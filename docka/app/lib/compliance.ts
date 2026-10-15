// Compliance gate for advancing a seafarer toward a ship — client-safe (no Node
// built-ins) so both the server PATCH route (authoritative hard block) and the
// agent board / review UI (disable + explain the block) share ONE rule.
//
// A crewing agent must never be able to ASSIGN or ADVANCE an out-of-compliance
// man toward a vessel: the whole point of the pipeline is to stop a bad
// assignment before the vessel sails. "Assignment" is not only the final "Sent to
// sea" hop — moving a man into "Accepted" already commits him to a rotation, so
// BOTH forward states are gated. A move into a gated state is HARD-BLOCKED when
// the seafarer has:
//   - any EXPIRED document (a lapsed CoC / medical / fire cert), or
//   - any MISSING required document (Basic Safety Training, Medical, Endorsement,
//     Seaman book, Passport), or
//   - a POSSIBLE FORGERY: a certificate number shared with another crew member
//     (a classic forged-STCW signal), or
//   - a document that is valid today but EXPIRES BEFORE THE END OF THE ROTATION
//     (a cert that lapses mid-voyage is not sea-ready for that voyage).
// The block is enforced on the server; the client mirrors it so the button
// explains itself instead of silently failing. A documented override (an explicit
// reason recorded to the audit trail) by a signed-in agent is the only way past.

import type { Doc } from "@/lib/db";
import { docStatus } from "@/lib/cert";
import { BASE_REQUIRED_DOC_TYPES, missingFrom, type RequiredDocType } from "@/lib/doctypes";
import { SEAFARER_STATES, type SeafarerState } from "@/lib/pipeline";
import { docNumber, duplicateOthers, type DuplicateNameIndex } from "@/lib/duplicates";
import {
  legalExpiryForDoc,
  assessRevalidationPath,
  certNeedsSeaServiceRevalidation,
  classifyCertRule,
  type CertRuleType,
} from "@/lib/cert-rules";
import { qualifyingDaysInWindow, REVALIDATION_WINDOW_MONTHS } from "@/lib/sea-service";
import type { SeaServiceEntry } from "@/lib/db";

export type ExpiredDoc = {
  title: string;
  requiredType: RequiredDocType | null;
  /** The date this document is judged against — the LEGAL expiry when a cert rule
   * shortened it (age-based medical etc.), otherwise the printed `validUntil`. */
  validUntil: string | null;
  /** The printed / registry-stated expiry, when it differs from the legal one. */
  printedValidUntil?: string | null;
  /** True when an age-based medical rule made this legally expire before its print. */
  ageRestricted?: boolean;
};

export type Forgery = {
  title: string;
  number: string;
  /** Other crew names carrying the same certificate number. */
  others: string[];
};

// Advisory (NON-blocking) flag: a sea-time-gated certificate (a CoC) whose
// approaching expiry falls on the costly refresher path because the holder is short
// of the ≥360-qualifying-days-in-5-years floor. Surfaced so cost + lead time are
// visible before renewal; it never hard-blocks assignment (the cert is valid today).
export type RevalWarning = {
  title: string;
  ruleType: CertRuleType;
  /** Qualifying sea-service days in the 5-year window. */
  qualifyingDays: number;
  /** Days required for the cheap short-revalidation path. */
  requiredDays: number;
  /** How many days of qualifying service the holder is still short. */
  shortfallDays: number;
  /** The (legal) expiry driving the warning. */
  validUntil: string | null;
  /** Whole days until that expiry; negative once already expired. */
  daysToExpiry: number | null;
  /** One-line human explanation. */
  reason: string;
};

export type AssignmentBlock = {
  /** True when this seafarer must not be advanced toward sea without an override. */
  blocked: boolean;
  expired: ExpiredDoc[];
  missing: RequiredDocType[];
  /** Cross-crew duplicate-number (forgery) flags on this seafarer's documents. */
  forgeries: Forgery[];
  /** Valid today but lapse before the rotation ends — blocked for planning. */
  rotationExpiring: ExpiredDoc[];
  /**
   * ADVISORY (non-blocking): sea-time-gated certificates whose approaching expiry
   * lands on the costly refresher path. Empty unless the sea-service ledger was
   * supplied. Never contributes to `blocked` — it is cost/lead-time advice.
   */
  revalWarnings: RevalWarning[];
  /**
   * ZERO-STATE: the seafarer's rank is null or not in the required-docs catalog,
   * so the required set could not be resolved. A hard block on advancement — an
   * unknown-rank man must never pass as sea-ready on an empty required set.
   */
  rankIncomplete: boolean;
  /** Short human reasons, ready to show in a warning / audit note. */
  reasons: string[];
};

// The pipeline state that means "sailing" — the final guarded point.
export const SEA_STATE = "sent_to_sea" as const;

// Every state that commits a man to a rotation. Moving a non-compliant seafarer
// FORWARD into any of these is the assignment/advancement we hard-block.
export const GATED_STATES: readonly SeafarerState[] = ["accepted", "sent_to_sea"];

// True when moving `from` -> `to` advances a seafarer forward into a gated
// (assignment) state. Backward moves (e.g. sending back to review) are never
// gated — an agent must always be able to pull a man off an assignment.
export function isAssignmentAdvance(from: SeafarerState, to: SeafarerState): boolean {
  const iFrom = SEAFARER_STATES.indexOf(from);
  const iTo = SEAFARER_STATES.indexOf(to);
  return iTo > iFrom && GATED_STATES.includes(to);
}

export type AssignmentOptions = {
  /** Fleet-wide cert-number -> crew entries index, for forgery detection. */
  duplicates?: DuplicateNameIndex;
  /** This seafarer's own name, so their own copy of a number isn't a "clash". */
  ownName?: string;
  /** End-of-rotation date; docs lapsing before it are not sea-ready for the voyage. */
  rotationEnd?: string | null;
  /**
   * Holder date of birth (ISO), used by lib/cert-rules to compute the TRUE legal
   * expiry of age-restricted certificates (a medical for a 55+ seaman is legally
   * valid 1 year, not the printed 2). When supplied, a legally-expired-but-printed-
   * valid document is caught by the hard block. Omitted = printed dates are trusted.
   */
  holderDOB?: string | null;
  /**
   * The seafarer's sea-service ledger (T2.2). When supplied, sea-time-gated
   * certificates (CoC) get a revalidation-path assessment and an ADVISORY warning
   * is raised for any whose approaching expiry lands on the costly refresher path.
   * Omitted = no revalidation advice (behaviour unchanged for existing callers).
   */
  seaServiceEntries?: SeaServiceEntry[];
  /** Clock injection for deterministic tests; defaults to now. */
  now?: Date;
  /**
   * The CONFIG-DRIVEN required set for this seafarer's rank (from
   * lib/required-docs.ts `requiredSetFor(...).required`). When omitted, the fixed
   * universal floor (BASE_REQUIRED_DOC_TYPES) is used, preserving pre-config
   * behaviour so every existing caller is unaffected.
   */
  required?: readonly RequiredDocType[];
  /**
   * ZERO-STATE flag: pass true when the required set could NOT be resolved (null /
   * uncatalogued rank). Forces `blocked` + a clear reason so an unknown-rank man is
   * never advanced on an empty required set. Defaults false.
   */
  rankIncomplete?: boolean;
};

export function assignmentBlockers(
  documents: Doc[],
  opts?: AssignmentOptions
): AssignmentBlock {
  const rotRaw = opts?.rotationEnd ? new Date(opts.rotationEnd) : null;
  const rotEnd = rotRaw && !isNaN(rotRaw.getTime()) ? rotRaw : null;

  const expired: ExpiredDoc[] = [];
  const rotationExpiring: ExpiredDoc[] = [];
  for (const d of documents) {
    // Feature 3: a document explicitly marked as having NO expiry (perpetual) is
    // never expired and never a rotation-expiry risk — skip it before any date
    // maths so a stray value can never turn a perpetual doc into a blocker. (A
    // null validUntil already passes; this makes the perpetual case explicit.)
    if (d.noExpiry === true) continue;
    // Judge the document against its LEGAL expiry (cert-rules shortens age-restricted
    // medicals etc.), not the possibly-optimistic printed date. Falls back to the
    // printed date when no rule applies or the holder DOB is unknown.
    const legal = legalExpiryForDoc(d, opts?.holderDOB);
    const effective = legal.legalValidUntil ?? d.validUntil ?? null;
    const st = docStatus(effective);
    if (st === "expired") {
      expired.push({
        title: d.title,
        requiredType: d.requiredType ?? null,
        validUntil: effective,
        printedValidUntil: legal.differs ? legal.printedValidUntil : undefined,
        ageRestricted: legal.ageRestricted && legal.differs ? true : undefined,
      });
      continue;
    }
    // Valid today, but does it survive to the end of the rotation?
    if (rotEnd && effective) {
      const vu = new Date(effective);
      if (!isNaN(vu.getTime()) && vu.getTime() < rotEnd.getTime()) {
        rotationExpiring.push({
          title: d.title,
          requiredType: d.requiredType ?? null,
          validUntil: effective,
          printedValidUntil: legal.differs ? legal.printedValidUntil : undefined,
          ageRestricted: legal.ageRestricted && legal.differs ? true : undefined,
        });
      }
    }
  }

  // Missing computed against the config-driven required set for this seafarer's
  // rank when supplied; otherwise the fixed universal 5. Same "missing slot"
  // helper doctypes.completeness() and required-docs.ts use — not a fork.
  const requiredSet = opts?.required ?? BASE_REQUIRED_DOC_TYPES;
  const missing = missingFrom(documents.map((d) => d.requiredType), requiredSet);
  const rankIncomplete = opts?.rankIncomplete === true;

  const forgeries: Forgery[] = [];
  if (opts?.duplicates) {
    const seen = new Set<string>();
    for (const d of documents) {
      const others = duplicateOthers(d, opts.duplicates, opts.ownName ?? "");
      if (others.length === 0) continue;
      const number = docNumber(d);
      const key = `${number}::${d.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      forgeries.push({ title: d.title, number, others });
    }
  }

  // Revalidation-path advice (T2.3) — only when the sea-service ledger is supplied.
  // Compute the holder's qualifying days ONCE, then flag each sea-time-gated cert
  // whose approaching expiry lands on the costly refresher path. Advisory only —
  // this never sets `blocked`.
  const revalWarnings: RevalWarning[] = [];
  if (opts?.seaServiceEntries && opts.seaServiceEntries.length >= 0) {
    const now = opts.now ?? new Date();
    const qualifyingDays = qualifyingDaysInWindow(
      opts.seaServiceEntries,
      REVALIDATION_WINDOW_MONTHS,
      now
    );
    const seenReval = new Set<string>();
    for (const d of documents) {
      const ruleType = classifyCertRule({
        title: d.title,
        docType: d.docType,
        docCategory: d.docCategory,
      });
      if (!certNeedsSeaServiceRevalidation(ruleType)) continue;
      const legal = legalExpiryForDoc(d, opts.holderDOB);
      const a = assessRevalidationPath({
        ruleType,
        validUntil: legal.legalValidUntil ?? d.validUntil ?? null,
        qualifyingDays,
        now,
      });
      if (!a || !a.costlyWarning) continue;
      const key = `${a.ruleType}::${d.title}`;
      if (seenReval.has(key)) continue; // one warning per (cert type, document)
      seenReval.add(key);
      revalWarnings.push({
        title: d.title,
        ruleType: a.ruleType,
        qualifyingDays: a.qualifyingDays,
        requiredDays: a.requiredDays,
        shortfallDays: a.shortfallDays,
        validUntil: a.validUntil,
        daysToExpiry: a.daysToExpiry,
        reason: a.reason,
      });
    }
  }

  const reasons: string[] = [];
  // Rank is NO LONGER a blocker/reason (multi-language portal: any/absent rank is
  // accepted). `rankIncomplete` is retained purely as an informational signal (e.g.
  // the analytics "rank unknown" counter) and never contributes a reason or a block.
  for (const e of expired) {
    reasons.push(
      e.ageRestricted
        ? `${e.title} is LEGALLY expired (age-based medical rule — legal expiry ${isoDay(e.validUntil)}, earlier than the printed ${isoDay(e.printedValidUntil ?? null)})`
        : `${e.title} is expired`
    );
  }
  for (const r of rotationExpiring) {
    const on = r.validUntil ? new Date(r.validUntil).toISOString().slice(0, 10) : "?";
    const end = rotEnd ? rotEnd.toISOString().slice(0, 10) : "?";
    reasons.push(
      r.ageRestricted
        ? `${r.title} legally expires ${on} (age-based medical rule) — before rotation end ${end}`
        : `${r.title} expires ${on} — before rotation end ${end}`
    );
  }
  if (missing.length) reasons.push(`Missing required: ${missing.join(", ")}`);
  for (const f of forgeries) {
    reasons.push(`Possible forgery: certificate ${f.number} (${f.title}) also on ${f.others.join(", ")}`);
  }
  for (const w of revalWarnings) {
    reasons.push(
      `${w.title}: expiry approaching but only ${w.qualifyingDays}/${w.requiredDays} qualifying sea days in ${REVALIDATION_WINDOW_MONTHS / 12}y — likely needs the costly refresher, not a short revalidation`
    );
  }

  return {
    blocked:
      expired.length > 0 ||
      rotationExpiring.length > 0 ||
      missing.length > 0 ||
      forgeries.length > 0,
    expired,
    missing,
    forgeries,
    rotationExpiring,
    revalWarnings,
    rankIncomplete,
    reasons,
  };
}

// One scannable row per problem, ready for the "Attention needed" table. The same
// document can be present more than once in the roster (a re-upload, a bad import,
// a genuine duplicate) — which would otherwise list "GMDSS is expired" twice — so
// rows are DEDUPLICATED by (issue kind, document). Severity: red for hard failures
// (expired / missing), amber for warnings (lapses mid-rotation, possible duplicate).
export type BlockIssueKind = "expired" | "rotation" | "missing" | "forgery" | "rank" | "reval";

export type BlockIssue = {
  kind: BlockIssueKind;
  /** Short label for the Issue column. */
  issue: string;
  /** Document name for the Document column. */
  document: string;
  /** Human detail for the Detail column. */
  detail: string;
  severity: "red" | "amber";
};

function isoDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function blockIssues(block: AssignmentBlock): BlockIssue[] {
  const out: BlockIssue[] = [];
  const seen = new Set<string>();
  const push = (i: BlockIssue) => {
    const key = `${i.kind}::${i.document}`;
    if (seen.has(key)) return; // never list the same problem twice
    seen.add(key);
    out.push(i);
  };
  // Rank is no longer a red "Attention needed" row (multi-language: any/absent rank
  // is accepted). Only real document issues below produce rows.
  for (const e of block.expired) {
    const d = isoDay(e.validUntil);
    const printed = e.ageRestricted ? isoDay(e.printedValidUntil ?? null) : "";
    const detail = e.ageRestricted
      ? `legally expired ${d}${printed ? ` (printed ${printed}; age-based medical rule)` : " (age-based medical rule)"}`
      : d
        ? `expired ${d}`
        : "expired";
    push({ kind: "expired", issue: e.ageRestricted ? "Legally expired" : "Expired", document: e.title, detail, severity: "red" });
  }
  for (const r of block.rotationExpiring) {
    const d = isoDay(r.validUntil);
    const suffix = r.ageRestricted ? " (age-based medical rule)" : "";
    push({ kind: "rotation", issue: "Expires early", document: r.title, detail: d ? `valid until ${d}, before rotation end${suffix}` : `lapses before rotation end${suffix}`, severity: "amber" });
  }
  for (const m of block.missing) {
    push({ kind: "missing", issue: "Missing", document: m, detail: "required document not on file", severity: "red" });
  }
  for (const f of block.forgeries) {
    push({ kind: "forgery", issue: "Possible duplicate", document: f.title, detail: `same certificate number also on ${f.others.join(", ")}`, severity: "amber" });
  }
  for (const w of block.revalWarnings) {
    const exp = isoDay(w.validUntil);
    const when =
      w.daysToExpiry != null && w.daysToExpiry < 0
        ? `expired ${exp}`
        : exp
          ? `expires ${exp}`
          : "expiry approaching";
    push({
      kind: "reval",
      issue: "Refresher path",
      document: w.title,
      detail: `${when}; only ${w.qualifyingDays}/${w.requiredDays} qualifying sea days in ${REVALIDATION_WINDOW_MONTHS / 12}y (short ${w.shortfallDays}) — likely a costly refresher, not a short revalidation`,
      severity: "amber",
    });
  }
  return out;
}
