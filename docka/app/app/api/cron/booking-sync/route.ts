// app/api/cron/booking-sync/route.ts — the SYSTEM cron entry point for the "Book a call"
// calendar reconciler (CV5-6 / CV6). Gated by the shared CRON_SECRET (lib/cron-auth) —
// exactly like the reminders + billing crons. Not an agent/seaman-scoped request.
//
// The reconciler core (lib/booking-sync.ts) does all the work behind injectable seams; here
// we just authorize, wire the REAL db + calendar deps, and return the summary. The network
// calls happen OUTSIDE the write mutex inside the core; the single-flight lock guarantees
// overlapping cron ticks don't double-push.
//
// AUTH: `Authorization: Bearer <CRON_SECRET>` or `?secret=<CRON_SECRET>`. With no secret
// set it runs only outside production (local/dev convenience).

import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron-auth";
import { getPublicBaseUrl } from "@/lib/base-url";
import {
  calendarConfigured,
  deleteBookingEvent,
  getBusyWallRangesForBooking,
  pushBookingEvent,
} from "@/lib/google-calendar";
import { reconcileBookingSync } from "@/lib/booking-sync";

export const dynamic = "force-dynamic";

async function run(req: NextRequest) {
  const authorized = cronAuthorized({
    authorization: req.headers.get("authorization"),
    secretParam: new URL(req.url).searchParams.get("secret"),
  });
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const adminBaseUrl = `${getPublicBaseUrl(req)}/admin/bookings`;
  const result = await reconcileBookingSync({
    now: () => new Date(),
    read: readDB,
    update: updateDB,
    push: pushBookingEvent,
    del: deleteBookingEvent,
    calendarConfigured,
    adminBaseUrl,
    // Two-way availability re-check (AV9-3): re-run FreeBusy for fail-open bookings.
    busy: (settings, now) => getBusyWallRangesForBooking(settings, now),
  });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
