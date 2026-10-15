// lib/stripe-webhook.ts — the Stripe webhook STATE MACHINE, kept out of the route so
// it is unit-testable without ever standing up an HTTP server or calling Stripe
// (same rule as lib/registry-health.ts: the auth-gated route itself is never imported
// in tests). The route does exactly three things: read the RAW body, verify the
// signature, and hand the parsed event to `handleStripeEvent` below.
//
// R2-2 — THE PROTOCOL IS EXPLICITLY THREE-PHASE:
//   phase 1  ONE updateDB: dedupe check + claim. Skip iff a ledger row exists with
//            processedAt !== null. A row with processedAt === null is a CRASHED claim
//            and IS reprocessed.
//   phase 2  OUTSIDE the mutex: every Stripe API side effect (the R3-1 liveness fetch,
//            the R1-4 duplicate cancel). NEVER await a network call inside updateDB —
//            the serialize mutex is process-wide.
//   phase 3  ONE updateDB: all profile mutations AND `processedAt` together.
//
// A handler that throws returns HTTP 5xx so Stripe REDELIVERS (never swallowed into a
// 200), and because phase 3 never ran, `processedAt` is still null — the redelivery
// re-runs it and the state converges.
//
// ACCEPTED RACE (documented in the plan's "Accepted races", round-3 architect): two
// concurrent redeliveries can both pass phase 1 and both run phase 2. That is harmless
// because the phase-2 Stripe calls are idempotent (cancelling an already-cancelled
// subscription no-ops) and phase 3 is idempotent. Do NOT "fix" this by holding the
// mutex across phase 2 — that would put a network round-trip inside the process-wide
// lock, and do not "fix" it by skipping processedAt:null rows — that turns a crash
// into a permanently LOST event.

import {
  claimStripeEvent,
  finishStripeEvent,
  agentIdForStripeCustomer,
  agentIdForStripeSubscription,
  getBillingProfileForAgent,
} from "@/lib/billing-store";
import { recordBillingAlert } from "@/lib/billing-health";
import {
  applyMappedStatus,
  cancelSubscriptionNow,
  fetchSubscription,
  isLiveStripeStatus,
  mapStripeStatus,
  type SubscriptionFetch,
} from "@/lib/stripe";
import type { BillingProfile } from "@/lib/db";

/** The (small) slice of a Stripe event this module needs. Deliberately structural. */
export type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

/** Injectable Stripe reads/writes — faked in tests, real in the route. */
export type WebhookDeps = {
  fetchSubscription: (id: string) => Promise<SubscriptionFetch>;
  cancelSubscriptionNow: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  alert: (kind: "duplicateSubscription" | "error", message: string, agentId: string | null) => void;
  now: () => string;
};

export const defaultWebhookDeps: WebhookDeps = {
  fetchSubscription,
  cancelSubscriptionNow,
  alert: (kind, message, agentId) => recordBillingAlert(kind, message, { agentId }),
  now: () => new Date().toISOString(),
};

export type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

const INVOICE_FAMILY = /^invoice\./;
const SUBSCRIPTION_FAMILY = /^customer\.subscription\./;

function asString(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
    return (v as { id: string }).id;
  }
  return null;
}

/** Resolve the acting agent for an event object, in the order the ids are trustworthy. */
function resolveAgentId(obj: Record<string, unknown>): string | null {
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = typeof meta.agentId === "string" ? meta.agentId : null;
  if (fromMeta) return fromMeta;
  const subId = asString(obj.subscription) ?? (obj.object === "subscription" ? asString(obj.id) : null);
  if (subId) {
    const bySub = agentIdForStripeSubscription(subId);
    if (bySub) return bySub;
  }
  const customerId = asString(obj.customer);
  if (customerId) return agentIdForStripeCustomer(customerId);
  return null;
}

/**
 * R2-4 — the per-family ordering guard, evaluated INSIDE phase 3 against the profile as
 * it stands at write time (so a fresher webhook that landed mid-flight is never
 * overwritten). Returns null when the event is stale and must be dropped.
 */
function orderingPatch(
  profile: BillingProfile,
  eventType: string,
  eventCreated: number
): Partial<BillingProfile> | null {
  if (INVOICE_FAMILY.test(eventType)) {
    const seen = profile.lastInvoiceEventCreated;
    if (typeof seen === "number" && eventCreated < seen) return null;
    return { lastInvoiceEventCreated: eventCreated };
  }
  if (SUBSCRIPTION_FAMILY.test(eventType)) {
    const seen = profile.lastSubscriptionEventCreated;
    if (typeof seen === "number" && eventCreated < seen) return null;
    return { lastSubscriptionEventCreated: eventCreated };
  }
  return {};
}

/**
 * R1-2e, preserved under R2-4's per-family clocks. A `customer.subscription.*` event
 * that maps to `past_due` is a STALE VIEW when a NEWER invoice event has already
 * settled the payment state (typically `invoice.paid` arriving first, then a delayed
 * subscription.updated(past_due)). This guard is deliberately NARROW — it only ever
 * suppresses the past_due DOWNGRADE, so a delayed `invoice.payment_failed` (invoice
 * family) is never dropped, which is exactly what R2-4 protects.
 */
function isStalePastDueView(
  profile: BillingProfile,
  eventType: string,
  eventCreated: number,
  mapped: string
): boolean {
  if (!SUBSCRIPTION_FAMILY.test(eventType)) return false;
  if (mapped !== "past_due") return false;
  const lastInvoice = profile.lastInvoiceEventCreated;
  return typeof lastInvoice === "number" && lastInvoice > eventCreated && profile.pastDueSince === null;
}

// ---- The handler --------------------------------------------------------------

export async function handleStripeEvent(
  event: StripeEventLike,
  deps: WebhookDeps = defaultWebhookDeps
): Promise<WebhookResult> {
  // ---- Phase 1: claim (one critical section) ---------------------------------
  const claim = await claimStripeEvent(event.id, event.type, deps.now());
  if (!claim.process) {
    return { status: 200, body: { ok: true, replay: true, eventId: event.id } };
  }

  const obj = event.data?.object ?? {};
  const agentId = resolveAgentId(obj);

  // An event we cannot attribute is still ACKNOWLEDGED (Stripe must stop retrying a
  // permanently unattributable event) but it is recorded as processed with no effect.
  if (!agentId) {
    await finishStripeEvent(event.id, null, () => null, deps.now());
    return { status: 200, body: { ok: true, ignored: "no matching agent", eventId: event.id } };
  }

  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event, obj, agentId, deps);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoicePaid(event, agentId, deps);
    case "invoice.payment_failed":
      return handleInvoiceFailed(event, agentId, deps);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscriptionChanged(event, obj, agentId, deps);
    default:
      await finishStripeEvent(event.id, null, () => null, deps.now());
      return { status: 200, body: { ok: true, ignored: event.type, eventId: event.id } };
  }
}

/**
 * checkout.session.completed — establishes the billing relationship.
 *
 * R3-1 (liveness-checked duplicate guard): the R1-4 duplicate cancel fires ONLY when
 * the STORED subscription id is DIFFERENT from the new one AND still refers to a LIVE
 * subscription. If the stored one is dead (canceled / incomplete_expired) or the fetch
 * 404s, we ADOPT the new subscription instead — that is the re-subscribe-after-cancel
 * path, and cancelling there would be a real-money bug.
 */
async function handleCheckoutCompleted(
  event: StripeEventLike,
  obj: Record<string, unknown>,
  agentId: string,
  deps: WebhookDeps
): Promise<WebhookResult> {
  const nowIso = deps.now();
  const customerId = asString(obj.customer);
  const newSubId = asString(obj.subscription);
  const stored = getBillingProfileForAgent(agentId);
  // The phase-2 OBSERVATION. Phase 3 re-checks the profile against it (finding 14).
  const storedSubId = stored?.stripeSubscriptionId ?? null;

  let duplicate = false;
  // ---- Phase 2: Stripe side effects, OUTSIDE the mutex ------------------------
  if (newSubId && storedSubId && storedSubId !== newSubId) {
    const fetched = await deps.fetchSubscription(storedSubId);
    if (fetched.kind === "error") {
      // FINDING 5 — a 429/5xx/network blip is NOT evidence that the stored
      // subscription is dead. Adopting on a blip orphans a still-live subscription
      // that keeps invoicing, with nothing to detect it. Throw => HTTP 5xx => Stripe
      // redelivers, and `processedAt` is still null so the replay reprocesses.
      throw new Error(
        `checkout.session.completed: could not read the stored subscription ${storedSubId} ` +
          `(${fetched.message}) — refusing to guess whether it is live`
      );
    }
    if (fetched.kind === "found" && isLiveStripeStatus(fetched.view.status)) {
      // The agency already has a LIVE subscription — the new one is a duplicate.
      duplicate = true;
      const cancelled = await deps.cancelSubscriptionNow(newSubId);
      if (!cancelled.ok) {
        // FINDING 4 — the failure used to be swallowed: processedAt was stamped and
        // the alert claimed the duplicate had been cancelled, so the agency paid two
        // base fees forever and the reconciler saw nothing wrong (the STORED id is
        // live). Throwing leaves the event unprocessed for Stripe to redeliver; the
        // phase-2 calls are idempotent, so the replay converges (R2-2 accepted races).
        throw new Error(
          `checkout.session.completed: failed to cancel the duplicate subscription ` +
            `${newSubId} (${cancelled.error}) — leaving the event unprocessed for redelivery`
        );
      }
      deps.alert(
        "duplicateSubscription",
        `checkout.session.completed created a second subscription ${newSubId} while ${storedSubId} is live (${fetched.view.status}); the new one was cancelled`,
        agentId
      );
    }
    // else: the stored subscription is genuinely NOT-FOUND or DEAD -> fall through and
    // ADOPT newSubId (R3-1).
  }

  // ---- Phase 3: one mutation + processedAt ------------------------------------
  // FINDING 14 — two DIFFERENT completed events (two tabs) that both observed no
  // stored subscription used to be last-writer-wins: two live subscriptions, and the
  // reconciler never alerted because the stored id was itself live. The mutator now
  // adopts ONLY if the profile still holds exactly what phase 2 observed; the loser
  // records a conflict and cleans up its OWN subscription afterwards. No network
  // enters the mutex, and exactly one writer wins.
  let conflictWinner: string | null = null;
  let conflicted = false;
  await finishStripeEvent(
    event.id,
    agentId,
    (profile) => {
      if (!profile) return null;
      if (duplicate) {
        // Nothing about the agency changed; the duplicate was cancelled in phase 2.
        return {};
      }
      const currentSubId = profile.stripeSubscriptionId ?? null;
      // N1 CONVERGENCE GUARD — the profile ALREADY holds the subscription this very
      // event is about. That is not a conflict, it is this event having already been
      // applied: a concurrent duplicate delivery of the same event id (both pass phase 1
      // through the crashed-claim reprocess path), or the reconciler adopting between
      // our phase 1 and phase 3. Without this check the recheck below fired with
      // `conflictWinner === newSubId`, and the clean-up then CANCELLED the agency's own
      // just-paid subscription while the profile went on mirroring it as active — a
      // brand-new way to lose a paying customer. Falling through is safe because the
      // adopt patch is idempotent.
      if (newSubId && currentSubId === newSubId) {
        // converged — apply the (idempotent) adopt patch below.
      } else if (currentSubId !== storedSubId) {
        conflicted = true;
        conflictWinner = currentSubId;
        return {}; // another writer got there first — leave the profile alone.
      }
      const patch: Partial<BillingProfile> = {
        subscriptionStatus: "active",
        paymentMethodAttached: true,
        pastDueSince: null,
        canceledAt: null,
      };
      if (customerId) patch.stripeCustomerId = customerId;
      if (newSubId) patch.stripeSubscriptionId = newSubId;
      // R1-6 — the billing relationship starts here; re-stamped on adoption after a
      // cancel so the comped/unsubscribed gap is never retro-billed.
      if (newSubId && newSubId !== profile.stripeSubscriptionId) patch.billingActiveFrom = nowIso;
      else if (!profile.billingActiveFrom) patch.billingActiveFrom = nowIso;
      return patch;
    },
    nowIso
  );

  // ---- Conflict clean-up, AFTER processedAt (FR1-6) ---------------------------
  // A throw here would be useless: `processedAt` is stamped, so a redelivery answers
  // `replayOfProcessed` and 200s. The loser therefore cancels ITS OWN subscription and,
  // if even that fails, leaves a manual-review alert naming the money consequence.
  // N1 belt and braces: never cancel `newSubId` when it IS the profile's current
  // subscription. The mutator above already rules that out, but this clean-up is the
  // one place in the codebase that cancels a subscription the agency has just paid for,
  // so it re-checks the store rather than trusting a flag computed inside a mutator.
  const settledSubId = getBillingProfileForAgent(agentId)?.stripeSubscriptionId ?? null;
  if (conflicted && newSubId && settledSubId !== newSubId) {
    const winner: string | null = conflictWinner;
    const winnerFetch: SubscriptionFetch = winner
      ? await deps.fetchSubscription(winner)
      : { kind: "not-found" };
    if (winnerFetch.kind === "found" && isLiveStripeStatus(winnerFetch.view.status)) {
      const cancelled = await deps.cancelSubscriptionNow(newSubId);
      deps.alert(
        "duplicateSubscription",
        cancelled.ok
          ? `two checkouts completed concurrently for this agency; ${winner} won and our ` +
              `subscription ${newSubId} was cancelled`
          : `two checkouts completed concurrently for this agency; ${winner} won but ` +
              `cancelling ${newSubId} FAILED (${cancelled.error}) — it KEEPS INVOICING ` +
              `until it is cancelled in the Stripe dashboard`,
        agentId
      );
    } else {
      deps.alert(
        "duplicateSubscription",
        `two checkouts completed concurrently for this agency; the stored subscription ` +
          `${winner ?? "(none)"} is not live and ${newSubId} was NOT adopted — resolve manually ` +
          `in the Stripe dashboard before either one invoices`,
        agentId
      );
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      eventId: event.id,
      agentId,
      duplicate,
      conflict: conflicted,
      subscriptionId: newSubId,
    },
  };
}

/** invoice.paid — clears the past-due clock and re-activates. */
/**
 * C3 — the finish + per-family ordering + `dropped` scaffold, written ONCE (it was
 * triplicated across the three handlers below).
 *
 * `buildPatch` runs INSIDE the phase-3 critical section against the profile as it
 * stands at write time, and must stay pure/sync (the standing R2-2 rule). Returning
 * `null` means "seen but deliberately not applied" — the ordering stamp still lands.
 */
async function applyOrdered(
  event: StripeEventLike,
  agentId: string,
  deps: WebhookDeps,
  buildPatch: (profile: BillingProfile, nowIso: string) => Partial<BillingProfile> | null
): Promise<{ dropped: boolean }> {
  const nowIso = deps.now();
  let dropped = false;
  await finishStripeEvent(
    event.id,
    agentId,
    (profile) => {
      if (!profile) return null;
      const ordering = orderingPatch(profile, event.type, event.created);
      if (!ordering) {
        dropped = true;
        return {};
      }
      const patch = buildPatch(profile, nowIso);
      if (patch === null) {
        dropped = true;
        return ordering; // record that we saw it; do not apply it.
      }
      return { ...ordering, ...patch };
    },
    nowIso
  );
  return { dropped };
}

/** The statuses `invoice.paid` may lift back to `active` (finding 10). */
const REVIVABLE_STATUSES = new Set(["active", "past_due", "incomplete"]);

async function handleInvoicePaid(
  event: StripeEventLike,
  agentId: string,
  deps: WebhookDeps
): Promise<WebhookResult> {
  const { dropped } = await applyOrdered(event, agentId, deps, (profile) => {
    // FINDING 10 — this used to set "active" UNCONDITIONALLY. A final prorated invoice
    // paid AFTER customer.subscription.deleted then flipped canceled -> active, lifting
    // the paywall and resuming metering on a subscription Stripe had already ended,
    // until the daily sweep happened to notice. FR1-6: the status gate reads the profile
    // INSIDE the phase-3 mutator, so it can never act on a stale phase-2 snapshot.
    if (!REVIVABLE_STATUSES.has(profile.subscriptionStatus)) {
      // The invoice really was paid, so the past-due clock is honestly cleared — but a
      // dead subscription stays dead and the R2-5 cancel ladder keeps running.
      return { pastDueSince: null };
    }
    return { subscriptionStatus: "active", pastDueSince: null };
  });
  return { status: 200, body: { ok: true, eventId: event.id, agentId, dropped } };
}

/** invoice.payment_failed — starts the past-due clock (never restarts a running one). */
async function handleInvoiceFailed(
  event: StripeEventLike,
  agentId: string,
  deps: WebhookDeps
): Promise<WebhookResult> {
  const { dropped } = await applyOrdered(event, agentId, deps, (profile, nowIso) => ({
    subscriptionStatus: "past_due",
    // Only SET when null — the escalation clock runs from the FIRST failure.
    pastDueSince: profile.pastDueSince ?? nowIso,
  }));
  return { status: 200, body: { ok: true, eventId: event.id, agentId, dropped } };
}

/** customer.subscription.created/updated/deleted — the R2-7 status mirror. */
async function handleSubscriptionChanged(
  event: StripeEventLike,
  obj: Record<string, unknown>,
  agentId: string,
  deps: WebhookDeps
): Promise<WebhookResult> {
  const rawStatus = event.type === "customer.subscription.deleted" ? "canceled" : String(obj.status ?? "");
  const mapped = mapStripeStatus(rawStatus);
  const subId = asString(obj.id);

  const { dropped } = await applyOrdered(event, agentId, deps, (profile, nowIso) => {
    if (isStalePastDueView(profile, event.type, event.created, mapped)) return null;
    // FINDING 21 — ONE status-effect chain, shared verbatim with the daily reconciler.
    return applyMappedStatus(profile, mapped, {
      nowIso,
      subscriptionId: subId,
      // Only pass the flag when Stripe actually sent it on this payload.
      ...(obj.default_payment_method !== undefined
        ? { paymentMethodAttached: Boolean(obj.default_payment_method) }
        : {}),
    });
  });

  return { status: 200, body: { ok: true, eventId: event.id, agentId, status: mapped, dropped } };
}
