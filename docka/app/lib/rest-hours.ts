// STCW A-VIII/1 + MLC 2006 (Std A2.3) rest-hours evaluation — client-safe (no
// Node built-ins) so both the server export/dossier routes and the review UI can
// share ONE rule.
//
// A PSC/MLC inspector asks for a rest-hours record on the spot and expects the
// ILO work/rest limits highlighted. The two headline numeric limits are:
//   - at least 10 hours of rest in any 24-hour period, and
//   - at least 77 hours of rest in any 7-day period.
// We model one total-rest figure per calendar day (the granularity a crewing
// office keeps) and flag any day under 10h, and any rolling 7-day window under
// 77h. (The sub-day "no more than two rest periods / one ≥6h / ≤14h interval"
// rule needs hour-level logs and is out of scope of this daily model.)

export const MIN_REST_24H = 10;
export const MIN_REST_7D = 77;
export const MAX_REST_PER_DAY = 24;

export type RestHourDay = {
  date: string; // YYYY-MM-DD
  hoursRest: number;
  /** Rolling sum of rest hours over this day + the previous 6 calendar days. */
  rest7d: number;
  /** How many of the 7 days in that window actually carry a logged entry. */
  daysIn7dWindow: number;
  violations: string[];
};

export type RestHourReport = {
  days: RestHourDay[];
  violationCount: number;
  compliant: boolean;
  /** Total rest hours logged across all days. */
  totalRest: number;
  entryCount: number;
};

// Normalise a date value to a YYYY-MM-DD key.
export function restDateKey(v: string): string {
  const s = (v ?? "").trim();
  // Already a plain date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

function dayDiff(aKey: string, bKey: string): number {
  const a = Date.parse(`${aKey}T00:00:00Z`);
  const b = Date.parse(`${bKey}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.round((a - b) / 86_400_000);
}

export type RestHourEntryLike = { date: string; hoursRest: number };

// Evaluate a seafarer's rest-hour log against the ILO limits. Entries may arrive
// unsorted or with duplicate dates (last write per date wins).
export function evaluateRestHours(entries: RestHourEntryLike[]): RestHourReport {
  // Collapse to one figure per calendar day (latest wins), then sort ascending.
  const byDate = new Map<string, number>();
  for (const e of entries) {
    const key = restDateKey(e.date);
    const h = Number(e.hoursRest);
    if (!key || isNaN(h)) continue;
    byDate.set(key, Math.max(0, Math.min(MAX_REST_PER_DAY, h)));
  }
  const sorted = [...byDate.entries()]
    .map(([date, hoursRest]) => ({ date, hoursRest }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const days: RestHourDay[] = [];
  let violationCount = 0;
  let totalRest = 0;

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    totalRest += cur.hoursRest;
    // Rolling 7-day window ending on this day.
    let rest7d = 0;
    let daysIn7dWindow = 0;
    for (let j = i; j >= 0; j--) {
      const d = dayDiff(cur.date, sorted[j].date);
      if (d < 0 || d > 6) {
        if (d > 6) break; // older than the window; earlier ones only older
        continue;
      }
      rest7d += sorted[j].hoursRest;
      daysIn7dWindow++;
    }
    const violations: string[] = [];
    if (cur.hoursRest < MIN_REST_24H) {
      violations.push(`Only ${cur.hoursRest}h rest in 24h — below ${MIN_REST_24H}h (MLC A2.3)`);
    }
    // Only flag the 7-day limit once a full week of data ends on this day, so a
    // sparse log doesn't produce phantom violations.
    if (daysIn7dWindow >= 7 && rest7d < MIN_REST_7D) {
      violations.push(`Only ${rest7d}h rest in 7 days — below ${MIN_REST_7D}h (MLC A2.3)`);
    }
    if (violations.length) violationCount += violations.length;
    days.push({ date: cur.date, hoursRest: cur.hoursRest, rest7d, daysIn7dWindow, violations });
  }

  return {
    days,
    violationCount,
    compliant: violationCount === 0,
    totalRest,
    entryCount: sorted.length,
  };
}
