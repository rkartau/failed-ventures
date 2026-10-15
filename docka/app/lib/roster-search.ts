// Cross-roster talent search — a standing, multi-filter query over an agent's
// WHOLE granted roster (rank, nationality, certificate held, vessel-type fit,
// flag, availability, expiry status). Distinct from the per-column board text
// search in components/AgentBoard.tsx, which is name/rank text only.
//
// Client-safe (no Node built-ins, type-only import of Doc/Seafarer) so the server
// page builds the rows off the grant-scoped set from lib/agentData.ts and the
// browser component filters them live off the SAME predicate — one source of the
// match semantics, never two drifting copies. It computes NOTHING new about a
// document: expiry/status reuse the app's existing single sources of truth
//   - cert.ts        docStatus / worstStatus / STATUS_LABELS
//   - cert-rules.ts  effectiveValidUntil (age-shortened LEGAL expiry)
//   - doctypes.ts    classifyRequiredType (which required slot a doc fills)
// so a talent hit can never disagree with the review board / reminders / CV.

import type { Doc, Seafarer } from "@/lib/db";
import type { SeafarerState } from "@/lib/pipeline";
import { docStatusForDoc, worstStatus, STATUS_LABELS, type DocStatus } from "@/lib/cert";
import { effectiveValidUntil } from "@/lib/cert-rules";
import {
  classifyRequiredType,
  REQUIRED_DOC_TYPES,
  type RequiredDocType,
} from "@/lib/doctypes";
import { requiredSetFor, type RequiredDocsConfig } from "@/lib/required-docs";
import { assignmentBlockers } from "@/lib/compliance";
import {
  matchesAvailabilityFilter,
  type Availability,
  type AvailabilityFilter,
} from "@/lib/availability";

/** Number of days ahead the "expiring within 90 days" crew-readiness filter looks. */
export const SEA_READY_EXPIRING_DAYS = 90;

export { STATUS_LABELS, type DocStatus };

/** One certificate a seafarer holds, projected for search + result display. */
export type RosterCert = {
  title: string;
  /** Which required slot it fills (stored tag, else best-effort classification). */
  requiredType: RequiredDocType | null;
  /** Status on the EFFECTIVE (legal) expiry, so an age-lapsed medical reads expired. */
  status: DocStatus;
  /** Effective (legal) expiry ISO, or null when none was read. */
  expiry: string | null;
};

/**
 * A single seafarer projected to the fields talent search filters + shows. Fully
 * serialisable (built server-side, filtered client-side). No documentRef / fileName
 * leaks — this is a roster INDEX, not a document accessor.
 */
export type RosterSearchRow = {
  id: string;
  name: string;
  rank: string;
  /** Registry issuing country — the best nationality signal on file ("" when none). */
  nationality: string;
  vessel: string;
  vesselType: string;
  flagState: string;
  /** Agent PIPELINE stage (workflow position) — NOT the seaman's availability. */
  state: SeafarerState;
  /** Seaman-DECLARED availability, or undefined when never set ("Not set"). */
  availability?: Availability;
  /** yyyy-mm-dd the seaman frees up — meaningful only when availability==='open_from'. */
  availableFrom: string | null;
  /** Planned end-of-rotation ISO — when an at-sea seafarer frees up. null when unset. */
  rotationEnd: string | null;
  identityVerified: boolean;
  /** True when NO sea-readiness blocker applies (fully compliant, can sail now). */
  seaReady: boolean;
  /** True when at least one held cert lapses within SEA_READY_EXPIRING_DAYS days. */
  expiring90: boolean;
  certs: RosterCert[];
  /** Worst status across all held certs — what the agent triages on. */
  overallStatus: DocStatus;
  docCount: number;
  expiringCount: number;
  expiredCount: number;
  /**
   * Public Sample Profiles (plan §D10): present-and-true ONLY for the seeded
   * fictional flagship row — the search result + vacancy-match SAMPLE chip keys
   * on it. Real seafarers never carry the field at all.
   */
  isSample?: boolean;
};

/** The crew-readiness filter dimension — "who can I send to sea now?". */
export type ReadinessFilter = "sea_ready" | "expiring_90";

/** The multi-filter query. Every field is optional; an empty query matches all. */
export type RosterQuery = {
  /** Free text over name / rank / vessel (case-insensitive substring). */
  text?: string;
  rank?: string;
  nationality?: string;
  vesselType?: string;
  flagState?: string;
  /** Agent PIPELINE stage (matches row.state) — the workflow position, NOT availability. */
  pipelineStage?: SeafarerState | "";
  /** Seaman-declared AVAILABILITY dimension (open now / open by date / occupied). */
  availability?: AvailabilityFilter | "";
  /** yyyy-mm-dd bound used only by the "open_by" availability filter. */
  availableBy?: string;
  /** Crew readiness: sea-ready (fully compliant) or expiring within 90 days. */
  readiness?: ReadinessFilter | "";
  /** Must HOLD a certificate that fills this required slot. */
  certType?: RequiredDocType | "";
  /**
   * Expiry-status constraint. Applies ONLY as a modifier of a selected certType (the
   * held cert of that type). Ignored — and not exposed — without a certType, where a
   * standalone status match is noisy (it matches almost everyone).
   */
  certStatus?: DocStatus | "";
};

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
const eq = (a: string, b: string): boolean => norm(a) === norm(b);

/**
 * Project a seafarer + their (already grant-scoped, active) documents into a row.
 * `config` is the acting agent's required-docs config, used to reuse the SAME
 * sea-readiness rule the board/review already apply (lib/compliance +
 * lib/required-docs) so the "Sea-ready" filter never disagrees with them.
 */
export function buildSearchRow(
  seafarer: Seafarer,
  documents: Doc[],
  config: RequiredDocsConfig | null = null
): RosterSearchRow {
  const dob = seafarer.birthDate ?? null;

  const certs: RosterCert[] = documents.map((doc) => {
    const expiry = effectiveValidUntil(doc, dob);
    return {
      title: doc.title,
      requiredType:
        doc.requiredType ??
        classifyRequiredType({
          title: doc.title,
          docType: doc.docType,
          docCategory: doc.docCategory,
        }),
      // Doc-aware: a `noExpiry` perpetual doc resolves to "none" regardless of the
      // (age-shortened) effective expiry; every other doc uses the effective date.
      status: docStatusForDoc(doc, expiry),
      expiry,
    };
  });

  // Reuse the board/review sea-readiness rule, not a fork: the required set for this
  // rank/vessel/flag, fed to assignmentBlockers. Sea-ready = nothing blocks (rank
  // known, nothing expired/missing/lapsing-before-rotation).
  const req = requiredSetFor({
    rank: seafarer.rank,
    config,
    vesselType: seafarer.vesselType,
    flag: seafarer.flagState,
  });
  const block = assignmentBlockers(documents, {
    ownName: seafarer.name,
    rotationEnd: seafarer.rotationEnd ?? null,
    required: req.required,
    rankIncomplete: !req.rankKnown,
    holderDOB: dob,
  });

  const now = Date.now();
  const expiring90 = certs.some((c) => {
    if (!c.expiry) return false;
    const t = new Date(c.expiry).getTime();
    if (isNaN(t)) return false;
    const days = (t - now) / 86_400_000;
    return days >= 0 && days <= SEA_READY_EXPIRING_DAYS;
  });

  return {
    id: seafarer.id,
    name: (seafarer.verifiedName || seafarer.name || "Seafarer").trim(),
    rank: (seafarer.rank || "").trim(),
    nationality: (seafarer.issuerCountry || "").trim(),
    vessel: (seafarer.vessel || "").trim(),
    vesselType: (seafarer.vesselType || "").trim(),
    flagState: (seafarer.flagState || "").trim(),
    state: seafarer.state,
    availability: seafarer.availability,
    availableFrom: seafarer.availableFrom ?? null,
    rotationEnd: seafarer.rotationEnd ?? null,
    identityVerified: seafarer.identityVerified === true,
    seaReady: !block.blocked,
    expiring90,
    certs,
    overallStatus: worstStatus(certs.map((c) => c.expiry)),
    docCount: certs.length,
    expiringCount: certs.filter((c) => c.status === "expiring").length,
    expiredCount: certs.filter((c) => c.status === "expired").length,
    // Sample flag only when true — real rows stay byte-identical to before (§D10).
    ...(seafarer.isSample === true ? { isSample: true } : {}),
  };
}

/** Apply the multi-filter query. Pure — same semantics on server and client. */
export function filterRoster(rows: RosterSearchRow[], q: RosterQuery): RosterSearchRow[] {
  const text = norm(q.text);
  return rows.filter((row) => {
    if (text && !`${row.name} ${row.rank} ${row.vessel}`.toLowerCase().includes(text)) {
      return false;
    }
    if (q.rank && !eq(row.rank, q.rank)) return false;
    if (q.nationality && !eq(row.nationality, q.nationality)) return false;
    if (q.vesselType && !eq(row.vesselType, q.vesselType)) return false;
    if (q.flagState && !eq(row.flagState, q.flagState)) return false;
    // Pipeline stage (agent workflow position) and availability (seaman-declared) are
    // now two SEPARATE dimensions — never conflated.
    if (q.pipelineStage && row.state !== q.pipelineStage) return false;
    if (q.availability && !matchesAvailabilityFilter(row, q.availability, q.availableBy ?? "")) {
      return false;
    }
    // Crew readiness — "who can I send to sea now?".
    if (q.readiness === "sea_ready" && !row.seaReady) return false;
    if (q.readiness === "expiring_90" && !row.expiring90) return false;

    // Certificate status is ONLY a modifier of a selected "certificate held" type; a
    // standalone status match is not applied (it is redundant with the status card).
    if (q.certType) {
      const held = row.certs.filter((c) => c.requiredType === q.certType);
      if (held.length === 0) return false;
      if (q.certStatus && !held.some((c) => c.status === q.certStatus)) return false;
    }
    return true;
  });
}

/** True when no filter is set — used to show a friendly "all crew" default state. */
export function isEmptyQuery(q: RosterQuery): boolean {
  return (
    !norm(q.text) &&
    !q.rank &&
    !q.nationality &&
    !q.vesselType &&
    !q.flagState &&
    !q.pipelineStage &&
    !q.availability &&
    !q.readiness &&
    !q.certType &&
    !q.certStatus
  );
}

/** Distinct, sorted filter options drawn from the roster that actually exists. */
export type RosterFacets = {
  ranks: string[];
  nationalities: string[];
  vesselTypes: string[];
  flagStates: string[];
  certTypes: RequiredDocType[];
};

function distinct(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function rosterFacets(rows: RosterSearchRow[]): RosterFacets {
  const present = new Set<RequiredDocType>();
  for (const row of rows) for (const c of row.certs) if (c.requiredType) present.add(c.requiredType);
  return {
    ranks: distinct(rows.map((r) => r.rank)),
    nationalities: distinct(rows.map((r) => r.nationality)),
    vesselTypes: distinct(rows.map((r) => r.vesselType)),
    flagStates: distinct(rows.map((r) => r.flagState)),
    // Preserve the canonical required-type ordering, only offering ones that appear.
    certTypes: REQUIRED_DOC_TYPES.filter((t) => present.has(t)),
  };
}
