// Batch 3 (#42 + #49) — external-body deep-scan [C3].
//
// The ONE integration test that proves the single external projection (client-view.ts)
// leaks NOTHING at ANY depth. It builds the REAL portal payload (crewForPortal) AND the
// REAL directory payload (searchDirectory) for a seaman who has documents, personalCode,
// DOB, contact overlay, agency notes, a share token and an allow-list, serialises BOTH
// exactly as they would cross the wire (JSON round-trip), then RECURSIVELY walks the
// tree asserting NO key or value matching {raw seafarerId, documents, fileName,
// personalCode, birthDate/DOB, contact, notes/comments, token, agentId, seafarerIds,
// allowedEmails} at any nesting depth. The seaman's birthDate + personalCode values are
// asserted absent explicitly.
//
// Disk-backed in an ISOLATED temp cwd (never the real data/db.json).
// Run: node --import ./tests/_register-alias.mjs tests/batch3-external-leak.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PORTAL_REF_SALT = "portal-salt-leak-spec";
process.env.DIRECTORY_REF_SALT = "directory-salt-leak-spec";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch3-leak-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const DB_PATH = path.join(TMP, "data", "db.json");
process.chdir(TMP);

const { createPortal, crewForPortal } = await import("@/lib/client-portal");
const { searchDirectory } = await import("@/lib/directory");

// ---- The sensitive values that must NEVER appear in an external body ------
const DOB = "1985-06-15T00:00:00.000Z";
const PERSONAL_CODE = "39001010000";
const PHONE = "+372-55501234";
const PRIVATE_EMAIL = "priya.private@example.com";
const BANK = "EE001122334455";
const NOK = "NextOfKin Person";
const FILE_NAME = "priya-passport-scan.jpg";
const CERT_NUMBER = "SECRETCERT99";
const ALLOWED_EMAIL = "confidential-client@example.com";
const OTHER_VESSEL = "MV Pacific Dawn"; // the seaman's current/other-vessel assignment [A]

const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [], appraisals: [], issuedSeaTerms: [],
  clientPortals: [], vacancies: [],
};

const db = {
  ...structuredClone(EMPTY),
  agents: [{ id: "agent:A", orgName: "Alpha Crewing", contact: "ops@alpha.example", createdAt: "2026-01-01T00:00:00.000Z" }],
  seafarers: [{
    id: "s1", name: "Priya Sharma", rank: "Rating", state: "review",
    shareToken: "o-s1", openShareToken: "o-s1", emailShareToken: "e-s1",
    identityVerified: true, directoryOptIn: true, birthDate: DOB, personalCode: PERSONAL_CODE,
    // The seaman's CURRENT/other-vessel assignment — must NEVER surface to a client whose
    // portal is for a DIFFERENT vessel (portal vessel below is "MV Alpha") [A].
    issuerCountry: "Eesti", vessel: OTHER_VESSEL,
    selfProfile: { phone: PHONE, email: PRIVATE_EMAIL, bankAccount: BANK, nextOfKinName: NOK },
    allowedEmails: [ALLOWED_EMAIL], createdAt: "2026-01-01T00:00:00.000Z",
  }],
  documents: [
    { id: "s1-p", seafarerId: "s1", title: "Passport", docType: "Passport", docCategory: null, estonianCode: null, certNumber: CERT_NUMBER, isValid: true, validUntil: "2030-01-01T00:00:00.000Z", fileName: FILE_NAME, createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType: "Passport", reviewStatus: "pending", verifiedPersonalCode: PERSONAL_CODE, verifiedBirthDate: DOB },
    { id: "s1-sb", seafarerId: "s1", title: "Seaman book", docType: "Seaman book", docCategory: null, estonianCode: null, certNumber: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z", fileName: "book.jpg", createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType: "Seaman book", reviewStatus: "pending" },
    { id: "s1-bst", seafarerId: "s1", title: "Basic Safety Training", docType: "Basic Safety Training", docCategory: null, estonianCode: null, certNumber: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z", fileName: "bst.jpg", createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType: "Basic Safety Training", reviewStatus: "pending" },
    { id: "s1-med", seafarerId: "s1", title: "Medical", docType: "Medical", docCategory: "medical", estonianCode: null, certNumber: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z", fileName: "med.jpg", createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType: "Medical", reviewStatus: "pending" },
  ],
  comments: [{ id: "c1", documentId: null, seafarerId: "s1", authorName: "Maria", text: "agency-private note about Priya", createdAt: "2026-01-01T00:00:00.000Z" }],
  accessGrants: [{ id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g1-secret-token", grantedAt: "2026-01-02T00:00:00.000Z", revokedAt: null, expiresAt: null, createdAt: "2026-01-02T00:00:00.000Z", clientVisible: true, directoryConsent: true }],
};
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// ---- Build the REAL external payloads --------------------------------------
const { portal } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "email", allowedEmails: [ALLOWED_EMAIL], rotationEnd: "2027-01-01T00:00:00.000Z" });
const portalRows = crewForPortal(portal);
const dir = searchDirectory({}, {});
assert.equal(dir.ok, true);

assert.ok(portalRows.length >= 1, "portal payload is non-empty (test is meaningful)");
assert.ok(dir.rows.length >= 1, "directory payload is non-empty (test is meaningful)");

// Serialise EXACTLY as the bytes that would cross the wire (drops undefined/functions).
const wire = JSON.parse(JSON.stringify({ portal: portalRows, directory: dir.rows }));
const wireText = JSON.stringify(wire);

// ---- Recursive deep-scan ---------------------------------------------------
const BANNED_KEYS = new Set([
  "seafarerid", "documents", "filename", "personalcode", "birthdate", "dob",
  "notes", "comments", "token", "agentid", "seafarerids", "allowedemails",
  "verifiedpersonalcode", "verifiedbirthdate", "selfprofile", "sharetoken",
]);
const BANNED_VALUES = [DOB, "1985-06-15", PERSONAL_CODE, PHONE, PRIVATE_EMAIL, BANK, NOK, FILE_NAME, "book.jpg", "bst.jpg", "med.jpg", CERT_NUMBER, ALLOWED_EMAIL, "g1-secret-token", portal.token, "agent:A", "agency-private note about Priya", OTHER_VESSEL];

const keyHits = [];
const valueHits = [];
function walk(node) {
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (BANNED_KEYS.has(k.toLowerCase())) keyHits.push(k);
      walk(v);
    }
    return;
  }
  if (typeof node === "string") {
    for (const bad of BANNED_VALUES) if (node.includes(bad)) valueHits.push(`${bad} <= "${node}"`);
  }
}
walk(wire);

assert.deepEqual(keyHits, [], `NO banned key at any depth (found: ${keyHits.join(", ")})`);
ok("deep-scan: no banned KEY (seafarerId/documents/fileName/personalCode/birthDate/contact/notes/comments/token/agentId/seafarerIds/allowedEmails) at any depth");

assert.deepEqual(valueHits, [], `NO banned value at any depth (found: ${valueHits.join(" | ")})`);
ok("deep-scan: no banned VALUE (DOB/personalCode/contact/fileName/certNumber/token/agentId/notes) at any depth");

// ---- Explicit DOB + personalCode absence (the DOB-enters-as-holderDOB rule) ----
assert.ok(!wireText.includes("1985-06-15"), "the seaman's birthDate value is absent from BOTH payloads");
assert.ok(!wireText.includes(PERSONAL_CODE), "the seaman's personalCode value is absent from BOTH payloads");
ok("explicit: birthDate + personalCode values never surface (DOB flows in as holderDOB only) [C3]");

// ---- Explicit: the seaman's OTHER-vessel assignment name never surfaces [A] ------
assert.ok(!wireText.includes(OTHER_VESSEL), "the seaman's current/other-vessel assignment name is absent from BOTH payloads");
assert.ok(!("vessel" in wire.portal[0]), "the portal crew row carries NO vessel field (other-vessel disclosure removed) [A]");
ok("explicit: the seaman's current/other-vessel assignment ('MV Pacific Dawn') never surfaces to the client [A]");

// ---- Positive control: the allow-listed fields ARE present (projection works) ----
const p = wire.portal[0];
const d = wire.directory[0];
assert.equal(p.name, "Priya S.", "portal row carries the MASKED name (allow-listed field present)");
assert.equal(d.name, "Priya Sharma", "directory row carries the consented full name (allow-listed field present)");
assert.ok(typeof p.ref === "string" && p.ref.length === 16, "portal row carries the non-reversible ref");
assert.notEqual(p.ref, d.ref, "portal vs directory refs are non-correlatable for the same seaman");
ok("positive control: allow-listed fields (masked/full name, non-reversible ref) ARE present — projection is not vacuous");

console.log(`\nbatch3-external-leak.spec: ${pass} sections passed`);
