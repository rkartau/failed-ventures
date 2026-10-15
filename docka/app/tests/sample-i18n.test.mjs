// i18n completeness for the Public Sample Profiles surfaces (plan Phase 6): the
// whole sample.* + home.sample* key group must exist in ALL 6 languages
// (en/zh/ru/tl/id/vi) — the DICT-wide English fallback is fine for legacy
// partials, but a brand-new public surface shipping partially English would be a
// silent regression for the exact users the demo targets. Follows the
// tests/verify-upload-i18n.test.mjs contract, including:
//   - no key may still be an English PLACEHOLDER (a non-en value byte-equal to
//     the en value is only legal where the English word IS the natural loanword,
//     listed explicitly);
//   - {placeholder} parity across languages.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/sample-i18n.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

// The complete Phase-6 group. Adding a sample.* key to the DICT without listing
// it here fails the sweep below, so the two can never drift.
const SAMPLE_KEYS = [
  "sample.composeNote",
  "sample.badge",
  "sample.bannerTitle",
  "sample.bannerBody",
  "sample.bannerCta",
  "sample.learnMore",
  "sample.viewSample",
  "sample.viewSampleBoard",
  "home.sampleProfile",
  "home.sampleBoard",
];

// (key, lang) pairs where the English string is the natural rendering in that
// language (established loanword). Everything else must actually differ from en.
const EN_OK = new Set(["sample.badge|tl"]);

test("LANGS roster is still the 6-language contract", () => {
  assert.equal(LANGS.length, 6);
});

test("every sample.* / home.sample* key is complete in all 6 languages", () => {
  for (const key of SAMPLE_KEYS) {
    const entry = DICT[key];
    assert.ok(entry, `missing dict entry: ${key}`);
    for (const { code } of LANGS) {
      assert.equal(typeof entry[code], "string", `${key} is missing its "${code}" translation`);
      assert.ok(entry[code].trim().length > 0, `${key} has an empty "${code}" translation`);
    }
  }
});

test("no key is still an English placeholder (Phase-3 debt repaid)", () => {
  for (const key of SAMPLE_KEYS) {
    const entry = DICT[key];
    for (const { code } of LANGS) {
      if (code === "en" || EN_OK.has(`${key}|${code}`)) continue;
      assert.notEqual(
        entry[code],
        entry.en,
        `${key}."${code}" is byte-equal to English — placeholder not translated`
      );
    }
  }
});

test("{placeholder} parity across all languages", () => {
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of SAMPLE_KEYS) {
    const entry = DICT[key];
    const en = holes(entry.en);
    for (const { code } of LANGS) {
      assert.deepEqual(holes(entry[code]), en, `${key}."${code}" placeholder mismatch`);
    }
  }
});

test("the DICT contains no sample-group key this test does not know about", () => {
  const known = new Set(SAMPLE_KEYS);
  const strays = Object.keys(DICT).filter(
    (k) => (k.startsWith("sample.") || k.startsWith("home.sample")) && !known.has(k)
  );
  assert.deepEqual(strays, [], "new sample.* keys must be added to SAMPLE_KEYS here");
});
