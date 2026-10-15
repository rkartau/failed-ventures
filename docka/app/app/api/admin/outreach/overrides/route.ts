// app/api/admin/outreach/overrides/route.ts — the manual hold / move override
// store's HTTP surface (feat/manual-hold).
//
//   GET  — leads-read Bearer ONLY (MACHINE-ONLY): the outreach pipeline pulls
//          the pending override set each cycle. Server COMPONENT pages do NOT
//          call this — they read the store directly via readDB() (no HTTP hop,
//          no adminSession-on-GET surface). Deny mirrors leads/export: 401
//          ALWAYS on bad/absent Bearer; 429 on rate-limit.
//   POST — adminSession() ONLY (the operator's Hold/Unhold/Move buttons). Deny
//          mirrors the outreach POST sibling: 404 when no credential, else 401.
//
// consumeBudget is imported from @/lib/registry [R13]. The store lives in
// db.json (updateDB mutex + atomicReplace); applyOp / toWire are the pure logic
// (lib/outreach-overrides.ts).

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import { readDB, updateDB } from "@/lib/db";
import { applyOp, toWire, type OverrideOp } from "@/lib/outreach-overrides";
import { readOutreachSnapshot } from "@/lib/outreach-snapshot-store";

export const dynamic = "force-dynamic";

/** Advisory cap on the POST body (operator clicks are tiny) [R13]. */
const MAX_BODY_BYTES = 4 * 1024;

// ---- GET: machine-only pull (leads-read Bearer) --------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Rate-limit BEFORE the hash compare so token guessing and pull-hammering
  // share one bounded budget per client IP.
  if (!consumeBudget(MACHINE_TOKEN_BUCKET, clientIpFromHeaders(req.headers), MACHINE_TOKEN_BUDGET)) {
    return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
  }
  const machine = verifyMachineToken(req.headers.get("authorization"), "leads-read");
  if (!machine.ok) return NextResponse.json({ ok: false }, { status: 401 }); // 401 ALWAYS (leads/export posture)

  const wire = toWire(readDB().outreachOverrides);
  return NextResponse.json(wire, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

// ---- POST: operator mutation (adminSession) ------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const admin = await adminSession();
  if (!admin) {
    // Mirror the outreach POST sibling's deny shape: no credential at all → the
    // historical 404 (never reveal /admin exists); a wrong/expired one → 401.
    // A missing session is indistinguishable from "no bearer", so 404 here.
    return NextResponse.json({ ok: false }, { status: 404 });
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
  if (raw === null || typeof raw !== "object") {
    return NextResponse.json({ ok: false, error: "Not an object" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  let op: OverrideOp;
  if (body.op === "move") {
    if (typeof body.sendKey !== "string" || typeof body.toStage !== "string") {
      return NextResponse.json({ ok: false, error: "move needs sendKey + toStage" }, { status: 400 });
    }
    op = { op: "move", sendKey: body.sendKey, toStage: body.toStage };
  } else if (body.op === "hold" || body.op === "unhold") {
    if ((body.scope !== "lead" && body.scope !== "company") || typeof body.key !== "string") {
      return NextResponse.json({ ok: false, error: "hold/unhold needs scope + key" }, { status: 400 });
    }
    op = { op: body.op, scope: body.scope, key: body.key };
  } else {
    return NextResponse.json({ ok: false, error: "unknown op" }, { status: 400 });
  }

  // For a move, resolve the lead's CURRENT stage from the board snapshot so a
  // currently-suppressed/undeliverable lead is rejected at POST [R7]. The board
  // may lag (or coerce undeliverable→unknown); the pipeline re-validates and
  // NACKs as defense-in-depth.
  let currentStage: string | null | undefined;
  if (op.op === "move") {
    const snap = readOutreachSnapshot();
    if (snap.status === "ok") {
      currentStage = snap.snapshot.leads.find((l) => l.sendKey === op.sendKey)?.stage;
    }
  }

  let outcome: ReturnType<typeof applyOp> = { ok: false, error: "not run" };
  const version = await updateDB((db) => {
    outcome = applyOp(db.outreachOverrides, op, { createdBy: email, currentStage });
    return db.outreachOverrides.version;
  });

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: 400 });
  }

  await recordAdminAction({
    adminEmail: email,
    action: "outreach-override",
    detail:
      op.op === "move"
        ? { op: "move", sendKey: op.sendKey, toStage: op.toStage, version }
        : { op: op.op, scope: op.scope, version },
  });

  return NextResponse.json({ ok: true, version });
}
