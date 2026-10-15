// SEO implementation plan — WP-B (global metadata/schema + home, pricing, book, contact,
// privacy, overview layouts, verify layout) regression contract. Locks:
//   - the enriched Organization node (email, registry identifier, >=1 VERIFIED sameAs,
//     logo @id) and the root metadata (META_DESCRIPTION <=160, OG image alt+dimensions,
//     viewport.themeColor),
//   - /pricing: own og:url, Fix-B Offers (three, each with @id + UnitPriceSpecification +
//     the ONE hoisted PRICE_VALID_UNTIL), SoftwareApplication first, no /terms link (R10),
//   - /contact: one ContactPage node carrying the public email,
//   - SERP-length titles (30-60) and descriptions (<=160) with plain punctuation,
//   - /overview/seafarers: SoftwareApplication + Service; /overview/agencies Service ->
//     /pricing licence Offer by @id,
//   - breadcrumbs: item 1 === SITE_URL (slash-less) and exactly one BreadcrumbList on every
//     B page that has one; every WebPage `breadcrumb.@id` resolves in the SAME page's
//     JSON-LD set (plan R12); /verify's crumb carries the @id WP-C's WebPage references,
//   - the home WebPage is the shared webPageJsonLd shape (no breadcrumb ref, url === SITE_URL),
//     plus the PSV definition link + the disambiguator sentence,
//   - footer: tap-target class on every link, NO /security and NO /terms link (S4, R10),
//   - /privacy: controller block (legal name, registry code, Stripe) and a visible Last updated.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-schema-b.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRouteHarness } from "./_route-harness.mjs";
import { SITE_URL, abs, META_DESCRIPTION } from "@/lib/seo";
import { pricingModel } from "@/components/billing-ui";

const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR } = createRouteHarness({
  stubs: {
    "@/components/billing-ui": { pricingModel },
    "@/lib/billing-store": { getBillingSettings: () => ({ defaults: {} }) },
    // /book reads the JSON store + the calendar; stub the edges so the page renders inert.
    "@/lib/db": { readDB: () => ({ bookings: [] }) },
    "@/lib/booking": {
      businessNowParts: () => ({ date: "2026-09-06" }),
      excludeBusySlots: (slots) => slots,
      generateSlots: () => [],
      getBookingSettings: () => ({ timezone: "Europe/Tallinn", slotMinutes: 30 }),
      pickLeadKey: () => undefined,
    },
    "@/lib/google-calendar": {
      calendarConfigured: () => false,
      getBusyWallRangesForRender: async () => ({ ranges: [], stale: false }),
    },
    "./BookClient": inert,
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
const readSource = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");

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

/** Every top-level JSON-LD node on a page, with @graph blocks flattened. */
function ldNodes(rendered) {
  const nodes = [];
  for (const html of collectLdJson(rendered)) {
    const parsed = JSON.parse(html);
    if (Array.isArray(parsed["@graph"])) nodes.push(...parsed["@graph"]);
    else nodes.push(parsed);
  }
  return nodes;
}
const ofType = (nodes, type) => nodes.filter((n) => n && n["@type"] === type);

/** Every string value reachable in an object graph. */
function walkStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => walkStrings(n, out));
  else if (node && typeof node === "object") Object.values(node).forEach((v) => walkStrings(v, out));
  return out;
}

const TYPOGRAPHIC = /[–—‘’“”]/;
const ROOT_TEMPLATE = "%s · Docka";

// The B pages that render in this harness, keyed by route. Layouts take { children }.
const B_PAGES = {
  "/": () => loadRoute("page.tsx").default(),
  "/pricing": () => loadRoute("pricing", "page.tsx").default(),
  "/book": () => loadRoute("book", "page.tsx").default({ searchParams: {} }),
  "/contact": () => loadRoute("contact", "page.tsx").default(),
  "/privacy": () => loadRoute("privacy", "page.tsx").default(),
  "/overview/agencies": () => loadRoute("overview", "agencies", "layout.tsx").default({ children: null }),
  "/overview/seafarers": () => loadRoute("overview", "seafarers", "layout.tsx").default({ children: null }),
  "/verify": () => loadRoute("verify", "layout.tsx").default({ children: null }),
};
const CRUMB_PAGES = Object.keys(B_PAGES).filter((r) => r !== "/");

// =====================================================================================
// (1) Organization node + root metadata
// =====================================================================================
function rootOrganization() {
  const nodes = ldNodes(loadRoute("layout.tsx").default({ children: null }));
  const org = ofType(nodes, "Organization")[0];
  assert.ok(org, "root layout must emit an Organization node");
  return org;
}

test("organization: email, Estonian registry identifier, >=1 verified sameAs, logo/image @id", () => {
  const org = rootOrganization();
  assert.equal(org.email, "info@docka.me");
  assert.equal(org.identifier["@type"], "PropertyValue");
  assert.equal(org.identifier.value, "17579582");
  assert.ok(Array.isArray(org.sameAs) && org.sameAs.length >= 1, "sameAs must carry >=1 URL (plan R9)");
  for (const u of org.sameAs) assert.match(u, /^https:\/\//, `sameAs must be absolute https: ${u}`);
  assert.ok(
    org.sameAs.includes("https://ariregister.rik.ee/eng/company/17579582"),
    "the verified e-Business Register card must be present"
  );
  assert.ok(
    org.sameAs.includes("https://www.linkedin.com/company/docka-me/"),
    "the LinkedIn company page (owner-created, browser-verified 2026-09-07) must be present"
  );
  assert.equal(org.logo["@id"], abs("/#logo"));
  assert.equal(org.logo.width, 512, "logo stays an inline ImageObject with dimensions");
  assert.equal(org.image["@id"], abs("/#logo"));
  assert.equal(org.alternateName, "docka.me");
  // Positioning batch 2026-09-07 (plan v4 §2a): 5 -> 6 entries, led by the CRM category.
  assert.ok(Array.isArray(org.knowsAbout) && org.knowsAbout.length === 6);
  assert.ok(org.knowsAbout.includes("Crewing agency CRM"));
  assert.ok(Array.isArray(org.contactPoint) && org.contactPoint[0].email === "info@docka.me");
  // Plan R9/Fix-A trims: nothing the owner has not confirmed as public.
  for (const k of ["founder", "foundingDate", "vatID", "numberOfEmployees"]) {
    assert.ok(!(k in org), `Organization must not carry ${k}`);
  }
  assert.ok(!("streetAddress" in org.address) && !("postalCode" in org.address), "no street/postal");
});

test("root metadata: META_DESCRIPTION (<=160), OG image alt + dimensions, viewport.themeColor", () => {
  const mod = loadRoute("layout.tsx");
  const meta = mod.metadata;
  assert.equal(meta.description, META_DESCRIPTION);
  assert.ok(meta.description.length <= 160, `root description is ${meta.description.length} chars`);
  const og = meta.openGraph.images[0];
  assert.ok(typeof og.alt === "string" && og.alt.length > 0, "OG image must carry alt");
  assert.equal(og.width, 1200);
  assert.equal(og.height, 630);
  assert.ok(meta.twitter.images[0].alt, "twitter image must carry alt");
  assert.equal(meta.openGraph.description, META_DESCRIPTION);
  assert.equal(mod.viewport.themeColor, "#0f172a");
});

// =====================================================================================
// (2) /pricing — og:url, Fix-B Offers, hoisted PRICE_VALID_UNTIL, no /terms (R10)
// =====================================================================================
test("pricing: own og:url + OG image alt; SoftwareApplication first with @id/featureList", () => {
  const mod = loadRoute("pricing", "page.tsx");
  assert.equal(mod.metadata.openGraph.url, "/pricing");
  assert.equal(mod.metadata.openGraph.type, "website");
  assert.ok(mod.metadata.openGraph.images[0].alt, "OG image alt");
  const blocks = collectLdJson(mod.default()).map((h) => JSON.parse(h));
  const app = blocks[0];
  assert.equal(app["@type"], "SoftwareApplication", "SoftwareApplication must stay the FIRST block");
  assert.equal(app["@id"], abs("/#software"));
  assert.ok(Array.isArray(app.featureList) && app.featureList.length === 5);
  assert.match(app.dateModified, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(app.publisher["@id"], abs("/#organization"));
  assert.ok(Array.isArray(app.screenshot) && app.screenshot[0].startsWith(SITE_URL));
  assert.ok(!("aggregateRating" in app));
});

test("pricing: every Offer has @id + UnitPriceSpecification + the ONE hoisted PRICE_VALID_UNTIL", () => {
  // The constant is hoisted ONCE, in lib/seo.ts (shared with the /overview/seafarers free
  // Offer since 2026-09-07); the pricing page imports it and never re-types the literal.
  const seoSrc = fs.readFileSync(path.join(APP_DIR, "..", "lib", "seo.ts"), "utf8");
  const hoisted = [...seoSrc.matchAll(/export const PRICE_VALID_UNTIL = "(\d{4}-\d{2}-\d{2})"/g)];
  assert.equal(hoisted.length, 1, "exactly one hoisted PRICE_VALID_UNTIL constant (plan S5)");
  const PRICE_VALID_UNTIL = hoisted[0][1];
  assert.equal(
    (seoSrc.match(new RegExp(PRICE_VALID_UNTIL, "g")) || []).length,
    1,
    "the date literal must appear ONCE in lib/seo.ts (never re-typed per Offer)"
  );
  const src = readSource("pricing", "page.tsx");
  assert.ok(!src.includes(PRICE_VALID_UNTIL), "the pricing page must import the constant, not re-type the date");
  assert.match(src, /PRICE_VALID_UNTIL/, "the pricing page uses the hoisted constant");
  const [app] = collectLdJson(loadRoute("pricing", "page.tsx").default()).map((h) => JSON.parse(h));
  assert.equal(app.offers.length, 3);
  const ids = app.offers.map((o) => o["@id"]);
  assert.deepEqual(ids, [
    abs("/pricing#offer-licence"),
    abs("/pricing#offer-metered"),
    abs("/pricing#offer-seafarer-free"),
  ]);
  for (const o of app.offers) {
    assert.equal(o.priceValidUntil, PRICE_VALID_UNTIL);
    assert.equal(o.priceSpecification["@type"], "UnitPriceSpecification");
    assert.equal(o.priceSpecification.price, o.price, "spec price mirrors the Offer price");
    assert.equal(o.priceSpecification.unitCode, "MON");
    assert.equal(o.priceCurrency, "EUR");
    assert.equal(typeof o.price, "number");
    assert.equal(o.seller["@id"], abs("/#organization"));
  }
  // Prices are the live model (defaults -> canonical 300 / 2), never literals; free = 0.
  const model = pricingModel({});
  assert.equal(app.offers[0].price, model.base);
  assert.equal(app.offers[0].name, "Monthly licence");
  assert.equal(app.offers[1].price, model.perSeafarer);
  assert.equal(app.offers[1].priceSpecification.referenceQuantity.value, 1);
  assert.equal(app.offers[2].price, 0);
  assert.equal(app.offers[2].eligibleCustomerType, "https://schema.org/Consumer");
});

test("pricing: no /terms link and no cancel FAQ yet (plan R10 deferred); links /overview/agencies", () => {
  const src = readSource("pricing", "page.tsx");
  assert.ok(!src.includes('href="/terms"'), "no /terms link until the owner confirms the ToS text");
  assert.ok(src.includes('href="/overview/agencies"'), "in-copy link to the agency plan");
  assert.match(src, /Prices shown are current as of/, "visible 'current as of' line");
  assert.match(src, /<time dateTime=\{CONTENT_LAST_UPDATED_ISO\}>/, "the date is a real <time>");
  const nodes = ldNodes(loadRoute("pricing", "page.tsx").default());
  assert.equal(ofType(nodes, "FAQPage")[0].mainEntity.length, 4);
  const wp = ofType(nodes, "WebPage")[0];
  assert.ok(wp, "/pricing must emit a WebPage node");
  assert.equal(wp["@id"], abs("/pricing#webpage"));
});

// =====================================================================================
// (3) /contact — exactly one ContactPage with the public email
// =====================================================================================
test("contact: exactly one ContactPage node carrying the public email", () => {
  const nodes = ldNodes(loadRoute("contact", "page.tsx").default());
  const cp = ofType(nodes, "ContactPage");
  assert.equal(cp.length, 1);
  assert.equal(cp[0].email, "info@docka.me");
  assert.equal(cp[0]["@id"], abs("/contact#webpage"));
  assert.equal(cp[0].isPartOf["@id"], abs("/#website"));
  assert.equal(ofType(nodes, "WebPage").length, 0, "the page node is the ContactPage, not a second WebPage");
});

// =====================================================================================
// (4) Titles 30-60 / descriptions <=160 / plain punctuation
// =====================================================================================
const META_PAGES = [
  ["/book", ["book", "page.tsx"]],
  ["/contact", ["contact", "page.tsx"]],
  ["/privacy", ["privacy", "page.tsx"]],
  ["/pricing", ["pricing", "page.tsx"]],
  ["/overview/agencies", ["overview", "agencies", "layout.tsx"]],
  ["/overview/seafarers", ["overview", "seafarers", "layout.tsx"]],
  ["/verify", ["verify", "layout.tsx"]],
];

for (const [route, segs] of META_PAGES) {
  test(`metadata: ${route} title 30-60 chars, description <=160, plain punctuation, own og:url`, () => {
    const meta = loadRoute(...segs).metadata;
    assert.equal(typeof meta.title, "string", "title must be a plain string (root template applies)");
    // /pricing's bare title is pinned at 28 chars by seo-phase1; the SERP sees the resolved
    // form, so measure that one through the root template.
    const measured = route === "/pricing" ? ROOT_TEMPLATE.replace("%s", meta.title) : meta.title;
    assert.ok(
      measured.length >= 30 && measured.length <= 60,
      `${route} title is ${measured.length} chars: ${measured}`
    );
    assert.ok(meta.description.length <= 160, `${route} description is ${meta.description.length} chars`);
    assert.ok(meta.description.length >= 70, `${route} description is too short (${meta.description.length})`);
    assert.ok(!TYPOGRAPHIC.test(meta.title), `${route} title has typographic punctuation`);
    assert.ok(!TYPOGRAPHIC.test(meta.description), `${route} description has typographic punctuation`);
    assert.ok(!/\bdocka\b/.test(meta.description), `${route} description must capitalise Docka`);
    assert.equal(meta.openGraph.url, route);
    assert.equal(meta.openGraph.title, meta.title);
    assert.equal(meta.openGraph.description, meta.description);
    assert.ok(meta.openGraph.images[0].alt, `${route} OG image alt`);
    assert.equal(meta.alternates.canonical, route);
  });
}

test("metadata: the seven B titles are unique across each other", () => {
  const titles = META_PAGES.map(([, segs]) => loadRoute(...segs).metadata.title);
  assert.equal(new Set(titles).size, titles.length, `duplicate titles: ${titles.join(" | ")}`);
});

// =====================================================================================
// (5) Overview layouts — SoftwareApplication + Service (seafarers), Service -> Offer (agencies)
// =====================================================================================
test("overview/seafarers layout: SoftwareApplication (free) + Service + WebPage, all jsonLd()-escaped", () => {
  const rendered = loadRoute("overview", "seafarers", "layout.tsx").default({ children: null });
  const nodes = ldNodes(rendered);
  const app = ofType(nodes, "SoftwareApplication");
  assert.equal(app.length, 1);
  assert.equal(app[0]["@id"], abs("/#software-seafarer"));
  assert.equal(app[0].isAccessibleForFree, true);
  assert.equal(app[0].offers.price, 0);
  assert.equal(app[0].offers.priceCurrency, "EUR");
  assert.equal(app[0].offers["@id"], abs("/pricing#offer-seafarer-free"), "same free Offer entity as /pricing");
  const svc = ofType(nodes, "Service");
  assert.equal(svc.length, 1);
  assert.equal(svc[0]["@id"], abs("/#service-seafarers"));
  assert.equal(svc[0].isAccessibleForFree, true);
  assert.equal(svc[0].provider["@id"], abs("/#organization"));
  assert.equal(ofType(nodes, "WebPage").length, 1);
  // Every block goes through jsonLd() (no raw JSON.stringify): no raw "<" can survive.
  for (const html of collectLdJson(rendered)) assert.ok(!html.includes("<"), "jsonLd()-escaped");
  assert.ok(!readSource("overview", "seafarers", "layout.tsx").includes("JSON.stringify("));
  // Owner phrase kept in the title (seo-tier1 owner pin).
  assert.match(loadRoute("overview", "seafarers", "layout.tsx").metadata.title, /Seafarer Documentation Service/);
});

test("overview/agencies layout: Service has @id/url and references the /pricing licence Offer", () => {
  const nodes = ldNodes(loadRoute("overview", "agencies", "layout.tsx").default({ children: null }));
  const svc = ofType(nodes, "Service");
  assert.equal(svc.length, 1);
  assert.equal(svc[0]["@id"], abs("/#service-agencies"));
  assert.equal(svc[0].url, abs("/overview/agencies"));
  assert.equal(svc[0].offers["@id"], abs("/pricing#offer-licence"));
  assert.equal(ofType(nodes, "WebPage").length, 1);
});

// =====================================================================================
// (6) Breadcrumbs — item 1 === SITE_URL, exactly one list, @id resolution (R12)
// =====================================================================================
for (const route of CRUMB_PAGES) {
  test(`breadcrumbs: ${route} emits exactly one BreadcrumbList whose item 1 is the slash-less SITE_URL`, async () => {
    const nodes = ldNodes(await B_PAGES[route]());
    const crumbs = ofType(nodes, "BreadcrumbList");
    assert.equal(crumbs.length, 1, `${route} must emit exactly one BreadcrumbList`);
    const items = crumbs[0].itemListElement;
    assert.equal(items[0].item, SITE_URL);
    assert.equal(items[0].name, "Home");
    assert.equal(items[items.length - 1].item, abs(route), "last crumb is the page itself");
    assert.equal(crumbs[0]["@id"], `${abs(route)}#breadcrumb`, "crumb carries its #breadcrumb @id");
    for (const s of walkStrings(crumbs[0])) assert.ok(!s.endsWith("docka.me/"), `no trailing-slash home: ${s}`);
  });
}

test("R12: every WebPage/ContactPage breadcrumb @id resolves to a BreadcrumbList in the SAME page's JSON-LD", async () => {
  for (const route of Object.keys(B_PAGES)) {
    const nodes = ldNodes(await B_PAGES[route]());
    const ids = new Set(nodes.map((n) => n["@id"]).filter(Boolean));
    const pages = nodes.filter((n) => n["@type"] === "WebPage" || n["@type"] === "ContactPage");
    if (route !== "/verify") assert.ok(pages.length >= 1, `${route} must emit a WebPage node`);
    for (const p of pages) {
      assert.equal(p["@id"], `${abs(route === "/" ? "/" : route)}#webpage`.replace(`${SITE_URL}/#`, `${SITE_URL}/#`));
      assert.equal(p.isPartOf["@id"], abs("/#website"));
      assert.match(p.dateModified, /^\d{4}-\d{2}-\d{2}$/);
      if (p.breadcrumb) {
        assert.ok(ids.has(p.breadcrumb["@id"]), `${route}: dangling breadcrumb @id ${p.breadcrumb["@id"]}`);
      } else {
        assert.equal(route, "/", `${route}: only the home WebPage may omit the breadcrumb reference`);
      }
    }
  }
});

test("verify layout: exactly one JSON-LD block, the crumb carries the @id WP-C's WebPage references", () => {
  const rendered = loadRoute("verify", "layout.tsx").default({ children: null });
  const htmls = collectLdJson(rendered);
  assert.equal(htmls.length, 1, "/verify layout keeps exactly ONE JSON-LD block (seo-phase1 pin)");
  const crumb = JSON.parse(htmls[0]);
  assert.equal(crumb["@type"], "BreadcrumbList");
  assert.equal(crumb["@id"], abs("/verify#breadcrumb"));
  assert.equal(loadRoute("verify", "layout.tsx").metadata.title, "Verify a Seafarer Certificate Against Its Registry");
});

// =====================================================================================
// (7) Home — shared WebPage shape, PSV definition link, disambiguator
// =====================================================================================
test("home: WebPage is the shared webPageJsonLd shape (url === SITE_URL, #webpage, no breadcrumb ref)", () => {
  const nodes = ldNodes(loadRoute("page.tsx").default());
  const wp = ofType(nodes, "WebPage");
  assert.equal(wp.length, 1);
  assert.equal(wp[0]["@id"], abs("/#webpage"));
  assert.equal(wp[0].url, SITE_URL, "home url is the slash-less origin (matches the canonical)");
  assert.equal(wp[0].isPartOf["@id"], abs("/#website"));
  assert.ok(!("breadcrumb" in wp[0]), "home emits no BreadcrumbList, so no breadcrumb reference");
  assert.equal(ofType(nodes, "BreadcrumbList").length, 0);
  assert.equal(ofType(nodes, "FAQPage").length, 1, "the home FAQ block is untouched");
  for (const s of walkStrings(wp[0])) assert.ok(!TYPOGRAPHIC.test(s), `plain punctuation: ${s}`);
  const src = readSource("page.tsx");
  assert.ok(!src.includes("homeWebPageJsonLd = {"), "hand-built home WebPage literal replaced (R6)");
  assert.match(src, /webPageJsonLd\(\{/);
});

test("home: links the PSV definition page and carries the disambiguator sentence (server section)", () => {
  const src = readSource("page.tsx");
  assert.ok(src.includes('href="/what-is-primary-source-verification"'), "PSV definition link");
  assert.match(src, /Read the full definition of primary source verification/);
  // Positioning batch 2026-09-07 (plan v4 §2d): the disambiguator no longer disclaims CRM
  // capability. The negative keeps the superseded sentence from creeping back.
  assert.match(src, /Docka is a crewing agency CRM with certificate verification built in\./);
  assert.doesNotMatch(src, /is not a rest-hours or scheduling tool\. It verifies certificates\./);
  // HomeClient / i18n untouched: the server wrapper still renders <HomeClient /> and HOME_FAQ.
  assert.match(src, /<HomeClient \/>/);
  assert.match(src, /const HOME_FAQ\b/);
});

// =====================================================================================
// (8) Footer + privacy
// =====================================================================================
test("footer: every footer link is a tap target (inline-block py-2); no /security, no /terms (S4, R10)", () => {
  const src = readSource("layout.tsx");
  const footer = src.slice(src.indexOf("<footer"), src.indexOf("</footer>"));
  const links = [...footer.matchAll(/<Link[\s\S]*?className="([^"]*)"/g)];
  assert.ok(links.length >= 6, `expected the six footer links, found ${links.length}`);
  for (const [, cls] of links) {
    assert.ok(cls.includes("inline-block") && cls.includes("py-2"), `footer link lacks tap-target classes: ${cls}`);
  }
  for (const target of ['href="/about"', 'href="/registries"', 'href="/resources"', 'href="/pricing"', 'href="/privacy"', 'href="/contact"']) {
    assert.ok(footer.includes(target), `footer must keep ${target}`);
  }
  assert.ok(!src.includes('href="/security"'), "no /security link (plan S4: struck)");
  assert.ok(!src.includes('href="/terms"'), "no /terms link (plan R10: deferred)");
});

test("privacy: visible Last updated + controller block (legal name, registry code, Stripe); no vendor names", () => {
  const src = readSource("privacy", "page.tsx");
  assert.match(src, /from "@\/components\/LastUpdated"/, "reuses the shared LastUpdated component");
  assert.match(src, /<LastUpdated \/>/);
  assert.match(src, /Docka Development OÜ/);
  assert.match(src, /17579582/);
  assert.match(src, /Tallinn, Estonia/);
  assert.match(src, /Stripe/);
  assert.match(src, /data controller/);
  for (const vendor of ["Zoho", "Hetzner"]) assert.ok(!src.includes(vendor), `${vendor} is owner-gated`);
  assert.ok(!TYPOGRAPHIC.test(src), "privacy copy uses plain punctuation");
  const nodes = ldNodes(loadRoute("privacy", "page.tsx").default());
  assert.equal(ofType(nodes, "WebPage").length, 1);
});
