// EXECUTED tests for the `claim` kind on POST /api/reminders (placeholder-card plan
// §4b/§9E) — the REAL route handler + REAL lib/claim-state, lib/access, lib/agentData,
// lib/claim-invite-rate-limit, transpiled in memory via the shared vm harness
// (tests/_route-harness.mjs). Only the edges are stubbed: next/server, @/lib/agent-session
// and @/lib/db (a synthetic in-memory store). @/lib/notify is stubbed EXCEPT in the one
// "env hygiene" test below, which runs the REAL notify module to prove SMTP is off.
//
// R2-6a — belt-and-braces env hygiene: an ambient dev shell exporting real SMTP creds
// must never turn this harness into a real send. Cleared FIRST, before any route loads.
delete process.env.SMTP_HOST;
delete process.env.SMTP_FROM;
delete process.env.AUTH_URL;

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRouteHarness, LIB, API } from "./_route-harness.mjs";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
let seq = 0;

function freshDB() {
  const now = new Date(T0).toISOString();
  return {
    agents: [
      { id: "agent:A", orgName: "Org A Crewing", contact: "", createdAt: now },
      { id: "agent:B", orgName: "Org B Crewing", contact: "", createdAt: now },
      { id: "agent:Z", orgName: "Org Z Crewing", contact: "", createdAt: now },
    ],
    seafarers: [
      // p1 — placeholder, agent:A's own creation, importedEmail on file, OPENED
      // (carries a stamp so the "stamp deleted" assertions have something to delete).
      {
        id: "p1", name: "Placeholder One", rank: "AB", state: "review",
        shareToken: "tok-p1", openShareToken: "tok-p1", emailShareToken: "em-p1",
        invited: true, createdByAgentId: "agent:A",
        importedEmail: "seaman1@example.invalid", shareTokenLastUsedAt: T0,
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // p2 — placeholder, agent:A's own creation, NO importedEmail, OPENED.
      {
        id: "p2", name: "Placeholder NoEmail", rank: "AB", state: "review",
        shareToken: "tok-p2", openShareToken: "tok-p2", emailShareToken: "em-p2",
        invited: true, createdByAgentId: "agent:A",
        importedEmail: null, shareTokenLastUsedAt: T0,
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // claimed1 — a real owner (ownerEmail set).
      {
        id: "claimed1", name: "Claimed One", rank: "AB", state: "review",
        shareToken: "tok-c1", openShareToken: "tok-c1", emailShareToken: "em-c1",
        ownerEmail: "real@x.com", importedEmail: "stale-import@example.invalid",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // legacy1 — unowned, but no invited/createdByAgentId provenance (NOT a placeholder).
      {
        id: "legacy1", name: "Legacy Unowned", rank: "AB", state: "review",
        shareToken: "tok-l1", openShareToken: "tok-l1", emailShareToken: "em-l1",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // sample1 — public curated sample.
      {
        id: "sample1", name: "Sample Row", rank: "AB", state: "review", isSample: true,
        shareToken: "tok-s1", openShareToken: "tok-s1", emailShareToken: "em-s1",
        importedEmail: "sample@example.invalid",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // foreignP — placeholder CREATED by agent:B, but ALSO granted to agent:A
      // (multi-agency roster) — agent:A must not be able to mail it (not-creator).
      {
        id: "foreignP", name: "Foreign-Created Placeholder", rank: "AB", state: "review",
        shareToken: "tok-fp", openShareToken: "tok-fp", emailShareToken: "em-fp",
        invited: true, createdByAgentId: "agent:B",
        importedEmail: "foreign@example.invalid",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // unstampedP — placeholder with NO createdByAgentId (legacy import) — grant
      // scope alone decides; any granted agent may manage it.
      {
        id: "unstampedP", name: "Unstamped Placeholder", rank: "AB", state: "review",
        shareToken: "tok-up", openShareToken: "tok-up", emailShareToken: "em-up",
        invited: true, importedEmail: "unstamped@example.invalid",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // foreignExisting — exists, but agent:A holds NO grant on it (agent:Z does).
      {
        id: "foreignExisting", name: "Foreign Existing", rank: "AB", state: "review",
        shareToken: "tok-fe", openShareToken: "tok-fe", emailShareToken: "em-fe",
        importedEmail: "fe@example.invalid",
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
      // toc1 — placeholder used only by the R2-5 TOCTOU test.
      {
        id: "toc1", name: "TOCTOU Placeholder", rank: "AB", state: "review",
        shareToken: "tok-toc", openShareToken: "tok-toc", emailShareToken: "em-toc",
        invited: true, createdByAgentId: "agent:A",
        importedEmail: "toc@example.invalid", shareTokenLastUsedAt: T0,
        selfProfile: {}, allowedEmails: [], birthDate: null, createdAt: now,
      },
    ],
    documents: [],
    comments: [],
    restHours: [], seaService: [], assignments: [],
    accessGrants: [
      "p1", "p2", "claimed1", "legacy1", "sample1", "foreignP", "unstampedP", "toc1",
    ].map((sid, i) => ({
      id: `g-${sid}`, seafarerId: sid, agentId: "agent:A", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: `gtok-${i}`,
      grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now,
    })).concat([
      // foreignExisting is granted to agent:Z only — never agent:A.
      {
        id: "g-fe-z", seafarerId: "foreignExisting", agentId: "agent:Z", status: "ACTIVE",
        legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "gtok-fe-z",
        grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now,
      },
    ]),
    requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
    circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
    impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
    issuedSeaTerms: [], clientPortals: [], vacancies: [],
    // agencyDisplayName() (route.ts, via lib/billing-store) reads billingProfiles on
    // every POST; empty => falls back to the agent's orgName.
    billingProfiles: [],
  };
}

let db = freshDB();
// TOCTOU knob (R2-5): when set, updateDB() runs against THIS object instead of `db`,
// simulating a claim that lands between readDB() and the commit.
let dbForUpdate = null;
let currentSession = null;
const notifyCalls = [];
// Realistic default: mirrors the real notify.ts guard order (no address -> logged,
// "no email address for recipient"; otherwise "sent"). Individual tests override this
// to exercise the "failed" / "not configured" outcomes.
let notifyImpl = async (input) => {
  notifyCalls.push(input);
  const to = input.to?.email ?? null;
  if (!to) {
    return { ok: true, delivered: false, status: "logged", reason: "no email address for recipient", logId: `n-${++seq}` };
  }
  return { ok: true, delivered: true, status: "sent", logId: `n-${++seq}` };
};

const dbStub = {
  readDB: () => db,
  updateDB: (fn) => Promise.resolve(fn(dbForUpdate ?? db)),
  serialize: (fn) => Promise.resolve(fn()),
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
};
const agentSessionStub = { agentSession: async () => currentSession, isDevLoginEnabled: false, DEV_COOKIE: "x" };
const notifyStub = { send: async (input) => notifyImpl(input) };

const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub,
    "@/lib/agent-session": agentSessionStub,
    "@/lib/notify": notifyStub,
  },
});
const remindersRoute = loadTs(path.join(API, "reminders", "route.ts"));
const claimRateLib = loadTs(path.join(LIB, "claim-invite-rate-limit.ts"));

// A second, SEPARATE harness (own module cache) that stubs @/lib/db but leaves
// @/lib/notify REAL — the one case that proves the env is actually clean (R2-6a),
// not merely asserted by grep.
let realDb = freshDB();
const realDbStub = {
  readDB: () => realDb,
  updateDB: (fn) => Promise.resolve(fn(realDb)),
  serialize: (fn) => Promise.resolve(fn()),
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
};
let realSession = null;
const { loadTs: loadTsReal } = createRouteHarness({
  stubs: {
    "@/lib/db": realDbStub,
    "@/lib/agent-session": { agentSession: async () => realSession, isDevLoginEnabled: false, DEV_COOKIE: "x" },
  },
});
const remindersRouteReal = loadTsReal(path.join(API, "reminders", "route.ts"));

function req(body, headers = {}) {
  return {
    nextUrl: { searchParams: new URLSearchParams(), origin: "http://localhost:3000" },
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body ?? {},
  };
}
function asAgent(agentId) {
  currentSession = { user: { name: `${agentId}-user`, email: `${agentId}@x.example` }, agentId };
}
function reset() {
  db = freshDB();
  dbForUpdate = null;
  currentSession = null;
  notifyCalls.length = 0;
  notifyImpl = async (input) => {
    notifyCalls.push(input);
    const to = input.to?.email ?? null;
    if (!to) {
      return { ok: true, delivered: false, status: "logged", reason: "no email address for recipient", logId: `n-${++seq}` };
    }
    return { ok: true, delivered: true, status: "sent", logId: `n-${++seq}` };
  };
  claimRateLib._resetClaimInviteRateLimit();
}
const s = (sid) => db.seafarers.find((x) => x.id === sid);

// ===========================================================================
// R2-6a — env hygiene: the REAL notify module, unstubbed, on a clean env.
// ===========================================================================

test("R2-6a: real @/lib/notify + SMTP unset => delivered:false, delivery contains 'not configured'", async () => {
  realDb = freshDB();
  realSession = { user: { name: "agent:A-user", email: "agent:A@x.example" }, agentId: "agent:A" };
  const r = await remindersRouteReal.POST(req({ seafarerIds: ["p1"], kind: "claim" }));
  assert.equal(r.status, 200, "the send is recorded, not rejected");
  assert.equal(r.body.reminders[0].delivered, false);
  assert.match(r.body.reminders[0].delivery, /not configured/, "the real notify module reports SMTP as unconfigured");
});

// ===========================================================================
// Granted placeholder w/ importedEmail — the core send path.
// ===========================================================================

test("claim: granted placeholder w/ importedEmail -> to/link/audit/stamp all correct (3 delivery variants)", async () => {
  const variants = [
    { impl: async (i) => { notifyCalls.push(i); return { ok: true, delivered: true, status: "sent", logId: "n1" }; },
      startsWith: "emailed to", delivered: true },
    { impl: async (i) => { notifyCalls.push(i); return { ok: true, delivered: false, status: "logged", reason: "email channel not configured (SMTP_HOST unset)", logId: "n2" }; },
      startsWith: "recorded only (", delivered: false },
    { impl: async (i) => { notifyCalls.push(i); return { ok: true, delivered: false, status: "failed", reason: "ECONNREFUSED", logId: "n3" }; },
      startsWith: "email failed", delivered: false },
  ];
  for (const v of variants) {
    reset();
    asAgent("agent:A");
    notifyImpl = v.impl;
    const r = await remindersRoute.POST(req({ seafarerIds: ["p1"], kind: "claim" }));
    assert.equal(r.status, 200);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].to.email, "seaman1@example.invalid", "to = importedEmail");
    assert.match(notifyCalls[0].message, /\/seafarer\?token=tok-p1/, "body carries the /seafarer?token= claim link");
    assert.doesNotMatch(notifyCalls[0].message, /\/share\//, "never the /share/ link for claim");
    const rem = r.body.reminders[0];
    assert.equal(rem.delivered, v.delivered);
    assert.ok(rem.delivery.startsWith(v.startsWith), `delivery "${rem.delivery}" should start with "${v.startsWith}"`);
    const lastComment = db.comments[db.comments.length - 1];
    assert.ok(lastComment.text.startsWith("PROFILE INVITE — link refreshed ["), "audit line names the refresh action");
    assert.equal(s("p1").shareTokenLastUsedAt, undefined, "idle stamp deleted on every outcome, incl. failed");
  }
});

test("claim: placeholder without e-mail -> 'recorded only — no e-mail on file', stamp still deleted (Refresh path)", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["p2"], kind: "claim" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.reminders[0].delivered, false);
  assert.equal(r.body.reminders[0].delivery, "recorded only — no e-mail on file for this seaman");
  assert.equal(s("p2").shareTokenLastUsedAt, undefined, "stamp deleted even with no address (Refresh = Send with no e-mail)");
});

test("claim vs request: kind:'request' still mails ownerEmail with /share/, never /seafarer?token=", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["claimed1"], kind: "request" }));
  assert.equal(r.status, 200);
  assert.equal(notifyCalls[0].to.email, "real@x.com", "request still uses ownerEmail, never importedEmail");
  assert.match(notifyCalls[0].message, /\/share\/tok-c1/);
  assert.doesNotMatch(notifyCalls[0].message, /\/seafarer\?token=/);
});

// ===========================================================================
// A2 pins.
// ===========================================================================

test("A2(a): claim ignores free-text note; request still relays it", async () => {
  reset();
  asAgent("agent:A");
  const evil = "<script>evil</script>";
  await remindersRoute.POST(req({ seafarerIds: ["p1"], kind: "claim", note: evil }));
  assert.doesNotMatch(notifyCalls[0].message, /<script>/, "claim body is the fixed template only");

  reset();
  asAgent("agent:A");
  await remindersRoute.POST(req({ seafarerIds: ["claimed1"], kind: "request", note: evil }));
  assert.match(notifyCalls[0].message, /<script>evil<\/script>/, "request still relays the note (unification-out pin)");
});

test("A2(b): 51 claim ids -> 400; 50 -> not blocked by the cap", async () => {
  reset();
  asAgent("agent:A");
  const many51 = Array.from({ length: 51 }, (_, i) => `dummy-${i}`);
  const r51 = await remindersRoute.POST(req({ seafarerIds: many51, kind: "claim" }));
  assert.equal(r51.status, 400);
  assert.match(r51.body.error, /at most 50/);

  reset();
  asAgent("agent:A");
  const many50 = Array.from({ length: 50 }, (_, i) => `dummy-${i}`);
  const r50 = await remindersRoute.POST(req({ seafarerIds: many50, kind: "claim" }));
  assert.notEqual(r50.status, 400, "50 ids clears the cap check (falls through to the not-found 404, not the cap 400)");
});

test("A2(c): 11th claim POST within 60s -> 429; window resets between tests", async () => {
  reset();
  asAgent("agent:A");
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await remindersRoute.POST(req({ seafarerIds: ["nope"], kind: "claim" }));
    statuses.push(r.status);
  }
  assert.ok(statuses.slice(0, 10).every((st) => st !== 429), "first 10 are not rate-limited");
  assert.equal(statuses[10], 429, "11th is rate-limited");
});

test("A2(d): stamped createdByAgentId of another agent -> skipped not-creator; unstamped -> processed", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["p1", "foreignP"], kind: "claim" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.reminders.length, 1, "only p1 was mailed");
  assert.ok(r.body.reminders.some((x) => x.seafarerId === "p1"));
  assert.ok(r.body.skipped.some((x) => x.id === "foreignP" && x.reason === "not-creator"));
  assert.equal(notifyCalls.some((c) => c.message?.includes("tok-fp")), false, "foreignP was never mailed");

  reset();
  asAgent("agent:A");
  const r2 = await remindersRoute.POST(req({ seafarerIds: ["unstampedP"], kind: "claim" }));
  assert.equal(r2.status, 200, "unstamped placeholder is processed by any granted agent");
  assert.equal(r2.body.reminders.length, 1);
});

// ===========================================================================
// R2-6e — the limiter is claim-only.
// ===========================================================================

test("R2-6e: the claim-invite limiter never leaks into kind:'request'", async () => {
  reset();
  asAgent("agent:A");
  const requestStatuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await remindersRoute.POST(req({ seafarerIds: ["p1"], kind: "request" }));
    requestStatuses.push(r.status);
  }
  assert.ok(requestStatuses.every((st) => st === 200), "all 11 request-kind POSTs succeed — no limiter on this kind");

  claimRateLib._resetClaimInviteRateLimit();
  const claimStatuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await remindersRoute.POST(req({ seafarerIds: ["p1"], kind: "claim" }));
    claimStatuses.push(r.status);
  }
  assert.equal(claimStatuses[10], 429, "the 11th claim POST is rate-limited");
});

// ===========================================================================
// T4 — single-id outcomes.
// ===========================================================================

test("T4: single claimed id -> 409 {claimed:true}, no send", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["claimed1"], kind: "claim" }));
  assert.equal(r.status, 409);
  assert.equal(r.body.claimed, true);
  assert.equal(notifyCalls.length, 0);
});

test("T4: sample id alone -> generic 404 (silent continue, never in skipped[])", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["sample1"], kind: "claim" }));
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "None of the selected crew were found.");
  assert.equal(r.body.skipped, undefined, "skipped is not even present on the 404 path");
  assert.equal(notifyCalls.length, 0);
});

test("T4: foreign (ungranted) existing id alone -> generic 404, indistinguishable from unknown", async () => {
  reset();
  asAgent("agent:A");
  const rForeign = await remindersRoute.POST(req({ seafarerIds: ["foreignExisting"], kind: "claim" }));
  const rUnknown = await remindersRoute.POST(req({ seafarerIds: ["does-not-exist"], kind: "claim" }));
  assert.equal(rForeign.status, 404);
  assert.equal(rUnknown.status, 404);
  assert.equal(rForeign.body.error, rUnknown.body.error, "identical 404 — no existence signal");
});

test("T4: legacy-unowned id alone -> generic 404 (not-placeholder), no send", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(req({ seafarerIds: ["legacy1"], kind: "claim" }));
  assert.equal(r.status, 404);
  assert.equal(notifyCalls.length, 0);
});

// ===========================================================================
// R2-4 — skipped[] is never an existence oracle.
// ===========================================================================

test("R2-4: skipped[] only ever names ids inside the caller's grant set", async () => {
  reset();
  asAgent("agent:A");
  const r = await remindersRoute.POST(
    req({ seafarerIds: ["p1", "foreignExisting", "does-not-exist"], kind: "claim" })
  );
  assert.equal(r.status, 200);
  assert.ok(!r.body.skipped.some((x) => x.id === "foreignExisting"), "foreign id never appears in skipped[]");
  assert.ok(!r.body.skipped.some((x) => x.id === "does-not-exist"), "unknown id never appears in skipped[]");
});

// ===========================================================================
// R2-5 — TOCTOU: the stamp delete re-checks the LIVE row inside updateDB.
// ===========================================================================

test("R2-5: a claim landing during send() leaves the idle stamp untouched (control: unclaimed -> deleted)", async () => {
  // Interleaved-claim case: readDB() (used by the loop) sees toc1 UNCLAIMED; the
  // object handed to updateDB() is a SEPARATE snapshot where toc1 has since been
  // claimed (simulating a claim landing during the awaited send()).
  reset();
  asAgent("agent:A");
  const claimedDuring = JSON.parse(JSON.stringify(db));
  claimedDuring.seafarers.find((x) => x.id === "toc1").ownerEmail = "claimer@x.com";
  dbForUpdate = claimedDuring;
  const r = await remindersRoute.POST(req({ seafarerIds: ["toc1"], kind: "claim" }));
  assert.equal(r.status, 200, "the mail still went out (the race already happened)");
  assert.equal(
    claimedDuring.seafarers.find((x) => x.id === "toc1").shareTokenLastUsedAt,
    T0,
    "stamp is NOT deleted on the now-claimed live row"
  );

  // Control: no interleaved claim -> the stamp IS deleted as normal.
  reset();
  asAgent("agent:A");
  const r2 = await remindersRoute.POST(req({ seafarerIds: ["toc1"], kind: "claim" }));
  assert.equal(r2.status, 200);
  assert.equal(s("toc1").shareTokenLastUsedAt, undefined, "control: stamp deleted when nobody claimed it meanwhile");
});
