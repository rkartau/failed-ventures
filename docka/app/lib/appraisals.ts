// Appraisal scorecards (#43) — client-safe (NO Node built-ins), so the AppraisalPanel
// UI and the server route share ONE validation + versioned competency-set engine.
// This module owns the PURE logic only; the stored shapes live in lib/db.ts (like
// SeaServiceEntry) and the transact/audit/idempotency wiring lives in the route.
//
// Two appraisal kinds:
//   - interview   : pre-hire screening. A fast-path (recommend + overall, competency
//                   rows optional) is allowed here ONLY.
//   - post_voyage : the full card — ALL competency rows of its pinned version + a
//                   mandatory vessel + both voyage dates. Fast-path is BARRED.
//
// Competency sets are VERSIONED (v3 item 9): an appraisal stamped with an older version
// renders + validates against ITS OWN set, never the current one.

import type {
  AppraisalKind,
  AppraisalRating,
  AppraisalScore,
  RehireRecommendation,
  Appraisal,
  AppraisalDeleteRequest,
} from "@/lib/db";

// ---- Versioned competency sets -----------------------------------------

export type CompetencySet = { interview: string[]; post_voyage: string[] };

/**
 * Every competency-set version, keyed by version string. Append a NEW version by
 * ADDING a key — never mutate a shipped one (a stamped appraisal must keep resolving
 * to the exact rows it was scored against). The CURRENT version is what new appraisals
 * are stamped with.
 */
export const COMPETENCY_SETS: Record<string, CompetencySet> = {
  "2023.1": {
    interview: ["Communication", "Technical knowledge", "Safety awareness"],
    post_voyage: ["Technical competence", "Safety", "Teamwork", "Reliability"],
  },
  "2024.1": {
    interview: [
      "Communication",
      "Technical knowledge",
      "Safety awareness",
      "Teamwork",
      "English proficiency",
    ],
    post_voyage: [
      "Technical competence",
      "Safety & compliance",
      "Leadership",
      "Teamwork",
      "Reliability",
      "Communication",
    ],
  },
};

export const CURRENT_COMPETENCY_SET_VERSION = "2024.1";

/**
 * The competency rows for a given pinned version + kind. Falls back to the CURRENT
 * version's set only when `version` is unknown (defensive — a stamped appraisal always
 * carries a real version). Returns a fresh array (never the stored reference).
 */
export function competenciesFor(version: string, kind: AppraisalKind): string[] {
  const set = COMPETENCY_SETS[version] ?? COMPETENCY_SETS[CURRENT_COMPETENCY_SET_VERSION];
  return [...set[kind]];
}

/** Resolve to a known version string (unknown/blank -> CURRENT). */
export function resolveVersion(version: string | null | undefined): string {
  return version && COMPETENCY_SETS[version] ? version : CURRENT_COMPETENCY_SET_VERSION;
}

// ---- Rating + score helpers --------------------------------------------

/** Coerce any input into a 1..5 rating (out-of-range / non-numeric clamps to nearest). */
export function clampRating(n: unknown): AppraisalRating {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > 5) return 5;
  return v as AppraisalRating;
}

/** Average of the scores' ratings, rounded to a 1..5 rating. Defaults to 3 when empty. */
export function averageRating(scores: AppraisalScore[]): AppraisalRating {
  if (scores.length === 0) return 3;
  const sum = scores.reduce((a, s) => a + s.rating, 0);
  return clampRating(sum / scores.length);
}

const MAX_SCORES = 40;

/**
 * Sanitise inbound competency scores against the version's whitelist for the kind:
 * only known competency names survive, each rating is clamped 1..5, duplicates keep
 * the LAST value, order follows the version's competency order, capped at MAX_SCORES.
 */
export function sanitizeScores(
  input: unknown,
  version: string,
  kind: AppraisalKind
): AppraisalScore[] {
  const allowed = competenciesFor(version, kind);
  const allowedSet = new Set(allowed);
  const byName = new Map<string, AppraisalRating>();
  if (Array.isArray(input)) {
    for (const raw of input.slice(0, MAX_SCORES * 2)) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as { competency?: unknown; rating?: unknown };
      const name = typeof r.competency === "string" ? r.competency.trim() : "";
      if (!allowedSet.has(name)) continue;
      byName.set(name, clampRating(r.rating));
    }
  }
  return allowed
    .filter((name) => byName.has(name))
    .slice(0, MAX_SCORES)
    .map((name) => ({ competency: name, rating: byName.get(name)! }));
}

// ---- Validation --------------------------------------------------------

export const APPRAISAL_BOUNDS = {
  comments: 2000,
  sharedComment: 2000,
  rehireReason: 500,
  vessel: 120,
} as const;

const RECOMMENDATIONS: ReadonlySet<string> = new Set(["yes", "no", "conditional"]);
const KINDS: ReadonlySet<string> = new Set(["interview", "post_voyage"]);

export type AppraisalInput = {
  kind?: unknown;
  competencySetVersion?: unknown;
  vessel?: unknown;
  voyageFrom?: unknown;
  voyageTo?: unknown;
  assignmentId?: unknown;
  scores?: unknown;
  overall?: unknown;
  recommend?: unknown;
  rehireReason?: unknown;
  comments?: unknown;
  sharedComment?: unknown;
  fastPath?: unknown;
};

/** The normalised, persist-ready appraisal fields (server adds id/author/idempotency). */
export type ValidatedAppraisal = {
  kind: AppraisalKind;
  competencySetVersion: string;
  vessel: string | null;
  voyageFrom: string | null;
  voyageTo: string | null;
  assignmentId: string | null;
  scores: AppraisalScore[];
  overall: AppraisalRating;
  recommend: RehireRecommendation;
  rehireReason: string | null;
  comments: string | null;
  /** #11 — the seaman-visible shared comment (capped, whitespace -> null). */
  sharedComment: string | null;
  fastPath: boolean;
};

export type ValidationResult =
  | { ok: true; value: ValidatedAppraisal }
  | { ok: false; error: string };

function capText(raw: unknown, max: number): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
}

/** YYYY-MM-DD normaliser; "" when invalid/blank. */
function normDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/**
 * Validate + normalise an appraisal write. Enforces:
 *   - post_voyage requires ALL competency rows of its version + vessel + both dates (item 7/8);
 *   - recommend==="no" ⇒ a non-empty reason (item 9);
 *   - fastPath (interview only) ⇒ rows optional, overall defaults to the score average (item 10);
 *   - {kind:"post_voyage", fastPath:true} is rejected outright (fast-path is interview-only).
 */
export function validateAppraisalInput(input: AppraisalInput): ValidationResult {
  const kind = input.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    return { ok: false, error: "kind must be 'interview' or 'post_voyage'." };
  }
  const fastPath = input.fastPath === true;
  if (kind === "post_voyage" && fastPath) {
    return { ok: false, error: "Fast-path is not allowed for a post-voyage appraisal." };
  }

  const recommend = input.recommend;
  if (typeof recommend !== "string" || !RECOMMENDATIONS.has(recommend)) {
    return { ok: false, error: "recommend must be 'yes', 'no', or 'conditional'." };
  }
  const rehireReason = capText(input.rehireReason, APPRAISAL_BOUNDS.rehireReason);
  if (recommend === "no" && !rehireReason) {
    return { ok: false, error: "A reason is required when the recommendation is 'no'." };
  }

  const version = resolveVersion(
    typeof input.competencySetVersion === "string" ? input.competencySetVersion : undefined
  );
  const kindTyped = kind as AppraisalKind;
  const scores = sanitizeScores(input.scores, version, kindTyped);

  const vessel = capText(input.vessel, APPRAISAL_BOUNDS.vessel);
  const voyageFromKey = normDate(input.voyageFrom);
  const voyageToKey = normDate(input.voyageTo);
  const assignmentId =
    typeof input.assignmentId === "string" && input.assignmentId.trim()
      ? input.assignmentId.trim()
      : null;

  if (kindTyped === "post_voyage") {
    // Full card: EVERY competency row of the pinned version, vessel + both dates.
    const need = competenciesFor(version, "post_voyage");
    const have = new Set(scores.map((s) => s.competency));
    const missingRows = need.filter((c) => !have.has(c));
    if (missingRows.length > 0) {
      return {
        ok: false,
        error: `A post-voyage appraisal must score every competency (missing: ${missingRows.join(", ")}).`,
      };
    }
    if (!vessel) return { ok: false, error: "Vessel is required for a post-voyage appraisal." };
    if (!voyageFromKey || !voyageToKey) {
      return { ok: false, error: "Both voyage dates are required for a post-voyage appraisal." };
    }
    if (voyageToKey < voyageFromKey) {
      return { ok: false, error: "Voyage end cannot be before voyage start." };
    }
  }

  // Overall: an explicit rating wins; otherwise derive from the scores; a fast-path
  // with neither is invalid (nothing to summarise).
  let overall: AppraisalRating;
  if (input.overall !== undefined && input.overall !== null && input.overall !== "") {
    overall = clampRating(input.overall);
  } else if (scores.length > 0) {
    overall = averageRating(scores);
  } else {
    return { ok: false, error: "Provide an overall rating or at least one competency score." };
  }

  return {
    ok: true,
    value: {
      kind: kindTyped,
      competencySetVersion: version,
      vessel,
      voyageFrom: voyageFromKey || null,
      voyageTo: voyageToKey || null,
      assignmentId,
      scores,
      overall,
      recommend: recommend as RehireRecommendation,
      rehireReason,
      comments: capText(input.comments, APPRAISAL_BOUNDS.comments),
      sharedComment: capText(input.sharedComment, APPRAISAL_BOUNDS.sharedComment),
      fastPath,
    },
  };
}

// ---- Seaman-visibility projection (item 11 / v3 item 4) ----------------

/** The ONLY appraisal fields a seaman may see. Private fields are stripped, not nulled. */
export type SeamanVisibleAppraisal = {
  id: string;
  seafarerId: string;
  kind: AppraisalKind;
  competencySetVersion: string;
  overall: AppraisalRating;
  scores: AppraisalScore[];
  recommend: RehireRecommendation;
  vessel: string | null;
  voyageFrom: string | null;
  voyageTo: string | null;
  /** #11 — the comment the agent explicitly shared with the seaman (null when none). */
  sharedComment: string | null;
  /** The authoring ORG name — the individual coordinator's name is NEVER exposed. */
  authorOrg: string;
  createdAt: string;
};

/**
 * Project an appraisal to exactly what a seaman may see. Maps authorName -> authorOrg
 * (the org, not the person), EMITS the seaman-visible sharedComment (#11), and STRIPS
 * comments, rehireReason, agentId, authorName, idempotencyKey, updatedAt. Building a NEW
 * object (not deleting keys) guarantees no private field can leak through an object spread.
 * NB: does NOT filter hiddenFromAgentAt — the seaman keeps visibility of a pending/kept
 * (agent-deleted) appraisal so they can decide (#12); that filter is agent-side only.
 */
export function projectAppraisalForSeaman(a: Appraisal): SeamanVisibleAppraisal {
  return {
    id: a.id,
    seafarerId: a.seafarerId,
    kind: a.kind,
    competencySetVersion: a.competencySetVersion,
    overall: a.overall,
    scores: a.scores.map((s) => ({ competency: s.competency, rating: s.rating })),
    recommend: a.recommend,
    vessel: a.vessel ?? null,
    voyageFrom: a.voyageFrom ?? null,
    voyageTo: a.voyageTo ?? null,
    sharedComment: a.sharedComment ?? null,
    authorOrg: a.authorOrg,
    createdAt: a.createdAt,
  };
}

// ---- #12 delete-consent pure state machine -----------------------------
//
// The route wires these into ONE transact/updateDB critical section; keeping the
// decisions pure makes them unit-testable and keeps the two writers (agent DELETE +
// seaman decision) from drifting.

/** An appraisal is "hidden" from every AGENT read once hiddenFromAgentAt is set (#12). */
export function isHiddenFromAgent(a: Pick<Appraisal, "hiddenFromAgentAt">): boolean {
  return !!a.hiddenFromAgentAt;
}

/**
 * The agent DELETE disposition, keyed on the STICKY sharedWithSeamanAt:
 *   - never shared  => "hard_delete" (remove the row outright).
 *   - ever shared   => "consent"     (soft-hide + raise a seaman keep/delete request).
 */
export function agentDeleteDisposition(
  a: Pick<Appraisal, "sharedWithSeamanAt">
): "hard_delete" | "consent" {
  return a.sharedWithSeamanAt ? "consent" : "hard_delete";
}

/**
 * Primary idempotency-key dedupe (#12): a same-key match EXCLUDES hidden rows — a
 * hidden row must never satisfy dedupe (the fresh write has to create a NEW visible
 * row). Returns the VISIBLE hit (dedupe target) plus, when there is no visible hit but
 * a hidden row shares the key, that stale hidden row's id so the caller can SUPERSEDE
 * (hard-delete) it on the fresh create — the seaman never ends up with two visible rows.
 */
export function primaryDedupeMatch<
  T extends Pick<Appraisal, "id" | "idempotencyKey" | "seafarerId" | "agentId" | "hiddenFromAgentAt">
>(
  appraisals: readonly T[],
  key: string,
  seafarerId: string,
  agentId: string
): { hit: T | null; staleHiddenId: string | null } {
  if (!key) return { hit: null, staleHiddenId: null };
  const sameKey = appraisals.filter(
    (a) => a.idempotencyKey === key && a.seafarerId === seafarerId && a.agentId === agentId
  );
  const hit = sameKey.find((a) => !a.hiddenFromAgentAt) ?? null;
  if (hit) return { hit, staleHiddenId: null };
  const hidden = sameKey.find((a) => !!a.hiddenFromAgentAt) ?? null;
  return { hit: null, staleHiddenId: hidden ? hidden.id : null };
}

/** True when a `pending` keep/delete request already exists for this appraisal (#12). */
export function hasPendingDeleteRequest(
  requests: readonly Pick<AppraisalDeleteRequest, "appraisalId" | "status">[],
  appraisalId: string
): boolean {
  return requests.some((r) => r.appraisalId === appraisalId && r.status === "pending");
}

export type DeleteDecision = "keep" | "delete";

export type DeleteTransition =
  | { ok: false; terminal: "kept" | "deleted" }
  | { ok: true; nextStatus: "kept" | "deleted"; hardDelete: boolean };

/**
 * The seaman keep/delete decision transition (#12). Only a `pending` request is
 * decidable — any already-terminal status returns { ok:false, terminal } (=> 409). When
 * the appraisal row is already gone the request resolves TERMINALLY to "deleted" with
 * nothing left to delete (no throw/nag). Otherwise "keep" => kept (row stays, agent-hidden),
 * "delete" => deleted + hard-delete the row (co-transacted by the caller).
 */
export function resolveDeleteRequestTransition(
  request: Pick<AppraisalDeleteRequest, "status">,
  decision: DeleteDecision,
  appraisalExists: boolean
): DeleteTransition {
  if (request.status !== "pending") {
    return { ok: false, terminal: request.status };
  }
  if (!appraisalExists) {
    return { ok: true, nextStatus: "deleted", hardDelete: false };
  }
  const hardDelete = decision === "delete";
  return { ok: true, nextStatus: hardDelete ? "deleted" : "kept", hardDelete };
}
