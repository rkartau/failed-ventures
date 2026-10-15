// Pure, I/O-free helpers for "is this agent's billing profile complete enough?".
//
// Two callers, ONE source of truth:
//   - the checkout route (POST /api/billing/checkout) composes `missingProfileFields`
//     with its own SEPARATE `!tosAcceptedAt` 400, preserving its two distinct 400s;
//   - agentSession() uses the merged `billingProfileIncomplete` to decide the
//     first-time onboarding redirect to /agent/settings/billing.
//
// The field list, order, and `.trim()`/empty semantics are the ones the checkout
// route has always enforced — moved here verbatim so the two paths can never diverge.

import type { BillingProfile } from "@/lib/db";

/** The business fields Stripe Tax / invoicing cannot do without. */
export function missingProfileFields(profile: BillingProfile): string[] {
  const missing: string[] = [];
  if (!profile.legalName.trim()) missing.push("legalName");
  if (!profile.regCode.trim()) missing.push("regCode");
  if (!profile.billingEmail.trim()) missing.push("billingEmail");
  if (!profile.address.line1.trim()) missing.push("address.line1");
  if (!profile.address.city.trim()) missing.push("address.city");
  if (!profile.address.postal.trim()) missing.push("address.postal");
  if (!profile.address.country.trim()) missing.push("address.country");
  return missing;
}

/**
 * True when the agency has NOT finished billing onboarding — i.e. it has no profile
 * yet, is missing any required business field, OR has not accepted the ToS.
 *
 * Null-safe (a missing profile counts as incomplete). Presence-not-version ToS check:
 * parity with the checkout route, which gates on `!tosAcceptedAt` and does NOT compare
 * `tosVersion` — an agency that accepted an older ToS version is still "complete".
 */
export function billingProfileIncomplete(profile: BillingProfile | null): boolean {
  if (profile == null) return true;
  if (missingProfileFields(profile).length > 0) return true;
  if (!profile.tosAcceptedAt) return true;
  return false;
}
