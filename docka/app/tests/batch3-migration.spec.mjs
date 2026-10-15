// Batch 3 (#42/#49/#52) — pre-migration legacy read [C7].
//
// A legacy db.json with NO clientPortals / vacancies collections, grants with no
// directoryConsent / clientVisible, and seafarers with no directoryOptIn loads through
// the REAL readDB() with every Batch-3 field/collection backfilled to its FAIL-CLOSED
// default and NO throw. Staged in an ISOLATED temp <tmp>/data/db.json (readDB goes to
// disk + may write token/stage back); a pristine copy per run; assertions on the
// RETURNED DB, not on file bytes.
//
// Run: node --import ./tests/_register-alias.mjs tests/batch3-migration.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

// Deliberately LEGACY: no clientPortals/vacancies keys at all; a grant with no
// directoryConsent/clientVisible; a seafarer with no directoryOptIn.
const LEGACY = {
  seafarers: [
    { id: "s1", name: "Legacy Seaman", rank: "Rating", state: "review", shareToken: "legacy-open", createdAt: "2024-01-01T00:00:00.000Z" },
  ],
  documents: [],
  agents: [{ id: "agent:A", orgName: "Legacy Crewing", contact: "", createdAt: "2024-01-01T00:00:00.000Z" }],
  accessGrants: [
    {
      id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
      scope: ["profile", "documents", "log"], shareToken: "g1tok", grantedAt: "2024-01-02T00:00:00.000Z",
      revokedAt: null, expiresAt: null, createdAt: "2024-01-02T00:00:00.000Z",
    },
  ],
  // NOTE: clientPortals + vacancies collections are intentionally ABSENT.
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch3-migration-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.writeFileSync(path.join(TMP, "data", "db.json"), JSON.stringify(LEGACY, null, 2), "utf-8");
process.chdir(TMP);

// readDB resolves DATA_DIR at module-eval, so import AFTER chdir.
const { readDB } = await import("@/lib/db");

let db;
assert.doesNotThrow(() => { db = readDB(); }, "readDB() must not throw on a Batch-3-legacy db.json");
ok("readDB() loads a Batch-3-legacy db.json without throwing");

// New collections backfill to [].
assert.deepEqual(db.clientPortals, [], "clientPortals backfills to []");
assert.deepEqual(db.vacancies, [], "vacancies backfills to []");
ok("clientPortals + vacancies backfill to []");

// New consent fields read OFF (fail-closed) on legacy rows.
const s = db.seafarers.find((x) => x.id === "s1");
assert.equal(s.directoryOptIn, false, "legacy seafarer.directoryOptIn defaults FALSE (fail-closed)");
const g = db.accessGrants.find((x) => x.id === "g1");
assert.equal(g.directoryConsent, false, "legacy grant.directoryConsent defaults FALSE (fail-closed)");
assert.equal(g.clientVisible, false, "legacy grant.clientVisible defaults FALSE (fail-closed)");
ok("every Batch-3 consent field reads OFF on a legacy row (directoryOptIn / directoryConsent / clientVisible)");

// Re-read in-process is stable (token/stage write-back tolerated).
const db2 = readDB();
assert.deepEqual(db2.clientPortals, []);
assert.deepEqual(db2.vacancies, []);
assert.equal(db2.accessGrants[0].directoryConsent, false);
assert.equal(db2.seafarers[0].directoryOptIn, false);
ok("second readDB() in-process is stable (defaults hold, no throw)");

console.log(`\nbatch3-migration.spec: ${pass} assertions passed`);
