// app/admin/verify-uploads/page.tsx — anonymous upload corpus (plan §7).
//
// Re-checks adminSession() (Layer C; the layout is not a substitute). Renders
// the paginated corpus table FIRST (the page's primary object — thumbnail,
// time, sniffed type, extraction summary, country, outcome, phase, per-row
// Download / Re-run / Delete), then the registry-health panel, then the
// per-country demand panel (the operator's radar for which registry adapter
// to build next — countries with NO adapter are flagged, not hidden).
// Every real view appends one admin-audit line (prefetch-guarded, like the
// drill-down pages); Download / Delete / Re-run are audited in their routes.

import Link from "next/link";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { recordAdminAction } from "@/lib/admin-audit";
import {
  listVerifyUploads,
  type AdminUploadRow,
  type RegistryTraceStep,
} from "@/lib/verify-upload-admin";
import { listRegistryHealth, type CountryHealth } from "@/lib/registry-health";
import { Card, fmtDateTime } from "../ui";
import { ProbeButton, RowActions } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Types an <img> can actually render — PDF/HEIC originals get a chip instead. */
const IMG_TYPES = new Set(["jpeg", "png", "webp", "gif", "bmp"]);

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

function PhaseBadge({ phase }: { phase: string }): JSX.Element {
  const cls =
    phase === "completed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : phase === "deferred"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-slate-200 bg-slate-100 text-slate-500";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {phase}
    </span>
  );
}

/**
 * Compact per-row registry trace: which country registry APIs this item's
 * recognition actually called, in dispatch order — e.g.
 * "EE meremees-api.transpordiamet.ee → no-match · DK verify.dma.dk → error".
 */
/** "skipped-budget" is a sidecar-only synthetic marker — render it readably. */
function traceOutcome(outcome: string): string {
  return outcome === "skipped-budget" ? "skipped (budget)" : outcome;
}

function TraceLine({ trace }: { trace: RegistryTraceStep[] }): JSX.Element {
  if (trace.length === 0) {
    return <div className="mt-0.5 text-[11px] text-slate-400">no registry called</div>;
  }
  const text = trace
    .map((t) => `${t.country ?? t.via}${t.adapterHost ? ` ${t.adapterHost}` : ""} → ${traceOutcome(t.outcome)}`)
    .join(" · ");
  const detail = trace
    .map((t) => `${t.via}${t.country ? ` ${t.country}` : ""}: ${traceOutcome(t.outcome)}`)
    .join("; ");
  return (
    <div className="mt-0.5 text-[11px] text-slate-400" title={detail}>
      {text}
    </div>
  );
}

const VERDICT_CHIP: Record<string, { label: string; cls: string }> = {
  healthy: { label: "Healthy", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  degraded: { label: "Degraded", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  error: { label: "Error", cls: "border-rose-200 bg-rose-50 text-rose-700" },
};

function VerdictChip({ last }: { last: CountryHealth | null }): JSX.Element {
  const chip = last
    ? VERDICT_CHIP[last.verdict] ?? VERDICT_CHIP.degraded
    : { label: "Not probed", cls: "border-slate-200 bg-slate-100 text-slate-500" };
  const detail = last
    ? `${last.outcome} (expected ${last.expected})${last.note ? ` — ${last.note}` : ""}`
    : "This registry has never been probed";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip.cls}`}
      title={detail}
    >
      {chip.label}
    </span>
  );
}

function Thumb({ row }: { row: AdminUploadRow }): JSX.Element {
  if (row.hasDerived || IMG_TYPES.has(row.sniffedType)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/admin/verify-uploads/${row.itemId}/thumbnail`}
        alt=""
        loading="lazy"
        className="h-12 w-12 rounded border border-slate-200 bg-slate-50 object-cover"
      />
    );
  }
  return (
    <span className="inline-flex h-12 w-12 items-center justify-center rounded border border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase text-slate-400">
      {row.sniffedType}
    </span>
  );
}

export default async function AdminVerifyUploadsPage({
  searchParams,
}: {
  searchParams?: { offset?: string };
}): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();
  const email = (session.user.email ?? "").trim().toLowerCase();

  const offset = Math.max(0, Math.floor(Number(searchParams?.offset) || 0));
  const { total, items, demand, undetected } = listVerifyUploads(offset, PAGE_SIZE);
  const health = listRegistryHealth();

  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-list",
    detail: { offset, limit: PAGE_SIZE },
  });

  const prev = offset > 0 ? Math.max(0, offset - PAGE_SIZE) : null;
  const next = offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Verify uploads</h1>
      <p className="mt-1 text-sm text-slate-500">
        Anonymous certificate-upload corpus ({total} documents). Every action here is audited.
      </p>

      {/* The corpus table is the page's primary object — it renders FIRST so the
          operator sees the documents above the fold; the Registry-health and
          Per-country-demand cards follow below it. */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-medium">Doc</th>
              <th className="px-3 py-2 text-left font-medium">Received</th>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Extraction</th>
              <th className="px-3 py-2 text-left font-medium">Country</th>
              <th className="px-3 py-2 text-left font-medium">Outcome</th>
              <th className="px-3 py-2 text-left font-medium">Phase</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  No uploads in the corpus yet.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r.itemId} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Thumb row={r} />
                  </td>
                  <td className="px-3 py-2 text-slate-600" title={r.itemId}>
                    {fmtDateTime(Date.parse(r.receivedAt))}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    <span className="uppercase">{r.sniffedType}</span>
                    <div className="text-xs text-slate-400">{fmtBytes(r.size)}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600" title={r.origName}>
                    {r.summary}
                    <TraceLine trace={r.registryTrace} />
                    {r.lateResult ? (
                      <div
                        className="mt-0.5 text-[11px] text-sky-600"
                        title={`Pipeline completed after the 45 s settle at ${r.lateResult.completedAt} — the registry answered; no re-dispatch needed to see it`}
                      >
                        completed after settle: {r.lateResult.outcome ?? "—"} ·{" "}
                        {r.lateResult.candidateCount} tried
                      </div>
                    ) : null}
                    {r.retryCount > 0 ? (
                      <div className="text-xs text-slate-400" title="Admin re-run attempts">
                        {r.retryCount} re-run{r.retryCount === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.countryDetected ?? "—"}</td>
                  <td
                    className="px-3 py-2 text-slate-600"
                    title={r.deferredReason ?? undefined}
                  >
                    {r.outcome ?? "—"}
                    {r.deferredReason ? (
                      <div className="text-xs text-slate-400">{r.deferredReason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <PhaseBadge phase={r.phase} />
                    {r.skipReason ? (
                      <div className="mt-1">
                        <span
                          className="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-500"
                          title="Why extraction was skipped or failed"
                        >
                          {r.skipReason}
                        </span>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <RowActions itemId={r.itemId} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {prev !== null || next !== null ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {prev !== null ? (
            <Link
              href={`/admin/verify-uploads?offset=${prev}`}
              className="text-slate-600 underline hover:text-slate-900"
            >
              Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-slate-400">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          {next !== null ? (
            <Link
              href={`/admin/verify-uploads?offset=${next}`}
              className="text-slate-600 underline hover:text-slate-900"
            >
              Older
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}

      <div className="mt-6">
        <Card
          title="Registry health"
          subtitle="One row per live registry adapter (derived from countries.ts capabilities). Probe fires that country's documented negative-path test lookup at the real registry — audited, 60 s per-country cooldown."
        >
          {health.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No live registry adapters.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {health.map((h) => (
                <li key={h.country} className="flex flex-wrap items-center gap-3 py-2">
                  {/* min-width (not fixed) — "UA-MARAD" is wider than ISO-2 codes. */}
                  <span className="min-w-[2rem] shrink-0 font-semibold text-slate-800">{h.country}</span>
                  <span
                    className="min-w-0 flex-1 truncate text-slate-600"
                    title={h.authority}
                  >
                    {h.authority}
                  </span>
                  <VerdictChip last={h.last} />
                  <span className="w-36 text-right text-xs text-slate-400">
                    {h.last ? fmtDateTime(Date.parse(h.last.at)) : "—"}
                  </span>
                  {h.hasProbe ? (
                    <ProbeButton country={h.country} />
                  ) : (
                    <span
                      className="text-xs text-slate-300"
                      title="No documented probe input exists for this registry yet"
                    >
                      no probe
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card
          title="Per-country demand"
          subtitle="Keyword-detected issuing countries across the whole corpus — the radar for the next registry adapter."
        >
          {demand.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No detected countries yet.</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm">
              {demand.map((d) => (
                <li
                  key={d.country}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5"
                >
                  <span className="font-medium text-slate-800">{d.countryName}</span>
                  <span className="font-semibold text-slate-600">{d.count}</span>
                  {d.hasAdapter ? null : (
                    <span
                      className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                      title="No registry adapter is wired for this country yet"
                    >
                      no adapter
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-400">No country detected: {undetected}</p>
        </Card>
      </div>
    </div>
  );
}
