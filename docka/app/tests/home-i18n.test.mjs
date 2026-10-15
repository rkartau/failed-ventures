// i18n completeness + HONESTY guard for the PSV homepage repositioning
// (psv-frontpage plan §3): every new/changed home.* key must exist in ALL 6
// languages (en/zh/ru/tl/id/vi), and — because completeness ≠ honesty — every
// LANGUAGE column is swept for the claims the copy must never make:
//   (a) no digit adjacent to a registry/country word (no "15 registries" — the
//       hero count stays DERIVED, never hardcoded, in any language);
//   (b) no "tamper(-proof)" claim;
//   (c) no standalone "API" claim;
//   (d) the pillar-3 wording stays de-absolutized: no universal
//       "every … re-check(ed) … live" claim (regex-pinned in ENGLISH; the other
//       5 languages are covered by sweep (a)–(c) plus the §8 per-language
//       claims review — documented limit, plan §3 v3);
//   (e) "PSV" NEVER appears except immediately after its spelled-out form
//       ("primary source verification (PSV)") — bare PSV reads as Platform
//       Supply Vessel to this audience (see app/lib/required-docs.ts).
//
// NOTE (plan §3 v3): sweep (a) is a digit sweep — it cannot catch spelled-out
// numerals (zh "八个国家", ru "восемь стран"); those are checked in the §8
// per-language claims review, not here.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/home-i18n.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

// Keys CHANGED by the PSV repositioning (updated in place, all 6 languages).
const CHANGED_KEYS = [
  "home.badge",
  "home.title",
  "home.subtitle",
  "home.tryTitle",
  "home.liveLookup",
];

// Keys ADDED by the PSV repositioning. None may start with "home.sample"
// (sample-i18n.test.mjs stray-key guard owns that namespace).
const NEW_KEYS = [
  "home.verifyCta",
  "home.trustTitle",
  "home.pillarsTitle",
  "home.pillar1t",
  "home.pillar1b",
  "home.pillar2t",
  "home.pillar2b",
  "home.pillar3t",
  "home.pillar3b",
  "home.pillar4t",
  "home.pillar4b",
  "home.lvl0",
  "home.lvl1",
  "home.lvl2",
  "home.lvl3",
  "home.howTitle",
];

// Keys added/changed by the homepage POLISH WAVE (follow-up, 2026-08-31):
// translated hero overview links + VerifyBox input chrome (new vb.* namespace),
// the hero hint line, and the PSV footer tagline. Concatenated into ALL_KEYS so
// every sweep above/below covers them — including the PSV-expansion rule the
// new tagline must pass in EVERY language column.
const WAVE2_KEYS = [
  "home.seeAgencies",
  "home.seeSeafarers",
  "home.verifyHint",
  "vb.verify",
  "vb.verifying",
  "vb.placeholder",
  "vb.sample",
  "footer.tagline",
];

// Keys added by the CRM POSITIONING batch (plan v4 §2d, 2026-09-07): the seafarer hero line
// and the six-card CRM section (title + 6 card titles + 6 card bodies + the closing CTA).
// Concatenated into ALL_KEYS so every completeness AND honesty sweep in this file covers
// them — the CRM cards are the most claim-dense copy on the site, so the digit sweep, the
// tamper sweep, the bare-API sweep and the PSV-expansion rule all have to hold in all six
// languages. `nav.agencies` is deliberately NOT here: nav.* is English-only by convention
// (D4), exactly like nav.registries / nav.resources, and t() falls back to `en`.
const CRM_KEYS = [
  "home.seafarerFree",
  "home.crmTitle",
  "home.crm1t",
  "home.crm1b",
  "home.crm2t",
  "home.crm2b",
  "home.crm3t",
  "home.crm3b",
  "home.crm4t",
  "home.crm4b",
  "home.crm5t",
  "home.crm5b",
  "home.crm6t",
  "home.crm6b",
  "home.crmCta",
];

const ALL_KEYS = [...CHANGED_KEYS, ...NEW_KEYS, ...WAVE2_KEYS, ...CRM_KEYS];

test("LANGS roster is still the 6-language contract", () => {
  assert.equal(LANGS.length, 6);
});

test("no new PSV key trespasses on the guarded home.sample namespace", () => {
  for (const key of [...NEW_KEYS, ...WAVE2_KEYS]) {
    assert.ok(!key.startsWith("home.sample"), `${key} must not start with home.sample`);
  }
});

test("every new/changed PSV home.* key is complete in all 6 languages", () => {
  for (const key of ALL_KEYS) {
    const entry = DICT[key];
    assert.ok(entry, `missing dict entry: ${key}`);
    for (const { code } of LANGS) {
      assert.equal(typeof entry[code], "string", `${key} is missing its "${code}" translation`);
      assert.ok(entry[code].trim().length > 0, `${key} has an empty "${code}" translation`);
    }
  }
});

test("no key is an untranslated English placeholder", () => {
  for (const key of ALL_KEYS) {
    const entry = DICT[key];
    for (const { code } of LANGS) {
      if (code === "en") continue;
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
  for (const key of ALL_KEYS) {
    const entry = DICT[key];
    const en = holes(entry.en);
    for (const { code } of LANGS) {
      assert.deepEqual(holes(entry[code]), en, `${key}."${code}" placeholder mismatch`);
    }
  }
});

// ---- Forbidden-claim sweep — EVERY language column (plan §3 v2) -----------

// Per-language registry/country word stems. A digit within 16 characters of
// one of these (either side) reads as a hardcoded count claim.
const COUNT_WORDS = [
  "registr", // en/tl/id: registry/registries/registri
  "countr", // en: country/countries
  "国", // zh: country
  "登记处", // zh: registry
  "реестр", // ru: registry
  "стран", // ru: country/countries stem
  "bansa", // tl: country
  "negara", // id: country
  "quốc gia", // vi: country
  "sổ đăng ký", // vi: registry
];
const COUNT_RE = new RegExp(
  `\\d[^.。]{0,16}(?:${COUNT_WORDS.join("|")})|(?:${COUNT_WORDS.join("|")})[^.。]{0,16}\\d`,
  "iu"
);

test("no language column hardcodes a registry/country count", () => {
  for (const key of ALL_KEYS) {
    for (const { code } of LANGS) {
      const v = DICT[key][code];
      assert.ok(
        !COUNT_RE.test(v),
        `${key}."${code}" puts a digit next to a registry/country word (derived counts only): ${v}`
      );
    }
  }
});

test('no language column claims "tamper-proof"', () => {
  for (const key of ALL_KEYS) {
    for (const { code } of LANGS) {
      const v = DICT[key][code];
      assert.ok(!/tamper/i.test(v), `${key}."${code}" contains a tamper claim: ${v}`);
      assert.ok(!/篡改/.test(v), `${key}."${code}" contains a tamper claim (zh): ${v}`);
    }
  }
});

test('no language column makes a bare "API" claim', () => {
  for (const key of ALL_KEYS) {
    for (const { code } of LANGS) {
      const v = DICT[key][code];
      assert.ok(!/\bAPI\b/.test(v), `${key}."${code}" contains a standalone API claim: ${v}`);
    }
  }
});

test("pillar 3 (en) never re-absolutizes the live-recheck claim", () => {
  const en = DICT["home.pillar3b"].en;
  assert.ok(
    !/every .*re-?check.*live/i.test(en),
    "home.pillar3b (en) must not claim a universal live re-check"
  );
  // Positive pin of the honest scoping (matches the live/cached/snapshot tri-state).
  assert.ok(
    en.includes("wherever the source registry supports it"),
    "home.pillar3b (en) must keep the 'wherever the source registry supports it' scope"
  );
});

test('"PSV" appears only immediately after its spelled-out form, in every language', () => {
  for (const key of ALL_KEYS) {
    for (const { code } of LANGS) {
      const v = DICT[key][code];
      const psvCount = (v.match(/PSV/g) ?? []).length;
      if (psvCount === 0) continue;
      const expandedCount = (v.match(/primary source verification \(PSV\)/g) ?? []).length;
      assert.equal(
        psvCount,
        expandedCount,
        `${key}."${code}": every "PSV" must appear as "primary source verification (PSV)": ${v}`
      );
    }
  }
});
