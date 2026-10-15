// Batch 3 (#42) — shipowner/client read-portal server module [R42.4/5/6, C10/C11/V4].
//
// Asserts: previewPortalVisibility reports per-crew visible/NOT-visible + reason BEFORE
// send; createPortal keeps only visible ids and is idempotent on createKey under a
// CONCURRENT double-submit (one row, same id) [C11/V4]; resolvePortal is null for
// unknown/revoked/expired and its client-facing HEADER carries no token/allowedEmails/
// agentId/seafarerIds; email-mode withholds the header pre-gate [C10]; crewForPortal
// masks the surname ("Priya S." [R42.4]), raises possibleForgery from the fleet
// duplicate index, judges a mid-rotation-lapsing cert NOT sea-ready [R42.2], and
// TOCTOU-drops a flipped grant / clientVisible.
//
// Disk-backed in an ISOLATED temp cwd (never the real data/db.json).
// Run: node --import ./tests/_register-alias.mjs tests/client-portal.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PORTAL_REF_SALT = "portal-salt-portal-spec";
process.env.DIRECTORY_REF_SALT = "directory-salt-portal-spec";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch3-portal-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const DB_PATH = path.join(TMP, "data", "db.json");
process.chdir(TMP);

const {
  previewPortalVisibility, createPortal, revokePortal, resolvePortal,
  portalHeaderForViewer, crewForPortal, listPortalsForAgent,
} = await import("@/lib/client-portal");
const { readDB } = await import("@/lib/db");

const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [], appraisals: [], issuedSeaTerms: [],
  clientPortals: [], vacancies: [],
};
const writeDb = (db) => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

const mkSeafarer = (id, name, over = {}) => ({
  id, name, rank: "Rating", state: "review", shareToken: "o-" + id, openShareToken: "o-" + id,
  emailShareToken: "e-" + id, identityVerified: true, birthDate: null, issuerCountry: "Eesti",
  vessel: "MV Alpha", selfProfile: {}, allowedEmails: [], createdAt: "2026-01-01T00:00:00.000Z", ...over,
});
const mkGrant = (id, sid, over = {}) => ({
  id, seafarerId: sid, agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
  scope: ["profile", "documents", "log"], shareToken: id, grantedAt: "2026-01-02T00:00:00.000Z",
  revokedAt: null, expiresAt: null, createdAt: "2026-01-02T00:00:00.000Z", clientVisible: true, ...over,
});
const mkDoc = (id, sid, requiredType, validUntil, over = {}) => ({
  id, seafarerId: sid, title: requiredType, docType: requiredType, docCategory: null, estonianCode: null,
  certNumber: null, isValid: true, validUntil, fileName: null, createdAt: "2026-01-01T00:00:00.000Z",
  source: "manual", requiredType, reviewStatus: "pending", ...over,
});
// The 4 universal required docs for a rating, all far-future (sea-ready baseline).
const universalDocs = (sid, medicalUntil = "2030-01-01T00:00:00.000Z", passportOver = {}) => [
  mkDoc(sid + "-p", sid, "Passport", "2030-01-01T00:00:00.000Z", passportOver),
  mkDoc(sid + "-sb", sid, "Seaman book", "2030-01-01T00:00:00.000Z"),
  mkDoc(sid + "-bst", sid, "Basic Safety Training", "2030-01-01T00:00:00.000Z"),
  mkDoc(sid + "-med", sid, "Medical", medicalUntil),
];
const base = () => ({ ...structuredClone(EMPTY), agents: [{ id: "agent:A", orgName: "Alpha Crewing", contact: "", createdAt: "2026-01-01T00:00:00.000Z" }] });

// ---- previewPortalVisibility: per-crew visible / NOT-visible + reason ------
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma"), mkSeafarer("s2", "No Grant"), mkSeafarer("s3", "Not Consented")];
  db.documents = universalDocs("s1");
  db.accessGrants = [mkGrant("g1", "s1"), mkGrant("g3", "s3", { clientVisible: false })];
  writeDb(db);

  const vis = previewPortalVisibility("agent:A", ["s1", "s2", "s3"]);
  assert.deepEqual(vis[0], { seafarerId: "s1", visible: true }, "s1 (grant + clientVisible) -> visible");
  assert.deepEqual(vis[1], { seafarerId: "s2", visible: false, reason: "no-grant" }, "s2 (no grant) -> no-grant");
  assert.deepEqual(vis[2], { seafarerId: "s3", visible: false, reason: "not-consented" }, "s3 (grant, not visible) -> not-consented");
  ok("previewPortalVisibility: per-crew visible/NOT-visible with drop reason BEFORE send [R42.5]");
}

// ---- createPortal keeps only visible ids + concurrent idempotency [C11/V4] ----
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma"), mkSeafarer("s2", "No Grant"), mkSeafarer("s3", "Not Consented")];
  db.documents = universalDocs("s1");
  db.accessGrants = [mkGrant("g1", "s1"), mkGrant("g3", "s3", { clientVisible: false })];
  writeDb(db);

  const { portal, visibility } = await createPortal("agent:A", {
    vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1", "s2", "s3"], mode: "open",
  });
  assert.deepEqual(portal.seafarerIds, ["s1"], "createPortal curates down to the VISIBLE ids only");
  assert.equal(visibility.length, 3, "visibility report covers every requested id");

  const [r1, r2] = await Promise.all([
    createPortal("agent:A", { vessel: "MV Beta", clientLabel: "Owner Y", seafarerIds: ["s1"], mode: "open", createKey: "pk-1" }),
    createPortal("agent:A", { vessel: "MV Beta", clientLabel: "Owner Y", seafarerIds: ["s1"], mode: "open", createKey: "pk-1" }),
  ]);
  assert.equal(r1.portal.id, r2.portal.id, "concurrent same-createKey creates resolve to the SAME portal id");
  assert.equal(listPortalsForAgent("agent:A").filter((p) => p.createKey === "pk-1").length, 1, "exactly ONE portal row for the shared createKey [C11]");
  ok("createPortal: curates to visible ids; concurrent double-submit is one row/same id [C11/V4]");
}

// ---- resolvePortal null-cases + header-only projection --------------------
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  db.documents = universalDocs("s1");
  db.accessGrants = [mkGrant("g1", "s1")];
  writeDb(db);

  assert.equal(resolvePortal("no-such-token"), null, "unknown token -> null (generic 404)");

  const { portal } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "open" });
  const resolved = resolvePortal(portal.token);
  assert.ok(resolved, "valid token resolves");
  assert.deepEqual(Object.keys(resolved.header).sort(), ["clientLabel", "mode", "vessel"], "header carries ONLY vessel/clientLabel/mode");
  for (const leaky of ["token", "allowedEmails", "agentId", "seafarerIds"]) {
    assert.ok(!(leaky in resolved.header), `header does NOT expose ${leaky} [R42.6]`);
  }

  // Revoked -> null.
  await revokePortal("agent:A", portal.id);
  assert.equal(resolvePortal(portal.token), null, "revoked portal -> null");

  // Expired -> null.
  const { portal: expiredPortal } = await createPortal("agent:A", { vessel: "MV Old", clientLabel: "Owner Z", seafarerIds: ["s1"], mode: "open", expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(resolvePortal(expiredPortal.token), null, "expired portal -> null");
  ok("resolvePortal: null for unknown/revoked/expired; client-facing header exposes no token/allowedEmails/agentId/seafarerIds [R42.6]");
}

// ---- email-mode withholds the display header pre-gate [C10] ----------------
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  db.documents = universalDocs("s1");
  db.accessGrants = [mkGrant("g1", "s1")];
  writeDb(db);

  const { portal: emailPortal } = await createPortal("agent:A", { vessel: "MV Secret", clientLabel: "Confidential Owner", seafarerIds: ["s1"], mode: "email", allowedEmails: ["client@x"] });
  assert.equal(portalHeaderForViewer(emailPortal, false), null, "email mode + non-allowed viewer -> NO header (vessel/clientLabel withheld) [C10]");
  assert.deepEqual(portalHeaderForViewer(emailPortal, true), { vessel: "MV Secret", clientLabel: "Confidential Owner", mode: "email" }, "email mode + allowed viewer -> header revealed");

  const { portal: openPortal } = await createPortal("agent:A", { vessel: "MV Open", clientLabel: "Public Owner", seafarerIds: ["s1"], mode: "open" });
  assert.deepEqual(portalHeaderForViewer(openPortal, false), { vessel: "MV Open", clientLabel: "Public Owner", mode: "open" }, "open mode -> header always shown");
  ok("email-mode: valid token + non-allowed viewer leaks neither crew NOR vessel/clientLabel header [C10]");
}

// ---- crewForPortal: surname masking + forgery boolean ---------------------
{
  const db = base();
  // S1 clean-required but with a Passport number CLONED by a phantom crew member.
  db.seafarers = [mkSeafarer("s1", "Priya Sharma"), mkSeafarer("s9", "Phantom Crew")];
  db.documents = [
    ...universalDocs("s1", "2030-01-01T00:00:00.000Z", { certNumber: "CLONE-1" }),
    mkDoc("s9-p", "s9", "Passport", "2030-01-01T00:00:00.000Z", { certNumber: "CLONE-1" }),
  ];
  db.accessGrants = [mkGrant("g1", "s1")];
  writeDb(db);

  const { portal } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "open" });
  const rows = crewForPortal(portal);
  assert.equal(rows.length, 1, "one crew row");
  assert.equal(rows[0].name, "Priya S.", "surname masked by default [R42.4]");
  assert.equal(rows[0].possibleForgery, true, "fleet-duplicate cert number -> possibleForgery boolean [R42.1]");
  assert.equal(rows[0].seaReady, false, "forgery nulls sea-readiness");
  assert.ok(!("documents" in rows[0]) && !("seafarerId" in rows[0]), "no documents/seafarerId leak on the crew row");
  ok("crewForPortal: surname masked ('Priya S.'); forgery is a boolean, other-crew names stripped [R42.1/R42.4]");
}

// ---- crewForPortal: a cert lapsing mid-rotation reads NOT sea-ready [R42.2] ----
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  // Fully covered required set; Medical valid today but lapses inside the voyage window.
  db.documents = universalDocs("s1", "2027-03-01T00:00:00.000Z");
  db.accessGrants = [mkGrant("g1", "s1")];
  writeDb(db);

  // Baseline (no rotation window): Medical valid today -> sea-ready.
  const { portal: noRot } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "open" });
  const baseRows = crewForPortal(noRot);
  assert.equal(baseRows[0].seaReady, true, "no voyage window: Medical valid today -> sea-ready");

  // With a rotation ending AFTER the Medical expiry, the same cert lapses mid-voyage.
  const { portal: rotPortal } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "open", rotationEnd: "2027-09-01T00:00:00.000Z" });
  const rows = crewForPortal(rotPortal);
  assert.equal(rows[0].seaReady, false, "voyage window past the Medical expiry -> NOT sea-ready [R42.2]");
  const medicalSlot = rows[0].slots.find((s) => s.requiredType === "Medical");
  assert.equal(medicalSlot.status, "expiring", "the Medical slot reads 'expiring' against the voyage window [R42.2/R42.3]");
  assert.ok(medicalSlot.safetyCritical, "Medical is flagged safety-critical (dated for the client)");
  ok("crewForPortal: a Medical lapsing before rotationEnd reads NOT sea-ready + slot 'expiring' [R42.2]");
}

// ---- crewForPortal: TOCTOU-drops a flipped grant / clientVisible -----------
{
  const db = base();
  db.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  db.documents = universalDocs("s1");
  db.accessGrants = [mkGrant("g1", "s1")];
  writeDb(db);

  const { portal } = await createPortal("agent:A", { vessel: "MV Alpha", clientLabel: "Owner X", seafarerIds: ["s1"], mode: "open" });
  assert.equal(crewForPortal(portal).length, 1, "s1 initially shown");

  // Flip clientVisible off AFTER the portal was built -> the very next view drops it.
  const db2 = base();
  db2.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  db2.documents = universalDocs("s1");
  db2.accessGrants = [mkGrant("g1", "s1", { clientVisible: false })];
  writeDb(db2);
  assert.equal(crewForPortal(portal).length, 0, "TOCTOU: clientVisible flipped off -> crew row dropped");

  // Revoked grant is also dropped live.
  const db3 = base();
  db3.seafarers = [mkSeafarer("s1", "Priya Sharma")];
  db3.documents = universalDocs("s1");
  db3.accessGrants = [mkGrant("g1", "s1", { status: "REVOKED", revokedAt: "2026-06-01T00:00:00.000Z" })];
  writeDb(db3);
  assert.equal(crewForPortal(portal).length, 0, "TOCTOU: grant revoked -> crew row dropped");
  ok("crewForPortal: re-checks grant + clientVisible LIVE per view (TOCTOU-drops a flipped grant)");
}

console.log(`\nclient-portal.spec: ${pass} sections passed`);
