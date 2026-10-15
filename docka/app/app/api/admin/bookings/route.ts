// app/api/admin/bookings/route.ts — admin actions over "Book a call" bookings.
//
// adminSession()-guarded (also satisfies the static isolation build guard — the symbol
// MUST be referenced). Actions (POST { action, ... }, mirroring the repo's action style):
//   - "cancel"    { id }: soft-cancel (status+calendarSync "cancelled") in one updateDB,
//                          then delete the derived-id Google event OUTSIDE the mutex
//                          (404/410 = success). Frees the slot for rebooking (R4).
//   - "mark-seen"        : stamp `seenAt` on all currently-unseen rows (R7 badge). GLOBAL.
// The booking mutations live in lib/booking-admin.ts so they stay unit-testable without
// importing this auth-bound module.

import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { adminSession } from "@/lib/admin-session";
import { cancelBookingInDb, countUnseenBookings, markUnseenBookingsSeen } from "@/lib/booking-admin";
import { calendarConfigured, deleteBookingEvent } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
  const action = (body.action ?? "").trim();

  if (action === "cancel") {
    const bookingId = (body.id ?? "").trim();
    if (!bookingId) {
      return NextResponse.json({ ok: false, error: "Booking id is required." }, { status: 400 });
    }
    const cancelled = await updateDB((db) => cancelBookingInDb(db, bookingId));
    if (!cancelled) {
      return NextResponse.json({ ok: false, error: "Booking not found." }, { status: 404 });
    }
    // Remove the calendar event OUTSIDE the mutex (idempotent; 404/410 = success). Only
    // attempt when Google is configured; best-effort — a delete failure never fails the
    // cancel (the cron tombstone sweep re-issues it).
    if (calendarConfigured()) {
      try {
        await deleteBookingEvent(bookingId);
      } catch {
        /* the tombstone sweep will retry */
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "mark-seen") {
    const marked = await updateDB((db) => markUnseenBookingsSeen(db, new Date().toISOString()));
    return NextResponse.json({ ok: true, marked, unseen: 0 });
  }

  return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
}

// GET /api/admin/bookings -> raw booking rows (newest first) + the unseen count for the
// R7 badge. Always derived from RAW db.bookings (never re-derived from generated slots),
// so a booking orphaned by a later settings change still shows (R6).
export async function GET(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const db = readDB();
  const bookings = db.bookings
    .slice()
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));
  return NextResponse.json({ ok: true, bookings, unseen: countUnseenBookings(db.bookings) });
}
