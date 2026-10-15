// lib/billing-enforce.ts — the billing ENFORCEMENT tiers (STRIPE-BILLING-PLAN.md P5,
// owner decision 6, with R1-8, R1-9, R2-5 and R2-9 folded in).
//
// WHAT ENFORCEMENT IS: a paywall on the AGENCY's own dashboard. It is never a data
// change. No grant is revoked, nothing is deleted, and payment restores access
// instantly (the `invoice.paid` webhook flips the tier back with no restart).
//
// WHAT IS NEVER BLOCKED, at any tier:
//   * every seaman-side route and page — a seafarer's access to their own data is
//     never hostage to their agency's unpaid invoice (also a GDPR posture point);
//   * /share/[token], /portal/[token], /verify — possession-token surfaces;
//   * the billing surface itself (/agent/settings/billing, /api/billing/*), or a
//     blocked agency could never pay its way out;
//   * /api/auth/*, /api/admin/*, /api/stripe/webhook, /api/cron/*.
//
// FAIL-OPEN BY DESIGN before launch: `billingSettings.goLiveAt` null => every agent is
// `exempt`. Deploying this code before go-live changes nothing for any user.

import { readDB, type BillingProfile, type DB } from "@/lib/db";
import { isSampleAgentId } from "@/lib/billing-usage";

export type BillingTier = "exempt" | "ok" | "warning" | "readonly" | "blocked";

export type BillingState = {
  tier: BillingTier;
  /** Machine-readable cause, for the banner copy and for audit. */
  reason:
    | "not-launched"
    | "exempt-agent"
    | "sample-agent"
    | "impersonation"
    | "dev-login"
    | "no-profile"
    | "ok"
    | "past_due"
    | "no_payment_method"
    | "no_subscription"
    /**
     * D-E — enforcement ABSTAINED: computing the tier itself failed (a store write or
     * read threw). Paired with `tier: "exempt"`, because `ok` would claim a healthy
     * tier was computed and this is the honest "we do not know" value. Fail-open is the
     * doctrine of this whole module (see the header): a billing bug must never lock an
     * agency out of its own dashboard.
     */
    | "error";
  /**
   * The instant the escalation clock started (null when nothing is wrong).
   *
   * C8 — the `pastDueSince` MIRROR that used to sit beside this was redundant and
   * misleading: it is one of the inputs `since` is a `max` over, so the two disagreed
   * whenever any other signal was later. Readers want the clock, and the clock is
   * `since`; the raw Stripe stamp lives on the PROFILE where it belongs.
   */
  since: string | null;
};

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Decision 6 — banner immediately, read-only at 14 days, paywall at 30. */
export const READONLY_AFTER_MS = 14 * DAY_MS;
export const BLOCKED_AFTER_MS = 30 * DAY_MS;

export const EXEMPT_STATE: BillingState = {
  tier: "exempt",
  reason: "exempt-agent",
  since: null,
};

function state(
  tier: BillingTier,
  reason: BillingState["reason"],
  since: string | null = null
): BillingState {
  return { tier, reason, since };
}

function parseOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The tier for one agent, computed from live state. PURE apart from the `db` it is
 * handed, so the whole escalation ladder is unit-testable without a session.
 */
export function billingTierForAgent(
  db: DB,
  agentId: string,
  now: number = Date.now()
): BillingState {
  // Global off-switch: billing has not launched.
  if (!db.billingSettings?.goLiveAt) return state("exempt", "not-launched");
  // R1-7 — the demo class is structurally exempt.
  if (isSampleAgentId(agentId)) return state("exempt", "sample-agent");

  const profile = db.billingProfiles.find((p) => p.agentId === agentId) ?? null;
  // No profile row yet (it is created on the first resolved session). Fail OPEN — an
  // enforcement bug must never lock out an agency that has not even been onboarded.
  if (!profile) return state("exempt", "no-profile");
  if (profile.exemptFromBilling) return state("exempt", "exempt-agent");
  // Pre-go-live agent: never stamped with a clock, so never escalates.
  if (!profile.billingRequiredSince) return state("exempt", "not-launched");

  return tierFromProfile(profile, now);
}

/** The escalation ladder for a billing-required, non-exempt profile. */
export function tierFromProfile(profile: BillingProfile, now: number): BillingState {
  const pastDue = Boolean(profile.pastDueSince) || profile.subscriptionStatus === "past_due";
  const noPaymentMethod = !profile.paymentMethodAttached;
  // R2-5 — a cancelled (or never-started) subscription escalates exactly like a
  // missing payment method. This is what closes the cancel-and-ride-free hole.
  const noSubscription =
    profile.subscriptionStatus === "canceled" || profile.subscriptionStatus === "none";

  if (!pastDue && !noPaymentMethod && !noSubscription) {
    return state("ok", "ok", null);
  }

  const reason: BillingState["reason"] = pastDue
    ? "past_due"
    : noSubscription
      ? "no_subscription"
      : "no_payment_method";

  // The clock starts at the LATEST applicable signal, never before the agency was
  // required to bill at all:
  //   max(billingRequiredSince, billingActiveFrom, pastDueSince, canceledAt).
  //
  // D-H / FINDING 12 — `billingActiveFrom` is in the set. Un-comping an agency stamps it
  // (billing-store's exempt -> non-exempt transition) but leaves the months-old
  // `billingRequiredSince` alone, so a 45-day-comped agency used to be BLOCKED the
  // instant the comp ended, with zero grace and no banner. Including the stamp starts
  // the ladder at the un-comp instant instead. Safe for a paying agency: the candidates
  // are a `max`, and any real problem signal (pastDueSince / canceledAt) is necessarily
  // later than the checkout adoption that also stamps this field (R1-9's definition of
  // `billingRequiredSince` as the first-session onboarding fact is untouched).
  const candidates = [
    parseOrNull(profile.billingRequiredSince),
    parseOrNull(profile.billingActiveFrom),
    parseOrNull(profile.pastDueSince),
    parseOrNull(profile.canceledAt),
  ].filter((n): n is number => n !== null);
  const startMs = candidates.length > 0 ? Math.max(...candidates) : now;
  const sinceIso = new Date(startMs).toISOString();
  const age = now - startMs;

  if (age >= BLOCKED_AFTER_MS) return state("blocked", reason, sinceIso);
  if (age >= READONLY_AFTER_MS) return state("readonly", reason, sinceIso);
  return state("warning", reason, sinceIso);
}

/** Convenience wrapper that reads the store itself. */
export function billingStateForAgent(agentId: string, now: number = Date.now()): BillingState {
  return billingTierForAgent(readDB(), agentId, now);
}

// ---- Route guards (R1-8) ------------------------------------------------------

/** The minimal session shape a guard needs — avoids a cycle with lib/agent-session. */
export type BillingGuardSession = { billing?: BillingState } | null | undefined;

export type BillingGate =
  | { ok: true }
  | { ok: false; status: 402; body: Record<string, unknown>; response: Response };

// NOTE: the denial is built with the WEB `Response` global rather than
// `NextResponse.json`. App Router route handlers accept either (NextResponse extends
// Response), and avoiding the `next/server` import keeps this module loadable by the
// plain `node --test` runner — which is what makes the whole tier ladder unit-testable.
function deny(state: BillingState, mode: "read" | "write"): BillingGate {
  const body = {
    ok: false,
    error:
      mode === "read"
        ? "Your agency's docka subscription is not active. Open Billing to restore access."
        : "Your agency's docka subscription is not active. Changes are paused until billing is fixed.",
    billing: { tier: state.tier, reason: state.reason, since: state.since },
  };
  return {
    ok: false,
    status: 402,
    body,
    response: new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json" },
    }),
  };
}

/**
 * R1-8 — GET/HEAD guard. Only the `blocked` tier is denied reads; `readonly` still
 * serves data (it just refuses mutations). Fail-open on a session with no billing
 * field at all (an unauthenticated caller was already 401'd by the route).
 */
export function requireBillingReadable(session: BillingGuardSession): BillingGate {
  const s = session?.billing;
  if (!s) return { ok: true };
  if (s.tier === "blocked") return deny(s, "read");
  return { ok: true };
}

/** Mutating-verb guard. Implies readable: `blocked` and `readonly` both deny. */
export function requireBillingWritable(session: BillingGuardSession): BillingGate {
  const s = session?.billing;
  if (!s) return { ok: true };
  if (s.tier === "blocked" || s.tier === "readonly") return deny(s, "write");
  return { ok: true };
}

/** True when the banner should be shown above the agency's pages. */
export function shouldShowBillingBanner(state: BillingState | undefined): boolean {
  return state?.tier === "warning" || state?.tier === "readonly";
}
