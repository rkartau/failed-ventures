import Link from "next/link";
import { readDB } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { listSeafarersForAgent, getDocumentsForAgent } from "@/lib/agentData";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { duplicateNameIndex } from "@/lib/duplicates";
import {
  buildAnalytics,
  compliancePercent,
  type AnalyticsInput,
} from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Small presentational helpers (server-rendered, no client JS needed).
function Kpi({
  label,
  value,
  sub,
  tone = "slate",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
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

export default async function AgentAnalyticsPage() {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  // GRANT-SCOPED roster: the agent sees ONLY seafarers who granted them access
  // (default-deny via lib/agentData.ts). Each seafarer's ACTIVE documents also come
  // through the fail-closed accessor — no raw db.seafarers / db.documents surface
  // here, so a KPI can never count a foreign tenant's crew.
  const db = readDB();
  const visible = listSeafarersForAgent(session.agentId, false);
  const visibleIds = new Set(visible.map((s) => s.id));

  const inputs: AnalyticsInput[] = visible.map((s) => ({
    seafarer: s,
    documents: getDocumentsForAgent(session.agentId, s.id),
    // Own-tenant checklist rows for an already grant-visible seafarer (board pattern).
    docRequests: db.docRequests.filter(
      (r) => r.seafarerId === s.id && r.agentId === session.agentId
    ),
    // Seaman-owned ledger, scoped to the grant-visible set.
    seaService: db.seaService.filter((e) => e.seafarerId === s.id),
  }));

  // Fleet-wide forgery signal for compliance parity with the board — other crew's
  // NAME is masked unless this agent may actually see them (isolation).
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (id) =>
    visibleIds.has(id) ? nameById.get(id) ?? id : "another crew member"
  );

  const requiredConfig = getConfigForAgent(session.agentId);
  const a = buildAnalytics(inputs, { config: requiredConfig, duplicates });
  const pct = compliancePercent(a);

  const complianceTone = pct >= 80 ? "emerald" : pct >= 50 ? "amber" : "rose";
  const maxStage = Math.max(1, ...a.byStage.map((s) => s.count));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Agency analytics</h1>
          <p className="mt-1 text-sm text-slate-500">
            A live cockpit over the {a.rosterSize} seafarer
            {a.rosterSize === 1 ? "" : "s"} who granted you access — pipeline mix,
            compliance, upcoming expiries and outstanding documents, computed from
            what is already on file. Replaces the monthly Excel roll-up.
          </p>
        </div>
        <Link
          href="/agent"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to pipeline
        </Link>
      </div>

      {a.rosterSize === 0 ? (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No crew have granted you access yet. Once a seafarer shares their profile,
          their KPIs appear here automatically.
        </div>
      ) : (
        <>
          {/* Headline KPI row */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Kpi label="Roster" value={a.rosterSize} sub="crew granting you access" />
            <Kpi
              label="Compliance rate"
              value={`${pct}%`}
              sub={`${a.compliance.seaReady} sea-ready · ${a.compliance.blocked} blocked`}
              tone={complianceTone}
            />
            <Kpi
              label="Expiring ≤60 days"
              value={a.expiries.within30 + a.expiries.within60}
              sub={`${a.expiries.crewAffectedSoon} crew to chase`}
              tone={a.expiries.within30 + a.expiries.within60 > 0 ? "amber" : "slate"}
            />
            <Kpi
              label="Expired documents"
              value={a.expiries.expired}
              sub="past legal expiry, on file"
              tone={a.expiries.expired > 0 ? "rose" : "slate"}
            />
            <Kpi
              label="Docs outstanding"
              value={a.docsOutstanding.missingRequired}
              sub={`${a.docsOutstanding.crewWithMissing} crew missing a required doc`}
              tone={a.docsOutstanding.missingRequired > 0 ? "amber" : "slate"}
            />
            <Kpi
              label="Open requests"
              value={a.docsOutstanding.openRequests}
              sub={`${a.docsOutstanding.overdueRequests} overdue`}
              tone={a.docsOutstanding.overdueRequests > 0 ? "rose" : "slate"}
            />
            <Kpi
              label="Avg age in pipeline"
              value={
                a.timeInStage.averageDaysInPipeline === null
                  ? "—"
                  : `${a.timeInStage.averageDaysInPipeline}d`
              }
              sub="since intake"
            />
            <Kpi
              label="At sea"
              value={a.byStage.find((s) => s.state === "sent_to_sea")?.count ?? 0}
              sub="currently sailing"
              tone="emerald"
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {/* Pipeline funnel */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Roster by stage</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Where your crew sit in the pipeline right now.
              </p>
              <ul className="mt-4 space-y-3">
                {a.byStage.map((s) => (
                  <li key={s.state} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-sm text-slate-600">{s.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100">
                      <div
                        className="h-full rounded bg-sky-500"
                        style={{ width: `${(s.count / maxStage) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-sm font-semibold text-slate-800">
                      {s.count}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Compliance breakdown */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Compliance</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Sea-ready = passes the same hard block the board enforces before a man
                advances toward a vessel.
              </p>
              <div className="mt-4">
                <div className="flex h-6 overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${pct}%` }}
                    title={`${a.compliance.seaReady} sea-ready`}
                  />
                  <div
                    className="h-full bg-rose-400"
                    style={{ width: `${100 - pct}%` }}
                    title={`${a.compliance.blocked} blocked`}
                  />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {a.compliance.seaReady} of {a.rosterSize} sea-ready ({pct}%)
                </p>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <dt className="text-xs text-slate-500">Any expired doc</dt>
                  <dd className="font-semibold text-slate-800">{a.compliance.withExpired}</dd>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <dt className="text-xs text-slate-500">Missing required</dt>
                  <dd className="font-semibold text-slate-800">{a.compliance.withMissing}</dd>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <dt className="text-xs text-slate-500">Lapses mid-rotation</dt>
                  <dd className="font-semibold text-slate-800">{a.compliance.withRotationRisk}</dd>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <dt className="text-xs text-slate-500">Possible forgery</dt>
                  <dd className="font-semibold text-slate-800">{a.compliance.withForgery}</dd>
                </div>
                {a.compliance.withRankUnknown > 0 ? (
                  <div className="col-span-2 rounded-lg border border-amber-100 bg-amber-50 p-3">
                    <dt className="text-xs text-amber-700">Rank unknown (required set unconfirmed)</dt>
                    <dd className="font-semibold text-amber-800">
                      {a.compliance.withRankUnknown}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>

            {/* Upcoming expiries */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Upcoming expiries</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Documents by time to their legal (age-adjusted) expiry.
              </p>
              <table className="mt-4 w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {[
                    { label: "Already expired", value: a.expiries.expired, tone: "text-rose-700" },
                    { label: "Within 30 days", value: a.expiries.within30, tone: "text-rose-600" },
                    { label: "31–60 days", value: a.expiries.within60, tone: "text-amber-700" },
                    { label: "61–90 days", value: a.expiries.within90, tone: "text-amber-600" },
                    { label: "More than 90 days", value: a.expiries.later, tone: "text-emerald-700" },
                    { label: "No expiry date", value: a.expiries.noExpiry, tone: "text-slate-500" },
                  ].map((row) => (
                    <tr key={row.label}>
                      <td className="py-2 text-slate-600">{row.label}</td>
                      <td className={`py-2 text-right font-semibold ${row.tone}`}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* Time in pipeline by stage */}
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Time in pipeline</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Average days since intake for crew currently in each stage (best-effort
                from the intake date on file).
              </p>
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-1 text-left font-medium">Stage</th>
                    <th className="py-1 text-right font-medium">Crew</th>
                    <th className="py-1 text-right font-medium">Avg age</th>
                    <th className="py-1 text-right font-medium">Oldest</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {a.timeInStage.byStage.map((s) => (
                    <tr key={s.state}>
                      <td className="py-2 text-slate-600">{s.label}</td>
                      <td className="py-2 text-right text-slate-700">{s.count}</td>
                      <td className="py-2 text-right font-semibold text-slate-800">
                        {s.averageDays === null ? "—" : `${s.averageDays}d`}
                      </td>
                      <td className="py-2 text-right text-slate-500">
                        {s.oldestDays === null ? "—" : `${s.oldestDays}d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <p className="mt-6 text-xs text-slate-400">
            Generated {new Date(a.generatedAt).toLocaleString()} · pilot-scale
            aggregation over the JSON store, grant-scoped to your tenant.
          </p>
        </>
      )}
    </div>
  );
}
