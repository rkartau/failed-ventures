// lib/outreach-snapshot.ts — outreach-campaign board.json snapshot store.
//
// The admin outreach dashboard is a READ-ONLY viewer over a board.json file
// produced by an external pipeline tool and uploaded by the operator. ALL
// logic lives here (validation, coercion, storage, derived views) so it is
// unit-testable without the auth-gated route/page. This module is PURE (no
// fs/node imports) so the client upload island can import MAX_UPLOAD_BYTES
// without dragging node builtins into the client bundle — the fs-touching
// read/write shell lives in lib/outreach-snapshot-store.ts. Validation is
// deliberately lenient at the lead level (coerce + warn, never reject a whole
// upload for one bad row) and strict only on the envelope (root shape,
// generated_at, leads array, size).

// ---- Constants ---------------------------------------------------------

// Increment 6: 10 MB (was 2 MB) — full-letter timelines are bulky (253 leads ×
// ~8 events × ~2 KB ≈ 4 MB). The upload route enforces this cap on the
// DECOMPRESSED size when the body arrives gzipped (gzip-bomb safe).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_LEADS = 5000;
export const MAX_RENDER_ROWS = 1000;
export const MAX_STORED_WARNINGS = 50;
// Per-mailbox send-count panel: the pipeline may publish a `mailboxes` array on
// the campaign block (one row per sending address). Bounded like the other
// arrays; render-only-when-present, degrade to nothing when absent.
export const MAX_MAILBOXES = 20;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
// Increment 6 (schema v3): per-lead events[] guardrails.
export const MAX_EVENT_BODY_BYTES = 20 * 1024;
export const MAX_EVENTS_PER_LEAD = 500;
export const EVENT_KINDS = ["sent", "reply", "draft", "state-change"] as const;

// Reply desk wave 3, M1 (schema v4): the pipeline publishes its operator
// runsheet as structured rows so this dashboard can render a "Waiting for you"
// queue. Same guardrails as events — strict field allowlist, 20 KB body cap on
// a codepoint boundary, bounded row count, bodies stored as DATA and escaped
// only at render time.
export const MAX_RUNSHEET_ITEMS = 500;
export const RUNSHEET_KINDS = [
  "halt",
  "fetch_degraded",
  "publish_stale",
  "lead_source_stale",
  "next_action",
  "unmatched_inbound",
  "review",
  "draft_failed",
  "draft_discarded",
  "draft_pending",
  // Auto-ack handling (2026-09-08): the pipeline stopped a sequence on an
  // inbound it could not confidently call human or machine, and asks the
  // operator to look. Carries the operator note + the inbound excerpt and a
  // draftId (the ledger row the two card buttons act on via draft actions).
  "needs_human",
] as const;
/** Rows the operator can ACT on in the UI (the queue's draft detail view /
 *  the needs-human card). */
export const ACTIONABLE_RUNSHEET_KINDS = ["draft_pending", "needs_human"] as const;
/** Display order inside the queue: the things that block sending first. */
const RUNSHEET_RANK: Record<string, number> = {
  halt: 0,
  fetch_degraded: 1,
  draft_pending: 2,
  needs_human: 2,
  review: 3,
  unmatched_inbound: 4,
  draft_failed: 5,
  draft_discarded: 6,
  publish_stale: 7,
  lead_source_stale: 8,
  next_action: 9,
};
const RUNSHEET_DEFAULT_RANK = 10;

export const PIPELINE_STAGES = [
  "queued",
  "email1",
  "followup",
  "breakup",
  "replied",
  "conversation",
  "trial_won",
] as const;
export const TERMINAL_STAGES = ["suppressed", "closed"] as const;
/** Increment 6: stages added by the pipeline's real-world-flow state machine
 * (plan I1). Recognised so a v3 board renders them as themselves instead of
 * coercing every such lead to "unknown"; the funnel strip shows them beside
 * the terminal cluster only when non-zero. */
export const EXTENDED_STAGES = [
  "snoozed",
  "paused_ooo",
  "referred",
  "signed_up",
  "re_engage",
  "closed_lost",
  "undeliverable",
] as const;
export const KNOWN_SENTIMENTS = ["positive", "neutral", "negative", "hostile", "none"] as const;
export const KNOWN_ANGLES = ["A", "B", "C", "D"] as const;

// ---- Types -------------------------------------------------------------

/**
 * One merged-timeline row (schema v3, Increment 6 — Director decision 1).
 * STRICT field allowlist: only these keys survive normalization; anything else
 * on the wire row is dropped. `bodyFull` is stored as DATA (capped at
 * MAX_EVENT_BODY_BYTES, truncated on a whole-codepoint boundary) and rendered
 * exclusively through React text escaping (escaped <pre>) — never as markup.
 */
export type OutreachLeadEvent = {
  kind: (typeof EVENT_KINDS)[number];
  ts: string | null;
  actor: string | null;
  templateId: string | null;
  classification: string | null;
  arm: string | null;
  bodyFull: string | null;
  thread: string | null;
};

/**
 * One operator-queue row (schema v4, wave 3 M1). STRICT field allowlist: only
 * these keys survive normalization. `bodyFull` / `inboundBody` are stored as
 * DATA (20 KB cap, whole-codepoint truncation) and rendered exclusively through
 * React text escaping — never as markup. `footer` is the canonical, read-only
 * legal footer the pipeline will append itself; it is NEVER part of bodyFull
 * and is never editable here.
 */
export type OutreachRunsheetItem = {
  kind: (typeof RUNSHEET_KINDS)[number];
  sendKey: string | null;
  company: string | null;
  ts: string | null;
  label: string;
  /** draft_pending only — the pipeline draft-ledger id (the action key). */
  draftId: string | null;
  templateId: string | null;
  subject: string | null;
  inboundId: string | null;
  bodyFull: string | null;
  bodyTruncated: boolean;
  footer: string | null;
  thread: string | null;
  inboundBody: string | null;
  inboundBodyTruncated: boolean;
  inboundTs: string | null;
  /** The inbound sender's DOMAIN — the pipeline never publishes an address. */
  inboundFromDomain: string | null;
  inboundSubject: string | null;
  reviewKind: string | null;
  /** needs_human only — the pipeline's note to the operator (why it stopped).
   *  Same 20 KB cap + escape-on-render stance as the bodies. */
  note: string | null;
};

/** Per-arm A/B counters (schema v3 campaign block, Increment 5/6). */
export type ArmStats = {
  sends: number | null;
  replies: number | null;
  positiveReplies: number | null;
  bookings: number | null;
  signups: number | null;
};

/** Per-mailbox send counters (campaign block). One row per sending address the
 * pipeline publishes. Render-only-when-present; each figure degrades to null. */
export type MailboxStats = {
  address: string;
  flow: string | null;
  sendsToday: number | null;
  sendsTotal: number | null;
  cap: number | null;
};

export type OutreachLead = {
  /** Display-only pipeline key — NEVER rendered as a link anywhere. */
  sendKey: string;
  company: string;
  country: string;
  angle: string;
  stage: string;
  sentiment: string;
  lastEvent: string;
  lastEventAt: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  /**
   * feat/manual-hold — the board's echo of the pipeline's applied manual_hold.
   * [R10] INFORMATIONAL ONLY: this lags one cycle and is NOT the badge's source
   * of truth. The Held badge is derived from the APP override store
   * (lib/outreach-overrides.ts), never from this field.
   */
  manualHold?: boolean;
  /** Engagement counters folded by the pipeline (Plan D3). OPTIONAL — absent in
   * older board.json; null when missing or not a non-negative number. */
  opens: number | null;
  bounced: number | null;
  booked: number | null;
  /** schema v3 merged timeline (Increment 6). Attached ONLY when the source
   * carried an events array, so a v2 lead re-reads byte-identical. */
  events?: OutreachLeadEvent[];
};

export type OutreachCampaign = {
  sendsToday: number | null;
  dailyCap: number | null;
  /** RAW total-bounce rate (hard bounces / sends). Kept for completeness, but it
   * is NOT the number that drives the halt — dead-address bounces dominate it.
   * The headline stat now prefers haltRatePct (below) when present. */
  bounceRatePct: number | null;
  /**
   * Smart bounce-halt breakdown (pipeline commit 8b304f1 / smart bounce-halt).
   * All OPTIONAL — null when the board.json predates the breakdown fields.
   *  - haltRatePct: the reputation+unknown rate over the deliverable base — the
   *    primary figure check_halt actually decides on (~0.3%, not the raw total).
   *  - haltThresholdPct: the halt trip threshold for haltRatePct (default 2).
   *  - deadAddressRatePct: dead-address bounces / sends (the benign majority).
   *  - undeliverableRatePct: total undeliverable rate over the base.
   */
  haltRatePct: number | null;
  haltThresholdPct: number | null;
  deadAddressRatePct: number | null;
  undeliverableRatePct: number | null;
  halted: boolean;
  /** schema v3 per-arm A/B stats (render only when present). Attached ONLY
   * when the source carried an arms object. */
  arms?: { signup: ArmStats; demo: ArmStats };
  /** Per-mailbox send counts (render only when present). Attached ONLY when the
   * source carried a `mailboxes` array — a board without it re-reads identical. */
  mailboxes?: MailboxStats[];
};

export type OutreachSnapshot = {
  generatedAt: string;
  uploadedAt: string;
  campaign: OutreachCampaign;
  leads: OutreachLead[];
  /** schema v4 operator queue. Attached ONLY when the source carried it, so a
   *  v2/v3 snapshot re-reads byte-identical (same no-phantom-key rule as
   *  lead.events / campaign.arms). */
  runsheet?: OutreachRunsheetItem[];
  warnings: string[];
};

// ---- Small helpers -----------------------------------------------------

/** Remove a leading UTF-8 BOM (PowerShell writes BOM-ed files). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function assertUploadSize(
  text: string,
  maxBytes: number = MAX_UPLOAD_BYTES
): { ok: true } | { ok: false; error: string } {
  // TextEncoder (not Buffer) — byte-accurate UTF-8 length that is equally at
  // home in the client island's bundle and in Node. `maxBytes` lets the docs
  // route keep its own (2 MB) cap while the board upload moved to 10 MB —
  // the sibling stays behaviourally untouched.
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, error: `File too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)` };
  }
  return { ok: true };
}

/** Truncate to at most `maxBytes` UTF-8 bytes on a WHOLE-CODEPOINT boundary
 * (never a surrogate-half / mid-multibyte cut) — same stance as the event
 * sink's encodeLine. Pure (TextEncoder, no Buffer). */
export function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  const cps = Array.from(s);
  let lo = 0;
  let hi = cps.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (enc.encode(cps.slice(0, mid).join("")).length <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return cps.slice(0, best).join("");
}

function parseableIso(v: unknown): string | null {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return null;
  return v;
}

const KNOWN_STAGES = new Set<string>([...PIPELINE_STAGES, ...TERMINAL_STAGES, ...EXTENDED_STAGES]);
const SENTIMENT_SET = new Set<string>(KNOWN_SENTIMENTS);
const ANGLE_SET = new Set<string>(KNOWN_ANGLES);
const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);

// ---- Per-lead events normalizer (schema v3, Increment 6) -------------------

/** One trimmed nullable-string field off a wire/stored event row. */
function evStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Normalize one lead's events array. STRICT allowlist — only the eight known
 * fields are copied; unknown kinds are skipped (+ warning); ts must parse as
 * ISO or degrades to null (+ warning); body_full over MAX_EVENT_BODY_BYTES is
 * truncated on a codepoint boundary (+ warning); at most MAX_EVENTS_PER_LEAD
 * rows survive (+ warning). Accepts BOTH wire keys (template_id/body_full)
 * and stored camelCase (templateId/bodyFull) — the stored-snapshot re-read is
 * the same code path as upload validation.
 */
function normalizeEvents(raw: unknown, i: number, warnings: string[]): OutreachLeadEvent[] | null {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      warnings.push(`leads[${i}] events not an array — dropped`);
    }
    return null;
  }
  let rows = raw;
  if (rows.length > MAX_EVENTS_PER_LEAD) {
    warnings.push(
      `leads[${i}] ${rows.length} events — keeping the last ${MAX_EVENTS_PER_LEAD}`
    );
    rows = rows.slice(rows.length - MAX_EVENTS_PER_LEAD);
  }
  const out: OutreachLeadEvent[] = [];
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j];
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      warnings.push(`leads[${i}].events[${j}] not an object — skipped`);
      continue;
    }
    const o = r as Record<string, unknown>;
    const pick = (wire: string, stored: string): unknown =>
      o[wire] !== undefined ? o[wire] : o[stored];

    const kind = String(o["kind"] ?? "");
    if (!EVENT_KIND_SET.has(kind)) {
      warnings.push(`leads[${i}].events[${j}] unknown kind "${kind}" — skipped`);
      continue;
    }

    const tsRaw = o["ts"];
    const ts = parseableIso(tsRaw);
    if (ts === null && tsRaw !== undefined && tsRaw !== null) {
      warnings.push(`leads[${i}].events[${j}] ts unparseable — dropped`);
    }

    let bodyFull = evStr(pick("body_full", "bodyFull"));
    if (bodyFull !== null && new TextEncoder().encode(bodyFull).length > MAX_EVENT_BODY_BYTES) {
      warnings.push(`leads[${i}].events[${j}] body_full over 20 KB — truncated`);
      bodyFull = truncateUtf8(bodyFull, MAX_EVENT_BODY_BYTES);
    }

    out.push({
      kind: kind as OutreachLeadEvent["kind"],
      ts,
      actor: evStr(o["actor"]),
      templateId: evStr(pick("template_id", "templateId")),
      classification: evStr(o["classification"]),
      arm: evStr(o["arm"]),
      bodyFull,
      thread: evStr(o["thread"]),
    });
  }
  return out;
}

// ---- Operator-queue normalizer (schema v4, wave 3 M1) ---------------------

const RUNSHEET_KIND_SET = new Set<string>(RUNSHEET_KINDS);

/**
 * Normalize the top-level `runsheet` array. STRICT allowlist — only the known
 * fields are copied; an unknown kind is skipped (+ warning); a row without a
 * usable label is skipped; bodies over MAX_EVENT_BODY_BYTES are truncated on a
 * codepoint boundary (+ warning); at most MAX_RUNSHEET_ITEMS rows survive.
 * Accepts BOTH wire keys (send_key/body_full) and stored camelCase, so the
 * stored-snapshot re-read is the same code path as upload validation.
 * Returns null when the source carried no runsheet at all (no phantom key).
 */
function normalizeRunsheet(raw: unknown, warnings: string[]): OutreachRunsheetItem[] | null {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push("runsheet not an array — dropped");
    return null;
  }
  let rows = raw;
  if (rows.length > MAX_RUNSHEET_ITEMS) {
    warnings.push(`runsheet ${rows.length} rows — keeping the first ${MAX_RUNSHEET_ITEMS}`);
    rows = rows.slice(0, MAX_RUNSHEET_ITEMS);
  }
  const out: OutreachRunsheetItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      warnings.push(`runsheet[${i}] not an object — skipped`);
      continue;
    }
    const o = r as Record<string, unknown>;
    const pick = (wire: string, stored: string): unknown =>
      o[wire] !== undefined ? o[wire] : o[stored];

    const kind = String(o["kind"] ?? "");
    if (!RUNSHEET_KIND_SET.has(kind)) {
      warnings.push(`runsheet[${i}] unknown kind "${kind}" — skipped`);
      continue;
    }
    const label = typeof o["label"] === "string" ? o["label"] : "";
    if (label.trim() === "") {
      warnings.push(`runsheet[${i}] has no label — skipped`);
      continue;
    }
    const cappedBody = (v: unknown, field: string): string | null => {
      let s = evStr(v);
      if (s !== null && new TextEncoder().encode(s).length > MAX_EVENT_BODY_BYTES) {
        warnings.push(`runsheet[${i}] ${field} over 20 KB — truncated`);
        s = truncateUtf8(s, MAX_EVENT_BODY_BYTES);
      }
      return s;
    };

    out.push({
      kind: kind as OutreachRunsheetItem["kind"],
      sendKey: evStr(pick("send_key", "sendKey")),
      company: evStr(o["company"]),
      ts: parseableIso(o["ts"]),
      label,
      draftId: evStr(pick("draft_id", "draftId")),
      templateId: evStr(pick("template_id", "templateId")),
      subject: evStr(o["subject"]),
      inboundId: evStr(pick("inbound_id", "inboundId")),
      bodyFull: cappedBody(pick("body_full", "bodyFull"), "body_full"),
      bodyTruncated: pick("body_truncated", "bodyTruncated") === true,
      footer: evStr(o["footer"]),
      thread: evStr(o["thread"]),
      inboundBody: cappedBody(pick("inbound_body", "inboundBody"), "inbound_body"),
      inboundBodyTruncated: pick("inbound_body_truncated", "inboundBodyTruncated") === true,
      inboundTs: parseableIso(pick("inbound_ts", "inboundTs")),
      inboundFromDomain: evStr(pick("inbound_from_domain", "inboundFromDomain")),
      inboundSubject: evStr(pick("inbound_subject", "inboundSubject")),
      reviewKind: evStr(pick("review_kind", "reviewKind")),
      note: cappedBody(o["note"], "note"),
    });
  }
  return out;
}

/**
 * The queue's display order: blocking conditions first, then the drafts waiting
 * for a decision, then everything else — newest-first inside each band. PURE.
 */
export function queueOrder(rows: OutreachRunsheetItem[]): OutreachRunsheetItem[] {
  return [...rows].sort((a, b) => {
    const ra = RUNSHEET_RANK[a.kind] ?? RUNSHEET_DEFAULT_RANK;
    const rb = RUNSHEET_RANK[b.kind] ?? RUNSHEET_DEFAULT_RANK;
    if (ra !== rb) return ra - rb;
    return (b.ts ?? "").localeCompare(a.ts ?? "");
  });
}

/** The rows the operator must personally decide on (drafts awaiting approval). */
export function pendingDrafts(rows: OutreachRunsheetItem[] | undefined): OutreachRunsheetItem[] {
  return (rows ?? []).filter((r) => r.kind === "draft_pending" && r.draftId !== null);
}
// ---- Per-lead normalizer (shared by validateBoard + readOutreachSnapshot) --

/**
 * Coerce one raw lead into an OutreachLead, pushing human-readable warnings.
 * Returns null (skip) only when the lead is not an object at all — every
 * field-level problem degrades to a placeholder value + warning instead.
 * Accepts BOTH wire-format keys (send_key/last_event/...) and stored
 * camelCase keys (sendKey/lastEvent/...) so re-normalizing a stored snapshot
 * is the same code path as validating an upload.
 */
function normalizeLead(raw: unknown, i: number, warnings: string[]): OutreachLead | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`leads[${i}] not an object — skipped`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const pick = (wire: string, stored: string): unknown =>
    o[wire] !== undefined ? o[wire] : o[stored];

  const companyRaw = o["company"];
  let company = companyRaw === null || companyRaw === undefined ? "" : String(companyRaw).trim();
  if (company === "") {
    company = "—";
    warnings.push(`leads[${i}] company missing — shown as "—"`);
  }

  const countryRaw = o["country"];
  const country = typeof countryRaw === "string" && countryRaw.trim() !== "" ? countryRaw.trim() : "—";

  const lastEventRaw = pick("last_event", "lastEvent");
  const lastEvent = typeof lastEventRaw === "string" ? lastEventRaw : "";

  // "unknown" is the coercion sentinel — a stored, already-coerced lead must
  // re-read silently (no duplicate warning on every page render).
  let stage = String(o["stage"] ?? "");
  if (stage !== "unknown" && !KNOWN_STAGES.has(stage)) {
    warnings.push(`leads[${i}] unknown stage "${stage}" — counted as unknown`);
    stage = "unknown";
  }

  const sentimentRaw = o["sentiment"];
  let sentiment = "none";
  if (typeof sentimentRaw === "string" && SENTIMENT_SET.has(sentimentRaw)) {
    sentiment = sentimentRaw;
  } else if (sentimentRaw !== undefined && sentimentRaw !== null && sentimentRaw !== "") {
    warnings.push(`leads[${i}] unknown sentiment "${String(sentimentRaw)}" — treated as none`);
  }

  // "?" is the angle coercion sentinel — same silent re-read rule as stage.
  const angleRaw = o["angle"];
  let angle = "?";
  if (typeof angleRaw === "string" && (ANGLE_SET.has(angleRaw) || angleRaw === "?")) {
    angle = angleRaw;
  } else if (angleRaw !== undefined && angleRaw !== null) {
    warnings.push(`leads[${i}] angle "${String(angleRaw)}" outside A–D — shown as "?"`);
  }

  const lastEventAtRaw = pick("last_event_at", "lastEventAt");
  const lastEventAt = parseableIso(lastEventAtRaw);
  if (lastEventAt === null && lastEventAtRaw !== undefined && lastEventAtRaw !== null) {
    warnings.push(`leads[${i}] last_event_at unparseable — dropped`);
  }

  const nextActionRaw = pick("next_action", "nextAction");
  const nextAction =
    typeof nextActionRaw === "string" && nextActionRaw.trim() !== "" ? nextActionRaw : null;

  const nextActionDueRaw = pick("next_action_due", "nextActionDue");
  const nextActionDue = parseableIso(nextActionDueRaw);
  if (nextActionDue === null && nextActionDueRaw !== undefined && nextActionDueRaw !== null) {
    warnings.push(`leads[${i}] next_action_due unparseable — dropped`);
  }

  const sendKeyRaw = pick("send_key", "sendKey");
  const sendKey = typeof sendKeyRaw === "string" ? sendKeyRaw : "";

  // Engagement counters (Plan D3) — lenient coerce+warn, matching the campaign
  // numeric contract: absent/null → null (no warning); a present non-number or
  // negative → null + one warning.
  const numCounter = (wire: string, stored: string): number | null => {
    const v = pick(wire, stored);
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`leads[${i}] ${wire} not a non-negative number — ignored`);
      return null;
    }
    return n;
  };
  const opens = numCounter("opens", "opens");
  const bounced = numCounter("bounced", "bounced");
  const booked = numCounter("booked", "booked");

  const lead: OutreachLead = {
    sendKey,
    company,
    country,
    angle,
    stage,
    sentiment,
    lastEvent,
    lastEventAt,
    nextAction,
    nextActionDue,
    opens,
    bounced,
    booked,
  };

  // [R10] Coerce the board's echoed manual_hold (wire key) / manualHold (stored)
  // to a strict boolean. Informational only. The key is attached ONLY when the
  // source carried it, so a legacy lead re-reads byte-identical (no phantom key).
  const manualHoldRaw = pick("manual_hold", "manualHold");
  if (manualHoldRaw !== undefined) lead.manualHold = manualHoldRaw === true;

  // schema v3 (Increment 6): per-lead merged timeline. Attached ONLY when the
  // source carried it (same no-phantom-key rule as manualHold — v2 leads
  // re-read byte-identical, no flag-day).
  const events = normalizeEvents(o["events"], i, warnings);
  if (events !== null) lead.events = events;

  return lead;
}

/** Cap stored warnings; append one honest "+ N more warnings" tail line. */
function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_STORED_WARNINGS) return warnings;
  const extra = warnings.length - MAX_STORED_WARNINGS;
  return [...warnings.slice(0, MAX_STORED_WARNINGS), `+ ${extra} more warnings`];
}

/**
 * Normalize the campaign's `mailboxes` array (per-sending-address send counts).
 * Returns null when the source carried no mailboxes at all (no phantom key), so
 * a board without it re-reads byte-identical. Caps at MAX_MAILBOXES. Each entry
 * requires a non-empty string `address` (else skipped + warning); `flow` coerces
 * to string|null; the numeric counters use the SAME lenient coercion as the
 * arms/campaign figures (absent/null → null; a present non-number or negative →
 * null + warning). Accepts BOTH wire snake_case and stored camelCase keys so the
 * stored-snapshot re-read is the same code path as upload validation.
 */
function normalizeMailboxes(raw: unknown, warnings: string[]): MailboxStats[] | null {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push("campaign.mailboxes not an array — ignored");
    return null;
  }
  let rows = raw;
  if (rows.length > MAX_MAILBOXES) {
    warnings.push(`campaign.mailboxes ${rows.length} rows — keeping the first ${MAX_MAILBOXES}`);
    rows = rows.slice(0, MAX_MAILBOXES);
  }
  const out: MailboxStats[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      warnings.push(`campaign.mailboxes[${i}] not an object — skipped`);
      continue;
    }
    const o = r as Record<string, unknown>;
    const pick = (wire: string, stored: string): unknown =>
      o[wire] !== undefined ? o[wire] : o[stored];

    const addressRaw = o["address"];
    const address = typeof addressRaw === "string" ? addressRaw.trim() : "";
    if (address === "") {
      warnings.push(`campaign.mailboxes[${i}] has no address — skipped`);
      continue;
    }
    const flowRaw = o["flow"];
    const flow = typeof flowRaw === "string" && flowRaw.trim() !== "" ? flowRaw : null;
    const num = (wire: string, stored: string): number | null => {
      const v = pick(wire, stored);
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        warnings.push(`campaign.mailboxes[${i}] ${wire} not a non-negative number — ignored`);
        return null;
      }
      return n;
    };
    out.push({
      address,
      flow,
      sendsToday: num("sends_today", "sendsToday"),
      sendsTotal: num("sends_total", "sendsTotal"),
      cap: num("cap", "cap"),
    });
  }
  return out;
}

/** Coerce a raw campaign object (or anything else) into OutreachCampaign. */
function normalizeCampaign(raw: unknown, warnings: string[]): OutreachCampaign {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      warnings.push("campaign is not an object — all campaign figures unknown");
    } else {
      warnings.push("campaign missing — all campaign figures unknown");
    }
    return {
      sendsToday: null,
      dailyCap: null,
      bounceRatePct: null,
      haltRatePct: null,
      haltThresholdPct: null,
      deadAddressRatePct: null,
      undeliverableRatePct: null,
      halted: false,
    };
  }
  const o = raw as Record<string, unknown>;
  const num = (wire: string, stored: string): number | null => {
    const v = o[wire] !== undefined ? o[wire] : o[stored];
    if (v === undefined || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`campaign.${wire} not a non-negative number — ignored`);
      return null;
    }
    return n;
  };
  const sendsToday = num("sends_today", "sendsToday");
  const dailyCap = num("daily_cap", "dailyCap");
  const bounceRatePct = num("bounce_rate_pct", "bounceRatePct");
  // Smart bounce-halt breakdown (OPTIONAL — null when the board predates them).
  const haltRatePct = num("halt_rate_pct", "haltRatePct");
  const haltThresholdPct = num("halt_threshold_pct", "haltThresholdPct");
  const deadAddressRatePct = num("dead_address_rate_pct", "deadAddressRatePct");
  const undeliverableRatePct = num("undeliverable_rate_pct", "undeliverableRatePct");
  const haltedRaw = o["halted"];
  let halted = false;
  if (haltedRaw === true) halted = true;
  else if (haltedRaw !== undefined && haltedRaw !== null && typeof haltedRaw !== "boolean") {
    warnings.push("campaign.halted not a boolean — treated as false");
  }
  const campaign: OutreachCampaign = {
    sendsToday,
    dailyCap,
    bounceRatePct,
    haltRatePct,
    haltThresholdPct,
    deadAddressRatePct,
    undeliverableRatePct,
    halted,
  };

  // schema v3 (Increment 5/6): per-arm A/B stats. Attached ONLY when the source
  // carried an arms object (render-only-when-present); each counter uses the
  // same lenient numeric coercion as the campaign figures.
  const armsRaw = o["arms"];
  if (armsRaw !== undefined && armsRaw !== null) {
    if (typeof armsRaw !== "object" || Array.isArray(armsRaw)) {
      warnings.push("campaign.arms not an object — ignored");
    } else {
      const armOf = (name: "signup" | "demo"): ArmStats => {
        const a = (armsRaw as Record<string, unknown>)[name];
        const src =
          a !== null && typeof a === "object" && !Array.isArray(a)
            ? (a as Record<string, unknown>)
            : {};
        if (src !== a && a !== undefined && a !== null) {
          warnings.push(`campaign.arms.${name} not an object — all its figures unknown`);
        }
        const n = (wire: string, stored: string): number | null => {
          const v = src[wire] !== undefined ? src[wire] : src[stored];
          if (v === undefined || v === null) return null;
          const parsed = Number(v);
          if (!Number.isFinite(parsed) || parsed < 0) {
            warnings.push(`campaign.arms.${name}.${wire} not a non-negative number — ignored`);
            return null;
          }
          return parsed;
        };
        return {
          sends: n("sends", "sends"),
          replies: n("replies", "replies"),
          positiveReplies: n("positive_replies", "positiveReplies"),
          bookings: n("bookings", "bookings"),
          signups: n("signups", "signups"),
        };
      };
      campaign.arms = { signup: armOf("signup"), demo: armOf("demo") };
    }
  }

  // Per-mailbox send counts — attached ONLY when the source carried a mailboxes
  // array (render-only-when-present, same no-phantom-key rule as arms).
  const mailboxes = normalizeMailboxes(o["mailboxes"], warnings);
  if (mailboxes !== null) campaign.mailboxes = mailboxes;
  return campaign;
}

// ---- Upload validation -------------------------------------------------

export function validateBoard(
  raw: unknown
): { ok: true; snapshot: Omit<OutreachSnapshot, "uploadedAt"> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Not a board.json object" };
  }
  const o = raw as Record<string, unknown>;

  // schema_version gate: absent / 1 / 2 = the legacy shape (events ignored by
  // old boards anyway); 3 adds per-lead events[] + campaign arms; 4 (wave 3
  // M1) adds the top-level `runsheet` operator queue. Anything ELSE is a future
  // format this validator does not understand — reject the envelope rather
  // than silently mangling it.
  const sv = o["schema_version"];
  if (sv !== undefined && sv !== null && sv !== 1 && sv !== 2 && sv !== 3 && sv !== 4) {
    return { ok: false, error: `Unsupported schema_version ${String(sv)} (accepted: 2, 3, 4)` };
  }

  const generatedAt = parseableIso(o["generated_at"]);
  if (generatedAt === null) {
    return { ok: false, error: "Missing or invalid generated_at" };
  }

  const leadsRaw = o["leads"];
  if (!Array.isArray(leadsRaw)) {
    return { ok: false, error: "leads is not an array" };
  }
  if (leadsRaw.length > MAX_LEADS) {
    return { ok: false, error: `Too many leads (${leadsRaw.length} > ${MAX_LEADS})` };
  }

  const warnings: string[] = [];
  const campaign = normalizeCampaign(o["campaign"], warnings);
  // The plan treats a MISSING campaign as a warning; keep the warning only in
  // that degraded case (normalizeCampaign already pushed it).

  const leads: OutreachLead[] = [];
  for (let i = 0; i < leadsRaw.length; i++) {
    const lead = normalizeLead(leadsRaw[i], i, warnings);
    if (lead) leads.push(lead);
  }

  const snapshot: Omit<OutreachSnapshot, "uploadedAt"> = {
    generatedAt,
    campaign,
    leads,
    warnings: capWarnings(warnings),
  };
  // schema v4 operator queue — attached ONLY when the source carried it.
  const runsheet = normalizeRunsheet(o["runsheet"], warnings);
  if (runsheet !== null) snapshot.runsheet = runsheet;
  snapshot.warnings = capWarnings(warnings);

  return { ok: true, snapshot };
}

// ---- Stored-snapshot re-validation -------------------------------------

/**
 * Re-validate a stored snapshot that was already JSON-parsed by the store
 * shell (lib/outreach-snapshot-store.ts). Envelope drift → corrupt; lead-level
 * garbage degrades through the SAME normalizer as uploads (skip + warning,
 * never a throw) — defense against hand-edits / schema drift.
 */
export function parseStoredSnapshot(
  parsed: unknown
): { status: "ok"; snapshot: OutreachSnapshot } | { status: "corrupt" } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "corrupt" };
  }
  const o = parsed as Record<string, unknown>;
  const generatedAt = parseableIso(o["generatedAt"]);
  if (generatedAt === null) return { status: "corrupt" };
  if (typeof o["uploadedAt"] !== "string") return { status: "corrupt" };
  if (!Array.isArray(o["leads"])) return { status: "corrupt" };
  if (o["campaign"] === null || typeof o["campaign"] !== "object" || Array.isArray(o["campaign"])) {
    return { status: "corrupt" };
  }

  // Defense against hand-edits / schema drift: RE-RUN the same normalizer over
  // stored leads and campaign — lead-level garbage degrades to skip+warning,
  // never a throw.
  const warnings: string[] = Array.isArray(o["warnings"])
    ? (o["warnings"] as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  const campaign = normalizeCampaign(o["campaign"], warnings);
  const leads: OutreachLead[] = [];
  const leadsRaw = o["leads"] as unknown[];
  for (let i = 0; i < leadsRaw.length; i++) {
    const lead = normalizeLead(leadsRaw[i], i, warnings);
    if (lead) leads.push(lead);
  }

  const snapshot: OutreachSnapshot = {
    generatedAt,
    uploadedAt: o["uploadedAt"] as string,
    campaign,
    leads,
    warnings: capWarnings(warnings),
  };
  const runsheet = normalizeRunsheet(o["runsheet"], warnings);
  if (runsheet !== null) snapshot.runsheet = runsheet;
  snapshot.warnings = capWarnings(warnings);

  return { status: "ok", snapshot };
}

// ---- Derived views -----------------------------------------------------

/** Per-stage counts, pre-seeded 0 for every known stage plus "unknown". */
export function stageCounts(leads: OutreachLead[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of PIPELINE_STAGES) counts.set(s, 0);
  for (const s of TERMINAL_STAGES) counts.set(s, 0);
  for (const s of EXTENDED_STAGES) counts.set(s, 0);
  counts.set("unknown", 0);
  for (const lead of leads) {
    counts.set(lead.stage, (counts.get(lead.stage) ?? 0) + 1);
  }
  return counts;
}

// Display rank: INVERTED from pipeline order so the highest-value rows survive
// the render cap; terminal + unknown stages sink to the bottom. Extended
// stages (Increment 6) slot by value: signed_up beside trial_won, re_engage
// after the active conversation band, timers below the cold sequence.
const DISPLAY_RANK: Record<string, number> = {
  trial_won: 0,
  signed_up: 1,
  conversation: 2,
  replied: 3,
  re_engage: 4,
  breakup: 5,
  followup: 6,
  email1: 7,
  queued: 8,
  snoozed: 9,
  paused_ooo: 10,
  referred: 11,
  closed_lost: 12,
  suppressed: 13,
  closed: 14,
  undeliverable: 15,
  unknown: 16,
};
const DEFAULT_RANK = DISPLAY_RANK.unknown;

export function visibleLeads(leads: OutreachLead[]): {
  rows: OutreachLead[];
  total: number;
  truncated: boolean;
} {
  const sorted = [...leads].sort((a, b) => {
    const ra = DISPLAY_RANK[a.stage] ?? DEFAULT_RANK;
    const rb = DISPLAY_RANK[b.stage] ?? DEFAULT_RANK;
    if (ra !== rb) return ra - rb;
    return a.company.localeCompare(b.company);
  });
  return {
    rows: sorted.slice(0, MAX_RENDER_ROWS),
    total: leads.length,
    truncated: leads.length > MAX_RENDER_ROWS,
  };
}

/** NaN never reaches here — the read path rejects an unparseable generatedAt. */
export function freshness(generatedAtIso: string, nowMs: number): "fresh" | "stale" | "future" {
  const parsed = Date.parse(generatedAtIso);
  if (parsed > nowMs + FUTURE_SKEW_MS) return "future";
  if (nowMs - parsed > STALE_AFTER_MS) return "stale";
  return "fresh";
}

export function isOverdue(dueIso: string | null, nowMs: number): boolean {
  if (dueIso === null) return false;
  const parsed = Date.parse(dueIso);
  return Number.isFinite(parsed) && parsed < nowMs;
}

export function repliedPlusCount(leads: OutreachLead[]): number {
  return leads.filter(
    (l) => l.stage === "replied" || l.stage === "conversation" || l.stage === "trial_won"
  ).length;
}

// ---- Booking-call overlay (book?lead= attribution) ---------------------

/** Uniform provenance: a matched lead was "reported via the outreach link" — light
 * attribution, NOT cryptographically verified (see plan OP-DECISION 1). */
export type BookingCallStatus = { booked: boolean };

/**
 * PURE join of live outreach bookings onto board leads by EXACT
 * `booking.leadKey === lead.sendKey` (no company logic, no fuzzy match). Keeps this
 * module free of DB/fs/clock: `bookings` are INJECTED by the caller (page.tsx),
 * already filtered to the live `status:"booked"` set; `leads` is the FULL pre-cap
 * snapshot array (matching runs over every lead, not the ≤1000-row display slice).
 *
 * Returns:
 *  - `byKey`: sendKey -> { booked } for EVERY lead, so the page can look up any
 *    rendered row via `byKey.get(lead.sendKey)`.
 *  - `kpiCount`: DISTINCT leads in the full snapshot whose sendKey matches a live
 *    booking leadKey. May EXCEED the number of visible emerald badges when the
 *    snapshot has >1000 leads (the table caps rendering) — expected, not double-counting.
 *  - `unmatchedCount`: DISTINCT live-booking leadKeys not present ANYWHERE in the full
 *    snapshot (lagging snapshot / unrecognised / guessed / possibly-forged keys). A
 *    genuinely matched lead beyond the display cap is counted in kpiCount, never here.
 *
 * Deterministic given its inputs. Only counts bookings whose status is exactly
 * "booked" is the CALLER's responsibility (already filtered); a defensive
 * status guard is applied here too so a stray non-"booked" row can never leak in.
 */
export function annotateBookingCall(
  leads: OutreachLead[],
  bookings: Array<{ leadKey?: string; status?: string }>
): { byKey: Map<string, BookingCallStatus>; kpiCount: number; unmatchedCount: number } {
  // (1) non-empty leadKeys among live bookings (defensive status guard: only "booked").
  const bookingLeadKeys = new Set<string>();
  for (const b of bookings) {
    if (b.status !== undefined && b.status !== "booked") continue;
    const key = typeof b.leadKey === "string" ? b.leadKey : "";
    if (key !== "") bookingLeadKeys.add(key);
  }

  // (2) all non-empty sendKeys across the FULL snapshot (distinct).
  const snapshotSendKeys = new Set<string>();
  for (const lead of leads) {
    if (typeof lead.sendKey === "string" && lead.sendKey !== "") snapshotSendKeys.add(lead.sendKey);
  }

  // (3) per-lead booked flag (keyed by sendKey).
  const byKey = new Map<string, BookingCallStatus>();
  for (const lead of leads) {
    const matched = lead.sendKey !== "" && bookingLeadKeys.has(lead.sendKey);
    byKey.set(lead.sendKey, { booked: matched });
  }

  // (4) kpiCount = distinct matched leads across the full snapshot.
  let kpiCount = 0;
  for (const sendKey of snapshotSendKeys) {
    if (bookingLeadKeys.has(sendKey)) kpiCount++;
  }

  // (5) unmatchedCount = distinct booking leadKeys absent from the whole snapshot.
  let unmatchedCount = 0;
  for (const key of bookingLeadKeys) {
    if (!snapshotSendKeys.has(key)) unmatchedCount++;
  }

  return { byKey, kpiCount, unmatchedCount };
}
