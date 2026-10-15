// Public Sample Profiles — Phase 5 discovery + interaction-seam acceptance
// (plan §D10 + Phase 5):
//
//   - getFlagshipSearchRow(): built ONLY from curated (sample:true) data — an
//     adversarial non-curated doc on the flagship never enters the row; the row
//     carries isSample:true; null before the seed.
//   - buildSearchRow(): real seafarers' rows carry NO isSample key at all (their
//     serialized shape is byte-identical to before Phase 5).
//   - CONCURRENT DOUBLE-OPEN (plan R3): two simultaneous opens of
//     /share/<SAMPLE_OPEN_TOKEN> by the SAME agent mint exactly ONE grant. The
//     page's findGrant read is check-then-act and CAN race, but grantAccess
//     re-checks UNIQUE(seafarerId, agentId) INSIDE its transact critical section
//     (lib/access.ts), so the second call returns the first's grant instead of
//     minting a duplicate. This test replicates the page seam (stale reads, then
//     both grant calls in flight together) and locks that behaviour.
//
// Run: node --import ./tests/_register-sample.mjs --test tests/sample-discovery.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-discovery-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
globalThis.__TEST_COOKIES = {};

const { readDB, updateDB } = await import("@/lib/db");
const { SAMPLE_AGENCY_ID, SAMPLE_FLAGSHIP_ID, SAMPLE_OPEN_TOKEN } = await import("@/lib/sample-ids");
const { getFlagshipSearchRow } = await import("@/lib/sample-data");
const { buildSearchRow } = await import("@/lib/roster-search");
const { grantAccess, findGrant } = await import("@/lib/access");

const iso = "2026-01-01T00:00:00.000Z";
const iso2 = "2026-01-02T00:00:00.000Z";

function baseSeafarer(id, open, email, extra = {}) {
  return {
    id,
    name: `Seafarer ${id}`,
    rank: "Chief Officer",
    state: "review",
    shareToken: open,
    openShareToken: open,
    emailShareToken: email,
    allowedEmails: [],
    createdAt: iso,
    ...extra,
  };
}

function baseDoc(id, seafarerId, extra = {}) {
  return {
    id,
    seafarerId,
    title: "Certificate of Competency",
    certNumber: `SAMPLE-CN-${id}`,
    validUntil: "2030-01-01",
    fileName: `${id}.jpg`,
    createdAt: iso,
    ...extra,
  };
}

// ---- 0. Before any sample rows exist: the row is null ------------------------
// (Captured at module-load time — node:test bodies run only after the module,
// including the seeding below, has fully evaluated.)

const rowBeforeSeed = getFlagshipSearchRow();

test("getFlagshipSearchRow returns null before the sample seed has run", () => {
  assert.equal(rowBeforeSeed, null);
});

// ---- Seed a minimal curated cohort + a real tenant ---------------------------

await updateDB((db) => {
  db.agents.push(
    { id: "agent-a", orgName: "Agency A", contact: "", createdAt: iso },
    { id: "agent-b", orgName: "Agency B", contact: "", createdAt: iso },
    { id: SAMPLE_AGENCY_ID, orgName: "Sample Crewing OU", contact: "", createdAt: iso, isSample: true }
  );
  db.seafarers.push(
    baseSeafarer(SAMPLE_FLAGSHIP_ID, SAMPLE_OPEN_TOKEN, "sample-email-tok", {
      name: "Marko Saar — SAMPLE",
      rank: "2nd Officer",
      isSample: true,
      identityVerified: true,
      verifiedName: "Marko Saar — SAMPLE",
      issuerCountry: "LV",
      availability: "open",
    }),
    baseSeafarer("real-1", "open-real-1", "email-real-1", { name: "Real One" })
  );
  db.documents.push(
    baseDoc("sd-1", SAMPLE_FLAGSHIP_ID, { sample: true, title: "Certificate of Competency — SAMPLE" }),
    baseDoc("sd-2", SAMPLE_FLAGSHIP_ID, { sample: true, title: "Seafarer's Medical — SAMPLE", validUntil: "2026-02-01" }),
    // ADVERSARIAL: a real agent's later upload onto the flagship (non-curated) —
    // the search row must never count or name it.
    baseDoc("adv-1", SAMPLE_FLAGSHIP_ID, { title: "Real Upload NOT CURATED", createdAt: iso2 }),
    baseDoc("rd-1", "real-1", {})
  );
});

// ---- 1. The flagship search row: curated-only, flagged, redacted -------------

test("flagship search row is curated-only and carries isSample", () => {
  const row = getFlagshipSearchRow();
  assert.ok(row, "row must exist once the flagship is seeded");
  assert.equal(row.isSample, true);
  assert.equal(row.id, SAMPLE_FLAGSHIP_ID);
  assert.equal(row.name, "Marko Saar — SAMPLE");
  // Curated docs only — the adversarial non-curated upload is invisible.
  assert.equal(row.docCount, 2);
  assert.ok(!row.certs.some((c) => /NOT CURATED/.test(c.title)));
  // Un-granted viewers see it parked at Review (every fresh grant starts there).
  assert.equal(row.state, "review");
  // The row is a serializable projection — no token or auth field can leak.
  const banned = ["openShareToken", "emailShareToken", "shareToken", "allowedEmails"];
  for (const k of banned) assert.ok(!(k in row), `leaked ${k}`);
});

test("real seafarers' rows carry NO isSample key (shape unchanged)", () => {
  const db = readDB();
  const real = db.seafarers.find((s) => s.id === "real-1");
  const row = buildSearchRow(real, db.documents.filter((d) => d.seafarerId === "real-1"));
  assert.ok(!("isSample" in row), "real rows must not gain the key");
  const sample = db.seafarers.find((s) => s.id === SAMPLE_FLAGSHIP_ID);
  const srow = buildSearchRow(sample, []);
  assert.equal(srow.isSample, true, "buildSearchRow must propagate the flag");
});

// ---- 2. Concurrent double-open of /share/<token> (plan R3) -------------------

test("two simultaneous share-page opens by the same agent mint exactly ONE grant", async () => {
  // Replicate the page seam exactly: BOTH requests do the stale check-then-act
  // read first (both see "no grant"), and only then both call grantAccess — the
  // worst-case interleaving of share/[token]/page.tsx's auto-grant block.
  const before1 = findGrant(readDB(), SAMPLE_FLAGSHIP_ID, "agent-a");
  const before2 = findGrant(readDB(), SAMPLE_FLAGSHIP_ID, "agent-a");
  assert.equal(before1, null);
  assert.equal(before2, null);

  const [r1, r2] = await Promise.all([
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-a" }),
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-a" }),
  ]);

  const rows = readDB().accessGrants.filter(
    (g) => g.seafarerId === SAMPLE_FLAGSHIP_ID && g.agentId === "agent-a"
  );
  assert.equal(rows.length, 1, "exactly one grant row for the (seafarer, agent) pair");
  assert.equal(rows[0].status, "ACTIVE");
  assert.equal(rows[0].stage, "review");
  // Exactly one of the two racing calls actually created; the other adopted it.
  assert.deepEqual([r1.created, r2.created].sort(), [false, true]);
  assert.equal(r1.grant.id, r2.grant.id, "both calls must resolve to the SAME grant");
});

test("a later double-open of an already-granted flagship stays a no-op", async () => {
  const before = readDB().accessGrants.filter((g) => g.seafarerId === SAMPLE_FLAGSHIP_ID);
  const [r1, r2] = await Promise.all([
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-a" }),
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-a" }),
  ]);
  assert.equal(r1.created, false);
  assert.equal(r2.created, false);
  const after = readDB().accessGrants.filter((g) => g.seafarerId === SAMPLE_FLAGSHIP_ID);
  assert.equal(after.length, before.length);
});

test("a SECOND agent's open mints its own single grant — tenants stay separate", async () => {
  const [r1, r2] = await Promise.all([
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-b" }),
    grantAccess({ seafarerId: SAMPLE_FLAGSHIP_ID, agentId: "agent-b" }),
  ]);
  assert.deepEqual([r1.created, r2.created].sort(), [false, true]);
  const pairs = readDB().accessGrants.filter((g) => g.seafarerId === SAMPLE_FLAGSHIP_ID);
  assert.equal(pairs.length, 2, "one grant per agent, never more");
  assert.deepEqual(pairs.map((g) => g.agentId).sort(), ["agent-a", "agent-b"]);
});
