// app/api/admin/outreach/route.ts — board.json snapshot upload (POST only).
//
// Thin HTTP shell over lib/outreach-snapshot.ts: auth gate first, size
// pre-check + backstop, BOM-tolerant JSON parse, lenient envelope validation,
// atomic snapshot write, one admin-audit line per accepted upload. Read-only
// dashboard — this route never sends email.
//
// AUTH (spec §13 automation): an admin session OR a Bearer
// OUTREACH_UPLOAD_TOKEN (hash in .env.local, lib/machine-token.ts) so the
// pipeline's `publish` step can push snapshots headlessly. Deny shapes:
// no credential at all keeps the sibling routes' 404 {ok:false} (never reveal
// /admin exists); a PRESENTED-but-wrong Bearer is an honest 401 for the
// machine caller. Bearer attempts are rate-limited per client IP
// (directory-route pattern) before any hash compare.

import zlib from "zlib";
import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import {
  MAX_UPLOAD_BYTES,
  assertUploadSize,
  stripBom,
  validateBoard,
} from "@/lib/outreach-snapshot";
import { writeOutreachSnapshot } from "@/lib/outreach-snapshot-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let email: string;
  const admin = await adminSession();
  if (admin) {
    email = (admin.user.email ?? "").trim().toLowerCase();
  } else {
    if (!consumeBudget(MACHINE_TOKEN_BUCKET, clientIpFromHeaders(req.headers), MACHINE_TOKEN_BUDGET)) {
      return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
    }
    const machine = verifyMachineToken(req.headers.get("authorization"), "outreach-upload");
    if (!machine.ok) {
      // No Bearer presented → the historical 404 shape; wrong/unconfigured
      // Bearer → honest 401 for the automation caller.
      const status = machine.reason === "no-bearer" ? 404 : 401;
      return NextResponse.json({ ok: false }, { status });
    }
    email = machine.actor;
  }

  // Advisory pre-check on the declared length — cheap early exit before the
  // body is read; the byte-accurate backstop below is the real limit. (For a
  // gzipped body this checks the COMPRESSED length — the decompressed cap is
  // enforced below.)
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: "File too large (max 10 MB)" }, { status: 400 });
  }

  // Increment 6: accept Content-Encoding: gzip so the pipeline can push the
  // full-body v3 snapshot compactly. GZIP-BOMB SAFE: the 10 MB cap is enforced
  // on the DECOMPRESSED size — zlib's maxOutputLength aborts inflation the
  // moment output would exceed the cap, so a bomb never reaches JSON.parse
  // (or even materializes in memory).
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  let text: string;
  if (encoding === "gzip") {
    const raw = Buffer.from(await req.arrayBuffer());
    let inflated: Buffer;
    try {
      inflated = zlib.gunzipSync(raw, { maxOutputLength: MAX_UPLOAD_BYTES + 1 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const error =
        code === "ERR_BUFFER_TOO_LARGE" ? "File too large (max 10 MB)" : "Not valid gzip";
      return NextResponse.json({ ok: false, error }, { status: 400 });
    }
    if (inflated.length > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: "File too large (max 10 MB)" }, { status: 400 });
    }
    text = inflated.toString("utf8");
  } else if (encoding !== "" && encoding !== "identity") {
    return NextResponse.json(
      { ok: false, error: `Unsupported content-encoding "${encoding}"` },
      { status: 400 }
    );
  } else {
    text = await req.text();
  }

  const size = assertUploadSize(text);
  if (!size.ok) {
    return NextResponse.json({ ok: false, error: size.error }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    return NextResponse.json({ ok: false, error: "Not valid JSON" }, { status: 400 });
  }

  const validated = validateBoard(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  try {
    writeOutreachSnapshot(validated.snapshot);
  } catch {
    return NextResponse.json({ ok: false, error: "Write failed" }, { status: 500 });
  }

  await recordAdminAction({
    adminEmail: email,
    action: "outreach-upload",
    detail: {
      leads: validated.snapshot.leads.length,
      generatedAt: validated.snapshot.generatedAt,
      warnings: validated.snapshot.warnings.length,
      halted: validated.snapshot.campaign.halted,
    },
  });

  return NextResponse.json({
    ok: true,
    leads: validated.snapshot.leads.length,
    warnings: validated.snapshot.warnings,
  });
}
