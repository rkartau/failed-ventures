// SEO implementation plan — WP-D (content pages: /about, /registries, /registries/ukraine,
// /registries/azerbaijan, /resources, the three original guides, the trust-ladder unification
// and the registry-derived source tables) regression + anti-fabrication contract.
//
// What it locks:
//   (1) the duplicated "How we verify / Trust levels at a glance / Primary sources" appendix is
//       gone from the three guides, and with it the hand-typed wrong-host authority links
//       (https://marad.gov.ua, https://www.dms.gov.cy, https://www.ardda.gov.az): none of those
//       URLs appears anywhere under app/, components/ or lib/ except the registry table itself;
//   (2) the trust ladder is ONE projection: TRUST_LADDER == plainPunct(LEVEL_META) and
//       components/LevelTable.tsx renders it (L1 = Reviewed by staff, never "Self-added");
//   (3) the how-works guide carries the canonical <LevelTable /> and a single-sourced FAQPage;
//   (4) /registries renders a <table> from the public registry projection and an ItemList of
//       eight distinct per-registry URLs referenced by the CollectionPage;
//   (5) every guide links at least one outbound primary source (IMO / gov.uk / MoU / a portalUrl);
//   (6) metadata descriptions <= 160 chars, no typographic dashes/quotes, style-guide clean
//       rendered text, Article/WebPage @id graph intact, byline + boxed CTA present;
//   (7) Ukraine/Azerbaijan: WebPage.about is the GovernmentOrganization from the public row,
//       the portal link is the row's portalUrl, the "Not found?" block quotes no duration.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-content-d.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { expand, render, walk, collectLdJson, ofType, textOf, collectVisibleQuestions } from "./_render-text.mjs";
import { STYLE_HARD, STYLE_TOLERATED } from "./_style-gate.mjs";
import { SITE_URL, abs, plainPunct } from "@/lib/seo";
import { LEVEL_META, TRUST_LADDER } from "@/lib/verification-level";
import { REGISTRY_PAGE_SLUGS, REGISTRY_PUBLIC_ROWS, registryRow } from "@/lib/registry/public-rows";

// ---- harness ------------------------------------------------------------------------
// Link renders as a real <a> so anchor hrefs survive into the rendered tree; other client-only
// edges are inert (same shape as the phase-2 / WP-E harness stubs).
const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR, APP } = createRouteHarness({
  stubs: {
    // `__esModule: true` so TS's `__importDefault` hands the page the function itself (without
    // it the default import resolves to the wrapper object and <Link> never becomes an <a>).
    "next/link": { __esModule: true, default: (props) => ({ type: "a", props }) },
    "next/script": { default: () => null },
    "@/components/SiteNav": inert,
    "@/components/Logo": inert,
  },
});
const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const readFile = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");
const REPO_ROOT = path.resolve(APP, "..");
const STYLE_GUIDE_PATH = path.join(REPO_ROOT, "docs", "WRITING-STYLE-GUIDE.md");

// `collectHrefs` stays local: this suite wants the bare href strings, while the shared
// _render-text.mjs variant (which seo-new-pages-e consumes) returns { href, rel, target }.
function collectHrefs(tree) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === "a" && typeof n.props?.href === "string") out.push(n.props.href);
  });
  return out;
}
function collectByType(tree, type) {
  const out = [];
  walk(tree, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
}
function byTestId(tree, id) {
  let found = null;
  walk(tree, (n) => {
    if (!found && n.props?.["data-testid"] === id) found = n;
  });
  return found;
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const words = (text) => text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];

// ---- the pages this WP owns -----------------------------------------------------------
const HOW_WORKS = "/resources/how-seafarer-certificate-verification-works";
const CHECK_STCW = "/resources/check-stcw-certificate-valid";
const SPOT_FORGED = "/resources/spot-forged-recycled-seafarer-certificate";
const GUIDES = [
  [HOW_WORKS, ["resources", "how-seafarer-certificate-verification-works", "page.tsx"]],
  [CHECK_STCW, ["resources", "check-stcw-certificate-valid", "page.tsx"]],
  [SPOT_FORGED, ["resources", "spot-forged-recycled-seafarer-certificate", "page.tsx"]],
];
const D_PAGES = [
  ...GUIDES,
  ["/about", ["about", "page.tsx"]],
  ["/registries", ["registries", "page.tsx"]],
  ["/registries/ukraine", ["registries", "ukraine", "page.tsx"]],
  ["/registries/azerbaijan", ["registries", "azerbaijan", "page.tsx"]],
  ["/resources", ["resources", "page.tsx"]],
];
const NEW_REGISTRY_PATHS = ["estonia", "denmark", "cyprus", "united-kingdom", "norway", "france"].map((s) => `/registries/${s}`);
const NEW_GUIDES = [
  "/resources/stcw-certificate-types",
  "/resources/required-stcw-documents-by-rank",
  "/resources/port-state-control-crew-certificate-deficiencies",
  "/resources/stcw-revalidation-every-5-years",
];

// =====================================================================================
// (1) The duplicated appendix and the wrong-host authority links are gone
// =====================================================================================
test("appendix: no 'Trust levels at a glance' / 'Primary sources we check against' / 'How we verify' block in the three guides", () => {
  for (const [route, segs] of GUIDES) {
    const src = readFile(...segs);
    for (const needle of ["Trust levels at a glance", "Primary sources we check against", "How we verify, step by step", ">How we verify<"]) {
      assert.ok(!src.includes(needle), `${route} still carries "${needle}"`);
    }
    // The ladder is rendered from the projection, never re-typed.
    assert.match(src, /TRUST_LADDER|<LevelTable \/>/, `${route} must render the ladder from TRUST_LADDER / LevelTable`);
    assert.ok(!/Self-added/.test(src), `${route} must not carry the wrong L1 wording "Self-added"`);
  }
});

const BAD_HOST_URLS = ["https://marad.gov.ua", "https://www.dms.gov.cy", "https://www.ardda.gov.az"];
function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkFiles(p, out);
    } else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}
test("bad hosts: the three wrong authority URLs appear nowhere under app/, components/ or lib/ except lib/registry/countries.ts", () => {
  const files = [APP_DIR, path.join(APP, "components"), path.join(APP, "lib")].flatMap((d) => walkFiles(d));
  assert.ok(files.length > 50, "expected a healthy file count");
  const offenders = [];
  for (const f of files) {
    if (f.endsWith(path.join("lib", "registry", "countries.ts"))) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const u of BAD_HOST_URLS) if (src.includes(u)) offenders.push(`${path.relative(APP, f)}: ${u}`);
  }
  assert.deepEqual(offenders, [], `wrong-host authority URLs still present:\n${offenders.join("\n")}`);
  // And every rendered outbound authority href on the D pages is a portalUrl or a primary document host.
  const portalUrls = new Set(REGISTRY_PUBLIC_ROWS.map((r) => r.portalUrl));
  for (const [route, segs] of D_PAGES) {
    const external = collectHrefs(render(loadRoute(...segs))).filter((h) => /^https?:\/\//.test(h));
    for (const h of external) {
      assert.ok(
        portalUrls.has(h) || /^https:\/\/(www\.)?(imo\.org|gov\.uk|parismou\.org|tokyo-mou\.org)\//.test(h),
        `${route} links an outbound URL that is neither a registry portalUrl nor a primary document: ${h}`
      );
    }
  }
});

// =====================================================================================
// (2) ONE trust ladder: TRUST_LADDER == plainPunct(LEVEL_META); LevelTable renders it
// =====================================================================================
test("trust ladder: TRUST_LADDER is the plainPunct'd projection of LEVEL_META (codes, names, meanings)", () => {
  assert.equal(TRUST_LADDER.length, 4);
  for (const n of [0, 1, 2, 3]) {
    assert.equal(TRUST_LADDER[n].code, LEVEL_META[n].code);
    assert.equal(TRUST_LADDER[n].name, plainPunct(LEVEL_META[n].word));
    assert.equal(TRUST_LADDER[n].short, plainPunct(LEVEL_META[n].short));
    assert.equal(TRUST_LADDER[n].meaning, plainPunct(LEVEL_META[n].tip));
    assert.doesNotMatch(JSON.stringify(TRUST_LADDER[n]), /[—–“”‘’]/, "ladder strings are plainPunct-clean");
  }
  assert.match(TRUST_LADDER[1].name, /staff/i, "L1 is the staff-review level per LEVEL_META");
  assert.ok(!TRUST_LADDER.some((r) => /Self-added/.test(r.name)), "no 'Self-added' anywhere in the ladder");
});

test("trust ladder: components/LevelTable.tsx renders 4 rows from TRUST_LADDER and its L1 row names staff review", () => {
  const src = fs.readFileSync(path.join(APP, "components", "LevelTable.tsx"), "utf8");
  assert.match(src, /TRUST_LADDER/, "LevelTable must render from TRUST_LADDER");
  assert.ok(!/\["L0"|\["L1"|Self-added/.test(src), "LevelTable must not carry a re-typed ladder");
  const tree = expand({ type: loadTs(path.join(APP, "components", "LevelTable.tsx")).LevelTable, props: {} });
  const rows = collectByType(tree, "tr").filter((tr) => tr.props?.["data-level"]);
  assert.equal(rows.length, 4, "four ladder rows");
  const l1 = rows.find((tr) => tr.props["data-level"] === "L1");
  assert.ok(l1, "L1 row present");
  assert.match(textOf(l1), /staff/i, "L1 row text must name staff review");
  for (const row of TRUST_LADDER) assert.ok(textOf(tree).includes(row.name), `LevelTable renders ${row.name}`);
});

test("trust ladder: /about carries no inline LevelTable; the canonical table renders on the how-works guide", () => {
  const about = readFile("about", "page.tsx");
  assert.ok(!/function LevelTable/.test(about), "/about must not define an inline LevelTable");
  assert.ok(!/<LevelTable/.test(about), "/about carries a 2-line summary + links, not the table");
  assert.match(about, new RegExp(`href="${HOW_WORKS}"`), "/about links the how-works guide (canonical ladder)");
  assert.match(about, /href="\/registries"/, "/about links the registry coverage page");
  const howWorks = render(loadRoute(...GUIDES[0][1]));
  const table = byTestId(howWorks, "level-table");
  assert.ok(table, "how-works must render <LevelTable /> (data-testid level-table)");
  assert.equal(collectByType(table, "tr").filter((tr) => tr.props?.["data-level"]).length, 4);
  // Every D page that mentions L1 uses the LEVEL_META wording.
  for (const [route, segs] of D_PAGES) {
    const text = textOf(render(loadRoute(...segs)));
    assert.ok(!/Self-added/.test(text), `${route} rendered text must not say "Self-added"`);
  }
});

// =====================================================================================
// (3) Schema: Article @id graph on the three guides; how-works FAQPage parity
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`schema: ${route} Article has @id, isPartOf, inLanguage and a breadcrumb @id that resolves`, () => {
    const objs = collectLdJson(render(loadRoute(...segs)));
    const art = ofType(objs, "Article");
    assert.equal(art.length, 1, "exactly one Article");
    assert.equal(art[0]["@id"], `${abs(route)}#article`);
    assert.equal(art[0].inLanguage, "en");
    assert.deepEqual(art[0].isPartOf, { "@id": abs("/#website") });
    assert.equal(art[0].author["@id"], abs("/#organization"), "author stays the Organization @id");
    assert.equal(art[0].mainEntityOfPage["@id"], abs(route));
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, "exactly one BreadcrumbList");
    assert.equal(crumbs[0]["@id"], `${abs(route)}#breadcrumb`);
    assert.equal(art[0].mainEntityOfPage.breadcrumb["@id"], crumbs[0]["@id"], "mainEntityOfPage.breadcrumb must reference the page's BreadcrumbList");
    assert.equal(crumbs[0].itemListElement[0].item, SITE_URL);
    assert.equal(crumbs[0].itemListElement.at(-1).item, abs(route));
    assert.match(art[0].datePublished, /^\d{4}-\d{2}-\d{2}$/, "date-only");
    assert.match(art[0].dateModified, /^\d{4}-\d{2}-\d{2}$/, "date-only");
  });
}

test(`faq-parity: ${HOW_WORKS} renders exactly one FAQPage (>= 4 questions) whose visible set equals the JSON-LD set`, () => {
  const tree = render(loadRoute(...GUIDES[0][1]));
  const faqs = ofType(collectLdJson(tree), "FAQPage");
  assert.equal(faqs.length, 1, "exactly one FAQPage");
  const jsonQs = new Set(faqs[0].mainEntity.map((q) => norm(q.name)));
  const visibleQs = new Set(collectVisibleQuestions(tree).map(norm));
  assert.ok(jsonQs.size >= 4, "at least four Q&As");
  assert.deepEqual([...visibleQs].sort(), [...jsonQs].sort(), "visible questions == FAQPage questions");
  for (const q of faqs[0].mainEntity) assert.ok(q.acceptedAnswer.text.trim().length > 10);
  const src = readFile(...GUIDES[0][1]);
  assert.match(src, /const FAQ\b/, "how-works must define a FAQ const");
  assert.match(src, /mainEntity:\s*FAQ\.map/, "FAQPage built from the FAQ const");
});

test(`faq: ${CHECK_STCW} carries the two seafarer PAA questions and a reworded pricing answer`, () => {
  const tree = render(loadRoute(...GUIDES[1][1]));
  const qs = collectVisibleQuestions(tree).map(norm);
  assert.ok(qs.includes(norm("Is my STCW certificate still valid?")));
  assert.ok(qs.includes(norm("How long is an STCW certificate valid for?")));
  const faq = ofType(collectLdJson(tree), "FAQPage")[0];
  const pricing = faq.mainEntity.find((q) => /free stcw or coc checker/i.test(q.name));
  assert.ok(pricing, "pricing FAQ present");
  const pricingPage = readFile("pricing", "page.tsx");
  assert.ok(!pricingPage.includes(pricing.acceptedAnswer.text), "pricing FAQ answer must not be verbatim from /pricing");
  const registriesFaq = ofType(collectLdJson(render(loadRoute("registries", "page.tsx"))), "FAQPage")[0];
  const hubPricing = registriesFaq.mainEntity.find((q) => /free seafarer certificate/i.test(q.name));
  assert.ok(hubPricing && !pricingPage.includes(hubPricing.acceptedAnswer.text), "/registries pricing answer must not be verbatim from /pricing");
  // The five-year statements cite stcw-convention (plan R7c).
  const src = readFile(...GUIDES[1][1]);
  assert.match(src, /\[src:stcw-convention:[^\]]*five years/i, "five-year revalidation statements cite [src:stcw-convention]");
  assert.match(src, /If it&apos;s your own certificate/, "the seafarer-first section is present");
  for (const target of ['href="/registries"', 'href="/verify"', 'href="/resources/stcw-revalidation-every-5-years"']) {
    assert.ok(src.includes(target), `check-stcw must link ${target}`);
  }
});

// =====================================================================================
// (4) /registries: a <table> from the projection, ItemList of 8 distinct URLs, Latvia FAQ
// =====================================================================================
test("/registries: renders a <table> from REGISTRY_PUBLIC_ROWS; ItemList @id + 8 distinct per-registry urls; CollectionPage.mainEntity references it", () => {
  const mod = loadRoute("registries", "page.tsx");
  const tree = render(mod);
  const tables = collectByType(tree, "table");
  assert.ok(tables.length >= 1, "at least one <table>");
  const tableText = textOf(byTestId(tree, "registry-table"));
  for (const r of REGISTRY_PUBLIC_ROWS) assert.ok(tableText.includes(r.authority), `table row for ${r.code} (${r.authority})`);
  assert.ok(!/"notes"/.test(readFile("registries", "page.tsx")), "never reads the notes field");

  const objs = collectLdJson(tree);
  const list = ofType(objs, "ItemList");
  assert.equal(list.length, 1, "exactly one ItemList");
  assert.equal(list[0]["@id"], abs("/registries#live-list"));
  const urls = list[0].itemListElement.map((li) => li.url);
  assert.equal(urls.length, 8, "eight live flag states");
  assert.equal(new Set(urls).size, 8, "eight DISTINCT urls");
  const expected = new Set(Object.values(REGISTRY_PAGE_SLUGS).map((slug) => abs(`/registries/${slug}`)));
  assert.deepEqual(new Set(urls), expected, "each item url is its own /registries/<slug> page");
  const cp = ofType(objs, "CollectionPage");
  assert.equal(cp.length, 1, "exactly one CollectionPage");
  assert.deepEqual(cp[0].mainEntity, { "@id": abs("/registries#live-list") });
  assert.equal(cp[0]["@id"], `${abs("/registries")}#webpage`, "built on webPageJsonLd");
  assert.deepEqual(cp[0].breadcrumb, { "@id": `${abs("/registries")}#breadcrumb` });
  const crumbs = ofType(objs, "BreadcrumbList");
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0]["@id"], `${abs("/registries")}#breadcrumb`, "breadcrumbList(trail, '/registries') carries the @id");

  const faq = ofType(objs, "FAQPage")[0];
  assert.ok(faq.mainEntity.some((q) => norm(q.name) === norm("Does Docka support Latvia?")), "Latvia FAQ present");
  const lv = registryRow("LV");
  const lvAnswer = faq.mainEntity.find((q) => /latvia/i.test(q.name)).acceptedAnswer.text;
  assert.ok(lvAnswer.includes(lv.authority), "Latvia answer names the authority from the public row");

  const hrefs = collectHrefs(tree);
  for (const slug of Object.values(REGISTRY_PAGE_SLUGS)) assert.ok(hrefs.includes(`/registries/${slug}`), `links /registries/${slug}`);
  for (const target of ["/what-is-primary-source-verification", "/verify", HOW_WORKS]) assert.ok(hrefs.includes(target), `links ${target}`);
  // The assisted and manual tiers are named from the rows.
  const text = textOf(tree);
  for (const r of REGISTRY_PUBLIC_ROWS.filter((x) => x.capability === "assisted" || x.capability === "manual")) {
    assert.ok(text.includes(r.country), `${r.capability} tier names ${r.country}`);
  }
  // Phase-2c pins still hold in the source.
  const src = readFile("registries", "page.tsx");
  assert.match(src, /eight flag states/i);
  assert.match(src, /Bulgaria/);
  assert.match(src, /<LastUpdated\s*\/>/);
});

// =====================================================================================
// (5) Outbound primary-source links on every guide; byline + boxed CTA + Related guides
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`links: ${route} has >= 1 outbound authority href, the byline, the boxed CTA and Related guides`, () => {
    const tree = render(loadRoute(...segs));
    const hrefs = collectHrefs(tree);
    const portalUrls = new Set(REGISTRY_PUBLIC_ROWS.map((r) => r.portalUrl));
    const outbound = hrefs.filter((h) => portalUrls.has(h) || /^https:\/\/(www\.)?(imo\.org|gov\.uk|parismou\.org|tokyo-mou\.org)\//.test(h));
    assert.ok(outbound.length >= 1, `${route} must link at least one outbound authority (got ${hrefs.filter((h) => /^https?:/.test(h)).join(", ")})`);
    assert.ok(hrefs.some((h) => /imo\.org/.test(h)), `${route} links the IMO STCW page as its primary document`);
    // Outbound anchors carry rel noopener noreferrer.
    walk(tree, (n) => {
      if (n.type === "a" && /^https?:\/\//.test(n.props?.href || "")) {
        assert.match(n.props.rel || "", /noopener/, `${route}: outbound link ${n.props.href} must carry rel=noopener`);
      }
    });
    for (const target of ["/verify", "/registries", HOW_WORKS].filter((t) => t !== route)) {
      assert.ok(hrefs.includes(target), `${route} must link ${target}`);
    }
    const text = textOf(tree);
    assert.match(text, /By the Docka team · Reviewed \d{1,2} [A-Z][a-z]+ \d{4}/, "byline renders");
    assert.ok(byTestId(tree, "byline"), "byline carries data-testid");
    assert.ok(byTestId(tree, "guide-cta"), "boxed CTA present");
    assert.match(textOf(byTestId(tree, "guide-cta")), /Check a certificate now, free/);
    assert.equal(collectHrefs(byTestId(tree, "guide-cta"))[0], "/verify", "CTA points at /verify");
    assert.match(text, /Related guides/);
    assert.ok(!/Next steps/.test(text), "the six-link Next steps box is replaced by the CTA + Related guides");
    // The registry-derived inputs table lives ONLY on the pillar guide (and /registries): it
    // renders every automatic row with its portal link there. The two other guides carry a
    // pointer to it plus at least one portalUrl of their own (content dedupe, 2026-09-07).
    const table = byTestId(tree, "inputs-table");
    if (route === HOW_WORKS) {
      assert.ok(table, `${route} renders the inputs table`);
      const tableHrefs = collectHrefs(table);
      for (const r of REGISTRY_PUBLIC_ROWS.filter((x) => x.capability === "auto" || x.capability === "auto-presence")) {
        assert.ok(tableHrefs.includes(r.portalUrl), `${route} table links ${r.code} portal ${r.portalUrl}`);
        for (const label of r.inputs) assert.ok(textOf(table).includes(label), `${route} table shows input label "${label}"`);
      }
    } else {
      assert.ok(!table, `${route} must not duplicate the pillar's inputs table`);
      assert.ok(!/What each live register asks for/.test(text), `${route} must not carry the pillar's table heading`);
      assert.ok(hrefs.some((h) => portalUrls.has(h)), `${route} still links at least one registry portalUrl`);
    }
    assert.ok(hrefs.includes("/registries/ukraine") && hrefs.includes("/registries/azerbaijan"), "links the Ukraine + Azerbaijan registry pages");
    for (const p of NEW_REGISTRY_PATHS) assert.ok(hrefs.includes(p), `${route} links ${p}`);
  });
}

// =====================================================================================
// (6) Metadata: descriptions <= 160, plain punctuation; titles as pinned
// =====================================================================================
test("metadata: every D page description is <= 160 chars and free of typographic dashes/quotes; titles pinned", () => {
  for (const [route, segs] of D_PAGES) {
    const meta = loadRoute(...segs).metadata;
    assert.equal(typeof meta.title, "string", `${route} title is a plain string`);
    assert.ok(meta.description.length <= 160, `${route} description is ${meta.description.length} chars (max 160)`);
    assert.doesNotMatch(meta.description, /[—–“”‘’]/, `${route} description punctuation`);
    assert.doesNotMatch(meta.title, /[—–“”‘’]/, `${route} title punctuation`);
    assert.equal(meta.alternates.canonical, route, `${route} self-canonical`);
  }
  assert.equal(loadRoute(...GUIDES[2][1]).metadata.title, "Spot a Forged or Recycled Seafarer Certificate");
  assert.equal(loadRoute("about", "page.tsx").metadata.title, "About Docka Development OÜ");
  assert.equal(loadRoute("registries", "page.tsx").metadata.title, "Seafarer Certificate Registries We Verify");
  const titles = D_PAGES.map(([, segs]) => loadRoute(...segs).metadata.title);
  assert.equal(new Set(titles).size, titles.length, "D page titles are unique");
});

test("/about: AboutPage.mainEntity is the bare Organization @id; team paragraph, no /security link, pricing in one line", () => {
  const tree = render(loadRoute("about", "page.tsx"));
  const about = ofType(collectLdJson(tree), "AboutPage")[0];
  assert.deepEqual(about.mainEntity, { "@id": abs("/#organization") });
  assert.equal(about["@id"], `${abs("/about")}#webpage`);
  assert.deepEqual(about.breadcrumb, { "@id": `${abs("/about")}#breadcrumb` });
  const src = readFile("about", "page.tsx");
  assert.ok(!src.includes('href="/security"'), "no /security link (plan S4)");
  const text = textOf(tree);
  assert.match(text, /The Docka team/);
  assert.match(text, /Who we are/);
  assert.match(text, /Security and your data/);
  assert.match(text, /300 EUR \/ month/);
  for (const target of ['href="/verify"', 'href="/overview/agencies"', 'href="/pricing"', "<LastUpdated />"]) assert.ok(src.includes(target), `/about keeps ${target}`);
});

// =====================================================================================
// (7) Ukraine / Azerbaijan: GovernmentOrganization from the row, portal link, DIY, not-found
// =====================================================================================
for (const [route, segs, code, extraCode] of [
  ["/registries/ukraine", ["registries", "ukraine", "page.tsx"], "UA-MARAD", "UA"],
  ["/registries/azerbaijan", ["registries", "azerbaijan", "page.tsx"], "AZ", null],
]) {
  test(`${route}: WebPage.about is the GovernmentOrganization from registryRow("${code}"); portal + DIY steps + not-found block; cross-links`, () => {
    const row = registryRow(code);
    const tree = render(loadRoute(...segs));
    const objs = collectLdJson(tree);
    const web = ofType(objs, "WebPage");
    assert.equal(web.length, 1, "one WebPage node");
    assert.equal(web[0]["@id"], `${abs(route)}#webpage`);
    assert.deepEqual(web[0].about, { "@type": "GovernmentOrganization", name: row.authority, url: row.portalUrl });
    assert.equal(ofType(objs, "FAQPage").length, 1);
    assert.equal(ofType(objs, "BreadcrumbList")[0]["@id"], `${abs(route)}#breadcrumb`);
    // FAQ parity (single array) and >= 4 questions.
    const faq = ofType(objs, "FAQPage")[0];
    assert.deepEqual([...new Set(collectVisibleQuestions(tree).map(norm))].sort(), [...new Set(faq.mainEntity.map((q) => norm(q.name)))].sort());
    assert.ok(faq.mainEntity.length >= 4);

    const hrefs = collectHrefs(tree);
    assert.ok(hrefs.includes(row.portalUrl), `links the ${code} portalUrl ${row.portalUrl}`);
    if (extraCode) assert.ok(hrefs.includes(registryRow(extraCode).portalUrl), `links the ${extraCode} validator portal`);
    const other = route.endsWith("ukraine") ? "/registries/azerbaijan" : "/registries/ukraine";
    assert.ok(hrefs.includes(other), `cross-links ${other}`);
    for (const p of NEW_REGISTRY_PATHS) assert.ok(hrefs.includes(p), `links ${p}`);
    for (const t of ["/verify", "/registries", HOW_WORKS, "/overview/agencies", "/pricing"]) assert.ok(hrefs.includes(t), `links ${t}`);

    const text = textOf(tree);
    assert.match(text, /Do it yourself on the official portal/);
    const steps = collectByType(tree, "ol").map((ol) => collectByType(ol, "li").length);
    assert.ok(steps.includes(3), "the DIY list has exactly three steps");
    for (const label of row.inputs) assert.ok(text.includes(label), `${route} shows input label "${label}"`);
    const nf = byTestId(tree, "not-found-block");
    assert.ok(nf, "Not found? block present");
    assert.doesNotMatch(textOf(nf), /\d+\s*(minute|hour|day|week|month|business)/i, "no duration claim in the not-found block");
    assert.match(textOf(nf), /turnaround/i, "says that no turnaround time is quoted");
    // Ladder: one line + link, no copied table.
    assert.ok(!/<LevelTable|TRUST_LADDER/.test(readFile(...segs)), `${route} carries a one-line ladder pointer, not the table`);
    assert.match(text, /L0 to L3/);
    assert.match(readFile(...segs), /<LastUpdated\s*\/>/);
  });
}

// =====================================================================================
// (8) /resources hub: editorial intro, reviewer block, audience lines, the seven guides
// =====================================================================================
test("/resources: 300-word intro, reviewer block, 'who should read this' per guide, all seven guides in ARTICLES", () => {
  const mod = loadRoute("resources", "page.tsx");
  const tree = render(mod);
  const text = textOf(tree);
  assert.match(text, /Reviewed by the Docka team/);
  assert.ok((text.match(/Who should read this/g) || []).length >= 7, "one audience line per guide");
  const src = readFile("resources", "page.tsx");
  const slugs = [...src.matchAll(/slug:\s*"(\/resources\/[^"]+)"/g)].map((m) => m[1]);
  for (const s of [HOW_WORKS, CHECK_STCW, SPOT_FORGED, ...NEW_GUIDES]) assert.ok(slugs.includes(s), `ARTICLES carries ${s}`);
  const list = ofType(collectLdJson(tree), "ItemList")[0];
  assert.equal(list.itemListElement.length, slugs.length);
  assert.equal(new Set(list.itemListElement.map((i) => i.url)).size, slugs.length, "distinct guide urls");
  // The intro (everything before the first guide card) is at least 300 words. The shared
  // WhatDockaIs positioning strip (components/WhatDockaIs.tsx) is site-wide chrome counted on
  // no page; the word-count gates measure the page's own prose, so they skip it.
  const introText = textOf(tree, true);
  const intro = introText.slice(0, introText.indexOf("Guide 1"));
  assert.ok(words(intro).length >= 300, `intro is ${words(intro).length} words (want >= 300)`);
  for (const target of ['href="/registries"', 'href="/verify"', 'href="/overview/agencies"', 'href="/pricing"', "<LastUpdated />"]) assert.ok(src.includes(target), `/resources keeps ${target}`);
});

// =====================================================================================
// (9) Style guide: rendered text (and metadata) of every D page passes the mechanical scan
// =====================================================================================

test("style-guide: rendered text + metadata + FAQ answers of every D page are free of banned punctuation and vocabulary", () => {
  const failures = [];
  for (const [route, segs] of D_PAGES) {
    const mod = loadRoute(...segs);
    const tree = render(mod);
    const faqs = ofType(collectLdJson(tree), "FAQPage");
    const answers = faqs.flatMap((f) => f.mainEntity.map((q) => `${q.name} ${q.acceptedAnswer.text}`)).join("\n");
    const text = `${mod.metadata.title} ${mod.metadata.description} ${textOf(tree)}\n${answers}`;
    for (const [re, label] of STYLE_HARD) {
      const hits = text.match(re);
      if (hits) failures.push(`${route}: ${label}: ${[...new Set(hits)].join(", ")}`);
    }
    for (const re of STYLE_TOLERATED) {
      const hits = text.match(re) || [];
      if (hits.length > 1) failures.push(`${route}: tolerated phrase used more than once: ${hits[0]} (${hits.length})`);
    }
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) failures.push(`${route}: emoji`);
    if (/[$€]/.test(textOf(tree))) failures.push(`${route}: $ or € glyph in body text`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("style-guide: the regex list in this test still matches the guide's mechanical scan", () => {
  const guide = fs.readFileSync(STYLE_GUIDE_PATH, "utf8");
  assert.match(guide, /\\x\{2014\}\\x\{2013\}/, "guide still carries the dash/quote scan line");
  for (const word of ["delve", "crucial", "seamless", "leverag", "streamlin", "holistic", "revolutioni"]) {
    assert.ok(guide.includes(word), `guide banned-word list still contains ${word}`);
    assert.ok(STYLE_HARD[1][0].source.includes(word), `test banned-word regex still contains ${word}`);
  }
});

// =====================================================================================
// (10) Length: total and unique words of each guide's rendered text
// =====================================================================================
// The plan asked for >= 300 page-specific words per guide on top of the existing bodies. The
// floors below are set from the measured rendered text after the WP-D rewrite (see the WP-D
// report for the exact numbers); they guard against a regression that strips the added
// sections (worked example, inputs table, sourced paragraph, FAQ), not against honest edits.
const MIN_TOTAL_WORDS = 1500;
const MIN_UNIQUE_WORDS = 500;
for (const [route, segs] of GUIDES) {
  test(`length: ${route} rendered text has >= ${MIN_TOTAL_WORDS} words and >= ${MIN_UNIQUE_WORDS} unique words`, () => {
    // The shared WhatDockaIs positioning strip (components/WhatDockaIs.tsx) is site-wide chrome
    // counted on no page; these floors measure the guide's own prose, so the strip is skipped.
    const w = words(textOf(render(loadRoute(...segs)), true));
    const uniq = new Set(w).size;
    assert.ok(w.length >= MIN_TOTAL_WORDS, `${route}: ${w.length} words (want >= ${MIN_TOTAL_WORDS})`);
    assert.ok(uniq >= MIN_UNIQUE_WORDS, `${route}: ${uniq} unique words (want >= ${MIN_UNIQUE_WORDS})`);
  });
}
