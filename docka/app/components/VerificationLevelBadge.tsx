// Shared verification-level pill (#30). Mirrors StatusBadge's pattern but renders the
// PLAIN-LANGUAGE word first (primary) with a small L-code suffix, distinct icons per
// level (so the signal is never colour-only, #30.5), and the identity-bound vs
// holder-bound tooltip on `title` (#30.7). Emerald is reserved for level 3 alone.

import { LEVEL_META, type VerificationLevel } from "@/lib/verification-level";

function LevelIcon({ icon }: { icon: LevelMetaIcon }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (icon) {
    case "shield-check":
      return (
        <svg {...common}>
          <path d="M12 3l7 3v6c0 4-3 6.5-7 9-4-2.5-7-5-7-9V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "file-check":
      return (
        <svg {...common}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
          <path d="M9 15l2 2 3-3" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default: // user
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
        </svg>
      );
  }
}

type LevelMetaIcon = (typeof LEVEL_META)[VerificationLevel]["icon"];

// "2026-01-02T…" -> "02 Jan 2026" (UTC, stable server/client) for the freshness stamp.
function fmtStamp(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function VerificationLevelBadge({
  level,
  tooltip,
  size = "md",
  className = "",
  verifiedOn = null,
  toneClassName,
  dotClassName,
}: {
  level: VerificationLevel;
  tooltip?: string;
  size?: "sm" | "md";
  className?: string;
  /**
   * #S9 — freshness stamp source: the doc's last-verified / checked timestamp.
   * Rendered ONLY for L2/L3 (a registry / government check that can go stale), so a
   * compliance reader sees the check is recent. Omitted gracefully when absent.
   */
  verifiedOn?: string | null;
  /**
   * Optional colour overrides for the pill + dot. Used where the SURROUNDING state
   * demotes the trust colour — e.g. the verify page's CACHED banner recolours the
   * L3 badge to amber so emerald reads only on a genuine LIVE re-check. Defaults to
   * the level's own tone, keeping every existing call site unchanged.
   */
  toneClassName?: string;
  dotClassName?: string;
}) {
  const meta = LEVEL_META[level];
  const tone = toneClassName ?? meta.tone;
  const dotTone = dotClassName ?? meta.dot;

  // DEF-12 — the sm chip renders on the narrow (~200px) kanban board card, next to
  // the sibling pills ("5/5 · complete", employment, "3 gov-verified"). It must be a
  // clean, single-line chip that matches those siblings' shape/height/rhythm — NOT a
  // cramped 3-line box. So at sm we: use the SHORT label, drop the freshness stamp and
  // the redundant colour dot (the icon already carries the non-colour signal, #30.5),
  // match the siblings' `rounded-full px-2 py-0.5 text-xs`, and keep `whitespace-nowrap`
  // (safe now the label is short). The full text stays on the hover `title`. All md/full
  // call sites (review panel, CV, share) are byte-unchanged in the branch below.
  if (size === "sm") {
    return (
      <span
        data-testid="verification-level"
        data-level={level}
        title={tooltip ?? meta.tip}
        // items-center on the flex row aligns the icon and label by their centres (no
        // baseline drift); text-xs + py-0.5 matches the sibling pills' height exactly.
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${tone} ${className}`}
      >
        <LevelIcon icon={meta.icon} />
        {/* #S6 — plain words only; the "L0/L1/L2/L3" code is NOT shown to users
            (kept as the data-level attribute above for tests). */}
        <span>{meta.short}</span>
      </span>
    );
  }

  // #S9 — only L2/L3 carry a freshness date.
  const stamp = level >= 2 ? fmtStamp(verifiedOn) : "";
  return (
    <span
      data-testid="verification-level"
      data-level={level}
      title={tooltip ?? meta.tip}
      // #S2 — rectangular pill (rounded-md), like the CV/share pills — not a cramped
      // circle. The default md size (review panel etc.) keeps the long label + stamp.
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-semibold ring-1 ${tone} px-2.5 py-1 text-xs ${className}`}
    >
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${dotTone}`} aria-hidden="true" />
      <LevelIcon icon={meta.icon} />
      {/* #S6 — plain words only; the "L0/L1/L2/L3" code is NOT shown to users
          (kept as the data-level attribute above for tests). */}
      <span>{meta.word}</span>
      {stamp && (
        <span className="font-normal opacity-70" data-testid="verification-freshness">
          · verified {stamp}
        </span>
      )}
    </span>
  );
}
