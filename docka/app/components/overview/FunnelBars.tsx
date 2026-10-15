"use client";

import { useRef } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { AGENCY_FUNNEL } from "./overviewData";

// G1 — pipeline funnel. Div-bar idiom copied from the analytics page. Counts and
// percentages are ALWAYS visible as text (IX3 — no number is hover-only). Each bar
// sits at its FINAL width and animates transform: scaleX(0 -> 1) from the left
// once the graph scrolls into view (plan v3 C6: a transform, never a width tween,
// so the animation causes no layout work). Reduced-motion renders the final state
// with no tween. role="img" + aria-label carries every count for screen readers.
export function FunnelBars({ active = false }: { active?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const { shown, reduced } = useMountAnimation(ref);
  const max = AGENCY_FUNNEL[0].count;

  const ariaLabel =
    "Pipeline funnel (illustrative): " +
    AGENCY_FUNNEL.map((s) => `${s.label} ${s.count}`).join(", ") +
    ".";

  return (
    <GraphShell
      ref={ref}
      title="Pipeline funnel"
      subtitle="Where crew sit as they move from review toward the ship."
      active={active}
    >
      <ul className="space-y-3" role="img" aria-label={ariaLabel}>
        {AGENCY_FUNNEL.map((s) => {
          const pct = Math.round((s.count / max) * 100);
          return (
            <li key={s.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-sm text-slate-600 sm:w-28">{s.label}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100">
                <div
                  className={`h-full origin-left rounded bg-sky-500 ${
                    reduced ? "" : "transition-transform duration-700 ease-out"
                  } ${shown ? "scale-x-100" : "scale-x-0"}`}
                  style={{ width: `${(s.count / max) * 100}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-sm font-semibold text-slate-800">
                {s.count} · {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </GraphShell>
  );
}
