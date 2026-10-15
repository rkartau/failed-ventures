// #41 item 17 — employment-CSV building blocks: deterministic row ORDER (matching
// listSeafarersForAgent, the exact source the ?kind=employment route iterates) + exact
// COUNT + per-seaman SEA status, against a seeded isolated on-disk fixture. Drives the
// REAL grant-scoped listSeafarersForAgent + the REAL employmentCompleteness the route
// builds each row from (the route is a thin, deterministic map over these).
//
// Run: node --import ./tests/_register-alias.mjs tests/employment-export.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const now = "2026-07-01T00:00:00.000Z";
const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [], appraisals: [], issuedSeaTerms: [],
};
const seed = {
  ...EMPTY,
  agents: [{ id: "agent:A", orgName: "Org A", contact: "", createdAt: now }],
  // db insertion order s1, s2, s3 — the deterministic order the CSV must follow.
  seafarers: [
    { id: "s1", name: "Alpha One", rank: "Chief Officer", state: "review", shareToken: "o1", openShareToken: "o1", emailShareToken: "e1", vessel: "MV Alpha", createdAt: now },
    { id: "s2", name: "Bravo Two", rank: "Rating", state: "review", shareToken: "o2", openShareToken: "o2", emailShareToken: "e2", vessel: "MV Beta", createdAt: now },
    { id: "s3", name: "Charlie Three (no grant)", rank: "Rating", state: "review", shareToken: "o3", openShareToken: "o3", emailShareToken: "e3", createdAt: now },
  ],
  documents: [
    { id: "d1", seafarerId: "s1", title: "Seafarer's Employment Agreement", docType: "sea", source: "manual", reviewStatus: "pending", seaEndDate: null, createdAt: now },
  ],
  assignments: [
    // s1 is ASSIGNED under agent A; s2 is benched (no live assignment).
    { id: "a1", seafarerId: "s1", agentId: "agent:A", vessel: "MV Alpha", sentToSeaAt: now, returnedAt: null, createdAt: now },
  ],
  accessGrants: [
    { id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g1", grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now },
    { id: "g2", seafarerId: "s2", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g2", grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now },
  ],
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch2-export-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.writeFileSync(path.join(TMP, "data", "db.json"), JSON.stringify(seed, null, 2), "utf-8");
process.chdir(TMP);

const { readDB } = await import("@/lib/db");
const { listSeafarersForAgent } = await import("@/lib/agentData");
const { hasActiveAssignment } = await import("@/lib/access");
const { employmentContextFor, employmentCompleteness } = await import("@/lib/required-docs");

// Deterministic, grant-scoped roster: s3 (no grant) excluded; s1, s2 in db order.
const roster = listSeafarersForAgent("agent:A");
assert.equal(roster.length, 2, "only the 2 grant-scoped seamen appear (s3 has no grant)");
assert.deepEqual(roster.map((s) => s.id), ["s1", "s2"], "order follows listSeafarersForAgent (db order)");
// Re-run stable.
assert.deepEqual(listSeafarersForAgent("agent:A").map((s) => s.id), ["s1", "s2"]);
ok("employment roster: exact count (2) + deterministic order (s1, s2), re-run stable");

const db = readDB();
const rowFor = (s) => {
  const docs = db.documents.filter((d) => d.seafarerId === s.id);
  const assigned = hasActiveAssignment(s.id, "agent:A", db.assignments);
  const ec = employmentCompleteness(docs.map((d) => d.requiredType), docs, employmentContextFor(s), { assigned });
  return { assigned, ec };
};

const r1 = rowFor(roster[0]); // s1 — assigned, SEA present with null end date.
assert.equal(r1.assigned, true);
assert.deepEqual(r1.ec.unknownExpiry, ["SEA"], "s1 assigned + null-date SEA => unknown expiry");
const r2 = rowFor(roster[1]); // s2 — benched.
assert.equal(r2.assigned, false);
assert.equal(r2.ec.applicable, false, "s2 benched => not applicable");
ok("per-seaman employment status: s1 unknown-expiry SEA, s2 benched/not-applicable");

console.log(`\nemployment-export.test: ${pass} assertions passed`);
