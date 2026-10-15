import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { isSafeItemId, readThumbnailSource } from "@/lib/verify-upload-admin";

export const dynamic = "force-dynamic";

// GET — table thumbnail (plan §7): the derived JPEG when present, else the
// original. Content-Type comes from the SNIFFED magic of the bytes served
// (never the extension) + X-Content-Type-Options: nosniff — both built in
// lib/verify-upload-admin so the polyglot behavior is unit-tested. NOT
// separately admin-audited: thumbnails load as part of the (audited) list
// view; one line per view, not one per row image.

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });

  const itemId = params.id;
  if (!isSafeItemId(itemId)) {
    return NextResponse.json({ ok: false, error: "Invalid item id." }, { status: 400 });
  }

  const f = readThumbnailSource(itemId);
  if (!f) return NextResponse.json({ ok: false }, { status: 404 });

  return new NextResponse(new Uint8Array(f.buf), { status: 200, headers: f.headers });
}
