// #42 — Client / shipowner read-portal (SERVER module). Owner-scoped create/revoke/
// list + token(+allow-list) view. Every crew row that leaves the box is the
// allow-list projection from lib/client-view.ts; documents / ids / DOB never cross.
//
// Live re-check on every view [TOCTOU]: crewForPortal re-reads the grant + the
// seaman's `clientVisible` for EACH curated id, so a mid-session revoke or a
// visibility-off flips the very next view. The `ref` is a non-reversible per-surface
// HMAC (lib/surface-ref); an unset salt fails closed as a per-ROUTE 503 [C6/V3].

import {
  readDB,
  transact,
  appendAudit,
  id,
  shareToken,
  AUDIT_NO_IMPERSONATION,
  type AuditOnBehalf,
  type ClientPortal,
  type DB,
} from "@/lib/db";
import { findGrant, effectiveGrantStatus, isReadableStatus } from "@/lib/access";
import { getDocumentsForAgent } from "@/lib/agentData";
import { duplicateNameIndex } from "@/lib/duplicates";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { projectClientCrewRow, type ClientCrewRow } from "@/lib/client-view";
import { surfaceRef } from "@/lib/surface-ref";

// Re-export so `import { surfaceRef } from "@/lib/client-portal"` keeps working; the
// definition lives in the foundation module (lib/surface-ref) shared with #49.
export { surfaceRef } from "@/lib/surface-ref";

/** Display-only portal header — the ONLY portal shape safe to render to a client. */
export type PortalHeader = { vessel: string; clientLabel: string; mode: "open" | "email" };

export type PortalVisibility = {
  seafarerId: string;
  visible: boolean;
  reason?: "no-grant" | "not-consented";
};

// Pure visibility gate over a db snapshot: a curated id is visible ONLY with a LIVE
// readable grant AND `clientVisible === true` for this agency.
function visForDb(db: DB, agentId: string, seafarerIds: string[]): PortalVisibility[] {
  return seafarerIds.map((sid) => {
    // Public Sample Profiles belt-and-braces: a sample subject is NEVER portal-
    // visible. Primary gate already holds (clientVisible is seaman-token-set only
    // and census row 20 DENIES it for samples) — this makes the exclusion local.
    if (db.seafarers.find((s) => s.id === sid)?.isSample === true) {
      return { seafarerId: sid, visible: false, reason: "no-grant" };
    }
    const grant = findGrant(db, sid, agentId);
    if (!grant) return { seafarerId: sid, visible: false, reason: "no-grant" };
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (!isReadableStatus(eff.status)) return { seafarerId: sid, visible: false, reason: "no-grant" };
    if (grant.clientVisible !== true) {
      return { seafarerId: sid, visible: false, reason: "not-consented" };
    }
    return { seafarerId: sid, visible: true };
  });
}

/** Per-crew visible/NOT-visible + reason BEFORE send [R42.5]. */
export function previewPortalVisibility(
  agentId: string,
  seafarerIds: string[]
): PortalVisibility[] {
  return visForDb(readDB(), agentId, seafarerIds);
}

export type CreatePortalInput = {
  vessel: string;
  clientLabel: string;
  seafarerIds: string[];
  mode: "open" | "email";
  allowedEmails?: string[];
  joinDate?: string | null;
  rotationEnd?: string | null;
  expiresAt?: string | null;
  createKey?: string | null;
};

/**
 * Create a portal in ONE critical section. Idempotent on `createKey` [C11]: a create
 * carrying a key already present for this agent RETURNS the existing portal (no 2nd
 * row). Otherwise keep only ids passing the live visibility gate, mint a token, push,
 * audit PORTAL_CREATED.
 */
export function createPortal(
  agentId: string,
  input: CreatePortalInput,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ portal: ClientPortal; visibility: PortalVisibility[] }> {
  const nowIso = new Date().toISOString();
  const key = (input.createKey ?? "").trim() || null;
  return transact((db, audit) => {
    if (key) {
      const existing = db.clientPortals.find((p) => p.agentId === agentId && p.createKey === key);
      if (existing) {
        return {
          portal: { ...existing },
          visibility: visForDb(db, agentId, existing.seafarerIds),
        };
      }
    }
    const visibility = visForDb(db, agentId, input.seafarerIds);
    const keep = visibility.filter((v) => v.visible).map((v) => v.seafarerId);
    const portal: ClientPortal = {
      id: id(),
      agentId,
      vessel: input.vessel,
      clientLabel: input.clientLabel,
      token: shareToken(),
      seafarerIds: keep,
      mode: input.mode,
      allowedEmails: input.mode === "email" ? input.allowedEmails ?? [] : undefined,
      joinDate: input.joinDate ?? null,
      rotationEnd: input.rotationEnd ?? null,
      createKey: key,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: nowIso,
    };
    db.clientPortals.push(portal);
    audit("portal-log", {
      id: id(),
      at: nowIso,
      type: "PORTAL_CREATED",
      portalId: portal.id,
      count: keep.length,
    });
    return { portal: { ...portal }, visibility };
  }, onBehalf);
}

/** Owner-scoped revoke: set revokedAt, audit PORTAL_REVOKED. Foreign portal => ok:false. */
export function revokePortal(
  agentId: string,
  portalId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; portal: ClientPortal | null }> {
  const nowIso = new Date().toISOString();
  return transact((db, audit) => {
    const p = db.clientPortals.find((x) => x.id === portalId && x.agentId === agentId) ?? null;
    if (!p) return { ok: false, portal: null };
    if (!p.revokedAt) {
      p.revokedAt = nowIso;
      audit("portal-log", {
        id: id(),
        at: nowIso,
        type: "PORTAL_REVOKED",
        portalId: p.id,
        count: 0,
      });
    }
    return { ok: true, portal: { ...p } };
  }, onBehalf);
}

/** Own-tenant portals (display list). Server-side only. */
export function listPortalsForAgent(agentId: string): ClientPortal[] {
  return readDB().clientPortals.filter((p) => p.agentId === agentId);
}

/**
 * Resolve a portal by token. Null on not-found / revoked / expired (generic 404). The
 * returned `portal` is SERVER-ONLY (never serialised to a client component); the page
 * passes ONLY `header` + projected rows to the client [R42.6]. In "email" mode the
 * header is withheld pre-gate by `portalHeaderForViewer` [C10].
 */
export function resolvePortal(token: string): { portal: ClientPortal; header: PortalHeader } | null {
  const t = (token ?? "").trim();
  if (!t) return null;
  const db = readDB();
  const p = db.clientPortals.find((x) => x.token === t) ?? null;
  if (!p) return null;
  if (p.revokedAt) return null;
  if (p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now()) return null;
  return { portal: p, header: { vessel: p.vessel, clientLabel: p.clientLabel, mode: p.mode } };
}

/**
 * The display header the caller may render, or null when it must be WITHHELD. In
 * "email" mode a valid token + non-allowed viewer leaks neither crew NOR the header
 * (vessel/clientLabel) — pass `allowed=false` and this returns null [C10].
 */
export function portalHeaderForViewer(portal: ClientPortal, allowed: boolean): PortalHeader | null {
  if (portal.mode === "email" && !allowed) return null;
  return { vessel: portal.vessel, clientLabel: portal.clientLabel, mode: portal.mode };
}

/**
 * Build the projected crew rows for a portal. LIVE re-checks grant + `clientVisible`
 * per curated id (TOCTOU), reads docs via the grant-scoped accessor, projects through
 * the SINGLE external allow-list with a per-surface `ref`, and audits PORTAL_VIEWED
 * (id + coarse count only). `surfaceRef` throws `SurfaceRefSaltMissing` when the salt
 * is unset — the route catches it as a 503.
 */
export function crewForPortal(
  portal: ClientPortal,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): ClientCrewRow[] {
  const db = readDB();
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (sfid) => nameById.get(sfid) ?? sfid);
  const config = getConfigForAgent(portal.agentId);
  const rows: ClientCrewRow[] = [];
  for (const sid of portal.seafarerIds) {
    const grant = findGrant(db, sid, portal.agentId);
    if (!grant) continue;
    const eff = effectiveGrantStatus(grant, db.assignments);
    if (!isReadableStatus(eff.status)) continue; // TOCTOU-drop a flipped grant
    if (grant.clientVisible !== true) continue; // TOCTOU-drop a flipped clientVisible
    const seafarer = db.seafarers.find((s) => s.id === sid) ?? null;
    if (!seafarer) continue;
    const docs = getDocumentsForAgent(portal.agentId, sid);
    rows.push(
      projectClientCrewRow(seafarer, docs, config, {
        ref: surfaceRef(sid, "portal"),
        masked: true,
        duplicates,
        ownName: seafarer.name,
        rotationEnd: portal.rotationEnd ?? seafarer.rotationEnd ?? null,
        holderDOB: seafarer.birthDate ?? null,
      })
    );
  }
  void appendAudit(
    "portal-log",
    { id: id(), at: new Date().toISOString(), type: "PORTAL_VIEWED", portalId: portal.id, count: rows.length },
    onBehalf
  );
  return rows;
}
