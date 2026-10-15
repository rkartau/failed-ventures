// Server-side agent authentication. Normally this is a Google (Auth.js) session.
//
// For local automation and for the owner using the dashboard BEFORE Google keys
// are set, a dev-only test session is accepted whenever NODE_ENV !== "production"
// — i.e. the ordinary `next dev` the owner is already running, with NO special
// env var and NO restart. In a production build NODE_ENV === "production", so
// `isDevLoginEnabled` is false, the cookie is ignored, and /api/test-login 403s:
// the test door is hard-disabled in prod.
//
// MEDICAL GATING IS OFF (owner decision D3): there is no medical-reviewer role and
// no health-data redaction. A signed-in agent that a seafarer has granted access
// to sees that seafarer's documents in full, medical certificates included. The
// privacy limit is documented; proper special-category handling is deferred to the
// DB+RLS hardening step. Multi-tenant isolation is enforced by grants, not roles —
// see lib/access.ts / lib/agentData.ts.

import { cookies } from "next/headers";
import { auth } from "@/auth";
import { readDB, type BillingProfile, type DB } from "@/lib/db";
import { findOrCreateAgentByGoogle } from "@/lib/agent-account";
import { ADMIN_EMAILS } from "@/lib/admin-session";
import {
  IMPERSONATION_ENABLED,
  resolveImpersonation,
  decideImpersonation,
} from "@/lib/impersonation";
import {
  billingStateForAgent,
  billingTierForAgent,
  EXEMPT_STATE,
  type BillingState,
} from "@/lib/billing-enforce";
import { billingProfileNeedsWrite, ensureBillingProfileForAgent } from "@/lib/billing-store";
import { recordBillingAlertOnce } from "@/lib/billing-health";
import { isSampleAgentId } from "@/lib/billing-usage";
import { billingProfileIncomplete } from "@/lib/billing-onboarding";

export const DEV_COOKIE = "docka_dev_agent";
// Dev-only door: on in `next dev`, hard-off in any production build. (The old
// DOCKA_DEMO_LOGIN override was removed in the public archive.)
export const isDevLoginEnabled = process.env.NODE_ENV !== "production";

// The dev "sign in as agent" cookie carries the CHOSEN agentId (e.g. "agent:maria")
// so the local picker can demonstrate multi-tenant isolation without Google: each
// pick is a different tenant, and the grant-scoped reads (lib/agentData.ts) then
// show only that agent's granted seafarers. Legacy value "1" maps to the "dev"
// tenant so an old cookie keeps working.
function resolveDevAgent(cookieValue: string): { agentId: string; name: string } {
  const raw = cookieValue === "1" ? "dev" : cookieValue;
  const agent = readDB().agents.find((a) => a.id === raw);
  if (agent) return { agentId: agent.id, name: agent.orgName };
  return { agentId: "dev", name: "Test agent (dev)" };
}

export type AgentSession = {
  user: { name?: string | null; email?: string | null };
  /**
   * Stable per-agent identity key (the tenant id used by lib/access.ts grants and
   * the per-agent required-docs config) — always a real Agent.id on the `agent:*`
   * keyspace. A live Google agent is resolved to their Agent row via
   * findOrCreateAgentByGoogle (lib/agent-account.ts); the dev door is the single
   * "dev" tenant. This is NOT an auth secret — just a stable partition key.
   */
  agentId: string;
  /**
   * "password" for credential sessions (drives the Step 13 account-settings
   * card/page — Google users have nothing to manage there).
   */
  authMethod?: "password";
  /** Set ONLY when an allowlisted admin is impersonating this agent (audit stamp). */
  impersonatorAdminEmail?: string;
  /**
   * BILLING ENFORCEMENT SEAM (owner-approved auth touch, plan decision 12 / P5).
   *
   * Every agent page and every agent API route already resolves this ONE function, so
   * computing the tier here is the only way enforcement cannot be bypassed by a route
   * that forgets a wrapper.
   *
   * COST (finding 22 — the old comment here claimed "cost is nil: readDB() is already
   * hot on these paths", which was simply wrong: readDB has NO cache, and this seam was
   * adding three full db.json parses per resolution). It is now ONE parse, shared
   * between the write check and the tier computation, and ZERO writes in the steady
   * state (R2-8).
   *
   * `tier: "exempt"` for the impersonation branch (an admin looking at an agency's
   * board must never hit that agency's paywall — the existing impersonatorAdminEmail
   * stamp is the audit trail) and for the dev door.
   */
  billing: BillingState;
  /**
   * FIRST-TIME ONBOARDING GATE (owner request). True ONLY for a real, resolved,
   * non-exempt, non-sample, non-impersonated, non-dev agent whose billing profile is
   * business-incomplete OR whose ToS is unaccepted — the (enforced) template redirects
   * such a session to /agent/settings/billing until it self-clears.
   *
   * False everywhere else, including every fail-open path (error / null profile /
   * impersonation / dev-login / sample / exempt), so an enforcement or store bug can
   * never lock an agency out of its board over an onboarding-bookkeeping error.
   */
  onboardingIncomplete: boolean;
};

/**
 * Credential (password) agent resolution — feat/password-signup Step 5. This IS
 * the production decision path (agentSession routes every non-seaman password
 * session through it); exported so the invariants tests can drive it with
 * sessions built via the REAL authorize → jwt/session-callback pipeline.
 *
 * Fail-closed rules (invariants 11/12):
 *   - no `pwdAt` claim ⇒ null (the bare `<` staleness compare is false for
 *     undefined and would fail OPEN — a stripped token must never pass);
 *   - no `agentId` claim ⇒ null — NEVER the shared `agent:unknown` tenant;
 *   - `agentId` with no live Agent row ⇒ null;
 *   - no CredentialUser owns that agentId ⇒ null (D4's id is a one-way hash of
 *     CredentialUser.id — resolve by scan; the staleness check is never skipped
 *     because the owner could not be found). The scan is identity-anchored by
 *     construction: the hash binds the tenant to exactly one account.
 *   - `pwdAt` older than the stored passwordChangedAt ?? createdAt ⇒ null (a
 *     recovery-reset / password change kills every pre-reset 30-day JWT).
 */
export function resolveCredentialAgentSession(
  s: {
    user?: { name?: string | null; email?: string | null } | null;
    agentId?: string;
    pwdAt?: string;
  },
  db: DB
): Omit<AgentSession, "billing" | "onboardingIncomplete"> | null {
  if (!s.pwdAt) return null; // fail CLOSED on the missing claim (invariant 11)
  const agentId = s.agentId;
  if (!agentId) return null; // never agent:unknown (invariant 12)
  if (!db.agents.some((a) => a.id === agentId)) return null; // tenant row must be live
  const owner = db.credentialUsers.find((u) => u.agentId === agentId);
  if (!owner) return null; // no owner ⇒ fail closed, staleness never skipped
  if (s.pwdAt < (owner.passwordChangedAt ?? owner.createdAt)) return null; // stale JWT
  return { user: { name: s.user?.name ?? null, email: null }, agentId, authMethod: "password" };
}

/**
 * Shared billing-state resolver for a resolved agent tenant (R2-8 fail-open, ONE readDB
 * snapshot, ZERO steady-state writes — identical semantics to the Google branch below).
 *
 * The Google branch keeps its billing resolve INLINE (byte-for-byte) because
 * billing-enforce.test.mjs source-scans it for the `agent.id` literals; this helper serves
 * the CREDENTIAL (password) branch, whose agent is an equally-real `agent:*` tenant that the
 * (enforced) template enforces the same way — it reads `session.billing` for EVERY agent, a
 * password login included, so the credential branch must attach billing too or the wall
 * would dereference `undefined`.
 *
 * It also computes `onboardingIncomplete` from the SAME snapshot + profile (ZERO extra
 * db parse), by the identical rule the Google branch uses — a password-registered agent
 * is the PRIMARY onboarding path, so it MUST be gated to the billing form until it
 * completes business details + accepts the ToS. Fail-open: any throw / null profile /
 * sample / exempt agent yields `onboardingIncomplete = false`.
 */
async function resolveSessionBilling(
  agentId: string
): Promise<{ billing: BillingState; onboardingIncomplete: boolean }> {
  try {
    const db = readDB();
    let profile: BillingProfile | null;
    let billing: BillingState;
    if (billingProfileNeedsWrite(db, agentId)) {
      // The anomalous/first-session path only: create-if-absent or the D-D heal.
      profile = await ensureBillingProfileForAgent(agentId);
      billing = billingStateForAgent(agentId); // re-read AFTER the write
    } else {
      profile = db.billingProfiles.find((p) => p.agentId === agentId) ?? null;
      billing = billingTierForAgent(db, agentId);
    }
    const onboardingIncomplete =
      !isSampleAgentId(agentId) &&
      profile != null &&
      !profile.exemptFromBilling &&
      billingProfileIncomplete(profile);
    return { billing, onboardingIncomplete };
  } catch (err) {
    console.error("BILLING-SESSION-FAILURE", agentId, err);
    try {
      // FR2-4 / N4 — the fail-open path can never itself throw and must never FLOOD:
      // deduped on (kind, agentId, scope) exactly like the Google branch.
      recordBillingAlertOnce(
        "error",
        `billing state could not be resolved for a signed-in session: ` +
          `${err instanceof Error ? err.message : String(err)} — enforcement abstained`,
        { agentId, scope: "agent-session" }
      );
    } catch {
      /* observability must never break the session it observes */
    }
    // Fail-open: enforcement abstains, and so does the onboarding gate.
    return { billing: { ...EXEMPT_STATE, reason: "error" }, onboardingIncomplete: false };
  }
}

export async function agentSession(): Promise<AgentSession | null> {
  const s = await auth();

  // IMPERSONATION PREAMBLE (runs BEFORE the real-agent / dev-cookie logic). Only an
  // allowlisted admin can trip it — ADMIN_EMAILS.has(email) is re-checked EVERY request
  // (fail-closed) before any target identity is returned. suspended => null (F3: 403,
  // never a fall-through to the admin's own identity); active-seaman => null (sibling
  // suppression); none => fall through to the existing logic below, unchanged.
  const adminEmail = (s?.user?.email ?? "").trim().toLowerCase();
  if (IMPERSONATION_ENABLED && adminEmail && ADMIN_EMAILS.has(adminEmail)) {
    const db = readDB();
    const decision = decideImpersonation(
      adminEmail,
      resolveImpersonation(adminEmail),
      db,
      "agent",
      ADMIN_EMAILS
    );
    if (decision.kind === "suspend") return null;
    if (decision.kind === "target") {
      const agent = db.agents.find((a) => a.id === decision.targetId) ?? null;
      if (!agent) return null; // vanished target — fail closed
      return {
        user: { name: agent.orgName, email: `${agent.id}@localhost` },
        agentId: agent.id,
        impersonatorAdminEmail: adminEmail,
        // Impersonation ALWAYS bypasses billing enforcement (P5). The bypass is
        // auditable through the impersonatorAdminEmail stamp above, which every
        // impersonated write already threads into the audit sinks.
        billing: { ...EXEMPT_STATE, reason: "impersonation" },
        // An admin looking at an agency's board must never be bounced to that
        // agency's onboarding form.
        onboardingIncomplete: false,
      };
    }
    // decision.kind === "fallthrough" — admin has no active agent impersonation.
  }

  // CREDENTIAL (password) SESSIONS — Step 5. Resolved by the explicit agentId
  // claim, NEVER by e-mail (a credential session carries none, D3): the e-mail
  // block below would fall through to the SHARED `agent:unknown` tenant for a
  // no-email session, so the credential branch must return here on ANY miss
  // (fail closed) and never reach it. A seaman-role password session falls
  // through like its Google counterpart and gains no agent scope.
  if (s?.authMethod === "password" && s.role !== "seaman") {
    const resolved = resolveCredentialAgentSession(s, readDB());
    if (!resolved) return null;
    // A password login is a real `agent:*` tenant and lands under the (enforced) route
    // group, whose template reads session.billing for EVERY agent — so it is enforced
    // exactly like a Google agent (same R2-8 fail-open, one snapshot, no steady writes).
    const { billing, onboardingIncomplete } = await resolveSessionBilling(resolved.agentId);
    return { ...resolved, billing, onboardingIncomplete };
  }

  // ROLE SEPARATION: a Google session only grants AGENT scope when its role is NOT
  // "seaman". A seaman signed in on the seaman side (same Google account or not)
  // must never gain agent scope here. Existing agent logins carry role "agent" (or,
  // on a pre-upgrade JWT, no role at all) and are unaffected.
  if (s?.user && s.role !== "seaman") {
    // Resolve the live Google agent to their REAL Agent row on the `agent:*`
    // keyspace (find-or-create, idempotent) so their grants/assignments/access-log
    // — all keyed by Agent.id — join their Agent row. This replaces the old
    // `google:<email>` key, which never matched any Agent row and left real
    // onboarding invisible to the admin board. Falls through to "agent:unknown"
    // for the (near-impossible) Google session with no e-mail, matching the prior
    // no-email behaviour without minting a junk row.
    const email = (s.user.email ?? "").trim().toLowerCase();
    if (email) {
      const agent = await findOrCreateAgentByGoogle({
        email,
        name: s.user.name,
      });
      // R1-9/R2-8 — the BillingProfile is created lazily on the agent's first resolved
      // session after go-live, which is also what stamps `billingRequiredSince` (the
      // escalation clock). Create-if-absent is atomic and write-once, and the steady
      // state is a PURE READ, so db.json does not churn on every authenticated request.
      //
      // D-E / FINDING 7 — this was a BARE await on a store WRITE, with no try/catch in
      // any of the 44 call sites: a transient write failure 500'd every authenticated
      // agent surface at once, for a billing bookkeeping error. That is the exact
      // opposite of the fail-open doctrine in billing-enforce.ts. Enforcement now
      // ABSTAINS instead: the session resolves exempt with reason "error", loudly.
      //
      // FINDING 22 — ONE snapshot. `ensureBillingProfileForAgent` (a read + a settings
      // read) followed by `billingStateForAgent` (a third read) meant three full
      // db.json parses on EVERY authenticated request, and a page view resolves the
      // session twice (template + page) — roughly four extra full parses per view.
      // readDB has no cache. The steady state is now a single parse: the snapshot
      // answers both "is a write needed?" and "what is the tier?".
      let billing: BillingState;
      // FIRST-TIME ONBOARDING GATE (owner request). Computed from the SAME snapshot +
      // profile this path already resolves — ZERO extra db parse — and it inherits the
      // try/catch fail-open below for free: any throw leaves it false, so the board
      // never locks over an onboarding-bookkeeping error.
      let onboardingIncomplete = false;
      try {
        const db = readDB();
        let profile: BillingProfile | null;
        if (billingProfileNeedsWrite(db, agent.id)) {
          // The anomalous/first-session path only: create-if-absent or the D-D heal.
          profile = await ensureBillingProfileForAgent(agent.id);
          billing = billingStateForAgent(agent.id); // re-read AFTER the write
        } else {
          profile = db.billingProfiles.find((p) => p.agentId === agent.id) ?? null;
          billing = billingTierForAgent(db, agent.id);
        }
        // True ONLY for a real, non-sample, non-exempt agent with an ACTUAL profile that
        // is business-incomplete or ToS-unaccepted. A null profile (never onboarded),
        // a sample agent, and an exempt/comped/grandfathered agency all stay false —
        // the same exclusion set the paywall applies, so onboarding never over-gates.
        onboardingIncomplete =
          !isSampleAgentId(agent.id) &&
          profile != null &&
          !profile.exemptFromBilling &&
          billingProfileIncomplete(profile);
      } catch (err) {
        console.error("BILLING-SESSION-FAILURE", agent.id, err);
        try {
          // FR2-4 — the fail-open path can never itself throw: the store may BE the
          // broken thing, and billing-health is a separate file with its own guard.
          //
          // N4 — ...and it must never FLOOD either. This runs PER REQUEST, so an
          // unbounded append would write one line per page view during an outage and
          // roll every money-critical alert out of the 200-entry window. Deduped on
          // (kind, agentId, scope) exactly like the FR2-2 cron alert.
          recordBillingAlertOnce(
            "error",
            `billing state could not be resolved for a signed-in session: ` +
              `${err instanceof Error ? err.message : String(err)} — enforcement abstained`,
            { agentId: agent.id, scope: "agent-session" }
          );
        } catch {
          /* observability must never break the session it observes */
        }
        billing = { ...EXEMPT_STATE, reason: "error" };
        // Fail-open: enforcement abstained, so the onboarding gate abstains too.
        onboardingIncomplete = false;
      }
      return { user: s.user, agentId: agent.id, billing, onboardingIncomplete };
    }
    return {
      user: s.user,
      agentId: "agent:unknown",
      billing: { ...EXEMPT_STATE },
      onboardingIncomplete: false,
    };
  }

  if (isDevLoginEnabled) {
    const c = cookies().get(DEV_COOKIE);
    if (c?.value) {
      const { agentId, name } = resolveDevAgent(c.value);
      // The dev/demo door is exempt (P5) — it exists precisely to demonstrate the app
      // without any real billing relationship behind it.
      return {
        user: { name, email: `${agentId}@localhost` },
        agentId,
        billing: { ...EXEMPT_STATE, reason: "dev-login" },
        onboardingIncomplete: false,
      };
    }
  }
  return null;
}
