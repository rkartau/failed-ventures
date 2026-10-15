// tests/signup-outreach.test.mjs — Increment 5 signup-capture route tests:
//   POST /api/signup outreach attribution (leadToken → leadKey + source stamp +
//   `signup` event append), the 4-case token matrix at ROUTE level with the
//   binding proceed-on-failed-verify rule (a bad token NEVER blocks a signup),
//   the shared ^LD\d{1,15}$ contract on BOTH /api/signup and /api/book, and the
//   GA4 consent allowlist (/book + /signup page_view only; everything else
//   unchanged).
//
// Follows the password-auth-routes.test.mjs pattern: node:test + the `@/*`
// alias hook, throwaway data dir chdir'd BEFORE any @/lib import, duck-typed
// requests ({ headers, json() }), no live network.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/signup-outreach.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode BEFORE any @/lib import — enables the x-registry-test-ip override.
process.env.REGISTRY_MOCK = "1";

const SECRET = "signup-route-secret-".padEnd(48, "s");
process.env.TRACKING_HMAC_SECRET = SECRET;
const ENV = { TRACKING_HMAC_SECRET: SECRET };
const FOREIGN_ENV = { TRACKING_HMAC_SECRET: "x".repeat(48) };

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-signup-outreach-"));
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

const { readDB } = await import("@/lib/db");
const { mintTrackingToken } = await import("@/lib/tracking-token");
const { readEventsSince, eventKey } = await import("@/lib/outreach-events");
const { sanitizeLeadKey, LEAD_KEY_RE } = await import("@/lib/booking");
const { isTrackablePath } = await import("@/lib/consent");
const { POST: signupPOST } = await import("@/app/api/signup/route");

// ---- helpers (password-auth-routes precedent) ------------------------------

let ipSeq = 0;
function nextIp() {
  return `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
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
const uniqueName = () => `outreacher-${++userSeq}-${Date.now() % 100000}`;
const GOOD_PW = "correct horse battery";

function signupToken(sendKey, env = ENV) {
  return mintTrackingToken(
    { send_key: sendKey, message_id: "cta-signup", touch: 0, event: "signup" },
    env
  );
}

async function signupVia(leadToken, extra = {}) {
  const username = uniqueName();
  const res = await signupPOST(
    jsonReq({
      side: "agent",
      username,
      password: GOOD_PW,
      ...(leadToken !== undefined ? { leadToken } : {}),
      ...extra,
    })
  );
  return { username, res, json: await res.json() };
}

function userByName(username) {
  return readDB().credentialUsers.find((u) => u.username === username);
}

function signupEvents() {
  return readEventsSince().events.filter((e) => e.event === "signup");
}

// ---- valid token → attribution + event -------------------------------------

test("(i5) valid signup token: account stamped leadKey + source:outreach; one signup event with the user id", async () => {
  const { username, json } = await signupVia(signupToken("LD1001"));
  assert.equal(json.ok, true);
  const user = userByName(username);
  assert.ok(user);
  assert.equal(user.leadKey, "LD1001");
  assert.equal(user.source, "outreach");
  const evs = signupEvents().filter((e) => e.send_key === "LD1001");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].user_id, user.id);
  assert.equal(evs[0].message_id, undefined);
  // username/password-only signup (no email collected) → NO email field on the
  // row: the pipeline keeps today's token-only attribution.
  assert.equal(evs[0].email, undefined);
});

test("(i5/[R2-7]) signup WITH an email: the event row carries `email` (stored lower-cased) OUTSIDE the key slots", async () => {
  const { username, json } = await signupVia(signupToken("LD1010"), {
    email: "Captain.Nemo@Example.COM",
  });
  assert.equal(json.ok, true);
  const user = userByName(username);
  assert.ok(user);
  const evs = signupEvents().filter((e) => e.send_key === "LD1010");
  assert.equal(evs.length, 1);
  // The exact field name the pipeline fold reads first: `email`
  // (accepted keys there: email / account_email / signup_email).
  assert.equal(evs[0].email, "captain.nemo@example.com");
  assert.equal(evs[0].user_id, user.id);
  // The email must NOT enter the event_key: the key is still the byte-exact
  // digest of [send_key, "", "signup", user_id] — unchanged formula.
  assert.equal(
    evs[0].event_key,
    eventKey({ send_key: "LD1010", event: "signup", user_id: user.id })
  );
});

// ---- 4-case matrix + proceed-on-failed-verify (BINDING) --------------------

test("(i5) tampered token: signup PROCEEDS, attribution dropped, no event", async () => {
  const tok = signupToken("LD1002");
  const [, sig] = tok.split(".");
  const forged =
    Buffer.from(
      JSON.stringify({ send_key: "LD9999", message_id: "cta-signup", touch: 0, event: "signup" }),
      "utf8"
    ).toString("base64url") + `.${sig}`;
  const { username, json } = await signupVia(forged);
  assert.equal(json.ok, true, "signup must never be blocked by a bad token");
  const user = userByName(username);
  assert.equal(user.leadKey, undefined);
  assert.equal(user.source, undefined);
  assert.equal(signupEvents().filter((e) => e.send_key === "LD9999").length, 0);
});

test("(i5) foreign-secret token: signup PROCEEDS, attribution dropped", async () => {
  const { username, json } = await signupVia(signupToken("LD1003", FOREIGN_ENV));
  assert.equal(json.ok, true);
  assert.equal(userByName(username).leadKey, undefined);
  assert.equal(signupEvents().filter((e) => e.send_key === "LD1003").length, 0);
});

test("(i5) absent / junk token: signup PROCEEDS, attribution dropped", async () => {
  for (const tok of [undefined, "", "not-a-token", 42]) {
    const { username, json } = await signupVia(tok);
    assert.equal(json.ok, true, `token=${String(tok)}`);
    assert.equal(userByName(username).leadKey, undefined);
  }
});

test("(i5) wrong-event token (unsub presented as signup CTA): attribution dropped, signup proceeds", async () => {
  const unsubTok = mintTrackingToken(
    { send_key: "LD1004", message_id: "m", touch: 1, event: "unsub" },
    ENV
  );
  const { username, json } = await signupVia(unsubTok);
  assert.equal(json.ok, true);
  assert.equal(userByName(username).leadKey, undefined);
});

test("(i5) valid signature but off-contract send_key (^LD\\d{1,15}$): attribution dropped, signup proceeds", async () => {
  for (const bad of ["XX123", "LD", "LD12345678901234567890", "ld123", "LD12x"]) {
    const { username, json } = await signupVia(signupToken(bad));
    assert.equal(json.ok, true, `send_key=${bad}`);
    assert.equal(userByName(username).leadKey, undefined, `send_key=${bad}`);
  }
});

test("(i5) unconfigured secret at route time: signup proceeds, attribution dropped (fail-soft)", async () => {
  const tok = signupToken("LD1005");
  delete process.env.TRACKING_HMAC_SECRET;
  try {
    const { username, json } = await signupVia(tok);
    assert.equal(json.ok, true);
    assert.equal(userByName(username).leadKey, undefined);
  } finally {
    process.env.TRACKING_HMAC_SECRET = SECRET;
  }
});

// ---- shared ^LD\d{1,15}$ contract ------------------------------------------

test("(i5) lead-key contract: one regex serves book AND signup (reuse, not a fork)", () => {
  assert.equal(String(LEAD_KEY_RE), String(/^LD\d{1,15}$/));
  assert.equal(sanitizeLeadKey("LD123456789012345"), "LD123456789012345");
  for (const bad of ["LD1234567890123456", "LD", "xLD1", "LD1 ", " LD1", "L D1"]) {
    assert.equal(sanitizeLeadKey(bad), undefined, bad);
  }
});

// ---- GA4 consent allowlist --------------------------------------------------

test("(i5) GA4 allowlist: /book and /signup trackable (path only); query/token never widens it", () => {
  assert.equal(isTrackablePath("/book"), true);
  assert.equal(isTrackablePath("/signup"), true);
  assert.equal(isTrackablePath("/signup?t=abc.def"), true); // query ignored, path allowed
  assert.equal(isTrackablePath("/book/"), true);
});

test("(i5) GA4 allowlist unchanged for every other path", () => {
  for (const p of ["/", "/overview", "/overview/agencies", "/overview/seafarers", "/verify", "/privacy"]) {
    assert.equal(isTrackablePath(p), true, p);
  }
  for (const p of [
    "/agent",
    "/seafarer",
    "/share/abc",
    "/portal/x",
    "/verify/123e4567",
    "/admin",
    "/admin/outreach",
    "/directory",
    "/signup/extra",
    "/booking",
    "/u/token",
    "/o/token.gif",
  ]) {
    assert.equal(isTrackablePath(p), false, p);
  }
});

// ---- /signup page source stance (thin-wrapper rule) -------------------------

test("(i5) /signup page: verifies server-side, appends signup_started, never blocks on failure", () => {
  // The page is a .tsx server component (JSX — not importable under node:test);
  // pin its load-bearing stance statically, like the isolation-guard meta-tests.
  const src = fs.readFileSync(
    path.join(originalCwd, "app", "signup", "page.tsx"),
    "utf8"
  );
  assert.match(src, /verifyTrackingToken\(token, "signup"\)/);
  assert.match(src, /sanitizeLeadKey\(v\.payload\.send_key\)/);
  assert.match(src, /event: "signup_started"/);
  assert.match(src, /AgentPasswordAuth/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
});
