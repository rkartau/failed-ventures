// Public Sample Profiles — Phase 2 seed acceptance (plan §Phase-2, v4-5a).
//
//   - sample-ids ⇔ seed literal equality (the two copies can never drift)
//   - fixture integrity: every seeded Doc.fileName exists in scripts/sample-fixtures/
//   - ADDITIVE + IDEMPOTENT: double-run on a prod-shaped COPY → zero real-row diffs,
//     run-2 db.json byte-identical to run-1
//   - §D8/PII invariants: no estonianCode, never the two real Estonian registry
//     codes, no auth identities, no e-mail anywhere, every PII-shaped string
//     carries a SAMPLE marker, every cert number SAMPLE-prefixed
//   - curated-filter self-consistency: the Phase-1 chokepoint's curated view
//     (resolveTokenSubject + filterRows over readDB()) returns EXACTLY the seeded
//     curated set; the redacted flagship exposes no non-allowlisted key
//   - content coverage: all four verification levels, expiring/expired/archived/
//     noExpiry lifecycle, all five docRequest stories incl. overdue, all five
//     pipeline stages on the sample grants, LOCKED-deriving live assignment,
//     forged-duplicate pair within the cohort only
//   - --remove: after seed + simulated REAL-agent interactions (grant + docRequest
//     + agent-uploaded doc with an arbitrary file name), db.json is BYTE-EQUAL to
//     the pre-seed copy and uploads/ holds no sample or orphaned files
//
// ALL runs happen against a throwaway temp copy — never a live db.json.
//
// Run: node --import ./tests/_register-sample.mjs --test tests/sample-seed.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");

// ---- Throwaway root (BEFORE any @/lib import — DATA_DIR is cwd-resolved) -----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-seed-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
process.chdir(TMP);
globalThis.__TEST_COOKIES = {};

const DB_PATH = path.join(TMP, "data", "db.json");
const UPLOADS = path.join(TMP, "uploads");
const isoFix = "2026-01-01T00:00:00.000Z";

// ---- Prod-shaped fixture (real rows the seed must never touch) ---------------

function prodShapedDb() {
  return {
    seafarers: [
      {
        id: "real-1",
        name: "Real Seafarer",
        rank: "Master",
        state: "accepted",
        shareToken: "real-open-tok",
        openShareToken: "real-open-tok",
        emailShareToken: "real-email-tok",
        allowedEmails: ["owner@example.com"],
        createdAt: isoFix,
        ownerEmail: "owner@example.com",
      },
    ],
    documents: [
      {
        id: "real-doc-1",
        seafarerId: "real-1",
        title: "Passport",
        docType: "Passport",
        docCategory: null,
        estonianCode: null,
        certNumber: "RE-123",
        isValid: true,
        validUntil: "2030-01-01T00:00:00.000Z",
        expiryConfirmed: true,
        fileName: "real-upload.jpg",
        createdAt: isoFix,
        source: "manual",
        requiredType: "Passport",
        reviewStatus: "pending",
        reviewedBy: null,
        reviewedAt: null,
      },
    ],
    comments: [],
    restHours: [],
    agents: [{ id: "agent:real", orgName: "Real Crewing", contact: "real@example.com", createdAt: isoFix }],
    assignments: [],
    accessGrants: [
      {
        id: "real-grant-1",
        seafarerId: "real-1",
        agentId: "agent:real",
        status: "ACTIVE",
        legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"],
        shareToken: "real-grant-tok",
        grantedAt: isoFix,
        revokedAt: null,
        expiresAt: null,
        createdAt: isoFix,
        stage: "accepted",
        stageUpdatedAt: 1767225600000,
      },
    ],
    requiredDocsConfigs: [],
    requiredDocsAudit: [],
    notifications: [
      { id: "real-notif-1", at: isoFix, channel: "email", to: "owner@example.com", subject: "hi", preview: "hi", status: "logged", reason: null, kind: null },
    ],
    remindersSent: [],
    circulars: [
      {
        id: "real-circ-1",
        agentId: "agent:real",
        authorName: "Real Crewing",
        subject: "Real circular",
        message: "real message",
        filter: null,
        channel: "email",
        recipientIds: ["real-1"],
        delivered: 0,
        allowReplies: false,
        createdAt: isoFix,
      },
    ],
    circularReplies: [],
    docRequests: [],
    profileChanges: [],
    seaService: [],
    impersonations: [],
    profileShareRequests: [],
    appraisals: [],
    appraisalDeleteRequests: [],
    issuedSeaTerms: [],
    clientPortals: [
      { id: "real-portal-1", agentId: "agent:real", vessel: "MV Real", clientLabel: "Client", token: "real-portal-tok", seafarerIds: ["real-1"], mode: "open", allowedEmails: [], joinDate: null, rotationEnd: null, createKey: null, expiresAt: null, revokedAt: null, createdAt: isoFix },
    ],
    vacancies: [],
    credentialUsers: [],
  };
}

const writeDb = (db) => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
const readRaw = () => fs.readFileSync(DB_PATH, "utf-8");

writeDb(prodShapedDb());
fs.writeFileSync(path.join(UPLOADS, "real-upload.jpg"), "real-bytes");
const PRE_SEED_BYTES = readRaw();

// ---- Imports (cwd is now TMP; alias hook resolves @/lib) ---------------------

const seed = await import(pathToFileURL(path.join(APP, "scripts", "seed-samples.mjs")).href);
const gen = await import(pathToFileURL(path.join(APP, "scripts", "generate-sample-docs.mjs")).href);
const ids = await import("@/lib/sample-ids");
const { readDB } = await import("@/lib/db");
const { resolveTokenSubject, SAMPLE_EXPOSED_SEAFARER_KEYS } = await import("@/lib/sample-guard");
const { verificationLevelForDoc } = await import("@/lib/verification-level");
const { getSampleBoardData, getSampleReviewData } = await import("@/lib/sample-data");

const FIXTURES_DIR = path.join(APP, "scripts", "sample-fixtures");
const REAL_EE_CODES = ["SAMPLE0SAFETY001", "SAMPLE0MEDICAL01"]; // scripts/seed.mjs:14-19 — must NEVER appear

// ---- 1. Literal lock: seed duplicates sample-ids EXACTLY ---------------------

test("seed literals are byte-equal to lib/sample-ids.ts", () => {
  assert.equal(seed.SAMPLE_PREFIX, ids.SAMPLE_PREFIX);
  assert.equal(seed.SAMPLE_AGENCY_ID, ids.SAMPLE_AGENCY_ID);
  assert.equal(seed.SAMPLE_FLAGSHIP_ID, ids.SAMPLE_FLAGSHIP_ID);
  assert.equal(seed.SAMPLE_OPEN_TOKEN, ids.SAMPLE_OPEN_TOKEN);
  assert.deepEqual([...seed.SAMPLE_CREW_IDS], [...ids.SAMPLE_CREW_IDS]);
});

// ---- 2. Fixture integrity ----------------------------------------------------

test("every fixture spec image is generated, committed, and SAMPLE-marked", () => {
  for (const fx of gen.SAMPLE_FIXTURES) {
    const p = path.join(FIXTURES_DIR, fx.fileName);
    assert.ok(fs.existsSync(p), `missing fixture image ${fx.fileName} — run generate-sample-docs.mjs`);
    assert.ok(fs.statSync(p).size > 10_000, `${fx.fileName} suspiciously small`);
    assert.ok(fx.fileName.startsWith(seed.SAMPLE_PREFIX));
    assert.ok(fx.holder.includes("SAMPLE"), `holder lacks SAMPLE marker: ${fx.holder}`);
    assert.ok(fx.certNumber.startsWith("SAMPLE-"), `cert not SAMPLE-prefixed: ${fx.certNumber}`);
  }
});

test("every seeded Doc.fileName exists among the committed fixtures", () => {
  const fixtureNames = new Set(gen.SAMPLE_FIXTURES.map((f) => f.fileName));
  for (const d of seed.buildSampleData().documents) {
    if (d.fileName) assert.ok(fixtureNames.has(d.fileName), `doc ${d.id} references unknown fixture ${d.fileName}`);
  }
});

// ---- 3. Additive + idempotent seed on the prod-shaped copy -------------------

let run1Bytes;

test("seed run 1: additive — zero diffs on real rows; fixtures copied to uploads/", () => {
  const before = JSON.parse(readRaw());
  seed.runSeed({ root: TMP });
  const after = JSON.parse(readRaw());

  // Every real row byte-identical (compare the non-sample subset per collection).
  for (const key of Object.keys(before)) {
    const realBefore = before[key];
    const realAfter = (after[key] ?? []).filter(
      (r) =>
        !(r.sample === true || r.isSample === true) &&
        !(typeof r.id === "string" && r.id.startsWith(seed.SAMPLE_PREFIX)) &&
        !(typeof r.agentId === "string" && r.agentId.startsWith(seed.SAMPLE_PREFIX) && ["requiredDocsConfigs", "requiredDocsAudit", "vacancies"].includes(key))
    );
    assert.deepEqual(realAfter, realBefore, `real rows changed in ${key}`);
  }

  // Uploads: fixture files present under their fixed sample-*.jpg names; real file intact.
  for (const d of seed.buildSampleData().documents) {
    if (d.fileName) assert.ok(fs.existsSync(path.join(UPLOADS, d.fileName)), `upload missing: ${d.fileName}`);
  }
  assert.equal(fs.readFileSync(path.join(UPLOADS, "real-upload.jpg"), "utf-8"), "real-bytes");

  run1Bytes = readRaw();
});

test("seed run 2: idempotent — db.json byte-identical to run 1", () => {
  seed.runSeed({ root: TMP });
  assert.equal(readRaw(), run1Bytes);
});

// ---- 4. §D8 / PII invariants over the seeded set -----------------------------

test("no estonianCode, no real registry codes, no auth identities, no e-mail, SAMPLE markers everywhere", () => {
  const data = seed.buildSampleData();
  const asJson = JSON.stringify(data);

  for (const code of REAL_EE_CODES) assert.ok(!asJson.includes(code), `real Estonian code leaked: ${code}`);
  assert.ok(!asJson.includes("@"), "an e-mail-shaped string leaked into the curated set");

  for (const d of data.documents) {
    assert.equal(d.estonianCode, null, `estonianCode set on ${d.id}`);
    if (d.certNumber != null) assert.ok(d.certNumber.startsWith("SAMPLE-"), `cert not SAMPLE-prefixed on ${d.id}`);
    assert.equal(d.sample, true);
    assert.ok(d.id.startsWith(seed.SAMPLE_PREFIX));
  }
  for (const s of data.seafarers) {
    assert.equal(s.isSample, true);
    assert.equal(s.directoryOptIn, false);
    assert.equal(s.googleSub, null);
    assert.equal(s.ownerEmail, null);
    assert.equal(s.importedEmail, null);
    assert.equal(s.credentialUserId, null);
    assert.ok(s.name.includes("SAMPLE"), `seafarer name lacks SAMPLE marker: ${s.name}`);
    if (s.verifiedName) assert.ok(s.verifiedName.includes("SAMPLE"));
    if (s.vessel) assert.ok(s.vessel.includes("Sample"), `vessel lacks Sample marker: ${s.vessel}`);
  }
  for (const a of data.agents) {
    assert.equal(a.isSample, true);
    assert.equal(a.contact, "", "sample agency must carry no contact address");
  }
  for (const g of data.accessGrants) {
    assert.equal(g.sample, true);
    assert.equal(g.clientVisible, false);
    assert.equal(g.directoryConsent, false);
    assert.equal(g.agentId, seed.SAMPLE_AGENCY_ID);
  }
  // Every row of every other curated collection is sample:true + sample--prefixed.
  for (const key of ["assignments", "issuedSeaTerms", "seaService", "appraisals", "circulars", "circularReplies", "docRequests", "restHours"]) {
    for (const r of data[key]) {
      assert.equal(r.sample, true, `${key} row not sample:true`);
      assert.ok(r.id.startsWith(seed.SAMPLE_PREFIX), `${key} row id not sample--prefixed`);
    }
  }
  for (const c of data.requiredDocsConfigs) assert.equal(c.agentId, seed.SAMPLE_AGENCY_ID);
});

// ---- 5. Content coverage -----------------------------------------------------

test("flagship docs cover L0/L1/L2/L3 and expiring/expired/archived/noExpiry", () => {
  const data = seed.buildSampleData();
  const flagDocs = data.documents.filter((d) => d.seafarerId === seed.SAMPLE_FLAGSHIP_ID);
  const levels = new Set(flagDocs.map((d) => verificationLevelForDoc(d)));
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3], "flagship must span all four verification levels");

  const now = Date.now();
  const in60d = now + 60 * 86400e3;
  const active = flagDocs.filter((d) => d.archived !== true);
  assert.ok(
    active.some((d) => d.validUntil && Date.parse(d.validUntil) > now && Date.parse(d.validUntil) <= in60d),
    "need one active doc expiring within 60 days"
  );
  assert.ok(active.some((d) => d.validUntil && Date.parse(d.validUntil) < now), "need one expired doc");
  assert.ok(flagDocs.some((d) => d.archived === true && d.archivedAt), "need one archived doc");
  assert.ok(active.some((d) => d.noExpiry === true && d.validUntil === null), "need one noExpiry doc");

  // The L3 doc is the LV snapshot-only story: registryInputs, never estonianCode.
  const l3 = flagDocs.filter((d) => verificationLevelForDoc(d) === 3);
  for (const d of l3) {
    assert.equal(d.registryCountry, "LV");
    assert.ok(d.registryInputs && Object.keys(d.registryInputs).length > 0);
    assert.equal(d.estonianCode, null);
  }
});

test("docRequests cover pending / overdue / received-upload / received-agent / waived", () => {
  const reqs = seed.buildSampleData().docRequests;
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(reqs.some((r) => r.status === "pending" && r.dueDate && r.dueDate > today), "pending (future due)");
  assert.ok(reqs.some((r) => r.status === "pending" && r.dueDate && r.dueDate < today), "overdue");
  assert.ok(reqs.some((r) => r.status === "received" && r.resolvedVia === "upload"), "received via upload auto-clear");
  assert.ok(reqs.some((r) => r.status === "received" && r.resolvedVia === "agent"), "received via agent");
  assert.ok(reqs.some((r) => r.status === "waived"), "waived");
});

test("grants cover all five pipeline stages; live assignment LOCKs sent_to_sea; inbox thread curated", () => {
  const data = seed.buildSampleData();
  const stages = new Set(data.accessGrants.map((g) => g.stage));
  assert.deepEqual(
    [...stages].sort(),
    ["accepted", "finished", "returning", "review", "sent_to_sea"],
    "sample grants must span every lib/pipeline.ts stage"
  );
  const live = data.assignments.filter((a) => a.returnedAt === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].seafarerId, "sample-crew-sent-to-sea");

  const circ = data.circulars[0];
  assert.equal(circ.allowReplies, true);
  assert.ok(circ.recipientIds.every((id) => id.startsWith(seed.SAMPLE_PREFIX)), "circular recipients are cohort-only");
  const replies = data.circularReplies.filter((r) => r.circularId === circ.id);
  assert.ok(replies.length >= 2 && replies.length <= 3);
  assert.ok(replies.some((r) => r.visibility === "all"), "one peer-anonymised (visibility:all) reply required");
  assert.ok(replies.some((r) => r.visibility === "agent"));

  // Appraisal with a seaman-visible shared comment.
  const appr = data.appraisals[0];
  assert.ok(appr.sharedComment && appr.sharedComment.includes("SAMPLE"));
  assert.ok(appr.sharedWithSeamanAt);
  assert.equal(appr.competencySetVersion, "2024.1");
});

test("forged-duplicate cert pair exists strictly within the sample cohort", () => {
  const data = seed.buildSampleData();
  const byCert = new Map();
  for (const d of data.documents) {
    if (!d.certNumber) continue;
    byCert.set(d.certNumber, (byCert.get(d.certNumber) ?? []).concat(d));
  }
  const dupes = [...byCert.entries()].filter(([, docs]) => docs.length > 1);
  assert.equal(dupes.length, 1, "exactly one deliberate duplicate cert number");
  const [certNo, docs] = dupes[0];
  assert.ok(certNo.startsWith("SAMPLE-"));
  assert.equal(docs.length, 2);
  assert.notEqual(docs[0].seafarerId, docs[1].seafarerId, "duplicate must span two crew");
  for (const d of docs) assert.ok(d.seafarerId.startsWith(seed.SAMPLE_PREFIX));
});

// ---- 6. Curated-filter self-consistency (Phase-1 chokepoint terms) -----------

test("the chokepoint's curated view returns exactly the seeded curated set", () => {
  const db = readDB();
  const subj = resolveTokenSubject(db, seed.SAMPLE_OPEN_TOKEN, "read", ["open"]);
  assert.ok(subj && subj !== "sample-write-denied");
  assert.equal(subj.isSample, true);

  // Redacted flagship: only allowlisted keys, and never the email token.
  const allow = new Set(SAMPLE_EXPOSED_SEAFARER_KEYS);
  for (const k of Object.keys(subj.seafarer)) assert.ok(allow.has(k), `non-allowlisted key exposed: ${k}`);
  assert.ok(!("emailShareToken" in subj.seafarer));
  assert.ok(!("allowedEmails" in subj.seafarer));

  // filterRows(sample===true) over the LIVE db returns exactly the seeded rows.
  const data = seed.buildSampleData();
  const collections = ["documents", "accessGrants", "assignments", "issuedSeaTerms", "seaService", "appraisals", "circulars", "circularReplies", "docRequests", "restHours"];
  for (const key of collections) {
    const curated = subj
      .filterRows(db[key])
      .map((r) => r.id)
      .sort();
    const seeded = data[key].map((r) => r.id).sort();
    assert.deepEqual(curated, seeded, `curated ${key} projection != seeded set`);
  }
  // Sample seafarers/agents (isSample flag) present and complete.
  const sampleSeafarers = db.seafarers.filter((s) => s.isSample === true).map((s) => s.id).sort();
  assert.deepEqual(sampleSeafarers, [seed.SAMPLE_FLAGSHIP_ID, ...seed.SAMPLE_CREW_IDS].sort());
  assert.ok(db.agents.some((a) => a.id === seed.SAMPLE_AGENCY_ID && a.isSample === true));
});

// ---- 6b. Phase-4 deviation follow-up (Phase 7): the forged-duplicate pair ----
// actually REACHES the surfaces that render the forgery flag — the board's
// cohort-scoped duplicates index and the opened review panel's — with both crew
// names resolved (never a real seafarer's).

test("the cohort duplicates index reaches the board + review panel data", () => {
  const data = seed.buildSampleData();
  const byCert = new Map();
  for (const d of data.documents) {
    if (!d.certNumber) continue;
    byCert.set(d.certNumber, (byCert.get(d.certNumber) ?? []).concat(d));
  }
  const [certNo, pairDocs] = [...byCert.entries()].find(([, docs]) => docs.length > 1);
  const pairIds = pairDocs.map((d) => d.seafarerId);
  const pairNames = pairIds
    .map((id) => data.seafarers.find((s) => s.id === id)?.name)
    .sort();

  const board = getSampleBoardData();
  assert.ok(board, "board data must exist after the seed");
  // The index key is the NORMALIZED cert number (lib/duplicates docNumber) — find
  // the entry by its resolved names instead of re-implementing normalization.
  const boardEntry = Object.values(board.duplicates).find(
    (entries) => entries.map((e) => e.name).sort().join("|") === pairNames.join("|")
  );
  assert.ok(boardEntry, `board duplicates index misses the ${certNo} pair`);
  for (const e of boardEntry) assert.match(e.name, /SAMPLE/, "cohort names only");

  const review = getSampleReviewData(seed.SAMPLE_FLAGSHIP_ID);
  assert.ok(review, "review data must exist after the seed");
  const reviewEntry = Object.values(review.duplicates).find(
    (entries) => entries.map((e) => e.name).sort().join("|") === pairNames.join("|")
  );
  assert.ok(reviewEntry, "review-panel duplicates index misses the forged pair");
});

// ---- 7. --remove: byte-equal to pre-seed, uploads clean ----------------------

test("--remove after real-agent interactions restores the pre-seed byte state", () => {
  // Simulate what REAL signed-in agents can do against the flagship (locked
  // interactivity decision): a grant, a doc request, and an agent-side upload
  // whose file name is an arbitrary server-generated one.
  const db = JSON.parse(readRaw());
  db.accessGrants.push({
    id: "real-grant-flagship",
    seafarerId: seed.SAMPLE_FLAGSHIP_ID,
    agentId: "agent:real",
    status: "ACTIVE",
    legalBasis: "CONSENT",
    scope: ["profile", "documents", "log"],
    shareToken: "real-grant-flag-tok",
    grantedAt: isoFix,
    revokedAt: null,
    expiresAt: null,
    createdAt: isoFix,
    stage: "review",
    stageUpdatedAt: 1767225600000,
  });
  db.docRequests.push({
    id: "real-dreq-flagship",
    seafarerId: seed.SAMPLE_FLAGSHIP_ID,
    agentId: "agent:real",
    requestedBy: "Real Crewing",
    requiredType: null,
    label: "Please supply your visa",
    note: null,
    dueDate: null,
    status: "pending",
    createdAt: isoFix,
    resolvedAt: null,
    resolvedVia: null,
  });
  db.documents.push({
    id: "real-agent-upload-doc",
    seafarerId: seed.SAMPLE_FLAGSHIP_ID,
    title: "Agent-uploaded scan",
    docType: "Photo — not verified",
    docCategory: null,
    estonianCode: null,
    certNumber: null,
    isValid: null,
    validUntil: null,
    expiryConfirmed: false,
    fileName: "a1b2c3d4-arbitrary-name.jpg", // server-generated, NOT sample-*
    createdAt: isoFix,
    source: "photo",
    requiredType: null,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
  });
  // A real circular that ALSO addressed the flagship (mixed recipients): the
  // cascade must STRIP the sample id but keep the circular for its real crew.
  db.circulars.push({
    id: "real-circ-mixed",
    agentId: "agent:real",
    authorName: "Real Crewing",
    subject: "Mixed circular",
    message: "to real-1 and the sample flagship",
    filter: null,
    channel: "email",
    recipientIds: ["real-1", seed.SAMPLE_FLAGSHIP_ID],
    delivered: 0,
    allowReplies: false,
    createdAt: isoFix,
  });
  writeDb(db);
  fs.writeFileSync(path.join(UPLOADS, "a1b2c3d4-arbitrary-name.jpg"), "agent-bytes");

  seed.runSeed({ root: TMP, remove: true });

  // The mixed circular must have survived WITH only its real recipient — remove
  // it (and re-check) so the byte-comparison against the pre-seed copy holds.
  const after = JSON.parse(readRaw());
  const mixed = after.circulars.find((c) => c.id === "real-circ-mixed");
  assert.ok(mixed, "mixed-recipient circular must survive --remove");
  assert.deepEqual(mixed.recipientIds, ["real-1"], "sample id must be stripped from the mixed circular");
  after.circulars = after.circulars.filter((c) => c.id !== "real-circ-mixed");
  assert.equal(JSON.stringify(after, null, 2), PRE_SEED_BYTES, "db.json not byte-equal to pre-seed after --remove");

  // No sample trace of any kind remains.
  const raw = JSON.stringify(after);
  assert.ok(!raw.includes("sample-"), "sample- id survived --remove");
  assert.ok(!raw.includes("SAMPLE"), "SAMPLE-marked string survived --remove");

  // Uploads: fixture copies AND the agent-uploaded arbitrary-name file deleted;
  // the real seafarer's real upload untouched.
  const remaining = fs.readdirSync(UPLOADS).sort();
  assert.deepEqual(remaining, ["real-upload.jpg"]);
  assert.equal(fs.readFileSync(path.join(UPLOADS, "real-upload.jpg"), "utf-8"), "real-bytes");
});

test("seed refuses to create a database (additive discipline)", () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-noroot-"));
  assert.throws(() => seed.runSeed({ root: emptyRoot }), /refuses to create/);
});
