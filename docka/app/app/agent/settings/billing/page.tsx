import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import {
  ensureBillingProfileForAgent,
  getBillingProfileForAgent,
  getBillingSettings,
  usageForAgent,
  usagePreviewForAgent,
} from "@/lib/billing-store";
import { tallinnPeriodOf } from "@/lib/billing-usage";
import { stripeConfigured } from "@/lib/stripe";
import { BillingSettings } from "@/components/BillingSettings";
import { deriveCheckoutView } from "@/components/billing-ui";

export const dynamic = "force-dynamic";

// The agency's own billing page. Deliberately OUTSIDE the app/agent/(enforced) route
// group (R2-10b): it must stay reachable at EVERY billing tier, including `blocked` —
// otherwise a paywalled agency could never pay its way out.

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: { checkout?: string };
}) {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  await ensureBillingProfileForAgent(session.agentId);
  const profile = getBillingProfileForAgent(session.agentId);
  const settings = getBillingSettings();
  const period = tallinnPeriodOf(Date.now());
  const preview = usagePreviewForAgent(session.agentId, period);

  // R3-6 (D-6) — the Stripe Checkout success_url / cancel_url carry ?checkout=done /
  // =cancelled, which the page previously never read, so a just-paid agent saw the stale
  // "Not set up" until the async webhook landed. Derive the post-checkout THANK-YOU view
  // server-side; emit ONE self-terminating <meta refresh> only while `.showRefresh` is
  // true (the "confirming" state) — bounded, never a client polling loop.
  const checkoutReturn =
    searchParams?.checkout === "done"
      ? "done"
      : searchParams?.checkout === "cancelled"
      ? "cancelled"
      : null;
  const checkoutView = deriveCheckoutView(profile?.subscriptionStatus, checkoutReturn);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {checkoutView.showRefresh ? (
        // Bounded: once the webhook flips the status live, the next render omits this tag.
        <meta httpEquiv="refresh" content="6;url=/agent/settings/billing" />
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your business details, payment method and monthly invoices. Payments are handled
            by Stripe — card and bank details never reach docka.
          </p>
        </div>
        <Link
          href="/agent"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to pipeline
        </Link>
      </div>

      <div className="mt-6">
        <BillingSettings
          profile={profile}
          tosVersion={settings.tosVersion}
          billingLive={Boolean(settings.goLiveAt)}
          stripeReady={stripeConfigured()}
          currentPeriod={{ period, quantity: preview.quantity }}
          usage={usageForAgent(session.agentId, 6)}
          checkoutView={checkoutView}
        />
      </div>
    </div>
  );
}
