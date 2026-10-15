import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { isSafeItemId } from "@/lib/verify-upload-admin";
import { rerunRecognition } from "@/lib/verify-upload";

export const dynamic = "force-dynamic";

// POST — re-run recognition for one corpus item (plan §7). The pipeline lives
// in lib/verify-upload.ts rerunRecognition: AUTH priority on THE ONE worker
// lane, tombstone check immediately before worker start AND before the sidecar
// write (a racing delete yields "deleted-during-run", never a resurrection),
// attempt recorded in sidecar retries[] + a rerun-flagged chain event.

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  const itemId = params.id;
  if (!isSafeItemId(itemId)) {
    return NextResponse.json({ ok: false, error: "Invalid item id." }, { status: 400 });
  }

  const res = await rerunRecognition(itemId);

  // Loud-fail, never-throw (review fix): the re-run already ran — an audit-sink
  // failure must not 500 it; recordAdminAction logs ADMIN-AUDIT-FAILURE.
  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-rerun",
    detail: { itemId, result: res.status },
  });

  if (res.status === "not-found") return NextResponse.json({ ok: false }, { status: 404 });
  return NextResponse.json({ ok: true, ...res });
}
