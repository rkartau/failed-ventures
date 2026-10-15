"use client";

import type { Persona } from "./overviewData";

// Shared persona controller (G5 / IX2). Chips are REAL buttons: keyboard-operable,
// aria-pressed reflects selection, visible focus ring. Initial state is NEUTRAL
// (nothing selected — all graphs show their final data, none ringed). Clicking a
// chip selects it; clicking the selected chip again DESELECTS back to neutral.
export function PersonaSelector({
  personas,
  selectedId,
  onSelect,
}: {
  personas: Persona[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = personas.find((p) => p.id === selectedId) ?? null;

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a persona">
        {personas.map((p) => {
          const isOn = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={isOn}
              onClick={() => onSelect(isOn ? null : p.id)}
              className={`min-h-[44px] rounded-xl border px-4 py-2 text-left text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                isOn
                  ? "border-brand-300 bg-brand-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="block">{p.name}</span>
              <span
                className={`block text-xs font-normal ${
                  isOn ? "text-brand-50" : "text-slate-500"
                }`}
              >
                {p.role}
              </span>
            </button>
          );
        })}
      </div>

      {/* Blurb region — live so a keyboard/screen-reader user hears the change. */}
      <div aria-live="polite" className="mt-4 min-h-[3.5rem]">
        {selected ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-sm text-slate-700">
              <span className="font-semibold text-slate-900">{selected.name}:</span>{" "}
              {selected.blurb}
            </p>
            {selected.callout ? (
              <p className="mt-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700">
                {selected.callout}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            Pick a person above to see what they care about — the graph they rely on lights
            up. Pick again to clear.
          </p>
        )}
      </div>
    </div>
  );
}
