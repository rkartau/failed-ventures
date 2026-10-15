// #52 — Vacancy candidate matching (agency-internal). CLIENT-SAFE (type-only Doc /
// Seafarer / Vacancy import, no Node built-ins) so the server page builds candidates
// off the grant-scoped roster and the browser component renders the SAME scores.
//
// The v2 signature deferred expiry to `buildSearchRow`, which judges validity as of
// TODAY against the SEAMAN's own rotation and passes NO duplicates — so a mid-voyage-
// lapsing cert counted as full coverage and a cloned-CoC candidate ranked top. This
// RE-RUNS `assignmentBlockers` per candidate against the VACANCY voyage window [C1]:
// a required slot counts toward coverage ONLY when filled by a cert valid THROUGH the
// voyage (excludes expired + lapsing-before-rotationEnd); a fleet-duplicate cert
// number nulls seaReady/qualified.

import type { Vacancy, Seafarer, Doc, SeaServiceEntry } from "@/lib/db";
import type { DuplicateNameIndex } from "@/lib/duplicates";
import type { Availability } from "@/lib/availability";
import { assignmentBlockers } from "@/lib/compliance";
import { effectiveValidUntil } from "@/lib/cert-rules";
import { qualifyingDaysInWindow, REVALIDATION_WINDOW_MONTHS } from "@/lib/sea-service";
import { buildSearchRow, type RosterSearchRow } from "@/lib/roster-search";
import { classifyRequiredType, type RequiredDocType } from "@/lib/doctypes";
import {
  normalizeRank,
  normalizeVesselType,
  normalizeFlag,
} from "@/lib/required-docs";
import {
  profileVerificationSummary,
  type VerificationLevel,
} from "@/lib/verification-level";

export type CandidateInput = {
  seafarer: Seafarer;
  docs: Doc[];
  entries: SeaServiceEntry[];
  atSea: boolean;
};

export type CandidateScore = {
  /** Display ref (agency-internal, but consistent). */
  ref: string;
  row: RosterSearchRow;
  /** validThroughVoyage(required) / requiredCount [C1]. */
  certCoverage: number;
  missingCerts: RequiredDocType[];
  /** Held for the slot but expired OR lapsing before vacancy.rotationEnd [C1]. */
  heldButExpiring: RequiredDocType[];
  /** Fleet duplicate cert number — nulls seaReady/qualified [C1]. */
  possibleForgery: boolean;
  seaTimeQualifies: boolean;
  seaDaysInWindow: number;
  /** The vacancy's required sea-time (days); 0 = no sea-time gate. For an honest
   *  "Needs Nd · has Md" readout instead of a bare "short" [C]. */
  minSeaDaysRequired: number;
  rankMatch: boolean;
  vesselTypeMatch: boolean;
  flagMatch: boolean;
  verificationFloor: VerificationLevel;
  /** !assignmentBlockers(...).blocked against the VACANCY window. */
  seaReady: boolean;
  availability?: Availability;
  atSea: boolean;
  availableFrom: string | null;
  /** certs fully covered (through voyage) AND sea-time OK AND no forgery [C1]. */
  qualified: boolean;
  score: number;
};

// Documented weights [R52.15]: dominant certCoverage + seaTimeQualifies; the rest are
// tie-breakers only. A `qualified=false` candidate sinks below EVERY qualified one
// regardless of soft points (the large QUALIFIED_BONUS guarantees the ordering).
const W_CERT = 50;
const W_SEATIME = 30;
const W_RANK = 5;
const W_VESSEL = 5;
const W_FLAG = 5;
const W_VERIFICATION = 5; // scaled over floor 0..3
const QUALIFIED_BONUS = 1000;

function slotTypeOf(d: Doc): RequiredDocType | null {
  return (
    d.requiredType ??
    classifyRequiredType({ title: d.title, docType: d.docType, docCategory: d.docCategory })
  );
}

// A held doc that survives the voyage: not expired today AND (no rotationEnd, or its
// effective expiry is on/after rotationEnd). A null/absent expiry is not a lapse
// blocker (mirrors compliance.ts, which never treats unknown-expiry as expired).
function docSurvivesVoyage(
  expiry: string | null,
  rotationEnd: string | null,
  now: Date
): boolean {
  if (!expiry) return true;
  const t = new Date(expiry).getTime();
  if (isNaN(t)) return true;
  if (t <= now.getTime()) return false; // expired today
  if (rotationEnd) {
    const re = new Date(rotationEnd).getTime();
    if (!isNaN(re) && t < re) return false; // lapses before voyage end
  }
  return true;
}

/**
 * Score each candidate against the vacancy, desc by score, stable name tiebreak. The
 * fleet `duplicates` index is built ONCE by the caller [C1] and threaded into every
 * candidate's `assignmentBlockers` so a cloned-cert-number candidate is caught.
 */
export function matchCandidates(
  vacancy: Vacancy,
  candidates: CandidateInput[],
  duplicates: DuplicateNameIndex,
  now: Date = new Date()
): CandidateScore[] {
  const required = Array.from(
    new Set<RequiredDocType>([...vacancy.requiredCerts, ...(vacancy.requiredEndorsements ?? [])])
  );
  const rotationEnd = vacancy.rotationEnd ?? null;
  const seaWindowMonths =
    typeof vacancy.seaWindowMonths === "number" && vacancy.seaWindowMonths > 0
      ? vacancy.seaWindowMonths
      : REVALIDATION_WINDOW_MONTHS;
  const minSeaDays =
    typeof vacancy.minSeaDays === "number" && vacancy.minSeaDays > 0 ? vacancy.minSeaDays : 0;

  const vRank = normalizeRank(vacancy.rank);
  const vVessel = normalizeVesselType(vacancy.vesselType);
  const vFlag = normalizeFlag(vacancy.flagState);

  const scored = candidates.map((cand) => {
    const { seafarer, docs, entries, atSea } = cand;
    const dob = seafarer.birthDate ?? null;

    // Re-run the board sea-readiness rule against the VACANCY voyage window [C1].
    const block = assignmentBlockers(docs, {
      required,
      rankIncomplete: false,
      rotationEnd,
      holderDOB: dob,
      duplicates,
      ownName: seafarer.name,
      now,
    });
    const possibleForgery = block.forgeries.length > 0;
    const seaReady = !block.blocked;

    // Per-required-slot coverage through the voyage.
    const missingCerts: RequiredDocType[] = [];
    const heldButExpiring: RequiredDocType[] = [];
    let covered = 0;
    for (const rt of required) {
      const matching = docs.filter((d) => slotTypeOf(d) === rt);
      if (matching.length === 0) {
        missingCerts.push(rt);
        continue;
      }
      const anyOk = matching.some((d) =>
        docSurvivesVoyage(effectiveValidUntil(d, dob), rotationEnd, now)
      );
      if (anyOk) covered++;
      else heldButExpiring.push(rt);
    }
    const certCoverage = required.length ? covered / required.length : 1;

    const seaDaysInWindow = qualifyingDaysInWindow(entries, seaWindowMonths, now);
    const seaTimeQualifies = minSeaDays <= 0 ? true : seaDaysInWindow >= minSeaDays;

    const rankMatch = vRank == null ? true : normalizeRank(seafarer.rank) === vRank;
    const vesselTypeMatch = vVessel == null ? true : normalizeVesselType(seafarer.vesselType) === vVessel;
    const flagMatch = vFlag == null ? true : normalizeFlag(seafarer.flagState) === vFlag;
    const verificationFloor = profileVerificationSummary(seafarer, docs).floor;

    const certsFullyCovered = covered === required.length;
    const qualified = certsFullyCovered && seaTimeQualifies && !possibleForgery;

    const soft =
      certCoverage * W_CERT +
      (seaTimeQualifies ? W_SEATIME : 0) +
      (rankMatch ? W_RANK : 0) +
      (vesselTypeMatch ? W_VESSEL : 0) +
      (flagMatch ? W_FLAG : 0) +
      (verificationFloor / 3) * W_VERIFICATION;
    const score = (qualified ? QUALIFIED_BONUS : 0) + soft;

    return {
      ref: seafarer.id,
      row: buildSearchRow(seafarer, docs, null),
      certCoverage,
      missingCerts,
      heldButExpiring,
      possibleForgery,
      seaTimeQualifies,
      seaDaysInWindow,
      minSeaDaysRequired: minSeaDays,
      rankMatch,
      vesselTypeMatch,
      flagMatch,
      verificationFloor,
      seaReady,
      availability: seafarer.availability,
      atSea,
      availableFrom: seafarer.availableFrom ?? null,
      qualified,
      score,
    } satisfies CandidateScore;
  });

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.row.name.localeCompare(b.row.name);
  });
}
