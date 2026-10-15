// lib/outreach-overrides.ts — PURE, node-testable store logic for the manual
// hold / manual move override set (feat/manual-hold).
//
// The APP override store is the SOURCE OF TRUTH: an operator clicking Hold /
// Unhold / Move on /admin/leads or /admin/outreach writes here (instant,
// authoritative); the outreach pipeline PULLS this every cycle and self-heals.
//
// This module has NO fs / db / next dependency — it is a set of pure functions
// over an OutreachOverrides value (pattern: lib/outreach-snapshot.ts). The only
// import is foldDiacritics, reused from lib/fuzzy-name so the company-key
// normaliser matches the existing duplicates.ts idiom exactly.
//
// normalizeCompanyKey is a HARD cross-repo shipping gate [V4][B6]: its output
// must equal the Python port byte-for-byte on the shared golden vector
// (tests/fixtures/company_normalize_vectors.json).

import { foldDiacritics } from "@/lib/fuzzy-name";

// ---- Types ---------------------------------------------------------------

export type OutreachMoveStatus = "pending" | "applied" | "rejected";

export type OutreachMove = {
  /** == moveSeq at creation; supersede + idempotency key. */
  id: number;
  sendKey: string;
  /** Validated ACTIVE move-target stage at write time [R7]. */
  toStage: string;
  createdBy: string;
  createdAt: string;
  status: OutreachMoveStatus;
  appliedAt: string | null;
  rejectedReason: string | null;
};

// ---- Draft decisions (reply desk, wave 3 M2) ------------------------------
//
// The operator's Approve / Approve-with-edits / Reject on a queued draft. These
// ride the SAME document as holds/moves but are a SEPARATE channel: the
// pipeline validates them PER ROW and fail-soft, so a bad decision row can
// never invalidate the holds sync. NOTHING here sends: a row is an intent the
// pipeline folds into its draft ledger, and only a folded approval lets its
// guard 8 permit a send.
//
// `not_a_reply` (auto-ack handling, 2026-09-08): the operator says the inbound
// the pipeline stopped on was an automated acknowledgement, not a person. The
// pipeline folds it by reclassifying that inbound to `auto_ack` and restoring
// the sequence (its `apply_not_a_reply`); it also dismisses the ledger row the
// decision names. Like a reject it is a STOP-shaped action (nothing is sent by
// it), so it is never counted against the approvals cap.

export type OutreachDraftActionKind = "approve" | "approve_edit" | "reject" | "not_a_reply";
export type OutreachDraftActionStatus = "pending" | "folded";

export type OutreachDraftAction = {
  /** == draftActionSeq at creation; the pipeline's replay key. */
  id: number;
  /** The pipeline draft-ledger id this decision is about. */
  draftId: string;
  action: OutreachDraftActionKind;
  /** approve_edit only — the operator's replacement body, FOOTER EXCLUDED. */
  editedBody: string | null;
  /** reject only (optional). */
  reason: string | null;
  actor: string;
  ts: string;
  status: OutreachDraftActionStatus;
  foldedAt: string | null;
};

export type OutreachOverrides = {
  /** ++ on EVERY successful mutation; the pipeline uses it as a staleness guard [R2]. */
  version: number;
  holds: {
    /** send_keys held (deduped). */
    leads: string[];
    /** NORMALIZED company_name keys held (deduped). */
    companies: string[];
  };
  /** At most ONE pending move per sendKey (a newer move REPLACES = supersede). */
  moves: OutreachMove[];
  /** Monotonic move-id source, independent of version. */
  moveSeq: number;
  /** At most ONE pending decision per draftId (a newer one REPLACES). */
  draftActions: OutreachDraftAction[];
  /** Monotonic draft-action id source, independent of version and moveSeq. */
  draftActionSeq: number;
  /** [R2][V5] surfaced to the pipeline; a strictly-forward updatedAt signals a legit reset. */
  updatedAt: string;
};

// ---- Stage contract (mirrors the pipeline; kept local to this module) -----
//
// Legal MOVE TARGETS (active stages + closed). NEVER suppressed / undeliverable.
export const ACTIVE_MOVE_STAGES = [
  "queued",
  "email1",
  "followup",
  "breakup",
  "replied",
  "conversation",
  "trial_won",
  "closed",
] as const;

// A move is BLOCKED when the lead's CURRENT stage is one of these (un-suppress
// is out of scope). The full pipeline stage list is documented for parity.
export const MOVE_BLOCKED_CURRENT_STAGES = ["suppressed", "undeliverable"] as const;

export const FULL_PIPELINE_STAGES = [
  "queued",
  "email1",
  "followup",
  "breakup",
  "replied",
  "conversation",
  "trial_won",
  "suppressed",
  "closed",
  "undeliverable",
] as const;

const ACTIVE_MOVE_SET = new Set<string>(ACTIVE_MOVE_STAGES);
const BLOCKED_CURRENT_SET = new Set<string>(MOVE_BLOCKED_CURRENT_STAGES);

// ---- Bounded-input caps [R13] --------------------------------------------

export const MAX_HELD_LEADS = 10000;
export const MAX_HELD_COMPANIES = 5000;
export const MAX_KEY_LEN = 512;
export const MAX_PENDING_MOVES = 5000;
/** Keep at most this many terminal (applied/rejected) moves for audit; prune older. */
export const KEEP_TERMINAL_MOVES = 200;

// ---- Draft-decision caps (wave 3 M2) -------------------------------------
/** Operator edits are ONE reply body; the pipeline enforces the same 20 KB. */
export const MAX_EDITED_BODY_BYTES = 20 * 1024;
export const MAX_REJECT_REASON_CHARS = 500;
/**
 * [v4 §6] "Pending" = appended but not yet folded by the pipeline. The cap
 * applies to APPROVALS ONLY — a reject (like a hold) is a STOP and is always
 * accepted, because the one thing an operator must never be rate-limited out
 * of is calling off a send. `not_a_reply` is likewise uncapped: it sends
 * nothing, and an operator clearing a mis-stopped sequence must never be
 * blocked by a full approvals queue.
 */
export const MAX_PENDING_DRAFT_APPROVALS = 50;
/** Keep at most this many folded decisions for audit; prune older. */
export const KEEP_FOLDED_DRAFT_ACTIONS = 200;

const DRAFT_ACTION_SET = new Set<string>(["approve", "approve_edit", "reject", "not_a_reply"]);
/** Decisions that never count against MAX_PENDING_DRAFT_APPROVALS (they send nothing). */
const UNCAPPED_DRAFT_ACTIONS = new Set<string>(["reject", "not_a_reply"]);

// ---- Company-key normaliser [R9][V4] -------------------------------------

/**
 * Canonical algorithm (§2 steps 1-7), implementable identically in JS and
 * Python. The shared golden-vector fixture is the authority — do NOT "improve"
 * this without regenerating the fixture on BOTH sides.
 *
 *   1. null/undefined -> "".
 *   2. NFC normalise FIRST (so NFD vs NFC converge before casing).
 *   3. foldDiacritics (NFD + strip combining marks): é -> e, İ -> I, ş -> s.
 *   4. trim, then .toLowerCase() (NOT .casefold(); the pair chosen to AGREE).
 *   5. collapse any whitespace run (incl. NBSP) to a single ASCII space.
 *   6. replace "." / "," with a space, then collapse + trim.
 *   7. blank -> "".
 */
export function normalizeCompanyKey(s: string | null | undefined): string {
  const raw = s === null || s === undefined ? "" : String(s);
  const folded = foldDiacritics(raw.normalize("NFC")); // NFD + strip combining marks
  let out = folded.trim().toLowerCase();
  out = out.replace(/\s+/g, " ");
  out = out.replace(/[.,]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// ---- Defaults + migration ------------------------------------------------

export function emptyOverrides(nowIso: string = new Date().toISOString()): OutreachOverrides {
  return {
    version: 0,
    holds: { leads: [], companies: [] },
    moves: [],
    moveSeq: 0,
    draftActions: [],
    draftActionSeq: 0,
    updatedAt: nowIso,
  };
}

/** Tolerant read-migration: coerce a legacy/partial db.json value into a valid
 *  store, defaulting anything missing/malformed. Never throws. */
export function migrateOverrides(raw: unknown, nowIso: string = new Date().toISOString()): OutreachOverrides {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyOverrides(nowIso);
  const o = raw as Record<string, unknown>;
  const holds = (o.holds ?? {}) as Record<string, unknown>;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === "string"))) : [];
  const moves: OutreachMove[] = Array.isArray(o.moves)
    ? (o.moves.filter((m) => m && typeof m === "object") as Record<string, unknown>[])
        .map((m) => ({
          id: typeof m.id === "number" ? m.id : 0,
          sendKey: typeof m.sendKey === "string" ? m.sendKey : "",
          toStage: typeof m.toStage === "string" ? m.toStage : "",
          createdBy: typeof m.createdBy === "string" ? m.createdBy : "",
          createdAt: typeof m.createdAt === "string" ? m.createdAt : nowIso,
          status:
            m.status === "applied" || m.status === "rejected" ? (m.status as OutreachMoveStatus) : "pending",
          appliedAt: typeof m.appliedAt === "string" ? m.appliedAt : null,
          rejectedReason: typeof m.rejectedReason === "string" ? m.rejectedReason : null,
        }))
        .filter((m) => m.id > 0 && m.sendKey !== "")
    : [];
  const version = typeof o.version === "number" && o.version >= 0 ? o.version : 0;
  const moveSeq = typeof o.moveSeq === "number" && o.moveSeq >= 0 ? o.moveSeq : moves.reduce((a, m) => Math.max(a, m.id), 0);
  // Wave 3 M2: legacy db.json files load with an EMPTY decision list (tolerant
  // read, no data migration) — same stance as moves.
  const draftActions: OutreachDraftAction[] = Array.isArray(o.draftActions)
    ? (o.draftActions.filter((a) => a && typeof a === "object") as Record<string, unknown>[])
        .map((a) => ({
          id: typeof a.id === "number" ? a.id : 0,
          draftId: typeof a.draftId === "string" ? a.draftId : "",
          action: DRAFT_ACTION_SET.has(a.action as string)
            ? (a.action as OutreachDraftActionKind)
            : "approve",
          editedBody: typeof a.editedBody === "string" ? a.editedBody : null,
          reason: typeof a.reason === "string" ? a.reason : null,
          actor: typeof a.actor === "string" ? a.actor : "",
          ts: typeof a.ts === "string" ? a.ts : nowIso,
          status: (a.status === "folded" ? "folded" : "pending") as OutreachDraftActionStatus,
          foldedAt: typeof a.foldedAt === "string" ? a.foldedAt : null,
        }))
        .filter((a) => a.id > 0 && a.draftId !== "")
    : [];
  const draftActionSeq =
    typeof o.draftActionSeq === "number" && o.draftActionSeq >= 0
      ? o.draftActionSeq
      : draftActions.reduce((a, x) => Math.max(a, x.id), 0);
  return {
    version,
    holds: { leads: strList(holds.leads), companies: strList(holds.companies) },
    moves,
    moveSeq,
    draftActions,
    draftActionSeq,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso,
  };
}

// ---- Ops (hold / unhold / move) ------------------------------------------

export type HoldOp = { op: "hold" | "unhold"; scope: "lead" | "company"; key: string };
export type MoveOp = { op: "move"; sendKey: string; toStage: string };
export type OverrideOp = HoldOp | MoveOp;

export type ApplyOk = { ok: true; version: number };
export type ApplyErr = { ok: false; error: string };
export type ApplyOutcome = ApplyOk | ApplyErr;

function bump(store: OutreachOverrides, now: string): void {
  store.version += 1;
  store.updatedAt = now;
}

/**
 * Apply one operation IN PLACE (called inside updateDB's mutator). Returns the
 * new version on success, or a validation error (the route maps it to 400).
 *
 * - hold/unhold are idempotent: a redundant click does NOT bump the version.
 * - a company key is normalised; an empty normalised company is rejected.
 * - move validates toStage is an ACTIVE target and the lead's current stage is
 *   not suppressed/undeliverable, then SUPERSEDES any pending move for that key.
 */
export function applyOp(
  store: OutreachOverrides,
  op: OverrideOp,
  opts: { now?: string; createdBy?: string; currentStage?: string | null } = {}
): ApplyOutcome {
  const now = opts.now ?? new Date().toISOString();

  if (op.op === "move") {
    const sendKey = typeof op.sendKey === "string" ? op.sendKey.trim() : "";
    if (sendKey === "" || sendKey.length > MAX_KEY_LEN) return { ok: false, error: "invalid sendKey" };
    if (typeof op.toStage !== "string" || !ACTIVE_MOVE_SET.has(op.toStage)) {
      return { ok: false, error: `invalid move target "${String(op.toStage)}"` };
    }
    const cur = opts.currentStage;
    if (typeof cur === "string" && BLOCKED_CURRENT_SET.has(cur)) {
      return { ok: false, error: `lead is currently ${cur} — un-suppress is out of scope` };
    }
    // Supersede: drop any PENDING move for this sendKey; a newer intent wins.
    store.moves = store.moves.filter((m) => !(m.status === "pending" && m.sendKey === sendKey));
    if (store.moves.filter((m) => m.status === "pending").length >= MAX_PENDING_MOVES) {
      return { ok: false, error: "too many pending moves" };
    }
    store.moveSeq += 1;
    store.moves.push({
      id: store.moveSeq,
      sendKey,
      toStage: op.toStage,
      createdBy: opts.createdBy ?? "",
      createdAt: now,
      status: "pending",
      appliedAt: null,
      rejectedReason: null,
    });
    bump(store, now);
    return { ok: true, version: store.version };
  }

  if (op.op === "hold" || op.op === "unhold") {
    if (op.scope !== "lead" && op.scope !== "company") return { ok: false, error: "invalid scope" };
    if (typeof op.key !== "string") return { ok: false, error: "invalid key" };
    const list = op.scope === "lead" ? store.holds.leads : store.holds.companies;
    const key = op.scope === "company" ? normalizeCompanyKey(op.key) : op.key.trim();
    if (op.op === "hold") {
      if (key === "" || key.length > MAX_KEY_LEN) return { ok: false, error: "invalid key" };
      if (list.includes(key)) return { ok: true, version: store.version }; // dedupe, no bump
      const cap = op.scope === "lead" ? MAX_HELD_LEADS : MAX_HELD_COMPANIES;
      if (list.length >= cap) return { ok: false, error: "hold set is full" };
      list.push(key);
      bump(store, now);
      return { ok: true, version: store.version };
    }
    // unhold
    if (key === "") return { ok: false, error: "invalid key" };
    const idx = list.indexOf(key);
    if (idx === -1) return { ok: true, version: store.version }; // not held, no bump
    list.splice(idx, 1);
    bump(store, now);
    return { ok: true, version: store.version };
  }

  return { ok: false, error: "unknown op" };
}

// ---- Draft decisions: apply (wave 3 M2) ----------------------------------

export type DraftActionInput = {
  draftId: string;
  action: OutreachDraftActionKind;
  /** approve_edit only. */
  editedBody?: string | null;
  /** reject only (optional). not_a_reply carries no reason (ignored). */
  reason?: string | null;
};

export type DraftActionOutcome = { ok: true; version: number; id: number } | ApplyErr;

/** Count of decisions the pipeline has not folded yet (the [v4 §6] "pending"). */
export function pendingDraftActions(store: OutreachOverrides): OutreachDraftAction[] {
  return store.draftActions.filter((a) => a.status === "pending");
}

/**
 * Append ONE operator decision IN PLACE (called inside updateDB's mutator).
 *
 * - A newer decision for the same draftId SUPERSEDES the pending one, so the
 *   operator can change their mind before the pipeline folds it (mirrors the
 *   move supersede rule). The pipeline additionally resolves conflicts
 *   first-by-ts, so a decision racing a fold is a review item, never a send.
 * - approve_edit MUST carry a non-empty editedBody within the 20 KB cap; the
 *   others must not carry one at all. The body is the reply text WITHOUT
 *   the footer — the pipeline appends the canonical footer itself and REFUSES
 *   an edit that carries footer text.
 * - The 50-pending cap applies to APPROVALS only [v4 §6]: a reject is a STOP
 *   and is always accepted; not_a_reply (sends nothing) is likewise uncapped.
 * - not_a_reply carries no body and no reason; it supersedes a pending
 *   decision for the same draftId exactly like the other kinds.
 *
 * This function NEVER sends anything and never touches holds or moves.
 */
export function applyDraftAction(
  store: OutreachOverrides,
  input: DraftActionInput,
  opts: { now?: string; actor?: string } = {}
): DraftActionOutcome {
  const now = opts.now ?? new Date().toISOString();
  const draftId = typeof input.draftId === "string" ? input.draftId.trim() : "";
  if (draftId === "" || draftId.length > MAX_KEY_LEN) return { ok: false, error: "invalid draftId" };
  if (!DRAFT_ACTION_SET.has(input.action)) {
    return { ok: false, error: `invalid action "${String(input.action)}"` };
  }

  let editedBody: string | null = null;
  if (input.action === "approve_edit") {
    const body = typeof input.editedBody === "string" ? input.editedBody : "";
    if (body.trim() === "") return { ok: false, error: "approve_edit needs an edited body" };
    if (new TextEncoder().encode(body).length > MAX_EDITED_BODY_BYTES) {
      return { ok: false, error: "edited body too large (max 20 KB)" };
    }
    editedBody = body;
  } else if (typeof input.editedBody === "string" && input.editedBody.trim() !== "") {
    return { ok: false, error: `${input.action} must not carry an edited body` };
  }

  const reason =
    input.action === "reject" && typeof input.reason === "string" && input.reason.trim() !== ""
      ? input.reason.trim().slice(0, MAX_REJECT_REASON_CHARS)
      : null;

  // Supersede any pending decision for this draft; a newer intent wins.
  store.draftActions = store.draftActions.filter(
    (a) => !(a.status === "pending" && a.draftId === draftId)
  );
  if (!UNCAPPED_DRAFT_ACTIONS.has(input.action)) {
    const queued = store.draftActions.filter(
      (a) => a.status === "pending" && !UNCAPPED_DRAFT_ACTIONS.has(a.action)
    ).length;
    if (queued >= MAX_PENDING_DRAFT_APPROVALS) {
      return { ok: false, error: "too many approvals waiting for the pipeline" };
    }
  }

  store.draftActionSeq += 1;
  store.draftActions.push({
    id: store.draftActionSeq,
    draftId,
    action: input.action,
    editedBody,
    reason,
    actor: opts.actor ?? "",
    ts: now,
    status: "pending",
    foldedAt: null,
  });
  bump(store, now);
  return { ok: true, version: store.version, id: store.draftActionSeq };
}

// ---- Wire projection for the machine GET [R13] ---------------------------

export type OverridesWire = {
  ok: true;
  version: number;
  updatedAt: string;
  holds: { leads: string[]; companies: string[] };
  moves: { id: number; sendKey: string; toStage: string }[];
  /**
   * Wave 3 M2. The pipeline reads this off the RAW payload BEFORE its own
   * holds/moves projection and validates it PER ROW, fail-soft — keep the
   * field names and the "editedBody only on approve_edit" rule in lockstep
   * with pipeline/overrides.py validate_draft_actions.
   */
  draftActions: {
    id: number;
    draftId: string;
    action: OutreachDraftActionKind;
    editedBody: string | null;
    reason: string | null;
    actor: string;
    ts: string;
  }[];
};

/** Pending-only projection the pipeline consumes each cycle. */
export function toWire(store: OutreachOverrides): OverridesWire {
  return {
    ok: true,
    version: store.version,
    updatedAt: store.updatedAt,
    holds: { leads: [...store.holds.leads], companies: [...store.holds.companies] },
    moves: store.moves
      .filter((m) => m.status === "pending")
      .map((m) => ({ id: m.id, sendKey: m.sendKey, toStage: m.toStage })),
    draftActions: pendingDraftActions(store).map((a) => ({
      id: a.id,
      draftId: a.draftId,
      action: a.action,
      editedBody: a.action === "approve_edit" ? a.editedBody : null,
      reason: a.reason,
      actor: a.actor,
      ts: a.ts,
    })),
  };
}

// ---- Ack (pipeline writes back applied / rejected move ids) [R8] ----------

export type AckInput = { applied?: number[]; rejected?: { id: number; reason?: string | null }[] };
export type AckOutcome = { ok: true; version: number; applied: number[]; rejected: number[] };

/**
 * Mark pending moves applied / rejected. Idempotent: unknown, superseded, and
 * already-terminal ids are no-ops. Bumps version iff something flipped, and
 * prunes terminal moves beyond KEEP_TERMINAL_MOVES (newest kept).
 */
export function ackMoves(store: OutreachOverrides, input: AckInput, now: string = new Date().toISOString()): AckOutcome {
  const appliedIds = new Set((input.applied ?? []).filter((n) => typeof n === "number"));
  const rejectedMap = new Map<number, string | null>();
  for (const r of input.rejected ?? []) {
    if (r && typeof r.id === "number") rejectedMap.set(r.id, typeof r.reason === "string" ? r.reason : null);
  }
  const flippedApplied: number[] = [];
  const flippedRejected: number[] = [];
  for (const m of store.moves) {
    if (m.status !== "pending") continue; // idempotent: never re-flip a terminal move
    if (appliedIds.has(m.id)) {
      m.status = "applied";
      m.appliedAt = now;
      flippedApplied.push(m.id);
    } else if (rejectedMap.has(m.id)) {
      m.status = "rejected";
      m.rejectedReason = rejectedMap.get(m.id) ?? null;
      flippedRejected.push(m.id);
    }
  }
  if (flippedApplied.length > 0 || flippedRejected.length > 0) {
    // Prune the oldest terminal moves past the retention cap (keep newest by id).
    const terminal = store.moves.filter((m) => m.status !== "pending").sort((a, b) => a.id - b.id);
    if (terminal.length > KEEP_TERMINAL_MOVES) {
      const drop = new Set(terminal.slice(0, terminal.length - KEEP_TERMINAL_MOVES).map((m) => m.id));
      store.moves = store.moves.filter((m) => !(m.status !== "pending" && drop.has(m.id)));
    }
    bump(store, now);
  }
  return { ok: true, version: store.version, applied: flippedApplied, rejected: flippedRejected };
}

/**
 * Mark decisions the pipeline has folded (wave 3 M2). Idempotent: unknown,
 * superseded and already-folded ids are no-ops. Bumps version iff something
 * flipped, and prunes folded rows past KEEP_FOLDED_DRAFT_ACTIONS (newest kept).
 * A LOST ack is harmless — the pipeline keeps its own applied-id ledger, so a
 * re-served decision folds as a no-op there.
 */
export function ackDraftActions(
  store: OutreachOverrides,
  ids: number[],
  now: string = new Date().toISOString()
): { ok: true; version: number; folded: number[] } {
  const wanted = new Set((ids ?? []).filter((n) => typeof n === "number"));
  const folded: number[] = [];
  for (const a of store.draftActions) {
    if (a.status !== "pending" || !wanted.has(a.id)) continue;
    a.status = "folded";
    a.foldedAt = now;
    folded.push(a.id);
  }
  if (folded.length > 0) {
    const done = store.draftActions.filter((a) => a.status === "folded").sort((x, y) => x.id - y.id);
    if (done.length > KEEP_FOLDED_DRAFT_ACTIONS) {
      const drop = new Set(done.slice(0, done.length - KEEP_FOLDED_DRAFT_ACTIONS).map((a) => a.id));
      store.draftActions = store.draftActions.filter(
        (a) => !(a.status === "folded" && drop.has(a.id))
      );
    }
    bump(store, now);
  }
  return { ok: true, version: store.version, folded };
}

/** The pending decision for a draft, if the operator already made one. */
export function pendingDecisionFor(
  store: OutreachOverrides,
  draftId: string | null | undefined
): OutreachDraftAction | null {
  if (typeof draftId !== "string" || draftId === "") return null;
  for (const a of store.draftActions) {
    if (a.status === "pending" && a.draftId === draftId) return a;
  }
  return null;
}

// ---- Display helpers (badge + UX; read the APP store, NOT the board echo) --
// [R10] The Held badge is derived SOLELY from these — never from the board's
// echoed manual_hold (which lags one cycle).

export function isLeadHeldByKey(store: OutreachOverrides, sendKey: string | null | undefined): boolean {
  return typeof sendKey === "string" && sendKey !== "" && store.holds.leads.includes(sendKey);
}

export function isCompanyHeld(store: OutreachOverrides, company: string | null | undefined): boolean {
  const k = normalizeCompanyKey(company);
  return k !== "" && store.holds.companies.includes(k);
}

export type HoldDisposition = {
  held: boolean;
  heldByLead: boolean;
  heldByCompany: boolean;
};

/**
 * hold = (lead OR company). [R11] The UI uses this to decide which Unhold
 * control to enable: un-holding a single lead of a company-held company is a
 * no-op, so the per-lead Unhold is disabled ("Held by company") and an
 * "Unhold company" is offered instead; symmetric for the reverse.
 */
export function holdDisposition(
  store: OutreachOverrides,
  lead: { sendKey?: string | null; company?: string | null }
): HoldDisposition {
  const heldByLead = isLeadHeldByKey(store, lead.sendKey ?? null);
  const heldByCompany = isCompanyHeld(store, lead.company ?? null);
  return { held: heldByLead || heldByCompany, heldByLead, heldByCompany };
}

/** [R9] Count how many of `leads` a hold on `company` would (or does) cover. */
export function companyHoldCount(
  leads: { company?: string | null }[],
  company: string | null | undefined
): number {
  const k = normalizeCompanyKey(company);
  if (k === "") return 0;
  return leads.reduce((acc, l) => (normalizeCompanyKey(l.company ?? null) === k ? acc + 1 : acc), 0);
}

/** Most-recent move (any status) for a sendKey — MoveSelect surfaces a rejected
 *  move's reason [R8]. Returns null when the lead has no move history. */
export function latestMoveFor(store: OutreachOverrides, sendKey: string | null | undefined): OutreachMove | null {
  if (typeof sendKey !== "string" || sendKey === "") return null;
  let best: OutreachMove | null = null;
  for (const m of store.moves) {
    if (m.sendKey === sendKey && (best === null || m.id > best.id)) best = m;
  }
  return best;
}
