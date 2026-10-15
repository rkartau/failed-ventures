import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  type ProfileChangeRequest,
} from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess, reviewsForSeafarer } from "@/lib/access";
import { getSeafarerForAgent } from "@/lib/agentData";
import {
  isSelfServiceField,
  normalizeValue,
  fieldLabel,
  currentValueOf,
  applyApprovedChange,
  summarizeChanges,
  sortChangesForDisplay,
  MAX_NOTE,
} from "@/lib/self-service";
import { send } from "@/lib/notify";
import { getPublicBaseUrl } from "@/lib/base-url";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// All of a seafarer's change requests (seaman-owned: NOT filtered by agent — a
// change to the seaman's own profile is visible to whichever granted agent reviews
// it, mirroring how a DocRequest is seaman-visible across granting agents).
function changesForSeafarer(seafarerId: string): ProfileChangeRequest[] {
  return readDB().profileChanges.filter((r) => r.seafarerId === seafarerId);
}

// Resolve the OWNER of a self-service action via the CHOKEPOINT, pinned to
// TODAY'S acceptance: open + email token, ungated (PHASE0-CENSUS row 15 audit —
// plan R15, behavior preserved). Returns the seafarer when the token belongs to
// `seafarerId`, the "sample" sentinel (route answers 403 read-only), or null.
function ownerByToken(seafarerId: string, token: string) {
  if (!token) return null;
  const subject = resolveTokenSubject(readDB(), token, "write", ["open", "email"]);
  if (subject === SAMPLE_WRITE_DENIED) return "sample" as const;
  return subject && subject.seafarer.id === seafarerId ? subject.seafarer : null;
}

// Best-effort: tell the granted agents that a change is waiting for shore approval.
// Reuses lib/notify (never throws; a non-email contact resolves to a recorded
// "logged only"). Only agents with a LIVE (ACTIVE/LOCKED) grant are contacted.
async function notifyGrantedAgents(
  seafarerName: string,
  fieldName: string,
  origin: string,
  seafarerId: string
): Promise<void> {
  const db = readDB();
  const rows = reviewsForSeafarer(seafarerId).filter(
    (r) => r.status === "ACTIVE" || r.status === "LOCKED"
  );
  for (const row of rows) {
    const agent = db.agents.find((a) => a.id === row.agentId);
    const to = agent?.contact?.trim() || null;
    const link = `${origin}/agent/${seafarerId}`;
    await send({
      channel: "email",
      to: { name: row.agentName, email: to },
      subject: `Profile update to approve — ${seafarerName}`,
      message:
        `${seafarerName} proposed a change to their "${fieldName}" and it is waiting ` +
        `for your approval.\n\nReview it here: ${link}\n\n— sent via docka`,
      kind: "profile-update:proposed",
    });
  }
}

// GET /api/profile-updates?seafarerId=...
//   AGENT-only, grant-scoped: the seafarer's change queue (pending + decided) plus a
//   summary. Fail-closed via getSeafarerForAgent — no live grant => 404, no data leak.
export async function GET(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  // FAIL-CLOSED grant guard. An internal queue read — no REVIEWED audit entry.
  if (!getSeafarerForAgent(session.agentId, seafarerId, { log: false })) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  const changes = sortChangesForDisplay(changesForSeafarer(seafarerId));
  return NextResponse.json({ ok: true, changes, summary: summarizeChanges(changes) });
}

// POST /api/profile-updates
//   { seafarerId, token, field, proposedValue, note? }
//
// SEAMAN self-service: propose a change to ONE editable personal field. Authorised
// by the OWNER share token (possession secret) — a token for another seafarer 404s,
// so a seaman can only ever propose changes to THEIR OWN profile. The live profile is
// NOT touched: a pending ProfileChangeRequest is created and only lands on approval.
// A fresh proposal for a field SUPERSEDES any earlier pending one for the same field
// (kept clean — one pending change per field). Granted agents are e-mailed a heads-up.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    seafarerId?: unknown;
    token?: unknown;
    field?: unknown;
    proposedValue?: unknown;
    note?: unknown;
  };
  const seafarerId = typeof body.seafarerId === "string" ? body.seafarerId.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  const seafarer = ownerByToken(seafarerId, token);
  if (seafarer === "sample") return sampleReadOnlyResponse();
  if (!seafarer) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  if (!isSelfServiceField(body.field)) {
    return NextResponse.json({ ok: false, error: "That field can't be self-updated." }, { status: 400 });
  }
  const field = body.field;
  const proposed = normalizeValue(body.proposedValue);
  if (proposed === "bad") {
    return NextResponse.json(
      { ok: false, error: `Enter a shorter value (max 200 characters).` },
      { status: 400 }
    );
  }
  const previous = currentValueOf(seafarer, field);
  if ((proposed ?? "") === (previous ?? "")) {
    return NextResponse.json(
      { ok: false, error: "That is already the value on file — nothing to change." },
      { status: 400 }
    );
  }
  const note =
    typeof body.note === "string" && body.note.trim()
      ? body.note.trim().slice(0, MAX_NOTE)
      : null;

  const now = new Date().toISOString();
  const request: ProfileChangeRequest = {
    id: id(),
    seafarerId,
    field,
    fieldLabel: fieldLabel(field),
    previousValue: previous,
    proposedValue: proposed,
    note,
    status: "pending",
    createdAt: now,
    decidedBy: null,
    decidedByAgentId: null,
    decidedAt: null,
    decisionNote: null,
  };

  await updateDB((db) => {
    // Supersede any earlier pending proposal for the SAME field — keep one pending
    // change per field so the shore queue never fills with stale duplicates.
    for (const r of db.profileChanges) {
      if (r.seafarerId === seafarerId && r.field === field && r.status === "pending") {
        r.status = "cancelled";
        r.decidedAt = now;
        r.decisionNote = "Superseded by a newer proposal.";
      }
    }
    db.profileChanges.push(request);
  });

  // Best-effort heads-up to the granted agents (never blocks the proposal).
  await notifyGrantedAgents(seafarer.name || "A seafarer", request.fieldLabel, getPublicBaseUrl(req), seafarerId);

  const changes = sortChangesForDisplay(changesForSeafarer(seafarerId));
  return NextResponse.json({
    ok: true,
    request,
    changes,
    summary: summarizeChanges(changes),
  });
}

// PATCH /api/profile-updates
//   AGENT decision: { id, decision: "approve" | "reject", decisionNote? }
//   SEAMAN cancel:  { id, decision: "cancel", seafarerId, token }
//
// A granted agent APPROVES (writes the proposed value into the live profile) or
// REJECTS (leaves it untouched) a pending change; the seaman is e-mailed the outcome.
// The seaman may CANCEL their own still-pending proposal. Tenant + grant scoped: the
// agent path requires a live grant to the request's seafarer (checkAccess) or it 404s
// with no write; the seaman path requires the owner token for that seafarer.
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    decision?: unknown;
    decisionNote?: unknown;
    seafarerId?: unknown;
    token?: unknown;
  };
  const requestId = typeof body.id === "string" ? body.id.trim() : "";
  const decision = typeof body.decision === "string" ? body.decision : "";
  if (!requestId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject" && decision !== "cancel") {
    return NextResponse.json({ ok: false, error: "Invalid decision." }, { status: 400 });
  }

  const existing = readDB().profileChanges.find((r) => r.id === requestId) ?? null;
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Change request not found." }, { status: 404 });
  }
  if (existing.status !== "pending") {
    return NextResponse.json(
      { ok: false, error: "This change has already been decided." },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  // ---- Seaman cancel: owner-token authorised, own pending request only ----
  if (decision === "cancel") {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const cancelOwner = ownerByToken(existing.seafarerId, token);
    if (cancelOwner === "sample") return sampleReadOnlyResponse();
    if (!cancelOwner) {
      return NextResponse.json({ ok: false, error: "Change request not found." }, { status: 404 });
    }
    const result = await updateDB((db) => {
      const r = db.profileChanges.find((x) => x.id === requestId);
      if (!r || r.status !== "pending") return null;
      r.status = "cancelled";
      r.decidedAt = now;
      return r;
    });
    if (!result) {
      return NextResponse.json({ ok: false, error: "Change request not found." }, { status: 404 });
    }
    const changes = sortChangesForDisplay(changesForSeafarer(existing.seafarerId));
    return NextResponse.json({ ok: true, request: result, changes, summary: summarizeChanges(changes) });
  }

  // ---- Agent approve / reject: grant-scoped ----
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  // Tenant + grant guard: the agent must hold a live grant to this seafarer.
  if (!checkAccess(session.agentId, existing.seafarerId).allowed) {
    return NextResponse.json({ ok: false, error: "Change request not found." }, { status: 404 });
  }
  const decidedBy = session.user.name || session.user.email || "Agent";
  const decisionNote =
    typeof body.decisionNote === "string" && body.decisionNote.trim()
      ? body.decisionNote.trim().slice(0, MAX_NOTE)
      : null;

  const outcome = await updateDB((db) => {
    const r = db.profileChanges.find((x) => x.id === requestId);
    if (!r || r.status !== "pending") return null;
    r.status = decision === "approve" ? "approved" : "rejected";
    r.decidedBy = decidedBy;
    r.decidedByAgentId = session.agentId;
    r.decidedAt = now;
    r.decisionNote = decisionNote;
    // Approval is the ONLY path that writes the seaman's proposed value into the
    // live profile — a rejection leaves it exactly as it was.
    if (decision === "approve") {
      const seafarer = db.seafarers.find((s) => s.id === r.seafarerId);
      if (seafarer) applyApprovedChange(seafarer, r);
    }
    return { request: r, seafarer: db.seafarers.find((s) => s.id === r.seafarerId) ?? null };
  });
  if (!outcome) {
    return NextResponse.json({ ok: false, error: "Change request not found." }, { status: 404 });
  }

  // Tell the seaman the outcome (best-effort; recorded even with no address on file).
  const to = outcome.seafarer?.ownerEmail?.trim() || null;
  const verb = decision === "approve" ? "approved" : "rejected";
  await send({
    channel: "email",
    to: { name: outcome.seafarer?.name ?? null, email: to },
    subject: `Your ${outcome.request.fieldLabel} update was ${verb}`,
    message:
      `Hello ${outcome.seafarer?.name || "seafarer"},\n\n` +
      `${decidedBy} ${verb} your proposed change to "${outcome.request.fieldLabel}".\n` +
      (decision === "approve"
        ? `It is now on file.\n`
        : `Your details on file were left unchanged.\n`) +
      (decisionNote ? `\nNote: ${decisionNote}\n` : "") +
      `\n— sent via docka`,
    kind: `profile-update:${verb}`,
  });

  const changes = sortChangesForDisplay(changesForSeafarer(existing.seafarerId));
  return NextResponse.json({
    ok: true,
    request: outcome.request,
    seafarer: outcome.seafarer,
    changes,
    summary: summarizeChanges(changes),
  });
}
