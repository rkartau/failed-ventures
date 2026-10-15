// Sea-service / sea-time rules — client-safe (NO Node built-ins), so the seaman
// dashboard, the agent review panel, the CV builder and (later) the revalidation
// gate all share ONE definition of "how many qualifying days has this seafarer
// served". The records live in lib/db.ts (`seaService`); this module owns ONLY the
// DERIVED logic, so a corrected sign-on date immediately re-flows every total.
//
// Counting model — defensible for STCW/MCA "qualifying sea service":
//   - Each engagement covers sign-on..sign-off INCLUSIVE (both days count), so a
//     one-day-apart on/off is 2 days aboard. An OPEN entry (no sign-off, still
//     onboard) counts up to today.
//   - Overlapping engagements are MERGED before counting, so a double-booked or
//     duplicated row can never inflate the total beyond real calendar days served.
//   - A windowed total (e.g. last 60 months) intersects the merged intervals with
//     the window — the exact input the revalidation-path gate (item 13) needs
//     ("≥360 qualifying days in the last 5 years").

import type { SeaServiceEntry } from "@/lib/db";

const MS_PER_DAY = 86_400_000;

/** Approx. days per year used to phrase a duration ("2y 3m"). */
const DAYS_PER_YEAR = 365.25;

/** Standard revalidation window (STCW/MCA): the last 5 years. */
export const REVALIDATION_WINDOW_MONTHS = 60;

/** Qualifying-days threshold for the cheaper revalidation path (item 13/T2.3). */
export const REVALIDATION_QUALIFYING_DAYS = 360;

// Normalise any date-ish value to a YYYY-MM-DD key, or "" when unparseable.
export function serviceDateKey(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// UTC midnight epoch for a YYYY-MM-DD key. NaN when the key is invalid.
function dayEpoch(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

// Today's YYYY-MM-DD in UTC — the "count an open engagement up to" boundary.
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The [start, end] day-epoch span an entry covers, or null when it can't count
 * (bad/missing sign-on, or a sign-off strictly before sign-on). An open entry
 * (no sign-off) ends at `now`. `end` is the INCLUSIVE last day, so day-count adds one.
 */
function spanOf(
  entry: Pick<SeaServiceEntry, "signOn" | "signOff">,
  now: Date
): { start: number; end: number } | null {
  const onKey = serviceDateKey(entry.signOn);
  if (!onKey) return null;
  const start = dayEpoch(onKey);
  if (isNaN(start)) return null;
  const offKey = entry.signOff ? serviceDateKey(entry.signOff) : todayKey(now);
  const rawEnd = offKey ? dayEpoch(offKey) : NaN;
  // Missing/invalid sign-off on a closed entry can't be counted.
  if (isNaN(rawEnd)) return null;
  // Clamp an open engagement's end to today (a future sign-on counts 0, not negative).
  const nowEpoch = dayEpoch(todayKey(now));
  const end = entry.signOff ? rawEnd : Math.min(rawEnd, nowEpoch);
  if (end < start) return null;
  return { start, end };
}

/** Inclusive day-count of ONE engagement (0 when it can't be counted). */
export function entryDays(
  entry: Pick<SeaServiceEntry, "signOn" | "signOff">,
  now: Date = new Date()
): number {
  const s = spanOf(entry, now);
  if (!s) return 0;
  return Math.round((s.end - s.start) / MS_PER_DAY) + 1;
}

/** True while an engagement is still open (no sign-off recorded). */
export function isOnboard(entry: Pick<SeaServiceEntry, "signOff">): boolean {
  return !entry.signOff || serviceDateKey(entry.signOff) === "";
}

// Merge overlapping/adjacent inclusive day-spans so shared calendar days are counted
// once. Two spans that touch or overlap (gap ≤ 1 day) collapse into one.
function mergeSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    // Overlap or contiguous (next starts within one day of last end) → extend.
    if (cur.start <= last.end + MS_PER_DAY) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// Inclusive days across a set of merged spans.
function daysOfMerged(merged: { start: number; end: number }[]): number {
  let days = 0;
  for (const s of merged) days += Math.round((s.end - s.start) / MS_PER_DAY) + 1;
  return days;
}

/** Total qualifying sea days across all entries, overlaps merged (never double-counted). */
export function totalSeaDays(entries: SeaServiceEntry[], now: Date = new Date()): number {
  const spans = entries
    .map((e) => spanOf(e, now))
    .filter((s): s is { start: number; end: number } => s !== null);
  return daysOfMerged(mergeSpans(spans));
}

/**
 * Qualifying sea days that fall inside the last `months` months (default: the
 * 5-year revalidation window). Merged first, then intersected with the window, so
 * the figure is the real calendar days served in-window — the revalidation gate's
 * exact input.
 */
export function qualifyingDaysInWindow(
  entries: SeaServiceEntry[],
  months: number = REVALIDATION_WINDOW_MONTHS,
  now: Date = new Date()
): number {
  const end = dayEpoch(todayKey(now));
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - months);
  const start = dayEpoch(from.toISOString().slice(0, 10));
  if (isNaN(start) || isNaN(end)) return 0;
  const clipped: { start: number; end: number }[] = [];
  for (const e of entries) {
    const s = spanOf(e, now);
    if (!s) continue;
    const cs = Math.max(s.start, start);
    const ce = Math.min(s.end, end);
    if (ce >= cs) clipped.push({ start: cs, end: ce });
  }
  return daysOfMerged(mergeSpans(clipped));
}

/** Phrase a day-count as "2y 3m 5d" (drops zero leading units; "0d" when empty). */
export function formatDuration(days: number): string {
  if (!days || days <= 0) return "0d";
  const years = Math.floor(days / DAYS_PER_YEAR);
  let rem = days - Math.floor(years * DAYS_PER_YEAR);
  const months = Math.floor(rem / 30);
  rem = rem - months * 30;
  const parts: string[] = [];
  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}m`);
  if (rem || parts.length === 0) parts.push(`${rem}d`);
  return parts.join(" ");
}

export type SeaServiceSummary = {
  entryCount: number;
  /** Total merged qualifying days across the whole ledger. */
  totalDays: number;
  /** Qualifying days inside the 5-year revalidation window. */
  last5yDays: number;
  /** Whether the seafarer is currently signed on to at least one vessel. */
  onboard: boolean;
  /** The vessel of the most recent (by sign-on) engagement, if any. */
  latestVessel: string | null;
  /** True when last-5y service clears the cheap-revalidation threshold. */
  meetsRevalidation: boolean;
};

/** Roster/dashboard summary of a seafarer's sea service. */
export function summarizeSeaService(
  entries: SeaServiceEntry[],
  now: Date = new Date()
): SeaServiceSummary {
  const last5yDays = qualifyingDaysInWindow(entries, REVALIDATION_WINDOW_MONTHS, now);
  const latest = sortForDisplay(entries)[0] ?? null;
  return {
    entryCount: entries.length,
    totalDays: totalSeaDays(entries, now),
    last5yDays,
    onboard: entries.some((e) => isOnboard(e)),
    latestVessel: latest ? latest.vessel : null,
    meetsRevalidation: last5yDays >= REVALIDATION_QUALIFYING_DAYS,
  };
}

/**
 * Display order: currently-onboard engagements first, then by sign-on date newest
 * first (a stable createdAt tiebreak keeps same-day rows deterministic).
 */
export function sortForDisplay(entries: SeaServiceEntry[]): SeaServiceEntry[] {
  return entries.slice().sort((a, b) => {
    const ao = isOnboard(a) ? 0 : 1;
    const bo = isOnboard(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ak = serviceDateKey(a.signOn);
    const bk = serviceDateKey(b.signOn);
    if (ak !== bk) return bk.localeCompare(ak);
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}
