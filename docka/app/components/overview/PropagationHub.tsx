"use client";

import { useState } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { HUB, SEAFARER_AGENCIES } from "./overviewData";

// S4 — enter-once -> propagates, hub-and-spoke. A central seaman hub connects to four
// agencies. A dot travels hub -> agency ONLY when that agency is granted, proving
// consent stays with the seaman. Each agency is a real toggle <button> (aria-pressed)
// with a lock icon that conveys granted/not INDEPENDENT of colour and of the dot
// (IX4). All-spokes-off shows an explicit empty-state message. Coordinates are
// hardcoded (BI1).

function LockIcon({ granted }: { granted: boolean }) {
  // Closed padlock = access on; open padlock = no access. Shape (not colour) is the signal.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {granted ? (
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      ) : (
        <path d="M8 11V7a4 4 0 0 1 7-2.5" />
      )}
    </svg>
  );
}

export function PropagationHub({ active = false }: { active?: boolean }) {
  const { shown, reduced } = useMountAnimation();
  const [granted, setGranted] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SEAFARER_AGENCIES.map((a) => [a.id, a.granted]))
  );

  const anyGranted = SEAFARER_AGENCIES.some((a) => granted[a.id]);

  const ariaLabel =
    "Consent propagation (illustrative): you are the hub; a document reaches only the agencies you have granted. Currently granted: " +
    (anyGranted
      ? SEAFARER_AGENCIES.filter((a) => granted[a.id]).map((a) => a.name).join(", ")
      : "none") +
    ".";

  return (
    <GraphShell
      title="Enter once — it reaches only who you allow"
      subtitle="Update your verified profile once; it propagates to the agencies you have granted."
      active={active}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <svg viewBox="0 0 320 220" className="h-48 w-full sm:w-1/2" role="img" aria-label={ariaLabel}>
          {/* spokes */}
          {SEAFARER_AGENCIES.map((a) => (
            <line
              key={a.id}
              x1={HUB.x}
              y1={HUB.y}
              x2={a.x}
              y2={a.y}
              stroke={granted[a.id] ? "#0ea5e9" : "#e2e8f0"}
              strokeWidth={2}
              strokeDasharray={granted[a.id] ? undefined : "4 4"}
            />
          ))}
          {/* travelling dots — only for granted spokes; park at the agency when shown */}
          {SEAFARER_AGENCIES.map((a) => {
            if (!granted[a.id]) return null;
            const atEnd = reduced || shown;
            return (
              <circle
                key={`dot-${a.id}`}
                r={4}
                fill="#0284c7"
                cx={atEnd ? a.x : HUB.x}
                cy={atEnd ? a.y : HUB.y}
                className={reduced ? "" : "transition-all duration-[1100ms] ease-in-out"}
              />
            );
          })}
          {/* agency nodes */}
          {SEAFARER_AGENCIES.map((a) => (
            <g key={`node-${a.id}`}>
              <circle
                cx={a.x}
                cy={a.y}
                r={16}
                fill={granted[a.id] ? "#e0f2fe" : "#f1f5f9"}
                stroke={granted[a.id] ? "#0ea5e9" : "#cbd5e1"}
                strokeWidth={2}
              />
              <text x={a.x} y={a.y + 4} textAnchor="middle" fontSize="11" fill="#475569" fontWeight="600">
                {granted[a.id] ? "✓" : "–"}
              </text>
            </g>
          ))}
          {/* hub (seaman) */}
          <circle cx={HUB.x} cy={HUB.y} r={22} fill="#1a3b8c" />
          <text x={HUB.x} y={HUB.y + 4} textAnchor="middle" fontSize="11" fill="#fff" fontWeight="700">
            You
          </text>
        </svg>

        {/* Real toggle controls */}
        <div className="w-full space-y-2 sm:w-1/2">
          {SEAFARER_AGENCIES.map((a) => {
            const on = granted[a.id];
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                onClick={() => setGranted((g) => ({ ...g, [a.id]: !g[a.id] }))}
                className={`flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                  on ? "border-sky-300 bg-sky-50" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={on ? "text-sky-700" : "text-slate-400"}>
                    <LockIcon granted={on} />
                  </span>
                  <span className="text-sm font-medium text-slate-800">{a.name}</span>
                </span>
                <span className={`text-xs font-semibold ${on ? "text-sky-700" : "text-slate-400"}`}>
                  {on ? "Access on" : "No access"}
                </span>
              </button>
            );
          })}

          {!anyGranted ? (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
              No agency has access — you're in full control.
            </p>
          ) : null}
        </div>
      </div>
    </GraphShell>
  );
}
