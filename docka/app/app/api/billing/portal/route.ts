import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { getPublicBaseUrl } from "@/lib/base-url";
import { getBillingProfileForAgent } from "@/lib/billing-store";
import { createPortalSessionForAgent, stripeConfigured } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// POST /api/billing/portal -> a hosted Stripe Customer Portal URL for the SIGNED-IN
// agent (payment-method update + invoice history). Scoped to session.agentId; a
// body-supplied customer id is never accepted.
//
// R2-5 — the portal always runs on the EXPLICIT configuration created by
// ensureBillingObjects(), which has subscription cancellation switched OFF. Agency
// offboarding is an owner action in the admin/Stripe dashboard, not self-serve.
//
// billing-guard: exempt — like the checkout route, the payment surface must stay
// reachable at every tier so a blocked agency can always fix its payment method.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  if (!stripeConfigured()) {
    return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
  }

  const profile = getBillingProfileForAgent(session.agentId);
  if (!profile?.stripeCustomerId) {
    return NextResponse.json(
      { ok: false, error: "No payment method set up yet — start with “Set up payment”." },
      { status: 409 }
    );
  }

  const url = await createPortalSessionForAgent({
    customerId: profile.stripeCustomerId,
    returnUrl: `${getPublicBaseUrl(req)}/agent/settings/billing`,
  });
  if (!url) {
    return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, url });
}
