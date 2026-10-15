import Link from "next/link";
import { readDB, type Seafarer } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { PrintButton } from "@/components/PrintButton";
import { STATE_LABELS } from "@/lib/pipeline";
import { docStatusForDoc, STATUS_LABELS } from "@/lib/cert";
import { BASE_REQUIRED_DOC_TYPES } from "@/lib/doctypes";
import { assignmentBlockers } from "@/lib/compliance";
import { duplicateNameIndex } from "@/lib/duplicates";
import { evaluateRestHours, MIN_REST_24H, MIN_REST_7D } from "@/lib/rest-hours";
import { listSeafarersForAgent } from "@/lib/agentData";
import { activeDocs } from "@/lib/archive";

export const dynamic = "force-dynamic";

function fmt(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

// PSC/MLC inspection dossier: a printable, per-vessel crew record an inspector can
// be handed on the spot — sea-ready verdict, certificate dossier, and the STCW/MLC
// rest-hours record with ILO work/rest violations highlighted. Optional ?vessel=
// and ?seafarerId= narrow the dossier.
export default async function InspectionPage({
  searchParams,
}: {
  searchParams: { vessel?: string; seafarerId?: string };
}) {
  const session = await agentSession();
  if (!session?.user) return <SignInGate />;

  const db = readDB();
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const dupIndex = duplicateNameIndex(db.documents, (id) => nameById.get(id) ?? id);

  // GRANT-SCOPED roster (fail-closed): the dossier starts from ONLY the seafarers
  // who granted THIS agent live access (default-deny via lib/agentData.ts), never
  // the raw db.seafarers table. A ?seafarerId / ?vessel filter can then only NARROW
  // that already-authorised set — it can never be used to pull another tenant's
  // seafarer into the dossier (previously `db.seafarers.slice()` exposed every
  // tenant's crew by id/vessel to any signed-in agent).
  let crew = listSeafarersForAgent(session.agentId, false);
  if (searchParams.seafarerId) crew = crew.filter((s) => s.id === searchParams.seafarerId);
  if (searchParams.vessel) crew = crew.filter((s) => (s.vessel ?? "") === searchParams.vessel);

  // Group by vessel.
  const groups = new Map<string, Seafarer[]>();
  for (const s of crew.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = s.vessel ?? "(unassigned)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const vessels = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 print:px-0 print:py-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/agent" className="text-sm font-medium text-brand-600 hover:text-brand-800">
          ← Back to dashboard
        </Link>
        <div className="flex items-center gap-2">
          <a
            href="/api/export?report=rest-hours"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Rest-hours CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <header className="mt-4 border-b border-slate-200 pb-4">
        <h1 className="text-2xl font-bold text-slate-900">PSC / MLC inspection dossier</h1>
        <p className="mt-1 text-sm text-slate-500">
          Generated {now} · {crew.length} crew across {vessels.length} vessel(s) ·
          STCW/MLC 2006 rest-hours limits: min {MIN_REST_24H}h in any 24h, {MIN_REST_7D}h in any 7 days.
        </p>
      </header>

      {vessels.length === 0 && (
        <p className="mt-8 text-sm text-slate-500" data-testid="dossier-empty">
          No crew match this dossier.
        </p>
      )}

      {vessels.map((vessel) => (
        <section key={vessel} className="mt-8" data-testid="dossier-vessel" data-vessel={vessel}>
          <h2 className="text-lg font-bold text-slate-900">
            Vessel: <span className="text-brand-700">{vessel}</span>
          </h2>

          {groups.get(vessel)!.map((s) => {
            // ACTIVE docs only — the inspection dossier lists current on-file certs,
            // not archived (retired) documents.
            const docs = activeDocs(db.documents.filter((d) => d.seafarerId === s.id));
            const block = assignmentBlockers(docs, {
              duplicates: dupIndex,
              ownName: s.name,
              rotationEnd: s.rotationEnd ?? null,
              holderDOB: s.birthDate ?? null,
            });
            const restReport = evaluateRestHours(db.restHours.filter((e) => e.seafarerId === s.id));

            return (
              <article
                key={s.id}
                data-testid="dossier-crew"
                data-name={s.name}
                data-sea-ready={block.blocked ? "no" : "yes"}
                className="mt-4 break-inside-avoid rounded-xl border border-slate-200 bg-white p-4 shadow-sm print:shadow-none"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">{s.name}</h3>
                    <p className="text-xs text-slate-500">
                      {s.rank || "—"} · Stage: {STATE_LABELS[s.state]} · Rotation end: {fmt(s.rotationEnd)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
                      block.blocked
                        ? "bg-rose-50 text-rose-700 ring-rose-200"
                        : "bg-emerald-50 text-emerald-700 ring-emerald-200"
                    }`}
                  >
                    Sea-ready: {block.blocked ? "NO" : "YES"}
                  </span>
                </div>

                {block.blocked && (
                  <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">
                    {block.reasons.join("; ")}.
                  </p>
                )}

                {/* Certificate dossier */}
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-left text-xs">
                    <thead>
                      <tr className="text-slate-400">
                        <th className="py-1 pr-3 font-semibold">Required document</th>
                        <th className="py-1 pr-3 font-semibold">On file</th>
                        <th className="py-1 pr-3 font-semibold">Status</th>
                        <th className="py-1 pr-3 font-semibold">Valid until</th>
                        <th className="py-1 font-semibold">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {BASE_REQUIRED_DOC_TYPES.map((rt) => {
                        const d = docs.find((x) => x.requiredType === rt) ?? null;
                        if (!d) {
                          return (
                            <tr key={rt} className="bg-rose-50">
                              <td className="py-1 pr-3 font-semibold text-slate-700">{rt}</td>
                              <td className="py-1 pr-3 font-bold text-rose-700" colSpan={4}>MISSING</td>
                            </tr>
                          );
                        }
                        const st = docStatusForDoc(d, d.validUntil);
                        return (
                          <tr key={d.id} className={st === "expired" ? "bg-rose-50" : ""}>
                            <td className="py-1 pr-3 font-semibold text-slate-700">{rt}</td>
                            <td className="py-1 pr-3 text-slate-700">{d.title}</td>
                            <td className={`py-1 pr-3 ${st === "expired" ? "font-bold text-rose-700" : "text-slate-700"}`}>
                              {STATUS_LABELS[st]}
                            </td>
                            <td className="py-1 pr-3 font-mono text-slate-700">{fmt(d.validUntil)}</td>
                            <td className="py-1 text-slate-500">{d.source}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Rest hours */}
                <div className="mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">
                      STCW/MLC rest hours
                    </h4>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${
                        restReport.entryCount === 0
                          ? "bg-slate-50 text-slate-500 ring-slate-200"
                          : restReport.compliant
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                            : "bg-rose-50 text-rose-700 ring-rose-200"
                      }`}
                    >
                      {restReport.entryCount === 0
                        ? "No rest hours logged"
                        : restReport.compliant
                          ? `Compliant · ${restReport.entryCount} days`
                          : `${restReport.violationCount} ILO violation(s)`}
                    </span>
                  </div>
                  {restReport.days.length > 0 && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[30rem] text-left text-xs">
                        <thead>
                          <tr className="text-slate-400">
                            <th className="py-1 pr-3 font-semibold">Date</th>
                            <th className="py-1 pr-3 font-semibold">Rest 24h</th>
                            <th className="py-1 pr-3 font-semibold">Rest 7d</th>
                            <th className="py-1 font-semibold">ILO work/rest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {restReport.days.map((d) => (
                            <tr key={d.date} className={d.violations.length ? "bg-rose-50" : ""}>
                              <td className="py-1 pr-3 font-mono text-slate-700">{d.date}</td>
                              <td className={`py-1 pr-3 ${d.hoursRest < MIN_REST_24H ? "font-bold text-rose-700" : "text-slate-700"}`}>
                                {d.hoursRest}h
                              </td>
                              <td className="py-1 pr-3 text-slate-700">
                                {d.daysIn7dWindow >= 7 ? `${d.rest7d}h` : "—"}
                              </td>
                              <td className="py-1">
                                {d.violations.length === 0 ? (
                                  <span className="text-emerald-600">OK</span>
                                ) : (
                                  <span className="font-semibold text-rose-700">{d.violations.join("; ")}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}
