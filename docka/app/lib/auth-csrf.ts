// feat/password-signup Step 6 — the CSRF stance shared by the custom auth POST
// routes (/api/signup, /api/recovery-reset; Step 13's account routes reuse it).
// It lives here because Next route files may only export route handlers.
//
// STANCE (r2 revision 8 — old/constrained webviews may send NEITHER Origin nor
// Referer): require `Content-Type: application/json` on EVERY request — a
// cross-origin HTML form can only produce x-www-form-urlencoded / multipart /
// text/plain without triggering a CORS preflight, and a preflighted JSON
// request is denied by the same-origin-only default (no CORS headers served).
// Enforcement order:
//   (1) JSON content-type required ALWAYS, else deny — matched on the MIME
//       type, not an exact string: `application/json; charset=utf-8` passes.
//   (2) If `Origin` is present its host must equal the request host, else deny.
//       The literal `Origin: null` opaque origin fails URL parsing ⇒ denied
//       (fails closed as written).
//   (3) Else if `Referer` is present its host must match, else deny.
//   (4) If BOTH headers are absent ⇒ ALLOW — the JSON requirement is the CSRF
//       backstop for headerless webviews.
// Callers run this BEFORE any rate-bucket charge (v4): cross-origin junk must
// never burn a victim IP's budget.

import { getPublicBaseUrl } from "@/lib/base-url";

type RequestLike = {
  headers: { get(name: string): string | null };
  nextUrl?: { origin: string; host?: string };
};

/** The set of hosts that count as "this deployment" for the Origin/Referer check. */
function allowedHosts(req: RequestLike): Set<string> {
  const allowed = new Set<string>();
  const host = req.headers.get("host");
  if (host) allowed.add(host.trim().toLowerCase());
  // Behind the reverse proxy the Host header is localhost — the public origin
  // (AUTH_URL on the box) and the client-facing x-forwarded-host must count too.
  const fwdHost = req.headers.get("x-forwarded-host");
  if (fwdHost) allowed.add(fwdHost.split(",")[0].trim().toLowerCase());
  try {
    const pub = new URL(getPublicBaseUrl(req));
    if (pub.host) allowed.add(pub.host.toLowerCase());
  } catch {
    // no resolvable public base URL — the remaining candidates decide
  }
  const nuHost = req.nextUrl?.host;
  if (nuHost) allowed.add(nuHost.toLowerCase());
  return allowed;
}

/** True when the request passes the Step 6 same-origin-JSON CSRF stance. */
export function sameOriginJsonOk(req: RequestLike): boolean {
  const contentType = req.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime !== "application/json") return false;

  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      return allowedHosts(req).has(new URL(origin).host.toLowerCase());
    } catch {
      return false; // "null" and other unparseable origins fail closed
    }
  }
  const referer = req.headers.get("referer");
  if (referer !== null) {
    try {
      return allowedHosts(req).has(new URL(referer).host.toLowerCase());
    } catch {
      return false;
    }
  }
  return true; // both absent — headerless webview; the JSON gate above is the backstop
}
