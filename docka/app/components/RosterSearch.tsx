"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { SEAFARER_STATES, STATE_LABELS, type SeafarerState } from "@/lib/pipeline";
import {
  filterRoster,
  isEmptyQuery,
  rosterFacets,
  STATUS_LABELS,
  SEA_READY_EXPIRING_DAYS,
  type DocStatus,
  type ReadinessFilter,
  type RosterQuery,
  type RosterSearchRow,
} from "@/lib/roster-search";
import {
  AVAILABILITY_FILTERS,
  AVAILABILITY_FILTER_LABELS,
  AVAILABILITY_LABELS,
  type AvailabilityFilter,
} from "@/lib/availability";
import type { RequiredDocType } from "@/lib/doctypes";
import { SAMPLE_OPEN_TOKEN } from "@/lib/sample-ids";

type Props = {
  rows: RosterSearchRow[];
  /**
   * Public Sample Profiles (plan §D10): true when the page INJECTED the un-granted
   * flagship row — only then does the sample row carry the "Add to board"
   * affordance (the /share auto-grant seam). A granted flagship arrives through
   * the normal grant-scoped roster and shows the chip alone.
   */
  sampleUngranted?: boolean;
};

const STATUS_PILL: Record<DocStatus, string> = {
  valid: "bg-emerald-50 text-emerald-700",
  // Perpetual (no-expiry) — valid/compliant, styled like "valid".
  none: "bg-emerald-50 text-emerald-700",
  expiring: "bg-amber-50 text-amber-700",
  expired: "bg-rose-50 text-rose-700",
  unknown: "bg-slate-100 text-slate-500",
};

const CERT_STATUS_OPTIONS: DocStatus[] = ["valid", "expiring", "expired"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function RosterSearch({ rows, sampleUngranted = false }: Props) {
  const [text, setText] = useState("");
  const [rank, setRank] = useState("");
  const [nationality, setNationality] = useState("");
  const [vesselType, setVesselType] = useState("");
  const [flagState, setFlagState] = useState("");
  // Two SEPARATE dimensions: agent pipeline stage vs seaman-declared availability.
  const [pipelineStage, setPipelineStage] = useState<"" | SeafarerState>("");
  const [availability, setAvailability] = useState<"" | AvailabilityFilter>("");
  const [availableBy, setAvailableBy] = useState("");
  const [readiness, setReadiness] = useState<"" | ReadinessFilter>("");
  const [certType, setCertType] = useState<"" | RequiredDocType>("");
  const [certStatus, setCertStatus] = useState<"" | DocStatus>("");

  const facets = useMemo(() => rosterFacets(rows), [rows]);

  const query: RosterQuery = {
    text,
    rank,
    nationality,
    vesselType,
    flagState,
    pipelineStage,
    availability,
    availableBy,
    readiness,
    certType,
    // Cert status is only meaningful as a modifier of a selected cert type.
    certStatus: certType ? certStatus : "",
  };

  const results = useMemo(
    () => filterRoster(rows, query),
    [rows, text, rank, nationality, vesselType, flagState, pipelineStage, availability, availableBy, readiness, certType, certStatus]
  );
  const empty = isEmptyQuery(query);

  function reset() {
    setText("");
    setRank("");
    setNationality("");
    setVesselType("");
    setFlagState("");
    setPipelineStage("");
    setAvailability("");
    setAvailableBy("");
    setReadiness("");
    setCertType("");
    setCertStatus("");
  }

  const input =
    "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Filters</h2>
          {!empty && (
            <button
              type="button"
              onClick={reset}
              className="text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Clear all
            </button>
          )}
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium text-slate-500">Name / rank / vessel</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. 2nd Officer, Aurora…"
            className={input}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-slate-500">Rank</label>
            <select value={rank} onChange={(e) => setRank(e.target.value)} className={input}>
              <option value="">All ranks</option>
              {facets.ranks.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Nationality / issuer</label>
            <select
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
              className={input}
            >
              <option value="">Any nationality</option>
              {facets.nationalities.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Pipeline stage</label>
            <select
              value={pipelineStage}
              onChange={(e) => setPipelineStage(e.target.value as "" | SeafarerState)}
              data-testid="filter-pipeline-stage"
              className={input}
            >
              <option value="">Any stage</option>
              {SEAFARER_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Availability</label>
            <select
              value={availability}
              onChange={(e) => setAvailability(e.target.value as "" | AvailabilityFilter)}
              data-testid="filter-availability"
              className={input}
            >
              <option value="">Any availability</option>
              {AVAILABILITY_FILTERS.map((a) => (
                <option key={a} value={a}>
                  {AVAILABILITY_FILTER_LABELS[a]}
                </option>
              ))}
            </select>
            {availability === "open_by" && (
              <input
                type="date"
                value={availableBy}
                onChange={(e) => setAvailableBy(e.target.value)}
                data-testid="filter-available-by"
                aria-label="Open by date"
                className={input}
              />
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Crew readiness</label>
            <select
              value={readiness}
              onChange={(e) => setReadiness(e.target.value as "" | ReadinessFilter)}
              data-testid="filter-readiness"
              className={input}
            >
              <option value="">Any readiness</option>
              <option value="sea_ready">Sea-ready (fully compliant)</option>
              <option value="expiring_90">Expiring within {SEA_READY_EXPIRING_DAYS} days</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Certificate held</label>
            <select
              value={certType}
              onChange={(e) => setCertType(e.target.value as "" | RequiredDocType)}
              className={input}
            >
              <option value="">Any certificate</option>
              {facets.certTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {certType && (
            <div>
              <label className="text-xs font-medium text-slate-500">
                Certificate status <span className="font-normal text-slate-400">(of held {certType})</span>
              </label>
              <select
                value={certStatus}
                onChange={(e) => setCertStatus(e.target.value as "" | DocStatus)}
                data-testid="filter-cert-status"
                className={input}
              >
                <option value="">Any status</option>
                {CERT_STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {facets.vesselTypes.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-500">Vessel-type fit</label>
              <select
                value={vesselType}
                onChange={(e) => setVesselType(e.target.value)}
                className={input}
              >
                <option value="">Any vessel type</option>
                {facets.vesselTypes.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          )}
          {facets.flagStates.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-500">Flag state</label>
              <select
                value={flagState}
                onChange={(e) => setFlagState(e.target.value)}
                className={input}
              >
                <option value="">Any flag</option>
                {facets.flagStates.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-slate-500">
          {empty ? (
            <>
              Showing your whole roster —{" "}
              <span className="font-semibold text-slate-700">{rows.length}</span> seafarer
              {rows.length === 1 ? "" : "s"}. Add filters to narrow the search.
            </>
          ) : (
            <>
              <span className="font-semibold text-slate-700">{results.length}</span> of{" "}
              <span className="font-semibold text-slate-700">{rows.length}</span> match your
              filters.
            </>
          )}
        </p>
      </div>

      {results.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-slate-600">No seafarer in your roster matches.</p>
          <p className="mt-1 text-xs text-slate-400">
            Loosen a filter, or check the certificate status you require.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {results.map((row) => {
            const shown = row.certs.slice(0, 6);
            return (
              <li
                key={row.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* The flagship SAMPLE row (plan §D10): its name opens the
                          public share view (works granted or not) instead of the
                          grant-scoped /agent/[id] page, which 404s pre-grant. */}
                      <Link
                        href={row.isSample === true ? `/share/${SAMPLE_OPEN_TOKEN}` : `/agent/${row.id}`}
                        className="font-semibold text-slate-900 hover:text-brand-700 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.isSample === true && (
                        <span
                          data-testid="search-sample-chip"
                          title="Fictional sample profile — demo data"
                          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300"
                        >
                          Sample
                        </span>
                      )}
                      {row.identityVerified && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                          Verified ID
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {row.rank || "Rank not set"}
                      {row.nationality ? ` · ${row.nationality}` : ""}
                      {row.vessel ? ` · ${row.vessel}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                        {STATE_LABELS[row.state]}
                      </span>
                      {row.availability && (
                        <span
                          data-testid="row-availability"
                          className={`rounded-full px-2 py-0.5 font-medium ${
                            row.availability === "occupied"
                              ? "bg-rose-50 text-rose-600"
                              : "bg-emerald-50 text-emerald-700"
                          }`}
                        >
                          {AVAILABILITY_LABELS[row.availability]}
                          {row.availability === "open_from" && row.availableFrom
                            ? ` ${fmtDate(row.availableFrom)}`
                            : ""}
                        </span>
                      )}
                      {row.seaReady && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                          Sea-ready
                        </span>
                      )}
                      {row.vesselType && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                          {row.vesselType}
                        </span>
                      )}
                      {row.flagState && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                          {row.flagState}
                        </span>
                      )}
                      {row.rotationEnd && (
                        <span className="text-slate-400">free after {fmtDate(row.rotationEnd)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    <span
                      className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_PILL[row.overallStatus]}`}
                    >
                      {STATUS_LABELS[row.overallStatus]}
                    </span>
                    <span className="text-slate-400">
                      {row.docCount} cert{row.docCount === 1 ? "" : "s"}
                      {row.expiringCount > 0 ? ` · ${row.expiringCount} expiring` : ""}
                      {row.expiredCount > 0 ? ` · ${row.expiredCount} expired` : ""}
                    </span>
                    {/* Terse affordance to the locked /share auto-grant seam: a
                        signed-in agent opening the open link mints the grant and
                        the flagship lands on their board (plan §D10). Injected
                        (un-granted) rows only — once granted it would be noise. */}
                    {row.isSample === true && sampleUngranted && (
                      <Link
                        href={`/share/${SAMPLE_OPEN_TOKEN}`}
                        data-testid="sample-add-to-board"
                        className="mt-1 rounded-lg bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-700"
                      >
                        Add to board
                      </Link>
                    )}
                  </div>
                </div>

                {shown.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {shown.map((c, i) => (
                      <span
                        key={`${row.id}-${i}`}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[c.status]}`}
                        title={`${c.title} · ${STATUS_LABELS[c.status]}${
                          c.expiry ? ` · ${fmtDate(c.expiry)}` : ""
                        }`}
                      >
                        {c.requiredType ?? c.title}
                      </span>
                    ))}
                    {row.certs.length > shown.length && (
                      <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-400">
                        +{row.certs.length - shown.length} more
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
