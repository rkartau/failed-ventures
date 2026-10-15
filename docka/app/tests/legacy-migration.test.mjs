// #41/#43/#45 — pre-migration read: a legacy db.json (no new fields/collections) loads
// through the REAL readDB() with every Batch-2 field/collection backfilled to its
// default, and no throw. v4 item 3 (isolation): the fixture is staged at an ISOLATED
// temp <tmp>/data/db.json (readDB goes to DISK + writes token/stage back), a pristine
// copy is used per run (committed fixture never corrupted in place), and assertions are
// on the RETURNED DB, not on file bytes.
//
// Run: node --import ./tests/_register-alias.mjs tests/legacy-migration.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

// A deliberately LEGACY db.json: no appraisals / issuedSeaTerms collections at all, a
// seafarer with no cbaCovered/cbaRef, and a document with no seaEndDate.
const LEGACY = {
  seafarers: [
    {
      id: "s1",
      name: "Legacy Seafarer",
      rank: "Rating",
      state: "review",
      shareToken: "legacy-open-token",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
  ],
  documents: [
    {
      id: "d1",
      seafarerId: "s1",
      title: "Seafarer's Employment Agreement",
      docType: "sea",
      source: "manual",
      reviewStatus: "pending",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
  ],
  agents: [{ id: "agent:A", orgName: "Org A", contact: "", createdAt: "2024-01-01T00:00:00.000Z" }],
  // NOTE: appraisals + issuedSeaTerms collections are intentionally ABSENT.
};

// Fresh, isolated temp cwd per run (re-run-safe: pristine fixture each time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch2-migration-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.writeFileSync(path.join(TMP, "data", "db.json"), JSON.stringify(LEGACY, null, 2), "utf-8");
process.chdir(TMP);

// readDB resolves DATA_DIR at module-eval, so import AFTER chdir.
const { readDB } = await import("@/lib/db");

let db;
assert.doesNotThrow(() => {
  db = readDB();
}, "readDB() must not throw on a legacy db.json");
ok("readDB() loads a legacy db.json without throwing");

// New collections backfill to [].
assert.deepEqual(db.appraisals, [], "appraisals backfills to []");
assert.deepEqual(db.issuedSeaTerms, [], "issuedSeaTerms backfills to []");
ok("appraisals + issuedSeaTerms backfill to []");

// New seafarer fields backfill to their defaults.
const s = db.seafarers.find((x) => x.id === "s1");
assert.equal(s.cbaCovered, false, "cbaCovered backfills to false");
assert.equal(s.cbaRef, null, "cbaRef backfills to null");
ok("seafarer.cbaCovered=false + cbaRef=null on a legacy row");

// New doc field backfills to null; the SEA doc still self-heals its classifier.
const d = db.documents.find((x) => x.id === "d1");
assert.equal(d.seaEndDate, null, "seaEndDate backfills to null");
assert.equal(d.requiredType, "SEA", "legacy SEA doc auto-classifies into the tightened SEA slot");
ok("doc.seaEndDate=null on a legacy row; SEA classifier self-heals");

// Re-run safety: reading again in the same process still yields the same defaults
// (readDB's token/stage write-back is tolerated — we assert on the returned DB).
const db2 = readDB();
assert.deepEqual(db2.appraisals, []);
assert.deepEqual(db2.issuedSeaTerms, []);
assert.equal(db2.seafarers[0].cbaCovered, false);
ok("second readDB() in-process is stable (token write-back tolerated)");

console.log(`\nlegacy-migration.test: ${pass} assertions passed`);
