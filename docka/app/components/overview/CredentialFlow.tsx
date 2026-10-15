"use client";

import { useState } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { SEAFARER_FLOW } from "./overviewData";

// S2 — credential flow: upload -> verify -> share -> hired. The SVG line + travelling
// pulse is decorative (aria-hidden); the real semantics live in four real <button>
// steps below it whose titles + captions are ALWAYS visible (IX3) and which expand a
// description on focus/tap. A dot pulses along the line on mount; reduced motion
// parks it at the end with no motion. "Hired" caption softened to "often within
// days" (CV8). Nodes are evenly spaced on a 0–100 viewBox for clean scaling to 360px.
const N = SEAFARER_FLOW.length;

export function CredentialFlow({ active = false }: { active?: boolean }) {
  const { shown, reduced } = useMountAnimation();
  const [open, setOpen] = useState<string | null>(null);

  // Evenly spaced node x-positions (viewBox 0..100), first at 10, last at 90.
  const xs = SEAFARER_FLOW.map((_, i) => 10 + (80 * i) / (N - 1));
  const dotX = reduced || shown ? xs[N - 1] : xs[0];

  const ariaLabel =
    "Credential flow (illustrative): " +
    SEAFARER_FLOW.map((s) => `${s.title} (${s.caption})`).join(" then ") +
    ".";

  return (
    <GraphShell
      title="From photo to hired"
      subtitle="Four steps, mostly taps."
      active={active}
    >
      <svg
        viewBox="0 0 100 24"
        className="h-16 w-full"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        <line x1={xs[0]} y1={12} x2={xs[N - 1]} y2={12} stroke="#e2e8f0" strokeWidth={2} />
        {xs.map((x, i) => (
          <circle key={i} cx={x} cy={12} r={4} fill="#fff" stroke="#0284c7" strokeWidth={2} />
        ))}
        <circle
          cx={dotX}
          cy={12}
          r={2.5}
          fill="#0ea5e9"
          className={reduced ? "" : "transition-[cx] duration-[1200ms] ease-in-out"}
          style={{ transitionProperty: reduced ? undefined : "cx" }}
        />
      </svg>

      {/* Real, focusable step controls — carry the accessible name + always-visible text. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={ariaLabel}>
        {SEAFARER_FLOW.map((s, i) => {
          const isOpen = open === s.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : s.id)}
              className={`flex min-h-[44px] flex-col items-start rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                isOpen ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              <span className="text-xs font-semibold text-slate-400">Step {i + 1}</span>
              <span className="text-sm font-semibold text-slate-900">{s.title}</span>
              <span className="text-xs text-sky-700">{s.caption}</span>
              {isOpen ? (
                <span className="mt-1 text-xs leading-relaxed text-slate-600">{s.desc}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </GraphShell>
  );
}
