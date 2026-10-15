// Resolve the PUBLIC base URL for building externally-shared links (upload-card emails,
// copy-link UI, etc.).
//
// WHY this exists: in production the box runs `next start` on localhost behind a reverse
// proxy, so `req.nextUrl.origin` resolves to `https://localhost:3000` — which then leaks
// into emailed/copied share links. The canonical public URL is configured as AUTH_URL
// (set to https://docka.me on the box, same value NextAuth trusts via AUTH_TRUST_HOST),
// so we prefer it. We fall back to the proxy's x-forwarded-host, then finally the raw
// request origin for local dev where none of the above is set.

interface RequestLike {
  headers?: { get(name: string): string | null };
  nextUrl?: { origin: string };
}

export function getPublicBaseUrl(req: RequestLike): string {
  // 1. AUTH_URL — the canonical public URL, most reliable (set on the box).
  const configured = process.env.AUTH_URL?.trim();
  if (configured) {
    // Harden a mis-set env: if AUTH_URL lacks a scheme (e.g. "docka.me"), it would
    // yield a relative-looking link. Prefix https:// so it is always absolute.
    const withScheme = /:\/\//.test(configured) ? configured : `https://${configured}`;
    return withScheme.replace(/\/+$/, "");
  }

  // 2. Reverse-proxy forwarded host -> reconstruct the public origin.
  const fwdHost = req.headers?.get("x-forwarded-host");
  if (fwdHost) {
    // x-forwarded-host can be a comma-list ("docka.me, internal") when it passes
    // through multiple proxies — take the FIRST (client-facing) host.
    const host = fwdHost.split(",")[0].trim();
    const fwdProto = req.headers?.get("x-forwarded-proto")?.trim() || "https";
    return `${fwdProto}://${host}`.replace(/\/+$/, "");
  }

  // 3. Local dev fallback: the request's own origin.
  return (req.nextUrl?.origin ?? "").replace(/\/+$/, "");
}
