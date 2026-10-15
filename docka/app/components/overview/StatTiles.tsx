"use client";

import { useRef } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { AGENCY_TILES, type Tone } from "./overviewData";

// G4 — clean illustrative KPI tiles (Kpi look copied from the analytics page). The
// number is rendered at its FINAL value on the server (SEO plan v3 R11): the HTML a
// crawler or a no-JS reader gets says "55%", never "0%", and the hydrated client
// starts from the same value so there is no 55 -> 0 -> 55 flash. When the tiles
// scroll into view they get a one-shot fade/scale (globals.css `.tile-in`) instead
// of a count-up. Reduced motion: no animation at all. No benchmark / "down from" /
// "×" framing (CV2).

const ACCENT: Record<Tone, string> = {
  slate: "text-slate-900",
  emerald: "text-emerald-700",
  amber: "text-amber-700",
  rose: "text-rose-700",
  sky: "text-sky-700",
  teal: "text-teal-700",
  brand: "text-brand-700",
};
const RING: Record<Tone, string> = {
  slate: "border-slate-200",
  emerald: "border-emerald-200",
  amber: "border-amber-200",
  rose: "border-rose-200",
  sky: "border-sky-200",
  teal: "border-teal-200",
  brand: "border-brand-200",
};

function Tile({
  label,
  target,
  tone,
  sub,
  run,
  reduced,
}: {
  label: string;
  target: string;
  tone: Tone;
  sub: string;
  run: boolean;
  reduced: boolean;
}) {
  // The tile is fully visible before `run` (server HTML, no-JS, pre-intersection);
  // the class only ADDS a reveal animation once the tile is in view.
  const anim = run && !reduced ? " tile-in" : "";
  return (
    <div className={`rounded-xl border ${RING[tone]} bg-white p-4 shadow-sm${anim}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${ACCENT[tone]}`}>{target}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

export function StatTiles({ active = false }: { active?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const { shown, reduced } = useMountAnimation(ref);
  return (
    <GraphShell
      ref={ref}
      title="What it changes, in numbers"
      subtitle="Representative outcomes once verified profiles flow through the desk."
      active={active}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {AGENCY_TILES.map((tile) => (
          <Tile
            key={tile.label}
            label={tile.label}
            target={tile.target}
            tone={tile.tone}
            sub={tile.sub}
            run={shown}
            reduced={reduced}
          />
        ))}
      </div>
    </GraphShell>
  );
}
