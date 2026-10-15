// feat/password-signup — Step 14 admin rescue (D13), plan Step 10
// "admin-rescue" rows:
//
//   - rescue unbinds BOTH pointers (seafarer.credentialUserId ↔
//     credentialUser.seafarerId) and rotates EVERY share token (old claim
//     links dead) in ONE transact, emitting PROFILE_BIND via "admin-rescue"
//     (ids only) through the transact collector;
//   - the old credential can no longer reach the profile: a dual-role account
//     keeps its agent side, plain seaman sign-in fails generic (D2 — the side
//     is now never-bound), and the STALE pre-rescue seaman JWT fails the
//     Step 5 gate;
//   - the NEW claim link adopts cleanly via the existing Step 2 adopt path
//     (password signup with the fresh token binds the SAME profile, documents
//     retained);
//   - orphan scrub (GDPR): a fully-orphaned CredentialUser is DELETED,
//     emailUnverified scrubbed from the store, usernameLower freed
//     (re-registration succeeds); a dual-role CredentialUser is NOT deleted;
//   - ownership-shape guard (v6 fold 2): a co-owned row (googleSub AND
//     credentialUserId; ownerEmail variant too) ⇒ rescue REFUSED, nothing
//     unbound, NO token rotation, no audit event;
//   - identity anchor, integration (v6 fold 1) — via the REAL rescue path this
//     time (rescueCredentialProfile, not direct db mutation): rescue → an
//     OLDER account re-adopts via the fresh claim link → the pre-rescue JWT
//     resolves to null even though the bare pwdAt staleness compare passes;
//   - route wiring pins: adminSession() gates the verb BEFORE any work
//     (non-admin ⇒ denied with no audit line), the acting admin identity comes
//     from the SESSION, and recordAdminAction is awaited AFTER the transact
//     resolves (v6 fold 5 — async audit can never run inside the sync
//     mutator). The auth-gated HTTP route itself is deliberately NOT imported
//     (it would need next-auth's live request scope — the
//     verify-upload-admin.test.mjs precedent); the behaviour lives in
//     lib/credential-auth.ts rescueCredentialProfile and is exercised
//     directly, with the route's ordering pinned at source level.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/admin-rescue.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.REGISTRY_MOCK = "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-admin-rescue-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { readDB, updateDB } = await import("@/lib/db");
const {
  createCredentialUser,
  authorizeCredentials,
  bindSideWithPassword,
  rescueCredentialProfile,
} = await import("@/lib/credential-auth");
const { _resetRateLimitedAggregates } = await import("@/lib/auth-rate-limit");
const { resetRegistryAbuseState } = await import("@/lib/registry");
const { jwtCallback, sessionCallback } = await import("@/auth");
const { credentialSeamanClaimValid } = await import("@/lib/seaman-session");
const { resolveCredentialAgentSession } = await import("@/lib/agent-session");

const AUTH_EVENTS_PATH = path.join(TMP, "data", "auth-events.ndjson");
const DB_PATH = path.join(TMP, "data", "db.json");

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
function ipHeaders() {
  return { headers: new Headers({ "x-registry-test-ip": `10.10.0.${(ipSeq++ % 250) + 1}` }) };
}

let userSeq = 0;
function uniqueName(prefix = "rescue") {
  return `${prefix}-${++userSeq}-${Date.now() % 100000}`;
}

const GOOD_PW = "correct horse battery";

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

// ---- the rescue transact ------------------------------------------------------

test("rescue unbinds both pointers, rotates EVERY claim token, PROFILE_BIND via admin-rescue (ids only)", async () => {
  freshBudgets();
  // Dual-role account (agent side bound too) so the CredentialUser row survives
  // and both halves of the unbind are observable.
  const su = await seamanSignup();
  const bind = await bindSideWithPassword({
    username: su.user.username,
    password: GOOD_PW,
    side: "agent",
    confirmBind: true,
  });
  assert.equal(bind.ok, true);
  const profileId = su.user.seafarerId;
  const before = readDB().seafarers.find((s) => s.id === profileId);
  const oldTokens = [before.shareToken, before.openShareToken, before.emailShareToken];

  const rescue = await rescueCredentialProfile(profileId);
  assert.equal(rescue.ok, true);
  assert.equal(rescue.credId, su.user.id);
  assert.equal(rescue.orphanDeleted, false, "dual-role account is NOT deleted");
  assert.equal(rescue.freedUsername, null);

  const db = readDB();
  const profile = db.seafarers.find((s) => s.id === profileId);
  const user = db.credentialUsers.find((u) => u.id === su.user.id);
  assert.ok(user, "dual-role CredentialUser row survives");
  assert.equal(profile.credentialUserId, null, "profile pointer cleared");
  assert.equal(user.seafarerId, null, "account pointer cleared");
  assert.ok(user.agentId, "agent binding survives");
  // Rotation: every old token is dead, the returned claim token is the new one.
  for (const t of oldTokens) {
    assert.equal([profile.shareToken, profile.openShareToken, profile.emailShareToken].includes(t), false);
  }
  assert.equal(rescue.claimToken, profile.shareToken, "response carries the fresh open claim token");

  // PROFILE_BIND via admin-rescue, ids only, in the same transact.
  const ev = authEvents().filter((e) => e.type === "PROFILE_BIND" && e.via === "admin-rescue");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].credId, su.user.id);
  assert.equal(ev[0].seafarerId, profileId);
  assert.equal("username" in ev[0], false);

  // ---- old credential can no longer reach the profile ----
  // Plain seaman sign-in: the side is now never-bound ⇒ generic null (D2).
  freshBudgets();
  const seamanTry = await authorizeCredentials(
    { identifier: su.user.username, password: GOOD_PW, side: "seaman" },
    ipHeaders()
  );
  assert.equal(seamanTry, null, "post-rescue plain seaman sign-in fails generic");
  // The agent side still works.
  const agentTry = await authorizeCredentials(
    { identifier: su.user.username, password: GOOD_PW, side: "agent" },
    ipHeaders()
  );
  assert.ok(agentTry, "dual-role account keeps its agent side");
  assert.ok(resolveCredentialAgentSession((await (async () => {
    const token = await jwtCallback({
      token: { name: agentTry.name, email: undefined, picture: undefined, sub: agentTry.id },
      user: agentTry,
      account: { providerAccountId: agentTry.id, type: "credentials", provider: "credentials" },
      profile: undefined,
    });
    return sessionCallback({
      session: { user: { name: token.name ?? null, email: token.email ?? null }, expires: "" },
      token,
    });
  })()), readDB()));
});

test("stale pre-rescue seaman JWT fails the Step 5 gate after the rescue", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const profileId = su.user.seafarerId;
  const pre = await credentialSession({ identifier: su.user.username, password: GOOD_PW, side: "seaman" });
  assert.equal(
    credentialSeamanClaimValid(pre.session, readDB().seafarers.find((s) => s.id === profileId), readDB()),
    true
  );
  const rescue = await rescueCredentialProfile(profileId);
  assert.equal(rescue.ok, true);
  assert.equal(
    credentialSeamanClaimValid(pre.session, readDB().seafarers.find((s) => s.id === profileId), readDB()),
    false,
    "pre-rescue JWT dead — the live Seafarer's credentialUserId is gone (fail closed)"
  );
});

test("the NEW claim link adopts cleanly: same profile, documents retained", async () => {
  freshBudgets();
  const su = await seamanSignup();
  const profileId = su.user.seafarerId;
  // A document on the profile — must survive the rescue + re-adoption.
  await updateDB((db) => {
    db.documents.push({
      id: "doc-rescue-1",
      seafarerId: profileId,
      title: "Basic Safety Training",
      docType: "certificate",
      source: "manual",
      isValid: true,
      validUntil: null,
      createdAt: new Date().toISOString(),
    });
  });

  const rescue = await rescueCredentialProfile(profileId);
  assert.equal(rescue.ok, true);

  // Password signup with the FRESH token binds the SAME profile (Step 2 adopt).
  const adopted = await createCredentialUser({
    side: "seaman",
    username: uniqueName("newowner"),
    password: "a brand new password",
    adoptToken: rescue.claimToken,
  });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.adoptedSeafarerId, profileId, "fresh claim link adopts the SAME profile");
  const db = readDB();
  assert.equal(db.seafarers.find((s) => s.id === profileId).credentialUserId, adopted.user.id);
  assert.equal(
    db.documents.some((d) => d.id === "doc-rescue-1" && d.seafarerId === profileId),
    true,
    "documents retained through rescue + re-adoption"
  );
});

test("orphan scrub: fully-orphaned account deleted, emailUnverified scrubbed, username freed", async () => {
  freshBudgets();
  const email = `scrub-${Date.now() % 100000}@example.org`;
  const su = await seamanSignup({ email });
  const username = su.user.username;
  assert.ok(JSON.stringify(readDB()).includes(email), "email in the store before the rescue");

  const rescue = await rescueCredentialProfile(su.user.seafarerId);
  assert.equal(rescue.ok, true);
  assert.equal(rescue.orphanDeleted, true, "no remaining binding ⇒ row deleted");
  assert.equal(rescue.freedUsername, username, "response names the freed username");

  const db = readDB();
  assert.equal(db.credentialUsers.some((u) => u.id === su.user.id), false, "row gone");
  assert.equal(JSON.stringify(db).includes(email), false, "emailUnverified scrubbed from the store");
  assert.equal(fs.readFileSync(DB_PATH, "utf-8").includes(email), false, "…and from the file on disk");

  // The usernameLower is free again: re-registration succeeds.
  freshBudgets();
  const again = await createCredentialUser({ side: "seaman", username, password: "a brand new password" });
  assert.equal(again.ok, true, "freed username re-registers cleanly");
});

// ---- ownership-shape guard (v6 fold 2) ----------------------------------------

test("co-owned rows are REFUSED: googleSub variant and ownerEmail variant — nothing unbound, no rotation, no event", async () => {
  freshBudgets();
  for (const patch of [{ googleSub: "google-sub-coowned" }, { ownerEmail: "coowner@example.org" }]) {
    const su = await seamanSignup();
    const profileId = su.user.seafarerId;
    await updateDB((db) => {
      Object.assign(db.seafarers.find((s) => s.id === profileId), patch);
    });
    const before = readDB().seafarers.find((s) => s.id === profileId);
    const eventsBefore = authEvents().filter((e) => e.via === "admin-rescue").length;

    const rescue = await rescueCredentialProfile(profileId);
    assert.deepEqual(rescue, { ok: false }, `co-owned (${Object.keys(patch)[0]}) refused — generic`);

    const after = readDB().seafarers.find((s) => s.id === profileId);
    assert.equal(after.credentialUserId, su.user.id, "nothing unbound");
    assert.equal(after.shareToken, before.shareToken, "no token rotation");
    assert.equal(
      readDB().credentialUsers.find((u) => u.id === su.user.id).seafarerId,
      profileId,
      "account pointer intact"
    );
    assert.equal(authEvents().filter((e) => e.via === "admin-rescue").length, eventsBefore, "no audit event");
  }

  // Not-rescuable shapes fail generic too: unowned profile, unknown id.
  const anonId = await updateDB((db) => {
    const anon = {
      id: "anon-rescue-x",
      name: "Anon",
      rank: "",
      state: "review",
      shareToken: "tok-rescue-x",
      openShareToken: "tok-rescue-x",
      emailShareToken: "tok-rescue-x-mail",
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    db.seafarers.push(anon);
    return anon.id;
  });
  assert.deepEqual(await rescueCredentialProfile(anonId), { ok: false }, "no credential owner ⇒ refused");
  assert.deepEqual(await rescueCredentialProfile("no-such-id"), { ok: false }, "unknown id ⇒ refused");
});

// ---- identity anchor via the REAL rescue path (v6 fold 1) ---------------------

test("rescue → OLDER account re-adopts via fresh link → pre-rescue JWT ⇒ seaman gate null (REAL rescue path)", async () => {
  freshBudgets();
  // OLD account (agent-side only, created "long ago" so its pwdAt predates the
  // victim token's claim).
  const oldName = uniqueName("oldacct");
  const old = await createCredentialUser({ side: "agent", username: oldName, password: GOOD_PW });
  assert.equal(old.ok, true);
  await updateDB((db) => {
    db.credentialUsers.find((u) => u.id === old.user.id).createdAt = "2020-01-01T00:00:00.000Z";
  });

  // Victim account owns profile P; capture its PRE-RESCUE session.
  const victim = await seamanSignup();
  const profileId = victim.user.seafarerId;
  const preRescue = await credentialSession({
    identifier: victim.user.username,
    password: GOOD_PW,
    side: "seaman",
  });
  assert.equal(
    credentialSeamanClaimValid(preRescue.session, readDB().seafarers.find((s) => s.id === profileId), readDB()),
    true
  );

  // The REAL Step 14 rescue (not a db-mutation simulation).
  const rescue = await rescueCredentialProfile(profileId);
  assert.equal(rescue.ok, true);

  // The OLDER account re-adopts P via the fresh claim link (sign-in adopt path).
  freshBudgets();
  const oldSession = await credentialSession({
    identifier: oldName,
    password: GOOD_PW,
    side: "seaman",
    adoptToken: rescue.claimToken,
  });
  assert.ok(oldSession, "older account adopted the rescued profile");
  assert.equal(oldSession.principal.seafarerId, profileId);

  const db = readDB();
  const profile = db.seafarers.find((s) => s.id === profileId);
  const owner = db.credentialUsers.find((u) => u.id === profile.credentialUserId);
  assert.equal(owner.id, old.user.id);
  // The BARE staleness compare would PASS for the stolen pre-rescue JWT...
  assert.equal(
    preRescue.session.pwdAt < (owner.passwordChangedAt ?? owner.createdAt),
    false,
    "bare pwdAt staleness alone would let the stolen JWT through"
  );
  // ...but the identity anchor rejects it, while the adopter's session passes.
  assert.equal(credentialSeamanClaimValid(preRescue.session, profile, db), false, "pre-rescue JWT rejected");
  assert.equal(credentialSeamanClaimValid(oldSession.session, profile, db), true);
});

// ---- route wiring pins ---------------------------------------------------------

test("route wiring pins: admin gate first (non-admin denied, no audit), session-derived identity, admin-audit AFTER the transact", () => {
  const src = fs.readFileSync(
    path.join(APP_ROOT, "app", "api", "admin", "credential-rescue", "route.ts"),
    "utf8"
  );
  // Gate order: adminSession() is awaited and denies BEFORE any body/db work —
  // a non-admin request never reaches the transact or any audit write.
  const gateAt = src.indexOf("await adminSession()");
  const denyAt = src.indexOf("if (!admin) return");
  const rescueAt = src.indexOf("rescueCredentialProfile(");
  const auditAt = src.indexOf("await recordAdminAction(");
  assert.ok(gateAt > 0, "adminSession() gate present");
  assert.ok(denyAt > gateAt, "denial right after the gate");
  assert.ok(denyAt < rescueAt, "non-admin denied BEFORE the rescue transact (no audit line)");
  // v6 fold 5: recordAdminAction is AWAITED and runs AFTER the transact resolves
  // (async audit can never run inside the synchronous transact mutator).
  assert.ok(rescueAt < auditAt, "recordAdminAction awaited AFTER the transact");
  // The rescue result gates the audit write: a refused rescue writes nothing.
  const refuseAt = src.indexOf("if (!rescue.ok)");
  assert.ok(refuseAt > rescueAt && refuseAt < auditAt, "refused rescue returns before the audit line");
  // Acting identity from the SESSION, never the body.
  assert.ok(src.includes("admin.user.email"), "acting admin e-mail comes from the session");
  assert.equal(src.includes("body.adminEmail"), false, "never from the request body");
  // The drill-down hides the button for the co-owned shape (fold 2 copy).
  const page = fs.readFileSync(
    path.join(APP_ROOT, "app", "admin", "seamen", "[id]", "page.tsx"),
    "utf8"
  );
  assert.ok(page.includes("Google-owned; recover via Google sign-in"), "co-owned shape shows the Google-recovery note");
  assert.ok(page.includes("CredentialRescueButton"), "rescue control rendered on the drill-down");
});
