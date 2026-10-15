// feat/password-signup Step 13b — POST /api/account/regenerate-codes
//
//   { currentPassword }
//
// Same gate + CSRF stance + auth-account-mgmt bucket as change-password.
// regenerateRecoveryCodes (lib/credential-auth.ts) verifies the CURRENT
// password, mints 8 fresh codes (sequential scrypt, D8), then one transact CAS
// replaces the WHOLE recoveryCodes array (voids ALL old codes, used and
// unused) and emits CODES_REGENERATED (id-only). The response carries the 8
// plaintext codes exactly once — the client re-runs the one-time ceremony
// screen (RecoveryCodesScreen, incl. the username) with pw.regenTitle /
// pw.regenWarn. No pwdAt change: sessions stay valid (codes are not the
// password).

import { regenerateRecoveryCodes } from "@/lib/credential-auth";
import { passwordAccountSession } from "@/lib/account-session";
import { sameOriginJsonOk } from "@/lib/auth-csrf";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!sameOriginJsonOk(req)) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 403 });
    }
    const acct = await passwordAccountSession();
    if (!acct) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 401 });
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";

    const res = await regenerateRecoveryCodes({
      credentialUserId: acct.user.id,
      currentPassword,
    });
    if (res.ok) {
      // The ONLY time this set of codes exists in plaintext.
      return Response.json({ ok: true, recoveryCodes: res.recoveryCodes, username: res.username });
    }
    if (res.reason === "rate") {
      return Response.json({ ok: false, errorKey: "pw.errRate" }, { status: 429 });
    }
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
  } catch {
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 500 });
  }
}
