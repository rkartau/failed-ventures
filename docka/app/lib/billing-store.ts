// SERVER-side persistence for Stripe billing state (STRIPE-BILLING-PLAN.md P1).
//
// Shaped exactly like lib/required-docs-store.ts: EVERY function is partitioned by
// `agentId`, which is what makes the tenant-isolation static guard able to whitelist
// them (tests/isolation-static.mjs GUARD_SYMBOLS). An agent can only ever reach its
// OWN profile and usage, and the agentId always comes from the SESSION — never from a
// request body.
//
// STANDING RULE (R2-2), enforced by convention throughout this module and its callers:
// NEVER await a Stripe (or any other network) call inside `updateDB`/`transact`. The
// serialize mutex is process-wide, so a slow HTTP call inside it stalls every other
// writer. Stripe side effects always happen BETWEEN critical sections.

import {
  readDB,
  updateDB,
  id,
  readBoardEvents,
  readConsentEvents,
  EMPTY_BILLING_SETTINGS,
  type DB,
  type BillingProfile,
  type BillingSettings,
  type BillingSubscriptionStatus,
  type BillingUsageRow,
} from "@/lib/db";
import {
  computeMonthlyUsage,
  computeMonthlyUsageWithWarnings,
  isSampleAgentId,
  type AgentUsage,
  type UsageInputs,
} from "@/lib/billing-usage";
// R3-5 / D-5 — the ONE liveness predicate, hosted in a cycle-free module (billing-status
// imports nothing from stripe/store). Replaces the third hardcoded LIVE_STORED_STATUSES set.
import { isLiveStripeStatus } from "@/lib/billing-status";
import { readMergeArchive } from "@/lib/delete-archive";
import { readableSeafarerIds } from "@/lib/access";

// ---- Settings singleton -------------------------------------------------------

/** The billing settings singleton (never null — a legacy db.json reads as defaults). */
export function getBillingSettings(): BillingSettings {
  return readDB().billingSettings ?? { ...EMPTY_BILLING_SETTINGS };
}

/** Patch the settings singleton. Used by go-live and by ensureBillingObjects(). */
export function saveBillingSettings(patch: Partial<BillingSettings>): Promise<BillingSettings> {
  return updateDB((db) => {
    db.billingSettings = {
      ...EMPTY_BILLING_SETTINGS,
      ...(db.billingSettings ?? {}),
      ...patch,
      defaults: {
        ...EMPTY_BILLING_SETTINGS.defaults,
        ...(db.billingSettings?.defaults ?? {}),
        ...(patch.defaults ?? {}),
      },
    };
    return db.billingSettings;
  });
}

// C4 — `isBillingLive()` was deleted here: it had exactly one consumer, its own unit
// test. The real off-switch is read in `billingTierForAgent` (goLiveAt null => exempt),
// and a second spelling of it invites a second, divergent notion of "live".

// ---- Profiles -----------------------------------------------------------------

export function defaultBillingProfile(
  agentId: string,
  nowIso: string,
  settings: BillingSettings
): BillingProfile {
  const sample = isSampleAgentId(agentId);
  return {
    agentId,
    legalName: "",
    regCode: "",
    vatNumber: null,
    billingEmail: "",
    address: { line1: "", city: "", postal: "", country: "" },
    tosAcceptedAt: null,
    tosVersion: null,
    baseEurMonthly: settings.defaults.baseEurMonthly,
    perSeafarerEur: settings.defaults.perSeafarerEur,
    // R1-7 — demo-class tenants are structurally exempt and never get a clock.
    exemptFromBilling: sample,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeBasePriceId: null,
    stripeUsagePriceId: null,
    subscriptionStatus: "none",
    paymentMethodAttached: false,
    pastDueSince: null,
    canceledAt: null,
    billingRequiredSince: null,
    billingActiveFrom: null,
    lastInvoiceEventCreated: null,
    lastSubscriptionEventCreated: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** This agent's stored profile, or null when it has never been created. PURE READ. */
export function getBillingProfileForAgent(agentId: string): BillingProfile | null {
  return readDB().billingProfiles.find((p) => p.agentId === agentId) ?? null;
}

/**
 * Human-facing agency name for outbound copy (e.g. the claim-invite email). Prefers the
 * billing profile's trimmed `legalName` (the real registered entity), falling back to the
 * signup handle `orgName`, then a neutral generic — the same precedence lib/admin-funnel
 * uses for its agency display column. `orgName` is passed in by the caller (the Agent row
 * it already has), so this performs at most ONE profile read.
 */
export function agencyDisplayName(agentId: string, orgName?: string | null): string {
  const legal = getBillingProfileForAgent(agentId)?.legalName?.trim();
  if (legal) return legal;
  const handle = (orgName ?? "").trim();
  if (handle) return handle;
  return "your crewing agency";
}

/**
 * R2-8 — create-if-absent, ATOMIC and write-once.
 *
 * The existence check and the insert happen inside ONE `updateDB` mutator, so N
 * parallel first-session resolutions produce exactly one row with one
 * `billingRequiredSince`. The fast path is a PURE READ: a steady-state
 * `agentSession()` on an agent that already has a profile performs ZERO writes, so
 * db.json does not churn on every authenticated request.
 *
 * `billingRequiredSince` (R1-9) is stamped at creation for a post-go-live, non-exempt,
 * non-demo agent — that is the instant the escalation clock starts.
 */
export function ensureBillingProfileForAgent(
  agentId: string,
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile> {
  const existing = getBillingProfileForAgent(agentId);
  if (existing) {
    // D-D SELF-HEAL (finding 2, belt and braces). The anomalous state: billing has gone
    // live, this profile is NOT exempt, and it still has no clock — i.e. it was created
    // by a sign-in BEFORE go-live and the go-live sweep did not reach it. Such a profile
    // read as `exempt/"not-launched"` FOREVER: a permanent free rider that no code path
    // ever re-stamped. One write fixes it, and only in that state, so R2-8's pure-read
    // steady state and R1-9's meaning of the stamp ("the first resolved session while
    // billing was required") both survive.
    if (!getBillingSettings().goLiveAt || !needsBillingStampHeal(existing)) {
      return Promise.resolve(existing);
    }
    return updateDB((db) => {
      const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
      if (idx < 0) return existing;
      const current = db.billingProfiles[idx];
      if (!db.billingSettings?.goLiveAt || !needsBillingStampHeal(current)) return current;
      db.billingProfiles[idx] = {
        ...current,
        billingRequiredSince: nowIso,
        updatedAt: nowIso,
      };
      return db.billingProfiles[idx];
    });
  }
  return updateDB((db) => {
    const found = db.billingProfiles.find((p) => p.agentId === agentId);
    if (found) return found; // lost the race — the winner's row is authoritative.
    const settings = db.billingSettings ?? { ...EMPTY_BILLING_SETTINGS };
    const profile = defaultBillingProfile(agentId, nowIso, settings);
    if (settings.goLiveAt && !profile.exemptFromBilling) {
      profile.billingRequiredSince = nowIso;
    }
    db.billingProfiles.push(profile);
    return profile;
  });
}

/**
 * FINDING 22 — "does resolving this session need a WRITE at all?", answered from a
 * snapshot the caller already holds. `agentSession()` used to call
 * `ensureBillingProfileForAgent` (two full db.json parses) and then
 * `billingStateForAgent` (a third) on EVERY authenticated request, with the layout and
 * the page each resolving a session — roughly four extra full parses per page view,
 * behind an in-code comment claiming the cost was nil.
 */
export function billingProfileNeedsWrite(db: DB, agentId: string): boolean {
  const profile = db.billingProfiles.find((p) => p.agentId === agentId) ?? null;
  if (!profile) return true; // create-if-absent must run
  return Boolean(db.billingSettings?.goLiveAt) && needsBillingStampHeal(profile);
}

/**
 * The anomalous state D-D heals: post-go-live, billable, and yet with no escalation
 * clock — which `billingTierForAgent` reads as `exempt/"not-launched"` forever.
 */
function needsBillingStampHeal(profile: BillingProfile): boolean {
  return (
    !profile.exemptFromBilling &&
    !profile.billingRequiredSince &&
    !isSampleAgentId(profile.agentId)
  );
}

/**
 * D-D — the GO-LIVE (T0) mutation, extracted from the admin route as a PURE function
 * over the db so the finding-2 free-rider case is unit-testable without an admin HTTP
 * session. Runs INSIDE the caller's `updateDB` (no network, R2-2).
 *
 * FINDING 2 — decision 7 says every agent alive at T0 is grandfathered comped, but the
 * old sweep only created-and-exempted profiles for agents that had NONE. An agent who
 * signed in BEFORE go-live already had a lazily-created profile (`exempt: false`,
 * `billingRequiredSince: null`), so the sweep skipped it, the tier read
 * `exempt/"not-launched"` and NOTHING in the codebase ever re-stamped it. A permanent
 * free rider, invisible on every surface. Existing profiles are now exempted too.
 *
 * FR1-3 — with ONE exception: a profile that already holds a live subscription is NOT
 * blanket-exempted (checkout has no goLiveAt gate, so a dormant-window subscription is
 * real). Comping an agency Stripe is actively invoicing would be silently money-wrong,
 * so it is left alone and surfaced for a human decision.
 */
export function applyGoLive(
  db: DB,
  nowIso: string
):
  | { ok: false; alreadyLiveAt: string }
  | {
      ok: true;
      goLiveAt: string;
      profilesCreated: number;
      profilesExempted: number;
      baselineRows: number;
      subscribedSkipped: string[];
      perAgent: { agentId: string; pairs: number }[];
    } {
  const settings = db.billingSettings ?? { ...EMPTY_BILLING_SETTINGS };
  if (settings.goLiveAt) return { ok: false, alreadyLiveAt: settings.goLiveAt };

  db.billingSettings = { ...settings, goLiveAt: nowIso };

  let profilesCreated = 0;
  let profilesExempted = 0;
  let baselineRows = 0;
  const subscribedSkipped: string[] = [];
  const perAgent: { agentId: string; pairs: number }[] = [];

  for (const agent of db.agents) {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agent.id);
    if (idx < 0) {
      const profile = defaultBillingProfile(agent.id, nowIso, db.billingSettings);
      profile.exemptFromBilling = true;
      db.billingProfiles.push(profile);
      profilesCreated++;
    } else {
      const current = db.billingProfiles[idx];
      // FR1-3 — never comp an agency Stripe is already invoicing. `subscriptionStatus`
      // is already a mapped value and `mapStripeStatus` is idempotent on stored values,
      // so this is behaviour-identical to the old {active,past_due,incomplete} membership
      // test — now sourced from the single liveness table (R3-5 / D-5).
      const subscribed =
        Boolean(current.stripeSubscriptionId) &&
        isLiveStripeStatus(current.subscriptionStatus);
      if (subscribed) {
        subscribedSkipped.push(agent.id);
      } else if (!current.exemptFromBilling) {
        db.billingProfiles[idx] = { ...current, exemptFromBilling: true, updatedAt: nowIso };
        profilesExempted++;
      }
    }

    // R1-7 — the demo class never gets baseline rows (never accrues usage).
    if (isSampleAgentId(agent.id)) {
      perAgent.push({ agentId: agent.id, pairs: 0 });
      continue;
    }

    // LIVE grant state, not the sinks — exactly decision 3 ("current board membership
    // counts from T0"). LOCKED (at sea) is readable, so it is included.
    const readable = readableSeafarerIds(agent.id, db);
    let pairs = 0;
    for (const grant of db.accessGrants) {
      if (grant.agentId !== agent.id) continue;
      if (!readable.has(grant.seafarerId)) continue;
      if (db.billingBaseline.some((b) => b.agentId === agent.id && b.seafarerId === grant.seafarerId)) {
        continue; // one open per pair, even when a pair somehow holds two grants.
      }
      db.billingBaseline.push({
        agentId: agent.id,
        seafarerId: grant.seafarerId,
        grantId: grant.id,
        openAt: nowIso,
      });
      baselineRows++;
      pairs++;
    }
    perAgent.push({ agentId: agent.id, pairs });
  }

  return {
    ok: true,
    goLiveAt: nowIso,
    profilesCreated,
    profilesExempted,
    baselineRows,
    subscribedSkipped,
    perAgent,
  };
}

/** Fields an agent may edit about itself (business info + ToS acceptance). */
export type BillingProfileBusinessPatch = Partial<
  Pick<BillingProfile, "legalName" | "regCode" | "vatNumber" | "billingEmail" | "address" | "tosAcceptedAt" | "tosVersion">
>;

/**
 * Upsert the agent's own business info. Deliberately CANNOT write rates,
 * exemption, Stripe ids or status — those are admin/webhook territory.
 */
export function saveBillingProfileForAgent(
  agentId: string,
  patch: BillingProfileBusinessPatch,
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile> {
  return updateDB((db) => {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
    const settings = db.billingSettings ?? { ...EMPTY_BILLING_SETTINGS };
    const base = idx >= 0 ? db.billingProfiles[idx] : defaultBillingProfile(agentId, nowIso, settings);
    const next: BillingProfile = { ...base, ...patch, agentId, updatedAt: nowIso };
    if (idx >= 0) db.billingProfiles[idx] = next;
    else db.billingProfiles.push(next);
    return next;
  });
}

/** Admin-only knobs (rates, exemption). Audited by the CALLER via recordAdminAction. */
export function setBillingRatesForAgent(
  agentId: string,
  patch: { baseEurMonthly?: number; perSeafarerEur?: number; exemptFromBilling?: boolean },
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile | null> {
  return updateDB((db) => {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
    if (idx < 0) return null;
    const prev = db.billingProfiles[idx];
    const next: BillingProfile = { ...prev, updatedAt: nowIso };
    if (typeof patch.baseEurMonthly === "number") next.baseEurMonthly = patch.baseEurMonthly;
    if (typeof patch.perSeafarerEur === "number") next.perSeafarerEur = patch.perSeafarerEur;
    if (typeof patch.exemptFromBilling === "boolean") {
      next.exemptFromBilling = patch.exemptFromBilling;
      // R1-6 — an exempt -> non-exempt transition RE-SETS the billing clock, so the
      // days spent comped are never retro-billed. The reverse direction leaves the
      // stamp alone (an exempt agent is not billed at all).
      if (prev.exemptFromBilling && !patch.exemptFromBilling) {
        next.billingActiveFrom = nowIso;
        // D-9 (refuted-hygiene) — a demo-class agent is structurally billing-exempt
        // (billing-enforce short-circuits it before tierFromProfile), so it must never
        // carry a billingRequiredSince stamp, matching the other write sites.
        if (db.billingSettings?.goLiveAt && !next.billingRequiredSince && !isSampleAgentId(agentId)) {
          next.billingRequiredSince = nowIso;
        }
      }
    }
    db.billingProfiles[idx] = next;
    return next;
  });
}

/** Persist Stripe object ids discovered by lib/stripe.ts (customer, prices, subscription). */
export function setBillingStripeRefs(
  agentId: string,
  refs: Partial<
    Pick<
      BillingProfile,
      "stripeCustomerId" | "stripeSubscriptionId" | "stripeBasePriceId" | "stripeUsagePriceId" | "billingActiveFrom"
    >
  >,
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile | null> {
  return updateDB((db) => {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
    if (idx < 0) return null;
    db.billingProfiles[idx] = { ...db.billingProfiles[idx], ...refs, updatedAt: nowIso };
    return db.billingProfiles[idx];
  });
}

/** The subscription-status mirror + its derived escalation stamps. */
export type SubscriptionStatusPatch = {
  subscriptionStatus?: BillingSubscriptionStatus;
  paymentMethodAttached?: boolean;
  pastDueSince?: string | null;
  canceledAt?: string | null;
  stripeSubscriptionId?: string | null;
  billingActiveFrom?: string | null;
  lastInvoiceEventCreated?: number | null;
  lastSubscriptionEventCreated?: number | null;
};

export function setSubscriptionStatusForAgent(
  agentId: string,
  patch: SubscriptionStatusPatch,
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile | null> {
  return updateDB((db) => {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
    if (idx < 0) return null;
    db.billingProfiles[idx] = { ...db.billingProfiles[idx], ...patch, updatedAt: nowIso };
    return db.billingProfiles[idx];
  });
}

// ---- Usage ledger -------------------------------------------------------------

/** This agent's usage rows, newest period first. */
export function usageForAgent(agentId: string, limit = 12): BillingUsageRow[] {
  return readDB()
    .billingUsage.filter((r) => r.agentId === agentId)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, limit);
}

export function getUsageRow(agentId: string, period: string): BillingUsageRow | null {
  return readDB().billingUsage.find((r) => r.agentId === agentId && r.period === period) ?? null;
}

/** Structural equality for the fields `recordUsageForPeriod` would write (finding 23b). */
function sameRecordedUsage(
  prev: BillingUsageRow,
  input: { quantity: number; billableSeafarerIds: string[]; detail?: unknown }
): boolean {
  if (prev.quantity !== input.quantity) return false;
  const a = prev.billableSeafarerIds ?? [];
  const b = input.billableSeafarerIds ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  try {
    return JSON.stringify(prev.detail ?? null) === JSON.stringify(input.detail ?? null);
  } catch {
    return false;
  }
}

/**
 * Upsert the computed usage for (agent, period).
 *
 * FROZEN once the row has been CLAIMED or PUSHED (finding 3 / R1-1): a row carrying
 * `pushAttemptedAt` may already have been received by Stripe, and the meter aggregates
 * by SUM, so recomputation must never move a quantity that could have been billed. Only
 * the admin's `resolveUnconfirmedPush` can unblock such a row.
 *
 * A row merely CLOSED (D-G `closedAs`) is NOT frozen: a recompute that now finds usage
 * REOPENS it (closedAs cleared) so a transient compute failure can never fossilise a
 * zero month. Returns the row as it stands after the write.
 *
 * Finding 23b — a recompute that changes NOTHING performs no write at all (the idle
 * cron tick used to re-stamp `computedAt` on every profile, 48 times a day, each one a
 * full db.json rewrite + fsync under the process-wide mutex). `computedAt` therefore
 * now means "last CHANGE", not "last tick".
 */
export function recordUsageForPeriod(
  agentId: string,
  period: string,
  input: {
    quantity: number;
    billableSeafarerIds: string[];
    detail?: unknown;
    /**
     * N5 — may a `never-billed` close be REOPENED by this recompute?
     *
     * The reopen exists for the zero-freeze fix: a close is only as good as the last
     * compute. But a `never-billed` close is not about the NUMBER, it is about the
     * agency — exempt, no subscription, a non-metering status, a pre-subscription
     * month. Reopening such a row because the quantity is non-zero only for the cron to
     * close it again on the very next line burned TWO fsync'd writes under the
     * process-wide mutex, per such agency, on every tick, forever.
     *
     * The caller passes what it actually knows: `false` when the agency still maps to
     * never-billed. Defaults to `true`, so a standalone caller keeps the plain
     * "recompute reopens a close" semantics.
     */
    canReopen?: boolean;
  },
  nowIso: string = new Date().toISOString()
): Promise<BillingUsageRow> {
  const mayReopen = (row: BillingUsageRow): boolean => {
    if (!row.closedAs || input.quantity <= 0) return false;
    // A `no-usage` close is purely about the quantity, so real usage always reopens it.
    if (row.closedAs !== "never-billed") return true;
    return input.canReopen !== false;
  };
  // PURE-READ fast path, outside the mutex (see the no-op rule above).
  const current = getUsageRow(agentId, period);
  if (current) {
    const frozen = Boolean(current.pushAttemptedAt || current.pushedToStripeAt);
    if (frozen) return Promise.resolve(current);
    if (!mayReopen(current) && sameRecordedUsage(current, input)) return Promise.resolve(current);
  }
  return updateDB((db) => {
    const idx = db.billingUsage.findIndex((r) => r.agentId === agentId && r.period === period);
    if (idx >= 0) {
      const prev = db.billingUsage[idx];
      // Frozen — claimed or already billed (finding 3).
      if (prev.pushAttemptedAt || prev.pushedToStripeAt) return prev;
      const reopens = mayReopen(prev);
      if (!reopens && sameRecordedUsage(prev, input)) return prev;
      const next: BillingUsageRow = {
        ...prev,
        quantity: input.quantity,
        billableSeafarerIds: input.billableSeafarerIds,
        detail: input.detail,
        computedAt: nowIso,
      };
      // D-G — the close is only as good as the last compute: real usage REOPENS it
      // (unless the close was `never-billed` and the agency still is — N5).
      if (reopens) {
        next.closedAs = null;
        next.closedReason = null;
      }
      db.billingUsage[idx] = next;
      return next;
    }
    const row: BillingUsageRow = {
      id: id(),
      agentId,
      period,
      billableSeafarerIds: input.billableSeafarerIds,
      quantity: input.quantity,
      computedAt: nowIso,
      pushAttemptedAt: null,
      pushedToStripeAt: null,
      stripeMeterEventId: null,
      closedAs: null,
      closedReason: null,
      detail: input.detail,
    };
    db.billingUsage.push(row);
    return row;
  });
}

/**
 * D-G — CLOSE a (agent, period) row that has nothing to send to Stripe:
 *   * `no-usage`     — the computed quantity was zero;
 *   * `never-billed` — the agency cannot be billed for this period at all (exempt, no
 *                      subscription, a non-metering status, or a month that predates
 *                      the subscription — R1-6b's visibility mandate).
 *
 * Deliberately does NOT touch `pushedToStripeAt`: that field means "Stripe received a
 * meter event" and nothing else. Refuses a claimed/pushed row — those belong to the
 * R1-1 manual-resolution path, never to an automatic close. db-only, so it is safe to
 * call from the cron between critical sections (never inside one).
 */
export function closeUsageRow(
  agentId: string,
  period: string,
  closedAs: "no-usage" | "never-billed",
  reason: string
): Promise<BillingUsageRow | null> {
  const existing = getUsageRow(agentId, period);
  // Pure-read no-op fast path — an already-closed row must not churn db.json.
  if (existing && existing.closedAs === closedAs && existing.closedReason === reason) {
    return Promise.resolve(existing);
  }
  return updateDB((db) => {
    const idx = db.billingUsage.findIndex((r) => r.agentId === agentId && r.period === period);
    if (idx < 0) return null;
    const row = db.billingUsage[idx];
    if (row.pushAttemptedAt || row.pushedToStripeAt) return row; // manual territory.
    if (row.closedAs === closedAs && row.closedReason === reason) return row; // no-op.
    db.billingUsage[idx] = { ...row, closedAs, closedReason: reason };
    return db.billingUsage[idx];
  });
}

/** True when a usage row needs nothing further from the cron (pushed OR closed). */
export function isUsageRowDone(row: BillingUsageRow | null | undefined): boolean {
  return Boolean(row && (row.pushedToStripeAt || row.closedAs));
}

/**
 * R1-1 phase 1 — CLAIM the push BEFORE calling Stripe. Returns false when the row is
 * already pushed, or when it carries an unconfirmed attempt that has aged out of
 * Stripe's ~24h idempotency-key dedupe window (that row is a MANUAL reconciliation
 * case and must never be auto-retried into a double charge).
 */
export const PUSH_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function claimUsagePush(
  agentId: string,
  period: string,
  nowMs: number = Date.now()
): Promise<{ claimed: boolean; reason?: "already-pushed" | "no-row" | "unconfirmed-stale" }> {
  const nowIso = new Date(nowMs).toISOString();
  return updateDB((db) => {
    const idx = db.billingUsage.findIndex((r) => r.agentId === agentId && r.period === period);
    if (idx < 0) return { claimed: false, reason: "no-row" as const };
    const row = db.billingUsage[idx];
    if (row.pushedToStripeAt) return { claimed: false, reason: "already-pushed" as const };
    if (row.pushAttemptedAt) {
      const attempted = Date.parse(row.pushAttemptedAt);
      if (Number.isFinite(attempted) && nowMs - attempted > PUSH_RETRY_WINDOW_MS) {
        return { claimed: false, reason: "unconfirmed-stale" as const };
      }
      // Inside the window the Stripe idempotency key still dedupes — retry is safe,
      // and `pushAttemptedAt` is deliberately NOT refreshed: Stripe's key dedupe runs
      // 24h from the FIRST use, so a sliding stamp would silently outlive it.
      return { claimed: true };
    }
    db.billingUsage[idx] = { ...row, pushAttemptedAt: nowIso };
    return { claimed: true };
  });
}

/** R1-1 phase 3 — CONFIRM a push that Stripe acknowledged. */
export function markUsagePushed(
  agentId: string,
  period: string,
  stripeMeterEventId: string | null,
  nowIso: string = new Date().toISOString()
): Promise<BillingUsageRow | null> {
  return updateDB((db) => {
    const idx = db.billingUsage.findIndex((r) => r.agentId === agentId && r.period === period);
    if (idx < 0) return null;
    db.billingUsage[idx] = {
      ...db.billingUsage[idx],
      pushedToStripeAt: nowIso,
      stripeMeterEventId,
    };
    return db.billingUsage[idx];
  });
}

/**
 * R2-10a — the ADMIN resolution of an attempted-but-unconfirmed push, after the admin
 * has checked the Stripe dashboard meter summary. Either mark it pushed (Stripe DID
 * receive it) or clear the attempt so the normal path can retry (it did not).
 */
export function resolveUnconfirmedPush(
  agentId: string,
  period: string,
  action: "mark-pushed" | "clear-attempt",
  nowIso: string = new Date().toISOString()
): Promise<BillingUsageRow | null> {
  return updateDB((db) => {
    const idx = db.billingUsage.findIndex((r) => r.agentId === agentId && r.period === period);
    if (idx < 0) return null;
    const row = db.billingUsage[idx];
    if (row.pushedToStripeAt) return row; // nothing to resolve.
    db.billingUsage[idx] =
      action === "mark-pushed"
        ? { ...row, pushedToStripeAt: nowIso, stripeMeterEventId: row.stripeMeterEventId ?? "admin-resolved" }
        : { ...row, pushAttemptedAt: null };
    return db.billingUsage[idx];
  });
}

/**
 * R2-4 — the daily reconciler's write. It stamps its FETCH timestamp into BOTH
 * ordering fields (so webhook events created before the fetch are dropped afterwards)
 * and RE-CHECKS those fields inside the same critical section: if a fresher webhook
 * landed while we were talking to Stripe, that webhook wins and the reconciliation is
 * abandoned rather than overwriting newer truth with a stale read.
 *
 * `fetchAtSec` is in unix SECONDS — the same unit as Stripe's `event.created`.
 */
export function applyReconciliation(
  agentId: string,
  fetchAtSec: number,
  patch: SubscriptionStatusPatch,
  nowIso: string = new Date().toISOString()
): Promise<{ applied: boolean; profile: BillingProfile | null }> {
  return updateDB((db) => {
    const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
    if (idx < 0) return { applied: false, profile: null };
    const current = db.billingProfiles[idx];
    const newerInvoice =
      typeof current.lastInvoiceEventCreated === "number" &&
      current.lastInvoiceEventCreated > fetchAtSec;
    const newerSubscription =
      typeof current.lastSubscriptionEventCreated === "number" &&
      current.lastSubscriptionEventCreated > fetchAtSec;
    if (newerInvoice || newerSubscription) {
      return { applied: false, profile: current }; // a fresher webhook already won.
    }
    db.billingProfiles[idx] = {
      ...current,
      ...patch,
      lastInvoiceEventCreated: fetchAtSec,
      lastSubscriptionEventCreated: fetchAtSec,
      updatedAt: nowIso,
    };
    return { applied: true, profile: db.billingProfiles[idx] };
  });
}

// ---- Usage computation (the I/O half of the pure engine) ----------------------

/**
 * Gather every input the PURE engine needs, in one place: db collections + the two
 * append-only sinks + the merge archive. Kept here (not in billing-usage.ts) so the
 * engine itself stays I/O-free and unit-testable against synthetic streams.
 *
 * `billingActiveFrom` is threaded per agent so the engine can apply the R1-6 clip
 * without reaching back into the store. A profile that has an active subscription but
 * no stamp falls back to nothing here — the reconciler heals it from Stripe's
 * `subscription.created` (R2-6).
 */
export function gatherUsageInputs(): UsageInputs {
  const db = readDB();
  const billingActiveFrom: Record<string, string | null> = {};
  for (const p of db.billingProfiles) billingActiveFrom[p.agentId] = p.billingActiveFrom;
  return {
    grants: db.accessGrants,
    consentEvents: readConsentEvents(),
    boardEvents: readBoardEvents(),
    baseline: db.billingBaseline,
    seafarers: db.seafarers,
    // Finding 18 — the engine needs assignments to mirror access.ts's LOCKED rule:
    // expiry is SUPPRESSED while a seafarer is at sea, so at-sea time past a grant's
    // expiresAt is readable on the board and must be billed.
    assignments: db.assignments,
    mergeArchiveRows: readMergeArchive(),
    billingActiveFrom,
  };
}

/**
 * The month-end metric for every agent, for one Tallinn period, plus the warnings that
 * belong to no agent (finding 23d — the cron surfaces those ONCE in billing-health
 * instead of embedding the global array into every tenant's persisted ledger row).
 */
export function computeUsageForPeriod(period: string): {
  usage: Map<string, AgentUsage>;
  unattributedWarnings: string[];
} {
  return computeMonthlyUsageWithWarnings(gatherUsageInputs(), period);
}

/**
 * A LIVE preview of one agent's current-period usage, for the agent's own billing page
 * and the admin drill-down. Partitioned by agentId like every other accessor here.
 */
export function usagePreviewForAgent(agentId: string, period: string): AgentUsage {
  // FINDING 23c — narrowed to THIS agent. Every billing-page GET and every admin
  // drill-down used to fold every other tenant's intervals as well, for an answer that
  // discarded all of them. FR1-10c: the narrowing happens at the fold stage only, so
  // the number is identical to the unfiltered computation.
  const all = computeMonthlyUsage(gatherUsageInputs(), period, agentId);
  return (
    all.get(agentId) ?? {
      agentId,
      quantity: 0,
      billableSeafarerIds: [],
      detail: { period, perSeafarerMs: {}, warnings: [] },
    }
  );
}

// ---- Stripe webhook ledger ----------------------------------------------------

/**
 * R2-2 phase 1 — dedupe check AND claim in ONE critical section.
 *   * a row with `processedAt !== null` → the event is DONE; skip it.
 *   * a row with `processedAt === null` → a CRASHED claim; REPROCESS it.
 *   * no row → insert the claim and process.
 */
export function claimStripeEvent(
  stripeEventId: string,
  type: string,
  nowIso: string = new Date().toISOString()
): Promise<{ process: boolean; replayOfProcessed: boolean }> {
  return updateDB((db) => {
    const found = db.stripeEvents.find((e) => e.stripeEventId === stripeEventId);
    if (found) {
      if (found.processedAt) return { process: false, replayOfProcessed: true };
      return { process: true, replayOfProcessed: false }; // crashed claim → reprocess.
    }
    db.stripeEvents.push({
      id: id(),
      stripeEventId,
      type,
      receivedAt: nowIso,
      processedAt: null,
    });
    return { process: true, replayOfProcessed: false };
  });
}

/** True when the event has already been fully processed (read-only probe, for tests). */
export function wasStripeEventProcessed(stripeEventId: string): boolean {
  const row = readDB().stripeEvents.find((e) => e.stripeEventId === stripeEventId);
  return Boolean(row?.processedAt);
}

// C4 — `recordStripeEvent()` was deleted here. It had ZERO callers and was actively
// dangerous: it claimed an event and dropped the claim on the floor, creating a ledger
// row with `processedAt: null` that the next redelivery would treat as a crashed claim
// and reprocess — a permanently-unprocessed event manufactured out of nothing.

/**
 * R2-2 phase 3 — apply every profile mutation for the event AND stamp `processedAt`
 * in ONE `updateDB`. `mutate` runs INSIDE the critical section and must be pure/sync
 * (no awaits — see the standing rule at the top of this file). It receives the
 * profile (or null) and returns the patch to apply, or null to leave it untouched.
 */
export function finishStripeEvent(
  stripeEventId: string,
  agentId: string | null,
  mutate: (profile: BillingProfile | null) => Partial<BillingProfile> | null,
  nowIso: string = new Date().toISOString()
): Promise<BillingProfile | null> {
  return updateDB((db) => {
    let result: BillingProfile | null = null;
    if (agentId) {
      const idx = db.billingProfiles.findIndex((p) => p.agentId === agentId);
      const current = idx >= 0 ? db.billingProfiles[idx] : null;
      const patch = mutate(current);
      if (patch && idx >= 0) {
        db.billingProfiles[idx] = { ...current as BillingProfile, ...patch, updatedAt: nowIso };
        result = db.billingProfiles[idx];
      } else {
        result = current;
      }
    } else {
      mutate(null);
    }
    const evIdx = db.stripeEvents.findIndex((e) => e.stripeEventId === stripeEventId);
    if (evIdx >= 0) db.stripeEvents[evIdx] = { ...db.stripeEvents[evIdx], processedAt: nowIso };
    return result;
  });
}

/** Prune webhook-ledger rows older than the retention window (Stripe retries ~3 days). */
export function pruneStripeEvents(
  olderThanMs: number = 90 * 24 * 60 * 60 * 1000,
  nowMs: number = Date.now()
): Promise<number> {
  // Pure-read fast path (finding 23): with nothing to prune, the idle cron tick must
  // not enter the process-wide mutex and rewrite db.json 48 times a day for no reason.
  const stale = readDB().stripeEvents.some((e) => {
    const at = Date.parse(e.receivedAt);
    return Number.isFinite(at) && nowMs - at > olderThanMs;
  });
  if (!stale) return Promise.resolve(0);
  return updateDB((db) => {
    const before = db.stripeEvents.length;
    db.stripeEvents = db.stripeEvents.filter((e) => {
      const at = Date.parse(e.receivedAt);
      return !Number.isFinite(at) || nowMs - at <= olderThanMs;
    });
    return before - db.stripeEvents.length;
  });
}

/** The profile keyed by Stripe customer id — the webhook's join back to an agent. */
export function agentIdForStripeCustomer(stripeCustomerId: string): string | null {
  return (
    readDB().billingProfiles.find((p) => p.stripeCustomerId === stripeCustomerId)?.agentId ?? null
  );
}

/** The profile keyed by Stripe subscription id (fallback join for invoice events). */
export function agentIdForStripeSubscription(stripeSubscriptionId: string): string | null {
  return (
    readDB().billingProfiles.find((p) => p.stripeSubscriptionId === stripeSubscriptionId)?.agentId ??
    null
  );
}
