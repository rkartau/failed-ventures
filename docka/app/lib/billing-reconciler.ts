// lib/billing-reconciler.ts — the once-per-Tallinn-day self-healing sweep
// (R1-3, specified; R2-4 ordering participation; R2-6 orphan adoption; R3-4a
// canceled-with-stale-id adoption).
//
// WHY IT EXISTS: webhooks get lost. A pm2 restart during a deploy, a Stripe retry
// window that expires, a delivery that arrives out of order — any of these can leave
// the local mirror disagreeing with Stripe, and the enforcement tier is computed from
// the local mirror. This sweep re-reads the truth from Stripe once a day and heals:
//
//   * the stored subscription is LIVE      -> mirror status / payment method / past-due
//   * the stored subscription is DEAD/404  -> R3-4a: look for a live one on the
//                                             customer and ADOPT it (this is the rare
//                                             re-subscribe whose checkout.session.
//                                             completed was lost beyond Stripe's retries)
//   * no stored subscription, but a customer -> R2-6: adopt the single live subscription
//   * more than one live subscription       -> duplicateSubscription alert, never a
//                                             silent pick
//
// It is ~6-20 API calls a day. Every Stripe call happens OUTSIDE the db mutex, and the
// write goes through `applyReconciliation`, which re-checks the ordering fields so a
// webhook that landed mid-fetch is never clobbered (R2-4).

import { applyReconciliation, type SubscriptionStatusPatch } from "@/lib/billing-store";
import { recordBillingAlert } from "@/lib/billing-health";
import {
  applyMappedStatus,
  fetchSubscription,
  isLiveStripeStatus,
  listLiveSubscriptionsForCustomer,
  mapStripeStatus,
  type SubscriptionFetch,
  type SubscriptionView,
} from "@/lib/stripe";
import type { BillingProfile } from "@/lib/db";

export type ReconcilerDeps = {
  fetchSubscription: (id: string) => Promise<SubscriptionFetch>;
  listLiveSubscriptionsForCustomer: (customerId: string) => Promise<SubscriptionView[]>;
  alert: (kind: "duplicateSubscription" | "error", message: string, agentId: string) => void;
  now: () => number;
};

export const defaultReconcilerDeps: ReconcilerDeps = {
  fetchSubscription,
  listLiveSubscriptionsForCustomer,
  alert: (kind, message, agentId) => recordBillingAlert(kind, message, { agentId }),
  now: () => Date.now(),
};

export type ReconcileOutcome =
  | "skipped-no-customer"
  | "healthy"
  | "healed"
  | "adopted"
  | "adopted-orphan"
  | "duplicate"
  | "dead-no-replacement"
  | "superseded-by-webhook"
  /** D-B — Stripe could not be read. The profile is left ALONE and alerted, never
   *  mirrored as dead on the strength of a 429. */
  | "fetch-error";

export type ReconcileResult = {
  agentId: string;
  outcome: ReconcileOutcome;
  status?: string;
};

/**
 * Everything a live subscription tells us about the local mirror.
 *
 * FINDING 21 — a thin wrapper over `applyMappedStatus`, the ONE status-effect chain the
 * webhook also uses. This function used to carry its own private version of that chain,
 * and the two had already diverged in three places (no `none` branch here, a
 * `latestInvoiceStatus` rule only here, different paymentMethodAttached semantics).
 *
 * FINDING 11 — the `latestInvoiceStatus === "paid"` rule used to null `pastDueSince`
 * unconditionally, INCLUDING while the subscription itself still read `past_due` (an
 * agency with one paid invoice and one older unpaid one). The tier clock then fell back
 * to a months-old `billingRequiredSince` and BLOCKED the agency instantly, skipping the
 * entire 14/30-day ladder. Clearing the clock is now the `active` branch's job alone.
 */
function patchFromView(view: SubscriptionView, nowIso: string, profile: BillingProfile): SubscriptionStatusPatch {
  const mapped = mapStripeStatus(view.status);
  return applyMappedStatus(profile, mapped, {
    nowIso,
    subscriptionId: view.id,
    paymentMethodAttached: view.defaultPaymentMethodAttached,
  }) as SubscriptionStatusPatch;
}

/** R1-6 fallback: a profile with a live subscription but no stamp uses subscription.created. */
function activeFromFallback(profile: BillingProfile, view: SubscriptionView): string | undefined {
  if (profile.billingActiveFrom) return undefined;
  if (typeof view.created !== "number") return undefined;
  return new Date(view.created * 1000).toISOString();
}

export async function reconcileProfile(
  profile: BillingProfile,
  deps: ReconcilerDeps = defaultReconcilerDeps
): Promise<ReconcileResult> {
  if (!profile.stripeCustomerId) {
    return { agentId: profile.agentId, outcome: "skipped-no-customer" };
  }

  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  // The fetch timestamp is the ordering watermark (R2-4). Taken BEFORE the network
  // calls, so any webhook created after this point legitimately wins.
  const fetchAtSec = Math.floor(nowMs / 1000);

  // ---- Stripe reads (OUTSIDE any db critical section) ------------------------
  let fetched: SubscriptionFetch = { kind: "not-found" };
  if (profile.stripeSubscriptionId) {
    fetched = await deps.fetchSubscription(profile.stripeSubscriptionId);
  }
  if (fetched.kind === "error") {
    // D-B / FINDING 5 (reconciler side) — a transient failure is NOT "the subscription
    // is dead". Mirroring a healthy agency as cancelled on the strength of a 429 would
    // start the R2-5 cancel ladder against a paying customer.
    deps.alert(
      "error",
      `could not read subscription ${profile.stripeSubscriptionId} (${fetched.message}) — ` +
        `the profile was left untouched and will be retried on the next sweep`,
      profile.agentId
    );
    return { agentId: profile.agentId, outcome: "fetch-error" };
  }

  const view: SubscriptionView | null = fetched.kind === "found" ? fetched.view : null;
  const storedIsDead = !view || !isLiveStripeStatus(view.status);

  if (storedIsDead) {
    // R2-6 (no stored id) and R3-4a (stored id fetched dead / 404) share one path:
    // ask the CUSTOMER what live subscriptions it has.
    const live = await deps.listLiveSubscriptionsForCustomer(profile.stripeCustomerId);
    if (live.length > 1) {
      deps.alert(
        "duplicateSubscription",
        `customer ${profile.stripeCustomerId} has ${live.length} live subscriptions ` +
          `(${live.map((s) => s.id).join(", ")}) — resolve in the Stripe dashboard`,
        profile.agentId
      );
      return { agentId: profile.agentId, outcome: "duplicate" };
    }
    if (live.length === 1) {
      const adopted = live[0];
      const patch: SubscriptionStatusPatch = {
        ...patchFromView(adopted, nowIso, profile),
        stripeSubscriptionId: adopted.id,
        // Adoption always (re)stamps the clock: the gap before this subscription
        // existed is never retro-billed (R1-6).
        billingActiveFrom:
          typeof adopted.created === "number"
            ? new Date(adopted.created * 1000).toISOString()
            : profile.billingActiveFrom,
        canceledAt: null,
      };
      const res = await applyReconciliation(profile.agentId, fetchAtSec, patch, nowIso);
      return {
        agentId: profile.agentId,
        outcome: res.applied
          ? profile.stripeSubscriptionId
            ? "adopted"
            : "adopted-orphan"
          : "superseded-by-webhook",
        status: adopted.status,
      };
    }
    // Nothing live anywhere. Mirror whatever the stored subscription actually says
    // (or leave a customer that never subscribed alone).
    if (!view) return { agentId: profile.agentId, outcome: "dead-no-replacement" };
    const res = await applyReconciliation(
      profile.agentId,
      fetchAtSec,
      patchFromView(view, nowIso, profile),
      nowIso
    );
    return {
      agentId: profile.agentId,
      outcome: res.applied ? "healed" : "superseded-by-webhook",
      status: view.status,
    };
  }

  // ---- The stored subscription is LIVE: mirror it ----------------------------
  const patch = patchFromView(view as SubscriptionView, nowIso, profile);
  const fallback = activeFromFallback(profile, view as SubscriptionView);
  if (fallback) patch.billingActiveFrom = fallback;

  const alreadyCorrect =
    profile.subscriptionStatus === patch.subscriptionStatus &&
    profile.paymentMethodAttached === patch.paymentMethodAttached &&
    (patch.pastDueSince === undefined || profile.pastDueSince === patch.pastDueSince) &&
    !fallback;

  const res = await applyReconciliation(profile.agentId, fetchAtSec, patch, nowIso);
  return {
    agentId: profile.agentId,
    outcome: !res.applied ? "superseded-by-webhook" : alreadyCorrect ? "healthy" : "healed",
    status: (view as SubscriptionView).status,
  };
}

/** Reconcile every profile that has a Stripe customer. */
export async function reconcileAll(
  profiles: BillingProfile[],
  deps: ReconcilerDeps = defaultReconcilerDeps
): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  for (const profile of profiles) {
    if (!profile.stripeCustomerId) continue;
    try {
      out.push(await reconcileProfile(profile, deps));
    } catch (err) {
      deps.alert(
        "error",
        `reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        profile.agentId
      );
    }
  }
  return out;
}
