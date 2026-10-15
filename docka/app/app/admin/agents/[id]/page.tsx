// app/admin/agents/[id]/page.tsx — Per-agent drill-down (+ the ONE audit write).
//
// Same security-critical order as the seaman drill-down (plan §4.4 / F1):
// gate → resolve subject (notFound() on miss, NO audit line) → prefetch-guarded
// recordAdminAccess (exactly one line per real view) → render org header + timeline.

import Link from "next/link";
import { notFound } from "next/navigation";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../../access";
import { recordAdminAccess } from "@/lib/admin-audit";
import { TakeOverButton } from "@/components/TakeOverButton";
import { AdminBillingEditor } from "@/components/AdminBillingEditor";
import { readDB, readAccessLog, readConsentEvents } from "@/lib/db";
import { buildUserTimeline } from "@/lib/admin-funnel";
import { billingTierForAgent } from "@/lib/billing-enforce";
import { usageForAgent } from "@/lib/billing-store";
import { stripeTestMode } from "@/lib/stripe";
import { Timeline } from "../../ui";
import { fmtBillingDate, monthlyRecurringEur, tierStyle } from "@/components/billing-ui";

export const dynamic = "force-dynamic";

// C7 — tier swatch, date format and MRR come from components/billing-ui.ts, shared
// with the roster page (the two TIER_STYLE copies had already drifted).
const fmtIso = fmtBillingDate;

export default async function AdminAgentDrilldownPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const id = decodeURIComponent(params.id);
  const db = readDB();
  const agent = db.agents.find((a) => a.id === id);
  if (!agent) notFound();

  await recordAdminAccess({
    adminEmail: session.user.email ?? "",
    view: "agent-drilldown",
    subjectKind: "agent",
    subjectId: agent.id,
  });

  const accessLog = readAccessLog();
  const consent = readConsentEvents();
  const { dated, undated } = buildUserTimeline(db, accessLog, consent, "agent", agent.id);

  // Billing (plan P6). The page view is already audited above via recordAdminAccess.
  const billingProfile = db.billingProfiles.find((p) => p.agentId === agent.id) ?? null;
  const billingState = billingTierForAgent(db, agent.id);
  const billingUsage = usageForAgent(agent.id, 3);
  const stripeBase = stripeTestMode()
    ? "https://dashboard.stripe.com/test/customers/"
    : "https://dashboard.stripe.com/customers/";
  const mrr = monthlyRecurringEur(billingProfile, billingUsage[0]?.quantity ?? null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <p className="text-xs text-slate-400">
        <Link href="/admin/agents" className="underline hover:text-slate-600">
          ← Back to agents
        </Link>
      </p>

      {/* Org header */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">{agent.orgName}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {agent.id}
          {agent.contact ? ` · ${agent.contact}` : ""}
          {agent.id === "dev" ? " · dev-door tenant (not a real agent)" : ""}
        </p>

        {/* Admin take-over / act-as control. */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <TakeOverButton targetKind="agent" targetId={agent.id} />
        </div>
      </div>

      {/* Billing */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Billing</h2>
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              tierStyle(billingState.tier)
            }`}
          >
            {billingState.tier}
            {billingState.reason && billingState.tier !== "ok" ? ` · ${billingState.reason}` : ""}
          </span>
        </div>

        {billingProfile ? (
          <>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Subscription</dt>
                <dd className="text-slate-800">{billingProfile.subscriptionStatus}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Rates</dt>
                <dd className="text-slate-800">
                  {billingProfile.baseEurMonthly} EUR/mo + {billingProfile.perSeafarerEur} EUR/seafarer
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Payment method</dt>
                <dd className="text-slate-800">
                  {billingProfile.paymentMethodAttached ? "attached" : "none"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">
                  Estimated monthly (last period)
                </dt>
                <dd className="text-slate-800">{mrr === null ? "—" : `${mrr} EUR`}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Past due since</dt>
                <dd className="text-slate-800">{fmtIso(billingProfile.pastDueSince)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Cancelled at</dt>
                <dd className="text-slate-800">{fmtIso(billingProfile.canceledAt)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Billing required since</dt>
                <dd className="text-slate-800">{fmtIso(billingProfile.billingRequiredSince)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Billable from</dt>
                <dd className="text-slate-800">{fmtIso(billingProfile.billingActiveFrom)}</dd>
              </div>
            </dl>

            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Last periods
              </h3>
              {billingUsage.length === 0 ? (
                <p className="mt-1 text-sm text-slate-500">No usage computed yet.</p>
              ) : (
                <table className="mt-1 w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="py-1">Period</th>
                      <th className="py-1">Billable</th>
                      <th className="py-1">Pushed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billingUsage.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100">
                        <td className="py-1.5 text-slate-800">{row.period}</td>
                        <td className="py-1.5 text-slate-800">{row.quantity}</td>
                        {/* N2 — a CLOSED month is a first-class ledger state (D-G), and
                            R1-6(b) says it must be visible. Reading only
                            `pushedToStripeAt` here showed every closed month as "—",
                            indistinguishable from one the cron has not reached yet. */}
                        <td className="py-1.5 text-slate-600">
                          {row.pushedToStripeAt ? (
                            fmtIso(row.pushedToStripeAt)
                          ) : row.pushAttemptedAt ? (
                            "attempted, unconfirmed"
                          ) : row.closedAs ? (
                            <>
                              <span className="text-slate-700">
                                {row.closedAs === "never-billed" ? "never billed" : "no usage"}
                              </span>
                              {row.closedReason ? (
                                <span className="block text-xs text-slate-400">{row.closedReason}</span>
                              ) : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {billingProfile.stripeCustomerId ? (
              <p className="mt-3 text-xs text-slate-500">
                <a
                  href={`${stripeBase}${billingProfile.stripeCustomerId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-slate-700"
                >
                  Open in Stripe ({billingProfile.stripeCustomerId})
                </a>
              </p>
            ) : null}

            <AdminBillingEditor
              agentId={agent.id}
              baseEurMonthly={billingProfile.baseEurMonthly}
              perSeafarerEur={billingProfile.perSeafarerEur}
              exemptFromBilling={billingProfile.exemptFromBilling}
              hasSubscription={Boolean(billingProfile.stripeSubscriptionId)}
            />
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            No billing profile yet — one is created on this agency&rsquo;s first sign-in
            after billing go-live.
          </p>
        )}
      </div>

      {/* Timeline */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Timeline</h2>
        <p className="mt-0.5 mb-4 text-xs text-slate-500">
          Tenant creation, grants received, access-log actions and assignments, in
          ascending order.
        </p>
        <Timeline dated={dated} undated={undated} />
      </div>
    </div>
  );
}
