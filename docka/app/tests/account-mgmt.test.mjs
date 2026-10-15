// feat/password-signup — Step 13 signed-in account management (D11), plan
// Step 10 "account-mgmt" rows:
//
//   - change-password (route): commits, every PRE-change token fails BOTH
//     session gates (pwdAt, invariant 11) while a re-minted token passes; the
//     old password is dead;
//   - wrong/missing currentPassword ⇒ ONE generic failure for both ops, and
//     nothing changes;
//   - regenerate (route): voids ALL old codes (unused old fails, consumed old
//     stays dead), mints 8 new ones that verify; response carries the
//     plaintext codes + username for the ceremony screen;
//   - auth-account-mgmt bucket (5/h/account) trips at the 6th op;
//   - PASSWORD_CHANGE / CODES_REGENERATED appended id-only (no password/email
//     material ever reaches the sink);
//   - claim-report route (v6 fold 3): a session-gated POST with a valid token
//     emits ADOPT_SKIPPED carrying the idHash ONLY (the raw token never
//     appears in the sink) and 429s once auth-account-mgmt trips (6th);
//   - gates: no session ⇒ 401 on all three routes; a STALE pre-change session
//     is rejected by the route gate itself; a Google session can claim-report
//     (no credId on the event) but can NOT reach the password-management ops;
//   - CSRF stance (shared lib/auth-csrf.ts): cross-origin ⇒ 403.
//
// The routes are driven DIRECTLY (duck-typed requests, the
// password-auth-routes.test.mjs precedent) with sessions built through the
// REAL claim path (authorizeCredentials → the exported jwtCallback →
// sessionCallback — the invariants-test helper) and injected via the
// mock-mode-only account-session override (REGISTRY_MOCK=1; auth() needs a
// live request scope plain node lacks).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/account-mgmt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.REGISTRY_MOCK = "1";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-account-mgmt-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { readDB, updateDB } = await import("@/lib/db");
const {
  createCredentialUser,
  authorizeCredentials,
  resetPasswordWithRecoveryCode,
  changePassword,
  regenerateRecoveryCodes,
} = await import("@/lib/credential-auth");
const { idHash16, _resetRateLimitedAggregates } = await import("@/lib/auth-rate-limit");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { jwtCallback, sessionCallback } = await import("@/auth");
const { credentialSeamanClaimValid } = await import("@/lib/seaman-session");
const { resolveCredentialAgentSession } = await import("@/lib/agent-session");
const { __setTestAccountSession } = await import("@/lib/account-session");
const { POST: changePwPOST } = await import("@/app/api/account/change-password/route");
const { POST: regenPOST } = await import("@/app/api/account/regenerate-codes/route");
const { POST: claimReportPOST } = await import("@/app/api/account/claim-report/route");

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

function sinkRaw() {
  return fs.existsSync(AUTH_EVENTS_PATH) ? fs.readFileSync(AUTH_EVENTS_PATH, "utf-8") : "";
}

let ipSeq = 0;
function ipHeaders() {
  return { headers: new Headers({ "x-registry-test-ip": `10.9.0.${(ipSeq++ % 250) + 1}` }) };
}

let userSeq = 0;
function uniqueName(prefix = "mgmt") {
  return `${prefix}-${++userSeq}-${Date.now() % 100000}`;
}

const GOOD_PW = "correct horse battery";
const HOST = "docka.test";

/** Duck-typed request for the route handlers (routes-test precedent). */
function jsonReq(body, { origin, contentType = "application/json" } = {}) {
  const headers = new Headers({ host: HOST });
  if (contentType !== null) headers.set("content-type", contentType);
  if (origin !== undefined) headers.set("origin", origin);
  return { headers, json: async () => body };
}

/** THE REAL CLAIM PATH (invariants-test helper): authorize → jwt → session. */
async function credentialSession(creds) {
  const principal = await authorizeCredentials(creds, ipHeaders());
  if (!principal) return null;
  const token = await jwtCallback({
    token: { name: principal.name, email: principal.email, picture: undefined, sub: principal.id },
    user: principal,
    account: { providerAccountId: principal.id, type: "credentials", provider: "credentials" },
    profile: undefined,
  });
  const session = await sessionCallback({
    session: { user: { name: token.name ?? null, email: token.email ?? null }, expires: "" },
    token,
  });
  return { principal, token, session };
}

async function seamanSignup(overrides = {}) {
  const username = uniqueName();
  const res = await createCredentialUser({ side: "seaman", username, password: GOOD_PW, ...overrides });
  assert.equal(res.ok, true, `signup should pass: ${JSON.stringify(res)}`);
  return res;
}

let anonSeq = 0;
/** Insert an unowned anonymous profile; returns { id, token }. */
async function mintAnonProfile() {
  const n = ++anonSeq;
  return updateDB((db) => {
    const anon = {
      id: `anon-mgmt-${n}`,
      name: `Anon Mgmt ${n}`,
      rank: "",
      state: "review",
      shareToken: `tok-mgmt-${n}`,
      openShareToken: `tok-mgmt-${n}`,
      emailShareToken: `tok-mgmt-${n}-mail`,
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    db.seafarers.push(anon);
    return { id: anon.id, token: anon.shareToken };
  });
}

// ---- change password ---------------------------------------------------------

test("change-password (route): pre-change token fails BOTH gates, re-minted token passes, old password dead", async () => {
  freshBudgets();
  const NEW_PW = "a fresh new password";
  const su = await seamanSignup();
  const pre = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  assert.ok(pre);
  const seafarer = () => readDB().seafarers.find((x) => x.id === su.user.seafarerId);
  assert.equal(credentialSeamanClaimValid(pre.session, seafarer(), readDB()), true);

  __setTestAccountSession(pre.session);
  const res = await changePwPOST(jsonReq({ currentPassword: GOOD_PW, newPassword: NEW_PW }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // Invariant 11: the pre-change 30-day JWT is now stale in the seaman gate...
  assert.equal(credentialSeamanClaimValid(pre.session, seafarer(), readDB()), false, "pre-change token dead");
  // ...and the ROUTE gate itself rejects the stale session too (fail closed).
  const staleOp = await regenPOST(jsonReq({ currentPassword: NEW_PW }));
  assert.equal(staleOp.status, 401, "stale session cannot reach account ops");

  // Old password is dead; the new one re-mints a session that passes.
  freshBudgets();
  const old = await authorizeCredentials(
    { identifier: su.user.username, password: GOOD_PW, side: "seaman" },
    ipHeaders()
  );
  assert.equal(old, null, "old password dead");
  const post = await credentialSession({ identifier: su.user.username, password: NEW_PW, side: "seaman" });
  assert.ok(post, "new password signs in");
  assert.equal(credentialSeamanClaimValid(post.session, seafarer(), readDB()), true, "re-minted token passes");

  // PASSWORD_CHANGE appended id-only: credId present, no secret material.
  const ev = authEvents().filter((e) => e.type === "PASSWORD_CHANGE" && e.credId === su.user.id);
  assert.equal(ev.length, 1, "exactly one PASSWORD_CHANGE for this account");
  const raw = sinkRaw();
  assert.equal(raw.includes(GOOD_PW), false, "old password never in the sink");
  assert.equal(raw.includes(NEW_PW), false, "new password never in the sink");
  assert.equal(raw.includes(su.user.username), false, "username never in the sink");
});

test("change-password kills the AGENT gate's pre-change tokens too (invariant 11, both gates)", async () => {
  freshBudgets();
  const NEW_PW = "another fresh password";
  const username = uniqueName("agency");
  const au = await createCredentialUser({ side: "agent", username, password: GOOD_PW });
  assert.equal(au.ok, true);
  const pre = await credentialSession({ identifier: username, password: GOOD_PW, side: "agent" });
  assert.ok(resolveCredentialAgentSession(pre.session, readDB()), "pre-change agent token valid");

  __setTestAccountSession(pre.session);
  const res = await changePwPOST(jsonReq({ currentPassword: GOOD_PW, newPassword: NEW_PW }));
  assert.equal(res.status, 200);
  assert.equal(resolveCredentialAgentSession(pre.session, readDB()), null, "pre-change agent token dead");

  freshBudgets();
  const post = await credentialSession({ identifier: username, password: NEW_PW, side: "agent" });
  assert.ok(resolveCredentialAgentSession(post.session, readDB()), "re-minted agent token passes");
});

test("wrong/missing currentPassword ⇒ ONE generic failure for BOTH ops; nothing changes", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const s = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  __setTestAccountSession(s.session);

  const wrongChange = await changePwPOST(
    jsonReq({ currentPassword: "not the password", newPassword: "some new password" })
  );
  assert.equal(wrongChange.status, 400);
  assert.deepEqual(await wrongChange.json(), { ok: false, errorKey: "pw.errGeneric" });

  const missingChange = await changePwPOST(jsonReq({ newPassword: "some new password" }));
  assert.equal(missingChange.status, 400);
  assert.deepEqual(await missingChange.json(), { ok: false, errorKey: "pw.errGeneric" });

  const wrongRegen = await regenPOST(jsonReq({ currentPassword: "not the password" }));
  assert.equal(wrongRegen.status, 400);
  assert.deepEqual(await wrongRegen.json(), { ok: false, errorKey: "pw.errGeneric" });

  // Weak NEW password (with the CORRECT current) is the one non-generic arm.
  const weak = await changePwPOST(jsonReq({ currentPassword: GOOD_PW, newPassword: "short" }));
  assert.equal(weak.status, 400);
  assert.deepEqual(await weak.json(), { ok: false, errorKey: "pw.errWeak" });

  // Nothing changed: the old password still signs in, codes still intact.
  freshBudgets();
  const still = await authorizeCredentials(
    { identifier: su.user.username, password: GOOD_PW, side: "seaman" },
    ipHeaders()
  );
  assert.ok(still, "password unchanged");
  const user = readDB().credentialUsers.find((u) => u.id === su.user.id);
  assert.equal(user.recoveryCodes.filter((c) => c.usedAt === null).length, 8, "codes untouched");
  assert.equal(user.passwordChangedAt, null, "no passwordChangedAt stamp");
});

// ---- regenerate recovery codes ----------------------------------------------

test("regenerate (route): voids ALL old codes, mints 8 that verify; consumed old codes stay dead", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const oldCodes = su.recoveryCodes;

  // Consume old code #0 first (so we can pin "used old stays dead" separately
  // from "unused old voided"). This also stamps a new password.
  const PW2 = "password after reset";
  const reset = await resetPasswordWithRecoveryCode({
    identifier: su.user.username,
    code: oldCodes[0],
    newPassword: PW2,
  });
  assert.equal(reset.ok, true);

  freshBudgets();
  const s = await credentialSession({ identifier: su.user.username, password: PW2, side: "seaman" });
  __setTestAccountSession(s.session);
  const res = await regenPOST(jsonReq({ currentPassword: PW2 }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.recoveryCodes.length, 8, "8 fresh plaintext codes");
  assert.equal(json.username, su.user.username, "ceremony screen shows the username");

  // Regeneration does NOT stamp pwdAt — the acting session stays valid.
  const seafarer = readDB().seafarers.find((x) => x.id === su.user.seafarerId);
  assert.equal(credentialSeamanClaimValid(s.session, seafarer, readDB()), true, "session survives regen");

  // Every OLD code is void: unused old fails generic...
  freshBudgets();
  const oldUnused = await resetPasswordWithRecoveryCode({
    identifier: su.user.username,
    code: oldCodes[1],
    newPassword: "yet another password",
  });
  assert.equal(oldUnused.ok, false, "unused OLD code voided by regeneration");
  // ...and the consumed old code stays dead.
  freshBudgets();
  const oldUsed = await resetPasswordWithRecoveryCode({
    identifier: su.user.username,
    code: oldCodes[0],
    newPassword: "yet another password",
  });
  assert.equal(oldUsed.ok, false, "consumed OLD code stays dead");

  // A NEW code works.
  freshBudgets();
  const PW3 = "password after new code";
  const newCode = await resetPasswordWithRecoveryCode({
    identifier: su.user.username,
    code: json.recoveryCodes[0],
    newPassword: PW3,
  });
  assert.equal(newCode.ok, true, "new code verifies");
  assert.equal(newCode.remainingCodes, 7);

  // CODES_REGENERATED appended id-only; no plaintext code in the sink.
  const ev = authEvents().filter((e) => e.type === "CODES_REGENERATED" && e.credId === su.user.id);
  assert.equal(ev.length, 1);
  const raw = sinkRaw();
  for (const code of json.recoveryCodes) {
    assert.equal(raw.includes(code), false, "plaintext codes never in the sink");
  }
});

// ---- auth-account-mgmt bucket -------------------------------------------------

test("auth-account-mgmt bucket trips at the 6th op per account (5/h)", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const s = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  __setTestAccountSession(s.session);

  // 5 charges (wrong current password keeps them cheap and mutation-free)...
  for (let i = 0; i < 5; i++) {
    const r = await changePwPOST(jsonReq({ currentPassword: "wrong", newPassword: "some new password" }));
    assert.equal(r.status, 400, `op ${i + 1} charged + failed generic`);
  }
  // ...the 6th — regardless of which op — is over-limit.
  const sixth = await regenPOST(jsonReq({ currentPassword: GOOD_PW }));
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), { ok: false, errorKey: "pw.errRate" });
});

// ---- claim-report (Step 13c, v6 fold 3) ---------------------------------------

test("claim-report: valid token emits ADOPT_SKIPPED idHash-only (never the raw token); 429 at the 6th", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const s = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  __setTestAccountSession(s.session);
  const anon = await mintAnonProfile();

  const res = await claimReportPOST(jsonReq({ token: anon.token }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const ev = authEvents().filter((e) => e.type === "ADOPT_SKIPPED" && e.credId === su.user.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].idHash, idHash16(anon.token), "idHash = first-16-hex sha256 of the token");
  assert.equal("token" in ev[0], false, "no token field on the event");
  assert.equal(sinkRaw().includes(anon.token), false, "raw claim token NEVER reaches the sink");

  // An unknown token answers generic (still charged — attacker-triggerable work
  // stays bucket-bounded) and emits nothing.
  const bogus = await claimReportPOST(jsonReq({ token: "no-such-token" }));
  assert.equal(bogus.status, 400);
  assert.equal(
    authEvents().filter((e) => e.type === "ADOPT_SKIPPED" && e.credId === su.user.id).length,
    1,
    "invalid token emits no event"
  );

  // Charges so far: 2. Three more valid reports = 5 total; the 6th ⇒ 429.
  for (let i = 0; i < 3; i++) {
    const r = await claimReportPOST(jsonReq({ token: anon.token }));
    assert.equal(r.status, 200);
  }
  const sixth = await claimReportPOST(jsonReq({ token: anon.token }));
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), { ok: false, errorKey: "pw.errRate" });
});

test("claim-report: a GOOGLE seaman session reports too (no credId); Google sessions cannot reach the password ops", async () => {
  freshBudgets();
  const anon = await mintAnonProfile();
  const owned = await mintAnonProfile(); // the Google seaman's own live profile
  const googleSession = {
    role: "seaman",
    seafarerId: owned.id,
    user: { name: "Google Seaman", email: "google-seaman@example.org" },
  };
  __setTestAccountSession(googleSession);

  const res = await claimReportPOST(jsonReq({ token: anon.token }));
  assert.equal(res.status, 200);
  const ev = authEvents().filter((e) => e.type === "ADOPT_SKIPPED" && e.idHash === idHash16(anon.token));
  assert.ok(ev.length >= 1);
  assert.equal("credId" in ev[ev.length - 1], false, "google-session report carries no credId");

  // The password-management ops are PASSWORD-account-only.
  const change = await changePwPOST(jsonReq({ currentPassword: "x", newPassword: "some new password" }));
  assert.equal(change.status, 401);
  const regen = await regenPOST(jsonReq({ currentPassword: "x" }));
  assert.equal(regen.status, 401);
});

// ---- gates + CSRF -------------------------------------------------------------

test("no session ⇒ 401 on all three routes; cross-origin ⇒ 403 (CSRF before everything)", async () => {
  freshBudgets();
  __setTestAccountSession(null);
  for (const [name, post, body] of [
    ["change-password", changePwPOST, { currentPassword: "x", newPassword: "some new password" }],
    ["regenerate-codes", regenPOST, { currentPassword: "x" }],
    ["claim-report", claimReportPOST, { token: "t" }],
  ]) {
    const unauth = await post(jsonReq(body));
    assert.equal(unauth.status, 401, `${name}: no session ⇒ 401`);
    const cross = await post(jsonReq(body, { origin: "https://evil.example" }));
    assert.equal(cross.status, 403, `${name}: cross-origin ⇒ 403`);
    const form = await post(jsonReq(body, { contentType: "application/x-www-form-urlencoded" }));
    assert.equal(form.status, 403, `${name}: form content-type ⇒ 403`);
  }
});
