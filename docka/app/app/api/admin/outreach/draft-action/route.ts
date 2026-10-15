// app/api/admin/outreach/draft-action/route.ts — the reply desk's decision
// surface (wave 3 M2).
//
// POST only, adminSession() ONLY (the operator's Approve / Approve-with-edits /
// Reject / Not-a-real-reply buttons on the "Waiting for you" queue). Deny mirrors the outreach
// POST sibling: 404 when there is no credential at all (never reveal /admin
// exists), 401 is unreachable here because a missing session is
// indistinguishable from no bearer.
//
// THIS ROUTE SENDS NOTHING. It appends ONE `draft_action` row to the override
// store. The pipeline pulls it, validates it PER ROW fail-soft, folds it into
// its draft ledger, and only THEN may its guard 8 permit a send — re-verifying
// the ledgered approval by id+ts in Python. An attacker with this endpoint
// still cannot send anything the pipeline has not drafted, to anyone the
// pipeline has not bound to that draft.
//
// Defence in depth on top of the session:
//   * CSRF — the same-origin-JSON stance (lib/auth-csrf.ts), charged BEFORE
//     the rate bucket so cross-origin junk cannot burn a victim's budget.
//   * rate limit — its own named bucket, never the registry-outbound global.
//   * body caps — declared content-length AND measured bytes.
//   * LOGGING — the audit row records the draft id, the action and the edited
//     body's LENGTH. The reply body itself is never written to a server log.

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { sameOriginJsonOk } from "@/lib/auth-csrf";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import { updateDB } from "@/lib/db";
import {
  MAX_EDITED_BODY_BYTES,
  applyDraftAction,
  type DraftActionInput,
  type DraftActionOutcome,
  type OutreachDraftActionKind,
} from "@/lib/outreach-overrides";

export const dynamic = "force-dynamic";

/** One decision + at most one 20 KB body, with slack for the JSON envelope. */
const MAX_BODY_BYTES = MAX_EDITED_BODY_BYTES + 8 * 1024;

const DRAFT_ACTION_BUCKET = "outreach-draft-action";
/** Burst 20, one token back every 3 s: far above a human clicking through a
 *  queue, far below anything that could hammer the store. */
const DRAFT_ACTION_BUDGET = {
  capacity: 20,
  refillPerMs: 1 / 3_000,
} as const;

// `not_a_reply` (auto-ack handling): no editedBody, no reason — the store
// refuses a body on it exactly as on approve/reject; audited like a reject.
const ACTIONS = new Set<string>(["approve", "approve_edit", "reject", "not_a_reply"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });

  // CSRF first (never charge the bucket for a cross-origin request), then rate.
  if (!sameOriginJsonOk(req)) {
    return NextResponse.json({ ok: false, error: "Bad request origin" }, { status: 400 });
  }
  if (!consumeBudget(DRAFT_ACTION_BUCKET, clientIpFromHeaders(req.headers), DRAFT_ACTION_BUDGET)) {
    return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
  }

  const email = (admin.user.email ?? "").trim().toLowerCase();

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 400 });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Not valid JSON" }, { status: 400 });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "Not an object" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.draftId !== "string" || body.draftId.trim() === "") {
    return NextResponse.json({ ok: false, error: "draftId required" }, { status: 400 });
  }
  if (typeof body.action !== "string" || !ACTIONS.has(body.action)) {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }

  const input: DraftActionInput = {
    draftId: body.draftId,
    action: body.action as OutreachDraftActionKind,
    editedBody: typeof body.editedBody === "string" ? body.editedBody : null,
    reason: typeof body.reason === "string" ? body.reason : null,
  };

  // The outcome travels back as updateDB's RETURN value (not a captured let):
  // the mutator runs inside the store mutex, so the version it reports is the
  // one that was actually persisted.
  const result: DraftActionOutcome = await updateDB((db) =>
    applyDraftAction(db.outreachOverrides, input, { actor: email })
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  // Audit the DECISION, never the reply text.
  await recordAdminAction({
    adminEmail: email,
    action: "outreach-draft-action",
    detail: {
      draftId: input.draftId,
      decision: input.action,
      id: result.id,
      version: result.version,
      editedBodyChars:
        input.action === "approve_edit" ? (input.editedBody ?? "").length : 0,
    },
  });

  return NextResponse.json({ ok: true, version: result.version, id: result.id });
}
