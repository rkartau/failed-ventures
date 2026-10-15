// SEO implementation plan — WP-E (new pages: six /registries/<slug> pages, the four
// /resources guides written by WP-E2, /what-is-primary-source-verification, /terms metadata)
// regression, dead-href and anti-fabrication contract, plus the single page registry
// (lib/site-pages.ts) that drives sitemap.xml and /llms.txt.
//
// Sections:
//   (1) SITE_PAGES registry: shape, resolution to route files, sitemap projection, inverse
//       test (every indexable app/**/page.tsx is registered, and vice versa; plan R6/S6).
//   (2) /llms.txt renders from SITE_PAGES and keeps the five pinned URLs.
//   (3) Per new route: metadata, canonical, JSON-LD (one BreadcrumbList with @id, one WebPage,
//       one FAQPage with visible/JSON parity), links, byline, portal link (plan WP-E tests).
//   (4) Title uniqueness across the 13 hand-listed pages + every SITE_PAGES page (plan R13).
//   (5) Dead-href test (plan R5/S7): literal hrefs, template literals, SITE_PAGES paths,
//       REGISTRY_PAGE_SLUGS, ARTICLES slugs all resolve to a route file.
//   (6) Notes-shingle test (plan R7b/S2): no 8-word shingle of any COUNTRIES[].notes (minus
//       shingles of the public fields) appears in any new page's rendered text.
//   (7) Style-guide scan (docs/WRITING-STYLE-GUIDE.md) over the rendered text.
//   (8) Fabrication scan (same regex as seo-tier1-articles.test.mjs) over lib/registry-pages.ts,
//       the shell, the six wrappers and the PSV page; ids allowlisted in
//       docs/seo-new-pages-claims-sources.md.
//   (9) /terms: noindex unless registered; metadata; breadcrumb + WebPage; body untouched.
//
// NOTE: the four WP-E2 guide routes are pre-registered in SITE_PAGES; until their page files
// land, the "SITE_PAGES paths resolve" and dead-href assertions report them (expected while
// WP-E and WP-E2 are in flight; the integration agent runs the full suite after both).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-new-pages-e.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { render, walk, collectLdJson, ofType, textOf, collectVisibleQuestions, collectHrefs, collectTestIds } from "./_render-text.mjs";
import { STYLE_HARD, STYLE_TOLERATED, scanStyle } from "./_style-gate.mjs";
import { SITE_URL, abs, plainPunct } from "@/lib/seo";
import { SITE_PAGES } from "@/lib/site-pages";
import { REGISTRY_PAGE_SLUGS, registryRow } from "@/lib/registry/public-rows";
import { REGISTRY_PAGES } from "@/lib/registry-pages";
import { COUNTRIES, countryEntry } from "@/lib/registry/countries";
import { pricingModel } from "@/components/billing-ui";

// ---- harness ----------------------------------------------------------------------
// Link renders as a real <a> (so anchor text and hrefs survive into the rendered tree);
// every other client-only edge is inert, mirroring the phase-2/tier-1 harness stubs.
const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR, APP } = createRouteHarness({
  stubs: {
    "@/components/billing-ui": { pricingModel },
    "@/lib/billing-store": { getBillingSettings: () => ({ defaults: {}, tosVersion: "test" }) },
    // `__esModule` so TypeScript's __importDefault does not wrap the stub a second time.
    "next/link": { __esModule: true, default: (props) => ({ type: "a", props }) },
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
    "@/components/ObfuscatedEmail": inert,
    "@/components/HomeClient": inert,
  },
});
process.env.GA_ID = "";
process.env.GTM_ID = "";

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const readFile = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");
const REPO_ROOT = path.resolve(APP, "..");
const CLAIMS_PATH = path.join(REPO_ROOT, "docs", "seo-new-pages-claims-sources.md");
const STYLE_GUIDE_PATH = path.join(REPO_ROOT, "docs", "WRITING-STYLE-GUIDE.md");

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// ---- route inventory --------------------------------------------------------------
// Recursively list every page.tsx and route.ts under app/, returning URL paths (route groups stripped).
function listRouteFiles(dir = APP_DIR, prefix = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const seg = /^\(.+\)$/.test(ent.name) ? "" : `/${ent.name}`;
      out.push(...listRouteFiles(full, prefix + seg));
    } else if (ent.name === "page.tsx" || ent.name === "route.ts") {
      out.push({ url: prefix || "/", file: full, kind: ent.name === "page.tsx" ? "page" : "route" });
    }
  }
  return out;
}
const ROUTES = listRouteFiles();
const PAGE_BY_URL = new Map(ROUTES.filter((r) => r.kind === "page").map((r) => [r.url, r.file]));
const ROUTE_URLS = new Set(ROUTES.map((r) => r.url));
// Non-page public URLs Next serves from app/ or public/.
const KNOWN_NON_PAGE_URLS = new Set(["/sitemap.xml", "/robots.txt", "/llms.txt", "/manifest.webmanifest", "/opengraph-image.jpg", "/twitter-image.jpg", "/icon.png", "/favicon.ico"]);

function routeExists(urlPath) {
  const clean = urlPath.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (ROUTE_URLS.has(clean) || KNOWN_NON_PAGE_URLS.has(clean)) return true;
  if (fs.existsSync(path.join(APP, "public", clean.replace(/^\//, "")))) return true;
  // A dynamic segment sibling (e.g. /verify/[uuid]) covers concrete children.
  const parent = clean.split("/").slice(0, -1).join("/") || "/";
  return ROUTES.some((r) => r.url.startsWith(parent + "/[") );
}

// Metadata for a URL: the page's own export, else the sibling layout's (verify, overview/*).
function metadataFor(urlPath) {
  const pageFile = PAGE_BY_URL.get(urlPath);
  if (!pageFile) return undefined;
  let meta;
  try {
    meta = loadTs(pageFile).metadata;
  } catch (e) {
    meta = undefined;
  }
  if (!meta) {
    const layout = path.join(path.dirname(pageFile), "layout.tsx");
    if (fs.existsSync(layout)) {
      try {
        meta = loadTs(layout).metadata;
      } catch {
        meta = undefined;
      }
    }
  }
  return meta;
}
/** robots.index === false, read from metadata when loadable, else from source. */
function isNoindex(urlPath) {
  const meta = metadataFor(urlPath);
  if (meta && meta.robots && typeof meta.robots === "object") return meta.robots.index === false;
  const pageFile = PAGE_BY_URL.get(urlPath);
  const src = fs.readFileSync(pageFile, "utf8");
  return /robots:\s*\{[^}]*index:\s*false/.test(src);
}

// ---- the routes this WP owns -------------------------------------------------------
const REGISTRY_SLUGS = ["estonia", "denmark", "cyprus", "united-kingdom", "norway", "france"];
const REGISTRY_ROUTES = REGISTRY_SLUGS.map((slug) => ({ route: `/registries/${slug}`, segs: ["registries", slug, "page.tsx"] }));
const PSV_ROUTE = "/what-is-primary-source-verification";
const PSV_SEGS = ["what-is-primary-source-verification", "page.tsx"];
const NEW_ROUTES = [...REGISTRY_ROUTES, { route: PSV_ROUTE, segs: PSV_SEGS }];
const GUIDE_ROUTES_E2 = [
  "/resources/stcw-certificate-types",
  "/resources/required-stcw-documents-by-rank",
  "/resources/port-state-control-crew-certificate-deficiencies",
  "/resources/stcw-revalidation-every-5-years",
];
const HOW_WORKS = "/resources/how-seafarer-certificate-verification-works";

// Explicit exclusion list for the inverse test (plan S6; NOT a regex). `/directory`: owner to
// decide whether public. `/signup`: auth page, never in the sitemap.
const EXCLUDED_PREFIXES = ["/admin", "/agent", "/seafarer", "/o", "/u", "/share", "/portal", "/api", "/signup", "/directory", "/verify/[uuid]"];
const isExcluded = (url) => EXCLUDED_PREFIXES.some((p) => url === p || url.startsWith(p + "/"));

// =====================================================================================
// (1) SITE_PAGES registry + sitemap projection
// =====================================================================================
test("site-pages: rows are well-formed, unique, date-only lastmod, and all six registry + PSV pages are registered", () => {
  const paths = SITE_PAGES.map((p) => p.path);
  assert.equal(new Set(paths).size, paths.length, "paths must be unique");
  for (const p of SITE_PAGES) {
    assert.match(p.path, /^\/[a-z0-9\-\/]*$/, `path ${p.path} must be a clean site-relative path`);
    assert.match(p.lastmod, /^\d{4}-\d{2}-\d{2}$/, `${p.path} lastmod must be YYYY-MM-DD`);
    assert.ok(["monthly", "yearly"].includes(p.changeFrequency));
    assert.ok(p.priority > 0 && p.priority <= 1);
    if (p.llms) assert.ok(["Key pages", "Guides", "Registries", "Legal"].includes(p.llms.section));
  }
  for (const { route } of NEW_ROUTES) assert.ok(paths.includes(route), `${route} must be in SITE_PAGES`);
  for (const g of GUIDE_ROUTES_E2) assert.ok(paths.includes(g), `${g} (WP-E2 guide) must be pre-registered`);
  assert.ok(paths.includes("/"), "home must be registered");
  assert.ok(!paths.includes("/terms"), "/terms stays out while noindex (owner has not signed off the ToS text)");
  assert.ok(!paths.includes("/security"), "/security is struck (plan S4)");
  // lastmod moves only when a page's OWN VISIBLE COPY changes (lib/site-pages.ts:7-16).
  // The CRM positioning batch (plan v4 §2c, 2026-09-07) gives /book and /contact the visible
  // <WhatDockaIs /> strip and /sample/seafarer a visible CRM body sentence, so those three
  // move to 2026-09-07. /sample/agency changes METADATA ONLY and keeps the date the previous
  // hand-written sitemap carried.
  const lm = Object.fromEntries(SITE_PAGES.map((p) => [p.path, p.lastmod]));
  assert.equal(lm["/sample/seafarer"], "2026-09-07");
  assert.equal(lm["/sample/agency"], "2026-08-18");
  assert.equal(lm["/verify"], "2026-09-07");
  assert.equal(lm["/"], "2026-09-07");
  assert.equal(lm["/book"], "2026-09-07");
  assert.equal(lm["/contact"], "2026-09-07");
  for (const { route } of NEW_ROUTES) assert.equal(lm[route], "2026-09-07", `${route} is dated the day it went live`);
});

test("site-pages: every SITE_PAGES path resolves to app/<path>/page.tsx (WP-E2 guides may be pending)", () => {
  const missing = SITE_PAGES.map((p) => p.path).filter((p) => !PAGE_BY_URL.has(p));
  assert.deepEqual(missing, [], `SITE_PAGES paths without a page.tsx: ${missing.join(", ")}`);
});

test("sitemap: a pure projection of SITE_PAGES, home url === SITE_URL (slash-less), each URL once", () => {
  const entries = loadRoute("sitemap.ts").default();
  assert.equal(entries.length, SITE_PAGES.length, "one sitemap entry per SITE_PAGES row");
  const urls = entries.map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicate sitemap URLs");
  const home = entries.find((e) => e.url === SITE_URL);
  assert.ok(home, "home url must be the slash-less SITE_URL");
  assert.ok(!urls.includes(abs("/")), "home must not also appear as abs('/')");
  for (const p of SITE_PAGES) {
    const expectUrl = p.path === "/" ? SITE_URL : abs(p.path);
    const row = entries.find((e) => e.url === expectUrl);
    assert.ok(row, `sitemap missing ${p.path}`);
    assert.equal(row.lastModified, p.lastmod);
    assert.match(row.lastModified, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.changeFrequency, p.changeFrequency);
    assert.equal(row.priority, p.priority);
  }
  for (const { route } of NEW_ROUTES) {
    assert.equal(urls.filter((u) => u === abs(route)).length, 1, `${route} exactly once in sitemap`);
  }
  // The hand-typed LASTMOD table is gone: no second source of dates.
  assert.doesNotMatch(readFile("sitemap.ts"), /const LASTMOD/, "sitemap.ts must not keep its own date table");
});

test("site-pages inverse: every indexable app/**/page.tsx outside the explicit exclusion list is registered, and every registered path is indexable", () => {
  const registered = new Set(SITE_PAGES.map((p) => p.path));
  const unregistered = [];
  for (const [url] of PAGE_BY_URL) {
    if (isExcluded(url)) continue;
    if (url.includes("[")) continue; // dynamic segments are never sitemap rows
    if (isNoindex(url)) {
      assert.ok(!registered.has(url), `${url} is noindex and must NOT be in SITE_PAGES`);
      continue;
    }
    if (!registered.has(url)) unregistered.push(url);
  }
  assert.deepEqual(unregistered, [], `indexable pages missing from SITE_PAGES: ${unregistered.join(", ")}`);
  for (const p of SITE_PAGES) {
    assert.ok(!isExcluded(p.path), `${p.path} is on the exclusion list and must not be registered`);
    if (PAGE_BY_URL.has(p.path)) assert.ok(!isNoindex(p.path), `${p.path} is registered but noindex`);
  }
});

// =====================================================================================
// (2) /llms.txt
// =====================================================================================
test("llms.txt: renders from SITE_PAGES, keeps the five pinned URLs, lists >= 10 site URLs, every URL is a registered page", async () => {
  const res = loadRoute("llms.txt", "route.ts").GET();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const text = await res.text();
  assert.match(text, /^# Docka\n/);
  for (const p of ["/verify", "/pricing", "/overview/agencies", "/overview/seafarers", "/contact"]) {
    assert.ok(text.includes(`${SITE_URL}${p}`), `llms.txt must link ${p}`);
  }
  const urls = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 10, `llms.txt must list >= 10 URLs (got ${urls.length})`);
  assert.equal(urls.filter((u) => u.startsWith(`${SITE_URL}/`) || u === SITE_URL).length, urls.length, "only docka.me URLs");
  const registered = new Set(SITE_PAGES.map((p) => (p.path === "/" ? SITE_URL : `${SITE_URL}${p.path}`)));
  for (const u of urls) assert.ok(registered.has(u), `llms.txt URL not in SITE_PAGES: ${u}`);
  for (const p of SITE_PAGES.filter((p) => p.llms)) {
    assert.ok(text.includes(`${SITE_URL}${p.path}`), `llms row missing ${p.path}`);
  }
  // Sections appear in the fixed order and each new registry page is under "Registries".
  const order = ["## Key pages", "## Guides", "## Registries", "## Legal"].map((h) => text.indexOf(h));
  assert.ok(order.every((i) => i >= 0), "all four sections present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections in fixed order");
  const registries = text.slice(text.indexOf("## Registries"), text.indexOf("## Legal"));
  for (const slug of REGISTRY_SLUGS) assert.ok(registries.includes(`/registries/${slug}`), `${slug} listed under Registries`);
  assert.ok(text.slice(text.indexOf("## Guides"), text.indexOf("## Registries")).includes(GUIDE_ROUTES_E2[0]), "E2 guides pre-listed under Guides");
});

// =====================================================================================
// (3) Per new route: metadata + JSON-LD + links
// =====================================================================================
for (const { route, segs } of NEW_ROUTES) {
  test(`${route}: page file, metadata (plain title <= 60, description <= 160, self-canonical, OG)`, () => {
    assert.ok(fs.existsSync(routeFile(...segs)), `${route} page file must exist`);
    const meta = loadRoute(...segs).metadata;
    assert.equal(typeof meta.title, "string", "title must be a plain string");
    assert.ok(meta.title.length <= 60, `title too long (${meta.title.length}): ${meta.title}`);
    assert.equal(typeof meta.description, "string");
    assert.ok(meta.description.length <= 160, `description too long (${meta.description.length})`);
    assert.equal(meta.alternates.canonical, route);
    assert.equal(meta.openGraph.url, route);
    assert.equal(meta.openGraph.type, "article");
    assert.equal(meta.openGraph.images[0].url, "/opengraph-image.jpg");
    assert.ok(meta.openGraph.images[0].alt.length > 20, "OG image alt must be descriptive");
    assert.doesNotMatch(meta.title, /[\u2014\u2013\u201C\u201D\u2018\u2019]/);
    assert.doesNotMatch(meta.description, /[\u2014\u2013\u201C\u201D\u2018\u2019]/);
  });

  test(`${route}: JSON-LD (one BreadcrumbList with @id, one WebPage referencing it, one FAQPage in parity with the visible <dl>)`, () => {
    const tree = render(loadRoute(...segs));
    const objs = collectLdJson(tree);
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, "exactly one BreadcrumbList");
    assert.equal(crumbs[0]["@id"], `${abs(route)}#breadcrumb`);
    assert.equal(crumbs[0].itemListElement[0].item, SITE_URL, "crumb 1 is the slash-less home");
    assert.equal(crumbs[0].itemListElement.at(-1).item, abs(route), "last crumb is self");
    const pages = ofType(objs, "WebPage");
    assert.equal(pages.length, 1, "exactly one WebPage");
    assert.equal(pages[0]["@id"], `${abs(route)}#webpage`);
    assert.equal(pages[0].url, abs(route));
    assert.equal(pages[0].breadcrumb["@id"], crumbs[0]["@id"], "WebPage.breadcrumb must reference the emitted BreadcrumbList");
    assert.equal(pages[0].isPartOf["@id"], abs("/#website"));
    assert.match(pages[0].dateModified, /^\d{4}-\d{2}-\d{2}$/);
    const faqs = ofType(objs, "FAQPage");
    assert.equal(faqs.length, 1, "exactly one FAQPage");
    assert.ok(faqs[0].mainEntity.length >= 4, "FAQ must have >= 4 entries");
    const jsonQs = faqs[0].mainEntity.map((q) => norm(q.name));
    const visibleQs = collectVisibleQuestions(tree).map(norm);
    assert.deepEqual(new Set(visibleQs), new Set(jsonQs), "visible FAQ questions must equal the FAQPage questions");
    assert.equal(visibleQs.length, jsonQs.length);
    // Answers: the JSON text must appear verbatim in the visible text (same array, no drift).
    const text = textOf(tree);
    for (const q of faqs[0].mainEntity) {
      assert.ok(text.includes(q.acceptedAnswer.text), `FAQ answer must be rendered visibly: ${q.name}`);
    }
    // Every breadcrumb @id referenced by a WebPage node exists in the same page's JSON-LD set (R12).
    const ids = new Set(objs.map((o) => o["@id"]).filter(Boolean));
    for (const p of pages) assert.ok(ids.has(p.breadcrumb["@id"]), "no dangling breadcrumb @id");
  });

  test(`${route}: links /verify + /registries, renders <LastUpdated /> + byline, no dead internal hrefs`, () => {
    const tree = render(loadRoute(...segs));
    const hrefs = collectHrefs(tree).map((h) => h.href);
    assert.ok(hrefs.includes("/verify"), "must link /verify");
    assert.ok(hrefs.includes("/registries"), "must link /registries");
    const ids = collectTestIds(tree);
    assert.ok(ids.has("last-updated"), "must render <LastUpdated />");
    const byline = textOf(ids.get("byline"));
    assert.match(byline, /^By the Docka team · Reviewed \d{1,2} [A-Z][a-z]+ \d{4}$/);
    for (const h of hrefs.filter((h) => h.startsWith("/"))) {
      assert.ok(routeExists(h), `${route} links a dead internal href: ${h}`);
    }
  });
}

// Registry-page specifics.
for (const { route, segs } of REGISTRY_ROUTES) {
  const slug = segs[1];
  test(`${route}: renders its countryEntry portalUrl as the authority link; WebPage.about is the GovernmentOrganization; inputs + H1 + siblings`, () => {
    const page = REGISTRY_PAGES.find((p) => p.slug === slug);
    assert.ok(page, `REGISTRY_PAGES must contain ${slug}`);
    const entry = countryEntry(page.code);
    const row = registryRow(page.code);
    assert.equal(REGISTRY_PAGE_SLUGS[page.code], slug, "slug comes from the shared map");
    const tree = render(loadRoute(...segs));
    const portal = collectHrefs(tree).find((h) => h.href === entry.portalUrl);
    assert.ok(portal, `must link the official portal ${entry.portalUrl}`);
    assert.equal(portal.rel, "noopener noreferrer");
    assert.equal(portal.target, "_blank");
    const text = textOf(tree);
    assert.ok(text.includes(row.authority), "authority line must render the public row's authority");
    for (const label of row.inputs) assert.ok(text.includes(label), `input label "${label}" must be rendered`);
    if (row.userNotes) assert.ok(text.includes(row.userNotes), "userNotes must be rendered");
    const web = ofType(collectLdJson(tree), "WebPage")[0];
    assert.equal(web.about["@type"], "GovernmentOrganization");
    assert.equal(web.about.name, row.authority);
    assert.equal(web.about.url, entry.portalUrl);
    // H1 shape and title shape.
    let h1;
    walk(tree, (n) => {
      if (n.type === "h1") h1 = textOf(n.props.children);
    });
    assert.match(h1, /^Verify an? [A-Z][A-Za-z ]+ seafarer certificate$/);
    assert.match(loadRoute(...segs).metadata.title, /^Verify an? .* Seafarer Certificate/);
    // Hub-and-spoke links.
    const hrefs = collectHrefs(tree).map((h) => h.href);
    for (const target of [HOW_WORKS, "/overview/agencies", "/pricing", "/registries/ukraine", "/registries/azerbaijan"]) {
      assert.ok(hrefs.includes(target), `${route} must link ${target}`);
    }
    for (const other of REGISTRY_SLUGS.filter((s) => s !== slug)) {
      assert.ok(hrefs.includes(`/registries/${other}`), `${route} must link sibling /registries/${other}`);
    }
    // Content volume: >= 600 words of page-specific prose from the data object.
    const prose = [...page.intro, ...page.whatDockaConfirms, ...page.diySteps, ...page.caveats, ...page.sections.flatMap((s) => [s.h2, ...s.paras]), ...page.faq.flatMap((f) => [f.q, f.a])].join(" ");
    const words = prose.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 600, `${route} must carry >= 600 words of country-specific prose (got ${words})`);
    assert.equal(page.diySteps.length, 3, "three DIY steps");
    assert.ok(page.faq.length >= 4);
    // The wrapper is thin: prose lives in the data file.
    assert.ok(readFile(...segs).split("\n").length <= 20, "page file is a thin wrapper");
  });
}

test("registry-pages data: six pages, every code public, no `notes` key anywhere, punctuation normalised", () => {
  assert.deepEqual(REGISTRY_PAGES.map((p) => p.slug).sort(), [...REGISTRY_SLUGS].sort());
  const json = JSON.stringify(REGISTRY_PAGES);
  assert.doesNotMatch(json, /"notes"/, "REGISTRY_PAGES must never carry a notes key");
  assert.doesNotMatch(json, /[\u2014\u2013\u201C\u201D\u2018\u2019]/, "data must be plainPunct-clean");
  for (const p of REGISTRY_PAGES) {
    assert.ok(registryRow(p.code), `${p.code} must be a public registry row`);
    assert.equal(p.slug, REGISTRY_PAGE_SLUGS[p.code]);
  }
});

// PSV definition page specifics.
test(`${PSV_ROUTE}: DefinedTerm (description === plainPunct(HOME_FAQ[0].a)), disambiguation, links home/verify/guide`, () => {
  const mod = loadRoute(...PSV_SEGS);
  assert.equal(mod.metadata.title, "What Is Primary Source Verification (PSV)?");
  const tree = render(mod);
  const objs = collectLdJson(tree);
  const terms = ofType(objs, "DefinedTerm");
  assert.equal(terms.length, 1, "exactly one DefinedTerm");
  assert.equal(terms[0].name, "Primary source verification (PSV)");
  assert.equal(terms[0].inDefinedTermSet, abs(PSV_ROUTE));
  // The definition is HOME_FAQ[0].a from app/page.tsx (not exported: read from source), verbatim
  // modulo the shared plainPunct() normalisation at the data layer (plan R8).
  const homeSrc = readFile("page.tsx");
  const m = homeSrc.match(/q:\s*"What is primary source verification \(PSV\)\?",\s*a:\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(m, "HOME_FAQ[0] must be findable in app/page.tsx");
  const homeAnswer = JSON.parse(`"${m[1]}"`);
  assert.equal(terms[0].description, plainPunct(homeAnswer));
  const ids = collectTestIds(tree);
  assert.equal(textOf(ids.get("psv-definition")), plainPunct(homeAnswer), "the visible definition is the same sentence");
  assert.equal(JSON.stringify(objs).split("DefinedTerm").length - 1, 2, "the string DefinedTerm appears in @type and inDefinedTermSet only (grep -c on one line -> 1)");
  const text = textOf(tree).toLowerCase();
  assert.ok(text.includes("platform supply vessel"), "must disambiguate the vessel meaning");
  const hrefs = collectHrefs(tree).map((h) => h.href);
  for (const t of ["/", "/verify", HOW_WORKS, "/registries"]) assert.ok(hrefs.includes(t), `PSV page must link ${t}`);
  assert.match(readFile(...PSV_SEGS), /<LastUpdated\s*\/>/);
});

// =====================================================================================
// (4) Title uniqueness (plan R13): the 13 hand-listed pages + every SITE_PAGES page
// =====================================================================================
test("uniqueness: titles are unique across the 13 hand-listed pages and every SITE_PAGES page", () => {
  const hand = [
    ["resources", "spot-forged-recycled-seafarer-certificate", "page.tsx"],
    ["resources", "check-stcw-certificate-valid", "page.tsx"],
    ["resources", "how-seafarer-certificate-verification-works", "page.tsx"],
    ["resources", "page.tsx"],
    ["registries", "page.tsx"],
    ["registries", "azerbaijan", "page.tsx"],
    ["registries", "ukraine", "page.tsx"],
    ["about", "page.tsx"],
    ["pricing", "page.tsx"],
    ["verify", "layout.tsx"],
    ["overview", "page.tsx"],
    ["overview", "seafarers", "layout.tsx"],
    ["overview", "agencies", "layout.tsx"],
  ];
  const titles = new Map();
  const add = (label, t) => {
    if (typeof t !== "string") return; // home uses the root template default
    assert.ok(!titles.has(t), `duplicate title "${t}" on ${label} and ${titles.get(t)}`);
    titles.set(t, label);
  };
  for (const segs of hand) add(segs.join("/"), loadRoute(...segs).metadata.title);
  for (const p of SITE_PAGES) {
    if (!PAGE_BY_URL.has(p.path)) continue; // WP-E2 guide not landed yet
    const meta = metadataFor(p.path);
    if (meta && !hand.some((h) => "/" + h.slice(0, -1).join("/") === p.path)) add(p.path, meta.title);
  }
  assert.ok(titles.size >= 13 + NEW_ROUTES.length, `expected >= ${13 + NEW_ROUTES.length} distinct titles, got ${titles.size}`);
  for (const { route } of NEW_ROUTES) {
    const t = loadRoute(...PAGE_BY_URL.get(route).replace(APP_DIR + path.sep, "").split(path.sep)).metadata.title;
    assert.ok(titles.has(t), `${route} title counted`);
  }
});

// =====================================================================================
// (5) Dead-href test (plan R5/S7)
// =====================================================================================
function listTsx(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsx(full));
    else if (/\.tsx$/.test(ent.name)) out.push(full);
  }
  return out;
}
const HREF_SKIP = /^\/(api|share|o|u|portal)(\/|$)/;
test("dead-href: every literal/template href, SITE_PAGES path, REGISTRY_PAGE_SLUGS value and ARTICLES slug resolves to a route file", () => {
  const files = [
    ...listTsx(APP_DIR).filter((f) => /[\\/](page|layout)\.tsx$/.test(f)),
    ...listTsx(path.join(APP, "components")),
  ];
  const candidates = new Map(); // href -> where
  const addHref = (h, where) => {
    if (!h.startsWith("/") || h.startsWith("//")) return;
    if (HREF_SKIP.test(h) || h.includes("${") || h.includes("[")) return;
    if (!candidates.has(h)) candidates.set(h, where);
  };
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(APP, f);
    for (const m of src.matchAll(/href=\{?"(\/[^"]*)"/g)) addHref(m[1], rel);
    for (const m of src.matchAll(/href=\{`(\/[^`]*)`\}/g)) addHref(m[1], rel);
    for (const m of src.matchAll(/href:\s*"(\/[^"]*)"/g)) addHref(m[1], rel);
  }
  for (const p of SITE_PAGES) addHref(p.path, "lib/site-pages.ts");
  for (const [code, slug] of Object.entries(REGISTRY_PAGE_SLUGS)) addHref(`/registries/${slug}`, `REGISTRY_PAGE_SLUGS[${code}]`);
  const resourcesSrc = readFile("resources", "page.tsx");
  const articleSlugs = [...resourcesSrc.matchAll(/slug:\s*"(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(articleSlugs.length >= 3, "ARTICLES slugs must be readable from resources/page.tsx");
  for (const s of articleSlugs) addHref(s, "resources/page.tsx ARTICLES");
  assert.ok(candidates.size >= 30, `expected a healthy number of hrefs to check (got ${candidates.size})`);
  const dead = [...candidates].filter(([h]) => !routeExists(h)).map(([h, where]) => `${h} (${where})`);
  assert.deepEqual(dead, [], `dead internal hrefs: ${dead.join("; ")}`);
});

// =====================================================================================
// (6) Notes-shingle test (plan R7b / S2)
// =====================================================================================
const normWords = (s) => (s || "").toLowerCase().replace(/[^a-z0-9à-ÿ]+/gi, " ").trim().split(/\s+/).filter(Boolean);
function shingles(s, n = 8) {
  const w = normWords(s);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}
/** Per entry: shingles(notes) MINUS shingles of the public fields (userNotes, authority, authorityShort, inputs[].label). */
function forbiddenShinglesFor(entry) {
  const forbidden = shingles(entry.notes);
  const allowedText = [entry.userNotes, entry.authority, entry.authorityShort, ...entry.inputs.map((i) => i.label)];
  for (const t of allowedText) for (const sh of shingles(t)) forbidden.delete(sh);
  return forbidden;
}
function shingleHits(text, forbidden) {
  const have = shingles(text);
  return [...forbidden].filter((sh) => have.has(sh));
}
const ALL_FORBIDDEN = COUNTRIES.filter((c) => c.notes).map((c) => ({ code: c.country, forbidden: forbiddenShinglesFor(c) }));

test("notes-shingle: detector fixtures (GR public-field overlap passes; a verbatim notes shingle is caught)", () => {
  const gr = COUNTRIES.find((c) => c.country === "GR");
  assert.ok(gr && gr.notes && gr.userNotes, "GR fixture must have notes + userNotes");
  // A page that renders GR's own userNotes verbatim must NOT be flagged (shared shingle removed).
  assert.deepEqual(shingleHits(gr.userNotes, forbiddenShinglesFor(gr)), []);
  // Negative fixture, built at runtime so the test file never reproduces `notes` text: the
  // first surviving 8-word shingle of some entry, embedded in otherwise innocent prose, MUST hit.
  const withShingle = ALL_FORBIDDEN.find((e) => e.forbidden.size > 0);
  assert.ok(withShingle, "at least one entry has a notes shingle to test with");
  const sample = [...withShingle.forbidden][0];
  assert.equal(shingleHits(`Innocent text before. ${sample} Innocent text after.`, withShingle.forbidden).length, 1);
});

test("notes-shingle: no COUNTRIES[].notes 8-word shingle appears in any new page's rendered text or in lib/registry-pages.ts", () => {
  const texts = NEW_ROUTES.map(({ route, segs }) => [route, textOf(render(loadRoute(...segs)))]);
  texts.push(["lib/registry-pages.ts", JSON.stringify(REGISTRY_PAGES)]);
  const violations = [];
  for (const [label, text] of texts) {
    for (const { code, forbidden } of ALL_FORBIDDEN) {
      for (const hit of shingleHits(text, forbidden)) violations.push(`${label} <- ${code}: "${hit}"`);
    }
  }
  assert.deepEqual(violations, [], `notes text leaked into rendered pages:\n${violations.join("\n")}`);
});

// =====================================================================================
// (7) Style-guide scan (docs/WRITING-STYLE-GUIDE.md §4 mechanical scan)
// =====================================================================================

test("style-guide: rendered text of every new page (and its metadata) is free of banned punctuation and vocabulary", () => {
  const failures = [];
  for (const { route, segs } of NEW_ROUTES) {
    const mod = loadRoute(...segs);
    const text = `${mod.metadata.title} ${mod.metadata.description} ${textOf(render(mod))}`;
    for (const [re, label] of STYLE_HARD) {
      const hits = text.match(re);
      if (hits) failures.push(`${route}: ${label}: ${[...new Set(hits)].join(", ")}`);
    }
    for (const re of STYLE_TOLERATED) {
      const hits = text.match(re) || [];
      if (hits.length > 1) failures.push(`${route}: tolerated phrase used more than once: ${hits[0]}`);
    }
    // No emoji, no horizontal rules.
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) failures.push(`${route}: emoji`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("style-guide: the regex list in this test matches the guide's mechanical scan (guide file present, dash rule quoted)", () => {
  const guide = fs.readFileSync(STYLE_GUIDE_PATH, "utf8");
  assert.match(guide, /\\x\{2014\}\\x\{2013\}/, "guide still carries the dash/quote scan line");
  for (const word of ["delve", "crucial", "seamless", "leverag", "streamlin", "holistic", "revolutioni"]) {
    assert.ok(guide.includes(word), `guide banned-word list still contains ${word}`);
    assert.ok(STYLE_HARD[1][0].source.includes(word), `test banned-word regex still contains ${word}`);
  }
});

test("style-guide: the shared _style-gate.mjs sets are complete and scanStyle keeps their semantics", () => {
  // Both groups are counted so neither can be quietly dropped from the shared module.
  assert.equal(STYLE_HARD.length, 12);
  assert.equal(STYLE_TOLERATED.length, 4);
  // scanStyle mirrors the loops above: any hard hit fails; a tolerated phrase fails only
  // above the allowance (1 per page by default, 0 when the input is a single string).
  assert.deepEqual(scanStyle("x", "a plain sentence about certificates and ports."), []);
  assert.equal(scanStyle("x", "we must delve into it").length, 1);
  assert.deepEqual(scanStyle("x", "this rather than that"), []);
  assert.equal(scanStyle("x", "this rather than that, rather than the other").length, 1);
  assert.equal(scanStyle("x", "this rather than that", { tolerated: 0 }).length, 1);
});

// =====================================================================================
// (8) Fabrication scan (same shape as seo-tier1-articles.test.mjs:101-152)
// =====================================================================================
const SPELLED = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|third|half|majority|most|nearly all)";
const HOTWORDS = "(?:forged|fraud|fake|penalty|fine|detention)";
const TRIGGER = new RegExp(`\\d|%|€|\\b${SPELLED}\\b|\\b${HOTWORDS}\\b`, "i");
const WINDOW = 5;
const SCANNED_FILES = [
  ["lib/registry-pages.ts", path.join(APP, "lib", "registry-pages.ts")],
  ["components/RegistryCountryPage.tsx", path.join(APP, "components", "RegistryCountryPage.tsx")],
  // The shared positioning strip renders on 21 URLs, so its prose is scanned like any other
  // shared surface (plan v4 §3e). It is digit-free and number-word-free by design.
  ["components/WhatDockaIs.tsx", path.join(APP, "components", "WhatDockaIs.tsx")],
  ...REGISTRY_ROUTES.map(({ route, segs }) => [route, routeFile(...segs)]),
  [PSV_ROUTE, routeFile(...PSV_SEGS)],
];
function allowedSrcIds() {
  // The doc has one allowlist per owning section ("## Guides" = WP-E2, "## Registry pages" =
  // WP-E1); every "- `id`" bullet anywhere in the file is an allowlisted id.
  const claims = fs.readFileSync(CLAIMS_PATH, "utf8");
  const ids = [...claims.matchAll(/^- `([A-Za-z0-9\-]+)`/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 8, "claims file must enumerate the allowlist");
  return new Set(ids);
}

for (const [label, file] of SCANNED_FILES) {
  test(`fabrication: every quantitative/hotword line in ${label} has an adjacent [src:] comment`, () => {
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!/26 registries/.test(raw));
    assert.ok(!/\d+%[^.]*(forged|fraud|fake)/i.test(raw), "must not assert a fraud/forgery percentage");
    const scan = raw
      .replace(/className="[^"]*"/g, "")
      .replace(/className=\{[^}]*\}/g, "")
      .replace(/href="[^"]*"/g, "")
      .replace(/data-testid="[^"]*"/g, "");
    // Split on CRLF as well as LF (mirror seo-tier1-articles.test.mjs): a bare "\n" split
    // leaves "\r" on every line of a CRLF checkout, and //.*$ in codeOnly() then cannot
    // reach $, so pure // comments are mis-read as rendered claims.
    const lines = scan.split(/\r?\n/);
    const codeOnly = (l) =>
      l
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*.*?\*\//g, "")
        .replace(/\/\/.*$/, "")
        .replace(/<[^>]*>/g, " ")
        // Heading tag names used as identifiers/fields (h1, h2) and Tailwind class digits
        // (text-brand-700) are code, not claims.
        .replace(/\bh[1-6]\b/g, " ")
        .replace(/\b[a-z]+(?:-[a-z]+)*-\d{1,3}\b/g, " ");
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i])) continue;
      if (!TRIGGER.test(codeOnly(lines[i]))) continue;
      const win = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
      assert.ok(/\[src:/.test(win), `${label}: claim line ${i + 1} ("${lines[i].trim().slice(0, 90)}") needs an adjacent [src:...] comment`);
    }
  });
}

test("fabrication: every [src:id] in the scanned files resolves to an allowlisted id in docs/seo-new-pages-claims-sources.md", () => {
  const allowed = allowedSrcIds();
  for (const [label, file] of SCANNED_FILES) {
    const raw = fs.readFileSync(file, "utf8");
    const ids = [...raw.matchAll(/\[src:([a-zA-Z0-9\-]+)(?::|\])/g)].map((m) => m[1]);
    // The six wrappers carry no prose (and so no claims); every prose-bearing file must cite.
    const isWrapper = /[\\/]registries[\\/][a-z-]+[\\/]page\.tsx$/.test(file);
    if (!isWrapper) assert.ok(ids.length > 0, `${label} must carry at least one [src:] token`);
    for (const id of ids) assert.ok(allowed.has(id), `${label}: unknown source id "${id}"`);
  }
  // The registry pages must be sourced from the portals and the public row only.
  const claims = fs.readFileSync(CLAIMS_PATH, "utf8");
  for (const code of ["EE", "DK", "CY", "UK", "NO", "FR"]) assert.ok(claims.includes(`portal-${code}`), `claims file documents portal-${code}`);
  assert.ok(claims.includes("## Registry pages"), "claims file has the Registry pages section");
});

// =====================================================================================
// (9) /terms: metadata + breadcrumb + WebPage, noindex unless registered, body untouched
// =====================================================================================
test("/terms: stays robots.index === false unless SITE_PAGES lists it; metadata, breadcrumb @id, WebPage, back-links, body untouched", () => {
  const mod = loadRoute("terms", "page.tsx");
  const meta = mod.metadata;
  const registered = SITE_PAGES.some((p) => p.path === "/terms");
  if (!registered) assert.equal(meta.robots.index, false, "/terms must remain noindex until registered in SITE_PAGES");
  else assert.notEqual(meta.robots?.index, false, "/terms is registered so it must be indexable");
  assert.equal(meta.title, "Terms of Service");
  assert.ok(meta.description.length <= 160);
  assert.equal(meta.alternates.canonical, "/terms");
  assert.equal(meta.openGraph.url, "/terms");
  const tree = render(mod);
  const objs = collectLdJson(tree);
  const crumbs = ofType(objs, "BreadcrumbList");
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0]["@id"], `${abs("/terms")}#breadcrumb`);
  const pages = ofType(objs, "WebPage");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].breadcrumb["@id"], crumbs[0]["@id"]);
  const hrefs = collectHrefs(tree).map((h) => h.href);
  assert.ok(hrefs.includes("/pricing"), "Back to pricing link");
  assert.ok(hrefs.includes("/agent/settings/billing"), "Back to billing link kept");
  const src = readFile("terms", "page.tsx");
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /getBillingSettings\(\)\.tosVersion/);
  assert.match(src, /const SECTIONS/);
  for (const heading of ["1. What docka provides", "2. Fees", "3. Billing cycle and payment", "4. Taxes", "5. Non-payment", "6. Data protection", "7. Changes and termination"]) {
    assert.ok(src.includes(heading), `SECTIONS heading kept: ${heading}`);
  }
  assert.ok(textOf(tree).includes("Version test"), "tosVersion still rendered");
});
