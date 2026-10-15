// The SINGLE external projection (#42 + #49) — one allow-list, no drift [§0.1].
//
// `client-view.ts` is the ONLY module that shapes anything an EXTERNAL client sees:
// both the shipowner read-portal (#42) AND the docka-verified directory (#49) go
// through `projectClientCrewRow`. It copies ONLY the whitelisted fields and NEVER
// documents / ids / fileName / personalCode / birthDate / contact / notes / tokens /
// tenant refs. Forgery is reduced to a BOOLEAN (other-crew names stripped).
//
// PURE + CLIENT-SAFE (type-only Doc/Seafarer import, no Node built-ins): the
// non-reversible `ref`, the fleet duplicates index and the voyage window are passed
// IN (the server computes them), so this module needs no crypto and unit-tests
// headless. `birthDate`/DOB flows IN as `holderDOB` and is NEVER a field of the
// output [C3].

import type { Doc, Seafarer } from "@/lib/db";
import type { RequiredDocsConfig } from "@/lib/required-docs";
import type { DuplicateNameIndex } from "@/lib/duplicates";
import { EXPIRING_DAYS, type DocStatus } from "@/lib/cert";
import { effectiveValidUntil } from "@/lib/cert-rules";
import { requiredSetFor } from "@/lib/required-docs";
import { classifyRequiredType, type RequiredDocType } from "@/lib/doctypes";
import {
  verificationLevelForDoc,
  profileVerificationSummary,
  type VerificationLevel,
} from "@/lib/verification-level";
import { assignmentBlockers } from "@/lib/compliance";

/** Required slots whose expiry a client should see dated (safety-critical) [R42.3]. */
const SAFETY_CRITICAL: ReadonlySet<RequiredDocType> = new Set<RequiredDocType>([
  "Medical",
  "Basic Safety Training",
  "Advanced Fire Fighting",
  "Tanker Familiarisation",
  "Endorsement",
]);

export type ClientSlot = {
  requiredType: RequiredDocType;
  present: boolean;
  /** 0..3 per slot (gov-verified vs self-uploaded). */
  level: VerificationLevel;
  /** EFFECTIVE legal expiry (age-aware), or null. */
  expiry: string | null;
  /** Status JUDGED AGAINST the voyage window (valid | expiring | expired | unknown). */
  status: DocStatus;
  safetyCritical: boolean;
};

export type ClientCrewRow = {
  /** Non-reversible per-surface HMAC, supplied by the caller [R42.7/C6/C9]. */
  ref: string;
  /** Surname-masked by default [R42.4]. */
  name: string;
  rank: string;
  /** issuerCountry, NOT nationality [R42.8]. */
  issuingCountry: string;
  identityVerified: boolean;
  verificationHeadline: string;
  verificationFloor: VerificationLevel;
  governmentVerifiedDocs: number;
  seaReady: boolean;
  /** Forgery = BOOLEAN only; other-crew names stripped [R42.1]. */
  possibleForgery: boolean;
  expiredCount: number;
  expiringCount: number;
  /** Per-required-slot breakdown [R42.3]. */
  slots: ClientSlot[];
};

export type ClientViewOpts = {
  /** Non-reversible ref computed server-side (surfaceRef). */
  ref: string;
  /** Surname masking — default TRUE. */
  masked?: boolean;
  duplicates?: DuplicateNameIndex;
  ownName?: string;
  /** Voyage window override [R42.2]. */
  rotationEnd?: string | null;
  holderDOB?: string | null;
  /** Clock injection for deterministic tests. */
  now?: Date;
};

/** "Priya Sharma" -> "Priya S."; a single word is unchanged. */
export function maskSurname(full: string): string {
  const s = (full ?? "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  if (parts.length < 2) return s;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  const initial = last.charAt(0).toUpperCase();
  return `${first} ${initial}.`;
}

function slotTypeOf(d: Doc): RequiredDocType | null {
  return (
    d.requiredType ??
    classifyRequiredType({ title: d.title, docType: d.docType, docCategory: d.docCategory })
  );
}

// Status of an effective expiry as of `now`, injectable for tests (docStatus in
// cert.ts is wall-clock only).
function statusAt(expiry: string | null, now: Date): DocStatus {
  if (!expiry) return "unknown";
  const d = new Date(expiry);
  if (isNaN(d.getTime())) return "unknown";
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return "expired";
  if (days < EXPIRING_DAYS) return "expiring";
  return "valid";
}

// Judge a doc's status against the VOYAGE WINDOW: a cert valid today but lapsing
// before rotationEnd reads "expiring" (not sea-ready for the voyage) [R42.2/C1].
//
// Doc-aware short-circuit (mirrors cert.ts docStatusForDoc): a `noExpiry` perpetual
// doc is compliant and resolves to "none" REGARDLESS of any date or the voyage
// window — it can never read expired/expiring/unknown. Done here (not via
// docStatusForDoc) to preserve the injectable `now` this helper relies on.
function statusAgainstWindow(
  expiry: string | null,
  rotationEnd: string | null | undefined,
  now: Date,
  noExpiry?: boolean
): DocStatus {
  if (noExpiry === true) return "none";
  const base = statusAt(expiry, now);
  if (base !== "valid" && base !== "expiring") return base; // expired / unknown stand
  if (rotationEnd && expiry) {
    const vu = new Date(expiry).getTime();
    const re = new Date(rotationEnd).getTime();
    if (!isNaN(vu) && !isNaN(re) && vu < re) return "expiring";
  }
  return base;
}

// Prefer the doc with the LATEST effective expiry (best coverage); a null expiry
// sorts as weakest coverage.
function laterExpiry(a: string | null, b: string | null): boolean {
  if (a === b) return false;
  if (a === null) return false;
  if (b === null) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}

/**
 * Project a seafarer + their (already grant-scoped, active) documents into ONE
 * external-safe crew row. `config` is the acting agent's required-docs config (or
 * null). Steps [§0.1]:
 *  1. requiredSetFor -> required slots;
 *  2. per-slot verificationLevelForDoc + effectiveValidUntil(doc,holderDOB) + status
 *     JUDGED AGAINST the voyage window [R42.2/R42.3];
 *  3. assignmentBlockers(docs, {duplicates, ownName, rotationEnd, holderDOB, required,
 *     rankIncomplete, now}) -> seaReady = !blocked ; possibleForgery = forgeries>0 [R42.1];
 *  4. ALLOW-LIST build — copy ONLY the whitelisted fields; never documents[].id /
 *     fileName / selfProfile / comments / tokens / DOB.
 */
export function projectClientCrewRow(
  seafarer: Seafarer,
  docs: Doc[],
  config: RequiredDocsConfig | null,
  opts: ClientViewOpts
): ClientCrewRow {
  const now = opts.now ?? new Date();
  const holderDOB = opts.holderDOB ?? null;
  const rotationEnd = opts.rotationEnd ?? null;
  const masked = opts.masked !== false; // default TRUE

  const req = requiredSetFor({
    rank: seafarer.rank,
    config,
    vesselType: seafarer.vesselType,
    flag: seafarer.flagState,
  });

  // 1+2. Per-required-slot breakdown.
  const slots: ClientSlot[] = req.required.map((rt) => {
    const matching = docs.filter((d) => slotTypeOf(d) === rt);
    if (matching.length === 0) {
      return {
        requiredType: rt,
        present: false,
        level: 0 as VerificationLevel,
        expiry: null,
        status: "unknown" as DocStatus,
        safetyCritical: SAFETY_CRITICAL.has(rt),
      };
    }
    let best = matching[0];
    let bestExp = effectiveValidUntil(best, holderDOB);
    let bestLvl = verificationLevelForDoc(best);
    for (let i = 1; i < matching.length; i++) {
      const d = matching[i];
      const exp = effectiveValidUntil(d, holderDOB);
      const lvl = verificationLevelForDoc(d);
      if (laterExpiry(exp, bestExp) || (exp === bestExp && lvl > bestLvl)) {
        best = d;
        bestExp = exp;
        bestLvl = lvl;
      }
    }
    return {
      requiredType: rt,
      present: true,
      level: bestLvl,
      expiry: bestExp,
      status: statusAgainstWindow(bestExp, rotationEnd, now, best.noExpiry),
      safetyCritical: SAFETY_CRITICAL.has(rt),
    };
  });

  // 3. Sea-readiness + forgery via the SAME rule the agency board uses.
  const block = assignmentBlockers(docs, {
    duplicates: opts.duplicates,
    ownName: opts.ownName ?? seafarer.name,
    rotationEnd,
    holderDOB,
    required: req.required,
    rankIncomplete: !req.rankKnown,
    now,
  });

  // Expiry counts across ALL held docs, judged against the voyage window.
  let expiredCount = 0;
  let expiringCount = 0;
  for (const d of docs) {
    const st = statusAgainstWindow(effectiveValidUntil(d, holderDOB), rotationEnd, now, d.noExpiry);
    if (st === "expired") expiredCount++;
    else if (st === "expiring") expiringCount++;
  }

  const summary = profileVerificationSummary(seafarer, docs);
  const displayName = (seafarer.verifiedName || seafarer.name || "Seafarer").trim();

  // 4. ALLOW-LIST build — ONLY these fields ever leave the server.
  return {
    ref: opts.ref,
    name: masked ? maskSurname(displayName) : displayName,
    rank: (seafarer.rank || "").trim(),
    // NOTE: the seafarer's CURRENT/other-vessel assignment name is deliberately NOT
    // projected — the portal is a PROPOSED crew list for the client's own vessel (shown
    // in the portal header), never a disclosure of where the crew currently sails [R42].
    issuingCountry: (seafarer.issuerCountry || "").trim(),
    identityVerified: seafarer.identityVerified === true,
    verificationHeadline: summary.headline,
    verificationFloor: summary.floor,
    governmentVerifiedDocs: summary.counts[3],
    seaReady: !block.blocked,
    possibleForgery: block.forgeries.length > 0,
    expiredCount,
    expiringCount,
    slots,
  };
}
