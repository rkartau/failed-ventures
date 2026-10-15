// Country-detection test-specimen generator (verify-upload corpus validation).
//
// For EVERY entry in the registry table (lib/registry/countries.ts) it renders
// an OBVIOUSLY-FAKE certificate-card JPEG via Playwright (devDependency) so the
// operator can validate keyword→country detection per country on the live
// /admin/verify-uploads page. The specimen bakes in the entry's authority
// string (what the keyword map matches), up to two of its keywords[], a
// synthetic "Certificate No" (best-effort codePattern match — NEVER a real
// number), holder "TEST SPECIMEN", and a large diagonal watermark.
//
// Output: tests/fixtures/verify-upload-specimens/<CC>.jpg (gitignored — this
// generator is the source of truth; regenerate at will).
//
// Run:  node scripts/generate-country-specimens.mjs        (from app/)
// The template/code helpers are exported for tests/verify-upload-specimens.test.mjs
// (text-level keyword-matcher assertions — no OCR in unit tests).

import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `@/*` alias + extensionless-TS resolve hook (same one npm test uses) so this
// .mjs can import the TypeScript registry table directly (Node 24 strips types).
register("../tests/_ts-alias-hooks.mjs", import.meta.url);

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SPECIMENS_DIR = path.join(APP_ROOT, "tests", "fixtures", "verify-upload-specimens");

export async function loadCountries() {
  const { COUNTRIES } = await import("@/lib/registry/countries");
  return COUNTRIES;
}

// ---- Synthetic certificate number ------------------------------------------
//
// Best-effort sample of the entry's codePattern for SIMPLE patterns only:
// a ^-anchored sequence of `\d` / `[literal class]` atoms with `{n}` /
// `{n,m}` / no quantifier. Anything fancier falls back to "TEST123456".
// Fill characters come from an obviously-fake preferred sequence
// ("TESTSPECIMEN" + ascending digits) filtered per character class, so e.g.
// /^[A-Z0-9]{16}$/ -> "TESTSPECIMEN0123" and /^\d{8}$/ -> "01234567".

const FALLBACK_CODE = "TEST123456";
const PREF = "TESTSPECIMEN0123456789";

function expandClass(body) {
  // Literal-only class bodies: letters/digits and simple X-Y ranges. `null`
  // for negations/escapes — caller falls back.
  if (body.startsWith("^") || body.includes("\\")) return null;
  const out = new Set();
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const lo = body.charCodeAt(i);
      const hi = body.charCodeAt(i + 2);
      if (hi < lo) return null;
      for (let c = lo; c <= hi; c++) out.add(String.fromCharCode(c));
      i += 2;
    } else {
      out.add(body[i]);
    }
  }
  return out;
}

export function makeSyntheticCode(entry) {
  const re = entry.codePattern;
  if (!re) return FALLBACK_CODE;
  let src = re.source;
  if (src.startsWith("^")) src = src.slice(1);
  if (src.endsWith("$")) src = src.slice(0, -1);

  // One whole-pattern non-capturing alternation group — e.g. the UK's REAL id
  // shapes /^(?:[A-Z]{2,4}\d{7}|\d{9})$/ (2026-08-12) — expands via its FIRST
  // alternative (any branch matches the pattern). Nested groups still fall back.
  if (src.startsWith("(?:") && src.endsWith(")")) {
    const inner = src.slice(3, -1);
    if (!inner.includes("(")) src = inner.split("|")[0];
  }

  let out = "";
  let i = 0;
  while (i < src.length) {
    let cls;
    if (src[i] === "\\" && src[i + 1] === "d") {
      cls = expandClass("0-9");
      i += 2;
    } else if (src[i] === "[") {
      const end = src.indexOf("]", i + 1);
      if (end < 0) return FALLBACK_CODE;
      cls = expandClass(src.slice(i + 1, end));
      i = end + 1;
    } else if (/[A-Z0-9]/i.test(src[i])) {
      cls = new Set([src[i]]);
      i += 1;
    } else {
      return FALLBACK_CODE; // groups, alternation, anchors mid-pattern, ...
    }
    if (!cls) return FALLBACK_CODE;

    let count = 1;
    const q = /^\{(\d+)(?:,(\d+))?\}/.exec(src.slice(i));
    if (q) {
      count = Number(q[1]); // minimum repetition is enough to match
      i += q[0].length;
    }

    const allowed = [...PREF].filter((ch) => cls.has(ch));
    const pool = allowed.length ? allowed : [...cls];
    for (let k = 0; k < count; k++) out += pool[k % pool.length];
  }
  if (!out || !re.test(out)) return FALLBACK_CODE;
  return out;
}

// ---- Specimen template -------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The exact human-readable text lines baked into the specimen (tests assert
 *  the keyword matcher fires on THIS text — same strings the OCR would read). */
export function buildSpecimenText(entry) {
  const kws = (entry.keywords ?? []).slice(0, 2);
  return [
    "TEST SPECIMEN — FOR SYSTEM VALIDATION ONLY",
    entry.countryName.toUpperCase(),
    "CERTIFICATE OF COMPETENCY",
    entry.authority,
    ...kws,
    `Certificate No: ${makeSyntheticCode(entry)}`,
    "Holder: TEST SPECIMEN",
    "TEST SPECIMEN — NOT A REAL CERTIFICATE",
  ].join("\n");
}

export function buildSpecimenHtml(entry) {
  const kws = (entry.keywords ?? []).slice(0, 2);
  const code = makeSyntheticCode(entry);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  .card {
    position: relative; width: 1200px; box-sizing: border-box;
    padding: 56px 64px 64px; border: 6px double #333; overflow: hidden;
  }
  .banner { font-size: 28px; letter-spacing: 2px; color: #444; text-align: center; margin-bottom: 28px; }
  .country { font-size: 44px; font-weight: bold; text-align: center; letter-spacing: 3px; }
  .doctype { font-size: 32px; text-align: center; margin: 10px 0 30px; letter-spacing: 2px; }
  .authority { font-size: 36px; font-weight: bold; text-align: center; margin: 0 0 18px; line-height: 1.35; }
  .keyword { font-size: 30px; text-align: center; margin: 6px 0; letter-spacing: 1px; }
  .fields { margin-top: 40px; font-size: 32px; line-height: 1.7; }
  .fields .code { font-family: "Courier New", monospace; font-weight: bold; letter-spacing: 2px; }
  .watermark {
    position: absolute; top: 50%; left: 50%; z-index: 0;
    transform: translate(-50%, -50%) rotate(-27deg);
    font-size: 58px; font-weight: bold; white-space: nowrap;
    color: rgba(200, 30, 30, 0.16); letter-spacing: 4px; pointer-events: none;
  }
  .fg { position: relative; z-index: 1; }
</style></head><body>
  <div class="card">
    <div class="watermark">TEST SPECIMEN — NOT A REAL CERTIFICATE</div>
    <div class="fg">
      <div class="banner">TEST SPECIMEN — FOR SYSTEM VALIDATION ONLY</div>
      <div class="country">${esc(entry.countryName.toUpperCase())}</div>
      <div class="doctype">CERTIFICATE OF COMPETENCY</div>
      <div class="authority">${esc(entry.authority)}</div>
      ${kws.map((k) => `<div class="keyword">${esc(k)}</div>`).join("\n      ")}
      <div class="fields">
        <div>Certificate No: <span class="code">${esc(code)}</span></div>
        <div>Holder: TEST SPECIMEN</div>
      </div>
    </div>
  </div>
</body></html>`;
}

// ---- Playwright render -------------------------------------------------------

export async function generateAll({ outDir = SPECIMENS_DIR, log = () => {} } = {}) {
  const countries = await loadCountries();
  const { chromium } = await import("playwright");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const written = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    for (const entry of countries) {
      await page.setContent(buildSpecimenHtml(entry), { waitUntil: "load" });
      const card = page.locator(".card");
      const file = path.join(outDir, `${entry.country}.jpg`);
      await card.screenshot({ path: file, type: "jpeg", quality: 90 });
      written.push({ country: entry.country, file, size: fs.statSync(file).size });
      log(`${entry.country}  ${path.basename(file)}  ${fs.statSync(file).size} bytes`);
    }
  } finally {
    await browser.close();
  }
  return written;
}

// ---- CLI ---------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const written = await generateAll({ log: (m) => console.log("  " + m) });
  console.log(`\nGenerated ${written.length} specimens in ${SPECIMENS_DIR}`);
}
