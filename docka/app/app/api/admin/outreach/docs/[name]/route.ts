// app/api/admin/outreach/docs/[name]/route.ts — campaign-doc upload (POST
// only), the sibling of the board.json route one directory up.
//
// The pipeline's `publish` step (spec §13) POSTs each CHANGED docs/*.md here
// as raw markdown. This is a MIRROR for the admin area — storage only, this
// route never sends email and nothing renders the markdown as HTML.
//
// AUTH — deliberately IDENTICAL to app/api/admin/outreach/route.ts: an admin
// session OR a Bearer OUTREACH_UPLOAD_TOKEN (same "outreach-upload" scope —
// the pipeline pushes board + docs with the ONE token). Deny shapes match:
// no credential at all → the sibling routes' 404 {ok:false}; a PRESENTED-but-
// wrong Bearer → honest 401 for the machine caller; Bearer attempts share the
// machine-token rate bucket per client IP. Size caps reuse the shared
// MAX_DOC_UPLOAD_BYTES (2 MB) pre-check + byte-accurate backstop. The doc NAME is
// validated against a flat-basename allowlist BEFORE any disk access
// (lib/outreach-docs-store.ts), and a distinct-name cap bounds disk usage.

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import { assertUploadSize } from "@/lib/outreach-snapshot";
import {
  MAX_DOC_COUNT,
  MAX_DOC_UPLOAD_BYTES,
  hasOutreachDoc,
  isSafeDocName,
  listOutreachDocs,
  writeOutreachDoc,
} from "@/lib/outreach-docs-store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { name: string } }
): Promise<NextResponse> {
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

  const name = params.name;
  if (!isSafeDocName(name)) {
    return NextResponse.json({ ok: false, error: "Invalid doc name" }, { status: 400 });
  }

  // Advisory pre-check on the declared length — cheap early exit before the
  // body is read; the byte-accurate backstop below is the real limit.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_DOC_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: "File too large (max 2 MB)" }, { status: 400 });
  }

  const text = await req.text();
  const size = assertUploadSize(text, MAX_DOC_UPLOAD_BYTES);
  if (!size.ok) {
    return NextResponse.json({ ok: false, error: size.error }, { status: 400 });
  }

  // Disk bound: a NEW name past the cap is refused; overwriting an existing
  // doc (the normal changed-hash push) always succeeds.
  if (!hasOutreachDoc(name) && listOutreachDocs().length >= MAX_DOC_COUNT) {
    return NextResponse.json(
      { ok: false, error: `Too many docs (max ${MAX_DOC_COUNT})` },
      { status: 400 }
    );
  }

  try {
    writeOutreachDoc(name, text);
  } catch {
    return NextResponse.json({ ok: false, error: "Write failed" }, { status: 500 });
  }

  const bytes = new TextEncoder().encode(text).length;
  await recordAdminAction({
    adminEmail: email,
    action: "outreach-docs-upload",
    detail: { name, bytes },
  });

  return NextResponse.json({ ok: true, name, bytes });
}
