// Unit tests for lib/booking.ts (docka-booking-plan.md §J, R6/R8/R11/R12) — the pure
// booking-math engine: settings validation, the single Intl clock primitive, slot
// generation (end-exclusive windows, past/booked exclusion, horizon), the server-side
// gate, and retention compaction.
//
// Runs the REAL module (Node strips the types; tests/_register-alias.mjs resolves the
// `@/` alias). booking.ts imports ONLY TYPES from @/lib/db, so this test never touches
// the JSON store / fs — no temp dir or chdir needed.
//
// FIXED TEST CLOCK (R11): every `now` is a specific UTC epoch instant, then formatted
// THROUGH the Tallinn formatter inside the module — never a local `Date` — so the test
// cannot inherit the tz ambiguity it is checking. 2026-08-24 is a Monday; in Tallinn
// summer (UTC+3) 06:00Z == 09:00 wall-clock.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_BOOKING_SETTINGS,
  ALLOWED_TIMEZONES,
  validateSettings,
  getBookingSettings,
  businessNowParts,
  generateSlots,
  isSlotValid,
  compactBookings,
} = await import("@/lib/booking");

// ---- helpers ----------------------------------------------------------

/** Times (HH:MM) of the generated slots that fall on a given date, in order. */
function timesOn(slots, date) {
  return slots.filter((s) => s.date === date).map((s) => s.time);
}

/** A weekly map with the SAME window on every day 0..6. */
function everyDay(start, end) {
  const weekly = {};
  for (let d = 0; d <= 6; d++) weekly[d] = { start, end };
  return weekly;
}

const FULL_DAY = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
  "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
];

// ---- generateSlots: normal weekday, exact list ------------------------

test("generateSlots: normal Tallinn Monday, default settings -> 09:00..16:30 (end-exclusive, no 17:00)", () => {
  // 05:00Z == Tallinn 08:00 on Mon 2026-08-24, so the whole day is still ahead.
  const now = new Date("2026-08-24T05:00:00Z");
  const slots = generateSlots(DEFAULT_BOOKING_SETTINGS, [], now);
  assert.deepEqual(timesOn(slots, "2026-08-24"), FULL_DAY);
  assert.ok(!timesOn(slots, "2026-08-24").includes("17:00"), "17:00 must be excluded (end-exclusive)");
});

test("generateSlots: now pinned exactly on the 09:00 boundary -> 09:00 excluded, 09:30 first (strictly-after)", () => {
  const now = new Date("2026-08-24T06:00:00Z"); // Tallinn 09:00 exactly
  const times = timesOn(generateSlots(DEFAULT_BOOKING_SETTINGS, [], now), "2026-08-24");
  assert.equal(times[0], "09:30");
  assert.ok(!times.includes("09:00"), "the on-the-dot 09:00 slot must be excluded (strictly after now)");
  assert.deepEqual(times, FULL_DAY.slice(1));
});

// ---- generateSlots: DST boundary days (wall-clock invariant) -----------

test("generateSlots: EU spring-forward day 2027-03-28 keeps the exact 09:00..16:30 window", () => {
  const settings = { timezone: "Europe/Tallinn", slotMinutes: 30, horizonDays: 21, weekly: everyDay("09:00", "17:00") };
  const now = new Date("2027-03-27T00:00:00Z"); // day before, Tallinn wall-clock still ahead
  assert.deepEqual(timesOn(generateSlots(settings, [], now), "2027-03-28"), FULL_DAY);
});

test("generateSlots: EU fall-back day 2026-10-25 keeps the exact 09:00..16:30 window", () => {
  const settings = { timezone: "Europe/Tallinn", slotMinutes: 30, horizonDays: 21, weekly: everyDay("09:00", "17:00") };
  const now = new Date("2026-10-24T00:00:00Z");
  assert.deepEqual(timesOn(generateSlots(settings, [], now), "2026-10-25"), FULL_DAY);
});

// ---- generateSlots: window not divisible by slotMinutes ---------------

test("generateSlots: 09:00-09:40 @30min emits only 09:00 (trailing partial dropped)", () => {
  const settings = {
    timezone: "Europe/Tallinn",
    slotMinutes: 30,
    horizonDays: 21,
    weekly: { 0: null, 1: { start: "09:00", end: "09:40" }, 2: null, 3: null, 4: null, 5: null, 6: null },
  };
  const now = new Date("2026-08-24T05:00:00Z"); // Mon 08:00 Tallinn
  assert.deepEqual(timesOn(generateSlots(settings, [], now), "2026-08-24"), ["09:00"]);
});

// ---- generateSlots: horizon boundary ----------------------------------

test("generateSlots: horizonDays=1 yields only today's remaining future slots", () => {
  const settings = { ...DEFAULT_BOOKING_SETTINGS, horizonDays: 1 };
  const now = new Date("2026-08-24T05:00:00Z"); // Mon 08:00 Tallinn
  const slots = generateSlots(settings, [], now);
  assert.deepEqual(timesOn(slots, "2026-08-24"), FULL_DAY);
  assert.equal(timesOn(slots, "2026-08-25").length, 0, "tomorrow must not appear when horizon is 1 day");
  assert.ok(slots.every((s) => s.date === "2026-08-24"), "every slot must be for today only");
});

// ---- generateSlots: all weekdays disabled -----------------------------

test("generateSlots: all weekdays null -> empty array, no throw", () => {
  const settings = { timezone: "Europe/Tallinn", slotMinutes: 30, horizonDays: 21, weekly: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } };
  const now = new Date("2026-08-24T05:00:00Z");
  assert.deepEqual(generateSlots(settings, [], now), []);
});

// ---- generateSlots: booked exclusion + cancel-then-rebook -------------

test("generateSlots: a status:booked booking hides its slot; a status:cancelled booking frees it", () => {
  const now = new Date("2026-08-24T05:00:00Z"); // Mon 08:00 Tallinn
  const booked = [{ status: "booked", date: "2026-08-24", time: "09:00" }];
  assert.ok(
    !timesOn(generateSlots(DEFAULT_BOOKING_SETTINGS, booked, now), "2026-08-24").includes("09:00"),
    "a booked 09:00 must be excluded"
  );
  const cancelled = [{ status: "cancelled", date: "2026-08-24", time: "09:00" }];
  assert.ok(
    timesOn(generateSlots(DEFAULT_BOOKING_SETTINGS, cancelled, now), "2026-08-24").includes("09:00"),
    "a cancelled 09:00 must be rebookable"
  );
});

// ---- isSlotValid ------------------------------------------------------

test("isSlotValid: off-grid time on a disabled Sunday -> false", () => {
  const now = new Date("2026-08-24T06:00:00Z");
  // 2026-08-30 is a Sunday (disabled in default weekly).
  assert.equal(isSlotValid(DEFAULT_BOOKING_SETTINGS, [], "2026-08-30", "03:17", now), false);
});

test("isSlotValid: valid on-grid open slot -> true", () => {
  const now = new Date("2026-08-24T06:00:00Z");
  // 2026-08-25 is a Tuesday; 10:00 is on-grid and in the future.
  assert.equal(isSlotValid(DEFAULT_BOOKING_SETTINGS, [], "2026-08-25", "10:00", now), true);
});

test("isSlotValid: already-booked slot -> false", () => {
  const now = new Date("2026-08-24T06:00:00Z");
  const bookings = [{ status: "booked", date: "2026-08-25", time: "10:00" }];
  assert.equal(isSlotValid(DEFAULT_BOOKING_SETTINGS, bookings, "2026-08-25", "10:00", now), false);
});

test("isSlotValid: past slot (today at the current wall-clock minute) -> false", () => {
  const now = new Date("2026-08-24T06:00:00Z"); // Tallinn 09:00 exactly
  assert.equal(isSlotValid(DEFAULT_BOOKING_SETTINGS, [], "2026-08-24", "09:00", now), false);
});

// ---- validateSettings -------------------------------------------------

test("validateSettings: rejects slotMinutes 0, bad tz, start>end, horizon 100000", () => {
  const base = { timezone: "Europe/Tallinn", horizonDays: 21, weekly: DEFAULT_BOOKING_SETTINGS.weekly };

  assert.equal(validateSettings({ ...base, slotMinutes: 0 }).ok, false);
  assert.equal(validateSettings({ ...base, slotMinutes: 30, timezone: "Europe/Talinn" }).ok, false);
  assert.equal(
    validateSettings({
      timezone: "Europe/Tallinn",
      slotMinutes: 30,
      horizonDays: 21,
      weekly: { 0: null, 1: { start: "17:00", end: "09:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
    }).ok,
    false
  );
  assert.equal(validateSettings({ ...base, slotMinutes: 30, horizonDays: 100000 }).ok, false);
});

test("validateSettings: accepts a valid config and normalizes it", () => {
  const res = validateSettings(DEFAULT_BOOKING_SETTINGS);
  assert.equal(res.ok, true);
  assert.equal(res.settings.timezone, "Europe/Tallinn");
  assert.equal(res.settings.slotMinutes, 30);
  assert.ok(ALLOWED_TIMEZONES.includes("Europe/Tallinn"));
});

test("getBookingSettings: falls back to defaults for null/invalid stored settings, never throws", () => {
  assert.equal(getBookingSettings({ bookingSettings: null }).timezone, "Europe/Tallinn");
  assert.equal(getBookingSettings(null).slotMinutes, 30);
  assert.equal(getBookingSettings({ bookingSettings: { timezone: "Mars/Base", slotMinutes: 7 } }).horizonDays, 21);
});

// ---- businessNowParts: offset flip (summer +3 vs winter +2) -----------

test("businessNowParts: summer instant -> Tallinn UTC+3 (06:00Z -> 09:00)", () => {
  assert.deepEqual(businessNowParts("Europe/Tallinn", new Date("2026-08-24T06:00:00Z")), {
    date: "2026-08-24",
    time: "09:00",
  });
});

test("businessNowParts: winter instant -> Tallinn UTC+2 (06:00Z -> 08:00), proving the offset flips", () => {
  assert.deepEqual(businessNowParts("Europe/Tallinn", new Date("2026-01-15T06:00:00Z")), {
    date: "2026-01-15",
    time: "08:00",
  });
});

test("businessNowParts: UTC instant is returned unshifted", () => {
  assert.deepEqual(businessNowParts("UTC", new Date("2026-08-24T06:00:00Z")), {
    date: "2026-08-24",
    time: "06:00",
  });
});

// ---- compactBookings --------------------------------------------------

test("compactBookings: drops cancelled + past-90d booked rows, keeps today's booked row", () => {
  const now = new Date("2026-08-24T06:00:00Z");
  const rows = [
    { id: "cancelled", status: "cancelled", date: "2026-08-24" },
    { id: "old", status: "booked", date: "2026-05-16" }, // 100 days before 2026-08-24
    { id: "today", status: "booked", date: "2026-08-24" },
    { id: "future", status: "booked", date: "2026-09-01" },
  ];
  const kept = compactBookings(rows, now).map((b) => b.id);
  assert.deepEqual(kept, ["today", "future"]);
});
