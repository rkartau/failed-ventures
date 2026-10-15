// feat/password-signup — Step 6 route tests (POST /api/signup, POST
// /api/recovery-reset), plan Step 10 "password-auth-routes" rows that map to
// the wave-2 scope:
//
//   - CSRF matrix (r2 revision 8 + v4): JSON with NEITHER Origin nor Referer
//     succeeds (headerless webview); cross-origin Origin ⇒ 403; form-encoded
//     content-type ⇒ 403; `application/json; charset=utf-8` accepted (MIME
//     match, not exact-string); literal `Origin: null` ⇒ 403 (fails closed);
//     matching Origin/Referer pass; CSRF rejections charge NO rate bucket.
//   - signup creates CredentialUser + role binding; duplicate usernameLower ⇒
//     pw.errTaken; replay of an identical committed signup ⇒ pw.errTaken, NO
//     duplicate user, and (v6 fold 6) needsBindConfirm ABSENT even though the
//     replayed password is CORRECT (the side is bound).
//   - e-mail hygiene: stored lower-cased on the CredentialUser ONLY —
//     Seafarer.ownerEmail and Agent.googleEmail stay null (invariant 2).
//   - adopt-at-signup: valid token binds the unowned anon profile; a Google-
//     owned and a credential-owned target are both refused (fresh mint
//     instead). (Adopt-at-SIGN-IN is pinned in credential-users.test.mjs —
//     race (c) sign-in path + the ADOPT_SKIPPED test.)
//   - bind arm (v5 fold 8): existing username + CORRECT password + unbound
//     side ⇒ needsBindConfirm without confirmBind; binds with it (no new
//     CredentialUser, NO recoveryCodes in the response); wrong password ⇒
//     plain generic pw.errTaken.
//   - invited-signup bucket split (v5 fold 1): valid tokens skip the per-IP
//     walk-in bucket; the per-token bucket trips at the 4th charge; an
//     INVALID token falls back to the IP bucket (no bypass via guessing);
//     the validity check burns NO scrypt (hash-call counter).
//   - per-IP 429 for walk-ins; RATE_LIMITED flood at route level stays a
//     BOUNDED number of per-bucket aggregate lines, never O(N).
//   - recovery-reset: success carries remainingCodes; ANY failure is the ONE
//     generic pw.errRecovery; same CSRF stance.
//
// Follows the credential-users.test.mjs pattern: plain node:test + the `@/*`
// alias hook, a throwaway data dir chdir'd BEFORE any @/lib import,
// deterministic, no live network. Route handlers are imported directly and
// driven with duck-typed request objects ({ headers, json() }) — the
// verify-upload-integration.test.mjs precedent.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/password-auth-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode BEFORE any @/lib import — enables the x-registry-test-ip override
// so routes can simulate distinct client IPs without a proxy hop.
process.env.REGISTRY_MOCK = "1";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-password-auth-routes-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { readDB, updateDB } = await import("@/lib/db");
const { authorizeCredentials, _scryptOpCount } = await import("@/lib/credential-auth");
const { consumeAuthBudget, idHash16, _flushRateLimitedAggregates, _resetRateLimitedAggregates } =
  await import("@/lib/auth-rate-limit");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { sameOriginJsonOk } = await import("@/lib/auth-csrf");
const { POST: signupPOST } = await import("@/app/api/signup/route");
const { POST: recoveryPOST } = await import("@/app/api/recovery-reset/route");

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
function nextIp() {
  return `10.7.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
}

const HOST = "docka.test";

/**
 * Duck-typed request for the route handlers (verify-upload-integration
 * precedent): only `headers` and `json()` are consumed. `origin`/`referer`
 * are set only when passed (undefined means "header absent").
 */
function jsonReq(body, { ip = nextIp(), origin, referer, contentType = "application/json", host = HOST, extraHeaders = {} } = {}) {
  const headers = new Headers({ "x-registry-test-ip": ip, host });
  if (contentType !== null) headers.set("content-type", contentType);
  if (origin !== undefined) headers.set("origin", origin);
  if (referer !== undefined) headers.set("referer", referer);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return { headers, json: async () => body };
}

let userSeq = 0;
function uniqueName(prefix = "routetester") {
  return `${prefix}-${++userSeq}-${Date.now() % 100000}`;
}

const GOOD_PW = "correct horse battery";

async function signupVia(bodyOverrides = {}, reqOpts = {}) {
  const body = { side: "seaman", username: uniqueName(), password: GOOD_PW, ...bodyOverrides };
  const res = await signupPOST(jsonReq(body, reqOpts));
  return { body, res, json: await res.json() };
}

let anonSeq = 0;
/** Insert an unowned anonymous profile; returns its share token. */
async function mintAnonProfile(overrides = {}) {
  const n = ++anonSeq;
  return updateDB((db) => {
    const anon = {
      id: `anon-rt-${n}`,
      name: `Anon Route ${n}`,
      rank: "",
      state: "review",
      shareToken: `tok-rt-${n}`,
      openShareToken: `tok-rt-${n}`,
      emailShareToken: `tok-rt-${n}-mail`,
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
      ...overrides,
    };
    db.seafarers.push(anon);
    return { id: anon.id, token: anon.shareToken };
  });
}

// ---- CSRF matrix (r2 revision 8 + v4) ---------------------------------------

test("CSRF: JSON with NEITHER Origin nor Referer succeeds (headerless webview)", async () => {
  freshBudgets();
  const { res, json } = await signupVia();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.recoveryCodes.length, 8);
  assert.equal(typeof json.username, "string");
});

test("CSRF: application/json; charset=utf-8 is accepted (MIME match, not exact string)", async () => {
  freshBudgets();
  const { res, json } = await signupVia({}, { contentType: "application/json; charset=utf-8" });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
});

test("CSRF: form-encoded content-type ⇒ 403; cross-origin Origin ⇒ 403; Origin: null ⇒ 403", async () => {
  freshBudgets();
  const body = { side: "seaman", username: uniqueName(), password: GOOD_PW };
  const form = await signupPOST(jsonReq(body, { contentType: "application/x-www-form-urlencoded" }));
  assert.equal(form.status, 403);
  const cross = await signupPOST(jsonReq(body, { origin: "https://evil.example" }));
  assert.equal(cross.status, 403);
  // The literal opaque origin "null" (sandboxed iframe / some redirects) fails
  // URL parsing and is denied — fails closed as written (v4).
  const nul = await signupPOST(jsonReq(body, { origin: "null" }));
  assert.equal(nul.status, 403);
  // Same stance on the recovery route.
  const rec = await recoveryPOST(
    jsonReq({ identifier: "x", code: "y", newPassword: "whatever pass" }, { origin: "https://evil.example" })
  );
  assert.equal(rec.status, 403);
  // No user was created by any of the rejected requests.
  assert.equal(readDB().credentialUsers.some((u) => u.usernameLower === body.username.toLowerCase()), false);
});

test("CSRF: matching Origin passes; matching Referer passes; mismatched Referer ⇒ 403", async () => {
  freshBudgets();
  const ok1 = await signupVia({}, { origin: `https://${HOST}` });
  assert.equal(ok1.res.status, 200);
  const ok2 = await signupVia({}, { referer: `https://${HOST}/seafarer` });
  assert.equal(ok2.res.status, 200);
  const bad = await signupPOST(
    jsonReq({ side: "seaman", username: uniqueName(), password: GOOD_PW }, { referer: "https://evil.example/x" })
  );
  assert.equal(bad.status, 403);
  // Unit-level: the helper honours x-forwarded-host (the reverse-proxy case).
  assert.equal(
    sameOriginJsonOk({
      headers: new Headers({
        "content-type": "application/json",
        host: "localhost:3000",
        "x-forwarded-host": "docka.me",
        origin: "https://docka.me",
      }),
    }),
    true
  );
});

test("CSRF rejections charge NO rate bucket (v4 ordering: CSRF before buckets)", async () => {
  freshBudgets();
  const ip = nextIp();
  // 10 cross-origin rejections from ONE IP — far beyond the 5/h walk-in cap.
  for (let i = 0; i < 10; i++) {
    const r = await signupPOST(
      jsonReq({ side: "seaman", username: uniqueName(), password: GOOD_PW }, { ip, origin: "https://evil.example" })
    );
    assert.equal(r.status, 403);
  }
  // A legit signup from the SAME IP still passes — nothing was charged.
  const { res, json } = await signupVia({}, { ip });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
});

// ---- Signup semantics --------------------------------------------------------

test("signup creates CredentialUser + role binding; email stays OFF Seafarer/Agent rows (inv. 2)", async () => {
  freshBudgets();
  const { res, json } = await signupVia({ email: "  Contact@Example.ORG " });
  assert.equal(res.status, 200);
  const user = readDB().credentialUsers.find((u) => u.username === json.username);
  assert.ok(user);
  assert.equal(user.emailUnverified, "contact@example.org"); // lower-cased, CredentialUser ONLY
  assert.ok(user.seafarerId);
  const profile = readDB().seafarers.find((s) => s.id === user.seafarerId);
  assert.equal(profile.credentialUserId, user.id);
  assert.equal(profile.ownerEmail, null, "unverified email must NEVER reach ownerEmail");

  const agent = await signupVia({ side: "agent", username: uniqueName("agency"), email: "agency@example.org" });
  assert.equal(agent.res.status, 200);
  const agentUser = readDB().credentialUsers.find((u) => u.username === agent.json.username);
  const agentRow = readDB().agents.find((a) => a.id === agentUser.agentId);
  assert.ok(agentRow);
  assert.equal(agentRow.googleEmail, null, "unverified email must NEVER reach Agent.googleEmail");
  assert.equal(String(agentRow.contact).includes("@"), false, "contact is the username, never an email");
});

test("duplicate username: wrong password ⇒ plain pw.errTaken, needsBindConfirm ABSENT", async () => {
  freshBudgets();
  const first = await signupVia();
  const dup = await signupPOST(
    jsonReq({ side: "seaman", username: first.body.username, password: "a totally different pw" })
  );
  assert.equal(dup.status, 400);
  const dupJson = await dup.json();
  assert.equal(dupJson.ok, false);
  assert.equal(dupJson.errorKey, "pw.errTaken");
  assert.equal("needsBindConfirm" in dupJson, false, "wrong password must not reveal bindability");
});

test("replay of an identical COMMITTED signup ⇒ pw.errTaken, NO duplicate, needsBindConfirm ABSENT (v6 fold 6)", async () => {
  freshBudgets();
  // The lost-response scenario: the server committed, the response (with the
  // only plaintext codes) was lost, and the client retries the SAME body —
  // correct password, side now BOUND.
  const first = await signupVia();
  assert.equal(first.res.status, 200);
  const replay = await signupPOST(jsonReq(first.body));
  assert.equal(replay.status, 400);
  const replayJson = await replay.json();
  assert.equal(replayJson.errorKey, "pw.errTaken");
  assert.equal("needsBindConfirm" in replayJson, false, "bound side never answers needsBindConfirm");
  assert.equal("recoveryCodes" in replayJson, false, "codes can never be re-shown");
  const rows = readDB().credentialUsers.filter((u) => u.usernameLower === first.body.username.toLowerCase());
  assert.equal(rows.length, 1, "usernameLower CAS — no duplicate user");
});

// ---- Bind arm (v5 fold 8) ----------------------------------------------------

test("bind arm: correct password + unbound side ⇒ needsBindConfirm, then binds with confirmBind (no new user, no codes)", async () => {
  freshBudgets();
  const first = await signupVia(); // seaman side bound; agent side unbound
  const usersBefore = readDB().credentialUsers.length;

  const probe = await signupPOST(jsonReq({ side: "agent", username: first.body.username, password: GOOD_PW }));
  assert.equal(probe.status, 200);
  const probeJson = await probe.json();
  assert.deepEqual(probeJson, { ok: false, needsBindConfirm: true });

  const confirmed = await signupPOST(
    jsonReq({ side: "agent", username: first.body.username, password: GOOD_PW, confirmBind: true })
  );
  assert.equal(confirmed.status, 200);
  const confirmedJson = await confirmed.json();
  assert.equal(confirmedJson.ok, true);
  assert.equal(confirmedJson.bound, true);
  assert.equal(confirmedJson.side, "agent");
  assert.equal("recoveryCodes" in confirmedJson, false, "NO codes minted on a side-bind");
  assert.equal(readDB().credentialUsers.length, usersBefore, "no new CredentialUser");
  const user = readDB().credentialUsers.find((u) => u.usernameLower === first.body.username.toLowerCase());
  assert.ok(user.agentId, "agent side now bound");

  // Wrong password on the bind arm ⇒ plain generic pw.errTaken.
  const second = await signupVia(); // another seaman-side account
  const wrong = await signupPOST(
    jsonReq({ side: "agent", username: second.body.username, password: "wrong password here", confirmBind: true })
  );
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).errorKey, "pw.errTaken");
});

// ---- Adoption at signup -------------------------------------------------------

test("adopt-at-signup: valid token binds the anon profile; Google-owned and credential-owned targets refused", async () => {
  freshBudgets();
  const anon = await mintAnonProfile();
  const adopted = await signupVia({ adoptToken: anon.token });
  assert.equal(adopted.res.status, 200);
  const user = readDB().credentialUsers.find((u) => u.username === adopted.json.username);
  assert.equal(user.seafarerId, anon.id, "bound the EXISTING anon profile — documents retained");
  assert.equal(readDB().seafarers.find((s) => s.id === anon.id).credentialUserId, user.id);

  // Google-owned target: refused, fresh profile minted instead.
  const googleOwned = await mintAnonProfile({ googleSub: "google-sub-x" });
  const g = await signupVia({ adoptToken: googleOwned.token });
  assert.equal(g.res.status, 200);
  const gUser = readDB().credentialUsers.find((u) => u.username === g.json.username);
  assert.notEqual(gUser.seafarerId, googleOwned.id, "Google-owned profile never adopted");
  assert.equal(readDB().seafarers.find((s) => s.id === googleOwned.id).credentialUserId ?? null, null);

  // Credential-owned target (the one adopted above): refused too.
  const c = await signupVia({ adoptToken: anon.token });
  assert.equal(c.res.status, 200);
  const cUser = readDB().credentialUsers.find((u) => u.username === c.json.username);
  assert.notEqual(cUser.seafarerId, anon.id, "credential-owned profile never re-adopted");
});

// ---- Invited vs walk-in bucket split (v5 fold 1) ------------------------------

test("invited signups (valid tokens) SKIP the per-IP bucket: 6 from one IP all pass", async () => {
  freshBudgets();
  const ip = nextIp();
  // 6 distinct valid claim tokens — one crew behind one ship-WiFi IP. The
  // walk-in cap is 5/h/IP, so if invited signups charged it, #6 would 429.
  for (let i = 0; i < 6; i++) {
    const anon = await mintAnonProfile();
    const { res, json } = await signupVia({ adoptToken: anon.token }, { ip });
    assert.equal(res.status, 200, `invited signup ${i + 1} must pass`);
    assert.equal(json.ok, true);
  }
  // And the walk-in budget for that IP is UNTOUCHED: a walk-in still passes.
  const walkIn = await signupVia({}, { ip });
  assert.equal(walkIn.res.status, 200, "walk-in budget was never charged by invited signups");
});

test("per-token invited bucket trips at the 4th charge; walk-in bucket unaffected; over-limit burns no scrypt", async () => {
  freshBudgets();
  const ip = nextIp();
  const anon = await mintAnonProfile();
  // Weak-password attempts: the invited bucket is charged BEFORE validation,
  // and the token stays adoptable (nothing is created), so ONE token absorbs
  // repeated charges — 3/h/token (cap 3), the 4th ⇒ 429.
  for (let i = 0; i < 3; i++) {
    const r = await signupPOST(
      jsonReq({ side: "seaman", username: uniqueName(), password: "short", adoptToken: anon.token }, { ip })
    );
    assert.equal(r.status, 400);
    assert.equal((await r.json()).errorKey, "pw.errWeak");
  }
  const opsBefore = _scryptOpCount();
  const fourth = await signupPOST(
    jsonReq({ side: "seaman", username: uniqueName(), password: GOOD_PW, adoptToken: anon.token }, { ip })
  );
  assert.equal(fourth.status, 429);
  assert.equal((await fourth.json()).errorKey, "pw.errRate");
  assert.equal(_scryptOpCount() - opsBefore, 0, "token validity check + over-limit burn NO scrypt");
  // The IP's walk-in budget is untouched by any of the invited charges.
  const walkIn = await signupVia({}, { ip });
  assert.equal(walkIn.res.status, 200);
});

test("INVALID adoptToken falls back to the per-IP walk-in bucket (no bypass via token guessing)", async () => {
  freshBudgets();
  const ip = nextIp();
  // 5 walk-in charges (weak password keeps them cheap; the bucket is charged
  // before validation), all carrying a GUESSED token — no special treatment.
  for (let i = 0; i < 5; i++) {
    const r = await signupPOST(
      jsonReq(
        { side: "seaman", username: uniqueName(), password: "short", adoptToken: `guess-${i}` },
        { ip }
      )
    );
    assert.equal(r.status, 400);
  }
  const sixth = await signupPOST(
    jsonReq({ side: "seaman", username: uniqueName(), password: GOOD_PW, adoptToken: "guess-6" }, { ip })
  );
  assert.equal(sixth.status, 429, "guessed tokens never escape the IP bucket");
});

// ---- Walk-in 429 + RATE_LIMITED aggregation -----------------------------------

test("walk-in per-IP cap: 6th signup from one IP ⇒ 429; flood stays BOUNDED aggregate lines", async () => {
  freshBudgets();
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    const r = await signupPOST(jsonReq({ side: "seaman", username: uniqueName(), password: "short" }, { ip }));
    assert.equal(r.status, 400); // charged, then failed validation — cheap charges
  }
  const linesBefore = authEvents().filter((e) => e.type === "RATE_LIMITED").length;
  const N = 80;
  for (let i = 0; i < N; i++) {
    const r = await signupPOST(jsonReq({ side: "seaman", username: uniqueName(), password: GOOD_PW }, { ip }));
    assert.equal(r.status, 429);
  }
  await _flushRateLimitedAggregates();
  const fresh = authEvents().filter((e) => e.type === "RATE_LIMITED").slice(linesBefore);
  assert.ok(fresh.length >= 1, "aggregate line exists");
  assert.ok(fresh.length <= 3, `bounded per bucket per window, got ${fresh.length} lines for ${N} floods`);
  const signupAgg = fresh.filter((e) => e.bucket === "auth-signup");
  assert.ok(signupAgg.reduce((n, e) => n + e.count, 0) >= N, "aggregates carry the full count");
});

// ---- Recovery-reset route ------------------------------------------------------

test("recovery-reset: success carries remainingCodes; ANY failure is the ONE generic pw.errRecovery", async () => {
  freshBudgets();
  const { body, json } = await signupVia();
  const username = body.username;

  // Wrong code ⇒ generic.
  const wrong = await recoveryPOST(
    jsonReq({ identifier: username, code: "AAAAAAAA23", newPassword: "brand new password" })
  );
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { ok: false, errorKey: "pw.errRecovery" });

  // Unknown identifier ⇒ the SAME generic (no oracle).
  freshBudgets();
  const unknown = await recoveryPOST(
    jsonReq({ identifier: "no-such-user-xyz", code: "AAAAAAAA23", newPassword: "brand new password" })
  );
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { ok: false, errorKey: "pw.errRecovery" });

  // Malformed body ⇒ the SAME generic.
  const malformed = await recoveryPOST(jsonReq({ nonsense: true }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, errorKey: "pw.errRecovery" });

  // Real code (typed messy — server-side D7 normalization) ⇒ ok + remainingCodes.
  freshBudgets();
  const messy = (json.recoveryCodes[0].slice(0, 5) + "-" + json.recoveryCodes[0].slice(5)).toLowerCase();
  const reset = await recoveryPOST(
    jsonReq({ identifier: username, code: messy, newPassword: "brand new password" })
  );
  assert.equal(reset.status, 200);
  const resetJson = await reset.json();
  assert.equal(resetJson.ok, true);
  assert.equal(resetJson.remainingCodes, 7);

  // The new password signs in; the old one fails generic.
  freshBudgets();
  const principal = await authorizeCredentials(
    { identifier: username, password: "brand new password", side: "seaman" },
    { headers: new Headers({ "x-registry-test-ip": nextIp() }) }
  );
  assert.ok(principal, "new password works");
  const old = await authorizeCredentials(
    { identifier: username, password: GOOD_PW, side: "seaman" },
    { headers: new Headers({ "x-registry-test-ip": nextIp() }) }
  );
  assert.equal(old, null, "old password dead");

  // Reusing the consumed code fails generic.
  freshBudgets();
  const reuse = await recoveryPOST(
    jsonReq({ identifier: username, code: json.recoveryCodes[0], newPassword: "yet another password" })
  );
  assert.equal(reuse.status, 400);
  assert.deepEqual(await reuse.json(), { ok: false, errorKey: "pw.errRecovery" });
});

test("recovery-reset: over-limit collapses into the SAME generic failure (no rate oracle on this route)", async () => {
  freshBudgets();
  const { body } = await signupVia();
  // Exhaust the per-identifier recovery bucket (3/h) with wrong codes...
  for (let i = 0; i < 3; i++) {
    const r = await recoveryPOST(
      jsonReq({ identifier: body.username, code: "AAAAAAAA23", newPassword: "whatever new pass" })
    );
    assert.equal(r.status, 400);
  }
  // ...the 4th is over-limit and reads EXACTLY like any other failure.
  const opsBefore = _scryptOpCount();
  const fourth = await recoveryPOST(
    jsonReq({ identifier: body.username, code: "AAAAAAAA23", newPassword: "whatever new pass" })
  );
  assert.equal(fourth.status, 400);
  assert.deepEqual(await fourth.json(), { ok: false, errorKey: "pw.errRecovery" });
  assert.equal(_scryptOpCount() - opsBefore, 0, "over-limit burns no scrypt");
});
