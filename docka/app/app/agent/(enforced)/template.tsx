import { redirect } from "next/navigation";
import { agentSession } from "@/lib/agent-session";
import { shouldShowBillingBanner } from "@/lib/billing-enforce";
import { BillingBanner } from "@/components/BillingBanner";
import { BillingPaywall } from "@/components/BillingPaywall";

export const dynamic = "force-dynamic";

// THE PAGE-SIDE BILLING SEAM (plan P5, committed to the ROUTE-GROUP variant by R2-10b).
//
// WHY A TEMPLATE, NOT A LAYOUT (D-A / FINDING 6). App Router PRESERVES layouts across
// `<Link>` navigations — a layout renders once per hard load and is then reused for
// every soft navigation in the session. The gate lived in `layout.tsx`, so an agency
// whose tier flipped to `blocked` mid-session kept browsing its board, page after page,
// with fresh tenant data, until someone happened to hard-reload. Templates re-render on
// EVERY navigation, which is the router-native answer; the file is otherwise unchanged.
//
// ACCEPTED RESIDUAL: Next 14's client Router Cache can still serve a previously-visited
// dynamic segment for up to ~30s without a server round-trip, so the staleness bound is
// <=30s rather than zero — down from "until a hard reload" (unbounded). The API-side 402
// guards (R1-8) bound data access throughout, which is what actually protects the data.
//
// Why a route group and not a pathname check: a server layout/template cannot read the
// current pathname, so "render the paywall everywhere except /agent/settings/billing" is
// not expressible from a single /agent wrapper. The `(enforced)` group solves it
// structurally — every agent page lives inside it, and the billing page deliberately
// sits OUTSIDE it (app/agent/settings/billing) so a blocked agency can always reach the
// one screen that lets it pay.
//
// Route groups do NOT affect URLs: /agent, /agent/[id], /agent/settings/required-docs
// and every other path are byte-identical to before this move.
//
// isolation-guard: exempt — this template resolves the acting agent ONLY to read its
// billing tier. It touches no tenant data at all (no seafarers, no documents, no
// grants); the pages it wraps keep their own fail-closed guards.
//
// billing-guard: exempt — this module IS the billing enforcement seam; guarding it
// with itself would be circular.

export default async function EnforcedAgentTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await agentSession();

  // Not signed in: let the page render its own <SignInGate/> exactly as before.
  if (!session?.user) return <>{children}</>;

  // FIRST-TIME ONBOARDING GATE. A real, resolved, non-exempt agency whose business
  // profile is incomplete or whose ToS is unaccepted is sent to the one screen that
  // lets it self-clear the gate. The boolean is computed in agentSession() from the
  // snapshot it already reads (fail-open there: any error/null path => false), so this
  // template still reads NO profile and makes NO store call. /agent/settings/billing
  // lives OUTSIDE the (enforced) group, so this template never mounts for it => the
  // redirect cannot loop.
  if (session.onboardingIncomplete) {
    redirect("/agent/settings/billing");
  }

  const state = session.billing;

  if (state.tier === "blocked") {
    // The paywall replaces the children entirely. Grants and data are untouched;
    // `invoice.paid` flips the tier back with no restart (decision 6).
    return <BillingPaywall state={state} />;
  }

  return (
    <>
      {shouldShowBillingBanner(state) ? <BillingBanner state={state} /> : null}
      {children}
    </>
  );
}
