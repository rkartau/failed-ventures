// Unit tests for lib/admin-funnel.ts — the PURE admin pipeline assembly module.
//
// Feeds SYNTHETIC hand-built fixtures (not the real db.json) so the assertions are
// deterministic and independent of seed data. The module is pure + client-safe, so
// the only reason we need the alias hook is to resolve `@/lib/pipeline` (a value
// import) — Node 24 strips the TypeScript types natively.
//
// Run: node --import ./tests/_register-alias.mjs tests/admin-funnel.test.mjs

import assert from "node:assert/strict";

const {
  buildSeamenStages,
  buildAgentsStages,
  buildUserTimeline,
  minValidTime,
} = await import("@/lib/admin-funnel");

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

// Fill every DB collection so the shape is complete; only the used ones carry data.
function makeDB(partial) {
  return {
    seafarers: [],
    documents: [],
    comments: [],
    restHours: [],
    agents: [],
    assignments: [],
    accessGrants: [],
    requiredDocsConfigs: [],
    requiredDocsAudit: [],
    notifications: [],
    remindersSent: [],
    circulars: [],
    circularReplies: [],
    docRequests: [],
    profileChanges: [],
    seaService: [],
    billingProfiles: [],
    ...partial,
  };
}

const NOW = Date.parse("2026-07-20T00:00:00.000Z");

// ---- Fixtures ----------------------------------------------------------

const seafarers = [
  // S1 — at sea via STATE only (no assignment): stage5 member (approximated), NOT
  // stage4 (no approved doc) → out-of-order. Google-owned, self-signup.
  {
    id: "S1",
    name: "Anna",
    rank: "Master",
    state: "sent_to_sea",
    createdAt: "2026-01-01T00:00:00.000Z",
    invited: false,
    googleSub: "sub-anna",
    ownerEmail: "anna@x.example",
    identityVerified: false,
  },
  // S2 — has an ASSIGNMENT but canonical state is "review" → conflict; also no
  // approved doc → out-of-order. Agent-invited.
  {
    id: "S2",
    name: "Ben",
    rank: "Chief Officer",
    state: "review",
    createdAt: "2026-01-02T00:00:00.000Z",
    invited: true,
    identityVerified: false,
  },
  // S3 — zero docs, plain review, no assignment: stages 2-6 all not-tracked. Anon.
  {
    id: "S3",
    name: "Cara",
    rank: "Cook",
    state: "review",
    createdAt: "2026-01-03T00:00:00.000Z",
    invited: false,
    identityVerified: false,
  },
  // S4 — docs with ONE malformed createdAt among valid ones: stage2 reached-at must
  // be the min over the VALID dates, never NaN.
  {
    id: "S4",
    name: "Dana",
    rank: "Bosun",
    state: "review",
    createdAt: "2026-01-04T00:00:00.000Z",
    invited: false,
    identityVerified: false,
  },
  // S5 — the "clean" seaman: gov-verified + identity + approved doc + accepted.
  {
    id: "S5",
    name: "Eve",
    rank: "Second Engineer",
    state: "accepted",
    createdAt: "2026-01-05T00:00:00.000Z",
    invited: false,
    identityVerified: true,
    identityVerifiedAt: "2026-01-07T00:00:00.000Z",
  },
  // S6 — an approved doc with a NULL reviewedAt: stage4 member true, reached-at null.
  {
    id: "S6",
    name: "Finn",
    rank: "AB",
    state: "review",
    createdAt: "2026-01-06T00:00:00.000Z",
    invited: false,
    identityVerified: false,
  },
];

const documents = [
  // S4: malformed + valid createdAt.
  { id: "D1", seafarerId: "S4", title: "Passport", docType: "passport", createdAt: "not-a-date", reviewStatus: "pending", isValid: null, source: "manual" },
  { id: "D2", seafarerId: "S4", title: "Medical", docType: "medical", createdAt: "2026-01-10T00:00:00.000Z", reviewStatus: "pending", isValid: null, source: "manual" },
  // S5: approved + gov-verified.
  { id: "D3", seafarerId: "S5", title: "CoC", docType: "coc", createdAt: "2026-01-05T00:00:00.000Z", reviewStatus: "approved", reviewedBy: "agent:maria", reviewedAt: "2026-01-06T00:00:00.000Z", verifiedResolvedAt: "2026-01-07T00:00:00.000Z", isValid: true, source: "government" },
  // S6: approved but reviewedAt null.
  { id: "D4", seafarerId: "S6", title: "GMDSS", docType: "gmdss", createdAt: "2026-01-06T00:00:00.000Z", reviewStatus: "approved", reviewedBy: "agent:maria", reviewedAt: null, isValid: null, source: "manual" },
  // S2: a rejected doc whose reviewedAt is MALFORMED → drives the undated-timeline test.
  { id: "D5", seafarerId: "S2", title: "Yellow fever", docType: "vaccine", createdAt: "2026-01-02T06:00:00.000Z", reviewStatus: "rejected", reviewedBy: "agent:maria", reviewedAt: "garbage-timestamp", isValid: null, source: "manual" },
];

const assignments = [
  // S2 under agent:maria — sent to sea while state is still "review" (the conflict).
  { id: "A1", seafarerId: "S2", agentId: "agent:maria", vessel: "MV Test", sentToSeaAt: "2026-02-01T00:00:00.000Z", returnedAt: null, createdAt: "2026-02-01T00:00:00.000Z" },
];

const accessGrants = [
  { id: "G1", seafarerId: "S2", agentId: "agent:maria", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile"], shareToken: "t1", grantedAt: "2026-01-02T12:00:00.000Z", revokedAt: null, expiresAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
  // Unmapped agentId (no Agent row) — must land in unmappedGoogle, never dropped.
  { id: "G2", seafarerId: "S1", agentId: "google:ghost@x.example", status: "PENDING", legalBasis: "CONSENT", scope: ["profile"], shareToken: "t2", grantedAt: null, revokedAt: null, expiresAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
  // dev-door grant.
  { id: "G3", seafarerId: "S3", agentId: "dev", status: "ACTIVE", legalBasis: "CONSENT", scope: ["profile"], shareToken: "t3", grantedAt: null, revokedAt: null, expiresAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
];

const agents = [
  { id: "dev", orgName: "Dev door", contact: "dev@localhost", createdAt: "2025-12-01T00:00:00.000Z" },
  { id: "agent:maria", orgName: "Oceanic Crewing", contact: "maria@oceanic.example", createdAt: "2025-12-02T00:00:00.000Z" },
  { id: "agent:priya", orgName: "Blue Horizon", contact: "priya@blue.example", createdAt: "2025-12-03T00:00:00.000Z" },
];

const accessLog = [
  { id: "L1", prevHash: "x", hash: "y", at: "2026-01-03T00:00:00.000Z", seafarerId: "S2", agentId: "agent:maria", grantId: "G1", action: "VIEWED", documentRef: null },
  { id: "L2", prevHash: "x", hash: "y", at: "2026-01-04T00:00:00.000Z", seafarerId: "S1", agentId: "google:ghost@x.example", grantId: null, action: "DOWNLOADED", documentRef: "D1" },
];

const consent = [
  { id: "C1", prevHash: "x", hash: "y", at: "2026-01-02T13:00:00.000Z", grantId: "G1", type: "GRANTED", legalBasisAfter: "CONSENT", actor: "seafarer:S2" },
  // Belongs to G2 → seaman S1, NOT S2. Must NOT appear in S2's timeline.
  { id: "C2", prevHash: "x", hash: "y", at: "2026-01-05T00:00:00.000Z", grantId: "G2", type: "REQUESTED", legalBasisAfter: null, actor: "seafarer:S1" },
];

const db = makeDB({ seafarers, documents, assignments, accessGrants, agents });

// ---- 0) minValidTime -------------------------------------------------
{
  assert.equal(minValidTime([]), null, "empty set → null");
  assert.equal(minValidTime([null, undefined, "not-a-date"]), null, "all invalid → null");
  assert.equal(
    minValidTime(["not-a-date", "2026-01-10T00:00:00.000Z", "also-bad"]),
    Date.parse("2026-01-10T00:00:00.000Z"),
    "one malformed date does not poison the min"
  );
  ok("minValidTime filters invalid before min (no NaN)");
}

// ---- 1) Seamen: independent stages + out-of-order + conflict -----------
const sm = buildSeamenStages(db, NOW);
const stageCount = (key) => sm.stages.find((s) => s.key === key).count;
const rowOf = (id) => sm.rows.find((r) => r.id === id);

{
  // S1: at sea by STATE only → stage5 member, stage4 NOT member.
  const r1 = rowOf("S1");
  assert.equal(r1.stages.placed_at_sea.member, true, "S1 is at stage 5 (sent_to_sea)");
  assert.equal(r1.stages.placed_at_sea.provenance, "approximated", "S1 stage5 is state-only → approximated");
  assert.equal(r1.stages.placed_at_sea.reachedAt, null, "S1 stage5 has no assignment timestamp");
  assert.equal(r1.stages.agent_approved.member, false, "S1 is NOT at stage 4 (no approved doc)");

  const oo = sm.flags.find((f) => f.seamanId === "S1" && f.kind === "out-of-order");
  assert.ok(oo, "S1 flagged out-of-order (at sea without an approved doc)");
  ok("independent stages: S1 counted at stage 5, not stage 4, flagged out-of-order");
}

{
  // S2: assignment set while state === "review" → conflict; reached-at uses the
  // assignment timestamp (tracked); state surfaced too.
  const r2 = rowOf("S2");
  assert.equal(r2.stages.placed_at_sea.member, true, "S2 at stage 5 via assignment");
  assert.equal(r2.stages.placed_at_sea.provenance, "tracked", "S2 stage5 via assignment → tracked");
  assert.equal(
    r2.stages.placed_at_sea.reachedAt,
    Date.parse("2026-02-01T00:00:00.000Z"),
    "S2 stage5 reached-at is the assignment sentToSeaAt (tracked wins)"
  );
  const cf = sm.flags.find((f) => f.seamanId === "S2" && f.kind === "conflict");
  assert.ok(cf, "S2 flagged conflict");
  assert.equal(cf.detail.canonicalState, "review", "conflict surfaces the disagreeing state");
  assert.equal(
    cf.detail.assignmentSentToSeaAt,
    Date.parse("2026-02-01T00:00:00.000Z"),
    "conflict surfaces the assignment timestamp (both values shown, none coerced)"
  );
  ok("conflict: assignment timestamp wins as reached-at; state also surfaced");
}

{
  // S3: zero docs → stages 2-6 not-tracked (member false), no NaN.
  const r3 = rowOf("S3");
  for (const key of ["document_uploaded", "gov_verified", "identity_verified", "agent_approved", "placed_at_sea", "returned_finished"]) {
    assert.equal(r3.stages[key].member, false, `S3 ${key} not a member`);
    assert.equal(r3.stages[key].reachedAt, null, `S3 ${key} reached-at null (not NaN)`);
    assert.equal(r3.stages[key].provenance, "not-tracked", `S3 ${key} not-tracked`);
  }
  ok("empty/null: zero-doc seaman → stages 2-6 not-tracked, never NaN");
}

{
  // S4: min over one malformed + one valid createdAt = the valid one.
  const r4 = rowOf("S4");
  assert.equal(r4.stages.document_uploaded.member, true, "S4 has docs → stage2 member");
  assert.equal(
    r4.stages.document_uploaded.reachedAt,
    Date.parse("2026-01-10T00:00:00.000Z"),
    "S4 stage2 reached-at = min over the VALID doc dates (malformed ignored, no NaN)"
  );
  assert.ok(Number.isFinite(r4.stages.document_uploaded.reachedAt), "reached-at is finite, never NaN");
  ok("min() poisoning: one malformed date among valid ones does not poison stage-2 min");
}

{
  // S6: approved doc with null reviewedAt → member true, reached-at null.
  const r6 = rowOf("S6");
  assert.equal(r6.stages.agent_approved.member, true, "S6 stage4 member (approved doc)");
  assert.equal(r6.stages.agent_approved.reachedAt, null, "S6 stage4 reached-at null (null reviewedAt)");
  ok("approved doc with null reviewedAt → member true, reached-at not tracked");
}

{
  // stateDist is the authoritative current position (raw state counts).
  assert.equal(sm.stateDist.sent_to_sea, 1, "stateDist sent_to_sea = 1 (S1)");
  assert.equal(sm.stateDist.review, 4, "stateDist review = 4 (S2,S3,S4,S6)");
  assert.equal(sm.stateDist.accepted, 1, "stateDist accepted = 1 (S5)");
  // Independent stage count differs from state dist — that divergence is expected.
  assert.equal(stageCount("placed_at_sea"), 2, "stage5 count = 2 (S1 state, S2 assignment)");
  assert.equal(stageCount("account_created"), 6, "stage1 count = all 6 seamen");
  assert.equal(stageCount("agent_approved"), 2, "stage4 count = 2 (S5, S6)");
  ok("stateDist returned separately as authoritative; not reconciled to stage counts");
}

// ---- 2) Agents: Agent.id keying, dev excluded, unmapped bucket ---------
const ag = buildAgentsStages(db, accessLog, NOW);
{
  const maria = ag.rows.find((r) => r.id === "agent:maria");
  assert.ok(maria, "agent:maria in headline rows");
  assert.equal(maria.stages.first_grant.member, true, "maria stage2 (grant) member");
  assert.equal(maria.stages.first_access.member, true, "maria stage3 (access) member");
  assert.equal(maria.stages.first_crew_sent.member, true, "maria stage4 (assignment) member");
  assert.equal(
    maria.stages.first_access.reachedAt,
    Date.parse("2026-01-03T00:00:00.000Z"),
    "maria stage3 reached-at = min access-log at"
  );
  assert.equal(maria.lastActivity, Date.parse("2026-01-03T00:00:00.000Z"), "maria lastActivity = latest log");

  const priya = ag.rows.find((r) => r.id === "agent:priya");
  assert.equal(priya.stages.first_grant.member, false, "priya has no grants → stage2 not member");

  assert.ok(ag.rows.every((r) => r.id !== "dev"), "dev NOT in headline rows");
  assert.ok(ag.devExcluded && ag.devExcluded.id === "dev", "dev separated into devExcluded");

  assert.equal(ag.unmappedGoogle.length, 1, "one unmapped agentId");
  const ghost = ag.unmappedGoogle[0];
  assert.equal(ghost.agentId, "google:ghost@x.example", "unmapped agentId collected, not dropped");
  assert.equal(ghost.grantCount, 1, "unmapped grant counted");
  assert.equal(ghost.accessLogCount, 1, "unmapped access-log counted");
  ok("agents: Agent.id keyed; dev excluded; unmapped google:* bucketed, never dropped");
}

// ---- 3) Timeline: consent join, undated bucket, ascending --------------
const tl = buildUserTimeline(db, accessLog, consent, "seaman", "S2");
{
  // Consent event C1 (grant G1 → S2) present; C2 (grant G2 → S1) absent.
  const consentEvents = tl.dated.filter((e) => e.type.startsWith("consent_"));
  assert.equal(consentEvents.length, 1, "exactly one consent event resolves to S2");
  assert.equal(consentEvents[0].extra.grantId, "G1", "S2 consent resolves via grantId→seafarerId (G1)");
  assert.ok(
    !tl.dated.concat(tl.undated).some((e) => e.extra && e.extra.grantId === "G2"),
    "G2's consent (belongs to S1) never appears in S2's timeline"
  );

  // The rejected doc D5 has a malformed reviewedAt → the review_decision event is undated.
  const undatedReview = tl.undated.find((e) => e.type === "review_decision");
  assert.ok(undatedReview, "malformed-timestamp review decision goes to the undated bucket");
  assert.equal(undatedReview.at, null, "undated event has at === null (never NaN)");

  // Dated events strictly ascending.
  const ats = tl.dated.map((e) => e.at);
  for (let i = 1; i < ats.length; i++) {
    assert.ok(ats[i] >= ats[i - 1], "dated events are ascending");
  }
  assert.ok(ats.every((a) => Number.isFinite(a)), "every dated event has a finite timestamp");
  ok("timeline: consent joins via grant; malformed ts → undated; dated ascending");
}

// ---- 4) Determinism ----------------------------------------------------
{
  const a = buildSeamenStages(db, NOW);
  const b = buildSeamenStages(db, NOW);
  assert.deepEqual(a, b, "same inputs + fixed now → identical seamen output");
  const c = buildAgentsStages(db, accessLog, NOW);
  const d = buildAgentsStages(db, accessLog, NOW);
  assert.deepEqual(c, d, "same inputs + fixed now → identical agents output");
  const e = buildUserTimeline(db, accessLog, consent, "seaman", "S2");
  const f = buildUserTimeline(db, accessLog, consent, "seaman", "S2");
  assert.deepEqual(e, f, "same inputs → identical timeline output");
  ok("determinism: identical inputs yield identical output");
}

console.log(`\nPASS — ${pass} groups.`);
