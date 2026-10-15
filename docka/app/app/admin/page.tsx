// app/admin/page.tsx — Admin OVERVIEW.
//
// Re-checks adminSession() (Layer C, per-page — the isolation unit). Renders:
//   * a KPI band from buildAnalytics() fed the FULL / UNSCOPED roster (all seafarers),
//     NOT grant-scoped — this is the admin's cross-tenant view.
//   * two INDEPENDENT per-stage breakdown cards (seamen, agents) — bar lists of
//     independent counts, explicitly NOT a funnel.
//   * the canonical Seafarer.state distribution, shown SEPARATELY as the
//     authoritative current position.
//
// F5: the only percentage shown (compliance %) pins its denominator to the roster
// TOTAL (buildAnalytics' compliance.rate = seaReady / rosterSize) — never
// stageN/stage(N-1). The per-stage bars carry no cross-stage conversion.

import Link from "next/link";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "./access";
import { readDB, readAccessLog } from "@/lib/db";
import { buildAnalytics, compliancePercent, type AnalyticsInput } from "@/lib/analytics";
import { duplicateNameIndex } from "@/lib/duplicates";
import { buildSeamenStages, buildAgentsStages } from "@/lib/admin-funnel";
import { SEAFARER_STATES, STATE_LABELS } from "@/lib/pipeline";
import { Card, Kpi, StageBarList, ProvenanceLegend } from "./ui";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const now = Date.now();
  const db = readDB();
  const accessLog = readAccessLog();

  // ---- KPI band: buildAnalytics over the FULL, UNSCOPED roster ----------
  // Unlike the agent page (grant-scoped via lib/agentData), admin builds the
  // AnalyticsInput from the WHOLE db — every seafarer, their ACTIVE (non-archived)
  // documents, all doc-requests, all sea-service. Admin is intentionally un-scoped.
  const activeDocsBySeafarer = new Map<string, typeof db.documents>();
  for (const d of db.documents) {
    if (d.archived === true) continue;
    const arr = activeDocsBySeafarer.get(d.seafarerId);
    if (arr) arr.push(d);
    else activeDocsBySeafarer.set(d.seafarerId, [d]);
  }
  const inputs: AnalyticsInput[] = db.seafarers.map((s) => ({
    seafarer: s,
    documents: activeDocsBySeafarer.get(s.id) ?? [],
    docRequests: db.docRequests.filter((r) => r.seafarerId === s.id),
    seaService: db.seaService.filter((e) => e.seafarerId === s.id),
  }));
  // Fleet-wide forgery signal — admin sees real names for everyone (no masking).
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (id) => nameById.get(id) ?? id);
  const a = buildAnalytics(inputs, { duplicates });
  const pct = compliancePercent(a);
  const complianceTone = pct >= 80 ? "emerald" : pct >= 50 ? "amber" : "rose";

  // A couple of absolute counts buildAnalytics does not compute (F5-safe: absolute,
  // not cross-stage ratios).
  const verifiedIdentities = db.seafarers.filter((s) => s.identityVerified === true).length;
  const pendingGrants = db.accessGrants.filter((g) => g.status === "PENDING").length;
  const atSea = a.byStage.find((s) => s.state === "sent_to_sea")?.count ?? 0;

  // ---- Per-stage breakdowns (independent counts) ------------------------
  const seamen = buildSeamenStages(db, now);
  const agents = buildAgentsStages(db, accessLog, now);

  const maxState = Math.max(1, ...SEAFARER_STATES.map((st) => seamen.stateDist[st]));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            docka admin
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Pipeline overview</h1>
          <p className="mt-1 text-sm text-slate-500">
            Cross-tenant view over all {a.rosterSize} seafarer
            {a.rosterSize === 1 ? "" : "s"} and {db.agents.length} agent tenant
            {db.agents.length === 1 ? "" : "s"} on file. Every figure is aggregated from
            data already persisted — nothing is fabricated.
          </p>
        </div>
      </div>

      {/* KPI band (product-included; buildAnalytics over the unscoped roster) */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Kpi label="Total seamen" value={a.rosterSize} sub="all tenants" />
        <Kpi
          label="Verified identities"
          value={verifiedIdentities}
          sub="government-verified"
          tone="emerald"
        />
        <Kpi
          label="Compliance rate"
          value={`${pct}%`}
          sub={`${a.compliance.seaReady} sea-ready · ${a.compliance.blocked} blocked`}
          tone={complianceTone}
        />
        <Kpi label="At sea now" value={atSea} sub="currently sailing" tone="emerald" />
        <Kpi
          label="Expiring ≤60 days"
          value={a.expiries.within30 + a.expiries.within60}
          sub={`${a.expiries.crewAffectedSoon} crew to chase`}
          tone={a.expiries.within30 + a.expiries.within60 > 0 ? "amber" : "slate"}
        />
        <Kpi
          label="Expired documents"
          value={a.expiries.expired}
          sub="past legal expiry"
          tone={a.expiries.expired > 0 ? "rose" : "slate"}
        />
        <Kpi
          label="Docs outstanding"
          value={a.docsOutstanding.missingRequired}
          sub={`${a.docsOutstanding.crewWithMissing} crew missing a required doc`}
          tone={a.docsOutstanding.missingRequired > 0 ? "amber" : "slate"}
        />
        <Kpi
          label="Grants pending"
          value={pendingGrants}
          sub="awaiting seaman consent"
          tone={pendingGrants > 0 ? "amber" : "slate"}
        />
      </div>

      <div className="mt-6">
        <ProvenanceLegend />
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {/* Seamen per-stage breakdown */}
        <Card
          title="Seamen — per-stage breakdown"
          subtitle="Independent per-stage counts. Stages are not strictly sequential in current data — a seaman can satisfy a later stage without an earlier one."
        >
          <StageBarList stages={seamen.stages} />
          <p className="mt-4 text-xs text-slate-400">
            <Link href="/admin/seamen" className="underline hover:text-slate-600">
              Open the seamen breakdown, integrity notes and roster →
            </Link>
          </p>
        </Card>

        {/* Agents per-stage breakdown */}
        <Card
          title="Agents — per-stage breakdown"
          subtitle="Independent per-stage counts, keyed by Agent.id (dev-door excluded). Reflects seeded orgs and live Google agents linked to their org."
        >
          <StageBarList stages={agents.stages} />
          <p className="mt-4 text-xs text-slate-400">
            <Link href="/admin/agents" className="underline hover:text-slate-600">
              Open the agents breakdown and roster →
            </Link>
          </p>
        </Card>
      </div>

      {/* Canonical state distribution — the AUTHORITATIVE current position */}
      <div className="mt-6">
        <Card
          title="Seafarer.state distribution (authoritative current position)"
          subtitle="The canonical pipeline state each seaman is in right now. Shown separately from the per-stage predicates above — divergence between the two is expected and is the point of the independent-stage model."
        >
          <ul className="mt-4 space-y-3">
            {SEAFARER_STATES.map((st) => (
              <li key={st} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-slate-600">
                  {STATE_LABELS[st]}
                </span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-full rounded bg-indigo-500"
                    style={{ width: `${(seamen.stateDist[st] / maxState) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-sm font-semibold text-slate-800">
                  {seamen.stateDist[st]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <p className="mt-6 text-xs text-slate-400">
        Generated {new Date(now).toLocaleString()} · pilot-scale aggregation over the
        JSON store, cross-tenant (admin is intentionally un-scoped).
      </p>
    </div>
  );
}
