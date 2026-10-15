import { NextResponse } from "next/server";
import { buildPublicProof } from "@/lib/verify-record";
import { clientIpFromHeaders } from "@/lib/registry";

export const dynamic = "force-dynamic";

// GET /api/verify/<token>
//
// PUBLIC, no-login machine-readable re-verification of ONE government-verified
// credential (roadmap T1.4; per-country since increment 8). The token is
// tamper-evident (HMAC-signed); an invalid/forged token or a non-verified document
// returns 404 with a minimal body. On a hit it re-checks the credential LIVE against
// the issuing country's registry where supported (`recheckState:"live"`), or returns
// the honest stored snapshot (`"snapshot"` by design / `"rate-limited"` under the
// §2.4 budget — no fetch either way / `"unreachable"`), with only privacy-safe fields.
export async function GET(req: Request, { params }: { params: { uuid: string } }) {
  const proof = await buildPublicProof(params.uuid, { clientIp: clientIpFromHeaders(req.headers) });
  if (!proof) {
    return NextResponse.json(
      { ok: false, error: "This verification link is invalid or is not a verified credential." },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, ...proof });
}
