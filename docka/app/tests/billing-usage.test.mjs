// THE CENTREPIECE: synthetic event-stream tests for lib/billing-usage.ts
// (STRIPE-BILLING-PLAN.md P2, cases 1-13, plus R1-6 cases 14-15 = 15 mandatory cases).
//
// Every case maps to a hazard the analysis (STRIPE-BILLING-ANALYSIS.md §C) PROVED
// exists in the real data — incomplete sinks, orphaned grant ids, hard deletes that
// erase the join row, last-value-only grant fields, merges, DST. The engine is PURE,
// so these run against hand-built arrays with zero I/O and zero db.json: nothing here
// touches the store, the network, or Stripe.
//
// HAZARD MAP
//   1  pre-sink grant + T0 baseline .......... 26/105 local grants have no GRANTED event
//   2  orphaned grantId ...................... 388 local consent events point at dead grants
//   3  hard delete mid-month ................. access.ts:648 erases the grant row
//   4  view-mode delete double signal ........ BOARD_DELETED + REVOKED_BY_AGENT both fire
//   5  re-grant same month .................. "cumulative", not "continuous"
//   6  LOCKED / UNLOCKED .................... LOCKED IS readable -> at-sea time bills
//   7  BOARD_HIDDEN / RESTORED ............... decision 4: deliberately NEUTRAL
//   8  month-straddling interval ............. per-month clipping
//   9  DST 23h / 25h months + 00:00 Tallinn .. crontab cannot express this; code must
//   10 merged seafarers ..................... db.ts:215 mergedFrom -> ONE billable head
//   11 expiry with no EXPIRED event .......... nothing schedules expireDueGrants today
//   12 exactly-24h boundary .................. >= is billable
//   13 GRANTED missing post-T0 ............... defensive fallback + surfaced warning
//   14 subscription starts mid-month ......... R1-6 billingActiveFrom clip
//   15 exempt -> non-exempt mid-month ........ R1-6 clip at the admin transition
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-usage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  BILLABLE_THRESHOLD_MS,
  buildGrantIndex,
  buildMergeCanonicalMap,
  clippedDurationMs,
  computeMonthlyUsage,
  computeMonthlyUsageWithWarnings,
  isSampleAgentId,
  normalizeCivilMidnight,
  previousTallinnPeriod,
  tallinnDayKey,
  tallinnMonthRange,
  tallinnPeriodOf,
  tallinnWallClockToUtc,
} from "@/lib/billing-usage";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const AGENT = "agent:acme";

// ---- Fixture builders ---------------------------------------------------------

let seq = 0;
const uid = (p) => `${p}-${++seq}`;

function grant(id, seafarerId, o = {}) {
  return {
    id,
    seafarerId,
    agentId: o.agentId ?? AGENT,
    status: o.status ?? "ACTIVE",
    legalBasis: "CONSENT",
    scope: [],
    shareToken: uid("tok"),
    grantedAt: o.grantedAt ?? null,
    revokedAt: null,
    expiresAt: o.expiresAt ?? null,
    createdAt: o.createdAt ?? "2026-06-11T00:00:00.000Z",
  };
}

function consent(grantId, type, at) {
  return {
    id: uid("ce"),
    prevHash: "",
    hash: "",
    at,
    grantId,
    type,
    legalBasisAfter: "CONSENT",
    actor: "system",
  };
}

function board(grantId, seafarerId, action, at, o = {}) {
  return {
    id: uid("be"),
    prevHash: "",
    hash: "",
    at,
    grantId,
    seafarerId,
    agentId: o.agentId ?? AGENT,
    action,
    ...(o.mode ? { mode: o.mode } : {}),
  };
}

function seafarer(id, o = {}) {
  return { id, name: id, rank: "", state: "review", mergedFrom: o.mergedFrom ?? [] };
}

function inputs(o = {}) {
  return {
    grants: o.grants ?? [],
    consentEvents: o.consentEvents ?? [],
    boardEvents: o.boardEvents ?? [],
    baseline: o.baseline ?? [],
    seafarers: o.seafarers ?? [],
    // Finding 18 — voyages, so the engine can mirror access.ts's LOCKED expiry rule.
    assignments: o.assignments ?? [],
    mergeArchiveRows: o.mergeArchiveRows ?? [],
    billingActiveFrom: o.billingActiveFrom ?? {},
  };
}

/** The usage row for AGENT in `period`, or a zero-shaped stand-in. */
function usage(inp, period, agentId = AGENT) {
  return (
    computeMonthlyUsage(inp, period).get(agentId) ?? {
      agentId,
      quantity: 0,
      billableSeafarerIds: [],
      detail: { period, perSeafarerMs: {}, warnings: [] },
    }
  );
}

// ===========================================================================
// CASE 1 — pre-sink grant covered by the T0 baseline row
// ===========================================================================

test("case 1: a pre-sink grant bills from T0 and NEVER before it", () => {
  const T0 = "2026-09-10T00:00:00.000Z";
  const inp = inputs({
    // The grant pre-dates the consent sink entirely (analysis §C.1) — no GRANTED
    // event exists for it anywhere.
    grants: [grant("g1", "sf1", { createdAt: "2026-06-11T00:00:00.000Z", grantedAt: "2026-06-11T00:00:00.000Z" })],
    baseline: [{ agentId: AGENT, seafarerId: "sf1", grantId: "g1", openAt: T0 }],
    seafarers: [seafarer("sf1")],
  });

  const sept = usage(inp, "2026-09");
  assert.equal(sept.quantity, 1);
  assert.deepEqual(sept.billableSeafarerIds, ["sf1"]);
  // Opens at T0, not at the June grant date.
  const { endMs } = tallinnMonthRange("2026-09");
  assert.equal(sept.detail.perSeafarerMs.sf1, endMs - Date.parse(T0));

  // Everything before T0 is out of scope — decision 3, no retro-billing.
  for (const period of ["2026-06", "2026-07", "2026-08"]) {
    assert.equal(usage(inp, period).quantity, 0, `${period} must not bill`);
  }
});

// ===========================================================================
// CASE 2 — orphaned grantId (recovery chain + unresolvable warning)
// ===========================================================================

test("case 2: an orphaned grantId resolves via board-events; a truly unresolvable one is skipped + warned", () => {
  const inp = inputs({
    // No grant rows at all: both ids were hard-deleted.
    grants: [],
    consentEvents: [
      consent("g-gone", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g-void", "GRANTED", "2026-09-01T00:00:00.000Z"),
    ],
    // Only ONE of them left a board-event trail carrying agentId + seafarerId.
    boardEvents: [board("g-gone", "sf1", "BOARD_HIDDEN", "2026-09-02T00:00:00.000Z")],
    seafarers: [seafarer("sf1")],
  });

  const sept = usage(inp, "2026-09");
  assert.equal(sept.quantity, 1, "the recoverable orphan still bills");
  assert.deepEqual(sept.billableSeafarerIds, ["sf1"]);
  // MODIFIED (finding 23d): an UNRESOLVABLE grantId is, by construction, attributable to
  // no agent — so it is surfaced on the unattributed channel (which the cron writes into
  // billing-health once per run) instead of being embedded into every tenant's persisted
  // ledger row. The invariant this case exists for is unchanged: never silently billed,
  // always surfaced.
  const { unattributedWarnings } = computeMonthlyUsageWithWarnings(inp, "2026-09");
  assert.ok(
    unattributedWarnings.some((w) => w.includes("g-void") && w.includes("unresolvable")),
    "the unresolvable orphan is surfaced as a warning, never silently billed"
  );
  assert.ok(!unattributedWarnings.some((w) => w.includes("g-gone")));
  assert.deepEqual(sept.detail.warnings, [], "and it never lands in an agency's own row");

  // The merge-archive is the third link of the recovery chain.
  const idx = buildGrantIndex([], [], [{ accessGrants: [{ id: "g-void", agentId: AGENT, seafarerId: "sf9" }] }]);
  assert.deepEqual(idx.get("g-void"), { agentId: AGENT, seafarerId: "sf9" });
});

// ===========================================================================
// CASE 3 — hard delete mid-month (board event is the ONLY close signal)
// ===========================================================================

test("case 3: a hard delete closes the interval; the >=24h already accrued still bills", () => {
  const inp = inputs({
    grants: [], // hard delete erased the row (access.ts:648)
    consentEvents: [consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z")],
    boardEvents: [board("g1", "sf1", "BOARD_DELETED", "2026-09-05T00:00:00.000Z", { mode: "hard" })],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  assert.equal(sept.quantity, 1);
  assert.equal(sept.detail.perSeafarerMs.sf1, 4 * DAY);
  // The month AFTER the delete bills nothing.
  assert.equal(usage(inp, "2026-10").quantity, 0);
});

test("case 3b: a hard delete before 24h accrued does NOT bill", () => {
  const inp = inputs({
    grants: [],
    consentEvents: [consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z")],
    boardEvents: [board("g1", "sf1", "BOARD_DELETED", "2026-09-01T20:00:00.000Z", { mode: "hard" })],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  assert.equal(sept.quantity, 0);
  assert.equal(sept.detail.perSeafarerMs.sf1, 20 * HOUR);
});

// ===========================================================================
// CASE 4 — view-mode delete emits BOTH signals: exactly ONE close
// ===========================================================================

test("case 4: view-mode delete (BOARD_DELETED + REVOKED_BY_AGENT) closes once, no double-toggle", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      // revokeGrantCore also writes this for mode:"view" (access.ts:592).
      consent("g1", "REVOKED_BY_AGENT", "2026-09-05T00:00:00.000Z"),
      consent("g1", "GRANTED", "2026-09-20T00:00:00.000Z"),
    ],
    boardEvents: [board("g1", "sf1", "BOARD_DELETED", "2026-09-05T00:00:00.000Z", { mode: "view" })],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  const { endMs } = tallinnMonthRange("2026-09");
  const expected = 4 * DAY + (endMs - Date.parse("2026-09-20T00:00:00.000Z"));
  assert.equal(
    sept.detail.perSeafarerMs.sf1,
    expected,
    "the duplicated close must not eat the later re-grant"
  );
  assert.equal(sept.quantity, 1);
});

// ===========================================================================
// CASE 5 — re-grant in the same month: CUMULATIVE, not continuous
// ===========================================================================

test("case 5: GRANTED -> WITHDRAWN -> GRANTED unions to a cumulative >=24h", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "WITHDRAWN", "2026-09-01T10:00:00.000Z"), // 10h
      consent("g1", "GRANTED", "2026-09-05T00:00:00.000Z"),
      consent("g1", "WITHDRAWN", "2026-09-05T15:00:00.000Z"), // 15h -> 25h cumulative
    ],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  assert.equal(sept.detail.perSeafarerMs.sf1, 25 * HOUR);
  assert.equal(sept.quantity, 1, "25h cumulative bills even though no single stay reached 24h");
});

// ===========================================================================
// CASE 6 — LOCKED / UNLOCKED are NEUTRAL (LOCKED is readable: at-sea time bills)
// ===========================================================================

test("case 6: LOCKED / UNLOCKED mid-month do not touch accrual", () => {
  const withLock = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "LOCKED", "2026-09-03T00:00:00.000Z"),
      consent("g1", "BASIS_CHANGED", "2026-09-03T00:00:00.000Z"),
      consent("g1", "UNLOCKED", "2026-09-08T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const withoutLock = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z")],
    seafarers: [seafarer("sf1")],
  });
  assert.equal(
    usage(withLock, "2026-09").detail.perSeafarerMs.sf1,
    usage(withoutLock, "2026-09").detail.perSeafarerMs.sf1
  );
});

test("case 6b: REQUESTED / REOPEN_DENIED / PROPAGATION_* / CLIENT_VISIBLE_* / DIRECTORY_* are NEUTRAL", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1", { status: "PENDING" })],
    consentEvents: [
      consent("g1", "REQUESTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "REOPEN_DENIED", "2026-09-02T00:00:00.000Z"),
      consent("g1", "PROPAGATION_GRANTED", "2026-09-03T00:00:00.000Z"),
      consent("g1", "CLIENT_VISIBLE_GRANTED", "2026-09-04T00:00:00.000Z"),
      consent("g1", "DIRECTORY_CONSENT_GRANTED", "2026-09-05T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  // PENDING is not readable and none of these events opens anything.
  assert.equal(usage(inp, "2026-09").quantity, 0);
});

// ===========================================================================
// CASE 7 — BOARD_HIDDEN / BOARD_RESTORED are DELIBERATELY IGNORED (decision 4)
// ===========================================================================

test("case 7: hide/restore never pause billing, including a May->July straddle", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [consent("g1", "GRANTED", "2026-05-01T00:00:00.000Z")],
    boardEvents: [
      board("g1", "sf1", "BOARD_HIDDEN", "2026-05-10T00:00:00.000Z"),
      board("g1", "sf1", "BOARD_RESTORED", "2026-07-05T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  // June is entirely inside the hidden window and still bills in full.
  const june = usage(inp, "2026-06");
  const { startMs, endMs } = tallinnMonthRange("2026-06");
  assert.equal(june.quantity, 1);
  assert.equal(june.detail.perSeafarerMs.sf1, endMs - startMs);
  for (const period of ["2026-05", "2026-07"]) {
    assert.equal(usage(inp, period).quantity, 1, `${period} bills too`);
  }
});

// ===========================================================================
// CASE 8 — month-straddling interval clipped per month
// ===========================================================================

test("case 8: an interval opening 20 Jan and closing 5 Mar is clipped into each month", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1")],
    consentEvents: [
      consent("g1", "GRANTED", "2026-01-20T00:00:00.000Z"),
      consent("g1", "WITHDRAWN", "2026-03-05T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const jan = tallinnMonthRange("2026-01");
  const feb = tallinnMonthRange("2026-02");
  const mar = tallinnMonthRange("2026-03");

  assert.equal(usage(inp, "2026-01").detail.perSeafarerMs.sf1, jan.endMs - Date.parse("2026-01-20T00:00:00.000Z"));
  assert.equal(usage(inp, "2026-02").detail.perSeafarerMs.sf1, feb.endMs - feb.startMs, "February bills in full");
  assert.equal(usage(inp, "2026-03").detail.perSeafarerMs.sf1, Date.parse("2026-03-05T00:00:00.000Z") - mar.startMs);
  assert.equal(usage(inp, "2025-12").quantity, 0);
  assert.equal(usage(inp, "2026-04").quantity, 0);
});

// ===========================================================================
// CASE 9 — DST: a 23h March and a 25h October, and 00:00 Tallinn != 00:00 UTC
// ===========================================================================

test("case 9a: tallinnMonthRange is DST-correct — March 2026 is 23h SHORT of 31 days", () => {
  const mar = tallinnMonthRange("2026-03");
  // 1 Mar 00:00 Tallinn is UTC+2 (winter); 1 Apr 00:00 Tallinn is UTC+3 (summer).
  assert.equal(new Date(mar.startMs).toISOString(), "2026-02-28T22:00:00.000Z");
  assert.equal(new Date(mar.endMs).toISOString(), "2026-03-31T21:00:00.000Z");
  assert.equal(mar.endMs - mar.startMs, 31 * DAY - HOUR, "the last Sunday of March has 23 hours");
});

test("case 9b: tallinnMonthRange is DST-correct — October 2026 is 25h LONG of 31 days", () => {
  const oct = tallinnMonthRange("2026-10");
  assert.equal(new Date(oct.startMs).toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(new Date(oct.endMs).toISOString(), "2026-10-31T22:00:00.000Z");
  assert.equal(oct.endMs - oct.startMs, 31 * DAY + HOUR, "the last Sunday of October has 25 hours");
});

test("case 9c: a pair visible for exactly the wall-clock month bills, in both DST directions", () => {
  for (const period of ["2026-03", "2026-10"]) {
    const { startMs, endMs } = tallinnMonthRange(period);
    const inp = inputs({
      grants: [grant("g1", "sf1")],
      consentEvents: [
        consent("g1", "GRANTED", new Date(startMs).toISOString()),
        consent("g1", "WITHDRAWN", new Date(endMs).toISOString()),
      ],
      seafarers: [seafarer("sf1")],
    });
    const u = usage(inp, period);
    assert.equal(u.quantity, 1);
    assert.equal(u.detail.perSeafarerMs.sf1, endMs - startMs, `${period} accrues the whole wall-clock month`);
  }
});

test("case 9d: the period boundary is 00:00 TALLINN, not 00:00 UTC", () => {
  // Summer: Tallinn is UTC+3, so 21:30Z on 31 Aug is already 00:30 on 1 Sep locally.
  assert.equal(tallinnPeriodOf(Date.parse("2026-08-31T21:30:00.000Z")), "2026-09");
  assert.equal(tallinnPeriodOf(Date.parse("2026-08-31T20:30:00.000Z")), "2026-08");
  // Winter: Tallinn is UTC+2.
  assert.equal(tallinnPeriodOf(Date.parse("2026-12-31T22:30:00.000Z")), "2027-01");
  assert.equal(tallinnDayKey(Date.parse("2026-08-31T21:30:00.000Z")), "2026-09-01");
  assert.equal(previousTallinnPeriod(Date.parse("2026-01-01T00:00:00.000Z")), "2025-12");
  assert.equal(previousTallinnPeriod(Date.parse("2026-08-31T21:30:00.000Z")), "2026-08");
  assert.equal(
    tallinnWallClockToUtc(2026, 7, 1, 0, 0, 0),
    Date.parse("2026-06-30T21:00:00.000Z"),
    "summer wall clock resolves through UTC+3"
  );
});

// ===========================================================================
// CASE 10 — merged seafarers are ONE billable head
// ===========================================================================

test("case 10: two merged profiles granted to the same agency count once", () => {
  const inp = inputs({
    grants: [grant("gA", "sfA"), grant("gB", "sfB")],
    consentEvents: [
      consent("gA", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("gB", "GRANTED", "2026-09-01T00:00:00.000Z"),
    ],
    // sfA was absorbed into the survivor sfB (db.ts:215).
    seafarers: [seafarer("sfB", { mergedFrom: ["sfA"] })],
  });
  const sept = usage(inp, "2026-09");
  assert.equal(sept.quantity, 1, "one head, not two");
  assert.deepEqual(sept.billableSeafarerIds, ["sfB"]);
  assert.equal(Object.keys(sept.detail.perSeafarerMs).length, 1);

  // Chained merges collapse to the final survivor.
  const chain = buildMergeCanonicalMap([seafarer("C", { mergedFrom: ["B"] }), seafarer("B", { mergedFrom: ["A"] })]);
  assert.equal(chain.get("A"), "C");
  assert.equal(chain.get("B"), "C");
});

// ===========================================================================
// CASE 11 — grant past expiresAt with NO EXPIRED event (nothing schedules the sweep)
// ===========================================================================

test("case 11: a grant sailing past expiresAt with no EXPIRED event closes synthetically", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1", { expiresAt: "2026-09-03T00:00:00.000Z" })],
    consentEvents: [consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z")],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  assert.equal(sept.detail.perSeafarerMs.sf1, 2 * DAY, "closes at expiresAt, not at month end");
  assert.equal(sept.quantity, 1);
  assert.equal(usage(inp, "2026-10").quantity, 0, "no accrual after expiry");
});

test("case 11b: a real EXPIRED event wins — no duplicate synthetic close", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1", { status: "EXPIRED", expiresAt: "2026-09-03T00:00:00.000Z" })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "EXPIRED", "2026-09-02T12:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  assert.equal(usage(inp, "2026-09").detail.perSeafarerMs.sf1, 36 * HOUR);
});

// ===========================================================================
// CASE 12 — the >= 24h boundary
// ===========================================================================

test("case 12: exactly 24h IS billable; 23h59m is not", () => {
  const build = (closeAt) =>
    inputs({
      grants: [grant("g1", "sf1")],
      consentEvents: [
        consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
        consent("g1", "WITHDRAWN", closeAt),
      ],
      seafarers: [seafarer("sf1")],
    });

  const exact = usage(build("2026-09-02T00:00:00.000Z"), "2026-09");
  assert.equal(exact.detail.perSeafarerMs.sf1, BILLABLE_THRESHOLD_MS);
  assert.equal(exact.quantity, 1, ">= 24h is billable");

  const justUnder = usage(build("2026-09-01T23:59:00.000Z"), "2026-09");
  assert.equal(justUnder.detail.perSeafarerMs.sf1, BILLABLE_THRESHOLD_MS - 60_000);
  assert.equal(justUnder.quantity, 0, "23h59m is not");
});

// ===========================================================================
// CASE 13 — post-T0 grant whose GRANTED event never made the sink
// ===========================================================================

test("case 13: a readable grant with no GRANTED event falls back to grantedAt and WARNS", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1", { grantedAt: "2026-09-05T00:00:00.000Z" })],
    consentEvents: [],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  const { endMs } = tallinnMonthRange("2026-09");
  assert.equal(sept.detail.perSeafarerMs.sf1, endMs - Date.parse("2026-09-05T00:00:00.000Z"));
  assert.ok(
    sept.detail.warnings.some((w) => w.includes("g1") && w.includes("no GRANTED event")),
    "the fallback is surfaced, never silent"
  );

  // grantedAt null -> createdAt is the floor.
  const inp2 = inputs({
    grants: [grant("g2", "sf2", { grantedAt: null, createdAt: "2026-09-07T00:00:00.000Z" })],
    seafarers: [seafarer("sf2")],
  });
  assert.equal(
    usage(inp2, "2026-09").detail.perSeafarerMs.sf2,
    endMs - Date.parse("2026-09-07T00:00:00.000Z")
  );
});

// ===========================================================================
// CASE 14 — R1-6: the subscription starts on the 25th
// ===========================================================================

test("case 14: intervals before billingActiveFrom are never billed", () => {
  const activeFrom = "2026-09-25T00:00:00.000Z";
  const inp = inputs({
    grants: [grant("g1", "sf1"), grant("g2", "sf2")],
    consentEvents: [
      // sf1 is visible the whole month.
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      // sf2 was visible only BEFORE the subscription started.
      consent("g2", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "WITHDRAWN", "2026-09-10T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1"), seafarer("sf2")],
    billingActiveFrom: { [AGENT]: activeFrom },
  });
  const sept = usage(inp, "2026-09");
  const { endMs } = tallinnMonthRange("2026-09");
  assert.deepEqual(sept.billableSeafarerIds, ["sf1"]);
  assert.equal(sept.detail.perSeafarerMs.sf1, endMs - Date.parse(activeFrom));
  assert.equal(sept.detail.perSeafarerMs.sf2, undefined, "pre-subscription days accrue nothing");

  // A month wholly before the subscription computes to nothing billable at all.
  assert.equal(usage(inp, "2026-08").quantity, 0);
});

// ===========================================================================
// CASE 15 — R1-6: exempt -> non-exempt transition mid-month
// ===========================================================================

test("case 15: an un-exempt transition mid-month clips the comped days away", () => {
  const transition = "2026-09-21T00:00:00.000Z";
  const inp = inputs({
    grants: [grant("g1", "sf1"), grant("g2", "sf2")],
    consentEvents: [
      // sf1: visible all month -> ~9 days after the transition -> billable.
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      // sf2: 20 comped days, then only 12h after the transition -> NOT billable.
      consent("g2", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "WITHDRAWN", "2026-09-21T12:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1"), seafarer("sf2")],
    billingActiveFrom: { [AGENT]: transition },
  });
  const sept = usage(inp, "2026-09");
  assert.deepEqual(sept.billableSeafarerIds, ["sf1"]);
  assert.equal(sept.detail.perSeafarerMs.sf2, 12 * HOUR, "only post-transition time counts");
  assert.equal(sept.quantity, 1);
});

// ===========================================================================
// Supporting invariants
// ===========================================================================

test("R1-7: demo-class agents never accrue usage at all", () => {
  assert.equal(isSampleAgentId("dev"), true);
  assert.equal(isSampleAgentId("sample-agency-crewing"), true);
  assert.equal(isSampleAgentId("agent:acme"), false);

  const inp = inputs({
    grants: [grant("g1", "sf1", { agentId: "dev" }), grant("g2", "sf2", { agentId: "sample-agency-crewing" })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "GRANTED", "2026-09-01T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1"), seafarer("sf2")],
  });
  assert.equal(computeMonthlyUsage(inp, "2026-09").size, 0);
});

test("multi-tenant: each agency's usage is computed independently", () => {
  const other = "agent:beta";
  const inp = inputs({
    grants: [grant("g1", "sf1"), grant("g2", "sf1", { agentId: other })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "GRANTED", "2026-09-28T00:00:00.000Z"), // < 24h before month end? no: ~2 days
      consent("g2", "WITHDRAWN", "2026-09-28T06:00:00.000Z"), // 6h -> not billable
    ],
    seafarers: [seafarer("sf1")],
  });
  const all = computeMonthlyUsage(inp, "2026-09");
  assert.equal(all.get(AGENT).quantity, 1);
  assert.equal(all.get(other).quantity, 0);
  assert.equal(all.get(other).detail.perSeafarerMs.sf1, 6 * HOUR);
});

test("clippedDurationMs unions overlapping intervals instead of summing them", () => {
  const win = [0, 100 * HOUR];
  assert.equal(clippedDurationMs([{ start: 0, end: 10 * HOUR }, { start: 5 * HOUR, end: 15 * HOUR }], ...win), 15 * HOUR);
  assert.equal(clippedDurationMs([{ start: 0, end: 10 * HOUR }, { start: 20 * HOUR, end: 25 * HOUR }], ...win), 15 * HOUR);
  assert.equal(clippedDurationMs([{ start: -50 * HOUR, end: 200 * HOUR }], ...win), 100 * HOUR);
  assert.equal(clippedDurationMs([], ...win), 0);
});

test("scale: a realistic month of sink traffic computes well under a second", () => {
  const grants = [];
  const consentEvents = [];
  const seafarers = [];
  const agents = 8;
  const perAgent = 60;
  for (let a = 0; a < agents; a++) {
    for (let s = 0; s < perAgent; s++) {
      const gid = `g-${a}-${s}`;
      const sid = `sf-${a}-${s}`;
      grants.push(grant(gid, sid, { agentId: `agent:${a}` }));
      seafarers.push(seafarer(sid));
      consentEvents.push(consent(gid, "GRANTED", "2026-09-01T00:00:00.000Z"));
      // Half of them churn a few times inside the month.
      if (s % 2 === 0) {
        consentEvents.push(consent(gid, "WITHDRAWN", "2026-09-08T00:00:00.000Z"));
        consentEvents.push(consent(gid, "GRANTED", "2026-09-12T00:00:00.000Z"));
        consentEvents.push(consent(gid, "LOCKED", "2026-09-14T00:00:00.000Z"));
        consentEvents.push(consent(gid, "UNLOCKED", "2026-09-18T00:00:00.000Z"));
      }
    }
  }
  const inp = inputs({ grants, consentEvents, seafarers });
  const t0 = Date.now();
  const out = computeMonthlyUsage(inp, "2026-09");
  const elapsed = Date.now() - t0;
  assert.equal(out.size, agents);
  assert.equal(out.get("agent:0").quantity, perAgent);
  assert.ok(elapsed < 1000, `computeMonthlyUsage took ${elapsed}ms (budget 1000ms)`);
});

// ===========================================================================
// F1 / FINDING 18 — the expiry definition must match the board's
// ===========================================================================
//
// access.ts:103-112 SUPPRESSES expiry while a live assignment makes the grant LOCKED:
// the seafarer stays on the board, the dossier stays readable, and the lock resolves
// only on unlock. The usage engine used to close the interval at the RAW expiresAt, so
// readable at-sea time past the expiry was silently unbilled.

function assignment(id, seafarerId, sentToSeaAt, returnedAt = null, o = {}) {
  return {
    id,
    seafarerId,
    agentId: o.agentId ?? AGENT,
    vessel: o.vessel ?? "MV Test",
    sentToSeaAt,
    returnedAt,
    createdAt: sentToSeaAt,
  };
}

test("F1 at-sea expiry: a grant expiring mid-voyage keeps billing until the voyage closes it", () => {
  // Granted 1 Sep, expiresAt 5 Sep, but the man sailed on 3 Sep and came back on 20 Sep.
  // The board showed him the whole time (LOCKED), so the whole time is billable.
  const g = grant("g-sea", "sf-sea", { expiresAt: "2026-09-05T00:00:00.000Z" });
  const base = {
    grants: [g],
    consentEvents: [consent("g-sea", "GRANTED", "2026-09-01T00:00:00.000Z")],
    seafarers: [seafarer("sf-sea")],
  };

  // (a) NO voyage: the synthetic expiry close still applies — 4 days, unchanged.
  const ashore = computeMonthlyUsage(inputs(base), "2026-09");
  assert.equal(ashore.get(AGENT).detail.perSeafarerMs["sf-sea"], 4 * DAY);

  // (b) A voyage spanning the expiry: billing runs to the RETURN, not the expiry.
  const atSea = computeMonthlyUsage(
    inputs({
      ...base,
      assignments: [assignment("a-sea", "sf-sea", "2026-09-03T00:00:00.000Z", "2026-09-20T00:00:00.000Z")],
    }),
    "2026-09"
  );
  assert.equal(
    atSea.get(AGENT).detail.perSeafarerMs["sf-sea"],
    19 * DAY,
    "1 Sep -> 20 Sep: the at-sea days past the expiry are readable, so they bill"
  );
  assert.equal(atSea.get(AGENT).quantity, 1);
});

test("F1 at-sea expiry: a voyage still OPEN at compute time leaves the interval open (FR1-10a)", () => {
  const g = grant("g-open", "sf-open", { expiresAt: "2026-09-05T00:00:00.000Z" });
  const out = computeMonthlyUsage(
    inputs({
      grants: [g],
      consentEvents: [consent("g-open", "GRANTED", "2026-09-01T00:00:00.000Z")],
      seafarers: [seafarer("sf-open")],
      assignments: [assignment("a-open", "sf-open", "2026-09-03T00:00:00.000Z", null)],
    }),
    "2026-09"
  );
  const { startMs, endMs } = tallinnMonthRange("2026-09");
  assert.equal(
    out.get(AGENT).detail.perSeafarerMs["sf-open"],
    endMs - Date.parse("2026-09-01T00:00:00.000Z"),
    "still at sea => still readable => bills through the end of the window"
  );
  assert.ok(endMs > startMs);
});

test("F1 at-sea expiry: ANOTHER agency's voyage never suppresses this agency's expiry", () => {
  const g = grant("g-x", "sf-x", { expiresAt: "2026-09-05T00:00:00.000Z" });
  const out = computeMonthlyUsage(
    inputs({
      grants: [g],
      consentEvents: [consent("g-x", "GRANTED", "2026-09-01T00:00:00.000Z")],
      seafarers: [seafarer("sf-x")],
      assignments: [
        assignment("a-x", "sf-x", "2026-09-03T00:00:00.000Z", null, { agentId: "agent:other" }),
      ],
    }),
    "2026-09"
  );
  assert.equal(
    out.get(AGENT).detail.perSeafarerMs["sf-x"],
    4 * DAY,
    "the lock is per (agent, seafarer) — a foreign voyage is not this agency's board"
  );
});

// ===========================================================================
// R3-1 — the synthetic-expiry guard tests "pair OPEN at closeAt", not "any earlier
// close exists" (D-1). A re-granted pair must not bill post-expiry days.
// ===========================================================================

test("R3-1 re-granted pair past expiry: grant1 withdrawn then grant2 sails past its own expiry — post-expiry days are NOT billed", () => {
  // grant1 (no expiry) opens Sep1, is WITHDRAWN Sep2; grant2 (its own expiresAt Sep8)
  // is GRANTED Sep5 and never gets an EXPIRED event. Both share the (AGENT, sf1) pair.
  const inp = inputs({
    grants: [grant("g1", "sf1"), grant("g2", "sf1", { expiresAt: "2026-09-08T00:00:00.000Z" })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "WITHDRAWN", "2026-09-02T00:00:00.000Z"),
      consent("g2", "GRANTED", "2026-09-05T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  // [Sep1,Sep2] ∪ [Sep5,Sep8] = 1 day + 3 days. grant2's synthetic close at Sep8 fires
  // because the pair is OPEN at Sep8 (last toggle is grant2's Sep5 open).
  assert.equal(sept.detail.perSeafarerMs.sf1, 1 * DAY + 3 * DAY, "closes at grant2's expiry, not month end");
  assert.equal(sept.quantity, 1);
  // The month AFTER expiry bills nothing — the old "any earlier close" guard suppressed
  // the synthetic close and billed [Sep5, windowEnd] plus all of October.
  assert.equal(usage(inp, "2026-10").quantity, 0, "no post-expiry accrual");
});

test("R3-1 no regression: a single grant withdrawn before its expiry stays closed (not reopened)", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1", { expiresAt: "2026-09-08T00:00:00.000Z" })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g1", "WITHDRAWN", "2026-09-02T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  // Withdrawn Sep2, before the Sep8 expiry: the pair is CLOSED at Sep8, so no synthetic
  // close is pushed and the closed interval is never reopened.
  assert.equal(sept.detail.perSeafarerMs.sf1, 1 * DAY, "[Sep1,Sep2], never reopened");
  assert.equal(usage(inp, "2026-10").quantity, 0);
});

test("R3-1 no regression: two overlapping grants with one expiresAt still merge and close at the synthetic expiry", () => {
  const inp = inputs({
    grants: [grant("g1", "sf1"), grant("g2", "sf1", { expiresAt: "2026-09-08T00:00:00.000Z" })],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "GRANTED", "2026-09-03T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  // Overlapping opens fold to one interval; the pair is OPEN at Sep8, so the merged
  // interval closes at the synthetic expiry: [Sep1, Sep8] = 7 days.
  assert.equal(sept.detail.perSeafarerMs.sf1, 7 * DAY, "[Sep1,Sep8] merged, closes at expiry");
  assert.equal(sept.quantity, 1);
  assert.equal(usage(inp, "2026-10").quantity, 0);
});

test("R3-known: two overlapping same-pair grants with different expiresAt currently under-bill the tail (documented model limit, R3-FR1-3)", () => {
  // g1 expires Sep5, g2 expires Sep10; both granted, neither withdrawn, overlapping.
  // g1's earlier synthetic close truncates g2's still-valid tail [Sep5,Sep10]. This is a
  // model-inherent UNDER-bill (docka loses revenue), pre-existing and NOT regressed by
  // pairOpenAt (both predicates under-bill identically). Pinned so a future per-grant
  // interval refactor is forced to revisit it. OWNER NOTE: revenue leak, out of scope here.
  const inp = inputs({
    grants: [
      grant("g1", "sf1", { expiresAt: "2026-09-05T00:00:00.000Z" }),
      grant("g2", "sf1", { expiresAt: "2026-09-10T00:00:00.000Z" }),
    ],
    consentEvents: [
      consent("g1", "GRANTED", "2026-09-01T00:00:00.000Z"),
      consent("g2", "GRANTED", "2026-09-02T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf1")],
  });
  const sept = usage(inp, "2026-09");
  // CURRENT (truncated) total: [Sep1, Sep5] = 4 days. The tail [Sep5, Sep10] is lost.
  assert.equal(sept.detail.perSeafarerMs.sf1, 4 * DAY, "documents the truncated tail (known under-bill)");
});

// ===========================================================================
// R3-9 — midnight "24" normalization rolls the civil DATE, not just the hour (D-2).
// ===========================================================================

test("R3-9 midnight-24 normalization rolls the civil date, not just the hour", () => {
  // A month-boundary midnight rendered as the prior day's 24:00 must carry to the 1st.
  assert.deepEqual(
    normalizeCivilMidnight({ year: 2026, month: 3, day: 31, hour: 24, minute: 0, second: 0 }),
    { year: 2026, month: 4, day: 1, hour: 0, minute: 0, second: 0 }
  );
  // Year boundary rolls too.
  assert.deepEqual(
    normalizeCivilMidnight({ year: 2026, month: 12, day: 31, hour: 24, minute: 30, second: 15 }),
    { year: 2027, month: 1, day: 1, hour: 0, minute: 30, second: 15 }
  );
  // A non-24 hour is returned untouched (identity — the common case).
  const noon = { year: 2026, month: 6, day: 15, hour: 12, minute: 0, second: 0 };
  assert.equal(normalizeCivilMidnight(noon), noon);
});

// ===========================================================================
// F6 — warnings attribution (23d) and the onlyAgentId narrowing (23c)
// ===========================================================================

test("F6 warnings attribution: agent A's orphan-grant warning never appears in agent B's detail", () => {
  // FINDING 23d: the engine built ONE flat warnings array and embedded the WHOLE array
  // into every agent's persisted `detail`. Every tenant's ledger row therefore carried
  // every other tenant's data-quality noise — unbounded db.json growth, and a small
  // cross-tenant leak into the admin drill-down.
  const inp = inputs({
    grants: [
      // A grant with no GRANTED event => a warning attributed to agent A.
      grant("g-a", "sf-a", { agentId: "agent:A", grantedAt: "2026-09-01T00:00:00.000Z" }),
      grant("g-b", "sf-b", { agentId: "agent:B", grantedAt: "2026-09-01T00:00:00.000Z" }),
    ],
    // Only B's grant has its GRANTED event, so ONLY A gets the fallback warning.
    consentEvents: [
      consent("g-b", "GRANTED", "2026-09-01T00:00:00.000Z"),
      // …plus an event for a grant nobody can resolve: attributable to no agent at all.
      consent("g-nowhere", "GRANTED", "2026-09-02T00:00:00.000Z"),
    ],
    seafarers: [seafarer("sf-a"), seafarer("sf-b")],
  });

  const { usage: out, unattributedWarnings } = computeMonthlyUsageWithWarnings(inp, "2026-09");
  const a = out.get("agent:A");
  const b = out.get("agent:B");
  assert.equal(a.quantity, 1);
  assert.equal(b.quantity, 1);

  assert.ok(
    a.detail.warnings.some((w) => w.includes("g-a")),
    "A keeps its OWN warning"
  );
  assert.ok(!a.detail.warnings.some((w) => w.includes("g-b")), "…and never sees B's");
  assert.deepEqual(b.detail.warnings, [], "B's row is clean — it had no problem of its own");

  for (const row of [a, b]) {
    assert.ok(
      !row.detail.warnings.some((w) => w.includes("g-nowhere")),
      "an unattributable warning is in NOBODY's ledger row"
    );
  }
  assert.ok(
    unattributedWarnings.some((w) => w.includes("g-nowhere")),
    "…it goes to the cron's billing-health channel instead, once per run"
  );
});

test("F6 FR1-10c: onlyAgentId narrows the FOLD, and the answer is identical to the unfiltered compute", () => {
  // FINDING 23c: `usagePreviewForAgent` folded EVERY tenant's intervals on every
  // billing-page GET and every admin drill-down, then threw all but one away.
  const grants = [];
  const consentEvents = [];
  const seafarers = [];
  for (const agentId of ["agent:A", "agent:B", "agent:C"]) {
    for (let i = 0; i < 4; i++) {
      const gid = `g-${agentId}-${i}`;
      const sid = `sf-${agentId}-${i}`;
      grants.push(grant(gid, sid, { agentId }));
      seafarers.push(seafarer(sid));
      consentEvents.push(consent(gid, "GRANTED", "2026-09-01T00:00:00.000Z"));
      // Churn half of them so the interval algebra is doing real work.
      if (i % 2 === 0) {
        consentEvents.push(consent(gid, "WITHDRAWN", "2026-09-10T00:00:00.000Z"));
        consentEvents.push(consent(gid, "GRANTED", "2026-09-14T00:00:00.000Z"));
      }
    }
  }
  const inp = inputs({ grants, consentEvents, seafarers });

  const unfiltered = computeMonthlyUsage(inp, "2026-09");
  const narrowed = computeMonthlyUsage(inp, "2026-09", "agent:B");

  assert.deepEqual(
    [...narrowed.keys()],
    ["agent:B"],
    "the narrowed compute returns ONLY the requested agency"
  );
  assert.deepEqual(
    narrowed.get("agent:B"),
    unfiltered.get("agent:B"),
    "…and its row is byte-identical to the unfiltered one (FR1-10c)"
  );
  assert.equal(unfiltered.size, 3, "the unfiltered compute still covers everyone");

  // A narrowing to an agent with no intervals at all is simply empty, never a throw.
  assert.equal(computeMonthlyUsage(inp, "2026-09", "agent:NOBODY").size, 0);
});
