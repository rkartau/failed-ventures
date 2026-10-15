// i18n completeness for the password-auth UI (feat/password-signup Step 9),
// mirroring tests/verify-upload-i18n.test.mjs: every pw.* key must exist and be
// non-empty in ALL 6 languages (en/zh/ru/tl/id/vi) — this surface exists FOR
// low-English users behind blocked Google OAuth (Wei/WeChat), so a partially
// English rollout would be a silent regression for exactly its target users.
// Also pins {placeholder} parity, the zh WeChat-Favorites (收藏) tip in the
// recovery-codes ceremony copy (fold 2), and the CJK example username in
// pw.usernameHint (fold 3 — CJK must feel allowed).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/pw-i18n.test.mjs

import assert from "node:assert/strict";

const { DICT, LANGS } = await import("@/lib/i18n");

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

// The COMPLETE pw.* group (plan Step 9: base list + v5 fold-3 keys + the v6
// fold-8a key, plus the two UI-mechanical keys pw.copyAll / pw.continue the
// Step 7 ceremony + codes-lost screens need).
const PW_KEYS = [
  "pw.createTitle",
  "pw.signInTitle",
  "pw.username",
  "pw.usernameHint",
  "pw.password",
  "pw.passwordHint",
  "pw.showPassword",
  "pw.email",
  "pw.emailOptionalNote",
  "pw.create",
  "pw.signIn",
  "pw.or",
  "pw.forgot",
  "pw.recTitle",
  "pw.recBody",
  "pw.recSaved",
  "pw.recConfirm",
  "pw.recRemaining",
  "pw.recCode",
  "pw.newPassword",
  "pw.reset",
  "pw.errTaken",
  "pw.errTakenHint",
  "pw.errUserRules",
  "pw.errUserAt",
  "pw.errWeak",
  "pw.errGeneric",
  "pw.errRate",
  "pw.errNetwork",
  "pw.errRecovery",
  "pw.selfDeclaredNote",
  "pw.agentGateTitle",
  "pw.codesLostTitle",
  "pw.codesLostBody",
  // v5 (fold 3)
  "pw.dualRoleNote",
  "pw.errTakenSteer",
  "pw.lowCodes",
  "pw.changeTitle",
  "pw.changePw",
  "pw.currentPw",
  "pw.regenTitle",
  "pw.regenWarn",
  "pw.bindSideTitle",
  "pw.bindSideBody",
  "pw.claimNoToken",
  "pw.alreadyOwned",
  // v6 (fold 8a)
  "pw.pwChangedSignIn",
  // UI-mechanical (Step 7 ceremony / codes-lost screens)
  "pw.copyAll",
  "pw.continue",
  // Step 13 (wave 4) — Account section chrome
  "pw.accountTitle",
  "pw.pwChangedOk",
];

// Pre-existing keys the password forms REUSE (reuse-first): the bind-confirm
// dialog borrows the generic Confirm/Cancel labels — they must stay complete.
const REUSED_KEYS = ["sd.cancel", "row.confirm"];

assert.equal(LANGS.length, 6, "the 6-language roster is the contract this test enforces");
ok("LANGS has exactly 6 languages");

for (const key of [...PW_KEYS, ...REUSED_KEYS]) {
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
ok(`all ${PW_KEYS.length} pw.* + ${REUSED_KEYS.length} reused keys complete in all 6 languages`);

// {placeholder} parity: every interpolation var in the English string must
// appear in every language's string (pw.recRemaining {n}, pw.lowCodes {n}) —
// a dropped var renders a dangling literal.
for (const key of PW_KEYS) {
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

// Safety-critical Chinese copy (fold 2 — Wei): the recovery-codes ceremony
// suggests WeChat Favorites (收藏), which follows the WeChat account across
// phones. Pinned so a future copy edit can't silently drop it.
assert.ok(DICT["pw.recBody"].zh.includes("收藏"), "zh pw.recBody must carry the WeChat 收藏 tip");
assert.ok(DICT["pw.recSaved"].zh.includes("收藏"), "zh pw.recSaved must carry the WeChat 收藏 tip");
ok("zh recovery-codes copy carries the WeChat Favorites (收藏) tip");

// CJK-allowed signal (fold 3): pw.usernameHint shows a Chinese example username
// in EVERY language, so a CJK name visibly reads as valid everywhere.
for (const { code } of LANGS) {
  assert.ok(
    /[一-鿿]/.test(DICT["pw.usernameHint"][code]),
    `pw.usernameHint "${code}" must include a CJK example username`
  );
}
ok("pw.usernameHint shows a CJK example username in all 6 languages");

// The e-mail note must state the Nikos constraint: unverified + cannot recover
// the account (pin the English wording's two claims).
assert.ok(
  /not verified/i.test(DICT["pw.emailOptionalNote"].en) &&
    /cannot recover/i.test(DICT["pw.emailOptionalNote"].en),
  "pw.emailOptionalNote must state: not verified, cannot recover the account"
);
ok("pw.emailOptionalNote states unverified + no-recovery");

console.log(`pw-i18n: ${pass} checks passed`);
