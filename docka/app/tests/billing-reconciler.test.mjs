// Unit tests for lib/billing-reconciler.ts — the belt-and-braces daily sweep
// (R1-3 specified, R2-4 ordering participation, R2-6 orphan adoption, R3-4a
// canceled-with-stale-id adoption).
//
// This mechanism exists BECAUSE webhooks get lost, so it is exactly the code that must
// not itself be untested. Every Stripe read is a FAKE injected through the deps — no
// network, no SDK, no keys.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-reconciler.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-billing-reconciler-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
delete process.env.STRIPE_SECRET_KEY;

const DB_PATH = path.join(TMP, "data", "db.json");

const store = await import("@/lib/billing-store");
const { reconcileProfile, reconcileAll } = await import("@/lib/billing-reconciler");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const AGENT = "agent:acme";
const NOW = Date.parse("2026-10-05T03:00:00.000Z");

function writeDb() {
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify(
      {
        seafarers: [], documents: [], comments: [], restHours: [], agents: [],
        assignments: [], accessGrants: [], requiredDocsConfigs: [], requiredDocsAudit: [],
        notifications: [], remindersSent: [], circulars: [], circularReplies: [],
        docRequests: [], profileChanges: [], seaService: [], impersonations: [],
        profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
        issuedSeaTerms: [], clientPortals: [], vacancies: [],
      },
      null,
      2
    ),
    "utf8"
  );
}

async function seed(patch = {}) {
  writeDb();
  await store.ensureBillingProfileForAgent(AGENT, "2026-09-01T00:00:00.000Z");
  await store.setSubscriptionStatusForAgent(AGENT, {
    stripeSubscriptionId: null,
    ...patch,
  });
  await store.setBillingStripeRefs(AGENT, {
    stripeCustomerId: patch.stripeCustomerId ?? "cus_1",
  });
  return store.getBillingProfileForAgent(AGENT);
}

/** A Stripe subscription view, as lib/stripe's `toSubscriptionView` would produce. */
function view(id, status, over = {}) {
  return {
    id,
    status,
    currentPeriodEnd: Math.floor(Date.parse("2026-11-01T00:00:00.000Z") / 1000),
    defaultPaymentMethodAttached: over.pm ?? true,
    created: over.created ?? Math.floor(Date.parse("2026-09-20T00:00:00.000Z") / 1000),
    latestInvoiceStatus: over.latestInvoiceStatus ?? "paid",
  };
}

function deps(over = {}) {
  const alerts = [];
  const calls = { fetched: [], listed: [] };
  return {
    alerts,
    calls,
    d: {
      // D-B — the TAGGED fetch contract. `over.fetch` still returns a plain view (or
      // null for "gone"); the wrapper tags it, and `over.fetchRaw` returns a tag
      // directly so a case can inject the `error` half.
      fetchSubscription: async (id) => {
        calls.fetched.push(id);
        if (over.fetchRaw) return over.fetchRaw(id);
        const v = over.fetch ? over.fetch(id) : null;
        return v ? { kind: "found", view: v } : { kind: "not-found" };
      },
      listLiveSubscriptionsForCustomer: async (cus) => {
        calls.listed.push(cus);
        return over.list ? over.list(cus) : [];
      },
      alert: (kind, message, agentId) => alerts.push({ kind, message, agentId }),
      now: over.now ?? (() => NOW),
    },
  };
}

const profile = () => store.getBillingProfileForAgent(AGENT);

// ===========================================================================

test("skips a profile that has no Stripe customer at all", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent(AGENT);
  const { d, calls } = deps();
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "skipped-no-customer");
  assert.deepEqual(calls.fetched, []);
  assert.deepEqual(calls.listed, []);
});

test("HEALTHY NO-OP: a mirror that already agrees with Stripe reports `healthy`", async () => {
  await seed({
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "active",
    paymentMethodAttached: true,
    pastDueSince: null,
    billingActiveFrom: "2026-09-20T00:00:00.000Z",
  });
  const { d, calls, alerts } = deps({ fetch: () => view("sub_1", "active") });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "healthy");
  assert.deepEqual(calls.listed, [], "a live stored subscription needs no customer listing");
  assert.deepEqual(alerts, []);
  assert.equal(profile().subscriptionStatus, "active");
});

test("HEALS a lost invoice.payment_failed: Stripe says past_due, the mirror said active", async () => {
  await seed({
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "active",
    paymentMethodAttached: true,
    pastDueSince: null,
    billingActiveFrom: "2026-09-20T00:00:00.000Z",
  });
  const { d } = deps({ fetch: () => view("sub_1", "past_due", { latestInvoiceStatus: "open" }) });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "healed");
  const p = profile();
  assert.equal(p.subscriptionStatus, "past_due");
  assert.equal(p.pastDueSince, new Date(NOW).toISOString(), "the escalation clock starts");
});

test("HEALS a lost invoice.paid and does NOT restart the past-due clock on re-observation", async () => {
  await seed({
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "past_due",
    pastDueSince: "2026-09-25T00:00:00.000Z",
    paymentMethodAttached: true,
    billingActiveFrom: "2026-09-20T00:00:00.000Z",
  });
  // Still past_due at Stripe -> the ORIGINAL failure instant must survive.
  const { d } = deps({ fetch: () => view("sub_1", "past_due", { latestInvoiceStatus: "open" }) });
  await reconcileProfile(profile(), d);
  assert.equal(profile().pastDueSince, "2026-09-25T00:00:00.000Z", "clock preserved, not restarted");

  // Now Stripe says paid -> cleared.
  const { d: d2 } = deps({ fetch: () => view("sub_1", "active") });
  await reconcileProfile(profile(), d2);
  assert.equal(profile().pastDueSince, null);
  assert.equal(profile().subscriptionStatus, "active");
});

test("R2-6 ORPHAN ADOPTION: a customer with no stored subscription adopts its single live one", async () => {
  await seed({ stripeSubscriptionId: null, subscriptionStatus: "none", paymentMethodAttached: false });
  assert.equal(profile().billingActiveFrom, null);

  const created = Math.floor(Date.parse("2026-09-25T09:00:00.000Z") / 1000);
  const { d, calls } = deps({ list: () => [view("sub_orphan", "active", { created })] });
  const res = await reconcileProfile(profile(), d);

  assert.equal(res.outcome, "adopted-orphan");
  assert.deepEqual(calls.fetched, [], "there was no stored id to fetch");
  assert.deepEqual(calls.listed, ["cus_1"]);
  const p = profile();
  assert.equal(p.stripeSubscriptionId, "sub_orphan");
  assert.equal(p.subscriptionStatus, "active");
  assert.equal(p.paymentMethodAttached, true);
  assert.equal(
    p.billingActiveFrom,
    "2026-09-25T09:00:00.000Z",
    "R1-6 fallback: the clock is Stripe's subscription.created"
  );
});

test("R3-4a STALE-ID ADOPTION: a canceled profile whose re-subscribe webhook was lost", async () => {
  await seed({
    stripeSubscriptionId: "sub_dead",
    subscriptionStatus: "canceled",
    canceledAt: "2026-09-10T00:00:00.000Z",
    paymentMethodAttached: false,
  });
  const created = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000);
  const { d, calls, alerts } = deps({
    fetch: () => view("sub_dead", "canceled", { pm: false }),
    list: () => [view("sub_new", "active", { created })],
  });
  const res = await reconcileProfile(profile(), d);

  assert.equal(res.outcome, "adopted");
  assert.deepEqual(calls.fetched, ["sub_dead"]);
  assert.deepEqual(calls.listed, ["cus_1"], "a dead stored id triggers the customer listing");
  assert.deepEqual(alerts, [], "adopting a legitimate re-subscribe is not an alert");
  const p = profile();
  assert.equal(p.stripeSubscriptionId, "sub_new");
  assert.equal(p.subscriptionStatus, "active");
  assert.equal(p.canceledAt, null, "the cancel stamp is cleared on adoption");
  assert.equal(p.billingActiveFrom, "2026-10-01T00:00:00.000Z");
});

test("R3-4a: a stored id that 404s also triggers the customer listing", async () => {
  await seed({ stripeSubscriptionId: "sub_gone", subscriptionStatus: "active" });
  const { d, calls } = deps({ fetch: () => null, list: () => [view("sub_replacement", "active")] });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "adopted");
  assert.deepEqual(calls.listed, ["cus_1"]);
  assert.equal(profile().stripeSubscriptionId, "sub_replacement");
});

test("a genuinely cancelled agency with no replacement is mirrored as canceled", async () => {
  await seed({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active", paymentMethodAttached: true });
  const { d } = deps({ fetch: () => view("sub_1", "canceled", { pm: false }), list: () => [] });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "healed");
  const p = profile();
  assert.equal(p.subscriptionStatus, "canceled");
  assert.equal(p.canceledAt, new Date(NOW).toISOString(), "the R2-5 ageing clock starts");
});

test("MORE THAN ONE live subscription is an alert, never a silent pick", async () => {
  await seed({ stripeSubscriptionId: null, subscriptionStatus: "none" });
  const { d, alerts } = deps({ list: () => [view("sub_a", "active"), view("sub_b", "active")] });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "duplicate");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "duplicateSubscription");
  assert.match(alerts[0].message, /sub_a/);
  assert.match(alerts[0].message, /sub_b/);
  assert.equal(profile().stripeSubscriptionId, null, "nothing was adopted");
});

// ===========================================================================
// F2 — one status table, no instant block, no dead-on-a-blip
// ===========================================================================

test("F2 no instant-block: a past_due subscription whose latest invoice reads paid KEEPS pastDueSince (ladder intact)", async () => {
  await seed({
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "past_due",
    pastDueSince: "2026-10-04T00:00:00.000Z",
    paymentMethodAttached: true,
    billingActiveFrom: "2026-01-01T00:00:00.000Z",
    billingRequiredSince: "2026-01-01T00:00:00.000Z",
  });
  // FINDING 11: `latestInvoiceStatus === "paid"` used to null `pastDueSince`
  // UNCONDITIONALLY — including while the subscription itself still read past_due (one
  // paid invoice, one older unpaid one). The tier clock then fell back to a months-old
  // `billingRequiredSince` and BLOCKED the agency instantly, skipping the entire
  // 14-day/30-day ladder decision 6 promises.
  const { d } = deps({ fetch: () => view("sub_1", "past_due", { latestInvoiceStatus: "paid" }) });
  await reconcileProfile(profile(), d);

  const p = profile();
  assert.equal(p.subscriptionStatus, "past_due");
  assert.equal(p.pastDueSince, "2026-10-04T00:00:00.000Z", "the escalation clock survives");

  // …and the ladder really is intact: a clock one day old is `warning`, not `blocked`.
  const enforce = await import("@/lib/billing-enforce");
  const state = enforce.tierFromProfile(p, NOW);
  assert.equal(state.tier, "warning");
  assert.equal(state.since, "2026-10-04T00:00:00.000Z");
});

test("F2 a transient fetch error alerts and SKIPS — a healthy agency is never mirrored as dead", async () => {
  await seed({
    stripeSubscriptionId: "sub_1",
    subscriptionStatus: "active",
    paymentMethodAttached: true,
    billingActiveFrom: "2026-09-20T00:00:00.000Z",
  });
  // D-B / FINDING 5 (reconciler side): a 429 used to collapse to `null` => "the stored
  // subscription is dead" => the customer listing, and with THAT also failing to `[]`,
  // `dead-no-replacement`. A paying agency, one blip away from the cancel ladder.
  const { d, calls, alerts } = deps({
    fetchRaw: () => ({ kind: "error", message: "429 rate limited" }),
  });
  const res = await reconcileProfile(profile(), d);

  assert.equal(res.outcome, "fetch-error");
  assert.deepEqual(calls.listed, [], "no customer listing is attempted on a blip");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "error");
  assert.match(alerts[0].message, /429/);
  const p = profile();
  assert.equal(p.subscriptionStatus, "active", "the mirror is left EXACTLY as it was");
  assert.equal(p.canceledAt, null);
});

test("F2 FR2-3 backstop: two live subscriptions are caught by the daily sweep even if the webhook's conflict alert was lost", async () => {
  // The finding-14 loser-cancel can itself fail, or its alert can be lost. This sweep
  // is the safety net named in FR2-3: within a day the duplicate is surfaced anyway.
  await seed({ stripeSubscriptionId: "sub_dead", subscriptionStatus: "canceled" });
  const { d, alerts } = deps({
    fetch: () => view("sub_dead", "canceled", { pm: false }),
    list: () => [view("sub_a", "active"), view("sub_b", "active")],
  });
  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "duplicate");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "duplicateSubscription");
  assert.match(alerts[0].message, /sub_a/);
  assert.match(alerts[0].message, /sub_b/);
  assert.equal(profile().stripeSubscriptionId, "sub_dead", "nothing is silently picked");
});

test("F2 a customer-listing failure alerts through reconcileAll instead of faking an empty list", async () => {
  // `listLiveSubscriptionsForCustomer` no longer swallows API errors into `[]` (D-B):
  // an empty list is the load-bearing evidence for "dead, with no replacement".
  writeDb();
  await store.ensureBillingProfileForAgent(AGENT, "2026-09-01T00:00:00.000Z");
  await store.setBillingStripeRefs(AGENT, { stripeCustomerId: "cus_1", stripeSubscriptionId: null });
  const alerts = [];
  const results = await reconcileAll((await import("@/lib/db")).readDB().billingProfiles, {
    fetchSubscription: async () => ({ kind: "not-found" }),
    listLiveSubscriptionsForCustomer: async () => {
      throw new Error("stripe 503");
    },
    alert: (kind, message, agentId) => alerts.push({ kind, message, agentId }),
    now: () => NOW,
  });
  assert.deepEqual(results, [], "the profile is skipped, not mirrored on a guess");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "error");
  assert.match(alerts[0].message, /stripe 503/);
  assert.equal(profile().subscriptionStatus, "none", "untouched");
});

// ===========================================================================
// R2-4 — the reconciler participates in the ordering guard
// ===========================================================================

test("R2-4: the reconciler stamps its FETCH timestamp into BOTH ordering fields", async () => {
  await seed({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" });
  const { d } = deps({ fetch: () => view("sub_1", "past_due", { latestInvoiceStatus: "open" }) });
  await reconcileProfile(profile(), d);
  const expected = Math.floor(NOW / 1000);
  const p = profile();
  assert.equal(p.lastInvoiceEventCreated, expected);
  assert.equal(p.lastSubscriptionEventCreated, expected);
});

test("R2-4: a webhook that landed MID-FETCH wins — the reconciler abandons its stale read", async () => {
  await seed({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active", pastDueSince: null });
  const fetchAtSec = Math.floor(NOW / 1000);

  const { d } = deps({
    fetch: async () => {
      // While we are "talking to Stripe", a NEWER webhook lands and marks the agency
      // past due. Its event.created is after our fetch watermark.
      await store.setSubscriptionStatusForAgent(AGENT, {
        subscriptionStatus: "past_due",
        pastDueSince: "2026-10-05T03:00:30.000Z",
        lastInvoiceEventCreated: fetchAtSec + 30,
        lastSubscriptionEventCreated: fetchAtSec + 30,
      });
      return view("sub_1", "active"); // our read is now stale
    },
  });

  const res = await reconcileProfile(profile(), d);
  assert.equal(res.outcome, "superseded-by-webhook");
  const p = profile();
  assert.equal(p.subscriptionStatus, "past_due", "the fresher webhook is NOT overwritten");
  assert.equal(p.pastDueSince, "2026-10-05T03:00:30.000Z");
  assert.equal(p.lastInvoiceEventCreated, fetchAtSec + 30, "the watermark is not rolled back");
});

// ===========================================================================
// reconcileAll
// ===========================================================================

test("reconcileAll skips customer-less profiles and survives a thrown Stripe error", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("agent:a");
  await store.ensureBillingProfileForAgent("agent:b");
  await store.ensureBillingProfileForAgent("agent:c");
  await store.setBillingStripeRefs("agent:a", { stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a" });
  await store.setBillingStripeRefs("agent:c", { stripeCustomerId: "cus_c", stripeSubscriptionId: "sub_c" });
  // agent:b has no customer at all.

  const alerts = [];
  const d = {
    fetchSubscription: async (id) => {
      if (id === "sub_c") throw new Error("stripe exploded");
      return { kind: "found", view: view(id, "active") };
    },
    listLiveSubscriptionsForCustomer: async () => [],
    alert: (kind, message, agentId) => alerts.push({ kind, message, agentId }),
    now: () => NOW,
  };

  const results = await reconcileAll(
    (await import("@/lib/db")).readDB().billingProfiles,
    d
  );
  assert.deepEqual(results.map((r) => r.agentId), ["agent:a"], "b skipped (no customer), c threw");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "error");
  assert.equal(alerts[0].agentId, "agent:c");
  assert.match(alerts[0].message, /stripe exploded/);
});
