"use client";

import { useRef, useState } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { LEVEL_META, type VerificationLevel } from "@/lib/verification-level";
import { AGENCY_LEVELS } from "./overviewData";

// G3 — verification-level distribution across 100 documents. Stacked bar whose
// segment fills come EXACTLY from LEVEL_META.dot (L0 slate, L1 amber, L2 teal,
// L3 emerald). Each segment sits at its FINAL width and animates transform:
// scaleX(0 -> 1) from the left on first intersection (plan v3 C6, no width tween).
// The legend uses the REAL VerificationLevelBadge, each wrapped in a real <button>
// so it is focusable + keyboard-activatable (IX6). Selecting a level emphasises it
// (others dim) and its count is always visible as text (IX3).
const TOTAL = 100;

export function LevelDistribution({ active = false }: { active?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const { shown, reduced } = useMountAnimation(ref);
  const [selected, setSelected] = useState<VerificationLevel | null>(null);

  const ariaLabel =
    "Verification-level distribution of 100 documents (illustrative): " +
    AGENCY_LEVELS.map((l) => `${LEVEL_META[l.level].word} ${l.count}`).join(", ") +
    ".";

  return (
    <GraphShell
      ref={ref}
      title="Verification-level mix"
      subtitle="Of 100 documents on file — how strongly each is verified."
      active={active}
    >
      {/* Stacked bar */}
      <div
        className="flex h-6 w-full overflow-hidden rounded"
        role="img"
        aria-label={ariaLabel}
      >
        {AGENCY_LEVELS.map((l) => {
          const meta = LEVEL_META[l.level];
          const dim = selected !== null && selected !== l.level;
          return (
            <div
              key={l.level}
              className={`h-full origin-left ${meta.dot} ${
                reduced ? "" : "transition-[transform,opacity] duration-700 ease-out"
              } ${shown ? "scale-x-100" : "scale-x-0"} ${dim ? "opacity-40" : "opacity-100"}`}
              style={{ width: `${(l.count / TOTAL) * 100}%` }}
            />
          );
        })}
      </div>

      {/* Legend — real badges wrapped in real buttons (focus + keyboard). */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {AGENCY_LEVELS.map((l) => {
          const isOn = selected === l.level;
          const pct = Math.round((l.count / TOTAL) * 100);
          return (
            <button
              key={l.level}
              type="button"
              aria-pressed={isOn}
              onClick={() => setSelected(isOn ? null : l.level)}
              className={`flex min-h-[44px] flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                isOn ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <VerificationLevelBadge level={l.level} size="sm" />
              <span className="text-xs font-semibold text-slate-800">
                {l.count} of {TOTAL} ({pct}%)
              </span>
            </button>
          );
        })}
      </div>
    </GraphShell>
  );
}
