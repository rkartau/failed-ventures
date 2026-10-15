// Layer B — runtime middleware admin gate (defense-in-depth, FAIL CLOSED).
//
// This is a COARSE edge pre-filter that blocks /admin/:path* BEFORE any admin
// page renders. It is NOT the authoritative check — the per-page adminSession()
// in lib/admin-session.ts (Layer C) is. This module only exists to make sure a
// request that could never pass the real gate never even reaches an admin render.
//
// EDGE-SAFETY (critical): Next 14 middleware runs on the edge runtime. We must
// NEVER import "@/auth" (auth.ts) here — auth.ts transitively pulls
// lib/seaman-account -> lib/seaman-otp -> lib/db -> node "fs", which breaks the
// edge bundle. Keep this file's imports edge-safe ONLY: next/server,
// next-auth/jwt, and local constants. Do NOT import lib/admin-session.ts either
// (it imports @/auth, so it is NOT edge-safe).
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
// Edge-safe: base-url.ts reads only process.env, request headers, and the request's
// own origin (no node "fs"/db imports), so it is safe in the edge middleware bundle.
import { getPublicBaseUrl } from "@/lib/base-url";
// Edge-safe (pure string/RegExp; no fs) — the matcher source-of-truth + drift guard.
import { isTrackingPath, assertMatcherLiteralInSync } from "@/lib/tracking-matcher";
// Edge-safe abuse controls for the /o and /u tracking endpoints (plan §2 B6).
import {
  clientIpFromHeaders,
  consumeTrackingBudget,
  bodyOverCap,
} from "@/lib/tracking-edge";

// Admin allowlist from the ADMIN_EMAILS env var (comma-separated). MUST parse
// exactly like ADMIN_EMAILS in lib/admin-session.ts (Layer C). Defined inline
// (not imported) because lib/admin-session.ts is not edge-safe. Unset = no admins.
const ADMIN_EMAILS: Set<string> = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Cookie names NextAuth/@auth-core may set for the session JWT. Over HTTPS
// (production, docka.me) it prefixes with "__Secure-"; over plain HTTP (local
// dev) it uses the bare name. getToken() derives its salt from the cookie name,
// so we must hand it the RIGHT name for decode to succeed — detected below.
const SECURE_COOKIE = "__Secure-authjs.session-token";

/**
 * Edge gate for /admin/:path*. Fails CLOSED on every failure mode:
 *   - no session token
 *   - token with no email
 *   - non-allowlisted email
 *   - getToken() throws (AUTH_SECRET unset, malformed/expired cookie, etc.)
 * Never falls through to "allow" on an error.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  // ---- Tracking endpoints (/o, /u): abuse controls, then pass through --------
  // These are PUBLIC by design (they live in sent mail) — never the admin gate.
  // Edge-safe controls only: a per-IP rate cap + a small request-body size cap.
  // No body rewrite/buffering. The event-FILE/disk ceiling is enforced in the
  // Node route via appendEvent (the edge runtime cannot stat the filesystem).
  if (isTrackingPath(req.nextUrl.pathname)) {
    if (bodyOverCap(req.headers)) {
      return new NextResponse("Payload Too Large", { status: 413 });
    }
    const ip = clientIpFromHeaders(req.headers);
    if (!consumeTrackingBudget(ip)) {
      return new NextResponse("Too Many Requests", { status: 429 });
    }
    return NextResponse.next();
  }

  // ---- Admin gate (pre-existing) --------------------------------------------
  try {
    const secret = process.env.AUTH_SECRET;
    // AUTH_SECRET unset -> we cannot verify anyone -> DENY (F2). Do not proceed.
    if (!secret) return redirectToSignIn(req);

    // Match the cookie name (and therefore the decode salt) NextAuth actually
    // used: prefixed over HTTPS, bare in dev. getToken handles chunk reassembly
    // and salt derivation internally once given the correct name.
    const secureCookie = req.cookies.has(SECURE_COOKIE);

    const token = await getToken({ req, secret, secureCookie });

    const email = (token?.email ?? "").trim().toLowerCase();
    if (email && ADMIN_EMAILS.has(email)) {
      // Passed the coarse check — let it through to the authoritative Layer C.
      return NextResponse.next();
    }

    // Signed in with a real (non-admin) identity -> 404 rather than reveal that
    // /admin exists (mirrors Layer C's notFound()). Not signed in at all ->
    // send to the Google sign-in entry.
    if (token) return notFound();
    return redirectToSignIn(req);
  } catch {
    // getToken threw (bad AUTH_SECRET, malformed cookie, decode failure, ...).
    // FAIL CLOSED — never open on an exception.
    return redirectToSignIn(req);
  }
}

// Not-signed-in deny: bounce to the app's Google sign-in entry (standard
// NextAuth v5 handler route, app/api/auth/[...nextauth]/route.ts).
//
// HOST FIX: behind the reverse proxy, `next start` sees the request line host as
// localhost:3000, and Next does NOT fold x-forwarded-host into req.nextUrl in the
// edge runtime (only NextAuth does, via AUTH_TRUST_HOST). Cloning req.nextUrl here
// therefore emitted `Location: https://localhost:3000/api/auth/signin` — a host the
// browser cannot follow. Build the redirect on the PUBLIC base (AUTH_URL ->
// x-forwarded-host -> request origin) so the emitted Location, and any callbackUrl
// derived from it, always carry the public host. WHO/WHEN is unchanged — only the
// host of the emitted URL. We keep the existing behavior of not attaching a
// callbackUrl (search stays empty), so no localhost can leak through a return-to.
function redirectToSignIn(req: NextRequest): NextResponse {
  const url = new URL("/api/auth/signin", getPublicBaseUrl(req));
  return NextResponse.redirect(url);
}

// Signed-in-but-not-allowed deny: a plain 404, no body, no admin disclosure.
function notFound(): NextResponse {
  return new NextResponse("Not Found", { status: 404 });
}

// Matcher: the admin gate PLUS the two public tracking endpoints. Kept as an
// inline literal so Next can statically extract it (an imported/spread matcher
// can silently fail to apply — the dead-allowlist bug). The source of truth is
// lib/tracking-matcher.MIDDLEWARE_MATCHER; the assert below fails CLOSED (throws
// when this module loads) if the literal drifts from it, and
// instrumentation.register() fails BOOT if the patterns stop matching /o & /u.
export const config = { matcher: ["/admin/:path*", "/o/:path*", "/u/:path*"] };
assertMatcherLiteralInSync(config.matcher);
