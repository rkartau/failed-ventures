// Wave-3 API tests for the "Book a call" backend (docka-booking-plan.md R3/R5/R7/R9/R11/
// R12 + CV5/CV6). Three layers:
//   1. The REAL public POST/GET /api/book route handlers, driven end-to-end against a REAL
//      temp-dir db.json (so the actual updateDB mutex proves the in-mutator re-check).
//   2. The admin mutators + settings edit-lock decision (lib/booking-admin) — pure.
//   3. The reconciler core (lib/booking-sync) with INJECTED calendar fakes (no network).
//
// calendarConfigured() is false locally (no GOOGLE_* env), so the route's calendar push is
// skipped — exactly the record path we assert here. The reconciler tests inject fakes.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking-api.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- temp store + env (before importing anything that reads cwd/env) --------
const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-booking-api-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
const DB_PATH = path.join(TMP, "data", "db.json");

// Distinct-IP simulation for the per-IP limiter + never look "production".
process.env.REGISTRY_MOCK = "1";
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
// Ensure Google is NOT configured so the route's calendar step is skipped.
delete process.env.GOOGLE_SA_CLIENT_EMAIL;
delete process.env.GOOGLE_SA_PRIVATE_KEY;
delete process.env.GOOGLE_CALENDAR_ID;

const { readDB, updateDB, _serializeEntryCount } = await import("@/lib/db");
const { getBookingSettings, generateSlots } = await import("@/lib/booking");
const { checkGlobalBookingRate, __resetGlobalBookingRate, GLOBAL_BOOKING_MAX } = await import(
  "@/lib/booking-rate-limit"
);
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { eventIdFor } = await import("@/lib/google-calendar");
const {
  cancelBookingInDb,
  countUnseenBookings,
  markUnseenBookingsSeen,
  evaluateSettingsUpdate,
} = await import("@/lib/booking-admin");
const {
  reconcileBookingSync,
  __resetBookingSyncLock,
  RECONCILE_BATCH,
} = await import("@/lib/booking-sync");
const { NextRequest } = await import("next/server");
const bookRoute = await import("@/app/api/book/route");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---- helpers ----------------------------------------------------------------

/** Fresh empty store + reset the per-IP and global limiters. */
function resetAll() {
  fs.writeFileSync(DB_PATH, "{}", "utf8");
  resetRegistryAbuseState();
  __resetGlobalBookingRate();
}

let ipSeq = 0;
/** A unique client IP per call so per-IP buckets never bleed between assertions. */
function freshIp() {
  return `10.0.0.${++ipSeq}`;
}

function postReq(body, ip = freshIp()) {
  return new NextRequest("http://localhost/api/book", {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-test-ip": ip },
    body: JSON.stringify(body),
  });
}

/** The first currently-open slot for the (empty) store. Always exists (Mon–Fri horizon). */
function firstOpenSlot() {
  const db = readDB();
  const slots = generateSlots(getBookingSettings(db), db.bookings, new Date());
  assert.ok(slots.length > 0, "the default schedule must offer at least one open slot");
  return slots[0];
}

const validForm = (slot, extra = {}) => ({
  name: "Alice Example",
  email: "alice@example.com",
  company: "Acme Shipping",
  phone: "+372 5555 5555",
  note: "Looking forward to it.",
  date: slot.date,
  time: slot.time,
  ...extra,
});

// ===========================================================================
// 1. PUBLIC ROUTE — happy path + record shape
// ===========================================================================

test("POST /api/book happy path -> 200, one booked row, calendarSync pending, tz set", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot)));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.booking.date, slot.date);
  assert.equal(json.booking.time, slot.time);
  assert.equal(json.booking.tz, getBookingSettings(readDB()).timezone);

  const rows = readDB().bookings;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "booked");
  assert.equal(rows[0].source, "public");
  assert.equal(rows[0].calendarSync, "pending");
  assert.equal(rows[0].tz, json.booking.tz);
  assert.ok(rows[0].id && rows[0].createdAt);
});

test("GET /api/book -> open slots + tz", async () => {
  resetAll();
  const res = await bookRoute.GET(new NextRequest("http://localhost/api/book"));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.tz, "Europe/Tallinn");
  assert.ok(Array.isArray(json.slots) && json.slots.length > 0);
});

// ===========================================================================
// 1b. VALIDATION -> 400
// ===========================================================================

test("POST /api/book invalid email -> 400", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { email: "not-an-email" })));
  assert.equal(res.status, 400);
  assert.equal(readDB().bookings.length, 0);
});

test("POST /api/book missing name -> 400", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { name: "   " })));
  assert.equal(res.status, 400);
});

test("POST /api/book oversize note (>1000) -> 400", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { note: "x".repeat(1001) })));
  assert.equal(res.status, 400);
  assert.equal(readDB().bookings.length, 0);
});

test("POST /api/book off-grid 03:17 on a disabled Sunday -> 400", async () => {
  resetAll();
  // Find the next Sunday (weekday 0) — disabled in the default weekly schedule.
  let d = new Date();
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  for (let i = 0; i < 14; i++) {
    if (d.getUTCDay() === 0) break;
    d = new Date(d.getTime() + 86_400_000);
  }
  const sunday = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
  const res = await bookRoute.POST(postReq(validForm({ date: sunday, time: "03:17" })));
  assert.equal(res.status, 400);
  assert.equal(readDB().bookings.length, 0);
});

// ===========================================================================
// 1c. DOUBLE-BOOK + CONCURRENCY (R12 in-mutator re-check)
// ===========================================================================

test("double-book same slot -> second 409, exactly one booked row", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const first = await bookRoute.POST(postReq(validForm(slot)));
  assert.equal(first.status, 200);
  const second = await bookRoute.POST(postReq(validForm(slot, { name: "Bob" })));
  assert.equal(second.status, 409);
  assert.equal(readDB().bookings.filter((b) => b.status === "booked").length, 1);
});

test("concurrent double-submit -> one 200 + one 409 + exactly one row (proves in-mutex re-check)", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const [a, b] = await Promise.all([
    bookRoute.POST(postReq(validForm(slot))),
    bookRoute.POST(postReq(validForm(slot, { name: "Bob" }))),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(readDB().bookings.filter((x) => x.status === "booked").length, 1);
});

// ===========================================================================
// 1d. HONEYPOT + RATE LIMITS
// ===========================================================================

test("honeypot filled -> fake-success 200 with NO row recorded", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { website: "http://spam.example" })));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.booking, null);
  assert.equal(readDB().bookings.length, 0, "honeypot submissions are never recorded");
});

test("per-IP rate limit -> 429 once the bucket is spent", async () => {
  resetAll();
  const ip = freshIp();
  // Capacity is 5. Six invalid submissions from ONE ip: the first five 400 (spending a
  // token each), the sixth is refused at the limiter with 429.
  let last;
  for (let i = 0; i < 6; i++) {
    last = await bookRoute.POST(postReq({ email: "bad" }, ip));
  }
  assert.equal(last.status, 429);
});

test("global ceiling: checkGlobalBookingRate allows MAX then refuses", () => {
  __resetGlobalBookingRate();
  const t = 1_000_000;
  for (let i = 0; i < GLOBAL_BOOKING_MAX; i++) {
    assert.equal(checkGlobalBookingRate(t), true, `hit ${i} within the window must pass`);
  }
  assert.equal(checkGlobalBookingRate(t), false, "the (MAX+1)th within the window is refused");
});

// ===========================================================================
// 1e. SERVER-CONSTRUCTED BOOKING (R3) + CANCEL-THEN-REBOOK (R4)
// ===========================================================================

test("extra body fields (id/status/createdAt/source) are ignored — booking is server-constructed", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(
    postReq(
      validForm(slot, {
        id: "HACKED-ID",
        status: "cancelled",
        createdAt: "2000-01-01T00:00:00.000Z",
        source: "outreach",
        calendarSync: "synced",
      })
    )
  );
  assert.equal(res.status, 200);
  const row = readDB().bookings[0];
  assert.notEqual(row.id, "HACKED-ID");
  assert.equal(row.status, "booked");
  assert.equal(row.source, "public");
  assert.equal(row.calendarSync, "pending");
  assert.notEqual(row.createdAt, "2000-01-01T00:00:00.000Z");
});

test("cancel frees the slot -> the same slot is rebookable (200)", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const first = await bookRoute.POST(postReq(validForm(slot)));
  assert.equal(first.status, 200);
  const bookedId = readDB().bookings[0].id;

  // Admin cancel (the route wraps exactly this mutator inside updateDB).
  const cancelled = await updateDB((db) => cancelBookingInDb(db, bookedId));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.calendarSync, "cancelled");

  const rebook = await bookRoute.POST(postReq(validForm(slot, { name: "Bob" })));
  assert.equal(rebook.status, 200, "a cancelled slot must be rebookable");
  const booked = readDB().bookings.filter((b) => b.status === "booked");
  assert.equal(booked.length, 1, "exactly one live booking on the rebooked slot");
  assert.equal(booked[0].name, "Bob");
  // Note: compactBookings() drops the cancelled tombstone on the rebook write (R10
  // retention), so only the new live row remains — the immediate delete-on-cancel (not
  // the tombstone sweep) is what removes its calendar event.
});

// ===========================================================================
// 1f. OUTREACH ATTRIBUTION — leadKey capture (book-a-call-outreach-plan Wave A4)
// ===========================================================================

test("POST /api/book with a valid leadKey -> stored booking has leadKey + source:'outreach'", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { leadKey: "LD7" })));
  assert.equal(res.status, 200, "attribution never blocks a real booking");
  const row = readDB().bookings[0];
  assert.equal(row.leadKey, "LD7");
  assert.equal(row.source, "outreach");
  assert.equal(row.status, "booked");
});

test("POST /api/book with a malformed leadKey -> booking succeeds, no leadKey, source stays 'public'", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { leadKey: "<x>" })));
  assert.equal(res.status, 200, "a malformed leadKey must NEVER be a 400");
  const row = readDB().bookings[0];
  assert.equal(row.leadKey, undefined, "malformed key is dropped");
  assert.equal(row.source, "public");
});

test("POST /api/book without a leadKey -> unchanged public booking (no leadKey, source:'public')", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot)));
  assert.equal(res.status, 200);
  const row = readDB().bookings[0];
  assert.equal(row.leadKey, undefined);
  assert.equal(row.source, "public");
});

test("POST /api/book: server RE-sanitizes a too-long leadKey (client can't force a bad value through)", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(validForm(slot, { leadKey: "LD" + "9".repeat(20) })));
  assert.equal(res.status, 200);
  const row = readDB().bookings[0];
  assert.equal(row.leadKey, undefined);
  assert.equal(row.source, "public");
});

test("POST /api/book: honeypot still writes NOTHING even with a valid leadKey present", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(
    postReq(validForm(slot, { leadKey: "LD42", website: "http://spam.example" }))
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.booking, null);
  assert.equal(readDB().bookings.length, 0, "a leadKey must not let the honeypot path record a row");
});

// [CRITIC 8] Rate-limit regression: a leadKey must NOT raise/bypass the per-IP bucket.
test("per-IP rate limit: >5 rapid POSTs from one IP -> 429, and a leadKey does NOT bypass it", async () => {
  resetAll();
  const ip = freshIp();
  const slot = firstOpenSlot();
  let last;
  // Six submissions from ONE ip, each carrying a valid leadKey. Capacity is 5.
  for (let i = 0; i < 6; i++) {
    last = await bookRoute.POST(postReq(validForm(slot, { leadKey: "LD42", name: `U${i}` }), ip));
  }
  assert.equal(last.status, 429, "the 6th request from the same IP is throttled — leadKey gives no bypass");
  // Exactly one live booking could have committed (the first valid one); the point is the
  // limiter fired, not vacuously green.
  assert.ok(readDB().bookings.filter((b) => b.status === "booked").length <= 1);
});

// [CRITIC 7] Concurrency: N simultaneous distinct-slot POSTs with leadKeys all persist,
// and serialize was entered once per committed write (falsifiability pin).
test("concurrent distinct-slot POSTs with leadKeys: all persist, mutex entered per committed write", async () => {
  resetAll();
  const db = readDB();
  const slots = generateSlots(getBookingSettings(db), db.bookings, new Date());
  assert.ok(slots.length >= 4, "need at least four distinct open slots");
  const chosen = slots.slice(0, 4);

  const before = _serializeEntryCount();
  const results = await Promise.all(
    chosen.map((s, i) =>
      bookRoute.POST(postReq(validForm(s, { leadKey: `LD${100 + i}`, name: `U${i}` })))
    )
  );
  for (const r of results) assert.equal(r.status, 200);

  const booked = readDB().bookings.filter((b) => b.status === "booked");
  assert.equal(booked.length, 4, "no lost update — every distinct-slot booking committed");
  for (let i = 0; i < 4; i++) {
    const row = booked.find((b) => b.leadKey === `LD${100 + i}`);
    assert.ok(row, `leadKey LD${100 + i} persisted`);
    assert.equal(row.source, "outreach");
  }
  const after = _serializeEntryCount();
  assert.ok(
    after - before >= 4,
    "serialize() was entered at least once per committed write (not a no-op)"
  );
});

// ===========================================================================
// 2. ADMIN MUTATORS + SETTINGS EDIT-LOCK
// ===========================================================================

test("mark-seen stamps all unseen rows and zeroes the unseen count", () => {
  const db = {
    bookings: [
      { id: "a", status: "booked" },
      { id: "b", status: "booked", seenAt: "2026-08-01T00:00:00.000Z" },
      { id: "c", status: "cancelled" },
    ],
  };
  assert.equal(countUnseenBookings(db.bookings), 2);
  const marked = markUnseenBookingsSeen(db, "2026-08-20T00:00:00.000Z");
  assert.equal(marked, 2);
  assert.equal(countUnseenBookings(db.bookings), 0);
});

test("settings validation rejects slotMinutes 0 / bad tz / start>end / horizon 100000 -> 400", () => {
  const db = { bookings: [], bookingSettings: null };
  const now = new Date();
  const base = { timezone: "Europe/Tallinn", horizonDays: 21, weekly: {} };
  const bad = [
    { ...base, slotMinutes: 0 },
    { ...base, slotMinutes: 30, timezone: "Mars/Base" },
    {
      timezone: "Europe/Tallinn",
      slotMinutes: 30,
      horizonDays: 21,
      weekly: { 0: null, 1: { start: "17:00", end: "09:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
    },
    { ...base, slotMinutes: 30, horizonDays: 100000 },
  ];
  for (const incoming of bad) {
    const r = evaluateSettingsUpdate(db, incoming, now);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  }
});

test("edit-lock: future booked exists -> tz change 409; cancel it -> tz change 200", () => {
  const future = { id: "f1", status: "booked", date: "2099-01-05", time: "10:00", tz: "Europe/Tallinn" };
  const db = { bookings: [future], bookingSettings: null }; // defaults = Europe/Tallinn / 30
  const now = new Date();
  const incoming = {
    timezone: "Europe/Helsinki", // changes the timezone
    slotMinutes: 30,
    horizonDays: 21,
    weekly: { 0: null, 1: { start: "09:00", end: "17:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
  };
  const locked = evaluateSettingsUpdate(db, incoming, now);
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 409);

  // Cancelling the future booking releases the lock.
  future.status = "cancelled";
  const unlocked = evaluateSettingsUpdate(db, incoming, now);
  assert.equal(unlocked.ok, true);
});

test("edit-lock allows weekly-hours edits even with a future booking", () => {
  const future = { id: "f1", status: "booked", date: "2099-01-05", time: "10:00", tz: "Europe/Tallinn" };
  const db = { bookings: [future], bookingSettings: null };
  const incoming = {
    timezone: "Europe/Tallinn", // SAME tz + slot -> only hours changed
    slotMinutes: 30,
    horizonDays: 30,
    weekly: { 0: null, 1: { start: "10:00", end: "16:00" }, 2: null, 3: null, 4: null, 5: null, 6: null },
  };
  const r = evaluateSettingsUpdate(db, incoming, new Date());
  assert.equal(r.ok, true, "weekly-hours/horizon edits are always allowed");
});

// ===========================================================================
// 3. RECONCILER CORE (injected fakes — no network)
// ===========================================================================

function fakeDb(bookings) {
  return { bookings, bookingSettings: null };
}

function fakeDeps(db, over = {}) {
  const pushed = [];
  const deleted = [];
  const deps = {
    now: over.now ?? (() => new Date("2026-08-20T00:00:00.000Z")),
    read: () => db,
    update: async (mutator) => mutator(db),
    push:
      over.push ??
      (async (booking) => {
        pushed.push(booking.id);
        return { ok: true, googleEventId: eventIdFor(booking.id) };
      }),
    del:
      over.del ??
      (async (id) => {
        deleted.push(id);
        return { ok: true };
      }),
    calendarConfigured: over.calendarConfigured ?? (() => true),
    adminBaseUrl: "https://docka.me/admin/bookings",
  };
  return { deps, pushed, deleted };
}

test("reconciler: a pending booking -> one push with the derived id -> stamped synced", async () => {
  __resetBookingSyncLock();
  const b = { id: "ABCDEF01-2345-6789-ABCD-EF0123456789", status: "booked", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: "2026-08-19T09:00:00.000Z", calendarSync: "pending" };
  const db = fakeDb([b]);
  const { deps, pushed } = fakeDeps(db);
  const res = await reconcileBookingSync(deps);
  assert.equal(pushed.length, 1);
  assert.equal(res.pushed, 1);
  assert.equal(b.calendarSync, "synced");
  assert.equal(b.googleEventId, eventIdFor(b.id), "stamped with the derived (lowercased) id");
  assert.equal(b.syncAttempts, 1);
});

test("reconciler: a cancelled booking is NEVER re-pushed", async () => {
  __resetBookingSyncLock();
  const db = fakeDb([
    { id: "c1", status: "cancelled", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: "2026-08-19T09:00:00.000Z", calendarSync: "cancelled" },
  ]);
  const { deps, pushed } = fakeDeps(db);
  const res = await reconcileBookingSync(deps);
  assert.equal(pushed.length, 0, "cancelled rows are excluded from the push selector");
  assert.equal(res.pushed, 0);
});

test("reconciler: the single-flight lock is released after a mid-batch throw", async () => {
  __resetBookingSyncLock();
  const b = { id: "d1", status: "booked", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: "2026-08-19T09:00:00.000Z", calendarSync: "pending" };
  const db = fakeDb([b]);
  const throwing = fakeDeps(db, {
    push: async () => {
      throw new Error("network exploded mid-batch");
    },
  });
  await assert.rejects(() => reconcileBookingSync(throwing.deps), /network exploded/);
  assert.equal(b.calendarSync, "pending", "the throwing attempt never stamped the row");

  // The NEXT run must proceed (lock was released in the finally, not wedged).
  const healthy = fakeDeps(db);
  const res = await reconcileBookingSync(healthy.deps);
  assert.equal(res.skipped, undefined);
  assert.equal(res.pushed, 1);
  assert.equal(b.calendarSync, "synced");
});

test("reconciler: oldest-first under a backlog > batch cap (no starvation)", async () => {
  __resetBookingSyncLock();
  const n = RECONCILE_BATCH + 1;
  const bookings = [];
  for (let i = 0; i < n; i++) {
    // createdAt strictly increasing -> index 0 is the OLDEST, last index the NEWEST.
    const ts = `2026-08-19T09:${String(i).padStart(2, "0")}:00.000Z`;
    bookings.push({ id: `b${i}`, status: "booked", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: ts, calendarSync: "pending" });
  }
  const db = fakeDb(bookings);

  const run1 = fakeDeps(db);
  const r1 = await reconcileBookingSync(run1.deps);
  assert.equal(r1.pushed, RECONCILE_BATCH);
  assert.equal(bookings[0].calendarSync, "synced", "the oldest was processed first");
  assert.equal(bookings[n - 1].calendarSync, "pending", "the newest waits for the next tick");

  __resetBookingSyncLock();
  const run2 = fakeDeps(db);
  const r2 = await reconcileBookingSync(run2.deps);
  assert.equal(r2.pushed, 1);
  assert.equal(bookings[n - 1].calendarSync, "synced", "processed within two ticks");
});

test("reconciler: tombstone sweep re-deletes a recently-cancelled row, skips a stale one", async () => {
  __resetBookingSyncLock();
  const now = () => new Date("2026-08-20T12:00:00.000Z");
  const recent = { id: "t-recent", status: "cancelled", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: "2026-08-20T06:00:00.000Z", calendarSync: "cancelled" };
  const stale = { id: "t-stale", status: "cancelled", date: "2026-08-25", time: "11:00", tz: "Europe/Tallinn", createdAt: "2026-08-01T00:00:00.000Z", calendarSync: "cancelled" };
  const db = fakeDb([recent, stale]);
  const { deps, deleted } = fakeDeps(db, { now });
  const res = await reconcileBookingSync(deps);
  assert.deepEqual(deleted, ["t-recent"], "only the recently-cancelled tombstone is re-deleted");
  assert.equal(res.tombstonesSwept, 1);
});

test("reconciler: no-op when Google is not configured", async () => {
  __resetBookingSyncLock();
  const b = { id: "n1", status: "booked", date: "2026-08-25", time: "10:00", tz: "Europe/Tallinn", createdAt: "2026-08-19T09:00:00.000Z", calendarSync: "pending" };
  const db = fakeDb([b]);
  const { deps, pushed } = fakeDeps(db, { calendarConfigured: () => false });
  const res = await reconcileBookingSync(deps);
  assert.equal(res.configured, false);
  assert.equal(pushed.length, 0);
  assert.equal(b.calendarSync, "pending");
});
