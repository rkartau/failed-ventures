// Find-or-create an Agent (crewing-org tenant) row for an AGENT who signed in
// with Google.
//
// This is the agent-side counterpart to lib/seaman-account.ts. It exists to fix a
// latent data-model bug: previously a live Google agent was keyed
// `google:<email>` (lib/agent-session.ts), which is NOT an Agent.id — so their
// grants/assignments/access-log (all keyed by Agent.id, e.g. `agent:maria`) never
// joined an Agent row and their onboarding was invisible to the admin board.
//
// Here a Google login always resolves to exactly ONE Agent row on the `agent:*`
// keyspace. Matching order (most-stable first):
//   1. Google `sub` (stable provider id) — a returning agent.
//   2. Linked `googleEmail` — the same agent before their `sub` was on file; the
//      `sub` is then back-filled so future logins hit case 1.
//   3. ADOPT a seed/legacy Agent row whose `contact` IS this e-mail (conservative:
//      only when `contact` is clearly an e-mail) — so a seeded org can be claimed
//      by its real Google login WITHOUT creating a duplicate tenant.
//   4. Otherwise provision a fresh Agent row with a STABLE, deterministic id in the
//      `agent:` namespace derived from the e-mail.
//
// The whole decision runs inside ONE db.ts critical section (updateDB → serialize
// + writeAtomic), so two near-simultaneous first logins cannot create two rows for
// one identity, and a second call for the same e-mail returns the SAME row and
// creates nothing (idempotent).

import crypto from "crypto";
import { updateDB, type Agent } from "@/lib/db";

export type GoogleAgentProfile = {
  email?: string | null;
  /** Auth.js `sub` (provider account id), when available. */
  sub?: string | null;
  name?: string | null;
};

/** Conservative "is this string an e-mail?" check for the seed-adoption path. */
function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

/**
 * Stable, collision-safe Agent id for a newly-provisioned Google agent.
 *
 * Scheme: `agent:g-` + the first 16 hex chars (64 bits) of sha256(seed), where
 * `seed` is the normalised e-mail (falling back to the Google `sub`). Chosen so
 * that:
 *   - it stays inside the existing `agent:` namespace (joins cleanly with grants/
 *     assignments/access-log that key `agent:*`),
 *   - the `g-` marker keeps it from ever colliding with the human-readable seed
 *     ids (`agent:maria`, …) or the `dev` tenant,
 *   - it is DETERMINISTIC in the e-mail, so the id is stable across logins and two
 *     races that both fall to the provision branch would compute the same id
 *     (belt-and-braces on top of the updateDB mutex),
 *   - 64 bits of digest makes accidental collision negligible at any realistic
 *     tenant count.
 */
function stableAgentId(seed: string): string {
  const h = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `agent:g-${h}`;
}

/** Best-effort org label from the e-mail domain (display only). */
function orgFromEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(at + 1) : email;
}

/**
 * Resolve a live Google agent to their real Agent row, creating it once if needed.
 * Idempotent per identity. Always returns an Agent whose `id` is on the `agent:*`
 * keyspace.
 */
export function findOrCreateAgentByGoogle(profile: GoogleAgentProfile): Promise<Agent> {
  const email = (profile.email ?? "").trim().toLowerCase();
  const sub = (profile.sub ?? "").trim();
  const name = (profile.name ?? "").trim();

  return updateDB((db) => {
    // 1. Returning agent by Google sub (stable primary link).
    let agent = sub
      ? db.agents.find((a) => (a.googleSub ?? "") === sub)
      : undefined;
    if (agent) {
      if (email && !agent.googleEmail) agent.googleEmail = email; // back-fill link
      return agent;
    }

    // 2. Returning agent by linked googleEmail — link the sub the first time.
    agent = email
      ? db.agents.find((a) => (a.googleEmail ?? "").trim().toLowerCase() === email)
      : undefined;
    if (agent) {
      if (sub && !agent.googleSub) agent.googleSub = sub;
      return agent;
    }

    // 3. Adopt a seed/legacy row whose `contact` IS this e-mail (conservative).
    //    Only when contact clearly looks like an e-mail and the row is not already
    //    linked to a different Google identity.
    if (email) {
      agent = db.agents.find((a) => {
        const contact = (a.contact ?? "").trim().toLowerCase();
        return contact === email && isEmail(contact) && !a.googleEmail;
      });
      if (agent) {
        agent.googleEmail = email;
        if (sub && !agent.googleSub) agent.googleSub = sub;
        return agent;
      }
    }

    // 4. Provision a fresh Agent row with a stable `agent:` id.
    const seed = email || sub || crypto.randomUUID();
    const created: Agent = {
      id: stableAgentId(seed),
      orgName: name || (email ? orgFromEmail(email) : "") || "Agent",
      contact: email || sub || "",
      createdAt: new Date().toISOString(),
      googleEmail: email || null,
      googleSub: sub || null,
    };
    db.agents.push(created);
    return created;
  });
}
