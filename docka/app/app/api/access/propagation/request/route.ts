import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type ProfileShareRequest } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { setPropagation } from "@/lib/propagation";
import { send } from "@/lib/notify";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// #38.5 — agent-side ASYNC "request profile access" lane. A request is NOT a grant: it
// writes no flag until the seaman approves. Fail-closed: an unapproved request grants
// zero visibility.
//
// POST  (agent-gated): raise a pending request + ping the seaman via lib/notify.
//   { seafarerId, bucket:"contact"|"financial" }
// PATCH (seaman-authorised by OWNER token): approve/decline.
//   { requestId, decision:"approved"|"declined", token }

export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { seafarerId?: string; bucket?: string };
  const seafarerId = (body.seafarerId ?? "").trim();
  const bucket = body.bucket === "financial" ? "financial" : body.bucket === "contact" ? "contact" : null;
  if (!seafarerId || !bucket) {
    return NextResponse.json(
      { ok: false, error: "seafarerId and a valid bucket are required." },
      { status: 400 }
    );
  }
  // Fail-closed: the agent must already hold a live grant to this seafarer.
  if (!checkAccess(session.agentId, seafarerId).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  const requestedBy = session.user.name ?? session.user.email ?? "Agent";
  const request: ProfileShareRequest = {
    id: id(),
    seafarerId,
    agentId: session.agentId,
    bucket,
    requestedBy,
    status: "pending",
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  await updateDB((db) => {
    db.profileShareRequests.push(request);
  });
  // Ping the seaman (best-effort — reuse the notify channel; never throws).
  const db = readDB();
  const seaman = db.seafarers.find((s) => s.id === seafarerId);
  if (seaman?.ownerEmail) {
    void send({
      channel: "email",
      to: { name: seaman.name, email: seaman.ownerEmail },
      subject: "An agency asked to see more of your profile",
      message: `${requestedBy} has asked to see your ${bucket === "contact" ? "contact details" : "bank details and next of kin"}. Open docka to approve or decline — nothing is shared until you do.`,
      kind: "propagation:request",
    });
  }
  return NextResponse.json({ ok: true, request });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    requestId?: string;
    decision?: string;
    token?: string;
  };
  const requestId = (body.requestId ?? "").trim();
  const decision = body.decision === "approved" ? "approved" : body.decision === "declined" ? "declined" : null;
  const token = (body.token ?? "").trim();
  if (!requestId || !decision) {
    return NextResponse.json(
      { ok: false, error: "requestId and a valid decision are required." },
      { status: 400 }
    );
  }
  const db = readDB();
  const request = db.profileShareRequests.find((r) => r.id === requestId) ?? null;
  if (!request) {
    return NextResponse.json({ ok: false, error: "Request not found." }, { status: 404 });
  }
  // Owner possession-trust via the CHOKEPOINT: open + email token, ungated
  // (PHASE0-CENSUS row 17 audit — plan R15, behavior preserved). Sample -> 403.
  const subject = token ? resolveTokenSubject(db, token, "write", ["open", "email"]) : null;
  if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
  if (!subject || subject.seafarer.id !== request.seafarerId) {
    return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 404 });
  }
  // Record the decision (idempotent-ish: a decided request is not re-decided).
  const updated = await updateDB((d) => {
    const r = d.profileShareRequests.find((x) => x.id === requestId);
    if (!r || r.status !== "pending") return null;
    r.status = decision;
    r.decidedAt = new Date().toISOString();
    return r;
  });
  if (!updated) {
    return NextResponse.json({ ok: false, error: "Request already decided." }, { status: 409 });
  }
  // Approval flips the flag + emits the consent event via the SAME seaman-controlled path.
  if (decision === "approved") {
    await setPropagation(
      request.seafarerId,
      request.agentId,
      request.bucket,
      true,
      `seafarer:${request.seafarerId}`
    );
  }
  return NextResponse.json({ ok: true, request: updated });
}
