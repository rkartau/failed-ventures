// Two-way availability tests (docka-booking-plan.md PLAN v7/v8/v9, AV8-1…7 + AV9-1…6).
// Google FreeBusy is MOCKED via the injected deps seam (fetch + token); nothing touches
// the network. Four layers:
//   1. getBusyIntervals strict parse (2xx+busy / 2xx+empty / 2xx+errors / HTTP-error).
//   2. excludeBusySlots — the pure end-exclusive overlap filter (incl. cross-day + all-day).
//   3. The globalThis busy cache: TTL, single-flight, reject-then-success, AbortController
//      timeout, serve-stale within cap, past-max-staleness -> stale:true, horizon window.
//   4. The REAL POST /api/book route (temp db.json) with GOOGLE_* set + the FreeBusy deps
//      overridden via __setBusyDeps: cold-cache overlap -> 409; never-resolve -> bounded
//      fail-open + flag. Plus the reconciler outage re-check + the admin render wiring.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking-availability.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- temp store + env (before importing anything that reads cwd/env) --------
const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-booking-avail-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
const DB_PATH = path.join(TMP, "data", "db.json");

process.env.REGISTRY_MOCK = "1";
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
// Configure Google so calendarConfigured() is TRUE for the route tests. The network is
// never hit — every busy read is driven through the injected FreeBusy deps.
process.env.GOOGLE_CALENDAR_ID = "docka-demo@group.calendar.google.com";
process.env.GOOGLE_SA_CLIENT_EMAIL = "sa@docka.iam.gserviceaccount.com";
process.env.GOOGLE_SA_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n";
const CAL_ID = process.env.GOOGLE_CALENDAR_ID;

const {
  getBusyIntervals,
  getBusyWallRangesForRender,
  getBusyWallRangesForBooking,
  __resetBusyCache,
  __setBusyDeps,
} = await import("@/lib/google-calendar");
const {
  excludeBusySlots,
  generateSlots,
  getBookingSettings,
  DEFAULT_BOOKING_SETTINGS,
} = await import("@/lib/booking");
const { readDB, updateDB } = await import("@/lib/db");
const { __resetGlobalBookingRate } = await import("@/lib/booking-rate-limit");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { reconcileBookingSync, __resetBookingSyncLock } = await import("@/lib/booking-sync");
const { NextRequest } = await import("next/server");
const bookRoute = await import("@/app/api/book/route");
const { t } = await import("@/lib/i18n");

process.on("exit", () => {
  __setBusyDeps(null);
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---- FreeBusy test doubles --------------------------------------------------

/** A minimal FreeBusy Response stand-in: only status + json() are read. */
function fbRes(status, body) {
  return { status, json: async () => body };
}
/** Wrap busy intervals into the FreeBusy calendars[id].busy shape. */
function busyBody(intervals) {
  return { calendars: { [CAL_ID]: { busy: intervals } } };
}
/**
 * Build FreeBusy deps that replay a queue of responses (a function entry is called to
 * produce its response, so a never-resolving fetch can be injected). Records the outgoing
 * request bodies for window assertions.
 */
function fbDeps(responses, { token = async () => "tok", timeoutMs } = {}) {
  const queue = [...responses];
  const calls = [];
  return {
    calls,
    deps: {
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (queue.length === 0) throw new Error("fbDeps: no more queued responses");
        const next = queue.shift();
        return typeof next === "function" ? next() : next;
      },
      getToken: token,
      timeoutMs,
    },
  };
}

const S = DEFAULT_BOOKING_SETTINGS; // Europe/Tallinn, 30-min, horizon 21, Mon–Fri 09–17

// ===========================================================================
// 1. getBusyIntervals — STRICT parse (AV8-3)
// ===========================================================================

test("getBusyIntervals: 2xx + busy array -> parsed intervals", async () => {
  const { deps } = fbDeps([
    fbRes(200, busyBody([{ start: "2026-08-24T06:00:00Z", end: "2026-08-24T06:30:00Z" }])),
  ]);
  const out = await getBusyIntervals("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z", deps);
  assert.deepEqual(out, [{ startUtc: "2026-08-24T06:00:00Z", endUtc: "2026-08-24T06:30:00Z" }]);
});

test("getBusyIntervals: 2xx + explicit empty busy -> [] (authoritative, no throw)", async () => {
  const { deps } = fbDeps([fbRes(200, busyBody([]))]);
  const out = await getBusyIntervals("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z", deps);
  assert.deepEqual(out, []);
});

test("getBusyIntervals: 2xx + calendars[id].errors -> THROWS (not 'nothing busy')", async () => {
  const { deps } = fbDeps([
    fbRes(200, { calendars: { [CAL_ID]: { errors: [{ domain: "global", reason: "notFound" }] } } }),
  ]);
  await assert.rejects(() => getBusyIntervals("a", "b", deps), /not authoritative/);
});

test("getBusyIntervals: HTTP 500 -> THROWS (caller fail-softs)", async () => {
  const { deps } = fbDeps([fbRes(500, {})]);
  await assert.rejects(() => getBusyIntervals("a", "b", deps), /FreeBusy failed: 500/);
});

// ===========================================================================
// 2. excludeBusySlots — pure end-exclusive overlap filter
// ===========================================================================

const slot = (date, time) => ({ date, time, tz: "Europe/Tallinn" });
const wall = (startWall, endWall) => ({ startWall, endWall });

test("excludeBusySlots: overlap removed; end-exclusive adjacency kept (09:00–09:30 removes 09:00, keeps 09:30)", () => {
  const slots = [slot("2026-08-24", "09:00"), slot("2026-08-24", "09:30")];
  const out = excludeBusySlots(slots, [wall("2026-08-24T09:00", "2026-08-24T09:30")], 30);
  assert.deepEqual(out.map((s) => s.time), ["09:30"]);
});

test("excludeBusySlots: a busy sliver partly inside a slot removes the whole slot", () => {
  const slots = [slot("2026-08-24", "09:00"), slot("2026-08-24", "09:30")];
  const out = excludeBusySlots(slots, [wall("2026-08-24T09:10", "2026-08-24T09:20")], 30);
  assert.deepEqual(out.map((s) => s.time), ["09:30"]);
});

test("excludeBusySlots: busy spanning several slots removes all of them", () => {
  const slots = ["09:00", "09:30", "10:00", "10:30", "11:00"].map((tm) => slot("2026-08-24", tm));
  const out = excludeBusySlots(slots, [wall("2026-08-24T09:00", "2026-08-24T11:00")], 30);
  assert.deepEqual(out.map((s) => s.time), ["11:00"]);
});

test("excludeBusySlots: day-1 busy leaves the same-time slot on day-2 intact (AV8-5)", () => {
  const slots = [slot("2026-08-24", "09:00"), slot("2026-08-25", "09:00")];
  const out = excludeBusySlots(slots, [wall("2026-08-24T09:00", "2026-08-24T09:30")], 30);
  assert.deepEqual(
    out.map((s) => `${s.date} ${s.time}`),
    ["2026-08-25 09:00"]
  );
});

test("excludeBusySlots: an all-day wall range hides the whole day, keeps the next", () => {
  const slots = [
    slot("2026-08-24", "09:00"),
    slot("2026-08-24", "16:30"),
    slot("2026-08-25", "09:00"),
  ];
  const out = excludeBusySlots(slots, [wall("2026-08-24T00:00", "2026-08-25T00:00")], 30);
  assert.deepEqual(
    out.map((s) => `${s.date} ${s.time}`),
    ["2026-08-25 09:00"]
  );
});

test("excludeBusySlots: empty range list returns the slots unchanged", () => {
  const slots = [slot("2026-08-24", "09:00")];
  assert.deepEqual(excludeBusySlots(slots, [], 30), slots);
});

// ===========================================================================
// 3. Busy cache: TTL / single-flight / no-wedge / timeout / serve-stale / horizon
// ===========================================================================

test("cache: fresh within TTL serves the cache (one fetch), refetches past TTL", async () => {
  __resetBusyCache();
  const { deps, calls } = fbDeps([
    fbRes(200, busyBody([{ start: "2026-08-24T06:00:00Z", end: "2026-08-24T06:30:00Z" }])),
    fbRes(200, busyBody([])),
  ]);
  const t0 = new Date("2026-08-24T05:00:00Z");
  const r1 = await getBusyWallRangesForRender(S, t0, deps);
  assert.equal(r1.stale, false);
  assert.equal(calls.length, 1);

  // +30s: still within the 60s TTL -> cache, no new fetch.
  await getBusyWallRangesForRender(S, new Date(t0.getTime() + 30_000), deps);
  assert.equal(calls.length, 1, "within TTL must not refetch");

  // +61s: past TTL -> refetch.
  await getBusyWallRangesForRender(S, new Date(t0.getTime() + 61_000), deps);
  assert.equal(calls.length, 2, "past TTL must refetch");
});

test("cache: single-flight — concurrent cold callers trigger exactly ONE fetch", async () => {
  __resetBusyCache();
  const { deps, calls } = fbDeps([fbRes(200, busyBody([]))]);
  const now = new Date("2026-08-24T05:00:00Z");
  await Promise.all([
    getBusyWallRangesForRender(S, now, deps),
    getBusyWallRangesForRender(S, now, deps),
    getBusyWallRangesForRender(S, now, deps),
  ]);
  assert.equal(calls.length, 1, "N concurrent callers must dedupe onto one fetch");
});

test("cache: a rejected refresh does NOT wedge — the next call refetches fresh", async () => {
  __resetBusyCache();
  const { deps, calls } = fbDeps([
    fbRes(500, {}), // first refresh throws
    fbRes(200, busyBody([{ start: "2026-08-24T06:00:00Z", end: "2026-08-24T06:30:00Z" }])),
  ]);
  const now = new Date("2026-08-24T05:00:00Z");
  const r1 = await getBusyWallRangesForRender(S, now, deps);
  assert.equal(r1.stale, true, "cold + error -> stale");
  assert.deepEqual(r1.ranges, []);
  const r2 = await getBusyWallRangesForRender(S, now, deps);
  assert.equal(r2.stale, false, "second call refetched successfully (no wedge)");
  assert.equal(r2.ranges.length, 1);
  assert.equal(calls.length, 2);
});

test("cache: a never-resolving FreeBusy aborts on the hard timeout -> fail-soft stale", async () => {
  __resetBusyCache();
  const started = Date.now();
  const { deps } = fbDeps([() => new Promise(() => {})], { timeoutMs: 60 });
  const r = await getBusyWallRangesForRender(S, new Date("2026-08-24T05:00:00Z"), deps);
  assert.equal(r.stale, true);
  assert.deepEqual(r.ranges, []);
  assert.ok(Date.now() - started < 2000, "must return via the timeout, not hang");
});

test("cache: serve-stale within the max-staleness cap keeps filtering (no banner)", async () => {
  __resetBusyCache();
  const { deps } = fbDeps([
    fbRes(200, busyBody([{ start: "2026-08-24T06:00:00Z", end: "2026-08-24T06:30:00Z" }])),
    fbRes(500, {}), // the refresh past TTL fails
  ]);
  const t0 = new Date("2026-08-24T05:00:00Z");
  const good = await getBusyWallRangesForRender(S, t0, deps);
  assert.equal(good.ranges.length, 1);
  // +5 min: past TTL, refresh fails, but within the 15-min cap -> serve last-good.
  const stale = await getBusyWallRangesForRender(S, new Date(t0.getTime() + 5 * 60_000), deps);
  assert.equal(stale.stale, false, "within the cap the last-good ranges still filter");
  assert.equal(stale.ranges.length, 1);
});

test("cache: past the max-staleness cap -> stops filtering, signals stale (AV9-2)", async () => {
  __resetBusyCache();
  const { deps } = fbDeps([
    fbRes(200, busyBody([{ start: "2026-08-24T06:00:00Z", end: "2026-08-24T06:30:00Z" }])),
    fbRes(500, {}),
  ]);
  const t0 = new Date("2026-08-24T05:00:00Z");
  await getBusyWallRangesForRender(S, t0, deps);
  // +16 min: past the 15-min cap with a failing refresh -> unfiltered + stale.
  const r = await getBusyWallRangesForRender(S, new Date(t0.getTime() + 16 * 60_000), deps);
  assert.equal(r.stale, true);
  assert.deepEqual(r.ranges, []);
});

test("horizon window (AV8-4/AV9-4): timeMax = start-of-day(today+horizon+1) covers the full last day; a last-day busy hides its slot, a beyond-horizon busy hides nothing", async () => {
  __resetBusyCache();
  // horizon=1 => only today (Mon 2026-08-24) is offered. Now 05:00Z == Tallinn 08:00.
  const settings = { ...S, horizonDays: 1 };
  const now = new Date("2026-08-24T05:00:00Z");
  // A busy today 15:00–15:30 Tallinn (== 12:00–12:30Z), plus a beyond-horizon busy on Aug-25.
  const { deps, calls } = fbDeps([
    fbRes(
      200,
      busyBody([
        { start: "2026-08-24T12:00:00Z", end: "2026-08-24T12:30:00Z" }, // Tallinn 15:00–15:30
        { start: "2026-08-25T12:00:00Z", end: "2026-08-25T12:30:00Z" }, // Aug-25 (beyond horizon)
      ])
    ),
  ]);
  const busy = await getBusyWallRangesForRender(settings, now, deps);

  // Window: timeMin = Tallinn midnight Aug-24 (2026-08-23T21:00Z); timeMax = Tallinn
  // midnight Aug-26 (today+horizon+1 => 2026-08-25T21:00Z) — the full last day is covered.
  assert.equal(calls[0].body.timeMin, "2026-08-23T21:00:00.000Z");
  assert.equal(calls[0].body.timeMax, "2026-08-25T21:00:00.000Z");
  assert.equal(calls[0].body.items[0].id, CAL_ID);

  const slots = generateSlots(settings, [], now);
  const filtered = excludeBusySlots(slots, busy.ranges, settings.slotMinutes);
  const times24 = filtered.filter((s) => s.date === "2026-08-24").map((s) => s.time);
  assert.ok(!times24.includes("15:00"), "the last-day busy slot is hidden");
  assert.ok(times24.includes("14:30") && times24.includes("15:30"), "adjacent slots survive");
  assert.ok(
    !filtered.some((s) => s.date === "2026-08-25"),
    "horizon=1 offers no Aug-25 slots, so a beyond-horizon busy hides nothing"
  );
});

// ===========================================================================
// 4. POST /api/book — authoritative busy gate + bounded fail-open (AV8-1 / AV9-1)
// ===========================================================================

let ipSeq = 0;
function freshIp() {
  return `10.9.0.${++ipSeq}`;
}
function postReq(body, ip = freshIp()) {
  return new NextRequest("http://localhost/api/book", {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-test-ip": ip },
    body: JSON.stringify(body),
  });
}
function resetStore() {
  fs.writeFileSync(DB_PATH, "{}", "utf8");
  resetRegistryAbuseState();
  __resetGlobalBookingRate();
  __resetBusyCache();
}
function firstOpenSlot() {
  const db = readDB();
  const slots = generateSlots(getBookingSettings(db), db.bookings, new Date());
  assert.ok(slots.length > 0);
  return slots[0];
}
const validForm = (s, extra = {}) => ({
  name: "Alice Example",
  email: "alice@example.com",
  date: s.date,
  time: s.time,
  ...extra,
});

test("POST: cold cache + Google UP + slot overlaps a busy range -> 409, no db write, no push", async () => {
  resetStore();
  // A giant all-covering busy range so the chosen slot is definitely busy.
  __setBusyDeps(
    fbDeps([fbRes(200, busyBody([{ start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" }]))])
      .deps
  );
  const res = await bookRoute.POST(postReq(validForm(firstOpenSlot())));
  assert.equal(res.status, 409);
  assert.equal(readDB().bookings.length, 0, "an overlapping slot must never be recorded");
  __setBusyDeps(null);
});

test("POST: Google UP + slot clear -> 200 and busyCheck:'ok'", async () => {
  resetStore();
  __setBusyDeps(fbDeps([fbRes(200, busyBody([]))]).deps);
  const res = await bookRoute.POST(postReq(validForm(firstOpenSlot())));
  assert.equal(res.status, 200);
  const row = readDB().bookings[0];
  assert.equal(row.busyCheck, "ok");
  __setBusyDeps(null);
});

test("POST: never-resolving Google -> bounded fail-OPEN within the deadline + flagged skipped-outage", async () => {
  resetStore();
  // A never-resolving FreeBusy with a short injected deadline: the POST must return via the
  // deadline (single attempt), NOT hang or retry.
  __setBusyDeps(fbDeps([() => new Promise(() => {})], { timeoutMs: 150 }).deps);
  const started = Date.now();
  const res = await bookRoute.POST(postReq(validForm(firstOpenSlot())));
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200, "a Google outage must NOT block a real booking (fail-open)");
  assert.ok(elapsed < 2500, `POST returned in ${elapsed}ms via the deadline, not a multi-retry stall`);
  const row = readDB().bookings[0];
  assert.equal(row.busyCheck, "skipped-outage", "the fail-open booking is flagged for reconciliation");
  __setBusyDeps(null);
});

// ===========================================================================
// 5. Admin render wiring (AV9-3a) — the badge string + the page conditional
// ===========================================================================

test("admin badge: the outage badge key resolves in every locale", () => {
  for (const code of ["en", "zh", "ru", "tl", "id", "vi"]) {
    const s = t(code, "book.outageBadge");
    assert.equal(typeof s, "string");
    assert.ok(s.trim().length > 0 && s !== "book.outageBadge", `missing outageBadge for ${code}`);
  }
  assert.ok(t("en", "book.outageBadge").includes("verify for overlap"));
});

test("admin render path: the bookings page renders the badge for skipped-outage rows", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pageSrc = fs.readFileSync(
    path.join(here, "..", "app", "admin", "bookings", "page.tsx"),
    "utf8"
  );
  assert.ok(
    pageSrc.includes('busyCheck === "skipped-outage"'),
    "the admin page must branch on the skipped-outage marker"
  );
  assert.ok(pageSrc.includes("book.outageBadge"), "the admin page must render the outage badge key");
});

// ===========================================================================
// 6. Reconciler outage re-check (AV9-3b)
// ===========================================================================

function fakeDb(bookings) {
  return { bookings, bookingSettings: null };
}
function reconDeps(db, busy) {
  return {
    now: () => new Date("2026-08-24T05:00:00Z"),
    read: () => db,
    update: async (mutator) => mutator(db),
    push: async (b) => ({ ok: true, googleEventId: "x" }),
    del: async () => ({ ok: true }),
    calendarConfigured: () => true,
    adminBaseUrl: "https://docka.me/admin/bookings",
    busy,
  };
}

test("reconciler: a skipped-outage booking whose slot is actually free -> marker cleared to 'ok'", async () => {
  __resetBookingSyncLock();
  const b = {
    id: "o1",
    status: "booked",
    date: "2026-08-25",
    time: "10:00",
    tz: "Europe/Tallinn",
    createdAt: "2026-08-24T04:00:00.000Z",
    calendarSync: "synced", // already synced, so it is NOT in the push batch
    busyCheck: "skipped-outage",
  };
  const db = fakeDb([b]);
  const res = await reconcileBookingSync(reconDeps(db, async () => ({ ok: true, ranges: [] })));
  assert.equal(res.outageRechecked, 1);
  assert.equal(res.outageCleared, 1);
  assert.equal(b.busyCheck, "ok", "a slot confirmed free clears the outage marker");
});

test("reconciler: a skipped-outage booking that overlaps a real event keeps the badge", async () => {
  __resetBookingSyncLock();
  const b = {
    id: "o2",
    status: "booked",
    date: "2026-08-25",
    time: "10:00",
    tz: "Europe/Tallinn",
    createdAt: "2026-08-24T04:00:00.000Z",
    calendarSync: "synced",
    busyCheck: "skipped-outage",
  };
  const db = fakeDb([b]);
  const res = await reconcileBookingSync(
    reconDeps(db, async () => ({
      ok: true,
      ranges: [{ startWall: "2026-08-25T10:00", endWall: "2026-08-25T10:30" }],
    }))
  );
  assert.equal(res.outageRechecked, 1);
  assert.equal(res.outageCleared, 0);
  assert.equal(b.busyCheck, "skipped-outage", "an overlap leaves the badge for manual attention");
});

test("reconciler: Google still down (busy ok:false) -> markers untouched, retried next tick", async () => {
  __resetBookingSyncLock();
  const b = {
    id: "o3",
    status: "booked",
    date: "2026-08-25",
    time: "10:00",
    tz: "Europe/Tallinn",
    createdAt: "2026-08-24T04:00:00.000Z",
    calendarSync: "synced",
    busyCheck: "skipped-outage",
  };
  const db = fakeDb([b]);
  const res = await reconcileBookingSync(reconDeps(db, async () => ({ ok: false })));
  assert.equal(res.outageCleared, 0);
  assert.equal(b.busyCheck, "skipped-outage");
});
