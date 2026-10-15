// Unit test for lib/admin-session.ts — the authoritative admin gate.
//
// The repo has no TypeScript unit-test runner (all other tests are Playwright
// .mjs journeys against a live dev server), and plain `node` cannot import a .ts
// module. So this test does two things with zero extra tooling:
//
//   1. BEHAVIOURAL: it exercises a faithful mirror of adminSession()'s gate with
//      an injected mock `auth()`, covering every session shape.
//   2. INTEGRITY: it reads the real lib/admin-session.ts and asserts the mirror
//      still matches the source (allowlist + gate expression), and that the file
//      obeys the build-guard forbidden-word constraint. If someone edits the
//      source gate without updating this test, the integrity check fails loudly.
//
// Run:  node tests/admin-session.test.mjs      (exits non-zero on any failure)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../lib/admin-session.ts");
const src = fs.readFileSync(SRC, "utf8");

// --- Mirror of the source gate (kept identical to lib/admin-session.ts) --------
// adminSession() with `auth` injected so we can drive it without NextAuth/Google.
// The real allowlist comes from process.env.ADMIN_EMAILS; the mirror uses fixed
// example addresses.
const ADMIN_EMAILS = new Set(["admin@example.com", "owner@example.com"]);
function makeAdminSession(authFn) {
  return async function adminSessionUnderTest() {
    const s = await authFn();
    const email = (s?.user?.email ?? "").trim().toLowerCase();
    if (s?.user && email && ADMIN_EMAILS.has(email)) {
      return { user: s.user };
    }
    return null;
  };
}
const withAuth = (value) => makeAdminSession(async () => value);

// --- Integrity: the mirror must not drift from the real source -----------------
test("source: allowlist is read from the ADMIN_EMAILS env var, no hard-coded addresses", () => {
  assert.ok(src.includes("process.env.ADMIN_EMAILS"), "source must read process.env.ADMIN_EMAILS");
  assert.ok(!/"[^"\s]+@[^"\s]+"/.test(src), "source must not hard-code any e-mail address");
});

test("source: gate normalises email (trim + lowercase) and fails closed", () => {
  assert.ok(
    src.includes('(s?.user?.email ?? "").trim().toLowerCase()'),
    "source must normalise email with trim().toLowerCase()"
  );
  assert.ok(
    src.includes("ADMIN_EMAILS.has(email)"),
    "source must gate on ADMIN_EMAILS.has(email)"
  );
  assert.ok(src.includes("return null;"), "source must fail closed with return null");
});

test("source: no dev/test-login backdoor, and no forbidden build-guard words", () => {
  // Guard against actual backdoor *code*, not prose: no cookie reads, no
  // dev-login identifiers. (The word "test-login" may appear in a comment that
  // documents the deliberate ABSENCE of the backdoor — that is allowed.)
  assert.ok(!/\bcookies\s*\(/.test(src), "must not read cookies (no dev door)");
  assert.ok(!/\bDEV_COOKIE\b|\bisDevLoginEnabled\b/.test(src), "no dev-login identifiers");
  assert.ok(!/\bagentSession\b/.test(src), "must not reference agentSession");
  assert.ok(!/\bseamanSession\b/.test(src), "must not reference seamanSession");
});

// --- Behaviour: allowlisted emails pass ----------------------------------------
test("allowlisted email (admin) → returns a session", async () => {
  const admin = withAuth({ user: { name: "R", email: "admin@example.com" } });
  const r = await admin();
  assert.deepEqual(r, { user: { name: "R", email: "admin@example.com" } });
});

test("allowlisted email (owner) → returns a session", async () => {
  const admin = withAuth({ user: { name: "J", email: "owner@example.com" } });
  const r = await admin();
  assert.ok(r);
  assert.equal(r.user.email, "owner@example.com");
});

test("allowlisted email, mixed case → returns a session", async () => {
  const admin = withAuth({ user: { email: "Admin@Example.com" } });
  const r = await admin();
  assert.ok(r, "mixed-case allowlisted email must be accepted");
});

test("allowlisted email, surrounding whitespace → returns a session", async () => {
  const admin = withAuth({ user: { email: "  admin@example.com  " } });
  const r = await admin();
  assert.ok(r, "email with surrounding whitespace must be accepted");
});

// --- Behaviour: everything else fails closed → null ----------------------------
test("signed-in non-allowlisted email → null", async () => {
  const admin = withAuth({ user: { name: "Mallory", email: "mallory@evil.com" } });
  assert.equal(await admin(), null);
});

test("no session (auth() returns null) → null", async () => {
  const admin = withAuth(null);
  assert.equal(await admin(), null);
});

test("session with a user but NO email (phone-OTP shape) → null (EXPECTED)", async () => {
  // Documented, expected behaviour: the seaman phone-OTP path sets no email, so
  // such a session can never be an admin. This is a feature, not a bug.
  const admin = withAuth({ user: { name: "OTP User" } });
  assert.equal(await admin(), null);
});

test("session with empty-string email → null", async () => {
  const admin = withAuth({ user: { email: "" } });
  assert.equal(await admin(), null);
});
