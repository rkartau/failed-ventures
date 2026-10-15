// feat/password-signup Step 14 (D13) — POST /api/admin/credential-rescue
//
//   { seafarerId }
//
// Admin rescue for "seafarer lost password AND all recovery codes" (R2).
// Modeled on api/admin/impersonation/route.ts: the verb is gated on
// adminSession() (real Google + allowlist, NO dev door), the acting admin's
// e-mail ALWAYS comes from the session, and the target id is validated against
// the store (inside the rescue transact).
//
// The rescue itself is ONE transact (lib/credential-auth.ts
// rescueCredentialProfile): ownership-shape guard (v6 fold 2 — a row with
// googleSub or ownerEmail set is REFUSED: the reissued token would fail the
// Step 2 adopt guard and fork an empty profile), unbind both pointers, rotate
// ALL share tokens (every old claim link dies), orphan-scrub the CredentialUser
// when no binding remains (GDPR — emailUnverified deleted, username freed),
// and PROFILE_BIND (via "admin-rescue", ids only) through the transact
// collector.
//
// recordAdminAction is awaited AFTER the transact resolves (v6 fold 5):
// it is async (appendAudit) and can never run inside the synchronous mutator.
// Accepted: a crash between the two loses only the admin-audit line, never the
// custody event.

import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { rescueCredentialProfile } from "@/lib/credential-auth";
import { getPublicBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  const body = (await req.json().catch(() => ({}))) as { seafarerId?: string };
  const seafarerId = (body.seafarerId ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }

  // Public Sample Profiles: rescue would mint a working claim link for a PUBLIC
  // demo account — refused outright, same generic shape as "not rescuable".
  if (readDB().seafarers.find((s) => s.id === seafarerId)?.isSample === true) {
    return NextResponse.json({ ok: false, error: "Not rescuable." }, { status: 400 });
  }

  // ONE transact — guard + unbind + rotate + conditional orphan-delete + audit.
  const rescue = await rescueCredentialProfile(seafarerId);
  if (!rescue.ok) {
    // Missing profile, no credential owner, or the ownership-shape guard
    // (Google-owned / co-owned) — one generic refusal.
    return NextResponse.json({ ok: false, error: "Not rescuable." }, { status: 400 });
  }

  // AFTER the transact (v6 fold 5) — async admin-audit line, ids only.
  await recordAdminAction({
    adminEmail: email,
    action: "credential-rescue",
    detail: { seafarerId, credId: rescue.credId, orphanDeleted: rescue.orphanDeleted },
  });

  // The fresh claim link, built the same way the invite flow builds one
  // (/seafarer?token=<share token> on the public base URL).
  const claimLink = `${getPublicBaseUrl(req)}/seafarer?token=${rescue.claimToken}`;
  return NextResponse.json({
    ok: true,
    claimLink,
    orphanDeleted: rescue.orphanDeleted,
    // When the orphan delete freed the username, the admin can tell the
    // seafarer they may re-register the same name.
    freedUsername: rescue.freedUsername,
  });
}
