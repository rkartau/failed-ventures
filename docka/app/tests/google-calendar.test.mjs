// Unit + contract tests for lib/google-calendar.ts (docka-booking-plan.md PLAN
// v5/v6, CV5-1…9 + CV6-5). The Google NETWORK layer is mocked via injected deps
// (fetch / token / sleep); the token/KEY builder is left UNMOCKED so the exact thing
// mocks would hide — PEM newline normalization + JWT config acceptance — is really
// exercised. No fs / JSON store touched (the module imports only the Booking TYPE).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/google-calendar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const {
  calendarConfigured,
  normalizePrivateKey,
  buildJwtClient,
  CALENDAR_SCOPE,
  eventIdFor,
  addMinutesToWallClock,
  buildEventPayload,
  backoffDelayMs,
  pushBookingEvent,
  deleteBookingEvent,
} = await import("@/lib/google-calendar");

// ---- test doubles -----------------------------------------------------

/** A minimal fetch-Response stand-in exposing only what the module reads. */
function mockResponse(status, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { status, headers: { get: (n) => lower[String(n).toLowerCase()] ?? null } };
}

/**
 * Build injectable deps that replay a queue of responses, recording every request,
 * every sleep(ms), and every token fetch (with its forceRefresh flag).
 */
function makeDeps(responses) {
  const calls = [];
  const sleeps = [];
  const tokenFetches = [];
  const queue = [...responses];
  const deps = {
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      // If the queue runs dry the loop would be unbounded — surface it loudly.
      if (queue.length === 0) throw new Error("mock fetch: no more queued responses (retry loop unbounded?)");
      return queue.shift();
    },
    getToken: async (forceRefresh = false) => {
      tokenFetches.push(Boolean(forceRefresh));
      return forceRefresh ? "refreshed-token" : "token";
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, calls, sleeps, tokenFetches };
}

/** A valid booking fixture (only the fields the module reads). */
function booking(overrides = {}) {
  return {
    id: "11112222-3333-4444-5555-666677778888",
    date: "2026-08-24",
    time: "09:00",
    tz: "Europe/Tallinn",
    name: "Alice Example",
    email: "alice@example.com",
    company: "Acme Shipping",
    phone: "+372 555 0000",
    note: "please call after lunch",
    source: "public",
    status: "booked",
    createdAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

const ADMIN_URL = "https://docka.me/admin/bookings";

// ---- normalizePrivateKey (UNMOCKED) + JWT config acceptance -----------

test("normalizePrivateKey: escaped \\n becomes real newlines and builds a JWT config that does not throw", () => {
  const escaped = "-----BEGIN PRIVATE KEY-----\\nMIIBVQIBADANBg\\n-----END PRIVATE KEY-----\\n";
  assert.ok(!escaped.includes("\n"), "the escaped input has no real newlines");
  const normalized = normalizePrivateKey(escaped);
  assert.ok(normalized.includes("\n"), "normalized key must contain real newline characters");
  assert.ok(!normalized.includes("\\n"), "no literal backslash-n should remain");

  // Build the real JWT client (no network). The library must accept the config.
  let client;
  assert.doesNotThrow(() => {
    client = buildJwtClient("sa@docka.iam.gserviceaccount.com", normalized);
  });
  assert.deepEqual(client.scopes, [CALENDAR_SCOPE]);
  assert.ok(client.key.includes("\n"), "the JWT client holds the newline-restored key");
});

// ---- eventIdFor: charset + uppercase parity ---------------------------

test("eventIdFor: uppercase UUID lowercases, strips hyphens, and equals the lowercase-id parity", () => {
  const upper = "ABCDEF01-2345-6789-ABCD-EF0123456789";
  const lower = upper.toLowerCase();
  const idU = eventIdFor(upper);
  const idL = eventIdFor(lower);
  assert.equal(idU, idL, "uppercase and lowercase ids must map identically (Google rejects uppercase)");
  assert.equal(idU, "abcdef0123456789abcdef0123456789");
  // create id == delete id (delete derives the same way).
  assert.equal(eventIdFor(upper), eventIdFor(upper));
  // Charset: only a-v and 0-9, length within 5..1024.
  assert.match(idU, /^[a-v0-9]{5,1024}$/);
});

// ---- addMinutesToWallClock: carry math --------------------------------

test("addMinutesToWallClock: 23:30 + 60 -> 00:30 next day (day carry, never 24:30)", () => {
  assert.deepEqual(addMinutesToWallClock("2026-08-24", "23:30", 60), {
    date: "2026-08-25",
    time: "00:30",
  });
});

test("addMinutesToWallClock: 16:45 + 45 -> 17:30 (minute carry, never 16:90)", () => {
  assert.deepEqual(addMinutesToWallClock("2026-08-24", "16:45", 45), {
    date: "2026-08-24",
    time: "17:30",
  });
});

test("addMinutesToWallClock: 16:30 + 60 -> 17:30", () => {
  assert.deepEqual(addMinutesToWallClock("2026-08-24", "16:30", 60), {
    date: "2026-08-24",
    time: "17:30",
  });
});

// ---- buildEventPayload: content + tz + PII minimization ---------------

test("buildEventPayload: uses booking.tz, end = start + slotMinutes, minimizes PII", () => {
  const ev = buildEventPayload(booking(), 30, ADMIN_URL);

  assert.equal(ev.start.dateTime, "2026-08-24T09:00:00");
  assert.equal(ev.start.timeZone, "Europe/Tallinn");
  assert.equal(ev.end.dateTime, "2026-08-24T09:30:00");
  assert.equal(ev.end.timeZone, "Europe/Tallinn");

  assert.equal(ev.summary, "Call: Alice Example — Acme Shipping");
  assert.equal(ev.id, eventIdFor(booking().id));

  // Email + admin deep link present; phone + free-text note absent.
  assert.ok(ev.description.includes("alice@example.com"), "email must be in the description");
  assert.ok(ev.description.includes(ADMIN_URL), "admin deep link must be in the description");
  assert.ok(!ev.description.includes("+372 555 0000"), "phone must NOT be on the Google event");
  assert.ok(!ev.description.includes("please call after lunch"), "note must NOT be on the Google event");
});

test("buildEventPayload: summary omits the em-dash when no company", () => {
  const ev = buildEventPayload(booking({ company: undefined }), 30, ADMIN_URL);
  assert.equal(ev.summary, "Call: Alice Example");
});

test("buildEventPayload: missing booking.tz throws (never emits timeZone: undefined)", () => {
  assert.throws(() => buildEventPayload(booking({ tz: "" }), 30, ADMIN_URL), /tz/);
});

test("pushBookingEvent: missing booking.tz returns ok:false and never hits the network", async () => {
  const { deps, calls } = makeDeps([]);
  const res = await pushBookingEvent(booking({ tz: "" }), 30, ADMIN_URL, deps);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0, "no request must be sent when tz is missing");
});

// ---- pushBookingEvent: idempotency ------------------------------------

test("pushBookingEvent: two pushes -> insert then 409 -> net one event, stable googleEventId", async () => {
  const { deps, calls } = makeDeps([mockResponse(200), mockResponse(409)]);
  const first = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  const second = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true, "409 duplicate must be treated as success");
  assert.equal(first.googleEventId, second.googleEventId, "the event id must be stable across retries");
  assert.equal(first.googleEventId, eventIdFor(booking().id));
  assert.equal(calls.length, 2, "exactly one insert attempt per push");
  assert.ok(calls.every((c) => c.method === "POST"), "create uses POST (client-set id insert)");
});

// ---- pushBookingEvent: retry policy -----------------------------------

test("pushBookingEvent: 429 + Retry-After then success -> honors the Retry-After delay", async () => {
  const { deps, calls, sleeps } = makeDeps([
    mockResponse(429, { "Retry-After": "30" }),
    mockResponse(200),
  ]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [30_000], "Retry-After: 30 must be honored as a 30s (30000ms) delay");
});

test("pushBookingEvent: 503 then success -> deterministic exponential backoff+jitter", async () => {
  const { deps, sleeps } = makeDeps([mockResponse(503), mockResponse(200)]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, true);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], backoffDelayMs(1), "first-attempt backoff is deterministic (no rng)");
});

test("pushBookingEvent: persistent 503 -> attempts capped, no infinite loop, non-terminal fail", async () => {
  const { deps, calls, sleeps } = makeDeps([
    mockResponse(503),
    mockResponse(503),
    mockResponse(503),
  ]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, false);
  assert.equal(res.terminal, false, "an exhausted-retry 5xx is non-terminal (reconciler may retry)");
  assert.equal(calls.length, 3, "capped at MAX_ATTEMPTS attempts");
  assert.equal(sleeps.length, 2, "sleeps between the 3 attempts only (no sleep after the final)");
});

test("pushBookingEvent: non-retryable 400 -> terminal fail, no retries", async () => {
  const { deps, calls, sleeps } = makeDeps([mockResponse(400)]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, false);
  assert.equal(res.terminal, true, "a 4xx (other than 409) is terminal");
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test("pushBookingEvent: 401 -> single token refresh + retry, then success (no loop)", async () => {
  const { deps, calls, tokenFetches } = makeDeps([mockResponse(401), mockResponse(200)]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(tokenFetches.includes(true), "a forced token refresh must have happened exactly once");
  assert.equal(tokenFetches.filter(Boolean).length, 1, "only ONE forced refresh (single retry, no loop)");
});

test("pushBookingEvent: repeated 401 -> gives up after one refresh (terminal, no infinite loop)", async () => {
  const { deps, calls } = makeDeps([mockResponse(401), mockResponse(401)]);
  const res = await pushBookingEvent(booking(), 30, ADMIN_URL, deps);
  assert.equal(res.ok, false);
  assert.equal(res.terminal, true, "a persistent 401 is a terminal 4xx");
  assert.equal(calls.length, 2, "one original + one post-refresh attempt, then stop");
});

// ---- deleteBookingEvent: 404 / 410 = success --------------------------

test("deleteBookingEvent: 404 (already gone) -> ok:true, deletes by DERIVED id", async () => {
  const { deps, calls } = makeDeps([mockResponse(404)]);
  const res = await deleteBookingEvent(booking().id, deps);
  assert.equal(res.ok, true);
  assert.equal(calls[0].method, "DELETE");
  assert.ok(calls[0].url.endsWith(`/${eventIdFor(booking().id)}`), "delete targets the recomputed event id");
});

test("deleteBookingEvent: 410 (gone) -> ok:true", async () => {
  const { deps } = makeDeps([mockResponse(410)]);
  const res = await deleteBookingEvent(booking().id, deps);
  assert.equal(res.ok, true);
});

test("deleteBookingEvent: 200 -> ok:true", async () => {
  const { deps } = makeDeps([mockResponse(204)]);
  const res = await deleteBookingEvent(booking().id, deps);
  assert.equal(res.ok, true);
});

test("deleteBookingEvent: hard 403 -> ok:false", async () => {
  const { deps } = makeDeps([mockResponse(403)]);
  const res = await deleteBookingEvent(booking().id, deps);
  assert.equal(res.ok, false);
});

// ---- calendarConfigured ------------------------------------------------

test("calendarConfigured: true only when all three env vars are set", () => {
  const keys = ["GOOGLE_SA_CLIENT_EMAIL", "GOOGLE_SA_PRIVATE_KEY", "GOOGLE_CALENDAR_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(calendarConfigured(), false, "none set -> false");

    process.env.GOOGLE_SA_CLIENT_EMAIL = "sa@docka.iam.gserviceaccount.com";
    process.env.GOOGLE_SA_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----\\n";
    assert.equal(calendarConfigured(), false, "two of three set -> false");

    process.env.GOOGLE_CALENDAR_ID = "docka-calls@group.calendar.google.com";
    assert.equal(calendarConfigured(), true, "all three set -> true");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
