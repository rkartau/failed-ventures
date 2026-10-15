// Headless server/pure-logic tests for Batch 1 (#30 levels, #37 merge, #38 propagation).
// Follows the registry-units.test.mjs pattern: process.chdir to a throwaway data dir
// BEFORE the dynamic @/lib imports (lib/db.ts resolves DATA_DIR at module-eval time).
//
// Run: node --import ./tests/_register-alias.mjs tests/batch1-logic.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/db-pre-migration.json", import.meta.url));

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch1-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const DATA = path.join(TMP, "data");
const DB_PATH = path.join(DATA, "db.json");

const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [],
};
function writeDb(partial) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ ...EMPTY, ...partial }, null, 2));
  // Reset the append-only sinks so each section's chain verification starts clean.
  for (const f of ["access-log.ndjson", "consent-events.ndjson", "admin-audit.ndjson"]) {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

process.chdir(TMP);

const { verificationLevelForDoc, profileVerificationSummary } = await import("@/lib/verification-level");
const { personIdentityOf, personMatchCandidates } = await import("@/lib/duplicates");
const { projectSelfProfileForGrant } = await import("@/lib/propagation");
const { mergePersons } = await import("@/lib/person-merge");
const { readDB, verifyAuditChain } = await import("@/lib/db");

// ---- #30 verification levels (allow-list, never a denylist) --------------
{
  const doc = (o) => ({ id: "d", seafarerId: "s", source: "manual", reviewStatus: "pending", ...o });
  assert.equal(verificationLevelForDoc(doc({ source: "government" })), 3);
  assert.equal(verificationLevelForDoc(doc({ source: "registry" })), 2);
  assert.equal(verificationLevelForDoc(doc({ reviewerChecked: true })), 1);
  assert.equal(verificationLevelForDoc(doc({ manualVerification: { status: "confirmed" } })), 1);
  // "requested" is pending -> L0; "closed_unavailable" is a no-answer close -> L0.
  assert.equal(verificationLevelForDoc(doc({ manualVerification: { status: "requested" } })), 0);
  assert.equal(verificationLevelForDoc(doc({ manualVerification: { status: "closed_unavailable" } })), 0);
  // A plain client-typed doc is stamped "manual" server-side -> level 0 (client source ignored).
  assert.equal(verificationLevelForDoc(doc({ source: "manual" })), 0);
  ok("#30 levels: gov=3, registry=2, reviewer/confirmed=1, requested/closed_unavailable/manual=0");
}

// ---- #30.4 profile floor must NOT gild (1 gov + 9 photos) ---------------
{
  const docs = [{ source: "government" }, ...Array.from({ length: 9 }, () => ({ source: "manual" }))]
    .map((d, i) => ({ id: "d" + i, seafarerId: "s", reviewStatus: "pending", ...d }));
  const verdict = profileVerificationSummary({ id: "s", identityVerified: true }, docs);
  assert.equal(verdict.floor, 0, "floor is the honest minimum (0), never max");
  assert.match(verdict.headline, /9 documents not yet verified/);
  ok("#30.4 profile floor: 1 gov + 9 photos -> floor 0, headline names 9 unverified");
}

// ---- #37 twins are NOT mergeable (corroborated=false + server refuses) ---
{
  writeDb({
    seafarers: [
      { id: "A", name: "Ivan Petrov", rank: "AB", state: "review", shareToken: "ta", openShareToken: "ta", emailShareToken: "tae", birthDate: "1990-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "B", name: "Igor Petrov", rank: "AB", state: "review", shareToken: "tb", openShareToken: "tb", emailShareToken: "tbe", birthDate: "1990-01-01", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const db = readDB();
  const a = db.seafarers.find((s) => s.id === "A");
  const b = db.seafarers.find((s) => s.id === "B");
  const matches = personMatchCandidates(personIdentityOf(a, []), [personIdentityOf(b, [])]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].corroborated, false, "twins (same DOB+surname, diff given) NOT corroborated");
  const res = await mergePersons("A", "B", "agent:x");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "needs corroboration");
  assert.ok(readDB().seafarers.some((s) => s.id === "B"), "nothing deleted");
  ok("#37 twins: corroborated=false, server refuses (needs corroboration), nothing deleted");
}

// ---- #37 corroborated merge + carried aliases + chains verify -----------
{
  writeDb({
    seafarers: [
      { id: "A", name: "Ivan Petrov", rank: "AB", state: "review", shareToken: "ao", openShareToken: "ao", emailShareToken: "ae", passportNo: "AB123456", allowedEmails: ["a@x"], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "B", name: "Ivan Petroff", rank: "AB", state: "review", shareToken: "bo", openShareToken: "bo", emailShareToken: "be", passportNo: "AB123456", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    documents: [{ id: "docB", seafarerId: "B", title: "COC", docType: "COC", source: "manual", reviewStatus: "pending", createdAt: "2026-01-02T00:00:00.000Z" }],
  });
  const res = await mergePersons("A", "B", "agent:x");
  assert.equal(res.ok, true, "shared passport -> corroborated -> merges");
  const db = readDB();
  assert.ok(!db.seafarers.some((s) => s.id === "B"), "absorbed deleted");
  const survivor = db.seafarers.find((s) => s.id === "A");
  assert.ok((survivor.mergedFrom ?? []).includes("B"), "mergedFrom records absorbed id");
  assert.ok(db.documents.find((d) => d.id === "docB").seafarerId === "A", "doc reassigned to survivor");
  // #6 — carried aliases preserve their ORIGINAL mode (email stays email).
  const prior = survivor.priorShareTokens ?? [];
  assert.ok(prior.some((p) => p.token === "be" && p.mode === "email"), "absorbed email token carried as EMAIL alias");
  assert.ok(prior.some((p) => p.token === "bo" && p.mode === "open"), "absorbed open token carried as OPEN alias");
  // The gate reads the SURVIVOR's allow-list (a@x), not the absorbed's.
  assert.deepEqual(survivor.allowedEmails, ["a@x"], "survivor allow-list is authoritative post-merge");
  // All three append-only chains still verify (we only appended).
  for (const sink of ["access-log", "consent-events", "admin-audit"]) {
    assert.equal(verifyAuditChain(sink).ok, true, `${sink} chain verifies post-merge`);
  }
  // admin-audit tail carries the PERSON_MERGE marker + an archive hash.
  const auditLines = fs.readFileSync(path.join(DATA, "admin-audit.ndjson"), "utf-8").trim().split("\n");
  const tail = JSON.parse(auditLines[auditLines.length - 1]);
  assert.equal(tail.action, "PERSON_MERGE");
  assert.ok(typeof tail.archiveHash === "string" && tail.archiveHash.length === 64);
  // The merge archive holds the absorbed record (reversibility).
  assert.ok(fs.existsSync(path.join(DATA, "merge-archive.ndjson")), "merge-archive.ndjson written");
  ok("#37 corroborated merge: absorbed deleted, docs/aliases carried, 3 chains verify, PERSON_MERGE + archiveHash");
}

// ---- #5 double-submit idempotency (one merge, chains verify) ------------
{
  writeDb({
    seafarers: [
      { id: "A", name: "Ivan Petrov", rank: "AB", state: "review", shareToken: "ao", openShareToken: "ao", emailShareToken: "ae", passportNo: "PP9", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "B", name: "Ivan Petroff", rank: "AB", state: "review", shareToken: "bo", openShareToken: "bo", emailShareToken: "be", passportNo: "PP9", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const [r1, r2] = await Promise.all([mergePersons("A", "B", "agent:x"), mergePersons("A", "B", "agent:x")]);
  const okCount = [r1, r2].filter((r) => r.ok).length;
  assert.equal(okCount, 1, "exactly ONE merge succeeds");
  const failed = [r1, r2].find((r) => !r.ok);
  assert.equal(failed.reason, "record not found", "second call finds absorbed already gone");
  assert.equal(readDB().seafarers.filter((s) => s.id === "B").length, 0, "absorbed deleted exactly once");
  for (const sink of ["access-log", "consent-events", "admin-audit"]) {
    assert.equal(verifyAuditChain(sink).ok, true, `${sink} verifies after double-submit`);
  }
  ok("#5 double-submit: one ok / one 'record not found', deleted once, all chains verify");
}

// ---- #7 LOCKED (at sea) blocks the merge, both directions ---------------
{
  const grant = (id, sf) => ({ id, seafarerId: sf, agentId: "ag", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile"], shareToken: id + "tok", grantedAt: "2026-01-02T00:00:00.000Z", revokedAt: null, expiresAt: null, createdAt: "2026-01-02T00:00:00.000Z" });
  writeDb({
    seafarers: [
      { id: "A", name: "Ivan Petrov", rank: "AB", state: "review", shareToken: "ao", openShareToken: "ao", emailShareToken: "ae", passportNo: "LK1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "B", name: "Ivan Petroff", rank: "AB", state: "review", shareToken: "bo", openShareToken: "bo", emailShareToken: "be", passportNo: "LK1", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    agents: [{ id: "ag", orgName: "Oceanic Crewing", contact: "x", createdAt: "2026-01-01T00:00:00.000Z" }],
    accessGrants: [grant("gA", "A"), grant("gB", "B")],
    assignments: [{ id: "asgB", seafarerId: "B", agentId: "ag", vessel: "MV Test", sentToSeaAt: "2026-02-01T00:00:00.000Z", returnedAt: null, createdAt: "2026-02-01T00:00:00.000Z" }],
  });
  const res = await mergePersons("A", "B", "agent:x");
  assert.equal(res.ok, false);
  assert.match(res.reason, /locked by Oceanic Crewing/);
  assert.ok(readDB().seafarers.some((s) => s.id === "B"), "locked absorbed not deleted");
  ok("#7 LOCKED absorbed (at sea) -> merge refused naming the agency, nothing deleted");
}

// ---- #38 propagation projection: opt-out default strips the overlay -----
{
  const sp = { phone: "+372 5", email: "s@x", bankAccount: "EE1", nextOfKinName: "Kin" };
  assert.equal(projectSelfProfileForGrant(sp, { propagateContact: false, propagateFinancial: false }), undefined, "both off -> undefined");
  const contactOnly = projectSelfProfileForGrant(sp, { propagateContact: true, propagateFinancial: false });
  assert.deepEqual(contactOnly, { phone: "+372 5", email: "s@x" }, "contact bucket only -> financial+NOK stripped");
  const finOnly = projectSelfProfileForGrant(sp, { propagateContact: false, propagateFinancial: true });
  assert.deepEqual(finOnly, { bankAccount: "EE1", nextOfKinName: "Kin" }, "financial bucket only -> contact stripped");
  ok("#38 projection: both-off=undefined; contact-only strips bank/NOK; financial-only strips contact");
}

// ---- #8 pre-migration fixture: tolerant read, opt-out default, no throw --
{
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
  fs.writeFileSync(DB_PATH, JSON.stringify(fixture, null, 2));
  const db = readDB(); // must NOT throw
  const grant = db.accessGrants.find((g) => g.id === "legacy-grant-1");
  assert.equal(grant.propagateContact, false, "legacy grant defaults propagateContact false");
  assert.equal(grant.propagateFinancial, false, "legacy grant defaults propagateFinancial false");
  const sf = db.seafarers.find((s) => s.id === "legacy-sf-1");
  assert.equal(sf.passportNo, null);
  assert.equal(sf.seamanBookNo, null);
  assert.deepEqual(sf.mergedFrom, []);
  // projectSelfProfileForGrant on a legacy grant -> undefined (opt-out).
  assert.equal(projectSelfProfileForGrant(sf.selfProfile, grant), undefined);
  // personIdentityOf tolerates the legacy row (no throw, null id fields).
  const pid = personIdentityOf(sf, []);
  assert.equal(pid.dob, null);
  assert.equal(pid.passportNo, null);
  assert.equal(pid.seamanBookNo, null);
  ok("#8 pre-migration fixture: readDB tolerant + opt-out default, projection undefined, personIdentityOf nulls");
}

// ---- #38.5 propagation-request projection: shared by /me AND ?token= paths --
// The QA gap was that a session-signed-in seaman dropped pending requests because
// /api/seafarers/me never returned them. Both paths now call the ONE pure projection
// below, so testing it proves parity: an agent-raised request appears identically on
// the session (/me) and token (?token=) paths.
{
  const { pendingPropagationRequestsForSeafarer } = await import("@/lib/propagation");
  const agents = [
    { id: "ag1", orgName: "Oceanic Crewing" },
    { id: "ag2", orgName: "Baltic Marine" },
  ];
  // What the agent-side POST /api/access/propagation/request writes: a PENDING request.
  // Plus a DECIDED one (must be excluded) and one for ANOTHER seaman (must be excluded).
  const requests = [
    { id: "r1", seafarerId: "S", agentId: "ag1", bucket: "contact", requestedBy: "Maria", status: "pending", createdAt: "2026-01-01T00:00:00.000Z", decidedAt: null },
    { id: "r2", seafarerId: "S", agentId: "ag2", bucket: "financial", requestedBy: "Olena", status: "pending", createdAt: "2026-01-02T00:00:00.000Z", decidedAt: null },
    { id: "r3", seafarerId: "S", agentId: "ag1", bucket: "contact", requestedBy: "Maria", status: "approved", createdAt: "2026-01-03T00:00:00.000Z", decidedAt: "2026-01-04T00:00:00.000Z" },
    { id: "r4", seafarerId: "OTHER", agentId: "ag1", bucket: "contact", requestedBy: "Maria", status: "pending", createdAt: "2026-01-05T00:00:00.000Z", decidedAt: null },
  ];
  const view = pendingPropagationRequestsForSeafarer("S", requests, agents);
  assert.equal(view.length, 2, "only THIS seaman's PENDING requests are returned");
  assert.deepEqual(view.map((v) => v.id).sort(), ["r1", "r2"], "decided + other-seaman requests excluded");
  const r1 = view.find((v) => v.id === "r1");
  assert.deepEqual(
    r1,
    { id: "r1", agentId: "ag1", orgName: "Oceanic Crewing", bucket: "contact", requestedBy: "Maria" },
    "projection enriches org name into the client shape"
  );
  // An unknown agentId falls back to the raw id (never throws / drops the row).
  const orphan = pendingPropagationRequestsForSeafarer("S", [
    { id: "r5", seafarerId: "S", agentId: "gone", bucket: "contact", requestedBy: "X", status: "pending", createdAt: "2026-01-06T00:00:00.000Z", decidedAt: null },
  ], agents);
  assert.equal(orphan[0].orgName, "gone", "missing agency -> falls back to id, row still shown");
  ok("#38.5 request projection: pending-only, tenant-scoped, org-name enriched — one shared source for /me + ?token=");
}

console.log(`\n${pass} sections passed.`);
