"use client";

import { useRef } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { AGENCY_COMPLIANCE } from "./overviewData";

// G2 — compliance donut, hand-rolled inline SVG (no chart library). Two arcs on a
// slate track. The sea-ready PASS arc is SKY, not emerald (emerald = L3 gov-verified
// only, CV3); blocked is rose. Center % and the count legend are ALWAYS visible text
// (IX3). role="img" + aria-label. The stroke-dashoffset tween starts on first
// intersection (plan v3 C6). Reduced motion: arcs at final offset immediately.
const R = 52;
const C = 2 * Math.PI * R; // ≈ 326.73
const CX = 60;
const CY = 60;

export function ComplianceDonut({ active = false }: { active?: boolean }) {
  const ref = useRef<HTMLElement | null>(null);
  const { shown, reduced } = useMountAnimation(ref);
  const { seaReadyPct, blockedPct, seaReadyCount, blockedCount, total } = AGENCY_COMPLIANCE;

  const seaLen = (seaReadyPct / 100) * C;
  const blockedLen = (blockedPct / 100) * C;
  const transition = reduced ? "" : "transition-[stroke-dashoffset] duration-[900ms] ease-out";

  return (
    <GraphShell
      ref={ref}
      title="Sea-ready compliance"
      subtitle="How many crew clear the same hard block the board enforces before a ship."
      active={active}
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
        <div className="relative h-32 w-32 shrink-0">
          <svg
            viewBox="0 0 120 120"
            className="h-full w-full"
            role="img"
            aria-label={`Compliance (illustrative): ${seaReadyCount} of ${total} sea-ready (${seaReadyPct}%), ${blockedCount} blocked (${blockedPct}%).`}
          >
            {/* track */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="#e2e8f0" strokeWidth={14} />
            {/* sea-ready pass — SKY (not emerald) */}
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={14}
              strokeLinecap="round"
              strokeDasharray={`${seaLen} ${C}`}
              strokeDashoffset={shown ? 0 : seaLen}
              transform={`rotate(-90 ${CX} ${CY})`}
              className={transition}
            />
            {/* blocked — rose, starting where sea-ready ends */}
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="#fb7185"
              strokeWidth={14}
              strokeLinecap="round"
              strokeDasharray={`${blockedLen} ${C}`}
              strokeDashoffset={shown ? 0 : blockedLen}
              transform={`rotate(${-90 + (seaReadyPct / 100) * 360} ${CX} ${CY})`}
              className={transition}
            />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-slate-900">{seaReadyPct}%</span>
            <span className="text-[11px] font-medium text-slate-500">sea-ready</span>
          </div>
        </div>

        {/* Always-visible legend (icons + text, colour never the sole signal). */}
        <dl className="w-full space-y-2 text-sm">
          <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
            <dt className="flex items-center gap-2 text-slate-600">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-500" aria-hidden />
              Sea-ready
            </dt>
            <dd className="font-semibold text-slate-800">
              {seaReadyCount} · {seaReadyPct}%
            </dd>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
            <dt className="flex items-center gap-2 text-slate-600">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-400" aria-hidden />
              Blocked
            </dt>
            <dd className="font-semibold text-slate-800">
              {blockedCount} · {blockedPct}%
            </dd>
          </div>
        </dl>
      </div>
    </GraphShell>
  );
}
