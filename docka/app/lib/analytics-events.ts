// PII-FREE analytics event helper (AP6) + the pure gtag reducers <Analytics> runs.
//
// track() is a hard no-op unless ALL of:
//   - running in the browser,
//   - the event name is one of EVENT_NAMES (TS type at dev time, runtime guard too),
//   - window.gtag exists (the Consent Mode default snippet defines it; the GA4
//     library itself is block-until-consent),
//   - stored consent === "granted",
//   - the current path is on the public allowlist (isTrackablePath).
// Params are whitelisted to a tiny PII-free key set and a strict value charset —
// names/emails/ids/tokens can never reach the dataLayer even if a caller passes
// them. EVERY hit also carries an explicit `page_location` (built from the bare
// pathname + at most three bounded utm_ keys) and an empty `page_referrer`, so the
// gtag library never stamps `location.href` / `document.referrer` on it: the
// per-lead `?t=` / `?lead=` tokens on /signup and /book stay out of GA4 (leak B).
//
// The reducers at the bottom (onTagLoaded / routeReducer) are what <Analytics>
// applies; they are pure so tests can pin the exact call ORDER and the private-
// route pin ("/private" synthetic location) without a browser.

import { isTrackablePath, readConsentCookie, shouldRenderTag } from "@/lib/consent";
import { SITE_URL } from "@/lib/seo";

export const EVENT_NAMES = [
  "cta_click",
  "persona_select",
  "sign_up_start",
  "sign_up",
  "book_submit",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type EventParams = Record<string, string>;

// Only these keys are ever forwarded. Everything else is dropped.
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["location", "target", "persona", "method", "step"]);
// Values: short path-ish tokens only ("/book", "/sample/agency", "agencies_hero").
// Anything with ?, =, &, %, <, > or over 64 chars is dropped with its key.
const PARAM_VALUE_RE = /^[A-Za-z0-9_./-]{1,64}$/;

// Attribution query: exactly these keys survive on a page_location, in this order.
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;
const CAMPAIGN_VALUE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// The outreach lead-key shape (lib/booking sanitizeLeadKey) — never forward it,
// whatever key it arrives under.
const LEAD_KEY_SHAPE = /^LD\d+$/;
// The two tokened landing pages: the query is dropped WHOLESALE, utm_ included.
const NO_QUERY_PATHS: ReadonlySet<string> = new Set(["/book", "/signup"]);

/** Synthetic location pinned on every private route — not a real page. */
export const PRIVATE_LOCATION = `${SITE_URL}/private`;
export const PRIVATE_PAGE_FIELDS: Readonly<{ page_location: string; page_referrer: string; page_title: string }> =
  Object.freeze({ page_location: PRIVATE_LOCATION, page_referrer: "", page_title: "private" });

/** Bare pathname: no query, no hash, no trailing slash (root stays "/"). */
export function cleanPath(pathname: string): string {
  let p = pathname.split("?")[0].split("#")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/**
 * Origin-only referrer. "" for empty/invalid/non-http values (android-app://…),
 * "" for any docka.me host (same-site navigations carry no attribution and could
 * carry a token), otherwise `origin + "/"` — never a path or query.
 */
export function sanitizeReferrer(ref: string | null | undefined, siteUrl: string = SITE_URL): string {
  if (!ref) return "";
  try {
    const u = new URL(ref);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    const site = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
    if (host === site || host === `www.${site}` || host.endsWith(`.${site}`)) return "";
    return `${u.origin}/`;
  } catch {
    return "";
  }
}

/**
 * Bounded campaign query: only utm_source / utm_medium / utm_campaign, first
 * occurrence wins, trimmed, spaces → "_", strict charset, lead-key shapes dropped.
 * Returns "" or "?k=v&…". On /book and /signup ALWAYS "" (those pages carry
 * per-lead tokens beside any utm_ and must send the bare path). URLSearchParams
 * never throws on malformed percent-escapes and decodes "+" as a space.
 */
export function campaignQuery(search: string | null | undefined, pathname?: string): string {
  if (pathname && NO_QUERY_PATHS.has(cleanPath(pathname))) return "";
  if (!search) return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: string[] = [];
  for (const key of CAMPAIGN_KEYS) {
    const raw = params.get(key); // first occurrence
    if (raw === null) continue;
    const v = raw.trim().replace(/\s+/g, "_");
    if (!CAMPAIGN_VALUE_RE.test(v) || LEAD_KEY_SHAPE.test(v)) continue;
    out.push(`${key}=${v}`);
  }
  return out.length ? `?${out.join("&")}` : "";
}

/** The page_location every hit carries: SITE_URL + bare path + bounded utm_ query. */
export function pageLocation(pathname: string, search: string | null | undefined = ""): string {
  const p = cleanPath(pathname);
  return `${SITE_URL}${p}${campaignQuery(search, p)}`;
}

function sanitize(params: EventParams): EventParams {
  const out: EventParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v !== "string" || !PARAM_VALUE_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export function track(event: EventName, params: EventParams = {}): void {
  if (typeof window === "undefined") return;
  if (!(EVENT_NAMES as readonly string[]).includes(event)) return; // runtime enum guard
  const gtag = window.gtag;
  if (typeof gtag !== "function") return; // no analytics id configured
  if (readConsentCookie() !== "granted") return; // consent gate
  const { pathname, search } = window.location;
  if (!isTrackablePath(pathname)) return; // path allowlist gate
  gtag("event", event, {
    ...sanitize(params),
    // Belt: the event-level override beats whatever gtag('set') holds and beats
    // location.href — no per-lead query can ride along.
    page_location: pageLocation(pathname, search),
    page_referrer: "",
  });
}

// ---- pure reducers for <Analytics> ------------------------------------------------

/** One `gtag(...)` call, as its argument list. */
export type GtagArgs = readonly unknown[];

function pageViewCall(location: string, referrer: string, path: string): GtagArgs {
  return ["event", "page_view", { page_path: path, page_location: location, page_referrer: referrer }];
}

/**
 * What to run inside the gtag <Script onLoad>, in this ORDER:
 *   trackable:  set(real location + origin-only referrer) → config → page_view
 *   private:    set(/private, "", title "private")        → config   (no page_view)
 * `gtag('set')` runs BEFORE `config` so even the library's own first hits carry the
 * pinned location. Returns the path the page_view was sent for (null if none) so the
 * component can de-duplicate against the route effect.
 */
export function onTagLoaded({
  gaId,
  pathname,
  search,
  referrer,
}: {
  gaId: string;
  pathname: string;
  search: string;
  referrer: string;
}): { calls: GtagArgs[]; lastSentPath: string | null } {
  const config: GtagArgs = ["config", gaId, { send_page_view: false, anonymize_ip: true }];
  if (!isTrackablePath(pathname)) {
    return { calls: [["set", { ...PRIVATE_PAGE_FIELDS }], config], lastSentPath: null };
  }
  const path = cleanPath(pathname);
  const location = pageLocation(path, search);
  const ref = sanitizeReferrer(referrer);
  return {
    calls: [["set", { page_location: location, page_referrer: ref }], config, pageViewCall(location, ref, path)],
    lastSentPath: path,
  };
}

/**
 * What to run on EVERY pathname or consent change (unconditionally — the Consent
 * Mode queue stub accepts `set` before the library loads):
 *   private route → set(/private …); disable flag true; nothing sent.
 *   public route  → set(real); page_view only when the library is configured,
 *                   consent is granted, and this path was not the last one sent
 *                   (so the onLoad page_view and this effect never double-count).
 * `disable` is the value for window["ga-disable-<id>"]: true on private routes and
 * after Reject, which stops every hit for that measurement id regardless of
 * property settings.
 */
export function routeReducer({
  pathname,
  search,
  granted,
  gaId,
  gtmId = "",
  configured,
  lastSentPath,
}: {
  pathname: string;
  search: string;
  granted: boolean;
  gaId: string;
  gtmId?: string;
  configured: boolean;
  lastSentPath: string | null;
}): { disable: boolean; calls: GtagArgs[]; lastSentPath: string | null } {
  const disable = !shouldRenderTag({ granted, pathname, gaId, gtmId });
  if (!isTrackablePath(pathname)) {
    return { disable, calls: [["set", { ...PRIVATE_PAGE_FIELDS }]], lastSentPath: null };
  }
  const path = cleanPath(pathname);
  const location = pageLocation(path, search);
  const calls: GtagArgs[] = [["set", { page_location: location, page_referrer: "" }]];
  if (granted && configured && lastSentPath !== path) {
    calls.push(pageViewCall(location, "", path));
    return { disable, calls, lastSentPath: path };
  }
  return { disable, calls, lastSentPath };
}
