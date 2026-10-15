// Shared, dependency-free, client-safe logic for the "Expiry reminders" feature.
//
// Both the seaman page (to preview which documents get reminders and how many) and
// the owner-scoped .ics route (to emit the calendar) import from here, so the client
// preview and the downloaded calendar can never disagree.
//
// All date maths is done in UTC-midnight so the SERVER (any timezone) and the browser
// agree on the calendar day of every reminder — reminders are ALL-DAY events, so only
// the Y-M-D matters, never a wall-clock instant.

export type ReminderUnit = "months" | "weeks" | "days";

export type ReminderSettings = {
  /** First-reminder lead value, paired with the unit (e.g. 3 in "3 months before"). */
  leadValue: number;
  leadUnit: ReminderUnit;
  /** How many scheduled reminders to emit per document. */
  count: number;
  /** Repeat interval between reminders, in days. */
  intervalDays: number;
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  leadValue: 1,
  leadUnit: "months",
  count: 3,
  intervalDays: 14,
};

/** Inclusive UI bounds — also the server-side clamp, so a crafted payload can't explode the calendar. */
export const REMINDER_BOUNDS = {
  leadValue: { min: 1, max: 12 },
  count: { min: 1, max: 10 },
  intervalDays: { min: 1, max: 365 },
} as const;

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Coerce any (possibly partial / hostile) input into safe, bounded settings. */
export function normalizeReminderSettings(raw: Partial<ReminderSettings> | null | undefined): ReminderSettings {
  const r = raw ?? {};
  return {
    leadValue: clampInt(r.leadValue, REMINDER_BOUNDS.leadValue.min, REMINDER_BOUNDS.leadValue.max, DEFAULT_REMINDER_SETTINGS.leadValue),
    leadUnit: r.leadUnit === "weeks" || r.leadUnit === "days" ? r.leadUnit : "months",
    count: clampInt(r.count, REMINDER_BOUNDS.count.min, REMINDER_BOUNDS.count.max, DEFAULT_REMINDER_SETTINGS.count),
    intervalDays: clampInt(
      r.intervalDays,
      REMINDER_BOUNDS.intervalDays.min,
      REMINDER_BOUNDS.intervalDays.max,
      DEFAULT_REMINDER_SETTINGS.intervalDays
    ),
  };
}

/** Pull the reminder settings off a seafarer-shaped object (with legacy-safe defaults). */
export function settingsFromSeafarer(s: {
  reminderLeadValue?: number;
  reminderLeadUnit?: ReminderUnit;
  reminderCount?: number;
  reminderIntervalDays?: number;
}): ReminderSettings {
  return normalizeReminderSettings({
    leadValue: s.reminderLeadValue,
    leadUnit: s.reminderLeadUnit,
    count: s.reminderCount,
    intervalDays: s.reminderIntervalDays,
  });
}

/** Parse an ISO instant / date string to a UTC-midnight Date on its calendar day. */
function parseDateUTC(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, d));
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return null;
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function todayUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function applyLeadUTC(expiry: Date, s: ReminderSettings): Date {
  const d = new Date(expiry.getTime());
  if (s.leadUnit === "months") d.setUTCMonth(d.getUTCMonth() - s.leadValue);
  else if (s.leadUnit === "weeks") d.setUTCDate(d.getUTCDate() - s.leadValue * 7);
  else d.setUTCDate(d.getUTCDate() - s.leadValue);
  return d;
}

/**
 * Compute the reminder dates for ONE document's expiry, per the owner's settings.
 *
 * The schedule: firstReminder = (expiry − lead), then repeating every `intervalDays`
 * up to `count` times, never past the expiry day, PLUS one reminder on the expiry day
 * itself.
 *
 * "NOW IS THE TIME" rule: a computed reminder date that already lies in the PAST is
 * NOT dropped — it is CLAMPED to today, so a document already inside its reminder
 * window is reminded immediately, and any still-future reminders keep coming as the
 * expiry nears. (Multiple past dates collapse to a single "today" reminder.)
 *
 * Returns UTC-midnight Dates, de-duplicated and ascending.
 */
export function computeReminderDates(
  expiryIso: string | null | undefined,
  settingsRaw: Partial<ReminderSettings> | null | undefined,
  now: Date = new Date()
): Date[] {
  const s = normalizeReminderSettings(settingsRaw);
  const expiry = parseDateUTC(expiryIso);
  if (!expiry) return [];

  const base = applyLeadUTC(expiry, s);
  const candidates: number[] = [];
  for (let i = 0; i < s.count; i++) {
    const d = addDaysUTC(base, i * s.intervalDays);
    if (d.getTime() > expiry.getTime()) break; // never schedule past the expiry day
    candidates.push(d.getTime());
  }
  // Always include a reminder on/just before the expiry day itself.
  candidates.push(expiry.getTime());

  const today = todayUTC(now).getTime();
  // Clamp any past date to today (remind NOW) rather than skipping it.
  const clamped = candidates.map((t) => (t < today ? today : t));
  return Array.from(new Set(clamped))
    .sort((a, b) => a - b)
    .map((t) => new Date(t));
}

/**
 * Does this document carry an expiry date we trust enough to remind on? Government
 * docs always do; a photo/manual doc only once the seaman CONFIRMED the date. Archived
 * (retired) docs never get reminders.
 */
export function docHasReminderExpiry(doc: {
  validUntil?: string | null;
  expiryConfirmed?: boolean;
  source?: string;
  archived?: boolean;
  noExpiry?: boolean;
}): boolean {
  if (doc.archived) return false;
  // Feature 3: a perpetual (no-expiry) document has nothing to remind about — this
  // gate is the single choke point every reminder path (.ics calendar, cron, and
  // the seafarer-page preview) runs through, so guarding here suppresses reminders
  // for a no-expiry doc everywhere, even if a stray future date is ever present.
  if (doc.noExpiry === true) return false;
  if (!doc.validUntil) return false;
  if (doc.source === "government") return true;
  return doc.expiryConfirmed === true;
}

/** Format a UTC-midnight Date as an iCalendar DATE value (YYYYMMDD). */
export function icsDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Human-readable "human" summary of the current settings, e.g. "1 month before". */
export function describeLead(s: ReminderSettings): string {
  const unit = s.leadValue === 1 ? s.leadUnit.replace(/s$/, "") : s.leadUnit;
  return `${s.leadValue} ${unit} before`;
}
