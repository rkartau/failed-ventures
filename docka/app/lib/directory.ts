// #49 — docka-verified network directory (SERVER module; the ONE narrow cross-tenant
// reader). Authenticated clients only (gated in the route/page), server-side-filtered,
// dual + LIVE consent, agency-attributed, identity-verified-only, rate-limited
// (REUSED registry limiter) + noindex.
//
// Only projected `ClientCrewRow`s ever leave the server — NEVER a `filterRoster`
// result or a raw `RosterSearchRow` (raw id / state / certs / rotationEnd) [R49.10].
//
// The inclusion gate reads the STORED fields directly and DELIBERATELY does NOT use
// `effectiveGrantStatus` / `effectiveLegalBasis` [V1/V5]: `effectiveLegalBasis ===
// "CONSENT"` holds for REVOKED, EXPIRED AND PENDING/ACTIVE (non-CONSENT only when
// LOCKED), so gating on it would list a stale-consent EXPIRED/REVOKED grant; and
// `effectiveGrantStatus` masks a REVOKED mid-voyage grant as LOCKED. Requiring stored
// `status === "ACTIVE"` + not-past-`expiresAt` excludes PENDING, REVOKED, stored
// EXPIRED, and a lapsed-but-unswept ACTIVE — a stale `directoryConsent=true` lists
// nobody and routes no lead, even mid-voyage.

import {
  readDB,
  transact,
  appendAudit,
  id,
  AUDIT_NO_IMPERSONATION,
  type AuditOnBehalf,
  type AccessGrant,
  type Doc,
  type Seafarer,
} from "@/lib/db";
import { activeDocs } from "@/lib/archive";
import { buildSearchRow, filterRoster, type RosterQuery } from "@/lib/roster-search";
import { projectClientCrewRow, type ClientCrewRow } from "@/lib/client-view";
import { effectiveValidUntil } from "@/lib/cert-rules";
import { surfaceRef } from "@/lib/surface-ref";
import type { RequiredDocType } from "@/lib/doctypes";
import type { VerificationLevel } from "@/lib/verification-level";

export const DIRECTORY_MAX = 50;
export const DIRECTORY_TEXT_MIN = 2;
export const DIRECTORY_TEXT_MAX = 64;

/** A directory row = the external projection PLUS lead-routing agency attribution. */
export type DirectoryRow = ClientCrewRow & {
  /** Org names of stored-ACTIVE, non-lapsed consenting agencies [R49.11]. */
  sourcingAgencies: string[];
  /** Soonest UPCOMING cert expiry date (ISO) across held docs, or null if none/all
   *  already lapsed — shown as an actual date, not just "1 expiring soon" [E1]. */
  nearestExpiry: string | null;
};

/** Soonest FUTURE effective expiry across a seaman's docs (the next cert to lapse). */
function nearestUpcomingExpiry(docs: Doc[], holderDOB: string | null, now: Date): string | null {
  const nowMs = now.getTime();
  let soonest: number | null = null;
  let soonestIso: string | null = null;
  for (const d of docs) {
    const exp = effectiveValidUntil(d, holderDOB);
    if (!exp) continue;
    const t = new Date(exp).getTime();
    if (isNaN(t) || t <= nowMs) continue; // ignore already-lapsed / undated
    if (soonest === null || t < soonest) {
      soonest = t;
      soonestIso = exp;
    }
  }
  return soonestIso;
}

export type DirectoryCandidate = {
  seafarer: Seafarer;
  docs: Doc[];
  sourcingAgencies: string[];
};

/**
 * The ONE stored-field directory-consent rule [V1/V5]. A grant lists its seaman ONLY
 * when it carries `directoryConsent === true` AND its STORED `status === "ACTIVE"` AND
 * it is not past `expiresAt`. Never `effectiveGrantStatus` / `effectiveLegalBasis`.
 */
export function grantListsInDirectory(g: AccessGrant, nowMs: number): boolean {
  if (g.directoryConsent !== true) return false;
  if (g.status !== "ACTIVE") return false; // excludes PENDING / REVOKED / stored EXPIRED
  if (g.expiresAt != null && new Date(g.expiresAt).getTime() <= nowMs) return false; // lapsed
  return true;
}

/**
 * Directory candidates: `db.seafarers` filtered to `directoryOptIn === true` AND
 * `identityVerified === true` AND ≥1 grant passing `grantListsInDirectory`. Reads
 * `db.documents` into a `Map<seafarerId, Doc[]>` ONCE per request (no per-candidate
 * refetch) [C5].
 */
export function directoryCandidates(now: Date = new Date()): DirectoryCandidate[] {
  const db = readDB();
  const nowMs = now.getTime();

  const docsBySeafarer = new Map<string, Doc[]>();
  for (const d of db.documents) {
    const arr = docsBySeafarer.get(d.seafarerId);
    if (arr) arr.push(d);
    else docsBySeafarer.set(d.seafarerId, [d]);
  }
  const orgById = new Map(db.agents.map((a) => [a.id, a.orgName] as const));

  const out: DirectoryCandidate[] = [];
  for (const s of db.seafarers) {
    // Public Sample Profiles belt-and-braces (plan §D10 rev-7): a sample subject
    // can NEVER enter the public directory — even under an adversarial grant
    // carrying directoryConsent:true (the seed's directoryOptIn:false is the
    // primary gate; this line makes the builder itself fail closed).
    if (s.isSample === true) continue;
    if (s.directoryOptIn !== true) continue; // seaman half of the dual consent
    if (s.identityVerified !== true) continue; // identity-verified only [R49.12]
    const consenting = db.accessGrants.filter(
      (g) => g.seafarerId === s.id && grantListsInDirectory(g, nowMs)
    );
    if (consenting.length === 0) continue; // agency half of the dual consent
    const agencies = Array.from(
      new Set(consenting.map((g) => orgById.get(g.agentId) ?? g.agentId))
    );
    out.push({
      seafarer: s,
      docs: activeDocs(docsBySeafarer.get(s.id) ?? []),
      sourcingAgencies: agencies,
    });
  }
  return out;
}

export type DirectorySearchInput = {
  text?: string;
  rank?: string;
  nationality?: string;
  vesselType?: string;
  flagState?: string;
  certType?: RequiredDocType | "";
  /** Keep only rows whose verification FLOOR is >= this level (0..3) [E2]. */
  minVerificationLevel?: VerificationLevel;
  /** Keep only rows with nothing expired AND nothing expiring in the window [E2]. */
  inDateOnly?: boolean;
};

export type DirectorySearchResult =
  | { ok: true; rows: DirectoryRow[] }
  | { ok: false; error: "text-too-short" | "text-too-long" };

/**
 * SERVER-SIDE search [R49.10]. Builds candidate `RosterSearchRow`s from the per-request
 * doc map, runs the pure `filterRoster` predicate on the server, then projects each hit
 * to a directory `ClientCrewRow` (`ref=surfaceRef(id,"directory")`)
 * enriched with `sourcingAgencies` + expiry counts. Bounds: `text` trimmed, min-2 AND
 * max-64 [C8]; cap DIRECTORY_MAX; dedup a multi-agency seaman to one row. Audits
 * DIRECTORY_SEARCH {count} — NEVER the query text. `surfaceRef` throws when its salt is
 * unset (route → 503).
 */
export function searchDirectory(
  query: DirectorySearchInput,
  opts?: { now?: Date; onBehalf?: AuditOnBehalf }
): DirectorySearchResult {
  const now = opts?.now ?? new Date();
  const text = (query.text ?? "").trim();
  if (text.length > 0 && text.length < DIRECTORY_TEXT_MIN) return { ok: false, error: "text-too-short" };
  if (text.length > DIRECTORY_TEXT_MAX) return { ok: false, error: "text-too-long" };

  const cands = directoryCandidates(now);
  // Build the search rows once; keep the candidate alongside so ONLY the projected row
  // (never the raw RosterSearchRow) is ever returned.
  const paired = cands.map((c) => ({ c, row: buildSearchRow(c.seafarer, c.docs, null) }));

  const q: RosterQuery = {
    text,
    rank: query.rank,
    nationality: query.nationality,
    vesselType: query.vesselType,
    flagState: query.flagState,
    certType: query.certType || "",
  };
  const filtered = filterRoster(
    paired.map((p) => p.row),
    q
  );
  const keepIds = new Set(filtered.map((r) => r.id));

  // Post-projection facet filters [E2]. Server-side: the verification floor + expiry
  // counts are only known after projection, so filtering here still ships NO raw row.
  const minLevel = query.minVerificationLevel;
  const inDateOnly = query.inDateOnly === true;

  const seen = new Set<string>();
  const rows: DirectoryRow[] = [];
  for (const { c } of paired) {
    if (!keepIds.has(c.seafarer.id)) continue;
    if (seen.has(c.seafarer.id)) continue; // dedup a multi-agency seaman to one row
    seen.add(c.seafarer.id);
    const dob = c.seafarer.birthDate ?? null;
    const base = projectClientCrewRow(c.seafarer, c.docs, null, {
      ref: surfaceRef(c.seafarer.id, "directory"),
      // Directory rows show the CONSENTED full name (the seaman opted in to be found
      // by name); surname masking is a #42 portal default, not a directory one.
      masked: false,
      holderDOB: dob,
      now,
    });
    if (typeof minLevel === "number" && base.verificationFloor < minLevel) continue;
    if (inDateOnly && (base.expiredCount > 0 || base.expiringCount > 0)) continue;
    rows.push({
      ...base,
      sourcingAgencies: c.sourcingAgencies,
      nearestExpiry: nearestUpcomingExpiry(c.docs, dob, now),
    });
    if (rows.length >= DIRECTORY_MAX) break;
  }

  void appendAudit(
    "portal-log",
    { id: id(), at: now.toISOString(), type: "DIRECTORY_SEARCH", count: rows.length },
    opts?.onBehalf ?? AUDIT_NO_IMPERSONATION
  );
  return { ok: true, rows };
}

/**
 * Seaman-controlled directory opt-in (seaman half of the dual consent). Seaman-level
 * flag (no grant), so it writes the flag inside one critical section without a
 * grant-scoped consent event. Fail-closed on a missing seaman.
 */
export function setDirectoryOptIn(
  seafarerId: string,
  on: boolean,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; seafarer?: Seafarer }> {
  return transact((db) => {
    const s = db.seafarers.find((x) => x.id === seafarerId) ?? null;
    if (!s) return { ok: false, reason: "not found" };
    s.directoryOptIn = on;
    return { ok: true, seafarer: { ...s } };
  }, onBehalf);
}

/**
 * Agency-controlled per-grant directory consent (agency half of the dual consent).
 * Flips `AccessGrant.directoryConsent` and emits DIRECTORY_CONSENT_GRANTED / _WITHDRAWN
 * (grant-scoped). Fail-closed on a missing grant. `actor` is an id reference.
 */
export function setDirectoryConsent(
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
    const before = grant.directoryConsent ?? false;
    if (before === on) return { ok: true, grant: { ...grant } };
    grant.directoryConsent = on;
    audit("consent-events", {
      id: id(),
      at: nowIso,
      grantId: grant.id,
      type: on ? "DIRECTORY_CONSENT_GRANTED" : "DIRECTORY_CONSENT_WITHDRAWN",
      legalBasisAfter: null,
      actor,
    });
    return { ok: true, grant: { ...grant } };
  }, onBehalf);
}
