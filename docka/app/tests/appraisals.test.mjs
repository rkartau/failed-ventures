// #43 — appraisal validation, versioned competency sets, seaman projection.
// Run: node --import ./tests/_register-alias.mjs tests/appraisals.test.mjs
import assert from "node:assert/strict";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const {
  clampRating,
  averageRating,
  sanitizeScores,
  competenciesFor,
  CURRENT_COMPETENCY_SET_VERSION,
  validateAppraisalInput,
  projectAppraisalForSeaman,
  primaryDedupeMatch,
  agentDeleteDisposition,
  hasPendingDeleteRequest,
  resolveDeleteRequestTransition,
} = await import("@/lib/appraisals");

// ---- clampRating -------------------------------------------------------
{
  assert.equal(clampRating(0), 1);
  assert.equal(clampRating(9), 5);
  assert.equal(clampRating(3), 3);
  assert.equal(clampRating("x"), 1);
  assert.equal(averageRating([{ competency: "a", rating: 4 }, { competency: "b", rating: 2 }]), 3);
  ok("clampRating clamps 1..5; averageRating rounds the mean");
}

// ---- sanitizeScores whitelist + clamp ----------------------------------
{
  const scores = sanitizeScores(
    [
      { competency: "Communication", rating: 7 },
      { competency: "NotAReal Competency", rating: 5 },
      { competency: "Teamwork", rating: 0 },
    ],
    CURRENT_COMPETENCY_SET_VERSION,
    "interview"
  );
  assert.ok(scores.every((s) => s.competency !== "NotAReal Competency"), "unknown competency dropped");
  assert.equal(scores.find((s) => s.competency === "Communication").rating, 5, "rating clamped to 5");
  assert.equal(scores.find((s) => s.competency === "Teamwork").rating, 1, "rating clamped to 1");
  ok("sanitizeScores drops unknown competencies + clamps ratings");
}

// ---- versioned competency resolution (v3 item 9) -----------------------
{
  const cur = competenciesFor("2024.1", "post_voyage");
  const old = competenciesFor("2023.1", "post_voyage");
  assert.notEqual(cur.length, old.length, "an older version resolves to ITS OWN set, not the current one");
  assert.deepEqual(old, ["Technical competence", "Safety", "Teamwork", "Reliability"]);
  ok("competenciesFor(oldVersion) resolves the pinned version's own set");
}

// ---- post_voyage requires ALL rows + vessel + both dates (item 7/8) -----
{
  const allRows = competenciesFor("2024.1", "post_voyage").map((c) => ({ competency: c, rating: 4 }));
  // Missing one competency row -> reject.
  const missingRow = validateAppraisalInput({
    kind: "post_voyage",
    recommend: "yes",
    vessel: "MV X",
    voyageFrom: "2026-01-01",
    voyageTo: "2026-06-01",
    scores: allRows.slice(1),
  });
  assert.equal(missingRow.ok, false);
  // Missing voyage dates -> reject.
  const missingDates = validateAppraisalInput({
    kind: "post_voyage",
    recommend: "yes",
    vessel: "MV X",
    scores: allRows,
  });
  assert.equal(missingDates.ok, false);
  // Full, valid card -> accept.
  const full = validateAppraisalInput({
    kind: "post_voyage",
    recommend: "yes",
    vessel: "MV X",
    voyageFrom: "2026-01-01",
    voyageTo: "2026-06-01",
    scores: allRows,
  });
  assert.equal(full.ok, true);
  ok("post_voyage requires ALL rows + vessel + both voyage dates");
}

// ---- reject {post_voyage, fastPath:true} (v3 item 9) -------------------
{
  const r = validateAppraisalInput({
    kind: "post_voyage",
    fastPath: true,
    recommend: "yes",
    overall: 4,
  });
  assert.equal(r.ok, false);
  ok("server rejects {kind:'post_voyage', fastPath:true} outright");
}

// ---- recommend 'no' requires a reason (item 9) -------------------------
{
  const noReason = validateAppraisalInput({ kind: "interview", fastPath: true, recommend: "no", overall: 2 });
  assert.equal(noReason.ok, false);
  const withReason = validateAppraisalInput({
    kind: "interview",
    fastPath: true,
    recommend: "no",
    overall: 2,
    rehireReason: "Repeated safety violations",
  });
  assert.equal(withReason.ok, true);
  ok("recommend 'no' requires a non-empty reason");
}

// ---- fast-path avg default + override (item 10) ------------------------
{
  const avg = validateAppraisalInput({
    kind: "interview",
    fastPath: true,
    recommend: "yes",
    scores: [
      { competency: "Communication", rating: 5 },
      { competency: "Teamwork", rating: 3 },
    ],
  });
  assert.equal(avg.ok, true);
  assert.equal(avg.value.overall, 4, "overall defaults to the score average when omitted");
  const override = validateAppraisalInput({
    kind: "interview",
    fastPath: true,
    recommend: "yes",
    overall: 2,
    scores: [{ competency: "Communication", rating: 5 }],
  });
  assert.equal(override.value.overall, 2, "explicit overall wins over the average");
  ok("fast-path overall defaults to score average, explicit overall overrides");
}

// ---- projectAppraisalForSeaman deep-scan (v3 item 4) -------------------
{
  const full = {
    id: "ap1",
    seafarerId: "s1",
    agentId: "agent:A",
    kind: "post_voyage",
    competencySetVersion: "2024.1",
    authorName: "Coordinator Jane",
    authorOrg: "Org A Crewing",
    vessel: "MV X",
    voyageFrom: "2026-01-01",
    voyageTo: "2026-06-01",
    assignmentId: "a1",
    scores: [{ competency: "Teamwork", rating: 4 }],
    overall: 4,
    recommend: "no",
    rehireReason: "confidential internal reason",
    comments: "internal agency-private note",
    sharedComment: "Great teamwork this voyage — well done.",
    sharedWithSeamanAt: "2026-06-02T00:00:00.000Z",
    hiddenFromAgentAt: null,
    fastPath: false,
    idempotencyKey: "k-secret",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const proj = projectAppraisalForSeaman(full);
  for (const banned of ["comments", "rehireReason", "authorName", "agentId", "idempotencyKey", "updatedAt", "sharedWithSeamanAt", "hiddenFromAgentAt"]) {
    assert.ok(!(banned in proj), `seaman projection must NOT expose ${banned}`);
  }
  assert.equal(proj.authorOrg, "Org A Crewing", "authorName is mapped to authorOrg");
  assert.equal(proj.overall, 4);
  assert.equal(proj.recommend, "no");
  // #11 — the shared comment IS in the seaman projection (the agent-private `comments` is not).
  assert.ok("sharedComment" in proj, "seaman projection MUST expose sharedComment");
  assert.equal(proj.sharedComment, "Great teamwork this voyage — well done.");
  ok("projectAppraisalForSeaman includes sharedComment; strips comments/rehireReason/authorName/agentId/idempotencyKey/updatedAt/sharedWithSeamanAt/hiddenFromAgentAt");
}

// ---- #11 validation caps + normalises sharedComment --------------------
{
  const blank = validateAppraisalInput({
    kind: "interview",
    fastPath: true,
    recommend: "yes",
    overall: 4,
    sharedComment: "   ",
  });
  assert.equal(blank.ok, true);
  assert.equal(blank.value.sharedComment, null, "whitespace-only sharedComment normalises to null");
  const long = validateAppraisalInput({
    kind: "interview",
    fastPath: true,
    recommend: "yes",
    overall: 4,
    sharedComment: "x".repeat(5000),
  });
  assert.equal(long.value.sharedComment.length, 2000, "sharedComment capped at 2000");
  ok("validateAppraisalInput caps sharedComment at 2000 + normalises whitespace to null");
}

// ---- #12 primaryDedupeMatch SKIPS hidden rows --------------------------
{
  const seafarerId = "s1", agentId = "agent:A", key = "idem-1";
  const base = { idempotencyKey: key, seafarerId, agentId };
  // A visible same-key row is the dedupe hit.
  const visibleOnly = primaryDedupeMatch(
    [{ id: "v", ...base, hiddenFromAgentAt: null }],
    key, seafarerId, agentId
  );
  assert.equal(visibleOnly.hit.id, "v", "visible same-key row is the dedupe hit");
  assert.equal(visibleOnly.staleHiddenId, null);
  // A hidden-only same-key row is NOT a hit; it is flagged to be superseded on fresh create.
  const hiddenOnly = primaryDedupeMatch(
    [{ id: "h", ...base, hiddenFromAgentAt: "2026-06-01T00:00:00.000Z" }],
    key, seafarerId, agentId
  );
  assert.equal(hiddenOnly.hit, null, "hidden same-key row must NOT dedupe a fresh write");
  assert.equal(hiddenOnly.staleHiddenId, "h", "stale hidden row is superseded on fresh create");
  // Mixed: a visible row wins (dedupe), no supersede.
  const mixed = primaryDedupeMatch(
    [
      { id: "h", ...base, hiddenFromAgentAt: "2026-06-01T00:00:00.000Z" },
      { id: "v", ...base, hiddenFromAgentAt: null },
    ],
    key, seafarerId, agentId
  );
  assert.equal(mixed.hit.id, "v");
  assert.equal(mixed.staleHiddenId, null);
  // Empty key never dedupes.
  const noKey = primaryDedupeMatch([{ id: "v", ...base, hiddenFromAgentAt: null }], "", seafarerId, agentId);
  assert.equal(noKey.hit, null);
  assert.equal(noKey.staleHiddenId, null);
  ok("primaryDedupeMatch skips hidden rows (same-key POST creates fresh + supersedes the stale hidden row)");
}

// ---- #12 agentDeleteDisposition keys on sticky sharedWithSeamanAt ------
{
  assert.equal(agentDeleteDisposition({ sharedWithSeamanAt: null }), "hard_delete");
  assert.equal(agentDeleteDisposition({ sharedWithSeamanAt: "2026-06-01T00:00:00.000Z" }), "consent");
  ok("agentDeleteDisposition: never-shared => hard_delete, ever-shared => consent");
}

// ---- #12 one-pending-per-appraisal ------------------------------------
{
  const reqs = [
    { appraisalId: "ap1", status: "pending" },
    { appraisalId: "ap2", status: "kept" },
    { appraisalId: "ap3", status: "deleted" },
  ];
  assert.equal(hasPendingDeleteRequest(reqs, "ap1"), true, "an open pending request is detected");
  assert.equal(hasPendingDeleteRequest(reqs, "ap2"), false, "a KEPT (terminal) request is not pending");
  assert.equal(hasPendingDeleteRequest(reqs, "ap3"), false, "a DELETED (terminal) request is not pending");
  assert.equal(hasPendingDeleteRequest(reqs, "nope"), false, "no request => not pending");
  ok("hasPendingDeleteRequest enforces one pending consent request per appraisal");
}

// ---- #12 delete-request state machine ---------------------------------
{
  // pending -> keep (appraisal exists): kept, no hard-delete.
  const keep = resolveDeleteRequestTransition({ status: "pending" }, "keep", true);
  assert.deepEqual(keep, { ok: true, nextStatus: "kept", hardDelete: false });
  // pending -> delete (appraisal exists): deleted + hard-delete.
  const del = resolveDeleteRequestTransition({ status: "pending" }, "delete", true);
  assert.deepEqual(del, { ok: true, nextStatus: "deleted", hardDelete: true });
  // pending -> keep, appraisal already gone: resolves terminally deleted, nothing to delete.
  const goneKeep = resolveDeleteRequestTransition({ status: "pending" }, "keep", false);
  assert.deepEqual(goneKeep, { ok: true, nextStatus: "deleted", hardDelete: false });
  // pending -> delete, appraisal already gone: terminally deleted, nothing to delete.
  const goneDel = resolveDeleteRequestTransition({ status: "pending" }, "delete", false);
  assert.deepEqual(goneDel, { ok: true, nextStatus: "deleted", hardDelete: false });
  // kept -> decide again: 409 terminal (not re-decidable).
  const keptAgain = resolveDeleteRequestTransition({ status: "kept" }, "delete", true);
  assert.deepEqual(keptAgain, { ok: false, terminal: "kept" });
  // deleted -> decide again: 409 terminal.
  const deletedAgain = resolveDeleteRequestTransition({ status: "deleted" }, "keep", true);
  assert.deepEqual(deletedAgain, { ok: false, terminal: "deleted" });
  ok("resolveDeleteRequestTransition: pending->kept/deleted, appraisal-gone->terminal deleted, terminal->409");
}

console.log(`\nappraisals.test: ${pass} assertions passed`);
