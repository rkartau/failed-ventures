import { forwardRef, type ReactNode } from "react";
import { ILLUSTRATIVE_CAPTION } from "./overviewData";

// Shared frame for every interactive graph: title, optional subtitle, the
// mandatory "Illustrative…" caption, and the persona-highlight ring. `active`
// (the mapped persona is selected) adds a brand ring so the chip visibly lights
// up its graph. The ref is forwarded to the <section> so each graph can hand it
// to useMountAnimation and start its tween on first intersection (plan v3 C6).
export const GraphShell = forwardRef<
  HTMLElement,
  {
    title: string;
    subtitle?: string;
    active?: boolean;
    children: ReactNode;
  }
>(function GraphShell({ title, subtitle, active = false, children }, ref) {
  return (
    <section
      ref={ref}
      className={`rounded-xl border bg-white p-5 shadow-sm transition ${
        active ? "border-brand-300 ring-2 ring-brand-300" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {active ? (
          <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
            In focus
          </span>
        ) : null}
      </div>

      <div className="mt-4">{children}</div>

      {/* text-slate-500 (not 400): the caption is readable text on white (plan C3). */}
      <p className="mt-4 text-xs italic text-slate-500">{ILLUSTRATIVE_CAPTION}</p>
    </section>
  );
});
