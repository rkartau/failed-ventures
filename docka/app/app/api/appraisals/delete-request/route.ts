import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { resolveDeleteRequestTransition, type DeleteDecision } from "@/lib/appraisals";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// #12 — the SEAMAN keep/delete decision on an agent-deleted, ever-shared appraisal.
// A dedicated record (AppraisalDeleteRequest) mirrors the propagation async-decision
// lane, but the payload semantics differ (keep vs delete a scorecard, co-transacted
// with a hard-delete). Owner possession-trust ONLY — no agent path.
//
// PATCH (seaman-authorised by OWNER token): decide.
//   { requestId, decision:"keep"|"delete", token }
//
// - Owner possession-trust: the token must belong to the request's seafarer (verbatim
//   from access/propagation/request PATCH :86-92) — else 404.
// - Transition guard: only a `pending` request is decidable; any terminal status => 409
//   with the terminal state (verbatim shape from propagation :94-96).
// - Both the status transition AND the hard-delete happen in ONE updateDB (co-transacted).
//   "keep" => status "kept" (row stays, agent-hidden, seaman-visible). "delete" => status
//   "deleted" + hard-delete the appraisal row. Appraisal already gone => resolve terminally
//   "deleted", no throw.
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    requestId?: string;
    decision?: string;
    token?: string;
  };
  const requestId = (body.requestId ?? "").trim();
  const decision: DeleteDecision | null =
    body.decision === "keep" ? "keep" : body.decision === "delete" ? "delete" : null;
  const token = (body.token ?? "").trim();
  if (!requestId || !decision) {
    return NextResponse.json(
      { ok: false, error: "requestId and a valid decision are required." },
      { status: 400 }
    );
  }

  const db = readDB();
  const request = db.appraisalDeleteRequests.find((r) => r.id === requestId) ?? null;
  if (!request) {
    return NextResponse.json({ ok: false, error: "Request not found." }, { status: 404 });
  }
  // Owner possession-trust via the CHOKEPOINT: open + email token, ungated
  // (PHASE0-CENSUS row 19 audit — plan R15, behavior preserved). Sample -> 403.
  const subject = token ? resolveTokenSubject(db, token, "write", ["open", "email"]) : null;
  if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
  if (!subject || subject.seafarer.id !== request.seafarerId) {
    return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 404 });
  }

  // Decide + (on delete) hard-delete the appraisal in ONE critical section.
  const updated = await updateDB((d) => {
    const r = d.appraisalDeleteRequests.find((x) => x.id === requestId);
    if (!r || r.status !== "pending") return null;
    const appraisal = d.appraisals.find((a) => a.id === r.appraisalId) ?? null;
    const t = resolveDeleteRequestTransition(r, decision, !!appraisal);
    // t.ok is guaranteed true here (r.status === "pending").
    if (!t.ok) return null;
    r.status = t.nextStatus;
    r.decidedAt = new Date().toISOString();
    if (t.hardDelete && appraisal) {
      d.appraisals = d.appraisals.filter((a) => a.id !== r.appraisalId);
    }
    return r;
  });

  if (!updated) {
    // Already decided — return the terminal state (409), mirroring the propagation lane.
    const current = readDB().appraisalDeleteRequests.find((r) => r.id === requestId) ?? null;
    return NextResponse.json(
      { ok: false, error: "Request already decided.", status: current?.status ?? null },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, request: updated });
}
