// lib/billing-usage.ts — the PURE usage engine (STRIPE-BILLING-PLAN.md §0.5 + P2).
//
// No I/O whatsoever: every input (grants, consent events, board events, merge-archive
// rows, baseline rows) is passed in as a plain array, so the whole month-end metric is
// unit-testable against synthetic event streams. The cron route (P7) is the only place
// that reads the sinks and calls in here.
//
// THE METRIC (decision 4/5, locked): a seafarer is billable to agent A in Tallinn
// calendar month M ⇔ the UNION of that pair's readable intervals ∩ M is >= 24h
// CUMULATIVE (not continuous).
//
//   OPEN   : consent GRANTED · the T0 go-live baseline row · (defensive) a readable
//            grant with no GRANTED event at all, opened at grantedAt ?? createdAt.
//   CLOSE  : consent WITHDRAWN / REVOKED_BY_AGENT / EXPIRED · board BOARD_DELETED
//            (both modes) · a synthetic close at grant.expiresAt for a grant that
//            sailed past its expiry with no EXPIRED event ever written (analysis §C:
//            nothing schedules expireDueGrants today).
//   NEUTRAL: BOARD_HIDDEN / BOARD_RESTORED are DELIBERATELY IGNORED (decision 4 —
//            hidden crew keep full access/reminders/export, and ignoring hide/restore
//            removes an entire class of interval-algebra bugs). Also neutral:
//            REQUESTED (PENDING is not readable), LOCKED / UNLOCKED (LOCKED IS
//            readable — at-sea time bills), BASIS_CHANGED, REOPEN_DENIED and every
//            PROPAGATION_* / CLIENT_VISIBLE_* / DIRECTORY_CONSENT_* event.
//
// Documented user-facing consequence: hiding a seafarer does NOT pause billing. Only
// withdraw / revoke / expiry / delete stops the clock.

import type {
  AccessGrant,
  Assignment,
  BillingBaselineRow,
  BoardEvent,
  ConsentEvent,
  Seafarer,
} from "@/lib/db";

// ---- Demo-class agents (R1-7) -------------------------------------------------
//
// Sample/demo tenants are STRUCTURALLY billing-exempt: they never get a
// billingRequiredSince, never accrue usage rows, never appear in billing-health, and
// are skipped by the go-live baseline. Two classes:
//   * "dev"      — the long-standing local/demo tenant (precedent: admin-funnel.ts:529).
//   * "sample-*" — the seeded Public Sample Profiles namespace.
//
// SEQUENCING NOTE (R1-7): the in-flight plan `docka-sample-profiles-2026-08-18-v4`
// introduces `lib/sample-ids.ts` with `SAMPLE_PREFIX = "sample-"` and `isSampleId()`.
// That module does NOT exist on this branch's base, so the prefix is declared here
// ONCE. Whichever branch lands second MUST collapse the two: re-export
// `SAMPLE_AGENT_ID_PREFIX` from `@/lib/sample-ids` rather than keeping two literals.

/** The single sample-namespace prefix — see the sequencing note above. */
export const SAMPLE_AGENT_ID_PREFIX = "sample-";

/** The legacy local/demo tenant id. */
export const DEV_AGENT_ID = "dev";

/** True when an agent id belongs to the demo class and must never be billed (R1-7). */
export function isSampleAgentId(agentId: string): boolean {
  if (typeof agentId !== "string") return false;
  return agentId === DEV_AGENT_ID || agentId.startsWith(SAMPLE_AGENT_ID_PREFIX);
}

// ---- Tallinn month arithmetic (plan §0.5 + risk row "Tallinn/DST boundary") ----
//
// ONE implementation, used by every caller. Europe/Tallinn is UTC+2 in winter and
// UTC+3 in summer, so a wall-clock month is NOT a fixed number of milliseconds: the
// last Sunday of March has 23h and the last Sunday of October has 25h. The offset is
// resolved with Intl (the IANA database ships with Node), never hardcoded.

const TALLINN = "Europe/Tallinn";

const TALLINN_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: TALLINN,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** A civil (wall-clock) field-set. */
export type CivilFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * R3-9 (D-2) — roll a civil field-set whose hour ICU rendered as "24" forward to 00:00
 * the NEXT day. The old code masked the hour with `% 24` but left day/month/year raw, so
 * on an ICU build that renders Tallinn midnight as the prior day's "24:00" the civil DATE
 * stayed one day behind — off by one at a month boundary. `Date.UTC` handles the
 * month/year rollover (day+1 past the month length carries correctly). Latent/defensive:
 * not reproducible on the current Node build, so this pure helper is the pin target.
 */
export function normalizeCivilMidnight(f: CivilFields): CivilFields {
  if (f.hour !== 24) return f;
  const d = new Date(Date.UTC(f.year, f.month - 1, f.day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: f.minute,
    second: f.second,
  };
}

/** The Tallinn wall-clock fields of a UTC instant. */
function tallinnFields(ms: number): CivilFields {
  const parts = TALLINN_PARTS.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // en-GB renders midnight as "24" in some ICU versions. Normalise the WHOLE civil
  // field-set (date included) to 00:00 the next day, not just the hour (R3-9 / D-2).
  return normalizeCivilMidnight({
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  });
}

/** Tallinn's UTC offset in ms at a given instant (7200000 or 10800000). */
function tallinnOffsetMs(ms: number): number {
  const f = tallinnFields(ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // Round to the second — formatToParts drops sub-second precision.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant of a Tallinn WALL-CLOCK time. Solved by fixed point: guess with the
 * offset at the naive instant, then re-resolve with the offset actually in force at
 * the guess. Two passes settle every real DST case (the offset only ever moves 1h).
 */
export function tallinnWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive - tallinnOffsetMs(naive);
  for (let i = 0; i < 3; i++) {
    const off = tallinnOffsetMs(guess);
    const next = naive - off;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Parse a "YYYY-MM" period key. Throws on anything else — periods are never guessed. */
export function parsePeriod(period: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period ?? ""));
  if (!m) throw new Error(`billing: invalid period "${period}" (expected YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`billing: invalid period "${period}"`);
  return { year, month };
}

/**
 * The half-open UTC range [startMs, endMs) covering the Tallinn calendar month.
 * DST-correct by construction: a 23h day in March and a 25h day in October make the
 * month's length in ms differ from the naive 30×24h.
 */
export function tallinnMonthRange(period: string): { startMs: number; endMs: number } {
  const { year, month } = parsePeriod(period);
  const startMs = tallinnWallClockToUtc(year, month, 1, 0, 0, 0);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs = tallinnWallClockToUtc(nextYear, nextMonth, 1, 0, 0, 0);
  return { startMs, endMs };
}

/** The "YYYY-MM" Tallinn period an instant falls in. */
export function tallinnPeriodOf(ms: number): string {
  const f = tallinnFields(ms);
  return `${f.year}-${String(f.month).padStart(2, "0")}`;
}

/** The "YYYY-MM-DD" Tallinn day key an instant falls in (daily-sweep ledger key). */
export function tallinnDayKey(ms: number): string {
  const f = tallinnFields(ms);
  return `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

/** The Tallinn period immediately BEFORE the one `ms` falls in. */
export function previousTallinnPeriod(ms: number): string {
  const f = tallinnFields(ms);
  const year = f.month === 1 ? f.year - 1 : f.year;
  const month = f.month === 1 ? 12 : f.month - 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

// ---- Grant index (analysis §C.3 recovery chain) --------------------------------

export type GrantIdentity = { agentId: string; seafarerId: string };

/** A pre-delete snapshot row from data/merge-archive.ndjson (lib/delete-archive.ts). */
export type MergeArchiveRow = { accessGrants?: Partial<AccessGrant>[] } & Record<string, unknown>;

/**
 * grantId -> (agentId, seafarerId), recovered in the documented order:
 *   (a) live db.accessGrants rows;
 *   (b) board-events rows — they carry agentId + seafarerId denormalised, which is the
 *       ONLY surviving mapping for a HARD-deleted grant (access.ts:648 erases the row);
 *   (c) merge-archive pre-delete snapshots.
 * Later sources never overwrite an earlier, more authoritative one.
 */
export function buildGrantIndex(
  grants: AccessGrant[],
  boardEvents: BoardEvent[],
  mergeArchiveRows: MergeArchiveRow[] = []
): Map<string, GrantIdentity> {
  const out = new Map<string, GrantIdentity>();
  for (const g of grants ?? []) {
    if (g?.id) out.set(g.id, { agentId: g.agentId, seafarerId: g.seafarerId });
  }
  for (const e of boardEvents ?? []) {
    if (!e?.grantId || out.has(e.grantId)) continue;
    if (e.agentId && e.seafarerId) out.set(e.grantId, { agentId: e.agentId, seafarerId: e.seafarerId });
  }
  for (const row of mergeArchiveRows ?? []) {
    for (const g of row?.accessGrants ?? []) {
      if (!g?.id || out.has(g.id)) continue;
      if (g.agentId && g.seafarerId) out.set(g.id, { agentId: g.agentId, seafarerId: g.seafarerId });
    }
  }
  return out;
}

/**
 * seafarerId -> canonical survivor id after merges (#37, db.ts `mergedFrom`). Two
 * profiles that were merged are ONE billable head. Chains are followed to a fixed
 * point so A→B→C collapses to C.
 */
export function buildMergeCanonicalMap(seafarers: Seafarer[]): Map<string, string> {
  const direct = new Map<string, string>();
  for (const s of seafarers ?? []) {
    for (const absorbed of s.mergedFrom ?? []) {
      if (absorbed && absorbed !== s.id) direct.set(absorbed, s.id);
    }
  }
  const canonical = new Map<string, string>();
  for (const [absorbed] of direct) {
    let cur = absorbed;
    const seen = new Set<string>([cur]);
    while (direct.has(cur)) {
      const next = direct.get(cur) as string;
      if (seen.has(next)) break; // defensive: never loop on a cyclic archive
      seen.add(next);
      cur = next;
    }
    canonical.set(absorbed, cur);
  }
  return canonical;
}

// ---- Interval construction ----------------------------------------------------

/** Consent events that OPEN a billable interval. */
const OPEN_TYPES = new Set(["GRANTED"]);
/** Consent events that CLOSE one. BOARD_HIDDEN/RESTORED are deliberately absent. */
const CLOSE_TYPES = new Set(["WITHDRAWN", "REVOKED_BY_AGENT", "EXPIRED"]);

export type Interval = { start: number; end: number };

export type UsageInputs = {
  grants: AccessGrant[];
  consentEvents: ConsentEvent[];
  boardEvents: BoardEvent[];
  baseline: BillingBaselineRow[];
  seafarers: Seafarer[];
  /**
   * Finding 18 — live/closed voyages, needed to mirror access.ts:103-112 LOCKED
   * semantics: a grant that sails past its `expiresAt` while the seafarer is AT SEA
   * stays readable (expiry is suppressed while locked and resolves only on unlock),
   * so the synthetic expiry close must be deferred to the end of the voyage.
   */
  assignments?: Assignment[];
  mergeArchiveRows?: MergeArchiveRow[];
  /** Per-agent R1-6 clip: usage before this instant is computed but never billable. */
  billingActiveFrom?: Record<string, string | null>;
};

type PairKey = string; // `${agentId} ${seafarerId}`
const pairKey = (agentId: string, seafarerId: string): PairKey => `${agentId} ${seafarerId}`;

type Toggle = { at: number; open: boolean; seq: number };

/**
 * FINDING 18 — when a grant's synthetic expiry close actually takes effect.
 *
 * access.ts:103-112 suppresses EXPIRED while a live assignment makes the grant LOCKED,
 * and the lock resolves only on unlock; the board keeps showing the seafarer, so that
 * time is readable and therefore billable. Mirrored here:
 *   * no voyage spanning the expiry            -> close AT the expiry (unchanged);
 *   * a voyage spanning it that has RETURNED   -> close at the voyage's end (chained,
 *                                                so back-to-back voyages carry through);
 *   * a voyage spanning it still OPEN          -> `null`: leave the interval open
 *                                                (FR1-10a — it bills through windowEnd).
 */
function expiryCloseInstant(
  expiryMs: number,
  assignments: Assignment[] | undefined
): number | null {
  if (!assignments || assignments.length === 0) return expiryMs;
  let cursor = expiryMs;
  // Bounded: each hop consumes one assignment, and `cursor` strictly increases.
  for (let hop = 0; hop <= assignments.length; hop++) {
    let next: number | null = null;
    for (const a of assignments) {
      const start = Date.parse(a.sentToSeaAt ?? "");
      if (!Number.isFinite(start) || start > cursor) continue;
      if (!a.returnedAt) return null; // still at sea — expiry has not resolved yet.
      const end = Date.parse(a.returnedAt);
      if (!Number.isFinite(end) || end <= cursor) continue;
      if (next === null || end > next) next = end;
    }
    if (next === null) return cursor;
    cursor = next;
  }
  return cursor;
}

/**
 * R3-1 (D-1) — the NET open state of a pair at instant `at`.
 *
 * Uses the SAME ordering the interval fold uses, so a close and an open at the same
 * instant leave the pair OPEN (the existing tie-break: an open sorts AFTER a co-instant
 * close). Net state equals the last toggle's polarity in fold order, because open-while-
 * open and close-while-closed are no-ops, so after each toggle `isOpen === t.open`.
 *
 * This replaces the old pair-keyed "is there ANY earlier close?" guard, which suppressed
 * a re-granted pair's synthetic expiry close (grant1 WITHDRAWN, then grant2 sailing past
 * its own expiry) and billed post-expiry days.
 */
function pairOpenAt(list: Toggle[], at: number): boolean {
  const relevant = list
    .filter((t) => t.at <= at)
    .sort((a, b) =>
      a.at === b.at ? (a.open === b.open ? a.seq - b.seq : a.open ? 1 : -1) : a.at - b.at
    );
  let open = false;
  for (const t of relevant) open = t.open; // each toggle sets state to its own polarity
  return open;
}

/**
 * Raw open/close toggles per (agent, seafarer) pair, in the plan's §0.5 vocabulary.
 * `now` bounds still-open intervals. Unresolvable grant ids are reported as warnings
 * and NEVER billed silently.
 */
export type UsageWarning = {
  /** The agency the warning belongs to, or null when it cannot be attributed. */
  agentId: string | null;
  message: string;
};

export function buildIntervals(
  inputs: UsageInputs,
  windowEndMs: number
): { intervals: Map<PairKey, Interval[]>; warnings: UsageWarning[] } {
  // FINDING 23d — warnings are ATTRIBUTED. The engine used to build one flat array and
  // then embed the WHOLE array in every agent's persisted `detail`, so each tenant's
  // ledger row carried every other tenant's warnings (db.json growth, and a small
  // cross-tenant information leak into the admin drill-down).
  const warnings: UsageWarning[] = [];
  const index = buildGrantIndex(inputs.grants, inputs.boardEvents, inputs.mergeArchiveRows);
  const toggles = new Map<PairKey, Toggle[]>();
  let seq = 0;

  // Finding 18 — voyages indexed by (agent, seafarer) so the expiry close below can
  // ask "was this pair at sea when the grant expired?".
  const assignmentsByPair = new Map<PairKey, Assignment[]>();
  for (const a of inputs.assignments ?? []) {
    if (!a?.agentId || !a?.seafarerId) continue;
    const k = pairKey(a.agentId, a.seafarerId);
    const list = assignmentsByPair.get(k);
    if (list) list.push(a);
    else assignmentsByPair.set(k, [a]);
  }

  const push = (agentId: string, seafarerId: string, at: number, open: boolean) => {
    if (!Number.isFinite(at)) return;
    const k = pairKey(agentId, seafarerId);
    const list = toggles.get(k);
    if (list) list.push({ at, open, seq: seq++ });
    else toggles.set(k, [{ at, open, seq: seq++ }]);
  };

  // (1) T0 baseline rows — the go-live snapshot. History before T0 is out of scope.
  for (const b of inputs.baseline ?? []) {
    const at = Date.parse(b.openAt);
    if (Number.isFinite(at)) push(b.agentId, b.seafarerId, at, true);
  }

  // (2) Consent events, joined to a pair through the recovery-chain index.
  const orphanCounts = new Map<string, number>();
  for (const e of inputs.consentEvents ?? []) {
    const isOpen = OPEN_TYPES.has(e.type);
    const isClose = CLOSE_TYPES.has(e.type);
    if (!isOpen && !isClose) continue; // NEUTRAL — see the file header.
    const ident = index.get(e.grantId);
    if (!ident) {
      orphanCounts.set(e.grantId, (orphanCounts.get(e.grantId) ?? 0) + 1);
      continue;
    }
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) push(ident.agentId, ident.seafarerId, at, isOpen);
  }
  for (const [grantId, n] of orphanCounts) {
    // Unattributable BY CONSTRUCTION: the whole point is that no agent could be
    // resolved for this grant. Surfaced once per cron tick in billing-health instead.
    warnings.push({
      agentId: null,
      message: `unresolvable grantId ${grantId} (${n} consent event(s)) — skipped, never billed`,
    });
  }

  // (3) Board deletes. BOTH modes close; the "view" mode ALSO emits a
  // REVOKED_BY_AGENT consent event, and a duplicate close at the same instant is a
  // no-op for the union algebra below — no double-toggle.
  for (const e of inputs.boardEvents ?? []) {
    if (e.action !== "BOARD_DELETED") continue; // HIDDEN / RESTORED are NEUTRAL.
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) push(e.agentId, e.seafarerId, at, false);
  }

  // (4) Defensive grant-level opens and closes.
  for (const g of inputs.grants ?? []) {
    const k = pairKey(g.agentId, g.seafarerId);
    const has = toggles.get(k);
    // (4a) A readable grant whose GRANTED event never made the sink (26/105 locally,
    // analysis §C.1) and that no baseline row covers: open at grantedAt ?? createdAt.
    const hasOpen = (has ?? []).some((t) => t.open);
    // NOTE: "LOCKED" is a DERIVED status (access.ts computes it from live
    // assignments); the persisted base status of an at-sea grant is still "ACTIVE",
    // so this single check covers both readable states.
    if (!hasOpen && g.status === "ACTIVE") {
      const at = Date.parse(g.grantedAt ?? g.createdAt ?? "");
      if (Number.isFinite(at)) {
        push(g.agentId, g.seafarerId, at, true);
        warnings.push({
          agentId: g.agentId,
          message: `grant ${g.id} had no GRANTED event or baseline row — opened at grantedAt ?? createdAt`,
        });
      }
    }
    // (4b) Synthetic close at expiresAt for a grant past expiry with no EXPIRED event
    // (nothing schedules expireDueGrants today — analysis §C).
    //
    // FINDING 18 — the close instant mirrors access.ts:103-112: while the seafarer is
    // AT SEA under this agency the grant is LOCKED, expiry is SUPPRESSED and the
    // dossier stays readable on the board, so that time IS billable. The synthetic
    // close therefore moves to the END of the voyage that spans the expiry. FR1-10a:
    // a voyage with no `returnedAt` at compute time is still OPEN, so the interval is
    // left open (it bills through windowEnd) rather than being closed at a guess.
    if (g.expiresAt) {
      const exp = Date.parse(g.expiresAt);
      if (Number.isFinite(exp) && exp <= windowEndMs) {
        const closeAt = expiryCloseInstant(exp, assignmentsByPair.get(k));
        if (closeAt !== null && closeAt <= windowEndMs) {
          // R3-1 (D-1): only synthesise the expiry close when the pair is actually OPEN
          // at closeAt (net state), not merely because some earlier close exists.
          if (pairOpenAt(toggles.get(k) ?? [], closeAt)) push(g.agentId, g.seafarerId, closeAt, false);
        }
      }
    }
  }

  // Fold toggles into a union of intervals. Duplicate signals at the same instant
  // collapse (a close while closed, or an open while open, is a no-op).
  const intervals = new Map<PairKey, Interval[]>();
  for (const [k, list] of toggles) {
    list.sort((a, b) => (a.at === b.at ? (a.open === b.open ? a.seq - b.seq : a.open ? 1 : -1) : a.at - b.at));
    const out: Interval[] = [];
    let openAt: number | null = null;
    for (const t of list) {
      if (t.open) {
        if (openAt === null) openAt = t.at;
      } else if (openAt !== null) {
        if (t.at > openAt) out.push({ start: openAt, end: t.at });
        openAt = null;
      }
    }
    if (openAt !== null && windowEndMs > openAt) out.push({ start: openAt, end: windowEndMs });
    intervals.set(k, out);
  }
  return { intervals, warnings };
}

/** Total ms of the union of `intervals` clipped to [startMs, endMs). */
export function clippedDurationMs(intervals: Interval[], startMs: number, endMs: number): number {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, startMs), end: Math.min(i.end, endMs) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const i of clipped) {
    if (curStart === null) {
      curStart = i.start;
      curEnd = i.end;
      continue;
    }
    if (i.start <= curEnd) curEnd = Math.max(curEnd, i.end);
    else {
      total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    }
  }
  if (curStart !== null) total += curEnd - curStart;
  return total;
}

/** The billable threshold: >= 24h CUMULATIVE inside the month. */
export const BILLABLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type AgentUsage = {
  agentId: string;
  quantity: number;
  billableSeafarerIds: string[];
  detail: {
    period: string;
    perSeafarerMs: Record<string, number>;
    warnings: string[];
  };
};

/**
 * The month-end metric for EVERY agent present in the inputs, for one Tallinn period.
 * Demo-class agents (R1-7) are excluded outright. Per-agent intervals are additionally
 * clipped to `billingActiveFrom` (R1-6) so an agency is never billed for days that
 * pre-date its own subscription / un-exempt transition.
 */
export function computeMonthlyUsage(
  inputs: UsageInputs,
  period: string,
  onlyAgentId?: string
): Map<string, AgentUsage> {
  return computeMonthlyUsageWithWarnings(inputs, period, onlyAgentId).usage;
}

/**
 * As `computeMonthlyUsage`, plus the warnings that belong to NO agent (finding 23d).
 * The cron surfaces those once per tick in billing-health rather than duplicating them
 * into every tenant's persisted ledger row.
 *
 * `onlyAgentId` (finding 23c) narrows the AGGREGATION to one agency: the billing page
 * and the admin drill-down were paying to fold every other tenant's intervals on every
 * GET. FR1-10c — the filter applies at the PAIR/FOLD stage only, never to the input
 * events, so the answer for that agent is identical to the unfiltered one.
 */
export function computeMonthlyUsageWithWarnings(
  inputs: UsageInputs,
  period: string,
  onlyAgentId?: string
): { usage: Map<string, AgentUsage>; unattributedWarnings: string[] } {
  const { startMs, endMs } = tallinnMonthRange(period);
  const { intervals, warnings } = buildIntervals(inputs, endMs);
  const warningsFor = (agentId: string): string[] =>
    warnings.filter((w) => w.agentId === agentId).map((w) => w.message);
  const unattributedWarnings = warnings.filter((w) => w.agentId === null).map((w) => w.message);
  const canonical = buildMergeCanonicalMap(inputs.seafarers ?? []);
  const activeFrom = inputs.billingActiveFrom ?? {};

  // (agentId -> canonical seafarerId -> accrued ms in the month)
  const perAgent = new Map<string, Map<string, number>>();
  for (const [k, list] of intervals) {
    const sep = k.indexOf(" ");
    const agentId = k.slice(0, sep);
    const rawSeafarerId = k.slice(sep + 1);
    if (isSampleAgentId(agentId)) continue; // R1-7 — demo class never accrues.
    if (onlyAgentId && agentId !== onlyAgentId) continue; // 23c — fold-stage narrowing.

    // R1-6 clip: never bill before the billing relationship started.
    const fromIso = activeFrom[agentId] ?? null;
    const fromMs = fromIso ? Date.parse(fromIso) : NaN;
    const windowStart = Number.isFinite(fromMs) ? Math.max(startMs, fromMs) : startMs;
    if (windowStart >= endMs) continue;

    const ms = clippedDurationMs(list, windowStart, endMs);
    if (ms <= 0) continue;
    const seafarerId = canonical.get(rawSeafarerId) ?? rawSeafarerId;
    let bucket = perAgent.get(agentId);
    if (!bucket) {
      bucket = new Map<string, number>();
      perAgent.set(agentId, bucket);
    }
    // Merged identities are ONE head: the survivor keeps the LONGEST accrual rather
    // than the sum, so a month where both profiles were visible still counts once.
    bucket.set(seafarerId, Math.max(bucket.get(seafarerId) ?? 0, ms));
  }

  const out = new Map<string, AgentUsage>();
  for (const [agentId, bucket] of perAgent) {
    const perSeafarerMs: Record<string, number> = {};
    const billable: string[] = [];
    for (const [seafarerId, ms] of bucket) {
      perSeafarerMs[seafarerId] = ms;
      if (ms >= BILLABLE_THRESHOLD_MS) billable.push(seafarerId);
    }
    billable.sort();
    out.set(agentId, {
      agentId,
      quantity: billable.length,
      billableSeafarerIds: billable,
      // ONLY this agency's warnings (finding 23d).
      detail: { period, perSeafarerMs, warnings: warningsFor(agentId) },
    });
  }
  return { usage: out, unattributedWarnings };
}
