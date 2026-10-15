// feat/password-signup Step 2 — core credential-auth lib: scrypt hashing,
// username/password validation (i18n error KEYS), recovery codes (Crockford,
// confusable-mapped), find-or-create, authorize, recovery reset, explicit
// side-bind.
//
// CONCURRENCY PATTERN (binding — security invariant 5): updateDB/transact
// mutators are SYNCHRONOUS (db.ts), so an async scrypt call can NEVER run
// inside the critical section. Every mutation here follows: async hashing/
// verification OUTSIDE the lock, compare-and-set INSIDE one `transact` that
// re-validates its own precondition on the freshly-read db (username still
// free; the binding still absent; the adopt target still unowned; the recovery
// code still unused), applies the mutation, and emits its audit event through
// the transact collector — event + mutation share one critical section. A
// precondition consumed between verify and CAS ⇒ fail generic.
//
// SECRETS: plaintext passwords/codes are hashed and dropped; hashes live ONLY
// in db.credentialUsers; the auth-events sink carries ids + sha256 prefixes +
// date-rotated ipHash only — never PII, never a secret, never an e-mail.
// A credential session/principal NEVER carries an e-mail (D3).

import crypto from "crypto";
import {
  readDB,
  transact,
  id,
  newShareTokens,
  AUDIT_NO_IMPERSONATION,
  type DB,
  type Seafarer,
  type Agent,
  type CredentialUser,
  type RecoveryCode,
  type ScryptHash,
} from "@/lib/db";
import {
  consumeAuthBudget,
  clientIpFromHeaders,
  idHash16,
  authIpHash,
  appendAuthEvent,
} from "@/lib/auth-rate-limit";

export type CredentialSide = "seaman" | "agent";

// ---- Scrypt hashing (D8) ----------------------------------------------------
//
// Node built-in crypto.scrypt (no native-module deploy risk). Params stored
// per-record so they can be raised later without migration. N=16384, r=8, p=1,
// keylen=64 needs 128·N·r = 16 MiB < Node's default 32 MiB maxmem; each verify
// burns ~16 MiB + ~50–100 ms on the shared libuv pool — TOTAL work is bounded
// by the Step 3 rate buckets, and multi-hash callers (signup/regenerate) hash
// SEQUENTIALLY so the pool peak stays one 16 MiB slot per in-flight call.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// Test-only observability: how many scrypt operations (hash or verify) ran.
// Lets tests pin "exactly ONE dummy verify on identifier miss" (r2 revision 9)
// and "the invited-token validity check burns NO scrypt" without mocking.
let scryptOps = 0;
/** Test hook: total scrypt operations (hash + verify) since module load. */
export function _scryptOpCount(): number {
  return scryptOps;
}

function scryptAsync(plain: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  scryptOps++;
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      plain,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/** Hash a secret (password or recovery code) with fresh salt + current params. */
export async function hashSecret(plain: string): Promise<ScryptHash> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(plain, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
  });
  return {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
    saltB64: salt.toString("base64"),
    hashB64: derived.toString("base64"),
  };
}

/** Constant-time verify against a stored hash, honouring ITS stored params. */
export async function verifySecret(plain: string, stored: ScryptHash): Promise<boolean> {
  try {
    const salt = Buffer.from(stored.saltB64, "base64");
    const expected = Buffer.from(stored.hashB64, "base64");
    const derived = await scryptAsync(plain, salt, {
      N: stored.N,
      r: stored.r,
      p: stored.p,
      keylen: stored.keylen,
    });
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected); // pattern: verify-record.ts:86
  } catch {
    return false;
  }
}

// Static dummy hash for identifier misses: burn one indistinguishable scrypt
// verification so username-exists vs wrong-password is not timing-separable
// (invariant 6). Memoized promise — built once per process, off the hot path's
// critical section (there is none here; this is pre-lock work by design).
let dummyHashPromise: Promise<ScryptHash> | null = null;
function dummyHash(): Promise<ScryptHash> {
  return (dummyHashPromise ??= hashSecret("docka-dummy-" + crypto.randomBytes(8).toString("hex")));
}
async function burnDummyVerify(plain: string): Promise<void> {
  await verifySecret(plain, await dummyHash());
}

// ---- Username / password validation (D5) ------------------------------------
//
// Returns i18n error KEYS (never English text) — the pw.* group ships in Step 9.
// Unicode letters/digits are ALLOWED (CJK usernames are a Wei requirement); `@`
// is reserved so the login identifier field can disambiguate e-mail logins.

/** NFC-normalize + trim — the stored display form. */
export function normalizeUsername(input: string): string {
  return input.normalize("NFC").trim();
}

/** The UNIQUE key form: NFC + toLowerCase (D5). */
export function usernameKey(input: string): string {
  return normalizeUsername(input).toLowerCase();
}

const USERNAME_ALLOWED = /^[\p{L}\p{N}._-]+$/u;

/** Null when valid, else an i18n error key. */
export function validateUsername(input: string): string | null {
  const u = normalizeUsername(input);
  if (u.includes("@")) return "pw.errUserAt";
  const length = Array.from(u).length;
  if (length < 3 || length > 32) return "pw.errUserRules";
  if (/\s/u.test(u)) return "pw.errUserRules";
  if (!USERNAME_ALLOWED.test(u)) return "pw.errUserRules";
  return null;
}

/** Null when valid, else an i18n error key. Min 8, max 256, no composition rules. */
export function validatePassword(input: string): string | null {
  if (typeof input !== "string" || input.length < 8 || input.length > 256) return "pw.errWeak";
  return null;
}

// ---- Recovery codes (D7) ----------------------------------------------------
//
// 8 one-time codes, 10 chars each from Crockford's base32 alphabet
// (0123456789ABCDEFGHJKMNPQRSTVWXYZ — excludes the confusable glyphs I, L, O, U
// but keeps 0 and 1 so the confusable mapping lands on valid characters).
// Stored scrypt-hashed exactly like the password; shown in plaintext exactly
// once, in the signup (or Step 13 regenerate) response.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CODE_LEN = 10;
const RECOVERY_CODE_COUNT = 8;

/**
 * Server-side, authoritative input normalization (D7): trim, uppercase, strip
 * spaces and dashes, then the Crockford confusable map O→0, I→1, L→1, U→V —
 * a code typed lowercase, with spaces, or with a confused glyph still verifies.
 * (U→V because the alphabet excludes U but keeps V.)
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

function randomRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LEN; i++) code += CROCKFORD[crypto.randomInt(CROCKFORD.length)];
  return code;
}

/**
 * Mint 8 fresh codes. Hashing is SEQUENTIAL (one await at a time, never
 * Promise.all — D8): bounds the libuv-pool peak to ONE 16 MiB slot per
 * in-flight signup at the cost of ~0.5–1 s latency, accepted at signup time.
 */
export async function generateRecoveryCodes(): Promise<{ plain: string[]; hashed: RecoveryCode[] }> {
  const plain: string[] = [];
  const hashed: RecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = randomRecoveryCode();
    plain.push(code);
    hashed.push({ hash: await hashSecret(code), usedAt: null }); // sequential by design
  }
  return { plain, hashed };
}

// ---- Shared helpers ---------------------------------------------------------

/** next-auth signIn() serializes credential values to strings — coerce defensively. */
export function coerceCredentialValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s === "null" || s === "undefined") return null;
  return s;
}

/** D4 — deterministic credential-agent id: agent:p- + first 16 hex of sha256(credId). */
export function credentialAgentId(credentialUserId: string): string {
  const h = crypto.createHash("sha256").update(credentialUserId).digest("hex").slice(0, 16);
  return `agent:p-${h}`;
}

/**
 * The one adopt guard (invariant 7): share-token match on a profile with NO owner
 * of any kind. Public Sample Profiles: a sample row is additionally NEVER
 * adoptable (its open token is published on indexable pages) — rejecting here
 * fixes signup at the root, since findAdoptableProfileByToken feeds /api/signup.
 */
function adoptableByToken(db: DB, token: string): Seafarer | undefined {
  return db.seafarers.find(
    (s) =>
      s.shareToken === token &&
      !s.googleSub &&
      !s.ownerEmail &&
      !s.credentialUserId &&
      !s.isSample
  );
}

/**
 * PURE token lookup for the Step 6 invited-signup bucket split (v5 fold 1):
 * does this adoptToken resolve to an unowned, adoptable profile? Burns NO
 * scrypt and mutates nothing — safe to call before any bucket decision.
 */
export function findAdoptableProfileByToken(db: DB, adoptToken: string | null | undefined): Seafarer | null {
  const token = coerceCredentialValue(adoptToken);
  if (!token) return null;
  return adoptableByToken(db, token) ?? null;
}

/** Fresh, EMPTY credential-owned Seafarer (mirrors seaman-account.ts case 4). */
function mintCredentialSeafarer(displayName: string, credentialUserId: string): Seafarer {
  return {
    id: id(),
    name: displayName || "My profile",
    rank: "",
    state: "review",
    ...newShareTokens(),
    createdAt: new Date().toISOString(),
    googleSub: null,
    ownerEmail: null, // an unverified e-mail must NEVER land here (invariant 2)
    credentialUserId,
  };
}

/**
 * Mint the credential-agent tenant row (D4). `contact` is the username —
 * display only: agent-account.ts case 3 only adopts when contact isEmail(),
 * and usernames can't contain `@` (D5), so a credential-agent row can never
 * be e-mail-adopted later.
 */
function mintCredentialAgent(agentId: string, username: string): Agent {
  return {
    id: agentId,
    orgName: username || "Agent",
    contact: username,
    createdAt: new Date().toISOString(),
    googleEmail: null,
    googleSub: null,
  };
}

function pwdAtOf(user: CredentialUser): string {
  return user.passwordChangedAt ?? user.createdAt;
}

function resolveByIdentifier(db: DB, identifier: string): CredentialUser | null {
  const idLower = identifier.normalize("NFC").trim().toLowerCase();
  const byUsername = db.credentialUsers.find((u) => u.usernameLower === idLower);
  if (byUsername) return byUsername;
  // E-mail identifier (D6): only when it contains `@` AND matches exactly one
  // CredentialUser; ambiguous ⇒ generic miss (accepted squatting side-effect, R9).
  if (idLower.includes("@")) {
    const matches = db.credentialUsers.filter((u) => (u.emailUnverified ?? "") === idLower);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

// ---- createCredentialUser (signup) ------------------------------------------

export type CreateCredentialUserInput = {
  side: CredentialSide;
  username: string;
  password: string;
  /** Optional UNVERIFIED contact e-mail — stored lower-cased on the CredentialUser ONLY (D6). */
  email?: string | null;
  /** Claim/adopt token (seaman side) — adopts an unowned anon profile instead of forking. */
  adoptToken?: string | null;
  /** Raw client IP (route-derived) — hashed before it touches the sink. */
  clientIp?: string | null;
  /**
   * Outreach attribution (Increment 5): a send_key ALREADY verified by the
   * route (HMAC CTA token + ^LD\d{1,15}$). When present, the created user is
   * stamped leadKey + source:"outreach" (additive telemetry, never auth-read).
   */
  leadKey?: string | null;
};

export type CreateCredentialUserResult =
  | {
      ok: true;
      user: CredentialUser;
      /** The ONLY time the codes exist in plaintext. */
      recoveryCodes: string[];
      /** Set when the seaman side adopted an existing anon profile. */
      adoptedSeafarerId: string | null;
    }
  | { ok: false; errorKey: string };

/**
 * Signup: hash password + 8 recovery codes with async scrypt BEFORE the
 * section, SEQUENTIALLY (D8); then ONE transact that re-checks usernameLower
 * uniqueness (CAS — typed "taken" on a lost race), inserts the CredentialUser,
 * binds the requested side (adopt iff the token resolves an unowned profile,
 * else fresh mint), and emits SIGNUP + PROFILE_BIND through the collector.
 * Rate buckets are the ROUTE's job (Step 6 — the invited-token split needs a
 * pure lookup before any bucket choice); this lib never charges signup buckets.
 */
export async function createCredentialUser(
  input: CreateCredentialUserInput
): Promise<CreateCredentialUserResult> {
  const usernameErr = validateUsername(input.username);
  if (usernameErr) return { ok: false, errorKey: usernameErr };
  const passwordErr = validatePassword(input.password);
  if (passwordErr) return { ok: false, errorKey: passwordErr };

  const username = normalizeUsername(input.username);
  const usernameLower = usernameKey(input.username);
  const email = coerceCredentialValue(input.email)?.toLowerCase() ?? null;
  const adoptToken = coerceCredentialValue(input.adoptToken);
  const ipHash = input.clientIp ? authIpHash(input.clientIp) : undefined;

  // Expensive async work OUTSIDE the lock — sequential (D8).
  const passwordHash = await hashSecret(input.password);
  const codes = await generateRecoveryCodes();

  return transact<CreateCredentialUserResult>((db, audit) => {
    // CAS: username still free? (Two racing signups ⇒ exactly one row.)
    if (db.credentialUsers.some((u) => u.usernameLower === usernameLower)) {
      return { ok: false, errorKey: "pw.errTaken" };
    }
    const nowIso = new Date().toISOString();
    const user: CredentialUser = {
      id: "cred:" + id(),
      username,
      usernameLower,
      password: passwordHash,
      emailUnverified: email,
      seafarerId: null,
      agentId: null,
      recoveryCodes: codes.hashed,
      createdAt: nowIso,
      passwordChangedAt: null,
      // Outreach attribution (Increment 5) — both keys or neither.
      ...(input.leadKey ? { leadKey: input.leadKey, source: "outreach" as const } : {}),
    };

    let adoptedSeafarerId: string | null = null;
    if (input.side === "seaman") {
      const anon = adoptToken ? adoptableByToken(db, adoptToken) : undefined;
      if (anon) {
        // Adopt: stamp credentialUserId, do NOT touch ownerEmail (invariant 2).
        anon.credentialUserId = user.id;
        user.seafarerId = anon.id;
        adoptedSeafarerId = anon.id;
      } else {
        const fresh = mintCredentialSeafarer(username, user.id);
        db.seafarers.push(fresh);
        user.seafarerId = fresh.id;
      }
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: user.id,
        seafarerId: user.seafarerId,
        via: anon ? "signup-adopt" : "fresh-mint",
      });
    } else {
      const agentId = credentialAgentId(user.id);
      db.agents.push(mintCredentialAgent(agentId, username));
      user.agentId = agentId;
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: user.id,
        agentId,
        via: "fresh-mint",
      });
    }

    db.credentialUsers.push(user);
    audit("auth-events", { id: id(), at: nowIso, type: "SIGNUP", credId: user.id, ...(ipHash ? { ipHash } : {}) });
    return { ok: true, user, recoveryCodes: codes.plain, adoptedSeafarerId };
  }, AUDIT_NO_IMPERSONATION);
}

// ---- authorizeCredentials (the next-auth Credentials provider brain) --------

/** What authorize() returns into the jwt callback (Step 4). NO email — ever (D3). */
export type CredentialPrincipal = {
  id: string;
  name: string;
  role: CredentialSide;
  seafarerId?: string;
  agentId?: string;
  /** The account's passwordChangedAt ?? createdAt — session-invalidation claim (inv. 11). */
  pwdAt: string;
};

/**
 * Login. Order (invariant 6 + Step 3): rate gates FIRST (IP + identifier
 * buckets before any lookup; the per-ACCOUNT bucket after resolution, BEFORE
 * any scrypt), dummy-verify on identifier miss, generic null on EVERY failure
 * (over-limit included — no distinguishable rate signal on the login path).
 *
 * Binding semantics (D2 v5 / invariant 14): a plain sign-in NEVER creates a
 * tenant or binding for an unbound side. The only sign-in-path binding
 * mutations are adoptToken adoption (side unbound + valid token) and the 2f-b
 * dangling-binding self-heal — each CAS'd + PROFILE_BIND-audited in ONE
 * transact. An already-bound user carrying a token keeps its profile and the
 * ignored token is recorded as ADOPT_SKIPPED (fold 7/10).
 */
export async function authorizeCredentials(
  creds: Record<string, unknown> | undefined,
  request?: { headers?: Headers }
): Promise<CredentialPrincipal | null> {
  const identifier = coerceCredentialValue(creds?.identifier);
  const password = coerceCredentialValue(creds?.password);
  const sideRaw = coerceCredentialValue(creds?.side);
  const adoptToken = coerceCredentialValue(creds?.adoptToken);
  if (!identifier || !password) return null;
  if (sideRaw !== "seaman" && sideRaw !== "agent") return null;
  const side: CredentialSide = sideRaw;

  const headers = request?.headers instanceof Headers ? request.headers : new Headers();
  const ip = clientIpFromHeaders(headers);
  const ipHash = authIpHash(ip);
  const idLower = identifier.normalize("NFC").trim().toLowerCase();
  const idHash = idHash16(idLower);

  // Rate gates FIRST — pre-resolution IP + identifier buckets before any lookup.
  if (!consumeAuthBudget("auth-login-ip", ip)) return null;
  if (!consumeAuthBudget("auth-login-id", idHash)) return null;

  // Pre-lock read snapshot (readDB is synchronous + consistent on the
  // single-threaded loop). Anything mutated later is re-read INSIDE its CAS.
  const found = ((db: DB) => {
    const user = resolveByIdentifier(db, identifier);
    if (!user) return null;
    return {
      user: { ...user, recoveryCodes: [...user.recoveryCodes] },
      seafarerLive: user.seafarerId ? db.seafarers.some((s) => s.id === user.seafarerId) : false,
    };
  })(readDB());

  if (!found) {
    await burnDummyVerify(password); // exactly ONE dummy scrypt (r2 revision 9)
    await appendAuthEvent({ type: "LOGIN_FAIL", idHash, ipHash });
    return null;
  }
  const { user, seafarerLive } = found;

  // Per-account budget BEFORE any scrypt (r2 revision 7) — closes the
  // two-identifiers-double-budget hole. Over-limit stays generic null.
  if (!consumeAuthBudget("auth-login-acct", user.id)) return null;

  if (!(await verifySecret(password, user.password))) {
    await appendAuthEvent({ type: "LOGIN_FAIL", idHash, credId: user.id, ipHash });
    return null;
  }

  const pwdAt = pwdAtOf(user);

  if (side === "agent") {
    if (!user.agentId) {
      // Never-bound side: NO silent side-minting (invariant 14) — fail generic.
      await appendAuthEvent({ type: "LOGIN_FAIL", idHash, credId: user.id, ipHash });
      return null;
    }
    if (adoptToken) {
      // A claim token on an agent-side sign-in is always ignored — record it.
      await appendAuthEvent({ type: "ADOPT_SKIPPED", credId: user.id, idHash: idHash16(adoptToken), ipHash });
    }
    await appendAuthEvent({ type: "LOGIN_OK", credId: user.id, side, ipHash });
    return { id: user.id, name: user.username, role: "agent", agentId: user.agentId, pwdAt };
  }

  // ---- side === "seaman" ----
  if (user.seafarerId && seafarerLive) {
    if (adoptToken) {
      // Already bound: IGNORE the token (no re-adoption) + ADOPT_SKIPPED (fold 7).
      await appendAuthEvent({ type: "ADOPT_SKIPPED", credId: user.id, idHash: idHash16(adoptToken), ipHash });
    }
    await appendAuthEvent({ type: "LOGIN_OK", credId: user.id, side, ipHash });
    return { id: user.id, name: user.username, role: "seaman", seafarerId: user.seafarerId, pwdAt };
  }

  if (user.seafarerId && !seafarerLive) {
    // 2f-b — dangling-binding self-heal (merged-away or hard-deleted row):
    // clear + re-bind inside ONE CAS section. The ONE sign-in path that may
    // still mint a profile (healing a side that WAS bound); the re-forked
    // Seafarer starts EMPTY (pinned by test).
    const healed = await transact<{ seafarerId: string } | null>((db, audit) => {
      const u = db.credentialUsers.find((x) => x.id === user.id);
      if (!u || !u.seafarerId) return null;
      const stillLive = db.seafarers.find((s) => s.id === u.seafarerId);
      if (stillLive) return { seafarerId: stillLive.id }; // healed concurrently
      const nowIso = new Date().toISOString();
      const anon = adoptToken ? adoptableByToken(db, adoptToken) : undefined;
      let target: Seafarer;
      if (anon) {
        anon.credentialUserId = u.id;
        target = anon;
      } else {
        target = mintCredentialSeafarer(u.username, u.id);
        db.seafarers.push(target);
      }
      u.seafarerId = target.id;
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: u.id,
        seafarerId: target.id,
        via: "self-heal",
      });
      audit("auth-events", { id: id(), at: nowIso, type: "LOGIN_OK", credId: u.id, side, ipHash });
      return { seafarerId: target.id };
    }, AUDIT_NO_IMPERSONATION);
    if (!healed) return null;
    return { id: user.id, name: user.username, role: "seaman", seafarerId: healed.seafarerId, pwdAt };
  }

  // Never-bound seaman side.
  if (adoptToken) {
    // adoptToken on the SIGN-IN path: adopt iff the target is STILL unowned
    // (CAS re-check inside the section — the racing loser fails generic).
    const adopted = await transact<{ seafarerId: string } | null>((db, audit) => {
      const u = db.credentialUsers.find((x) => x.id === user.id);
      if (!u) return null;
      if (u.seafarerId && db.seafarers.some((s) => s.id === u.seafarerId)) {
        return { seafarerId: u.seafarerId }; // bound concurrently — keep it
      }
      const anon = adoptableByToken(db, adoptToken);
      if (!anon) return null; // consumed/invalid ⇒ loser fails generic (no fresh mint on sign-in)
      const nowIso = new Date().toISOString();
      anon.credentialUserId = u.id;
      u.seafarerId = anon.id;
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: u.id,
        seafarerId: anon.id,
        via: "signin-adopt",
      });
      audit("auth-events", { id: id(), at: nowIso, type: "LOGIN_OK", credId: u.id, side, ipHash });
      return { seafarerId: anon.id };
    }, AUDIT_NO_IMPERSONATION);
    if (adopted) {
      return { id: user.id, name: user.username, role: "seaman", seafarerId: adopted.seafarerId, pwdAt };
    }
    await appendAuthEvent({ type: "LOGIN_FAIL", idHash, credId: user.id, ipHash });
    return null;
  }

  // Plain sign-in on a never-bound side: no tenant, no binding (invariant 14).
  await appendAuthEvent({ type: "LOGIN_FAIL", idHash, credId: user.id, ipHash });
  return null;
}

// ---- resetPasswordWithRecoveryCode ------------------------------------------

export type RecoveryResetInput = {
  identifier: string;
  code: string;
  newPassword: string;
  /** Raw client IP (route-derived). When absent, the per-IP bucket is skipped. */
  clientIp?: string | null;
};

export type RecoveryResetResult = { ok: true; remainingCodes: number } | { ok: false };

/**
 * Verify OUTSIDE the section, CAS INSIDE one transact (invariant 5). Timing
 * spec (r2 revision 9): missing identifier ⇒ exactly ONE dummy scrypt verify;
 * existing account ⇒ up to 8 real verifies against UNUSED codes only,
 * short-circuiting on first match — why recovery has the tightest buckets
 * (accepted timing residual R3, bounded by 3/h identifier + 3/h account).
 * Charges auth-recovery-ip (when clientIp given) + auth-recovery-id +
 * (post-resolution, pre-scrypt) auth-recovery-acct — the route must NOT
 * charge these again.
 */
export async function resetPasswordWithRecoveryCode(
  input: RecoveryResetInput
): Promise<RecoveryResetResult> {
  const identifier = coerceCredentialValue(input.identifier);
  const codeRaw = coerceCredentialValue(input.code);
  if (!identifier || !codeRaw) return { ok: false };
  if (validatePassword(input.newPassword)) return { ok: false }; // generic (route contract)

  const idLower = identifier.normalize("NFC").trim().toLowerCase();
  const idHash = idHash16(idLower);
  const ipHash = input.clientIp ? authIpHash(input.clientIp) : undefined;

  if (input.clientIp && !consumeAuthBudget("auth-recovery-ip", input.clientIp)) return { ok: false };
  if (!consumeAuthBudget("auth-recovery-id", idHash)) return { ok: false };

  const snapshot = ((db: DB) => {
    const user = resolveByIdentifier(db, identifier);
    return user ? { ...user, recoveryCodes: user.recoveryCodes.map((c) => ({ ...c, hash: { ...c.hash } })) } : null;
  })(readDB());

  if (!snapshot) {
    await burnDummyVerify(codeRaw); // exactly ONE dummy verify
    await appendAuthEvent({ type: "RECOVERY_RESET_FAIL", idHash, ...(ipHash ? { ipHash } : {}) });
    return { ok: false };
  }

  // Per-account bucket on resolution success, BEFORE any scrypt (Step 3).
  if (!consumeAuthBudget("auth-recovery-acct", snapshot.id)) return { ok: false };

  const code = normalizeRecoveryCode(codeRaw);
  let matchedIndex = -1;
  for (let i = 0; i < snapshot.recoveryCodes.length; i++) {
    const rc = snapshot.recoveryCodes[i];
    if (rc.usedAt !== null) continue; // unused codes only
    if (await verifySecret(code, rc.hash)) {
      matchedIndex = i; // short-circuit on first match
      break;
    }
  }
  if (matchedIndex < 0) {
    await appendAuthEvent({ type: "RECOVERY_RESET_FAIL", idHash, credId: snapshot.id, ...(ipHash ? { ipHash } : {}) });
    return { ok: false };
  }

  const matchedHashB64 = snapshot.recoveryCodes[matchedIndex].hash.hashB64;
  const newHash = await hashSecret(input.newPassword); // pre-hash outside the lock

  return transact<RecoveryResetResult>((db, audit) => {
    const nowIso = new Date().toISOString();
    const user = db.credentialUsers.find((u) => u.id === snapshot.id);
    const rc = user?.recoveryCodes[matchedIndex];
    // CAS: same code slot, same hash, STILL unused — else a concurrent request
    // consumed it (or regenerated the set) between verify and here ⇒ generic.
    if (!user || !rc || rc.usedAt !== null || rc.hash.hashB64 !== matchedHashB64) {
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "RECOVERY_RESET_FAIL",
        idHash,
        credId: snapshot.id,
        ...(ipHash ? { ipHash } : {}),
      });
      return { ok: false };
    }
    rc.usedAt = nowIso;
    user.password = newHash;
    user.passwordChangedAt = nowIso; // kills every pre-reset JWT (invariant 11)
    const remainingCodes = user.recoveryCodes.filter((c) => c.usedAt === null).length;
    audit("auth-events", {
      id: id(),
      at: nowIso,
      type: "RECOVERY_RESET_OK",
      credId: user.id,
      remainingCodes, // a count, not PII (fold 10)
      ...(ipHash ? { ipHash } : {}),
    });
    return { ok: true, remainingCodes };
  }, AUDIT_NO_IMPERSONATION);
}

// ---- bindSideWithPassword (v5 fold 8 / D2 — the explicit bind action) -------

export type BindSideInput = {
  username: string;
  password: string;
  side: CredentialSide;
  adoptToken?: string | null;
  /**
   * The route sends confirmBind:true only after the user explicitly confirmed
   * (pw.bindSideTitle/Body). Without it, a bindable account answers
   * needsBindConfirm — revealed only AFTER the password verified (no oracle
   * beyond what a login attempt already gives).
   */
  confirmBind?: boolean;
  clientIp?: string | null;
};

export type BindSideResult =
  | { ok: true; bound: true; side: CredentialSide; seafarerId?: string; agentId?: string }
  | { ok: false; needsBindConfirm: true }
  | { ok: false };

/**
 * The authenticated replacement for silent second-side minting (invariant 14).
 * An AUTHENTICATION attempt: charges auth-login-id + (post-resolution,
 * pre-scrypt) auth-login-acct. Precondition: username exists AND password
 * verifies AND the requested side is unbound (never-bound null — a DANGLING
 * binding is NOT bindable here; it heals only via the 2f-b sign-in path, v6
 * fold 6). Then ONE transact CAS re-checks the side is STILL unbound
 * (concurrent binds ⇒ exactly one; the loser fails generic), binds (adopt iff
 * a valid adoptToken, else mint), and emits PROFILE_BIND via "side-bind".
 * NO new CredentialUser, NO new recovery codes. Wrong password ⇒ generic
 * failure, indistinguishable from pw.errTaken.
 */
export async function bindSideWithPassword(input: BindSideInput): Promise<BindSideResult> {
  const usernameLower = usernameKey(input.username ?? "");
  const password = coerceCredentialValue(input.password);
  const adoptToken = coerceCredentialValue(input.adoptToken);
  if (!usernameLower || !password) return { ok: false };

  const idHash = idHash16(usernameLower);
  const ipHash = input.clientIp ? authIpHash(input.clientIp) : undefined;
  if (!consumeAuthBudget("auth-login-id", idHash)) return { ok: false };

  const snapshot = ((db: DB) => {
    const user = db.credentialUsers.find((u) => u.usernameLower === usernameLower);
    return user ? { ...user } : null;
  })(readDB());
  if (!snapshot) {
    await burnDummyVerify(password);
    return { ok: false };
  }

  if (!consumeAuthBudget("auth-login-acct", snapshot.id)) return { ok: false };
  if (!(await verifySecret(password, snapshot.password))) {
    await appendAuthEvent({ type: "LOGIN_FAIL", idHash, credId: snapshot.id, ...(ipHash ? { ipHash } : {}) });
    return { ok: false };
  }

  // Bound OR dangling (set at all) ⇒ generic — never needsBindConfirm (v6 fold 6).
  const alreadyBound = input.side === "seaman" ? snapshot.seafarerId != null : snapshot.agentId != null;
  if (alreadyBound) return { ok: false };

  if (input.confirmBind !== true) return { ok: false, needsBindConfirm: true };

  return transact<BindSideResult>((db, audit) => {
    const user = db.credentialUsers.find((u) => u.id === snapshot.id);
    if (!user) return { ok: false };
    const nowIso = new Date().toISOString();
    if (input.side === "seaman") {
      if (user.seafarerId != null) return { ok: false }; // CAS: lost the race
      const anon = adoptToken ? adoptableByToken(db, adoptToken) : undefined;
      let target: Seafarer;
      if (anon) {
        anon.credentialUserId = user.id;
        target = anon;
      } else {
        target = mintCredentialSeafarer(user.username, user.id);
        db.seafarers.push(target);
      }
      user.seafarerId = target.id;
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: user.id,
        seafarerId: target.id,
        via: "side-bind",
      });
      return { ok: true, bound: true, side: "seaman", seafarerId: target.id };
    }
    if (user.agentId != null) return { ok: false }; // CAS: lost the race
    const agentId = credentialAgentId(user.id);
    if (!db.agents.some((a) => a.id === agentId)) db.agents.push(mintCredentialAgent(agentId, user.username));
    user.agentId = agentId;
    audit("auth-events", {
      id: id(),
      at: nowIso,
      type: "PROFILE_BIND",
      credId: user.id,
      agentId,
      via: "side-bind",
    });
    return { ok: true, bound: true, side: "agent", agentId };
  }, AUDIT_NO_IMPERSONATION);
}

// ---- Step 13 — signed-in account management (D11) ---------------------------
//
// Both ops require the CURRENT password (a stolen live session must not be able
// to silently rotate the credential) and are charged to the per-account
// `auth-account-mgmt` bucket (5/h/account, global 60/h — v6 fold 4) BEFORE any
// scrypt. Same async-outside/CAS-inside-one-transact shape as everything above;
// audit events (PASSWORD_CHANGE / CODES_REGENERATED — id-only) ride the same
// transact as their mutation.

export type AccountMgmtFailure = { ok: false; reason: "rate" | "weak" | "generic" };

export type ChangePasswordInput = {
  credentialUserId: string;
  currentPassword: string;
  newPassword: string;
};

/**
 * Change password (Step 13a). Stamps `passwordChangedAt`, which makes every
 * OTHER outstanding JWT stale via the Step 5 gates (invariant 11) — the acting
 * client re-mints its own token by re-signIn'ing with the new password (UI).
 */
export async function changePassword(
  input: ChangePasswordInput
): Promise<{ ok: true } | AccountMgmtFailure> {
  const current = coerceCredentialValue(input.currentPassword);
  if (!current) return { ok: false, reason: "generic" };
  if (validatePassword(input.newPassword)) return { ok: false, reason: "weak" };
  // Per-account bucket BEFORE any scrypt (Step 3 / v6 fold 4).
  if (!consumeAuthBudget("auth-account-mgmt", input.credentialUserId)) {
    return { ok: false, reason: "rate" };
  }

  const snapshot = readDB().credentialUsers.find((u) => u.id === input.credentialUserId);
  if (!snapshot) return { ok: false, reason: "generic" };
  const snapHashB64 = snapshot.password.hashB64;
  if (!(await verifySecret(current, snapshot.password))) {
    return { ok: false, reason: "generic" }; // wrong current password — generic
  }
  const newHash = await hashSecret(input.newPassword); // pre-hash outside the lock

  return transact<{ ok: true } | AccountMgmtFailure>((db, audit) => {
    const user = db.credentialUsers.find((u) => u.id === input.credentialUserId);
    // CAS: account still exists AND the verified hash is still current — a
    // concurrent change/reset between verify and here ⇒ fail generic.
    if (!user || user.password.hashB64 !== snapHashB64) return { ok: false, reason: "generic" };
    const nowIso = new Date().toISOString();
    user.password = newHash;
    user.passwordChangedAt = nowIso; // kills every OTHER outstanding JWT (invariant 11)
    audit("auth-events", { id: id(), at: nowIso, type: "PASSWORD_CHANGE", credId: user.id });
    return { ok: true };
  }, AUDIT_NO_IMPERSONATION);
}

export type RegenerateCodesInput = {
  credentialUserId: string;
  currentPassword: string;
};

/**
 * Regenerate recovery codes (Step 13b). Replaces the WHOLE recoveryCodes array
 * (voids ALL old codes, used and unused), mints 8 fresh ones (sequential
 * hashing, D8) and returns them in plaintext exactly once — the UI re-runs the
 * one-time ceremony screen. No pwdAt change: codes are not the password, so
 * sessions stay valid (plan Step 13).
 */
export async function regenerateRecoveryCodes(
  input: RegenerateCodesInput
): Promise<{ ok: true; recoveryCodes: string[]; username: string } | AccountMgmtFailure> {
  const current = coerceCredentialValue(input.currentPassword);
  if (!current) return { ok: false, reason: "generic" };
  if (!consumeAuthBudget("auth-account-mgmt", input.credentialUserId)) {
    return { ok: false, reason: "rate" };
  }

  const snapshot = readDB().credentialUsers.find((u) => u.id === input.credentialUserId);
  if (!snapshot) return { ok: false, reason: "generic" };
  const snapHashB64 = snapshot.password.hashB64;
  if (!(await verifySecret(current, snapshot.password))) {
    return { ok: false, reason: "generic" };
  }
  const codes = await generateRecoveryCodes(); // sequential scrypt, outside the lock

  return transact<{ ok: true; recoveryCodes: string[]; username: string } | AccountMgmtFailure>(
    (db, audit) => {
      const user = db.credentialUsers.find((u) => u.id === input.credentialUserId);
      // CAS: account still exists AND the verified password is still current.
      if (!user || user.password.hashB64 !== snapHashB64) return { ok: false, reason: "generic" };
      const nowIso = new Date().toISOString();
      user.recoveryCodes = codes.hashed; // voids ALL old codes, used and unused
      audit("auth-events", { id: id(), at: nowIso, type: "CODES_REGENERATED", credId: user.id });
      return { ok: true, recoveryCodes: codes.plain, username: user.username };
    },
    AUDIT_NO_IMPERSONATION
  );
}

// ---- Step 14 — admin rescue: unbind credential + reissue claim link (D13) ---

export type RescueResult =
  | {
      ok: true;
      /** The freshly-rotated OPEN claim token — every old claim link is dead. */
      claimToken: string;
      credId: string;
      /** True when the CredentialUser had no remaining binding and was deleted. */
      orphanDeleted: boolean;
      /** Set when the orphan delete freed this username for re-registration. */
      freedUsername: string | null;
    }
  | { ok: false };

/**
 * The Step 14 rescue transact — "seafarer lost password AND codes" (R2).
 * ONE critical section: (1) resolve seafarer + owning CredentialUser;
 * (2) ownership-shape guard (v6 fold 2) re-checked INSIDE the section — a row
 * with googleSub or ownerEmail set is REFUSED (a reissued claim token would
 * fail the Step 2 adopt guard and fork an empty profile instead of adopting);
 * (3) unbind both pointers; (4) rotate ALL share tokens via newShareTokens()
 * (rotation precedent access.ts:363) killing every old claim link; (5) orphan
 * scrub (GDPR): a CredentialUser with NO remaining binding is DELETED — which
 * scrubs emailUnverified and frees its usernameLower; (6) PROFILE_BIND
 * (via "admin-rescue", ids only) through the transact collector.
 *
 * The ROUTE awaits recordAdminAction(...) AFTER this resolves — recordAdminAction
 * is async (appendAudit) and can never run inside the synchronous mutator.
 */
export async function rescueCredentialProfile(seafarerId: string): Promise<RescueResult> {
  const target = coerceCredentialValue(seafarerId);
  if (!target) return { ok: false };
  return transact<RescueResult>((db, audit) => {
    const seafarer = db.seafarers.find((s) => s.id === target);
    if (!seafarer || !seafarer.credentialUserId) return { ok: false };
    // Ownership-shape guard (v6 fold 2): co-owned rows are NOT rescuable.
    if (seafarer.googleSub || seafarer.ownerEmail) return { ok: false };
    const user = db.credentialUsers.find((u) => u.id === seafarer.credentialUserId);
    if (!user) return { ok: false };

    const nowIso = new Date().toISOString();
    // (3) Unbind — both pointers, atomically.
    seafarer.credentialUserId = null;
    user.seafarerId = null;
    // (4) Reissue — rotate: kill every old claim link (access.ts:363 precedent).
    Object.assign(seafarer, newShareTokens());

    // (5) Orphan scrub: no remaining binding ⇒ delete the row entirely
    // (emailUnverified scrubbed with it, usernameLower freed).
    let orphanDeleted = false;
    let freedUsername: string | null = null;
    if (!user.agentId) {
      db.credentialUsers = db.credentialUsers.filter((u2) => u2.id !== user.id);
      orphanDeleted = true;
      freedUsername = user.username;
    }

    audit("auth-events", {
      id: id(),
      at: nowIso,
      type: "PROFILE_BIND",
      credId: user.id,
      seafarerId: seafarer.id,
      via: "admin-rescue",
    });
    return {
      ok: true,
      claimToken: seafarer.shareToken,
      credId: user.id,
      orphanDeleted,
      freedUsername,
    };
  }, AUDIT_NO_IMPERSONATION);
}
