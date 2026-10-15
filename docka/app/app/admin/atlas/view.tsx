// app/admin/atlas/view.tsx — CLIENT choropleth for the Lead Atlas.
//
// Ports the reviewed artifact interaction (scratchpad/lead-atlas.html) to React,
// with NO d3/topojson on the client: the geometry arrives precomputed as path
// strings + projected marker points; only the per-country colour scale is computed
// here, from the live stats. The map panel is a deliberate dark-sea inset inside the
// otherwise light (slate) admin surface, consistent with the artifact.
//
// Robustness invariants (RV4/RV5/RV6/RV8):
//  * perM is null when population is missing/0 — never NaN/Infinity; those countries
//    drop out of the per-million metric (grey on the map, absent from the ranked
//    list + densest-market, "—" in the tooltip). Total/Sendable still show them.
//  * The quantile scale falls back to a single bin when the current metric has < 2
//    distinct positive values (never throws).
//  * Wheel zoom uses a NON-passive listener so preventDefault actually stops page
//    scroll; drag pans; scale clamps to [1,14]; Reset re-centres; prefers-reduced-
//    motion disables the fill transition.
//  * Counted countries with no polygon AND no marker are surfaced in the provenance
//    line ("N leads in M unmapped territories"), never silently dropped.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AtlasGeometry } from "@/lib/atlas/geo";
import type { LeadCountryStat } from "@/lib/docka-leads";
import { POPULATION } from "@/lib/atlas/reference";
import {
  ATLAS_COLORS as COLORS,
  ATLAS_NODATA as NODATA,
  ATLAS_ZERO as ZERO,
  buildScale,
  perMillion,
} from "@/lib/atlas/scale";

type Provenance = {
  generatedAt: string;
  sourceVersion: string;
  totalRows: number;
  withCountry: number;
  noCountry: number;
};

type Metric = "perM" | "total" | "sendable";

const METRICS: Record<Metric, { label: string; short: string; rankTitle: string; unit: string }> = {
  perM: { label: "Leads per million people", short: "leads per million people", rankTitle: "Top by density", unit: "/M" },
  total: { label: "Total leads", short: "total leads on file", rankTitle: "Top by volume", unit: "" },
  sendable: { label: "Sendable leads", short: "contactable right now", rankTitle: "Top by sendable", unit: "" },
};

type Row = {
  iso2: string;
  name: string;
  total: number;
  sendable: number;
  pop: number | null;
  perM: number | null;
};

const NF0 = new Intl.NumberFormat("en-US");

/** Best-effort English region name from an ISO2 (browser Intl), fallback to the code. */
function regionName(iso2: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

function metricValue(r: Row, m: Metric): number | null {
  return m === "perM" ? r.perM : m === "total" ? r.total : r.sendable;
}

function fmtMetric(m: Metric, v: number): string {
  if (m === "perM") return v >= 100 ? NF0.format(Math.round(v)) : v.toFixed(1);
  return NF0.format(Math.round(v));
}

/** Population-abbreviated string, e.g. 1.4B / 67M / 540k. */
function fmtPop(pop: number | null): string {
  if (pop == null || pop <= 0) return "—";
  if (pop >= 1e9) return `${(pop / 1e9).toFixed(1)}B`;
  if (pop >= 1e6) return `${(pop / 1e6).toFixed(pop >= 1e7 ? 0 : 1)}M`;
  if (pop >= 1e3) return `${Math.round(pop / 1e3)}k`;
  return NF0.format(pop);
}

export function LeadAtlasView({
  geometry,
  stats,
  provenance,
  stale,
  initialMetric = "perM",
}: {
  geometry: AtlasGeometry;
  stats: LeadCountryStat[];
  provenance: Provenance;
  stale: string | null;
  /** Metric selected on first render (defaults to per-million). */
  initialMetric?: Metric;
}): JSX.Element {
  const [metric, setMetric] = useState<Metric>(initialMetric);

  // ---- derived per-country rows + lookups (stable across renders) ----
  const rows: Row[] = useMemo(
    () =>
      stats.map((s) => {
        const pop = POPULATION[s.iso2];
        const hasPop = typeof pop === "number" && pop > 0;
        return {
          iso2: s.iso2,
          name: regionName(s.iso2),
          total: s.total,
          sendable: s.sendable,
          pop: hasPop ? pop : null,
          perM: perMillion(s.total, pop),
        };
      }),
    [stats]
  );
  const dataMap = useMemo(() => new Map(rows.map((r) => [r.iso2, r])), [rows]);
  const scale = useMemo(() => buildScale(rows.map((r) => metricValue(r, metric))), [rows, metric]);

  const mappedSets = useMemo(
    () => ({
      poly: new Set(geometry.polygonIso2),
      marker: new Set(geometry.markerIso2),
    }),
    [geometry]
  );

  // ---- provenance extras (RV4 no-pop, RV8 unmapped) ----
  const noPopCount = rows.filter((r) => r.pop == null).length;
  const unmapped = rows.filter((r) => !mappedSets.poly.has(r.iso2) && !mappedSets.marker.has(r.iso2));
  const unmappedLeads = unmapped.reduce((a, r) => a + r.total, 0);

  // ---- summary tiles ----
  const totalLeads = rows.reduce((a, r) => a + r.total, 0);
  const totalSendable = rows.reduce((a, r) => a + r.sendable, 0);
  const densest = rows
    .filter((r) => r.perM != null)
    .sort((a, b) => (b.perM as number) - (a.perM as number))[0];

  // ---- ranked list (top 15 by current metric, positives only) ----
  const ranked = useMemo(() => {
    const withVal = rows
      .map((r) => ({ r, v: metricValue(r, metric) }))
      .filter((x): x is { r: Row; v: number } => x.v != null && x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 15);
    const max = withVal.length ? withVal[0].v : 1;
    return { items: withVal, max };
  }, [rows, metric]);

  const fillFor = useCallback(
    (iso2: string): string => {
      const d = dataMap.get(iso2);
      if (!d) return NODATA;
      const v = metricValue(d, metric);
      if (v == null) return NODATA; // perM null → excluded from this metric
      if (v <= 0) return ZERO;
      return scale.color(v);
    },
    [dataMap, metric, scale]
  );

  // ---- pan/zoom state ----
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const [reduceMotion, setReduceMotion] = useState(false);
  const W = geometry.width;
  const H = geometry.height;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduceMotion(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  /** Clamp a translate so the scaled map keeps covering the viewBox. */
  const clampView = useCallback(
    (k: number, tx: number, ty: number) => {
      const kk = Math.max(1, Math.min(14, k));
      const minTx = W * (1 - kk);
      const minTy = H * (1 - kk);
      return { k: kk, tx: Math.max(minTx, Math.min(0, tx)), ty: Math.max(minTy, Math.min(0, ty)) };
    },
    [W, H]
  );

  /** Element px → viewBox coords (container holds a fixed W:H aspect, so linear). */
  const toViewBox = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { vx: 0, vy: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        vx: ((clientX - rect.left) / rect.width) * W,
        vy: ((clientY - rect.top) / rect.height) * H,
      };
    },
    [W, H]
  );

  // Non-passive wheel listener (RV6) — React onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      setView((cur) => {
        const { vx, vy } = toViewBox(ev.clientX, ev.clientY);
        const factor = Math.exp(-ev.deltaY * 0.0015);
        const nk = Math.max(1, Math.min(14, cur.k * factor));
        // keep the world point under the cursor fixed
        const wx = (vx - cur.tx) / cur.k;
        const wy = (vy - cur.ty) / cur.k;
        return clampView(nk, vx - wx * nk, vy - wy * nk);
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toViewBox, clampView]);

  // drag-pan via pointer events
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - drag.current.x) / rect.width) * W;
    const dy = ((e.clientY - drag.current.y) / rect.height) * H;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((cur) => clampView(cur.k, cur.tx + dx, cur.ty + dy));
  };
  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- tooltip ----
  const [tip, setTip] = useState<{ row: Row; x: number; y: number } | null>(null);
  const showTip = (row: Row, e: React.MouseEvent) => {
    const card = cardRef.current;
    if (!card) return;
    const r = card.getBoundingClientRect();
    let x = e.clientX - r.left + 14;
    let y = e.clientY - r.top + 14;
    if (x > r.width - 190) x = e.clientX - r.left - 186;
    if (y > r.height - 130) y = e.clientY - r.top - 130;
    setTip({ row, x, y });
  };

  const strokeW = 0.4 / view.k;
  const markerR = Math.max(1.1, geometry.baseMarkerRadius / view.k);
  const transition = reduceMotion ? "none" : "fill .35s";

  return (
    <div>
      <style>{`
        .atlas-country{stroke:rgba(255,255,255,.10);stroke-linejoin:round;vector-effect:non-scaling-stroke}
        .atlas-country.hit{cursor:pointer}
        .atlas-marker{stroke:#081820}
        .atlas-seg{color:#5b6f7b}
        .atlas-seg[aria-pressed="true"]{background:#e8843c;color:#241206;font-weight:600}
      `}</style>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Lead Atlas</h1>
          <p className="text-sm text-slate-500">
            The live lead base by country — colour the map by density, volume, or who is
            contactable right now.
          </p>
        </div>
      </div>

      {/* summary tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile k="Leads mapped" v={NF0.format(totalLeads)} s={`${NF0.format(provenance.noCountry)} without a country`} />
        <Tile k="Countries" v={NF0.format(rows.length)} s="with at least one lead" />
        <Tile k="Sendable now" v={NF0.format(totalSendable)} s="past the base sendable flag" />
        <Tile
          k="Densest market"
          v={densest ? densest.name : "—"}
          s={densest ? `${fmtMetric("perM", densest.perM as number)} leads / million` : "no population data"}
        />
      </div>

      {/* metric toggle */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {(Object.keys(METRICS) as Metric[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className="atlas-seg rounded-md px-3 py-1.5 text-[13px] font-medium hover:text-slate-900"
            >
              {m === "perM" ? "Leads per million" : m === "total" ? "Total leads" : "Sendable now"}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400">Scroll to zoom · drag to pan</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* map panel (dark-sea inset) */}
        <div
          ref={cardRef}
          className="relative overflow-hidden rounded-xl border border-slate-200 shadow-sm"
          style={{ background: "radial-gradient(120% 120% at 30% 10%, #0c2530, #081820 70%)" }}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ display: "block", width: "100%", height: "auto", touchAction: "none", cursor: drag.current ? "grabbing" : "grab" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={(e) => {
              endDrag(e);
              setTip(null);
            }}
          >
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
              <path d={geometry.sphere} fill="transparent" stroke="rgba(255,255,255,.10)" strokeWidth={0.6 / view.k} />
              {geometry.polygons.map((p, i) => {
                const has = p.iso2 !== "" && dataMap.has(p.iso2);
                return (
                  <path
                    key={`${p.id}-${i}`}
                    d={p.d}
                    fill={p.iso2 !== "" ? fillFor(p.iso2) : NODATA}
                    className={`atlas-country${has ? " hit" : ""}`}
                    strokeWidth={strokeW}
                    style={{ transition }}
                    onMouseMove={has ? (e) => showTip(dataMap.get(p.iso2) as Row, e) : undefined}
                    onMouseLeave={has ? () => setTip(null) : undefined}
                  />
                );
              })}
              {geometry.markers.map((mk) => {
                const d = dataMap.get(mk.iso2);
                if (!d) return null;
                const v = metricValue(d, metric);
                const fill = v == null ? NODATA : v <= 0 ? ZERO : scale.color(v);
                return (
                  <circle
                    key={mk.iso2}
                    cx={mk.x}
                    cy={mk.y}
                    r={markerR}
                    fill={fill}
                    className="atlas-marker"
                    strokeWidth={0.6 / view.k}
                    style={{ cursor: "pointer", transition }}
                    onMouseMove={(e) => showTip(d, e)}
                    onMouseLeave={() => setTip(null)}
                  />
                );
              })}
            </g>
          </svg>

          {/* reset */}
          <button
            type="button"
            onClick={() => setView({ k: 1, tx: 0, ty: 0 })}
            className="absolute right-3 top-3 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/20"
          >
            Reset
          </button>

          {/* legend */}
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] text-slate-200">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">{METRICS[metric].label}</div>
            {scale.single ? (
              <div className="flex items-center gap-2 text-[10px] text-slate-300">
                <span className="inline-block h-2.5 w-6 rounded-sm" style={{ background: COLORS[COLORS.length - 1] }} />
                <span>{scale.positiveCount} {scale.positiveCount === 1 ? "country" : "countries"} with data</span>
              </div>
            ) : (
              <>
                <div className="flex h-2.5 w-[230px] max-w-full overflow-hidden rounded-sm">
                  {COLORS.map((c) => (
                    <span key={c} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
                <div className="mt-0.5 flex w-[230px] max-w-full justify-between">
                  {[0, ...scale.thresholds].map((v, i) => (
                    <span key={i} className="text-[9px] text-slate-400">
                      {fmtMetric(metric, v)}
                    </span>
                  ))}
                  <span className="text-[9px] text-slate-400">max</span>
                </div>
              </>
            )}
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
              <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: NODATA }} />
              <span>no data</span>
            </div>
          </div>

          {/* tooltip */}
          {tip ? (
            <div
              className="pointer-events-none absolute z-10 min-w-[170px] rounded-lg border border-white/15 bg-[#06121ef2] p-2.5 text-slate-100 shadow-lg"
              style={{ left: tip.x, top: tip.y }}
            >
              <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                {tip.row.name}
                <span className="rounded border border-white/15 px-1 py-0.5 text-[10px] tracking-wide text-amber-400">
                  {tip.row.iso2}
                </span>
              </div>
              <TipRow l="Leads / million" r={tip.row.perM != null ? fmtMetric("perM", tip.row.perM) : "—"} hi />
              <TipRow l="Total leads" r={NF0.format(tip.row.total)} />
              <TipRow l="Sendable now" r={NF0.format(tip.row.sendable)} />
              <TipRow l="Population" r={fmtPop(tip.row.pop)} />
            </div>
          ) : null}
        </div>

        {/* ranked list */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">{METRICS[metric].rankTitle}</h2>
          <p className="text-xs text-slate-500">{METRICS[metric].short}</p>
          <ol className="mt-3 space-y-2">
            {ranked.items.length === 0 ? (
              <li className="text-xs text-slate-400">No countries with a value for this metric.</li>
            ) : (
              ranked.items.map(({ r, v }, i) => (
                <li key={r.iso2} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-slate-700">{r.name}</div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-100">
                      <div className="h-full rounded bg-[#1c8079]" style={{ width: `${Math.max(3, (v / ranked.max) * 100)}%` }} />
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-medium tabular-nums text-slate-800">
                    {fmtMetric(metric, v)}
                    {METRICS[metric].unit ? <span className="text-slate-400"> {METRICS[metric].unit}</span> : null}
                  </span>
                </li>
              ))
            )}
          </ol>
        </div>
      </div>

      {/* provenance line */}
      <p className="mt-3 text-[11px] text-slate-400">
        live base · generated {provenance.generatedAt} · v{provenance.sourceVersion} ·{" "}
        {NF0.format(provenance.noCountry)} without a country
        {noPopCount > 0 ? ` · ${noPopCount} without a per-capita figure` : ""}
        {unmapped.length > 0
          ? ` · ${NF0.format(unmappedLeads)} leads in ${unmapped.length} unmapped ${unmapped.length === 1 ? "territory" : "territories"}`
          : ""}
        {stale ? ` · latest refresh failed (${stale})` : ""}
      </p>
    </div>
  );
}

function Tile({ k, v, s }: { k: string; v: string; s: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k}</p>
      <p className="mt-1 truncate text-2xl font-bold text-slate-900">{v}</p>
      <p className="mt-0.5 text-xs text-slate-500">{s}</p>
    </div>
  );
}

function TipRow({ l, r, hi }: { l: string; r: string; hi?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between gap-4 text-[12.5px] leading-relaxed">
      <span className="text-slate-400">{l}</span>
      <span className={`tabular-nums ${hi ? "text-amber-400" : ""}`}>{r}</span>
    </div>
  );
}
