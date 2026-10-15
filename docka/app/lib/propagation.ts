// Enter-once cross-agency propagation (#38) — SERVER module (setPropagation writes via
// transact). The projection + consent copy are pure; they are only imported server-side
// (the choke point in agentData.ts and the routes), so this file may value-import db.ts.
//
// What propagates is ONLY `Seafarer.selfProfile` (the personal overlay). Documents ALWAYS
// follow the grant unchanged — only the overlay is gated — so defaulting propagation OFF
// is privacy-correct and touches NO document visibility. `comments` / `profileChanges` are
// separate top-level collections and can NEVER propagate under #38 (#38.6).

import {
  transact,
  id,
  AUDIT_NO_IMPERSONATION,
  type AccessGrant,
  type AuditOnBehalf,
  type ProfileShareRequest,
} from "@/lib/db";
import type { SeafarerProfile } from "@/lib/self-service";

// The two independent consent buckets (#38.2). Keys reuse SELF_SERVICE_FIELDS so they
// can't drift from the editable registry.
export const CONTACT_FIELDS = ["phone", "email", "address"] as const;
export const FINANCIAL_FIELDS = [
  "bankName",
  "bankAccount",
  "bankSwift",
  "nextOfKinName",
  "nextOfKinRelation",
  "nextOfKinPhone",
] as const;

export type PropagationBucket = "contact" | "financial";

/**
 * Project a seaman's self-profile overlay for ONE grant: return ONLY the buckets whose
 * flag is true. Both false (the opt-out default) => undefined, so a fresh grant sees no
 * personal overlay at all. Tolerant of a legacy grant with the flags absent (read as false).
 */
export function projectSelfProfileForGrant(
  sp: SeafarerProfile | undefined,
  g: Pick<AccessGrant, "propagateContact" | "propagateFinancial">
): SeafarerProfile | undefined {
  if (!sp) return undefined;
  const contact = g.propagateContact === true;
  const financial = g.propagateFinancial === true;
  if (!contact && !financial) return undefined;
  const out: SeafarerProfile = {};
  if (contact) for (const k of CONTACT_FIELDS) if (k in sp) out[k] = sp[k];
  if (financial) for (const k of FINANCIAL_FIELDS) if (k in sp) out[k] = sp[k];
  return out;
}

/**
 * #38.5 — the seaman-facing view of an agent-raised pending propagation request,
 * enriched with the requesting agency's display name.
 */
export type PendingPropagationRequestView = {
  id: string;
  agentId: string;
  orgName: string;
  bucket: PropagationBucket;
  requestedBy: string;
};

/**
 * #38.5 — project the seaman's PENDING propagation requests into the client shape, for
 * ONE seafarer, enriched with each requesting agency's org name. Pure: it takes db slices
 * as arguments and reads nothing global. This is the SINGLE source of truth shared by BOTH
 * the ?token= (api/seafarers) and the signed-in /me (api/seafarers/me) paths, so the two
 * entry points can never drift — a signed-in seaman and a token-link seaman see the same
 * pending-request cards.
 */
export function pendingPropagationRequestsForSeafarer(
  seafarerId: string,
  requests: ProfileShareRequest[],
  agents: { id: string; orgName: string }[]
): PendingPropagationRequestView[] {
  const orgNameFor = (agentId: string) =>
    agents.find((a) => a.id === agentId)?.orgName ?? agentId;
  return requests
    .filter((r) => r.seafarerId === seafarerId && r.status === "pending")
    .map((r) => ({
      id: r.id,
      agentId: r.agentId,
      orgName: orgNameFor(r.agentId),
      bucket: r.bucket,
      requestedBy: r.requestedBy,
    }));
}

/** Plain-language consent copy (#38.3) — the exact strings the seaman sees. */
export function consentSentence(agencyName: string, bucket: PropagationBucket): string {
  if (bucket === "contact") {
    return `Share your name, contact details and CV with ${agencyName}? Your bank details and emergency family contact stay private unless you separately allow them.`;
  }
  return `Also share your bank details and emergency family contact with ${agencyName}? Only do this if they handle your wages.`;
}

/** Honest revoke copy (#38.4) — shown on toggle-off confirm. */
export function revokeSentence(agencyName: string): string {
  return `Stopping sharing hides this from ${agencyName} from now on. It cannot un-see or delete what they already viewed or saved.`;
}

/**
 * Seaman-controlled propagation write (#38). Flips the per-grant bucket flag and emits a
 * PROPAGATION_GRANTED / PROPAGATION_WITHDRAWN consent event when the value actually changes.
 * Fail-closed on a missing grant. Runs in one transact (db write + audit append share the
 * critical section). `actor` is an id reference ("seafarer:<id>"), never a name.
 */
export function setPropagation(
  seafarerId: string,
  agentId: string,
  bucket: PropagationBucket,
  on: boolean,
  actor: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; grant?: AccessGrant }> {
  const key = bucket === "contact" ? "propagateContact" : "propagateFinancial";
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const grant =
      db.accessGrants.find((g) => g.seafarerId === seafarerId && g.agentId === agentId) ?? null;
    if (!grant) return { ok: false, reason: "no grant" };
    const before = grant[key] ?? false;
    if (before === on) return { ok: true, grant: { ...grant } }; // no-op, no spurious event
    grant[key] = on;
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: on ? "PROPAGATION_GRANTED" : "PROPAGATION_WITHDRAWN",
      legalBasisAfter: null,
      actor,
      bucket,
    });
    return { ok: true, grant: { ...grant } };
  }, onBehalf);
}

/**
 * #42 — seaman-controlled per-agency client-portal visibility toggle. Flips
 * `AccessGrant.clientVisible` and emits a CLIENT_VISIBLE_GRANTED / _WITHDRAWN consent
 * event when the value actually changes (grant-scoped, so it carries a grantId).
 * Fail-closed on a missing grant. One transact (db write + audit append share the
 * critical section). `actor` is an id reference ("seafarer:<id>"), never a name.
 */
export function setClientVisible(
  seafarerId: string,
  agentId: string,
  on: boolean,
  actor: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; grant?: AccessGrant }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const grant =
      db.accessGrants.find((g) => g.seafarerId === seafarerId && g.agentId === agentId) ?? null;
    if (!grant) return { ok: false, reason: "no grant" };
    const before = grant.clientVisible ?? false;
    if (before === on) return { ok: true, grant: { ...grant } }; // no-op, no spurious event
    grant.clientVisible = on;
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: on ? "CLIENT_VISIBLE_GRANTED" : "CLIENT_VISIBLE_WITHDRAWN",
      legalBasisAfter: null,
      actor,
    });
    return { ok: true, grant: { ...grant } };
  }, onBehalf);
}
