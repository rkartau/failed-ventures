// Agency analytics / KPI aggregation (roadmap T2.6) — client-safe (NO Node
// built-ins; type-only imports of the db shapes) so the same aggregation can run
// server-side (the /agent/analytics page) and, if ever needed, in the browser.
//
// This module computes NOTHING new about compliance or expiry — it reuses the
// app's existing single sources of truth so a KPI can never disagree with the
// board, the reminders or the CV:
//   - pipeline.ts        canonical stages + labels (roster counts by stage)
//   - required-docs.ts   requiredSetFor / requiredCompleteness (missing / docs-out)
//   - compliance.ts      assignmentBlockers (the SAME sea-ready hard block the
//                        board and the PATCH route enforce → compliance rate)
//   - cert-rules.ts      effectiveValidUntil (age-shortened LEGAL expiry)
//   - cert.ts            docStatus (60-day "expiring" window)
//   - doc-requests.ts    summarizeRequests (open / overdue checklist items)
//
// Every figure is derived from data ALREADY on file (JSON store, pilot scale) —
// no new persisted state. The caller passes an already GRANT-SCOPED set (built via
// lib/agentData.ts on the server), so this pure function never sees a foreign
// tenant's crew.

import type { Doc, DocRequest, Seafarer, SeaServiceEntry } from "@/lib/db";
import { SEAFARER_STATES, STATE_LABELS, type SeafarerState } from "@/lib/pipeline";
import { docStatusForDoc } from "@/lib/cert";
import { effectiveValidUntil } from "@/lib/cert-rules";
import {
  requiredSetFor,
  requiredCompleteness,
  type RequiredDocsConfig,
} from "@/lib/required-docs";
import { assignmentBlockers } from "@/lib/compliance";
import type { DuplicateNameIndex } from "@/lib/duplicates";
import { summarizeRequests } from "@/lib/doc-requests";

const DAY_MS = 86_400_000;

/** One seafarer + everything already on file about them, GRANT-SCOPED by the caller. */
export type AnalyticsInput = {
  seafarer: Seafarer;
  /** ACTIVE (non-archived) documents — the same set the board / compliance judge. */
  documents: Doc[];
  /** This agent's document-request checklist rows for this seafarer (own tenant). */
  docRequests: DocRequest[];
  /** The seafarer's sea-service ledger, for parity with the board's blocker call. */
  seaService?: SeaServiceEntry[];
};

export type AnalyticsOptions = {
  /** Per-agent required-docs config (own tenant). Falls back to the baseline. */
  config?: RequiredDocsConfig | null;
  /**
   * Fleet-wide cert-number → crew-entries index (masked names for non-visible crew),
   * for forgery parity with the board's sea-ready gate. Optional.
   */
  duplicates?: DuplicateNameIndex;
  /** Clock injection for deterministic tests; defaults to now. */
  now?: Date;
};

export type StageCount = { state: SeafarerState; label: string; count: number };

export type ComplianceKpi = {
  /** Seafarers with NO assignment blocker (sea-ready today). */
  seaReady: number;
  /** Seafarers the board would hard-block from advancing toward a vessel. */
  blocked: number;
  /** seaReady / rosterSize in [0,1]; 0 for an empty roster. */
  rate: number;
  withExpired: number;
  withMissing: number;
  withForgery: number;
  withRankUnknown: number;
  withRotationRisk: number;
};

export type ExpiryKpi = {
  /** Documents already past their LEGAL expiry. */
  expired: number;
  within30: number;
  within60: number;
  within90: number;
  /** Valid and more than 90 days out. */
  later: number;
  /** Documents with no readable expiry date. */
  noExpiry: number;
  /** Distinct crew with at least one expired OR ≤60-day document (the chase list). */
  crewAffectedSoon: number;
};

export type OutstandingKpi = {
  /** Total missing required slots summed across the roster. */
  missingRequired: number;
  /** Distinct crew missing at least one required document. */
  crewWithMissing: number;
  /** Pending document-request checklist items across the roster. */
  openRequests: number;
  /** Pending checklist items already past their deadline. */
  overdueRequests: number;
  /** Expired active documents across the roster. */
  expiredDocs: number;
};

export type StageAge = {
  state: SeafarerState;
  label: string;
  count: number;
  /** Mean days since intake for crew CURRENTLY in this stage; null when empty. */
  averageDays: number | null;
  /** Oldest (max days since intake) in this stage; null when empty. */
  oldestDays: number | null;
};

export type TimeInStageKpi = {
  /** Mean days since intake across the whole roster; null when empty. */
  averageDaysInPipeline: number | null;
  byStage: StageAge[];
};

export type AgencyAnalytics = {
  rosterSize: number;
  generatedAt: string;
  byStage: StageCount[];
  compliance: ComplianceKpi;
  expiries: ExpiryKpi;
  docsOutstanding: OutstandingKpi;
  timeInStage: TimeInStageKpi;
};

/** Whole days from `createdAt` to `now` (>= 0), or null when unparseable. */
function daysSince(createdAt: string | null | undefined, now: Date): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Aggregate an agency's whole (grant-scoped) roster into the KPI model. Pure —
 * same numbers on server and client, deterministic under an injected `now`.
 *
 * SCOPE CONTRACT (F5): `state` on each input is WHATEVER the caller's roster carries —
 * the deprecated GLOBAL `Seafarer.state` when called from the admin KPI band
 * (admin/page.tsx, raw unscoped roster) or the PER-AGENT `grant.stage` when called
 * from the agent analytics page (agentData.listSeafarersForAgent, B.1-overridden
 * roster). The two meanings must NEVER be mixed in one call — do not build a single
 * inputs array from both a global and an overridden roster.
 */
export function buildAnalytics(
  inputs: AnalyticsInput[],
  opts: AnalyticsOptions = {}
): AgencyAnalytics {
  const now = opts.now ?? new Date();
  const rosterSize = inputs.length;

  // ---- Roster counts by stage --------------------------------------------
  const stageCount: Record<SeafarerState, number> = {
    review: 0,
    accepted: 0,
    sent_to_sea: 0,
    returning: 0,
    finished: 0,
  };
  // ---- Time in pipeline (age since intake), grouped by CURRENT stage ------
  const stageAges: Record<SeafarerState, number[]> = {
    review: [],
    accepted: [],
    sent_to_sea: [],
    returning: [],
    finished: [],
  };
  const allAges: number[] = [];

  // ---- Compliance (the board's sea-ready hard block) ---------------------
  let seaReady = 0;
  let blocked = 0;
  let withExpired = 0;
  let withMissing = 0;
  let withForgery = 0;
  let withRankUnknown = 0;
  let withRotationRisk = 0;

  // ---- Upcoming expiries (per document, on LEGAL expiry) -----------------
  let expired = 0;
  let within30 = 0;
  let within60 = 0;
  let within90 = 0;
  let later = 0;
  let noExpiry = 0;
  let crewAffectedSoon = 0;

  // ---- Docs outstanding ---------------------------------------------------
  let missingRequired = 0;
  let crewWithMissing = 0;
  let openRequests = 0;
  let overdueRequests = 0;
  let expiredDocs = 0;

  for (const { seafarer, documents, docRequests, seaService } of inputs) {
    const state: SeafarerState = seafarer.state;
    stageCount[state] += 1;

    const age = daysSince(seafarer.createdAt, now);
    if (age !== null) {
      stageAges[state].push(age);
      allAges.push(age);
    }

    // Config-driven required set for THIS rank/vessel/flag — same call as the board.
    const req = requiredSetFor({
      rank: seafarer.rank,
      config: opts.config,
      vesselType: seafarer.vesselType,
      flag: seafarer.flagState,
    });
    const completeness = requiredCompleteness(
      documents.map((d) => d.requiredType),
      req
    );
    if (completeness.missing.length > 0) {
      missingRequired += completeness.missing.length;
      crewWithMissing += 1;
    }

    // The SAME sea-ready hard block the board + PATCH route enforce.
    const block = assignmentBlockers(documents, {
      duplicates: opts.duplicates,
      ownName: seafarer.name,
      rotationEnd: seafarer.rotationEnd ?? null,
      required: req.required,
      rankIncomplete: !req.rankKnown,
      holderDOB: seafarer.birthDate ?? null,
      seaServiceEntries: seaService,
      now,
    });
    if (block.blocked) blocked += 1;
    else seaReady += 1;
    if (block.expired.length > 0) withExpired += 1;
    if (block.missing.length > 0) withMissing += 1;
    if (block.forgeries.length > 0) withForgery += 1;
    if (block.rankIncomplete) withRankUnknown += 1;
    if (block.rotationExpiring.length > 0) withRotationRisk += 1;

    // Per-document expiry buckets on the age-shortened LEGAL expiry.
    let affectedSoon = false;
    for (const d of documents) {
      const legal = effectiveValidUntil(d, seafarer.birthDate ?? null);
      const status = docStatusForDoc(d, legal);
      // Feature 3: a perpetual (no-expiry) doc is VALID/compliant — it must never
      // count as expired/expiring/unknown. It has no finite date to bucket by, so
      // it lands in the safe "later" (valid, not soon) bucket and never marks the
      // crew as affected-soon.
      if (status === "none") {
        later += 1;
        continue;
      }
      if (status === "unknown") {
        noExpiry += 1;
        continue;
      }
      if (status === "expired") {
        expired += 1;
        expiredDocs += 1;
        affectedSoon = true;
        continue;
      }
      // Valid today — bucket by days remaining.
      const days = (new Date(legal as string).getTime() - now.getTime()) / DAY_MS;
      if (days <= 30) within30 += 1;
      else if (days <= 60) within60 += 1;
      else if (days <= 90) within90 += 1;
      else later += 1;
      if (days <= 60) affectedSoon = true;
    }
    if (affectedSoon) crewAffectedSoon += 1;

    // Document-request checklist (own-tenant rows for this seafarer).
    const summary = summarizeRequests(docRequests, now);
    openRequests += summary.pending;
    overdueRequests += summary.overdue;
  }

  const byStage: StageCount[] = SEAFARER_STATES.map((state) => ({
    state,
    label: STATE_LABELS[state],
    count: stageCount[state],
  }));

  const timeByStage: StageAge[] = SEAFARER_STATES.map((state) => ({
    state,
    label: STATE_LABELS[state],
    count: stageCount[state],
    averageDays: mean(stageAges[state]),
    oldestDays: stageAges[state].length ? Math.max(...stageAges[state]) : null,
  }));

  return {
    rosterSize,
    generatedAt: now.toISOString(),
    byStage,
    compliance: {
      seaReady,
      blocked,
      rate: rosterSize === 0 ? 0 : seaReady / rosterSize,
      withExpired,
      withMissing,
      withForgery,
      withRankUnknown,
      withRotationRisk,
    },
    expiries: {
      expired,
      within30,
      within60,
      within90,
      later,
      noExpiry,
      crewAffectedSoon,
    },
    docsOutstanding: {
      missingRequired,
      crewWithMissing,
      openRequests,
      overdueRequests,
      expiredDocs,
    },
    timeInStage: {
      averageDaysInPipeline: mean(allAges),
      byStage: timeByStage,
    },
  };
}

/** Compliance rate as a rounded whole percentage (0..100). */
export function compliancePercent(a: AgencyAnalytics): number {
  return Math.round(a.compliance.rate * 100);
}
