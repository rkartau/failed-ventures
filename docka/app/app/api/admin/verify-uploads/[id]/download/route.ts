import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { isSafeItemId, readOriginalForDownload } from "@/lib/verify-upload-admin";

export const dynamic = "force-dynamic";

// GET — download the ORIGINAL bytes (plan §7). Content-Type from SNIFFED magic
// (never extension), X-Content-Type-Options: nosniff, Content-Disposition
// attachment with the sanitized original filename (CRLF / zero-width /
// RTL-override / path separators stripped; itemId fallback) — all built and
// unit-tested in lib/verify-upload-admin. Every download is admin-audited.

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  const itemId = params.id;
  if (!isSafeItemId(itemId)) {
    return NextResponse.json({ ok: false, error: "Invalid item id." }, { status: 400 });
  }

  const f = readOriginalForDownload(itemId);
  if (!f) return NextResponse.json({ ok: false }, { status: 404 });

  // Loud-fail, never-throw (review fix): an audit-sink failure must not 500 a
  // download that already succeeded — recordAdminAction logs ADMIN-AUDIT-FAILURE.
  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-download",
    detail: { itemId },
  });

  return new NextResponse(new Uint8Array(f.buf), { status: 200, headers: f.headers });
}
