// feat/password-signup — Steps 1–3 tests (store, core auth lib, rate limiting).
//
// Covers the plan's Step 10 assertions that map to Steps 1–3: scrypt roundtrip
// + per-record params, the D5 username validation table (CJK / NFC / @), the
// D7 recovery codes (8 minted, consume-once, server-side normalization incl.
// the U→V confusable), the r2-revision-9 exactly-one-dummy-scrypt timing rule,
// the CAS race tests via Promise.all against the REAL transact (concurrent
// signup / plain-sign-in-on-unbound = zero tenants / concurrent bind / adopt
// races on both paths / concurrent recovery-reset), Step 2f merge inheritance
// + the 2f-b dangling-binding self-heal (re-forked profile starts EMPTY), the
// seaman-account case-3 adopt guard, the v6-fold-7 commit-marker schema, and
// the Step 3 buckets (caps, XFF spoofing lands in ONE bucket, isolation from
// the registry buckets, the per-ACCOUNT bucket under alternating identifiers,
// and the RATE_LIMITED flood ⇒ BOUNDED aggregate lines, never O(N)).
//
// Follows the verify-upload pattern: plain node:test + the
// `@/*` alias hook, a throwaway data dir chdir'd BEFORE any @/lib import,
// deterministic, no live network.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/credential-users.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode BEFORE any @/lib import — enables the x-registry-test-ip override
// so authorize() can simulate distinct client IPs without a proxy hop.
process.env.REGISTRY_MOCK = "1";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-credential-users-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const {
  readDB,
  updateDB,
  verifyAuditChain,
} = await import("@/lib/db");
const {
  hashSecret,
  verifySecret,
  normalizeUsername,
  usernameKey,
  validateUsername,
  validatePassword,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  createCredentialUser,
  authorizeCredentials,
  resetPasswordWithRecoveryCode,
  bindSideWithPassword,
  credentialAgentId,
  findAdoptableProfileByToken,
  _scryptOpCount,
} = await import("@/lib/credential-auth");
const {
  consumeAuthBudget,
  idHash16,
  authIpHash,
  _flushRateLimitedAggregates,
  _resetRateLimitedAggregates,
} = await import("@/lib/auth-rate-limit");
const { consumeBudget, resetRegistryAbuseState } = await import("@/lib/registry");
const { findOrCreateSeafarerByGoogle } = await import("@/lib/seaman-account");
const { mergePersons } = await import("@/lib/person-merge");
const { buildSignupCommitMarker, markerMatches, parseSignupCommitMarker } = await import(
  "@/lib/signup-marker"
);

const DB_PATH = path.join(TMP, "data", "db.json");
const AUTH_EVENTS_PATH = path.join(TMP, "data", "auth-events.ndjson");

// ---- helpers ---------------------------------------------------------------

function freshBudgets() {
  resetRegistryAbuseState();
  _resetRateLimitedAggregates();
}

function authEvents() {
  if (!fs.existsSync(AUTH_EVENTS_PATH)) return [];
  return fs
    .readFileSync(AUTH_EVENTS_PATH, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let ipSeq = 0;
/** Headers presenting a UNIQUE test client IP (mock-mode override header). */
function ipHeaders(ip = `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`) {
  return { headers: new Headers({ "x-registry-test-ip": ip }) };
}

let userSeq = 0;
function uniqueName(prefix = "tester") {
  return `${prefix}-${++userSeq}-${Date.now() % 100000}`;
}

async function signup(overrides = {}) {
  const res = await createCredentialUser({
    side: "seaman",
    username: uniqueName(),
    password: "correct horse battery",
    ...overrides,
  });
  assert.equal(res.ok, true, `signup should succeed: ${JSON.stringify(res)}`);
  return res;
}

// ---- Step 1 — store ---------------------------------------------------------

test("legacy db.json without credentialUsers loads with [] (tolerant read)", () => {
  fs.writeFileSync(DB_PATH, JSON.stringify({ seafarers: [], documents: [] }), "utf-8");
  const db = readDB();
  assert.deepEqual(db.credentialUsers, []);
  // And a legacy seafarer row gains credentialUserId: null on read.
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify({ seafarers: [{ id: "s-legacy", name: "Old Row", createdAt: "2020-01-01" }] }),
    "utf-8"
  );
  const db2 = readDB();
  assert.equal(db2.seafarers[0].credentialUserId, null);
});

test("CredentialUser round-trips through updateDB/readDB", async () => {
  const hash = await hashSecret("some password");
  await updateDB((db) => {
    db.credentialUsers.push({
      id: "cred:roundtrip",
      username: "Roundtrip",
      usernameLower: "roundtrip",
      password: hash,
      emailUnverified: "rt@example.com",
      seafarerId: null,
      agentId: null,
      recoveryCodes: [{ hash, usedAt: null }],
      createdAt: new Date().toISOString(),
      passwordChangedAt: null,
    });
  });
  const stored = readDB().credentialUsers.find((u) => u.id === "cred:roundtrip");
  assert.ok(stored);
  assert.equal(stored.usernameLower, "roundtrip");
  assert.equal(stored.password.hashB64, hash.hashB64);
  assert.equal(stored.recoveryCodes.length, 1);
});

// ---- Step 2 — scrypt --------------------------------------------------------

test("scrypt hash/verify roundtrip; wrong password fails; params stored per-record", async () => {
  const h = await hashSecret("s3cret-password");
  assert.equal(await verifySecret("s3cret-password", h), true);
  assert.equal(await verifySecret("wrong-password", h), false);
  // D8 params live ON the record so they can be raised without migration.
  assert.equal(h.N, 16384);
  assert.equal(h.r, 8);
  assert.equal(h.p, 1);
  assert.equal(h.keylen, 64);
  assert.equal(Buffer.from(h.saltB64, "base64").length, 16);
  // Verification honours the STORED params, not the current constants.
  const legacy = { ...h };
  legacy.N = 4096;
  const salt = Buffer.from(h.saltB64, "base64");
  const crypto = await import("node:crypto");
  legacy.hashB64 = crypto.scryptSync("legacy-pass", salt, 64, { N: 4096, r: 8, p: 1 }).toString("base64");
  assert.equal(await verifySecret("legacy-pass", legacy), true);
});

// ---- Step 2 — username validation table (D5) --------------------------------

test("username validation: CJK ok, @ rejected, NFC collides, length bounds", () => {
  assert.equal(validateUsername("王伟海员"), null); // CJK explicitly allowed (Wei)
  assert.equal(validateUsername("abc"), null); // 3 = lower bound
  assert.equal(validateUsername("a".repeat(32)), null); // 32 = upper bound
  assert.equal(validateUsername("ab"), "pw.errUserRules"); // too short
  assert.equal(validateUsername("a".repeat(33)), "pw.errUserRules"); // too long
  assert.equal(validateUsername("has space"), "pw.errUserRules");
  assert.equal(validateUsername("has!bang"), "pw.errUserRules");
  assert.equal(validateUsername("dots.under_score-ok"), null);
  assert.equal(validateUsername("wei@example.com"), "pw.errUserAt"); // @ reserved (D5)
  // NFC equivalence: composed é vs e + combining acute collide on usernameLower.
  const composed = "caféman"; // café — U+00E9
  const decomposed = "caféman"; // e + U+0301
  assert.equal(usernameKey(composed), usernameKey(decomposed));
  assert.equal(normalizeUsername(decomposed), "caféman");
  // Password bounds: min 8, max 256, no composition rules.
  assert.equal(validatePassword("1234567"), "pw.errWeak");
  assert.equal(validatePassword("12345678"), null);
  assert.equal(validatePassword("x".repeat(257)), "pw.errWeak");
});

test("NFC-equivalent username collides at signup (usernameLower CAS)", async () => {
  freshBudgets();
  const base = `nfcé-${Date.now() % 100000}`;
  const first = await createCredentialUser({ side: "seaman", username: base, password: "password-1" });
  assert.equal(first.ok, true);
  const clash = await createCredentialUser({
    side: "seaman",
    username: base.normalize("NFD").toUpperCase(),
    password: "password-2",
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.errorKey, "pw.errTaken");
});

// ---- Step 2 — recovery codes (D7) ------------------------------------------

test("recovery codes: 8 minted from the Crockford alphabet; normalization map incl. U→V", async () => {
  const { plain, hashed } = await generateRecoveryCodes();
  assert.equal(plain.length, 8);
  assert.equal(hashed.length, 8);
  for (const code of plain) {
    assert.match(code, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    assert.equal(normalizeRecoveryCode(code), code); // already-normal codes are fixed points
  }
  for (const rc of hashed) assert.equal(rc.usedAt, null);
  // The confusable map: trim, case, spaces/dashes, O→0, I→1, L→1, U→V.
  assert.equal(normalizeRecoveryCode("  ab0-1v 2x "), "AB01V2X");
  assert.equal(normalizeRecoveryCode("oO"), "00");
  assert.equal(normalizeRecoveryCode("iIlL"), "1111");
  assert.equal(normalizeRecoveryCode("uU"), "VV");
});

test("recovery reset: mangled code verifies, code consumed once, reused code fails", async () => {
  freshBudgets();
  const res = await signup();
  const username = res.user.username;
  const code = res.recoveryCodes[0];
  // Mangle: lowercase, group with dashes/spaces, swap confusables backwards
  // (0→O, 1→L, V→U) — server-side normalization must still accept it.
  const mangled = (code.slice(0, 5) + "-" + code.slice(5))
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/v/g, "u")
    .split("")
    .join(" ");
  const reset = await resetPasswordWithRecoveryCode({
    identifier: username,
    code: mangled,
    newPassword: "brand new password",
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.remainingCodes, 7);

  // passwordChangedAt stamped (feeds pwdAt invalidation — invariant 11).
  const stored = readDB().credentialUsers.find((u) => u.id === res.user.id);
  assert.ok(stored.passwordChangedAt);
  assert.equal(stored.recoveryCodes.filter((c) => c.usedAt !== null).length, 1);
  assert.equal(await verifySecret("brand new password", stored.password), true);

  // Reused code fails generic.
  freshBudgets();
  const reuse = await resetPasswordWithRecoveryCode({
    identifier: username,
    code,
    newPassword: "another new password",
  });
  assert.equal(reuse.ok, false);
  // RECOVERY_RESET_OK carried remainingCodes (fold 10).
  const okEvent = authEvents().find((e) => e.type === "RECOVERY_RESET_OK" && e.credId === res.user.id);
  assert.ok(okEvent);
  assert.equal(okEvent.remainingCodes, 7);
});

test("concurrent recovery-reset with the SAME code: exactly one wins (CAS)", async () => {
  freshBudgets();
  const res = await signup();
  const code = res.recoveryCodes[1];
  const [a, b] = await Promise.all([
    resetPasswordWithRecoveryCode({ identifier: res.user.username, code, newPassword: "racer-a-password" }),
    resetPasswordWithRecoveryCode({ identifier: res.user.username, code, newPassword: "racer-b-password" }),
  ]);
  const wins = [a, b].filter((r) => r.ok).length;
  assert.equal(wins, 1, `exactly one racer must win, got ${JSON.stringify([a, b])}`);
  const stored = readDB().credentialUsers.find((u) => u.id === res.user.id);
  assert.equal(stored.recoveryCodes.filter((c) => c.usedAt !== null).length, 1);
});

// ---- Step 2 — timing spec (r2 revision 9) -----------------------------------

test("identifier miss burns exactly ONE dummy scrypt (login and recovery)", async () => {
  freshBudgets();
  // Warm the memoized dummy hash so its one-time creation doesn't skew counts.
  await authorizeCredentials(
    { identifier: "no-such-user-warmup", password: "whatever-pass", side: "seaman" },
    ipHeaders()
  );
  const before = _scryptOpCount();
  const out = await authorizeCredentials(
    { identifier: "no-such-user-at-all", password: "whatever-pass", side: "seaman" },
    ipHeaders()
  );
  assert.equal(out, null);
  assert.equal(_scryptOpCount() - before, 1, "login miss = exactly one dummy verify");

  const before2 = _scryptOpCount();
  const reset = await resetPasswordWithRecoveryCode({
    identifier: "no-such-user-at-all",
    code: "ABCDEFGH23",
    newPassword: "whatever new pass",
  });
  assert.equal(reset.ok, false);
  assert.equal(_scryptOpCount() - before2, 1, "recovery miss = exactly one dummy verify");
});

// ---- Step 2 — signup + authorize semantics ----------------------------------

test("signup binds the requested side; agent id is deterministic p- namespace; no email leaks", async () => {
  freshBudgets();
  const seaman = await signup({ email: "SeaMan@Example.COM " });
  assert.ok(seaman.user.seafarerId);
  assert.equal(seaman.user.agentId, null);
  assert.equal(seaman.user.emailUnverified, "seaman@example.com"); // lower-cased, CredentialUser ONLY
  const profile = readDB().seafarers.find((s) => s.id === seaman.user.seafarerId);
  assert.equal(profile.credentialUserId, seaman.user.id);
  assert.equal(profile.ownerEmail, null, "unverified email must NEVER reach ownerEmail (inv. 2)");
  assert.equal(profile.googleSub, null);

  const agentRes = await createCredentialUser({
    side: "agent",
    username: uniqueName("agency"),
    password: "agency password",
  });
  assert.equal(agentRes.ok, true);
  assert.equal(agentRes.user.seafarerId, null);
  assert.equal(agentRes.user.agentId, credentialAgentId(agentRes.user.id));
  assert.match(agentRes.user.agentId, /^agent:p-[0-9a-f]{16}$/); // D4/D10 — disjoint from agent:g-
  const agentRow = readDB().agents.find((a) => a.id === agentRes.user.agentId);
  assert.equal(agentRow.googleEmail, null);
  assert.equal(agentRow.contact, agentRes.user.username); // not an email ⇒ never e-mail-adoptable

  // authorize returns the principal with pwdAt and NO email anywhere (D3).
  const principal = await authorizeCredentials(
    { identifier: seaman.user.username, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.ok(principal);
  assert.equal(principal.role, "seaman");
  assert.equal(principal.seafarerId, seaman.user.seafarerId);
  assert.equal(principal.pwdAt, seaman.user.createdAt);
  assert.equal("email" in principal, false);
  const loginOk = authEvents().filter((e) => e.type === "LOGIN_OK" && e.credId === seaman.user.id);
  assert.ok(loginOk.length >= 1);
  assert.equal(loginOk[loginOk.length - 1].side, "seaman"); // LOGIN_OK carries side (fold 10)
});

test("email identifier: works when unique, fails generic when ambiguous (D6/R9)", async () => {
  freshBudgets();
  const shared = `dup-${Date.now() % 100000}@example.com`;
  const one = await signup({ email: shared });
  const principal = await authorizeCredentials(
    { identifier: shared, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.ok(principal, "unique email identifier resolves");
  assert.equal(principal.id, one.user.id);

  await signup({ email: shared }); // squatter — email now ambiguous
  freshBudgets();
  const ambiguous = await authorizeCredentials(
    { identifier: shared, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.equal(ambiguous, null, "ambiguous email fails generic for BOTH");
  const byUsername = await authorizeCredentials(
    { identifier: one.user.username, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.ok(byUsername, "username login unaffected");
});

test("string-serialized credential values are coerced ('null'/'undefined'/'' absent)", async () => {
  freshBudgets();
  const res = await signup();
  const principal = await authorizeCredentials(
    {
      identifier: res.user.username,
      password: "correct horse battery",
      side: "seaman",
      adoptToken: "undefined", // next-auth serializes absent values to strings
    },
    ipHeaders()
  );
  assert.ok(principal, "'undefined' adoptToken treated as absent");
  assert.equal(authEvents().some((e) => e.type === "ADOPT_SKIPPED" && e.credId === res.user.id), false);
  assert.equal(await authorizeCredentials(undefined, ipHeaders()), null);
  assert.equal(
    await authorizeCredentials({ identifier: res.user.username, password: "correct horse battery", side: "null" }, ipHeaders()),
    null,
    "invalid side fails generic"
  );
});

// ---- Step 2 — race tests against the REAL transact (r2 revision 6) ----------

test("race (a): concurrent same-username signup ⇒ exactly 1 user + 1 pw.errTaken", async () => {
  freshBudgets();
  const username = uniqueName("race-a");
  const [a, b] = await Promise.all([
    createCredentialUser({ side: "seaman", username, password: "password-one" }),
    createCredentialUser({ side: "seaman", username, password: "password-two" }),
  ]);
  const oks = [a, b].filter((r) => r.ok);
  const taken = [a, b].filter((r) => !r.ok && r.errorKey === "pw.errTaken");
  assert.equal(oks.length, 1);
  assert.equal(taken.length, 1);
  assert.equal(readDB().credentialUsers.filter((u) => u.usernameLower === username.toLowerCase()).length, 1);
});

test("race (b): concurrent PLAIN sign-in ×2 on a never-bound side ⇒ ZERO tenants, both generic (D2)", async () => {
  freshBudgets();
  const res = await signup(); // seaman side bound; AGENT side never-bound
  const dbBefore = readDB();
  const agentsBefore = dbBefore.agents.length;
  const seafarersBefore = dbBefore.seafarers.length;
  const [a, b] = await Promise.all([
    authorizeCredentials(
      { identifier: res.user.username, password: "correct horse battery", side: "agent" },
      ipHeaders()
    ),
    authorizeCredentials(
      { identifier: res.user.username, password: "correct horse battery", side: "agent" },
      ipHeaders()
    ),
  ]);
  assert.equal(a, null);
  assert.equal(b, null);
  const dbAfter = readDB();
  assert.equal(dbAfter.agents.length, agentsBefore, "no tenant minted by a plain sign-in (inv. 14)");
  assert.equal(dbAfter.seafarers.length, seafarersBefore);
  assert.equal(dbAfter.credentialUsers.find((u) => u.id === res.user.id).agentId, null);
});

test("race (b2): concurrent explicit side-bind ⇒ exactly ONE binding, loser generic (CAS)", async () => {
  freshBudgets();
  const res = await signup();
  const [a, b] = await Promise.all([
    bindSideWithPassword({
      username: res.user.username,
      password: "correct horse battery",
      side: "agent",
      confirmBind: true,
    }),
    bindSideWithPassword({
      username: res.user.username,
      password: "correct horse battery",
      side: "agent",
      confirmBind: true,
    }),
  ]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, `exactly one bind, got ${JSON.stringify([a, b])}`);
  assert.equal([a, b].some((r) => !r.ok && !("needsBindConfirm" in r)), true);
  const stored = readDB().credentialUsers.find((u) => u.id === res.user.id);
  assert.equal(stored.agentId, credentialAgentId(res.user.id));
  assert.equal(readDB().agents.filter((x) => x.id === stored.agentId).length, 1);
  const binds = authEvents().filter(
    (e) => e.type === "PROFILE_BIND" && e.credId === res.user.id && e.via === "side-bind"
  );
  assert.equal(binds.length, 1);
});

test("bindSideWithPassword: confirm gate, wrong password generic, bound side generic (fold 6/8)", async () => {
  freshBudgets();
  const res = await signup();
  // Correct password + unbound side, NO confirm ⇒ needsBindConfirm (after verify only).
  const probe = await bindSideWithPassword({
    username: res.user.username,
    password: "correct horse battery",
    side: "agent",
  });
  assert.deepEqual(probe, { ok: false, needsBindConfirm: true });
  assert.equal(readDB().credentialUsers.find((u) => u.id === res.user.id).agentId, null, "probe binds nothing");
  // Wrong password ⇒ plain generic (no needsBindConfirm oracle).
  const wrong = await bindSideWithPassword({
    username: res.user.username,
    password: "totally wrong password",
    side: "agent",
    confirmBind: true,
  });
  assert.deepEqual(wrong, { ok: false });
  // Already-bound side (seaman) ⇒ plain generic even with the right password.
  const bound = await bindSideWithPassword({
    username: res.user.username,
    password: "correct horse battery",
    side: "seaman",
    confirmBind: true,
  });
  assert.deepEqual(bound, { ok: false });
});

test("race (c) SIGNUP path: two users, one adoptToken ⇒ 1 adoption + 1 fresh profile", async () => {
  freshBudgets();
  // An anonymous, unowned profile with a known share token.
  const token = await updateDB((db) => {
    const anon = {
      id: "anon-race-c",
      name: "Anon Race C",
      rank: "",
      state: "review",
      shareToken: "tok-race-c",
      openShareToken: "tok-race-c",
      emailShareToken: "tok-race-c-mail",
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    db.seafarers.push(anon);
    return anon.shareToken;
  });
  const [a, b] = await Promise.all([
    createCredentialUser({ side: "seaman", username: uniqueName("race-c1"), password: "password-c1", adoptToken: token }),
    createCredentialUser({ side: "seaman", username: uniqueName("race-c2"), password: "password-c2", adoptToken: token }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const adopted = [a, b].filter((r) => r.adoptedSeafarerId === "anon-race-c");
  assert.equal(adopted.length, 1, "exactly one adoption");
  const fresh = [a, b].find((r) => r.adoptedSeafarerId === null);
  assert.ok(fresh, "the loser minted a FRESH profile (signup path)");
  const anonRow = readDB().seafarers.find((s) => s.id === "anon-race-c");
  assert.equal(anonRow.credentialUserId, adopted[0].user.id);
});

test("race (c) SIGN-IN path: 1 adoption, loser fails generic (NO fresh mint on sign-in)", async () => {
  freshBudgets();
  // Two never-bound-on-seaman credential users: mint via agent-side signup.
  const u1 = await createCredentialUser({ side: "agent", username: uniqueName("race-d1"), password: "password-d1" });
  const u2 = await createCredentialUser({ side: "agent", username: uniqueName("race-d2"), password: "password-d2" });
  const token = await updateDB((db) => {
    const anon = {
      id: "anon-race-d",
      name: "Anon Race D",
      rank: "",
      state: "review",
      shareToken: "tok-race-d",
      openShareToken: "tok-race-d",
      emailShareToken: "tok-race-d-mail",
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    db.seafarers.push(anon);
    return anon.shareToken;
  });
  const seafarersBefore = readDB().seafarers.length;
  const [a, b] = await Promise.all([
    authorizeCredentials(
      { identifier: u1.user.username, password: "password-d1", side: "seaman", adoptToken: token },
      ipHeaders()
    ),
    authorizeCredentials(
      { identifier: u2.user.username, password: "password-d2", side: "seaman", adoptToken: token },
      ipHeaders()
    ),
  ]);
  const wins = [a, b].filter(Boolean);
  assert.equal(wins.length, 1, "exactly one adoption on the sign-in path");
  assert.equal(wins[0].seafarerId, "anon-race-d");
  assert.equal(readDB().seafarers.length, seafarersBefore, "loser minted NOTHING (sign-in path)");
  const binds = authEvents().filter(
    (e) => e.type === "PROFILE_BIND" && e.seafarerId === "anon-race-d" && e.via === "signin-adopt"
  );
  assert.equal(binds.length, 1);
});

test("adoptToken on sign-in: second sign-in with a DIFFERENT token does not re-adopt (ADOPT_SKIPPED)", async () => {
  freshBudgets();
  const res = await signup(); // seaman side already bound
  const otherToken = await updateDB((db) => {
    const anon = {
      id: "anon-skip",
      name: "Anon Skip",
      rank: "",
      state: "review",
      shareToken: "tok-skip",
      openShareToken: "tok-skip",
      emailShareToken: "tok-skip-mail",
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    db.seafarers.push(anon);
    return anon.shareToken;
  });
  const principal = await authorizeCredentials(
    { identifier: res.user.username, password: "correct horse battery", side: "seaman", adoptToken: otherToken },
    ipHeaders()
  );
  assert.ok(principal);
  assert.equal(principal.seafarerId, res.user.seafarerId, "keeps the EXISTING profile — no re-adoption");
  const anonRow = readDB().seafarers.find((s) => s.id === "anon-skip");
  assert.equal(anonRow.credentialUserId ?? null, null, "target stays unowned");
  const skipped = authEvents().filter((e) => e.type === "ADOPT_SKIPPED" && e.credId === res.user.id);
  assert.equal(skipped.length, 1, "ignored token recorded, never silent (fold 7)");
  assert.equal(skipped[0].idHash, idHash16(otherToken));
  assert.equal(JSON.stringify(skipped[0]).includes(otherToken), false, "raw token never in the sink");
});

test("findAdoptableProfileByToken: pure lookup, burns no scrypt (invited-bucket seam)", () => {
  const before = _scryptOpCount();
  const hit = findAdoptableProfileByToken(readDB(), "tok-skip");
  assert.ok(hit);
  assert.equal(hit.id, "anon-skip");
  assert.equal(findAdoptableProfileByToken(readDB(), "no-such-token"), null);
  assert.equal(findAdoptableProfileByToken(readDB(), "undefined"), null); // coerced absent
  assert.equal(_scryptOpCount(), before, "validity check burns NO scrypt");
});

// ---- Step 2f — merge / delete reconciliation --------------------------------

test("2f(a): merging a credential-owned row re-points the binding to the survivor (both pointer directions)", async () => {
  freshBudgets();
  const res = await signup();
  const credProfileId = res.user.seafarerId;
  // A plain (agent-created style) survivor, corroborated by passportNo.
  const survivorId = await updateDB((db) => {
    const s = {
      id: "merge-survivor",
      name: res.user.username, // same person
      rank: "",
      state: "review",
      shareToken: "tok-merge-s",
      openShareToken: "tok-merge-s",
      emailShareToken: "tok-merge-s-mail",
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
      passportNo: "P1234567",
    };
    db.seafarers.push(s);
    const absorbed = db.seafarers.find((x) => x.id === credProfileId);
    absorbed.passportNo = "P1234567"; // corroboration (stored-ID agreement)
    return s.id;
  });
  const merged = await mergePersons(survivorId, credProfileId, "agent:test");
  assert.equal(merged.ok, true, `merge should pass: ${JSON.stringify(merged)}`);

  const db = readDB();
  const survivor = db.seafarers.find((s) => s.id === survivorId);
  const credUser = db.credentialUsers.find((u) => u.id === res.user.id);
  // Bidirectional-pointer consistency (v4): each side resolves back to the other.
  assert.equal(survivor.credentialUserId, res.user.id);
  assert.equal(credUser.seafarerId, survivorId);
  assert.equal(db.seafarers.some((s) => s.id === credProfileId), false, "absorbed row deleted");
  const bind = authEvents().find(
    (e) => e.type === "PROFILE_BIND" && e.credId === res.user.id && e.via === "merge-inherit"
  );
  assert.ok(bind, "custody change audited in the SAME transact");
  assert.equal(bind.seafarerId, survivorId);

  // The credential login now lands on the survivor.
  const principal = await authorizeCredentials(
    { identifier: res.user.username, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.ok(principal);
  assert.equal(principal.seafarerId, survivorId);
});

test("2f-b: dangling seafarerId self-heals on sign-in; the re-forked profile starts EMPTY", async () => {
  freshBudgets();
  const res = await signup();
  // Simulate a hard delete (access.ts:677 pattern) that strands the binding.
  await updateDB((db) => {
    db.seafarers = db.seafarers.filter((s) => s.id !== res.user.seafarerId);
  });
  const principal = await authorizeCredentials(
    { identifier: res.user.username, password: "correct horse battery", side: "seaman" },
    ipHeaders()
  );
  assert.ok(principal, "sign-in heals the dangling binding");
  assert.notEqual(principal.seafarerId, res.user.seafarerId);
  const db = readDB();
  const fresh = db.seafarers.find((s) => s.id === principal.seafarerId);
  assert.ok(fresh);
  assert.equal(fresh.credentialUserId, res.user.id);
  assert.equal(fresh.ownerEmail, null);
  // Re-forked profile starts EMPTY (fold 12b): zero documents, no verification.
  assert.equal(db.documents.filter((d) => d.seafarerId === fresh.id).length, 0);
  assert.equal(fresh.identityVerified ?? false, false);
  const heal = authEvents().find(
    (e) => e.type === "PROFILE_BIND" && e.credId === res.user.id && e.via === "self-heal"
  );
  assert.ok(heal, "self-heal audited in the same transact");
});

test("seaman-account case 3: Google login must NOT adopt a credential-owned profile", async () => {
  freshBudgets();
  const res = await signup();
  const profile = readDB().seafarers.find((s) => s.id === res.user.seafarerId);
  const seafarersBefore = readDB().seafarers.length;
  const googleId = await findOrCreateSeafarerByGoogle(
    { sub: "google-sub-guard", email: "guard@example.com", name: "Guard" },
    profile.shareToken // holds the credential-owned profile's token
  );
  assert.notEqual(googleId, profile.id, "guard refused the adoption");
  assert.equal(readDB().seafarers.length, seafarersBefore + 1, "Google user got a FRESH profile instead");
  const after = readDB().seafarers.find((s) => s.id === profile.id);
  assert.equal(after.googleSub, null);
  assert.equal(after.credentialUserId, res.user.id, "credential ownership untouched");
});

// ---- v6 fold 7 — commit-marker schema ---------------------------------------

test("commit marker holds ONLY { usernameLower, side, ts } — no password/email material", () => {
  const marker = buildSignupCommitMarker({
    username: "  CaféUser  ",
    side: "seaman",
    // Extra secrets passed alongside must be dropped by construction:
    password: "super secret password",
    email: "leak@example.com",
  });
  assert.deepEqual(Object.keys(marker).sort(), ["side", "ts", "usernameLower"]);
  assert.equal(marker.usernameLower, "caféuser");
  const serialized = JSON.stringify(marker);
  assert.equal(serialized.includes("super secret password"), false);
  assert.equal(serialized.includes("leak@example.com"), false);
  assert.equal(markerMatches(marker, { username: "caféuser", side: "seaman" }), true); // NFC-equiv
  assert.equal(markerMatches(marker, { username: "caféuser", side: "agent" }), false);
  assert.deepEqual(parseSignupCommitMarker(JSON.stringify(marker)), marker);
  assert.equal(parseSignupCommitMarker("{not json"), null);
  assert.equal(parseSignupCommitMarker(JSON.stringify({ usernameLower: 5, side: "seaman", ts: 1 })), null);
});

// ---- Step 3 — rate limiting -------------------------------------------------

test("bucket caps: identifier bucket trips at its cap, isolated from IP bucket and registry buckets", () => {
  freshBudgets();
  const key = idHash16("some-identifier");
  for (let i = 0; i < 5; i++) assert.equal(consumeAuthBudget("auth-login-id", key), true);
  assert.equal(consumeAuthBudget("auth-login-id", key), false, "6th charge trips (cap 5)");
  // The IP bucket for the same string key is INDEPENDENT (namespaced bucket names).
  assert.equal(consumeAuthBudget("auth-login-ip", key), true);
  // And the registry namespace is untouched by auth charges (isolation).
  assert.equal(consumeBudget("registry", "9.9.9.9", { capacity: 2, refillPerMs: 0 }), true);
  for (let i = 0; i < 3; i++) consumeAuthBudget("auth-recovery-id", idHash16("x"));
  assert.equal(consumeAuthBudget("auth-recovery-id", idHash16("x")), false, "recovery id cap 3");
  assert.equal(consumeBudget("registry", "9.9.9.9", { capacity: 2, refillPerMs: 0 }), true, "registry bucket unaffected");
  // Invited-signup bucket: 3/h per token.
  for (let i = 0; i < 3; i++) assert.equal(consumeAuthBudget("auth-signup-invited", "tok-abc"), true);
  assert.equal(consumeAuthBudget("auth-signup-invited", "tok-abc"), false, "4th signup on ONE token trips");
  assert.equal(consumeAuthBudget("auth-signup-invited", "tok-other"), true, "other tokens unaffected");
});

test("rotating fake XFF lands in ONE bucket (rightmost entry wins; leftmost never chosen)", async () => {
  freshBudgets();
  const res = await signup();
  // 10 login attempts, each with a DIFFERENT client-controlled leftmost XFF but
  // the SAME trusted rightmost hop. All must land in one auth-login-ip bucket.
  // Cap is 10/min — with the per-identifier cap at 5 we use 5 DISTINCT identifiers
  // (all misses after the first) so only the IP bucket accumulates all charges.
  let denied = 0;
  for (let i = 0; i < 12; i++) {
    const headers = new Headers({ "x-forwarded-for": `1.2.3.${i}, 8.8.8.8` });
    const out = await authorizeCredentials(
      { identifier: `spoofer-${i}`, password: "whatever pass", side: "seaman" },
      { headers }
    );
    assert.equal(out, null);
    if (i >= 10) denied++; // charges 11+ must be over the 10/min IP cap
  }
  // Prove the IP bucket (keyed on the RIGHTMOST 8.8.8.8) is exhausted despite
  // 12 distinct leftmost entries: a 13th request with a fresh leftmost still 429s...
  assert.equal(consumeAuthBudget("auth-login-ip", "8.8.8.8"), false, "one bucket despite rotating XFF");
  // ...while a genuinely different trusted hop is unaffected.
  assert.equal(consumeAuthBudget("auth-login-ip", "8.8.4.4"), true);
  void res;
  void denied;
});

test("per-ACCOUNT bucket trips when the two identifiers of one account alternate (r2 rev 7)", async () => {
  freshBudgets();
  const email = `acct-${Date.now() % 100000}@example.com`;
  const res = await signup({ email });
  const identifiers = [res.user.username, email];
  // 5 wrong-password attempts, alternating identifiers, each from a FRESH IP so
  // neither the IP bucket (10/min) nor an identifier bucket (5/5min — sees ≤3)
  // can be the limiter. Each burns one real scrypt verify.
  for (let i = 0; i < 5; i++) {
    const before = _scryptOpCount();
    const out = await authorizeCredentials(
      { identifier: identifiers[i % 2], password: "wrong password here", side: "seaman" },
      ipHeaders()
    );
    assert.equal(out, null);
    assert.equal(_scryptOpCount() - before, 1, `attempt ${i + 1} reached scrypt`);
  }
  // 6th attempt: the ACCOUNT bucket (cap 5, keyed on CredentialUser.id) trips
  // BEFORE any scrypt — regardless of which identifier is used.
  const before = _scryptOpCount();
  const out = await authorizeCredentials(
    { identifier: identifiers[1], password: "wrong password here", side: "seaman" },
    ipHeaders()
  );
  assert.equal(out, null);
  assert.equal(_scryptOpCount() - before, 0, "over-limit: no scrypt burned");
});

test("RATE_LIMITED flood ⇒ BOUNDED per-bucket aggregate lines, never O(N)", async () => {
  freshBudgets();
  const linesBefore = authEvents().filter((e) => e.type === "RATE_LIMITED").length;
  // Exhaust one bucket, then flood it far beyond the aggregation window count.
  const key = idHash16("flood-victim");
  for (let i = 0; i < 5; i++) consumeAuthBudget("auth-login-id", key);
  const N = 500;
  for (let i = 0; i < N; i++) assert.equal(consumeAuthBudget("auth-login-id", key), false);
  await _flushRateLimitedAggregates();
  const lines = authEvents().filter((e) => e.type === "RATE_LIMITED");
  const fresh = lines.slice(linesBefore);
  assert.ok(fresh.length >= 1, "the aggregate line exists");
  // Bounded: one line per bucket per 10-min window (2 tolerates a window
  // boundary crossing mid-flood), NEVER O(N).
  assert.ok(fresh.length <= 2, `bounded (per bucket per window), got ${fresh.length} for ${N} over-limit hits`);
  for (const agg of fresh) {
    assert.equal(agg.bucket, "auth-login-id");
    assert.ok(agg.firstAt <= agg.lastAt);
  }
  const total = fresh.reduce((n, e) => n + e.count, 0);
  assert.equal(total >= N, true, `aggregates carry the full count (got ${total})`);
});

// ---- Sink hygiene (invariant 4) + chain integrity ---------------------------

test("auth-events sink: hash-chain intact; no plaintext secret/username/email ever appended", async () => {
  await _flushRateLimitedAggregates();
  const chain = verifyAuditChain("auth-events");
  assert.equal(chain.ok, true, `auth-events chain broken at ${chain.brokenAt}`);
  const raw = fs.readFileSync(AUTH_EVENTS_PATH, "utf-8");
  assert.equal(raw.includes("correct horse battery"), false, "no plaintext password");
  assert.equal(raw.includes("@example.com"), false, "no raw email");
  for (const u of readDB().credentialUsers) {
    assert.equal(raw.includes(u.username), false, `raw username ${u.username} leaked to sink`);
    assert.equal(raw.includes(u.password.hashB64), false, "password hash leaked to sink");
  }
  // authIpHash is date-rotated and never the raw IP.
  assert.equal(raw.includes("8.8.8.8"), false, "raw IP leaked to sink");
  assert.notEqual(authIpHash("8.8.8.8"), authIpHash("8.8.4.4"));
  assert.equal(authIpHash("8.8.8.8"), authIpHash("8.8.8.8"));
  assert.notEqual(
    authIpHash("8.8.8.8", new Date("2026-01-01T00:00:00Z")),
    authIpHash("8.8.8.8", new Date("2026-01-02T00:00:00Z")),
    "day rotation"
  );
});
