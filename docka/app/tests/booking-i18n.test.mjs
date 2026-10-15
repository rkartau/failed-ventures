// i18n completeness for the Wave-4 "Book a call" UI (public /book, homepage + nav CTA,
// admin bookings view, settings editor, outreach copy-link panel). Every NEW key the
// feature introduced must exist in ALL 6 languages (en/zh/ru/tl/id/vi) — a brand-new
// customer-facing surface shipping partially English would be a silent regression for the
// exact low-English users the app targets. Also checks {placeholder} parity so a
// translation can't drop {tz}/{time}/{date}/{n}/{url}.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking-i18n.test.mjs

import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

assert.equal(LANGS.length, 6, "the 6-language roster is the contract this test enforces");
ok("LANGS has exactly 6 languages");

// Every key the booking UI adds: the whole book.* namespace + the two shared CTAs.
const KEYS = [
  ...Object.keys(DICT).filter((k) => k.startsWith("book.")),
  "nav.book",
  "home.book",
];

assert.ok(KEYS.length >= 60, `expected the full booking key set, found ${KEYS.length}`);

for (const key of KEYS) {
  const entry = DICT[key];
  assert.ok(entry, `missing dict entry: ${key}`);
  for (const { code } of LANGS) {
    assert.equal(typeof entry[code], "string", `${key} is missing its "${code}" translation`);
    assert.ok(entry[code].trim().length > 0, `${key} has an empty "${code}" translation`);
  }
}
ok(`all ${KEYS.length} booking keys complete in all 6 languages`);

// {placeholder} parity: every interpolation var in English must survive in every language.
for (const key of KEYS) {
  const entry = DICT[key];
  const vars = [...entry.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const { code } of LANGS) {
    for (const v of vars) {
      assert.ok(
        entry[code].includes(`{${v}}`),
        `${key} "${code}" translation lost the {${v}} placeholder`
      );
    }
  }
}
ok("placeholder vars survive in every language");

console.log(`booking-i18n: ${pass} checks passed`);
