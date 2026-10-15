// i18n completeness for the anonymous verify-upload UI (plan §6): every NEW
// key the upload tab introduced must exist in ALL 6 languages (en/zh/ru/tl/
// id/vi) — the DICT-wide English fallback is fine for legacy partials, but a
// brand-new surface shipping partially English would be a silent regression
// for the exact users the feature targets. Also pins the retention disclosure
// to its home on /privacy (operator decision 2026-08-12) and checks
// {placeholder} parity across languages.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/verify-upload-i18n.test.mjs

import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

// Every key ADDED for the upload tab (VerifyBox.tsx upload mode).
const NEW_KEYS = [
  "vu.tabPaste",
  "vu.tabUpload",
  "vu.dropTitle",
  "vu.choose",
  "vu.takePhoto",
  "vu.formats",
  "vu.notice", // no longer rendered (disclosure moved to /privacy) but kept in DICT for a future i18n'd privacy page
  "vu.preparing",
  "vu.checking",
  "vu.deferred",
  "vu.fallbackTitle",
  "vu.fallbackBody",
  "vu.fallbackCountry",
  "vu.readCode", // upload-born needs-inputs prompt (2026-08-24 AZ defect fix)
  "vu.countryLabel",
  "vu.detectAuto",
  "vu.verify",
  "vu.retryIn",
  "vu.tooLarge",
  "vu.unsupported",
  "vu.unavailable",
  "vu.genericError",
  "vu.moreWaiting",
];

// Pre-existing keys the upload tab REUSES (reuse-first): they must stay
// present and complete too — deleting or hollowing one would break the tab.
const REUSED_KEYS = ["sd.codeLabel", "sc.codePh", "mu.st.uploading"];

// Honesty-audit copy keys (2026-08-13): new surfaces must ship complete in
// all 6 languages, same contract as the upload tab.
const AUDIT_KEYS = ["sh.registryConfirmedBy"];

assert.equal(LANGS.length, 6, "the 6-language roster is the contract this test enforces");
ok("LANGS has exactly 6 languages");

for (const key of [...NEW_KEYS, ...REUSED_KEYS, ...AUDIT_KEYS]) {
  const entry = DICT[key];
  assert.ok(entry, `missing dict entry: ${key}`);
  for (const { code } of LANGS) {
    assert.equal(
      typeof entry[code],
      "string",
      `${key} is missing its "${code}" translation`
    );
    assert.ok(entry[code].trim().length > 0, `${key} has an empty "${code}" translation`);
  }
}
ok(
  `all ${NEW_KEYS.length} new + ${REUSED_KEYS.length} reused + ${AUDIT_KEYS.length} audit keys complete in all 6 languages`
);

// Retention disclosure (operator decision 2026-08-12): the sentence is no
// longer rendered in VerifyBox — it moved to the /privacy page ("What we
// collect"). Pin BOTH halves of that decision:
//  (a) the vu.notice dictionary entry survives unrendered (byte-exact in
//      English) so a future i18n'd privacy page can reuse the translations;
//  (b) the privacy page actually carries the disclosure.
assert.equal(
  DICT["vu.notice"].en,
  "Uploaded documents are kept by docka to improve recognition and test registry integrations."
);
ok("vu.notice retention sentence kept in DICT (unrendered) for a future i18n'd privacy page");

const { readFileSync } = await import("node:fs");
const privacySrc = readFileSync(
  new URL("../app/privacy/page.tsx", import.meta.url),
  "utf8"
);
assert.ok(
  /retained by Docka to improve\s+document recognition and to test registry integrations/.test(privacySrc),
  "privacy page must carry the upload-retention disclosure (operator decision 2026-08-12)"
);
assert.ok(
  /can be removed on\s+request/.test(privacySrc),
  "privacy page disclosure must include the removal-on-request clause"
);
ok("retention disclosure lives on /privacy (new home) incl. removal-on-request");

// {placeholder} parity: every interpolation var in the English string must
// appear in every language's string (vu.retryIn {s}, vu.moreWaiting {n},
// vu.fallbackCountry {country}) — a dropped var renders a dangling literal.
for (const key of [...NEW_KEYS, ...AUDIT_KEYS]) {
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

console.log(`verify-upload-i18n: ${pass} checks passed`);
