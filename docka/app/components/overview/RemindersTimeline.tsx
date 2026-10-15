"use client";

import { useRef, useState } from "react";
import { GraphShell } from "./GraphShell";
import { useMountAnimation } from "./useMountAnimation";
import { SEAFARER_REMINDERS, REMINDER_UNITS } from "./overviewData";

// S3 — reminders timeline. A certificate expires 90 days out; reminders fire ahead
// of it (positions are hardcoded percentages — no new Date(), BI1). Future reminders
// are amber, the expiry is rose, "today" is a slate marker. Each reminder is a real
// <button> whose label ("Reminder 60 days before — .ics added") is reachable by
// focus/tap (IX3). A lead-unit toggle (Months/Weeks/Days) re-labels without moving
// anything. Dots pop in on mount; reduced motion shows them settled.

function unitLabel(daysBefore: number, unit: "months" | "weeks" | "days", expiry?: boolean): string {
  if (expiry) return "Expiry day";
  if (unit === "months") return `~${Math.max(1, Math.round(daysBefore / 30))} month${daysBefore >= 45 ? "s" : ""} before`;
  if (unit === "weeks") return `~${Math.round(daysBefore / 7)} weeks before`;
  return `${daysBefore} days before`;
}

export function RemindersTimeline({ active = false }: { active?: boolean }) {
  // Dots pop in on first intersection (plan v3 C6), not at page load.
  const ref = useRef<HTMLElement | null>(null);
  const { shown, reduced } = useMountAnimation(ref);
  const [unit, setUnit] = useState<"months" | "weeks" | "days">("days");
  const [open, setOpen] = useState<number | null>(null);

  const ariaLabel =
    "Reminder timeline (illustrative): a certificate expiring in 90 days, with reminders at " +
    SEAFARER_REMINDERS.filter((r) => !r.expiry)
      .map((r) => `${r.daysBefore} days before`)
      .join(", ") +
    ", and the expiry day.";

  return (
    <GraphShell
      ref={ref}
      title="Expiry reminders"
      subtitle="Set your own schedule — each reminder becomes a calendar (.ics) entry."
      active={active}
    >
      {/* Lead-unit toggle */}
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label="Reminder lead unit">
        {REMINDER_UNITS.map((u) => {
          const on = u.id === unit;
          return (
            <button
              key={u.id}
              type="button"
              aria-pressed={on}
              onClick={() => setUnit(u.id)}
              className={`min-h-[44px] rounded-md px-3 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                on ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {u.label}
            </button>
          );
        })}
      </div>

      {/* Track */}
      <div className="relative h-10" role="img" aria-label={ariaLabel}>
        <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-100" />
        {/* today marker (slate) slides in from the left */}
        <div
          className={`absolute top-1/2 flex -translate-y-1/2 flex-col items-center ${
            reduced ? "" : "transition-all duration-700 ease-out"
          }`}
          style={{ left: `${shown ? 0 : -8}%` }}
        >
          <span className="h-4 w-1.5 rounded bg-slate-500" />
        </div>
        {SEAFARER_REMINDERS.map((r, i) => (
          <span
            key={r.daysBefore}
            className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${
              r.expiry ? "bg-rose-500" : "bg-amber-500"
            } ${reduced ? "" : "transition-transform duration-500 ease-out"} ${
              shown ? "scale-100" : "scale-0"
            }`}
            style={{
              left: `${r.pct}%`,
              transitionDelay: reduced ? undefined : `${i * 100}ms`,
            }}
            aria-hidden
          />
        ))}
      </div>

      {/* Always-visible reminder chips (real buttons — focus/tap reveals the .ics note). */}
      <div className="mt-3 flex flex-wrap gap-2">
        {SEAFARER_REMINDERS.map((r) => {
          const isOpen = open === r.daysBefore;
          const label = unitLabel(r.daysBefore, unit, r.expiry);
          return (
            <button
              key={r.daysBefore}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : r.daysBefore)}
              className={`min-h-[44px] rounded-full border px-3 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
                r.expiry
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              } ${isOpen ? "ring-2 ring-brand-300" : ""}`}
            >
              {label}
              {isOpen && !r.expiry ? <span className="ml-1 text-slate-500">· .ics added</span> : null}
              {isOpen && r.expiry ? <span className="ml-1 text-slate-500">· certificate lapses</span> : null}
            </button>
          );
        })}
      </div>
    </GraphShell>
  );
}
