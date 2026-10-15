// Consent-based access lifecycle for the multi-tenant model. This is the ONLY
// place grant state transitions, the sea-lock, and the audit sinks are written.
// It never returns seafarer/document PAYLOADS — that is lib/agentData.ts's job,
// which calls the read helpers here to decide visibility. Owner decisions this
// implements (see the plan's "Decisions locked"):
//   D1 — file store now, pinned to ONE process; all writes via db.ts's mutex.
//   D2 — HARD, pre-disclosed sea-lock: while a live assignment exists the grant
//        CANNOT be revoked; legal basis flips CONSENT -> CONTRACT + legal
//        obligation (MLC 2006 / flag-state crew-certification duty), recorded as a
//        BASIS_CHANGED consent event. A MAX-LOCK backstop only ALERTS / forces an
//        explicit audited close — a real active assignment ALWAYS beats the cap.
//   D3 — medical gating is OFF (no health-data role here).

import {
  readDB,
  transact,
  appendAudit,
  readAccessLog,
  readConsentEvents,
  id,
  shareToken,
  AUDIT_NO_IMPERSONATION,
  type AuditOnBehalf,
  type DB,
  type AccessGrant,
  type Assignment,
  type GrantStatus,
  type LegalBasis,
  type AccessAction,
  type AccessLogEntry,
  type AuditSink,
  type ConsentEvent,
  type ConsentEventType,
} from "@/lib/db";
import { archiveBeforeDelete } from "@/lib/delete-archive";
import {
  requiredSetFor,
  snapshotRequiredSet,
  defaultConfigFor,
} from "@/lib/required-docs";
import { STATE_LABELS, type SeafarerState } from "@/lib/pipeline";
import { isClaimed } from "@/lib/claim-state"; // type-only dep on db.ts → no cycle; no token symbol (F5)

// MAX-LOCK backstop (owner D2): a never-closed assignment must not lock personal
// data forever. The cap does NOT silently unlock a live assignment — it only
// raises `overCap` (an alert) and enables `forceCloseAssignment` (an explicit,
// audited close). Configurable via env; defaults to 270 days (~ a long contract).
export const MAX_LOCK_DAYS = Number(process.env.MAX_LOCK_DAYS ?? 270);
const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses at which an agent may actually READ a seafarer's data (default-deny:
// anything not in this set = no access).
const READABLE: ReadonlySet<GrantStatus> = new Set<GrantStatus>(["ACTIVE", "LOCKED"]);

export function isReadableStatus(status: GrantStatus): boolean {
  return READABLE.has(status);
}

// ---- Assignment / lock helpers ----------------------------------------

/** Live assignments (returnedAt === null) for a (seafarer, agent) pair. */
export function activeAssignmentsFor(
  seafarerId: string,
  agentId: string,
  assignments: Assignment[]
): Assignment[] {
  return assignments.filter(
    (a) => a.seafarerId === seafarerId && a.agentId === agentId && a.returnedAt === null
  );
}

/** The sea-lock predicate: LOCKED iff ANY live assignment exists for the pair. */
export function hasActiveAssignment(
  seafarerId: string,
  agentId: string,
  assignments: Assignment[]
): boolean {
  return activeAssignmentsFor(seafarerId, agentId, assignments).length > 0;
}

export type EffectiveGrant = {
  status: GrantStatus;
  effectiveLegalBasis: LegalBasis;
  /** True when a live assignment has exceeded MAX_LOCK_DAYS — an alert, NOT an unlock. */
  overCap: boolean;
  /** IDs of the live assignments causing the lock (for the transparency view). */
  lockedByAssignmentIds: string[];
};

/**
 * Derive the REQUEST-TIME status of a grant. LOCKED and EXPIRED are never stored;
 * they are computed here so a stale flag can't diverge from reality:
 *   - a live assignment  => LOCKED (beats everything; expiry is SUPPRESSED while
 *     locked and resolves only on unlock), legal basis = CONTRACT_LEGAL_OBLIGATION.
 *   - else REVOKED       => REVOKED.
 *   - else past expiresAt => EXPIRED.
 *   - else the stored base (PENDING / ACTIVE / EXPIRED), basis = CONSENT.
 */
export function effectiveGrantStatus(
  grant: AccessGrant,
  assignments: Assignment[],
  now: number = Date.now()
): EffectiveGrant {
  const live = activeAssignmentsFor(grant.seafarerId, grant.agentId, assignments);
  if (live.length > 0) {
    const overCap = live.some((a) => now - new Date(a.sentToSeaAt).getTime() > MAX_LOCK_DAYS * DAY_MS);
    return {
      status: "LOCKED",
      effectiveLegalBasis: "CONTRACT_LEGAL_OBLIGATION",
      overCap,
      lockedByAssignmentIds: live.map((a) => a.id),
    };
  }
  if (grant.status === "REVOKED") {
    return { status: "REVOKED", effectiveLegalBasis: "CONSENT", overCap: false, lockedByAssignmentIds: [] };
  }
  const expired =
    grant.status === "EXPIRED" ||
    (grant.expiresAt != null && new Date(grant.expiresAt).getTime() <= now);
  if (expired) {
    return { status: "EXPIRED", effectiveLegalBasis: "CONSENT", overCap: false, lockedByAssignmentIds: [] };
  }
  return {
    status: grant.status, // PENDING or ACTIVE
    effectiveLegalBasis: "CONSENT",
    overCap: false,
    lockedByAssignmentIds: [],
  };
}

// ---- Read helpers (no PII — grants + derived status only) --------------

export function findGrant(db: DB, seafarerId: string, agentId: string): AccessGrant | null {
  return db.accessGrants.find((g) => g.seafarerId === seafarerId && g.agentId === agentId) ?? null;
}

/** LIVE, per-request grant check (TOCTOU-safe): reads fresh state every call. */
export function checkAccess(
  agentId: string,
  seafarerId: string
): { allowed: boolean; grant: AccessGrant | null; effective: EffectiveGrant | null } {
  const db = readDB();
  const grant = findGrant(db, seafarerId, agentId);
  if (!grant) return { allowed: false, grant: null, effective: null };
  const effective = effectiveGrantStatus(grant, db.assignments);
  return { allowed: isReadableStatus(effective.status), grant, effective };
}

/** Every seafarerId an agent may currently read (default-deny). */
export function readableSeafarerIds(agentId: string, db: DB = readDB()): Set<string> {
  const out = new Set<string>();
  for (const g of db.accessGrants) {
    if (g.agentId !== agentId) continue;
    const eff = effectiveGrantStatus(g, db.assignments);
    if (isReadableStatus(eff.status)) out.add(g.seafarerId);
  }
  return out;
}

// ---- Consent-event + access-log writers -------------------------------

function actorSeafarer(seafarerId: string): string {
  return `seafarer:${seafarerId}`;
}
function actorAgent(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * Record an agent access event to the tamper-evident sink. IDs/refs ONLY — never
 * PII. Called by lib/agentData.ts in the SAME request that serves the data, so it
 * cannot be bypassed. `documentRef` is a document ID, never its contents.
 */
export function logAccess(
  seafarerId: string,
  agentId: string,
  grantId: string | null,
  action: AccessAction,
  documentRef: string | null = null,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<unknown> {
  return appendAudit(
    "access-log",
    {
      id: id(),
      at: new Date().toISOString(),
      seafarerId,
      agentId,
      grantId,
      action,
      documentRef,
    },
    onBehalf
  );
}

// ---- Grant lifecycle ---------------------------------------------------

/**
 * Fresh seafarer approval — creates a grant ACTIVE, or (the reopen path) explicitly
 * re-approves a REVOKED/EXPIRED one. Enforces UNIQUE(seafarerId, agentId) INSIDE
 * the critical section. This IS the "fresh explicit seafarer approval" the reopen
 * guard requires; an agent merely opening a stale link (see `openGrantLink`) can
 * never trigger it.
 */
export function grantAccess(
  input: {
    seafarerId: string;
    agentId: string;
    scope?: AccessGrant["scope"];
    expiresAt?: string | null;
  },
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ grant: AccessGrant; created: boolean; reactivated: boolean }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const existing = findGrant(db, input.seafarerId, input.agentId);
    if (existing) {
      // Uniqueness holds: never a second row for the pair.
      if (existing.status === "REVOKED" || existing.status === "EXPIRED") {
        // Fresh approval reactivates: new rotating token, consent basis reset.
        existing.status = "ACTIVE";
        existing.legalBasis = "CONSENT";
        existing.shareToken = shareToken();
        existing.grantedAt = nowIso;
        existing.revokedAt = null;
        // A re-approved grant restarts at Review; the reactivation is itself a stage
        // change, so stamp stageUpdatedAt fresh (A.1).
        existing.stage = "review";
        existing.stageUpdatedAt = Date.now();
        if (input.expiresAt !== undefined) existing.expiresAt = input.expiresAt;
        if (input.scope) existing.scope = input.scope;
        audit("consent-events", {
          id: id(),
          at: nowIso,
          grantId: existing.id,
          type: "GRANTED",
          legalBasisAfter: "CONSENT",
          actor: actorSeafarer(input.seafarerId),
        });
        return { grant: { ...existing }, created: false, reactivated: true };
      }
      return { grant: { ...existing }, created: false, reactivated: false };
    }
    // #38 enter-once: a new grant inherits the seaman's propagation DEFAULTS (both
    // false unless the seaman opted in). "Auto-populate" = the SAME canonical overlay
    // becoming visible — no data copy. Default false => the new agency sees docs but no
    // personal overlay until the seaman opts in.
    const seaman = db.seafarers.find((s) => s.id === input.seafarerId) ?? null;
    const propagateContact = seaman?.propagateContactByDefault ?? false;
    const propagateFinancial = seaman?.propagateFinancialByDefault ?? false;
    const grant: AccessGrant = {
      id: id(),
      seafarerId: input.seafarerId,
      agentId: input.agentId,
      status: "ACTIVE",
      legalBasis: "CONSENT",
      scope: input.scope ?? ["profile", "documents", "log"],
      shareToken: shareToken(),
      grantedAt: nowIso,
      revokedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso,
      // Every new grant starts at Review, stamped now (A.1).
      stage: "review",
      stageUpdatedAt: Date.now(),
      propagateContact,
      propagateFinancial,
    };
    db.accessGrants.push(grant);
    // Emit a PROPAGATION_GRANTED consent event per bucket that starts true.
    for (const bucket of ["contact", "financial"] as const) {
      if (bucket === "contact" ? propagateContact : propagateFinancial) {
        audit("consent-events", {
          id: id(),
          at: nowIso,
          grantId: grant.id,
          type: "PROPAGATION_GRANTED",
          legalBasisAfter: null,
          actor: actorSeafarer(input.seafarerId),
          bucket,
        });
      }
    }
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: "REQUESTED",
      legalBasisAfter: "CONSENT",
      actor: actorSeafarer(input.seafarerId),
    });
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: "GRANTED",
      legalBasisAfter: "CONSENT",
      actor: actorSeafarer(input.seafarerId),
    });
    return { grant, created: true, reactivated: false };
  }, onBehalf);
}

/**
 * An agent opens a per-grant share link. This does NOT constitute seafarer
 * approval: a REVOKED/EXPIRED grant is NOT reactivated — the attempt is logged as
 * REOPEN_DENIED and the caller must ask the seafarer to re-approve (grantAccess).
 * A PENDING grant activates (first open). ACTIVE/LOCKED just proceed.
 */
export function openGrantLink(
  token: string,
  actorId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; grant: AccessGrant | null; status: GrantStatus | null; reopenDenied: boolean }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const grant = db.accessGrants.find((g) => g.shareToken === token) ?? null;
    if (!grant) return { ok: false, grant: null, status: null, reopenDenied: false };
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (eff.status === "REVOKED" || eff.status === "EXPIRED") {
      audit("consent-events", {
        id: id(),
        at: nowIso,
        grantId: grant.id,
        type: "REOPEN_DENIED",
        legalBasisAfter: null,
        actor: actorAgent(actorId),
      });
      return { ok: false, grant: { ...grant }, status: eff.status, reopenDenied: true };
    }
    if (grant.status === "PENDING") {
      grant.status = "ACTIVE";
      grant.grantedAt = nowIso;
      audit("consent-events", {
        id: id(),
        at: nowIso,
        grantId: grant.id,
        type: "GRANTED",
        legalBasisAfter: "CONSENT",
        actor: actorSeafarer(grant.seafarerId),
      });
    }
    return { ok: true, grant: { ...grant }, status: effectiveGrantStatus(grant, db.assignments).status, reopenDenied: false };
  }, onBehalf);
}

/**
 * The revoke EFFECT, shared by `revokeGrant` (seafarer WITHDRAWN) and
 * `deleteFromBoard` (agent REVOKED_BY_AGENT). Runs INSIDE an already-open transact
 * critical section — it never opens its own. Flips the base to REVOKED, stamps
 * revokedAt, ROTATES the share token so the old link is dead, optionally clears the
 * board-hidden flag, and drafts the consent event.
 */
function revokeGrantCore(
  db: DB,
  audit: (sink: AuditSink, core: Record<string, unknown>) => void,
  grant: AccessGrant,
  opts: { eventType: ConsentEventType; actor: string; clearHidden?: boolean }
): void {
  const nowIso = new Date().toISOString();
  grant.status = "REVOKED";
  grant.revokedAt = nowIso;
  grant.shareToken = shareToken(); // rotate: kill the old link
  if (opts.clearHidden) grant.hiddenByAgentAt = null;
  audit("consent-events", {
    id: id(),
    at: nowIso,
    grantId: grant.id,
    type: opts.eventType,
    legalBasisAfter: "CONSENT",
    actor: opts.actor,
  });
}

/**
 * Seafarer withdraws access. HARD sea-lock: blocked while LOCKED (a live
 * assignment). On success the base flips to REVOKED and the share token ROTATES so
 * the old link is dead. Recorded as WITHDRAWN.
 */
export function revokeGrant(
  grantId: string,
  actorId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; blocked: boolean; reason?: string; grant: AccessGrant | null }> {
  return transact((db, audit) => {
    const grant = db.accessGrants.find((g) => g.id === grantId) ?? null;
    if (!grant) return { ok: false, blocked: false, reason: "not found", grant: null };
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (eff.status === "LOCKED") {
      return {
        ok: false,
        blocked: true,
        reason:
          "Access is locked while you are at sea under this agent and cannot be withdrawn until you return (MLC 2006 / flag-state crew-certification obligation, pre-disclosed at grant).",
        grant: { ...grant },
      };
    }
    // #16 — stage gate (server-authoritative): even when NO live assignment forces a
    // LOCKED status (e.g. the agency has moved the seaman to "returning"/coming-back,
    // which closes the assignment), withdrawal stays blocked while the agency's stored
    // stage is sent_to_sea or returning. Gate on grant.stage, alongside the LOCKED
    // check above (harmless overlap while sent_to_sea is also live-locked).
    if (grant.stage === "sent_to_sea" || grant.stage === "returning") {
      return {
        ok: false,
        blocked: true,
        reason:
          "You can't withdraw access while you are at sea or on your way back to shore under this agent. You'll be able to withdraw it once the voyage is closed.",
        grant: { ...grant },
      };
    }
    revokeGrantCore(db, audit, grant, {
      eventType: "WITHDRAWN",
      actor: actorSeafarer(grant.seafarerId),
    });
    return { ok: true, blocked: false, grant: { ...grant } };
  }, onBehalf);
}

/**
 * #15 — seaman re-grants a previously REVOKED agent (direct, unilateral restore).
 * Mirrors `revokeGrant`'s shape and reactivates the grant IN PLACE, reusing the exact
 * reactivation effect from `grantAccess`'s reopen path: base flips back to ACTIVE,
 * legal basis reset to CONSENT, the share token ROTATES (a fresh link), grantedAt is
 * re-stamped, revokedAt cleared, and the pipeline restarts at "review" (stamped now).
 * Recorded as a GRANTED consent event with the seaman as actor.
 *
 * Guard: ONLY a grant whose STORED base status is "REVOKED" can be re-granted. An
 * ACTIVE/PENDING grant is a no-op reject (nothing to restore); EXPIRED is out of scope
 * (retention has elapsed — the seaman must re-approve via grantAccess). Non-REVOKED
 * grants return { ok:false } with a clear reason and are left untouched.
 */
export function regrantGrant(
  grantId: string,
  actorId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; grant: AccessGrant | null }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const grant = db.accessGrants.find((g) => g.id === grantId) ?? null;
    if (!grant) return { ok: false, reason: "not found", grant: null };
    if (grant.status !== "REVOKED") {
      return {
        ok: false,
        reason: `Only a withdrawn (revoked) grant can be re-granted; this grant is ${grant.status}.`,
        grant: { ...grant },
      };
    }
    // Exact reactivation effect (mirrors grantAccess:214-238).
    grant.status = "ACTIVE";
    grant.legalBasis = "CONSENT";
    grant.shareToken = shareToken(); // rotate: a fresh link for the re-granted agent
    grant.grantedAt = nowIso;
    grant.revokedAt = null;
    grant.stage = "review";
    grant.stageUpdatedAt = Date.now();
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: "GRANTED",
      legalBasisAfter: "CONSENT",
      actor: actorSeafarer(grant.seafarerId),
    });
    return { ok: true, grant: { ...grant } };
  }, onBehalf);
}

/**
 * Bug1 — per-agent BOARD hide / restore. This is NOT a consent change and NOT an
 * access event: the grant stays ACTIVE and the seaman keeps every other agent
 * surface (reminders, circulars, inspection, export…). It ONLY sets/clears
 * `hiddenByAgentAt` and writes to the dedicated `board-events` sink (never
 * access-log — whose unfiltered tail `reviewsForSeafarer` shows to the seaman — and
 * never the consent ledger).
 *
 * Guards:
 *   - ownership: `grant.agentId === agentId` else `{error:"forbidden"}` (agent B can
 *     never hide agent A's grant).
 *   - at-sea: hiding is blocked while the pair is LOCKED / has a live (non-returned)
 *     assignment — a legally on-assignment seaman must stay in oversight. `{error:"at-sea"}`.
 * Idempotent: hiding an already-hidden (or restoring an already-visible) grant is a
 * no-op success with no duplicate event.
 */
export function setBoardHidden(
  grantId: string,
  agentId: string,
  hidden: boolean,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; error?: "not-found" | "forbidden" | "at-sea"; grant: AccessGrant | null }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const grant = db.accessGrants.find((g) => g.id === grantId) ?? null;
    if (!grant) return { ok: false, error: "not-found" as const, grant: null };
    if (grant.agentId !== agentId) return { ok: false, error: "forbidden" as const, grant: null };
    if (hidden) {
      const eff = effectiveGrantStatus(grant, db.assignments);
      if (eff.status === "LOCKED" || hasActiveAssignment(grant.seafarerId, grant.agentId, db.assignments)) {
        return { ok: false, error: "at-sea" as const, grant: { ...grant } };
      }
    }
    const already = !!grant.hiddenByAgentAt;
    if (hidden === already) return { ok: true, grant: { ...grant } }; // idempotent no-op
    grant.hiddenByAgentAt = hidden ? nowIso : null;
    audit("board-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      seafarerId: grant.seafarerId,
      agentId: grant.agentId,
      action: hidden ? "BOARD_HIDDEN" : "BOARD_RESTORED",
    });
    return { ok: true, grant: { ...grant } };
  }, onBehalf);
}

export type DeleteFromBoardResult =
  | "not-found"
  | "not-hidden"
  | "at-sea"
  | { mode: "view" | "hard"; files: string[] };

/**
 * Hidden-crew DELETE — an agent removes a board-HIDDEN seaman for good. ONE transact;
 * the whole decision table is re-checked on the fresh db inside the mutex:
 *   - no grant for the pair, or the caller's grant is effectively REVOKED/EXPIRED
 *     => "not-found" (a stale/revoked grant can never delete);
 *   - grant not board-hidden => "not-hidden" (the UI only offers Delete on hidden rows);
 *   - ANY live assignment for the seaman under ANY agency (GLOBAL sweep — a man at sea
 *     under agency B must survive agency A's delete), or the caller's own stage is
 *     sent_to_sea/returning => "at-sea";
 *   - claimed (`isClaimed`: googleSub / ownerEmail / credentialUserId, trimmed — or
 *     legacy-truthy — or sample) OR another agency holds a live (ACTIVE/PENDING/
 *     LOCKED) grant OR the caller is NOT the profile's creator => VIEW-ONLY removal:
 *     the caller's grant is revoked via `revokeGrantCore` (REVOKED_BY_AGENT, agent
 *     actor, hidden flag cleared so a seaman-side re-grant lands VISIBLE) — the
 *     profile itself is untouched. Creator = `seafarer.createdByAgentId` matches, or
 *     (legacy rows without the stamp) the caller's grant is the STRICTLY earliest
 *     ever created for this sid — ties/missing timestamps fail toward view-only;
 *   - otherwise (unclaimed, sole live grant, caller-created) => HARD delete: the full record +
 *     every child row is archived via `archiveBeforeDelete` (no archive line => no
 *     deletion), then erased from db.json — including OTHER agencies' dead
 *     (REVOKED/EXPIRED) grants and historic voyage rows for this sid (history
 *     survives in the sinks + the archive). notifications/impersonations are
 *     retained; NDJSON sinks are never edited. Returns the upload files to move.
 * Both modes append a BOARD_DELETED board event in the same transact.
 */
export function deleteFromBoard(
  seafarerId: string,
  agentId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<DeleteFromBoardResult> {
  const nowIso = new Date().toISOString();
  return transact((db, audit): DeleteFromBoardResult => {
    const grant = findGrant(db, seafarerId, agentId);
    if (!grant) return "not-found";
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (eff.status === "REVOKED" || eff.status === "EXPIRED") return "not-found";
    if (!grant.hiddenByAgentAt) return "not-hidden";
    // GLOBAL at-sea sweep (NOT pair-scoped): a live assignment under ANY agency blocks.
    const anyLive = db.assignments.some(
      (a) => a.seafarerId === seafarerId && a.returnedAt === null
    );
    if (anyLive || grant.stage === "sent_to_sea" || grant.stage === "returning") {
      return "at-sea";
    }
    const seafarer = db.seafarers.find((s) => s.id === seafarerId) ?? null;
    if (!seafarer) return "not-found";
    // Public Sample Profiles belt-and-braces: a sample row behaves as CLAIMED here,
    // so an agent's hidden-crew delete can only ever remove it from their OWN board
    // (view-only revoke) — the seeded public flagship can never be hard-deleted,
    // which would 404 the indexed public pages until reseed.
    // R2-3 — unified with isClaimed (canonical: googleSub / ownerEmail /
    // credentialUserId, trimmed) so the READ flag that picks the confirm copy
    // (api/seafarers ?view=hidden) and this WRITE decision agree. UNION with the
    // legacy truthiness so the change is STRICTLY tightening: every input that was
    // view-only stays view-only (a whitespace-only pointer that isClaimed rejects is
    // still caught by the legacy truthy check), and credentialUserId-owned rows move
    // from hard-delete to view-only. Nothing that was view-only becomes hard-deletable.
    const claimed =
      isClaimed(seafarer) ||
      !!(seafarer.googleSub || seafarer.ownerEmail) ||
      seafarer.isSample === true;
    const otherLiveGrant = db.accessGrants.some((g) => {
      if (g.seafarerId !== seafarerId || g.agentId === agentId) return false;
      const s = effectiveGrantStatus(g, db.assignments).status;
      return s === "ACTIVE" || s === "PENDING" || s === "LOCKED";
    });
    // Provenance gate: only the agency that CREATED the placeholder may hard-erase it.
    // Stamped rows compare `createdByAgentId`; legacy/unstamped rows fall back to "the
    // caller's grant is the STRICTLY earliest ever created for this sid" (incl. dead
    // grants — the creator's grant is always the first). Tie or an unparsable
    // timestamp => NOT creator => view-only.
    let callerIsCreator = false;
    if (seafarer.createdByAgentId != null) {
      callerIsCreator = seafarer.createdByAgentId === agentId;
    } else {
      const all = db.accessGrants.filter((g) => g.seafarerId === seafarerId);
      const times = all.map((g) => Date.parse(g.createdAt));
      if (all.length > 0 && times.every((t) => Number.isFinite(t))) {
        const min = Math.min(...times);
        const earliest = all.filter((_, i) => times[i] === min);
        callerIsCreator = earliest.length === 1 && earliest[0].agentId === agentId;
      }
    }
    if (claimed || otherLiveGrant || !callerIsCreator) {
      revokeGrantCore(db, audit, grant, {
        eventType: "REVOKED_BY_AGENT",
        actor: actorAgent(agentId),
        clearHidden: true,
      });
      audit("board-events", {
        id: id(),
        at: nowIso,
        grantId: grant.id,
        seafarerId,
        agentId,
        action: "BOARD_DELETED",
        mode: "view",
      });
      return { mode: "view", files: [] };
    }
    // HARD delete. Collect the upload files first (documents + both photo files).
    const docs = db.documents.filter((d) => d.seafarerId === seafarerId);
    const files: string[] = [];
    for (const d of docs) if (d.fileName) files.push(d.fileName);
    if (seafarer.verifiedPhotoFile) files.push(seafarer.verifiedPhotoFile);
    if (seafarer.customPhotoFile) files.push(seafarer.customPhotoFile);
    // Reversibility snapshot BEFORE any mutation — incl. foreign dead grants. A
    // throwing append means transact never writes: no archive line => no deletion.
    archiveBeforeDelete("hidden-crew-delete", {
      at: nowIso,
      seafarerId,
      agentId,
      seafarer,
      cascadeRows: {
        documents: docs,
        comments: db.comments.filter((c) => c.seafarerId === seafarerId),
        restHours: db.restHours.filter((r) => r.seafarerId === seafarerId),
        assignments: db.assignments.filter((a) => a.seafarerId === seafarerId),
        accessGrants: db.accessGrants.filter((g) => g.seafarerId === seafarerId),
        docRequests: db.docRequests.filter((r) => r.seafarerId === seafarerId),
        profileChanges: db.profileChanges.filter((r) => r.seafarerId === seafarerId),
        seaService: db.seaService.filter((e) => e.seafarerId === seafarerId),
        profileShareRequests: db.profileShareRequests.filter((p) => p.seafarerId === seafarerId),
        appraisals: db.appraisals.filter((a) => a.seafarerId === seafarerId),
        appraisalDeleteRequests: (db.appraisalDeleteRequests ?? []).filter(
          (r) => r.seafarerId === seafarerId
        ),
        issuedSeaTerms: db.issuedSeaTerms.filter((r) => r.seafarerId === seafarerId),
      },
      files,
    });
    // Cascade: remove every child row, strip the sid from array fields. Comments on
    // this seaman's documents ride on documentId only, so drop those by doc id too.
    const docIds = new Set(docs.map((d) => d.id));
    db.documents = db.documents.filter((d) => d.seafarerId !== seafarerId);
    db.comments = db.comments.filter(
      (c) => c.seafarerId !== seafarerId && !(c.documentId && docIds.has(c.documentId))
    );
    db.restHours = db.restHours.filter((r) => r.seafarerId !== seafarerId);
    db.assignments = db.assignments.filter((a) => a.seafarerId !== seafarerId);
    db.accessGrants = db.accessGrants.filter((g) => g.seafarerId !== seafarerId);
    db.docRequests = db.docRequests.filter((r) => r.seafarerId !== seafarerId);
    db.profileChanges = db.profileChanges.filter((r) => r.seafarerId !== seafarerId);
    db.seaService = db.seaService.filter((e) => e.seafarerId !== seafarerId);
    db.profileShareRequests = db.profileShareRequests.filter((p) => p.seafarerId !== seafarerId);
    db.appraisals = db.appraisals.filter((a) => a.seafarerId !== seafarerId);
    db.appraisalDeleteRequests = (db.appraisalDeleteRequests ?? []).filter(
      (r) => r.seafarerId !== seafarerId
    );
    db.issuedSeaTerms = db.issuedSeaTerms.filter((r) => r.seafarerId !== seafarerId);
    db.remindersSent = db.remindersSent.filter((r) => r.seafarerId !== seafarerId);
    for (const row of db.requiredDocsAudit) {
      if (row.affectedSeafarerIds.includes(seafarerId)) {
        row.affectedSeafarerIds = row.affectedSeafarerIds.filter((x) => x !== seafarerId);
      }
    }
    for (const c of db.circulars) {
      if (c.recipientIds.includes(seafarerId)) {
        c.recipientIds = c.recipientIds.filter((x) => x !== seafarerId);
      }
    }
    db.circularReplies = db.circularReplies.filter((r) => r.seafarerId !== seafarerId);
    for (const p of db.clientPortals ?? []) {
      if (p.seafarerIds.includes(seafarerId)) {
        p.seafarerIds = p.seafarerIds.filter((x) => x !== seafarerId);
      }
    }
    // notifications + impersonations are deliberately RETAINED (delivery/audit trail;
    // their readers fail closed on a vanished seafarer).
    db.seafarers = db.seafarers.filter((s) => s.id !== seafarerId);
    audit("board-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      seafarerId,
      agentId,
      action: "BOARD_DELETED",
      mode: "hard",
    });
    return { mode: "hard", files };
  }, onBehalf);
}

/**
 * Sweep grants whose retention has elapsed to EXPIRED — but NEVER one that is
 * LOCKED (expiry is suppressed at sea and resolves on unlock). Idempotent.
 */
export function expireDueGrants(
  now: number = Date.now(),
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<number> {
  const nowIso = new Date(now).toISOString();
  return transact((db, audit) => {
    let n = 0;
    for (const grant of db.accessGrants) {
      if (grant.status !== "ACTIVE") continue;
      const eff = effectiveGrantStatus(grant, db.assignments, now);
      if (eff.status === "EXPIRED") {
        grant.status = "EXPIRED";
        audit("consent-events", {
          id: id(),
          at: nowIso,
          grantId: grant.id,
          type: "EXPIRED",
          legalBasisAfter: "CONSENT",
          actor: "system",
        });
        n++;
      }
    }
    return n;
  }, onBehalf);
}

// ---- Assignment lifecycle (drives the lock) ----------------------------

/**
 * Send a seafarer to sea under an agent. Requires a readable (ACTIVE) grant. The
 * grant's legal basis flips CONSENT -> CONTRACT_LEGAL_OBLIGATION (BASIS_CHANGED)
 * and the sea-lock engages (LOCKED, derived from this live assignment).
 */
export function startAssignment(
  input: {
    seafarerId: string;
    agentId: string;
    vessel?: string | null;
    sentToSeaAt?: string;
  },
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; assignment: Assignment | null }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    // R3 — idempotency guard: if a live assignment already exists for this
    // (seafarer, agent) pair, return it instead of pushing a duplicate row /
    // emitting a second LOCKED. Makes ENTER-sent_to_sea safe to fire
    // unconditionally + concurrent double-submits collapse to one row.
    const live = activeAssignmentsFor(input.seafarerId, input.agentId, db.assignments);
    if (live.length) return { ok: true, assignment: live[0] };
    const grant = findGrant(db, input.seafarerId, input.agentId);
    if (!grant) return { ok: false, reason: "no grant", assignment: null };
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (!isReadableStatus(eff.status)) {
      return { ok: false, reason: `grant is ${eff.status}`, assignment: null };
    }
    // Freeze the required-docs set at start (single rank source of truth = the
    // seafarer profile rank; agent's config, or the baseline default) so a later
    // rank change cannot silently re-scope this voyage's requirements.
    const seafarer = db.seafarers.find((s) => s.id === input.seafarerId) ?? null;
    const config =
      db.requiredDocsConfigs.find((c) => c.agentId === input.agentId) ??
      defaultConfigFor(input.agentId, nowIso);
    const requiredSnapshot = snapshotRequiredSet(
      requiredSetFor({
        rank: seafarer?.rank ?? null,
        config,
        at: nowIso,
        vesselType: seafarer?.vesselType ?? null,
        flag: seafarer?.flagState ?? null,
      }),
      nowIso
    );
    const assignment: Assignment = {
      id: id(),
      seafarerId: input.seafarerId,
      agentId: input.agentId,
      vessel: input.vessel ?? null,
      sentToSeaAt: input.sentToSeaAt ?? nowIso,
      returnedAt: null,
      closedReason: null,
      requiredSnapshot,
      createdAt: nowIso,
    };
    db.assignments.push(assignment);
    // Pre-disclosed basis flip at lock.
    if (grant.legalBasis !== "CONTRACT_LEGAL_OBLIGATION") {
      grant.legalBasis = "CONTRACT_LEGAL_OBLIGATION";
      audit("consent-events", {
        id: id(),
        at: nowIso,
        grantId: grant.id,
        type: "BASIS_CHANGED",
        legalBasisAfter: "CONTRACT_LEGAL_OBLIGATION",
        actor: "system",
      });
    }
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: "LOCKED",
      legalBasisAfter: "CONTRACT_LEGAL_OBLIGATION",
      actor: actorAgent(input.agentId),
    });
    return { ok: true, assignment };
  }, onBehalf);
}

// Shared close routine. Only flips the grant back to CONSENT / emits UNLOCKED when
// NO other live assignment remains for the pair (overlapping assignments stay
// locked until ALL are closed).
function closeAssignmentTx(
  assignmentId: string,
  actorId: string,
  reason: "returned" | "force_closed_cap",
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; unlocked: boolean; assignment: Assignment | null }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const a = db.assignments.find((x) => x.id === assignmentId) ?? null;
    if (!a) return { ok: false, unlocked: false, assignment: null };
    if (a.returnedAt !== null) return { ok: true, unlocked: false, assignment: { ...a } };
    a.returnedAt = nowIso;
    a.closedReason = reason;
    const stillLive = activeAssignmentsFor(a.seafarerId, a.agentId, db.assignments).length > 0;
    let unlocked = false;
    if (!stillLive) {
      const grant = findGrant(db, a.seafarerId, a.agentId);
      if (grant) {
        if (grant.legalBasis !== "CONSENT") {
          grant.legalBasis = "CONSENT";
          audit("consent-events", {
            id: id(),
            at: nowIso,
            grantId: grant.id,
            type: "BASIS_CHANGED",
            legalBasisAfter: "CONSENT",
            actor: "system",
          });
        }
        audit("consent-events", {
          id: id(),
          at: nowIso,
          grantId: grant.id,
          type: "UNLOCKED",
          legalBasisAfter: "CONSENT",
          actor: reason === "force_closed_cap" ? actorAgent(actorId) : actorSeafarer(a.seafarerId),
        });
        unlocked = true;
      }
    }
    return { ok: true, unlocked, assignment: { ...a } };
  }, onBehalf);
}

/** Normal return from sea. Unlocks the grant iff no other live assignment remains. */
export function closeAssignment(
  assignmentId: string,
  actorId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
) {
  return closeAssignmentTx(assignmentId, actorId, "returned", onBehalf);
}

/**
 * The ONLY way the MAX-LOCK cap releases a live assignment: an explicit, audited
 * force-close. It never happens silently — `overCap` merely surfaces the alert.
 */
export function forceCloseAssignment(
  assignmentId: string,
  actorId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
) {
  return closeAssignmentTx(assignmentId, actorId, "force_closed_cap", onBehalf);
}

// ---- Seafarer transparency ("who reviewed me") ------------------------

export type ReviewerRow = {
  agentId: string;
  /** Human org name for the agent (from db.agents), falls back to the agentId. */
  agentName: string;
  grantId: string | null;
  status: GrantStatus | null;
  /** Last action of ANY kind (view or review) — for the "last seen" line. */
  lastAction: AccessAction | null;
  lastActionAt: string | null;
  /** Last REVIEW-LEVEL action + when, shown distinctly from a plain list view. */
  lastReviewAction: AccessAction | null;
  lastReviewAt: string | null;
  reviewCount: number;
  overCap: boolean;
  /** Vessel of the live assignment causing a LOCKED status (for the lock reason). */
  lockedVessel: string | null;
  /** Per-agent pipeline stage (STORED truth: grant.stage, default "review"). */
  stage: SeafarerState;
  /** Human label for `stage` (STATE_LABELS). */
  stageLabel: string;
  /** Epoch ms of the last stage change; null when not finite (no update recorded). */
  stageUpdatedAt: number | null;
};

/**
 * One "flow" the SEAMAN sees — a single agency they shared docs with and where that
 * agency is with them. Projects only what the seaman card needs; carries BOTH the
 * stored `stage` and `status` so the client derives `displayStage` (F1) without
 * mutating the stored truth. No tokens, no agent secrets, no other-seaman PII.
 */
export type SeamanFlow = {
  /** Opaque — used only as a React key. */
  agentId: string;
  orgName: string;
  /** Stored per-agent stage truth. */
  stage: SeafarerState;
  stageLabel: string;
  stageUpdatedAt: number | null;
  /** Live grant status so the card can derive displayStage (LOCKED -> at sea). */
  status: GrantStatus;
  /** Vessel of the live LOCKED assignment (only meaningful when LOCKED). */
  lockedVessel: string | null;
  /**
   * #45 — id of the live LOCKED assignment, so the seaman can download THEIR OWN SEA
   * for this voyage (/api/contract/<id>?token=&assignmentId=). null unless LOCKED.
   */
  lockedByAssignmentId: string | null;
  overCap: boolean;
  /** The AGENCY's own business contact (display only) — surfaced ONLY on overrun. */
  agencyContact: string | null;
  /** #38 — this agency's current CONTACT-bucket propagation consent (seaman-controlled). */
  propagateContact: boolean;
  /** #38 — this agency's current FINANCIAL/NOK-bucket propagation consent. */
  propagateFinancial: boolean;
  /** #42 — may this agency expose the seaman on a client read-portal (seaman-controlled). */
  clientVisible: boolean;
};

// REVIEW-level actions (distinct from a plain list VIEW) for the transparency view.
// view  = loading a list/card (VIEWED). review = opening the single-seaman review
// or the doc viewer / confirm / download / export.
const REVIEW_ACTIONS: ReadonlySet<AccessAction> = new Set<AccessAction>([
  "REVIEWED",
  "DOWNLOADED",
  "EXPORTED",
]);

/**
 * GDPR Art.15 self-report for a seafarer: per agent, the last access, its status,
 * and how many REVIEW-level actions occurred. Reads the append-only sink — the
 * agent cannot suppress an entry.
 */
export function reviewsForSeafarer(seafarerId: string): ReviewerRow[] {
  const db = readDB();
  const log = readAccessLog().filter((e) => e.seafarerId === seafarerId);
  const byAgent = new Map<string, AccessLogEntry[]>();
  for (const e of log) {
    if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
    byAgent.get(e.agentId)!.push(e);
  }
  // Include agents that have a grant even if they've taken no action yet.
  for (const g of db.accessGrants) {
    if (g.seafarerId === seafarerId && !byAgent.has(g.agentId)) byAgent.set(g.agentId, []);
  }
  const agentName = (agentId: string): string =>
    db.agents.find((a) => a.id === agentId)?.orgName ?? agentId;
  const rows: ReviewerRow[] = [];
  for (const [agentId, entries] of byAgent) {
    // Timestamps are stored UTC ISO-8601; ordering is by timestamp (string compare
    // on ISO-8601 is chronological). The seaman UI renders them in its own locale.
    entries.sort((a, b) => a.at.localeCompare(b.at));
    const last = entries[entries.length - 1] ?? null;
    const reviewEntries = entries.filter((e) => REVIEW_ACTIONS.has(e.action));
    const lastReview = reviewEntries[reviewEntries.length - 1] ?? null;
    const grant = findGrant(db, seafarerId, agentId);
    const eff = grant ? effectiveGrantStatus(grant, db.assignments) : null;
    // Vessel behind a LOCKED status (the live assignment that forces the lock).
    let lockedVessel: string | null = null;
    if (eff?.status === "LOCKED") {
      const live = activeAssignmentsFor(seafarerId, agentId, db.assignments)[0] ?? null;
      lockedVessel = live?.vessel ?? null;
    }
    // Per-agent stage (F4: optional-chaining default). stageUpdatedAt F3-coerced —
    // absent -> Date.parse(createdAt); never `?? 0` over a possible NaN.
    const stage: SeafarerState = grant?.stage ?? "review";
    const rawStageAt = grant?.stageUpdatedAt ?? (grant ? Date.parse(grant.createdAt) : NaN);
    rows.push({
      agentId,
      agentName: agentName(agentId),
      grantId: grant?.id ?? null,
      status: eff?.status ?? null,
      lastAction: last?.action ?? null,
      lastActionAt: last?.at ?? null,
      lastReviewAction: lastReview?.action ?? null,
      lastReviewAt: lastReview?.at ?? null,
      reviewCount: reviewEntries.length,
      overCap: eff?.overCap ?? false,
      lockedVessel,
      stage,
      stageLabel: STATE_LABELS[stage],
      stageUpdatedAt: Number.isFinite(rawStageAt) ? rawStageAt : null,
    });
  }
  return rows.sort((a, b) => (b.lastActionAt ?? "").localeCompare(a.lastActionAt ?? ""));
}

/**
 * The SEAMAN-facing "my applications" list (D2): only agencies with an effectively
 * ACTIVE or LOCKED grant. Read-only; the seaman cannot change their own stage.
 * Projects only the card fields — no other-seaman PII, no tokens, no agent secrets.
 * agencyContact is the agency's OWN business contact (display only, db.ts:385-386),
 * surfaced by the UI only in the at-sea overrun affordance.
 */
export function flowsForSeafarer(seafarerId: string): SeamanFlow[] {
  const db = readDB();
  const rows: SeamanFlow[] = [];
  for (const g of db.accessGrants) {
    if (g.seafarerId !== seafarerId) continue;
    const eff = effectiveGrantStatus(g, db.assignments);
    if (eff.status !== "ACTIVE" && eff.status !== "LOCKED") continue;
    let lockedVessel: string | null = null;
    let lockedByAssignmentId: string | null = null;
    if (eff.status === "LOCKED") {
      const live = activeAssignmentsFor(seafarerId, g.agentId, db.assignments)[0] ?? null;
      lockedVessel = live?.vessel ?? null;
      lockedByAssignmentId = live?.id ?? null;
    }
    const stage: SeafarerState = g.stage ?? "review";
    const rawStageAt = g.stageUpdatedAt ?? Date.parse(g.createdAt);
    const agent = db.agents.find((a) => a.id === g.agentId) ?? null;
    rows.push({
      agentId: g.agentId,
      orgName: agent?.orgName ?? g.agentId,
      stage,
      stageLabel: STATE_LABELS[stage],
      stageUpdatedAt: Number.isFinite(rawStageAt) ? rawStageAt : null,
      status: eff.status,
      lockedVessel,
      lockedByAssignmentId,
      overCap: eff.overCap ?? false,
      agencyContact: agent?.contact ?? null,
      propagateContact: g.propagateContact ?? false,
      propagateFinancial: g.propagateFinancial ?? false,
      clientVisible: g.clientVisible ?? false,
    });
  }
  return rows;
}

export { readConsentEvents, type ConsentEvent };
