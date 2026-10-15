// "Book a call" — admin-side booking mutations + the settings edit-lock decision.
//
// These are PURE db mutators / predicates (no fs, no network, no auth). The thin
// adminSession()-guarded routes (app/api/admin/bookings, app/api/admin/booking-settings)
// call them INSIDE an `updateDB` critical section; the calendar network calls (delete)
// happen in the route OUTSIDE the mutex. Factoring the logic here keeps it unit-testable
// against the real store without importing the auth-bound route module (mirrors how the
// billing dispatch lives in lib/billing-cron.ts, not the cron route).

import type { Booking, BookingSettings, DB } from "@/lib/db";
import { businessNowParts, getBookingSettings, validateSettings } from "@/lib/booking";

/**
 * Soft-cancel a booking (R4 / CV5-3): set `status:"cancelled"` AND
 * `calendarSync:"cancelled"` in one shot. Returns the row (so the route can then delete
 * the derived-id calendar event OUTSIDE the mutex), or null if no such id exists.
 * Idempotent: cancelling an already-cancelled row is a harmless no-op returning the row.
 * Call INSIDE `updateDB` only.
 */
export function cancelBookingInDb(db: Pick<DB, "bookings">, bookingId: string): Booking | null {
  const row = db.bookings.find((b) => b.id === bookingId);
  if (!row) return null;
  row.status = "cancelled";
  row.calendarSync = "cancelled";
  return row;
}

/**
 * Mark every currently-UNSEEN booking as seen (R7 unseen badge). `seenAt` is GLOBAL
 * (per-installation, not per-admin) per R11. Returns how many rows were freshly stamped.
 * Call INSIDE `updateDB` only.
 */
export function markUnseenBookingsSeen(db: Pick<DB, "bookings">, nowIso: string): number {
  let marked = 0;
  for (const b of db.bookings) {
    if (!b.seenAt) {
      b.seenAt = nowIso;
      marked++;
    }
  }
  return marked;
}

/** Count of unseen bookings (drives the "N new" badge / tests). */
export function countUnseenBookings(bookings: Booking[]): number {
  return (bookings ?? []).filter((b) => b && !b.seenAt).length;
}

/**
 * R6/CV edit-lock: block a `timezone` or `slotMinutes` change while any FUTURE
 * `status==="booked"` booking exists — re-interpreting those two fields would re-time
 * existing bookings' absolute instant. Weekly-hours / horizon edits only shrink or grow
 * availability (never re-time a booking) and are therefore always allowed → not locked.
 * "Future" is judged as strictly-after the current business-now wall-clock in the
 * CURRENT (pre-change) timezone.
 */
export function settingsEditLocked(
  current: BookingSettings,
  incoming: BookingSettings,
  bookings: Booking[],
  now: Date
): boolean {
  const changesTiming =
    incoming.timezone !== current.timezone || incoming.slotMinutes !== current.slotMinutes;
  if (!changesTiming) return false;
  const nowParts = businessNowParts(current.timezone, now);
  return (bookings ?? []).some((b) => {
    if (!b || b.status !== "booked") return false;
    return b.date > nowParts.date || (b.date === nowParts.date && b.time > nowParts.time);
  });
}

/** Discriminated result of validating + edit-lock-checking an incoming settings write. */
export type SettingsUpdateResult =
  | { ok: true; settings: BookingSettings }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Full server-side decision for `POST /api/admin/booking-settings`: run the Wave-1
 * `validateSettings` gate (400 on failure), then the R6 edit-lock (409 while future
 * booked slots exist and a timing field changed). On success returns the normalized
 * settings for the route to assign to `db.bookingSettings`. Pure — call inside `updateDB`
 * so the edit-lock reads the same snapshot it writes.
 */
export function evaluateSettingsUpdate(
  db: Pick<DB, "bookings" | "bookingSettings">,
  incoming: unknown,
  now: Date
): SettingsUpdateResult {
  const v = validateSettings(incoming);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const current = getBookingSettings(db);
  if (settingsEditLocked(current, v.settings, db.bookings, now)) {
    return {
      ok: false,
      status: 409,
      error:
        "Cannot change timezone or slot length while future bookings exist. Cancel or wait out the booked slots first.",
    };
  }
  return { ok: true, settings: v.settings };
}
