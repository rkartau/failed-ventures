// Route-handler tests for the tracking endpoints (plan Phase B):
//   app/o/[token]/route.ts — open pixel (fail-closed, OFF-by-default, always GIF)
//   app/u/[token]/route.ts — unsubscribe (fail-closed, one-click POST, idempotent)
//   + edge abuse controls (lib/tracking-edge)
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-endpoints.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-outreach-endpoints-"));
process.chdir(TMP);

const SECRET = "s".repeat(48);
const ENV = { TRACKING_HMAC_SECRET: SECRET };

const { mintTrackingToken } = await import("@/lib/tracking-token");
const { readEventsSince, aggregateBySendKey } = await import("@/lib/outreach-events");
const oPixel = await import("@/app/o/[token]/route");
const uUnsub = await import("@/app/u/[token]/route");
const { consumeTrackingBudget, __resetTrackingEdge, bodyOverCap, clientIpFromHeaders } =
  await import("@/lib/tracking-edge");

const DATA = path.join(TMP, "data");
function freshData() {
  fs.rmSync(DATA, { recursive: true, force: true });
}
const dummyReq = {};

function setSecret(on) {
  if (on) process.env.TRACKING_HMAC_SECRET = SECRET;
  else delete process.env.TRACKING_HMAC_SECRET;
}

// ============================== /o open pixel ===============================

test("(fail-closed) /o returns 503 when TRACKING_HMAC_SECRET is unset", async () => {
  setSecret(false);
  const res = await oPixel.GET(dummyReq, { params: { token: "anything.gif" } });
  assert.equal(res.status, 503);
});

test("/o always returns a 1x1 GIF with no-store; records nothing while OFF (default)", async () => {
  setSecret(true);
  freshData();
  delete process.env.OUTREACH_OPEN_PIXEL_ENABLED; // default: dormant
  const tok = mintTrackingToken({ send_key: "sk", message_id: "m", touch: 1, event: "open" }, ENV);
  const res = await oPixel.GET(dummyReq, { params: { token: tok + ".gif" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/gif");
  assert.match(res.headers.get("cache-control"), /no-store/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 6).toString("latin1"), "GIF89a");
  // Dormant → no event recorded.
  assert.equal(readEventsSince().events.length, 0);
});

test("/o records an open ONLY when the pixel is enabled; forged token never records", async () => {
  setSecret(true);
  freshData();
  process.env.OUTREACH_OPEN_PIXEL_ENABLED = "1";
  try {
    const tok = mintTrackingToken({ send_key: "skO", message_id: "m", touch: 2, event: "open" }, ENV);
    const res = await oPixel.GET(dummyReq, { params: { token: tok + ".gif" } });
    assert.equal(res.status, 200);
    let events = readEventsSince().events;
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "open");
    assert.equal(events[0].send_key, "skO");

    // Forged/invalid token → still a GIF, but NO new record.
    const res2 = await oPixel.GET(dummyReq, { params: { token: "garbage.gif" } });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("content-type"), "image/gif");
    assert.equal(readEventsSince().events.length, 1);
  } finally {
    delete process.env.OUTREACH_OPEN_PIXEL_ENABLED;
  }
});

// ============================== /u unsubscribe ==============================

test("(fail-closed) /u POST and GET return 503 when secret unset", async () => {
  setSecret(false);
  const p = await uUnsub.POST(dummyReq, { params: { token: "x" } });
  assert.equal(p.status, 503);
  const g = await uUnsub.GET(dummyReq, { params: { token: "x" } });
  assert.equal(g.status, 503);
});

test("/u POST records an unsub and returns 200 (RFC 8058 one-click)", async () => {
  setSecret(true);
  freshData();
  const tok = mintTrackingToken({ send_key: "skU", message_id: "m", touch: 1, event: "unsub" }, ENV);
  const res = await uUnsub.POST(dummyReq, { params: { token: tok } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.unsubscribed, true);
  const events = readEventsSince().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "unsub");
  assert.equal(events[0].send_key, "skU");
});

test("(u) unsub idempotency: same token POSTed twice → one logical suppression, no error", async () => {
  setSecret(true);
  freshData();
  const tok = mintTrackingToken({ send_key: "idem", message_id: "m", touch: 1, event: "unsub" }, ENV);
  const r1 = await uUnsub.POST(dummyReq, { params: { token: tok } });
  const r2 = await uUnsub.POST(dummyReq, { params: { token: tok } });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200); // no error on repeat
  const events = readEventsSince().events;
  assert.equal(events.length, 2, "two rows on disk");
  assert.equal(events[0].event_key, events[1].event_key, "same event_key → collapses");
  const agg = aggregateBySendKey(events);
  assert.equal(agg.size, 1);
  assert.equal(agg.get("idem").unsubbed, true);
});

test("/u POST with a forged token → 400, records nothing", async () => {
  setSecret(true);
  freshData();
  const res = await uUnsub.POST(dummyReq, { params: { token: "forged.token" } });
  assert.equal(res.status, 400);
  assert.equal(readEventsSince().events.length, 0);
});

test("/u GET is a human confirm page that does NOT record (avoids prefetch/scanner false unsubs)", async () => {
  setSecret(true);
  freshData();
  const tok = mintTrackingToken({ send_key: "skG", message_id: "m", touch: 1, event: "unsub" }, ENV);
  const res = await uUnsub.GET(dummyReq, { params: { token: tok } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /<form method="POST"/i);
  assert.equal(readEventsSince().events.length, 0, "GET must not record");
  // A bad token on GET → an error page (400), still no record.
  const bad = await uUnsub.GET(dummyReq, { params: { token: "nope" } });
  assert.equal(bad.status, 400);
});

// ============================ edge abuse controls ===========================

test("edge: per-IP token bucket eventually 429s a hammering IP", () => {
  __resetTrackingEdge();
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (consumeTrackingBudget("1.2.3.4", 1000)) allowed++;
  assert.ok(allowed <= 20 && allowed >= 1, `burst capped, got ${allowed}`);
  // A different IP is unaffected.
  assert.equal(consumeTrackingBudget("5.6.7.8", 1000), true);
});

test("edge: bodyOverCap reads Content-Length only; client IP prefers X-Real-IP then rightmost XFF", () => {
  assert.equal(bodyOverCap(new Headers({ "content-length": "999999" })), true);
  assert.equal(bodyOverCap(new Headers({ "content-length": "10" })), false);
  assert.equal(bodyOverCap(new Headers()), false);
  assert.equal(clientIpFromHeaders(new Headers({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  assert.equal(
    clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" })),
    "3.3.3.3"
  );
});
