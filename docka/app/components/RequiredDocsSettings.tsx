"use client";

import { useMemo, useState } from "react";
import { REQUIRED_DOC_TYPES, type RequiredDocType } from "@/lib/doctypes";
import {
  RANK_KEYS,
  RANK_LABELS,
  VESSEL_TYPE_KEYS,
  VESSEL_TYPE_LABELS,
  FLAG_KEYS,
  FLAG_LABELS,
  requiredSetFor,
  type RankKey,
  type VesselTypeKey,
  type FlagKey,
  type RequiredDocsConfig,
  type CatalogEntry,
} from "@/lib/required-docs";
import type { RequiredDocsAuditRow } from "@/lib/db";

type Props = {
  initialConfig: RequiredDocsConfig;
  catalog: CatalogEntry[];
  baselineVersion: string;
  governedCount: number;
  custom: boolean;
  initialAudit: RequiredDocsAuditRow[];
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB");
}

export function RequiredDocsSettings({
  initialConfig,
  catalog,
  baselineVersion,
  governedCount,
  custom,
  initialAudit,
}: Props) {
  const [universal, setUniversal] = useState<Set<RequiredDocType>>(
    new Set(initialConfig.universalRequired)
  );
  const [perRank, setPerRank] = useState<Record<RankKey, Set<RequiredDocType>>>(() => {
    const out = {} as Record<RankKey, Set<RequiredDocType>>;
    for (const k of RANK_KEYS) out[k] = new Set(initialConfig.perRankRequired[k] ?? []);
    return out;
  });
  const [perVesselType, setPerVesselType] = useState<Record<VesselTypeKey, Set<RequiredDocType>>>(() => {
    const out = {} as Record<VesselTypeKey, Set<RequiredDocType>>;
    for (const k of VESSEL_TYPE_KEYS) out[k] = new Set(initialConfig.perVesselTypeRequired?.[k] ?? []);
    return out;
  });
  const [perFlag, setPerFlag] = useState<Record<FlagKey, Set<RequiredDocType>>>(() => {
    const out = {} as Record<FlagKey, Set<RequiredDocType>>;
    for (const k of FLAG_KEYS) out[k] = new Set(initialConfig.perFlagRequired?.[k] ?? []);
    return out;
  });
  const [audit, setAudit] = useState<RequiredDocsAuditRow[]>(initialAudit);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [isCustom, setIsCustom] = useState(custom);
  // The per-rank grid is advanced/optional. Keep it collapsed by default so the
  // common case (one universal set for everyone) stays simple; auto-open it if
  // the agent already has per-rank rules so they can see them.
  const [showPerRank, setShowPerRank] = useState(() =>
    RANK_KEYS.some((k) => (initialConfig.perRankRequired[k] ?? []).length > 0)
  );
  const [showPerVesselType, setShowPerVesselType] = useState(() =>
    VESSEL_TYPE_KEYS.some((k) => (initialConfig.perVesselTypeRequired?.[k] ?? []).length > 0)
  );
  const [showPerFlag, setShowPerFlag] = useState(() =>
    FLAG_KEYS.some((k) => (initialConfig.perFlagRequired?.[k] ?? []).length > 0)
  );

  const nameBySlug = useMemo(() => {
    const m = new Map<RequiredDocType, string>();
    for (const c of catalog) m.set(c.slug, c.name);
    return m;
  }, [catalog]);

  function toggleUniversal(t: RequiredDocType) {
    setUniversal((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }
  function togglePerRank(k: RankKey, t: RequiredDocType) {
    setPerRank((prev) => {
      const next = { ...prev, [k]: new Set(prev[k]) };
      if (next[k].has(t)) next[k].delete(t);
      else next[k].add(t);
      return next;
    });
  }
  function togglePerVesselType(k: VesselTypeKey, t: RequiredDocType) {
    setPerVesselType((prev) => {
      const next = { ...prev, [k]: new Set(prev[k]) };
      if (next[k].has(t)) next[k].delete(t);
      else next[k].add(t);
      return next;
    });
  }
  function togglePerFlag(k: FlagKey, t: RequiredDocType) {
    setPerFlag((prev) => {
      const next = { ...prev, [k]: new Set(prev[k]) };
      if (next[k].has(t)) next[k].delete(t);
      else next[k].add(t);
      return next;
    });
  }

  // Live preview of the effective required set per rank (universal + per-rank),
  // computed with the SAME engine the board/review use.
  const preview = useMemo(() => {
    const cfg: RequiredDocsConfig = {
      ...initialConfig,
      universalRequired: REQUIRED_DOC_TYPES.filter((t) => universal.has(t)),
      perRankRequired: Object.fromEntries(
        RANK_KEYS.map((k) => [k, REQUIRED_DOC_TYPES.filter((t) => perRank[k].has(t))])
      ) as Record<RankKey, RequiredDocType[]>,
    };
    return RANK_KEYS.map((k) => ({
      rank: k,
      set: requiredSetFor({ rank: k, config: cfg }).required,
    }));
  }, [universal, perRank, initialConfig]);

  async function save() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/required-docs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baselineVersion,
          universalRequired: REQUIRED_DOC_TYPES.filter((t) => universal.has(t)),
          perRankRequired: Object.fromEntries(
            RANK_KEYS.map((k) => [k, REQUIRED_DOC_TYPES.filter((t) => perRank[k].has(t))])
          ),
          perVesselTypeRequired: Object.fromEntries(
            VESSEL_TYPE_KEYS.map((k) => [k, REQUIRED_DOC_TYPES.filter((t) => perVesselType[k].has(t))])
          ),
          perFlagRequired: Object.fromEntries(
            FLAG_KEYS.map((k) => [k, REQUIRED_DOC_TYPES.filter((t) => perFlag[k].has(t))])
          ),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setAudit((prev) => [data.audit, ...prev]);
        setIsCustom(true);
        setBanner(
          `Saved. This change applies to ${data.audit.affectedSeafarers} of your seafarers.`
        );
      } else {
        setBanner(data.error ?? "Could not save the configuration.");
      }
    } catch {
      setBanner("Could not save the configuration.");
    } finally {
      setBusy(false);
    }
  }

  // A collapsible additive-requirements matrix keyed by an arbitrary dimension
  // (vessel type, flag). Documents already required of EVERYONE are shown checked +
  // disabled; the agent adds only the EXTRA documents that dimension needs on top.
  function addOnSection<K extends string>(cfg: {
    keys: readonly K[];
    labels: Record<K, string>;
    state: Record<K, Set<RequiredDocType>>;
    toggle: (k: K, t: RequiredDocType) => void;
    open: boolean;
    setOpen: (v: (p: boolean) => boolean) => void;
    title: string;
    hint: string;
    rowHeader: string;
    testid: string;
  }) {
    return (
      <section data-testid={cfg.testid}>
        <button
          type="button"
          onClick={() => cfg.setOpen((v) => !v)}
          aria-expanded={cfg.open}
          className="flex w-full items-center gap-2 text-left text-lg font-semibold text-slate-900"
        >
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`text-slate-400 transition-transform ${cfg.open ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {cfg.title}
        </button>
        <p className="mt-1 text-sm text-slate-500">{cfg.hint}</p>

        {cfg.open && (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-4">{cfg.rowHeader}</th>
                  {REQUIRED_DOC_TYPES.map((t) => (
                    <th key={t} className="px-2 py-2 text-center font-medium">
                      {nameBySlug.get(t) ?? t}
                    </th>
                  ))}
                  <th className="pl-4 py-2">Extra documents required</th>
                </tr>
              </thead>
              <tbody>
                {cfg.keys.map((k) => {
                  const extra = REQUIRED_DOC_TYPES.filter(
                    (t) => cfg.state[k].has(t) && !universal.has(t)
                  );
                  return (
                    <tr key={k} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium text-slate-700">{cfg.labels[k]}</td>
                      {REQUIRED_DOC_TYPES.map((t) => {
                        const inUniversal = universal.has(t);
                        return (
                          <td key={t} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={inUniversal || cfg.state[k].has(t)}
                              disabled={inUniversal}
                              title={inUniversal ? "Already required of everyone" : undefined}
                              onChange={() => cfg.toggle(k, t)}
                            />
                          </td>
                        );
                      })}
                      <td className="pl-4 py-2 text-xs text-slate-500">
                        {extra.length
                          ? extra.map((s) => nameBySlug.get(s) ?? s).join(", ")
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        This change applies to <strong>all {governedCount}</strong> of your
        seafarer{governedCount === 1 ? "" : "s"}. What you set here decides which
        documents each of them must have on file. Every save is listed in the change
        history below.
        {!isCustom && (
          <span className="ml-1 text-amber-700">
            Right now you are using the recommended default set ({baselineVersion}).
          </span>
        )}
      </div>

      {banner && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {banner}
        </div>
      )}

      {/* Universal requirements */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900">Required of every seafarer</h2>
        <p className="mt-1 text-sm text-slate-500">
          These apply to everyone, whatever their rank. Based on the standard MLC/STCW rules.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {REQUIRED_DOC_TYPES.map((t) => (
            <label
              key={t}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                universal.has(t)
                  ? "border-brand-300 bg-brand-50 text-brand-800"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              <input
                type="checkbox"
                checked={universal.has(t)}
                onChange={() => toggleUniversal(t)}
              />
              {nameBySlug.get(t) ?? t}
            </label>
          ))}
        </div>
      </section>

      {/* Per-rank additive requirements — advanced/optional, collapsed by default */}
      <section>
        <button
          type="button"
          onClick={() => setShowPerRank((v) => !v)}
          aria-expanded={showPerRank}
          className="flex w-full items-center gap-2 text-left text-lg font-semibold text-slate-900"
        >
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={`text-slate-400 transition-transform ${showPerRank ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          Customize per rank (optional)
        </button>
        <p className="mt-1 text-sm text-slate-500">
          Most agents don&apos;t need this. Everyone already needs the documents above.
          Open this only if some ranks need extra documents on top.
        </p>

        {showPerRank && (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-4">Rank</th>
                  {REQUIRED_DOC_TYPES.map((t) => (
                    <th key={t} className="px-2 py-2 text-center font-medium">
                      {nameBySlug.get(t) ?? t}
                    </th>
                  ))}
                  <th className="pl-4 py-2">Documents required</th>
                </tr>
              </thead>
              <tbody>
                {RANK_KEYS.map((k) => {
                  const effective = preview.find((p) => p.rank === k)?.set ?? [];
                  return (
                    <tr key={k} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium text-slate-700">{RANK_LABELS[k]}</td>
                      {REQUIRED_DOC_TYPES.map((t) => {
                        const inUniversal = universal.has(t);
                        return (
                          <td key={t} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={inUniversal || perRank[k].has(t)}
                              disabled={inUniversal}
                              title={inUniversal ? "Already required of everyone" : undefined}
                              onChange={() => togglePerRank(k, t)}
                            />
                          </td>
                        );
                      })}
                      <td className="pl-4 py-2 text-xs text-slate-500">
                        {effective.length
                          ? effective.map((s) => nameBySlug.get(s) ?? s).join(", ")
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Per-vessel-type additive requirements (T1.8) */}
      {addOnSection({
        keys: VESSEL_TYPE_KEYS,
        labels: VESSEL_TYPE_LABELS,
        state: perVesselType,
        toggle: togglePerVesselType,
        open: showPerVesselType,
        setOpen: setShowPerVesselType,
        title: "Customize per vessel type (optional)",
        hint:
          "Some berths need extra certificates on top of the rank set — e.g. a chemical tanker needs tanker familiarisation and advanced fire fighting. Set a seafarer's vessel type on their profile to apply these.",
        rowHeader: "Vessel type",
        testid: "per-vessel-type-section",
      })}

      {/* Per-flag additive requirements (T1.8) */}
      {addOnSection({
        keys: FLAG_KEYS,
        labels: FLAG_LABELS,
        state: perFlag,
        toggle: togglePerFlag,
        open: showPerFlag,
        setOpen: setShowPerFlag,
        title: "Customize per flag state (optional)",
        hint:
          "Add any documents a specific flag state requires on top of the sets above. Set a seafarer's flag on their profile to apply these.",
        rowHeader: "Flag state",
        testid: "per-flag-section",
      })}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save configuration"}
        </button>
        <span className="text-xs text-slate-400">
          Applies immediately to all {governedCount} of your seafarers.
        </span>
      </div>

      {/* Audit trail */}
      <section>
        <h2 className="text-lg font-semibold text-slate-900">Change history</h2>
        {audit.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No configuration changes yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {audit.map((row) => (
              <li
                key={row.id}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-700">{row.summary}</span>
                  <span className="text-xs text-slate-400">{fmt(row.at)}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  by {row.actor} · affected {row.affectedSeafarers} seafarer
                  {row.affectedSeafarers === 1 ? "" : "s"}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
