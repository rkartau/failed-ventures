// SEO implementation plan — WP-E2: the four new /resources guides (G3 certificate types,
// G4 required documents by rank, G5 PSC crew-certificate deficiencies, G9 revalidation).
// Regression + style-guide + anti-fabrication contract. NOT registered in package.json
// "test" by this WP; the integration agent registers it.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-guides-e2.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
// shallow expand: this suite walks per node and re-expands as it goes; see _render-text.mjs:expandShallow.
import { expandShallow as expand } from "./_render-text.mjs";
import { SITE_URL, abs } from "@/lib/seo";

const inert = new Proxy({}, { get: () => () => null });
const { loadTs, APP_DIR } = createRouteHarness({
  stubs: {
    "next/link": { default: () => null },
    "next/script": { default: () => null },
    "./globals.css": {},
    "@/components/Logo": inert,
    "@/components/SiteNav": inert,
  },
});

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const readFile = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");

// Repo-root docs/ (APP_DIR is <root>/app/app).
const CLAIMS_PATH = path.join(APP_DIR, "..", "..", "docs", "seo-new-pages-claims-sources.md");
const STYLE_GUIDE_PATH = path.join(APP_DIR, "..", "..", "docs", "WRITING-STYLE-GUIDE.md");

const GUIDES = [
  ["/resources/stcw-certificate-types", ["resources", "stcw-certificate-types", "page.tsx"]],
  ["/resources/required-stcw-documents-by-rank", ["resources", "required-stcw-documents-by-rank", "page.tsx"]],
  [
    "/resources/port-state-control-crew-certificate-deficiencies",
    ["resources", "port-state-control-crew-certificate-deficiencies", "page.tsx"],
  ],
  ["/resources/stcw-revalidation-every-5-years", ["resources", "stcw-revalidation-every-5-years", "page.tsx"]],
];

// The guide-section allowlist in docs/seo-new-pages-claims-sources.md (plan E3).
const ALLOWED_SRC = ["stcw-convention", "paris-mou", "tokyo-mou", "mca-eng1", "lib-doctypes", "real-features"];

// ---- element-tree walkers (harness returns { type, props } trees, no React) -----------
// The harness's jsx runtime stub does not invoke function components, so the tree holds
// `{ type: fn, props }` nodes for <LastUpdated />, <PrintButton />, <Link>. Expand them.
function collectLdJson(node, out = []) {
  node = expand(node);
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

function collectVisibleQuestions(node, out = []) {
  node = expand(node);
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectVisibleQuestions(n, out);
    return out;
  }
  const props = node.props || {};
  if ("data-faq-q" in props) {
    const kids = props.children;
    out.push(Array.isArray(kids) ? kids.join("") : String(kids ?? ""));
  }
  if (props.children) collectVisibleQuestions(props.children, out);
  return out;
}

// Rendered VISIBLE text: every string/number leaf, excluding <script> bodies.
// `skipStrip`: the shared WhatDockaIs positioning strip (components/WhatDockaIs.tsx) is site-wide
// chrome counted on no page; the word-count gate measures the guide's own prose, so it skips it.
// Length gate only - every other assertion (the style scan included) still sees the strip.
function collectText(node, out = [], skipStrip = false) {
  node = expand(node);
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out, skipStrip);
    return out;
  }
  if (node.type === "script") return out;
  const props = node.props || {};
  if (skipStrip && props["data-testid"] === "what-docka-is") return out;
  if (props.children !== undefined) collectText(props.children, out, skipStrip);
  return out;
}
const renderedText = (segs, skipStrip = false) =>
  collectText(loadRoute(...segs).default(), [], skipStrip).join(" ").replace(/\s+/g, " ").trim();
const wordCount = (text) => text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

function collectHrefs(node, out = []) {
  node = expand(node);
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectHrefs(n, out);
    return out;
  }
  const props = node.props || {};
  if (typeof props.href === "string") out.push(props.href);
  if (props.children) collectHrefs(props.children, out);
  return out;
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// =====================================================================================
// (1) Length — 900 to 1,500 words of rendered text (style guide §3)
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`length: ${route} renders 900-1500 words`, () => {
    const n = wordCount(renderedText(segs, true));
    assert.ok(n >= 900 && n <= 1500, `${route}: ${n} words (want 900-1500)`);
  });
}

// =====================================================================================
// (2) Schema — one Article, one FAQPage, one BreadcrumbList; @id graph wired
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`schema: ${route} emits one Article, one FAQPage, one BreadcrumbList (Home > Resources > self)`, () => {
    const objs = parsedBlocks(collectLdJson(loadRoute(...segs).default()));
    const arts = ofType(objs, "Article");
    assert.equal(arts.length, 1, "exactly one Article");
    assert.equal(ofType(objs, "FAQPage").length, 1, "exactly one FAQPage");
    const crumbs = ofType(objs, "BreadcrumbList");
    assert.equal(crumbs.length, 1, "exactly one BreadcrumbList");
    const trail = crumbs[0].itemListElement;
    assert.equal(trail[0].name, "Home");
    assert.equal(trail[0].item, SITE_URL);
    assert.equal(trail[1].name, "Resources");
    assert.equal(trail[1].item, abs("/resources"));
    assert.equal(trail[trail.length - 1].item, abs(route), "last crumb must be the self URL");
    // breadcrumbList(trail, PATH) — the @id the Article references must exist.
    assert.equal(crumbs[0]["@id"], `${abs(route)}#breadcrumb`);
    const art = arts[0];
    assert.equal(art.mainEntityOfPage["@id"], abs(route));
    assert.equal(art.mainEntityOfPage.breadcrumb["@id"], crumbs[0]["@id"], "Article breadcrumb @id must resolve");
    assert.equal(art.isPartOf["@id"], abs("/#website"));
    assert.equal(art.author["@id"], abs("/#organization"));
    assert.equal(art.publisher["@id"], abs("/#organization"));
    assert.equal(art.inLanguage, "en");
    assert.match(art.datePublished, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(art.dateModified, /^\d{4}-\d{2}-\d{2}$/);
  });
}

// =====================================================================================
// (3) FAQ parity — visible data-faq-q set == FAQPage mainEntity set; ≤3 per style guide
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`faq-parity: ${route} visible questions == FAQPage JSON-LD questions`, () => {
    const rendered = loadRoute(...segs).default();
    const faq = ofType(parsedBlocks(collectLdJson(rendered)), "FAQPage")[0];
    const jsonQs = new Set(faq.mainEntity.map((q) => norm(q.name)));
    const visibleQs = new Set(collectVisibleQuestions(rendered).map(norm));
    assert.ok(jsonQs.size >= 2 && jsonQs.size <= 3, `${route}: FAQ must have 2-3 questions (style guide §3)`);
    assert.deepEqual([...visibleQs].sort(), [...jsonQs].sort());
    for (const q of faq.mainEntity) assert.ok(q.acceptedAnswer.text.trim().length > 40, "answers must be substantive");
  });
}

// =====================================================================================
// (4) Metadata — title ≤60 unique, description ≤160, canonical self, OG article
// =====================================================================================
test("metadata: titles ≤60 chars and unique; descriptions ≤160; canonical = self; OG article", () => {
  const titles = new Set();
  for (const [route, segs] of GUIDES) {
    const meta = loadRoute(...segs).metadata;
    assert.equal(typeof meta.title, "string", `${route} title must be a plain string`);
    assert.ok(meta.title.length <= 60, `${route} title ${meta.title.length} chars (>60)`);
    assert.ok(!titles.has(meta.title), `${route} title duplicates another guide`);
    titles.add(meta.title);
    assert.ok(meta.description.length <= 160, `${route} description ${meta.description.length} chars (>160)`);
    assert.equal(meta.alternates.canonical, route);
    assert.equal(meta.openGraph.type, "article");
    assert.equal(meta.openGraph.url, route);
    if (meta.robots) assert.notEqual(meta.robots.index, false);
  }
});

// =====================================================================================
// (5) Links — /verify CTA, /registries, the pillar; byline; no duplicate appendix
// =====================================================================================
for (const [route, segs] of GUIDES) {
  test(`links: ${route} links /verify, /registries and the pillar; byline present; no appendix`, () => {
    const rendered = loadRoute(...segs).default();
    const hrefs = collectHrefs(rendered);
    assert.ok(hrefs.includes("/verify"), "must link /verify");
    assert.ok(hrefs.includes("/registries"), "must link /registries");
    assert.ok(
      hrefs.includes("/resources/how-seafarer-certificate-verification-works"),
      "must link the pillar guide"
    );
    const text = renderedText(segs);
    assert.ok(/By the Docka team · Reviewed \d{1,2} [A-Z][a-z]+ \d{4}/.test(text), "byline must render");
    assert.ok(/Check a certificate now, free/.test(text), "boxed CTA copy must render");
    assert.ok(/Related guides/.test(text), "Related guides list must render");
    const src = readFile(...segs);
    assert.ok(!/Trust levels at a glance/.test(src), "must not carry the removed appendix");
    assert.ok(!/How we verify/.test(src), "must not carry the removed 'How we verify' appendix");
    assert.match(src, /data-testid="byline"/);
    assert.match(src, /breadcrumbList\(\s*\[[\s\S]*?\],\s*PATH\s*\)/, "must call breadcrumbList(trail, PATH)");
  });
}

test("links: the PSC guide carries at least two outbound MoU links", () => {
  const hrefs = collectHrefs(loadRoute(...GUIDES[2][1]).default());
  const mou = hrefs.filter((h) => /^https:\/\/(www\.)?(parismou\.org|tokyo-mou\.org)\//.test(h));
  assert.ok(mou.length >= 2, `want ≥2 MoU links, got ${mou.length}: ${mou.join(", ")}`);
  assert.ok(mou.some((h) => /parismou\.org/.test(h)), "must link parismou.org");
  assert.ok(mou.some((h) => /tokyo-mou\.org/.test(h)), "must link tokyo-mou.org");
});

test("links: the by-rank guide renders the PrintButton and a checklist row per rank label", () => {
  const src = readFile(...GUIDES[1][1]);
  assert.match(src, /import \{ PrintButton \} from "@\/components\/PrintButton"/);
  const text = renderedText(GUIDES[1][1]);
  assert.ok(/Print \/ Save as PDF/.test(text), "PrintButton label must render");
  const { RANK_LABELS } = loadTs(path.join(APP_DIR, "..", "lib", "required-docs.ts"));
  for (const label of Object.values(RANK_LABELS)) {
    assert.ok(text.includes(label), `checklist must carry the exact rank label "${label}"`);
  }
});

// =====================================================================================
// (6) Style guide — the mechanical regex scan from WRITING-STYLE-GUIDE.md §4, run on the
//     RENDERED text (plan R8) and on the JSON-LD answers.
// =====================================================================================
const STYLE_REGEXES = [
  /[—–“”‘’]/u,
  /\b(delve|delving|crucial|pivotal|robust|seamless(ly)?|landscape|tapestry|testament|navigat(e|ing)|leverag(e|ing)|harness(es|ing)?|unlock(s|ing)?|elevat(e|ing)|empower(s|ing)?|streamlin(e|ing)|cutting-edge|game-?chang(er|ing)|groundbreaking|vibrant|boasts?|bolster(s|ed|ing)?|intricate|interplay|meticulous(ly)?|underscor(e|es|ing)|foster(s|ing)?|showcas(e|es|ing)|garner(s|ed)?|enduring|ever-evolving|holistic|synergy|realm|transformative|revolutioni[sz]e)\b/i,
  /\b(highlighting|underscoring|emphasi[sz]ing|reflecting|symboli[sz]ing|contributing to)\b/i,
  /\b(serves as|stands as|functions as|operates as|represents a)\b/i,
  /\b(not only|not just|isn't just|is not just|rather than|more than just)\b/i,
  /\b(in conclusion|in summary|to sum up|overall,|final thoughts|ultimately)\b/i,
  /\b(it'?s (important|worth) (to note|noting)|notably|importantly|interestingly|essentially|additionally|furthermore|moreover)\b/i,
  /\b(whether you'?re|in today'?s|in the world of|in an era of|in the (ever-)?evolving|fast-paced)\b/i,
  /\b(great question|certainly|i hope this helps|let'?s dive|please note|as of my last|at the time of writing|as an ai)\b/i,
  /\b(experts (say|agree|argue)|industry reports|observers (note|have)|widely (recogni[sz]ed|regarded)|some critics)\b/i,
  /\b(world-class|state-of-the-art|best-in-class|trusted by|leading provider|nestled|in the heart of)\b/i,
  /(\*\*|^#{1,6} |^---$|utm_source=|\[insert|lorem ipsum|TBD)/m,
];

test("style: the regex list mirrors WRITING-STYLE-GUIDE.md §4 (guard against silent drift)", () => {
  const guide = fs.readFileSync(STYLE_GUIDE_PATH, "utf8");
  for (const needle of ["delve|delving|crucial", "not only|not just", "in conclusion|in summary", "utm_source="]) {
    assert.ok(guide.includes(needle), `style guide must still carry "${needle}"`);
  }
});

for (const [route, segs] of GUIDES) {
  test(`style: ${route} rendered text and JSON-LD answers pass the style-guide regex scan`, () => {
    const rendered = loadRoute(...segs).default();
    const text = renderedText(segs);
    const faq = ofType(parsedBlocks(collectLdJson(rendered)), "FAQPage")[0];
    const answers = faq.mainEntity.map((q) => `${q.name} ${q.acceptedAnswer.text}`).join("\n");
    const meta = loadRoute(...segs).metadata;
    const corpus = `${text}\n${answers}\n${meta.title}\n${meta.description}`;
    for (const re of STYLE_REGEXES) {
      const m = corpus.match(re);
      assert.equal(m, null, `${route}: style-guide hit ${re} at "${m && corpus.slice(Math.max(0, m.index - 40), m.index + 60)}"`);
    }
    // No emoji, no "$" or "€" glyph in body text (style guide §2 rule 8).
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(corpus), "no emoji");
    assert.ok(!/[$€]/.test(text), "no $ or € glyph in body text");
  });
}

// =====================================================================================
// (7) Fabrication — every digit/hotword line has an adjacent [src:] comment; ids allowlisted
// =====================================================================================
const HOTWORDS = "(?:forged|fraud(?:ulent(?:ly)?)?|fake|penalty|fines?|detention|detainable|detained)";
const TRIGGER = new RegExp(`\\d|%|\\b${HOTWORDS}\\b`, "i");
const WINDOW = 5;

for (const [route, segs] of GUIDES) {
  test(`fabrication: every digit/hotword line in ${route} has an adjacent [src:] comment`, () => {
    const raw = readFile(...segs);
    assert.ok(!/26 registries/.test(raw), "no '26 registries' overcount");
    assert.ok(!/\d+%[^.]*(forged|fraud|fake)/i.test(raw), "no fraud percentage");
    assert.ok(!/\d+(\.\d+)?%/.test(raw), "no percentages at all (no read source for any)");

    const scan = raw
      // The shared Tailwind class string (text-brand-700 etc.) is styling, not a claim.
      .replace(/const LINK =\s*\n?\s*"[^"]*";/g, "")
      .replace(/className=\{?"[^"]*"\}?/g, "")
      .replace(/className=\{LINK\}/g, "")
      .replace(/<Link[\s\S]*?<\/Link>/g, " NAVLINK ")
      .replace(/href="[^"]*"/g, "")
      .replace(/data-testid="[^"]*"/g, "")
      .replace(/aria-labelledby="[^"]*"/g, "")
      .replace(/id="[^"]*"/g, "");
    const lines = scan.split("\n");
    const codeOnly = (l) =>
      l
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*.*?\*\//g, "")
        .replace(/\/\/.*$/, "")
        .replace(/<[^>]*>/g, " ");
    // The metadata/JSON-LD/import preamble (before the FAQ const) is structural, not prose,
    // except the TITLE/DESCRIPTION strings — those are scanned too.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*import\s/.test(line)) continue;
      if (/^\s*(const|export const|"@|headline:|description:|image:|inLanguage|isPartOf|author:|publisher:|datePublished|dateModified|mainEntityOfPage|breadcrumb:|"@id"|"@type"|"@context"|type:|url:|title:|images:|twitter:|alternates:|openGraph:)/.test(line) && !/TITLE|DESCRIPTION/.test(line))
        continue;
      if (!TRIGGER.test(codeOnly(line))) continue;
      const win = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
      assert.ok(
        /\[src:/.test(win),
        `${route}: line ${i + 1} ("${line.trim().slice(0, 90)}") needs an adjacent [src:...] comment`
      );
    }
  });
}

test("fabrication: every [src:id] in the four guides is allowlisted under '## Guides' in the claims file", () => {
  const claims = fs.readFileSync(CLAIMS_PATH, "utf8");
  const guidesSection = claims.slice(claims.indexOf("## Guides"));
  assert.ok(guidesSection.length > 0, "claims file must carry a '## Guides' section");
  for (const id of ALLOWED_SRC) {
    assert.ok(guidesSection.includes(`\`${id}\``), `'## Guides' must enumerate source id "${id}"`);
  }
  for (const [route, segs] of GUIDES) {
    const raw = readFile(...segs);
    const ids = [...raw.matchAll(/\[src:\s*([A-Za-z][A-Za-z0-9._-]*)/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, `${route} must carry [src:] tokens`);
    for (const id of ids) {
      assert.ok(ALLOWED_SRC.includes(id), `${route}: [src:${id}] is not allowlisted (${ALLOWED_SRC.join(", ")})`);
    }
  }
  // Plan R7c: the five-year / refresher statements cite stcw-convention.
  const reval = readFile(...GUIDES[3][1]);
  assert.match(reval, /\[src:stcw-convention:[^\]]*five years/i, "revalidation guide must cite stcw-convention for five years");
});

// =====================================================================================
// (8) Cross-links — the four guides link each other (no orphan among the set)
// =====================================================================================
test("cross-links: each new guide is href'd by at least two of the other three", () => {
  const srcs = GUIDES.map(([route, segs]) => [route, readFile(...segs)]);
  for (const [route] of GUIDES) {
    const inbound = srcs.filter(([r, s]) => r !== route && s.includes(`"${route}"`)).length;
    assert.ok(inbound >= 2, `${route} is linked from ${inbound} sibling guides (want ≥2)`);
  }
});
