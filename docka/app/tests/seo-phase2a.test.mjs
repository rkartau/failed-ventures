// SEO Phase 2a (seo/phase-2a-quickwins) regression contract. Locks the low-risk
// technical/schema/on-page/AI-search quick-wins this pass shipped:
//   - the three SAFE security headers (and the CSP staying free of resource directives),
//   - exactly ONE BreadcrumbList per newly-covered marketing URL (no double-emit),
//   - the /pricing FAQPage + Offer priceValidUntil,
//   - the Organization.logo ImageObject, the home canonical trailing slash,
//   - the 404 title/noindex, /llms.txt, and the IndexNow key file.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-phase2a.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

import { createRouteHarness } from "./_route-harness.mjs";
import { SITE_URL, abs, breadcrumbList } from "@/lib/seo";
import { pricingModel } from "@/components/billing-ui";

const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR, APP } = createRouteHarness({
  stubs: {
    "@/components/billing-ui": { pricingModel },
    "@/lib/billing-store": { getBillingSettings: () => ({ defaults: {} }) },
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
    "@/components/ObfuscatedEmail": inert,
    "@/components/HomeClient": inert,
  },
});

process.env.GA_ID = "";
process.env.GTM_ID = "";

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));

/** Walk a `{ type, props }` element tree; return every <script ld+json> __html. */
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
// (1) Security headers — the three safe additions + the CSP guard-rail
// =====================================================================================
test("headers: next.config emits the safe security header set on every route", async () => {
  const require = createRequire(import.meta.url);
  const cfg = require(path.join(APP, "next.config.js"));
  const groups = await cfg.headers();
  const all = groups.find((g) => g.source === "/:path*");
  assert.ok(all, "a /:path* header group must exist");
  const byKey = Object.fromEntries(all.headers.map((h) => [h.key, h.value]));

  // Pre-existing (must be preserved).
  assert.ok(byKey["Strict-Transport-Security"], "HSTS preserved");
  assert.equal(byKey["X-Content-Type-Options"], "nosniff");
  assert.equal(byKey["Referrer-Policy"], "strict-origin-when-cross-origin");
  // New in 2a.
  assert.equal(byKey["X-Frame-Options"], "SAMEORIGIN");
  assert.equal(byKey["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  const csp = byKey["Content-Security-Policy"];
  assert.ok(csp, "CSP header must be present");
  for (const d of ["frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'"]) {
    assert.ok(csp.includes(d), `CSP must include: ${d}`);
  }
});

test("headers: the CSP must NOT set resource directives that could break gtag/GTM/Stripe/fonts", async () => {
  const require = createRequire(import.meta.url);
  const cfg = require(path.join(APP, "next.config.js"));
  const groups = await cfg.headers();
  const csp = groups
    .find((g) => g.source === "/:path*")
    .headers.find((h) => h.key === "Content-Security-Policy").value;
  for (const forbidden of ["default-src", "script-src", "style-src", "connect-src", "img-src", "font-src"]) {
    assert.ok(!csp.includes(forbidden), `CSP must NOT contain ${forbidden} (would risk blocking third-party tags)`);
  }
});

// =====================================================================================
// (2) breadcrumbList() helper — valid shape, 1-based positions, absolute items
// =====================================================================================
test("breadcrumbList(): produces a valid, absolute, ordered BreadcrumbList", () => {
  const bc = breadcrumbList([
    { name: "Home", path: "/" },
    { name: "Pricing", path: "/pricing" },
  ]);
  assert.equal(bc["@type"], "BreadcrumbList");
  assert.equal(bc.itemListElement.length, 2);
  bc.itemListElement.forEach((li, i) => {
    assert.equal(li["@type"], "ListItem");
    assert.equal(li.position, i + 1, "positions must be 1-based and sequential");
    assert.ok(li.item.startsWith(SITE_URL), "item must be an absolute URL");
  });
  assert.equal(bc.itemListElement[0].item, SITE_URL, "home crumb = slash-less origin (matches the canonical)");
  assert.equal(bc.itemListElement[1].item, abs("/pricing"));
});

// =====================================================================================
// (3) Exactly ONE BreadcrumbList per URL — static (all 8) + runtime (the light ones)
// =====================================================================================
const BREADCRUMB_FILES = [
  ["pricing", "page.tsx"],
  ["verify", "layout.tsx"],
  ["book", "page.tsx"],
  ["contact", "page.tsx"],
  ["privacy", "page.tsx"],
  ["overview", "page.tsx"],
  ["sample", "agency", "page.tsx"],
  ["sample", "seafarer", "page.tsx"],
];

test("breadcrumbs: each covered file calls breadcrumbList() exactly once (no double-emit)", () => {
  for (const segs of BREADCRUMB_FILES) {
    const src = fs.readFileSync(routeFile(...segs), "utf8");
    const count = (src.match(/breadcrumbList\(/g) || []).length;
    assert.equal(count, 1, `${segs.join("/")} must call breadcrumbList() exactly once (found ${count})`);
  }
});

test("breadcrumbs: the root layout does NOT emit a BreadcrumbList (no sitewide double)", () => {
  const objs = parsedBlocks(collectLdJson(loadRoute("layout.tsx").default({ children: null })));
  assert.equal(ofType(objs, "BreadcrumbList").length, 0, "root layout must not emit a BreadcrumbList");
});

for (const [route, segs] of [
  ["/pricing", ["pricing", "page.tsx"]],
  ["/verify", ["verify", "layout.tsx"]],
  ["/contact", ["contact", "page.tsx"]],
  ["/privacy", ["privacy", "page.tsx"]],
  ["/overview", ["overview", "page.tsx"]],
]) {
  test(`breadcrumbs (runtime): ${route} renders exactly one valid BreadcrumbList`, () => {
    const mod = loadRoute(...segs);
    const rendered = segs[segs.length - 1] === "layout.tsx" ? mod.default({ children: null }) : mod.default();
    const objs = parsedBlocks(collectLdJson(rendered));
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, `${route} must emit exactly one BreadcrumbList`);
    assert.ok(crumbs[0].itemListElement.length >= 2, "trail must have at least Home + self");
    assert.equal(crumbs[0].itemListElement[0].name, "Home");
  });
}

// =====================================================================================
// (4) /pricing schema — SoftwareApplication first, priceValidUntil, one FAQPage
// =====================================================================================
test("pricing: emits SoftwareApplication (first) + one BreadcrumbList + one FAQPage", () => {
  const htmls = collectLdJson(loadRoute("pricing", "page.tsx").default());
  const objs = parsedBlocks(htmls);
  // SoftwareApplication must remain the FIRST block (the phase-1 test reads [0]).
  assert.equal(objs[0]["@type"], "SoftwareApplication");
  assert.equal(ofType(objs, "BreadcrumbList").length, 1);
  assert.equal(ofType(objs, "FAQPage").length, 1);
});

test("pricing: all three Offers carry a priceValidUntil; no aggregateRating is emitted", () => {
  const [swApp] = parsedBlocks(collectLdJson(loadRoute("pricing", "page.tsx").default()));
  // WP-B: licence + metered + the free seafarer Offer (plan R10: kept because every Offer
  // carries the ONE hoisted PRICE_VALID_UNTIL constant).
  assert.ok(Array.isArray(swApp.offers) && swApp.offers.length === 3);
  for (const o of swApp.offers) {
    assert.equal(o.priceValidUntil, "2027-12-31", "each Offer must carry priceValidUntil");
    assert.equal(o.priceCurrency, "EUR");
  }
  assert.ok(!("aggregateRating" in swApp), "no aggregateRating (there are no real ratings)");
});

test("pricing: FAQPage has 4 Q&As, each with a non-empty answer (fact-based, no invention)", () => {
  const faq = ofType(parsedBlocks(collectLdJson(loadRoute("pricing", "page.tsx").default())), "FAQPage")[0];
  assert.equal(faq.mainEntity.length, 4);
  for (const q of faq.mainEntity) {
    assert.equal(q["@type"], "Question");
    assert.ok(q.name.trim().length > 0);
    assert.equal(q.acceptedAnswer["@type"], "Answer");
    assert.ok(q.acceptedAnswer.text.trim().length > 10);
  }
  // A load-bearing fact must actually be present (billable-seafarer definition).
  const joined = faq.mainEntity.map((q) => q.acceptedAnswer.text).join(" ");
  assert.match(joined, /Europe\/Tallinn/);
  assert.match(joined, /free for seafarers/i);
});

// =====================================================================================
// (5) Organization.logo ImageObject + home canonical trailing slash
// =====================================================================================
test("schema: Organization.logo is an ImageObject with explicit 512x512 dimensions", () => {
  const objs = parsedBlocks(collectLdJson(loadRoute("layout.tsx").default({ children: null })));
  // The root layout emits one @graph block (Organization + WebSite).
  const graphBlock = objs.find((o) => Array.isArray(o["@graph"]));
  assert.ok(graphBlock, "root layout must emit an @graph JSON-LD block");
  const org = graphBlock["@graph"].find((n) => n["@type"] === "Organization");
  assert.ok(org, "Organization node must exist");
  assert.equal(typeof org.logo, "object", "logo must be an object, not a bare URL string");
  assert.equal(org.logo["@type"], "ImageObject");
  assert.equal(org.logo.width, 512);
  assert.equal(org.logo.height, 512);
  assert.ok(org.logo.url.endsWith("/icon.png"));
});

test("canonical: the home canonical == the sitemap home URL, byte-identical (SEO Phase 2c)", () => {
  // Phase 2c re-alignment: Next 14 (trailingSlash:false) strips the rendered root
  // canonical's trailing slash, so abs("/") would render as the bare origin anyway. The
  // home canonical AND the sitemap home loc are both pinned to SITE_URL (slash-less), so
  // they match byte-for-byte — consistent with every other (slash-less) page.
  const canonical = loadRoute("page.tsx").metadata.alternates.canonical;
  assert.equal(canonical, SITE_URL);
  assert.ok(!canonical.endsWith("/"), "home canonical is the bare origin (no trailing slash)");
  const homeSitemap = loadRoute("sitemap.ts").default().find((e) => e.url === SITE_URL);
  assert.ok(homeSitemap, "sitemap must contain the home URL byte-identical to the canonical");
  assert.equal(homeSitemap.url, canonical);
});

// =====================================================================================
// (6) 404 title + noindex
// =====================================================================================
test("404: not-found exports its own title (resolves to 'Page not found · Docka') + noindex", () => {
  const meta = loadRoute("not-found.tsx").metadata;
  assert.equal(meta.title, "Page not found", "must be a plain string (root template appends ' · Docka')");
  const template = loadRoute("layout.tsx").metadata.title.template;
  assert.equal(template.replace("%s", meta.title), "Page not found · Docka");
  assert.equal(meta.robots.index, false);
  assert.equal(meta.robots.follow, false);
});

// =====================================================================================
// (7) /llms.txt route + IndexNow key file
// =====================================================================================
test("llms.txt: GET returns 200 text/plain, referencing the entity + key marketing URLs", async () => {
  const res = loadRoute("llms.txt", "route.ts").GET();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const text = await res.text();
  assert.match(text, /# Docka/);
  for (const p of ["/verify", "/pricing", "/overview/agencies", "/overview/seafarers", "/contact"]) {
    assert.ok(text.includes(`${SITE_URL}${p}`), `llms.txt must link ${p}`);
  }
});

test("IndexNow: a single 32-hex key file exists under public/ and contains exactly that key", () => {
  const pub = path.join(APP, "public");
  const keyFiles = fs.readdirSync(pub).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.equal(keyFiles.length, 1, "exactly one IndexNow key file must exist");
  const key = keyFiles[0].replace(/\.txt$/, "");
  const content = fs.readFileSync(path.join(pub, keyFiles[0]), "utf8").trim();
  assert.equal(content, key, "the key file's content must equal the key in its filename");
});
