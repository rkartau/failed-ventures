// tests/outreach-overrides.test.mjs — the pure override-store logic
// (lib/outreach-overrides.ts): the manual hold / move source of truth.
//
// Covers: applyOp hold/unhold (lead + company, dedupe, idempotent, version
// bump), move supersede (one pending per sendKey, id increases), move-target
// rules, normalizeCompanyKey golden-vector parity [V4] + [B6] fixture sha guard,
// toWire pending-only projection, ackMoves idempotency (unknown / already-
// applied / superseded no-op; rejected sets reason), the [R10] badge-source and
// [R11] company-vs-lead unhold display helpers, and the stage-list contract.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-overrides.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  ACTIVE_MOVE_STAGES,
  MOVE_BLOCKED_CURRENT_STAGES,
  FULL_PIPELINE_STAGES,
  normalizeCompanyKey,
  emptyOverrides,
  migrateOverrides,
  applyOp,
  applyDraftAction,
  ackDraftActions,
  pendingDraftActions,
  pendingDecisionFor,
  MAX_EDITED_BODY_BYTES,
  MAX_PENDING_DRAFT_APPROVALS,
  KEEP_FOLDED_DRAFT_ACTIONS,
  toWire,
  ackMoves,
  isLeadHeldByKey,
  isCompanyHeld,
  holdDisposition,
  companyHoldCount,
  latestMoveFor,
} = await import("@/lib/outreach-overrides");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "company_normalize_vectors.json");

const NOW = "2026-08-24T12:00:00.000Z";
const store = () => emptyOverrides(NOW);

// ---- normalizeCompanyKey: golden-vector parity [V4] ----------------------

test("[V4] normalizeCompanyKey matches the SHARED golden vector byte-for-byte", () => {
  const { vectors } = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.ok(vectors.length >= 30, `expected >=30 vectors, got ${vectors.length}`);
  for (const { input, expected } of vectors) {
    assert.equal(normalizeCompanyKey(input), expected, `input=${JSON.stringify(input)}`);
  }
});

test("normalizeCompanyKey: null / undefined / empty → ''", () => {
  assert.equal(normalizeCompanyKey(null), "");
  assert.equal(normalizeCompanyKey(undefined), "");
  assert.equal(normalizeCompanyKey(""), "");
  assert.equal(normalizeCompanyKey("   "), "");
});

test("[B6] vendored golden-vector fixture sha256 matches the pipeline single-source-of-truth", () => {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    sha,
    "0fbaa93e8812b999c743388e8633d55fc180077f61f25effa5bf730869f563c1",
    "the vendored fixture drifted from the pipeline copy — a one-sided edit must fail CI"
  );
});

// ---- Stage-list contract -------------------------------------------------

test("stage contract mirrors the pipeline (active targets, blocked current, full list)", () => {
  assert.deepEqual(
    [...ACTIVE_MOVE_STAGES],
    ["queued", "email1", "followup", "breakup", "replied", "conversation", "trial_won", "closed"]
  );
  assert.deepEqual([...MOVE_BLOCKED_CURRENT_STAGES], ["suppressed", "undeliverable"]);
  assert.deepEqual(
    [...FULL_PIPELINE_STAGES],
    ["queued", "email1", "followup", "breakup", "replied", "conversation", "trial_won", "suppressed", "closed", "undeliverable"]
  );
});

// ---- applyOp: holds ------------------------------------------------------

test("applyOp hold lead: adds, dedupes, bumps version only on real change", () => {
  const s = store();
  assert.deepEqual(applyOp(s, { op: "hold", scope: "lead", key: "sk-1" }, { now: NOW }), { ok: true, version: 1 });
  assert.deepEqual(s.holds.leads, ["sk-1"]);
  assert.equal(s.version, 1);
  // Redundant hold → idempotent no-op, version unchanged.
  assert.deepEqual(applyOp(s, { op: "hold", scope: "lead", key: "sk-1" }, { now: NOW }), { ok: true, version: 1 });
  assert.deepEqual(s.holds.leads, ["sk-1"]);
  assert.equal(s.version, 1);
});

test("applyOp hold company: NORMALIZES the key before store", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "company", key: "  Acme,  Inc. " }, { now: NOW });
  assert.deepEqual(s.holds.companies, ["acme inc"]);
  // A case/space variant is the SAME key → dedupe.
  const before = s.version;
  applyOp(s, { op: "hold", scope: "company", key: "ACME INC" }, { now: NOW });
  assert.deepEqual(s.holds.companies, ["acme inc"]);
  assert.equal(s.version, before);
});

test("applyOp hold company: empty normalised key rejected", () => {
  const s = store();
  const r = applyOp(s, { op: "hold", scope: "company", key: "   " }, { now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(s.holds.companies, []);
});

test("applyOp unhold: removes, and is a no-op when not held", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "lead", key: "sk-1" }, { now: NOW });
  assert.deepEqual(applyOp(s, { op: "unhold", scope: "lead", key: "sk-1" }, { now: NOW }), { ok: true, version: 2 });
  assert.deepEqual(s.holds.leads, []);
  const v = s.version;
  // Unhold something never held → no bump.
  applyOp(s, { op: "unhold", scope: "lead", key: "ghost" }, { now: NOW });
  assert.equal(s.version, v);
});

// ---- applyOp: moves + supersede ------------------------------------------

test("applyOp move: one pending per sendKey, supersede assigns a fresh higher id", () => {
  const s = store();
  const r1 = applyOp(s, { op: "move", sendKey: "sk-3", toStage: "conversation" }, { now: NOW, createdBy: "a@x" });
  assert.equal(r1.ok, true);
  assert.equal(s.moves.length, 1);
  assert.equal(s.moves[0].id, 1);
  assert.equal(s.moves[0].status, "pending");

  const r2 = applyOp(s, { op: "move", sendKey: "sk-3", toStage: "trial_won" }, { now: NOW, createdBy: "a@x" });
  assert.equal(r2.ok, true);
  const pending = s.moves.filter((m) => m.status === "pending");
  assert.equal(pending.length, 1, "still exactly one pending for sk-3");
  assert.equal(pending[0].id, 2, "id increased on supersede");
  assert.equal(pending[0].toStage, "trial_won");
});

test("applyOp move target rules: active→ok, suppressed/undeliverable/unknown→error, currently-suppressed→error", () => {
  const s = store();
  assert.equal(applyOp(s, { op: "move", sendKey: "k", toStage: "queued" }, { now: NOW }).ok, true);
  assert.equal(applyOp(s, { op: "move", sendKey: "k", toStage: "closed" }, { now: NOW }).ok, true, "closed is a legal target");
  assert.equal(applyOp(s, { op: "move", sendKey: "k", toStage: "suppressed" }, { now: NOW }).ok, false);
  assert.equal(applyOp(s, { op: "move", sendKey: "k", toStage: "undeliverable" }, { now: NOW }).ok, false);
  assert.equal(applyOp(s, { op: "move", sendKey: "k", toStage: "bogus" }, { now: NOW }).ok, false);
  // Lead currently suppressed → move blocked regardless of a valid target.
  assert.equal(
    applyOp(s, { op: "move", sendKey: "k", toStage: "conversation" }, { now: NOW, currentStage: "suppressed" }).ok,
    false
  );
  assert.equal(
    applyOp(s, { op: "move", sendKey: "k", toStage: "conversation" }, { now: NOW, currentStage: "undeliverable" }).ok,
    false
  );
});

// ---- toWire --------------------------------------------------------------

test("toWire: pending-only moves, version + updatedAt + holds carried", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "lead", key: "sk-1" }, { now: NOW });
  applyOp(s, { op: "hold", scope: "company", key: "Acme Inc" }, { now: NOW });
  applyOp(s, { op: "move", sendKey: "sk-3", toStage: "conversation" }, { now: NOW });
  // Ack the move → it must drop from the wire projection.
  ackMoves(s, { applied: [s.moves[0].id] }, NOW);
  applyOp(s, { op: "move", sendKey: "sk-9", toStage: "trial_won" }, { now: NOW });

  const w = toWire(s);
  assert.equal(w.ok, true);
  assert.equal(w.version, s.version);
  assert.equal(w.updatedAt, s.updatedAt);
  assert.deepEqual(w.holds.leads, ["sk-1"]);
  assert.deepEqual(w.holds.companies, ["acme inc"]);
  assert.deepEqual(w.moves, [{ id: s.moves.find((m) => m.sendKey === "sk-9").id, sendKey: "sk-9", toStage: "trial_won" }]);
});

// ---- ackMoves ------------------------------------------------------------

test("ackMoves: applied + rejected flip pending; idempotent on unknown/already/superseded", () => {
  const s = store();
  applyOp(s, { op: "move", sendKey: "a", toStage: "conversation" }, { now: NOW }); // id 1
  applyOp(s, { op: "move", sendKey: "b", toStage: "trial_won" }, { now: NOW }); // id 2
  applyOp(s, { op: "move", sendKey: "a", toStage: "replied" }, { now: NOW }); // id 3 supersedes id 1 (id1 gone)

  const r = ackMoves(s, { applied: [2], rejected: [{ id: 3, reason: "invalid target" }] }, NOW);
  assert.deepEqual(r.applied, [2]);
  assert.deepEqual(r.rejected, [3]);
  assert.equal(s.moves.find((m) => m.id === 2).status, "applied");
  assert.equal(s.moves.find((m) => m.id === 3).status, "rejected");
  assert.equal(s.moves.find((m) => m.id === 3).rejectedReason, "invalid target");

  // Idempotent: re-ack the same ids + an unknown id → nothing flips, version steady.
  const v = s.version;
  const r2 = ackMoves(s, { applied: [2, 999], rejected: [{ id: 3 }] }, NOW);
  assert.deepEqual(r2.applied, []);
  assert.deepEqual(r2.rejected, []);
  assert.equal(s.version, v, "no flip → no version bump");
});

// ---- Display helpers: [R10] badge source of truth ------------------------

test("[R10] badge reads the APP store, not the board echo (join by sendKey OR company)", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "company", key: "Acme Inc" }, { now: NOW });
  // A board lead whose echoed manualHold is FALSE but whose company is held →
  // the store says held. isCompanyHeld / holdDisposition are the truth source.
  assert.equal(isCompanyHeld(s, "  acme,  inc. "), true);
  assert.equal(isLeadHeldByKey(s, "sk-1"), false);
  const disp = holdDisposition(s, { sendKey: "sk-1", company: "Acme, Inc." });
  assert.deepEqual(disp, { held: true, heldByLead: false, heldByCompany: true });
});

// ---- [R11] company-vs-lead unhold UX (both directions) -------------------

test("[R11] un-holding a single lead of a company-held company is a no-op (still held)", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "company", key: "Acme Inc" }, { now: NOW });
  // Operator un-holds just this lead's key — but it was never a lead-hold, so
  // the store is unchanged and the lead stays held BY COMPANY.
  applyOp(s, { op: "unhold", scope: "lead", key: "sk-1" }, { now: NOW });
  const disp = holdDisposition(s, { sendKey: "sk-1", company: "Acme Inc" });
  assert.equal(disp.held, true, "still held by company");
  assert.equal(disp.heldByCompany, true);
  assert.equal(disp.heldByLead, false);
});

test("[R11] symmetric: a lead individually held while its company is NOT held", () => {
  const s = store();
  applyOp(s, { op: "hold", scope: "lead", key: "sk-1" }, { now: NOW });
  const disp = holdDisposition(s, { sendKey: "sk-1", company: "Acme Inc" });
  assert.deepEqual(disp, { held: true, heldByLead: true, heldByCompany: false });
  // Un-holding the COMPANY here is the no-op direction.
  const v = s.version;
  applyOp(s, { op: "unhold", scope: "company", key: "Acme Inc" }, { now: NOW });
  assert.equal(s.version, v, "company was never held → no bump");
  assert.equal(holdDisposition(s, { sendKey: "sk-1", company: "Acme Inc" }).held, true);
});

// ---- [R9] company hold coverage count ------------------------------------

test("[R9] companyHoldCount counts leads a company-hold covers (normalised match)", () => {
  const leads = [
    { company: "Acme, Inc." },
    { company: "ACME INC" },
    { company: "Beta Shipping" },
    { company: "  acme   inc  " },
  ];
  assert.equal(companyHoldCount(leads, "Acme Inc"), 3);
  assert.equal(companyHoldCount(leads, "Beta Shipping"), 1);
  assert.equal(companyHoldCount(leads, "   "), 0);
});

// ---- latestMoveFor (MoveSelect rejected-status surfacing [R8]) -----------

test("latestMoveFor returns the newest move (incl. rejected) for a sendKey", () => {
  const s = store();
  applyOp(s, { op: "move", sendKey: "a", toStage: "conversation" }, { now: NOW }); // id 1
  applyOp(s, { op: "move", sendKey: "a", toStage: "trial_won" }, { now: NOW }); // id 2
  ackMoves(s, { rejected: [{ id: 2, reason: "lead deleted" }] }, NOW);
  const m = latestMoveFor(s, "a");
  assert.equal(m.id, 2);
  assert.equal(m.status, "rejected");
  assert.equal(m.rejectedReason, "lead deleted");
  assert.equal(latestMoveFor(s, "nobody"), null);
});

// ---- migrateOverrides (read-migration back-compat) -----------------------

test("migrateOverrides: legacy/absent → empty; partial coerced with defaults", () => {
  assert.deepEqual(migrateOverrides(undefined, NOW), emptyOverrides(NOW));
  assert.deepEqual(migrateOverrides(null, NOW), emptyOverrides(NOW));
  assert.deepEqual(migrateOverrides(42, NOW), emptyOverrides(NOW));
  const m = migrateOverrides(
    {
      version: 5,
      holds: { leads: ["sk-1", "sk-1"], companies: ["acme inc"] },
      moves: [{ id: 3, sendKey: "x", toStage: "conversation", status: "pending" }],
      moveSeq: 3,
      updatedAt: NOW,
    },
    NOW
  );
  assert.equal(m.version, 5);
  assert.deepEqual(m.holds.leads, ["sk-1"], "deduped");
  assert.equal(m.moves.length, 1);
  assert.equal(m.moveSeq, 3);
});

// ==========================================================================
// Reply desk (wave 3 M2) — operator draft decisions
// ==========================================================================

const DRAFT = "box:42";

test("(w3) applyDraftAction: approve appends ONE pending row and bumps version", () => {
  const s = emptyOverrides(NOW);
  const r = applyDraftAction(s, { draftId: DRAFT, action: "approve" }, { now: NOW, actor: "rk@x.io" });
  assert.equal(r.ok, true);
  assert.equal(r.id, 1);
  assert.equal(r.version, 1);
  assert.equal(s.draftActions.length, 1);
  assert.deepEqual(s.draftActions[0], {
    id: 1,
    draftId: DRAFT,
    action: "approve",
    editedBody: null,
    reason: null,
    actor: "rk@x.io",
    ts: NOW,
    status: "pending",
    foldedAt: null,
  });
  // holds and moves are untouched by a decision
  assert.deepEqual(s.holds, { leads: [], companies: [] });
  assert.deepEqual(s.moves, []);
});

test("(w3) applyDraftAction: approve_edit needs a body; approve/reject must not carry one", () => {
  const s = emptyOverrides(NOW);
  assert.equal(applyDraftAction(s, { draftId: DRAFT, action: "approve_edit" }).ok, false);
  assert.equal(
    applyDraftAction(s, { draftId: DRAFT, action: "approve_edit", editedBody: "   " }).ok,
    false
  );
  assert.match(
    applyDraftAction(s, { draftId: DRAFT, action: "approve", editedBody: "sneaky" }).error,
    /must not carry an edited body/
  );
  const big = "x".repeat(MAX_EDITED_BODY_BYTES + 1);
  assert.match(
    applyDraftAction(s, { draftId: DRAFT, action: "approve_edit", editedBody: big }).error,
    /too large/
  );
  assert.equal(s.draftActions.length, 0, "nothing appended by any refusal");
  const ok = applyDraftAction(s, { draftId: DRAFT, action: "approve_edit", editedBody: "Rewritten." });
  assert.equal(ok.ok, true);
  assert.equal(s.draftActions[0].editedBody, "Rewritten.");
});

test("(w3) applyDraftAction: invalid draftId / action refused, nothing appended", () => {
  const s = emptyOverrides(NOW);
  for (const bad of [
    { draftId: "", action: "approve" },
    { draftId: "  ", action: "approve" },
    { draftId: "x".repeat(513), action: "approve" },
    { draftId: DRAFT, action: "send_now" },
  ]) {
    assert.equal(applyDraftAction(s, bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(s.draftActions.length, 0);
  assert.equal(s.version, 0);
});

test("(w3) applyDraftAction: a newer decision SUPERSEDES the pending one", () => {
  const s = emptyOverrides(NOW);
  applyDraftAction(s, { draftId: DRAFT, action: "approve" }, { now: NOW });
  applyDraftAction(s, { draftId: DRAFT, action: "reject", reason: "changed my mind" }, { now: NOW });
  assert.equal(pendingDraftActions(s).length, 1);
  assert.equal(s.draftActions[0].action, "reject");
  assert.equal(s.draftActions[0].reason, "changed my mind");
  assert.equal(s.draftActions[0].id, 2, "ids stay monotonic across a supersede");
  // ...only for the SAME draft
  applyDraftAction(s, { draftId: "box:43", action: "approve" }, { now: NOW });
  assert.equal(pendingDraftActions(s).length, 2);
});

test("(w3) [v4 6] the 50-pending cap applies to APPROVALS only - a reject always lands", () => {
  const s = emptyOverrides(NOW);
  for (let i = 0; i < MAX_PENDING_DRAFT_APPROVALS; i++) {
    assert.equal(applyDraftAction(s, { draftId: `d${i}`, action: "approve" }).ok, true, `#${i}`);
  }
  const over = applyDraftAction(s, { draftId: "one-too-many", action: "approve" });
  assert.equal(over.ok, false);
  assert.match(over.error, /too many approvals/);
  // an URGENT reject is never rate-limited out
  assert.equal(applyDraftAction(s, { draftId: "urgent", action: "reject" }).ok, true);
  assert.equal(pendingDraftActions(s).length, MAX_PENDING_DRAFT_APPROVALS + 1);
  // ...and once the pipeline folds them, approvals flow again
  ackDraftActions(s, s.draftActions.map((a) => a.id), NOW);
  assert.equal(applyDraftAction(s, { draftId: "after-fold", action: "approve" }).ok, true);
});

test("(w3) toWire: pending-only, editedBody ONLY on approve_edit (pipeline contract)", () => {
  const s = emptyOverrides(NOW);
  applyDraftAction(s, { draftId: "a", action: "approve" }, { now: NOW, actor: "rk@x.io" });
  applyDraftAction(s, { draftId: "b", action: "approve_edit", editedBody: "mine" }, { now: NOW });
  applyDraftAction(s, { draftId: "c", action: "reject", reason: "no" }, { now: NOW });
  const wire = toWire(s);
  assert.deepEqual(
    wire.draftActions.map((a) => [a.draftId, a.action, a.editedBody, a.reason]),
    [
      ["a", "approve", null, null],
      ["b", "approve_edit", "mine", null],
      ["c", "reject", null, "no"],
    ]
  );
  // folded rows leave the wire
  ackDraftActions(s, [wire.draftActions[0].id], NOW);
  assert.deepEqual(
    toWire(s).draftActions.map((a) => a.draftId),
    ["b", "c"]
  );
  // the holds/moves projection is unchanged by any of this
  assert.deepEqual(wire.holds, { leads: [], companies: [] });
  assert.deepEqual(wire.moves, []);
});

test("(w3) ackDraftActions: idempotent, version bumps only on a real flip, prunes", () => {
  const s = emptyOverrides(NOW);
  applyDraftAction(s, { draftId: "a", action: "approve" }, { now: NOW });
  const v = s.version;
  const first = ackDraftActions(s, [1, 999], NOW);
  assert.deepEqual(first.folded, [1]);
  assert.ok(s.version > v);
  const after = s.version;
  assert.deepEqual(ackDraftActions(s, [1, 999], NOW).folded, [], "re-ack is a no-op");
  assert.equal(s.version, after, "no version bump when nothing flipped");

  const big = emptyOverrides(NOW);
  const ids = [];
  for (let i = 0; i < KEEP_FOLDED_DRAFT_ACTIONS + 25; i++) {
    ids.push(applyDraftAction(big, { draftId: `d${i}`, action: "reject" }, { now: NOW }).id);
  }
  ackDraftActions(big, ids, NOW);
  assert.equal(big.draftActions.length, KEEP_FOLDED_DRAFT_ACTIONS);
  assert.equal(big.draftActions[0].id, 26, "the OLDEST folded rows are pruned");
});

test("(w3) pendingDecisionFor: surfaces a queued decision, ignores folded ones", () => {
  const s = emptyOverrides(NOW);
  assert.equal(pendingDecisionFor(s, DRAFT), null);
  assert.equal(pendingDecisionFor(s, null), null);
  applyDraftAction(s, { draftId: DRAFT, action: "approve" }, { now: NOW });
  assert.equal(pendingDecisionFor(s, DRAFT).action, "approve");
  ackDraftActions(s, [1], NOW);
  assert.equal(pendingDecisionFor(s, DRAFT), null);
});

test("(w3) migrateOverrides: legacy db.json loads with an empty decision list", () => {
  const legacy = migrateOverrides(
    { version: 5, holds: { leads: ["sk-1"] }, moves: [], moveSeq: 3, updatedAt: NOW },
    NOW
  );
  assert.deepEqual(legacy.draftActions, []);
  assert.equal(legacy.draftActionSeq, 0);
  // ...and garbage rows are dropped, seq derived from the survivors
  const messy = migrateOverrides(
    {
      draftActions: [
        { id: 4, draftId: "a", action: "approve", status: "folded", ts: NOW },
        { id: 0, draftId: "b", action: "approve" },
        { id: 9, draftId: "", action: "approve" },
        "junk",
        { id: 7, draftId: "c", action: "detonate", status: "weird" },
      ],
    },
    NOW
  );
  assert.deepEqual(
    messy.draftActions.map((a) => [a.id, a.draftId, a.action, a.status]),
    [
      [4, "a", "approve", "folded"],
      [7, "c", "approve", "pending"],
    ]
  );
  assert.equal(messy.draftActionSeq, 7);
});

// ==========================================================================
// Auto-ack handling (2026-09-08) — the `not_a_reply` decision
// ==========================================================================

test("(aa) applyDraftAction: not_a_reply appends ONE pending row — no body, no reason", () => {
  const s = emptyOverrides(NOW);
  const r = applyDraftAction(
    s,
    { draftId: "local:3bbe756e", action: "not_a_reply", reason: "ignored on this kind" },
    { now: NOW, actor: "rk@x.io" }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(s.draftActions[0], {
    id: 1,
    draftId: "local:3bbe756e",
    action: "not_a_reply",
    editedBody: null,
    reason: null,
    actor: "rk@x.io",
    ts: NOW,
    status: "pending",
    foldedAt: null,
  });
  assert.equal(s.version, 1);
  assert.deepEqual(s.holds, { leads: [], companies: [] });
  assert.deepEqual(s.moves, []);
});

test("(aa) applyDraftAction: not_a_reply must not carry an edited body", () => {
  const s = emptyOverrides(NOW);
  const r = applyDraftAction(s, { draftId: DRAFT, action: "not_a_reply", editedBody: "sneaky" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not_a_reply must not carry an edited body/);
  assert.equal(s.draftActions.length, 0);
  assert.equal(s.version, 0);
});

test("(aa) applyDraftAction: not_a_reply SUPERSEDES a pending decision for the same draft (and is superseded by one)", () => {
  const s = emptyOverrides(NOW);
  applyDraftAction(s, { draftId: DRAFT, action: "approve" }, { now: NOW });
  applyDraftAction(s, { draftId: DRAFT, action: "not_a_reply" }, { now: NOW });
  assert.equal(pendingDraftActions(s).length, 1);
  assert.equal(s.draftActions[0].action, "not_a_reply");
  assert.equal(s.draftActions[0].id, 2);
  // the operator changes their mind again → reject wins, still one pending row
  applyDraftAction(s, { draftId: DRAFT, action: "reject", reason: "a person after all" }, { now: NOW });
  assert.equal(pendingDraftActions(s).length, 1);
  assert.equal(s.draftActions[0].action, "reject");
  assert.equal(s.draftActions[0].id, 3);
  assert.equal(pendingDecisionFor(s, DRAFT).action, "reject");
});

test("(aa) [v3 A1/T3] not_a_reply is NEVER counted against the approvals cap — in either direction", () => {
  const s = emptyOverrides(NOW);
  for (let i = 0; i < MAX_PENDING_DRAFT_APPROVALS; i++) {
    assert.equal(applyDraftAction(s, { draftId: `d${i}`, action: "approve" }).ok, true, `#${i}`);
  }
  assert.equal(applyDraftAction(s, { draftId: "one-too-many", action: "approve" }).ok, false);
  // at cap: clearing a mis-stopped sequence still lands
  const r = applyDraftAction(s, { draftId: "local:3bbe756e", action: "not_a_reply" });
  assert.equal(r.ok, true);
  assert.equal(pendingDraftActions(s).length, MAX_PENDING_DRAFT_APPROVALS + 1);

  // ...and pending not_a_reply rows do not eat the approvals budget
  const t = emptyOverrides(NOW);
  for (let i = 0; i < MAX_PENDING_DRAFT_APPROVALS + 10; i++) {
    assert.equal(applyDraftAction(t, { draftId: `nar${i}`, action: "not_a_reply" }).ok, true);
  }
  for (let i = 0; i < MAX_PENDING_DRAFT_APPROVALS; i++) {
    assert.equal(applyDraftAction(t, { draftId: `ap${i}`, action: "approve" }).ok, true, `approve #${i}`);
  }
  assert.equal(applyDraftAction(t, { draftId: "ap-over", action: "approve" }).ok, false);
});

test("(aa) toWire: not_a_reply passes through as the action string, editedBody null; ack flips it to folded", () => {
  const s = emptyOverrides(NOW);
  applyDraftAction(s, { draftId: "local:3bbe756e", action: "not_a_reply" }, { now: NOW, actor: "rk@x.io" });
  const wire = toWire(s);
  assert.deepEqual(wire.draftActions, [
    {
      id: 1,
      draftId: "local:3bbe756e",
      action: "not_a_reply",
      editedBody: null,
      reason: null,
      actor: "rk@x.io",
      ts: NOW,
    },
  ]);
  const ack = ackDraftActions(s, [1], NOW);
  assert.deepEqual(ack.folded, [1]);
  assert.equal(s.draftActions[0].status, "folded");
  assert.equal(s.draftActions[0].foldedAt, NOW);
  assert.deepEqual(toWire(s).draftActions, []);
  assert.equal(pendingDecisionFor(s, "local:3bbe756e"), null);
});

test("(aa) migrateOverrides: a stored not_a_reply row keeps its action (never coerced to approve)", () => {
  const m = migrateOverrides(
    { draftActions: [{ id: 3, draftId: "local:x", action: "not_a_reply", status: "pending", ts: NOW }] },
    NOW
  );
  assert.equal(m.draftActions[0].action, "not_a_reply");
  assert.equal(m.draftActions[0].editedBody, null);
});
