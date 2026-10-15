// Pure unit test + ACCEPTANCE GATE for lib/fuzzy-name.ts (#37, §0 #4-critic). Runs on
// plain node with the @/* alias hook; no server, deterministic.
//
// Run: node --import ./tests/_register-alias.mjs tests/fuzzy-name.test.mjs

import assert from "node:assert/strict";
import {
  foldDiacritics,
  levenshtein,
  tokenSetRatio,
  phoneticKey,
  nameNearExact,
  nameFuzzy,
} from "@/lib/fuzzy-name";

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

// ---- foldDiacritics -----------------------------------------------------
assert.equal(foldDiacritics("Nguyễn"), "Nguyen");
assert.equal(foldDiacritics("Jörg"), "Jorg");
ok("foldDiacritics strips combining marks (Nguyễn -> Nguyen, Jörg -> Jorg)");

// ---- levenshtein --------------------------------------------------------
assert.equal(levenshtein("kitten", "sitting"), 3);
assert.equal(levenshtein("abc", "abc"), 0);
assert.equal(levenshtein("", "abc"), 3);
ok("levenshtein basic distances");

// ---- POSITIVE phonetic pairs (map EQUAL, or match via lev/token rules) ---
assert.equal(phoneticKey("Aleksandr"), phoneticKey("Alexander"), "Aleksandr==Alexander");
assert.equal(phoneticKey("Ivanov"), phoneticKey("Ivanoff"), "Ivanov==Ivanoff");
assert.equal(phoneticKey("Mohammed"), phoneticKey("Muhammad"), "Mohammed==Muhammad");
assert.ok(nameFuzzy("Nguyễn", "Nguyen"), "Nguyễn~Nguyen (folded)");
ok("POSITIVE: Aleksandr/Alexander, Ivanov/Ivanoff, Mohammed/Muhammad map equal; Nguyễn~Nguyen");

// nameFuzzy catches all four positive pairs
assert.ok(nameFuzzy("Aleksandr", "Alexander"));
assert.ok(nameFuzzy("Ivanov", "Ivanoff"));
assert.ok(nameFuzzy("Mohammed", "Muhammad"));
ok("nameFuzzy flags every positive transliteration pair");

// ---- NEGATIVE: must NOT collapse ----------------------------------------
assert.notEqual(phoneticKey("Petrov"), phoneticKey("Popov"), "Petrov!=Popov");
assert.ok(!nameFuzzy("Petrov", "Popov"), "Petrov not fuzzy-equal Popov");
assert.notEqual(phoneticKey("Johnson"), phoneticKey("Jackson"), "Johnson!=Jackson");
assert.ok(!nameFuzzy("Johnson", "Jackson"), "Johnson not fuzzy-equal Jackson");
ok("NEGATIVE: Petrov≠Popov, Johnson≠Jackson (no false collapse)");

// Two distinct romanised CJK names — phonetics must NOT false-merge them (they can only
// ever match via DOB/code, never here).
assert.notEqual(phoneticKey("Li Wei"), phoneticKey("Wang Fang"), "Li Wei != Wang Fang key");
assert.ok(!nameFuzzy("Li Wei", "Wang Fang"), "Li Wei not fuzzy-equal Wang Fang");
// Two DISTINCT CJK names never collide on a shared empty key.
const kA = phoneticKey("李伟");
const kB = phoneticKey("王芳");
assert.ok(kA === "" && kB === "", "non-Latin phoneticKey is empty (never a false key)");
ok("NEGATIVE: two distinct CJK names do not collapse (phonetics never false-merges them)");

// ---- tokenSetRatio ------------------------------------------------------
assert.equal(tokenSetRatio("Ivan Petrov", "Petrov Ivan"), 1);
assert.ok(tokenSetRatio("Ivan Petrov", "Ivan Popov") < 0.8);
ok("tokenSetRatio order-insensitive (==1) and low on a differing surname");

// ---- nameNearExact (the narrow mergeable full-name tier) ----------------
assert.ok(nameNearExact("Ivan Petrov", "Petrov Ivan"), "order-insensitive exact tokens");
assert.ok(nameNearExact("Aleksandr Ivanov", "Aleksander Ivanov"), "lev<=1 spelling variant");
assert.ok(!nameNearExact("Ivan Petrov", "Igor Petrov"), "different given name is NOT near-exact");
ok("nameNearExact: same full name (reordered / 1-char) yes; different given name no");

console.log(`\n${pass} checks passed.`);
