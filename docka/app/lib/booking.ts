// "Book a call" — the pure booking-math engine.
//
// Wave-1 foundation (docka-booking-plan.md §A, R1/R2/R6/R8/R10). Everything here
// is a PURE function: no `fs`, no `readDB`, no `Date.now()` reached for internally.
// Callers pass `settings` / `bookings` / `now` explicitly so every branch is unit
// testable with a fixed clock.
//
// TIMEZONE CONTRACT (R6): the ONLY clock primitive is `businessNowParts()`, which
// formats an absolute instant INTO the business timezone with `Intl.DateTimeFormat`.
// Slot generation, availability and double-booking then compare Tallinn wall-clock
// TUPLES `(date, time)` as zero-padded strings — never a JS `Date` epoch — so there
// is no wall-clock->instant math and therefore no DST landmine. `new Date(...)` is
// used ONLY for date-ONLY calendar arithmetic via `Date.UTC` (day-of-week, add-days,
// day-diff), which is unambiguous because a bare calendar date carries no offset.

import type { Booking, BookingSettings, DB } from "@/lib/db";

// ---- Defaults + policy ------------------------------------------------

/**
 * Singleton defaults used whenever no valid settings are stored: Europe/Tallinn,
 * 30-minute slots, a 21-day booking horizon, Mon–Fri 09:00–17:00, weekend closed.
 * `weekly` keys are day-of-week 0..6 (0 = Sunday).
 */
export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  timezone: "Europe/Tallinn",
  slotMinutes: 30,
  horizonDays: 21,
  weekly: {
    0: null, // Sunday
    1: { start: "09:00", end: "17:00" },
    2: { start: "09:00", end: "17:00" },
    3: { start: "09:00", end: "17:00" },
    4: { start: "09:00", end: "17:00" },
    5: { start: "09:00", end: "17:00" },
    6: null, // Saturday
  },
};

/**
 * Curated IANA timezone allowlist (R1): a valid-but-nonsense zone can never be
 * saved. Kept small on purpose — docka operates from the Baltics/EU.
 */
export const ALLOWED_TIMEZONES = [
  "Europe/Tallinn",
  "Europe/Helsinki",
  "Europe/Riga",
  "Europe/London",
  "UTC",
] as const;

/** HH:MM restricted to a 15-minute grid — the admin-editable window resolution (R1). */
const SETTINGS_TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
/** HH:MM well-formedness (any valid minute) — used to validate an incoming slot time. */
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** YYYY-MM-DD well-formedness. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Business hours must lie fully within this window so they never straddle the
 * EU 03:00/04:00 DST transition (R1). */
const WINDOW_MIN = "06:00";
const WINDOW_MAX = "20:00";

/** Retention window for compaction (R10): past booked rows older than this are dropped. */
const RETENTION_DAYS = 90;

// ---- Small date/time helpers (pure, no tz) ----------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "HH:MM" -> minutes since midnight. Assumes a well-formed input. */
function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(":").map((x) => Number(x));
  return h * 60 + m;
}

/** minutes since midnight -> "HH:MM" (zero-padded). */
function minutesToHHMM(mins: number): string {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

/** Parse a "YYYY-MM-DD" calendar date to a UTC-midnight epoch (date-only math). */
function dateToUTC(dateStr: string): number {
  const [y, mo, d] = dateStr.split("-").map((x) => Number(x));
  return Date.UTC(y, mo - 1, d);
}

/** True if `dateStr` is a REAL calendar date (round-trips through Date.UTC). */
function isRealDate(dateStr: string): boolean {
  if (!DATE_RE.test(dateStr)) return false;
  const [y, mo, d] = dateStr.split("-").map((x) => Number(x));
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

/** Day-of-week (0=Sunday..6=Saturday) of a calendar date string — tz-independent. */
function weekdayOf(dateStr: string): number {
  return new Date(dateToUTC(dateStr)).getUTCDay();
}

/** `dateStr` + `days` as a new "YYYY-MM-DD" string (UTC calendar arithmetic). */
function addDays(dateStr: string, days: number): string {
  const dt = new Date(dateToUTC(dateStr) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole-day difference `a - b` between two calendar date strings. */
function dayDiff(a: string, b: string): number {
  return Math.round((dateToUTC(a) - dateToUTC(b)) / 86_400_000);
}

// ---- Settings validation + coercion -----------------------------------

/**
 * R1 authoritative settings validation for the admin write path. Returns a
 * normalized settings object on success, or a clear error string on the FIRST
 * failure. Never throws.
 */
export function validateSettings(
  s: unknown
): { ok: true; settings: BookingSettings } | { ok: false; error: string } {
  if (!s || typeof s !== "object") return { ok: false, error: "settings must be an object" };
  const o = s as Record<string, unknown>;

  const timezone = o.timezone;
  if (typeof timezone !== "string" || !(ALLOWED_TIMEZONES as readonly string[]).includes(timezone)) {
    return { ok: false, error: `timezone must be one of: ${ALLOWED_TIMEZONES.join(", ")}` };
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { ok: false, error: `invalid timezone: ${timezone}` };
  }

  const slotMinutes = o.slotMinutes;
  if (slotMinutes !== 15 && slotMinutes !== 30 && slotMinutes !== 60) {
    return { ok: false, error: "slotMinutes must be one of 15, 30, 60" };
  }

  const horizonDays = o.horizonDays;
  if (
    typeof horizonDays !== "number" ||
    !Number.isInteger(horizonDays) ||
    horizonDays < 1 ||
    horizonDays > 60
  ) {
    return { ok: false, error: "horizonDays must be an integer between 1 and 60" };
  }

  const weekly = o.weekly;
  if (!weekly || typeof weekly !== "object") {
    return { ok: false, error: "weekly must be an object keyed by weekday 0..6" };
  }
  const w = weekly as Record<string, unknown>;
  const normalizedWeekly: Record<number, { start: string; end: string } | null> = {};
  for (let d = 0; d <= 6; d++) {
    const entry = w[d];
    if (entry === null || entry === undefined) {
      normalizedWeekly[d] = null;
      continue;
    }
    if (typeof entry !== "object") {
      return { ok: false, error: `weekly[${d}] must be null or { start, end }` };
    }
    const e = entry as Record<string, unknown>;
    const start = e.start;
    const end = e.end;
    if (typeof start !== "string" || !SETTINGS_TIME_RE.test(start)) {
      return { ok: false, error: `weekly[${d}].start must be HH:MM on a 15-minute boundary` };
    }
    if (typeof end !== "string" || !SETTINGS_TIME_RE.test(end)) {
      return { ok: false, error: `weekly[${d}].end must be HH:MM on a 15-minute boundary` };
    }
    if (!(start < end)) {
      return { ok: false, error: `weekly[${d}].start must be earlier than end` };
    }
    if (start < WINDOW_MIN || end > WINDOW_MAX) {
      return { ok: false, error: `weekly[${d}] must lie within ${WINDOW_MIN}..${WINDOW_MAX}` };
    }
    normalizedWeekly[d] = { start, end };
  }

  return {
    ok: true,
    settings: { timezone, slotMinutes, horizonDays, weekly: normalizedWeekly },
  };
}

/**
 * Returns valid stored settings, else the defaults. NEVER throws — a corrupt or
 * absent settings blob must never brick the public page (R1). Note: this uses the
 * strict `validateSettings` gate, so a stored blob that violates admin policy
 * (off-grid window, out-of-range horizon) is treated as absent and replaced by the
 * defaults.
 */
export function getBookingSettings(db: Pick<DB, "bookingSettings"> | null | undefined): BookingSettings {
  try {
    const v = validateSettings(db?.bookingSettings);
    if (v.ok) return v.settings;
  } catch {
    /* never throw — fall through to defaults */
  }
  return DEFAULT_BOOKING_SETTINGS;
}

/**
 * Structural-only coercion used by the SLOT MATH (`generateSlots`/`isSlotValid`).
 * Unlike `validateSettings` (the admin write gate), this trusts stored window
 * values and only replaces settings that are structurally unusable (bad shape,
 * unusable timezone, non-positive slot length, missing weekly map) with the
 * defaults — so a legacy/corrupt blob degrades to defaults instead of throwing,
 * while a merely off-policy-but-usable blob is still honoured. Generation and the
 * server-side gate share this so a slot one emits is exactly one the other accepts.
 */
function usableSettings(s: unknown): BookingSettings {
  try {
    if (!s || typeof s !== "object") return DEFAULT_BOOKING_SETTINGS;
    const o = s as Record<string, unknown>;
    if (typeof o.timezone !== "string") return DEFAULT_BOOKING_SETTINGS;
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat("en-CA", { timeZone: o.timezone });
    } catch {
      return DEFAULT_BOOKING_SETTINGS;
    }
    if (typeof o.slotMinutes !== "number" || !(o.slotMinutes > 0)) return DEFAULT_BOOKING_SETTINGS;
    if (typeof o.horizonDays !== "number" || !Number.isInteger(o.horizonDays) || o.horizonDays < 1) {
      return DEFAULT_BOOKING_SETTINGS;
    }
    if (!o.weekly || typeof o.weekly !== "object") return DEFAULT_BOOKING_SETTINGS;
    return o as BookingSettings;
  } catch {
    return DEFAULT_BOOKING_SETTINGS;
  }
}

// ---- The single clock primitive (R6) ----------------------------------

/**
 * Format an absolute instant `now` INTO the business timezone `tz`, returning the
 * Tallinn (etc.) wall-clock as `{ date: "YYYY-MM-DD", time: "HH:MM" }`. This is the
 * ONLY place an instant meets a timezone; everything else compares the returned
 * strings. Fully DST-correct (Intl does the offset). The `en-CA` locale yields
 * ISO-ish `YYYY-MM-DD`; the `hour:"24"` midnight edge is normalized to `"00"`.
 */
export function businessNowParts(tz: string, now: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // en-CA can emit "24" at midnight
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

// ---- Availability generation + the server-side gate -------------------

/**
 * Generate every OPEN slot over `[today, today+horizonDays)` in chronological
 * order. For each enabled weekday, slots step by `slotMinutes` within
 * `[start, end)` END-EXCLUSIVE — a slot is emitted only if it fits fully before
 * `end`, so a window not divisible by `slotMinutes` drops the trailing partial
 * slot (R8). Excludes any slot not STRICTLY after the business-now wall-clock, and
 * any slot already taken by a `status === "booked"` booking at the same
 * `(date, time)` (a cancelled booking frees the slot — R4). Never throws (R1).
 * Caller groups the flat list by `date`.
 */
export function generateSlots(
  settings: BookingSettings,
  bookings: Booking[],
  now: Date
): Array<{ date: string; time: string; tz: string }> {
  try {
    const cfg = usableSettings(settings);
    const nowParts = businessNowParts(cfg.timezone, now);
    const today = nowParts.date;

    // Set of (date,time) taken by a LIVE booking — cancelled rows do not block.
    const taken = new Set<string>();
    for (const b of bookings ?? []) {
      if (b && b.status === "booked") taken.add(`${b.date} ${b.time}`);
    }

    const out: Array<{ date: string; time: string; tz: string }> = [];
    for (let i = 0; i < cfg.horizonDays; i++) {
      const date = addDays(today, i);
      const win = cfg.weekly[weekdayOf(date)];
      if (!win) continue;
      const startMin = hhmmToMinutes(win.start);
      const endMin = hhmmToMinutes(win.end);
      for (let t = startMin; t + cfg.slotMinutes <= endMin; t += cfg.slotMinutes) {
        const time = minutesToHHMM(t);
        // Strictly after business-now (compare wall-clock tuples as strings).
        if (date === today && !(time > nowParts.time)) continue;
        if (date < today) continue; // defensive; addDays(today, i>=0) never yields this
        if (taken.has(`${date} ${time}`)) continue;
        out.push({ date, time, tz: cfg.timezone });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The AUTHORITATIVE server-side gate (Wave-2 API calls this before writing).
 * Returns true ONLY if ALL hold (R2):
 *  1. `date` is a real YYYY-MM-DD and `time` is a well-formed HH:MM;
 *  2. the weekday of `date` is enabled;
 *  3. `time` sits exactly on a `slotMinutes` boundary within `[start, end)` (the
 *     same end-exclusive fit rule as generation);
 *  4. `date` is within `[today, today+horizonDays)` in the business tz;
 *  5. the slot is STRICTLY after the business-now wall-clock;
 *  6. the slot is not already taken by a `status === "booked"` booking.
 * Never throws — any unexpected input yields false.
 */
export function isSlotValid(
  settings: BookingSettings,
  bookings: Booking[],
  date: string,
  time: string,
  now: Date
): boolean {
  try {
    if (typeof date !== "string" || !isRealDate(date)) return false;
    if (typeof time !== "string" || !HHMM_RE.test(time)) return false;

    const cfg = usableSettings(settings);

    // (2) weekday enabled
    const win = cfg.weekly[weekdayOf(date)];
    if (!win) return false;

    // (3) exactly on-grid within [start, end) end-exclusive
    const startMin = hhmmToMinutes(win.start);
    const endMin = hhmmToMinutes(win.end);
    const t = hhmmToMinutes(time);
    if (t < startMin) return false;
    if (t + cfg.slotMinutes > endMin) return false;
    if ((t - startMin) % cfg.slotMinutes !== 0) return false;

    // (4) within horizon
    const nowParts = businessNowParts(cfg.timezone, now);
    const idx = dayDiff(date, nowParts.date);
    if (idx < 0 || idx >= cfg.horizonDays) return false;

    // (5) strictly after now (wall-clock tuple compare)
    if (!(date > nowParts.date || (date === nowParts.date && time > nowParts.time))) return false;

    // (6) not already taken by a LIVE booking
    for (const b of bookings ?? []) {
      if (b && b.status === "booked" && b.date === date && b.time === time) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Two-way availability: pure busy filter (PLAN v7/v8) --------------

/**
 * Drop any slot whose `[start, start+slotMinutes)` wall-clock interval OVERLAPS any
 * Google-busy range (two-way availability). Overlap is END-EXCLUSIVE:
 *   `slotStart < busyEnd && slotEnd > busyStart`
 * and compares FULL `${date}T${time}` sortable timestamps (NOT time-of-day), so a busy
 * event on day 1 can never remove the same clock-time slot on day 2 (AV8-5). Busy ranges
 * are business-tz wall timestamps (`YYYY-MM-DDTHH:MM`) produced by the calendar module.
 * Pure + deterministic: an empty/absent range list returns the slots unchanged.
 */
export function excludeBusySlots(
  slots: Array<{ date: string; time: string; tz: string }>,
  busyWallRanges: Array<{ startWall: string; endWall: string }>,
  slotMinutes: number
): Array<{ date: string; time: string; tz: string }> {
  const ranges = Array.isArray(busyWallRanges) ? busyWallRanges : [];
  const list = Array.isArray(slots) ? slots : [];
  if (ranges.length === 0) return list;
  return list.filter((s) => {
    const start = `${s.date}T${s.time}`;
    // End timestamp via minute->hour->day carry (reuses this module's wall-clock math;
    // no cross-import of the calendar module, so booking.ts stays dependency-light).
    const total = hhmmToMinutes(s.time) + slotMinutes;
    const dayCarry = Math.floor(total / 1440);
    const minsInDay = ((total % 1440) + 1440) % 1440;
    const endDate = dayCarry === 0 ? s.date : addDays(s.date, dayCarry);
    const end = `${endDate}T${minutesToHHMM(minsInDay)}`;
    for (const r of ranges) {
      if (!r) continue;
      if (start < r.endWall && end > r.startWall) return false; // overlap -> drop
    }
    return true;
  });
}

// ---- Outreach attribution (book?lead=<send_key>) ----------------------

/**
 * The ONE shared send_key contract (see book-a-call-outreach-plan §A1/Wave E):
 * `LD` + a zero-padded (≥5-digit) monotonic integer, generated pipeline-side as
 * `f"LD{next_id:05d}"`. `^LD\d{1,15}$` is a strict SUPERSET that accepts every
 * real key (5–15 digits) and can only reject an absurd >15-digit key the generator
 * cannot produce — so it never drops a genuine key to source:"public". Strict
 * enough that no HTML/script/quote/space/SQLi payload survives (defense-in-depth;
 * React also escapes on render). Total length ≤17 chars.
 */
export const LEAD_KEY_RE = /^LD\d{1,15}$/;

/**
 * Coerce an unknown value into a valid outreach lead key, or `undefined` when it
 * does not match the contract. PURE — no DB/network/clock. Never throws: a
 * malformed value is dropped (the booking still records as source:"public"),
 * because attribution must never block a real booking. Used by BOTH the /book
 * server page and the /api/book route (the server re-sanitizes, never trusting the
 * client).
 */
export function sanitizeLeadKey(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return LEAD_KEY_RE.test(v) ? v : undefined;
}

/**
 * Select a lead key from a Next.js `searchParams.lead` value. For the array form
 * (`?lead=&lead=LD00001` or `?lead=LD00001&lead=LD00002`) pick the FIRST element
 * that sanitizes to a valid key — never blindly element [0], so an empty/whitespace/
 * invalid first element is skipped. Scalar form sanitizes directly. Returns
 * `undefined` when nothing sanitizes. PURE, never throws.
 */
export function pickLeadKey(lead: string | string[] | undefined): string | undefined {
  if (Array.isArray(lead)) {
    for (const candidate of lead) {
      const key = sanitizeLeadKey(candidate);
      if (key) return key;
    }
    return undefined;
  }
  return sanitizeLeadKey(lead);
}

// ---- Retention / compaction (R10) -------------------------------------

/**
 * Return a NEW array with stale rows removed so db.json growth stays bounded:
 * every `status === "cancelled"` row is dropped, and every past `booked` (or other)
 * row whose `date` is older than the 90-day retention window is dropped. Everything
 * else (future rows, recent rows) is kept. Pure — the Wave-2 booking mutator calls
 * this INSIDE its own `updateDB` critical section before writing (it is deliberately
 * NOT wired into `updateDB` globally). The retention cutoff uses a UTC date-diff of
 * each row's `date` against `now`'s UTC calendar date.
 */
export function compactBookings(bookings: Booking[], now: Date): Booking[] {
  const list = Array.isArray(bookings) ? bookings : [];
  const todayUTC = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  return list.filter((b) => {
    if (!b) return false;
    if (b.status === "cancelled") return false;
    if (typeof b.date !== "string" || !isRealDate(b.date)) return true; // keep unparseable rows
    // Drop rows whose date is more than RETENTION_DAYS in the past.
    if (dayDiff(todayUTC, b.date) > RETENTION_DAYS) return false;
    return true;
  });
}
