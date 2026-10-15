// SEO Phase 1 (seo/phase-1-onpage) regression contract. Locks the on-page hygiene
// + structured-data invariants the pass shipped, so a later edit that re-introduces
// a nav trap, a title.absolute, an unescaped JSON-LD block, a sitemap↔noindex
// contradiction, or a hollow pricing key fails the build.
//
// Rendering: the repo harness (tests/_route-harness.mjs) transpiles the real
// route .tsx/.ts in-process and invokes the server components with a JSX-runtime
// stub that returns `{ type, props }` — no next build, no react-dom. Client-only
// imports (next/link, the client components under app/layout.tsx) are stubbed to
// inert modules; only the module top-level must evaluate, never render.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-phase1.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRouteHarness } from "./_route-harness.mjs";
import { jsonLd, SITE_URL } from "@/lib/seo";
import { pricingModel } from "@/components/billing-ui";
import { DICT } from "@/lib/i18n";

// ---- shared harness: inert stubs for every client-only edge the in-scope route
// modules import, so a metadata read / component invoke never mounts React. ----
const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR } = createRouteHarness({
  stubs: {
    // billing-ui is a .ts (the harness only probes .tsx for @/components/*), so
    // hand it the real pricingModel imported through the @/ alias above.
    "@/components/billing-ui": { pricingModel },
    // /pricing reads only the billing defaults; empty defaults exercise the
    // canonical 300/2 fallback (pricingModel tolerates {}).
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
  },
});

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));

/** Walk a `{ type, props }` element tree; return every <script type=ld+json> __html. */
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

// Silence GA/GTM branch when rendering the root layout (avoids the <Script> path).
process.env.GA_ID = "";
process.env.GTM_ID = "";

// =====================================================================================
// (1) Sitemap ↔ noindex two-way contract
// =====================================================================================
const sitemap = loadRoute("sitemap.ts").default();
const sitemapPaths = sitemap.map((e) => {
  assert.ok(e.url.startsWith(SITE_URL), `sitemap url ${e.url} must be absolute under ${SITE_URL}`);
  return e.url.slice(SITE_URL.length) || "/";
});

test("sitemap: every URL resolves to a real route file", () => {
  for (const p of sitemapPaths) {
    const dir = p === "/" ? APP_DIR : routeFile(...p.replace(/^\//, "").split("/"));
    const hasPage = fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "page.ts"));
    assert.ok(hasPage, `sitemap path ${p} has no page file at ${dir}`);
  }
});

test("sitemap: no listed URL is a noindex segment (/seafarer, /agent or a nested route)", () => {
  // Only /seafarer, /agent (segment layouts) and /verify/[uuid] carry robots noindex.
  // A sitemap entry that resolves (above) AND is not under those is, by construction,
  // an indexable page — the "NOT noindex" half of the contract.
  for (const p of sitemapPaths) {
    assert.ok(p !== "/seafarer" && !p.startsWith("/seafarer/"), `${p} is the noindex seafarer shell`);
    assert.ok(p !== "/agent" && !p.startsWith("/agent/"), `${p} is under the noindex agent area`);
  }
});

test("sitemap: /seafarer and /agent are ABSENT", () => {
  assert.ok(!sitemapPaths.includes("/seafarer"), "/seafarer must not be in the sitemap");
  assert.ok(!sitemapPaths.includes("/agent"), "/agent must not be in the sitemap");
});

test("noindex: /seafarer and /agent layouts still emit robots noindex", () => {
  for (const seg of ["seafarer", "agent"]) {
    const meta = loadRoute(seg, "layout.tsx").metadata;
    assert.ok(meta && meta.robots, `/${seg} layout must export metadata.robots`);
    assert.equal(meta.robots.index, false, `/${seg} must be robots index:false`);
    assert.equal(meta.robots.follow, false, `/${seg} must be robots follow:false`);
  }
});

// =====================================================================================
// (2) JSON-LD validity + hostile-string escaper
// =====================================================================================
test("JSON-LD: every block on / , /pricing and /overview/agencies parses as JSON", () => {
  const blocks = {
    "/": collectLdJson(loadRoute("layout.tsx").default({ children: null })),
    "/pricing": collectLdJson(loadRoute("pricing", "page.tsx").default()),
    "/overview/agencies": collectLdJson(loadRoute("overview", "agencies", "layout.tsx").default({ children: null })),
  };
  for (const [route, htmls] of Object.entries(blocks)) {
    assert.ok(htmls.length >= 1, `${route} must emit at least one JSON-LD block`);
    for (const html of htmls) {
      assert.doesNotThrow(() => JSON.parse(html), `${route} JSON-LD must parse`);
      assert.ok(!html.includes("</script>"), `${route} JSON-LD must not contain a raw </script>`);
    }
  }
  // /verify now emits exactly one JSON-LD block (a BreadcrumbList, added in SEO Phase 2a);
  // it must parse and be a BreadcrumbList.
  const verifyBlocks = collectLdJson(loadRoute("verify", "layout.tsx").default({ children: null }));
  assert.equal(verifyBlocks.length, 1, "/verify emits exactly one JSON-LD block");
  assert.equal(JSON.parse(verifyBlocks[0])["@type"], "BreadcrumbList");
});

test("JSON-LD: the root Organization node carries the verified e-Business Register sameAs (parses)", () => {
  const blocks = collectLdJson(loadRoute("layout.tsx").default({ children: null }));
  assert.ok(blocks.length >= 1, "/ must emit at least one JSON-LD block");
  // The site-wide block is an @graph; locate the Organization node within it.
  let org = null;
  for (const html of blocks) {
    let parsed;
    assert.doesNotThrow(() => (parsed = JSON.parse(html)), "root JSON-LD must parse");
    const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
    const found = nodes.find((n) => n && n["@type"] === "Organization");
    if (found) org = found;
  }
  assert.ok(org, "root JSON-LD must include an Organization node");
  assert.ok(Array.isArray(org.sameAs), "Organization.sameAs must be an array");
  // SEO implementation plan R9: sameAs ships ONLY URLs verified to resolve. The Estonian
  // e-Business Register card for registry code 17579582 (HTTP 200, names "Docka
  // Development OÜ") was verified 2026-09-06. The LinkedIn company page
  // /company/docka-me/ was dropped on 09-06 (404 then) and restored 2026-09-07 once the
  // owner created it and it was confirmed live in a browser.
  assert.ok(
    org.sameAs.includes("https://ariregister.rik.ee/eng/company/17579582"),
    "Organization.sameAs must contain the verified e-Business Register card URL",
  );
  assert.ok(
    org.sameAs.includes("https://www.linkedin.com/company/docka-me/"),
    "Organization.sameAs must contain the live LinkedIn company page (verified 2026-09-07)",
  );
  assert.equal(new Set(org.sameAs).size, org.sameAs.length, "sameAs must not repeat a URL");
});

test("JSON-LD: the /pricing SoftwareApplication carries a numeric Offer 300 EUR", () => {
  const [html] = collectLdJson(loadRoute("pricing", "page.tsx").default());
  const obj = JSON.parse(html);
  assert.equal(obj["@type"], "SoftwareApplication");
  const licence = obj.offers.find((o) => o.name === "Monthly licence");
  assert.equal(licence.price, 300, "the monthly-licence Offer price must be the numeric 300");
  assert.equal(licence.priceCurrency, "EUR");
});

test("jsonLd() neutralizes a hostile </script> + <b> value, staying valid JSON", () => {
  const out = jsonLd({ evil: "</script><b>x</b> & more" });
  assert.ok(!out.includes("</script>"), "no raw </script> may survive");
  assert.ok(!out.includes("<b>"), "no raw < may survive (tag break-out)");
  assert.ok(out.includes("\\u003c"), "< must be unicode-escaped");
  const parsed = JSON.parse(out);
  assert.equal(parsed.evil, "</script><b>x</b> & more", "the value round-trips through JSON.parse intact");
});

// =====================================================================================
// (3) Nav guard — no /seafarer trap; informational item targets /overview/seafarers
// =====================================================================================
const siteNavSrc = fs.readFileSync(path.join(APP_DIR, "..", "components", "SiteNav.tsx"), "utf-8");
const navBlock = siteNavSrc.slice(
  siteNavSrc.indexOf("const NAV_LINKS"),
  siteNavSrc.indexOf("];", siteNavSrc.indexOf("const NAV_LINKS")) + 2
);

test("nav (negative): NO NAV_LINKS entry hrefs the noindex /seafarer app shell", () => {
  assert.ok(navBlock.length > 0, "NAV_LINKS block must be found in SiteNav.tsx");
  assert.ok(!/href:\s*["']\/seafarer["']/.test(navBlock), "NAV_LINKS must not link /seafarer");
});

test("nav (positive): the informational nav item targets /overview/seafarers", () => {
  assert.match(
    navBlock,
    /href:\s*["']\/overview\/seafarers["'],\s*key:\s*["']nav\.seafarer["']/,
    "the nav.seafarer item must point at /overview/seafarers"
  );
});

// =====================================================================================
// (4) Title normalization — no title.absolute; titles resolve via the "%s · Docka" template
// =====================================================================================
test("titles: no metadata under app/ uses title.absolute", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(ent.name)) {
        if (/absolute\s*:/.test(fs.readFileSync(full, "utf-8"))) offenders.push(full);
      }
    }
  };
  walk(APP_DIR);
  assert.deepEqual(offenders, [], `title.absolute must not appear in metadata: ${offenders.join(", ")}`);
});

test("titles: /pricing resolves via the root template to 'Pricing for Crewing Agencies · Docka' (no '— docka')", () => {
  const rootTitle = loadRoute("layout.tsx").metadata.title;
  assert.equal(typeof rootTitle.template, "string", "root metadata.title.template must exist");
  assert.equal(rootTitle.template, "%s · Docka");

  const pricingTitle = loadRoute("pricing", "page.tsx").metadata.title;
  assert.equal(typeof pricingTitle, "string", "/pricing title must be a plain string, never { absolute }");

  const resolved = rootTitle.template.replace("%s", pricingTitle);
  assert.equal(resolved, "Pricing for Crewing Agencies · Docka");
  assert.ok(!/—\s*docka/i.test(resolved), "the resolved title must not contain a '— docka' fragment");
});

// =====================================================================================
// (5) i18n — pricing.title exists with a non-empty en; pricing.* completeness sweep
// =====================================================================================
test("i18n: pricing.title exists in the DICT with a non-empty en value", () => {
  const entry = DICT["pricing.title"];
  assert.ok(entry, "pricing.title must exist in the DICT");
  assert.equal(typeof entry.en, "string", "pricing.title must have an en string");
  assert.ok(entry.en.trim().length > 0, "pricing.title en must be non-empty");
});

test("i18n: every pricing.* key has a non-empty en (a hollow/missing key fails)", () => {
  const pricingKeys = Object.keys(DICT).filter((k) => k.startsWith("pricing."));
  assert.ok(pricingKeys.length >= 1, "there must be at least one pricing.* key");
  for (const key of pricingKeys) {
    const entry = DICT[key];
    assert.equal(typeof entry.en, "string", `${key} must have an en string`);
    assert.ok(entry.en.trim().length > 0, `${key} en must be non-empty`);
  }
});
