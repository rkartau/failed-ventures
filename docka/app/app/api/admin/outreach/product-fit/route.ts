// app/api/admin/outreach/product-fit/route.ts — product-fit verdict upload
// (POST only).
//
// Thin HTTP shell over lib/product-fit.ts, copied from the sibling board upload
// (app/api/admin/outreach/route.ts): auth gate first, size pre-check + backstop,
// gzip decode (cap enforced on the DECOMPRESSED size, gzip-bomb safe via
// zlib.maxOutputLength), BOM-tolerant JSON parse, lenient envelope validation,
// atomic write, one admin-audit line per accepted upload. The size helpers
// (assertUploadSize / stripBom) are REUSED from lib/outreach-snapshot.ts.
//
// AUTH: an admin session OR a Bearer OUTREACH_UPLOAD_TOKEN (hash in
// .env.local, lib/machine-token.ts scope "outreach-upload") — REUSES the same
// machine credential the sibling board upload (app/api/admin/outreach/route.ts)
// already authenticates with, so the pipeline can push verdicts headlessly
// without provisioning a new secret. FAIL CLOSED: the token env/hash absent →
// "unconfigured" → 401 (the token path is simply OFF). No credential at all
// keeps the sibling routes' 404 (never reveal /admin exists); a PRESENTED-but-
// wrong/unconfigured Bearer is an honest 401 for the machine caller. Bearer
// attempts are rate-limited per client IP (shared machine-token bucket) before
// any hash compare.

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
import { assertUploadSize, stripBom } from "@/lib/outreach-snapshot";
import { MAX_PRODUCT_FIT_BYTES, validateProductFit } from "@/lib/product-fit";
import { writeProductFit } from "@/lib/product-fit-store";

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
      // No Bearer presented → the historical 404 shape; wrong/UNCONFIGURED
      // Bearer → honest 401 for the automation caller (fail closed when the
      // OUTREACH_UPLOAD_TOKEN_HASH env is absent).
      const status = machine.reason === "no-bearer" ? 404 : 401;
      return NextResponse.json({ ok: false }, { status });
    }
    email = machine.actor;
  }

  // Advisory pre-check on the declared length — cheap early exit before the body
  // is read; the byte-accurate backstop below is the real limit. (For a gzipped
  // body this checks the COMPRESSED length — the decompressed cap is below.)
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PRODUCT_FIT_BYTES) {
    return NextResponse.json({ ok: false, error: "File too large (max 10 MB)" }, { status: 400 });
  }

  // Accept Content-Encoding: gzip so the pipeline can push the verdict map
  // compactly. GZIP-BOMB SAFE: the 10 MB cap is enforced on the DECOMPRESSED
  // size — zlib's maxOutputLength aborts inflation the moment output would
  // exceed the cap, so a bomb never reaches JSON.parse.
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  let text: string;
  if (encoding === "gzip") {
    const raw = Buffer.from(await req.arrayBuffer());
    let inflated: Buffer;
    try {
      inflated = zlib.gunzipSync(raw, { maxOutputLength: MAX_PRODUCT_FIT_BYTES + 1 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const error =
        code === "ERR_BUFFER_TOO_LARGE" ? "File too large (max 10 MB)" : "Not valid gzip";
      return NextResponse.json({ ok: false, error }, { status: 400 });
    }
    if (inflated.length > MAX_PRODUCT_FIT_BYTES) {
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

  const size = assertUploadSize(text, MAX_PRODUCT_FIT_BYTES);
  if (!size.ok) {
    return NextResponse.json({ ok: false, error: size.error }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    return NextResponse.json({ ok: false, error: "Not valid JSON" }, { status: 400 });
  }

  const validated = validateProductFit(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }

  try {
    writeProductFit(validated.data);
  } catch {
    return NextResponse.json({ ok: false, error: "Write failed" }, { status: 500 });
  }

  const verdictCount = Object.keys(validated.data.verdicts).length;
  await recordAdminAction({
    adminEmail: email,
    action: "product-fit-upload",
    detail: {
      verdicts: verdictCount,
      generatedAt: validated.data.generatedAt,
      warnings: validated.data.warnings.length,
    },
  });

  return NextResponse.json({
    ok: true,
    verdicts: verdictCount,
    warnings: validated.data.warnings,
  });
}
