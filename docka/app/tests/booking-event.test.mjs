// Plan E3 — booking-event contract test. Drives the REAL public POST /api/book
// route end-to-end against a temp db.json AND the real append-only event store,
// asserting the single booking-event writer (E1/C2):
//   * /book?lead=<send_key> (forwarded as body.leadKey, per the shipped
//     BookClient -> sanitizeLeadKey contract) -> EXACTLY ONE booking event
//     with the correct send_key + booking_id (the persisted booking's id);
//   * a booking with NO lead -> ZERO events (organic bookings carry none);
//   * TWO DISTINCT bookings for the SAME send_key -> TWO DISTINCT event_keys
//     (booking_id in the key keeps genuine bookings from collapsing);
//   * a REPLAY of one booking event -> folds to ONE (dedup by event_key).
//
// The 1-URL + 2-placeholder send guards live on the pipeline side (send.py
// fill_body emits the single docka.me/book?lead=<send_key> URL — verified there,
// E2); this test pins the app-side event contract those links feed.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking-event.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-booking-event-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
const DATA = path.join(TMP, "data");
const DB_PATH = path.join(DATA, "db.json");

process.env.REGISTRY_MOCK = "1";
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";
delete process.env.GOOGLE_SA_CLIENT_EMAIL;
delete process.env.GOOGLE_SA_PRIVATE_KEY;
delete process.env.GOOGLE_CALENDAR_ID;

const { readDB } = await import("@/lib/db");
const { getBookingSettings, generateSlots } = await import("@/lib/booking");
const { __resetGlobalBookingRate } = await import("@/lib/booking-rate-limit");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { readEventsSince, aggregateBySendKey, eventKey, appendEvent } = await import(
  "@/lib/outreach-events"
);
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

let ipSeq = 0;
function freshIp() {
  return `10.1.0.${++ipSeq}`;
}

function postReq(body, ip = freshIp()) {
  return new NextRequest("http://localhost/api/book", {
    method: "POST",
    headers: { "content-type": "application/json", "x-registry-test-ip": ip },
    body: JSON.stringify(body),
  });
}

/** Wipe db.json AND the event store between tests, reset the limiters. */
function resetAll() {
  for (const f of fs.readdirSync(DATA)) {
    if (f.startsWith("outreach-events-") || f === ".segment.lock") {
      fs.rmSync(path.join(DATA, f), { force: true });
    }
  }
  fs.writeFileSync(DB_PATH, "{}", "utf8");
  resetRegistryAbuseState();
  __resetGlobalBookingRate();
}

function firstOpenSlot() {
  const db = readDB();
  const slots = generateSlots(getBookingSettings(db), db.bookings, new Date());
  assert.ok(slots.length > 0, "the default schedule must offer at least one open slot");
  return slots[0];
}

const form = (slot, extra = {}) => ({
  name: "Alice Example",
  email: "alice@example.com",
  date: slot.date,
  time: slot.time,
  ...extra,
});

function allEvents() {
  return readEventsSince().events;
}

// ===========================================================================

test("E3: /book with lead -> exactly ONE booking event, correct send_key + booking_id", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(form(slot, { leadKey: "LD00042" })));
  assert.equal(res.status, 200);

  const booking = readDB().bookings[0];
  assert.ok(booking && booking.id);

  const evs = allEvents().filter((e) => e.event === "booking");
  assert.equal(evs.length, 1, "exactly one booking event");
  assert.equal(evs[0].send_key, "LD00042");
  assert.equal(evs[0].booking_id, booking.id);
  // event_key matches the byte-exact contract (booking_id occupies the touch slot).
  assert.equal(
    evs[0].event_key,
    eventKey({ send_key: "LD00042", event: "booking", booking_id: booking.id })
  );
});

test("E3: booking WITHOUT lead -> zero events", async () => {
  resetAll();
  const slot = firstOpenSlot();
  const res = await bookRoute.POST(postReq(form(slot)));
  assert.equal(res.status, 200);
  assert.equal(allEvents().length, 0, "organic booking emits no event");
});

test("E3: two DISTINCT bookings, same send_key -> two DISTINCT event_keys", async () => {
  resetAll();
  const slot1 = firstOpenSlot();
  assert.equal((await bookRoute.POST(postReq(form(slot1, { leadKey: "LD00099" })))).status, 200);
  // second bookable slot (the first is now taken)
  const slot2 = firstOpenSlot();
  assert.equal((await bookRoute.POST(postReq(form(slot2, { leadKey: "LD00099" })))).status, 200);

  const evs = allEvents().filter((e) => e.event === "booking");
  assert.equal(evs.length, 2, "two genuine bookings");
  const keys = new Set(evs.map((e) => e.event_key));
  assert.equal(keys.size, 2, "distinct event_keys — not collapsed");
  // But they fold to ONE send_key with TWO distinct booking_ids.
  const agg = aggregateBySendKey(evs).get("LD00099");
  assert.equal(agg.booked, true);
  assert.equal(agg.bookingIds.length, 2);
});

test("E3: replay of one booking event folds to ONE (dedup by event_key)", async () => {
  resetAll();
  const slot = firstOpenSlot();
  assert.equal((await bookRoute.POST(postReq(form(slot, { leadKey: "LD00007" })))).status, 200);
  const booking = readDB().bookings[0];

  // Simulate a redelivered/re-appended booking event (same booking_id).
  await appendEvent({ event: "booking", send_key: "LD00007", booking_id: booking.id });

  // Two raw rows on disk, but they carry the SAME event_key...
  const evs = allEvents().filter((e) => e.event === "booking");
  assert.equal(evs.length, 2, "the replay writes a second raw row");
  assert.equal(new Set(evs.map((e) => e.event_key)).size, 1, "same event_key");
  // ...so the fold (dedup by event_key) collapses them to ONE booking.
  const agg = aggregateBySendKey(evs).get("LD00007");
  assert.equal(agg.bookingIds.length, 1, "replay folds to one booking");
});
