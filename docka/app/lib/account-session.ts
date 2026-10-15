// feat/password-signup Step 13 — session resolution for the signed-in account
// routes (/api/account/change-password, /api/account/regenerate-codes,
// /api/account/claim-report). Lives in lib because Next route files may only
// export route handlers.
//
// A PASSWORD-ACCOUNT session is validated with the SAME exported production
// validators the Step 5 gates use — credentialSeamanClaimValid (seaman side:
// pwdAt staleness + identity anchor + owner liveness) and
// resolveCredentialAgentSession (agent side: agentId claim + owner scan +
// staleness) — never a parallel re-implementation. On ANY miss: null (fail
// closed). The resolved CredentialUser is additionally cross-checked against
// the session's role binding (seafarerId / agentId claim), so a crafted claim
// combination can never manage a different account.
//
// TEST OVERRIDE (mock-mode only): mirrors the registry limiter's
// x-registry-test-ip convention — honored ONLY under REGISTRY_MOCK=1 and never
// in a production build. It lets the route tests drive the REAL handlers with
// sessions built through the real authorize → jwt/session-callback pipeline
// (next-auth's auth() needs a live request scope that plain node tests lack).

import { auth } from "@/auth";
import { readDB, type CredentialUser } from "@/lib/db";
import { credentialSeamanClaimValid } from "@/lib/seaman-session";
import { resolveCredentialAgentSession } from "@/lib/agent-session";
import { idHash16 } from "@/lib/auth-rate-limit";

export type AccountSessionLike = {
  role?: "agent" | "seaman";
  seafarerId?: string;
  agentId?: string;
  authMethod?: "password";
  pwdAt?: string;
  credentialSub?: string;
  user?: { name?: string | null; email?: string | null } | null;
} | null;

// undefined = no override (auth() decides); null/an object = the override value.
let testSessionOverride: AccountSessionLike | undefined;

/** Mock-mode-only test hook (REGISTRY_MOCK=1, never production). */
export function __setTestAccountSession(s: AccountSessionLike | undefined): void {
  testSessionOverride = s;
}

async function currentSession(): Promise<AccountSessionLike> {
  if (
    process.env.REGISTRY_MOCK === "1" &&
    process.env.NODE_ENV !== "production" &&
    testSessionOverride !== undefined
  ) {
    return testSessionOverride;
  }
  return (await auth()) as AccountSessionLike;
}

export type PasswordAccountSession = {
  user: CredentialUser;
  side: "seaman" | "agent";
};

/**
 * The gate for change-password / regenerate-codes: a VALID password session
 * (per the Step 5 validators) resolved to its owning CredentialUser. Google
 * sessions and anything failing a gate check resolve to null.
 */
export async function passwordAccountSession(): Promise<PasswordAccountSession | null> {
  const s = await currentSession();
  if (!s || s.authMethod !== "password" || !s.credentialSub) return null;
  const db = readDB();
  if (s.role === "seaman") {
    if (!s.seafarerId) return null;
    const seafarer = db.seafarers.find((x) => x.id === s.seafarerId);
    if (!seafarer) return null;
    if (!credentialSeamanClaimValid(s, seafarer, db)) return null;
  } else {
    if (!resolveCredentialAgentSession(s, db)) return null;
  }
  const user = db.credentialUsers.find((u) => u.id === s.credentialSub);
  if (!user) return null;
  // Cross-check: the resolved account IS the session's role binding.
  if (s.role === "seaman" && user.seafarerId !== s.seafarerId) return null;
  if (s.role !== "seaman" && user.agentId !== s.agentId) return null;
  return { user, side: s.role === "seaman" ? "seaman" : "agent" };
}

export type ClaimReportActor = {
  /** Rate-bucket partition key — never a raw identifier (hashed for e-mails). */
  key: string;
  /** Set for password sessions only — rides the ADOPT_SKIPPED event (id-only). */
  credId?: string;
};

/**
 * The claim-report gate (Step 13c): ANY signed-in session may report a claim
 * token it could not adopt — password accounts (validated as above) and Google
 * sessions (seaman: live owned seafarer; agent: session e-mail). Fail closed on
 * everything else. The returned key partitions the auth-account-mgmt bucket.
 */
export async function claimReportActor(): Promise<ClaimReportActor | null> {
  const s = await currentSession();
  if (!s) return null;
  if (s.authMethod === "password") {
    const acct = await passwordAccountSession();
    return acct ? { key: acct.user.id, credId: acct.user.id } : null;
  }
  const db = readDB();
  if (s.role === "seaman") {
    if (!s.seafarerId || !db.seafarers.some((x) => x.id === s.seafarerId)) return null;
    return { key: `seafarer:${s.seafarerId}` };
  }
  const email = (s.user?.email ?? "").trim().toLowerCase();
  if (!email) return null;
  return { key: `email:${idHash16(email)}` };
}
