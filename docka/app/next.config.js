/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // SEO WP-A: never advertise the framework (`X-Powered-By: Next.js`).
  poweredByHeader: false,
  images: { unoptimized: true },
  // Enable the app/instrumentation.ts boot hook (Next 14 — stable in 15). Used for
  // the DOCKA_DEMO_LOGIN production boot assertion (F2).
  experimental: { instrumentationHook: true },
  // TS7 — baseline security headers. The CSP is DELIBERATELY narrow: only the three
  // resource-agnostic directives (frame-ancestors/base-uri/object-src). It does NOT set
  // default-src/script-src/style-src/connect-src, which would break gtag/GTM/Stripe/fonts.
  async headers() {
    // Baseline security headers — apply to EVERY route (unchanged).
    const securityHeaders = [
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Clickjacking defence — legacy header kept alongside CSP frame-ancestors
      // for older browsers.
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      // Deny powerful features the site never uses.
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
      // Cross-origin isolation for the browsing context. Use
      // `same-origin-allow-popups` (NOT plain `same-origin`) so the Google
      // sign-in popup and Stripe checkout — which the site opens as popups —
      // keep their window.opener handle and can post back. No COEP is set:
      // COEP would break gtag/GTM/Stripe/font subresource loads.
      {
        key: "Cross-Origin-Opener-Policy",
        value: "same-origin-allow-popups",
      },
      // Safe CSP subset ONLY: forbid framing by third parties, lock <base>, and
      // block <object>/<embed>. No script/style/connect directives (see note above).
      {
        key: "Content-Security-Policy",
        value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
      },
    ];

    // 4.1 — Cache-Control ALLOWLIST (SEO remediation It.4). Root cause: the root
    // layout (`app/app/layout.tsx`) calls `cookies()` for the language cookie, which
    // opts EVERY route into dynamic rendering, so Next emits
    // `Cache-Control: private, no-store` site-wide. That default is CORRECT for every
    // authed/token/API route and MUST stay — but it also kills back/forward-cache
    // (bfcache) on the public marketing pages. This is an explicit ALLOWLIST, NEVER a
    // denylist: ONLY the PII-free public marketing paths below get a bfcache-eligible-
    // but-still-revalidated header (`private, max-age=0, must-revalidate` = cacheable in
    // bfcache yet revalidated on every navigation, so content is never stale; `private`
    // — not `public` — bars shared/proxy caches because the sitewide ImpersonationBanner
    // can SSR admin PII into any route, while still restoring browser bfcache).
    // Everything not listed here keeps Next's `no-store` — including /agent, /seafarer,
    // /admin, /api, /o, /u, /share, /portal, and /verify/[uuid] result pages.
    // Collision safety: only anchored literals + explicit `:path*` variants of the
    // allowlisted marketing roots appear here. There is NO `/o`, `/u`, `/share`,
    // `/portal`, `/agent`, `/seafarer`, `/admin`, or `/api` rule, so path-to-regexp can
    // never let an `/overview` rule touch `/o/*` (or vice-versa) — the prefixes are
    // matched as whole, anchored patterns and cannot overlap.
    // `/verify` is allowlisted as the EXACT tool landing ONLY (no `:path*`), because its
    // dynamic verification-RESULT children live at `/verify/[uuid]` and MUST stay
    // no-store — so they are deliberately excluded from the allowlist.
    const MARKETING_CACHE_CONTROL = "private, max-age=0, must-revalidate";
    const cacheableMarketingSources = [
      "/",
      "/pricing",
      "/about",
      "/contact",
      "/registries",
      "/registries/:path*", // spokes: /registries/azerbaijan, /registries/ukraine (public)
      "/resources",
      "/resources/:path*", // article children (all public)
      "/overview",
      "/overview/:path*", // /overview/agencies, /overview/seafarers (public)
      "/verify", // EXACT ONLY — NOT /verify/:path* (protects /verify/[uuid] result pages)
      // SEO WP-A (plan v2 R16 / v3 S4): three more PII-free public pages. `/book` is
      // deliberately NOT here — app/book/page.tsx reads `searchParams.lead` (a per-lead
      // outreach token), so it must keep Next's `no-store`.
      "/privacy",
      "/sample/seafarer", // public demo profile (fixture data, no real PII)
      "/sample/agency", // public demo agency view (fixture data)
      // Public pages owned by WP-E (harmless if the route is absent).
      "/terms",
      "/what-is-primary-source-verification",
      "/security", // deferred — page struck from the plan (owner-gated); literal kept per S4
    ];

    // SEO WP-A: long-lived caching for committed PUBLIC static assets under
    // `public/` — product screenshots and the sample-document thumbnails (WP-C).
    // Both are checked-in fixtures (never tokenised uploads and no PII), so a
    // shared/proxy-cacheable `public` header is safe (plan v2 R10). A day of
    // freshness + a week of stale-while-revalidate: a redeploy that changes an
    // image is picked up within 24h without ever blocking a render.
    const STATIC_ASSET_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
    // public/apple-touch-icon.png (the default iOS path, a byte copy of app/apple-icon.png)
    // is a committed asset too, so it gets the same header. The app-dir metadata icons
    // (app/favicon.ico, app/icon.png, app/apple-icon.png) are deliberately NOT listed:
    // Next's metadata route handler sets its own Cache-Control on those (1-year immutable
    // for the hashed PNGs; `max-age=0, must-revalidate` for favicon.ico) and a headers()
    // rule is APPENDED, not substituted, which yields two Cache-Control headers (verified
    // live 2026-09-07). Long-caching favicon.ico needs it served from public/ instead.
    const staticAssetSources = ["/screenshots/:path*", "/samples/:path*", "/apple-touch-icon.png"];

    return [
      { source: "/:path*", headers: securityHeaders },
      ...cacheableMarketingSources.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: MARKETING_CACHE_CONTROL }],
      })),
      // Keep AFTER the /:path* security group (Next applies matching groups in order;
      // the security headers still apply to these assets).
      ...staticAssetSources.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: STATIC_ASSET_CACHE_CONTROL }],
      })),
    ];
  },
};

module.exports = nextConfig;
