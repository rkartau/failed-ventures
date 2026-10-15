// lib/billing-cron.ts — the billing cron's AUTH + DISPATCH, kept out of the route so
// both are unit-testable without an HTTP server (the auth-gated route module itself is
// never imported in tests). The route is a thin wrapper.
//
// ONE endpoint, ONE crontab line, internal dispatch (plan §0.4):
//
//   */30 * * * * curl -fsS --max-time 300 -H "Authorization: Bearer $CRON_SECRET" \
//                https://docka.me/api/cron/billing >> /var/log/docka-billing-cron.log 2>&1
//
// Every 30 minutes, and everything it does is idempotent and ledgered:
//   1. expireDueGrants()      — closes the "EXPIRED never emitted" hole (analysis §C:
//                               nothing schedules this today).
//   2. month-end usage push   — compute the CLOSED Tallinn month(s) and push each once.
//   3. daily reconcile sweep  — once per Tallinn day, ledgered in billing-health.
//   4. prune the webhook ledger + write data/billing-health.json.
//
// Why every-30-min instead of a precise month-end crontab line: crontab cannot express
// "last day of month, Europe/Tallinn" across DST. A frequent idempotent tick with the
// Tallinn logic IN CODE is simpler and self-healing — a box reboot, a pm2 restart or a
// missed tick is caught by the next one.
//
// TWO RULES THIS FILE EXISTS TO HOLD (findings 1/3/16/17):
//   * a compute FAILURE for a period records NOTHING for that period — no zero rows, no
//     closes, no pushes. The failure is alerted and the next tick retries from scratch
//     (FR1-1: the abort is PER-PERIOD, so a permanently-broken orphan month can never
//     starve the current month's billing);
//   * a month with nothing to send is CLOSED with `closedAs`, never by stamping
//     `pushedToStripeAt` — that field means "Stripe received a meter event" and nothing
//     else, and a closed row REOPENS if a later compute finds usage (D-G).

import { readDB, type BillingProfile, type BillingUsageRow, type DB } from "@/lib/db";
import { expireDueGrants } from "@/lib/access";
import {
  PUSH_RETRY_WINDOW_MS,
  claimUsagePush,
  closeUsageRow,
  computeUsageForPeriod,
  getUsageRow,
  isUsageRowDone,
  markUsagePushed,
  pruneStripeEvents,
  recordUsageForPeriod,
} from "@/lib/billing-store";
import {
  claimDailySweep,
  readBillingHealth,
  recordBillingAlert,
  recordBillingAlertOnce,
  writeBillingHealth,
  type BillingHealth,
  type BillingHealthAgentRow,
} from "@/lib/billing-health";
import {
  isSampleAgentId,
  previousTallinnPeriod,
  tallinnDayKey,
  tallinnMonthRange,
  tallinnPeriodOf,
  type AgentUsage,
} from "@/lib/billing-usage";
import { reconcileAll, defaultReconcilerDeps, type ReconcilerDeps } from "@/lib/billing-reconciler";
import {
  fetchSubscription,
  meterEventTimestampSec,
  pushUsage,
  type SubscriptionFetch,
} from "@/lib/stripe";

// ---- Auth ---------------------------------------------------------------------

// C1 — the shared-secret gate now lives in lib/cron-auth.ts, shared with
// /api/cron/reminders (it was hand-copied there). Re-exported so every existing
// caller and test keeps importing it from here.
export { cronAuthorized } from "@/lib/cron-auth";

// ---- Dispatch -----------------------------------------------------------------

export type CronDeps = {
  expireDueGrants: () => Promise<number>;
  fetchSubscription: (id: string) => Promise<SubscriptionFetch>;
  pushUsage: (input: {
    agentId: string;
    period: string;
    quantity: number;
    stripeCustomerId: string;
    timestampSec: number;
  }) => Promise<{ ok: true; eventId: string } | { ok: false; error: string }>;
  reconciler: ReconcilerDeps;
  now: () => number;
};

export const defaultCronDeps: CronDeps = {
  expireDueGrants: () => expireDueGrants(),
  fetchSubscription,
  pushUsage,
  reconciler: defaultReconcilerDeps,
  now: () => Date.now(),
};

export type CronResult = {
  ok: true;
  ranAt: string;
  /** The CLOSED Tallinn month this tick is primarily about. */
  period: string;
  /** Every period this tick processed (the primary one plus any recovered month). */
  periods: string[];
  expiredGrants: number;
  computed: number;
  pushed: number;
  /** Rows closed with `closedAs: "no-usage"` — nothing to send, not a Stripe push. */
  closed: number;
  skipped: number;
  lateEvents: number;
  unconfirmedPush: number;
  neverBilled: number;
  dailySweep: { ran: boolean; day: string; results: { agentId: string; outcome: string }[] };
  prunedEvents: number;
  errors: string[];
};

/** Statuses that still meter (R2-3): a past_due agency keeps accruing onto its next invoice. */
const METERING_STATUSES = new Set(["active", "past_due"]);

/**
 * Why this (agent, period) can never be pushed to Stripe, or null when it can.
 *
 * ONE predicate, used twice: `pushOneAgent` turns it into the `never-billed` close, and
 * the record step turns it into `canReopen` (N5). They MUST agree — when they did not,
 * an exempt agency with usage had its `never-billed` row reopened by the recompute and
 * re-closed by the push step on the very same tick: two fsync'd writes under the
 * process-wide mutex, per agency, every 30 minutes, indefinitely.
 */
function neverBillableReason(profile: BillingProfile, tallinnMonthEndMs: number): string | null {
  if (profile.exemptFromBilling) return "agency is exempt from billing";
  if (!profile.stripeCustomerId || !profile.stripeSubscriptionId) {
    return "no Stripe subscription for this agency";
  }
  // R2-3 — a past_due agency KEEPS metering (the usage rides the next invoice and is
  // itself the evidence trail for the escalation). Only none/incomplete/canceled skip.
  if (!METERING_STATUSES.has(profile.subscriptionStatus)) {
    return `subscription status is ${profile.subscriptionStatus}`;
  }
  // FINDING 17 / R1-6(b) — a month that closed BEFORE the subscription began is not a
  // zero month, it is a month this agency was never billable for.
  const activeFromMs = profile.billingActiveFrom ? Date.parse(profile.billingActiveFrom) : NaN;
  if (Number.isFinite(activeFromMs) && activeFromMs >= tallinnMonthEndMs) {
    return "period predates the subscription (R1-6b)";
  }
  return null;
}

/**
 * N2 — the `neverBilled` visibility list, rebuilt from the LEDGER on every health write
 * rather than from this tick's outcomes.
 *
 * R1-6(b) mandates that such months are SURFACED, never silently skipped. They were
 * pushed to the snapshot only on the tick that closed them; every later tick skipped the
 * (now done) row, so `writeBillingHealth` overwrote the list with `[]` and the month
 * vanished from the admin card within 30 minutes of appearing. The ledger is the durable
 * record — read it.
 */
function neverBilledFromLedger(db: DB, primaryPeriod: string): BillingHealth["neverBilled"] {
  // Bounded lookback so the card cannot grow without limit as the ledger ages.
  const horizon = new Set<string>();
  let period = primaryPeriod;
  for (let i = 0; i < NEVER_BILLED_LOOKBACK_PERIODS; i++) {
    horizon.add(period);
    period = periodBefore(period);
  }
  return db.billingUsage
    .filter((r) => r.closedAs === "never-billed" && horizon.has(r.period) && !isSampleAgentId(r.agentId))
    .sort((a, b) => b.period.localeCompare(a.period) || a.agentId.localeCompare(b.agentId))
    .map((r) => ({
      agentId: r.agentId,
      period: r.period,
      reason: r.closedReason ?? "closed as never-billed",
    }));
}

/** FR2-6 — the bounded recovery window for a cron that was dead across a boundary. */
const MAX_LOOKBACK_PERIODS = 3;

/** N2 — how far back the health card's `neverBilled` list reaches into the ledger. */
const NEVER_BILLED_LOOKBACK_PERIODS = 6;

/** The Tallinn period immediately before `period` ("YYYY-MM" arithmetic). */
function periodBefore(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * FINDING 16 — the set of periods this tick must work on, not just "last month".
 *
 *   (a) the previous Tallinn period (the ordinary month-end case);
 *   (b) every period that already has a usage row which is neither pushed nor closed —
 *       this is the admin "clear-attempt" after a rollover, and any month a previous
 *       tick recorded but could not finish;
 *   (c) up to MAX_LOOKBACK_PERIODS closed periods back to the period the cron LAST RAN
 *       in, for which some non-sample profile has no done row at all — the
 *       outage-across-a-boundary case, where no row was ever created.
 *
 * (c) is deliberately bounded by the last run rather than by wall-clock alone: on a box
 * where the cron has never run there is no missed month to recover, and recovery beyond
 * the bound is a manual job (FR2-6 documented residual — the staleness card has been red
 * for months by then).
 */
export function monthEndPeriods(
  db: DB,
  nowMs: number,
  lastRanAt: string | null
): string[] {
  const primary = previousTallinnPeriod(nowMs);
  const out = new Set<string>([primary]);

  for (const row of db.billingUsage) {
    if (isSampleAgentId(row.agentId)) continue;
    if (!isUsageRowDone(row)) out.add(row.period);
  }

  const lastRanMs = lastRanAt ? Date.parse(lastRanAt) : NaN;
  if (Number.isFinite(lastRanMs)) {
    const floor = tallinnPeriodOf(lastRanMs);
    const billable = db.billingProfiles.filter((p) => !isSampleAgentId(p.agentId));
    let period = primary;
    for (let i = 0; i < MAX_LOOKBACK_PERIODS && period >= floor; i++) {
      const missing = billable.some(
        (p) => !isUsageRowDone(db.billingUsage.find((r) => r.agentId === p.agentId && r.period === period))
      );
      if (missing) out.add(period);
      period = periodBefore(period);
    }
  }

  // Oldest first: a recovered month is finished before the current one is touched.
  return [...out].sort();
}

/** 23a — true when every non-sample profile already has a done row for every period. */
function everythingDone(db: DB, periods: string[]): boolean {
  const billable = db.billingProfiles.filter((p) => !isSampleAgentId(p.agentId));
  if (billable.length === 0) return true;
  for (const period of periods) {
    for (const p of billable) {
      const row = db.billingUsage.find((r) => r.agentId === p.agentId && r.period === period);
      if (!isUsageRowDone(row)) return false;
    }
  }
  return true;
}

export async function runBillingCron(deps: CronDeps = defaultCronDeps): Promise<CronResult> {
  const nowMs = deps.now();
  const ranAt = new Date(nowMs).toISOString();
  const errors: string[] = [];

  // ---- 1. Close grants that sailed past their expiry -------------------------
  let expiredGrants = 0;
  try {
    expiredGrants = await deps.expireDueGrants();
  } catch (err) {
    errors.push(`expireDueGrants failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- 2. Month-end usage for every CLOSED Tallinn month still owing ----------
  const primaryPeriod = previousTallinnPeriod(nowMs);
  const db = readDB();
  const periods = monthEndPeriods(db, nowMs, readBillingHealth().ranAt);

  const perAgent: BillingHealthAgentRow[] = [];
  const lateEvents: BillingHealth["lateEvents"] = [];
  const unconfirmedPush: BillingHealth["unconfirmedPush"] = [];
  const neverBilled: BillingHealth["neverBilled"] = [];
  const usageWarnings: string[] = [];
  let computed = 0;
  let pushed = 0;
  let closed = 0;
  let skipped = 0;

  // 23a — the idle tick. Nothing is owed, so the expensive full-sink compute (and the
  // per-profile ledger writes it feeds) is skipped entirely. 48 ticks a day used to pay
  // for a computation whose answer was already on disk.
  const idle = everythingDone(db, periods);

  const billableProfiles = db.billingProfiles.filter((p) => !isSampleAgentId(p.agentId));

  for (const period of idle ? [] : periods) {
    // FR1-1 — the abort is PER-PERIOD. A period whose compute throws records NOTHING
    // (no zero rows, no closes, no pushes) and the OTHER periods still bill this tick.
    // The month arithmetic is inside the try for the same reason: a malformed period
    // key on an orphan row must not take the whole tick down with it.
    let usage: Map<string, AgentUsage>;
    let tallinnMonthEndMs: number;
    try {
      tallinnMonthEndMs = tallinnMonthRange(period).endMs;
      const computedForPeriod = computeUsageForPeriod(period);
      usage = computedForPeriod.usage;
      // FINDING 23d — warnings that belong to NO agent (an unresolvable grantId is
      // unattributable by construction) are surfaced ONCE per period HERE, instead of
      // being embedded into every tenant's persisted ledger row on every tick.
      for (const message of computedForPeriod.unattributedWarnings) {
        const line = period + ": " + message;
        if (!usageWarnings.includes(line)) usageWarnings.push(line);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`computeUsageForPeriod ${period} failed: ${message}`);
      // FR2-2 — deduped by (kind, period) so a broken period alerts once, not 48×/day.
      recordBillingAlertOnce(
        "error",
        `month-end compute failed for ${period} — nothing recorded this tick (${message})`,
        { period }
      );
      continue;
    }

    for (const profile of billableProfiles) {
      const row = usage.get(profile.agentId);
      const quantity = row?.quantity ?? 0;
      const billableSeafarerIds = row?.billableSeafarerIds ?? [];
      const warnings = extractWarnings(row?.detail);

      // The row is ALWAYS recorded, even for an agency that cannot be billed — the
      // admin surface needs the number, and R1-6 says such months are surfaced as
      // `neverBilled`, never silently skipped.
      try {
        await recordUsageForPeriod(profile.agentId, period, {
          quantity,
          billableSeafarerIds,
          detail: row?.detail,
          // N5 — reopen a `never-billed` close ONLY when this agency could actually be
          // pushed now. Otherwise the reopen below and the re-close in `pushOneAgent`
          // would fight each other, two writes per tick, forever.
          canReopen: neverBillableReason(profile, tallinnMonthEndMs) === null,
        });
        computed++;
      } catch (err) {
        errors.push(`record ${profile.agentId} ${period}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const existing = getUsageRow(profile.agentId, period);
      if (isUsageRowDone(existing)) {
        perAgent.push({
          agentId: profile.agentId,
          period,
          quantity: existing?.quantity ?? quantity,
          pushed: Boolean(existing?.pushedToStripeAt),
          warnings,
        });
        continue; // already billed or already closed — a rerun is a no-op.
      }

      const pushable = await pushOneAgent({
        profile,
        period,
        // FR1-2 — the LEDGER quantity, never the fresh recompute. A retry inside the
        // 24h window must send a body identical to the first attempt or Stripe answers
        // `idempotency_error`, and the ledger must equal what Stripe holds.
        ledger: existing,
        quantity: existing?.quantity ?? quantity,
        tallinnMonthEndMs,
        nowMs,
        deps,
      });

      switch (pushable.kind) {
        case "pushed":
          pushed++;
          break;
        case "closed":
          closed++;
          break;
        case "late":
          lateEvents.push({ agentId: profile.agentId, period, reason: pushable.reason });
          recordBillingAlert("lateEvent", pushable.reason, { agentId: profile.agentId, period });
          skipped++;
          break;
        case "unconfirmed":
          unconfirmedPush.push({
            agentId: profile.agentId,
            period,
            attemptedAt: pushable.attemptedAt,
          });
          recordBillingAlert(
            "unconfirmedPush",
            `push for ${period} was attempted at ${pushable.attemptedAt} and never confirmed; ` +
              `past the 24h dedupe window it needs MANUAL resolution (admin card)`,
            { agentId: profile.agentId, period }
          );
          skipped++;
          break;
        case "never-billed":
          neverBilled.push({ agentId: profile.agentId, period, reason: pushable.reason });
          skipped++;
          break;
        case "error":
          errors.push(`push ${profile.agentId} ${period}: ${pushable.reason}`);
          skipped++;
          break;
      }

      perAgent.push({
        agentId: profile.agentId,
        period,
        quantity: existing?.quantity ?? quantity,
        pushed: pushable.kind === "pushed",
        warnings,
      });
    }
  }

  // ---- 3. Daily reconcile sweep (once per Tallinn day) ------------------------
  const day = tallinnDayKey(nowMs);
  let sweepResults: { agentId: string; outcome: string }[] = [];
  const sweepRan = claimDailySweep(day, ranAt);
  if (sweepRan) {
    try {
      const results = await reconcileAll(db.billingProfiles, deps.reconciler);
      sweepResults = results.map((r) => ({ agentId: r.agentId, outcome: r.outcome }));
    } catch (err) {
      errors.push(`daily reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 4. Housekeeping + the health snapshot ---------------------------------
  let prunedEvents = 0;
  try {
    prunedEvents = await pruneStripeEvents(90 * 24 * 3600_000, nowMs);
  } catch (err) {
    errors.push(`prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // N2 — the durable lists are rebuilt from the LEDGER, not from this tick's outcomes.
  // `neverBilled` rows are only *produced* on the tick that closes them; every later
  // tick skips the done row, so writing this tick's outcomes blanked the card.
  const neverBilledRows = neverBilledFromLedger(readDB(), primaryPeriod);
  // Warnings for a period this tick did not recompute must survive too (same bug shape).
  const computedPeriods = new Set(idle ? [] : periods);
  const carriedWarnings = readBillingHealth().usageWarnings.filter((w) => {
    const period = w.slice(0, w.indexOf(":"));
    return !computedPeriods.has(period);
  });

  writeBillingHealth({
    ranAt,
    period: primaryPeriod,
    perAgent,
    errors,
    lateEvents,
    unconfirmedPush,
    neverBilled: neverBilledRows,
    usageWarnings: [...new Set([...carriedWarnings, ...usageWarnings])].sort(),
  });

  return {
    ok: true,
    ranAt,
    period: primaryPeriod,
    periods,
    expiredGrants,
    computed,
    pushed,
    closed,
    skipped,
    lateEvents: lateEvents.length,
    unconfirmedPush: unconfirmedPush.length,
    neverBilled: neverBilledRows.length,
    dailySweep: { ran: sweepRan, day, results: sweepResults },
    prunedEvents,
    errors,
  };
}

type PushOutcome =
  | { kind: "pushed" }
  | { kind: "closed"; reason: string }
  | { kind: "late"; reason: string }
  | { kind: "unconfirmed"; attemptedAt: string }
  | { kind: "never-billed"; reason: string }
  | { kind: "error"; reason: string };

/**
 * The R1-1 attempt/confirm protocol for ONE (agent, period):
 *   claim (own updateDB) -> Stripe call -> confirm (own updateDB).
 * A crash between claim and confirm leaves `pushAttemptedAt` set and
 * `pushedToStripeAt` null; within 24h the Stripe idempotency key still dedupes so a
 * retry is safe, and after that the row becomes a MANUAL reconciliation case rather
 * than a possible double charge (the meter aggregates by SUM).
 */
async function pushOneAgent(input: {
  profile: BillingProfile;
  period: string;
  ledger: BillingUsageRow | null;
  quantity: number;
  tallinnMonthEndMs: number;
  nowMs: number;
  deps: CronDeps;
}): Promise<PushOutcome> {
  const { profile, period, ledger, quantity, tallinnMonthEndMs, nowMs, deps } = input;

  // R1-1 / R3-3 (D-3) — the STALE-UNCONFIRMED check comes FIRST, before the unbillable
  // branch, before the quantity-0 close, before the lateness check and before any claim.
  // A row that was attempted and never confirmed, past Stripe's ~24h idempotency-key
  // window, is the most dangerous state there is (the meter aggregates by SUM, so a blind
  // retry could double-charge) and must be reported as the manual `unconfirmed` case
  // whatever else is true of it. In particular it must beat the unbillable branch: an
  // aged unconfirmed row on an agency that has since become exempt/canceled/non-metering
  // used to take the never-billed branch, but closeUsageRow REFUSES rows carrying
  // pushAttemptedAt, so closedAs stayed null and the row was re-added every tick — invisible
  // and unresolvable (finding R3-3). Surfacing it as unconfirmedPush makes it visible on
  // the admin billing-health card and terminally resolvable there.
  if (ledger?.pushAttemptedAt && !ledger.pushedToStripeAt) {
    const attempted = Date.parse(ledger.pushAttemptedAt);
    if (Number.isFinite(attempted) && nowMs - attempted > PUSH_RETRY_WINDOW_MS) {
      return { kind: "unconfirmed", attemptedAt: ledger.pushAttemptedAt };
    }
  }

  const neverBilled = async (reason: string): Promise<PushOutcome> => {
    // D-G — closed with `closedAs`, NOT by stamping pushedToStripeAt.
    await closeUsageRow(profile.agentId, period, "never-billed", reason);
    return { kind: "never-billed", reason };
  };

  // ONE predicate, shared with the `canReopen` decision at the record step (N5).
  const unbillable = neverBillableReason(profile, tallinnMonthEndMs);
  if (unbillable) return neverBilled(unbillable);
  // Re-read the ids as locals: the predicate above has already guaranteed both are
  // present, but it did so behind a function boundary, so TS cannot see the narrowing.
  const { stripeCustomerId, stripeSubscriptionId } = profile;
  if (!stripeCustomerId || !stripeSubscriptionId) {
    return neverBilled("no Stripe subscription for this agency");
  }

  if (quantity <= 0) {
    // Nothing was billable. There is no meter event to send, so the row is CLOSED
    // explicitly rather than being retried every 30 minutes forever — and closed in a
    // way a later recompute can reopen (D-G).
    const reason = "no billable seafarers in the period";
    await closeUsageRow(profile.agentId, period, "no-usage", reason);
    return { kind: "closed", reason };
  }

  // R2-1/R3-2 — the meter timestamp must sit inside the still-open Stripe period.
  // FR1-9a — the D-B tagged result. A transient Stripe failure is an ERROR outcome
  // (retried next tick), never "no current_period_end", which would have been reported
  // as the manual `late` case and hidden a perfectly pushable month behind admin work.
  const fetched = await deps.fetchSubscription(stripeSubscriptionId);
  if (fetched.kind === "error") {
    return {
      kind: "error",
      reason: `could not read subscription ${stripeSubscriptionId}: ${fetched.message}`,
    };
  }
  const subscription = fetched.kind === "found" ? fetched.view : null;
  const ts = meterEventTimestampSec({
    nowMs,
    tallinnMonthEndMs,
    currentPeriodEndSec: subscription?.currentPeriodEnd ?? null,
  });
  if (!ts.ok) {
    return {
      kind: "late",
      reason:
        ts.reason === "late"
          ? `the Stripe period closed before the ${period} usage was pushed — needs manual review`
          : `no current_period_end available for subscription ${stripeSubscriptionId}`,
    };
  }

  const claim = await claimUsagePush(profile.agentId, period, nowMs);
  if (!claim.claimed) {
    if (claim.reason === "unconfirmed-stale") {
      const row = getUsageRow(profile.agentId, period);
      return { kind: "unconfirmed", attemptedAt: row?.pushAttemptedAt ?? "unknown" };
    }
    if (claim.reason === "already-pushed") return { kind: "pushed" };
    return { kind: "error", reason: `could not claim the push (${claim.reason})` };
  }

  const res = await deps.pushUsage({
    agentId: profile.agentId,
    period,
    quantity,
    stripeCustomerId,
    timestampSec: ts.timestamp,
  });
  if (!res.ok) {
    // The claim STAYS. Inside 24h the idempotency key still dedupes, so the next tick
    // may retry safely; after that the row surfaces as unconfirmedPush.
    return { kind: "error", reason: res.error };
  }
  await markUsagePushed(profile.agentId, period, res.eventId, new Date(nowMs).toISOString());
  return { kind: "pushed" };
}

function extractWarnings(detail: unknown): string[] {
  if (detail && typeof detail === "object" && Array.isArray((detail as { warnings?: unknown }).warnings)) {
    return (detail as { warnings: string[] }).warnings;
  }
  return [];
}
