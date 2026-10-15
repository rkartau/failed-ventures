import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  transact,
  updateDB,
  id,
  AUDIT_NO_IMPERSONATION,
  type Appraisal,
  type AppraisalDeleteRequest,
} from "@/lib/db";
import { auth } from "@/auth";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  pruneSampleReferences,
} from "@/lib/sample-guard";
import { send as notifySend } from "@/lib/notify";
import {
  validateAppraisalInput,
  projectAppraisalForSeaman,
  primaryDedupeMatch,
  agentDeleteDisposition,
  hasPendingDeleteRequest,
} from "@/lib/appraisals";

export const dynamic = "force-dynamic";

// Appraisal scorecards API (#43). Agency-authored, tenant-scoped, hash-chain audited.
// Two trust models, never conflated (mirrors /api/sea-service, /api/cv):
//   - AGENT branch (?seafarerId=): a signed-in agent with a LIVE grant. GET returns
//     the FULL appraisals they authored; POST/PATCH/DELETE write, double-gated.
//   - SEAMAN branch (?token=): possession of the seaman's OWN share token. GET returns
//     ONLY the projection (private fields never leave the server). Ownership-404 is
//     replicated VERBATIM from /api/cv/[id].
//
// Idempotency (v3 item 2 + v4 item 1): the dedupe check runs INSIDE the transact
// critical section. A non-empty client idempotencyKey dedupes exactly. A server
// FALLBACK on {seafarerId, agentId, kind, assignmentId} applies ONLY to a post_voyage
// with a real (non-null) assignmentId within a 10s window — an interview (assignmentId
// always null pre-hire) is NEVER fallback-deduped.

const FALLBACK_WINDOW_MS = 10_000;

// ---- GET ---------------------------------------------------------------
export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();

  // SEAMAN branch — possession token. Replicate /api/cv/[id] ownership-404 exactly.
  // CHOKEPOINT: open + gated email (PHASE0-CENSUS row 18). Sample subjects render
  // CURATED (sample:true) appraisal projections only (FILTER verdict).
  if (token) {
    const db = readDB();
    const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
    if (subject === null || subject === SAMPLE_WRITE_DENIED) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    const owner = subject.seafarer;
    // A request-supplied seafarerId must match the TOKEN-resolved owner, else 404.
    const askedId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
    if (askedId && owner.id !== askedId) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    if (subject.mode === "email") {
      const gate = await evaluateShareAccess(owner, "email");
      let allowed = gate.allowed;
      if (!allowed) {
        const session = await auth();
        if (session?.role === "seaman" && session.seafarerId === owner.id) allowed = true;
      }
      if (!allowed) {
        return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
      }
    }
    const appraisals = subject
      .filterRows(db.appraisals.filter((a) => a.seafarerId === owner.id))
      .map(projectAppraisalForSeaman);
    return NextResponse.json({ ok: true, appraisals });
  }

  // AGENT branch — signed-in agent + live grant.
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to view appraisals." },
      { status: 401 }
    );
  }
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  if (!checkAccess(session.agentId, seafarerId).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  // #12 — hidden (agent-deleted, pending/kept the seaman's consent) rows are NEVER
  // returned to the agent again.
  const appraisals = readDB()
    .appraisals.filter(
      (a) => a.seafarerId === seafarerId && a.agentId === session.agentId && !a.hiddenFromAgentAt
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return NextResponse.json({ ok: true, appraisals });
}

// ---- POST (agent-only) -------------------------------------------------
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to file an appraisal." },
      { status: 401 }
    );
  }
  const seafarerId = typeof body.seafarerId === "string" ? body.seafarerId.trim() : "";
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  const access = checkAccess(session.agentId, seafarerId);
  if (!access.allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  const validated = validateAppraisalInput(body);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const v = validated.value;

  const db0 = readDB();
  const authorOrg = db0.agents.find((a) => a.id === session.agentId)?.orgName ?? session.agentId;
  const authorName = session.user.name ?? session.user.email ?? "Agent";
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const grantId = access.grant?.id ?? null;

  const result = await transact((db, audit) => {
    // Primary dedupe: a non-empty client key, scoped to this seaman + agency. #12 —
    // EXCLUDES hidden rows (an agent-deleted row must not dedupe a fresh write); when a
    // hidden row alone carries this key, SUPERSEDE it (hard-delete the stale hidden row)
    // on the fresh create so the seaman never ends up with two visible rows.
    const dedupe = primaryDedupeMatch(db.appraisals, key, seafarerId, session.agentId);
    let hit: Appraisal | null = dedupe.hit;
    // Fallback dedupe: post_voyage + real assignmentId within a 10s window ONLY. An
    // interview (assignmentId null) can NEVER be collapsed here. Hidden rows excluded
    // (defensive — a just-hidden row can't fall inside the 10s window in practice).
    if (!hit && v.kind === "post_voyage" && v.assignmentId) {
      const cutoff = nowMs - FALLBACK_WINDOW_MS;
      hit =
        db.appraisals.find(
          (a) =>
            a.seafarerId === seafarerId &&
            a.agentId === session.agentId &&
            a.kind === "post_voyage" &&
            a.assignmentId === v.assignmentId &&
            !a.hiddenFromAgentAt &&
            Date.parse(a.createdAt) >= cutoff
        ) ?? null;
    }
    if (hit) return { appraisal: hit, created: false };

    // Fresh create supersedes a stale hidden row that shares the idempotency key.
    if (dedupe.staleHiddenId) {
      db.appraisals = db.appraisals.filter((a) => a.id !== dedupe.staleHiddenId);
    }

    const row: Appraisal = {
      id: id(),
      seafarerId,
      agentId: session.agentId,
      kind: v.kind,
      competencySetVersion: v.competencySetVersion,
      authorName,
      authorOrg,
      vessel: v.vessel,
      voyageFrom: v.voyageFrom,
      voyageTo: v.voyageTo,
      assignmentId: v.assignmentId,
      scores: v.scores,
      overall: v.overall,
      recommend: v.recommend,
      rehireReason: v.rehireReason,
      comments: v.comments,
      // #11 — the seaman-visible shared comment + STICKY "was ever shared" stamp.
      sharedComment: v.sharedComment,
      sharedWithSeamanAt: v.sharedComment ? nowIso : null,
      // #12 — a fresh row is never hidden.
      hiddenFromAgentAt: null,
      fastPath: v.fastPath,
      idempotencyKey: key,
      createdAt: nowIso,
      updatedAt: null,
    };
    db.appraisals.push(row);
    // Bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(db, seafarerId);
    audit("access-log", {
      id: id(),
      at: nowIso,
      seafarerId,
      agentId: session.agentId,
      grantId,
      action: "REVIEWED",
      documentRef: null,
    });
    return { appraisal: row, created: true };
  }, AUDIT_NO_IMPERSONATION);

  // Notify the seaman AFTER commit, fire-and-forget — never able to fail the 200.
  if (result.created) {
    try {
      const seaman = db0.seafarers.find((s) => s.id === seafarerId) ?? null;
      void notifySend({
        channel: "email",
        to: { name: seaman?.name ?? null, email: seaman?.ownerEmail ?? null },
        subject: "An appraisal has been filed on your seafarer profile",
        message:
          `${authorOrg} filed a ${v.kind === "post_voyage" ? "post-voyage" : "interview"} appraisal. ` +
          `You can view the overall rating, ratings, and recommendation on your dashboard.`,
        kind: "appraisal:filed",
      }).catch(() => {});
    } catch {
      /* never fail the 200 */
    }
  }

  return NextResponse.json({ ok: true, appraisal: result.appraisal, created: result.created });
}

// ---- PATCH (agent-only, double-gated) ----------------------------------
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const appraisalId = typeof body.id === "string" ? body.id.trim() : "";
  if (!appraisalId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  const existing = readDB().appraisals.find((a) => a.id === appraisalId) ?? null;
  // Double gate: must be the authoring tenant AND still hold a live grant. #12 — a hidden
  // (agent-deleted) row is no longer editable by the agent.
  if (
    !existing ||
    existing.agentId !== session.agentId ||
    !checkAccess(session.agentId, existing.seafarerId).allowed ||
    existing.hiddenFromAgentAt
  ) {
    return NextResponse.json({ ok: false, error: "Appraisal not found." }, { status: 404 });
  }
  // Re-validate the whole card with the kind + assignment fixed to the stored values.
  const validated = validateAppraisalInput({
    ...body,
    kind: existing.kind,
    assignmentId: existing.assignmentId,
    fastPath: existing.fastPath,
  });
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const v = validated.value;
  const updated = await updateDB((db) => {
    const a = db.appraisals.find((x) => x.id === appraisalId);
    if (!a) return null;
    a.vessel = v.vessel;
    a.voyageFrom = v.voyageFrom;
    a.voyageTo = v.voyageTo;
    a.scores = v.scores;
    a.overall = v.overall;
    a.recommend = v.recommend;
    a.rehireReason = v.rehireReason;
    a.comments = v.comments;
    // #11 — persist the shared comment on PATCH too (not just POST); set the STICKY
    // sharedWithSeamanAt the FIRST time a non-empty sharedComment lands, NEVER clear it
    // on blanking (the "was ever shared" fact #12's consent branch keys on).
    a.sharedComment = v.sharedComment;
    if (v.sharedComment && !a.sharedWithSeamanAt) {
      a.sharedWithSeamanAt = new Date().toISOString();
    }
    a.competencySetVersion = v.competencySetVersion;
    a.updatedAt = new Date().toISOString();
    return a;
  });
  if (!updated) {
    return NextResponse.json({ ok: false, error: "Appraisal not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, appraisal: updated });
}

// ---- DELETE (agent-only, double-gated) ---------------------------------
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const appraisalId = typeof body.id === "string" ? body.id.trim() : "";
  if (!appraisalId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  const existing = readDB().appraisals.find((a) => a.id === appraisalId) ?? null;
  // Double gate + #12 idempotent double-delete: an already-hidden row is 404/no-op.
  if (
    !existing ||
    existing.agentId !== session.agentId ||
    !checkAccess(session.agentId, existing.seafarerId).allowed ||
    existing.hiddenFromAgentAt
  ) {
    return NextResponse.json({ ok: false, error: "Appraisal not found." }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  // ONE critical section (#12). Never-shared => hard-delete outright. Ever-shared
  // (sticky sharedWithSeamanAt) => soft-hide + raise ONE pending consent request per
  // appraisalId; report whether a request was NEWLY created so ONLY that path emails.
  const outcome = await updateDB((db) => {
    const a = db.appraisals.find((x) => x.id === appraisalId);
    // Re-validate the double gate inside the mutex (TOCTOU); a raced hide/delete => no-op.
    if (!a || a.agentId !== session.agentId || a.hiddenFromAgentAt) {
      return { disposition: "gone" as const };
    }
    if (agentDeleteDisposition(a) === "hard_delete") {
      db.appraisals = db.appraisals.filter((x) => x.id !== appraisalId);
      return { disposition: "hard_deleted" as const };
    }
    // Ever-shared: hide from the agent, keep the row for the seaman's decision.
    a.hiddenFromAgentAt = nowIso;
    const hasPending = hasPendingDeleteRequest(db.appraisalDeleteRequests, appraisalId);
    let requestCreated = false;
    if (!hasPending) {
      const request: AppraisalDeleteRequest = {
        id: id(),
        appraisalId,
        seafarerId: a.seafarerId,
        agentId: a.agentId,
        status: "pending",
        createdAt: nowIso,
        decidedAt: null,
      };
      db.appraisalDeleteRequests.push(request);
      requestCreated = true;
    }
    return { disposition: "consent_requested" as const, requestCreated };
  });

  if (outcome.disposition === "gone") {
    // Raced with a concurrent delete/hide — behave like the idempotent 404 above.
    return NextResponse.json({ ok: false, error: "Appraisal not found." }, { status: 404 });
  }

  if (outcome.disposition === "hard_deleted") {
    return NextResponse.json({ ok: true, deleted: appraisalId, disposition: "deleted" });
  }

  // consent_requested — email the seaman ONLY when a request was NEWLY created (mirror
  // POST's created-gating). Fire-and-forget; never fails the 200.
  if (outcome.requestCreated) {
    try {
      const seaman = readDB().seafarers.find((s) => s.id === existing.seafarerId) ?? null;
      void notifySend({
        channel: "email",
        to: { name: seaman?.name ?? null, email: seaman?.ownerEmail ?? null },
        subject: "An agency asked to remove an appraisal from your profile",
        message:
          `${existing.authorOrg} asked to delete an appraisal on your profile. ` +
          `Open docka to keep it on your record or agree to delete it — nothing changes until you decide.`,
        kind: "appraisal:delete-request",
      }).catch(() => {});
    } catch {
      /* never fail the 200 */
    }
  }

  return NextResponse.json({
    ok: true,
    disposition: "consent_requested",
    requestCreated: outcome.requestCreated,
  });
}
