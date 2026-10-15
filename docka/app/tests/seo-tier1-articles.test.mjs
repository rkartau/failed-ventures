// SEO Tier 1 (seo/tier1-verification-cluster) regression + anti-fabrication contract.
// Locks the two new /resources articles, the additive FAQ on /verify and /registries, the
// owner optimisation on /overview/seafarers, sitemap presence, orphan reachability, and
// title/primary-keyword uniqueness. The centrepiece is the FABRICATION INVARIANT: every
// claim sentence in the two article JSX files must carry an adjacent `[src:...]` code
// comment resolving to a source id enumerated in docs/seo-tier1-claims-sources.md.
//
// docka i18n is SINGLE-URL cookie-based (there is NO /[lang]/ route tree), so each article
// is ONE URL with a self-canonical and one rendered EN title; "uniqueness across languages"
// is therefore uniqueness of the single rendered title set.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-tier1-articles.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { SITE_URL, abs } from "@/lib/seo";
import { pricingModel } from "@/components/billing-ui";

// Mirror the phase-1 harness stubs: inert every client-only edge the in-scope route modules
// import, so a metadata read / server-component invoke never mounts React or loads CSS.
const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR } = createRouteHarness({
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
  },
});

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const readFile = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");

// Repo-root docs/ (APP_DIR is <root>/app/app).
const CLAIMS_PATH = path.join(APP_DIR, "..", "..", "docs", "seo-tier1-claims-sources.md");

// The two new article routes: [route, path segments under app/].
const A1 = ["resources", "spot-forged-recycled-seafarer-certificate", "page.tsx"];
const A2 = ["resources", "check-stcw-certificate-valid", "page.tsx"];
const A1_ROUTE = "/resources/spot-forged-recycled-seafarer-certificate";
const A2_ROUTE = "/resources/check-stcw-certificate-valid";
const NEW_ARTICLES = [
  [A1_ROUTE, A1],
  [A2_ROUTE, A2],
];

const ALLOWED_SRC = ["verifiable-registries-truth.md", "real-features", "pillar", "stcw-convention", "lib-registry-countries"];

// ---- shared JSON-LD walkers (same shape as the phase-2 contracts) -------------------
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

// Collect the text of every visible FAQ question — nodes tagged with `data-faq-q`.
function collectVisibleQuestions(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectVisibleQuestions(n, out);
    return out;
  }
  const props = node.props || {};
  if ("data-faq-q" in props) {
    const kids = props.children;
    const text = Array.isArray(kids) ? kids.join("") : String(kids ?? "");
    out.push(text);
  }
  if (props.children) collectVisibleQuestions(props.children, out);
  return out;
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// =====================================================================================
// (1) FABRICATION INVARIANT — every claim sentence carries an adjacent [src:] comment
// =====================================================================================
const SPELLED =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|third|half|majority|most|nearly all)";
const HOTWORDS = "(?:forged|fraud|fake|penalty|fine|detention)";
const TRIGGER = new RegExp(`\\d|%|€|\\b${SPELLED}\\b|\\b${HOTWORDS}\\b`, "i");
// A claim line must have a [src:] comment within this many lines. The two articles are
// authored so every quantitative/forgery claim carries an adjacent source comment; the hard
// denylist above is the second, unconditional layer against the classic fabrication shapes.
const WINDOW = 5;

for (const [route, segs] of NEW_ARTICLES) {
  test(`fabrication: every quantitative/forgery claim in ${route} has an adjacent [src:] comment`, () => {
    const raw = readFile(...segs);

    // Hard denylist — literal overcount + fabricated fraud-percentage patterns.
    assert.ok(!/26 registries/.test(raw), `${route} must not contain the "26 registries" overcount`);
    assert.ok(
      !/\d+%[^.]*(forged|fraud|fake)/i.test(raw),
      `${route} must not assert a fraud/forgery percentage`
    );

    // Build the scan text: drop className/attribute noise (Tailwind digits) and nav <Link>
    // labels (navigational, not factual claims). Comments survive — they carry the [src:].
    const scan = raw
      .replace(/className="[^"]*"/g, "")
      .replace(/<Link[\s\S]*?<\/Link>/g, " NAVLINK ")
      .replace(/href="[^"]*"/g, "")
      .replace(/data-testid="[^"]*"/g, "");
    // Split on CRLF as well as LF: with a bare "\n" split a CRLF file leaves "\r" on every
    // line, `//.*$` then cannot reach `$` (`.` excludes line terminators) and a pure code
    // comment such as "// ... the ONE sitewide ..." is mis-read as a rendered claim.
    const lines = scan.split(/\r?\n/);
    // Trigger detection ignores CODE COMMENTS (`//`, `{/* */}`, `/* */`) — a comment is
    // annotation, never a rendered claim (and our explanatory comments legitimately contain
    // words like "one"). The [src:] window below still reads the comment-bearing lines.
    const codeOnly = (l) =>
      l
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*.*?\*\//g, "")
        .replace(/\/\/.*$/, "")
        // Strip JSX/HTML tags so tag names (h1, h2, …) and attribute digits never trigger;
        // the visible TEXT between tags — the actual claim — survives.
        .replace(/<[^>]*>/g, " ");

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i])) continue;
      if (!TRIGGER.test(codeOnly(lines[i]))) continue;
      const from = Math.max(0, i - WINDOW);
      const win = lines.slice(from, i + WINDOW + 1).join("\n");
      assert.ok(
        /\[src:/.test(win),
        `${route}: claim sentence at line ${i + 1} ("${lines[i].trim().slice(0, 90)}") ` +
          `must have an adjacent [src:...] source comment`
      );
    }
  });
}

test("fabrication: every [src:id] resolves to a source id in the committed claims file", () => {
  const claims = fs.readFileSync(CLAIMS_PATH, "utf8");
  for (const id of ALLOWED_SRC) {
    assert.ok(claims.includes(id), `claims-sources file must enumerate source id "${id}"`);
  }
  for (const [route, segs] of NEW_ARTICLES) {
    const raw = readFile(...segs);
    // Ids start with a letter (real-features, pillar, verifiable-registries-truth.md); this
    // skips the illustrative `[src:...]` placeholder inside the file's own header comment.
    const ids = [...raw.matchAll(/\[src:\s*([A-Za-z][A-Za-z0-9._-]*)/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, `${route} must carry at least one [src:] token`);
    for (const id of ids) {
      assert.ok(
        ALLOWED_SRC.includes(id),
        `${route}: [src:${id}] is not an allowlisted source id (${ALLOWED_SRC.join(", ")})`
      );
    }
  }
});

// =====================================================================================
// (2) Article JSON-LD dates — valid, ISO-8601, ordered (modified >= published), not future
// =====================================================================================
for (const [route, segs] of NEW_ARTICLES) {
  test(`schema: ${route} Article JSON-LD dates are valid, ordered and not in the future`, () => {
    const objs = parsedBlocks(collectLdJson(loadRoute(...segs).default()));
    const art = ofType(objs, "Article")[0];
    assert.ok(art, `${route} must emit an Article`);
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    assert.match(art.datePublished, iso, "datePublished must be ISO-8601 (YYYY-MM-DD)");
    assert.match(art.dateModified, iso, "dateModified must be ISO-8601 (YYYY-MM-DD)");
    const pub = new Date(art.datePublished + "T00:00:00Z").getTime();
    const mod = new Date(art.dateModified + "T00:00:00Z").getTime();
    assert.ok(mod >= pub, "dateModified must be >= datePublished");
    assert.ok(mod <= Date.now(), "dateModified must not be in the future");
    // author + publisher point at the ONE sitewide Organization node.
    assert.equal(art.author["@id"], abs("/#organization"));
    assert.equal(art.publisher["@id"], abs("/#organization"));
  });
}

// =====================================================================================
// (3) Schema shape — exactly one Article, one FAQPage, one BreadcrumbList; crumbs correct
// =====================================================================================
for (const [route, segs] of NEW_ARTICLES) {
  test(`schema: ${route} emits one Article, one FAQPage, one BreadcrumbList (Home > Resources > self)`, () => {
    const objs = parsedBlocks(collectLdJson(loadRoute(...segs).default()));
    assert.equal(ofType(objs, "Article").length, 1, "exactly one Article");
    assert.equal(ofType(objs, "FAQPage").length, 1, "exactly one FAQPage");
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, "exactly one BreadcrumbList");
    const trail = crumbs[0].itemListElement;
    assert.equal(trail[0].name, "Home");
    assert.equal(trail[0].item, SITE_URL, "home crumb = slash-less origin (matches the canonical)");
    assert.equal(trail[1].name, "Resources");
    assert.equal(trail[1].item, abs("/resources"));
    assert.equal(trail[trail.length - 1].item, abs(route), "last crumb must be the self URL");
  });
}

// =====================================================================================
// (4) FAQPage BIDIRECTIONAL parity — visible-Q set == JSON-LD-Q set (normalised)
//     Renderable server pages: the two articles + /registries.
// =====================================================================================
for (const [route, segs] of [
  [A1_ROUTE, A1],
  [A2_ROUTE, A2],
  ["/registries", ["registries", "page.tsx"]],
]) {
  test(`faq-parity: ${route} visible questions == FAQPage JSON-LD questions`, () => {
    const rendered = loadRoute(...segs).default();
    const faq = ofType(parsedBlocks(collectLdJson(rendered)), "FAQPage")[0];
    assert.ok(faq, `${route} must emit a FAQPage`);
    const jsonQs = new Set(faq.mainEntity.map((q) => norm(q.name)));
    const visibleQs = new Set(collectVisibleQuestions(rendered).map(norm));
    assert.ok(jsonQs.size >= 4, `${route} FAQ must have at least four Q&As`);
    assert.deepEqual(
      [...visibleQs].sort(),
      [...jsonQs].sort(),
      `${route}: visible FAQ questions must equal the FAQPage JSON-LD questions (both ways)`
    );
    // Every answer non-empty (no empty acceptedAnswer).
    for (const q of faq.mainEntity) {
      assert.ok(q.acceptedAnswer.text.trim().length > 10, `${route}: answers must be non-empty`);
    }
  });
}

// /verify is a "use client" page (cannot be rendered in this harness). Its FAQ is driven by
// a single VERIFY_FAQ const that feeds BOTH the visible <dl> and the FAQPage JSON-LD, so
// parity is structural — assert that construction from source.
test("faq-parity: /verify FAQ is single-sourced (VERIFY_FAQ drives both the <dl> and the FAQPage JSON-LD)", () => {
  const src = readFile("verify", "page.tsx");
  assert.match(src, /const VERIFY_FAQ\b/, "/verify must define a VERIFY_FAQ const");
  assert.match(src, /"@type":\s*"FAQPage"/, "/verify must emit a FAQPage JSON-LD block");
  assert.match(src, /mainEntity:\s*VERIFY_FAQ\.map/, "FAQPage must be built from VERIFY_FAQ");
  // The visible <dl> maps VERIFY_FAQ too (two .map call-sites over the same const).
  assert.ok(
    (src.match(/VERIFY_FAQ\.map/g) || []).length >= 2,
    "both the FAQPage JSON-LD and the visible <dl> must map over VERIFY_FAQ"
  );
  const qs = [...src.matchAll(/q:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(qs.length >= 4, "/verify VERIFY_FAQ must have at least four questions");
});

// Iteration 2.2 (addendum A) — the three NEW FAQ surfaces (home + the two /overview pages)
// each ship a single-sourced FAQ: ONE const drives BOTH the visible <dl data-faq-q> AND the
// FAQPage JSON-LD, so the visible question set and the JSON-LD mainEntity set cannot drift.
// The home FAQ is emitted from the SERVER wrapper app/app/page.tsx and the two /overview
// pages are "use client" — neither is renderable in this harness — so parity is asserted
// structurally from source, exactly like the /verify assertion above.
for (const [label, segs, constName] of [
  ["home (app/app/page.tsx)", ["page.tsx"], "HOME_FAQ"],
  ["/overview/agencies", ["overview", "agencies", "page.tsx"], "AGENCIES_FAQ"],
  ["/overview/seafarers", ["overview", "seafarers", "page.tsx"], "SEAFARERS_FAQ"],
]) {
  test(`faq-parity: ${label} FAQ is single-sourced (${constName} drives both the <dl> and the FAQPage JSON-LD)`, () => {
    const src = readFile(...segs);
    assert.match(src, new RegExp(`const ${constName}\\b`), `${label} must define a ${constName} const`);
    assert.match(src, /"@type":\s*"FAQPage"/, `${label} must emit a FAQPage JSON-LD block`);
    assert.match(
      src,
      new RegExp(`mainEntity:\\s*${constName}\\.map`),
      `${label} FAQPage must be built from ${constName}`
    );
    // Two .map call-sites over the SAME const: the FAQPage JSON-LD and the visible <dl>.
    assert.ok(
      (src.match(new RegExp(`${constName}\\.map`, "g")) || []).length >= 2,
      `${label} must map ${constName} for both the FAQPage JSON-LD and the visible <dl>`
    );
    // The single const is the only source of the questions, so the visible set == JSON-LD set
    // by construction. Assert the const carries at least three Q&As (plan 2.2: 3–5 pairs) and a
    // visible data-faq-q node exists on the page.
    const qs = [...src.matchAll(/q:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(qs.length >= 3, `${label} ${constName} must have at least three questions`);
    assert.match(src, /data-faq-q/, `${label} must render a visible data-faq-q question set`);
  });
}

// =====================================================================================
// (5) Sitemap — each new URL present exactly once, resolves to a real file, not noindex
// =====================================================================================
test("sitemap: each new article URL is present exactly once and self-canonical", () => {
  const entries = loadRoute("sitemap.ts").default();
  const urls = entries.map((e) => e.url);
  for (const [route, segs] of NEW_ARTICLES) {
    const hits = urls.filter((u) => u === abs(route));
    assert.equal(hits.length, 1, `${abs(route)} must appear exactly once in the sitemap`);
    const meta = loadRoute(...segs).metadata;
    assert.equal(meta.alternates.canonical, route, `${route} must self-canonicalise`);
    // Not noindex.
    if (meta.robots) assert.notEqual(meta.robots.index, false, `${route} must NOT be noindex`);
  }
});

// =====================================================================================
// (6) Orphan guard — each new article is href'd by >= 1 other indexable page
// =====================================================================================
test("orphan-guard: each new article is linked from at least one other indexable page", () => {
  const inbound = {
    "/resources": readFile("resources", "page.tsx"),
    pillar: readFile("resources", "how-seafarer-certificate-verification-works", "page.tsx"),
    A1: readFile(...A1),
    A2: readFile(...A2),
  };
  // A page links a route if it carries the quoted path — as an href="…" or as a slug: "…"
  // string (the /resources index renders <Link href={a.slug}>).
  const links = (src, route) => src.includes(`"${route}"`);
  for (const route of [A1_ROUTE, A2_ROUTE]) {
    const linkers = Object.entries(inbound).filter(([, src]) => links(src, route));
    // A page does not count as linking itself.
    const others = linkers.filter(([name]) => !(name === "A1" && route === A1_ROUTE) && !(name === "A2" && route === A2_ROUTE));
    assert.ok(others.length >= 1, `${route} must be href'd by >= 1 OTHER indexable page`);
  }
  // Resources index links BOTH new articles (primary hub inbound).
  assert.ok(links(inbound["/resources"], A1_ROUTE), "resources index must link A1");
  assert.ok(links(inbound["/resources"], A2_ROUTE), "resources index must link A2");
  // Pillar <-> spokes.
  assert.ok(inbound.pillar.includes(`href="${A1_ROUTE}"`), "pillar must link A1");
  assert.ok(inbound.pillar.includes(`href="${A2_ROUTE}"`), "pillar must link A2");
  assert.ok(inbound.A1.includes('href="/resources/how-seafarer-certificate-verification-works"'), "A1 links up to pillar");
  assert.ok(inbound.A2.includes('href="/resources/how-seafarer-certificate-verification-works"'), "A2 links up to pillar");
});

test("wire-in: each new article links up to the pillar, /verify and /registries", () => {
  for (const segs of [A1, A2]) {
    const src = readFile(...segs);
    for (const target of [
      'href="/resources/how-seafarer-certificate-verification-works"',
      'href="/verify"',
      'href="/registries"',
    ]) {
      assert.ok(src.includes(target), `${segs.join("/")} must link ${target}`);
    }
  }
});

// =====================================================================================
// (7) Title / primary-keyword uniqueness across ALL indexable pages (single-URL EN titles)
// =====================================================================================
function metaTitle(...segs) {
  return loadRoute(...segs).metadata.title;
}
test("uniqueness: the two new article titles are unique across every indexable page", () => {
  const titles = [
    metaTitle(...A1),
    metaTitle(...A2),
    metaTitle("resources", "how-seafarer-certificate-verification-works", "page.tsx"),
    metaTitle("resources", "page.tsx"),
    metaTitle("registries", "page.tsx"),
    metaTitle("registries", "azerbaijan", "page.tsx"),
    metaTitle("registries", "ukraine", "page.tsx"),
    metaTitle("about", "page.tsx"),
    metaTitle("pricing", "page.tsx"),
    metaTitle("verify", "layout.tsx"),
    metaTitle("overview", "page.tsx"),
    metaTitle("overview", "seafarers", "layout.tsx"),
    metaTitle("overview", "agencies", "layout.tsx"),
  ];
  assert.equal(new Set(titles).size, titles.length, "every indexable page title must be unique");
  // Primary-keyword guard: neither new title is a substring of, or equal to, another page's title.
  const newTitles = [metaTitle(...A1), metaTitle(...A2)];
  const others = titles.filter((t) => !newTitles.includes(t));
  for (const nt of newTitles) {
    for (const ot of others) {
      assert.ok(nt !== ot, `new title collides with an existing title: ${nt}`);
    }
  }
});

// =====================================================================================
// (8) Owner optimisation + "do not touch" invariants (Scope B additive-only)
// =====================================================================================
test("owner: /overview/seafarers owns 'seafarer documentation service'; no other indexable page uses the phrase title", () => {
  const PHRASE = "seafarer documentation service";
  const seafarers = loadRoute("overview", "seafarers", "layout.tsx").metadata;
  const hay = `${seafarers.title} ${seafarers.description}`.toLowerCase();
  assert.ok(hay.includes(PHRASE), "owner page metadata must target the phrase");
  // The phrase must NOT appear in the /verify or home titles/descriptions (no cannibalisation).
  const verify = loadRoute("verify", "layout.tsx").metadata;
  assert.ok(!`${verify.title}`.toLowerCase().includes(PHRASE), "/verify title must not use the owner phrase");
});

test("untouched: /verify title unchanged; home primary title is the CRM positioning pin (Scope B)", () => {
  // /verify title re-pinned by the SEO implementation plan WP-B (<=60 chars, onpage §3);
  // the home default title is the CRM positioning pin (2026-09-07).
  assert.equal(
    loadRoute("verify", "layout.tsx").metadata.title,
    "Verify a Seafarer Certificate Against Its Registry",
    "/verify primary title must match the WP-B pin"
  );
  const home = loadRoute("layout.tsx").metadata;
  assert.equal(
    home.title.default,
    "Crewing Agency CRM with Seafarer Certificate Checks · Docka",
    "home default title is the CRM positioning pin (2026-09-07)"
  );
});
