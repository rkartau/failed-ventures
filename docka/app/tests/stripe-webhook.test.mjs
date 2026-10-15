// Unit tests for the Stripe webhook state machine (STRIPE-BILLING-PLAN.md P3 +
// R1-2/R1-4, R2-2/R2-4/R2-7, R3-1).
//
// NOTHING here talks to Stripe. Signatures are computed by hand with node:crypto and
// fed through the SDK's `constructEvent` (pure HMAC, no network); every Stripe READ is
// a faked dep injected into `handleStripeEvent`. The handlers take PARSED events, so
// the route module itself is never imported (same rule as the registry-health tests).
//
// ===========================================================================
// ACCEPTED RACE — DO NOT "FIX" THIS (plan §R3 "Accepted races", round-3 architect)
// ===========================================================================
// Two concurrent redeliveries of the same event can BOTH pass phase 1 (claim) and
// both run phase 2 (the Stripe side effects), because phase 2 deliberately happens
// OUTSIDE the db mutex. That is harmless and intentional:
//   * the phase-2 calls are idempotent — cancelling an already-cancelled subscription
//     no-ops, and a subscription fetch has no side effect at all;
//   * phase 3 is idempotent — it writes the same patch twice.
// The two "obvious fixes" are both worse:
//   * holding the mutex across phase 2 puts a network round-trip inside a
//     PROCESS-WIDE lock, stalling every other writer in the app;
//   * skipping rows whose processedAt is null turns a crash between phase 1 and
//     phase 3 into a PERMANENTLY LOST event (the crash-replay test below proves the
//     current design converges instead).
// ===========================================================================
//
// Run: node --import ./tests/_register-alias.mjs --test tests/stripe-webhook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-stripe-webhook-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const WEBHOOK_SECRET = "whsec_unit_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
// No STRIPE_SECRET_KEY on purpose: the whole suite must pass with billing unconfigured.
delete process.env.STRIPE_SECRET_KEY;

const DB_PATH = path.join(TMP, "data", "db.json");

const db = await import("@/lib/db");
const store = await import("@/lib/billing-store");
const stripeLib = await import("@/lib/stripe");
const { handleStripeEvent } = await import("@/lib/stripe-webhook");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---- Fixtures -------------------------------------------------------------

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

const AGENT = "agent:acme";

/** A profile already wired to Stripe, in whatever state the case needs. */
async function seedProfile(patch = {}) {
  writeDb();
  await store.ensureBillingProfileForAgent(AGENT, "2026-09-01T00:00:00.000Z");
  await store.setBillingStripeRefs(AGENT, {
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: patch.stripeSubscriptionId ?? null,
  });
  const rest = { ...patch };
  delete rest.stripeSubscriptionId;
  if (Object.keys(rest).length) await store.setSubscriptionStatusForAgent(AGENT, rest);
  return store.getBillingProfileForAgent(AGENT);
}

let evtSeq = 0;
function event(type, object, created = 1_800_000_000) {
  return {
    id: `evt_${++evtSeq}`,
    type,
    created,
    data: { object },
  };
}

/** A `{kind:"found"}` fetch result, as lib/stripe's tagged contract produces (D-B). */
function found(id, status, over = {}) {
  return {
    kind: "found",
    view: {
      id,
      status,
      currentPeriodEnd: over.currentPeriodEnd ?? null,
      defaultPaymentMethodAttached: over.pm ?? true,
      created: over.created ?? 1,
      latestInvoiceStatus: over.latestInvoiceStatus ?? "paid",
    },
  };
}

/** Deps with no side effects — the default for cases that never touch Stripe. */
function deps(over = {}) {
  const alerts = [];
  const cancelled = [];
  return {
    alerts,
    cancelled,
    d: {
      // D-B — the TAGGED fetch contract: `not-found` (a real 404) and `error` (a 429 /
      // 5xx / network blip) are different facts and the handler treats them differently.
      fetchSubscription: over.fetchSubscription ?? (async () => ({ kind: "not-found" })),
      cancelSubscriptionNow:
        over.cancelSubscriptionNow ??
        (async (id) => {
          cancelled.push(id);
          return { ok: true };
        }),
      alert: (kind, message, agentId) => alerts.push({ kind, message, agentId }),
      now: over.now ?? (() => "2026-09-15T12:00:00.000Z"),
    },
  };
}

const profile = () => store.getBillingProfileForAgent(AGENT);

// ===========================================================================
// Signature verification (HMAC computed here, verified by the SDK)
// ===========================================================================

function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signed = `${timestamp}.${payload}`;
  const v1 = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

test("signature: a correctly-signed raw body verifies and parses", async () => {
  const payload = JSON.stringify({ id: "evt_sig", type: "invoice.paid", created: 1, data: { object: {} } });
  const parsed = await stripeLib.constructWebhookEvent(payload, signPayload(payload, WEBHOOK_SECRET), WEBHOOK_SECRET);
  assert.equal(parsed.id, "evt_sig");
  assert.equal(parsed.type, "invoice.paid");
});

test("signature: a wrong secret, a tampered body and a stale timestamp are all REJECTED", async () => {
  const payload = JSON.stringify({ id: "evt_sig2", type: "invoice.paid", created: 1, data: { object: {} } });
  const good = signPayload(payload, WEBHOOK_SECRET);

  await assert.rejects(
    () => stripeLib.constructWebhookEvent(payload, signPayload(payload, "whsec_wrong"), WEBHOOK_SECRET),
    /signature/i,
    "a signature from a different secret must not verify"
  );
  await assert.rejects(
    () => stripeLib.constructWebhookEvent(payload.replace("evt_sig2", "evt_evil"), good, WEBHOOK_SECRET),
    /signature/i,
    "the signature covers the RAW body — tampering must break it"
  );
  const stale = signPayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  await assert.rejects(
    () => stripeLib.constructWebhookEvent(payload, stale, WEBHOOK_SECRET),
    /timestamp|tolerance/i,
    "a replayed old signature is outside the tolerance window"
  );
});

// ===========================================================================
// checkout.session.completed
// ===========================================================================

test("checkout.session.completed stores the ids, activates and stamps billingActiveFrom", async () => {
  await seedProfile();
  const { d } = deps();
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_1",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: { agentId: AGENT },
    }),
    d
  );
  assert.equal(res.status, 200);
  const p = profile();
  assert.equal(p.stripeSubscriptionId, "sub_1");
  assert.equal(p.stripeCustomerId, "cus_1");
  assert.equal(p.subscriptionStatus, "active");
  assert.equal(p.paymentMethodAttached, true);
  assert.equal(p.billingActiveFrom, "2026-09-15T12:00:00.000Z");
});

test("R1-4/R3-1: a second checkout while the stored subscription is LIVE cancels the new one", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_live", subscriptionStatus: "active" });
  const { d, alerts, cancelled } = deps({
    fetchSubscription: async (id) => found(id, "active"),
  });
  const res = await handleStripeEvent(
    event("checkout.session.completed", { id: "cs_2", customer: "cus_1", subscription: "sub_dupe", metadata: { agentId: AGENT } }),
    d
  );
  assert.equal(res.body.duplicate, true);
  assert.deepEqual(cancelled, ["sub_dupe"], "the NEWLY created duplicate is the one cancelled");
  assert.equal(profile().stripeSubscriptionId, "sub_live", "the live subscription is untouched");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "duplicateSubscription");
});

test("R3-1: cancel -> re-checkout ADOPTS the new subscription instead of cancelling it", async () => {
  await seedProfile({
    stripeSubscriptionId: "sub_dead",
    subscriptionStatus: "canceled",
    canceledAt: "2026-09-10T00:00:00.000Z",
  });
  const { d, cancelled, alerts } = deps({
    // The stored subscription fetches as DEAD.
    fetchSubscription: async (id) => found(id, "canceled", { pm: false, latestInvoiceStatus: null }),
  });
  const ev = event("checkout.session.completed", { id: "cs_3", customer: "cus_1", subscription: "sub_new", metadata: { agentId: AGENT } });
  const res = await handleStripeEvent(ev, d);

  assert.equal(res.body.duplicate, false);
  assert.deepEqual(cancelled, [], "NOTHING is cancelled — this is a legitimate re-subscribe");
  assert.deepEqual(alerts, []);
  const p = profile();
  assert.equal(p.stripeSubscriptionId, "sub_new");
  assert.equal(p.subscriptionStatus, "active");
  assert.equal(p.canceledAt, null, "the cancel stamp is cleared on adoption");
  assert.equal(p.billingActiveFrom, "2026-09-15T12:00:00.000Z", "the gap is never retro-billed");

  // ...and a repeat delivery of that same completed event stays idempotent.
  const again = await handleStripeEvent(ev, d);
  assert.equal(again.body.replay, true);
  assert.equal(profile().stripeSubscriptionId, "sub_new");
});

// MODIFIED (fix-plan §3): this case used to pin `fetch returns null` as "the stored
// subscription is a 404, so adopt" — the very NULL COLLAPSE that IS finding 5, because
// a 429/5xx/network blip produced the same `null`. It now pins the `not-found` half of
// the tagged contract; the `error` half is the sibling case immediately below.
test("R3-1: a genuine 404 on the stored subscription adopts (fetch returns not-found)", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_vanished", subscriptionStatus: "active" });
  const { d, cancelled } = deps({ fetchSubscription: async () => ({ kind: "not-found" }) });
  await handleStripeEvent(
    event("checkout.session.completed", { id: "cs_4", customer: "cus_1", subscription: "sub_fresh", metadata: { agentId: AGENT } }),
    d
  );
  assert.deepEqual(cancelled, []);
  assert.equal(profile().stripeSubscriptionId, "sub_fresh");
});

test("F2 adopt-on-blip: a transient error fetching the stored subscription throws (5xx) — the live stored sub is NOT abandoned and the new sub is NOT adopted", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_live", subscriptionStatus: "active" });
  // FINDING 5: `fetchSubscription` collapsed 429/5xx/network into the SAME null a 404
  // produced, so a blip during the duplicate check read as "the stored subscription is
  // dead" — the handler adopted the new one and left the still-live old one invoicing,
  // with no alert anywhere (the reconciler mirrors the STORED id, which was now the
  // new, healthy one).
  const blip = deps({ fetchSubscription: async () => ({ kind: "error", message: "429 rate limited" }) });
  const ev = event("checkout.session.completed", {
    id: "cs_blip", customer: "cus_1", subscription: "sub_new", metadata: { agentId: AGENT },
  });

  await assert.rejects(() => handleStripeEvent(ev, blip.d), /refusing to guess/);
  assert.deepEqual(blip.cancelled, [], "nothing was cancelled on a guess");
  assert.equal(profile().stripeSubscriptionId, "sub_live", "the live subscription is NOT abandoned");
  assert.equal(store.wasStripeEventProcessed(ev.id), false, "processedAt stays null so Stripe redelivers");

  // Stripe recovers and answers honestly: the stored subscription really is gone.
  const healthy = deps({ fetchSubscription: async () => ({ kind: "not-found" }) });
  const res = await handleStripeEvent(ev, healthy.d);
  assert.equal(res.body.replay, undefined, "the crashed claim is REPROCESSED, not skipped");
  assert.equal(profile().stripeSubscriptionId, "sub_new", "…and only now is the new one adopted");
  assert.equal(store.wasStripeEventProcessed(ev.id), true);
});

test("F2 swallowed-cancel: a failed duplicate-cancel throws → 5xx → redelivery re-runs and converges when the cancel finally succeeds", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_live", subscriptionStatus: "active" });
  // FINDING 4: `cancelSubscriptionNow` swallowed every error into `false`, the caller
  // ignored the return, `processedAt` was stamped and the alert LIED ("the new one was
  // cancelled"). The agency paid two base fees forever, and the reconciler was blind
  // because the STORED subscription really was live.
  let attempts = 0;
  const flaky = deps({
    fetchSubscription: async (id) => found(id, "active"),
    cancelSubscriptionNow: async (id) => {
      attempts++;
      if (attempts === 1) return { ok: false, error: "stripe 500" };
      flaky.cancelled.push(id);
      return { ok: true };
    },
  });
  const ev = event("checkout.session.completed", {
    id: "cs_dupe_fail", customer: "cus_1", subscription: "sub_dupe", metadata: { agentId: AGENT },
  });

  await assert.rejects(() => handleStripeEvent(ev, flaky.d), /failed to cancel the duplicate/);
  assert.equal(store.wasStripeEventProcessed(ev.id), false, "the event is left for redelivery");
  assert.deepEqual(flaky.alerts, [], "no alert claims a cancel that never happened");
  assert.equal(profile().stripeSubscriptionId, "sub_live");

  // Stripe redelivers; phase 2 is idempotent, and this time the cancel lands.
  const res = await handleStripeEvent(ev, flaky.d);
  assert.equal(res.body.duplicate, true);
  assert.deepEqual(flaky.cancelled, ["sub_dupe"]);
  assert.equal(flaky.alerts.length, 1);
  assert.equal(flaky.alerts[0].kind, "duplicateSubscription");
  assert.equal(store.wasStripeEventProcessed(ev.id), true, "converged");
  assert.equal(profile().stripeSubscriptionId, "sub_live");
});

/**
 * Drive the finding-14 race: the OTHER tab's phase 3 lands while THIS event is inside
 * its own phase 2 (the Stripe fetch), which is precisely where the real window is — the
 * plan forbids holding the db mutex across a network call, so the gap is by design.
 * The recheck in phase 3 is what makes exactly one writer win.
 */
function racingDeps(winnerSubId, over = {}) {
  const d = deps({
    fetchSubscription: async (id) => {
      if (id !== winnerSubId && !d.raced) {
        d.raced = true;
        // The winner's phase-3 write lands mid-fetch.
        await store.setBillingStripeRefs(AGENT, { stripeSubscriptionId: winnerSubId });
      }
      // The stored (pre-race) subscription is dead, so this event is on the ADOPT path
      // and never takes the duplicate branch — exactly the finding-14 setup.
      return id === winnerSubId ? found(id, "active") : found(id, "canceled", { pm: false });
    },
    ...over,
  });
  return d;
}

test("F2 two-tab race: of two concurrent completed events, the loser cancels its own subscription and alerts", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
  // FINDING 14: phase 3 wrote unconditionally, so the second event simply overwrote the
  // first — TWO live subscriptions, and the reconciler never flagged it because the
  // STORED id was itself live.
  const loser = racingDeps("sub_winner");
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_loser", customer: "cus_1", subscription: "sub_loser", metadata: { agentId: AGENT },
    }),
    loser.d
  );

  assert.equal(res.body.conflict, true, "the post-write recheck caught the race");
  assert.equal(profile().stripeSubscriptionId, "sub_winner", "exactly ONE writer wins");
  assert.deepEqual(loser.cancelled, ["sub_loser"], "the loser cancels its OWN subscription");
  assert.equal(loser.alerts.length, 1);
  assert.equal(loser.alerts[0].kind, "duplicateSubscription");
  assert.match(loser.alerts[0].message, /sub_winner/);
});

test("F2 two-tab race: a FAILING loser-cancel alerts (never throws) and names the money consequence", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
  // FR1-6 — the conflict clean-up runs AFTER processedAt is stamped, so throwing would
  // be useless: the redelivery would answer `replayOfProcessed` and 200.
  const loser = racingDeps("sub_winner", {
    cancelSubscriptionNow: async () => ({ ok: false, error: "stripe 500" }),
  });
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_loser2", customer: "cus_1", subscription: "sub_loser2", metadata: { agentId: AGENT },
    }),
    loser.d
  );

  assert.equal(res.status, 200, "never a throw — processedAt is already stamped (FR1-6)");
  assert.equal(res.body.conflict, true);
  assert.equal(loser.alerts.length, 1);
  assert.match(loser.alerts[0].message, /KEEPS INVOICING/, "the alert names the money consequence");
  assert.equal(profile().stripeSubscriptionId, "sub_winner");
});

test("F2 zombie invoice: subscription.deleted then a final invoice.paid leaves status canceled and the paywall standing", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" });
  const { d } = deps();
  await handleStripeEvent(
    event("customer.subscription.deleted", { id: "sub_1", status: "canceled", customer: "cus_1" }, 1_800_002_000),
    d
  );
  assert.equal(profile().subscriptionStatus, "canceled");
  const canceledAt = profile().canceledAt;

  // FINDING 10: the final prorated invoice used to flip canceled -> active, lifting the
  // paywall and resuming metering on a subscription Stripe had already ended.
  const res = await handleStripeEvent(
    event("invoice.paid", { id: "in_final", customer: "cus_1" }, 1_800_002_100),
    d
  );
  assert.equal(res.body.dropped, false, "the event is applied, not dropped");
  const p = profile();
  assert.equal(p.subscriptionStatus, "canceled", "a dead subscription is never resurrected");
  assert.equal(p.canceledAt, canceledAt, "the R2-5 ageing clock keeps running");
  assert.equal(p.pastDueSince, null, "the invoice really was paid, so that clock IS cleared");
});

test("F2 one status table: for every raw status, duplicate-guard liveness ≡ (mapStripeStatus ∈ {active, past_due, incomplete})", () => {
  // FINDING 20: `isLiveStripeStatus` was an independent DENY-list, so any unknown or
  // future Stripe status was LIVE to the duplicate guard (it cancelled the customer's
  // genuine new subscription) and "no subscription" to the tier logic.
  const LIVE = new Set(["active", "past_due", "incomplete"]);
  const raws = [
    "active", "trialing", "past_due", "unpaid", "paused", "incomplete",
    "incomplete_expired", "canceled", "something_new", "", null, undefined,
    "ACTIVE", "will_be_added_in_2027",
  ];
  for (const raw of raws) {
    assert.equal(
      stripeLib.isLiveStripeStatus(raw),
      LIVE.has(stripeLib.mapStripeStatus(raw)),
      `liveness must be derived from the ONE mapping table for ${JSON.stringify(raw)}`
    );
  }
  assert.equal(stripeLib.isLiveStripeStatus("something_new"), false, "unknown => dead => adopt, the safe direction for money");
});

test("F2 rate-change self-heal: stored priceIds matching nothing falls back to product-id matching", () => {
  // FINDING 15: the old matcher keyed ONLY on the stored price ids, and the ids were
  // persisted AFTER the swap — so a crash in between left every future rate change
  // silently no-opping while the API still reported `stripeUpdated: true`.
  const products = { baseProductId: "prod_base", usageProductId: "prod_usage" };
  const next = { basePriceId: "price_new_base", usagePriceId: "price_new_usage" };
  const items = [
    { id: "si_1", price: { id: "price_live_base", product: "prod_base" } },
    { id: "si_2", price: { id: "price_live_usage", product: { id: "prod_usage" } } },
  ];

  // (a) the healthy case still matches by stored price id.
  assert.deepEqual(
    stripeLib.matchRateChangeItems(items, { basePriceId: "price_live_base", usagePriceId: "price_live_usage" }, products, next),
    [
      { id: "si_1", price: "price_new_base" },
      { id: "si_2", price: "price_new_usage" },
    ]
  );

  // (b) a DESYNCED profile (stored ids match nothing) self-heals via the products.
  assert.deepEqual(
    stripeLib.matchRateChangeItems(items, { basePriceId: "price_stale", usagePriceId: null }, products, next),
    [
      { id: "si_1", price: "price_new_base" },
      { id: "si_2", price: "price_new_usage" },
    ]
  );

  // (c) genuinely foreign items still match nothing — the fallback is not a wildcard.
  assert.deepEqual(
    stripeLib.matchRateChangeItems(
      [{ id: "si_x", price: { id: "price_other", product: "prod_someone_else" } }],
      { basePriceId: "price_stale", usagePriceId: null },
      products,
      next
    ),
    []
  );
});

test("F2 applyMappedStatus is the ONE effect chain both consumers call", () => {
  const base = {
    agentId: AGENT, pastDueSince: null, canceledAt: null, stripeSubscriptionId: "sub_1",
    subscriptionStatus: "active", paymentMethodAttached: true,
  };
  const NOW = "2026-09-15T12:00:00.000Z";

  // past_due NEVER nulls the clock (finding 11) and never restarts it.
  assert.equal(stripeLib.applyMappedStatus(base, "past_due", { nowIso: NOW }).pastDueSince, NOW);
  assert.equal(
    stripeLib.applyMappedStatus({ ...base, pastDueSince: "2026-09-01T00:00:00.000Z" }, "past_due", { nowIso: NOW }).pastDueSince,
    "2026-09-01T00:00:00.000Z"
  );
  // active clears both clocks.
  const active = stripeLib.applyMappedStatus({ ...base, pastDueSince: NOW, canceledAt: NOW }, "active", { nowIso: NOW });
  assert.equal(active.pastDueSince, null);
  assert.equal(active.canceledAt, null);
  // canceled keeps the id for audit; none clears it.
  assert.equal(stripeLib.applyMappedStatus(base, "canceled", { nowIso: NOW }).stripeSubscriptionId, undefined);
  assert.equal(stripeLib.applyMappedStatus(base, "none", { nowIso: NOW, subscriptionId: "sub_1" }).stripeSubscriptionId, null);
  // paymentMethodAttached is applied ONLY when the caller observed it.
  assert.equal("paymentMethodAttached" in stripeLib.applyMappedStatus(base, "active", { nowIso: NOW }), false);
  assert.equal(
    stripeLib.applyMappedStatus(base, "active", { nowIso: NOW, paymentMethodAttached: false }).paymentMethodAttached,
    false
  );
});

// ===========================================================================
// Idempotency + crash replay (R2-2)
// ===========================================================================

test("R2-2: a redelivery of a PROCESSED event is a no-op replay", async () => {
  await seedProfile({ subscriptionStatus: "past_due", pastDueSince: "2026-09-01T00:00:00.000Z" });
  const { d } = deps();
  const ev = event("invoice.paid", { id: "in_1", customer: "cus_1" });
  const first = await handleStripeEvent(ev, d);
  assert.equal(first.body.replay, undefined);
  assert.equal(profile().pastDueSince, null);

  // Someone re-fails the profile out of band; a replay must NOT re-apply the event.
  await store.setSubscriptionStatusForAgent(AGENT, { pastDueSince: "2026-09-20T00:00:00.000Z" });
  const replay = await handleStripeEvent(ev, d);
  assert.equal(replay.body.replay, true);
  assert.equal(profile().pastDueSince, "2026-09-20T00:00:00.000Z", "the replay changed nothing");
  assert.equal(db.readDB().stripeEvents.length, 1, "the ledger holds ONE row for the event");
});

test("R2-2/R1-2e: a CRASH between phase 1 and phase 3 converges on redelivery", async () => {
  await seedProfile({ subscriptionStatus: "past_due", pastDueSince: "2026-09-01T00:00:00.000Z" });
  const ev = event("invoice.paid", { id: "in_crash", customer: "cus_1" });

  // Simulate the crash: phase 1 claimed the event, then the process died before
  // phase 3 could mutate anything.
  await store.claimStripeEvent(ev.id, ev.type, "2026-09-15T11:59:00.000Z");
  assert.equal(store.wasStripeEventProcessed(ev.id), false);
  assert.equal(profile().pastDueSince, "2026-09-01T00:00:00.000Z", "nothing was applied");

  // Stripe redelivers. The claim row has processedAt === null, so it is REPROCESSED.
  const { d } = deps();
  const res = await handleStripeEvent(ev, d);
  assert.equal(res.body.replay, undefined, "a crashed claim is not treated as a replay");
  assert.equal(profile().pastDueSince, null, "state converged");
  assert.equal(store.wasStripeEventProcessed(ev.id), true);
  assert.equal(db.readDB().stripeEvents.filter((e) => e.stripeEventId === ev.id).length, 1);
});

// ===========================================================================
// Ordering (R2-4 per-family, and R1-2e's stale past_due view)
// ===========================================================================

test("R2-4: a delayed invoice.payment_failed still sets pastDueSince after a newer subscription event", async () => {
  await seedProfile({ subscriptionStatus: "active" });
  const { d } = deps();

  // A subscription-family event lands FIRST and bumps only the subscription clock.
  await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active", customer: "cus_1" }, 1_800_000_100),
    d
  );
  assert.equal(profile().lastSubscriptionEventCreated, 1_800_000_100);
  assert.equal(profile().lastInvoiceEventCreated, null);

  // Now the INVOICE event, created 1s EARLIER than that subscription event, arrives.
  // A shared clock would have dropped it; per-family clocks must not.
  const res = await handleStripeEvent(
    event("invoice.payment_failed", { id: "in_late", customer: "cus_1" }, 1_800_000_099),
    d
  );
  assert.equal(res.body.dropped, false);
  assert.equal(profile().subscriptionStatus, "past_due");
  assert.equal(profile().pastDueSince, "2026-09-15T12:00:00.000Z");
});

test("R2-4: a stale event WITHIN its own family is dropped", async () => {
  await seedProfile({ subscriptionStatus: "active" });
  const { d } = deps();
  await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active", customer: "cus_1" }, 1_800_000_500),
    d
  );
  const res = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "past_due", customer: "cus_1" }, 1_800_000_400),
    d
  );
  assert.equal(res.body.dropped, true);
  assert.equal(profile().subscriptionStatus, "active", "a stale same-family event cannot downgrade");
});

test("R1-2e: an out-of-order subscription.updated(past_due) after invoice.paid leaves status active", async () => {
  await seedProfile({ subscriptionStatus: "past_due", pastDueSince: "2026-09-01T00:00:00.000Z" });
  const { d } = deps();
  await handleStripeEvent(event("invoice.paid", { id: "in_2", customer: "cus_1" }, 1_800_001_000), d);
  assert.equal(profile().subscriptionStatus, "active");
  assert.equal(profile().pastDueSince, null);

  // The stale subscription view was created BEFORE the invoice that settled it.
  const res = await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "past_due", customer: "cus_1" }, 1_800_000_900),
    d
  );
  assert.equal(res.body.dropped, true);
  assert.equal(profile().subscriptionStatus, "active", "a paid invoice is not clobbered by a stale view");
  assert.equal(profile().pastDueSince, null);
});

// ===========================================================================
// R2-7 status matrix
// ===========================================================================

test("R2-7: every Stripe status maps exactly once", () => {
  const m = stripeLib.mapStripeStatus;
  assert.equal(m("active"), "active");
  assert.equal(m("trialing"), "active");
  assert.equal(m("past_due"), "past_due");
  assert.equal(m("unpaid"), "past_due");
  assert.equal(m("paused"), "past_due");
  assert.equal(m("incomplete"), "incomplete");
  assert.equal(m("incomplete_expired"), "none");
  assert.equal(m("canceled"), "canceled");
  assert.equal(m("something_new"), "none");
  assert.equal(stripeLib.isLiveStripeStatus("active"), true);
  assert.equal(stripeLib.isLiveStripeStatus("past_due"), true);
  assert.equal(stripeLib.isLiveStripeStatus("canceled"), false);
  assert.equal(stripeLib.isLiveStripeStatus("incomplete_expired"), false);
});

for (const [raw, expected] of [
  ["active", "active"],
  ["trialing", "active"],
  ["past_due", "past_due"],
  ["unpaid", "past_due"],
  ["paused", "past_due"],
  ["incomplete", "incomplete"],
]) {
  test(`R2-7 webhook: customer.subscription.updated(${raw}) mirrors as ${expected}`, async () => {
    await seedProfile({ stripeSubscriptionId: "sub_1", subscriptionStatus: "none" });
    const { d } = deps();
    await handleStripeEvent(
      event("customer.subscription.updated", { id: "sub_1", status: raw, customer: "cus_1" }),
      d
    );
    const p = profile();
    assert.equal(p.subscriptionStatus, expected);
    if (expected === "past_due") assert.equal(p.pastDueSince, "2026-09-15T12:00:00.000Z");
    if (expected === "active") assert.equal(p.pastDueSince, null);
    assert.equal(p.stripeSubscriptionId, "sub_1", "a live id is never cleared");
  });
}

test("R2-7/R3-1: incomplete_expired maps to none AND clears the id, unlocking checkout", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_1", subscriptionStatus: "incomplete" });
  const { d } = deps();
  await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "incomplete_expired", customer: "cus_1" }),
    d
  );
  const p = profile();
  assert.equal(p.subscriptionStatus, "none");
  assert.equal(p.stripeSubscriptionId, null, "cleared so the reconciler can adopt and checkout re-opens");
  assert.equal(p.canceledAt, null);
});

test("R2-5/R3-1: subscription.deleted sets canceledAt and KEEPS the id for audit", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_1", subscriptionStatus: "active" });
  const { d } = deps();
  await handleStripeEvent(event("customer.subscription.deleted", { id: "sub_1", status: "canceled", customer: "cus_1" }), d);
  const p = profile();
  assert.equal(p.subscriptionStatus, "canceled");
  assert.equal(p.canceledAt, "2026-09-15T12:00:00.000Z");
  assert.equal(p.stripeSubscriptionId, "sub_1", "kept for audit; a re-subscribe adopts over it");
});

test("subscription.updated mirrors the payment-method flag when Stripe sends it", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_1", paymentMethodAttached: false });
  const { d } = deps();
  await handleStripeEvent(
    event("customer.subscription.updated", { id: "sub_1", status: "active", customer: "cus_1", default_payment_method: "pm_1" }),
    d
  );
  assert.equal(profile().paymentMethodAttached, true);
});

// ===========================================================================
// Attribution + unknown events
// ===========================================================================

test("an event for an unknown customer is acknowledged, recorded and applied to nobody", async () => {
  await seedProfile();
  const { d } = deps();
  const res = await handleStripeEvent(event("invoice.paid", { id: "in_x", customer: "cus_stranger" }), d);
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, "no matching agent");
  assert.equal(profile().subscriptionStatus, "none", "no profile was touched");
});

test("attribution falls back from metadata to subscription id to customer id", async () => {
  // The seed status is `incomplete` (a LIVE subscription awaiting its first payment):
  // after finding 10, invoice.paid deliberately no longer resurrects a `none`/`canceled`
  // subscription, so a dead seed would make this attribution case assert the bug.
  await seedProfile({ stripeSubscriptionId: "sub_join", subscriptionStatus: "incomplete" });
  const { d } = deps();
  // No metadata, no customer — only the subscription id.
  const res = await handleStripeEvent(event("invoice.paid", { id: "in_j", subscription: "sub_join" }), d);
  assert.equal(res.body.agentId, AGENT);
  assert.equal(profile().subscriptionStatus, "active");
});

test("an unhandled event type is acknowledged 200 and marked processed", async () => {
  await seedProfile();
  const { d } = deps();
  const ev = event("customer.updated", { id: "cus_1", customer: "cus_1" });
  const res = await handleStripeEvent(ev, d);
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, "customer.updated");
  assert.equal(store.wasStripeEventProcessed(ev.id), true, "Stripe must stop retrying it");
});

// ===========================================================================
// Anchor / expiry / meter-timestamp math (R2-1, R1-5 restated by R3-2)
// ===========================================================================

test("R2-1: the billing anchor is 00:00 UTC on the 1st and never drifts with DST", () => {
  const summer = stripeLib.nextUtcAnchorSec(Date.parse("2026-07-14T10:00:00.000Z"));
  assert.equal(new Date(summer * 1000).toISOString(), "2026-08-01T00:00:00.000Z");
  const winter = stripeLib.nextUtcAnchorSec(Date.parse("2026-12-14T10:00:00.000Z"));
  assert.equal(new Date(winter * 1000).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("R1-5/R3-2: a checkout started just before midnight cannot produce a PAST anchor", () => {
  const now = Date.parse("2026-08-31T23:50:00.000Z"); // 10 minutes to the anchor
  const anchor = stripeLib.nextUtcAnchorSec(now);
  assert.equal(
    new Date(anchor * 1000).toISOString(),
    "2026-10-01T00:00:00.000Z",
    "the window was too short, so the anchor rolls to the FOLLOWING 1st"
  );
  const expires = stripeLib.checkoutExpiresAtSec(now, anchor) * 1000;
  assert.ok(expires > now, "the session expiry is in the future");
  assert.ok(expires - now >= stripeLib.CHECKOUT_MIN_LIFETIME_MS, "at least Stripe's 30-minute floor");
  assert.ok(expires - now <= stripeLib.CHECKOUT_MAX_LIFETIME_MS, "at most Stripe's 24h ceiling");
  assert.ok(expires < anchor * 1000, "the session can never outlive the anchor it was priced against");
});

test("R1-5/R3-2: a mid-month checkout expires 24h out, well inside the anchor", () => {
  const now = Date.parse("2026-08-14T09:00:00.000Z");
  const anchor = stripeLib.nextUtcAnchorSec(now);
  assert.equal(new Date(anchor * 1000).toISOString(), "2026-09-01T00:00:00.000Z");
  const expires = stripeLib.checkoutExpiresAtSec(now, anchor) * 1000;
  assert.equal(expires - now, stripeLib.CHECKOUT_MAX_LIFETIME_MS);
});

// ===========================================================================
// Checkout params — Stripe Tax gated behind STRIPE_TAX_ENABLED (owner has no VAT)
// ===========================================================================
//
// Captures the exact args handed to `checkout.sessions.create` via the F5-T1 test seam
// (__setStripeClientForTests), so the money-path shape is asserted with no network/key.
// Owner decision 2026-08-20: default OFF = no VAT; flip STRIPE_TAX_ENABLED=1 when VAT-
// registered. billing_address_collection stays "required" in BOTH states (invoice records).

function captureCheckoutClient() {
  const calls = [];
  return {
    calls,
    client: {
      checkout: {
        sessions: {
          create: async (params) => {
            calls.push(params);
            return { url: "https://checkout.stripe.test/cs_params" };
          },
        },
      },
    },
  };
}

const checkoutInput = () => ({
  profile: { agentId: AGENT },
  customerId: "cus_1",
  basePriceId: "price_base",
  usagePriceId: "price_usage",
  successUrl: "https://docka.me/agent/settings/billing?checkout=done",
  cancelUrl: "https://docka.me/agent/settings/billing?checkout=cancelled",
  nowMs: Date.parse("2026-08-15T12:00:00.000Z"),
});

test("checkout params: Stripe Tax OFF by default — automatic_tax + tax_id_collection false, address still required", async () => {
  delete process.env.STRIPE_TAX_ENABLED;
  const { client, calls } = captureCheckoutClient();
  stripeLib.__setStripeClientForTests(client);
  try {
    const url = await stripeLib.createCheckoutSessionForAgent(checkoutInput());
    assert.ok(url, "returns the hosted Checkout URL");
    assert.equal(calls.length, 1, "one checkout.sessions.create call");
    const p = calls[0];
    assert.equal(p.automatic_tax.enabled, false, "no VAT: automatic_tax OFF");
    assert.equal(p.tax_id_collection.enabled, false, "no VAT: VAT-id collection OFF");
    assert.equal(p.billing_address_collection, "required", "address stays required for invoice records");
    assert.equal(p.mode, "subscription", "still a subscription checkout");
    assert.ok(!("payment_method_types" in p), "dynamic methods: payment_method_types omitted so Stripe offers all dashboard-enabled, subscription-eligible methods");
    assert.deepEqual(p.customer_update, { name: "auto", address: "auto" }, "customer_update unchanged");
    assert.equal(p.subscription_data.proration_behavior, "create_prorations", "proration unchanged");
    assert.ok(Number.isFinite(p.subscription_data.billing_cycle_anchor), "anchor still set");
  } finally {
    stripeLib.__resetStripeClient();
  }
});

test("checkout params: STRIPE_TAX_ENABLED=1 turns Stripe Tax + VAT-id collection back ON", async () => {
  process.env.STRIPE_TAX_ENABLED = "1";
  const { client, calls } = captureCheckoutClient();
  stripeLib.__setStripeClientForTests(client);
  try {
    await stripeLib.createCheckoutSessionForAgent(checkoutInput());
    const p = calls[0];
    assert.equal(p.automatic_tax.enabled, true, "flag on: automatic_tax ON");
    assert.equal(p.tax_id_collection.enabled, true, "flag on: VAT-id collection ON");
    assert.equal(p.billing_address_collection, "required", "address required regardless");
  } finally {
    delete process.env.STRIPE_TAX_ENABLED;
    stripeLib.__resetStripeClient();
  }
});

test("R2-1/R3-2: the meter timestamp is clamped into [tallinnMonthEnd, periodEnd-60s]", async () => {
  const { tallinnMonthRange } = await import("@/lib/billing-usage");
  // WINTER month (Tallinn UTC+2): December 2026 closes at 2026-12-31T22:00Z.
  const dec = tallinnMonthRange("2026-12");
  const decPeriodEnd = Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1000);
  const winter = stripeLib.meterEventTimestampSec({
    nowMs: Date.parse("2026-12-31T22:20:00.000Z"),
    tallinnMonthEndMs: dec.endMs,
    currentPeriodEndSec: decPeriodEnd,
  });
  assert.equal(winter.ok, true);
  assert.ok(winter.timestamp * 1000 >= dec.endMs, "never before the Tallinn month closed");
  assert.ok(winter.timestamp <= decPeriodEnd - 60, "never inside the last minute of the Stripe period");

  // SUMMER month (Tallinn UTC+3): June 2026 closes at 2026-06-30T21:00Z.
  const jun = tallinnMonthRange("2026-06");
  const junPeriodEnd = Math.floor(Date.parse("2026-07-01T00:00:00.000Z") / 1000);
  const summer = stripeLib.meterEventTimestampSec({
    nowMs: Date.parse("2026-06-30T21:20:00.000Z"),
    tallinnMonthEndMs: jun.endMs,
    currentPeriodEndSec: junPeriodEnd,
  });
  assert.equal(summer.ok, true);
  assert.ok(summer.timestamp * 1000 >= jun.endMs);
  assert.ok(summer.timestamp <= junPeriodEnd - 60);

  // A push attempted AFTER the period closed is LATE -> manual reconciliation (R1-1).
  const late = stripeLib.meterEventTimestampSec({
    nowMs: Date.parse("2027-01-01T00:30:00.000Z"),
    tallinnMonthEndMs: dec.endMs,
    currentPeriodEndSec: decPeriodEnd,
  });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "late");

  // No known period end -> never guess.
  assert.equal(
    stripeLib.meterEventTimestampSec({ nowMs: Date.now(), tallinnMonthEndMs: dec.endMs, currentPeriodEndSec: null }).reason,
    "no-period"
  );
});

test("the usage idempotency key is stable per (agent, period)", () => {
  assert.equal(stripeLib.usageIdempotencyKey(AGENT, "2026-09"), "usage:agent:acme:2026-09");
});

test("degradation: with no STRIPE_SECRET_KEY every Stripe surface is inert", async () => {
  assert.equal(stripeLib.stripeConfigured(), false);
  assert.equal(await stripeLib.getStripe(), null);
  assert.equal(await stripeLib.ensureBillingObjects(), null);
  assert.equal(await stripeLib.createPortalSessionForAgent({ customerId: "cus_1", returnUrl: "/" }), null);
  assert.deepEqual(await stripeLib.fetchSubscription("sub_1"), { kind: "not-found" });
  assert.deepEqual(await stripeLib.listLiveSubscriptionsForCustomer("cus_1"), []);
  assert.deepEqual(await stripeLib.cancelSubscriptionNow("sub_1"), {
    ok: false,
    error: "billing not configured",
  });
  const push = await stripeLib.pushUsage({ agentId: AGENT, period: "2026-09", quantity: 1, stripeCustomerId: "cus_1", timestampSec: 1 });
  assert.equal(push.ok, false);
  assert.equal(push.error, "billing not configured");
});

// ===========================================================================
// F5 — the spec-mandated test that was missing (R3-3a)
// ===========================================================================

test("F5 R3-3a: createPortalSessionForAgent passes the EXPLICIT portal configuration id, never the account default", async () => {
  // The account-default portal configuration allows subscription CANCELLATION, which is
  // exactly the cancel-and-ride-free hole R2-5 closed by creating an explicit
  // configuration with `subscription_cancel: { enabled: false }`. Passing the id was
  // implemented but never ASSERTED — a refactor could silently drop the argument and
  // every other test would stay green.
  writeDb();
  await store.saveBillingSettings({
    stripeBaseProductId: "prod_base",
    stripeUsageProductId: "prod_usage",
    stripeMeterId: "mtr_1",
    stripePortalConfigId: "bpc_explicit_no_cancel",
  });

  const calls = [];
  stripeLib.__setStripeClientForTests({
    billingPortal: {
      sessions: {
        create: async (args) => {
          calls.push(args);
          return { url: "https://billing.stripe.test/session" };
        },
      },
    },
  });

  try {
    const url = await stripeLib.createPortalSessionForAgent({
      customerId: "cus_1",
      returnUrl: "https://docka.me/agent/settings/billing",
    });
    assert.equal(url, "https://billing.stripe.test/session");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customer, "cus_1");
    assert.equal(calls[0].return_url, "https://docka.me/agent/settings/billing");
    assert.equal(
      calls[0].configuration,
      "bpc_explicit_no_cancel",
      "ALWAYS the explicit configuration — the account default re-opens the R2-5 hole"
    );
  } finally {
    stripeLib.__resetStripeClient();
  }
});

// ===========================================================================
// R2 / N1 — the phase-3 recheck must recognise CONVERGENCE, not just conflict
// ===========================================================================
//
// The recheck compares the profile at phase-3 time against the phase-2 observation. It
// treated ANY difference as a lost race — including the case where the profile now holds
// THE VERY SUBSCRIPTION THIS EVENT IS ABOUT. `conflictWinner` was then `newSubId`, and
// the clean-up cancelled it: the agency's own just-paid subscription, killed while the
// profile went on mirroring it as active, with a "two checkouts completed concurrently"
// alert as the only trace.
//
// Both drivers below use the ADOPT path (a dead stored id), because that is the only
// path where phase 2 awaits Stripe — the window the race lives in. They differ in WHO
// the other writer is: a concurrent duplicate delivery of the same event, and the daily
// reconciler.

/** Another writer adopts `newSubId` while THIS event is inside its phase-2 fetch. */
function convergingDeps(newSubId) {
  const d = deps({
    fetchSubscription: async (id) => {
      if (id !== newSubId && !d.raced) {
        d.raced = true;
        await store.setBillingStripeRefs(AGENT, { stripeSubscriptionId: newSubId });
        return found(id, "canceled", { pm: false }); // the stored id really is dead
      }
      return found(id, "active");
    },
  });
  return d;
}

test("R2 N1 convergence: a concurrent duplicate delivery of the SAME completed event never cancels the agency's own subscription", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
  // The other copy of this event (both passed phase 1 through the crashed-claim
  // reprocess path) lands its phase 3 while we are still fetching the dead stored id.
  const d = convergingDeps("sub_paid");
  const ev = event("checkout.session.completed", {
    id: "cs_same", customer: "cus_1", subscription: "sub_paid", metadata: { agentId: AGENT },
  });
  const res = await handleStripeEvent(ev, d.d);

  assert.equal(res.body.conflict, false, "the SAME subscription is convergence, not a conflict");
  assert.deepEqual(d.cancelled, [], "the agency's just-paid subscription is NEVER cancelled");
  assert.deepEqual(d.alerts, [], "and no duplicate-subscription alert is raised");
  const p = profile();
  assert.equal(p.stripeSubscriptionId, "sub_paid", "the profile still mirrors it");
  assert.equal(p.subscriptionStatus, "active", "the idempotent adopt patch still lands");
  assert.equal(p.canceledAt, null);
  assert.equal(store.wasStripeEventProcessed(ev.id), true);

  // …and a later true replay stays a no-op.
  const replay = await handleStripeEvent(ev, deps().d);
  assert.equal(replay.body.replay, true);
  assert.equal(profile().stripeSubscriptionId, "sub_paid");
});

test("R2 N1 convergence: a reconciler adoption between phase 1 and phase 3 converges instead of cancelling", async () => {
  await seedProfile({ stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
  // R2-6/R3-4a: the daily sweep adopts the customer's live subscription off Stripe. If
  // it lands while this checkout event is mid-flight, both are talking about sub_new.
  const d = convergingDeps("sub_new");
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_reconciled", customer: "cus_1", subscription: "sub_new", metadata: { agentId: AGENT },
    }),
    d.d
  );

  assert.equal(res.body.conflict, false);
  assert.deepEqual(d.cancelled, [], "we must not cancel what the reconciler adopted FOR us");
  assert.deepEqual(d.alerts, []);
  assert.equal(profile().stripeSubscriptionId, "sub_new");
  assert.equal(profile().subscriptionStatus, "active");
});

test("R2 N1: a genuine two-tab conflict (a DIFFERENT winner) still cancels the loser", async () => {
  // The guard must not swallow the finding-14 case it sits next to.
  await seedProfile({ stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
  const loser = racingDeps("sub_winner");
  const res = await handleStripeEvent(
    event("checkout.session.completed", {
      id: "cs_still_conflict", customer: "cus_1", subscription: "sub_loser", metadata: { agentId: AGENT },
    }),
    loser.d
  );
  assert.equal(res.body.conflict, true);
  assert.deepEqual(loser.cancelled, ["sub_loser"], "a real loser is still cancelled");
  assert.equal(loser.alerts.length, 1);
  assert.equal(profile().stripeSubscriptionId, "sub_winner");
});
