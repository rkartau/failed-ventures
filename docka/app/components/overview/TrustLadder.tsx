"use client";

import { useState } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { LEVEL_META } from "@/lib/verification-level";
import { SEAFARER_LADDER, FOREIGN_CERT_REASSURANCE } from "./overviewData";

// S1 — L0 -> L3 trust ladder. Each rung is a real <button> wrapping the real
// VerificationLevelBadge (IX6 — the span isn't focusable on its own), keyboard
// activatable, aria-expanded. Clicking expands the plain "what this means for you"
// line (which is also always visible as the rung meaning, so nothing is hover-only).
// Rungs stagger in on mount; reduced motion shows them all at once.
export function TrustLadder({ active = false }: { active?: boolean }) {
  const { shown, reduced } = useMountAnimation();
  const [open, setOpen] = useState<number | null>(null);

  return (
    <GraphShell
      title="Your trust ladder — L0 to L3"
      subtitle="Every certificate sits on one of four levels. Higher is stronger."
      active={active}
    >
      <ul className="space-y-2" role="list">
        {SEAFARER_LADDER.map((rung, i) => {
          const meta = LEVEL_META[rung.level];
          const isOpen = open === rung.level;
          return (
            <li
              key={rung.level}
              className={
                reduced
                  ? ""
                  : `transition-all duration-500 ease-out ${
                      shown ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0"
                    }`
              }
              style={reduced ? undefined : { transitionDelay: `${i * 90}ms` }}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : rung.level)}
                className={`flex w-full min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                  isOpen ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <VerificationLevelBadge level={rung.level} size="sm" />
                <span className="flex-1 text-sm text-slate-600">{rung.meaning}</span>
                <span aria-hidden className="text-slate-400">
                  {isOpen ? "–" : "+"}
                </span>
              </button>
              {isOpen ? (
                <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">{meta.word}.</span> {meta.tip}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Wei foreign-cert reassurance (CV5) — always visible. */}
      <p className="mt-4 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        {FOREIGN_CERT_REASSURANCE}
      </p>
    </GraphShell>
  );
}
