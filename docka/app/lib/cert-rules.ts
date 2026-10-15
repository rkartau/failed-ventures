// Certificate-type validity-rule library — client-safe (no Node built-ins) so the
// server compliance gate, the agent board / review UI, and the public verify card
// all consume ONE rule set.
//
// WHY THIS EXISTS
// docka today trusts the printed expiry date on a document. That is wrong for a
// whole class of certificates whose LEGAL validity is shorter than the printed one
// implies:
//   - A seafarer medical (ENG1) is normally valid 2 years, but only 1 YEAR once the
//     holder is 55 or older (and for under-18s). A medical issued to a 56-year-old
//     that prints "valid 2028" is legally expired in 2027 — invisible to a junior
//     agent who reads the printed date. This is exactly the silent gap MCA/AMSA
//     inspectors catch by hand.
//   - CoC/CoP, flag CoE, DCE and STCW refreshers each carry a fixed statutory
//     window, so an implausible printed date (a typo, a bad OCR read, a forged
//     "valid 2035") can be sanity-checked against the rule window.
//
// This library maps a document to its certificate rule, then computes the TRUE
// legal expiry from { rule, printed expiry, issue date, holder date-of-birth }.
// compliance.ts consumes `effectiveValidUntil` so a legally-expired-but-printed-
// valid document hard-blocks assignment and shows in the "Attention needed" table;
// the cert card surfaces a "legal expiry differs from printed" note.

import type { Doc, SeaServiceEntry } from "@/lib/db";
import {
  qualifyingDaysInWindow,
  REVALIDATION_WINDOW_MONTHS,
} from "@/lib/sea-service";

export type CertRuleType =
  | "coc" // STCW Certificate of Competency / Proficiency — 5y
  | "medical" // Seafarer medical (ENG1 etc.) — 2y, 1y when age >= 55 or < 18
  | "ml5" // ML5 (UK boatmaster/inland) medical — 5y
  | "coe" // Flag-state Certificate of Endorsement / recognition — 3y
  | "dce" // Dangerous Cargo Endorsement — 5y
  | "safety"; // STCW basic safety training / refresher — 5y

export type CertRule = {
  type: CertRuleType;
  label: string;
  /** Standard full statutory validity window, in months. */
  standardMonths: number;
  /** Reduced window (months) when an age rule applies; omitted = no age rule. */
  ageRestrictedMonths?: number;
  /** Age BELOW which the reduced window applies (e.g. under-18 medical = 1y). */
  youngThreshold?: number;
  /** Age AT/ABOVE which the reduced window applies (e.g. 55+ medical = 1y). */
  oldThreshold?: number;
  /** Recommended renewal lead time, in days, ahead of the (legal) expiry. */
  renewalLeadDays: number;
  /**
   * Qualifying seagoing-service days the holder must have served in the last
   * `REVALIDATION_WINDOW_MONTHS` (5 years) to take the CHEAP short revalidation
   * path instead of the expensive refresher / re-assessment course. Only STCW
   * certificates whose renewal is conditioned on recent sea service carry this
   * (a CoC/CoP). Omitted = renewal is not sea-time-gated (a medical re-exam, a
   * refresher-only safety cert), so the revalidation-path gate does not apply.
   */
  revalidationSeaDays?: number;
};

// The rule table. Windows follow STCW / MLC + MCA(ENG1)/AMSA age-based medical.
export const CERT_RULES: Record<CertRuleType, CertRule> = {
  coc: { type: "coc", label: "Certificate of competency", standardMonths: 60, renewalLeadDays: 90, revalidationSeaDays: 360 },
  medical: {
    type: "medical",
    label: "Seafarer medical (ENG1)",
    standardMonths: 24,
    ageRestrictedMonths: 12,
    youngThreshold: 18,
    oldThreshold: 55,
    renewalLeadDays: 60,
  },
  ml5: { type: "ml5", label: "ML5 medical", standardMonths: 60, renewalLeadDays: 60 },
  coe: { type: "coe", label: "Flag-state endorsement (CoE)", standardMonths: 36, renewalLeadDays: 90 },
  dce: { type: "dce", label: "Dangerous cargo endorsement", standardMonths: 60, renewalLeadDays: 90 },
  safety: { type: "safety", label: "Basic safety training (STCW)", standardMonths: 60, renewalLeadDays: 90 },
};

// ---- Classification ----------------------------------------------------
//
// Map a document to its certificate rule. Keyword patterns are evaluated in array
// order (first match wins) so the SPECIFIC types (ML5, DCE) beat the generic ones
// (medical, endorsement); the government docCategory is used as a fallback default.

const RULE_PATTERNS: { type: CertRuleType; patterns: RegExp[] }[] = [
  { type: "ml5", patterns: [/\bml\s*5\b/i, /ml5/i] },
  { type: "dce", patterns: [/dangerous\s*cargo/i, /\bDCE\b/i, /tanker\s*endorsement/i] },
  {
    type: "medical",
    patterns: [/\beng\s*1\b/i, /medical/i, /fit\s*for\s*(sea|duty)/i, /health/i, /tervis/i],
  },
  {
    type: "coe",
    patterns: [/endorsement/i, /recognition/i, /\bCoE\b/i, /flag\s*state/i],
  },
  {
    type: "coc",
    patterns: [/competenc/i, /\bCoC\b/i, /\bCoP\b/i, /proficiency/i, /master/i, /officer/i, /engineer/i],
  },
  {
    type: "safety",
    patterns: [/basic\s*safety/i, /\bBST\b/i, /safety\s*training/i, /personal\s*survival/i, /fire\s*fighting/i, /first\s*aid/i, /\bSTCW\b/i],
  },
];

function fromDocCategory(docCategory: string | null | undefined): CertRuleType | null {
  switch (docCategory) {
    case "medical":
      return "medical";
    case "endorsement":
      return "coe";
    case "competency":
    case "qualification":
      return "coc";
    default:
      return null;
  }
}

/** Best-effort certificate-rule classification, or null when no rule is known. */
export function classifyCertRule(input: {
  title?: string | null;
  docType?: string | null;
  docCategory?: string | null;
  certificateType?: string | null;
}): CertRuleType | null {
  const hay = `${input.title ?? ""} ${input.docType ?? ""} ${input.certificateType ?? ""}`;
  for (const r of RULE_PATTERNS) {
    if (r.patterns.some((re) => re.test(hay))) return r.type;
  }
  // Keyword miss — fall back to the government category default.
  return fromDocCategory(input.docCategory);
}

// ---- Date maths (UTC, calendar-correct) --------------------------------

function parseDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Add whole months to a UTC date, clamping day-of-month overflow (e.g. Jan 31 + 1m). */
function addMonthsUTC(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** Whole years between two dates (age), or null when DOB is unknown/unparseable. */
function ageAt(dob: string | null | undefined, at: Date): number | null {
  const b = parseDay(dob);
  if (!b) return null;
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  const m = at.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- Legal expiry computation ------------------------------------------

export type LegalExpiryInfo = {
  /** The matched rule, or null when the document type carries no rule. */
  ruleType: CertRuleType | null;
  /** The printed / registry-stated expiry (unchanged), day-normalised or null. */
  printedValidUntil: string | null;
  /** The TRUE legal expiry (<= printed). Falls back to printed when no correction. */
  legalValidUntil: string | null;
  /** True when the legal expiry is meaningfully EARLIER than the printed one. */
  differs: boolean;
  /** True when an age-based medical rule shortened the window. */
  ageRestricted: boolean;
  /** Holder age at the (derived) issue date, when it drove the correction. */
  ageAtIssue: number | null;
  /** Short human explanation, ready for a badge / audit note; null when no rule. */
  reason: string | null;
};

/**
 * Compute the legally-correct expiry for a document from its certificate rule.
 *
 * Because the store does not persist an issue date, when `issuedOn` is not supplied
 * the issue date is DERIVED as `printedValidUntil - standardMonths` (the printed
 * expiry implies a standard-window issue). The legal expiry is then
 * `issue + ageRestrictedMonths`, capped at the printed date (we never EXTEND a
 * printed expiry — only shorten it when the law says the window is shorter).
 */
export function computeLegalExpiry(opts: {
  ruleType: CertRuleType | null;
  printedValidUntil: string | null | undefined;
  issuedOn?: string | null;
  holderDOB?: string | null;
}): LegalExpiryInfo {
  const printed = parseDay(opts.printedValidUntil);
  const printedIso = printed ? isoDay(printed) : null;

  const base: LegalExpiryInfo = {
    ruleType: opts.ruleType,
    printedValidUntil: printedIso,
    legalValidUntil: printedIso,
    differs: false,
    ageRestricted: false,
    ageAtIssue: null,
    reason: null,
  };

  if (!opts.ruleType || !printed) return base;
  const rule = CERT_RULES[opts.ruleType];

  // No age rule on this type → the printed date is the legal date (nothing to do).
  if (rule.ageRestrictedMonths == null) return base;

  // Issue date: use a supplied one, else derive from the printed standard window.
  const issued = parseDay(opts.issuedOn) ?? addMonthsUTC(printed, -rule.standardMonths);
  const age = ageAt(opts.holderDOB, issued);
  if (age == null) return base; // DOB unknown — cannot apply the age rule, stay honest.

  const restricted =
    (rule.oldThreshold != null && age >= rule.oldThreshold) ||
    (rule.youngThreshold != null && age < rule.youngThreshold);
  if (!restricted) return base;

  // Legal window is shorter — compute and cap at the printed date.
  let legal = addMonthsUTC(issued, rule.ageRestrictedMonths);
  if (legal.getTime() > printed.getTime()) legal = printed;
  const legalIso = isoDay(legal);
  const differs = legal.getTime() < printed.getTime();

  const years = (rule.ageRestrictedMonths / 12).toFixed(0);
  const boundary =
    rule.oldThreshold != null && age >= rule.oldThreshold
      ? `age ${age} (${rule.oldThreshold}+)`
      : `age ${age} (under ${rule.youngThreshold})`;

  return {
    ...base,
    legalValidUntil: legalIso,
    differs,
    ageRestricted: true,
    ageAtIssue: age,
    reason: differs
      ? `${rule.label}: holder was ${boundary} at issue — ${years}-year validity applies; legal expiry ${legalIso} is earlier than the printed ${printedIso}.`
      : `${rule.label}: ${years}-year validity applies for ${boundary}.`,
  };
}

/** Convenience: full legal-expiry info for a stored document + its holder's DOB. */
export function legalExpiryForDoc(doc: Doc, holderDOB?: string | null): LegalExpiryInfo {
  const ruleType = classifyCertRule({
    title: doc.title,
    docType: doc.docType,
    docCategory: doc.docCategory,
  });
  return computeLegalExpiry({
    ruleType,
    printedValidUntil: doc.validUntil,
    holderDOB: holderDOB ?? null,
  });
}

/**
 * The date compliance / reminders should treat as the document's real expiry: the
 * legal expiry when a rule shortens it, otherwise the stored `validUntil` untouched.
 */
export function effectiveValidUntil(doc: Doc, holderDOB?: string | null): string | null {
  const info = legalExpiryForDoc(doc, holderDOB);
  return info.legalValidUntil ?? doc.validUntil ?? null;
}

// ---- Revalidation-path gate (T2.3, needs the sea-service ledger T2.2) ----
//
// An STCW Certificate of Competency does NOT simply "renew". Its holder must show
// approved seagoing service — ≥360 qualifying days in the preceding 5 years — to
// take the cheap SHORT REVALIDATION path. Fall short of that and the only route
// back to a valid ticket is the expensive REFRESHER / re-assessment course (weeks
// of training, real money, and lead time that can miss a join date). Junior agents
// and seamen constantly misjudge this — they see a future printed expiry and assume
// a quick renewal — so we classify the path explicitly and WARN the moment an
// approaching expiry lands on the costly side. This never HARD-blocks assignment
// (the cert is still valid today); it is advisory so cost + on-time deployability
// are visible before the expiry, not discovered at renewal.

export type RevalidationPath = "revalidation" | "refresher";

export type RevalidationAssessment = {
  ruleType: CertRuleType;
  /** Certificate label, for a badge / table cell. */
  label: string;
  /** Qualifying days required in the window for the cheap short-revalidation path. */
  requiredDays: number;
  /** The seafarer's qualifying sea-service days inside the window. */
  qualifyingDays: number;
  /** The revalidation window, in months (5 years). */
  windowMonths: number;
  /** "revalidation" (meets the sea-time floor) or "refresher" (short of it). */
  path: RevalidationPath;
  /** Days of qualifying service still short of the threshold (0 when met). */
  shortfallDays: number;
  /** The (legal) expiry this assessment is anchored to. */
  validUntil: string | null;
  /** Whole days until the (legal) expiry; negative once expired. Null when unknown. */
  daysToExpiry: number | null;
  /** True when the (legal) expiry is inside the rule's renewal lead window (or past). */
  approaching: boolean;
  /** True when an approaching expiry falls on the COSTLY refresher path — the warn. */
  costlyWarning: boolean;
  /** Ready-to-show explanation of the path and what it implies. */
  reason: string;
};

/** True when this certificate's renewal is conditioned on recent seagoing service. */
export function certNeedsSeaServiceRevalidation(ruleType: CertRuleType | null): boolean {
  if (!ruleType) return false;
  return CERT_RULES[ruleType].revalidationSeaDays != null;
}

function daysBetween(from: Date, toIso: string | null): number | null {
  if (!toIso) return null;
  const d = parseDay(toIso);
  if (!d) return null;
  return Math.floor((d.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Classify the revalidation path for ONE sea-time-gated certificate. Returns null
 * for a certificate whose renewal is not conditioned on sea service (no gate).
 */
export function assessRevalidationPath(opts: {
  ruleType: CertRuleType | null;
  /** The document's LEGAL expiry (from effectiveValidUntil), or its printed date. */
  validUntil: string | null | undefined;
  /** The holder's qualifying sea-service days in the revalidation window. */
  qualifyingDays: number;
  now?: Date;
}): RevalidationAssessment | null {
  if (!opts.ruleType) return null;
  const rule = CERT_RULES[opts.ruleType];
  const requiredDays = rule.revalidationSeaDays;
  if (requiredDays == null) return null; // not a sea-time-gated certificate

  const now = opts.now ?? new Date();
  const qualifyingDays = Math.max(0, Math.floor(opts.qualifyingDays));
  const meets = qualifyingDays >= requiredDays;
  const path: RevalidationPath = meets ? "revalidation" : "refresher";
  const shortfallDays = meets ? 0 : requiredDays - qualifyingDays;

  const validUntil = opts.validUntil ?? null;
  const daysToExpiry = daysBetween(now, validUntil);
  // "Approaching" once inside the renewal lead window, and still true once expired
  // (an expired sea-time-gated cert on the refresher path is the sharpest warning).
  const approaching = daysToExpiry != null && daysToExpiry <= rule.renewalLeadDays;
  const costlyWarning = approaching && path === "refresher";

  const windowYears = REVALIDATION_WINDOW_MONTHS / 12;
  const reason = meets
    ? `${rule.label}: ${qualifyingDays} qualifying sea days in the last ${windowYears}y meet the ≥${requiredDays}-day floor — the cheap short revalidation applies.`
    : `${rule.label}: only ${qualifyingDays} qualifying sea days in the last ${windowYears}y (need ≥${requiredDays}) — short by ${shortfallDays} day(s), so renewal likely needs the expensive refresher / re-assessment course.`;

  return {
    ruleType: opts.ruleType,
    label: rule.label,
    requiredDays,
    qualifyingDays,
    windowMonths: REVALIDATION_WINDOW_MONTHS,
    path,
    shortfallDays,
    validUntil,
    daysToExpiry,
    approaching,
    costlyWarning,
    reason,
  };
}

/**
 * Revalidation-path assessment for a stored document, given the holder's whole
 * sea-service ledger + DOB (for the legal expiry). Null when the document is not a
 * sea-time-gated certificate.
 */
export function revalidationForDoc(
  doc: Doc,
  seaServiceEntries: SeaServiceEntry[],
  holderDOB?: string | null,
  now: Date = new Date()
): RevalidationAssessment | null {
  const ruleType = classifyCertRule({
    title: doc.title,
    docType: doc.docType,
    docCategory: doc.docCategory,
  });
  if (!certNeedsSeaServiceRevalidation(ruleType)) return null;
  const qualifyingDays = qualifyingDaysInWindow(
    seaServiceEntries,
    REVALIDATION_WINDOW_MONTHS,
    now
  );
  return assessRevalidationPath({
    ruleType,
    validUntil: effectiveValidUntil(doc, holderDOB),
    qualifyingDays,
    now,
  });
}
