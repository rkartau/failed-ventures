// app/api/book/route.ts â€” the PUBLIC "Book a call" API (unauthenticated by design).
//
// POST records a booking; GET lists open slots for the client island. The POST follows
// the STRICT R9 ordering so a flood is rejected BEFORE the ~435KB readDB():
//   (1) per-IP consumeBudget            -> 429
//   (2) global in-memory ceiling        -> 429
//   (3) honeypot hidden field non-empty -> 200 fake-success, NO write (don't tip the bot)
//   (4) cheap whitelist validation+caps -> 400
//   (5) readDB + isSlotValid fast-fail  -> 400
//   (6) updateDB authoritative re-check -> 409 (taken) | insert (200)
// The Booking is constructed SERVER-SIDE (R3): id/status/createdAt/source/tz/calendarSync
// are never taken from the body. After the write commits we best-effort push the event to
// Google (OUTSIDE the mutex, CV3/CV5-3); a Google failure can NEVER flip the 200.

import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type Booking } from "@/lib/db";
import { appendEvent } from "@/lib/outreach-events";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import { checkGlobalBookingRate } from "@/lib/booking-rate-limit";
import {
  compactBookings,
  excludeBusySlots,
  generateSlots,
  getBookingSettings,
  isSlotValid,
  sanitizeLeadKey,
} from "@/lib/booking";
import {
  calendarConfigured,
  deleteBookingEvent,
  getBusyWallRangesForBooking,
  getBusyWallRangesForRender,
  pushBookingEvent,
} from "@/lib/google-calendar";
import { getPublicBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";

// Per-IP token bucket for the booking POST â€” generous for a human (re)submitting a form,
// far below what an abuser needs. Distinct bucket name so it never shares the registry's.
const BOOK_BUCKET = "book";
const BOOK_BUDGET = { capacity: 5, refillPerMs: 5 / 60_000 } as const;

// Field caps (R3), applied after trim + control-char strip.
const CAPS = { name: 120, email: 254, company: 120, phone: 40, note: 1000 } as const;

/** Strip NUL + C0/DEL control chars but keep everything else (emoji included). */
function clean(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** LOOSE email check (R3): record-only, never dispatched â€” one @, no whitespace, â‰¤254. */
function looseEmailOk(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  return at < email.length - 1; // non-empty domain
}

// GET /api/book -> open slots for the client island. When Google is configured, the
// slots are ALSO filtered against the shared calendar's busy times (two-way
// availability, PLAN v8). Fail-soft: any Google error leaves the docka-only slots and
// never 500s; `stale` tells the client to show the "approximate" note (AV9-2).
export async function GET(req: NextRequest) {
  const now = new Date();
  const db = readDB();
  const settings = getBookingSettings(db);
  let slots: Array<{ date: string; time: string; tz: string }> = [];
  try {
    slots = generateSlots(settings, db.bookings, now);
  } catch {
    slots = [];
  }
  let stale = false;
  if (calendarConfigured()) {
    try {
      const busy = await getBusyWallRangesForRender(settings, now);
      slots = excludeBusySlots(slots, busy.ranges, settings.slotMinutes);
      stale = busy.stale;
    } catch {
      /* fail-soft: keep the docka-only slots */
    }
  }
  return NextResponse.json({ ok: true, tz: settings.timezone, slots, stale });
}

// POST /api/book { name, email, company?, phone?, note?, date, time, website? (honeypot) }
export async function POST(req: NextRequest) {
  // (1) per-IP budget.
  const ip = clientIpFromHeaders(req.headers);
  if (!consumeBudget(BOOK_BUCKET, ip, BOOK_BUDGET)) {
    return NextResponse.json({ ok: false, error: "Too many requests. Please try again shortly." }, { status: 429 });
  }
  // (2) global in-memory ceiling.
  if (!checkGlobalBookingRate()) {
    return NextResponse.json({ ok: false, error: "Booking is busy right now. Please try again shortly." }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // (3) honeypot: a hidden field a human never fills. If present -> pretend success but
  // record NOTHING (don't reveal the trap to the bot).
  if (clean(body.website).length > 0) {
    return NextResponse.json({ ok: true, booking: null });
  }

  // (4) whitelist + trim + strip + caps. Only these seven human inputs are ever read.
  const name = clean(body.name);
  const email = clean(body.email);
  const company = clean(body.company);
  const phone = clean(body.phone);
  const note = clean(body.note);
  const date = clean(body.date);
  const time = clean(body.time);
  // 8th read, but NOT a human input: a MACHINE-supplied outreach attribution token
  // (send_key from /book?lead=). Server RE-sanitizes (never trusts the client) here —
  // BEFORE the ~435KB readDB() — so a garbage value costs nothing. A malformed/absent
  // value is dropped silently (the booking still records as source:"public"); attribution
  // must NEVER block a real booking, so this never returns a 400.
  const leadKey = sanitizeLeadKey(body.leadKey);

  if (!name || !email || !date || !time) {
    return NextResponse.json({ ok: false, error: "Name, email, date and time are required." }, { status: 400 });
  }
  if (
    name.length > CAPS.name ||
    email.length > CAPS.email ||
    company.length > CAPS.company ||
    phone.length > CAPS.phone ||
    note.length > CAPS.note
  ) {
    return NextResponse.json({ ok: false, error: "One or more fields are too long." }, { status: 400 });
  }
  if (!looseEmailOk(email)) {
    return NextResponse.json({ ok: false, error: "Please enter a valid email address." }, { status: 400 });
  }

  // (5) NOW touch the store: settings + cheap fast-fail slot check.
  const now = new Date();
  const db = readDB();
  const settings = getBookingSettings(db);
  if (!isSlotValid(settings, db.bookings, date, time, now)) {
    // Distinguish a genuinely invalid slot (off-grid / past / disabled -> 400) from one
    // that is merely already taken by a live booking (-> 409). The authoritative taken
    // re-check still runs inside the mutex below for the concurrent case (R12).
    const taken = db.bookings.some((b) => b.status === "booked" && b.date === date && b.time === time);
    if (taken) {
      return NextResponse.json({ ok: false, error: "That time was just booked. Please pick another." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: "That time is no longer available." }, { status: 400 });
  }

  // (5b) Two-way availability busy-check (PLAN v8 AV8-1 / v9 AV9-1). Runs BEFORE the
  // in-mutex double-book guard and OUTSIDE the mutex (never hold the write lock across a
  // network call). When Google is configured we AWAIT an authoritative FreeBusy check
  // (bounded ~3s, single attempt):
  //   - fetch SUCCEEDS + the chosen slot overlaps a busy range -> 409 (fail-CLOSED).
  //   - fetch SUCCEEDS + clear                                  -> busyCheck:"ok".
  //   - fetch FAILS/timeout (a real Google outage)             -> FAIL-OPEN: proceed but
  //     flag busyCheck:"skipped-outage" + write an audit line so the admin verifies and
  //     the cron reconciler re-checks. So cold-cache + Google healthy = correct 409; only
  //     a true outage books over a possible overlap, and never silently.
  let busyCheck: Booking["busyCheck"] | undefined;
  if (calendarConfigured()) {
    const busy = await getBusyWallRangesForBooking(settings, now);
    if (busy.ok) {
      const clear =
        excludeBusySlots([{ date, time, tz: settings.timezone }], busy.ranges, settings.slotMinutes)
          .length > 0;
      if (!clear) {
        return NextResponse.json(
          { ok: false, error: "That time is no longer available." },
          { status: 409 }
        );
      }
      busyCheck = "ok";
    } else {
      busyCheck = "skipped-outage";
      // eslint-disable-next-line no-console
      console.warn(
        `[book] booked without a fresh Google busy-check (calendar outage) — verify for overlap: ${date} ${time}`
      );
    }
  }

  // (6) Authoritative atomic re-check + insert INSIDE the mutex (R12). The server
  // constructs the whole Booking â€” body-supplied id/status/createdAt/source/tz are ignored.
  const booking: Booking = {
    id: id(),
    date,
    time,
    tz: settings.timezone, // CV5-4 pin the tz onto the booking
    name,
    email,
    ...(company ? { company } : {}),
    ...(phone ? { phone } : {}),
    ...(note ? { note } : {}),
    // A valid outreach leadKey stamps source:"outreach" + persists the key; otherwise
    // the booking stays source:"public" (the hardcoded default) with no leadKey.
    ...(leadKey ? { leadKey, source: "outreach" as const } : { source: "public" as const }),
    status: "booked",
    createdAt: now.toISOString(),
    calendarSync: "pending",
    ...(busyCheck ? { busyCheck } : {}),
  };

  const result = await updateDB((store) => {
    // Authoritative taken-check: only a LIVE (status==="booked") row at (date,time) blocks.
    const taken = store.bookings.some(
      (b) => b.status === "booked" && b.date === date && b.time === time
    );
    if (taken) return { added: false as const };
    // Bound db.json growth (R10) before appending.
    store.bookings = compactBookings(store.bookings, now);
    store.bookings.push(booking);
    return { added: true as const };
  });

  if (!result.added) {
    return NextResponse.json({ ok: false, error: "That time was just booked. Please pick another." }, { status: 409 });
  }

  // Success payload is FIXED now â€” the calendar step below can never change it (CV3).
  const payload = { ok: true as const, booking: { date: booking.date, time: booking.time, tz: booking.tz } };

  // (E1/C2) Single booking-event writer: the APP is the one writer of the
  // web-tracking JSONL. AFTER the booking persists, append ONE `booking` event
  // keyed by the outreach send_key + this booking's id — only when a lead is
  // present. The event_key includes booking_id, so two distinct bookings for
  // one send_key stay distinct while a replay collapses (Plan C3/E3). Fail-soft:
  // a sink hiccup can never flip the already-decided 200.
  if (leadKey) {
    try {
      await appendEvent({ event: "booking", send_key: leadKey, booking_id: booking.id });
    } catch {
      /* never let an event-sink hiccup flip the 200 */
    }
  }

  // Best-effort calendar push OUTSIDE the mutex. Guarded so any failure is swallowed and
  // the 200 stands. Skipped entirely when Google isn't configured (local/dev) â€” the
  // booking simply stays calendarSync:"pending" for the cron reconciler.
  if (calendarConfigured()) {
    try {
      const adminUrl = `${getPublicBaseUrl(req)}/admin/bookings`;
      const push = await pushBookingEvent(booking, settings.slotMinutes, adminUrl);
      await updateDB((store) => {
        const row = store.bookings.find((b) => b.id === booking.id);
        // Cancelled/gone between insert and stamp (CV5-3): delete the just-created event,
        // do NOT stamp. The delete is issued outside this call below via the flag.
        if (!row || row.status === "cancelled") return;
        if (push.ok) {
          row.googleEventId = push.googleEventId;
          row.calendarSync = "synced";
        } else {
          row.calendarSync = "failed";
        }
      });
      // If the row vanished/cancelled mid-flight, remove the ghost event (idempotent).
      const stillLive = readDB().bookings.find((b) => b.id === booking.id && b.status === "booked");
      if (push.ok && !stillLive) {
        await deleteBookingEvent(booking.id);
      }
    } catch {
      /* never let a calendar hiccup flip the already-decided 200 */
    }
  }

  return NextResponse.json(payload);
}
