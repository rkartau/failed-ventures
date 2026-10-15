// feat/password-signup — Steps 4/5 security-spine invariants (plan Step 10,
// "password-auth-invariants" rows mapped to waves 1–2):
//
//   - credential authorize/jwt path yields a token with NO email (D3), even
//     when emailUnverified is set — and set to an ADMIN address;
//   - emailUnverified ∈ ADMIN_EMAILS still yields adminSession() === null;
//   - evaluateShareAccess denies a credential session for emailShareToken mode
//     even when emailUnverified is on allowedEmails;
//   - agentSession resolves a credential agent by the agentId claim and never
//     via the e-mail path (a seeded Agent whose contact equals the credential
//     user's e-mail is NOT adopted); a credential session WITHOUT an agentId
//     claim ⇒ null, NOT the shared agent:unknown tenant (invariant 12);
//   - agent-gate owner lookup (r2 rev 5): agentId matching no credentialUsers
//     row ⇒ null; seaman-gate symmetry (v4): live seafarer with missing/
//     dangling credentialUserId ⇒ null;
//   - pwdAt fail-CLOSED (r2 rev 3): a password session with NO pwdAt claim is
//     rejected by BOTH gates — pinned against the real jwt-callback wiring
//     regression (user missing from the destructure ⇒ claims undefined ⇒ the
//     gates fail closed, and THIS test fails because the healthy path stops
//     resolving);
//   - session invalidation (invariant 11): a recovery-reset makes every
//     pre-reset token resolve to null in both gates; the agent-gate variant
//     builds its token through the REAL claim path (authorizeCredentials →
//     the ACTUAL exported jwtCallback wired into NextAuth — never a copy);
//   - seaman-gate IDENTITY ANCHOR, integration (v6 fold 1): rescue a
//     credential-owned profile (Step 14 simulated by direct db mutation — the
//     rescue route is a later wave), have an OLDER account re-adopt it via
//     the fresh claim link, then present the PRE-RESCUE JWT ⇒ rejected even
//     though the bare pwdAt staleness comparison passes;
//   - fresh credential agent ⇒ listSeafarersForAgent returns [] (default-deny);
//   - agent:p-* / agent:g-* namespaces disjoint by prefix (invariant 10);
//   - role scope (invariant 9): a seaman token carries no agentId, an agent
//     token no seafarerId.
//
// REAL next-auth@5.0.0-beta.31 VERIFICATION (plan revisions §12) — findings
// from the INSTALLED node_modules, recorded next to the simulated tests below:
//
//  (a) authorize-null error shape: @auth/core/lib/actions/callback/index.js
//      (credentials arm, ~line 236) does `if (!user) throw new
//      CredentialsSignin()` — an AuthError subclass with static
//      type "CredentialsSignin" and instance code "credentials". The client
//      `signIn("credentials", { redirect:false })` (next-auth/react.js)
//      fetches the callback URL and returns
//        { error: "CredentialsSignin", code: "credentials",
//          status: <fetch status>, ok: <res.ok>, url: null }
//      — NOTE: the fetch itself typically succeeds (the error rides the
//      redirect URL's ?error=&code= params), so the UI (wave 3) must detect
//      failure via `data.error != null`, NEVER via `ok`/`status`.
//  (b) string serialization: next-auth/react.js signIn() posts
//      `body: new URLSearchParams({ ...signInParams, csrfToken, callbackUrl })`
//      as application/x-www-form-urlencoded — EVERY credential value arrives
//      in authorize() as a string ("undefined"/"null" for absent values),
//      which is exactly what coerceCredentialValue defends against (Step 2).
//  (c) jwt-callback contract: the credentials arm builds
//      `defaultToken = { name: user.name, email: user.email, picture:
//      user.image, sub: user.id }` and calls `callbacks.jwt({ token:
//      defaultToken, user, account: { providerAccountId: user.id, type:
//      "credentials", provider: <id> }, isNewUser: false, trigger: "signIn" })`
//      — authorize()'s returned id lands in token.sub (the identity anchor's
//      ground truth), and `user` IS in the params (r2 revision 5). The
//      credentialSession() helper below mirrors this exactly, and a pin test
//      asserts the installed source still matches.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/password-auth-invariants.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.REGISTRY_MOCK = "1";
// The admin allowlist is env-driven; give the test a known admin address
// before anything imports lib/admin-session.
process.env.ADMIN_EMAILS ||= "admin@example.com";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-password-auth-inv-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { readDB, updateDB, newShareTokens } = await import("@/lib/db");
const {
  createCredentialUser,
  authorizeCredentials,
  resetPasswordWithRecoveryCode,
  credentialAgentId,
} = await import("@/lib/credential-auth");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { _resetRateLimitedAggregates } = await import("@/lib/auth-rate-limit");
// The REAL callbacks wired into NextAuth (auth.ts exports the very functions
// the config uses — pinned by the source-integrity test below).
const { jwtCallback, sessionCallback } = await import("@/auth");
const { resolveCredentialAgentSession } = await import("@/lib/agent-session");
const { credentialSeamanClaimValid } = await import("@/lib/seaman-session");
const { ADMIN_EMAILS } = await import("@/lib/admin-session");
const { listSeafarersForAgent } = await import("@/lib/agentData");
const { CredentialsSignin } = await import("next-auth");

// ---- helpers ---------------------------------------------------------------

function freshBudgets() {
  resetRegistryAbuseState();
  _resetRateLimitedAggregates();
}

let ipSeq = 0;
function ipHeaders() {
  return { headers: new Headers({ "x-registry-test-ip": `10.8.0.${(ipSeq++ % 250) + 1}` }) };
}

let userSeq = 0;
function uniqueName(prefix = "invtester") {
  return `${prefix}-${++userSeq}-${Date.now() % 100000}`;
}

const GOOD_PW = "correct horse battery";

/**
 * THE REAL CLAIM PATH (r2 revision 5): authorizeCredentials → the ACTUAL
 * exported jwtCallback → the ACTUAL exported sessionCallback. The token/session
 * scaffolding mirrors the installed @auth/core credentials arm exactly (see
 * verification note (c) above + the node_modules pin test): defaultToken from
 * the returned principal with sub = principal.id, then session.user built from
 * the token. NO hand-built token objects — a Step 4 wiring regression (e.g.
 * dropping `user` from the jwt destructure) makes every claim undefined and
 * the healthy-path tests below fail loudly.
 */
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

async function agentSignup(overrides = {}) {
  const username = uniqueName("agency");
  const res = await createCredentialUser({ side: "agent", username, password: GOOD_PW, ...overrides });
  assert.equal(res.ok, true, `signup should pass: ${JSON.stringify(res)}`);
  return res;
}

// ---- Installed next-auth pins (verification notes (a)/(b)/(c) above) ---------

test("installed next-auth@5.0.0-beta.31: authorize-null throws CredentialsSignin (code 'credentials')", () => {
  const err = new CredentialsSignin();
  assert.ok(err instanceof Error);
  assert.equal(err.code, "credentials");
  assert.equal(CredentialsSignin.type, "CredentialsSignin");
  const core = fs.readFileSync(
    path.join(APP_ROOT, "node_modules", "@auth", "core", "lib", "actions", "callback", "index.js"),
    "utf8"
  );
  assert.ok(core.includes("throw new CredentialsSignin"), "authorize-null still throws CredentialsSignin");
  // Pin the jwt-callback contract the credentialSession() helper mirrors:
  assert.ok(core.includes("sub: user.id"), "authorize()'s id still lands in token.sub");
  assert.ok(core.includes("await provider.authorize(credentials"), "authorize still receives the raw body");
});

test("installed next-auth: signIn() string-serializes credential values (URLSearchParams body)", () => {
  const react = fs.readFileSync(path.join(APP_ROOT, "node_modules", "next-auth", "react.js"), "utf8");
  assert.ok(react.includes("body: new URLSearchParams({"), "client signIn posts URLSearchParams");
  // The mechanism itself: absent values become the STRINGS coerceCredentialValue drops.
  assert.equal(new URLSearchParams({ adoptToken: undefined }).get("adoptToken"), "undefined");
  assert.equal(new URLSearchParams({ adoptToken: null }).get("adoptToken"), "null");
});

test("auth.ts wires the EXPORTED callbacks (the tested functions ARE production)", () => {
  const src = fs.readFileSync(path.join(APP_ROOT, "auth.ts"), "utf8");
  assert.ok(src.includes("jwt: (params) => jwtCallback(params)"), "config uses the exported jwtCallback");
  assert.ok(
    src.includes("session: ({ session, token }) => sessionCallback({ session, token })"),
    "config uses the exported sessionCallback"
  );
  assert.ok(src.includes('account.provider === "credentials"'), "credentials-first branch present");
  assert.ok(src.includes("delete token.email"), "D3 belt-and-braces present");
});

// ---- D3: no e-mail on token/session; role scope (inv. 9) ---------------------

const adminEmail = [...ADMIN_EMAILS][0];

test("credential jwt path: NO email on token or session — even when emailUnverified is an ADMIN address", async () => {
  freshBudgets();
  const su = await seamanSignup({ email: adminEmail });
  assert.equal(su.user.emailUnverified, adminEmail, "the admin address IS on the account");
  const out = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  assert.ok(out);
  const { token, session } = out;
  assert.equal("email" in token, false, "token.email deleted (D3)");
  assert.equal(session.user.email, null, "session.user.email null");
  assert.equal(token.role, "seaman");
  assert.equal(token.authMethod, "password");
  assert.equal(token.pwdAt, su.user.createdAt);
  assert.equal(token.sub, su.user.id, "authorize()'s id is the token identity");
  assert.equal(session.credentialSub, su.user.id);
  // Role scope (invariant 9): a seaman token carries NO agentId...
  assert.equal(token.agentId, undefined);
  assert.equal(session.agentId, undefined);

  const au = await agentSignup();
  const aOut = await credentialSession({ identifier: au.user.username, password: GOOD_PW, side: "agent" });
  assert.ok(aOut);
  // ...and an agent token NO seafarerId.
  assert.equal(aOut.token.seafarerId, undefined);
  assert.equal(aOut.session.seafarerId, undefined);
  assert.equal(aOut.token.agentId, au.user.agentId);
  assert.match(aOut.token.agentId, /^agent:p-[0-9a-f]{16}$/);
});

test("emailUnverified ∈ ADMIN_EMAILS ⇒ adminSession() === null (mirror + source integrity)", async () => {
  freshBudgets();
  const su = await seamanSignup({ email: adminEmail });
  const out = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  // adminSession() gate mirror (lib/admin-session.ts — the admin-session.test.mjs
  // precedent; integrity below pins the mirror against drift):
  const adminGate = (s) => {
    const email = (s?.user?.email ?? "").trim().toLowerCase();
    return s?.user && email && ADMIN_EMAILS.has(email) ? { user: s.user } : null;
  };
  assert.equal(adminGate(out.session), null, "no session e-mail ⇒ password accounts can never be admin");
  // Sanity: the same gate WOULD pass for a verified Google admin session.
  assert.ok(adminGate({ user: { email: adminEmail } }));
  const src = fs.readFileSync(path.join(APP_ROOT, "lib", "admin-session.ts"), "utf8");
  assert.ok(src.includes('(s?.user?.email ?? "").trim().toLowerCase()'), "gate keys on the session e-mail");
  assert.ok(src.includes("ADMIN_EMAILS.has(email)"), "allowlist check present");
});

test("evaluateShareAccess denies a credential session in email mode even when emailUnverified ∈ allowedEmails", async () => {
  freshBudgets();
  const email = `share-${Date.now() % 100000}@example.org`;
  const su = await seamanSignup({ email });
  const out = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  // evaluateShareAccess (lib/share-access.ts:95–110) keys PURELY on
  // session.user.email — mirror of its email-mode gate (the function itself
  // calls next-auth's auth(), which needs a live request scope; source
  // integrity below pins the mirrored expression):
  const seafarer = { allowedEmails: [email] };
  const viewerEmail = out.session?.user?.email ? out.session.user.email.trim().toLowerCase() : null;
  assert.equal(viewerEmail, null, "credential session has no viewer e-mail");
  const gate = !viewerEmail
    ? { allowed: false, reason: "need-signin" }
    : seafarer.allowedEmails.includes(viewerEmail)
      ? { allowed: true }
      : { allowed: false, reason: "not-allowed" };
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "need-signin", "fail-closed: unverified e-mails never satisfy the private-link gate");
  const src = fs.readFileSync(path.join(APP_ROOT, "lib", "share-access.ts"), "utf8");
  assert.ok(src.includes("session?.user?.email"), "gate keys on the session e-mail");
  assert.ok(src.includes('"need-signin"'), "no-email sessions fail closed to need-signin");
});

// ---- Agent gate (Step 5) -----------------------------------------------------

test("agent gate: resolves by agentId claim, NEVER the e-mail path — seeded contact-email Agent not adopted", async () => {
  freshBudgets();
  const email = `agency-${Date.now() % 100000}@example.org`;
  const au = await agentSignup({ email });
  // A seeded/legacy Agent row whose contact IS that e-mail — the pre-existing
  // agent-account.ts case-3 adoption target (tenant-takeover hazard).
  await updateDB((db) => {
    db.agents.push({
      id: "agent:seeded-contact",
      orgName: "Seeded Agency",
      contact: email,
      createdAt: new Date().toISOString(),
      googleEmail: null,
      googleSub: null,
    });
  });
  const out = await credentialSession({ identifier: au.user.username, password: GOOD_PW, side: "agent" });
  assert.ok(out);
  const resolved = resolveCredentialAgentSession(out.session, readDB());
  assert.ok(resolved);
  assert.equal(resolved.agentId, au.user.agentId, "lands on its OWN agent:p-* tenant");
  assert.equal(resolved.user.email, null, "resolved session carries no e-mail");
  const seeded = readDB().agents.find((a) => a.id === "agent:seeded-contact");
  assert.equal(seeded.googleEmail, null, "seeded row untouched — never e-mail-adopted");
  // Source integrity: the credential branch returns BEFORE the e-mail
  // resolution block and its shared agent:unknown fallback.
  const src = fs.readFileSync(path.join(APP_ROOT, "lib", "agent-session.ts"), "utf8");
  const branchAt = src.indexOf('if (s?.authMethod === "password" && s.role !== "seaman")');
  assert.ok(branchAt > 0, "credential branch present in agentSession");
  assert.ok(branchAt < src.indexOf("findOrCreateAgentByGoogle({"), "credential branch precedes e-mail resolution");
  assert.ok(branchAt < src.indexOf('agentId: "agent:unknown"'), "credential branch precedes agent:unknown");
});

test("agent gate fail-closed: no agentId claim ⇒ null (NOT agent:unknown); unknown owner ⇒ null; dead tenant ⇒ null", async () => {
  freshBudgets();
  const au = await agentSignup();
  const out = await credentialSession({ identifier: au.user.username, password: GOOD_PW, side: "agent" });
  const db = readDB();
  // Missing agentId claim (invariant 12): null — never the shared tenant.
  assert.equal(resolveCredentialAgentSession({ ...out.session, agentId: undefined }, db), null);
  // agentId that matches NO credentialUsers row (r2 rev 5): fail closed even
  // though an Agent row with that id exists.
  await updateDB((d) => {
    d.agents.push({
      id: "agent:p-0000000000000000",
      orgName: "Orphan",
      contact: "orphan",
      createdAt: new Date().toISOString(),
      googleEmail: null,
      googleSub: null,
    });
  });
  assert.equal(
    resolveCredentialAgentSession({ ...out.session, agentId: "agent:p-0000000000000000" }, readDB()),
    null,
    "no owning CredentialUser ⇒ null (staleness never skipped)"
  );
  // agentId whose Agent ROW is gone: fail closed.
  assert.equal(
    resolveCredentialAgentSession({ ...out.session, agentId: credentialAgentId("cred:never-existed") }, db),
    null
  );
});

test("jwt wiring regression simulation: user missing from the callback ⇒ claims undefined ⇒ both gates fail closed", async () => {
  freshBudgets();
  // What the token looks like if Step 4's `user` destructure were dropped:
  // the credentials branch still runs (account.provider matches) but every
  // claim read off `user` is undefined.
  const token = await jwtCallback({
    token: { name: "ghost", email: undefined, picture: undefined, sub: "cred:ghost" },
    user: undefined,
    account: { providerAccountId: "cred:ghost", type: "credentials", provider: "credentials" },
    profile: undefined,
  });
  assert.equal(token.authMethod, "password");
  assert.equal(token.pwdAt, undefined);
  const session = await sessionCallback({
    session: { user: { name: "ghost", email: null }, expires: "" },
    token,
  });
  // pwdAt fail-CLOSED (r2 revision 3) pins both gates shut:
  assert.equal(resolveCredentialAgentSession(session, readDB()), null);
  const anySeafarer = readDB().seafarers[0];
  assert.ok(anySeafarer);
  assert.equal(credentialSeamanClaimValid(session, anySeafarer, readDB()), false);
});

// ---- pwdAt fail-closed + session invalidation (invariant 11) -----------------

test("pwdAt fail-closed: a password session with NO pwdAt claim ⇒ null in BOTH gates", async () => {
  freshBudgets();
  const au = await agentSignup();
  const aOut = await credentialSession({ identifier: au.user.username, password: GOOD_PW, side: "agent" });
  const stripped = { ...aOut.session };
  delete stripped.pwdAt;
  assert.equal(resolveCredentialAgentSession(stripped, readDB()), null, "agent gate fails closed");

  const su = await seamanSignup();
  const sOut = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  const seafarer = readDB().seafarers.find((x) => x.id === sOut.principal.seafarerId);
  const sStripped = { ...sOut.session };
  delete sStripped.pwdAt;
  assert.equal(credentialSeamanClaimValid(sStripped, seafarer, readDB()), false, "seaman gate fails closed");
  // Healthy sessions DO pass (the fail-closed rule isn't a fail-everything rule).
  assert.ok(resolveCredentialAgentSession(aOut.session, readDB()));
  assert.equal(credentialSeamanClaimValid(sOut.session, seafarer, readDB()), true);
});

test("invariant 11 (agent gate, REAL claim path): recovery-reset kills every pre-reset token; re-issued token passes", async () => {
  freshBudgets();
  const au = await agentSignup();
  const preReset = await credentialSession({ identifier: au.user.username, password: GOOD_PW, side: "agent" });
  assert.ok(resolveCredentialAgentSession(preReset.session, readDB()), "pre-reset token valid before the reset");

  const reset = await resetPasswordWithRecoveryCode({
    identifier: au.user.username,
    code: au.recoveryCodes[0],
    newPassword: "a brand new password",
  });
  assert.equal(reset.ok, true);

  assert.equal(
    resolveCredentialAgentSession(preReset.session, readDB()),
    null,
    "pre-reset 30-day JWT is dead (pwdAt < passwordChangedAt)"
  );
  freshBudgets();
  const postReset = await credentialSession({
    identifier: au.user.username,
    password: "a brand new password",
    side: "agent",
  });
  assert.ok(postReset);
  assert.ok(resolveCredentialAgentSession(postReset.session, readDB()), "fresh token passes");
});

test("invariant 11 (seaman gate): recovery-reset invalidates pre-reset tokens; owner-lookup fail-closed (v4 symmetry)", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const preReset = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  const seafarer = () => readDB().seafarers.find((x) => x.id === su.user.seafarerId);
  assert.equal(credentialSeamanClaimValid(preReset.session, seafarer(), readDB()), true);

  const reset = await resetPasswordWithRecoveryCode({
    identifier: su.user.username,
    code: su.recoveryCodes[0],
    newPassword: "a brand new password",
  });
  assert.equal(reset.ok, true);
  assert.equal(credentialSeamanClaimValid(preReset.session, seafarer(), readDB()), false, "stale token dead");

  freshBudgets();
  const postReset = await credentialSession({
    identifier: su.user.username,
    password: "a brand new password",
    side: "seaman",
  });
  assert.equal(credentialSeamanClaimValid(postReset.session, seafarer(), readDB()), true);

  // v4 symmetry — owner missing/dangling on a LIVE seafarer ⇒ fail closed:
  await updateDB((db) => {
    db.seafarers.find((x) => x.id === su.user.seafarerId).credentialUserId = "cred:does-not-exist";
  });
  assert.equal(credentialSeamanClaimValid(postReset.session, seafarer(), readDB()), false, "dangling owner");
  await updateDB((db) => {
    db.seafarers.find((x) => x.id === su.user.seafarerId).credentialUserId = null;
  });
  assert.equal(credentialSeamanClaimValid(postReset.session, seafarer(), readDB()), false, "missing owner");
});

// ---- Identity anchor, integration (v6 fold 1) --------------------------------

test("identity anchor: rescue → OLDER account re-adopts → pre-rescue JWT rejected though bare staleness passes", async () => {
  freshBudgets();
  // OLD account (agent-side only — its seaman side is free to adopt), with a
  // createdAt far in the past so its pwdAt PREDATES the victim token's.
  const old = await agentSignup();
  await updateDB((db) => {
    db.credentialUsers.find((u) => u.id === old.user.id).createdAt = "2020-01-01T00:00:00.000Z";
  });

  // Victim account NEW owns profile P; capture its PRE-RESCUE session.
  const nu = await seamanSignup();
  const profileId = nu.user.seafarerId;
  const preRescue = await credentialSession({ identifier: nu.user.username, password: GOOD_PW, side: "seaman" });
  assert.equal(
    credentialSeamanClaimValid(preRescue.session, readDB().seafarers.find((x) => x.id === profileId), readDB()),
    true
  );

  // Step 14 admin rescue, simulated by direct db mutation (the rescue route is
  // a later wave): unbind both pointers + rotate the claim tokens.
  const freshToken = await updateDB((db) => {
    const p = db.seafarers.find((x) => x.id === profileId);
    p.credentialUserId = null;
    db.credentialUsers.find((u) => u.id === nu.user.id).seafarerId = null;
    Object.assign(p, newShareTokens());
    return p.shareToken;
  });

  // The OLDER account re-adopts P via the fresh claim link (sign-in adopt path).
  freshBudgets();
  const oldSession = await credentialSession({
    identifier: old.user.username,
    password: GOOD_PW,
    side: "seaman",
    adoptToken: freshToken,
  });
  assert.ok(oldSession, "older account adopted the rescued profile");
  assert.equal(oldSession.principal.seafarerId, profileId);
  const db = readDB();
  const profile = db.seafarers.find((x) => x.id === profileId);
  assert.equal(profile.credentialUserId, old.user.id);

  // The BARE pwdAt staleness comparison would PASS for the stolen pre-rescue
  // JWT (the old owner's pwdAt predates the thief's claim)...
  const owner = db.credentialUsers.find((u) => u.id === profile.credentialUserId);
  const ownerPwdAt = owner.passwordChangedAt ?? owner.createdAt;
  assert.equal(preRescue.session.pwdAt < ownerPwdAt, false, "bare staleness check alone would let it through");
  // ...but the identity anchor (owner.id !== token.sub) rejects it:
  assert.equal(credentialSeamanClaimValid(preRescue.session, profile, db), false, "pre-rescue JWT rejected");
  // while the adopting account's own session passes:
  assert.equal(credentialSeamanClaimValid(oldSession.session, profile, db), true);
});

// ---- Default-deny + namespaces -----------------------------------------------

test("fresh credential agent sees an EMPTY board (default-deny, grant-scoped reads)", async () => {
  freshBudgets();
  const au = await agentSignup();
  assert.ok(readDB().seafarers.length > 0, "other seafarers exist in the store");
  assert.deepEqual(listSeafarersForAgent(au.user.agentId), [], "zero grants ⇒ zero readable seafarers");
});

test("agent:p-* / agent:g-* namespaces are disjoint by prefix (invariant 10)", () => {
  assert.match(credentialAgentId("cred:x"), /^agent:p-[0-9a-f]{16}$/);
  const src = fs.readFileSync(path.join(APP_ROOT, "lib", "agent-account.ts"), "utf8");
  assert.ok(src.includes("agent:g-"), "Google agents mint agent:g-* ids — p-/g- can never collide");
});
