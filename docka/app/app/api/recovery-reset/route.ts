// feat/password-signup Step 6 — POST /api/recovery-reset (D7).
//
//   { identifier, code, newPassword }
//
// Same CSRF stance as /api/signup (lib/auth-csrf.ts), enforced BEFORE any
// work. Rate buckets are charged by resetPasswordWithRecoveryCode itself
// (auth-recovery-ip via clientIp + auth-recovery-id + post-resolution
// auth-recovery-acct) — this route re-charges NOTHING. Code normalization
// (D7: trim/case/spaces/dashes + the Crockford confusable map) is applied
// inside the lib before every hash/compare.
//
// Success ⇒ { ok:true, remainingCodes:n }. ANY failure — unknown identifier,
// wrong code, reused code, over-limit, malformed body — collapses to ONE
// generic { ok:false, errorKey:"pw.errRecovery" }: no oracle for which part
// failed. (Documented residual R3: response TIMING may distinguish account
// existence — 1 dummy scrypt vs up to 8 real verifies — accepted, bounded by
// the 3/h identifier + 3/h account buckets.)

import { resetPasswordWithRecoveryCode } from "@/lib/credential-auth";
import { clientIpFromHeaders } from "@/lib/auth-rate-limit";
import { sameOriginJsonOk } from "@/lib/auth-csrf";

export const dynamic = "force-dynamic";

const GENERIC_FAIL = { ok: false, errorKey: "pw.errRecovery" } as const;

export async function POST(req: Request) {
  try {
    if (!sameOriginJsonOk(req)) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return Response.json(GENERIC_FAIL, { status: 400 });
    }
    const identifier = typeof body.identifier === "string" ? body.identifier : "";
    const code = typeof body.code === "string" ? body.code : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    const res = await resetPasswordWithRecoveryCode({
      identifier,
      code,
      newPassword,
      clientIp: clientIpFromHeaders(req.headers),
    });
    if (res.ok) {
      return Response.json({ ok: true, remainingCodes: res.remainingCodes });
    }
    return Response.json(GENERIC_FAIL, { status: 400 });
  } catch {
    return Response.json(GENERIC_FAIL, { status: 500 });
  }
}
