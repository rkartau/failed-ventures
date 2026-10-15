import Link from "next/link";
import type { BillingState } from "@/lib/billing-enforce";
import { billingReasonCopy, daysSinceBillingClock } from "@/components/billing-ui";

// The amber strip shown above every /agent page at the `warning` and `readonly` tiers.
// Server component — no state, no interactivity beyond the link to the billing page.

// C7 — the day count and the reason copy are SHARED with the paywall
// (components/billing-ui.ts). The paywall carried its own inline nested ternary, so a
// wording change could land on one surface and silently miss the other.

export function BillingBanner({ state }: { state: BillingState }) {
  const days = daysSinceBillingClock(state.since);
  const readonly = state.tier === "readonly";
  return (
    <div
      className={`border-b px-4 py-3 text-sm ${
        readonly
          ? "border-amber-400 bg-amber-100 text-amber-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
      role="status"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <p>
          <span className="font-semibold">{billingReasonCopy(state)}</span>{" "}
          {readonly ? (
            <>
              Your board is <span className="font-semibold">read-only</span> until this is
              fixed. Your seafarers keep full access to their own data, and nothing has been
              deleted.
            </>
          ) : (
            <>
              Fix it to avoid your board becoming read-only.
              {days !== null ? ` Outstanding for ${days} day${days === 1 ? "" : "s"}.` : ""}
            </>
          )}
        </p>
        <Link
          href="/agent/settings/billing"
          className="shrink-0 rounded-lg border border-amber-500 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-50"
        >
          Open billing
        </Link>
      </div>
    </div>
  );
}
