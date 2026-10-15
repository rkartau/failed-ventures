// app/admin/ui.tsx
//
// Small, server-rendered presentational primitives for the admin screens. Plain
// Tailwind, visually consistent with app/agent/analytics/page.tsx, but admin-local
// (we do NOT import components/Kpi.tsx or touch the agent tree). Not a routable
// module, so it is outside the inverted admin static guard.

import type { Provenance, StageCount, TimelineEvent } from "@/lib/admin-funnel";

// ---- Date formatting ---------------------------------------------------

/** Epoch-ms → readable date, or the honest "— not tracked" badge text when null. */
export function fmtDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "— not tracked";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "— not tracked";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Epoch-ms → readable date + time, for timelines. Null → "— not tracked". */
export function fmtDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "— not tracked";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "— not tracked";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---- Table + badge class primitives ------------------------------------
// Lifted verbatim from the per-page copies (leads/view.tsx, outreach/page.tsx,
// outreach/timeline.tsx) so every admin table shares one source of truth.

/** Table header cell classes. */
export const TH =
  "px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500";
/** Table data cell classes. */
export const TD = "px-2 py-1.5 align-top";
/** Inline badge base classes; append border / bg / text tone classes per use. */
export const BADGE =
  "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide";

// ---- Query-string toggle href ------------------------------------------

/**
 * Build a click-to-filter href that toggles ONE query param while preserving the
 * others. `current` is the ALREADY-VALIDATED filter set (never raw searchParams)
 * — its null / empty values are dropped, so an invalid param can never persist
 * across a click. Clicking the value that is already active clears it (back to
 * the unfiltered base); any other value replaces it. Every key and value is
 * encodeURIComponent-escaped; the other active params (q and sort included) ride
 * along unchanged, in their original order. Generalises outreach's `stageHref`.
 */
export function toggleParamHref(
  basePath: string,
  current: Record<string, string | null>,
  key: string,
  value: string
): string {
  const next = new Map<string, string>();
  for (const [k, v] of Object.entries(current)) {
    if (v !== null && v !== undefined && v !== "") next.set(k, v);
  }
  if (next.get(key) === value) next.delete(key);
  else next.set(key, value);
  const qs = Array.from(next.entries())
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? `${basePath}?${qs}` : basePath;
}

// ---- Layout primitives -------------------------------------------------

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : null}
      {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone = "slate",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}): JSX.Element {
  const ring: Record<string, string> = {
    slate: "border-slate-200",
    emerald: "border-emerald-200",
    amber: "border-amber-200",
    rose: "border-rose-200",
  };
  const accent: Record<string, string> = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
  };
  return (
    <div className={`rounded-xl border ${ring[tone]} bg-white p-4 shadow-sm`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent[tone]}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

// ---- Provenance + integrity badges -------------------------------------

const PROV_STYLE: Record<Provenance, { cls: string; label: string }> = {
  tracked: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "tracked" },
  approximated: { cls: "bg-amber-50 text-amber-700 border-amber-200", label: "approx" },
  "not-tracked": { cls: "bg-slate-100 text-slate-500 border-slate-200", label: "not tracked" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }): JSX.Element {
  const s = PROV_STYLE[provenance];
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

export function OutOfOrderBadge(): JSX.Element {
  return (
    <span className="inline-flex items-center rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700">
      out-of-order
    </span>
  );
}

export function ConflictBadge(): JSX.Element {
  return (
    <span className="inline-flex items-center rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
      conflict
    </span>
  );
}

/** The legend explaining every honesty badge. */
export function ProvenanceLegend(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
      <span className="font-medium text-slate-600">Legend:</span>
      <ProvenanceBadge provenance="tracked" />
      <span>real persisted timestamp</span>
      <span className="text-slate-300">·</span>
      <ProvenanceBadge provenance="approximated" />
      <span>derived / proxy</span>
      <span className="text-slate-300">·</span>
      <ProvenanceBadge provenance="not-tracked" />
      <span>no data on file</span>
    </div>
  );
}

// ---- Per-stage breakdown bar list --------------------------------------

/**
 * A horizontal bar list of INDEPENDENT per-stage counts (NOT a funnel). Bar width is
 * scaled against the largest count purely for visual comparison — it is never a
 * stageN/stage(N-1) conversion. Each row shows the count and a provenance badge.
 */
export function StageBarList<K extends string>({
  stages,
}: {
  stages: StageCount<K>[];
}): JSX.Element {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <ul className="mt-4 space-y-3">
      {stages.map((s) => (
        <li key={s.key} className="flex items-center gap-3">
          <span className="w-40 shrink-0 text-sm text-slate-600">{s.label}</span>
          <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100">
            <div
              className="h-full rounded bg-sky-500"
              style={{ width: `${(s.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-sm font-semibold text-slate-800">
            {s.count}
          </span>
          <span className="w-24 shrink-0 text-right">
            <ProvenanceBadge provenance={s.provenance} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- Timeline ----------------------------------------------------------

function TimelineRow({ ev }: { ev: TimelineEvent }): JSX.Element {
  const addon = ev.extra && ev.extra["addon"] === true;
  return (
    <li className="flex gap-3">
      <div className="w-40 shrink-0 text-xs text-slate-500">
        {ev.at === null ? "— not tracked" : fmtDateTime(ev.at)}
      </div>
      <div className="flex-1 border-l border-slate-200 pb-4 pl-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${addon ? "text-slate-400 italic" : "text-slate-800"}`}>
            {ev.label}
          </span>
          <ProvenanceBadge provenance={ev.provenance} />
          {addon ? (
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
              add-on
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{ev.type}</div>
      </div>
    </li>
  );
}

/** Dated timeline (ascending) + a separate labelled "undated" section. */
export function Timeline({
  dated,
  undated,
}: {
  dated: TimelineEvent[];
  undated: TimelineEvent[];
}): JSX.Element {
  return (
    <div>
      {dated.length === 0 ? (
        <p className="text-sm text-slate-500">No dated events on file.</p>
      ) : (
        <ul className="space-y-0">
          {dated.map((ev, i) => (
            <TimelineRow key={`d-${i}`} ev={ev} />
          ))}
        </ul>
      )}

      {undated.length > 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Undated / no timestamp
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Events with a missing or unparseable timestamp — never interleaved with
            dated events.
          </p>
          <ul className="mt-3 space-y-0">
            {undated.map((ev, i) => (
              <TimelineRow key={`u-${i}`} ev={ev} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
