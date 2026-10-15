// EXECUTED tests for the `PATCH /api/seafarers { id, importedEmail }` branch
// (placeholder-card plan §4d/§9F) — the REAL route handler + REAL lib/claim-state,
// lib/access, lib/agentData, lib/roster-parse, transpiled in memory via the shared vm
// harness (tests/_route-harness.mjs). Only the edges are stubbed: next/server,
// @/lib/agent-session and @/lib/db (a synthetic in-memory store).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seafarers-imported-email.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRouteHarness, API } from "./_route-harness.mjs";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
let seq = 0;

function freshDB() {
  const now = new Date(T0).toISOString();
  const seafarers = [
    // ph1 — placeholder, agent:A's own creation. Primary PATCH target.
    {
      id: "ph1", name: "Placeholder One", rank: "AB", state: "review",
      shareToken: "tok-ph1", openShareToken: "tok-ph1", emailShareToken: "em-ph1",
      invited: true, createdByAgentId: "agent:A", importedEmail: null,
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // claimed1 — a real owner (ownerEmail set) => 409.
    {
      id: "claimed1", name: "Claimed One", rank: "AB", state: "review",
      shareToken: "tok-c1", openShareToken: "tok-c1", emailShareToken: "em-c1",
      ownerEmail: "real@x.com", importedEmail: "stale@example.invalid",
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // legacy1 — unowned but no invited/createdByAgentId provenance => not a
    // placeholder => 409 ("This profile is claimed…").
    {
      id: "legacy1", name: "Legacy Unowned", rank: "AB", state: "review",
      shareToken: "tok-l1", openShareToken: "tok-l1", emailShareToken: "em-l1",
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // foreignStamped — placeholder CREATED by agent:B but ALSO granted to agent:A
    // (multi-agency roster) => 404 (not-creator).
    {
      id: "foreignStamped", name: "Foreign-Created", rank: "AB", state: "review",
      shareToken: "tok-fs", openShareToken: "tok-fs", emailShareToken: "em-fs",
      invited: true, createdByAgentId: "agent:B", importedEmail: null,
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // ungranted1 — exists, but agent:A holds NO grant on it (agent:Z does).
    {
      id: "ungranted1", name: "Ungranted Placeholder", rank: "AB", state: "review",
      shareToken: "tok-u1", openShareToken: "tok-u1", emailShareToken: "em-u1",
      invited: true, createdByAgentId: "agent:Z", importedEmail: null,
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // sample1 — public curated sample => 403 (read-only) before any other check.
    {
      id: "sample1", name: "Sample Row", rank: "AB", state: "review", isSample: true,
      shareToken: "tok-s1", openShareToken: "tok-s1", emailShareToken: "em-s1",
      importedEmail: null, selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // credU — placeholder claimed ONLY via credentialUserId (password auth, no
    // googleSub/ownerEmail) — A4/T5 hidden-crew READ-flag parity.
    {
      id: "credU", name: "Password-Claimed", rank: "AB", state: "review",
      shareToken: "tok-cu", openShareToken: "tok-cu", emailShareToken: "em-cu",
      credentialUserId: "cu-1", importedEmail: null,
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
    // wsOwner — whitespace-only ownerEmail (never written in practice, but
    // representable) — isClaimed() must treat it as NOT ownership.
    {
      id: "wsOwner", name: "Whitespace Owner", rank: "AB", state: "review",
      shareToken: "tok-ws", openShareToken: "tok-ws", emailShareToken: "em-ws",
      ownerEmail: " ", importedEmail: null,
      selfProfile: {}, allowedEmails: [], createdAt: now,
    },
  ];
  const grantIds = ["ph1", "claimed1", "legacy1", "foreignStamped", "sample1", "credU", "wsOwner"];
  const accessGrants = grantIds.map((sid, i) => ({
    id: `g-${sid}`, seafarerId: sid, agentId: "agent:A", status: "ACTIVE",
    legalBasis: "CONSENT", stage: "review",
    hiddenByAgentAt: sid === "credU" || sid === "wsOwner" ? now : null,
    scope: ["profile", "documents", "log"], shareToken: `gtok-${i}`,
    grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now,
  })).concat([
    // ungranted1 is granted to agent:Z only.
    {
      id: "g-u1-z", seafarerId: "ungranted1", agentId: "agent:Z", status: "ACTIVE",
      legalBasis: "CONSENT", stage: "review", scope: ["profile", "documents", "log"],
      shareToken: "gtok-u1z", grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now,
    },
  ]);
  return {
    agents: [
      { id: "agent:A", orgName: "Org A Crewing", contact: "", createdAt: now },
      { id: "agent:B", orgName: "Org B Crewing", contact: "", createdAt: now },
      { id: "agent:Z", orgName: "Org Z Crewing", contact: "", createdAt: now },
    ],
    seafarers, documents: [], comments: [], restHours: [], seaService: [], assignments: [],
    accessGrants,
    requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
    circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
    impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
    issuedSeaTerms: [], clientPortals: [], vacancies: [],
  };
}

let db = freshDB();
let currentSession = null;
const dbStub = {
  readDB: () => db,
  updateDB: (fn) => Promise.resolve(fn(db)),
  serialize: (fn) => Promise.resolve(fn()),
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
};
const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub,
    "@/lib/agent-session": { agentSession: async () => currentSession, isDevLoginEnabled: false, DEV_COOKIE: "x" },
    "@/auth": { auth: async () => null },
  },
});
const seafarersRoute = loadTs(path.join(API, "seafarers", "route.ts"));

function patchReq(body) {
  return { nextUrl: { searchParams: new URLSearchParams() }, json: async () => body };
}
function getReq(query = {}) {
  return { nextUrl: { searchParams: new URLSearchParams(query) }, json: async () => ({}) };
}
function asAgent(agentId) {
  currentSession = { user: { name: `${agentId}-user`, email: `${agentId}@x.example` }, agentId };
}
function reset() {
  db = freshDB();
  currentSession = null;
}
const s = (sid) => db.seafarers.find((x) => x.id === sid);

test("valid e-mail -> stored lower-cased; ownerEmail untouched", async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "SEAMAN@Ship.COM" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.seafarer.importedEmail, "seaman@ship.com");
  assert.equal(s("ph1").importedEmail, "seaman@ship.com");
  assert.equal(s("ph1").ownerEmail, undefined, "ownerEmail is never written by this branch");
});

test('"  A@B.com " -> trimmed BEFORE store -> exactly "a@b.com" (R2-6c)', async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "  A@B.com " }));
  assert.equal(r.status, 200);
  assert.equal(r.body.seafarer.importedEmail, "a@b.com");
});

test("blank / null clears importedEmail", async () => {
  reset();
  asAgent("agent:A");
  await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "seaman@ship.com" }));
  const rBlank = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "   " }));
  assert.equal(rBlank.status, 200);
  assert.equal(rBlank.body.seafarer.importedEmail, null, "whitespace-only clears");

  await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "seaman@ship.com" }));
  const rNull = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: null }));
  assert.equal(rNull.status, 200);
  assert.equal(rNull.body.seafarer.importedEmail, null, "null clears");
});

test("invalid shapes -> 400: no-dot domain, CRLF injection, effective >128 chars", async () => {
  reset();
  asAgent("agent:A");
  const rNoDot = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "a@b" }));
  assert.equal(rNoDot.status, 400);
  assert.equal(rNoDot.body.error, "Enter a valid e-mail address.");

  const rCrlf = await seafarersRoute.PATCH(
    patchReq({ id: "ph1", importedEmail: "a@b.com\r\nBcc: evil@x.com" })
  );
  assert.equal(rCrlf.status, 400, "CRLF header-injection attempt rejected");

  // A 128-char CAP is applied BEFORE validation: a local part alone longer than 128
  // chars truncates to something with no "@" left at all -> still invalid, never
  // silently stored padded/truncated-but-plausible.
  const long = "a".repeat(200) + "@b.com";
  const rLong = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: long }));
  assert.equal(rLong.status, 400, "an over-128-char value truncates to something invalid, never stored");
  assert.equal(s("ph1").importedEmail, null, "nothing was written");
});

test("claimed target -> 409, no write", async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.PATCH(patchReq({ id: "claimed1", importedEmail: "new@x.com" }));
  assert.equal(r.status, 409);
  assert.equal(s("claimed1").importedEmail, "stale@example.invalid", "unchanged");
});

test("legacy-unowned target -> 409 (not a placeholder), no write", async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.PATCH(patchReq({ id: "legacy1", importedEmail: "new@x.com" }));
  assert.equal(r.status, 409);
});

test("foreign creator's stamped placeholder -> 404, no write", async () => {
  reset();
  asAgent("agent:A"); // granted, but createdByAgentId is agent:B
  const r = await seafarersRoute.PATCH(patchReq({ id: "foreignStamped", importedEmail: "new@x.com" }));
  assert.equal(r.status, 404);
  assert.equal(s("foreignStamped").importedEmail, null);
});

test("ungranted target -> 404, no write", async () => {
  reset();
  asAgent("agent:A"); // no grant on ungranted1 at all
  const r = await seafarersRoute.PATCH(patchReq({ id: "ungranted1", importedEmail: "new@x.com" }));
  assert.equal(r.status, 404);
});

test("anonymous caller -> 401", async () => {
  reset();
  currentSession = null;
  const r = await seafarersRoute.PATCH(patchReq({ id: "ph1", importedEmail: "new@x.com" }));
  assert.equal(r.status, 401);
});

test("sample row -> 403 (read-only), before any other check", async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.PATCH(patchReq({ id: "sample1", importedEmail: "new@x.com" }));
  assert.equal(r.status, 403);
  assert.equal(s("sample1").importedEmail, null);
});

// ---------------------------------------------------------------------------
// A4/T5 — hidden-crew ?view=hidden `claimed` flag agrees with isClaimed() for
// credentialUserId-only and whitespace-only-ownerEmail rows.
// ---------------------------------------------------------------------------

test("A4/T5: ?view=hidden claimed flag — credentialUserId-only => true; whitespace-only ownerEmail => false", async () => {
  reset();
  asAgent("agent:A");
  const r = await seafarersRoute.GET(getReq({ view: "hidden" }));
  assert.equal(r.body.ok, true);
  const byId = Object.fromEntries((r.body.seafarers ?? []).map((row) => [row.id, row]));
  assert.equal(byId.credU?.claimed, true, "credentialUserId alone counts as claimed under isClaimed()");
  assert.equal(byId.wsOwner?.claimed, false, "a whitespace-only ownerEmail is NOT ownership under isClaimed()");
});
