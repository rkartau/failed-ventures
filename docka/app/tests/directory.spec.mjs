// Batch 3 (#49) — docka-verified directory inclusion / withdrawal [V1/V5/C4/C8/R49.10/12].
//
// The inclusion gate reads STORED fields ONLY: a seaman is listed iff directoryOptIn
// AND identityVerified AND at least one grant with directoryConsent===true whose STORED
// status==="ACTIVE" and not past expiresAt. It DELIBERATELY never uses
// effectiveGrantStatus / effectiveLegalBasis (which alias EXPIRED/REVOKED/PENDING as
// CONSENT and mask a REVOKED mid-voyage grant as LOCKED). This asserts the seaman is
// listed ONLY in the all-true case, and removed for each withdrawal / non-ACTIVE path —
// including the critic BLOCKER (grant REVOKED but a live assignment makes
// effectiveGrantStatus resolve LOCKED -> must STILL be excluded). Plus: only projected
// rows leave the server (never a raw RosterSearchRow), and text is min-2 / max-64 bound.
//
// Disk-backed in an ISOLATED temp cwd (never the real data/db.json).
// Run: node --import ./tests/_register-alias.mjs tests/directory.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Salts before importing the directory (surfaceRef is lazy, but set them up front).
process.env.PORTAL_REF_SALT = "portal-salt-dir-spec";
process.env.DIRECTORY_REF_SALT = "directory-salt-dir-spec";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch3-directory-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const DB_PATH = path.join(TMP, "data", "db.json");
process.chdir(TMP);

const { searchDirectory } = await import("@/lib/directory");
const { surfaceRef } = await import("@/lib/surface-ref");
const { effectiveGrantStatus, isReadableStatus } = await import("@/lib/access");

const NOW = new Date("2026-07-21T00:00:00.000Z");
const DREF = surfaceRef("s1", "directory");

const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [], appraisals: [], issuedSeaTerms: [],
  clientPortals: [], vacancies: [],
};

function base() {
  return {
    ...structuredClone(EMPTY),
    agents: [{ id: "agent:A", orgName: "Alpha Crewing", contact: "", createdAt: "2026-01-01T00:00:00.000Z" }],
    seafarers: [{
      id: "s1", name: "Priya Sharma", rank: "Rating", state: "review",
      shareToken: "o-s1", openShareToken: "o-s1", emailShareToken: "e-s1",
      identityVerified: true, directoryOptIn: true, birthDate: "1985-06-15T00:00:00.000Z",
      issuerCountry: "Eesti", vessel: "MV Alpha", selfProfile: {}, allowedEmails: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    documents: [{
      id: "d1", seafarerId: "s1", title: "Medical certificate", docType: "Medical", docCategory: "medical",
      estonianCode: null, certNumber: "MED-1", isValid: true, validUntil: "2027-06-01T00:00:00.000Z",
      fileName: null, createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType: "Medical",
      reviewStatus: "pending",
    }],
    accessGrants: [{
      id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
      scope: ["profile", "documents", "log"], shareToken: "g1", grantedAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null, expiresAt: null, createdAt: "2026-01-02T00:00:00.000Z",
      directoryConsent: true, clientVisible: false,
    }],
  };
}

function run(mutate) {
  const db = base();
  if (mutate) mutate(db);
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  const res = searchDirectory({}, { now: NOW });
  assert.equal(res.ok, true, "searchDirectory ok");
  return { db, listed: res.rows.some((r) => r.ref === DREF), rows: res.rows };
}

// ---- all-true -> LISTED ---------------------------------------------------
{
  const { listed, rows } = run(null);
  assert.equal(listed, true, "all-true seaman IS listed");
  assert.equal(rows.length, 1, "exactly one directory row");
  ok("listed: directoryOptIn + identityVerified + stored-ACTIVE consenting grant -> LISTED [V1/V5]");
}

// ---- each exclusion path -> NOT listed ------------------------------------
{
  assert.equal(run((db) => { db.seafarers[0].directoryOptIn = false; }).listed, false, "seaman opt-in off -> excluded");
  ok("withdrawal (1): seaman directoryOptIn OFF -> not listed");

  assert.equal(run((db) => { db.accessGrants[0].directoryConsent = false; }).listed, false, "agency consent off -> excluded");
  ok("withdrawal (2): agency directoryConsent OFF -> not listed");

  assert.equal(run((db) => { db.accessGrants[0].status = "REVOKED"; db.accessGrants[0].revokedAt = "2026-06-01T00:00:00.000Z"; }).listed, false, "REVOKED no-assignment -> excluded");
  ok("withdrawal (3): grant REVOKED (no assignment) -> not listed");

  // BLOCKER [V1]: grant REVOKED but a LIVE assignment makes effectiveGrantStatus resolve
  // LOCKED (readable) — the directory MUST STILL exclude, because it reads STORED status.
  {
    const r = run((db) => {
      db.accessGrants[0].status = "REVOKED";
      db.accessGrants[0].revokedAt = "2026-06-01T00:00:00.000Z";
      db.assignments = [{ id: "a1", seafarerId: "s1", agentId: "agent:A", vessel: "MV Alpha", sentToSeaAt: "2026-05-01T00:00:00.000Z", returnedAt: null, createdAt: "2026-05-01T00:00:00.000Z" }];
    });
    const g = r.db.accessGrants[0];
    const eff = effectiveGrantStatus(g, r.db.assignments, NOW.getTime());
    assert.equal(eff.status, "LOCKED", "sanity: effectiveGrantStatus masks the REVOKED mid-voyage grant as LOCKED");
    assert.equal(isReadableStatus(eff.status), true, "sanity: LOCKED is a readable status");
    assert.equal(r.listed, false, "BLOCKER: REVOKED + live assignment (effective LOCKED) is STILL excluded [V1]");
    ok("withdrawal (4): grant REVOKED WITH a live assignment (effective LOCKED) -> STILL not listed [V1 blocker]");
  }

  assert.equal(run((db) => { db.accessGrants[0].expiresAt = "2026-01-01T00:00:00.000Z"; }).listed, false, "lapsed ACTIVE -> excluded");
  ok("withdrawal (5): stored-ACTIVE grant past expiresAt (lapsed, unswept) -> not listed [V5]");

  assert.equal(run((db) => { db.accessGrants[0].status = "EXPIRED"; }).listed, false, "stored EXPIRED -> excluded");
  ok("withdrawal (6): grant stored EXPIRED -> not listed [V5]");

  assert.equal(run((db) => { db.accessGrants[0].status = "PENDING"; }).listed, false, "PENDING -> excluded");
  ok("withdrawal (7): grant PENDING (not-yet-approved) -> not listed [V5]");

  assert.equal(run((db) => { db.seafarers[0].identityVerified = false; }).listed, false, "identity-unverified -> excluded");
  ok("inclusion: identity-UNVERIFIED seaman excluded even with all consent [R49.12]");
}

// ---- projected rows only (never a raw RosterSearchRow) [R49.10] -----------
{
  const { rows } = run(null);
  const row = rows[0];
  // Allow-list projection fields present.
  for (const k of ["ref", "name", "rank", "issuingCountry", "verificationFloor", "sourcingAgencies"]) {
    assert.ok(k in row, `projected row carries ${k}`);
  }
  // Raw RosterSearchRow internals (id / certs / state / rotationEnd) must NEVER cross —
  // the directory projection is a ClientCrewRow, not a RosterSearchRow.
  assert.ok(!("id" in row), "no raw seafarer id on the directory row [R49.10]");
  assert.ok(!("certs" in row), "no raw certs array on the directory row [R49.10]");
  assert.ok(!("state" in row), "no raw pipeline state on the directory row [R49.10]");
  assert.ok(!("rotationEnd" in row), "no raw rotationEnd on the directory row [R49.10]");
  // Attribution is the agency ORG name (lead routing), never the agentId.
  assert.deepEqual(row.sourcingAgencies, ["Alpha Crewing"], "sourcingAgencies is the org name (not agentId) [R49.11]");
  ok("server-side: only the projected ClientCrewRow leaves the server, never a raw RosterSearchRow [R49.10]");
}

// ---- text bound: min-2 AND max-64 [C8] ------------------------------------
{
  fs.writeFileSync(DB_PATH, JSON.stringify(base(), null, 2));
  assert.deepEqual(searchDirectory({ text: "a" }, { now: NOW }), { ok: false, error: "text-too-short" }, "1-char text rejected");
  assert.deepEqual(searchDirectory({ text: "x".repeat(65) }, { now: NOW }), { ok: false, error: "text-too-long" }, "65-char text rejected");
  const hit = searchDirectory({ text: "Pri" }, { now: NOW });
  assert.equal(hit.ok, true);
  assert.equal(hit.rows.some((r) => r.ref === DREF), true, "a valid substring (>=2) still finds the seaman");
  const miss = searchDirectory({ text: "Zzz" }, { now: NOW });
  assert.equal(miss.rows.length, 0, "a non-matching text returns no rows (server-side filtered)");
  ok("bounds: directory text is min-2 AND max-64; a valid substring filters server-side [C8]");
}

console.log(`\ndirectory.spec: ${pass} sections passed`);
