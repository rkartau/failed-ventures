// B2 board-card view-model — the ONE pure derivation behind the redesigned kanban
// card (spec "B2 ledger" v2). Zero JSX; client-safe (type-only Doc/Seafarer/
// DocRequest imports); consumes only the EXISTING shared helpers (cert status,
// request summary, required-set completeness, employment read-model, verification
// floor) so the card can never fork a parallel status computation.
//
// Strings resolve through the caller-supplied `tr` (the bound `t` from lib/i18n),
// so strip text is unit-testable AND localized without this module importing React.
//
// Clock stance (R1-3): `opts.now` reaches ONLY the request due-state
// (summarizeRequests) and the employment read-model. Per-doc expiry status runs
// through docStatusForDoc, which is hardwired to the real clock — unit fixtures
// for expiry states must use dates relative to real now with >= 1 day of margin
// from the 60-day expiring boundary.

import type { Doc, DocRequest, Seafarer } from "@/lib/db";
import { docStatusForDoc, type DocStatus } from "@/lib/cert";
import { summarizeRequests } from "@/lib/doc-requests";
import {
  requiredSetFor,
  requiredCompleteness,
  employmentCompleteness,
  employmentContextFor,
  type RequiredDocsConfig,
} from "@/lib/required-docs";
import {
  profileVerificationSummary,
  LEVEL_META,
  type VerificationLevel,
} from "@/lib/verification-level";
import { nextState, STATE_LABELS } from "@/lib/pipeline";
import { claimStateOf, type ClaimState } from "@/lib/claim-state";

/** The board-row shape the model derives from (AgentBoard's SeafarerWithDocs). */
export type SeafarerWithDocsShape = Seafarer & {
  documents: Doc[];
  docRequests?: DocRequest[];
  assigned?: boolean;
};

// ---- Moved board helpers (single definition — AgentBoard imports these back) ----

// Worst-first ordering: expired first, then expiring, then no-expiry/unknown,
// then valid — the order an agent should triage in. `none` (perpetual noExpiry)
// is valid-equivalent — a compliant state, never a warning.
export const SEVERITY: Record<DocStatus, number> = {
  expired: 4,
  expiring: 3,
  unknown: 2,
  valid: 1,
  none: 1,
};

// Doc-aware worst-status across a seafarer's docs. Mirrors cert.ts `worstStatus`
// ordering (a dated "valid" outranks a null "unknown") but is fed through
// `docStatusForDoc`, so a perpetual (noExpiry) document ranks valid-equivalent
// ("none") rather than the "unknown" a null date would otherwise yield.
const WORST_SEVERITY: Record<DocStatus, number> = {
  expired: 3,
  expiring: 2,
  valid: 1,
  none: 1,
  unknown: 0,
};
export function worstStatusForDocs(docs: Doc[]): DocStatus {
  let worst: DocStatus = "unknown";
  for (const d of docs) {
    const st = docStatusForDoc(d);
    if (WORST_SEVERITY[st] > WORST_SEVERITY[worst]) worst = st;
  }
  return worst;
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// UTC-pinned date formatter for text that is compared across the SSR/client boundary
// (the claim panel + card status line). fmtDate above pins the locale but NOT the
// timezone, so a stamp near midnight renders a different DAY on the box (UTC) vs a
// client in UTC+3 → a recoverable hydration mismatch. This variant pins timeZone:"UTC"
// so server and client always emit the identical string. Used ONLY where that matters.
export function fmtDateUtc(iso?: string | number | null): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// #S9 — the freshest registry/reviewer check timestamp across a seafarer's docs, for
// the roster verification badge's "verified <date>" freshness stamp (shown only when
// the floor level is L2/L3). null when nothing has a verification timestamp.
export function freshestVerifiedAt(docs: Doc[]): string | null {
  let best: string | null = null;
  for (const d of docs) {
    const t = d.verifiedResolvedAt ?? d.checkedAt ?? null;
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

// The single document the agent should act on: the worst-status doc with the
// earliest date. Returns its title + status + date so the card can say exactly
// WHICH document is expiring/expired, not just "earliest expiry".
export function worstDoc(docs: Doc[]): { doc: Doc; status: DocStatus } | null {
  let best: { doc: Doc; status: DocStatus } | null = null;
  for (const doc of docs) {
    const status = docStatusForDoc(doc);
    if (status !== "expired" && status !== "expiring") continue;
    if (
      !best ||
      SEVERITY[status] > SEVERITY[best.status] ||
      (SEVERITY[status] === SEVERITY[best.status] &&
        (doc.validUntil ?? "") < (best.doc.validUntil ?? ""))
    ) {
      best = { doc, status };
    }
  }
  return best;
}

// ---- The four count predicates (the one definition both the card cells and the
// rows-memo filter counts use — they can never diverge) ------------------------

/** Emerald is exclusive to actual government verification (F7 / docBadge semantics). */
export const isGovVerifiedDoc = (d: Doc): boolean => d.source === "government";

/** Awaiting verification: an OPEN manual-verification request or a flagged holder mismatch. */
export const isVerifyPendingDoc = (d: Doc): boolean =>
  d.manualVerification?.status === "requested" || d.holderMismatch === true;

/** Checked against a registry: portal sign-off OR authority-confirmed manual (vr2 item 6). */
export const isCheckedDoc = (d: Doc): boolean =>
  (d.reviewerChecked === true && d.checkedVia === "registry-portal") ||
  d.manualVerification?.status === "confirmed";

/** Registry-confirmed documents (source:"registry", the teal tier). */
export const isRegistryConfirmedDoc = (d: Doc): boolean => d.source === "registry";

// ---- View-model types --------------------------------------------------------

export type StripSeverity = "red" | "amber" | "sky" | "neutral";
export type CardStrip = { severity: StripSeverity; text: string; testid: string };

export type BoardCardModel = {
  floor: VerificationLevel;
  /** LEVEL_META[floor].short verbatim (R1-1) — the shipped badge wording, never re-keyed. */
  floorWord: string;
  /** Freshest check timestamp for the badge tooltip's freshness stamp. */
  floorVerifiedAt: string | null;
  cells: {
    docs: { count: number; covered: number; total: number };
    gov: { gov: number; registry: number; checked: number; pending: number };
    req: { open: number };
    employment:
      | { kind: "benched" }
      | { kind: "complete"; count: number; total: number }
      | { kind: "gap"; count: number; total: number; seaBad: boolean; reconfirm: boolean };
  };
  /** Ordered red? amber? sky? neutral? — structurally capped at one strip per severity. */
  strips: CardStrip[];
  actionState: { atEnd: boolean; nextLabel: string | null; removeDisabled: boolean };
  /**
   * Claim status chip + kebab affordance derivation (one shared helper, §5). Deliberately
   * exposes NO `linkStale` boolean — the card renders identically on server and client;
   * staleness matters only for the panel's post-mount amber line, computed there. `label`
   * is null for legacy-unowned + sample (no chip). `tip` carries the always-on 24h note
   * for the opened state.
   */
  claim: { kind: ClaimState["kind"]; label: string | null; tip: string | null; testid: string | null };
};

type Tr = (key: string, vars?: Record<string, string | number>) => string;

// A bucket group: one localized head text covering `items` actionable things.
// The bucket strip renders the FIRST group's text and folds every remaining
// group's items into one trailing "+N more" — so the one-red + one-amber cap is
// structural, never a JSX discipline.
type StripGroup = { text: string; items: number };

function bucketStrip(groups: StripGroup[], severity: StripSeverity, tr: Tr): CardStrip | null {
  if (groups.length === 0) return null;
  const extra = groups.slice(1).reduce((sum, g) => sum + g.items, 0);
  const text =
    groups[0].text + (extra > 0 ? " · " + tr("board.strip.more", { n: extra }) : "");
  return { severity, text, testid: `card-strip-${severity}` };
}

/** Cap the missing-names list at 3 names, then "+N more" (spec amber example). */
function missingNames(missing: string[], tr: Tr): string {
  const head = missing.slice(0, 3).join(", ");
  return missing.length > 3
    ? `${head} ${tr("board.strip.more", { n: missing.length - 3 })}`
    : head;
}

// ---- The model ---------------------------------------------------------------

export function boardCardModel(
  input: { s: SeafarerWithDocsShape; requiredConfig: RequiredDocsConfig | null },
  opts: { now?: Date; tr: Tr }
): BoardCardModel {
  const { s, requiredConfig } = input;
  const { tr } = opts;
  const now = opts.now ?? new Date();
  const docs = s.documents;

  // ---- Verification floor (never max(docs)) — #30.6 --------------------------
  const verdict = profileVerificationSummary(s, docs);
  const floor = verdict.floor;

  // ---- Docs cell: on-file count + required-set completeness ------------------
  const req = requiredSetFor({
    rank: s.rank,
    config: requiredConfig,
    vesselType: s.vesselType,
    flag: s.flagState,
  });
  const completeness = requiredCompleteness(docs.map((d) => d.requiredType), req);

  // ---- Gov cell: government-only count; registry/checked live in the tooltip;
  // pending keeps the verify-pending filter visibly anchored (REQUIRED #9) ------
  const gov = docs.filter(isGovVerifiedDoc).length;
  const registry = docs.filter(isRegistryConfirmedDoc).length;
  const checked = docs.filter(isCheckedDoc).length;
  const pending = docs.filter(isVerifyPendingDoc).length;

  // ---- Req cell + package summary --------------------------------------------
  const reqSummary = summarizeRequests(s.docRequests ?? [], now);

  // ---- Employment (#41 shared read-model; benched is never a gap) ------------
  const ec = employmentCompleteness(
    docs.map((d) => d.requiredType),
    docs,
    employmentContextFor(s),
    { assigned: s.assigned === true, now }
  );
  const seaBad = ec.missing.includes("SEA") || ec.expired.includes("SEA");
  const anyGap =
    ec.missing.length > 0 || ec.expired.length > 0 || ec.unknownExpiry.length > 0;
  // REQUIRED #8 — an unknown-expiry SEA counts as a gap (reconfirm), never a false ✓.
  const reconfirm = ec.unknownExpiry.includes("SEA");
  const employment: BoardCardModel["cells"]["employment"] = !ec.applicable
    ? { kind: "benched" }
    : anyGap
      ? { kind: "gap", count: ec.count, total: ec.total, seaBad, reconfirm }
      : { kind: "complete", count: ec.count, total: ec.total };

  // ---- Strips (the card's entire status system) ------------------------------
  const strips: CardStrip[] = [];

  // RED bucket: expired docs (worst named + date), overdue requests, employment
  // gap with SEA missing/expired (the shipped seaBad severity split, R1-8).
  const redGroups: StripGroup[] = [];
  const expiredDocs = docs.filter((d) => docStatusForDoc(d) === "expired");
  if (expiredDocs.length > 0) {
    const w = worstDoc(expiredDocs)!;
    redGroups.push({
      text: tr("board.strip.expired", {
        n: expiredDocs.length,
        name: w.doc.title,
        date: fmtDate(w.doc.validUntil),
      }),
      items: expiredDocs.length,
    });
  }
  if (reqSummary.overdue > 0) {
    redGroups.push({
      text: tr("board.strip.requestOverdue", { n: reqSummary.overdue }),
      items: reqSummary.overdue,
    });
  }
  if (ec.applicable && seaBad) {
    redGroups.push({ text: tr("board.strip.employmentGap"), items: 1 });
  }
  const red = bucketStrip(redGroups, "red", tr);
  if (red) strips.push(red);

  // AMBER bucket: expiring docs (named + date), missing required docs (names
  // capped at 3), doc-level unknown-expiry (the "unknown" DocStatus replacing
  // StatusBadge's distinct state), non-SEA employment gaps + SEA reconfirm (R1-8).
  const amberGroups: StripGroup[] = [];
  const expiringDocs = docs.filter((d) => docStatusForDoc(d) === "expiring");
  if (expiringDocs.length > 0) {
    const w = worstDoc(expiringDocs)!;
    amberGroups.push({
      text: tr("board.strip.expiring", {
        n: expiringDocs.length,
        name: w.doc.title,
        date: fmtDate(w.doc.validUntil),
      }),
      items: expiringDocs.length,
    });
  }
  if (completeness.missing.length > 0) {
    amberGroups.push({
      text: tr("board.strip.missing", {
        n: completeness.missing.length,
        names: missingNames(completeness.missing, tr),
      }),
      // The head text already folds its own overflow into "+N more"; other
      // groups' extras count from here.
      items: completeness.missing.length,
    });
  }
  const unknownDocs = docs.filter((d) => docStatusForDoc(d) === "unknown");
  if (unknownDocs.length > 0) {
    amberGroups.push({
      text: tr("board.strip.unknownExpiry", { n: unknownDocs.length }),
      items: unknownDocs.length,
    });
  }
  if (ec.applicable && anyGap && !seaBad) {
    amberGroups.push({ text: tr("board.strip.employmentGap"), items: 1 });
  }
  const amber = bucketStrip(amberGroups, "amber", tr);
  if (amber) strips.push(amber);

  // SKY strip: package ready — sky, never green (#S3). Denominator = ACTIVE
  // requests (total − waived/cancelled, R1-4); all-waived renders no fraction
  // (parity with today's numberless chip — never "0/3").
  if (reqSummary.packageReady) {
    const active = reqSummary.total - reqSummary.closed;
    strips.push({
      severity: "sky",
      text:
        active > 0
          ? tr("board.strip.packageReady", { received: reqSummary.received, active })
          : tr("board.strip.packageReadyBare"),
      testid: "card-strip-sky",
    });
  }

  // NEUTRAL strip: facts, not urgency.
  if (s.assigned === true) {
    strips.push({
      severity: "neutral",
      text: tr("board.strip.atSea"),
      testid: "card-strip-neutral",
    });
  }

  // ---- Claim status chip (one shared helper) ---------------------------------
  const cs = claimStateOf(s, now.getTime());
  let claimLabel: string | null = null;
  let claimTip: string | null = null;
  let claimTestid: string | null = null;
  if (cs.kind === "claimed") {
    claimLabel = tr("board.claim.claimed");
    claimTip = tr("board.claim.claimedTip");
    claimTestid = "claimed";
  } else if (cs.kind === "placeholder" && cs.opened === false) {
    claimLabel = tr("board.claim.pending");
    claimTip = tr("board.claim.pendingTip");
    claimTestid = "pending";
  } else if (cs.kind === "placeholder" && cs.opened === true) {
    claimLabel = tr("board.claim.opened");
    // UTC-pinned so the SSR + client `title` string match (no clock-dependent boolean).
    claimTip = tr("board.claim.openedTip", { when: fmtDateUtc(cs.openedAt) });
    claimTestid = "opened";
  }
  const claim = { kind: cs.kind, label: claimLabel, tip: claimTip, testid: claimTestid };

  // ---- Action row state ------------------------------------------------------
  const next = nextState(s.state);
  const atEnd = next === s.state;

  return {
    floor,
    floorWord: LEVEL_META[floor].short,
    floorVerifiedAt: freshestVerifiedAt(docs),
    cells: {
      docs: { count: docs.length, covered: completeness.count, total: completeness.total },
      gov: { gov, registry, checked, pending },
      req: { open: reqSummary.pending },
      employment,
    },
    strips,
    actionState: {
      atEnd,
      nextLabel: atEnd ? null : STATE_LABELS[next],
      removeDisabled: s.assigned === true,
    },
    claim,
  };
}
