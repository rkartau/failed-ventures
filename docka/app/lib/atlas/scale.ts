// lib/atlas/scale.ts — pure, client-safe choropleth colour maths (no React, no d3).
//
// Extracted from the view so the two numerically-delicate rules can be unit-tested
// without a DOM:
//  * perMillion() returns null when population is missing/0 — NEVER NaN/Infinity
//    (RV4). A null-per-million country is excluded from the per-million metric.
//  * buildScale() falls back to a SINGLE bin when the metric has < 2 distinct
//    positive values (or too few positives for the bins) — never throws (RV5).

/** 6-colour teal→amber ramp (verbatim from the reviewed artifact). */
export const ATLAS_COLORS = ["#12525a", "#1c8079", "#37a892", "#8ac97a", "#f0c14b", "#e8843c"];
/** Land with no data for the current metric. */
export const ATLAS_NODATA = "#33454f";
/** Land that HAS leads but a zero value for the current metric (dim teal). */
export const ATLAS_ZERO = "#213c44";

/** Leads per million, or null when population is absent/0 (never a divide blow-up). */
export function perMillion(total: number, pop: number | null | undefined): number | null {
  return typeof pop === "number" && pop > 0 ? (total / pop) * 1e6 : null;
}

/** Linear-interpolated quantile of p∈[0,1] over an ascending numeric array. */
export function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const i = (n - 1) * p;
  const lo = Math.floor(i);
  const frac = i - lo;
  return lo + 1 < n ? sorted[lo] + (sorted[lo + 1] - sorted[lo]) * frac : sorted[lo];
}

export type AtlasScale = {
  /** true when the single-bin fallback is active (degenerate input). */
  single: boolean;
  /** count of positive values that fed the scale. */
  positiveCount: number;
  /** the k-1 quantile break points (empty when single). */
  thresholds: number[];
  /** map a value to its fill colour (v<=0 → ATLAS_ZERO). */
  color: (v: number) => string;
};

/**
 * Build the fill scale from the current metric's values (nulls/≤0 ignored for the
 * domain). Guards degeneracy (RV5): fewer than 2 distinct positive values — or
 * fewer positives than colour bins — collapses to one bin.
 */
export function buildScale(values: Array<number | null>): AtlasScale {
  const vals = values
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b);
  const distinct = new Set(vals);
  const k = ATLAS_COLORS.length;
  if (distinct.size < 2 || vals.length < k) {
    const only = ATLAS_COLORS[k - 1];
    return { single: true, positiveCount: vals.length, thresholds: [], color: (v) => (v > 0 ? only : ATLAS_ZERO) };
  }
  const thresholds: number[] = [];
  for (let i = 1; i < k; i++) thresholds.push(quantileSorted(vals, i / k));
  return {
    single: false,
    positiveCount: vals.length,
    thresholds,
    color: (v) => {
      if (v <= 0) return ATLAS_ZERO;
      let idx = 0;
      for (const t of thresholds) {
        if (v >= t) idx++;
        else break;
      }
      return ATLAS_COLORS[Math.min(idx, k - 1)];
    },
  };
}
