// tests/sources-shots.mjs — desktop + mobile screenshots of /admin/sources.
//
// The admin surface has NO dev/test auth door (lib/admin-session.ts), so we
// cannot drive it through a live server the way the seaman/agent shots do.
// Instead we render the REAL <SourcesView> server component through the in-memory
// route harness (the SAME code path the unit tests exercise), serialise its
// element tree to HTML, style it with Tailwind's Play CDN, and screenshot that
// file:// page with Playwright at both viewports. FIXTURES ONLY — never live
// data, never app/data or content/.
//
// No dev server is started, so there is nothing to leave running; the ONLY child
// process is headless chromium, closed in `finally`. Every shot also asserts the
// page body does not scroll horizontally (overflowX === 0).
//
// Run:  node tests/sources-shots.mjs
//       SHOTS_OUT=<dir> node tests/sources-shots.mjs   (override output dir)

import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteHarness, APP_DIR, JSX_FRAGMENT } from "./_route-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOTS_OUT || path.join(__dirname, "shots", "sources");
fs.mkdirSync(OUT, { recursive: true });

// ---- harness: real view + parser, next/link → <a> --------------------------

const LINK_STUB = { __esModule: true, default: (p) => ({ type: "a", props: p }) };
const h = createRouteHarness({ stubs: { "next/link": LINK_STUB } });
const { SourcesView } = h.loadTs(path.join(APP_DIR, "admin", "sources", "view.tsx"));
const { parseSourcesDoc } = h.loadTs(path.join(APP_DIR, "..", "lib", "docka-sources.ts"));

const STAT = { mtimeMs: 100, size: 200 };

function srcEntry(o = {}) {
  return {
    row: 1, section: "A", name: "Some Source", country: "GB",
    category: "Licence & approval register", url: "https://example.gov/reg",
    url_note: null, url_recorded_in: "PIPELINE_STATE.md#1",
    access_method: "the site's own data endpoint, robots-clean", access_method_truncated: false,
    rows_extracted: "10", licence_terms: "OGL v3 — attribution required", licence_terms_truncated: false,
    verdict: "USABLE", in_the_list: "YES|10", in_list_flag: "YES", in_list_rows: 10,
    notes: "notes", notes_truncated: false, registry_keys: ["some_reg"],
    enrichment: false, assessed_at: "2026-08-17", assessed_at_basis: "url_recorded_in",
    ...o,
  };
}
function mkDoc(sources, warnings = []) {
  return {
    schema_version: 1, kind: "docka-sources", generated_at: "2026-09-02 13:40 UTC",
    generated_at_epoch_ms: 1788356400000, source_version: "v21",
    ledger: {
      file: "SOURCE_INDEX.csv", sha256: "a".repeat(64), mtime: "2026-09-02 07:06 UTC",
      mtime_epoch_ms: 1788332760000, rows: sources.length,
      has_registry_column: true, has_assessed_at_column: true,
    },
    sources, warnings,
  };
}
function agg(registry, rows, withEmail = 0, sendable = 0, lastExtractedAt = null) {
  return { registry, rows, withEmail, sendable, lastExtractedAt };
}
function okSources(sources, warnings = []) {
  const parsed = parseSourcesDoc(mkDoc(sources, warnings), STAT);
  if (!parsed.ok) throw new Error("fixture parse failed: " + parsed.error);
  return { status: "ok", doc: parsed.value, publishedAt: 1788332760000 };
}
function okLeads(aggs, extra = {}) {
  return {
    ok: true, stale: extra.stale ?? null,
    data: {
      generatedAt: "2026-09-02 10:00 UTC", sourceVersion: "v21", publishedAt: 1788332760000,
      totalRows: extra.totalRows ?? 36860, sendableCount: 556, workingSet: [], desks: [],
      sources: aggs, sourcesTruncated: extra.sourcesTruncated ?? false,
      sourcesUnreadable: extra.sourcesUnreadable ?? 0,
    },
  };
}

// ---- element tree → HTML ---------------------------------------------------

const VOID = new Set(["input", "br", "img", "hr", "meta"]);
const RENAME = { className: "class", htmlFor: "for", colSpan: "colspan", maxLength: "maxlength", defaultValue: "value" };
const KEEP = new Set(["class", "value", "for", "colspan", "maxlength", "href", "target", "rel", "title", "placeholder", "name", "type", "id"]);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function toHtml(node) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return esc(node);
  if (Array.isArray(node)) return node.map(toHtml).join("");
  if (typeof node === "object" && "type" in node) {
    const { type, props } = node;
    const p = props || {};
    if (typeof type === "function") return toHtml(type(p));
    if (type === JSX_FRAGMENT) return toHtml(p.children);
    if (typeof type !== "string") return toHtml(p.children);
    let attrs = "";
    for (const [key, val] of Object.entries(p)) {
      if (key === "children" || val == null || val === false) continue;
      const name = RENAME[key] || key;
      if (KEEP.has(name) || name.startsWith("data-")) attrs += ` ${name}="${esc(val)}"`;
    }
    const kids = toHtml(p.children);
    return VOID.has(type) ? `<${type}${attrs}>` : `<${type}${attrs}>${kids}</${type}>`;
  }
  return "";
}

function pageHtml(el) {
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{margin:0;background:#fff}</style></head>
<body>${toHtml(el)}</body></html>`;
}

// ---- fixtures --------------------------------------------------------------

const AGGS = [
  agg("uk_companies_house", 6576, 202, 38, "2026-08-01"),
  agg("maritime_directory_2026-08", 5060, 3252, 374, "2026-08-31"),
  agg("in_dgma_rpsl", 526, 526, 0, "2026-08-17"),
  agg("website_discovered_2026-08", 34, 34, 34, "2026-08-31"),
  agg("(unknown)", 12, 0, 0, null),
];
const LEDGER = [
  srcEntry({ row: 1, name: "India DGMA — RPSL register", country: "IN", section: "A", category: "Licence & approval register", url: "https://dgma.gov.in/ari/rpsl", registry_keys: ["in_dgma_rpsl"], in_the_list: "YES|526", in_list_flag: "YES", in_list_rows: 526, verdict: "USABLE", licence_terms: "NO OPEN LICENCE. Footer asserts reserved rights; contactable-source reuse under legitimate-interest. ".repeat(4), licence_terms_truncated: true }),
  srcEntry({ row: 2, name: "UK Companies House (FCDP maritime SIC)", country: "GB", section: "E", category: "National company register", url: "https://find-and-update.company-information.service.gov.uk", registry_keys: ["uk_companies_house"], in_the_list: "YES|6434", in_list_flag: "YES", in_list_rows: 6434, verdict: "USABLE" }),
  srcEntry({ row: 3, name: "utdanning.no lærebedrift", country: "NO", section: "A", category: "Cadet/training-berth register", url: "https://utdanning.no", registry_keys: ["maritime_directory_2026-08"], in_the_list: "YES|2", in_list_flag: "YES", in_list_rows: 2, verdict: "USABLE" }),
  srcEntry({ row: 4, name: "docka wave-2 email-discovery crawl", country: "GLOBAL", section: "S", category: "Member-company website", url: "https://example.org/crawl", registry_keys: [], enrichment: true, in_the_list: "YES|34", in_list_flag: "YES", in_list_rows: 34, verdict: "USABLE" }),
  srcEntry({ row: 5, name: "INTERTANKO members", country: "GLOBAL", section: "F", category: "Shipowner/ship-manager association", url: "https://www.intertanko.com", registry_keys: ["intertanko"], in_the_list: "NO-FORBIDDEN|0", in_list_flag: "NO-FORBIDDEN", in_list_rows: 0, verdict: "FORBIDDEN", access_method: "Members directory behind terms that forbid scraping and reuse; robots + ToS both refuse. ".repeat(3), access_method_truncated: true, assessed_at: "2026-08-10" }),
  srcEntry({ row: 6, name: "Some dead registry", country: "GR", section: "G", category: "Crewing directory/job board", url: "NOT RECORDED", registry_keys: ["dead_reg"], in_the_list: "NO-DEAD|0", in_list_flag: "NO-DEAD", in_list_rows: 0, verdict: "DEAD", assessed_at: "2026-07-01" }),
  srcEntry({ row: 7, name: "Gated cadet register", country: "DK", section: "G", category: "Cadet/training-berth register", url: "https://gated.example.dk/login", registry_keys: ["gated_reg"], in_the_list: "NO-GATED|0", in_list_flag: "NO-GATED", in_list_rows: 0, verdict: "GATED", assessed_at: "2026-06-15" }),
];

const POPULATED = { leads: okLeads(AGGS, { sourcesUnreadable: 3 }), sources: okSources(LEDGER, [{ kind: "duplicate_key", key: "in_dgma_rpsl", rows: [1, 99] }]) };
const MISSING = { leads: okLeads(AGGS), sources: { status: "missing" } };
const INVALID = { leads: okLeads(AGGS), sources: { status: "invalid", error: "the file is present but not valid JSON" } };

const VIEWPORTS = [
  { tag: "desktop", width: 1280, height: 800 },
  { tag: "mobile", width: 390, height: 844 },
];
const STATES = [
  { name: "populated", props: POPULATED },
  { name: "ledger-missing", props: MISSING },
  { name: "ledger-invalid", props: INVALID },
];

// ---- render + screenshot ---------------------------------------------------

const browser = await chromium.launch();
let overflowFailures = 0;
try {
  for (const st of STATES) {
    const html = pageHtml(SourcesView({ ...st.props, searchParams: {} }));
    const tmp = path.join(os.tmpdir(), `sources-shot-${st.name}-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, "utf8");
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto("file://" + tmp.replace(/\\/g, "/"));
      // Give the Play CDN a moment to apply utilities (best-effort; layout still
      // renders without it).
      await page.waitForTimeout(1200);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const file = path.join(OUT, `sources-${st.name}-${vp.tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const ok = overflowX <= 1;
      if (!ok) overflowFailures++;
      console.log(`  ${st.name} ${vp.tag} → ${path.basename(file)}  overflowX=${overflowX}px ${ok ? "ok" : "OVERFLOW!"}`);
      await ctx.close();
    }
    fs.rmSync(tmp, { force: true });
  }
} catch (e) {
  console.log("FAIL:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

if (overflowFailures > 0) {
  console.log(`FAIL: ${overflowFailures} shot(s) scrolled horizontally`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${STATES.length * VIEWPORTS.length} shots written to ${OUT}`);
}
