// app/admin/agents/page.tsx — Agents per-stage breakdown + roster.
//
// Re-checks adminSession() (Layer C). Agent.id-keyed per-stage bars (dev-door
// EXCLUDED from the headline counts and shown separately), the empty legacy-google
// "unmapped" note, the loud seed-data caveat, and the roster table.

import Link from "next/link";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { readDB, readAccessLog } from "@/lib/db";
import {
  buildAgentsStages,
  type AgentRow,
  type AgentStageKey,
} from "@/lib/admin-funnel";
import { Card, StageBarList, ProvenanceLegend, ProvenanceBadge, fmtDate } from "../ui";
import { billingTierForAgent, type BillingState } from "@/lib/billing-enforce";
import { healthStaleness, readBillingHealth } from "@/lib/billing-health";
import type { BillingProfile, BillingUsageRow } from "@/lib/db";
import { monthlyRecurringEur, tierStyle } from "@/components/billing-ui";

export const dynamic = "force-dynamic";

// ---- Billing column (plan P6) -------------------------------------------------
//
// Per agent: the live enforcement tier, the Stripe status mirror, the negotiated base
// rate, last computed period quantity, and an MRR-ish figure (base + qty x rate).
// Everything is derived from the SAME billingTierForAgent the runtime enforces with,
// so the roster can never disagree with what an agency actually experiences.

// C7 — the tier swatch and the MRR formula are SHARED with the drill-down page
// (components/billing-ui.ts). The two copies had already drifted apart.

export type BillingCell = {
  state: BillingState;
  profile: BillingProfile | null;
  lastUsage: BillingUsageRow | null;
};

function BillingCells({ cell }: { cell: BillingCell | undefined }): JSX.Element {
  if (!cell) {
    return (
      <>
        <td className="px-3 py-2 text-right text-slate-300">-</td>
        <td className="px-3 py-2 text-right text-slate-300">-</td>
      </>
    );
  }
  const { state, profile, lastUsage } = cell;
  const qty = lastUsage?.quantity ?? null;
  const mrr = monthlyRecurringEur(profile, qty);
  return (
    <>
      <td className="px-3 py-2 text-right">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            tierStyle(state.tier)
          }`}
        >
          {state.tier}
        </span>
        <div className="text-xs text-slate-400">{profile ? profile.subscriptionStatus : "no profile"}</div>
      </td>
      <td className="px-3 py-2 text-right">
        <span className="text-slate-700">{mrr === null ? "-" : `${mrr} EUR`}</span>
        <div className="text-xs text-slate-400">
          {profile ? `${profile.baseEurMonthly} + ${qty ?? 0} x ${profile.perSeafarerEur}` : "-"}
        </div>
      </td>
    </>
  );
}

const TABLE_STAGES: { key: AgentStageKey; short: string }[] = [
  { key: "tenant_created", short: "Created" },
  { key: "first_grant", short: "1st grant" },
  { key: "first_access", short: "1st access" },
  { key: "first_crew_sent", short: "1st crew sent" },
];

function AgentStageCell({
  m,
}: {
  m: { member: boolean; reachedAt: number | null; provenance: "tracked" | "approximated" | "not-tracked" };
}): JSX.Element {
  if (!m.member) return <span className="text-slate-300">—</span>;
  if (m.reachedAt === null) return <ProvenanceBadge provenance="not-tracked" />;
  return <span className="text-slate-700">{fmtDate(m.reachedAt)}</span>;
}

function AgentRowCells({
  row,
  drill,
  billing,
}: {
  row: AgentRow;
  drill: boolean;
  billing?: BillingCell;
}): JSX.Element {
  return (
    <>
      <td className="px-3 py-2">
        {drill ? (
          <Link
            href={`/admin/agents/${encodeURIComponent(row.id)}`}
            className="font-medium text-slate-800 underline hover:text-slate-600"
          >
            {row.displayName}
          </Link>
        ) : (
          <span className="font-medium text-slate-700">{row.displayName}</span>
        )}
        <div className="text-xs text-slate-400">{row.id}</div>
      </td>
      {TABLE_STAGES.map((c) => (
        <td key={c.key} className="px-3 py-2 text-right">
          <AgentStageCell m={row.stages[c.key]} />
        </td>
      ))}
      <td className="px-3 py-2 text-right">
        {row.lastActivity === null ? (
          <ProvenanceBadge provenance="not-tracked" />
        ) : (
          <span className="flex items-center justify-end gap-1">
            <span className="text-slate-700">{fmtDate(row.lastActivity)}</span>
            <ProvenanceBadge provenance="approximated" />
          </span>
        )}
      </td>
      <BillingCells cell={billing} />
    </>
  );
}

export default async function AdminAgentsPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const db = readDB();
  const accessLog = readAccessLog();
  const { stages, rows, devExcluded, unmappedGoogle } = buildAgentsStages(
    db,
    accessLog,
    Date.now()
  );

  // Sort by tenant created date, newest first (row.createdAt is epoch-ms or null).
  // Rows with no valid createdAt sink to the bottom; ties (and both-null) tiebreak
  // by id for a stable, deterministic order.
  const sorted = [...rows].sort((a, b) => {
    const ta = a.createdAt;
    const tb = b.createdAt;
    if (ta !== null && tb !== null) {
      if (tb !== ta) return tb - ta;
      return a.id.localeCompare(b.id);
    }
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return a.id.localeCompare(b.id);
  });

  const health = readBillingHealth();
  const staleness = healthStaleness(health);

  // One pass over the billing collections for the whole roster (no N+1 readDB).
  const now = Date.now();
  const billingByAgent = new Map<string, BillingCell>();
  for (const agent of db.agents) {
    const profile = db.billingProfiles.find((p) => p.agentId === agent.id) ?? null;
    const lastUsage =
      db.billingUsage
        .filter((u) => u.agentId === agent.id)
        .sort((a, b) => b.period.localeCompare(a.period))[0] ?? null;
    billingByAgent.set(agent.id, {
      state: billingTierForAgent(db, agent.id, now),
      profile,
      lastUsage,
    });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Agents</h1>
      <p className="mt-1 text-sm text-slate-500">
        Independent per-stage breakdown, keyed by Agent.id ({rows.length} agent tenant
        {rows.length === 1 ? "" : "s"}, dev-door excluded).
      </p>

      <div className="mt-6">
        <Card
          title="Per-stage breakdown"
          subtitle="Independent per-stage counts (dev-door excluded from these headline numbers). Not a funnel."
        >
          <StageBarList stages={stages} />
          <div className="mt-4">
            <ProvenanceLegend />
          </div>
        </Card>
      </div>

      {/* Billing cron health (plan P7 + R1-10b: staleness computed AT RENDER TIME) */}
      <div className="mt-6">
        <Card
          title="Billing cron"
          subtitle="Month-end usage push + the daily reconcile sweep. Staleness is computed at render time from the last run."
        >
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                staleness.level === "ok"
                  ? "bg-emerald-100 text-emerald-800"
                  : staleness.level === "amber"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-rose-100 text-rose-900"
              }`}
            >
              {staleness.level}
            </span>
            <span className="text-slate-700">{staleness.text}</span>
          </div>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Last period</dt>
              <dd className="text-slate-800">{health.period ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Pushed</dt>
              <dd className="text-slate-800">
                {health.perAgent.filter((a) => a.pushed).length} / {health.perAgent.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Needs attention</dt>
              <dd className="text-slate-800">
                {health.unconfirmedPush.length + health.lateEvents.length} unconfirmed/late
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Warnings</dt>
              <dd className="text-slate-800">
                {health.perAgent.reduce((n, a) => n + a.warnings.length, 0)} usage ·{" "}
                {health.errors.length} error{health.errors.length === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>

          {health.unconfirmedPush.length > 0 ? (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="font-medium">
                Unconfirmed usage pushes — resolve MANUALLY (R1-1/R2-10a)
              </p>
              <p className="mt-0.5 text-xs">
                Check the meter summary in the Stripe dashboard, then POST to
                /api/admin/billing/usage-resolution with action &ldquo;mark-pushed&rdquo; (Stripe
                received it) or &ldquo;clear-attempt&rdquo; (it did not). These are never retried
                automatically — the meter aggregates by SUM, so a blind retry could double-bill.
              </p>
              <ul className="mt-1 text-xs">
                {health.unconfirmedPush.map((u) => (
                  <li key={`${u.agentId}:${u.period}`}>
                    {u.agentId} · {u.period} · attempted {u.attemptedAt}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {health.lateEvents.length > 0 ? (
            <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              <p className="font-medium">Late usage pushes</p>
              <ul className="mt-1 text-xs">
                {health.lateEvents.map((l) => (
                  <li key={`${l.agentId}:${l.period}`}>
                    {l.agentId} · {l.period} · {l.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {health.neverBilled.length > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              Computed but not billed (no live subscription / exempt):{" "}
              {health.neverBilled.map((n) => `${n.agentId} (${n.period})`).join(", ")}
            </p>
          ) : null}
        </Card>
      </div>

      {/* Seed-data reality caveat */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Agent data currently reflects seeded orgs and live Google agents linked to their
        org; agents onboard as they sign in. Live Google agents are only counted here
        once their Agent row carries a Google link — until then their activity will not
        appear in this breakdown.
      </div>

      {/* Roster table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-medium">Agent</th>
              {TABLE_STAGES.map((c) => (
                <th key={c.key} className="px-3 py-2 text-right font-medium">
                  {c.short}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Last activity</th>
              <th className="px-3 py-2 text-right font-medium">Billing</th>
              <th className="px-3 py-2 text-right font-medium">Monthly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50">
                <AgentRowCells row={row} drill billing={billingByAgent.get(row.id)} />
              </tr>
            ))}

            {/* dev-door (excluded) row — separated, clearly not a real agent. */}
            {devExcluded ? (
              <tr className="bg-slate-50/60">
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-500">{devExcluded.displayName}</span>
                  <div className="text-xs text-slate-400">
                    {devExcluded.id} · dev-door (excluded from headline counts)
                  </div>
                </td>
                {TABLE_STAGES.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    <AgentStageCell m={devExcluded.stages[c.key]} />
                  </td>
                ))}
                <td className="px-3 py-2 text-right">
                  {devExcluded.lastActivity === null ? (
                    <span className="text-slate-300">—</span>
                  ) : (
                    fmtDate(devExcluded.lastActivity)
                  )}
                </td>
                {/* The dev-door tenant is structurally billing-exempt (R1-7). */}
                <td className="px-3 py-2 text-right">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">
                    exempt
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-slate-300">—</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Unmapped legacy-google bucket — expected empty today. */}
      <p className="mt-4 text-xs text-slate-400">
        Unmapped legacy Google agents (referenced by data but matching no Agent row):{" "}
        <span className="font-semibold text-slate-600">
          {unmappedGoogle.length === 0 ? "none today" : unmappedGoogle.length}
        </span>
        {unmappedGoogle.length > 0
          ? ` — ${unmappedGoogle.map((u) => u.agentId).join(", ")}`
          : "."}
      </p>
    </div>
  );
}
