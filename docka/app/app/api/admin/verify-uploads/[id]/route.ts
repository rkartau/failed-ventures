import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { deleteVerifyUpload, isSafeItemId } from "@/lib/verify-upload-admin";

export const dynamic = "force-dynamic";

// DELETE — per-item corpus delete (plan §7): bytes + derived + sidecar removed,
// tombstone appended to the verify-uploads chain (inside deleteVerifyUpload),
// plus the admin-audit line naming WHO deleted. adminSession() gate first; the
// id is regex-gated before it may touch the filesystem.

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  const itemId = params.id;
  if (!isSafeItemId(itemId)) {
    return NextResponse.json({ ok: false, error: "Invalid item id." }, { status: 400 });
  }

  const res = await deleteVerifyUpload(itemId);
  if (!res.ok) return NextResponse.json({ ok: false }, { status: 404 });

  // Loud-fail, never-throw (review fix): the delete already happened — an
  // audit-sink failure must not 500 it; recordAdminAction logs ADMIN-AUDIT-FAILURE.
  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-delete",
    detail: { itemId },
  });

  return NextResponse.json({ ok: true });
}
