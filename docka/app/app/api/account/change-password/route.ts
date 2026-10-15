// feat/password-signup Step 13a — POST /api/account/change-password
//
//   { currentPassword, newPassword }
//
// Order (binding): (1) CSRF stance (lib/auth-csrf.ts — same as /api/signup)
// BEFORE anything; (2) session gate — a VALID password session resolved to its
// owning CredentialUser via the Step 5 validators (lib/account-session.ts);
// (3) changePassword (lib/credential-auth.ts) charges auth-account-mgmt
// (5/h/account, global 60/h) BEFORE any scrypt, verifies the CURRENT password
// (required — a stolen live session must not silently rotate the credential),
// then one transact CAS stamps the new hash + passwordChangedAt and emits
// PASSWORD_CHANGE (id-only) through the transact collector.
//
// pwdAt semantics: the new passwordChangedAt makes every OTHER outstanding JWT
// stale (Step 5 gates); the CURRENT client immediately re-signIns with the new
// password to re-mint its own token (AccountSecurity.tsx). If that leg fails,
// the honest outcome is pw.pwChangedSignIn — the change has still committed.

import { changePassword } from "@/lib/credential-auth";
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
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

    const res = await changePassword({
      credentialUserId: acct.user.id,
      currentPassword,
      newPassword,
    });
    if (res.ok) return Response.json({ ok: true });
    if (res.reason === "rate") {
      return Response.json({ ok: false, errorKey: "pw.errRate" }, { status: 429 });
    }
    if (res.reason === "weak") {
      return Response.json({ ok: false, errorKey: "pw.errWeak" }, { status: 400 });
    }
    // Wrong/missing current password and every other miss — ONE generic answer.
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
  } catch {
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 500 });
  }
}
