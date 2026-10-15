// Unit tests for the append-only web-tracking event sink (plan Phase C):
//   lib/outreach-events.ts — event_key contract, codepoint-safe byte guard,
//                            segment reader, rollover span, torn-line recovery,
//                            aggregateBySendKey dedup.
//   lib/tracking-token.ts  — HMAC signed-token mint/verify (fail-closed).
//   lib/tracking-matcher.ts— matcher self-test.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-events.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Throwaway cwd BEFORE any @/lib import — the event store resolves cwd/data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-outreach-events-"));
process.chdir(TMP);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  eventKey,
  eventKeySlots,
  encodeLine,
  appendEvent,
  readEventsSince,
  aggregateBySendKey,
  MAX_LINE_BYTES,
} = await import("@/lib/outreach-events");
const { mintTrackingToken, verifyTrackingToken, trackingSecretConfigured } = await import(
  "@/lib/tracking-token"
);
const { assertTrackingMatcher, matcherMatches, MIDDLEWARE_MATCHER } = await import(
  "@/lib/tracking-matcher"
);

const DATA = path.join(TMP, "data");

function freshData() {
  fs.rmSync(DATA, { recursive: true, force: true });
}

// ============================ event_key contract ============================

test("(n) golden vectors: TS serializer reproduces every expected digest", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "outreach-event-key-golden.json"), "utf8")
  );
  assert.ok(fixture.cases.length >= 6);
  for (const c of fixture.cases) {
    const got = eventKey(c.input);
    assert.equal(got, c.expected_event_key, `case ${c.name}`);
    assert.deepEqual(eventKeySlots(c.input), c.slots, `slots ${c.name}`);
  }
});

test("event_key: absent message_id and null touch both serialize to empty string", () => {
  // These MUST be equal — both null touch and undefined touch → "".
  const a = eventKey({ send_key: "s", message_id: "m", event: "open", touch: null });
  const b = eventKey({ send_key: "s", message_id: "m", event: "open" });
  assert.equal(a, b);
  // absent message_id === explicit empty message_id
  const c = eventKey({ send_key: "s", event: "open", touch: 2 });
  const d = eventKey({ send_key: "s", message_id: "", event: "open", touch: 2 });
  assert.equal(c, d);
});

test("event_key: two distinct bookings differ; a replay collapses", () => {
  const b1 = eventKey({ send_key: "s", event: "booking", booking_id: "bk1" });
  const b2 = eventKey({ send_key: "s", event: "booking", booking_id: "bk2" });
  const b1again = eventKey({ send_key: "s", event: "booking", booking_id: "bk1" });
  assert.notEqual(b1, b2);
  assert.equal(b1, b1again);
});

// ======================= codepoint-safe byte guard (o) ======================

test("(o) encodeLine: 4090-char 4-byte-emoji meta → line < 4000 bytes, valid UTF-8, whole codepoints", () => {
  const meta = "🚀".repeat(4090); // ~16 KB raw
  const row = {
    event_key: "k",
    at: new Date().toISOString(),
    event: "open",
    send_key: "sk",
    message_id: "mid",
    touch: 1,
    meta,
  };
  const line = encodeLine(row);
  assert.ok(Buffer.byteLength(line, "utf8") < MAX_LINE_BYTES, "line under byte budget");
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line); // valid JSON + valid UTF-8 or this throws
  // Every codepoint of the truncated meta is a WHOLE rocket — never a lone surrogate.
  for (const cp of parsed.meta) assert.equal(cp, "🚀");
  assert.ok(parsed.meta.length < meta.length, "meta was actually truncated");
});

test("encodeLine: short row is emitted untouched (with a trailing newline)", () => {
  const row = { event_key: "k", at: "t", event: "unsub", send_key: "sk", message_id: "m", touch: 0 };
  const line = encodeLine(row);
  assert.equal(line, JSON.stringify(row) + "\n");
});

// ============================== append + read ===============================

test("appendEvent + readEventsSince: single event round-trips with its stored event_key", async () => {
  freshData();
  const r = await appendEvent({ event: "unsub", send_key: "skA", message_id: "m1", touch: 1 });
  const { events } = readEventsSince();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "unsub");
  assert.equal(events[0].send_key, "skA");
  assert.equal(events[0].event_key, r.event_key);
  assert.equal(events[0].event_key, eventKey({ send_key: "skA", message_id: "m1", event: "unsub", touch: 1 }));
});

test("(f) readEventsSince spans a segment rollover — a pre-rollover cursor loses nothing", async () => {
  freshData();
  process.env.OUTREACH_SEGMENT_MAX_BYTES = "220"; // force frequent rollovers
  try {
    for (let i = 0; i < 6; i++) {
      await appendEvent({ event: "open", send_key: "s", message_id: "m" + i, touch: i });
    }
    const first = readEventsSince();
    assert.equal(first.events.length, 6);
    // more than one segment was created
    const segs = fs.readdirSync(DATA).filter((f) => /^outreach-events-\d+\.jsonl$/.test(f));
    assert.ok(segs.length >= 2, `expected multiple segments, got ${segs.join(",")}`);

    // Append across further rollovers, then read from the STORED pre-rollover cursor.
    for (let i = 6; i < 12; i++) {
      await appendEvent({ event: "open", send_key: "s", message_id: "m" + i, touch: i });
    }
    const rest = readEventsSince(first.cursor);
    assert.equal(rest.events.length, 6, "exactly the 6 post-cursor events, across rollover");
    const all = readEventsSince();
    assert.equal(all.events.length, 12);
  } finally {
    delete process.env.OUTREACH_SEGMENT_MAX_BYTES;
  }
});

test("(l) torn final line is left for the next read, then folded whole", async () => {
  freshData();
  await appendEvent({ event: "unsub", send_key: "good", message_id: "m", touch: 1 });
  // Manually append a PARTIAL line (no trailing newline) to the active segment.
  const segFile = fs
    .readdirSync(DATA)
    .filter((f) => /^outreach-events-\d+\.jsonl$/.test(f))
    .sort()
    .pop();
  const segPath = path.join(DATA, segFile);
  const partial = '{"event_key":"torn","at":"t","event":"unsub","send_key":"torny","message_id":"m","touch":9';
  fs.appendFileSync(segPath, partial); // no "\n"

  const r1 = readEventsSince();
  assert.equal(r1.events.length, 1, "only the whole line folds");
  assert.equal(r1.events[0].send_key, "good");
  assert.equal(r1.skipped, 0, "a torn FINAL line is not counted as skipped — it's left unread");

  // Complete the torn line; reading from the stored cursor now folds it.
  fs.appendFileSync(segPath, "}\n");
  const r2 = readEventsSince(r1.cursor);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].send_key, "torny");
});

// ============================ aggregateBySendKey ============================

test("aggregateBySendKey: dedups by event_key (replay never double-counts)", async () => {
  freshData();
  // Same logical unsub appended twice → same event_key.
  await appendEvent({ event: "unsub", send_key: "dup", message_id: "m", touch: 1 });
  await appendEvent({ event: "unsub", send_key: "dup", message_id: "m", touch: 1 });
  await appendEvent({ event: "open", send_key: "dup", message_id: "m", touch: 1 });
  await appendEvent({ event: "booking", send_key: "dup", booking_id: "bk1" });

  const { events } = readEventsSince();
  assert.equal(events.length, 4, "all rows on disk (dedup is a read-side fold, not on write)");
  const agg = aggregateBySendKey(events);
  const a = agg.get("dup");
  assert.ok(a);
  assert.equal(a.unsubbed, true);
  assert.equal(a.opened, true);
  assert.equal(a.booked, true);
  assert.deepEqual(a.bookingIds, ["bk1"]);
  // The duplicate unsub collapsed: still exactly one logical suppression.
  const unsubRows = events.filter((e) => e.event === "unsub");
  assert.equal(unsubRows.length, 2);
  assert.equal(unsubRows[0].event_key, unsubRows[1].event_key);
});

// ============================ tracking tokens ===============================

const ENV = { TRACKING_HMAC_SECRET: "s".repeat(48) };

test("tracking token: mint → verify round-trip carries the payload", () => {
  const tok = mintTrackingToken(
    { send_key: "sk", message_id: "mid", touch: 2, event: "unsub" },
    ENV
  );
  const v = verifyTrackingToken(tok, "unsub", ENV);
  assert.equal(v.ok, true);
  assert.deepEqual(v.payload, { send_key: "sk", message_id: "mid", touch: 2, event: "unsub" });
});

test("tracking token: FAIL-CLOSED when secret unset → unconfigured", () => {
  const tok = mintTrackingToken({ send_key: "sk", message_id: "m", touch: 1, event: "open" }, ENV);
  assert.deepEqual(verifyTrackingToken(tok, "open", {}), { ok: false, reason: "unconfigured" });
  assert.equal(trackingSecretConfigured({}), false);
  assert.equal(trackingSecretConfigured(ENV), true);
});

test("tracking token: tampered payload or signature → bad-signature", () => {
  const tok = mintTrackingToken({ send_key: "sk", message_id: "m", touch: 1, event: "open" }, ENV);
  const [body, sig] = tok.split(".");
  // Flip a payload byte (re-encode a different send_key) but keep the old sig.
  const forgedBody = Buffer.from(
    JSON.stringify({ send_key: "EVIL", message_id: "m", touch: 1, event: "open" }),
    "utf8"
  ).toString("base64url");
  assert.equal(verifyTrackingToken(`${forgedBody}.${sig}`, "open", ENV).ok, false);
  assert.equal(verifyTrackingToken(`${forgedBody}.${sig}`, "open", ENV).reason, "bad-signature");
  // Flip a signature byte.
  const badSig = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.equal(verifyTrackingToken(`${body}.${badSig}`, "open", ENV).reason, "bad-signature");
});

test("tracking token: wrong-event (unsub token presented to /o) is rejected", () => {
  const tok = mintTrackingToken({ send_key: "sk", message_id: "m", touch: 1, event: "unsub" }, ENV);
  assert.equal(verifyTrackingToken(tok, "open", ENV).reason, "wrong-event");
});

test("tracking token: malformed structures rejected", () => {
  for (const bad of ["", "nodot", "a.b.c", ".sig", "body.", "x".repeat(5000)]) {
    assert.equal(verifyTrackingToken(bad, "open", ENV).ok, false);
  }
});

// ============================ matcher self-test =============================

test("matcher self-test: MIDDLEWARE_MATCHER covers /o/<token>.gif and /u/<token>", () => {
  assert.doesNotThrow(() => assertTrackingMatcher(MIDDLEWARE_MATCHER));
  assert.ok(matcherMatches(MIDDLEWARE_MATCHER, "/o/abc.gif"));
  assert.ok(matcherMatches(MIDDLEWARE_MATCHER, "/u/abc"));
  assert.ok(matcherMatches(MIDDLEWARE_MATCHER, "/admin/x"));
  assert.ok(!matcherMatches(MIDDLEWARE_MATCHER, "/other"));
});

test("matcher self-test: a matcher missing /o or /u FAILS (boot would abort)", () => {
  assert.throws(() => assertTrackingMatcher(["/admin/:path*", "/u/:path*"]), /\/o\//);
  assert.throws(() => assertTrackingMatcher(["/admin/:path*", "/o/:path*"]), /\/u\//);
});

// ================= Increment 5: signup / signup_started events ==============

test("(i5) appendEvent signup: row carries user_id (no message_id/touch); key matches recipe", async () => {
  freshData();
  const r = await appendEvent({ event: "signup", send_key: "LD42", user_id: "cred:abc-123" });
  assert.equal(
    r.event_key,
    eventKey({ send_key: "LD42", event: "signup", user_id: "cred:abc-123" })
  );
  const { events } = readEventsSince();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "signup");
  assert.equal(events[0].user_id, "cred:abc-123");
  assert.equal(events[0].message_id, undefined);
  assert.equal(events[0].touch, undefined);
  // No email supplied (username-only account) → no email field on the row.
  assert.equal(events[0].email, undefined);
});

test("(i5/[R2-7]) appendEvent signup with email: additive row field only — event_key IGNORES it", async () => {
  freshData();
  const r = await appendEvent({
    event: "signup",
    send_key: "LD42",
    user_id: "cred:abc-123",
    email: "master@shipco.example",
  });
  // Identical key with or without the email — the formula is untouched:
  // [send_key, "", "signup", user_id].
  assert.equal(
    r.event_key,
    eventKey({ send_key: "LD42", event: "signup", user_id: "cred:abc-123" })
  );
  const { events } = readEventsSince();
  assert.equal(events.length, 1);
  assert.equal(events[0].email, "master@shipco.example");
  assert.equal(events[0].user_id, "cred:abc-123");
});

test("(i5) appendEvent signup_started: normal decimal-touch recipe (cta-signup / 0)", async () => {
  freshData();
  const r = await appendEvent({
    event: "signup_started",
    send_key: "LD42",
    message_id: "cta-signup",
    touch: 0,
  });
  assert.equal(
    r.event_key,
    eventKey({ send_key: "LD42", message_id: "cta-signup", event: "signup_started", touch: 0 })
  );
  const { events } = readEventsSince();
  assert.equal(events[0].message_id, "cta-signup");
  assert.equal(events[0].touch, 0);
});

test("(i5) aggregate: signup replay collapses; two distinct accounts both recorded; signup_started flag", async () => {
  freshData();
  await appendEvent({ event: "signup_started", send_key: "LD1", message_id: "cta-signup", touch: 0 });
  await appendEvent({ event: "signup_started", send_key: "LD1", message_id: "cta-signup", touch: 0 });
  await appendEvent({ event: "signup", send_key: "LD1", user_id: "cred:a" });
  await appendEvent({ event: "signup", send_key: "LD1", user_id: "cred:a" }); // replay
  await appendEvent({ event: "signup", send_key: "LD1", user_id: "cred:b" }); // distinct
  const { events } = readEventsSince();
  const agg = aggregateBySendKey(events).get("LD1");
  assert.equal(agg.signedUp, true);
  assert.equal(agg.signupStarted, true);
  assert.deepEqual(agg.signupUserIds.sort(), ["cred:a", "cred:b"]);
  // Distinct event_keys: 1 started + 2 signups.
  assert.equal(new Set(events.map((e) => e.event_key)).size, 3);
});

// ============== Increment 5: signup tokens + golden mint vectors ============

test("(i5) signup token: mint → verify round-trip with expectEvent signup", () => {
  const tok = mintTrackingToken(
    { send_key: "LD42", message_id: "cta-signup", touch: 0, event: "signup" },
    ENV
  );
  const v = verifyTrackingToken(tok, "signup", ENV);
  assert.equal(v.ok, true);
  assert.equal(v.payload.send_key, "LD42");
  assert.equal(v.payload.event, "signup");
  // Pinned to its endpoint: a signup token presented as unsub/open is wrong-event.
  assert.equal(verifyTrackingToken(tok, "unsub", ENV).reason, "wrong-event");
  assert.equal(verifyTrackingToken(tok, "open", ENV).reason, "wrong-event");
});

test("(i5) signup token 4-case matrix: valid / tampered / foreign-secret / absent", () => {
  const payload = { send_key: "LD7", message_id: "cta-signup", touch: 0, event: "signup" };
  const tok = mintTrackingToken(payload, ENV);
  // valid
  assert.equal(verifyTrackingToken(tok, "signup", ENV).ok, true);
  // tampered (payload swapped, signature kept)
  const [, sig] = tok.split(".");
  const forged = Buffer.from(
    JSON.stringify({ send_key: "LD9", message_id: "cta-signup", touch: 0, event: "signup" }),
    "utf8"
  ).toString("base64url");
  assert.equal(verifyTrackingToken(`${forged}.${sig}`, "signup", ENV).reason, "bad-signature");
  // foreign secret
  const foreign = mintTrackingToken(payload, { TRACKING_HMAC_SECRET: "x".repeat(48) });
  assert.equal(verifyTrackingToken(foreign, "signup", ENV).reason, "bad-signature");
  // absent
  assert.equal(verifyTrackingToken(null, "signup", ENV).reason, "malformed");
  assert.equal(verifyTrackingToken(undefined, "signup", ENV).reason, "malformed");
});

test("(i5) golden mint vectors: TS mint reproduces every token byte-exactly (b64url padding residues 0/1/2)", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "tracking-token-golden.json"), "utf8")
  );
  const env = { TRACKING_HMAC_SECRET: fixture.secret };
  const residues = new Set();
  for (const c of fixture.cases) {
    assert.equal(mintTrackingToken(c.payload, env), c.token, `mint ${c.name}`);
    const v = verifyTrackingToken(c.token, c.payload.event, env);
    assert.equal(v.ok, true, `verify ${c.name}`);
    assert.deepEqual(v.payload, c.payload, `payload ${c.name}`);
    // The encoded payload really is the pinned fixed-key-order JSON.
    assert.equal(
      Buffer.from(c.token.split(".")[0], "base64url").toString("utf8"),
      c.payload_json,
      `payload_json ${c.name}`
    );
    residues.add(c.payload_json_bytes_mod3);
  }
  assert.deepEqual([...residues].sort(), [0, 1, 2], "all padding residues covered");
});
