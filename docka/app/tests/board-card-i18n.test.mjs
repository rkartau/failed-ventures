// i18n completeness for the B2 board-card redesign (plan Phase 3/4): the whole
// board.* key group must exist in ALL 6 languages (en/zh/ru/tl/id/vi). Follows
// the tests/sample-i18n.test.mjs contract exactly:
//   - key roster pinned here (a new board.* key not listed below fails the sweep);
//   - no key may still be an English PLACEHOLDER (a non-en value byte-equal to en
//     is only legal where the English word IS the natural loanword — EN_OK);
//   - {placeholder} parity across languages.
//
// Floor words are deliberately NOT in this group (R1-1): they reuse the shipped
// LEVEL_META.short strings from lib/verification-level.ts, never re-keyed.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/board-card-i18n.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

// The complete B2 group (plan Phase-3 enumeration + the R1-4 bare-package key).
const BOARD_KEYS = [
  "board.legend",
  "board.allClear",
  "board.cell.docs",
  "board.cell.docsTip",
  "board.cell.gov",
  "board.cell.govPend",
  "board.cell.govTip",
  "board.cell.req",
  "board.cell.reqTip",
  "board.cell.empBenched",
  "board.cell.empTip",
  "board.cell.empReconfirm",
  "board.strip.expired",
  "board.strip.expiring",
  "board.strip.missing",
  "board.strip.unknownExpiry",
  "board.strip.requestOverdue",
  "board.strip.employmentGap",
  "board.strip.more",
  "board.strip.packageReady",
  "board.strip.packageReadyBare",
  "board.strip.atSea",
  "board.review",
  "board.removeFromBoard",
  "board.removeAtSeaTip",
  "board.removeTip",
  "board.menuLabel",
  // Unclaimed roster placeholders — claim-status chip + claim panel (22 keys).
  "board.claim.claimed",
  "board.claim.claimedTip",
  "board.claim.pending",
  "board.claim.pendingTip",
  "board.claim.opened",
  "board.claim.openedTip",
  "board.claim.linkStaleTip",
  "board.claim.copyLink",
  "board.claim.copied",
  "board.claim.refresh",
  "board.claim.refreshed",
  "board.claim.emailLabel",
  "board.claim.emailSave",
  "board.claim.emailSaved",
  "board.claim.emailInvalid",
  "board.claim.send",
  "board.claim.sendNoEmail",
  "board.claim.sentEmailed",
  "board.claim.sentRecorded",
  "board.claim.sendFailed",
  "board.claim.panelTitle",
  "board.claim.panelBody",
];

// (key, lang) pairs where the English string is the natural rendering in that
// language (established loanword). Every board.* string was actually translated,
// so the set is empty; add pairs here ONLY with a loanword justification.
const EN_OK = new Set([]);

test("LANGS roster is still the 6-language contract", () => {
  assert.equal(LANGS.length, 6);
});

test("every board.* key is complete in all 6 languages", () => {
  for (const key of BOARD_KEYS) {
    const entry = DICT[key];
    assert.ok(entry, `missing dict entry: ${key}`);
    for (const { code } of LANGS) {
      assert.equal(typeof entry[code], "string", `${key} is missing its "${code}" translation`);
      assert.ok(entry[code].trim().length > 0, `${key} has an empty "${code}" translation`);
    }
  }
});

test("no key is still an English placeholder", () => {
  for (const key of BOARD_KEYS) {
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
  for (const key of BOARD_KEYS) {
    const entry = DICT[key];
    const en = holes(entry.en);
    for (const { code } of LANGS) {
      assert.deepEqual(holes(entry[code]), en, `${key}."${code}" placeholder mismatch`);
    }
  }
});

test("the DICT contains no board.* key this test does not know about", () => {
  const known = new Set(BOARD_KEYS);
  const strays = Object.keys(DICT).filter((k) => k.startsWith("board.") && !known.has(k));
  assert.deepEqual(strays, [], "new board.* keys must be added to BOARD_KEYS here");
});
