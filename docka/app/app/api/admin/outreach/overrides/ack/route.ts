// app/api/admin/outreach/overrides/ack/route.ts — the pipeline writes back which
// pending moves it applied / rejected (feat/manual-hold).
//
// admin-guard: exempt — this is a MACHINE-ONLY endpoint (outreach-upload Bearer,
// the same scope the pipeline's `publish` step already holds). It reads no
// tenant data and carries no operator session, exactly like the outreach-upload
// half of the sibling routes; the ONLY caller is the pipeline. Deny mirrors the
// outreach POST: 404 when no Bearer, else 401.
//
// Body: { moveIds:[17,18], rejected:[{id:19, reason:"invalid target"}],
//         draftActionIds:[4,5] }.
// ackMoves / ackDraftActions are idempotent (unknown / superseded / already-
// terminal ids no-op) and bump version so later GETs stop returning them [R8].
// draftActionIds (wave 3 M2) is what makes "pending" mean "not yet folded" for
// the 50-approval cap; losing an ack is harmless, because the pipeline keeps
// its own applied-id ledger and re-folds a re-served decision as a no-op.

import { NextRequest, NextResponse } from "next/server";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import { updateDB } from "@/lib/db";
import { ackDraftActions, ackMoves, type AckInput } from "@/lib/outreach-overrides";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!consumeBudget(MACHINE_TOKEN_BUCKET, clientIpFromHeaders(req.headers), MACHINE_TOKEN_BUDGET)) {
    return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
  }
  const machine = verifyMachineToken(req.headers.get("authorization"), "outreach-upload");
  if (!machine.ok) {
    const status = machine.reason === "no-bearer" ? 404 : 401;
    return NextResponse.json({ ok: false }, { status });
  }

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
  if (raw === null || typeof raw !== "object") {
    return NextResponse.json({ ok: false, error: "Not an object" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  const input: AckInput = {
    applied: Array.isArray(body.moveIds) ? body.moveIds.filter((n): n is number => typeof n === "number") : [],
    rejected: Array.isArray(body.rejected)
      ? (body.rejected.filter((r) => r && typeof r === "object") as Record<string, unknown>[])
          .filter((r) => typeof r.id === "number")
          .map((r) => ({ id: r.id as number, reason: typeof r.reason === "string" ? r.reason : null }))
      : [],
  };

  const draftActionIds = Array.isArray(body.draftActionIds)
    ? body.draftActionIds.filter((n): n is number => typeof n === "number")
    : [];

  let result: ReturnType<typeof ackMoves> = { ok: true, version: 0, applied: [], rejected: [] };
  let drafts: ReturnType<typeof ackDraftActions> = { ok: true, version: 0, folded: [] };
  await updateDB((db) => {
    result = ackMoves(db.outreachOverrides, input);
    drafts = ackDraftActions(db.outreachOverrides, draftActionIds);
    return null;
  });

  return NextResponse.json({
    ok: true,
    version: Math.max(result.version, drafts.version),
    applied: result.applied,
    rejected: result.rejected,
    draftActions: drafts.folded,
  });
}
