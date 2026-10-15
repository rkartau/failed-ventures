// Duplicate-PERSON merge (#37) — SERVER-ONLY (behind /api/seafarers/merge). Corroboration
// -gated, archive-before-delete (reversible), audit-reconciled, per-tenant. Runs in ONE
// db.ts `transact` critical section so the db write + audit appends never interleave and
// no hash chain forks. All guards are re-checked on the freshly-read db INSIDE the mutex.
//
// PII archive: the full absorbed record is serialised to data/merge-archive.ndjson BEFORE
// any mutation (no archive write => no merge). That file lives under data/ (deploy-excluded),
// so PII never leaves the box; only the archive HASH + ids go into the PII-free admin-audit.

import {
  readDB,
  transact,
  id,
  AUDIT_NO_IMPERSONATION,
  type DB,
  type Seafarer,
  type AccessGrant,
  type AuditOnBehalf,
} from "@/lib/db";
import { effectiveGrantStatus } from "@/lib/access";
import { personIdentityOf, corroboratedByStored } from "@/lib/duplicates";
import { archiveBeforeDelete } from "@/lib/delete-archive";

export type MergeMoves = {
  documents: number;
  accessGrants: { move: number; dropDuplicatePair: number };
  docRequests: number;
  profileChanges: number;
  seaService: number;
  comments: number;
  restHours: number;
};

export type MergePreview = {
  survivorId: string;
  absorbedId: string;
  moves: MergeMoves;
  identityOutcome: "survivor-kept" | "adopted-from-absorbed";
  /** #37.10 — agency NAME only when a LOCKED grant blocks the merge; no roster leak. */
  lockConflict: null | { agencyName: string };
};

function agencyName(db: DB, agentId: string): string {
  return db.agents.find((a) => a.id === agentId)?.orgName ?? agentId;
}

/** The single LOCKED conflict (absorbed OR survivor side), agency name only. #37.10 / #7. */
function lockConflictFor(db: DB, survivor: Seafarer, absorbed: Seafarer): { agencyName: string } | null {
  for (const g of db.accessGrants) {
    if (g.seafarerId !== survivor.id && g.seafarerId !== absorbed.id) continue;
    if (effectiveGrantStatus(g, db.assignments).status === "LOCKED") {
      return { agencyName: agencyName(db, g.agentId) };
    }
  }
  return null;
}

function countMoves(db: DB, survivorId: string, absorbedId: string): MergeMoves {
  const survivorAgents = new Set(
    db.accessGrants.filter((g) => g.seafarerId === survivorId).map((g) => g.agentId)
  );
  let move = 0;
  let dropDuplicatePair = 0;
  for (const g of db.accessGrants) {
    if (g.seafarerId !== absorbedId) continue;
    if (survivorAgents.has(g.agentId)) dropDuplicatePair++;
    else move++;
  }
  const c = (arr: { seafarerId: string }[]) => arr.filter((x) => x.seafarerId === absorbedId).length;
  return {
    documents: c(db.documents),
    accessGrants: { move, dropDuplicatePair },
    docRequests: c(db.docRequests),
    profileChanges: c(db.profileChanges),
    seaService: c(db.seaService),
    comments: db.comments.filter((x) => x.seafarerId === absorbedId).length,
    restHours: c(db.restHours),
  };
}

/**
 * READ-ONLY preview (#37.4): which docs/grants/records move, the identity outcome, and any
 * LOCKED conflict. Never mutates. Returns { error } when a record is missing or self-merge.
 */
export function previewMerge(
  survivorId: string,
  absorbedId: string
): MergePreview | { error: string } {
  if (survivorId === absorbedId) return { error: "cannot merge a record into itself" };
  const db = readDB();
  const survivor = db.seafarers.find((s) => s.id === survivorId) ?? null;
  const absorbed = db.seafarers.find((s) => s.id === absorbedId) ?? null;
  if (!survivor || !absorbed) return { error: "record not found" };
  // Public Sample Profiles (plan v4-3a): a sample record can NEVER be merged, in
  // either direction — merging would carry the PUBLISHED sample token into a real
  // seafarer's priorShareTokens (public link -> real documents) or delete the
  // public flagship. Independent check via this fn's existing { error } union.
  if (survivor.isSample === true || absorbed.isSample === true) {
    return { error: "sample records cannot be merged" };
  }
  const adopt = !survivor.identityVerified && absorbed.identityVerified === true;
  return {
    survivorId,
    absorbedId,
    moves: countMoves(db, survivorId, absorbedId),
    identityOutcome: adopt ? "adopted-from-absorbed" : "survivor-kept",
    lockConflict: lockConflictFor(db, survivor, absorbed),
  };
}

/**
 * Perform the merge. ONE transact critical section; every guard re-checked on the fresh db.
 * Returns { ok:false, reason } for a refused merge (self / missing / not-corroborated / locked)
 * so the caller maps the status; { ok:true, preview } on success.
 */
export function mergePersons(
  survivorId: string,
  absorbedId: string,
  actor: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ ok: boolean; reason?: string; preview?: MergePreview }> {
  return transact((db, audit) => {
    // 0. Idempotency / missing-row / self-merge guards (before anything). A double-submit
    //    finds the absorbed row already gone on the second call => exactly one merge (#5).
    if (survivorId === absorbedId) return { ok: false, reason: "cannot merge a record into itself" };
    const survivor = db.seafarers.find((s) => s.id === survivorId) ?? null;
    const absorbed = db.seafarers.find((s) => s.id === absorbedId) ?? null;
    if (!survivor || !absorbed) return { ok: false, reason: "record not found" };
    // Public Sample Profiles (plan v4-3b): refuse EITHER-side sample merges INSIDE
    // the early-guard block, BEFORE any mutation — transact writes the db
    // unconditionally on return (db.ts), so a return-refusal is only safe here
    // while the db handle is still unmutated.
    if (survivor.isSample === true || absorbed.isSample === true) {
      return { ok: false, reason: "sample records cannot be merged" };
    }

    // Corroboration HARD-GATE re-derived server-side from the STORED records (#37.6).
    const absorbedDocs = db.documents.filter((d) => d.seafarerId === absorbedId);
    const survivorDocs = db.documents.filter((d) => d.seafarerId === survivorId);
    if (
      !corroboratedByStored(
        personIdentityOf(survivor, survivorDocs),
        personIdentityOf(absorbed, absorbedDocs)
      )
    ) {
      return { ok: false, reason: "needs corroboration" };
    }

    // 1. LOCKED policy — BOTH directions (#37.10 + #7). A man at sea (either side) blocks.
    const lock = lockConflictFor(db, survivor, absorbed);
    if (lock) {
      const absorbedLocked = db.accessGrants.some(
        (g) => g.seafarerId === absorbedId && effectiveGrantStatus(g, db.assignments).status === "LOCKED"
      );
      return {
        ok: false,
        reason: absorbedLocked
          ? `locked by ${lock.agencyName}`
          : `survivor is at sea (${lock.agencyName})`,
      };
    }

    const preview = previewMergeFromDb(db, survivorId, absorbedId);

    // 2. Reversibility snapshot BEFORE any mutation (#37.5). No archive write => no merge
    //    (throw before mutating). The PII lives in the deploy-excluded archive.
    const archiveRecord = {
      at: new Date().toISOString(),
      survivorId,
      absorbedId,
      absorbed,
      children: {
        documents: absorbedDocs,
        comments: db.comments.filter((c) => c.seafarerId === absorbedId),
        restHours: db.restHours.filter((r) => r.seafarerId === absorbedId),
        docRequests: db.docRequests.filter((r) => r.seafarerId === absorbedId),
        profileChanges: db.profileChanges.filter((r) => r.seafarerId === absorbedId),
        seaService: db.seaService.filter((e) => e.seafarerId === absorbedId),
        assignments: db.assignments.filter((a) => a.seafarerId === absorbedId),
        accessGrants: db.accessGrants.filter((g) => g.seafarerId === absorbedId),
        profileShareRequests: db.profileShareRequests.filter((p) => p.seafarerId === absorbedId),
      },
    };
    // Throws on failure -> transact's writeAtomic never runs -> nothing mutated.
    const { hash: archiveHash } = archiveBeforeDelete("person-merge", archiveRecord);

    // 3. Reassign child collections absorbed -> survivor. assignments ARE included for
    //    audit completeness — the LOCKED guard means every one is already CLOSED
    //    (returnedAt != null), so re-pointing them is safe and keeps voyage history whole.
    for (const d of db.documents) if (d.seafarerId === absorbedId) d.seafarerId = survivorId;
    for (const c of db.comments) if (c.seafarerId === absorbedId) c.seafarerId = survivorId;
    for (const r of db.restHours) if (r.seafarerId === absorbedId) r.seafarerId = survivorId;
    for (const r of db.docRequests) if (r.seafarerId === absorbedId) r.seafarerId = survivorId;
    for (const r of db.profileChanges) if (r.seafarerId === absorbedId) r.seafarerId = survivorId;
    for (const e of db.seaService) if (e.seafarerId === absorbedId) e.seafarerId = survivorId;
    for (const a of db.assignments) if (a.seafarerId === absorbedId) a.seafarerId = survivorId;
    for (const p of db.profileShareRequests) if (p.seafarerId === absorbedId) p.seafarerId = survivorId;

    // 4. accessGrants: dedupe per agent. Survivor already has a grant for that agent ->
    //    keep survivor's, TOMBSTONE the absorbed duplicate (#2), reconcile propagate flags
    //    most-private-wins (#38.7) + emit consent events; else re-point the absorbed grant.
    const survivorGrantByAgent = new Map<string, AccessGrant>();
    for (const g of db.accessGrants) {
      if (g.seafarerId === survivorId) survivorGrantByAgent.set(g.agentId, g);
    }
    const nowIso = new Date().toISOString();
    for (const g of db.accessGrants) {
      if (g.seafarerId !== absorbedId) continue;
      const survGrant = survivorGrantByAgent.get(g.agentId);
      if (survGrant) {
        // Tombstone the absorbed duplicate (not a hard delete — keeps consent history).
        g.status = "REVOKED";
        g.mergedIntoGrantId = survGrant.id;
        // most-private-wins per bucket; emit a WITHDRAWN event for any true->false flip.
        for (const bucket of ["contact", "financial"] as const) {
          const key = bucket === "contact" ? "propagateContact" : "propagateFinancial";
          const before = survGrant[key] ?? false;
          const after = before && (g[key] ?? false);
          survGrant[key] = after;
          if (before && !after) {
            audit("consent-events", {
              id: id(),
              at: nowIso,
              grantId: survGrant.id,
              type: "PROPAGATION_WITHDRAWN",
              legalBasisAfter: null,
              actor,
              bucket,
            });
          }
        }
      } else {
        // Re-point the absorbed grant to the survivor (keeps its id + history).
        g.seafarerId = survivorId;
      }
    }

    // 5. Identity: keep survivor's; adopt absorbed identity ONLY if survivor is unverified.
    if (!survivor.identityVerified && absorbed.identityVerified === true) {
      survivor.identityVerified = true;
      survivor.identityVerifiedAt = absorbed.identityVerifiedAt ?? nowIso;
      survivor.verifiedName = absorbed.verifiedName ?? null;
      survivor.personalCode = absorbed.personalCode ?? survivor.personalCode ?? null;
      survivor.birthDate = absorbed.birthDate ?? survivor.birthDate ?? null;
      survivor.photoUrl = absorbed.photoUrl ?? null;
      survivor.issuerCountry = absorbed.issuerCountry ?? null;
      survivor.verifiedPhotoFile = absorbed.verifiedPhotoFile ?? survivor.verifiedPhotoFile ?? null;
    }

    // 5b. Imported contact e-mail (A7): the NEW placeholder is the ABSORBED record, so
    //     its agent-typed importedEmail is what a naive merge would throw away. Survivor
    //     wins on conflict; a survivor that LACKS one inherits the absorbed placeholder's.
    //     ownerEmail / googleSub are deliberately NOT reconciled (auth fields, untouched).
    if (!survivor.importedEmail && absorbed.importedEmail) {
      survivor.importedEmail = absorbed.importedEmail;
    }

    // 5c. Credential-owner reconciliation (feat/password-signup Step 2f(a)):
    //     without this, deleting the absorbed row would strand its CredentialUser
    //     on a dead seafarerId. When the absorbed row is credential-owned and the
    //     survivor has NO credential owner, the survivor inherits the binding and
    //     the CredentialUser's seafarerId is re-pointed — same transact, custody
    //     change audited as PROFILE_BIND via "merge-inherit" (fold 10). When BOTH
    //     rows are credential-owned, the survivor keeps its own binding and the
    //     absorbed row's credential user is left dangling — it self-heals on next
    //     login (Step 2f-b in lib/credential-auth.ts). NOTE: inheriting onto a
    //     Google-owned survivor deliberately co-owns it (same human, merged by an
    //     agent/admin who established that — plan R4).
    if (absorbed.credentialUserId && !survivor.credentialUserId) {
      const credUser = db.credentialUsers.find((u) => u.id === absorbed.credentialUserId);
      survivor.credentialUserId = absorbed.credentialUserId;
      if (credUser) credUser.seafarerId = survivorId;
      audit("auth-events", {
        id: id(),
        at: nowIso,
        type: "PROFILE_BIND",
        credId: absorbed.credentialUserId,
        seafarerId: survivorId,
        via: "merge-inherit",
      });
    }

    // 6. mergedFrom chain + carry absorbed share tokens as VIEW-ONLY aliases (#6), then
    //    delete the absorbed seafarer row.
    const mergedFrom = new Set<string>(survivor.mergedFrom ?? []);
    mergedFrom.add(absorbedId);
    for (const prior of absorbed.mergedFrom ?? []) mergedFrom.add(prior);
    survivor.mergedFrom = [...mergedFrom];

    // Public Sample Profiles (plan v4-3c): LAST-LINE assert immediately before the
    // token-carry block. A THROW is the only thing that skips transact's
    // unconditional writeAtomic — a plain return here would persist a half-merged
    // db. If a future edit ever bypasses the early guard, this aborts the write
    // before a sample token can land in any real row's priorShareTokens.
    // (Widened re-check defeats TS narrowing from the early guard — this is a
    // deliberate runtime backstop, not dead code.)
    const sampleAssertRows: Array<{ isSample?: boolean }> = [survivor, absorbed];
    if (sampleAssertRows.some((r) => r.isSample === true)) {
      throw new Error(
        "sample-merge-assert: refusing to carry share tokens across a sample merge"
      );
    }
    const priorTokens = [...(survivor.priorShareTokens ?? [])];
    const seen = new Set(priorTokens.map((p) => p.token));
    const addAlias = (token: string | undefined, mode: "open" | "email") => {
      if (token && !seen.has(token)) {
        priorTokens.push({ token, mode });
        seen.add(token);
      }
    };
    addAlias(absorbed.openShareToken, "open");
    addAlias(absorbed.emailShareToken, "email");
    for (const p of absorbed.priorShareTokens ?? []) addAlias(p.token, p.mode);
    survivor.priorShareTokens = priorTokens;

    db.seafarers = db.seafarers.filter((s) => s.id !== absorbedId);

    // 7. Audit reconciliation — APPEND-ONLY (never rewrite a chain). admin-audit gets the
    //    PII-free PERSON_MERGE marker (ids + archive hash + counts). mergedFrom makes every
    //    future survivor read UNION the absorbed id's pre-merge history. All three chains
    //    stay ok:true because we only appended.
    audit("admin-audit", {
      id: id(),
      at: nowIso,
      action: "PERSON_MERGE",
      survivorId,
      absorbedId,
      archiveHash,
      moves: preview.moves,
      actor,
    });

    return { ok: true, preview };
  }, onBehalf);
}

// Same computation as previewMerge but off an already-read db (used inside the mutex).
function previewMergeFromDb(db: DB, survivorId: string, absorbedId: string): MergePreview {
  const survivor = db.seafarers.find((s) => s.id === survivorId)!;
  const absorbed = db.seafarers.find((s) => s.id === absorbedId)!;
  const adopt = !survivor.identityVerified && absorbed.identityVerified === true;
  return {
    survivorId,
    absorbedId,
    moves: countMoves(db, survivorId, absorbedId),
    identityOutcome: adopt ? "adopted-from-absorbed" : "survivor-kept",
    lockConflict: lockConflictFor(db, survivor, absorbed),
  };
}
