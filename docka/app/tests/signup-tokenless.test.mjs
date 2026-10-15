// tests/signup-tokenless.test.mjs — go-live readiness plan 2026-08-25 item 3
// + D5, app side:
//
//   * TOKENLESS signup event: POST /api/signup appends a `signup` row with
//     send_key "" + the PINNED `email` key whenever an email was provided and
//     no valid CTA token resolved; no email -> no event; a valid token keeps
//     the tokened row ONLY (no tokenless duplicate). Contract pinned by the
//     shared fixture tests/fixtures/signup-tokenless-golden.json (the pipeline
//     asserts the same fixture — byte-exact event_key + schema key).
//   * lib/email-match.ts normalization: golden vectors shared with the
//     pipeline's common.normalize_email (email-normalize-golden.json) + the
//     pinned HMAC wire unit.
//   * GET /api/admin/outreach/signup-emails (D5): leads-read Bearer / admin
//     session auth, HMAC-only body (no raw email ever), 503 without
//     TRACKING_HMAC_SECRET.
//
// Part A follows the signup-outreach.test.mjs pattern (direct route import,
// throwaway data dir); part B drives the admin route through the shared vm
// harness (tests/_route-harness.mjs) with @/lib/db and admin-session stubbed.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/signup-tokenless.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.REGISTRY_MOCK = "1";

const SECRET = "signup-tokenless-secret-".padEnd(48, "s");
process.env.TRACKING_HMAC_SECRET = SECRET;
const ENV = { TRACKING_HMAC_SECRET: SECRET };

const READ_TOKEN = "a".repeat(64);
const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
process.env.LEADS_READ_TOKEN_HASH = sha256hex(READ_TOKEN);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-signup-tokenless-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "signup-tokenless-golden.json"), "utf8")
);
const NORM_GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "email-normalize-golden.json"), "utf8")
);

const { mintTrackingToken } = await import("@/lib/tracking-token");
const { readEventsSince, eventKey, eventKeySlots } = await import("@/lib/outreach-events");
const { normalizeEmailForMatch, hmacEmailHex } = await import("@/lib/email-match");
const { POST: signupPOST } = await import("@/app/api/signup/route");

// ---- helpers (signup-outreach.test.mjs precedent) --------------------------

let ipSeq = 0;
function nextIp() {
  return `10.8.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
}

function jsonReq(body, { ip = nextIp() } = {}) {
  const headers = new Headers({
    "x-registry-test-ip": ip,
    host: "docka.test",
    "content-type": "application/json",
  });
  return { headers, json: async () => body };
}

let userSeq = 0;
const uniqueName = () => `organic-${++userSeq}-${Date.now() % 100000}`;
const GOOD_PW = "correct horse battery";

async function signupVia({ leadToken, email } = {}) {
  const username = uniqueName();
  const res = await signupPOST(
    jsonReq({
      side: "agent",
      username,
      password: GOOD_PW,
      ...(leadToken !== undefined ? { leadToken } : {}),
      ...(email !== undefined ? { email } : {}),
    })
  );
  return { username, res, json: await res.json() };
}

function signupEvents() {
  return readEventsSince().events.filter((e) => e.event === "signup");
}

function signupToken(sendKey) {
  return mintTrackingToken(
    { send_key: sendKey, message_id: "cta-signup", touch: 0, event: "signup" },
    ENV
  );
}

// ---- fixture contract (shared with the pipeline) ---------------------------

test("(item3) golden fixture: pinned schema key + byte-exact tokenless event_key, distinct per account", () => {
  assert.equal(GOLDEN.email_field, "email");
  assert.ok(GOLDEN.rows.length >= 2);
  const keys = new Set();
  for (const c of GOLDEN.rows) {
    assert.equal(c.row.send_key, "", c.name);
    assert.equal(c.row.event, "signup", c.name);
    assert.equal(typeof c.row[GOLDEN.email_field], "string", c.name);
    assert.deepEqual(
      eventKeySlots({ send_key: c.row.send_key, event: c.row.event, user_id: c.row.user_id }),
      c.slots,
      c.name
    );
    assert.equal(
      eventKey({ send_key: c.row.send_key, event: c.row.event, user_id: c.row.user_id }),
      c.expected_event_key,
      c.name
    );
    keys.add(c.expected_event_key);
  }
  // slots collapse safely: same empty send_key/message_id, DIFFERENT user_id
  // -> distinct keys (no collision); a replay of one row collapses by equality.
  assert.equal(keys.size, GOLDEN.rows.length);
});

// ---- tokenless event via the live route ------------------------------------

test("(item3) tokenless signup WITH email: one event, send_key empty, pinned `email` key, key formula unchanged", async () => {
  const { username, json } = await signupVia({ email: "Organic.Adopter@Example.COM" });
  assert.equal(json.ok, true);
  const { readDB } = await import("@/lib/db");
  const user = readDB().credentialUsers.find((u) => u.username === username);
  assert.ok(user);
  const evs = signupEvents().filter((e) => e.user_id === user.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].send_key, "");
  assert.equal(evs[0].message_id, undefined);
  // The pinned schema key, exactly as the pipeline fold reads it.
  assert.equal(evs[0][GOLDEN.email_field], "organic.adopter@example.com");
  assert.equal(
    evs[0].event_key,
    eventKey({ send_key: "", event: "signup", user_id: user.id })
  );
});

test("(item3) tokenless signup WITHOUT email: NO event at all", async () => {
  const before = signupEvents().length;
  const { json } = await signupVia({});
  assert.equal(json.ok, true);
  assert.equal(signupEvents().length, before);
});

test("(item3) valid token + email: the TOKENED row only — no tokenless duplicate", async () => {
  const { username, json } = await signupVia({
    leadToken: signupToken("LD2001"),
    email: "captain@lead-company.example.com",
  });
  assert.equal(json.ok, true);
  const { readDB } = await import("@/lib/db");
  const user = readDB().credentialUsers.find((u) => u.username === username);
  const evs = signupEvents().filter((e) => e.user_id === user.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].send_key, "LD2001");
  assert.equal(evs[0].email, "captain@lead-company.example.com");
});

test("(item3) invalid token + email: attribution dropped -> the TOKENLESS event still lands", async () => {
  const { username, json } = await signupVia({
    leadToken: "not-a-token",
    email: "fallback@example.org",
  });
  assert.equal(json.ok, true);
  const { readDB } = await import("@/lib/db");
  const user = readDB().credentialUsers.find((u) => u.username === username);
  const evs = signupEvents().filter((e) => e.user_id === user.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].send_key, "");
  assert.equal(evs[0].email, "fallback@example.org");
});

// ---- shared normalization + HMAC wire unit (D5) ----------------------------

test("(D5) email-normalize golden vectors: byte-equal to the pipeline's common.normalize_email", () => {
  assert.ok(NORM_GOLDEN.cases.length >= 9);
  for (const c of NORM_GOLDEN.cases) {
    assert.equal(normalizeEmailForMatch(c.input), c.expected, c.name);
  }
});

test("(D5) hmacEmailHex: pinned cross-language digest (verified against Python hmac/sha256)", () => {
  // Computed independently with Python:
  //   hmac.new(secret, b"crewing@alpha.example.com", sha256).hexdigest()
  assert.equal(
    hmacEmailHex(
      normalizeEmailForMatch("  CREWING@Alpha.Example.COM "),
      "golden-vector-secret-0123456789abcdef-NOT-A-REAL-SECRET"
    ),
    "c60d0007d05cbeb76ec61e67de3840c2fa60bbaf3b3670300a373ba68f6a44e5"
  );
});

// ---- GET /api/admin/outreach/signup-emails (D5) — vm route harness ---------

const { createRouteHarness, API } = await import("./_route-harness.mjs");

let db = { credentialUsers: [], agents: [] };
let currentAdmin = null;

const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": { readDB: () => db, updateDB: (fn) => Promise.resolve(fn(db)) },
    "@/lib/admin-session": { adminSession: async () => currentAdmin },
    "@/lib/admin-audit": { recordAdminAction: async () => ({}) },
  },
});

const signupEmailsRoute = loadTs(
  path.join(API, "admin", "outreach", "signup-emails", "route.ts")
);

function mkGet({ auth, ip } = {}) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  if (ip) headers.set("x-real-ip", ip);
  return { headers, url: "http://localhost/api/admin/outreach/signup-emails" };
}
const bearer = (t) => `Bearer ${t}`;

function resetDb() {
  db = {
    credentialUsers: [
      { id: "cred:1", emailUnverified: "crewing@alpha.example.com" },
      { id: "cred:2", emailUnverified: null },
    ],
    agents: [{ id: "agent:p-1", googleEmail: "Ops@MÜNCHEN-shipping.de" }],
  };
  currentAdmin = null;
}

test("(D5) signup-emails: no credential -> 401; wrong token -> 401", async () => {
  resetDb();
  assert.equal((await signupEmailsRoute.GET(mkGet({ ip: "9.1.1.1" }))).status, 401);
  assert.equal(
    (await signupEmailsRoute.GET(mkGet({ auth: bearer("c".repeat(64)), ip: "9.1.1.2" }))).status,
    401
  );
});

test("(D5) signup-emails: leads-read Bearer -> 200, HMACs of NORMALIZED emails, no raw email on the wire", async () => {
  resetDb();
  const res = await signupEmailsRoute.GET(mkGet({ auth: bearer(READ_TOKEN), ip: "9.1.2.1" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.algo, "hmac-sha256");
  assert.equal(res.body.count, 2);
  const expectCred = hmacEmailHex(normalizeEmailForMatch("crewing@alpha.example.com"), SECRET);
  // The agent email exercises the IDN arm: normalized to punycode BEFORE hashing.
  const expectAgent = hmacEmailHex("ops@xn--mnchen-shipping-zvb.de", SECRET);
  assert.deepEqual([...res.body.hmacs].sort(), [expectCred, expectAgent].sort());
  const wire = JSON.stringify(res.body);
  assert.ok(!wire.includes("alpha.example.com"), "raw email leaked");
  assert.ok(!/@/.test(wire.replace(/"[0-9a-f]{64}"/g, '""')), "raw address leaked");
});

test("(D5) signup-emails: admin session also grants (parity with leads/export)", async () => {
  resetDb();
  currentAdmin = { user: { email: "admin@example.com" } };
  const res = await signupEmailsRoute.GET(mkGet({ ip: "9.1.3.1" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("(D5) signup-emails: TRACKING_HMAC_SECRET unset -> 503 unconfigured (fail closed)", async () => {
  resetDb();
  delete process.env.TRACKING_HMAC_SECRET;
  try {
    const res = await signupEmailsRoute.GET(mkGet({ auth: bearer(READ_TOKEN), ip: "9.1.4.1" }));
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, "unconfigured");
  } finally {
    process.env.TRACKING_HMAC_SECRET = SECRET;
  }
});
