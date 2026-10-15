import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { listVerifyUploads } from "@/lib/verify-upload-admin";

export const dynamic = "force-dynamic";

// Admin verify-upload corpus listing (plan §7). Thin HTTP shell over
// lib/verify-upload-admin: adminSession() gate (same 404-not-json-error shape
// as the impersonation route — never reveal /admin exists), pagination params,
// one admin-audit line per real view. This module references ONLY adminSession.

export async function GET(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  const sp = req.nextUrl.searchParams;
  const offset = Math.max(0, Math.floor(Number(sp.get("offset")) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(sp.get("limit")) || 50)));

  const listing = listVerifyUploads(offset, limit);

  // Loud-fail, never-throw (review fix): an audit-sink failure must not 500 a
  // listing that already succeeded — recordAdminAction logs ADMIN-AUDIT-FAILURE.
  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-list",
    detail: { offset, limit },
  });

  return NextResponse.json({ ok: true, ...listing });
}
