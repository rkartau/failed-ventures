import Link from "next/link";
import type { BillingState } from "@/lib/billing-enforce";
import { billingReasonCopy, fmtBillingDate } from "@/components/billing-ui";

// Rendered INSTEAD of the agency's pages at the `blocked` tier. Deliberately calm and
// explicit about what has NOT happened: this is a paywall, not a data change.

// C7 — the date format and the reason copy come from components/billing-ui.ts, shared
// with the banner.

export function BillingPaywall({ state }: { state: BillingState }) {
  const since = fmtBillingDate(state.since, "");
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Crewing agent
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Your dashboard is paused</h1>
        <p className="mt-3 text-sm text-slate-700">
          {billingReasonCopy(state)}
          {since ? ` Outstanding since ${since}.` : ""}
        </p>

        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          <li>· Nothing has been deleted, and no seafarer&rsquo;s consent has been revoked.</li>
          <li>· Your seafarers keep full access to their own profiles and documents.</li>
          <li>· Your share links and shipowner portals are still live.</li>
          <li>· Access to your board returns immediately once payment succeeds.</li>
        </ul>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/agent/settings/billing"
            className="rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Fix payment
          </Link>
          <a
            href="mailto:hello@docka.me?subject=Billing"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Contact docka
          </a>
        </div>
      </div>
    </div>
  );
}
