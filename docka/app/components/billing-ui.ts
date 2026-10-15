// components/billing-ui.ts — the small shared pieces every billing surface needs
// (fix-plan C7). Not a component: pure helpers, so a server page, a client component
// and the admin roster can all use them.
//
// EXTRACTED BECAUSE THEY HAD ALREADY DRIFTED. `TIER_STYLE` existed twice and the two
// copies disagreed on the `exempt` swatch (text-slate-500 vs text-slate-600); the MRR
// formula existed twice with different null handling; the en-GB date formatter had been
// re-typed in three more places; and the reason copy lived once as a `headline()`
// function (banner) and once as an inline nested ternary (paywall), so a wording change
// could land on one surface and not the other.

import type { BillingState } from "@/lib/billing-enforce";
import type { BillingProfile, BillingSubscriptionStatus, BillingUsageRow } from "@/lib/db";

/** ONE tier swatch, so the roster and the drill-down can never disagree again. */
export const TIER_STYLE: Record<string, string> = {
  exempt: "bg-slate-100 text-slate-500",
  ok: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-900",
  readonly: "bg-orange-100 text-orange-900",
  blocked: "bg-rose-100 text-rose-900",
};

export const TIER_STYLE_FALLBACK = "bg-slate-100 text-slate-600";

export function tierStyle(tier: string | null | undefined): string {
  return TIER_STYLE[tier ?? ""] ?? TIER_STYLE_FALLBACK;
}

/** The house date format. `dash` is what an absent/unparseable value renders as. */
export function fmtBillingDate(iso: string | null | undefined, dash = "—"): string {
  if (!iso) return dash;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dash;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ---- Money + the public pricing model ----------------------------------------
//
// `eur` was a PRIVATE copy inside the "use client" BillingSettings component; extracted
// here (this module's stated purpose) so the agency billing card and the public /pricing
// page format a rate the SAME way and can never drift. Byte-identical to the old private
// one: "300 EUR", "2 EUR", thousands-grouped, up to 2 dp.

/** The house money format: `1,234 EUR` (en-GB grouping, up to 2 dp). */
export function eur(n: number): string {
  return `${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })} EUR`;
}

// Canonical default rates — the same values as EMPTY_BILLING_SETTINGS.defaults in
// lib/db.ts. Kept as literals here (NOT imported from db.ts) on purpose: billing-ui.ts is
// pulled into the "use client" BillingSettings bundle, and importing a VALUE from the
// server-only db.ts would drag its fs/node graph into the client. Types from db.ts stay
// `import type` (erased); this module never becomes server-only.
const DEFAULT_BASE_EUR_MONTHLY = 300;
const DEFAULT_PER_SEAFARER_EUR = 2;

export type PricingModel = {
  /** The base rate, EUR/month. */
  base: number;
  /** The metered rate, EUR per billable seafarer / month. */
  perSeafarer: number;
  /** Formatted base line, e.g. "300 EUR / month". */
  baseLine: string;
  /** Formatted metered line, e.g. "2 EUR per billable seafarer". */
  perSeafarerLine: string;
};

/**
 * The formatted price lines for the public /pricing page, derived from the billing
 * settings defaults. TOLERATES a missing/partial `defaults` object (R1-2): any absent
 * field falls back to the canonical 300/2 and it NEVER throws — so a legacy or
 * hand-edited db.json whose `billingSettings` lacks `defaults` can never 500 a public,
 * crawler-hit page. Contains no share-token symbol (R1-5); pure and non-JSX so the unit
 * test can call it directly.
 */
export function pricingModel(
  defaults?: { baseEurMonthly?: number; perSeafarerEur?: number } | null
): PricingModel {
  const base =
    typeof defaults?.baseEurMonthly === "number" ? defaults.baseEurMonthly : DEFAULT_BASE_EUR_MONTHLY;
  const perSeafarer =
    typeof defaults?.perSeafarerEur === "number" ? defaults.perSeafarerEur : DEFAULT_PER_SEAFARER_EUR;
  return {
    base,
    perSeafarer,
    baseLine: `${eur(base)} / month`,
    perSeafarerLine: `${eur(perSeafarer)} per billable seafarer`,
  };
}

/**
 * The admin roster's monthly-recurring figure: base + (last computed quantity x rate).
 * "-ish" by construction — it is last month's usage against this month's rates, which is
 * exactly what the admin wants at a glance. Null when there is no profile at all.
 */
export function monthlyRecurringEur(
  profile: Pick<BillingProfile, "baseEurMonthly" | "perSeafarerEur"> | null | undefined,
  lastQuantity: number | null | undefined
): number | null {
  if (!profile) return null;
  return profile.baseEurMonthly + (lastQuantity ?? 0) * profile.perSeafarerEur;
}

/** The one-line cause, shared by the banner and the paywall. */
export function billingReasonCopy(state: Pick<BillingState, "reason">): string {
  if (state.reason === "past_due") return "A payment for your docka subscription failed.";
  if (state.reason === "no_subscription") return "Your docka subscription is not active.";
  return "Your agency has no payment method on file.";
}

/** Whole days since the escalation clock started, or null when it has not. */
export function daysSinceBillingClock(since: string | null | undefined, nowMs = Date.now()): number | null {
  if (!since) return null;
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / (24 * 60 * 60 * 1000)));
}

// ---- R3-7 (D-7) — the "Reported to Stripe" cell ------------------------------
//
// EXTRACTED as a PURE helper (R3-FR1-1): the agent "Recent months" table and the admin
// drill-down both need to distinguish a month the cron has not reached (—) from a month
// that was CLOSED as never-billed / no-usage. Rendering only `pushedToStripeAt` showed
// every closed month as "—". This returns the cell TEXT (agent-friendly copy), so it is
// unit-testable without invoking the "use client" BillingSettings component (which has
// hooks and cannot be called as a function in a test).

export type ReportedCell = { text: string; subtext?: string | null };

/**
 * The agent-facing "Reported to Stripe" cell for one usage row. Order (D-7):
 *   pushedToStripeAt  -> the push date;
 *   pushAttemptedAt   -> "processing" (claimed, not yet confirmed);
 *   closedAs "never-billed" -> "not billed" (+ closedReason subtext);
 *   closedAs "no-usage"     -> "no billable seafarers";
 *   otherwise               -> "—" (the cron has not reached it yet).
 * `fmtDate` lets the caller keep the surrounding table's date format.
 */
export function reportedCell(
  row: Pick<BillingUsageRow, "pushedToStripeAt" | "pushAttemptedAt" | "closedAs" | "closedReason">,
  fmtDate: (iso: string | null | undefined) => string = (iso) => fmtBillingDate(iso)
): ReportedCell {
  if (row.pushedToStripeAt) return { text: fmtDate(row.pushedToStripeAt) };
  if (row.pushAttemptedAt) return { text: "processing" };
  if (row.closedAs === "never-billed") return { text: "not billed", subtext: row.closedReason ?? null };
  if (row.closedAs === "no-usage") return { text: "no billable seafarers" };
  return { text: "—" };
}

// ---- R3-6 (D-6) — the checkout-return banner ---------------------------------
//
// EXTRACTED as a PURE helper (R3-FR1-1): a just-paid agent returning from Stripe's hosted
// Checkout with `?checkout=done` saw the stale store status ("Not set up") until the async
// webhook landed. The server page consumes this and renders the text; it emits a single
// self-terminating `<meta refresh>` ONLY when `.refresh` is true (done AND not-yet-live),
// so once the webhook flips the status live the next render drops the tag — bounded, never
// a client polling loop.

export type CheckoutBanner = { text: string; refresh: boolean } | null;

export function deriveCheckoutBanner(
  status: BillingSubscriptionStatus | string | null | undefined,
  checkoutReturn: "done" | "cancelled" | null | undefined
): CheckoutBanner {
  if (checkoutReturn === "cancelled") {
    return { text: "Payment setup was cancelled.", refresh: false };
  }
  if (checkoutReturn === "done") {
    // Live already (the webhook beat the redirect): confirm, no refresh.
    if (status === "active" || status === "past_due") {
      return { text: "Your payment is set up.", refresh: false };
    }
    // Not yet live: show a pending notice and a single self-terminating refresh.
    return { text: "Confirming your payment with Stripe…", refresh: true };
  }
  return null;
}

// ---- Owner request — the post-checkout THANK-YOU confirmation view ------------
//
// Same PURE-helper discipline as deriveCheckoutBanner (R3-FR1-1): the just-paid agent
// returning from Stripe's hosted Checkout deserves a real thank-you page, not a thin
// banner. deriveCheckoutView returns a small DESCRIPTOR the "use client" BillingSettings
// renders data-driven — so the four states are unit-tested here without invoking the
// hook-bearing component.
//
// The server page still emits its single self-terminating <meta refresh> ONLY while
// `.showRefresh` is true (the "confirming" sub-state: done AND not-yet-live), so the
// "bounded, no client polling loop" property is preserved: once the webhook flips the
// status live the descriptor becomes "confirmed" and the tag disappears.

export type CheckoutViewKind = "confirmed" | "confirming" | "cancelled" | "none";

export type CheckoutView = {
  kind: CheckoutViewKind;
  /** The card's real <h2> heading. */
  heading: string;
  /** The one-line supporting copy under the heading. */
  body: string;
  /** Emit the self-terminating <meta refresh> — true ONLY in the "confirming" state. */
  showRefresh: boolean;
  /** Show the "Manage billing & invoices" (portal) action — "confirmed" only. */
  showManage: boolean;
  /** Show the "Try again" (set-up-payment) affordance — "cancelled" only. */
  showRetry: boolean;
};

export function deriveCheckoutView(
  status: BillingSubscriptionStatus | string | null | undefined,
  checkoutReturn: "done" | "cancelled" | null | undefined
): CheckoutView {
  if (checkoutReturn === "cancelled") {
    return {
      kind: "cancelled",
      heading: "Payment setup wasn’t completed",
      body: "No payment method was saved and nothing has been charged. You can set up your subscription whenever you’re ready.",
      showRefresh: false,
      showManage: false,
      showRetry: true,
    };
  }
  if (checkoutReturn === "done") {
    // Live already (the webhook beat the redirect, or a later render caught up): the full
    // thank-you card. Confirmed, no refresh, offer the portal.
    if (status === "active" || status === "past_due") {
      return {
        kind: "confirmed",
        heading: "🎉 Thank you — your subscription is set up",
        body: "Your payment method is saved with Stripe and your docka subscription is active.",
        showRefresh: false,
        showManage: true,
        showRetry: false,
      };
    }
    // Not yet live: thank them, and let the single self-terminating refresh upgrade the
    // card to "confirmed" automatically once the webhook / reconciler flips the status.
    return {
      kind: "confirming",
      heading: "Thank you! We’re confirming your payment with Stripe…",
      body: "This usually only takes a few seconds. This page updates automatically as soon as your subscription is confirmed.",
      showRefresh: true,
      showManage: false,
      showRetry: false,
    };
  }
  return { kind: "none", heading: "", body: "", showRefresh: false, showManage: false, showRetry: false };
}
