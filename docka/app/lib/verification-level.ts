// Verification-level ladder (#30) — a PURE, derive-on-read projection over the
// server-stamped trust signals already on a Doc / Seafarer. It stores NOTHING and
// introduces NO new write path: the level is a read-time function of `doc.source`
// (server-stamped only, §30.2), `reviewerChecked` and `manualVerification.status`.
//
// It mirrors the `docBadge` ladder in cert.ts so the level badge and the status pill
// can never diverge:
//   L3 Government-verified  ⇐ source === "government"        (emerald, exclusive)
//   L2 Registry-confirmed   ⇐ source === "registry"          (document confirmed, holder not verified)
//   L1 Reviewed by staff    ⇐ reviewerChecked === true OR manualVerification.status === "confirmed"
//   L0 Self-declared        ⇐ everything else                (neutral, never shaming)
//
// TYPE-ONLY import of Doc/Seafarer keeps this client-safe (no Node built-ins).

import type { Doc, Seafarer } from "@/lib/db";
import { plainPunct } from "@/lib/seo";

export type VerificationLevel = 0 | 1 | 2 | 3;

export type LevelMeta = {
  /** PRIMARY plain-language label (#30.1) — shown first, never a bare L-code. */
  word: string;
  /**
   * DEF-12 — SHORT one-word/one-token label for the compact `size="sm"` chip that
   * renders on the narrow (~200px) kanban board card. The long `word` wraps into an
   * ugly 3-line box there; the short label keeps the chip a clean single line. The
   * full `word`/`tip` still shows on hover (title) and on every md/full surface.
   */
  short: string;
  /** Small secondary suffix, e.g. "L2". */
  code: string;
  /** Tailwind tone classes for the pill. */
  tone: string;
  /** Tailwind dot colour. */
  dot: string;
  /** Icon key rendered by the badge. */
  icon: "user" | "eye" | "file-check" | "shield-check";
  /** Tooltip base (#30.7 — a per-doc identity-bound / holder-bound nuance is appended). */
  tip: string;
};

export const LEVEL_META: Record<VerificationLevel, LevelMeta> = {
  0: {
    // #S8 — one consistent, non-shaming L0 phrase everywhere. Honest but neutral:
    // an un-verified REAL cert must never look fake, and "self-uploaded" is a plain
    // fact, not a judgement (persona: "L0 looks like a grade I failed").
    word: "Self-uploaded — not yet verified",
    short: "Self-uploaded",
    code: "L0",
    // Neutral slate — bottom of the ramp (grey), never green (#30.5 / #S3).
    tone: "bg-slate-100 text-slate-600 ring-slate-300",
    dot: "bg-slate-400",
    icon: "user",
    tip: "Self-uploaded — on file, but not yet checked or verified by anyone.",
  },
  1: {
    word: "Reviewed by staff",
    short: "Staff-reviewed",
    code: "L1",
    // #S4 — graded ramp: L1 AMBER (visibly weaker than the teal L2 / emerald L3).
    tone: "bg-amber-100 text-amber-800 ring-amber-200",
    dot: "bg-amber-500",
    icon: "eye",
    tip: "A human reviewer opened the actual document and confirmed it — holder-bound to this person, not a government registry check.",
  },
  2: {
    word: "Registry-confirmed",
    short: "Registry",
    code: "L2",
    // #S4 — light-green/teal: stronger than amber L1, weaker than emerald L3.
    tone: "bg-teal-100 text-teal-800 ring-teal-200",
    dot: "bg-teal-500",
    icon: "file-check",
    tip: "The document was confirmed to exist in a registry, but the holder's identity was not verified (holder-bound to the document, not the person).",
  },
  3: {
    word: "Government-verified",
    short: "Gov-verified",
    code: "L3",
    // Emerald is RESERVED for L3 (the anti-fraud invariant).
    tone: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    dot: "bg-emerald-500",
    icon: "shield-check",
    tip: "Verified against the issuing government's maritime registry.",
  },
};

/**
 * The public trust ladder for the marketing/content pages (SEO plan R6 / S5): a PURE
 * projection of LEVEL_META, never a re-typed table. `name` is LEVEL_META[n].word,
 * `short` is LEVEL_META[n].short, `meaning` is LEVEL_META[n].tip; every string passes
 * through `plainPunct()` HERE (data layer, not JSX) so the rendered ladder and any JSON-LD
 * text built from it are byte-identical and free of typographic dashes/quotes. The
 * canonical full table is `components/LevelTable.tsx`; every other public mention of the
 * ladder renders from this array or links to that table.
 */
export type TrustLadderRow = { code: string; name: string; short: string; meaning: string };
export const TRUST_LADDER: readonly TrustLadderRow[] = Object.freeze(
  ([0, 1, 2, 3] as const).map((n) => ({
    code: LEVEL_META[n].code,
    name: plainPunct(LEVEL_META[n].word),
    short: plainPunct(LEVEL_META[n].short),
    meaning: plainPunct(LEVEL_META[n].tip),
  }))
);

/**
 * The verification level of a single document — the AUTHORITATIVE per-doc signal.
 *
 * The `manualVerification.status` allow-list is EXACTLY `"confirmed"` (#30.11): a
 * bare `"requested"` is pending (stays L0), and `"closed_unavailable"` is a no-answer
 * close (also L0). Written as an allow-list, never a `!== "requested"` denylist, so a
 * future added status defaults to L0.
 */
export function verificationLevelForDoc(doc: Doc): VerificationLevel {
  if (doc.source === "government") return 3;
  if (doc.source === "registry") return 2;
  if (doc.reviewerChecked === true || doc.manualVerification?.status === "confirmed") return 1;
  return 0;
}

/**
 * The tooltip for a document's badge (#30.7). Rendered on EVERY surface (the shared
 * VerificationLevelBadge owns it), so board / cert-card / CV / verify all get the same
 * identity-bound vs holder-bound nuance. For an L3 government doc the wording depends on
 * the §2.5 key-trust class of the lookup that produced it.
 */
export function docLevelTooltip(doc: Doc): string {
  const level = verificationLevelForDoc(doc);
  if (level === 3) {
    return doc.verifiedKeyTrust === "capability-token"
      ? "Government-verified — identity-bound (secure registry token)."
      : "Government-verified — holder-bound (printed identifier).";
  }
  return LEVEL_META[level].tip;
}

/**
 * The structured profile verdict (#30.4) — NEVER `max(docs)`. The identity chip and
 * the honest per-document floor are kept side by side so one government doc can never
 * paint nine self-declared photos green.
 */
export type ProfileVerdict = {
  /** seafarer.identityVerified ONLY (a capability-token government identity). */
  identityVerified: boolean;
  /** The min level across active docs — the honest floor (0 when no docs). */
  floor: VerificationLevel;
  counts: Record<VerificationLevel, number>;
  /** Plain-language headline that always names the un-verified count when there is one. */
  headline: string;
};

export function profileVerificationSummary(seafarer: Seafarer, docs: Doc[]): ProfileVerdict {
  const counts: Record<VerificationLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let floor: VerificationLevel = docs.length ? 3 : 0;
  for (const d of docs) {
    const lvl = verificationLevelForDoc(d);
    counts[lvl] += 1;
    if (lvl < floor) floor = lvl;
  }
  const identityVerified = seafarer.identityVerified === true;
  const total = docs.length;
  // "Not yet verified" = anything below government-verified (level < 3).
  const notVerified = total - counts[3];

  let headline: string;
  if (identityVerified) {
    headline =
      notVerified > 0
        ? `Government-verified identity · ${notVerified} document${notVerified === 1 ? "" : "s"} not yet verified`
        : "Government-verified identity";
  } else if (total === 0) {
    headline = "No documents on file yet";
  } else if (notVerified === 0) {
    headline = `${counts[3]} government-verified document${counts[3] === 1 ? "" : "s"}`;
  } else {
    headline = `${counts[3]} of ${total} document${total === 1 ? "" : "s"} government-verified · ${notVerified} not yet verified`;
  }

  return { identityVerified, floor, counts, headline };
}
