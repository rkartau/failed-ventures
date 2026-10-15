// lib/billing-health.ts — the billing job's observability file.
//
// Imitates lib/registry-health.ts exactly: a plain JSON snapshot under data/ with an
// atomic tmp+rename write, tolerant read, and an admin card that renders it.
// Deliberately NOT db.json (it is regenerable operational state, not tenant data) and
// NOT an audit sink (nothing here is hash-chained or legally load-bearing).
//
// It carries the alerts the plan requires a human to see:
//   * unconfirmedPush     (R1-1) — attempted, never confirmed, past the 24h dedupe
//                                  window: MANUAL reconciliation via the admin card.
//   * duplicateSubscription (R1-4/R3-1) — a second live subscription was created.
//   * neverBilled         (R1-6) — a month computed for visibility but never pushed.
//   * lateEvents          (R2-1) — the push missed the subscription's period end.
//   * staleness           (R1-10b) — computed AT RENDER TIME from `ranAt`.
//
// All writes are synchronous read-modify-write. The app is pinned to ONE process
// (db.ts:1376), so on the single-threaded event loop that is race-free without taking
// the db mutex — and this file must never take that mutex anyway (a cron run holds it
// repeatedly, and blocking on it here would serialise health writes behind db writes).

import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "@/lib/atomic-json";

const DATA_DIR = path.join(process.cwd(), "data");
const HEALTH_PATH = path.join(DATA_DIR, "billing-health.json");

/** R1-10b — staleness thresholds the admin card colours by, at render time. */
export const HEALTH_AMBER_MS = 2 * 60 * 60 * 1000;
export const HEALTH_RED_MS = 6 * 60 * 60 * 1000;

/** Rolling cap so a stuck alert loop can never grow the file without bound. */
const MAX_ALERTS = 200;

export type BillingHealthAgentRow = {
  agentId: string;
  period: string;
  quantity: number;
  pushed: boolean;
  warnings: string[];
};

export type BillingHealthAlert = {
  at: string;
  kind: "unconfirmedPush" | "duplicateSubscription" | "neverBilled" | "lateEvent" | "error";
  agentId: string | null;
  period: string | null;
  /**
   * N4 — WHICH producer raised it, so the once-per-alert dedupe below can distinguish
   * two different `error` alerts about the same agent. Without it, a session fail-open
   * would silently suppress the reconciler's unrelated error for that agency.
   */
  scope?: string | null;
  message: string;
};

export type BillingHealth = {
  /** Last completed cron run. null = the cron has never run on this box. */
  ranAt: string | null;
  /** The Tallinn period the last run computed. */
  period: string | null;
  perAgent: BillingHealthAgentRow[];
  errors: string[];
  lateEvents: { agentId: string; period: string; reason: string }[];
  unconfirmedPush: { agentId: string; period: string; attemptedAt: string }[];
  neverBilled: { agentId: string; period: string; reason: string }[];
  /**
   * Finding 23d — usage warnings that belong to NO agent (an unresolvable grantId is
   * unattributable by construction). Surfaced here ONCE per run rather than copied into
   * every tenant's persisted ledger row, where they grew db.json without bound and
   * leaked one agency's data-quality noise into another's admin drill-down.
   */
  usageWarnings: string[];
  alerts: BillingHealthAlert[];
  /** Ledger for the once-per-Tallinn-day reconciler sweep ("YYYY-MM-DD"). */
  lastDailySweepDay: string | null;
  lastDailySweepAt: string | null;
};

export const EMPTY_BILLING_HEALTH: BillingHealth = {
  ranAt: null,
  period: null,
  perAgent: [],
  errors: [],
  lateEvents: [],
  unconfirmedPush: [],
  neverBilled: [],
  usageWarnings: [],
  alerts: [],
  lastDailySweepDay: null,
  lastDailySweepAt: null,
};

/** Tolerant read — a missing or corrupt file reads as the empty snapshot. */
export function readBillingHealth(): BillingHealth {
  try {
    const raw = fs.readFileSync(HEALTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<BillingHealth>;
    return {
      ...EMPTY_BILLING_HEALTH,
      ...parsed,
      perAgent: Array.isArray(parsed.perAgent) ? parsed.perAgent : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      lateEvents: Array.isArray(parsed.lateEvents) ? parsed.lateEvents : [],
      unconfirmedPush: Array.isArray(parsed.unconfirmedPush) ? parsed.unconfirmedPush : [],
      neverBilled: Array.isArray(parsed.neverBilled) ? parsed.neverBilled : [],
      usageWarnings: Array.isArray(parsed.usageWarnings) ? parsed.usageWarnings : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    return { ...EMPTY_BILLING_HEALTH, perAgent: [], errors: [], alerts: [] };
  }
}

function writeAtomic(next: BillingHealth): void {
  // C6 — the tmp+rename writer is SHARED with lib/registry-health.ts, which had its own
  // copy. Two implementations of a durability primitive means a fix to one silently
  // misses the other.
  const res = writeJsonAtomic(HEALTH_PATH, next);
  if (!res.ok) {
    // Observability must never break the job it observes.
    console.error("BILLING-HEALTH-WRITE-FAILURE:", res.error);
  }
}

/** Merge a patch into the snapshot and persist it atomically. */
export function writeBillingHealth(patch: Partial<BillingHealth>): BillingHealth {
  const next: BillingHealth = { ...readBillingHealth(), ...patch };
  next.alerts = next.alerts.slice(-MAX_ALERTS);
  writeAtomic(next);
  return next;
}

/** Append ONE alert. Used by the webhook (duplicateSubscription) and the cron. */
export function recordBillingAlert(
  kind: BillingHealthAlert["kind"],
  message: string,
  opts: { agentId?: string | null; period?: string | null; scope?: string | null; at?: string } = {}
): void {
  const current = readBillingHealth();
  const alert: BillingHealthAlert = {
    at: opts.at ?? new Date().toISOString(),
    kind,
    agentId: opts.agentId ?? null,
    period: opts.period ?? null,
    scope: opts.scope ?? null,
    message,
  };
  current.alerts = [...current.alerts, alert].slice(-MAX_ALERTS);
  writeAtomic(current);
}

/**
 * FR2-2 — append an alert AT MOST ONCE per (kind, agentId, period, scope) for as long
 * as it stands in the snapshot. Two producers need it:
 *   * the month-end compute failure — the cron ticks 48 times a day, and a permanently
 *     broken period would otherwise write 48 identical lines a day;
 *   * the agent-session fail-open (N4) — that path runs PER REQUEST, so a transient
 *     store failure could append thousands of lines in a minute and roll every
 *     money-critical alert (unconfirmedPush, duplicateSubscription) straight out of the
 *     200-entry window. `scope` keeps the two `error` producers from suppressing each
 *     other for the same agency.
 */
export function recordBillingAlertOnce(
  kind: BillingHealthAlert["kind"],
  message: string,
  opts: { agentId?: string | null; period?: string | null; scope?: string | null; at?: string } = {}
): void {
  const agentId = opts.agentId ?? null;
  const period = opts.period ?? null;
  const scope = opts.scope ?? null;
  const already = readBillingHealth().alerts.some(
    (a) =>
      a.kind === kind &&
      a.agentId === agentId &&
      a.period === period &&
      (a.scope ?? null) === scope
  );
  if (already) return;
  recordBillingAlert(kind, message, opts);
}

/** Claim the once-per-Tallinn-day reconciler sweep. False = already done today. */
export function claimDailySweep(dayKey: string, nowIso: string = new Date().toISOString()): boolean {
  const current = readBillingHealth();
  if (current.lastDailySweepDay === dayKey) return false;
  current.lastDailySweepDay = dayKey;
  current.lastDailySweepAt = nowIso;
  writeAtomic(current);
  return true;
}

/** R1-10b — staleness computed AT RENDER TIME, never persisted. */
export function healthStaleness(
  health: BillingHealth,
  nowMs: number = Date.now()
): { level: "ok" | "amber" | "red" | "never"; ageMs: number | null; text: string } {
  if (!health.ranAt) {
    return { level: "never", ageMs: null, text: "billing cron has never run on this box" };
  }
  const ranAt = Date.parse(health.ranAt);
  if (!Number.isFinite(ranAt)) {
    return { level: "red", ageMs: null, text: "billing cron last-run timestamp is unreadable" };
  }
  const ageMs = nowMs - ranAt;
  const text = `billing cron has not run since ${health.ranAt}`;
  if (ageMs > HEALTH_RED_MS) return { level: "red", ageMs, text };
  if (ageMs > HEALTH_AMBER_MS) return { level: "amber", ageMs, text };
  return { level: "ok", ageMs, text: `last billing cron run ${health.ranAt}` };
}

/** Test hook — remove the snapshot file. */
export function __resetBillingHealth(): void {
  try {
    fs.rmSync(HEALTH_PATH, { force: true });
  } catch {
    /* ignore */
  }
}
