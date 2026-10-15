// app/admin/sources/view.tsx — presentational body of /admin/sources.
//
// PURE, SYNCHRONOUS server component (no auth, no client island): the gate lives
// in page.tsx (adminSession) + layout + edge middleware. Every cell is a plain
// scalar rendered through JSX, so React escapes everything — no raw HTML on this
// surface. TWO honest clocks: the COUNTS come from the lead base on every
// request; the LEDGER TEXT only changes when someone publishes + scp's the file.

import Link from "next/link";
import type { LeadsPageSnapshot, SourceAgg } from "@/lib/docka-leads";
import {
  applySourceFilters,
  filterParams,
  hostOf,
  ledgerBadge,
  parseSourceFilters,
  parseUtcStamp,
  reconcileSources,
  sortSectionA,
  sortSectionB,
  splitCountries,
  SOURCE_STATUSES,
  type ReconciledSource,
  type SourcesDoc,
  type SourceStatus,
} from "@/lib/docka-sources";
import { BADGE, TH, TD, Kpi, fmtDateTime, toggleParamHref } from "../ui";

type SourcesLoad =
  | { status: "ok"; doc: SourcesDoc; publishedAt: number }
  | { status: "missing" }
  | { status: "invalid"; error: string };

function n(v: number): string {
  return v.toLocaleString("en-US");
}
function clip(s: string, len: number): string {
  return s.length > len ? `${s.slice(0, len - 1)}…` : s;
}

// ---- status maps (exhaustive; satisfies pins the union at compile time) -----

const STATUS_LABEL = {
  in_base: "In base",
  enrichment: "Enrichment",
  usable_not_merged: "Usable, not merged",
  not_yet: "Not yet worked",
  gated: "Gated",
  forbidden: "Forbidden",
  dead: "Dead",
  superseded: "Superseded",
  other: "Other",
} satisfies Record<SourceStatus, string>;

const STATUS_CHIP = {
  in_base: "in base",
  enrichment: "enrichment",
  usable_not_merged: "usable, not merged",
  not_yet: "not yet",
  gated: "gated",
  forbidden: "forbidden",
  dead: "dead",
  superseded: "superseded",
  other: "other verdict",
} satisfies Record<SourceStatus, string>;

const STATUS_TONE = {
  in_base: "border-emerald-200 bg-emerald-50 text-emerald-700",
  enrichment: "border-emerald-200 bg-emerald-50 text-emerald-700",
  usable_not_merged: "border-amber-200 bg-amber-50 text-amber-700",
  not_yet: "border-slate-200 bg-slate-100 text-slate-600",
  gated: "border-amber-200 bg-amber-50 text-amber-700",
  forbidden: "border-rose-200 bg-rose-50 text-rose-700",
  dead: "border-slate-200 bg-white text-slate-400",
  superseded: "border-slate-200 bg-white text-slate-400",
  other: "border-slate-200 bg-slate-100 text-slate-600",
} satisfies Record<SourceStatus, string>;

const SECTIONS = ["A", "B", "C", "D", "E", "F", "G", "S"] as const;

// ---- small presentational bits ---------------------------------------------

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Link
      href={href}
      className={`${BADGE} ${
        active
          ? "border-sky-400 bg-sky-50 text-sky-700 ring-1 ring-sky-300"
          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
      }`}
    >
      {children}
    </Link>
  );
}

function VerdictBadge({ verdict }: { verdict: string }): JSX.Element {
  const v = verdict.toUpperCase();
  const tone = v.startsWith("USABLE")
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : v === "FORBIDDEN"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : v === "GATED" || v === "NOT-YET-WORKED"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-100 text-slate-600";
  return <span className={`${BADGE} ${tone}`}>{clip(verdict, 24)}</span>;
}

/** External link ONLY for a validated http(s) url with a parseable host. */
function SourceLink({ url }: { url: string | null }): JSX.Element {
  if (url === null) return <span className="text-slate-300">—</span>;
  const host = hostOf(url);
  if (host === null) return <span className="break-all text-slate-500">{clip(url, 40)}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-700 hover:underline"
    >
      {host} ↗
    </a>
  );
}

function RegistryKeys({ r }: { r: ReconciledSource }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {r.registryKeys.length === 0 && r.enrichment ? (
        <span className={`${BADGE} border-emerald-200 bg-emerald-50 text-emerald-700`}>
          enrichment
        </span>
      ) : null}
      {r.registryKeys.map((k) => (
        <span
          key={k}
          className={`${BADGE} border-slate-200 bg-slate-50 font-mono text-slate-700`}
          title={k.includes(" | ") ? k : undefined}
        >
          {clip(k, 28)}
        </span>
      ))}
      {r.alsoRows.length > 0 ? (
        <span
          className={`${BADGE} border-amber-200 bg-amber-50 text-amber-700`}
          title="This key is also carried by another ledger row"
        >
          also row {r.alsoRows.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function LicenceCell({ r }: { r: ReconciledSource }): JSX.Element {
  const head = clip(r.licenceTerms, 120);
  const long = r.licenceTerms.length > 120;
  return (
    <div className="max-w-[22rem] text-xs text-slate-600">
      {head || "—"}
      {r.licenceTermsTruncated ? <span className="text-slate-400"> (trimmed)</span> : null}
      {long ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-400">full terms</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-slate-500">
            {r.licenceTerms}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function LedgerExtracted({ r }: { r: ReconciledSource }): JSX.Element {
  const badge = ledgerBadge(r);
  return (
    <div>
      <span className="tabular-nums">{r.inListRows === null ? "—" : n(r.inListRows)}</span>
      {badge === "claimed_not_found" ? (
        <span className={`ml-1 ${BADGE} border-rose-200 bg-rose-50 text-rose-700`}>
          claimed, not found in the base
        </span>
      ) : null}
      {badge === "base_exceeds" ? (
        <span
          className={`ml-1 ${BADGE} border-amber-200 bg-amber-50 text-amber-700`}
          title="More registries were merged than the ledger flag records"
        >
          base exceeds the ledger count
        </span>
      ) : null}
    </div>
  );
}

// ---- the view --------------------------------------------------------------

export function SourcesView({
  leads,
  sources,
  searchParams,
}: {
  leads: LeadsPageSnapshot;
  sources: SourcesLoad;
  searchParams: Record<string, string | string[] | undefined>;
}): JSX.Element {
  const filters = parseSourceFilters(searchParams);

  const leadsOk = leads.ok === true;
  const leadsData = leads.ok ? leads.data : null;
  const staleNote = leads.ok ? leads.stale : null;
  const aggs: SourceAgg[] = leadsData ? leadsData.sources : [];
  const totalRows = leadsData ? leadsData.totalRows : 0;

  const ledgerOk = sources.status === "ok";
  const doc = sources.status === "ok" ? sources.doc : null;

  const ledgerMtimeMs = doc ? (doc.ledger.mtimeEpochMs ?? parseUtcStamp(doc.ledger.mtime)) : null;

  const rec = reconcileSources({
    sources: doc ? doc.sources : [],
    wireWarnings: doc ? doc.warnings : [],
    parseWarnings: doc ? doc.parseWarnings : [],
    aggs,
    totalRows,
    sourcesTruncated: leadsData ? leadsData.sourcesTruncated : false,
    sourcesUnreadable: leadsData ? leadsData.sourcesUnreadable : 0,
    baseSourceVersion: leadsData ? leadsData.sourceVersion : null,
    basePublishedAt: leadsData ? leadsData.publishedAt : null,
    ledgerSourceVersion: doc ? doc.sourceVersion : null,
    ledgerMtimeMs,
  });

  const sortKey: "rows" | "name" = filters.sort ?? "rows";
  const sectionA = sortSectionA(applySourceFilters(rec.inBase, filters), sortKey);
  const sectionB = sortSectionB(applySourceFilters(rec.notInBase, filters));

  const anyFilter =
    filters.status !== null ||
    filters.verdict !== null ||
    filters.country !== null ||
    filters.section !== null ||
    filters.q !== null;

  const validated = filterParams(filters);
  const base = "/admin/sources";

  const k = rec.kpis;
  const coverageValue = totalRows > 0 ? `${n(k.coverageRows)} of ${n(totalRows)}` : "0 of 0";

  const warnKinds = new Set<string>();
  for (const w of rec.warnings) warnKinds.add(w.kind);
  if (rec.nearMisses.length > 0) warnKinds.add("near_miss");
  if (rec.parseWarnings.length > 0) warnKinds.add("read");
  const warnCount = rec.warnings.length + rec.nearMisses.length + rec.parseWarnings.length;
  const otherBucketRows = aggs.find((a) => a.registry === "(other)")?.rows ?? 0;

  return (
    <main className="w-full px-3 py-8 sm:px-5">
      {/* Header */}
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        docka admin · private research
      </p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Sources</h1>
      <p className="mt-1 text-sm text-slate-500">
        Where the lead base comes from — and what we found but do not use.
      </p>

      {/* Freshness banner */}
      <div
        data-testid="sources-freshness"
        className="mt-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
      >
        {leadsData ? (
          <p>
            Lead base {leadsData.sourceVersion} generated {leadsData.generatedAt} · published onto
            this box {fmtDateTime(leadsData.publishedAt)}.
          </p>
        ) : null}
        {doc ? (
          <p>
            Source ledger: SOURCE_INDEX.csv last modified {doc.ledger.mtime} ({n(doc.ledger.rows)}{" "}
            rows), published {doc.generatedAt} against lead base {doc.sourceVersion}.
          </p>
        ) : null}
        <p>
          Counts are computed from the lead base on every request. The ledger text refreshes only
          when someone runs handoff_publish_leads.py (--sources-only or a full publish) AND copies
          the file to this box with the printed scp line — that step is manual.
        </p>
        {rec.ledgerAgeDays !== null ? (
          <p
            data-testid="sources-ledger-age"
            className={Math.abs(rec.ledgerAgeDays) > 7 ? "font-semibold text-amber-900" : ""}
          >
            {rec.ledgerAgeDays === 0
              ? "The ledger file is from the same day as the lead base."
              : `The ledger file is ${Math.abs(rec.ledgerAgeDays)} day${
                  Math.abs(rec.ledgerAgeDays) === 1 ? "" : "s"
                } ${rec.ledgerAgeDays > 0 ? "newer" : "older"} than the lead base.`}
          </p>
        ) : null}
      </div>

      {/* State captions */}
      {sources.status === "missing" ? (
        <p
          data-testid="sources-ledger-missing"
          className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"
        >
          No source ledger on this box yet. Run handoff_publish_leads.py --sources-only and copy
          content/docka-sources.json across; the per-registry counts below still come from the lead
          base.
        </p>
      ) : null}
      {sources.status === "invalid" ? (
        <p
          data-testid="sources-ledger-invalid"
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"
        >
          The source ledger file is present but could not be read ({clip(sources.error, 120)}). The
          per-registry counts below still come from the lead base.
        </p>
      ) : null}
      {!leadsOk ? (
        <p
          data-testid="sources-counts-unavailable"
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"
        >
          Lead-base counts are unavailable right now
          {leads.ok === false ? ` (${leads.reason})` : ""}; registry counts cannot be computed until
          the base is readable again.
        </p>
      ) : null}
      {staleNote ? (
        <p
          data-testid="sources-stale"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
        >
          The lead base shown is the last good copy on this box; the latest refresh failed:{" "}
          {clip(staleNote.error, 120)}.
        </p>
      ) : null}
      {rec.versionSkew ? (
        <p
          data-testid="sources-version-skew"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
        >
          The ledger was published against lead base {rec.versionSkew.ledgerVersion}, but the base
          on this box is {rec.versionSkew.baseVersion} — the two clocks disagree.
        </p>
      ) : null}
      {warnCount > 0 ? (
        <p
          data-testid="sources-parse-warnings"
          className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"
        >
          {warnCount} ledger entries were skipped, trimmed or flagged at read:{" "}
          {Array.from(warnKinds).join(", ")}.
        </p>
      ) : null}
      {rec.sourcesTruncated ? (
        <p
          data-testid="sources-buckets-truncated"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
        >
          More than 1,000 distinct registry keys — {n(otherBucketRows)} rows were folded into
          &quot;(other)&quot;; ledger rows for them show as claim-only.
        </p>
      ) : null}
      {rec.sourcesUnreadable > 0 ? (
        <p
          data-testid="sources-unreadable"
          className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"
        >
          {n(rec.sourcesUnreadable)} lead rows could not be decoded for this view and are counted
          under &quot;(unreadable)&quot;; the Leads page is unaffected.
        </p>
      ) : null}

      {/* KPI row */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <Kpi label="Ledger rows" value={n(k.ledgerRows)} />
        <Kpi
          label="Feeding the base"
          value={n(k.feedingBase)}
          sub={`+${n(k.registryOnlyCount)} registry-only`}
          tone="emerald"
        />
        <Kpi
          label="Base rows with a ledger row"
          value={coverageValue}
          sub={`${k.coveragePct} %`}
          tone={k.coveragePct >= 99 ? "emerald" : "slate"}
        />
        <Kpi label="Usable, not merged" value={n(k.usableNotMerged)} tone="amber" />
        <Kpi label="Gated" value={n(k.gated)} tone="amber" />
        <Kpi label="Forbidden" value={n(k.forbidden)} tone="rose" />
        <Kpi label="Dead / not yet / superseded / other" value={n(k.deadNotYetSupersededOther)} />
      </div>

      {/* Filter bar */}
      <div className="mt-6 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-slate-400">Status</span>
          {SOURCE_STATUSES.map((s) => (
            <Chip
              key={s}
              href={toggleParamHref(base, validated, "status", s)}
              active={filters.status === s}
            >
              {STATUS_CHIP[s]}
            </Chip>
          ))}
        </div>
        {rec.verdicts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] uppercase tracking-wide text-slate-400">Verdict</span>
            {rec.verdicts.map((v) => (
              <Chip
                key={v}
                href={toggleParamHref(base, validated, "verdict", v)}
                active={filters.verdict === v}
              >
                {clip(v, 20)}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-slate-400">Section</span>
          {SECTIONS.map((s) => (
            <Chip
              key={s}
              href={toggleParamHref(base, validated, "section", s)}
              active={filters.section === s}
            >
              {s}
            </Chip>
          ))}
        </div>
        {rec.countries.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] uppercase tracking-wide text-slate-400">Country</span>
            {rec.countries.map((c) => (
              <Chip
                key={c}
                href={toggleParamHref(base, validated, "country", c)}
                active={filters.country === c}
              >
                {c}
              </Chip>
            ))}
          </div>
        ) : null}
        <form method="get" className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="text"
            name="q"
            defaultValue={filters.q ?? ""}
            maxLength={40}
            placeholder="search source name"
            className="rounded border border-slate-200 px-2 py-1 text-xs"
          />
          {filters.status !== null ? <input type="hidden" name="status" value={filters.status} /> : null}
          {filters.verdict !== null ? (
            <input type="hidden" name="verdict" value={filters.verdict} />
          ) : null}
          {filters.country !== null ? (
            <input type="hidden" name="country" value={filters.country} />
          ) : null}
          {filters.section !== null ? (
            <input type="hidden" name="section" value={filters.section} />
          ) : null}
          {filters.sort !== null ? <input type="hidden" name="sort" value={filters.sort} /> : null}
          <button
            type="submit"
            className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            Search
          </button>
        </form>
        {anyFilter ? (
          <div data-testid="sources-filter" className="text-xs text-slate-500">
            Filtered
            {filters.status ? ` · status ${STATUS_CHIP[filters.status]}` : ""}
            {filters.verdict ? ` · verdict ${filters.verdict}` : ""}
            {filters.section ? ` · section ${filters.section}` : ""}
            {filters.country ? ` · country ${filters.country}` : ""}
            {filters.q ? ` · “${filters.q}”` : ""} ·{" "}
            <Link href={base} className="text-sky-700 hover:underline">
              show all
            </Link>
          </div>
        ) : null}
        <p data-testid="sources-legend" className="text-[11px] text-slate-400">
          Legend: <b>in base</b> = the base has rows under this source&apos;s registry key(s);{" "}
          <b>claim only</b> = the ledger&apos;s YES flag but no base rows yet; <b>enrichment</b> = a
          wave-2 enrichment pass, not a standalone base. The ledger flag is hand-maintained and is
          shown for reference, never trusted.
        </p>
        <p data-testid="sources-verdict-caption" className="text-[11px] text-slate-400">
          Verdicts (USABLE / GATED / FORBIDDEN / DEAD / …) are our own working assessments of each
          source, not legal advice.
        </p>
      </div>

      {/* Section A — sources we take leads from */}
      <section className="mt-8" data-testid="sources-in-base">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">
            Sources we take leads from ({n(sectionA.length)})
          </h2>
          <div className="text-xs text-slate-500">
            Sort:{" "}
            <Link
              href={toggleParamHref(base, validated, "sort", "rows")}
              className={sortKey === "rows" ? "font-semibold text-sky-700" : "text-slate-500 hover:underline"}
            >
              rows
            </Link>{" "}
            ·{" "}
            <Link
              href={toggleParamHref(base, validated, "sort", "name")}
              className={sortKey === "name" ? "font-semibold text-sky-700" : "text-slate-500 hover:underline"}
            >
              name
            </Link>
          </div>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Any source with rows in the base, a YES ledger flag, or the enrichment sentinel.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className={TH}>Source</th>
                <th className={TH}>Country</th>
                <th className={TH}>Registry key(s)</th>
                <th className={TH}>In base</th>
                <th className={TH}>With email</th>
                <th className={TH}>Sendable</th>
                <th className={TH}>Ledger extracted</th>
                <th className={TH}>Ledger flag</th>
                <th className={TH}>Last extracted</th>
                <th className={TH}>Verdict</th>
                <th className={TH}>Licence terms</th>
                <th className={TH}>Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sectionA.length === 0 ? (
                <tr>
                  <td className={`${TD} text-slate-400`} colSpan={12}>
                    No sources are feeding the base right now.
                  </td>
                </tr>
              ) : (
                sectionA.map((r) => (
                  <tr key={`${r.row}-${r.name}`}>
                    <td className={TD}>
                      <div className="font-medium text-slate-800">{r.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {r.section} · {r.category}
                      </div>
                    </td>
                    <td className={TD}>{r.country || "—"}</td>
                    <td className={TD}>
                      <RegistryKeys r={r} />
                    </td>
                    <td className={`${TD} tabular-nums`}>{r.claimOnly ? "claim only" : n(r.baseRows)}</td>
                    <td className={`${TD} tabular-nums`}>{n(r.baseWithEmail)}</td>
                    <td className={`${TD} tabular-nums`}>{n(r.baseSendable)}</td>
                    <td className={TD}>
                      <LedgerExtracted r={r} />
                    </td>
                    <td className={TD}>
                      <span className={`${BADGE} border-slate-200 bg-slate-100 text-slate-600`}>
                        {r.inListFlag || "—"}
                      </span>
                    </td>
                    <td className={TD}>{r.baseLastExtractedAt ?? "—"}</td>
                    <td className={TD}>
                      <VerdictBadge verdict={r.verdict} />
                    </td>
                    <td className={TD}>
                      <LicenceCell r={r} />
                    </td>
                    <td className={TD}>
                      <SourceLink url={r.url} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Registry-only (in the base, no ledger row) */}
        <div className="mt-6" data-testid="sources-registry-only">
          <h3 className="text-sm font-semibold text-slate-800">
            In the lead base but not in the ledger ({n(rec.registryOnly.length)})
          </h3>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className={TH}>Registry key</th>
                  <th className={TH}>Rows</th>
                  <th className={TH}>With email</th>
                  <th className={TH}>Sendable</th>
                  <th className={TH}>Last extracted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rec.registryOnly.length === 0 ? (
                  <tr>
                    <td className={`${TD} text-slate-400`} colSpan={5}>
                      Every registry in the base has a ledger row.
                    </td>
                  </tr>
                ) : (
                  rec.registryOnly.map((ro) => (
                    <tr key={ro.key}>
                      <td className={`${TD} font-mono text-slate-700`}>
                        {ro.key}
                        {ro.key === "(unknown)" || ro.key === "(unreadable)" || ro.key === "(other)" ? (
                          <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">
                            sentinel
                          </span>
                        ) : null}
                      </td>
                      <td className={`${TD} tabular-nums`}>{n(ro.rows)}</td>
                      <td className={`${TD} tabular-nums`}>{n(ro.withEmail)}</td>
                      <td className={`${TD} tabular-nums`}>{n(ro.sendable)}</td>
                      <td className={TD}>{ro.lastExtractedAt ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Section B — discovered but not in the base */}
      <section className="mt-8" data-testid="sources-not-in-base">
        <h2 className="text-lg font-semibold text-slate-900">
          Discovered but not in the base ({n(sectionB.length)})
        </h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className={TH}>Source</th>
                <th className={TH}>Country</th>
                <th className={TH}>Status</th>
                <th className={TH}>Ledger flag</th>
                <th className={TH}>Ledger extracted</th>
                <th className={TH}>Reason</th>
                <th className={TH}>Last noted</th>
                <th className={TH}>Recorded in</th>
                <th className={TH}>Link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sectionB.length === 0 ? (
                <tr>
                  <td className={`${TD} text-slate-400`} colSpan={9}>
                    Nothing discovered outside the base (or the ledger is not published yet).
                  </td>
                </tr>
              ) : (
                sectionB.map((r) => {
                  const reasonLong =
                    r.accessMethod.length > 160 ||
                    r.licenceTerms.length > 0 ||
                    r.notes.length > 0 ||
                    r.rowsExtracted.length > 0;
                  return (
                    <tr key={`${r.row}-${r.name}`}>
                      <td className={TD}>
                        <div className="font-medium text-slate-800">{r.name}</div>
                        <div className="text-[11px] text-slate-400">
                          {r.section} · {r.category}
                        </div>
                      </td>
                      <td className={TD}>{r.country || "—"}</td>
                      <td className={TD}>
                        <span className={`${BADGE} ${STATUS_TONE[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className={TD}>
                        <span className={`${BADGE} border-slate-200 bg-slate-100 text-slate-600`}>
                          {r.inListFlag || "—"}
                        </span>
                      </td>
                      <td className={`${TD} tabular-nums`}>
                        {r.inListRows === null ? "—" : n(r.inListRows)}
                      </td>
                      <td className={TD}>
                        <div className="max-w-[24rem] text-xs text-slate-600">
                          {clip(r.accessMethod, 160) || "—"}
                          {r.accessMethodTruncated ? (
                            <span className="text-slate-400"> (trimmed)</span>
                          ) : null}
                          {reasonLong ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[11px] text-slate-400">
                                detail
                              </summary>
                              <div className="mt-1 space-y-1 text-[11px] text-slate-500">
                                {r.accessMethod ? (
                                  <p className="whitespace-pre-wrap break-words">
                                    <b>Access:</b> {r.accessMethod}
                                  </p>
                                ) : null}
                                {r.licenceTerms ? (
                                  <p className="whitespace-pre-wrap break-words">
                                    <b>Licence:</b> {r.licenceTerms}
                                    {r.licenceTermsTruncated ? " (trimmed)" : ""}
                                  </p>
                                ) : null}
                                {r.rowsExtracted ? (
                                  <p>
                                    <b>Rows extracted:</b> {r.rowsExtracted}
                                  </p>
                                ) : null}
                                {r.notes ? (
                                  <p className="whitespace-pre-wrap break-words">
                                    <b>Notes:</b> {r.notes}
                                    {r.notesTruncated ? " (trimmed)" : ""}
                                  </p>
                                ) : null}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      </td>
                      <td className={TD}>
                        {r.assessedAt
                          ? `${r.assessedAt}${
                              r.assessedAtBasis === "url_recorded_in" ? " (from url_recorded_in)" : ""
                            }`
                          : "—"}
                      </td>
                      <td className={`${TD} text-[11px] text-slate-500`}>{r.urlRecordedIn || "—"}</td>
                      <td className={TD}>
                        <SourceLink url={r.url} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-10 border-t border-slate-200 pt-4 text-[11px] text-slate-400">
        Read-only. Counts refresh with every lead-base publish; the ledger text refreshes only on a
        manual publish + scp. The ledger flag is displayed, never trusted — the base decides what is
        &quot;in base&quot;.
      </footer>
    </main>
  );
}
