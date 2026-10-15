// lib/admin-funnel.ts
//
// PURE, client-safe assembly of the docka internal-admin pipeline views. It mirrors
// the discipline of lib/analytics.ts: every input is PASSED IN (this module never
// reads the DB, the filesystem, or a clock itself), so it is deterministic and
// unit-testable, and it carries only TYPE-ONLY imports from lib/db.ts / lib/pipeline.ts
// (no Node built-ins) so it is safe to bundle on the client.
//
// Design rules baked in (plan §4.1, §4.1a, §4.2, §4.3, §4.5, §4.6, F4):
//   * Seamen stages are INDEPENDENT per-stage predicates, NOT an ordinal funnel — a
//     seaman can satisfy a later stage without an earlier one; no monotonic assumption.
//   * Every stage / row / event carries an explicit `provenance` label.
//   * A reached-at is a real, parseable timestamp or `null` ("not tracked"); we NEVER
//     emit NaN / Invalid Date. One malformed date in a set never poisons a min().
//   * Timeline events with a valid timestamp sort ascending into `dated`; events whose
//     timestamp is missing / unparseable go to a separate `undated` bucket (never
//     interleaved, never sorted as NaN).

import type {
  DB,
  Seafarer,
  Doc,
  Agent,
  Assignment,
  AccessGrant,
  AccessLogEntry,
  ConsentEvent,
} from "@/lib/db";
import { SEAFARER_STATES, STATE_LABELS, type SeafarerState } from "@/lib/pipeline";

// ---- Shared vocabulary -------------------------------------------------

/** Honesty label attached to every stage / row / event. */
export type Provenance = "tracked" | "approximated" | "not-tracked";

/** `now` is always injected — a number (epoch ms) or a Date. Never read internally. */
export type Now = number | Date;

function toMs(now: Now): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Parse one candidate timestamp to epoch-ms, or `null` if it is missing / not a
 * finite parseable instant. Accepts ISO strings (Date.parse) or an epoch number.
 */
function parseTime(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Minimum VALID timestamp across a candidate set, as epoch-ms, or `null` when the
 * set is empty after filtering. Invalid / unparseable / missing values are dropped
 * BEFORE the min, so a single malformed date can never poison the result to NaN
 * (plan §4.5 / F4).
 */
export function minValidTime(values: Array<string | number | null | undefined>): number | null {
  let min: number | null = null;
  for (const v of values) {
    const t = parseTime(v);
    if (t === null) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

// ---- 1) Seamen stages --------------------------------------------------

export type SeamanStageKey =
  | "account_created"
  | "document_uploaded"
  | "gov_verified"
  | "identity_verified"
  | "agent_approved"
  | "placed_at_sea"
  | "returned_finished";

/**
 * One independent per-stage aggregate count. Generic over the stage-key union so
 * both the seamen (SeamanStageKey) and agents (AgentStageKey) breakdowns reuse a
 * single exported type. Default key = SeamanStageKey.
 *
 * Stage-level `provenance`: "not-tracked" when the stage has zero members; else
 * "approximated" when at least one member is state-only (no timestamp);
 * else "tracked". `approximatedMembers` is the count of state-only members.
 */
export type StageCount<K extends string = SeamanStageKey> = {
  key: K;
  label: string;
  /** Number of subjects INDEPENDENTLY satisfying this stage's predicate. */
  count: number;
  provenance: Provenance;
  approximatedMembers: number;
};

/** Per-seaman membership record for a single stage. */
export type StageMembership = {
  member: boolean;
  /** Epoch-ms the stage was reached, or `null` = "not tracked". Never NaN. */
  reachedAt: number | null;
  provenance: Provenance;
};

export type SignupType = "agent-invited" | "self-signup";
// NOTE (real-type adaptation): the Seafarer row has NO phone-ownership field, so a
// phone-OTP seaman is indistinguishable from an anonymous local profile at the data
// level — only googleSub/ownerEmail are authoritative ownership markers. "phone" is
// retained in the union for forward-compatibility but is NEVER currently emitted.
export type OwnerType = "google" | "phone" | "anon";

export type SeamanRow = {
  id: string;
  name: string;
  rank: string;
  /** Raw Seafarer.createdAt (ISO string), or "" when absent. Roster sort key. */
  createdAt: string;
  currentState: SeafarerState;
  currentStateLabel: string;
  signupType: SignupType;
  owner: OwnerType;
  /** Independent membership for each of the 7 stages, keyed by stage key. */
  stages: Record<SeamanStageKey, StageMembership>;
};

export type IntegrityFlag =
  | {
      seamanId: string;
      kind: "out-of-order";
      note: string;
    }
  | {
      seamanId: string;
      kind: "conflict";
      note: string;
      /** Both sides surfaced, never coerced. */
      detail: {
        /** Assignment timestamp (tracked) that WINS as reached-at. Epoch-ms or null. */
        assignmentSentToSeaAt: number | null;
        /** The canonical Seafarer.state that disagrees. */
        canonicalState: SeafarerState;
      };
    };

export type SeamenStages = {
  stages: StageCount[];
  rows: SeamanRow[];
  flags: IntegrityFlag[];
  /** Canonical Seafarer.state distribution — the AUTHORITATIVE current position. */
  stateDist: Record<SeafarerState, number>;
  /** Echo of the injected clock, so identical inputs yield identical output. */
  generatedAt: number;
};

const SEAMAN_STAGE_LABELS: Record<SeamanStageKey, string> = {
  account_created: "Account created",
  document_uploaded: "Document uploaded",
  gov_verified: "Document gov-verified",
  identity_verified: "Identity verified",
  agent_approved: "Agent-approved",
  placed_at_sea: "Placed / sent to sea",
  returned_finished: "Returned / finished",
};

const SEAMAN_STAGE_ORDER: SeamanStageKey[] = [
  "account_created",
  "document_uploaded",
  "gov_verified",
  "identity_verified",
  "agent_approved",
  "placed_at_sea",
  "returned_finished",
];

const SENT_TO_SEA_INDEX = SEAFARER_STATES.indexOf("sent_to_sea");

function signupTypeOf(s: Seafarer): SignupType {
  return s.invited === true ? "agent-invited" : "self-signup";
}

function ownerOf(s: Seafarer): OwnerType {
  if ((s.googleSub && s.googleSub.length > 0) || (s.ownerEmail && s.ownerEmail.length > 0)) {
    return "google";
  }
  // No authoritative phone-ownership field exists on Seafarer (see OwnerType note).
  return "anon";
}

/**
 * Build the seamen per-stage breakdown. INDEPENDENT predicates — each stage's count
 * is the number of seamen who satisfy THAT predicate on its own; there is no nesting
 * or monotonic assumption. `stateDist` is returned SEPARATELY as the authoritative
 * current position and is NOT reconciled against the predicate stages.
 */
export function buildSeamenStages(db: DB, now: Now): SeamenStages {
  const generatedAt = toMs(now);

  // Index docs + assignments by seafarer (single pass each).
  const docsBySeafarer = new Map<string, Doc[]>();
  for (const d of db.documents) {
    const arr = docsBySeafarer.get(d.seafarerId);
    if (arr) arr.push(d);
    else docsBySeafarer.set(d.seafarerId, [d]);
  }
  const asgBySeafarer = new Map<string, Assignment[]>();
  for (const a of db.assignments) {
    const arr = asgBySeafarer.get(a.seafarerId);
    if (arr) arr.push(a);
    else asgBySeafarer.set(a.seafarerId, [a]);
  }

  // Canonical state distribution (authoritative current position).
  const stateDist = {} as Record<SeafarerState, number>;
  for (const st of SEAFARER_STATES) stateDist[st] = 0;
  for (const s of db.seafarers) {
    if (SEAFARER_STATES.includes(s.state)) stateDist[s.state] += 1;
  }

  const rows: SeamanRow[] = [];
  const flags: IntegrityFlag[] = [];

  // Per-stage running aggregates.
  const counts: Record<SeamanStageKey, number> = {
    account_created: 0,
    document_uploaded: 0,
    gov_verified: 0,
    identity_verified: 0,
    agent_approved: 0,
    placed_at_sea: 0,
    returned_finished: 0,
  };
  const approx: Record<SeamanStageKey, number> = {
    account_created: 0,
    document_uploaded: 0,
    gov_verified: 0,
    identity_verified: 0,
    agent_approved: 0,
    placed_at_sea: 0,
    returned_finished: 0,
  };

  for (const s of db.seafarers) {
    const docs = docsBySeafarer.get(s.id) ?? [];
    const asgs = asgBySeafarer.get(s.id) ?? [];
    const stateIdx = SEAFARER_STATES.indexOf(s.state);

    // 1) Account created — the row exists.
    const stage1: StageMembership = {
      member: true,
      reachedAt: minValidTime([s.createdAt]),
      provenance: "tracked",
    };

    // 2) Document uploaded — any doc for this seaman.
    const hasDoc = docs.length > 0;
    const stage2: StageMembership = {
      member: hasDoc,
      reachedAt: hasDoc ? minValidTime(docs.map((d) => d.createdAt)) : null,
      provenance: hasDoc ? "tracked" : "not-tracked",
    };

    // 3) Gov-verified — a doc with verifiedResolvedAt set AND isValid === true.
    const govDocs = docs.filter((d) => d.verifiedResolvedAt != null && d.isValid === true);
    const hasGov = govDocs.length > 0;
    const stage3: StageMembership = {
      member: hasGov,
      reachedAt: hasGov ? minValidTime(govDocs.map((d) => d.verifiedResolvedAt)) : null,
      provenance: hasGov ? "tracked" : "not-tracked",
    };

    // 3a) Identity verified — Seafarer.identityVerified === true.
    const hasIdentity = s.identityVerified === true;
    const stage3a: StageMembership = {
      member: hasIdentity,
      reachedAt: hasIdentity ? minValidTime([s.identityVerifiedAt]) : null,
      provenance: hasIdentity ? "tracked" : "not-tracked",
    };

    // 4) Agent-approved — a doc with reviewStatus === "approved".
    const approvedDocs = docs.filter((d) => d.reviewStatus === "approved");
    const hasApproved = approvedDocs.length > 0;
    const stage4: StageMembership = {
      member: hasApproved,
      // An approved doc with a null reviewedAt → member true, reachedAt null.
      reachedAt: hasApproved ? minValidTime(approvedDocs.map((d) => d.reviewedAt)) : null,
      provenance: hasApproved ? "tracked" : "not-tracked",
    };

    // 5) Placed / sent to sea — an assignment exists OR state === "sent_to_sea".
    const hasAssignment = asgs.length > 0;
    const stateAtSea = s.state === "sent_to_sea";
    const memberStage5 = hasAssignment || stateAtSea;
    const stage5: StageMembership = {
      member: memberStage5,
      // Assignment timestamp (tracked) WINS; state-only membership has no timestamp.
      reachedAt: hasAssignment ? minValidTime(asgs.map((a) => a.sentToSeaAt)) : null,
      provenance: !memberStage5 ? "not-tracked" : hasAssignment ? "tracked" : "approximated",
    };

    // 6) Returned / finished — an assignment with returnedAt set, OR state in
    //    {returning, finished}.
    const returnedAsgs = asgs.filter((a) => a.returnedAt != null);
    const hasReturnedAsg = returnedAsgs.length > 0;
    const stateReturnedish = s.state === "returning" || s.state === "finished";
    const memberStage6 = hasReturnedAsg || stateReturnedish;
    const stage6: StageMembership = {
      member: memberStage6,
      reachedAt: hasReturnedAsg ? minValidTime(returnedAsgs.map((a) => a.returnedAt)) : null,
      provenance: !memberStage6 ? "not-tracked" : hasReturnedAsg ? "tracked" : "approximated",
    };

    const stages: Record<SeamanStageKey, StageMembership> = {
      account_created: stage1,
      document_uploaded: stage2,
      gov_verified: stage3,
      identity_verified: stage3a,
      agent_approved: stage4,
      placed_at_sea: stage5,
      returned_finished: stage6,
    };

    // Aggregate.
    for (const key of SEAMAN_STAGE_ORDER) {
      const m = stages[key];
      if (m.member) {
        counts[key] += 1;
        if (m.provenance === "approximated") approx[key] += 1;
      }
    }

    // --- Integrity flags (plan §4.1a) ---
    // out-of-order: at sea (stage 5) without an approved doc (stage 4).
    if (memberStage5 && !hasApproved) {
      flags.push({
        seamanId: s.id,
        kind: "out-of-order",
        note: "at sea without an approved doc on file",
      });
    }
    // conflict: an assignment EXISTS but the canonical state disagrees (state is
    // before sent_to_sea). The assignment timestamp (tracked) wins as reached-at;
    // both values are surfaced, never coerced.
    if (hasAssignment && stateIdx >= 0 && stateIdx < SENT_TO_SEA_INDEX) {
      flags.push({
        seamanId: s.id,
        kind: "conflict",
        note: `assignment sentToSeaAt is set but Seafarer.state is "${s.state}"`,
        detail: {
          assignmentSentToSeaAt: minValidTime(asgs.map((a) => a.sentToSeaAt)),
          canonicalState: s.state,
        },
      });
    }

    rows.push({
      id: s.id,
      name: s.name,
      rank: s.rank,
      createdAt: s.createdAt ?? "",
      currentState: s.state,
      currentStateLabel: STATE_LABELS[s.state] ?? String(s.state),
      signupType: signupTypeOf(s),
      owner: ownerOf(s),
      stages,
    });
  }

  const stages: StageCount[] = SEAMAN_STAGE_ORDER.map((key) => {
    const count = counts[key];
    const approximatedMembers = approx[key];
    let provenance: Provenance;
    if (count === 0) provenance = "not-tracked";
    else if (approximatedMembers > 0) provenance = "approximated";
    else provenance = "tracked";
    return { key, label: SEAMAN_STAGE_LABELS[key], count, provenance, approximatedMembers };
  });

  return { stages, rows, flags, stateDist, generatedAt };
}

// ---- 2) Agents stages --------------------------------------------------

export type AgentStageKey =
  | "tenant_created"
  | "first_grant"
  | "first_access"
  | "first_crew_sent";

export type AgentStageMembership = {
  member: boolean;
  reachedAt: number | null;
  provenance: Provenance;
};

export type AgentRow = {
  id: string;
  orgName: string;
  /**
   * Human label for the roster: the billing legal name when the agent has a
   * billing profile with a non-empty legalName, else "" (empty). No handle
   * fallback — a blank-named row is identified by its id (owner rule).
   */
  displayName: string;
  createdAt: number | null;
  stages: Record<AgentStageKey, AgentStageMembership>;
  /** Latest access-log entry.at for this agent — a best-effort activity proxy. */
  lastActivity: number | null;
  /** Always "approximated" (proxy) when lastActivity is set, else "not-tracked". */
  lastActivityProvenance: Provenance;
};

/** An agentId referenced by data but matching no Agent row (defensive; expected empty). */
export type UnmappedAgent = {
  agentId: string;
  grantCount: number;
  assignmentCount: number;
  accessLogCount: number;
};

export type AgentsStages = {
  stages: StageCount<AgentStageKey>[];
  rows: AgentRow[];
  /** The `dev` tenant separated out of the headline rows (the dev-door, not a real agent). */
  devExcluded: AgentRow | null;
  /** agentIds in grants/assignments/accessLog with no Agent row (never silently dropped). */
  unmappedGoogle: UnmappedAgent[];
  generatedAt: number;
};

const AGENT_STAGE_LABELS: Record<AgentStageKey, string> = {
  tenant_created: "Tenant created",
  first_grant: "First grant received",
  first_access: "First access / review action",
  first_crew_sent: "First crew sent to sea",
};

const AGENT_STAGE_ORDER: AgentStageKey[] = [
  "tenant_created",
  "first_grant",
  "first_access",
  "first_crew_sent",
];

function buildAgentRow(
  agent: Agent,
  grantsBy: Map<string, AccessGrant[]>,
  asgsBy: Map<string, Assignment[]>,
  logBy: Map<string, AccessLogEntry[]>,
  /** agentId -> trimmed, non-empty billing legalName (built once by the caller). */
  legalNameBy: Map<string, string>
): AgentRow {
  const grants = grantsBy.get(agent.id) ?? [];
  const asgs = asgsBy.get(agent.id) ?? [];
  const log = logBy.get(agent.id) ?? [];

  const hasGrant = grants.length > 0;
  const hasLog = log.length > 0;
  const hasAsg = asgs.length > 0;

  const stages: Record<AgentStageKey, AgentStageMembership> = {
    tenant_created: {
      member: true,
      reachedAt: minValidTime([agent.createdAt]),
      provenance: "tracked",
    },
    first_grant: {
      member: hasGrant,
      reachedAt: hasGrant ? minValidTime(grants.map((g) => g.createdAt)) : null,
      provenance: hasGrant ? "tracked" : "not-tracked",
    },
    first_access: {
      member: hasLog,
      reachedAt: hasLog ? minValidTime(log.map((e) => e.at)) : null,
      provenance: hasLog ? "tracked" : "not-tracked",
    },
    first_crew_sent: {
      member: hasAsg,
      reachedAt: hasAsg ? minValidTime(asgs.map((a) => a.sentToSeaAt)) : null,
      provenance: hasAsg ? "tracked" : "not-tracked",
    },
  };

  const lastActivity = log.length > 0 ? maxValidTime(log.map((e) => e.at)) : null;

  return {
    id: agent.id,
    orgName: agent.orgName,
    displayName: legalNameBy.get(agent.id) ?? "",
    createdAt: minValidTime([agent.createdAt]),
    stages,
    lastActivity,
    lastActivityProvenance: lastActivity === null ? "not-tracked" : "approximated",
  };
}

/** Max VALID timestamp across a candidate set (epoch-ms) or null after filtering. */
function maxValidTime(values: Array<string | number | null | undefined>): number | null {
  let max: number | null = null;
  for (const v of values) {
    const t = parseTime(v);
    if (t === null) continue;
    if (max === null || t > max) max = t;
  }
  return max;
}

/**
 * Build the agents per-stage breakdown, keyed by Agent.id. The `dev` tenant is
 * separated into `devExcluded`; any agentId referenced by grants/assignments/access-log
 * that matches no Agent row is collected in `unmappedGoogle` (never dropped).
 */
export function buildAgentsStages(db: DB, accessLog: AccessLogEntry[], now: Now): AgentsStages {
  const generatedAt = toMs(now);

  const grantsBy = new Map<string, AccessGrant[]>();
  for (const g of db.accessGrants) {
    const arr = grantsBy.get(g.agentId);
    if (arr) arr.push(g);
    else grantsBy.set(g.agentId, [g]);
  }
  const asgsBy = new Map<string, Assignment[]>();
  for (const a of db.assignments) {
    const arr = asgsBy.get(a.agentId);
    if (arr) arr.push(a);
    else asgsBy.set(a.agentId, [a]);
  }
  const logBy = new Map<string, AccessLogEntry[]>();
  for (const e of accessLog) {
    const arr = logBy.get(e.agentId);
    if (arr) arr.push(e);
    else logBy.set(e.agentId, [e]);
  }

  const agentIds = new Set(db.agents.map((a) => a.id));

  // agentId -> trimmed, non-empty billing legalName, built ONCE (no O(n·m) per-row
  // scan of billingProfiles). Empty/whitespace legalNames are dropped so the row's
  // displayName resolves to "" (blank — no orgName fallback, owner rule). Malformed
  // rows (e.g. company name mistakenly stored in regCode) are left untouched — such
  // a row simply shows blank and is identified by its id.
  const legalNameBy = new Map<string, string>();
  for (const p of db.billingProfiles) {
    const legal = (p.legalName ?? "").trim();
    if (legal) legalNameBy.set(p.agentId, legal);
  }

  const rows: AgentRow[] = [];
  let devExcluded: AgentRow | null = null;
  for (const agent of db.agents) {
    const row = buildAgentRow(agent, grantsBy, asgsBy, logBy, legalNameBy);
    if (agent.id === "dev") devExcluded = row;
    else rows.push(row);
  }

  // Unmapped: any agentId in the referenced keyspace with no Agent row.
  const unmappedMap = new Map<string, UnmappedAgent>();
  const bump = (
    agentId: string,
    field: "grantCount" | "assignmentCount" | "accessLogCount"
  ): void => {
    if (agentIds.has(agentId)) return;
    let u = unmappedMap.get(agentId);
    if (!u) {
      u = { agentId, grantCount: 0, assignmentCount: 0, accessLogCount: 0 };
      unmappedMap.set(agentId, u);
    }
    u[field] += 1;
  };
  for (const g of db.accessGrants) bump(g.agentId, "grantCount");
  for (const a of db.assignments) bump(a.agentId, "assignmentCount");
  for (const e of accessLog) bump(e.agentId, "accessLogCount");
  const unmappedGoogle = [...unmappedMap.values()].sort((a, b) =>
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0
  );

  // Headline stage counts EXCLUDE the dev tenant (rows already exclude it).
  const counts: Record<AgentStageKey, number> = {
    tenant_created: 0,
    first_grant: 0,
    first_access: 0,
    first_crew_sent: 0,
  };
  const approx: Record<AgentStageKey, number> = {
    tenant_created: 0,
    first_grant: 0,
    first_access: 0,
    first_crew_sent: 0,
  };
  for (const row of rows) {
    for (const key of AGENT_STAGE_ORDER) {
      const m = row.stages[key];
      if (m.member) {
        counts[key] += 1;
        if (m.provenance === "approximated") approx[key] += 1;
      }
    }
  }

  const stages: StageCount<AgentStageKey>[] = AGENT_STAGE_ORDER.map((key) => {
    const count = counts[key];
    const approximatedMembers = approx[key];
    let provenance: Provenance;
    if (count === 0) provenance = "not-tracked";
    else if (approximatedMembers > 0) provenance = "approximated";
    else provenance = "tracked";
    return { key, label: AGENT_STAGE_LABELS[key], count, provenance, approximatedMembers };
  });

  return { stages, rows, devExcluded, unmappedGoogle, generatedAt };
}

// ---- 3) User timeline --------------------------------------------------

export type TimelineEvent = {
  /** Epoch-ms of the event, or `null` for the undated bucket. */
  at: number | null;
  /** The raw timestamp as stored, for display / debugging. */
  atRaw: string | null;
  type: string;
  label: string;
  provenance: Provenance;
  /** Optional structured detail (ids, statuses, add-on flags). */
  extra?: Record<string, unknown>;
};

export type UserTimeline = {
  /** Events with a valid, parseable timestamp — sorted ASCENDING. */
  dated: TimelineEvent[];
  /** Events with a missing / unparseable timestamp — never sorted as NaN. */
  undated: TimelineEvent[];
};

type Draft = {
  raw: string | null | undefined;
  type: string;
  label: string;
  provenance: Provenance;
  extra?: Record<string, unknown>;
};

/**
 * Merge one user's persisted milestones into a chronological list. Consent events
 * (which carry only a grantId) are resolved to a seaman via
 * AccessGrant.seafarerId. Dated events sort ascending; undated events (missing /
 * unparseable timestamp) are isolated in their own bucket.
 */
export function buildUserTimeline(
  db: DB,
  accessLog: AccessLogEntry[],
  consent: ConsentEvent[],
  kind: "seaman" | "agent",
  id: string
): UserTimeline {
  const drafts: Draft[] = [];
  const push = (d: Draft): void => {
    drafts.push(d);
  };

  if (kind === "seaman") {
    const s = db.seafarers.find((x) => x.id === id);
    if (s) {
      push({
        raw: s.createdAt,
        type: "account_created",
        label: "Account created",
        provenance: "tracked",
        extra: { signupType: signupTypeOf(s), owner: ownerOf(s) },
      });
      if (s.identityVerified === true) {
        push({
          raw: s.identityVerifiedAt,
          type: "identity_verified",
          label: "Identity government-verified",
          provenance: "tracked",
        });
      }
    }

    // Documents: upload, gov verification, review decision, archival (add-on).
    for (const d of db.documents) {
      if (d.seafarerId !== id) continue;
      push({
        raw: d.createdAt,
        type: "doc_uploaded",
        label: `Document uploaded: ${d.title}`,
        provenance: "tracked",
        extra: { docId: d.id, docType: d.docType, source: d.source },
      });
      if (d.verifiedResolvedAt != null) {
        push({
          raw: d.verifiedResolvedAt,
          type: "gov_verified",
          label: `Government verification: ${d.title}`,
          provenance: "tracked",
          extra: { docId: d.id, isValid: d.isValid },
        });
      }
      if (d.reviewStatus !== "pending") {
        push({
          raw: d.reviewedAt,
          type: "review_decision",
          label: `Review ${d.reviewStatus}: ${d.title}`,
          provenance: "tracked",
          extra: { docId: d.id, reviewStatus: d.reviewStatus, reviewedBy: d.reviewedBy ?? null },
        });
      }
      // OPTIONAL add-on: document archival.
      if (d.archived === true) {
        push({
          raw: d.archivedAt,
          type: "doc_archived",
          label: `Document archived: ${d.title}`,
          provenance: "tracked",
          extra: { docId: d.id, addon: true },
        });
      }
    }

    // Grant lifecycle for this seaman.
    for (const g of db.accessGrants) {
      if (g.seafarerId !== id) continue;
      push({
        raw: g.createdAt,
        type: "grant_created",
        label: "Access grant created",
        provenance: "tracked",
        extra: { grantId: g.id, agentId: g.agentId, status: g.status },
      });
      if (g.grantedAt != null) {
        push({
          raw: g.grantedAt,
          type: "grant_granted",
          label: "Access grant activated",
          provenance: "tracked",
          extra: { grantId: g.id, agentId: g.agentId },
        });
      }
      if (g.revokedAt != null) {
        push({
          raw: g.revokedAt,
          type: "grant_revoked",
          label: "Access grant revoked",
          provenance: "tracked",
          extra: { grantId: g.id, agentId: g.agentId },
        });
      }
    }

    // Consent events — join via grantId -> AccessGrant.seafarerId.
    const grantToSeafarer = new Map<string, string>();
    for (const g of db.accessGrants) grantToSeafarer.set(g.id, g.seafarerId);
    for (const c of consent) {
      if (grantToSeafarer.get(c.grantId) !== id) continue;
      push({
        raw: c.at,
        type: `consent_${c.type}`,
        label: `Consent ${c.type}`,
        provenance: "tracked",
        extra: { grantId: c.grantId, consentType: c.type, actor: c.actor },
      });
    }

    // Access-log events naming this seaman (direct seafarerId).
    for (const e of accessLog) {
      if (e.seafarerId !== id) continue;
      push({
        raw: e.at,
        type: `access_${e.action}`,
        label: `Agent ${e.action.toLowerCase()}`,
        provenance: "tracked",
        extra: { action: e.action, agentId: e.agentId, documentRef: e.documentRef },
      });
    }

    // Assignments sent / returned.
    for (const a of db.assignments) {
      if (a.seafarerId !== id) continue;
      push({
        raw: a.sentToSeaAt,
        type: "assignment_sent",
        label: "Sent to sea",
        provenance: "tracked",
        extra: { assignmentId: a.id, agentId: a.agentId, vessel: a.vessel },
      });
      if (a.returnedAt != null) {
        push({
          raw: a.returnedAt,
          type: "assignment_returned",
          label: "Returned from sea",
          provenance: "tracked",
          extra: { assignmentId: a.id, agentId: a.agentId, vessel: a.vessel },
        });
      }
    }
    // NOTE (real-type adaptation): db.notifications (NotificationLog) carries no
    // seafarerId, so it cannot be attributed to a specific seaman and is intentionally
    // omitted from the seaman timeline.
  } else {
    // kind === "agent"; id === Agent.id
    const agent = db.agents.find((x) => x.id === id);
    if (agent) {
      push({
        raw: agent.createdAt,
        type: "tenant_created",
        label: "Tenant created",
        provenance: "tracked",
        extra: { orgName: agent.orgName },
      });
    }
    for (const g of db.accessGrants) {
      if (g.agentId !== id) continue;
      push({
        raw: g.createdAt,
        type: "grant_created",
        label: "Access grant received",
        provenance: "tracked",
        extra: { grantId: g.id, seafarerId: g.seafarerId, status: g.status },
      });
      if (g.grantedAt != null) {
        push({
          raw: g.grantedAt,
          type: "grant_granted",
          label: "Access grant activated",
          provenance: "tracked",
          extra: { grantId: g.id, seafarerId: g.seafarerId },
        });
      }
      if (g.revokedAt != null) {
        push({
          raw: g.revokedAt,
          type: "grant_revoked",
          label: "Access grant revoked",
          provenance: "tracked",
          extra: { grantId: g.id, seafarerId: g.seafarerId },
        });
      }
    }
    for (const e of accessLog) {
      if (e.agentId !== id) continue;
      push({
        raw: e.at,
        type: `access_${e.action}`,
        label: `${e.action.toLowerCase()}`,
        provenance: "tracked",
        extra: { action: e.action, seafarerId: e.seafarerId, documentRef: e.documentRef },
      });
    }
    for (const a of db.assignments) {
      if (a.agentId !== id) continue;
      push({
        raw: a.sentToSeaAt,
        type: "assignment_sent",
        label: "Crew sent to sea",
        provenance: "tracked",
        extra: { assignmentId: a.id, seafarerId: a.seafarerId, vessel: a.vessel },
      });
      if (a.returnedAt != null) {
        push({
          raw: a.returnedAt,
          type: "assignment_returned",
          label: "Crew returned from sea",
          provenance: "tracked",
          extra: { assignmentId: a.id, seafarerId: a.seafarerId, vessel: a.vessel },
        });
      }
    }
  }

  // Partition into dated / undated, preserving a deterministic order.
  const dated: Array<TimelineEvent & { _seq: number }> = [];
  const undated: TimelineEvent[] = [];
  drafts.forEach((d, seq) => {
    const at = parseTime(d.raw);
    const atRaw = d.raw == null ? null : String(d.raw);
    const ev: TimelineEvent = {
      at,
      atRaw,
      type: d.type,
      label: d.label,
      provenance: d.provenance,
      ...(d.extra ? { extra: d.extra } : {}),
    };
    if (at === null) {
      undated.push(ev);
    } else {
      dated.push({ ...ev, _seq: seq });
    }
  });

  // Ascending by timestamp; ties broken by original insertion order (deterministic).
  dated.sort((a, b) => (a.at! - b.at!) || (a._seq - b._seq));

  return {
    dated: dated.map(({ _seq, ...ev }) => ev),
    undated,
  };
}
