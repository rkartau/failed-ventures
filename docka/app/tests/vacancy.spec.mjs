// Batch 3 (#52) — vacancy candidate matching + store [C1/C8/C11/R52.15-17].
//
// matchCandidates RE-RUNS assignmentBlockers per candidate against the VACANCY voyage
// window (never buildSearchRow's "as of today / own rotation" judgement), threading the
// fleet duplicates index so a cloned-cert candidate is caught [C1]. This asserts:
//   (A) a cert valid today but lapsing BEFORE vacancy.rotationEnd is NOT counted in
//       coverage, drops qualified=false, and ranks BELOW one valid through the window;
//   (B) a cloned-CoC candidate (fleet duplicate number) -> seaReady=false, qualified=
//       false, cannot outrank a clean qualified candidate;
//   (C) documented weights make certs+sea-time DOMINATE — a rank/vessel/flag-only match
//       can't outrank a cert-qualified candidate [R52.15];
//   (D) sea-time-short -> qualified=false, ranks below every qualified [R52.16];
//   (E) createVacancy is server-side validated [C8] + idempotent on createKey under a
//       CONCURRENT double-submit [C11/V4] (Promise.all -> one row, same id).
//
// The pure matcher runs on an injected clock; the store section is disk-backed in an
// ISOLATED temp cwd (never the real data/db.json).
// Run: node --import ./tests/_register-alias.mjs tests/vacancy.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

// ---- Isolated temp cwd BEFORE importing db-backed modules ----------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-batch3-vacancy-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const DB_PATH = path.join(TMP, "data", "db.json");
const EMPTY = {
  seafarers: [], documents: [], comments: [], restHours: [], agents: [], assignments: [],
  accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [],
  remindersSent: [], circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
  seaService: [], impersonations: [], profileShareRequests: [], appraisals: [], issuedSeaTerms: [],
  clientPortals: [], vacancies: [],
};
fs.writeFileSync(DB_PATH, JSON.stringify({ ...EMPTY, agents: [{ id: "agent:A", orgName: "Alpha Crewing", contact: "", createdAt: "2026-01-01T00:00:00.000Z" }] }, null, 2));
process.chdir(TMP);

const { matchCandidates } = await import("@/lib/vacancy");
const { duplicateNameIndex } = await import("@/lib/duplicates");
const { createVacancy, listVacancies } = await import("@/lib/vacancy-store");
const { readDB } = await import("@/lib/db");

const NOW = new Date("2026-07-21T00:00:00.000Z");
const ROT = "2026-11-01T00:00:00.000Z"; // ~4-month rotation

const mkSeafarer = (id, name, over = {}) => ({
  id, name, rank: "Rating", state: "review", shareToken: "t-" + id, openShareToken: "t-" + id,
  emailShareToken: "e-" + id, identityVerified: false, birthDate: null, selfProfile: {},
  allowedEmails: [], createdAt: "2026-01-01T00:00:00.000Z", ...over,
});
const mkDoc = (id, sid, requiredType, validUntil, over = {}) => ({
  id, seafarerId: sid, title: requiredType ?? "Document", docType: requiredType ?? "Document",
  docCategory: null, estonianCode: null, certNumber: null, isValid: true, validUntil,
  fileName: null, createdAt: "2026-01-01T00:00:00.000Z", source: "manual", requiredType,
  reviewStatus: "pending", ...over,
});
const cand = (seafarer, docs, entries = []) => ({ seafarer, docs, entries, atSea: false });
const vacancy = (over) => ({
  id: "V", agentId: "agent:A", title: "Post", rank: "Rating", vesselType: null, flagState: null,
  requiredCerts: [], requiredEndorsements: [], minSeaDays: 0, seaWindowMonths: 60,
  rotationEnd: null, status: "open", createdAt: "2026-01-01T00:00:00.000Z", ...over,
});
const byRef = (scored, ref) => scored.find((s) => s.ref === ref);

// ---- (A) cert lapsing before rotationEnd is not covered, ranks below ------
{
  const through = cand(mkSeafarer("through", "Anna Through"), [mkDoc("d1", "through", "Medical", "2027-06-01T00:00:00.000Z")]);
  const lapse = cand(mkSeafarer("lapse", "Bea Lapse"), [mkDoc("d2", "lapse", "Medical", "2026-09-15T00:00:00.000Z")]);
  const v = vacancy({ requiredCerts: ["Medical"], rotationEnd: ROT });
  const scored = matchCandidates(v, [lapse, through], {}, NOW);

  const t = byRef(scored, "through");
  const l = byRef(scored, "lapse");
  assert.equal(t.certCoverage, 1, "through: Medical valid through the voyage -> full coverage");
  assert.equal(t.qualified, true, "through: qualified");
  assert.equal(t.seaReady, true, "through: sea-ready for the voyage window");
  assert.equal(l.certCoverage, 0, "lapse: Medical lapses before rotationEnd -> NOT counted in coverage [C1]");
  assert.deepEqual(l.heldButExpiring, ["Medical"], "lapse: held-but-expiring flags the lapsing slot");
  assert.equal(l.qualified, false, "lapse: qualified=false");
  assert.equal(l.seaReady, false, "lapse: not sea-ready (lapses mid-voyage)");
  assert.equal(scored[0].ref, "through", "the through-valid candidate ranks ABOVE the mid-voyage-lapsing one");
  ok("(A) mid-voyage-lapsing cert: not covered, qualified=false, ranks below a through-valid candidate [C1]");
}

// ---- (B) cloned-CoC candidate: not sea-ready, cannot outrank a clean one --
{
  const cleanDocs = [mkDoc("m1", "clean", "Medical", "2027-06-01T00:00:00.000Z"), mkDoc("c1", "clean", "Endorsement", null, { certNumber: "UNIQUE-1", title: "Certificate of Competency" })];
  const cloneDocs = [mkDoc("m2", "clone", "Medical", "2027-06-01T00:00:00.000Z"), mkDoc("c2", "clone", "Endorsement", null, { certNumber: "SHARED-CLONE-9", title: "Certificate of Competency" })];
  // A phantom crew member carries the SAME CoC number -> fleet duplicate on "clone".
  const phantomDoc = mkDoc("cp", "phantom", "Endorsement", null, { certNumber: "SHARED-CLONE-9", title: "Certificate of Competency" });
  const clean = cand(mkSeafarer("clean", "Cara Clean"), cleanDocs);
  const clone = cand(mkSeafarer("clone", "Dov Clone"), cloneDocs);

  const nameOf = (id) => ({ clean: "Cara Clean", clone: "Dov Clone", phantom: "Phantom Crew" })[id] ?? id;
  const dupes = duplicateNameIndex([...cleanDocs, ...cloneDocs, phantomDoc], nameOf);

  const v = vacancy({ requiredCerts: ["Medical"], rotationEnd: null });
  const scored = matchCandidates(v, [clone, clean], dupes, NOW);

  const cl = byRef(scored, "clone");
  const cn = byRef(scored, "clean");
  assert.equal(cl.possibleForgery, true, "clone: fleet-duplicate CoC number -> possibleForgery");
  assert.equal(cl.seaReady, false, "clone: forgery nulls sea-readiness");
  assert.equal(cl.qualified, false, "clone: forgery nulls qualified");
  assert.equal(cn.possibleForgery, false, "clean: unique CoC number -> no forgery");
  assert.equal(cn.qualified, true, "clean: qualified");
  assert.equal(scored[0].ref, "clean", "the clean qualified candidate outranks the cloned-CoC one [C1]");
  ok("(B) cloned-CoC candidate: seaReady=false, qualified=false, cannot outrank a clean qualified candidate [C1]");
}

// ---- (C) weights: a cert-qualified candidate beats a rank/vessel/flag-only match ----
{
  const v = vacancy({ requiredCerts: ["Medical"], rank: "Master", vesselType: "oil_tanker", flagState: "panama", rotationEnd: null });
  // Cert-qualified but ZERO soft matches (rating, no vessel/flag).
  const qualified = cand(mkSeafarer("q", "Qual Match", { rank: "Rating", vesselType: null, flagState: null }), [mkDoc("qm", "q", "Medical", "2027-06-01T00:00:00.000Z")]);
  // All soft matches but MISSING the required Medical -> not qualified.
  const softOnly = cand(mkSeafarer("soft", "Soft Match", { rank: "Master", vesselType: "oil tanker", flagState: "Panama" }), [mkDoc("sp", "soft", "Passport", "2030-01-01T00:00:00.000Z")]);
  const scored = matchCandidates(v, [softOnly, qualified], {}, NOW);

  const q = byRef(scored, "q");
  const s = byRef(scored, "soft");
  assert.equal(q.qualified, true, "cert-qualified candidate is qualified");
  assert.equal(s.qualified, false, "soft-only candidate misses the required Medical -> not qualified");
  assert.ok(s.rankMatch && s.vesselTypeMatch && s.flagMatch, "soft-only DID match rank+vessel+flag (soft points earned)");
  assert.ok(q.score > s.score, "certs+sea-time DOMINATE: qualified > every soft-only match [R52.15]");
  assert.equal(scored[0].ref, "q", "a rank/vessel/flag-only match can't outrank a cert-qualified candidate");
  ok("(C) documented weights: certs+sea-time dominate soft rank/vessel/flag matches [R52.15]");
}

// ---- (D) sea-time-short -> qualified=false, ranks below the sea-time-OK one ----
{
  const v = vacancy({ requiredCerts: ["Medical"], minSeaDays: 360, seaWindowMonths: 60, rotationEnd: null });
  const entry = (id, on, off) => ({ id, seafarerId: id, vessel: "MV X", rank: "Rating", signOn: on, signOff: off, recordedBy: "seaman", createdAt: "2026-01-01T00:00:00.000Z" });
  const okSea = cand(mkSeafarer("okSea", "Fu SeaTime"), [mkDoc("mo", "okSea", "Medical", "2027-06-01T00:00:00.000Z")], [entry("okSea", "2025-01-01", "2026-06-01")]); // ~517 days in window
  const shortSea = cand(mkSeafarer("shortSea", "Gil Short"), [mkDoc("ms", "shortSea", "Medical", "2027-06-01T00:00:00.000Z")], [entry("shortSea", "2026-05-01", "2026-06-01")]); // ~32 days
  const scored = matchCandidates(v, [shortSea, okSea], {}, NOW);

  const good = byRef(scored, "okSea");
  const short = byRef(scored, "shortSea");
  assert.ok(good.seaDaysInWindow >= 360, `sea-time-OK candidate has >=360 qualifying days (${good.seaDaysInWindow})`);
  assert.equal(good.seaTimeQualifies, true);
  assert.equal(good.qualified, true, "sea-time-OK candidate qualified");
  assert.ok(short.seaDaysInWindow < 360, `sea-time-short candidate has <360 days (${short.seaDaysInWindow})`);
  assert.equal(short.seaTimeQualifies, false);
  assert.equal(short.qualified, false, "sea-time-short candidate NOT qualified (a 'Qualified only' filter hides it) [R52.16]");
  assert.equal(scored[0].ref, "okSea", "the sea-time-short candidate ranks below the qualified one");
  ok("(D) sea-time-short -> qualified=false, ranks below the sea-time-OK candidate [R52.16]");
}

// ---- (E) createVacancy: server-side validation [C8] + concurrent idempotency [C11] ----
{
  // Missing title/rank => 400-shaped error, no row.
  const before = listVacancies("agent:A").length;
  const bad = await createVacancy("agent:A", { title: "", rank: "Rating" });
  assert.equal(bad.ok, false, "blank title => validation error");
  assert.equal(listVacancies("agent:A").length, before, "rejected create wrote NO row");

  // Enum + integer bounds enforced server-side.
  const bounded = await createVacancy("agent:A", {
    title: "ETO", rank: "Engineer Officer",
    requiredCerts: ["Medical", "NOT_A_REAL_TYPE", "Passport"],
    minSeaDays: 999999, seaWindowMonths: 9999,
  });
  assert.equal(bounded.ok, true);
  assert.deepEqual(bounded.vacancy.requiredCerts, ["Medical", "Passport"], "bogus cert type stripped; catalog-ordered [C8]");
  assert.equal(bounded.vacancy.minSeaDays, 25000, "minSeaDays clamped to the 25000 max [C8]");
  assert.equal(bounded.vacancy.seaWindowMonths, 600, "seaWindowMonths clamped to the 600 max [C8]");

  // CONCURRENT double-submit on the same createKey -> exactly ONE row, same id [C11/V4].
  const [r1, r2] = await Promise.all([
    createVacancy("agent:A", { title: "Master", rank: "Master", createKey: "vac-key-1" }),
    createVacancy("agent:A", { title: "Master", rank: "Master", createKey: "vac-key-1" }),
  ]);
  assert.ok(r1.ok && r2.ok, "both concurrent creates resolve ok");
  assert.equal(r1.vacancy.id, r2.vacancy.id, "both concurrent creates resolve to the SAME vacancy id");
  const keyed = readDB().vacancies.filter((v) => v.createKey === "vac-key-1");
  assert.equal(keyed.length, 1, "exactly ONE vacancy row for the shared createKey (no 2nd row) [C11]");
  ok("(E) createVacancy: validated server-side [C8] + concurrent double-submit is one row/same id [C11/V4]");
}

console.log(`\nvacancy.spec: ${pass} sections passed`);
