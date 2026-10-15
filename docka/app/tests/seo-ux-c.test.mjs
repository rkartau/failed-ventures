// SEO implementation plan v3 — WP-C (components, client pages, samples, /overview hub,
// i18n) regression contract. Pins:
//   C1  consent bar: SSR-open via `initialOpen`, no autofocus, no JS padding measurement,
//       no ResizeObserver, aria-live, Accept + Reject both rendered; lib/consent.ts keeps
//       its cookie/event contract and gains the pure `isConsentChoice` guard; the root
//       layout stamps `consent-open` on <html> ONLY when analytics is on and no choice is
//       stored (S3); globals.css reserves the space.
//   C2  44px tap targets (nav, language switcher, VerifyBox tabs, sample banner, toggles).
//   C3  readable text is slate-500, not slate-400 (LastUpdated, GraphShell caption).
//   C4  /verify DOM order (H1 -> trust strip -> VerifyBox -> copy -> tables -> cards ->
//       links -> FAQ), WebPage node, derived portal links, >= 700 words, style-guide clean.
//   C5  /overview/agencies H1 + CTAs + LEVEL_META ladder + <img srcSet>; seafarers links.
//   C6  StatTiles SSR paints the target (no `0%`), IntersectionObserver start, scaleX bars.
//   C7  /overview hub >= 400 words + feature matrix + WebPage node + ONE breadcrumbList.
//   C8  sample pages: one H1 each, titles/descriptions/og:url; ReviewPanel titleAs.
//   C9  sampleThumbSrc() manifest + safety contract; every fixture has a < 25 KB thumb.
//   C10 home widget wrapper is lg:self-start.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-ux-c.test.mjs

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteHarness } from "./_route-harness.mjs";

// TSX transpile + next/link + next/navigation stubs, registered BEFORE the component
// imports below (same pattern as tests/home-dom.test.mjs).
register("./_tsx-hooks.mjs", import.meta.url);

const React = (await import("react")).default;
const { renderToString, renderToStaticMarkup } = await import("react-dom/server");
const consent = await import("@/lib/consent");
const { SITE_PAGES } = await import("@/lib/site-pages");
const { sampleThumbSrc } = await import("@/lib/sample-thumbs");
const { SAMPLE_THUMB_BASENAMES, SAMPLE_THUMB_EXT } = await import("@/lib/sample-thumbs-manifest");
const { DICT, LANGS, t } = await import("@/lib/i18n");
const { LEVEL_META } = await import("@/lib/verification-level");
const { AGENCY_TILES } = await import("@/components/overview/overviewData");
const { REGISTRY_PAGE_SLUGS } = await import("@/lib/registry/public-rows");
const { ConsentBanner } = await import("@/components/ConsentBanner");
const { StatTiles } = await import("@/components/overview/StatTiles");
const { default: OverviewChooser } = await import("@/app/overview/page");
const { default: VerifyIndexPage } = await import("@/app/verify/page");

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...segs) => fs.readFileSync(path.join(APP, ...segs), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const TYPOGRAPHIC = /[—–“”‘’]/;

/** Visible text of rendered HTML: JSON-LD scripts dropped, tags stripped, entities decoded. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const wordCount = (text) => text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
const uniqueWordCount = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter((w) => w.length > 1)
  ).size;

// =====================================================================================
// C1 — consent bar
// =====================================================================================
test("C1: lib/consent.ts keeps the cookie/event contract and exports isConsentChoice", () => {
  assert.equal(consent.CONSENT_COOKIE, "docka_consent");
  assert.equal(consent.CONSENT_CHANGE_EVENT, "docka-consent-change");
  assert.equal(consent.OPEN_CONSENT_EVENT, "docka-open-consent");
  assert.equal(consent.CONSENT_MAX_AGE, 15552000);
  assert.equal(typeof consent.readConsentCookie, "function");
  assert.equal(typeof consent.writeConsentCookie, "function");
  assert.equal(typeof consent.isTrackablePath, "function");
  // The pure guard.
  assert.equal(consent.isConsentChoice("granted"), true);
  assert.equal(consent.isConsentChoice("denied"), true);
  for (const v of [undefined, null, "", "yes", "GRANTED", "granted ", 0, true, {}, ["granted"]]) {
    assert.equal(consent.isConsentChoice(v), false, `isConsentChoice(${JSON.stringify(v)}) must be false`);
  }
  // AP1 exact-match allowlist. Since the GA4 plan (2026-09-07) it is DERIVED from the
  // public page catalogue (SITE_PAGES + /signup) instead of a hand-typed list, so every
  // indexable page fires a page_view — while every private / token surface stays out.
  // tests/ga4-consent.test.mjs pins the derivation and the private invariant in depth.
  for (const { path: p } of SITE_PAGES) assert.equal(consent.isTrackablePath(p), true, p);
  assert.equal(consent.isTrackablePath("/signup"), true);
  for (const p of ["/agent", "/agent/x", "/seafarer", "/share/abc", "/portal/abc", "/verify/123e4567-e89b-12d3-a456-426614174000", "/admin", "/admin/leads", "/directory", "/terms", "/api/x", "/o/tok", "/u/tok", "/signup/extra"]) {
    assert.equal(consent.isTrackablePath(p), false, p);
    assert.equal(consent.shouldRenderTag({ granted: true, pathname: p, gaId: "G-X" }), false, p);
  }
  for (const { path: p } of SITE_PAGES) assert.equal(consent.isPrivatePath(p), false, `${p} is public`);
  const src = read("lib", "consent.ts");
  assert.match(src, /\.\.\.SITE_PAGES\.map\(\(p\) => p\.path\)/, "allowlist derived from SITE_PAGES");
});

test("C1: ConsentBanner has no autofocus, no JS padding measurement, no ResizeObserver; window-level Escape; aria-live", () => {
  const src = read("components", "ConsentBanner.tsx");
  assert.doesNotMatch(src, /\.focus\(/, "no autofocus (focus steal)");
  assert.doesNotMatch(src, /autoFocus/, "no autoFocus attribute");
  assert.doesNotMatch(src, /paddingBottom/, "no JS-measured body padding");
  assert.doesNotMatch(src, /ResizeObserver/, "no ResizeObserver");
  assert.match(src, /initialOpen/, "accepts the initialOpen prop");
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /window\.addEventListener\("keydown"/, "Escape is a window-level keydown listener");
  assert.match(src, /classList\.toggle\("consent-open"|CONSENT_OPEN_CLASS = "consent-open"/, "toggles the <html> class");
  // The class is toggled ONLY through the shared transition (Accept/Reject/Escape/reopen).
  assert.equal((src.match(/setConsentOpenClass\(/g) || []).length, 2, "one helper definition + one call inside transition()");
});

test("C1: ConsentBanner SSRs open with initialOpen (both buttons, equal size) and renders nothing when closed", () => {
  const open = renderToString(React.createElement(ConsentBanner, { enabled: true, initialOpen: true }));
  assert.match(open, /role="dialog"/);
  assert.match(open, /aria-live="polite"/);
  assert.match(open, /id="docka-consent-body"/, "server-rendered body (curl grep target)");
  assert.ok(open.includes(t("en", "consent.accept")), "Accept rendered");
  assert.ok(open.includes(t("en", "consent.reject")), "Reject rendered");
  // Equal prominence: both buttons carry the same base class list (size/weight/min-height).
  const buttons = [...open.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(buttons.length, 2);
  for (const cls of buttons) {
    assert.match(cls, /min-h-\[44px\]/);
    assert.match(cls, /text-sm font-semibold/);
    assert.match(cls, /px-4/);
  }
  assert.doesNotMatch(open, /autofocus/i);
  const closed = renderToString(React.createElement(ConsentBanner, { enabled: true, initialOpen: false }));
  assert.equal(closed, "", "closed bar renders nothing");
  const disabled = renderToString(React.createElement(ConsentBanner, { enabled: false, initialOpen: true }));
  assert.equal(disabled, "", "disabled channel renders nothing even if asked to open");
});

test("C1/S3: root layout stamps consent-open on <html> only when analytics is on AND no choice is stored", () => {
  const src = read("app", "layout.tsx");
  assert.match(
    src,
    /const consentOpen = analyticsEnabled && !isConsentChoice\(cookies\(\)\.get\(CONSENT_COOKIE\)\?\.value\)/,
    "S3 expression"
  );
  assert.match(src, /<html lang=\{lang\} className=\{consentOpen \? "consent-open" : undefined\}>/);
  assert.match(src, /<ConsentBanner enabled initialOpen=\{consentOpen\} \/>/);

  // Runtime: the route harness's next/headers stub has NO cookies (first visit).
  const inert = new Proxy({}, { get: () => () => null });
  const { loadTs } = createRouteHarness({
    stubs: {
      "next/link": { default: () => null },
      "next/script": { default: () => null },
      "./globals.css": {},
      "@/components/Logo": inert,
      "@/components/ImpersonationBanner": inert,
      "@/components/ServiceWorkerRegister": inert,
      "@/components/LanguageProvider": inert,
      "@/components/SiteNav": inert,
      "@/components/Analytics": inert,
      "@/components/ConsentBanner": inert,
      "@/components/CookieSettingsLink": inert,
    },
  });
  const layout = loadTs(path.join(APP, "app", "layout.tsx"));
  const prevGa = process.env.GA_ID;
  const prevGtm = process.env.GTM_ID;
  try {
    process.env.GA_ID = "";
    process.env.GTM_ID = "";
    const off = layout.default({ children: null });
    assert.equal(off.type, "html");
    assert.equal(off.props.className, undefined, "analytics off -> no consent-open class");

    process.env.GA_ID = "G-TEST";
    process.env.GTM_ID = "";
    const on = layout.default({ children: null });
    assert.equal(on.props.className, "consent-open", "analytics on + no cookie -> consent-open");
  } finally {
    if (prevGa === undefined) delete process.env.GA_ID;
    else process.env.GA_ID = prevGa;
    if (prevGtm === undefined) delete process.env.GTM_ID;
    else process.env.GTM_ID = prevGtm;
  }
});

test("C1: the pure gating expression (analyticsEnabled && !isConsentChoice(cookie))", () => {
  const gate = (enabled, cookie) => enabled && !consent.isConsentChoice(cookie);
  assert.equal(gate(false, undefined), false);
  assert.equal(gate(true, undefined), true);
  assert.equal(gate(true, "granted"), false);
  assert.equal(gate(true, "denied"), false);
  assert.equal(gate(true, "garbage"), true, "an unknown cookie value counts as no choice");
});

test("C1: globals.css reserves the bar height under .consent-open (mobile + sm)", () => {
  const css = read("app", "globals.css");
  const rules = [...css.matchAll(/\.consent-open body\s*\{\s*padding-bottom:\s*(\d+)px;?\s*\}/g)].map((m) => Number(m[1]));
  assert.equal(rules.length, 2, "one mobile rule + one sm rule");
  const [mobile, desktop] = rules;
  // Tallest of the six languages at 390px: two stacked 44px buttons + 4px gap + 16px padding + 1px border = 109px.
  assert.ok(mobile >= 109 && mobile <= 130, `mobile reserve ${mobile}px must cover the 109px bar without a big gap`);
  // >= 640px: one row, the longest sentence wraps to <= 4 lines of 16.5px + 16px padding + border ~= 83px.
  assert.ok(desktop >= 83 && desktop <= 96, `desktop reserve ${desktop}px must cover the ~83px bar`);
  assert.match(css, /@media \(min-width: 640px\)\s*\{\s*\.consent-open body/);
});

// =====================================================================================
// C2 / C3 — tap targets + contrast
// =====================================================================================
test("C2: 44px tap targets on nav, language switcher, VerifyBox tabs, sample banner, reminder toggles", () => {
  const nav = read("components", "SiteNav.tsx");
  assert.match(nav, /min-h-\[44px\] min-w-\[44px\]/, "hamburger");
  assert.ok((nav.match(/inline-flex min-h-\[44px\] items-center/g) || []).length >= 2, "desktop + mobile links");
  // R10: no filled "Book" pill was added; NAV_LINKS intact.
  assert.match(nav, /\{ href: "\/book", key: "nav\.book" \},\r?\n\];/);
  assert.doesNotMatch(nav, /bg-brand-600/, "no filled Book pill (R10)");
  assert.match(read("components", "LanguageSwitcher.tsx"), /min-h-\[44px\] rounded-lg border/);
  const vb = read("components", "VerifyBox.tsx");
  const tab = vb.slice(vb.indexOf("const tabClass"), vb.indexOf("const tabClass") + 200);
  assert.match(tab, /min-h-\[44px\]/, "tabClass");
  assert.equal((read("components", "SampleBanner.tsx").match(/min-h-\[44px\]/g) || []).length, 2);
  const rt = read("components", "overview", "RemindersTimeline.tsx");
  assert.doesNotMatch(rt, /min-h-\[36px\]/);
  assert.equal((rt.match(/min-h-\[44px\]/g) || []).length, 2, "unit toggles + reminder chips");
});

test("C3: readable small text is slate-500, not slate-400", () => {
  assert.match(read("components", "LastUpdated.tsx"), /text-slate-500/);
  assert.doesNotMatch(read("components", "LastUpdated.tsx"), /text-slate-400/);
  assert.match(read("components", "overview", "GraphShell.tsx"), /italic text-slate-500/);
  assert.doesNotMatch(read("components", "overview", "GraphShell.tsx"), /text-slate-400/);
  assert.doesNotMatch(stripComments(read("app", "verify", "page.tsx")), /text-slate-400/);
});

// =====================================================================================
// C4 — /verify
// =====================================================================================
const verifySrc = read("app", "verify", "page.tsx");
const verifyHtml = renderToStaticMarkup(React.createElement(VerifyIndexPage));
const verifyText = visibleText(verifyHtml);

test("C4: /verify source — VerifyBox before the registry cards; WebPage node; derived links; no /security", () => {
  assert.ok(verifySrc.indexOf("<VerifyBox") < verifySrc.indexOf('data-testid="registry-connections"'));
  assert.match(verifySrc, /webPageJsonLd\(\{\s*path: "\/verify"/);
  assert.match(verifySrc, /REGISTRY_PUBLIC_ROWS/);
  assert.match(verifySrc, /RegistryPortalLink/);
  assert.match(verifySrc, /registryPagePath\(/);
  assert.match(verifySrc, /REGISTRY_PAGE_SLUGS/);
  assert.match(verifySrc, /vp\.connSummary/);
  assert.match(verifySrc, /autoCount:\s*AUTO_FLAG_STATE_COUNT/);
  assert.match(verifySrc, /PRESENCE_ONLY_COUNTRIES/);
  assert.doesNotMatch(verifySrc, /href="\/security"/, "S4: no /security link");
  assert.doesNotMatch(verifySrc, /marad\.gov\.ua|dms\.gov\.cy|ardda\.gov\.az/, "no hand-typed portal URL");
  assert.doesNotMatch(verifySrc, /href="https?:/, "no hand-typed outbound href (only RegistryPortalLink)");
  assert.doesNotMatch(verifySrc, /\.notes\b/, "never renders CountryEntry.notes");
  // Style guide on the hand-written prose: no em/en dashes, no curly quotes.
  assert.doesNotMatch(stripComments(verifySrc), TYPOGRAPHIC, "verify/page.tsx prose is style-guide clean");
});

test("C4: /verify renders in the planned DOM order", () => {
  const idx = (needle) => {
    const i = verifyHtml.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const order = [
    'data-testid="verify-page-title"',
    'data-testid="verify-trust-strip"',
    'data-testid="verify-page-box"',
    "What you get back",
    'data-testid="verify-dob-table"',
    'data-testid="verify-portal-table"',
    'data-testid="registry-connections"',
    'data-testid="verify-registry-pages"',
    'data-testid="verify-faq"',
  ].map(idx);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `order broken at step ${i}`);
  // Exactly one H1, and it is the new EN title.
  assert.equal((verifyHtml.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok(verifyHtml.includes(DICT["vp.title"].en));
  // Trust strip: 8 flag-state codes + the BG existence chip.
  const strip = verifyHtml.slice(verifyHtml.indexOf('data-testid="verify-trust-strip"'), verifyHtml.indexOf('data-testid="verify-box-title"'));
  assert.equal((strip.match(/bg-brand-100/g) || []).length, 8, "8 flag-state chips");
  assert.match(strip, />BG existence</);
  // Two JSON-LD blocks in the page (WebPage + FAQPage); the layout owns the BreadcrumbList.
  const blocks = [...verifyHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1].replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"))
  );
  assert.deepEqual(
    blocks.map((b) => b["@type"]).sort(),
    ["FAQPage", "WebPage"]
  );
  const wp = blocks.find((b) => b["@type"] === "WebPage");
  assert.ok(wp.breadcrumb["@id"].endsWith("/verify#breadcrumb"));
  const faq = blocks.find((b) => b["@type"] === "FAQPage");
  assert.equal(faq.mainEntity.length, (verifyHtml.match(/data-faq-q/g) || []).length, "visible FAQ == JSON-LD FAQ");
});

test("C4: /verify portal table + registry-page links are derived from the registry table", () => {
  // Every pinned portal link is rel=noopener noreferrer + target=_blank (RegistryPortalLink).
  const portal = verifyHtml.slice(verifyHtml.indexOf('data-testid="verify-portal-table"'), verifyHtml.indexOf('data-testid="verify-conn-title"'));
  const links = [...portal.matchAll(/<a href="(https?:\/\/[^"]+)"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/g)];
  assert.ok(links.length >= 9, `expected >= 9 portal links (8 auto + BG), got ${links.length}`);
  // Each per-country registry page is linked exactly by its slug.
  const pages = verifyHtml.slice(verifyHtml.indexOf('data-testid="verify-registry-pages"'), verifyHtml.indexOf('data-testid="verify-faq-title"'));
  for (const slug of Object.values(REGISTRY_PAGE_SLUGS)) {
    assert.ok(pages.includes(`href="/registries/${slug}"`), `link to /registries/${slug}`);
  }
  assert.ok(verifyHtml.includes('href="/registries"'));
  assert.ok(verifyHtml.includes('href="/overview/agencies"'));
  // The FAQ pricing answer is no longer the verbatim /pricing answer.
  assert.doesNotMatch(verifySrc, /300 EUR per month plus 2 EUR/);
});

test("C4: /verify body is >= 700 words (>= 350 unique)", () => {
  const words = wordCount(verifyText);
  const uniq = uniqueWordCount(verifyText);
  assert.ok(words >= 700, `expected >= 700 words on /verify, got ${words}`);
  assert.ok(uniq >= 350, `expected >= 350 unique words on /verify, got ${uniq}`);
});

test("C4: vp.title is the new H1 in all six languages", () => {
  assert.equal(LANGS.length, 6);
  const titles = LANGS.map(({ code }) => t(code, "vp.title"));
  assert.equal(t("en", "vp.title"), "Verify a seafarer certificate online against the official flag-state registry");
  for (const [i, title] of titles.entries()) {
    // zh is 18 CJK characters; every other language is a full sentence.
    assert.ok(typeof title === "string" && title.length >= 10, `vp.title.${LANGS[i].code} present`);
    assert.notEqual(title, "Verify a certificate", `vp.title.${LANGS[i].code} updated`);
    assert.notEqual(title, "vp.title", `vp.title.${LANGS[i].code} resolved`);
    assert.doesNotMatch(title, TYPOGRAPHIC);
  }
  assert.equal(new Set(titles).size, LANGS.length, "six distinct translations");
});

// =====================================================================================
// C5 — /overview/agencies + /overview/seafarers
// =====================================================================================
test("C5: agencies page — new H1, /book + /verify CTAs, LEVEL_META ladder, <img srcSet>", () => {
  const src = read("app", "overview", "agencies", "page.tsx");
  // Positioning batch 2026-09-07 (plan v4 §2c / E8). `\s+` covers both formattings: at the
  // page's JSX indentation the H1 fits on one line, but a formatter may wrap it.
  assert.match(src, /Crew compliance software built into the CRM your crewing\s+desk runs on\./);
  assert.match(src, /href="\/book"[\s\S]{0,600}Book a 20-min demo/);
  assert.match(src, /href="\/verify"[\s\S]{0,600}Try the live verifier/);
  assert.match(src, /href="\/agent"/, "tertiary /agent text link kept");
  assert.match(src, /LADDER_LEVELS\.map\(/);
  assert.match(src, /LEVEL_META\[level\]/);
  assert.doesNotMatch(stripComments(src), /Self-added/, "the wrong hand-typed L1 wording is gone (a comment may explain it)");
  assert.doesNotMatch(src, /from "next\/image"/);
  assert.match(src, /srcSet="\/screenshots\/docka-verify-certificate-tool-640\.webp 640w, \/screenshots\/docka-verify-certificate-tool\.webp 1200w"/);
  assert.match(src, /loading="lazy"/);
  assert.match(src, /width=\{1200\}\s+height=\{806\}/);
  // Ladder words come straight from LEVEL_META (plainPunct only normalises punctuation).
  for (const n of [0, 1, 2, 3]) assert.match(src, /plainPunct\(meta\.word\)/, `L${n} word from LEVEL_META`);
  assert.equal(LEVEL_META[1].short, "Staff-reviewed", "product truth for L1");
});

test("C5: seafarers page — <img srcSet> + derived links to the per-country registry pages", () => {
  const src = read("app", "overview", "seafarers", "page.tsx");
  assert.doesNotMatch(src, /from "next\/image"/);
  assert.match(src, /srcSet="\/screenshots\/docka-sample-seafarer-profile-640\.webp 640w, \/screenshots\/docka-sample-seafarer-profile\.webp 1200w"/);
  assert.match(src, /registryPagePath\(/);
  assert.match(src, /REGISTRY_PAGE_SLUGS/);
  assert.doesNotMatch(src, /href="\/registries\/[a-z-]+"/, "no hand-typed registry-page href");
  for (const f of ["docka-verify-certificate-tool-640.webp", "docka-sample-seafarer-profile-640.webp"]) {
    assert.ok(fs.existsSync(path.join(APP, "public", "screenshots", f)), `${f} exists (WP-A asset)`);
  }
});

// =====================================================================================
// C6 — counters / animations
// =====================================================================================
test("C6: StatTiles SSR paints the target value (55%), never 0%", () => {
  const html = renderToString(React.createElement(StatTiles));
  assert.ok(html.includes("55%"), "target painted server-side");
  assert.ok(!/>0%</.test(html), "no 0% placeholder");
  // Every tile paints its own target string verbatim (one tile's real target IS "0").
  for (const { target } of AGENCY_TILES) assert.ok(html.includes(`>${target}<`), `tile target ${target} painted`);
  const src = read("components", "overview", "StatTiles.tsx");
  assert.doesNotMatch(src, /useState\(0\)/);
  assert.doesNotMatch(src, /requestAnimationFrame/, "no count-up (R11: never 55 -> 0 -> 55)");
  assert.match(src, /tile-in/);
  assert.match(read("app", "globals.css"), /\.tile-in\s*\{\s*animation:/);
});

test("C6: graphs start on IntersectionObserver via a forwarded GraphShell ref; bars animate scaleX", () => {
  const hook = read("components", "overview", "useMountAnimation.ts");
  assert.match(hook, /IntersectionObserver/);
  assert.match(hook, /ref\?: RefObject<Element \| null>/);
  assert.match(hook, /setTimeout\(show, FALLBACK_DELAY_MS\)/, "timer fallback kept");
  assert.match(read("components", "overview", "GraphShell.tsx"), /forwardRef</);
  for (const f of ["StatTiles", "FunnelBars", "ComplianceDonut", "LevelDistribution", "RemindersTimeline"]) {
    const src = read("components", "overview", `${f}.tsx`);
    assert.match(src, /useMountAnimation\(ref\)/, `${f} passes the ref`);
    assert.match(src, /<GraphShell\s+ref=\{ref\}/, `${f} forwards the ref to GraphShell`);
  }
  for (const f of ["FunnelBars", "LevelDistribution"]) {
    const src = read("components", "overview", `${f}.tsx`);
    assert.match(src, /origin-left/, `${f} origin-left`);
    assert.match(src, /scale-x-100" : "scale-x-0"/, `${f} scaleX`);
    assert.doesNotMatch(src, /transition-\[width\]/, `${f} no width tween`);
    assert.doesNotMatch(src, /: "0%"/, `${f} width fixed at the final %`);
  }
  assert.match(read("components", "overview", "ComplianceDonut.tsx"), /stroke-dashoffset/);
});

// =====================================================================================
// C7 — /overview hub
// =====================================================================================
test("C7: /overview hub renders >= 400 words, a feature matrix, ONE breadcrumbList + a WebPage node", () => {
  const src = read("app", "overview", "page.tsx");
  assert.equal((src.match(/breadcrumbList\(/g) || []).length, 1);
  assert.match(src, /breadcrumbList\(\s*\[[\s\S]*?\],\s*"\/overview"\s*\)/, "self path gives the #breadcrumb @id");
  assert.match(src, /webPageJsonLd\(\{\s*path: "\/overview"/);
  const html = renderToStaticMarkup(React.createElement(OverviewChooser));
  const text = visibleText(html);
  const words = wordCount(text);
  assert.ok(words >= 400, `expected >= 400 words on /overview, got ${words}`);
  // The feature matrix is a real <table> inside the matrix section.
  const matrixStart = html.indexOf('data-testid="overview-feature-matrix"');
  assert.ok(matrixStart >= 0, "feature matrix section");
  assert.match(html.slice(matrixStart), /<table/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  // Matrix rows: every feature-group heading from both tours.
  for (const h of ["Trust & verification", "Pipeline & throughput", "Compliance & lifecycle", "External surfaces", "Get your documents in", "Your verified identity", "Sharing & control", "Never miss a renewal"]) {
    assert.ok(text.includes(h), `matrix row: ${h}`);
  }
  // ChooserCard: a <div>, with the heading and the CTA as links (never one big link).
  assert.doesNotMatch(src, /<Link\s+href=\{href\}\s+className="group flex h-full/, "card is not one big link");
  const cardLinks = [...html.matchAll(/href="\/overview\/(agencies|seafarers)"/g)].length;
  assert.ok(cardLinks >= 4, "2 cards x (heading link + CTA link) at least");
  // Anchor texts to the tours stay short and descriptive (<= 60 chars).
  for (const m of html.matchAll(/<a href="\/overview\/(?:agencies|seafarers)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const anchor = visibleText(m[1]);
    assert.ok(anchor.length > 0 && anchor.length <= 60, `anchor <= 60 chars: "${anchor}"`);
  }
  // Style guide on the rendered body (all hand-written): no em/en dashes, no curly quotes.
  assert.doesNotMatch(text, TYPOGRAPHIC);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(blocks.map((b) => b["@type"]).sort(), ["BreadcrumbList", "WebPage"]);
  assert.equal(blocks.find((b) => b["@type"] === "BreadcrumbList")["@id"], blocks.find((b) => b["@type"] === "WebPage").breadcrumb["@id"]);
});

// =====================================================================================
// C8 — sample pages
// =====================================================================================
test("C8: sample pages have exactly one <h1>, planned titles/descriptions, og:url, robots literal", () => {
  const agency = read("app", "sample", "agency", "page.tsx");
  const seafarer = read("app", "sample", "seafarer", "page.tsx");
  assert.equal((agency.match(/<h1[\s>]/g) || []).length, 1);
  assert.equal((seafarer.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(agency, /<h1 className="text-2xl font-bold text-slate-900">\s*Sample crewing agency board \(read-only demo\)/);
  assert.match(agency, /<h2 className="mt-3 text-lg font-bold text-slate-900">Fleet pipeline<\/h2>/);
  assert.match(agency, /titleAs="h2"/);
  assert.match(seafarer, /<h1 className="sr-only">Sample seafarer profile \(read-only demo\)<\/h1>/);
  for (const [src, title, url] of [
    [agency, "Sample Crewing Agency Board: Live Read-Only Demo", "/sample/agency"],
    [seafarer, "Sample Seafarer Profile: Live Read-Only Demo", "/sample/seafarer"],
  ]) {
    assert.match(src, new RegExp(`const TITLE = "${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.ok(title.length >= 30 && title.length <= 60, `title length ${title.length}`);
    const desc = /const DESCRIPTION =\s*"([^"]+)"/.exec(src)?.[1];
    assert.ok(desc && desc.length <= 160, `description <= 160 (${desc?.length})`);
    assert.doesNotMatch(desc, TYPOGRAPHIC);
    assert.match(src, new RegExp(`openGraph: \\{\\s*url: "${url}"`));
    assert.match(src, /alt: "Docka: live seafarer certificate verification against flag-state registries"/);
    assert.match(src, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/);
    assert.doesNotMatch(stripComments(src), /noindex/i);
  }
  // ReviewPanel: titleAs prop, default h1, h2 branch.
  const rp = read("components", "ReviewPanel.tsx");
  assert.match(rp, /titleAs = "h1",/);
  assert.match(rp, /titleAs\?: "h1" \| "h2";/);
  assert.match(rp, /titleAs === "h2" \? \(\s*<h2 className="text-2xl font-bold text-slate-900">\{seafarer\.name\}<\/h2>/);
  // The seafarer dashboard demotes its own H1 in sample mode.
  const sf = read("app", "seafarer", "page.tsx");
  assert.match(sf, /\{sample \? \(\s*<h2 className="text-2xl font-bold text-slate-900">\{seafarer\.name\}<\/h2>\s*\) : \(\s*<h1 className="text-2xl font-bold text-slate-900">\{seafarer\.name\}<\/h1>/);
});

// =====================================================================================
// C9 — thumbnails
// =====================================================================================
test("C9: sampleThumbSrc() returns a thumb path ONLY for manifest basenames that are safe", () => {
  assert.equal(sampleThumbSrc({ sample: true, fileName: "sample-flagship-coc.jpg" }), "/samples/thumbs/sample-flagship-coc.webp");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "sample-flagship-coc" }), "/samples/thumbs/sample-flagship-coc.webp", "extension optional");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "not-in-manifest.jpg" }), null, "unknown basename");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "../sample-flagship-coc.jpg" }), null, "path segment");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "sample-flagship-coc/../x.jpg" }), null, "slash");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "Sample-Flagship-COC.jpg" }), null, "uppercase is unsafe");
  assert.equal(sampleThumbSrc({ sample: true, fileName: "sample flagship coc.jpg" }), null, "space is unsafe");
  assert.equal(sampleThumbSrc({ sample: true, fileName: null }), null);
  assert.equal(sampleThumbSrc({ sample: true }), null);
  assert.equal(sampleThumbSrc({ fileName: "sample-flagship-coc.jpg" }), null, "real (non-sample) doc never gets a public thumb");
  assert.equal(sampleThumbSrc({ sample: false, fileName: "sample-flagship-coc.jpg" }), null);
  // Import-free except the manifest const.
  const src = read("lib", "sample-thumbs.ts");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/sample-thumbs-manifest"]);
});

test("C9: every sample fixture has a committed < 25 KB WebP thumb listed in the manifest", () => {
  const fixtures = fs.readdirSync(path.join(APP, "scripts", "sample-fixtures")).filter((f) => f.endsWith(".jpg"));
  assert.equal(fixtures.length, 12, "12 fixtures (plan R6)");
  for (const f of fixtures) {
    const base = f.replace(/\.jpg$/, "");
    assert.ok(SAMPLE_THUMB_BASENAMES.includes(base), `${base} in manifest`);
    const thumb = path.join(APP, "public", "samples", "thumbs", `${base}.${SAMPLE_THUMB_EXT}`);
    assert.ok(fs.existsSync(thumb), `${thumb} exists`);
    assert.ok(fs.statSync(thumb).size < 25 * 1024, `${base}.${SAMPLE_THUMB_EXT} < 25 KB`);
  }
  for (const base of SAMPLE_THUMB_BASENAMES) assert.match(base, /^[a-z0-9-]+$/);
});

test("C9: DocImage passes width/height/loading/decoding through; thumbnails use sampleThumbSrc, viewers keep fileUrl", () => {
  const di = read("components", "DocImage.tsx");
  for (const p of ["width={width}", "height={height}", "loading={loading}", "decoding={decoding}"]) assert.ok(di.includes(p), p);
  const rp = read("components", "ReviewPanel.tsx");
  assert.match(rp, /const thumbSrc = sampleThumbSrc\(doc\) \?\? fileUrl;/);
  assert.match(rp, /src=\{thumbSrc\}[\s\S]{0,200}width=\{400\}\s+height=\{181\}\s+loading="lazy"\s+decoding="async"/);
  assert.match(rp, /<DocViewer[\s\S]{0,400}fileToken=\{fileToken\}/, "viewer keeps the API path");
  const sf = read("app", "seafarer", "page.tsx");
  assert.match(sf, /sampleThumbSrc\(doc\) \?\?\s*`\/api\/files\/\$\{doc\.id\}/);
  assert.match(sf, /src=\{thumbUrl\}[\s\S]{0,200}width=\{400\}\s+height=\{181\}\s+loading="lazy"\s+decoding="async"/);
});

// =====================================================================================
// C10 — home widget wrapper
// =====================================================================================
test("C10: the home verify widget wrapper is lg:self-start (hero recomposition dropped, R10)", () => {
  const src = read("components", "HomeClient.tsx");
  assert.match(src, /<div id="verify" className="scroll-mt-24 lg:self-start">/);
  assert.doesNotMatch(src, /lg:self-center/);
});
