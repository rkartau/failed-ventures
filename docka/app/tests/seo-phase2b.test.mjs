// SEO Phase 2b (seo/phase-2b-content) regression contract. Locks the new content pages
// this pass shipped — /about, the /registries hub + azerbaijan/ukraine spokes, the
// /resources index + the long-form guide. For EACH new route it pins:
//   - present in the sitemap (byte-identical to its self-canonical),
//   - indexable (no robots noindex) with a self-canonical + og image,
//   - a unique title (plain string, so the root template appends " · Docka"),
//   - every JSON-LD block parses, and EXACTLY ONE BreadcrumbList per page,
//   - the page-type schema (AboutPage / FAQPage / Article / CollectionPage) present,
//   - and JSON-LD @id references resolve to the sitewide Organization/WebSite nodes.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-phase2b.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { SITE_URL, abs } from "@/lib/seo";

const { loadTs, APP_DIR } = createRouteHarness({
  stubs: {
    "next/link": { default: () => null },
  },
});

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

// The six new routes: [pretty route, path segments under app/, expected page-type schema].
const NEW_PAGES = [
  ["/about", ["about", "page.tsx"], "AboutPage"],
  ["/registries", ["registries", "page.tsx"], "CollectionPage"],
  ["/registries/azerbaijan", ["registries", "azerbaijan", "page.tsx"], "FAQPage"],
  ["/registries/ukraine", ["registries", "ukraine", "page.tsx"], "FAQPage"],
  ["/resources", ["resources", "page.tsx"], "CollectionPage"],
  [
    "/resources/how-seafarer-certificate-verification-works",
    ["resources", "how-seafarer-certificate-verification-works", "page.tsx"],
    "Article",
  ],
];

// =====================================================================================
// (1) Sitemap — every new route present, byte-identical to its self-canonical
// =====================================================================================
test("sitemap: every new Phase 2b route is present and matches its canonical URL", () => {
  const entries = loadRoute("sitemap.ts").default();
  const urls = new Set(entries.map((e) => e.url));
  for (const [route, segs] of NEW_PAGES) {
    assert.ok(urls.has(abs(route)), `sitemap must contain ${abs(route)}`);
    const canonical = loadRoute(...segs).metadata.alternates.canonical;
    assert.equal(canonical, route, `${route} canonical must be the self path`);
    assert.ok(urls.has(abs(canonical)), `sitemap URL must equal abs(canonical) for ${route}`);
  }
});

// =====================================================================================
// (2) Indexable + self-canonical + og image (no accidental noindex)
// =====================================================================================
for (const [route, segs] of NEW_PAGES) {
  test(`metadata: ${route} is indexable, self-canonical, and carries an og image`, () => {
    const meta = loadRoute(...segs).metadata;
    // No noindex — either no robots field at all, or robots.index !== false.
    if (meta.robots) {
      assert.notEqual(meta.robots.index, false, `${route} must NOT be noindex`);
    }
    assert.equal(meta.alternates.canonical, route, `${route} must self-canonicalise`);
    assert.ok(meta.openGraph && meta.openGraph.images, `${route} must set an og image`);
    assert.equal(typeof meta.title, "string", `${route} title must be a plain string for the template`);
    assert.ok(meta.title.trim().length > 0);
    assert.ok(!meta.title.includes("· Docka"), `${route} title must NOT pre-bake the template suffix`);
  });
}

test("metadata: the six new page titles are all unique", () => {
  const titles = NEW_PAGES.map(([, segs]) => loadRoute(...segs).metadata.title);
  assert.equal(new Set(titles).size, titles.length, "every new page title must be unique");
});

// =====================================================================================
// (3) JSON-LD parses + EXACTLY ONE BreadcrumbList + the expected page-type schema
// =====================================================================================
for (const [route, segs, pageType] of NEW_PAGES) {
  test(`schema: ${route} emits parseable JSON-LD, exactly one BreadcrumbList, and a ${pageType}`, () => {
    const htmls = collectLdJson(loadRoute(...segs).default());
    assert.ok(htmls.length >= 2, `${route} must emit at least the page schema + a BreadcrumbList`);
    const objs = parsedBlocks(htmls); // throws if any block is invalid JSON
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, `${route} must emit EXACTLY ONE BreadcrumbList`);
    const trail = crumbs[0].itemListElement;
    assert.ok(trail.length >= 2, "trail must have at least Home + self");
    assert.equal(trail[0].name, "Home");
    assert.equal(trail[0].item, SITE_URL, "home crumb = slash-less origin (matches the canonical)");
    // Last crumb must be this page's absolute URL.
    assert.equal(trail[trail.length - 1].item, abs(route), "last crumb must be the self URL");
    trail.forEach((li, i) => {
      assert.equal(li.position, i + 1, "positions must be 1-based sequential");
      assert.ok(li.item.startsWith(SITE_URL), "each crumb item must be absolute");
    });
    // The page-type schema is present.
    assert.equal(ofType(objs, pageType).length, 1, `${route} must emit exactly one ${pageType}`);
  });
}

// =====================================================================================
// (4) @id references resolve to the sitewide Organization / WebSite nodes
// =====================================================================================
test("schema: about + article reference the ONE sitewide Organization node by @id", () => {
  const orgId = abs("/#organization");

  const about = parsedBlocks(collectLdJson(loadRoute("about", "page.tsx").default()));
  const aboutPage = ofType(about, "AboutPage")[0];
  assert.equal(aboutPage.mainEntity["@id"], orgId, "AboutPage.mainEntity must @id the org node");

  const article = parsedBlocks(
    collectLdJson(loadRoute("resources", "how-seafarer-certificate-verification-works", "page.tsx").default())
  );
  const art = ofType(article, "Article")[0];
  assert.equal(art.author["@id"], orgId, "Article.author must @id the org node (no invented person)");
  assert.equal(art.publisher["@id"], orgId, "Article.publisher must @id the org node");
});

// =====================================================================================
// (5) FAQ pages carry non-empty, fact-based Q&As (no empty answers)
// =====================================================================================
for (const [route, segs] of [
  ["/registries/azerbaijan", ["registries", "azerbaijan", "page.tsx"]],
  ["/registries/ukraine", ["registries", "ukraine", "page.tsx"]],
]) {
  test(`schema: ${route} FAQPage has non-empty questions and answers`, () => {
    const faq = ofType(parsedBlocks(collectLdJson(loadRoute(...segs).default())), "FAQPage")[0];
    assert.ok(faq.mainEntity.length >= 4, `${route} FAQ must have at least four Q&As`);
    for (const q of faq.mainEntity) {
      assert.equal(q["@type"], "Question");
      assert.ok(q.name.trim().length > 0);
      assert.equal(q.acceptedAnswer["@type"], "Answer");
      assert.ok(q.acceptedAnswer.text.trim().length > 10);
    }
  });
}

// =====================================================================================
// (6) Hub-and-spoke internal linking — each new page links the money pages
// =====================================================================================
test("links: every new page links /overview/agencies, /pricing and /verify (descriptive anchors)", () => {
  for (const [route, segs] of NEW_PAGES) {
    const src = fs.readFileSync(routeFile(...segs), "utf8");
    for (const target of ['href="/overview/agencies"', 'href="/pricing"', 'href="/verify"']) {
      assert.ok(src.includes(target), `${route} must link ${target}`);
    }
  }
});

test("links: the registry hub links both spokes + /verify", () => {
  const src = fs.readFileSync(routeFile("registries", "page.tsx"), "utf8");
  for (const target of ['href="/registries/azerbaijan"', 'href="/registries/ukraine"', 'href="/verify"']) {
    assert.ok(src.includes(target), `hub must link ${target}`);
  }
});

test("links: each registry spoke links back to the hub + the guide", () => {
  for (const seg of ["azerbaijan", "ukraine"]) {
    const src = fs.readFileSync(routeFile("registries", seg, "page.tsx"), "utf8");
    assert.ok(src.includes('href="/registries"'), `${seg} must link back to the hub`);
    assert.ok(
      src.includes('href="/resources/how-seafarer-certificate-verification-works"'),
      `${seg} must link the guide`
    );
  }
});

// =====================================================================================
// (7) Footer wiring — the layout's Resources group links the three content hubs
// =====================================================================================
test("footer: the root layout links /about, /registries and /resources", () => {
  const src = fs.readFileSync(routeFile("layout.tsx"), "utf8");
  for (const target of ['href="/about"', 'href="/registries"', 'href="/resources"']) {
    assert.ok(src.includes(target), `footer must link ${target}`);
  }
});
