// Unit tests for lib/billing-cron.ts — the auth gate and the month-end dispatch
// (STRIPE-BILLING-PLAN.md §0.4 + P7, with R1-1, R2-3 and R2-1/R3-2 folded in).
//
// The auth-gated route module is never imported; the dispatch lives in the lib exactly
// so it can be driven here with faked Stripe deps. No network, no SDK, no keys.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-cron.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-billing-cron-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
delete process.env.STRIPE_SECRET_KEY;

const DB_PATH = path.join(TMP, "data", "db.json");

const db = await import("@/lib/db");
const store = await import("@/lib/billing-store");
const health = await import("@/lib/billing-health");
const { cronAuthorized, runBillingCron } = await import("@/lib/billing-cron");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// The cron runs at 00:20 Tallinn on 1 October 2026 = 21:20 UTC on 30 September
// (Tallinn is UTC+3 in summer). The CLOSED Tallinn month is therefore 2026-09.
const NOW = Date.parse("2026-09-30T21:20:00.000Z");
const PERIOD = "2026-09";
const AGENT = "agent:acme";
const PERIOD_END_SEC = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000);

// ---- Fixtures -------------------------------------------------------------

/**
 * A db with one agent whose seafarers were visible all month, so the pure engine
 * computes a real quantity rather than a hand-fed number.
 */
function writeDb(opts = {}) {
  const seafarerIds = opts.seafarerIds ?? ["sf1", "sf2", "sf3"];
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify(
      {
        seafarers: seafarerIds.map((id) => ({ id, name: id, rank: "", state: "review", mergedFrom: [] })),
        documents: [], comments: [], restHours: [],
        agents: [{ id: AGENT, orgName: "Acme Crewing", contact: "", createdAt: "2026-01-01T00:00:00.000Z" }],
        assignments: [],
        accessGrants: seafarerIds.map((sid, i) => ({
          id: `g${i}`,
          seafarerId: sid,
          agentId: AGENT,
          status: "ACTIVE",
          legalBasis: "CONSENT",
          scope: [],
          shareToken: `t${i}`,
          grantedAt: "2026-08-01T00:00:00.000Z",
          revokedAt: null,
          expiresAt: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        })),
        requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
        circulars: [], circularReplies: [], docRequests: [], profileChanges: [], seaService: [],
        impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
        issuedSeaTerms: [], clientPortals: [], vacancies: [],
        billingSettings: { goLiveAt: "2026-01-01T00:00:00.000Z" },
      },
      null,
      2
    ),
    "utf8"
  );
  health.__resetBillingHealth();
}

async function seedProfile(patch = {}) {
  await store.ensureBillingProfileForAgent(AGENT, "2026-01-02T00:00:00.000Z");
  await store.setBillingStripeRefs(AGENT, {
    stripeCustomerId: patch.stripeCustomerId === null ? null : "cus_1",
    stripeSubscriptionId: patch.stripeSubscriptionId === undefined ? "sub_1" : patch.stripeSubscriptionId,
    billingActiveFrom: patch.billingActiveFrom ?? "2026-08-01T00:00:00.000Z",
  });
  await store.setSubscriptionStatusForAgent(AGENT, {
    subscriptionStatus: patch.subscriptionStatus ?? "active",
    paymentMethodAttached: true,
  });
  if (patch.exemptFromBilling) {
    await store.setBillingRatesForAgent(AGENT, { exemptFromBilling: true });
  }
}

function deps(over = {}) {
  const pushes = [];
  return {
    pushes,
    d: {
      expireDueGrants: over.expireDueGrants ?? (async () => 0),
      // D-B — the TAGGED fetch contract (a 404 and a 429 are different facts).
      fetchSubscription: over.fetchSubscription ?? (async (id) => ({
        kind: "found",
        view: {
          id,
          status: "active",
          currentPeriodEnd: PERIOD_END_SEC,
          defaultPaymentMethodAttached: true,
          created: Math.floor(Date.parse("2026-07-01T00:00:00.000Z") / 1000),
          latestInvoiceStatus: "paid",
        },
      })),
      pushUsage:
        over.pushUsage ??
        (async (input) => {
          pushes.push(input);
          return { ok: true, eventId: `mev_${pushes.length}` };
        }),
      reconciler: {
        fetchSubscription: async () => ({ kind: "not-found" }),
        listLiveSubscriptionsForCustomer: async () => [],
        alert: () => {},
        now: () => NOW,
        ...(over.reconciler ?? {}),
      },
      now: over.now ?? (() => NOW),
    },
  };
}

// ===========================================================================
// AUTH — fail-closed in production
// ===========================================================================

test("cronAuthorized: NO secret in a production-like env is a HARD refusal", () => {
  const env = { NODE_ENV: "production" };
  assert.equal(cronAuthorized({ authorization: null, secretParam: null, env }), false);
  assert.equal(cronAuthorized({ authorization: "Bearer anything", secretParam: null, env }), false);
  assert.equal(cronAuthorized({ authorization: null, secretParam: "anything", env }), false);
});

test("cronAuthorized: no secret outside production runs freely (local convenience)", () => {
  const env = { NODE_ENV: "development" };
  assert.equal(cronAuthorized({ authorization: null, secretParam: null, env }), true);
});

test("cronAuthorized: with a secret, ONLY the exact value passes — header or query", () => {
  const env = { NODE_ENV: "production", CRON_SECRET: "s3cr3t" };
  assert.equal(cronAuthorized({ authorization: "Bearer s3cr3t", secretParam: null, env }), true);
  assert.equal(cronAuthorized({ authorization: null, secretParam: "s3cr3t", env }), true);
  assert.equal(cronAuthorized({ authorization: "Bearer wrong", secretParam: null, env }), false);
  assert.equal(cronAuthorized({ authorization: null, secretParam: "wrong", env }), false);
  assert.equal(cronAuthorized({ authorization: "s3cr3t", secretParam: null, env }), false, "raw header, no Bearer prefix");
  assert.equal(cronAuthorized({ authorization: null, secretParam: null, env }), false);
});

// ===========================================================================
// DISPATCH
// ===========================================================================

test("computes the CLOSED Tallinn month and pushes it exactly once", async () => {
  writeDb();
  await seedProfile();
  const { d, pushes } = deps();

  const res = await runBillingCron(d);
  assert.equal(res.period, PERIOD, "the previous TALLINN month, not the UTC one");
  assert.equal(res.computed, 1);
  assert.equal(res.pushed, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].quantity, 3);
  assert.equal(pushes[0].stripeCustomerId, "cus_1");
  assert.equal(pushes[0].period, PERIOD);
  assert.ok(
    pushes[0].timestampSec <= PERIOD_END_SEC - 60,
    "the meter timestamp sits inside the still-open Stripe period (R2-1)"
  );

  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.quantity, 3);
  assert.ok(row.pushAttemptedAt, "the attempt was claimed BEFORE the Stripe call");
  assert.ok(row.pushedToStripeAt, "and confirmed after it");
  assert.equal(row.stripeMeterEventId, "mev_1");
});

test("IDEMPOTENCY: a second run in the same period computes nothing new and pushes nothing", async () => {
  writeDb();
  await seedProfile();
  const { d, pushes } = deps();
  await runBillingCron(d);
  assert.equal(pushes.length, 1);

  const second = await runBillingCron(d);
  assert.equal(second.pushed, 0, "the pushedToStripeAt ledger stops the second push");
  assert.equal(pushes.length, 1, "Stripe was called exactly ONCE for the period");
  assert.equal(db.readDB().billingUsage.filter((r) => r.period === PERIOD).length, 1, "one row, not two");
});

test("the ledger freezes a billed quantity even if the roster changes afterwards", async () => {
  writeDb();
  await seedProfile();
  const { d, pushes } = deps();
  await runBillingCron(d);
  assert.equal(pushes[0].quantity, 3);

  // A fourth seafarer appears (backdated) — the already-billed period must not move.
  writeDbWithExtraSeafarer();
  await runBillingCron(d);
  assert.equal(store.getUsageRow(AGENT, PERIOD).quantity, 3, "frozen after the push");
  assert.equal(pushes.length, 1);

  function writeDbWithExtraSeafarer() {
    const current = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    current.seafarers.push({ id: "sf4", name: "sf4", rank: "", state: "review", mergedFrom: [] });
    current.accessGrants.push({
      id: "g9", seafarerId: "sf4", agentId: AGENT, status: "ACTIVE", legalBasis: "CONSENT",
      scope: [], shareToken: "t9", grantedAt: "2026-08-01T00:00:00.000Z", revokedAt: null,
      expiresAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    });
    fs.writeFileSync(DB_PATH, JSON.stringify(current, null, 2), "utf8");
  }
});

test("R1-1 CRASH between attempt and confirm: retried inside 24h, MANUAL after it", async () => {
  writeDb();
  await seedProfile();

  // The Stripe call "succeeds" at Stripe but the process dies before markUsagePushed.
  const crashing = deps({
    pushUsage: async () => {
      throw new Error("process died mid-push");
    },
  });
  await assert.rejects(() => runBillingCron(crashing.d), /process died mid-push/);

  const afterCrash = store.getUsageRow(AGENT, PERIOD);
  assert.ok(afterCrash.pushAttemptedAt, "the claim survives the crash");
  assert.equal(afterCrash.pushedToStripeAt, null, "and it is NOT marked as billed");

  // Next tick, still inside Stripe's ~24h idempotency-key window AND still inside the
  // open Stripe period: retrying is SAFE because the key dedupes, so the cron retries.
  const soon = deps({ now: () => NOW + 3600_000 });
  const res = await runBillingCron(soon.d);
  assert.equal(res.pushed, 1);
  assert.equal(soon.pushes.length, 1);
  assert.equal(store.getUsageRow(AGENT, PERIOD).pushedToStripeAt !== null, true);
});

test("R1-1: an unconfirmed attempt PAST the dedupe window becomes a manual case, never a retry", async () => {
  writeDb();
  await seedProfile();
  const crashing = deps({
    pushUsage: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => runBillingCron(crashing.d), /boom/);

  // 25 hours later the idempotency key no longer dedupes; a blind retry could
  // double-bill a SUM-aggregated meter, so the row is surfaced instead.
  const later = deps({ now: () => NOW + 25 * 3600_000 });
  const res = await runBillingCron(later.d);
  assert.equal(later.pushes.length, 0, "Stripe was NOT called again");
  assert.equal(res.unconfirmedPush, 1);
  const snapshot = health.readBillingHealth();
  assert.equal(snapshot.unconfirmedPush.length, 1);
  assert.equal(snapshot.unconfirmedPush[0].agentId, AGENT);
  assert.ok(
    snapshot.alerts.some((a) => a.kind === "unconfirmedPush"),
    "and it raises an alert for the admin card"
  );
});

test("R2-3: a PAST_DUE agency keeps metering; none/incomplete/canceled are neverBilled", async () => {
  for (const status of ["active", "past_due"]) {
    writeDb();
    await seedProfile({ subscriptionStatus: status });
    const { d, pushes } = deps();
    const res = await runBillingCron(d);
    assert.equal(res.pushed, 1, `${status} must keep metering`);
    assert.equal(pushes.length, 1);
  }
  for (const status of ["none", "incomplete", "canceled"]) {
    writeDb();
    await seedProfile({ subscriptionStatus: status });
    const { d, pushes } = deps();
    const res = await runBillingCron(d);
    assert.equal(pushes.length, 0, `${status} must not meter`);
    assert.equal(res.neverBilled, 1, `${status} is surfaced, not silently dropped`);
    const snapshot = health.readBillingHealth();
    assert.match(snapshot.neverBilled[0].reason, new RegExp(status));
    // The row is STILL recorded for admin visibility (R1-6).
    assert.equal(store.getUsageRow(AGENT, PERIOD).quantity, 3);
  }
});

test("an EXEMPT agency is computed for visibility but never pushed", async () => {
  writeDb();
  await seedProfile({ exemptFromBilling: true });
  const { d, pushes } = deps();
  const res = await runBillingCron(d);
  assert.equal(pushes.length, 0);
  assert.equal(res.neverBilled, 1);
  assert.match(health.readBillingHealth().neverBilled[0].reason, /exempt/);
  assert.equal(store.getUsageRow(AGENT, PERIOD).quantity, 3, "the number is still visible to admin");
});

test("R2-1/R3-2: a push after the Stripe period closed is LATE, not a guess", async () => {
  writeDb();
  await seedProfile();
  // The cron was dead for hours and only ran well INTO the new Stripe period.
  const { d, pushes } = deps({ now: () => Date.parse("2026-10-01T02:00:00.000Z") });
  const res = await runBillingCron(d);
  assert.equal(pushes.length, 0);
  assert.equal(res.lateEvents, 1);
  const snapshot = health.readBillingHealth();
  assert.equal(snapshot.lateEvents.length, 1);
  assert.match(snapshot.lateEvents[0].reason, /manual review/);
});

// MODIFIED (fix-plan §3): this case used to assert `stripeMeterEventId === "no-usage"`,
// i.e. the zero month was closed by stamping `pushedToStripeAt` — the very stamp that
// froze the ledger forever and made finding 1 (the zero-freeze) unrecoverable. Under
// D-G a zero month is closed with `closedAs`, and `pushedToStripeAt` now means ONLY
// "Stripe received a meter event".
test("a zero-quantity month is closed out explicitly instead of retrying forever", async () => {
  writeDb({ seafarerIds: [] });
  await seedProfile();
  const { d, pushes } = deps();
  const res = await runBillingCron(d);
  assert.equal(pushes.length, 0, "there is nothing to meter");
  assert.equal(res.closed, 1);
  assert.equal(res.pushed, 0, "closing a month is NOT a Stripe push");
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.quantity, 0);
  assert.equal(row.closedAs, "no-usage");
  assert.equal(row.pushedToStripeAt, null, "the ledger-freezing stamp is never applied");
  assert.equal(row.stripeMeterEventId, null);
  // ...and the next tick does not touch it again.
  const again = await runBillingCron(d);
  assert.equal(again.pushed, 0);
  assert.equal(again.closed, 0);
});

test("R1-7: a demo-class agent never gets a usage row at all", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("dev");
  await store.ensureBillingProfileForAgent("sample-agency-crewing");
  const { d } = deps();
  await runBillingCron(d);
  const rows = db.readDB().billingUsage.map((r) => r.agentId);
  assert.ok(!rows.includes("dev"));
  assert.ok(!rows.includes("sample-agency-crewing"));
});

// ===========================================================================
// The other dispatch steps
// ===========================================================================

test("expireDueGrants runs FIRST and its count is reported", async () => {
  writeDb();
  await seedProfile();
  const order = [];
  const { d } = deps({
    expireDueGrants: async () => {
      order.push("expire");
      return 4;
    },
    pushUsage: async () => {
      order.push("push");
      return { ok: true, eventId: "mev" };
    },
  });
  const res = await runBillingCron(d);
  assert.equal(res.expiredGrants, 4);
  assert.deepEqual(order, ["expire", "push"]);
});

test("the daily reconcile sweep runs ONCE per Tallinn day and is ledgered", async () => {
  writeDb();
  await seedProfile();
  let sweeps = 0;
  const reconciler = {
    fetchSubscription: async (id) => {
      sweeps++;
      return {
        kind: "found",
        view: { id, status: "active", currentPeriodEnd: PERIOD_END_SEC, defaultPaymentMethodAttached: true, created: 1, latestInvoiceStatus: "paid" },
      };
    },
    listLiveSubscriptionsForCustomer: async () => [],
    alert: () => {},
    now: () => NOW,
  };

  const first = await runBillingCron(deps({ reconciler }).d);
  assert.equal(first.dailySweep.ran, true);
  assert.equal(first.dailySweep.day, "2026-10-01", "Tallinn day, not the UTC one");
  assert.equal(sweeps, 1);

  // A later tick on the SAME Tallinn day does not sweep again.
  const second = await runBillingCron(deps({ reconciler, now: () => NOW + 3600_000 }).d);
  assert.equal(second.dailySweep.ran, false);
  assert.equal(sweeps, 1);

  // The NEXT Tallinn day does.
  const nextDay = await runBillingCron(
    deps({ reconciler, now: () => NOW + 26 * 3600_000 }).d
  );
  assert.equal(nextDay.dailySweep.ran, true);
  assert.equal(sweeps, 2);
});

test("billing-health is written every run, with per-agent rows and usage warnings", async () => {
  writeDb();
  await seedProfile();
  const { d } = deps();
  await runBillingCron(d);
  const snapshot = health.readBillingHealth();
  assert.equal(snapshot.period, PERIOD);
  assert.equal(snapshot.ranAt, new Date(NOW).toISOString());
  assert.equal(snapshot.perAgent.length, 1);
  assert.equal(snapshot.perAgent[0].agentId, AGENT);
  assert.equal(snapshot.perAgent[0].quantity, 3);
  assert.equal(snapshot.perAgent[0].pushed, true);
  assert.deepEqual(snapshot.errors, []);
  // R1-10b staleness is computed at RENDER time, never persisted.
  assert.equal(health.healthStaleness(snapshot, NOW + 60_000).level, "ok");
  assert.equal(health.healthStaleness(snapshot, NOW + 3 * 3600_000).level, "amber");
  assert.equal(health.healthStaleness(snapshot, NOW + 7 * 3600_000).level, "red");
  assert.match(health.healthStaleness(snapshot, NOW + 7 * 3600_000).text, /has not run since/);
  assert.equal(health.healthStaleness({ ...snapshot, ranAt: null }).level, "never");
});

test("the webhook ledger is pruned to the retention window on every run", async () => {
  writeDb();
  await seedProfile();
  await store.claimStripeEvent("evt_ancient", "invoice.paid", "2025-01-01T00:00:00.000Z");
  await store.claimStripeEvent("evt_recent", "invoice.paid", new Date(NOW - 3600_000).toISOString());
  const { d } = deps();
  const res = await runBillingCron(d);
  assert.equal(res.prunedEvents, 1);
  assert.deepEqual(db.readDB().stripeEvents.map((e) => e.stripeEventId), ["evt_recent"]);
});

// ===========================================================================
// F1 — the zero-freeze, the ledger freeze, orphaned periods and the idle tick
// ===========================================================================

const CONSENT_SINK = path.join(TMP, "data", "consent-events.ndjson");

/** Poison the consent sink so readConsentEvents (and therefore compute) THROWS. */
function poisonSink() {
  fs.writeFileSync(CONSENT_SINK, "{ this is not json\n", "utf8");
}
function healSink() {
  fs.rmSync(CONSENT_SINK, { force: true });
}

/** Mutate the fixture db in place (writeDb() would wipe profiles and usage rows). */
function patchDb(fn) {
  const current = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  fn(current);
  fs.writeFileSync(DB_PATH, JSON.stringify(current, null, 2), "utf8");
}
const clearRoster = () =>
  patchDb((c) => {
    c.seafarers = [];
    c.accessGrants = [];
  });
const backdateGrants = (iso) =>
  patchDb((c) => {
    for (const g of c.accessGrants) {
      g.grantedAt = iso;
      g.createdAt = iso;
    }
  });

test("F1 zero-freeze: a compute failure aborts month-end — nothing recorded, nothing closed, alert written, next tick bills normally", async () => {
  writeDb();
  await seedProfile();
  // FINDING 1: one torn line in an append-only sink used to be caught into an EMPTY
  // usage map, which rewrote every agent's row to quantity 0 and then stamped it
  // "pushed" — zero-billing the whole platform for the month, permanently.
  poisonSink();

  const { d, pushes } = deps();
  const res = await runBillingCron(d);

  assert.equal(pushes.length, 0, "nothing was sent to Stripe");
  assert.equal(res.computed, 0, "NOTHING was recorded");
  assert.equal(res.closed, 0, "and nothing was closed out");
  assert.equal(db.readDB().billingUsage.length, 0, "not a single usage row was written");
  assert.equal(store.getUsageRow(AGENT, PERIOD), null);
  assert.ok(
    res.errors.some((e) => /computeUsageForPeriod 2026-09 failed/.test(e)),
    "the failure is reported, never swallowed"
  );
  const snapshot = health.readBillingHealth();
  assert.ok(
    snapshot.alerts.some((a) => a.kind === "error" && a.period === PERIOD),
    "and it raises an alert for the admin card"
  );

  // The sink heals; the very next tick bills the month at its FULL quantity.
  healSink();
  const second = deps();
  const res2 = await runBillingCron(second.d);
  assert.equal(res2.pushed, 1);
  assert.equal(second.pushes.length, 1);
  assert.equal(second.pushes[0].quantity, 3, "the full month, not a fossilised zero");
  assert.ok(store.getUsageRow(AGENT, PERIOD).pushedToStripeAt);
});

test("F1 FR1-1: the abort is PER-PERIOD — a broken month never starves the current one, and it alerts ONCE", async () => {
  writeDb();
  await seedProfile();
  // An orphan row for a period whose compute throws on every single tick, forever.
  patchDb((c) => {
    c.billingUsage = [
      {
        id: "u-bad",
        agentId: AGENT,
        period: "2026-13",
        quantity: 0,
        billableSeafarerIds: [],
        computedAt: "2026-09-01T00:00:00.000Z",
        pushAttemptedAt: null,
        pushedToStripeAt: null,
        stripeMeterEventId: null,
      },
    ];
  });

  const { d, pushes } = deps();
  const res = await runBillingCron(d);
  assert.ok(res.periods.includes("2026-13"), "the broken period is in the set");
  assert.ok(res.errors.some((e) => /2026-13/.test(e)));
  assert.equal(res.pushed, 1, "the HEALTHY period still billed in the SAME tick");
  assert.equal(pushes[0].period, PERIOD);

  // FR2-2 — a permanently broken period must not alert 48 times a day.
  const again = deps({ now: () => NOW + 3600_000 });
  await runBillingCron(again.d);
  const errors = health
    .readBillingHealth()
    .alerts.filter((a) => a.kind === "error" && a.period === "2026-13");
  assert.equal(errors.length, 1, "one alert per broken period, not one per tick");
});

test("F1 stale-unconfirmed beats quantity-0: an aged unconfirmed claim on a now-zero row surfaces as unconfirmedPush, not no-usage", async () => {
  writeDb();
  await seedProfile();
  const crashing = deps({
    pushUsage: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => runBillingCron(crashing.d), /boom/);

  // The roster is emptied, so a fresh recompute would now read ZERO for the period.
  // FINDING 3: the quantity-0 short-circuit used to run FIRST and close such a row
  // "no-usage" — burying a claim Stripe may already have received.
  clearRoster();
  const later = deps({ now: () => NOW + 25 * 3600_000 });
  const res = await runBillingCron(later.d);

  assert.equal(later.pushes.length, 0, "Stripe was NOT called again");
  assert.equal(res.unconfirmedPush, 1, "the MANUAL case wins over the zero close");
  assert.equal(res.closed, 0);
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, null, "never silently closed");
  assert.equal(row.quantity, 3, "and the claimed ledger quantity is frozen (finding 3)");
});

test("F1 FR1-2: a retry inside the window sends the CLAIMED ledger quantity, not a fresh recompute", async () => {
  writeDb();
  await seedProfile();
  const failing = deps({
    pushUsage: async () => ({ ok: false, error: "stripe 500" }),
  });
  await runBillingCron(failing.d);
  assert.equal(store.getUsageRow(AGENT, PERIOD).quantity, 3);
  assert.ok(store.getUsageRow(AGENT, PERIOD).pushAttemptedAt);
  assert.equal(store.getUsageRow(AGENT, PERIOD).pushedToStripeAt, null);

  // The roster changes before the retry. The idempotency key's BODY must not move, or
  // Stripe answers `idempotency_error` and the ledger stops matching what Stripe holds.
  clearRoster();
  const retry = deps({ now: () => NOW + 3600_000 });
  const res = await runBillingCron(retry.d);
  assert.equal(res.pushed, 1);
  assert.equal(retry.pushes.length, 1);
  assert.equal(retry.pushes[0].quantity, 3, "the frozen ledger quantity, never the recompute");
  assert.equal(store.getUsageRow(AGENT, PERIOD).quantity, 3);
});

test("F1 orphaned period: an unpushed row from two months ago is retried/surfaced, not ignored", async () => {
  writeDb();
  await seedProfile({ billingActiveFrom: "2026-06-01T00:00:00.000Z" });
  backdateGrants("2026-06-01T00:00:00.000Z");
  // FINDING 16: the cron only ever looked at previousTallinnPeriod(now), so a month an
  // outage (or an admin clear-attempt after rollover) left unfinished was never
  // computed or pushed by ANYTHING, ever again.
  await store.recordUsageForPeriod(
    AGENT,
    "2026-07",
    { quantity: 0, billableSeafarerIds: [] },
    "2026-08-01T00:20:00.000Z"
  );

  const { d, pushes } = deps();
  const res = await runBillingCron(d);

  assert.deepEqual(res.periods, ["2026-07", "2026-09"], "the orphan month joins the set");
  assert.equal(pushes.length, 2, "both months were pushed");
  assert.ok(pushes.some((p) => p.period === "2026-07" && p.quantity === 3));
  assert.ok(pushes.some((p) => p.period === PERIOD));
  assert.ok(store.getUsageRow(AGENT, "2026-07").pushedToStripeAt);
  assert.equal(res.period, PERIOD, "the primary period is still the closed month");
});

test("F1 pre-subscription month closes as never-billed (closedAs), not no-usage", async () => {
  writeDb();
  // The subscription only started in October, so September predates it entirely.
  await seedProfile({ billingActiveFrom: "2026-10-05T00:00:00.000Z" });
  const { d, pushes } = deps();
  const res = await runBillingCron(d);

  assert.equal(pushes.length, 0);
  assert.equal(res.neverBilled, 1, "R1-6(b): surfaced, never silently dropped");
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, "never-billed", "NOT `no-usage` — the two are different facts");
  assert.match(row.closedReason, /predates the subscription/);
  assert.equal(row.pushedToStripeAt, null);
  assert.match(health.readBillingHealth().neverBilled[0].reason, /predates the subscription/);
});

test("F1 never-billed months are closed with closedAs, not with a pushed stamp", async () => {
  writeDb();
  await seedProfile({ exemptFromBilling: true });
  const { d } = deps();
  await runBillingCron(d);
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, "never-billed");
  assert.match(row.closedReason, /exempt/);
  assert.equal(row.pushedToStripeAt, null);
  assert.equal(row.quantity, 3, "the number stays visible to admin (R1-6)");
});

test("F1 idle tick is write-free: a second tick after a fully-done period performs zero db writes", async () => {
  writeDb();
  await seedProfile();
  await runBillingCron(deps().d);

  const entriesBefore = db._serializeEntryCount();
  const bytesBefore = fs.readFileSync(DB_PATH, "utf8");
  const second = deps({ now: () => NOW + 3600_000 });
  const res = await runBillingCron(second.d);

  assert.equal(res.computed, 0, "the idle tick skipped the full-sink compute entirely");
  assert.equal(second.pushes.length, 0);
  assert.equal(db._serializeEntryCount(), entriesBefore, "not one critical section was entered");
  assert.equal(fs.readFileSync(DB_PATH, "utf8"), bytesBefore, "db.json bytes unchanged");
});

// ===========================================================================
// R2 / N2 + N5 — the visibility mandate, and the reopen/re-close write loop
// ===========================================================================

/** A row for a MALFORMED period: never done, so the tick can never go idle. */
function pendingOrphanRow() {
  patchDb((c) => {
    c.billingUsage = [
      ...(c.billingUsage ?? []),
      {
        id: "u-pending", agentId: AGENT, period: "2026-13", quantity: 0, billableSeafarerIds: [],
        computedAt: "2026-09-01T00:00:00.000Z", pushAttemptedAt: null, pushedToStripeAt: null,
        stripeMeterEventId: null, closedAs: null, closedReason: null,
      },
    ];
  });
}

test("R2 N2: a never-billed month stays visible in billing-health after a later tick", async () => {
  writeDb();
  await seedProfile({ exemptFromBilling: true });

  const first = await runBillingCron(deps().d);
  assert.equal(first.neverBilled, 1);
  const afterClose = health.readBillingHealth();
  assert.equal(afterClose.neverBilled.length, 1);
  assert.match(afterClose.neverBilled[0].reason, /exempt/);

  // N2: the row is `never-billed` in the LEDGER, but it was pushed to the snapshot only
  // on the tick that closed it. Every later tick skips the (done) row, so
  // writeBillingHealth overwrote the list with [] — R1-6(b)'s "surfaced, never silently
  // skipped" lasted exactly one 30-minute tick before the card went blank.
  const second = await runBillingCron(deps({ now: () => NOW + 3600_000 }).d);
  const afterIdle = health.readBillingHealth();
  assert.equal(afterIdle.neverBilled.length, 1, "the month is STILL on the card");
  assert.equal(afterIdle.neverBilled[0].agentId, AGENT);
  assert.equal(afterIdle.neverBilled[0].period, PERIOD);
  assert.match(afterIdle.neverBilled[0].reason, /exempt/, "with its stored closedReason");
  assert.equal(second.neverBilled, 1, "and the count reflects the ledger, not the tick");

  // The card reads the LEDGER, bounded: a recent closed month shows, an ancient one
  // does not (the list must not grow without limit as the ledger ages).
  patchDb((c) => {
    c.billingUsage.push(
      { id: "u-recent", agentId: AGENT, period: "2026-08", quantity: 0, billableSeafarerIds: [],
        computedAt: "2026-09-01T00:00:00.000Z", pushAttemptedAt: null, pushedToStripeAt: null,
        stripeMeterEventId: null, closedAs: "never-billed", closedReason: "agency is exempt from billing" },
      { id: "u-ancient", agentId: AGENT, period: "2025-12", quantity: 0, billableSeafarerIds: [],
        computedAt: "2026-01-01T00:00:00.000Z", pushAttemptedAt: null, pushedToStripeAt: null,
        stripeMeterEventId: null, closedAs: "never-billed", closedReason: "agency is exempt from billing" },
    );
  });
  await runBillingCron(deps({ now: () => NOW + 7200_000 }).d);
  const periods = health.readBillingHealth().neverBilled.map((r) => r.period);
  assert.ok(periods.includes("2026-08"), "a recent closed month is on the card");
  assert.ok(!periods.includes("2025-12"), "…but the lookback is bounded");
});

test("R2 N2: an unattributed usage warning survives a tick that did not recompute its period", async () => {
  writeDb();
  await seedProfile();
  // A consent event pointing at a grant nobody can resolve => an unattributed warning.
  patchDb((c) => {
    c.accessGrants = c.accessGrants.filter((g) => g.id !== "g0");
  });
  fs.writeFileSync(
    CONSENT_SINK,
    JSON.stringify({ id: "ce1", at: "2026-09-05T00:00:00.000Z", grantId: "g-nowhere", type: "GRANTED" }) + "\n",
    "utf8"
  );

  await runBillingCron(deps().d);
  const first = health.readBillingHealth();
  assert.ok(
    first.usageWarnings.some((w) => w.includes("g-nowhere")),
    "the unattributable warning is surfaced once"
  );

  // A later tick recomputes nothing (everything is done) — the warning must not vanish.
  await runBillingCron(deps({ now: () => NOW + 3600_000 }).d);
  assert.ok(
    health.readBillingHealth().usageWarnings.some((w) => w.includes("g-nowhere")),
    "…and it is still there after an idle tick"
  );
  fs.rmSync(CONSENT_SINK, { force: true });
});

test("R2 N5: an exempt agency's never-billed row is not reopened and re-closed every tick", async () => {
  writeDb();
  await seedProfile({ exemptFromBilling: true });
  // Something else is permanently pending, so the tick can never short-circuit and the
  // recompute really does run every time — which is exactly the situation N5 describes.
  pendingOrphanRow();

  await runBillingCron(deps().d);
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, "never-billed");
  assert.equal(row.quantity, 3, "the agency HAS usage — that is what made the loop churn");

  // N5: recordUsageForPeriod reopened the close (quantity > 0), pushOneAgent immediately
  // re-closed it — two fsync'd writes under the process-wide mutex, per such agency,
  // every 30 minutes, forever.
  const entriesBefore = db._serializeEntryCount();
  const bytesBefore = fs.readFileSync(DB_PATH, "utf8");
  const second = await runBillingCron(deps({ now: () => NOW + 3600_000 }).d);

  assert.ok(second.computed > 0, "the tick really did recompute (it was not idle)");
  assert.equal(db._serializeEntryCount(), entriesBefore, "…and performed ZERO db writes");
  assert.equal(fs.readFileSync(DB_PATH, "utf8"), bytesBefore, "db.json bytes unchanged");
  assert.equal(store.getUsageRow(AGENT, PERIOD).closedAs, "never-billed", "still closed");
});

test("R2 N5: the genuine reopen still works — an un-exempted, subscribed agency bills the month", async () => {
  writeDb();
  await seedProfile({ exemptFromBilling: true });
  // As in the case above, something else is pending, so the period is really recomputed
  // (a closed row is "done", so an otherwise-idle tick never revisits it by design).
  pendingOrphanRow();
  await runBillingCron(deps().d);
  assert.equal(store.getUsageRow(AGENT, PERIOD).closedAs, "never-billed");

  // The owner un-comps the agency and it now holds a live subscription for that month.
  await store.setBillingRatesForAgent(AGENT, { exemptFromBilling: false }, "2026-08-01T00:00:00.000Z");
  await store.setBillingStripeRefs(AGENT, { billingActiveFrom: "2026-08-01T00:00:00.000Z" });

  const { d, pushes } = deps({ now: () => NOW + 3600_000 });
  const res = await runBillingCron(d);
  assert.equal(res.pushed, 1, "the close is REOPENED and the month is billed");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].quantity, 3);
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, null);
  assert.ok(row.pushedToStripeAt);
});

// ===========================================================================
// R3-3 — the stale-unconfirmed check must beat the UNBILLABLE branch, not only the
// quantity-0 branch (D-3). An aged unconfirmed claim on an agency that has since become
// exempt/canceled/non-metering must surface as the manual case, never be silently stuck.
// ===========================================================================

test("R3-3 aged unconfirmed on a now-exempt agency surfaces as unconfirmedPush, not silently stuck", async () => {
  writeDb();
  await seedProfile();
  // Crash mid-push: the row gets pushAttemptedAt set, pushedToStripeAt null, quantity 3.
  const crashing = deps({
    pushUsage: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => runBillingCron(crashing.d), /boom/);

  // The agency then becomes EXEMPT (the canceled/non-metering equivalent). Under the OLD
  // branch order the unbillable branch ran first -> neverBilled() -> closeUsageRow, which
  // REFUSES a row carrying pushAttemptedAt, so closedAs stayed null forever, isUsageRowDone
  // stayed false, and the row was re-added by monthEndPeriods every tick — invisible on
  // every card and unresolvable (finding R3-3).
  await store.setBillingRatesForAgent(AGENT, { exemptFromBilling: true });

  // 25 hours later, past the ~24h idempotency window.
  const later = deps({ now: () => NOW + 25 * 3600_000 });
  const res = await runBillingCron(later.d);

  assert.equal(later.pushes.length, 0, "Stripe was NOT called again");
  assert.equal(res.unconfirmedPush, 1, "the MANUAL case wins over the unbillable close");
  assert.equal(res.neverBilled, 0, "the unbillable branch did NOT falsely close it");
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, null, "never silently/falsely closed");
  const snapshot = health.readBillingHealth();
  assert.equal(snapshot.unconfirmedPush.length, 1);
  assert.equal(snapshot.unconfirmedPush[0].agentId, AGENT);
  assert.ok(
    snapshot.alerts.some((a) => a.kind === "unconfirmedPush"),
    "and it raises an alert for the admin billing-health card"
  );
});

test("R3-3 resolvability: after clear-attempt an exempt agency's row closes as never-billed on the next tick", async () => {
  writeDb();
  await seedProfile();
  const crashing = deps({
    pushUsage: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => runBillingCron(crashing.d), /boom/);
  await store.setBillingRatesForAgent(AGENT, { exemptFromBilling: true });

  // Surfaced as unconfirmedPush past the window, still not closed.
  await runBillingCron(deps({ now: () => NOW + 25 * 3600_000 }).d);
  assert.equal(store.getUsageRow(AGENT, PERIOD).closedAs, null);

  // Admin picks "clear-attempt": the row is no longer frozen (still not done).
  await store.resolveUnconfirmedPush(AGENT, PERIOD, "clear-attempt");
  assert.equal(store.getUsageRow(AGENT, PERIOD).pushAttemptedAt, null);

  // Next tick: recompute -> pushOneAgent hits the unbillable (exempt) branch ->
  // closeUsageRow now SUCCEEDS (no pushAttemptedAt) -> closedAs set -> row done. Proves
  // the fix does not merely relocate the stuck state — it is terminally resolvable.
  const finalTick = deps({ now: () => NOW + 26 * 3600_000 });
  const res = await runBillingCron(finalTick.d);
  const row = store.getUsageRow(AGENT, PERIOD);
  assert.equal(row.closedAs, "never-billed", "now terminally resolved");
  assert.match(row.closedReason, /exempt/);
  assert.equal(res.neverBilled, 1);
  assert.equal(store.isUsageRowDone(row), true);
});
