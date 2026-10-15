import { NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { backfillOwnerIdentity } from "@/lib/verify";
import { buildOwnerPayload } from "@/lib/owner-payload";

export const dynamic = "force-dynamic";

// Coarse stamp throttle for the HOT signed-in /me path. An actively-signed-in
// seaman resolves via the SESSION here and never hits the ?token= resolver, so we
// refresh their shareTokenLastUsedAt to stop the 24h idle TTL expiring their token
// under them when they later fall back to the token path. 1h granularity (vs the
// 5-min token-path throttle) is deliberate: idle-TTL correctness needs ~24h
// precision, not minutes — this cuts me-path whole-file rewrites ~12x while keeping
// an active token comfortably inside its 24h window (effective idle window ~24h–25h).
const ME_STAMP_THROTTLE_MS = 60 * 60 * 1000;   // 1h — coarse; idle-TTL needs no finer

// GET /api/seafarers/me — the signed-in SEAMAN's OWN profile + documents.
//
// Ownership + cross-device identity: the seafarer is resolved from the seaman
// SESSION (role:"seaman"), NOT from any id or token in the request, so signing in
// with Google on any device lands on the SAME profile. Fail-closed: no seaman
// session => 401. Strictly scoped to the session's own seafarerId — this route can
// never return another seafarer's data and grants no agent scope (it resolves no
// agent identity at all). The returned seafarer carries its OWN share token: the owner
// legitimately holds their own possession secret, so the existing token-authorised
// seaman flows (upload / edit / revoke / access-reviews) keep working once signed in.
export async function GET() {
  const session = await seamanSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Not signed in as a seafarer." },
      { status: 401 }
    );
  }
  // Sample belt-and-braces (census row 22): no session can exist for a sample row
  // (adoption/signup/dev doors all refuse), but even a forged/dev session must
  // never resolve one — and never trigger the backfill/stamp writes below.
  if (readDB().seafarers.find((s) => s.id === session.seafarerId)?.isSample === true) {
    return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
  }

  // Self-heal the OWNER's verified identity from their government-verified docs
  // before serving the profile (populates identityVerified/verifiedName if a
  // verified cert exists but the profile fields were never filled). Owner-scoped.
  await backfillOwnerIdentity(session.seafarerId);

  // Slide the self-access idle-TTL stamp on this active signed-in resolve, throttled
  // to 1h so the hot /me path does not rewrite the whole db.json on every load.
  const now = Date.now();
  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === session.seafarerId);
    if (s && (s.shareTokenLastUsedAt === undefined || now - s.shareTokenLastUsedAt > ME_STAMP_THROTTLE_MS)) {
      s.shareTokenLastUsedAt = now;
    }
  });

  const db = readDB();
  // SHARED owner-payload projection (lib/owner-payload.ts, §D8): the SAME builder
  // the ?token= path uses, so the session and token channels can never drift —
  // documents / docRequests / profileChanges / seaService / flows /
  // propagationRequests (#38.5) / appraisalDeleteRequests (#12) exactly as this
  // route assembled them inline before (behavior-preserving; golden suite).
  const payload = buildOwnerPayload(db, session.seafarerId);
  if (!payload.seafarer) {
    return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    ...payload,
    signedIn: true,
    user: session.user,
    // feat/password-signup Step 13: "password" for credential sessions, else
    // absent — drives the client-side Account section. Never any other auth
    // detail (invariant 13: emailUnverified is NOT surfaced here).
    authMethod: session.authMethod,
  });
}
