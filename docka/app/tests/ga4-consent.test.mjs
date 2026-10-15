// GA4 "see reality" plan (2026-09-07, v3 + v4 addendum) — the PURE contracts:
//   C1  TRACKABLE_PATHS is derived from SITE_PAGES (+ /signup); exact match only; no
//       trackable path is private (isPrivatePath invariant); trailing slash tolerated,
//       /signup/extra and every token/private surface stay out.
//   C2  shouldRenderTag matrix (consent x path x ids; GTM-only follows the same rule).
//   A1  onTagLoaded call ORDER: private → [set(/private), config]; public → [set(real),
//       config, page_view] with an origin-only referrer.
//   A2/A3 routeReducer: private pin on every route change, stickiness back to a real
//       location, exactly two page_views over / → /share/x → /pricing, hard-stop flag.
//   C3  sanitizeReferrer / campaignQuery / pageLocation (leak-safe attribution).
//   C4/A5 track(): whitelist, charset, enum guard, page_location belt (no ?t=, no
//       ?lead=), consent + path gates.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/ga4-consent.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_PAGES } from "@/lib/site-pages";
import {
  PRIVATE_PATH_PREFIXES,
  TRACKABLE_PATHS,
  isPrivatePath,
  isTrackablePath,
  shouldRenderTag,
} from "@/lib/consent";
import {
  EVENT_NAMES,
  PRIVATE_LOCATION,
  campaignQuery,
  cleanPath,
  onTagLoaded,
  pageLocation,
  routeReducer,
  sanitizeReferrer,
  track,
} from "@/lib/analytics-events";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...segs) => fs.readFileSync(path.join(APP, ...segs), "utf8");
const SITE = "https://docka.me";

const NOT_TRACKABLE = [
  "/agent",
  "/agent/x",
  "/seafarer",
  "/share/abc",
  "/portal/abc",
  "/verify/123e4567-e89b-12d3-a456-426614174000",
  "/admin",
  "/admin/leads",
  "/directory",
  "/terms",
  "/api/x",
  "/o/tok",
  "/u/tok",
  "/signup/extra",
  "/booking",
  "/private",
  "",
  null,
  undefined,
];

// =====================================================================================
// C1 — trackable set derived from the public catalogue
// =====================================================================================
test("C1: every SITE_PAGES path and /signup is trackable; nothing private is", () => {
  assert.ok(SITE_PAGES.length >= 30, `catalogue has ${SITE_PAGES.length} pages`);
  for (const { path: p } of SITE_PAGES) {
    assert.equal(isTrackablePath(p), true, `${p} must be trackable`);
    assert.equal(TRACKABLE_PATHS.has(p), true, `${p} must be in the set`);
    assert.equal(isPrivatePath(p), false, `${p} must not be private`);
  }
  assert.equal(isTrackablePath("/signup"), true);
  assert.equal(TRACKABLE_PATHS.size, SITE_PAGES.length + 1, "SITE_PAGES + /signup, nothing else");
  for (const p of NOT_TRACKABLE) assert.equal(isTrackablePath(p), false, `${p} must NOT be trackable`);
  for (const p of TRACKABLE_PATHS) assert.equal(isPrivatePath(p), false, `${p} is trackable, so must not be private`);
});

test("C1/A4: trailing slash and query/hash are normalised; /signup/extra is not /signup", () => {
  assert.equal(isTrackablePath("/signup/"), true);
  assert.equal(isTrackablePath("/book/"), true);
  assert.equal(isTrackablePath("/overview/"), true);
  assert.equal(isTrackablePath("/signup?t=abc.def"), true);
  assert.equal(isTrackablePath("/pricing#faq"), true);
  assert.equal(isTrackablePath("/signup/extra"), false);
  assert.equal(isTrackablePath("/verify/"), true, "'/verify/' normalises to the public tool landing");
});

test("C1: isPrivatePath prefix semantics (tests-only helper)", () => {
  assert.deepEqual(
    [...PRIVATE_PATH_PREFIXES],
    ["/agent", "/seafarer", "/share/", "/portal/", "/admin", "/api/", "/verify/", "/o/", "/u/", "/directory"]
  );
  for (const p of ["/agent", "/agent/x", "/seafarer", "/share/t", "/portal/t", "/admin/leads", "/api/x", "/verify/uuid", "/o/t", "/u/t", "/directory"]) {
    assert.equal(isPrivatePath(p), true, `${p} is private`);
  }
  for (const p of ["/verify", "/verify/", "/agentless", "/", "/pricing", "", null]) {
    assert.equal(isPrivatePath(p), false, `${p} is not private`);
  }
});

test("C1: the source builds TRACKABLE_PATHS from SITE_PAGES (grep proof) and never throws at load", () => {
  const src = read("lib", "consent.ts");
  assert.match(src, /import \{ SITE_PAGES \} from "@\/lib\/site-pages"/);
  assert.match(src, /TRACKABLE_PATHS[^=]*= new Set<string>\(\[\s*\.\.\.SITE_PAGES\.map\(\(p\) => p\.path\),\s*"\/signup",\s*\]\)/);
  assert.doesNotMatch(src, /^\s*throw /m, "no module-level throw in the client bundle");
  // No second hand-typed public list: the only quoted paths are /signup and the private prefixes.
  const quoted = [...src.matchAll(/^\s*"(\/[^"]*)",/gm)].map((m) => m[1]);
  assert.deepEqual(quoted, ["/signup", ...PRIVATE_PATH_PREFIXES]);
});

// =====================================================================================
// C2 — shouldRenderTag matrix
// =====================================================================================
test("C2: shouldRenderTag = granted AND an id AND a trackable path (GTM-only follows the same rule)", () => {
  const G = "G-TEST";
  const cases = [
    [{ granted: true, pathname: "/", gaId: G }, true],
    [{ granted: true, pathname: "/pricing", gaId: G }, true],
    [{ granted: true, pathname: "/signup/", gaId: G }, true],
    [{ granted: true, pathname: "/sample/agency", gaId: G }, true],
    [{ granted: true, pathname: "/registries/estonia", gaId: G }, true],
    [{ granted: false, pathname: "/", gaId: G }, false],
    [{ granted: true, pathname: "/", gaId: "" }, false],
    [{ granted: true, pathname: "/", gaId: "", gtmId: "GTM-X" }, true],
    [{ granted: true, pathname: "/share/x", gaId: "", gtmId: "GTM-X" }, false],
    [{ granted: false, pathname: "/", gaId: "", gtmId: "GTM-X" }, false],
    [{ granted: true, pathname: "/o/tok", gaId: G }, false],
    [{ granted: true, pathname: "/u/tok", gaId: G }, false],
    [{ granted: true, pathname: "/agent/x", gaId: G }, false],
    [{ granted: true, pathname: "/share/x", gaId: G }, false],
    [{ granted: true, pathname: "/verify/123e4567-e89b-12d3-a456-426614174000", gaId: G }, false],
    [{ granted: true, pathname: "/signup/extra", gaId: G }, false],
    [{ granted: true, pathname: null, gaId: G }, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shouldRenderTag(input), expected, JSON.stringify(input));
  }
});

test("C2: Analytics.tsx renders <Script> only behind shouldRenderTag and applies the reducers (grep proof)", () => {
  const src = read("components", "Analytics.tsx");
  const guard = src.indexOf("if (!shouldRenderTag({ granted, pathname, gaId, gtmId })) return null;");
  const firstScript = src.indexOf("<Script");
  assert.ok(guard > 0 && firstScript > guard, "every <Script> sits after the shouldRenderTag guard");
  assert.doesNotMatch(src, /if \(!granted\) return null/, "the old consent-only guard is gone");
  assert.match(src, /routeReducer\(/);
  assert.match(src, /onTagLoaded\(/);
  assert.match(src, /`ga-disable-\$\{gaId\}`\] = next\.disable/);
  assert.doesNotMatch(src, /gtag\("event", "page_view"/, "no inline page_view — only the reducers build hits");
  assert.match(src, /block-until-consent AND trackable-[\s/]*path-only/, "header comment updated");
});

// =====================================================================================
// C3 — attribution helpers
// =====================================================================================
test("C3/A7: sanitizeReferrer is origin-only, same-site-blind and never throws", () => {
  for (const bad of ["", "garbage", "android-app://com.google.android.gm", "https://docka.me/share/t", "https://www.docka.me/share/t", "https://app.docka.me/x", "http://DOCKA.ME/", "javascript:alert(1)", "ftp://x.y/", null, undefined]) {
    assert.equal(sanitizeReferrer(bad), "", `${bad}`);
  }
  assert.equal(sanitizeReferrer("https://www.google.com/search?q=x"), "https://www.google.com/");
  assert.equal(sanitizeReferrer("http://t.co/abc#frag"), "http://t.co/");
  assert.equal(sanitizeReferrer("https://www.bing.com:443/search"), "https://www.bing.com/");
  // Explicit siteUrl argument.
  assert.equal(sanitizeReferrer("https://example.org/a", "https://example.org"), "");
  assert.equal(sanitizeReferrer("https://sub.example.org/a", "https://www.example.org"), "");
  assert.equal(sanitizeReferrer("https://docka.me/", "https://example.org"), "https://docka.me/");
});

test("C3/A5/A6: campaignQuery keeps only three bounded utm_ keys, first wins, lead keys dropped, never throws", () => {
  assert.equal(campaignQuery("?lead=LD1&utm_source=x&t=tok&utm_medium=<script>"), "?utm_source=x");
  assert.equal(campaignQuery("?utm_campaign=Spring%20Sale"), "?utm_campaign=Spring_Sale");
  assert.equal(campaignQuery("?utm_campaign=Spring+Sale"), "?utm_campaign=Spring_Sale");
  assert.equal(campaignQuery("?utm_source=a&utm_source=b"), "?utm_source=a");
  assert.equal(campaignQuery("?utm_source=%E0%A4%A"), "");
  assert.equal(campaignQuery("?utm_source=LD12345"), "", "lead-key shape is never forwarded");
  assert.equal(campaignQuery("?utm_source=a=b"), "");
  assert.equal(campaignQuery("?utm_source=" + "a".repeat(65)), "");
  assert.equal(campaignQuery("?utm_source=" + "a".repeat(64)), "?utm_source=" + "a".repeat(64));
  assert.equal(campaignQuery("?utm_medium=email&utm_source=newsletter&utm_campaign=q3"), "?utm_source=newsletter&utm_medium=email&utm_campaign=q3");
  assert.equal(campaignQuery("?utm_term=x&utm_content=y&gclid=z"), "");
  assert.equal(campaignQuery(""), "");
  assert.equal(campaignQuery(null), "");
  assert.equal(campaignQuery("utm_source=bare"), "?utm_source=bare");
  // The two tokened landing pages drop the whole query.
  assert.equal(campaignQuery("?utm_source=x", "/book"), "");
  assert.equal(campaignQuery("?utm_source=x", "/signup"), "");
  assert.equal(campaignQuery("?utm_source=x", "/signup/"), "");
  assert.equal(campaignQuery("?utm_source=x", "/pricing"), "?utm_source=x");
});

test("C3: pageLocation = SITE_URL + bare path + bounded query; cleanPath normalises", () => {
  assert.equal(cleanPath("/signup/"), "/signup");
  assert.equal(cleanPath("/"), "/");
  assert.equal(cleanPath("/pricing?x=1#faq"), "/pricing");
  assert.equal(pageLocation("/", ""), `${SITE}/`);
  assert.equal(pageLocation("/registries/estonia", ""), `${SITE}/registries/estonia`);
  assert.equal(pageLocation("/pricing", "?utm_source=x&lead=LD1"), `${SITE}/pricing?utm_source=x`);
  assert.equal(pageLocation("/book", "?lead=LD1&utm_source=x"), `${SITE}/book`);
  assert.equal(pageLocation("/signup/", "?t=abc.def"), `${SITE}/signup`);
  assert.equal(PRIVATE_LOCATION, `${SITE}/private`);
});

// =====================================================================================
// A1 / A2 / A3 — reducers
// =====================================================================================
const CONFIG = ["config", "G-T", { send_page_view: false, anonymize_ip: true }];
const pageViews = (calls) => calls.filter((c) => c[0] === "event" && c[1] === "page_view");

test("A1: onTagLoaded order — private route: [set(/private), config], no page_view", () => {
  const { calls, lastSentPath } = onTagLoaded({ gaId: "G-T", pathname: "/agent/x", search: "?x=1", referrer: "https://www.google.com/" });
  assert.deepEqual(calls, [
    ["set", { page_location: `${SITE}/private`, page_referrer: "", page_title: "private" }],
    CONFIG,
  ]);
  assert.equal(lastSentPath, null);
});

test("A1: onTagLoaded order — /signup?t=abc: [set(bare), config, page_view], no t=, origin-only referrer", () => {
  const { calls, lastSentPath } = onTagLoaded({ gaId: "G-T", pathname: "/signup", search: "?t=abc", referrer: "https://www.google.com/search?q=docka" });
  assert.deepEqual(calls, [
    ["set", { page_location: `${SITE}/signup`, page_referrer: "https://www.google.com/" }],
    CONFIG,
    ["event", "page_view", { page_path: "/signup", page_location: `${SITE}/signup`, page_referrer: "https://www.google.com/" }],
  ]);
  assert.equal(lastSentPath, "/signup");
  assert.doesNotMatch(JSON.stringify(calls), /abc|t=/);
});

test("A1: onTagLoaded on a public page with a docka.me referrer sends an empty referrer", () => {
  const { calls } = onTagLoaded({ gaId: "G-T", pathname: "/registries/estonia", search: "", referrer: "https://docka.me/share/tok" });
  assert.equal(calls[0][1].page_referrer, "");
  assert.equal(pageViews(calls).length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /share|tok/);
});

test("A2/A3: routeReducer over / → /share/x → /pricing: exactly 2 page_views, private pin, sticky real location, flag", () => {
  const base = { search: "", granted: true, gaId: "G-T", configured: true };
  const all = [];
  let state = { lastSentPath: null };

  const s1 = routeReducer({ ...base, pathname: "/", lastSentPath: state.lastSentPath });
  all.push(...s1.calls);
  assert.equal(s1.disable, false);
  assert.deepEqual(s1.calls[0], ["set", { page_location: `${SITE}/`, page_referrer: "" }]);
  assert.equal(pageViews(s1.calls).length, 1);
  assert.equal(s1.lastSentPath, "/");

  const s2 = routeReducer({ ...base, pathname: "/share/x", lastSentPath: s1.lastSentPath });
  all.push(...s2.calls);
  assert.equal(s2.disable, true, "hard-stop flag on a private route");
  assert.deepEqual(s2.calls, [["set", { page_location: `${SITE}/private`, page_referrer: "", page_title: "private" }]]);
  assert.equal(s2.lastSentPath, null);

  const s3 = routeReducer({ ...base, pathname: "/pricing", lastSentPath: s2.lastSentPath });
  all.push(...s3.calls);
  assert.equal(s3.disable, false);
  assert.deepEqual(s3.calls[0], ["set", { page_location: `${SITE}/pricing`, page_referrer: "" }], "the real location is re-set after the private pin");
  assert.equal(pageViews(s3.calls).length, 1);
  assert.equal(s3.lastSentPath, "/pricing");

  assert.equal(pageViews(all).length, 2, "exactly two page_views over the sequence");
  assert.doesNotMatch(JSON.stringify(all), /share\/x/, "the private path never appears in any call");
});

test("A2: routeReducer sends no page_view before config, after Reject, or twice for one path", () => {
  const base = { pathname: "/pricing", search: "", gaId: "G-T" };
  const notConfigured = routeReducer({ ...base, granted: true, configured: false, lastSentPath: null });
  assert.equal(pageViews(notConfigured.calls).length, 0);
  assert.equal(notConfigured.lastSentPath, null);
  assert.equal(notConfigured.disable, false);
  assert.deepEqual(notConfigured.calls, [["set", { page_location: `${SITE}/pricing`, page_referrer: "" }]], "location is still pinned before load");

  const rejected = routeReducer({ ...base, granted: false, configured: true, lastSentPath: null });
  assert.equal(pageViews(rejected.calls).length, 0);
  assert.equal(rejected.disable, true, "Reject sets the hard-stop flag");

  const dup = routeReducer({ ...base, granted: true, configured: true, lastSentPath: "/pricing" });
  assert.equal(pageViews(dup.calls).length, 0, "already sent for this path (onLoad) → no second page_view");
  assert.equal(dup.lastSentPath, "/pricing");
});

test("A2: routeReducer pins /private unconditionally (even before consent) and GTM-only follows the same flag rule", () => {
  const r = routeReducer({ pathname: "/verify/123e4567-e89b-12d3-a456-426614174000", search: "?x=1", granted: false, gaId: "G-T", configured: false, lastSentPath: "/" });
  assert.deepEqual(r.calls, [["set", { page_location: `${SITE}/private`, page_referrer: "", page_title: "private" }]]);
  assert.equal(r.disable, true);
  assert.equal(r.lastSentPath, null);
  const gtmOnly = routeReducer({ pathname: "/pricing", search: "", granted: true, gaId: "", gtmId: "GTM-X", configured: false, lastSentPath: null });
  assert.equal(gtmOnly.disable, false);
});

// =====================================================================================
// C4 / A5 — track()
// =====================================================================================
/** Fake browser globals around `fn`; returns the recorded gtag calls. */
function withBrowser({ pathname, search = "", consent = "granted", gtag = true }, fn) {
  const calls = [];
  globalThis.window = {
    location: { pathname, search },
    ...(gtag ? { gtag: (...args) => calls.push(args) } : {}),
  };
  globalThis.document = { cookie: consent ? `docka_consent=${consent}` : "" };
  try {
    fn(calls);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
  return calls;
}

test("C4: EVENT_NAMES is the closed set and analytics-events never emits an event without page_location (grep proof)", () => {
  assert.deepEqual([...EVENT_NAMES], ["cta_click", "persona_select", "sign_up_start", "sign_up", "book_submit"]);
  const src = read("lib", "analytics-events.ts");
  const events = [...src.matchAll(/gtag\("event", event, \{([\s\S]*?)\}\);/g)];
  assert.equal(events.length, 1, "exactly one gtag('event') site in track()");
  assert.match(events[0][1], /page_location: pageLocation\(pathname, search\)/);
  assert.match(events[0][1], /page_referrer: ""/);
});

test("C4: sign_up_start on /signup?t=abc carries the bare page_location and no token", () => {
  const calls = withBrowser({ pathname: "/signup", search: "?t=abc.def" }, () => {
    track("sign_up_start", { step: "agent" });
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["event", "sign_up_start", { step: "agent", page_location: `${SITE}/signup`, page_referrer: "" }]);
  assert.doesNotMatch(JSON.stringify(calls), /abc|t=/);
});

test("C4: book_submit on /book?lead=LD1&utm_source=x sends no query at all", () => {
  const calls = withBrowser({ pathname: "/book", search: "?lead=LD1&utm_source=x" }, () => {
    track("book_submit");
  });
  assert.deepEqual(calls, [["event", "book_submit", { page_location: `${SITE}/book`, page_referrer: "" }]]);
});

test("C4: page_location on a public page keeps only the bounded utm_ query", () => {
  const calls = withBrowser({ pathname: "/pricing/", search: "?utm_source=li&utm_medium=<b>&fbclid=1" }, () => {
    track("cta_click", { location: "pricing_plan", target: "/agent/settings/billing" });
  });
  assert.equal(calls[0][2].page_location, `${SITE}/pricing?utm_source=li`);
  assert.equal(calls[0][2].target, "/agent/settings/billing");
});

test("A5: param whitelist + charset — existing targets pass, injections/ids/unknown keys are dropped", () => {
  const calls = withBrowser({ pathname: "/overview/agencies" }, () => {
    track("cta_click", { location: "agencies_hero", target: "/book" });
    track("cta_click", { location: "agencies_hero", target: "/sample/agency" });
    track("persona_select", { persona: "crewing-manager" });
    track("cta_click", { step: "<script>", location: "x?y=1", target: "a&b", persona: "100%", method: "ok", email: "a@b.c", name: "Jane" });
    track("sign_up", { method: "password", extra: "no", target: "a".repeat(65) });
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0][2], { location: "agencies_hero", target: "/book", page_location: `${SITE}/overview/agencies`, page_referrer: "" });
  assert.equal(calls[1][2].target, "/sample/agency");
  assert.equal(calls[2][2].persona, "crewing-manager");
  assert.deepEqual(calls[3][2], { method: "ok", page_location: `${SITE}/overview/agencies`, page_referrer: "" }, "every bad value dropped with its key");
  assert.deepEqual(calls[4][2], { method: "password", page_location: `${SITE}/overview/agencies`, page_referrer: "" });
});

test("A5: track() rejects event names outside EVENT_NAMES at runtime", () => {
  const calls = withBrowser({ pathname: "/" }, () => {
    track("purchase", { location: "x" });
    track("page_view", { location: "x" });
    track("", {});
  });
  assert.equal(calls.length, 0);
});

test("C4: consent denied/absent → no call; private path (/seafarer) → no call; no gtag → no call; SSR → no call", () => {
  assert.equal(withBrowser({ pathname: "/", consent: "denied" }, () => track("cta_click", { location: "x" })).length, 0);
  assert.equal(withBrowser({ pathname: "/", consent: "" }, () => track("cta_click", { location: "x" })).length, 0);
  assert.equal(withBrowser({ pathname: "/seafarer" }, () => track("sign_up_start", { step: "agent" })).length, 0);
  assert.equal(withBrowser({ pathname: "/seafarer" }, () => track("sign_up", { method: "password" })).length, 0);
  assert.equal(withBrowser({ pathname: "/share/tok" }, () => track("cta_click", { location: "x" })).length, 0);
  assert.equal(withBrowser({ pathname: "/", gtag: false }, () => track("cta_click", { location: "x" })).length, 0);
  assert.equal(typeof window, "undefined");
  assert.doesNotThrow(() => track("cta_click", { location: "x" }), "server render is a silent no-op");
});

// =====================================================================================
// A8 / A9 — the seams are wired exactly once each (static pins)
// =====================================================================================
test("A9: PasswordAuthCore fires sign_up_start once per mount on the create form and sign_up only in the created branch", () => {
  const src = read("components", "SeamanPasswordAuth.tsx");
  assert.match(src, /import \{ track \} from "@\/lib\/analytics-events"/);
  assert.equal((src.match(/track\("sign_up_start", \{ step: "agent" \}\)/g) || []).length, 1);
  assert.match(src, /if \(side !== "agent" \|\| signUpStartSent\.current\) return;/);
  const createForm = src.slice(src.indexOf('data-testid="pw-create-form"') - 200, src.indexOf('data-testid="pw-create-form"'));
  assert.match(createForm, /onFocusCapture=\{markSignUpStart\}/);
  assert.match(createForm, /onInput=\{markSignUpStart\}/);
  const signinForm = src.slice(src.indexOf('data-testid="pw-signin-form"') - 200, src.indexOf('data-testid="pw-signin-form"'));
  assert.doesNotMatch(signinForm, /markSignUpStart/, "nothing on the sign-in tab");
  // sign_up: exactly once, inside the recoveryCodes (created) branch, before the sign-in leg.
  assert.equal((src.match(/track\("sign_up", \{ method: "password" \}\)/g) || []).length, 1);
  const created = src.indexOf("Array.isArray(data.recoveryCodes)) {");
  const signUp = src.indexOf('track("sign_up", { method: "password" })');
  const signInLeg = src.indexOf("await signInCredentials({ identifier: uname, password, side, adoptToken });", created);
  assert.ok(created > 0 && signUp > created && signUp < signInLeg, "sign_up sits in the created branch before signInCredentials");
  const bound = src.slice(src.indexOf("data.bound === true"), src.indexOf("needsBindConfirm === true"));
  assert.doesNotMatch(bound, /track\(/, "never in the side-bind branch");
  const codesLost = src.slice(src.indexOf('kind: "codesLost"') - 400, src.indexOf('kind: "codesLost"'));
  assert.doesNotMatch(codesLost, /track\(/, "never in the codes-lost path (no creation confirmed in that response)");
});

test("A9: BookClient fires book_submit exactly once, in the res.ok branch", () => {
  const src = read("app", "book", "BookClient.tsx");
  assert.equal((src.match(/track\("book_submit"\)/g) || []).length, 1);
  const ok = src.indexOf("if (res.ok) {");
  const call = src.indexOf('track("book_submit")');
  const next = src.indexOf("if (res.status === 409)");
  assert.ok(ok > 0 && call > ok && call < next);
});

test("A8: ONE TrackedLink component; used on /, /pricing, /contact; /verify portals hook RegistryPortalLink", () => {
  const tracked = read("components", "TrackedLink.tsx");
  assert.match(tracked, /^"use client";/);
  assert.match(tracked, /import Link from "next\/link"/);
  assert.equal((tracked.match(/track\("cta_click", \{ location, target \}\)/g) || []).length, 1);
  const components = fs.readdirSync(path.join(APP, "components")).filter((f) => /tracked|Tracked/.test(f));
  assert.deepEqual(components, ["TrackedLink.tsx"], "no parallel tracked-link component");

  const home = read("components", "HomeClient.tsx");
  assert.equal((home.match(/<TrackedLink/g) || []).length, 4, "four hero CTAs");
  assert.equal((home.match(/location="home_hero"/g) || []).length, 4);
  const pricing = read("app", "pricing", "page.tsx");
  assert.equal((pricing.match(/<TrackedLink/g) || []).length, 4);
  assert.ok(pricing.includes('href="/agent/settings/billing"'));
  const contact = read("app", "contact", "page.tsx");
  assert.equal((contact.match(/<TrackedLink/g) || []).length, 1);
  assert.match(contact, /cta="mailto"/);
  const verify = read("app", "verify", "page.tsx");
  assert.match(verify, /track\("cta_click", \{ location: "verify_portals", target: "portal-link" \}\)/);
  assert.equal((verify.match(/onClick=\{trackPortalClick\}/g) || []).length, 2, "both RegistryPortalLink sites");
  const portal = read("components", "RegistryPortalLink.tsx");
  assert.doesNotMatch(portal, /^"use client";/m, "RegistryPortalLink stays server-safe");
  assert.doesNotMatch(portal, /analytics-events/, "the primitive itself never tracks");
});
