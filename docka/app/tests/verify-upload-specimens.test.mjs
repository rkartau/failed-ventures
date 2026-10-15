// Country-specimen coverage tests (scripts/generate-country-specimens.mjs):
//
//  1. Every registry-table entry gets a JPEG specimen (magic-byte check) —
//     generated on demand via Playwright; SKIPPED gracefully when Playwright
//     browsers aren't installed (npx playwright install chromium).
//  2. TEXT-LEVEL detection assertion (no OCR): the authority/keyword text baked
//     into each specimen template must fire the keyword matcher
//     (lib/registry/keywords.ts) for its OWN country — and no other. Entries
//     without keywords (BG: Cyrillic authority, eng-only OCR — documented
//     limit) must yield NO match.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/verify-upload-specimens.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { keywordCountries } = await import("@/lib/registry/keywords");
const { loadCountries, buildSpecimenText, makeSyntheticCode, generateAll, SPECIMENS_DIR } =
  await import("../scripts/generate-country-specimens.mjs");

const COUNTRIES = await loadCountries();

// ---- 2. keyword-matcher assertions (pure text, fast, always run) ------------

test("specimen text fires the keyword matcher for exactly its own country", () => {
  for (const entry of COUNTRIES) {
    const hits = keywordCountries(buildSpecimenText(entry));
    if (entry.keywords && entry.keywords.length > 0) {
      assert.deepEqual(
        hits,
        [entry.country],
        `${entry.country}: expected exactly [${entry.country}], got [${hits.join(", ")}]`
      );
    } else {
      // BG: Cyrillic-only authority keywords — dead until non-eng traineddata.
      assert.deepEqual(hits, [], `${entry.country}: keyword-less entry must not match, got [${hits.join(", ")}]`);
    }
  }
});

test("synthetic certificate numbers match their entry's codePattern and are obviously fake", () => {
  for (const entry of COUNTRIES) {
    const code = makeSyntheticCode(entry);
    assert.ok(code.length >= 6, `${entry.country}: code too short: ${code}`);
    if (entry.codePattern) {
      assert.match(code, entry.codePattern, `${entry.country}: ${code} !~ ${entry.codePattern}`);
    } else {
      assert.equal(code, "TEST123456", `${entry.country}: pattern-less entry uses the TEST fallback`);
    }
  }
});

// ---- 1. generator produces a JPEG per entry (Playwright, guarded) -----------

function isJpeg(file) {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && fs.statSync(file).size > 10_000;
  } finally {
    fs.closeSync(fd);
  }
}

test("generator produces a JPEG specimen for every table entry", async (t) => {
  const allPresent = COUNTRIES.every((e) => isJpeg(path.join(SPECIMENS_DIR, `${e.country}.jpg`)));
  if (!allPresent || process.env.SPECIMENS_REGEN === "1") {
    try {
      await generateAll();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/executable doesn't exist|browserType\.launch|install/i.test(msg)) {
        t.skip(`Playwright browsers not installed (npx playwright install chromium): ${msg.slice(0, 120)}`);
        return;
      }
      throw e;
    }
  }
  for (const entry of COUNTRIES) {
    const file = path.join(SPECIMENS_DIR, `${entry.country}.jpg`);
    assert.ok(isJpeg(file), `${entry.country}: missing/invalid JPEG at ${file}`);
  }
});
