// FAIL-CLOSED data access for agents. This module is the ONLY way to read
// seafarer / document / log data on behalf of an agent. Every function:
//   - takes an agentId and returns ONLY rows the agent has a live grant for
//     (DEFAULT-DENY: no ACTIVE/LOCKED grant => empty/null, NEVER the full set);
//   - re-checks grant status LIVE on every call (TOCTOU-safe: a mid-session revoke
//     makes the very next call return nothing/404, not stale data);
//   - resolves a documentRef ONLY via a db lookup scoped to the grant — NEVER a
//     path-join — and rejects traversal / null-byte / foreign / missing refs as a
//     hard 404 with no disk read.
// Raw collection reads (db.seafarers, db.documents, ...) are NOT exported here, so
// no agent route can accidentally bypass the grant filter.

import {
  readDB,
  readAccessLog,
  AUDIT_NO_IMPERSONATION,
  type Seafarer,
  type Doc,
  type AccessLogEntry,
  type AccessGrant,
  type AuditOnBehalf,
} from "@/lib/db";
import { checkAccess, readableSeafarerIds, logAccess } from "@/lib/access";
import { activeDocs } from "@/lib/archive";
import { projectSelfProfileForGrant } from "@/lib/propagation";

/**
 * A documentRef is an OPAQUE document ID (uuid shape). Anything else — a path, a
 * traversal sequence, a null byte, a percent-encoded dot — can never be a real ID
 * and is rejected BEFORE any lookup, so a crafted ref can't reach the filesystem.
 */
function isSafeId(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  if (ref.length === 0 || ref.length > 200) return false;
  // uuids and our short ids are [A-Za-z0-9-] only. This rejects "/", "\", "..",
  // "%2e", "%00", null bytes, and any foreign path shape by construction.
  return /^[A-Za-z0-9-]+$/.test(ref);
}

/**
 * Seafarers this agent may currently read. Default-deny.
 *
 * PER-AGENT STAGE OVERRIDE (choke point): each returned row's `state` is replaced by
 * the acting agent's own `grant.stage` (B.1), so every downstream agent surface
 * (board grouping, problems filter, circulars, talent search, export, analytics,
 * inspection) reads the per-tenant stage with no further edits. Two agents viewing
 * the same seaman see independent columns. `grant?.stage ?? "review"` (F4) means a
 * row with no grant for this agent (impossible on this path — `allowed` came from
 * this agent's grants — but guarded) yields "review", never a throw. The grant index
 * is built ONCE per call (F8).
 *
 * Bug1 — `includeHidden` (DEFAULT true): per-agent board-hidden crew (`hiddenByAgentAt`
 * set) are now excluded EVERYWHERE by callers passing `false` — the board render (agent
 * dashboard + default `GET /api/seafarers`), CSV exports (`GET /api/export`), inspection
 * dossier, talent search, single-agent view, analytics, vacancies, portals (page + API),
 * circulars (settings roster + sends), reminders, and bulk actions all drop hidden crew
 * from both viewing AND notification/action reach. The ONLY surface that still passes the
 * default `true` is the dedicated "Hidden crew" panel (`?view=hidden` /
 * `listHiddenSeafarersForAgent`) and the invite-link re-add path used to restore them.
 * Hide never revokes the grant: it stays ACTIVE and hidden ids remain in
 * `readableSeafarerIds`, so un-hiding fully restores reach.
 */
export function listSeafarersForAgent(agentId: string, includeHidden = true): Seafarer[] {
  const db = readDB();
  const allowed = readableSeafarerIds(agentId, db);
  const grantByPair = new Map<string, AccessGrant>();
  for (const g of db.accessGrants) grantByPair.set(`${g.seafarerId}::${g.agentId}`, g);
  return db.seafarers
    .filter((s) => {
      if (!allowed.has(s.id)) return false;
      if (!includeHidden && grantByPair.get(`${s.id}::${agentId}`)?.hiddenByAgentAt) return false;
      return true;
    })
    .map((s) => {
      const grant = grantByPair.get(`${s.id}::${agentId}`);
      return {
        ...s,
        state: grant?.stage ?? "review",
        // #38 propagation gate: replace the personal overlay with only the buckets this
        // agency was granted (both off / no grant => undefined). Docs are untouched.
        selfProfile: grant
          ? projectSelfProfileForGrant(s.selfProfile, grant)
          : undefined,
      };
    });
}

/**
 * Bug1 — the agent's OWN board-hidden crew (grant ACTIVE but `hiddenByAgentAt` set), for
 * the "Hidden crew" panel + `GET /api/seafarers?view=hidden`. Same grant-scoped
 * default-deny + per-agent stage/propagation projection as `listSeafarersForAgent`.
 */
export function listHiddenSeafarersForAgent(agentId: string): Seafarer[] {
  const db = readDB();
  const allowed = readableSeafarerIds(agentId, db);
  const grantByPair = new Map<string, AccessGrant>();
  for (const g of db.accessGrants) grantByPair.set(`${g.seafarerId}::${g.agentId}`, g);
  return db.seafarers
    .filter((s) => allowed.has(s.id) && !!grantByPair.get(`${s.id}::${agentId}`)?.hiddenByAgentAt)
    .map((s) => {
      const grant = grantByPair.get(`${s.id}::${agentId}`);
      return {
        ...s,
        state: grant?.stage ?? "review",
        selfProfile: grant ? projectSelfProfileForGrant(s.selfProfile, grant) : undefined,
      };
    });
}

/**
 * A single seafarer + their documents FOR an agent, or null if the agent has no
 * live grant. Opening a single-seaman review is a REVIEW-level action, so it is
 * logged to the tamper-evident sink in this same request (unless `log:false`, e.g.
 * an internal completeness check).
 */
export function getSeafarerForAgent(
  agentId: string,
  seafarerId: string,
  opts: { log?: boolean; onBehalf?: AuditOnBehalf } = {}
): { seafarer: Seafarer; documents: Doc[] } | null {
  if (!isSafeId(seafarerId)) return null;
  const { allowed, grant } = checkAccess(agentId, seafarerId);
  if (!allowed) return null;
  const db = readDB();
  const found = db.seafarers.find((s) => s.id === seafarerId) ?? null;
  if (!found) return null;
  // Per-agent stage override (B.1 / F4): reflect the acting agent's grant.stage. #38:
  // the personal overlay is gated to the granted propagation buckets (both off => undefined).
  const seafarer: Seafarer = {
    ...found,
    state: grant?.stage ?? "review",
    selfProfile: grant ? projectSelfProfileForGrant(found.selfProfile, grant) : undefined,
  };
  // ACTIVE docs only — archived (retired) docs are excluded from the agent view so
  // they never count toward completeness / validity / sea-readiness.
  const documents = activeDocs(db.documents.filter((d) => d.seafarerId === seafarerId));
  if (opts.log !== false) {
    void logAccess(
      seafarerId,
      agentId,
      grant?.id ?? null,
      "REVIEWED",
      null,
      opts.onBehalf ?? AUDIT_NO_IMPERSONATION
    );
  }
  return { seafarer, documents };
}

/** Documents for a seafarer, grant-filtered. Empty when the agent has no access. */
export function getDocumentsForAgent(agentId: string, seafarerId: string): Doc[] {
  if (!isSafeId(seafarerId)) return [];
  const { allowed } = checkAccess(agentId, seafarerId);
  if (!allowed) return [];
  // ACTIVE docs only — archived docs do not count as on-file for an agent.
  return activeDocs(readDB().documents.filter((d) => d.seafarerId === seafarerId));
}

/**
 * Resolve ONE document for an agent by its ID, scoped to a live grant. Returns null
 * (=> the caller should 404) for a traversal/null-byte/foreign/missing/unauthorised
 * ref — WITHOUT touching the filesystem. On success it is a DOWNLOAD-level action
 * and is logged. The returned Doc carries `fileName`; the file route must still
 * serve strictly by that field, never by the raw ref.
 */
export function resolveDocumentForAgent(
  agentId: string,
  documentRef: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Doc | null {
  if (!isSafeId(documentRef)) return null;
  const db = readDB();
  const doc = db.documents.find((d) => d.id === documentRef) ?? null;
  if (!doc) return null; // missing / foreign id — 404, no disk read
  const { allowed, grant } = checkAccess(agentId, doc.seafarerId);
  if (!allowed) return null; // agent has no live grant to this doc's owner
  void logAccess(doc.seafarerId, agentId, grant?.id ?? null, "DOWNLOADED", doc.id, onBehalf);
  return doc;
}

/**
 * Explicitly record a review/confirm action (e.g. the agent confirmed a document
 * in the viewer). Fail-closed: logs nothing if the agent has no live grant.
 */
export function recordReview(
  agentId: string,
  seafarerId: string,
  documentId: string | null = null,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): boolean {
  if (!isSafeId(seafarerId)) return false;
  if (documentId !== null && !isSafeId(documentId)) return false;
  const { allowed, grant } = checkAccess(agentId, seafarerId);
  if (!allowed) return false;
  void logAccess(seafarerId, agentId, grant?.id ?? null, "REVIEWED", documentId, onBehalf);
  return true;
}

/** An agent's OWN access-log entries (their activity), for a settings/audit view. */
export function accessLogForAgent(agentId: string): AccessLogEntry[] {
  return readAccessLog().filter((e) => e.agentId === agentId);
}
