// Client-safe consent core: cookie helpers + the trackable-path gate. No network,
// no React — pure functions shared by <Analytics>, <ConsentBanner> and the events
// helper so the "is this path/consent OK to track" decision lives in ONE place
// (AP1). The GA4 measurement id / GTM container id are passed as props from the
// server (read RUNTIME from process.env) — never imported here.

import { SITE_PAGES } from "@/lib/site-pages";

export const CONSENT_COOKIE = "docka_consent";
export type ConsentChoice = "granted" | "denied";

// ~6 months, in seconds.
export const CONSENT_MAX_AGE = 15552000;

// Custom window events keep the (independent) banner + analytics client components
// in sync without prop-drilling or a shared context.
export const CONSENT_CHANGE_EVENT = "docka-consent-change";
export const OPEN_CONSENT_EVENT = "docka-open-consent";

// PUBLIC allowlist — EXACT match only (AP1 BLOCKER). Derived from the ONE public
// page catalogue (`SITE_PAGES`, the same array the sitemap and /llms.txt are
// projected from) plus /signup (an auth page, deliberately kept out of the
// sitemap). Analytics fires on NOTHING else: never on /agent*, /seafarer, /share/*,
// /portal/*, /verify/<uuid>, /admin*, /o/*, /u/*, /directory — those paths carry
// secret tokens / ids / PII, and query strings can carry seafarer names. Both
// page_view and events route through here.
//
// 2026-09-07: replaced the hand-typed 8-path list (22 of the 30 public landing
// pages fired nothing, so GA4 under-counted organic traffic). /book and /signup
// still send the bare pathname: the ?lead= / ?t= attribution query never reaches
// GA4 (lib/analytics-events.ts pageLocation() drops every query on those two
// paths; no per-lead data).
export const TRACKABLE_PATHS: ReadonlySet<string> = new Set<string>([
  ...SITE_PAGES.map((p) => p.path),
  "/signup",
]);

// Prefixes of every PRIVATE surface. Consulted by TESTS ONLY, to assert the
// invariant "no trackable path is private" — the allowlist above is the single
// runtime gate. A prefix ending in "/" matches only deeper paths ("/verify/" is
// private, "/verify" is the public tool landing); a bare prefix matches itself and
// its subtree ("/agent", "/agent/x"). Pure data; nothing here throws at load.
export const PRIVATE_PATH_PREFIXES: readonly string[] = Object.freeze([
  "/agent",
  "/seafarer",
  "/share/",
  "/portal/",
  "/admin",
  "/api/",
  "/verify/",
  "/o/",
  "/u/",
  "/directory",
]);

/** Drop query/hash and a trailing slash (except the root) so "/overview/" is "/overview". */
function normalisePath(pathname: string): string {
  let p = pathname.split("?")[0].split("#")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

/** True only for the exact public paths above. Query/hash are ignored. */
export function isTrackablePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return TRACKABLE_PATHS.has(normalisePath(pathname));
}

/** Prefix match against PRIVATE_PATH_PREFIXES (tests only — see the note above). */
export function isPrivatePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = normalisePath(pathname);
  return PRIVATE_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(prefix + "/")
  );
}

/**
 * The ONE render gate for the GA4 gtag <Script> and the GTM container alike:
 * stored consent granted AND at least one id configured AND the current path on
 * the public allowlist. On every other route (private surfaces, token pages) the
 * tag is not rendered at all, so a property-level auto event has nothing to run in.
 * The GTM container (gaId "" + gtmId set) follows exactly the same rule.
 */
export function shouldRenderTag({
  granted,
  pathname,
  gaId,
  gtmId = "",
}: {
  granted: boolean;
  pathname: string | null | undefined;
  gaId: string;
  gtmId?: string;
}): boolean {
  return granted && Boolean(gaId || gtmId) && isTrackablePath(pathname);
}

/**
 * Type guard: is `v` one of the two stored consent values? Pure and server-safe
 * (SEO plan v3 S3): the root layout calls it on the raw cookie value to decide
 * whether the consent bar is server-rendered open, so the SSR HTML and the
 * hydrated client agree on first paint (no consent-bar CLS).
 */
export function isConsentChoice(v: unknown): v is ConsentChoice {
  return v === "granted" || v === "denied";
}

/** Read the stored consent choice, or null if the visitor hasn't chosen yet. */
export function readConsentCookie(): ConsentChoice | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)docka_consent=([^;]+)/);
  const v = m?.[1];
  return v === "granted" || v === "denied" ? v : null;
}

/** Persist the consent choice: Path=/, ~6-month Max-Age, SameSite=Lax, Secure. */
export function writeConsentCookie(choice: ConsentChoice): void {
  if (typeof document === "undefined") return;
  document.cookie = `${CONSENT_COOKIE}=${choice}; Path=/; Max-Age=${CONSENT_MAX_AGE}; SameSite=Lax; Secure`;
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}
