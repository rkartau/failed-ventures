import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  isSeafarerState,
  type AccessGrant,
  type Comment,
  type NotifyChannel,
  type Seafarer,
  type SeafarerState,
} from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { listSeafarersForAgent } from "@/lib/agentData";
import { activeDocs } from "@/lib/archive";
import { send, type NotifyResult } from "@/lib/notify";
import { assignmentBlockers, isAssignmentAdvance } from "@/lib/compliance";
import { duplicateNameIndex } from "@/lib/duplicates";
import { requiredSetFor } from "@/lib/required-docs";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { STATE_LABELS } from "@/lib/pipeline";
import { getPublicBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";
// sample-token: exempt(link-construction only — the token is embedded into outbound
// message links, never used to authorise the caller; sample recipients are skipped
// on the message path, sample rows are skipped on the tag path, stage moves allowed)
import { pruneSampleReferences } from "@/lib/sample-guard";

// Email today; the notify channel stubs SMS/WhatsApp behind the same interface.
const CHANNEL: NotifyChannel = "email";
const MAX_TAG_LEN = 40;
const MAX_TAGS = 30;

// Same honest, human delivery outcome the single/bulk reminder flow records, so
// the audit note reflects what ACTUALLY happened rather than always "sent".
function deliveryNote(res: NotifyResult, to: string | null): string {
  if (res.delivered) return `emailed to ${to}`;
  if (res.status === "failed") return `email failed (${res.reason ?? "unknown error"})`;
  if (!to) return "recorded only — no e-mail on file for this seaman";
  return `recorded only (${res.reason ?? "channel not configured"})`;
}

// Normalise ONE tag: trim, collapse inner whitespace, cap length. Empty => null.
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LEN);
  return t.length ? t : null;
}

// POST /api/bulk
//   { action: "message", seafarerIds, subject?, message }        -> free-text notify to the cohort
//   { action: "stage",   seafarerIds, state }                    -> move the cohort's pipeline stage
//   { action: "tag",     seafarerIds, tagOp: "add"|"remove", tag } -> add/remove a label on the cohort
//
// The multi-select counterpart to the one-man review flow (roadmap T2.1). EVERY
// branch is grant-scoped through lib/agentData.ts: an agent may only touch
// seafarers they hold a LIVE grant for, so a replayed/foreign seafarerId is
// dropped BEFORE any name / e-mail / mutation. Stage-move re-runs the SAME
// sea-readiness hard-block the single move enforces — a non-sea-ready man is
// reported as blocked and left in place, never silently advanced.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    seafarerIds?: unknown;
    subject?: unknown;
    message?: unknown;
    state?: unknown;
    tagOp?: unknown;
    tag?: unknown;
  };

  const action = body.action;
  const seafarerIds = Array.isArray(body.seafarerIds)
    ? Array.from(new Set(body.seafarerIds.map((x) => String(x)).filter(Boolean)))
    : [];
  if (seafarerIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Select at least one crew member." },
      { status: 400 }
    );
  }

  // GRANT-SCOPE the target ids up front. Any id outside this agent's live-grant set
  // is dropped here, before we read any name / e-mail or mutate — no cross-tenant
  // reach for message, stage, OR tag.
  const allowedIds = new Set(listSeafarersForAgent(session.agentId, false).map((s) => s.id));
  const targetIds = seafarerIds.filter((sid) => allowedIds.has(sid));
  if (targetIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "None of the selected crew were found." },
      { status: 404 }
    );
  }

  const author = session.user.name || session.user.email || "Agent";

  // ---- Bulk free-text message -------------------------------------------------
  if (action === "message") {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Enter a message to send." },
        { status: 400 }
      );
    }
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const origin = getPublicBaseUrl(req);
    const db = readDB();

    const results: {
      seafarerId: string;
      name: string;
      delivered: boolean;
      delivery: string;
    }[] = [];
    const newComments: Comment[] = [];
    let delivered = 0;

    for (const sid of targetIds) {
      const s = db.seafarers.find((x) => x.id === sid);
      if (!s) continue;
      // §D7 — sample subjects never receive messages, never pollute notifications.
      if (s.isSample === true) continue;
      const to = s.ownerEmail?.trim() || null;
      const shareUrl = `${origin}/share/${s.shareToken}`;
      const subj = subject || `A message from your agency — ${s.name}`.trim();
      const emailBody =
        `Hello ${s.name || "seafarer"},\n\n` +
        `${message}\n\n` +
        `View your documents here:\n${shareUrl}\n\n` +
        `— sent via docka on behalf of ${author}`;

      const res = await send({
        channel: CHANNEL,
        to: { name: s.name, email: to },
        subject: subj,
        message: emailBody,
        kind: "bulk:message",
      });
      if (res.delivered) delivered++;
      const note = deliveryNote(res, to);
      newComments.push({
        id: id(),
        documentId: null,
        seafarerId: sid,
        authorName: author,
        text: `MESSAGE sent — ${message} [${note}]`,
        createdAt: new Date().toISOString(),
      });
      results.push({ seafarerId: sid, name: s.name, delivered: res.delivered, delivery: note });
    }

    if (results.length === 0) {
      return NextResponse.json(
        { ok: false, error: "None of the selected crew were found." },
        { status: 404 }
      );
    }
    await updateDB((d) => {
      d.comments.push(...newComments);
    });
    return NextResponse.json({
      ok: true,
      action: "message",
      count: results.length,
      delivered,
      results,
    });
  }

  // ---- Bulk pipeline stage-move ----------------------------------------------
  if (action === "stage") {
    const state = body.state;
    if (!isSeafarerState(state)) {
      return NextResponse.json(
        { ok: false, error: "A valid target stage is required." },
        { status: 400 }
      );
    }
    const target = state as SeafarerState;
    const db = readDB();
    const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
    const duplicates = duplicateNameIndex(db.documents, (i) => nameById.get(i) ?? i);
    const config = getConfigForAgent(session.agentId);
    // Acting agent's grants keyed by seafarerId (B.2 / F4): the per-grant stage is
    // the "from" stage for the no-op + advance checks, not the deprecated global.
    const actingGrantBySeafarer = new Map<string, AccessGrant>();
    for (const g of db.accessGrants) {
      if (g.agentId === session.agentId) actingGrantBySeafarer.set(g.seafarerId, g);
    }

    const moved: string[] = [];
    const blocked: { seafarerId: string; name: string; reasons: string[] }[] = [];

    for (const sid of targetIds) {
      const s = db.seafarers.find((x) => x.id === sid);
      if (!s) continue;
      const fromStage = actingGrantBySeafarer.get(sid)?.stage ?? "review";
      if (fromStage === target) continue; // already there for THIS agent — no-op
      // Sea-readiness hard-block: advancing FORWARD into an assignment state is
      // refused for a non-sea-ready man, exactly as the single move does. Bulk has
      // no per-man documented override, so a blocked man is reported and left put.
      if (isAssignmentAdvance(fromStage, target)) {
        const docs = activeDocs(db.documents.filter((d) => d.seafarerId === sid));
        const liveAssignment = db.assignments.find(
          (a) =>
            a.seafarerId === sid &&
            a.agentId === session.agentId &&
            a.returnedAt === null &&
            a.requiredSnapshot
        );
        const req = liveAssignment?.requiredSnapshot
          ? {
              required: liveAssignment.requiredSnapshot.required,
              rankKnown: liveAssignment.requiredSnapshot.rankKnown,
            }
          : requiredSetFor({
              rank: s.rank,
              config,
              vesselType: s.vesselType,
              flag: s.flagState,
            });
        const b = assignmentBlockers(docs, {
          duplicates,
          ownName: s.name,
          rotationEnd: s.rotationEnd ?? null,
          required: req.required,
          rankIncomplete: !req.rankKnown,
          holderDOB: s.birthDate ?? null,
        });
        if (b.blocked) {
          blocked.push({ seafarerId: sid, name: s.name, reasons: b.reasons });
          continue;
        }
      }
      moved.push(sid);
    }

    let updated: { id: string; state: SeafarerState }[] = [];
    if (moved.length > 0) {
      const movedSet = new Set(moved);
      updated = await updateDB((d) => {
        const out: { id: string; state: SeafarerState }[] = [];
        const now = Date.now();
        for (const s of d.seafarers) {
          if (movedSet.has(s.id)) {
            // B.2: stamp the acting agent's grant (source of truth) + timestamp, then
            // dual-write the deprecated global mirror. Race-safe inside updateDB (#1).
            const grant = d.accessGrants.find(
              (g) => g.seafarerId === s.id && g.agentId === session.agentId
            );
            if (grant) {
              grant.stage = target;
              grant.stageUpdatedAt = now;
            }
            s.state = target; // dual-write (deprecated global mirror)
            // Bound real-agent interactions with a sample subject (no-op otherwise).
            if (s.isSample === true) pruneSampleReferences(d, s.id);
            out.push({ id: s.id, state: grant?.stage ?? target });
          }
        }
        return out;
      });
    }

    return NextResponse.json({
      ok: true,
      action: "stage",
      state: target,
      stateLabel: STATE_LABELS[target],
      moved: moved.length,
      blocked,
      seafarers: updated,
    });
  }

  // ---- Bulk tag add / remove -------------------------------------------------
  if (action === "tag") {
    const tagOp = body.tagOp === "remove" ? "remove" : "add";
    const tag = normalizeTag(body.tag);
    if (!tag) {
      return NextResponse.json({ ok: false, error: "Enter a tag." }, { status: 400 });
    }
    const lc = tag.toLowerCase();
    const targetSet = new Set(targetIds);

    const updated = await updateDB((d) => {
      const out: { id: string; tags: string[] }[] = [];
      for (const s of d.seafarers) {
        if (!targetSet.has(s.id)) continue;
        // Sample rows are read-only for tag writes (census row 25: tag DENY).
        if (s.isSample === true) continue;
        const current = Array.isArray(s.tags) ? s.tags : [];
        let nextTags: string[];
        if (tagOp === "add") {
          // De-dupe case-insensitively; keep the existing casing if already present.
          if (current.some((t) => t.toLowerCase() === lc)) {
            nextTags = current;
          } else {
            nextTags = [...current, tag].slice(0, MAX_TAGS);
          }
        } else {
          nextTags = current.filter((t) => t.toLowerCase() !== lc);
        }
        s.tags = nextTags;
        out.push({ id: s.id, tags: nextTags });
      }
      return out;
    });

    return NextResponse.json({
      ok: true,
      action: "tag",
      tagOp,
      tag,
      count: updated.length,
      seafarers: updated,
    });
  }

  return NextResponse.json({ ok: false, error: "Unknown bulk action." }, { status: 400 });
}
