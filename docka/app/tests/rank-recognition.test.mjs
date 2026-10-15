// #13 — multi-language rank recognition + "rank never blocks" guarantees.
// Run: node --import ./tests/_register-alias.mjs tests/rank-recognition.test.mjs
import assert from "node:assert/strict";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const { normalizeRank, requiredSetFor } = await import("@/lib/required-docs");
const { assignmentBlockers } = await import("@/lib/compliance");

// ---- Estonian / abbreviation aliases map to the canonical rank -----------
{
  assert.equal(normalizeRank("madrus"), "rating");
  assert.equal(normalizeRank("kapten"), "master");
  assert.equal(normalizeRank("vanemtüürimees"), "chief_officer");
  assert.equal(normalizeRank("tüürimees"), "deck_officer");
  assert.equal(normalizeRank("vanemmehaanik"), "chief_engineer");
  assert.equal(normalizeRank("mehaanik"), "engineer_officer");
  assert.equal(normalizeRank("kadett"), "cadet");
  ok("Estonian aliases → canonical (madrus/kapten/vanemtüürimees/tüürimees/vanemmehaanik/mehaanik/kadett)");
}

// ---- Case-insensitive + senior-first (no over-match by the junior key) ---
{
  assert.equal(normalizeRank("VANEMTÜÜRIMEES"), "chief_officer");
  assert.equal(normalizeRank("Vanemmehaanik"), "chief_engineer");
  assert.equal(normalizeRank("Vahitüürimees (OOW)"), "deck_officer");
  assert.equal(normalizeRank("praktikant"), "cadet");
  assert.equal(normalizeRank("motorist"), "engineer_officer");
  assert.equal(normalizeRank("pootsman"), "rating");
  ok("aliases are case-insensitive; senior compound (vanem…) wins over the junior word");
}

// ---- Existing English patterns unchanged --------------------------------
{
  assert.equal(normalizeRank("OOW"), "deck_officer");
  assert.equal(normalizeRank("Master"), "master");
  assert.equal(normalizeRank("Able Seaman"), "rating");
  ok("existing English patterns intact (OOW→deck_officer, Master→master, Able Seaman→rating)");
}

// ---- Unrecognised / absent rank => null (never fabricated) ---------------
{
  assert.equal(normalizeRank("CEO"), null);
  assert.equal(normalizeRank(""), null);
  assert.equal(normalizeRank(null), null);
  assert.equal(normalizeRank("   "), null);
  ok('CEO / blank / null / whitespace → null (still unrecognised, no over-match)');
}

// ---- Rank ALONE never blocks assignment ---------------------------------
{
  // A null (unknown) rank yields the universal-only set and NEVER a rank block.
  const reqNull = requiredSetFor({ rank: null });
  assert.equal(reqNull.rankKey, null);
  assert.equal(reqNull.blockAssignment, false, "null rank must NOT set blockAssignment");

  const reqCeo = requiredSetFor({ rank: "CEO" });
  assert.equal(reqCeo.rankKey, null);
  assert.equal(reqCeo.blockAssignment, false, "unrecognised rank must NOT set blockAssignment");

  // A recognisable rank still yields its accurate per-rank set (officer → Endorsement).
  const reqMaster = requiredSetFor({ rank: "kapten" });
  assert.equal(reqMaster.rankKey, "master");
  assert.ok(reqMaster.required.includes("Endorsement"), "recognised officer keeps the accurate set");

  ok("requiredSetFor: null/unknown rank never blocks; a recognised alias still tailors the set");
}

// ---- assignmentBlockers: rankIncomplete signal alone never blocks --------
{
  // Every universal required document present + valid, but the rank is "incomplete":
  // the block must be driven ONLY by real document issues, so this is NOT blocked.
  const future = "2099-01-01";
  const docs = [
    { title: "Passport", requiredType: "Passport", validUntil: future },
    { title: "Seaman book", requiredType: "Seaman book", validUntil: future },
    { title: "Medical", requiredType: "Medical", validUntil: future },
    { title: "Basic Safety Training", requiredType: "Basic Safety Training", validUntil: future },
  ];
  const b = assignmentBlockers(docs, {
    required: ["Passport", "Seaman book", "Medical", "Basic Safety Training"],
    rankIncomplete: true, // legacy signal — must no longer contribute to `blocked`
  });
  assert.equal(b.blocked, false, "rankIncomplete alone must not block when documents are complete");
  assert.deepEqual(b.reasons, [], "no rank reason is produced");
  ok("assignmentBlockers: rankIncomplete alone never blocks and produces no reason");
}

console.log(`\nrank-recognition.test: ${pass} assertions passed`);
