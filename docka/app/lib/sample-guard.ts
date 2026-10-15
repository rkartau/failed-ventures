// Public Sample Profiles — the single token CHOKEPOINT every token-authorised API
// route resolves through (plan §D4), plus the sample-reference prune (§D9) and the
// anonymous-load hardening for sample FILTER GETs (§D4 v3-2/v4-5b).
//
// Design rules this module enforces:
//  - DELEGATION, not a parallel resolver: token → seafarer resolution runs through
//    the canonical `resolveSeafarerByShareToken` (lib/share-access.ts) so the
//    three-mode semantics (open → email → post-merge alias, aliasMode preserved)
//    stay single-sourced.
//  - PER-ROUTE MODE PINNING: each caller passes `allowedModes` — TODAY'S exact
//    acceptance for that route (see PHASE0-CENSUS.md audit table). A resolution
//    whose mode is not pinned is rejected, so the chokepoint can never WIDEN a
//    route's token surface (no route gains alias or email acceptance it lacked).
//  - WRITE-DENY: `intent:"write"` on a sample subject returns the
//    "sample-write-denied" marker — the route answers 403 via
//    `sampleReadOnlyResponse()` and mutates nothing.
//  - CURATED FILTER: `intent:"read"` on a sample subject returns a subject whose
//    `filterRows` is pre-bound to `sample === true` and whose seafarer is
//    pre-redacted through the SAMPLE_EXPOSED_SEAFARER_KEYS allowlist (fail-closed:
//    keys NOT on the list — emailShareToken, allowedEmails, googleSub, ownerEmail,
//    credentialUserId, personalCode, priorShareTokens, … and any FUTURE field —
//    are dropped). Real subjects pass through byte-identical (identity filter, raw
//    seafarer).
//  - An alias-mode hit on a sample subject is the same curated read-only view as
//    "open" (view-only is already alias semantics) — where alias is pinned at all.

import { NextResponse } from "next/server";
import type { DB, Seafarer } from "@/lib/db";
import { resolveSeafarerByShareToken } from "@/lib/share-access";

export type TokenIntent = "read" | "write";
export type TokenMode = "open" | "email" | "alias";

export type TokenSubject = {
  /** Pre-redacted via the sample allowlist when `isSample`; the raw row otherwise. */
  seafarer: Seafarer;
  mode: TokenMode;
  aliasMode?: "open" | "email";
  isSample: boolean;
  /** Curated-rows filter for sample subjects; identity for real subjects. */
  filterRows: <T extends { sample?: boolean }>(rows: T[]) => T[];
};

/**
 * Marker returned when a WRITE was attempted with a sample subject's token: the
 * route must answer `sampleReadOnlyResponse()` (403) — distinct from `null`
 * (no/foreign/mode-rejected token → the route's existing 404/401).
 */
export const SAMPLE_WRITE_DENIED = "sample-write-denied" as const;
export type SampleWriteDenied = typeof SAMPLE_WRITE_DENIED;

/**
 * §D8 allowlist — the ONLY Seafarer keys a public sample projection may carry.
 * Every key not listed is dropped (fail-closed for future fields).
 */
export const SAMPLE_EXPOSED_SEAFARER_KEYS = [
  "id",
  "name",
  "rank",
  "vessel",
  "vesselType",
  "flagState",
  "availability",
  "availableFrom",
  "rotationEnd",
  "reminderLeadValue",
  "reminderLeadUnit",
  "reminderCount",
  "reminderIntervalDays",
  "identityVerified",
  "identityVerifiedAt",
  "verifiedName",
  "issuerCountry",
  "birthDate",
  "autoArchiveExpired",
  "openShareToken",
  // Deprecated ALIAS of openShareToken — always the SAME value (db.ts keeps them in
  // lock-step on every read), so exposing it adds zero secret beyond the already-
  // published open token. Needed because the owner-view client reads the legacy
  // `seafarer.shareToken` field for its token-authorised file/calendar/CV URLs.
  // The PRIVATE `emailShareToken` stays excluded.
  "shareToken",
  "createdAt",
  "isSample",
] as const;

/** Allowlist projection of a sample seafarer — every unlisted key is DROPPED. */
export function redactSampleSeafarer(s: Seafarer): Seafarer {
  const out: Record<string, unknown> = {};
  for (const k of SAMPLE_EXPOSED_SEAFARER_KEYS) {
    const v = (s as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  // The projection intentionally lacks non-allowlisted REQUIRED keys
  // (emailShareToken/state) — consumers of a sample subject render read-only
  // surfaces and never rely on them (board rows re-attach `state` explicitly
  // from the sample-agency GRANT's stage in lib/sample-data.ts, never from the
  // deprecated global mirror). Cast keeps the call sites typed.
  return out as unknown as Seafarer;
}

const identityFilter = <T extends { sample?: boolean }>(rows: T[]): T[] => rows;
const curatedFilter = <T extends { sample?: boolean }>(rows: T[]): T[] =>
  rows.filter((r) => r.sample === true);

/**
 * THE chokepoint (plan §D4). Resolves `token` through the canonical resolver,
 * rejects any mode not pinned by the route, then applies the sample verdicts:
 *   - real subject             → subject with identity filter (byte-identical path)
 *   - sample subject + "read"  → curated view (filterRows→sample:true, redacted seafarer)
 *   - sample subject + "write" → SAMPLE_WRITE_DENIED (route answers 403)
 *   - no/foreign/mode-rejected → null (route keeps today's 404/401)
 */
export function resolveTokenSubject(
  db: DB,
  token: string | null | undefined,
  intent: TokenIntent,
  allowedModes: readonly TokenMode[]
): TokenSubject | SampleWriteDenied | null {
  const t = (token ?? "").trim();
  if (!t) return null;
  const resolved = resolveSeafarerByShareToken(db, t);
  if (!resolved) return null;
  if (!allowedModes.includes(resolved.mode)) return null;
  const isSample = resolved.seafarer.isSample === true;
  if (isSample && intent === "write") return SAMPLE_WRITE_DENIED;
  return {
    seafarer: isSample ? redactSampleSeafarer(resolved.seafarer) : resolved.seafarer,
    mode: resolved.mode,
    aliasMode: resolved.aliasMode,
    isSample,
    filterRows: isSample ? curatedFilter : identityFilter,
  };
}

/** The one 403 every DENY-verdict route returns for a sample-token write. */
export function sampleReadOnlyResponse(): NextResponse {
  return NextResponse.json({ ok: false, error: "Sample data is read-only." }, { status: 403 });
}

/** Cache policy for sample FILTER GET responses (content immutable between seeds). */
export const SAMPLE_CACHE_CONTROL = "public, max-age=300";

// ---- Anonymous-load limiter (v3-2, bounded per v4-5d) ----------------------
//
// Sliding-window counter keyed by the raw token string, LRU-capped so junk-token
// floods on anonymous endpoints cannot grow memory on the single box (same
// lifecycle discipline as the lib/inbox.ts limiter). Single-process in-memory —
// correct for the pinned pm2 fork (plan R14).

const SAMPLE_RATE_WINDOW_MS = 10_000;
const SAMPLE_RATE_MAX_HITS = 60;
const SAMPLE_RATE_MAX_KEYS = 4096;
const sampleRateHits = new Map<string, number[]>();

/** True when this token is over the sample-GET rate limit (route answers 429). */
export function sampleTokenRateLimited(token: string): boolean {
  const now = Date.now();
  const key = token || "<empty>";
  // LRU: Map iteration order is insertion order; re-inserting moves to the back.
  const prior = sampleRateHits.get(key) ?? [];
  sampleRateHits.delete(key);
  const hits = prior.filter((t) => now - t < SAMPLE_RATE_WINDOW_MS);
  hits.push(now);
  sampleRateHits.set(key, hits);
  // Bound: evict oldest keys beyond the cap; opportunistic stale sweep.
  while (sampleRateHits.size > SAMPLE_RATE_MAX_KEYS) {
    const oldest = sampleRateHits.keys().next().value;
    if (oldest === undefined) break;
    sampleRateHits.delete(oldest);
  }
  return hits.length > SAMPLE_RATE_MAX_HITS;
}

/** Test hook — clears the limiter map (never used by routes). */
export function _resetSampleRateLimiter(): void {
  sampleRateHits.clear();
}

// ---- pruneSampleReferences (§D9) -------------------------------------------
//
// Keeps real-user interactions with a sample subject BOUNDED. Runs INSIDE the
// same updateDB/transact mutation as any write that appends a row referencing a
// sample subject. Semantics (strip-don't-delete for shared rows):
//  - curated rows (`sample === true`) are NEVER touched;
//  - rows OWNED by the interaction (docRequests, comments, appraisals,
//    circularReplies, seaService, assignments) keep the newest
//    SAMPLE_PRUNE_CAP non-curated rows per collection, oldest deleted first;
//  - SHARED rows (Circular): beyond the cap the sample id is STRIPPED from
//    `recipientIds`; the circular row itself is dropped ONLY when its
//    recipientIds becomes empty (a mixed-recipient circular survives intact for
//    its real recipients).
// (`notifications` rows carry no seafarerId key and sample sends are skipped at
// source per §D7, so they are not pruned here.)

export const SAMPLE_PRUNE_CAP = 200;

type Dated = { createdAt?: string; sample?: boolean };

function capOwned<T extends Dated>(
  rows: T[],
  belongs: (row: T) => boolean
): T[] {
  const owned = rows.filter((r) => belongs(r) && r.sample !== true);
  if (owned.length <= SAMPLE_PRUNE_CAP) return rows;
  const sorted = owned
    .slice()
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const drop = new Set(sorted.slice(0, owned.length - SAMPLE_PRUNE_CAP));
  return rows.filter((r) => !drop.has(r));
}

export function pruneSampleReferences(db: DB, seafarerId: string): void {
  const s = db.seafarers.find((x) => x.id === seafarerId);
  if (!s || s.isSample !== true) return; // real subjects: never touched

  const bySid = (r: { seafarerId?: string | null }) => r.seafarerId === seafarerId;
  db.docRequests = capOwned(db.docRequests, bySid);
  db.comments = capOwned(db.comments, bySid);
  db.appraisals = capOwned(db.appraisals, bySid);
  db.circularReplies = capOwned(db.circularReplies, bySid);
  db.seaService = capOwned(db.seaService, bySid);
  db.assignments = capOwned(db.assignments, bySid);

  // Shared rows: strip, never delete (drop only when recipients empty).
  const referencing = db.circulars.filter(
    (c) => c.sample !== true && c.recipientIds.includes(seafarerId)
  );
  if (referencing.length > SAMPLE_PRUNE_CAP) {
    const sorted = referencing
      .slice()
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const strip = new Set(sorted.slice(0, referencing.length - SAMPLE_PRUNE_CAP));
    for (const c of db.circulars) {
      if (!strip.has(c)) continue;
      c.recipientIds = c.recipientIds.filter((id) => id !== seafarerId);
    }
    db.circulars = db.circulars.filter((c) => c.recipientIds.length > 0);
  }
}
