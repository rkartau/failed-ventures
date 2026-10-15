// SEO Phase 2c (seo/phase-2c) regression contract. Locks the code-level SEO wins this
// pass shipped:
//   - top-nav discoverability: NAV_LINKS gains /registries + /resources (i18n keys present),
//   - registry-count consistency: ONE derived constant (AUTO_FLAG_STATE_COUNT) drives the
//     "N flag states" wording, and /verify carries the honest "+ Bulgaria existence" line,
//   - freshness: a visible "Last updated" line on the six content pages + JSON-LD date
//     fields (Article datePublished/dateModified, AboutPage/CollectionPage dateModified),
//   - contact email server-rendered as a real mailto in the initial HTML,
//   - home canonical == sitemap home loc (byte-identical, trailing slash),
//   - IndexNow submission wiring (script + npm script + robots reference + key file).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-phase2c.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { abs, SITE_URL } from "@/lib/seo";
import { t, DICT } from "@/lib/i18n";
import {
  AUTO_FLAG_STATE_COUNT,
  PRESENCE_ONLY_COUNTRIES,
  HERO_AUTO_REGISTRY_COUNTRIES,
  countryDisplayName,
} from "@/lib/registry/display";

const { loadTs, APP_DIR, APP } = createRouteHarness({
  stubs: { "next/link": { default: () => null } },
});

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const compFile = (name) => path.join(APP, "components", name);

function collectLdJson(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectLdJson(n, out);
    return out;
  }
  const props = node.props || {};
  if (node.type === "script" && props.dangerouslySetInnerHTML && props.dangerouslySetInnerHTML.__html) {
    out.push(props.dangerouslySetInnerHTML.__html);
  }
  if (props.children) collectLdJson(props.children, out);
  return out;
}
const parsedBlocks = (htmls) => htmls.map((h) => JSON.parse(h));
const ofType = (objs, type) => objs.filter((o) => o && o["@type"] === type);

// =====================================================================================
// (1) Top-nav discoverability — NAV_LINKS gains /registries + /resources
// =====================================================================================
const siteNavSrc = fs.readFileSync(compFile("SiteNav.tsx"), "utf-8");
const navBlock = siteNavSrc.slice(
  siteNavSrc.indexOf("const NAV_LINKS"),
  siteNavSrc.indexOf("];", siteNavSrc.indexOf("const NAV_LINKS")) + 2
);

test("nav: NAV_LINKS links /registries (nav.registries) and /resources (nav.resources)", () => {
  assert.ok(navBlock.length > 0, "NAV_LINKS block must be found");
  assert.match(navBlock, /href:\s*["']\/registries["'],\s*key:\s*["']nav\.registries["']/);
  assert.match(navBlock, /href:\s*["']\/resources["'],\s*key:\s*["']nav\.resources["']/);
});

test("nav: the two new nav i18n keys exist with an English string", () => {
  for (const key of ["nav.registries", "nav.resources"]) {
    assert.ok(DICT[key], `${key} must exist in DICT`);
    assert.equal(typeof DICT[key].en, "string");
    assert.ok(DICT[key].en.trim().length > 0);
  }
  assert.equal(t("en", "nav.registries"), "Registries");
  assert.equal(t("en", "nav.resources"), "Resources");
});

test("nav: the new nav targets are real, indexable, self-canonical routes", () => {
  for (const [route, segs] of [
    ["/registries", ["registries", "page.tsx"]],
    ["/resources", ["resources", "page.tsx"]],
  ]) {
    assert.ok(fs.existsSync(routeFile(...segs)), `${route} page file must exist`);
    const meta = loadRoute(...segs).metadata;
    assert.equal(meta.alternates.canonical, route, `${route} must self-canonicalise`);
    if (meta.robots) assert.notEqual(meta.robots.index, false, `${route} must not be noindex`);
  }
});

// =====================================================================================
// (2) Registry-count consistency — one derived constant, honest 8 + Bulgaria story
// =====================================================================================
test("count: AUTO_FLAG_STATE_COUNT is 8 and equals the home-hero flag-state list length", () => {
  assert.equal(AUTO_FLAG_STATE_COUNT, 8, "eight live-automatic flag states today");
  assert.equal(
    HERO_AUTO_REGISTRY_COUNTRIES.length,
    AUTO_FLAG_STATE_COUNT,
    "home hero list length must equal the shared flag-state count (no drift)"
  );
});

test("count: the presence-only tier is Bulgaria (existence check, not a flag state)", () => {
  const names = PRESENCE_ONLY_COUNTRIES.map((c) => countryDisplayName(c.country, "en", c.countryName));
  assert.deepEqual(names, ["Bulgaria"], "the sole presence-only registry is Bulgaria");
});

test("count: /verify renders the honest summary from the shared constants", () => {
  const src = fs.readFileSync(routeFile("verify", "page.tsx"), "utf-8");
  assert.match(src, /vp\.connSummary/, "/verify must render the connSummary key");
  assert.match(src, /autoCount:\s*AUTO_FLAG_STATE_COUNT/, "count must come from the shared constant");
  assert.match(src, /PRESENCE_ONLY_COUNTRIES/, "presence names must come from the shared constant");
  // The interpolated sentence reads honestly with the real values.
  const sentence = t("en", "vp.connSummary", { autoCount: AUTO_FLAG_STATE_COUNT, presence: "Bulgaria" });
  assert.match(sentence, /\b8\b/, "sentence must state the flag-state count");
  assert.match(sentence, /Bulgaria/, "sentence must name the existence-check registry");
  assert.doesNotMatch(sentence, /\{autoCount\}|\{presence\}/, "no unresolved placeholders");
});

test("count: the /registries hub still tells the same 8 + Bulgaria story", () => {
  const src = fs.readFileSync(routeFile("registries", "page.tsx"), "utf-8");
  assert.match(src, /eight flag states/i, "hub copy must say eight flag states");
  assert.match(src, /Bulgaria/, "hub must name Bulgaria in the presence tier");
});

// =====================================================================================
// (3) Home canonical == sitemap home loc (byte-identical, trailing slash)
// =====================================================================================
test("canonical: home canonical == sitemap home loc, byte-identical (slash-less, Next-normalised)", () => {
  // Next 14 (trailingSlash:false) strips the rendered root canonical's trailing slash, so
  // the aligned form is the bare origin. Both the canonical and the sitemap home loc are
  // pinned to SITE_URL so the RENDERED canonical matches the sitemap URL byte-for-byte.
  const canonical = loadRoute("page.tsx").metadata.alternates.canonical;
  assert.equal(canonical, SITE_URL);
  assert.ok(!canonical.endsWith("/"), "home canonical is the bare origin (no trailing slash)");
  const homeSitemap = loadRoute("sitemap.ts").default().find((e) => e.url === SITE_URL);
  assert.ok(homeSitemap, "sitemap must contain the home URL byte-identical to the canonical");
  assert.equal(homeSitemap.url, canonical);
  // Guard the drift the other way too: the home loc must NOT be the slash form.
  assert.ok(!loadRoute("sitemap.ts").default().some((e) => e.url === abs("/")),
    "sitemap home loc must be the slash-less SITE_URL, not abs('/')");
});

// =====================================================================================
// (4) Freshness — visible "Last updated" line on the six content pages
// =====================================================================================
const CONTENT_PAGES = [
  ["/about", ["about", "page.tsx"]],
  ["/registries", ["registries", "page.tsx"]],
  ["/registries/azerbaijan", ["registries", "azerbaijan", "page.tsx"]],
  ["/registries/ukraine", ["registries", "ukraine", "page.tsx"]],
  ["/resources", ["resources", "page.tsx"]],
  ["/resources/how-seafarer-certificate-verification-works", ["resources", "how-seafarer-certificate-verification-works", "page.tsx"]],
];

test("freshness: every content page renders the shared <LastUpdated /> line", () => {
  for (const [route, segs] of CONTENT_PAGES) {
    const src = fs.readFileSync(routeFile(...segs), "utf-8");
    assert.match(src, /<LastUpdated\s*\/>/, `${route} must render <LastUpdated />`);
    assert.match(src, /from "@\/components\/LastUpdated"/, `${route} must import LastUpdated`);
  }
});

test("freshness: LastUpdated uses a STATIC constant + a real <time datetime>, never new Date()", () => {
  const src = fs.readFileSync(compFile("LastUpdated.tsx"), "utf-8");
  assert.match(src, /CONTENT_LAST_UPDATED_ISO/);
  assert.match(src, /CONTENT_LAST_UPDATED_LABEL/);
  assert.match(src, /<time dateTime=/);
  assert.doesNotMatch(src, /new Date\(/, "must not use build-time new Date()");
  // The seo constants exist and are a plausible ISO date + human label.
  const seoSrc = fs.readFileSync(path.join(APP, "lib", "seo.ts"), "utf-8");
  assert.match(seoSrc, /CONTENT_LAST_UPDATED_ISO\s*=\s*"20\d\d-\d\d-\d\d"/);
  assert.match(seoSrc, /CONTENT_LAST_UPDATED_LABEL\s*=\s*"/);
});

// =====================================================================================
// (5) JSON-LD date fields — Article date*, AboutPage + CollectionPage dateModified
// =====================================================================================
test("schema: the Article carries datePublished + dateModified (ISO)", () => {
  const objs = parsedBlocks(
    collectLdJson(loadRoute("resources", "how-seafarer-certificate-verification-works", "page.tsx").default())
  );
  const art = ofType(objs, "Article")[0];
  assert.ok(art, "Article JSON-LD must be present");
  assert.match(art.datePublished, /^20\d\d-\d\d-\d\d$/, "Article.datePublished must be an ISO date");
  assert.match(art.dateModified, /^20\d\d-\d\d-\d\d$/, "Article.dateModified must be an ISO date");
});

test("schema: AboutPage + both CollectionPages carry dateModified", () => {
  const about = ofType(parsedBlocks(collectLdJson(loadRoute("about", "page.tsx").default())), "AboutPage")[0];
  assert.match(about.dateModified, /^20\d\d-\d\d-\d\d$/, "AboutPage.dateModified must be an ISO date");
  for (const segs of [["registries", "page.tsx"], ["resources", "page.tsx"]]) {
    const cp = ofType(parsedBlocks(collectLdJson(loadRoute(...segs).default())), "CollectionPage")[0];
    assert.match(cp.dateModified, /^20\d\d-\d\d-\d\d$/, `${segs[0]} CollectionPage.dateModified must be ISO`);
  }
});

// =====================================================================================
// (6) Contact email — a real server-rendered mailto in the initial HTML
// =====================================================================================
test("contact: the email is a real server-rendered mailto (not client-only obfuscation)", () => {
  const src = fs.readFileSync(routeFile("contact", "page.tsx"), "utf-8");
  assert.match(src, /mailto:\$\{COMPANY\.contactEmail\}|mailto:info@docka\.me/, "must render a mailto href");
  assert.match(src, /contactEmail:\s*"info@docka\.me"/, "must use the real, already-public address");
  assert.doesNotMatch(src, /ObfuscatedEmail/, "must no longer rely on the client-only ObfuscatedEmail");
  // The rendered server tree actually contains a mailto anchor in the initial HTML.
  // Since the GA4 funnel (2026-09-07) the anchor is the ONE TrackedLink (a next/link
  // wrapper that renders the same <a href="mailto:…"> and adds a PII-free cta_click),
  // so the walker accepts that element type beside a bare <a>.
  const { TrackedLink } = loadTs(path.join(APP, "components", "TrackedLink.tsx"));
  const tree = loadRoute("contact", "page.tsx").default();
  const anchors = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if ((n.type === "a" || n.type === TrackedLink) && n.props && typeof n.props.href === "string") anchors.push(n.props.href);
    if (n.props && n.props.children) walk(n.props.children);
  };
  walk(tree);
  assert.ok(anchors.some((h) => h === "mailto:info@docka.me"), "SSR tree must contain the mailto anchor");
});

// =====================================================================================
// (7) IndexNow — submission wiring is complete (script + npm script + robots + key file)
// =====================================================================================
test("indexnow: the submission script exists and references the key + endpoint + sitemap", () => {
  const scriptPath = path.join(APP, "scripts", "indexnow-submit.mjs");
  assert.ok(fs.existsSync(scriptPath), "indexnow-submit.mjs must exist");
  const src = fs.readFileSync(scriptPath, "utf-8");
  assert.match(src, /f845660bcf9e58c5b5f6284455f9ab50/, "script must carry the ownership key");
  assert.match(src, /api\.indexnow\.org\/indexnow/, "script must POST to the IndexNow endpoint");
  assert.match(src, /sitemap\.xml/, "script must read the sitemap for the URL list");
});

test("indexnow: package.json exposes the indexnow:submit script", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf-8"));
  assert.equal(pkg.scripts["indexnow:submit"], "node scripts/indexnow-submit.mjs");
});

test("indexnow: robots + key file are present and consistent", () => {
  const robotsSrc = fs.readFileSync(routeFile("robots.ts"), "utf-8");
  assert.match(robotsSrc, /f845660bcf9e58c5b5f6284455f9ab50/, "robots must reference the key file");
  assert.match(robotsSrc, /indexnow/i, "robots must reference IndexNow");
  const pub = path.join(APP, "public");
  const keyFiles = fs.readdirSync(pub).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.equal(keyFiles.length, 1, "exactly one IndexNow key file under public/");
  const key = keyFiles[0].replace(/\.txt$/, "");
  assert.equal(fs.readFileSync(path.join(pub, keyFiles[0]), "utf8").trim(), key, "file content == key");
});
