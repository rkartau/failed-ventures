// Server-side SEAMAN authentication — the counterpart to lib/agent-session.ts.
//
// A seaman session is a Google (Auth.js) session whose role is "seaman" (decided by
// the context the user signed in from, see auth.ts). It carries the id of the ONE
// seafarer profile that Google identity owns. This is the ONLY seaman identity gate:
// every seaman-scoped route resolves data via the seafarerId returned here, NEVER an
// id/token taken from the request, so a seaman can never reach another seafarer's
// data and a seaman session never gains agent scope.
//
// For local automation (the persona harness) and for the owner testing BEFORE Google
// keys are set, a DEV-ONLY cookie session is accepted whenever NODE_ENV !==
// "production" — the seaman-side mirror of the agent dev door. In a production build
// NODE_ENV === "production", so `isDevSeamanLoginEnabled` is false, the cookie is
// ignored, and /api/seaman-test-login 403s: the test door is hard-disabled in prod.
// This cookie is DISTINCT from the agent dev cookie, so it can never grant agent scope.

import { cookies } from "next/headers";
import { auth } from "@/auth";
import { readDB, type DB, type Seafarer } from "@/lib/db";
import { ADMIN_EMAILS } from "@/lib/admin-session";
import {
  IMPERSONATION_ENABLED,
  resolveImpersonation,
  decideImpersonation,
} from "@/lib/impersonation";

export const DEV_SEAMAN_COOKIE = "docka_dev_seaman";
// Dev-only door: on in `next dev`, hard-off in any production build. (The old
// DOCKA_DEMO_LOGIN override was removed in the public archive.)
export const isDevSeamanLoginEnabled = process.env.NODE_ENV !== "production";

export type SeamanSession = {
  /** The seafarer profile this signed-in seaman owns. */
  seafarerId: string;
  user: { name?: string | null; email?: string | null };
  /**
   * "password" for credential sessions (drives the Step 13 Account section —
   * Google users have nothing to manage there). Never anything else; carries
   * no secret (the pw.* claims stay on the session, not here).
   */
  authMethod?: "password";
  /** Set ONLY when an allowlisted admin is impersonating this seaman (audit stamp). */
  impersonatorAdminEmail?: string;
};

/**
 * Credential (password) seaman claim validation — feat/password-signup Step 5.
 * This IS the production decision path (seamanSession routes every password
 * session through it after the existing DB liveness re-check); exported so the
 * invariants tests can drive it with sessions built via the REAL authorize →
 * jwt/session-callback pipeline. Google sessions never reach it.
 *
 * Fail-closed rules (invariant 11 + v6 fold 1):
 *   - no `pwdAt` claim ⇒ invalid (the bare `<` staleness compare is false for
 *     undefined and would fail OPEN — a stripped token must never pass);
 *   - the live Seafarer has no / a dangling `credentialUserId` ⇒ invalid — the
 *     staleness check is never skipped because the owner could not be found
 *     (v4 symmetry with the agent gate's no-owner rule);
 *   - IDENTITY ANCHOR (v6 fold 1): the resolved CredentialUser must BE the
 *     session's identity — `owner.id === s.credentialSub` (authorize()'s
 *     returned id lands in token.sub; the session callback surfaces it).
 *     Without it, a stale stolen JWT survives an admin rescue followed by
 *     re-adoption of the profile by an OLDER account whose passwordChangedAt
 *     predates the thief's pwdAt;
 *   - `pwdAt` older than the stored passwordChangedAt ?? createdAt ⇒ invalid
 *     (a recovery-reset / password change kills every pre-reset 30-day JWT).
 */
export function credentialSeamanClaimValid(
  s: { pwdAt?: string; credentialSub?: string },
  seafarer: Seafarer,
  db: DB
): boolean {
  if (!s.pwdAt) return false; // fail CLOSED on the missing claim (invariant 11)
  if (!seafarer.credentialUserId) return false; // owner missing ⇒ fail closed
  const owner = db.credentialUsers.find((u) => u.id === seafarer.credentialUserId);
  if (!owner) return false; // dangling owner pointer ⇒ fail closed
  if (!s.credentialSub || owner.id !== s.credentialSub) return false; // identity anchor
  if (s.pwdAt < (owner.passwordChangedAt ?? owner.createdAt)) return false; // stale JWT
  return true;
}

export async function seamanSession(): Promise<SeamanSession | null> {
  const s = await auth();

  // IMPERSONATION PREAMBLE (runs BEFORE the real-seaman / dev-cookie logic). Only an
  // allowlisted admin can trip it — ADMIN_EMAILS.has(email) is re-checked EVERY request
  // (fail-closed) before any target identity is returned. suspended => null (F3: 403,
  // never a fall-through to the admin's own identity); active-agent => null (sibling
  // suppression); none => fall through to the existing logic below, unchanged.
  const email = (s?.user?.email ?? "").trim().toLowerCase();
  if (IMPERSONATION_ENABLED && email && ADMIN_EMAILS.has(email)) {
    const db = readDB();
    const decision = decideImpersonation(
      email,
      resolveImpersonation(email),
      db,
      "seaman",
      ADMIN_EMAILS
    );
    if (decision.kind === "suspend") return null;
    if (decision.kind === "target") {
      const seafarer = db.seafarers.find((x) => x.id === decision.targetId) ?? null;
      if (!seafarer) return null; // vanished target — fail closed
      return {
        seafarerId: seafarer.id,
        user: { name: seafarer.name, email: `${seafarer.id}@localhost` },
        impersonatorAdminEmail: email,
      };
    }
    // decision.kind === "fallthrough" — admin has no active seaman impersonation.
  }

  if (s?.role === "seaman" && s.seafarerId && s.user) {
    const seafarerId = s.seafarerId;
    // Defend against a stale JWT that outlived its seafarer (e.g. a data reset).
    const db = readDB();
    const seafarer = db.seafarers.find((x) => x.id === seafarerId);
    if (!seafarer) return null;
    // Credential (password) sessions additionally pass the pwdAt staleness +
    // identity-anchor gate (Step 5, invariant 11 / v6 fold 1) — fail closed on
    // ANY miss. Google sessions are unaffected.
    if (s.authMethod === "password" && !credentialSeamanClaimValid(s, seafarer, db)) {
      return null;
    }
    return {
      seafarerId,
      user: s.user,
      ...(s.authMethod === "password" ? { authMethod: "password" as const } : {}),
    };
  }

  // DEV-ONLY backdoor (mirror of the agent test-login): a cookie carrying the OWNED
  // seafarerId establishes a seaman session without Google. Hard-disabled in a
  // production build. Resolves ONLY a seafarer id — never any agent identity.
  if (isDevSeamanLoginEnabled) {
    const c = cookies().get(DEV_SEAMAN_COOKIE);
    if (c?.value) {
      const seafarer = readDB().seafarers.find((x) => x.id === c.value);
      if (seafarer) {
        return {
          seafarerId: seafarer.id,
          user: { name: seafarer.name, email: `${seafarer.id}@localhost` },
        };
      }
    }
  }
  return null;
}
