// lib/billing-status.ts — the ONE Stripe-status liveness predicate (R2-7 / R3-5 / D-5).
//
// Hosted here, in a module that imports NOTHING from `@/lib/stripe` or `@/lib/billing-store`,
// so both of them can import it without a cycle:
//   * `stripe.ts` imports Stripe object accessors from `billing-store.ts`, so
//     `billing-store.ts` cannot import from `stripe.ts` (that would close a real cycle).
//   * `stripe.ts` RE-EXPORTS `mapStripeStatus`/`isLiveStripeStatus` from here, so the
//     webhook, the reconciler and the F2 test keep importing them from `@/lib/stripe`
//     with no import-line change.
//   * `billing-store.ts` imports `isLiveStripeStatus` from here directly.
//
// This was previously duplicated: `stripe.ts` owned `mapStripeStatus`/`isLiveStripeStatus`
// and `billing-store.ts` carried a THIRD hardcoded live-status set (`LIVE_STORED_STATUSES`),
// which agreed today but would drift the moment liveness semantics moved in one place
// (R3-5). Now there is exactly one table.

import type { BillingSubscriptionStatus } from "@/lib/db";

/**
 * The EXHAUSTIVE Stripe-status -> stored-status mapping. The webhook, the daily
 * reconciler and the store's go-live check all go through here, so they can never diverge.
 *
 *   active | trialing        -> active
 *   past_due | unpaid | paused -> past_due
 *   incomplete              -> incomplete
 *   incomplete_expired      -> none      (re-enables checkout; R3-1 clears the id)
 *   canceled                -> canceled  (+ canceledAt; the id is KEPT for audit)
 *
 * Idempotent on stored values: active->active, past_due->past_due, incomplete->incomplete,
 * canceled->canceled, none->none — so applying it to an already-mapped stored status is a
 * no-op, which is what lets the store call `isLiveStripeStatus(profile.subscriptionStatus)`.
 */
export function mapStripeStatus(raw: string | null | undefined): BillingSubscriptionStatus {
  switch ((raw ?? "").trim()) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "none";
    case "canceled":
      return "canceled";
    default:
      return "none";
  }
}

/** The mapped statuses that mean "this subscription is still alive" (R2-7 + D-B). */
export const LIVE_MAPPED_STATUSES: ReadonlySet<BillingSubscriptionStatus> = new Set([
  "active",
  "past_due",
  "incomplete",
]);

/**
 * A subscription is LIVE when its MAPPED status is one Stripe would still invoice on.
 *
 * FINDING 20 — this used to be a second, independent deny-list ("not canceled and not
 * incomplete_expired"), which disagreed with `mapStripeStatus` on every unknown or
 * future status: such a status was LIVE to the duplicate guard (so a customer's genuine
 * new subscription got cancelled) and "no subscription" to the tier logic. Deriving it
 * from the mapping leaves exactly ONE status table (R2-7): an unknown status now maps
 * to `none` => dead => the ADOPTION path, which is the safe direction for money.
 */
export function isLiveStripeStatus(raw: string | null | undefined): boolean {
  return LIVE_MAPPED_STATUSES.has(mapStripeStatus(raw));
}
