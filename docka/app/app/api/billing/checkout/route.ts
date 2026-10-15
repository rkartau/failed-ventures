import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { getPublicBaseUrl } from "@/lib/base-url";
import { missingProfileFields } from "@/lib/billing-onboarding";
import {
  ensureBillingProfileForAgent,
  setBillingStripeRefs,
} from "@/lib/billing-store";
import {
  createCheckoutSessionForAgent,
  ensureCustomerForAgent,
  ensurePricesForAgent,
  stripeConfigured,
} from "@/lib/stripe";

export const dynamic = "force-dynamic";

// POST /api/billing/checkout -> a hosted Stripe Checkout URL for the SIGNED-IN agent.
//
// Everything is keyed by session.agentId — a body-supplied agent id is never trusted.
// Card details never reach this app; the agent is redirected to Stripe's hosted page.
//
// R1-4 / R2-7 — DOUBLE-CHECKOUT GUARD: 409 when the agency already holds an `active`
// or `past_due` subscription (the UI then points at the Customer Portal). `incomplete`
// deliberately does NOT block: the stale session expires on its own (R1-5) and a second
// completed checkout is caught by the webhook's liveness-checked duplicate guard (R3-1).
//
// billing-guard: exempt — the billing surface itself must stay reachable at EVERY
// tier, or a blocked agency could never pay its way out (plan §6 kill-switch rule).
export async function POST(req: NextRequest) {
  const session = await agentSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  if (!stripeConfigured()) {
    return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
  }

  // C5 — create-if-absent RETURNS the profile; the re-read and its unreachable null
  // branch were copy-paste.
  const profile = await ensureBillingProfileForAgent(session.agentId);

  if (profile.subscriptionStatus === "active" || profile.subscriptionStatus === "past_due") {
    return NextResponse.json(
      {
        ok: false,
        error: "Billing is already set up — use “Manage payment & invoices” instead.",
        status: profile.subscriptionStatus,
      },
      { status: 409 }
    );
  }

  const missing = missingProfileFields(profile);
  if (missing.length > 0) {
    return NextResponse.json(
      { ok: false, error: "Complete your business details first.", missing },
      { status: 400 }
    );
  }
  if (!profile.tosAcceptedAt) {
    return NextResponse.json(
      { ok: false, error: "Accept the terms of service first.", missing: ["tosAcceptedAt"] },
      { status: 400 }
    );
  }

  // Stripe object creation happens OUTSIDE any db critical section (R2-2 standing rule).
  // Wrapped so a Stripe failure (e.g. a payment method the live account has not enabled)
  // surfaces as a real JSON error the client can render, never a bare 500. The 401/503/
  // 409/400 guards above run BEFORE this block and are intentionally left outside it.
  try {
    const customerId = await ensureCustomerForAgent(profile);
    if (!customerId) {
      return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
    }
    if (customerId !== profile.stripeCustomerId) {
      await setBillingStripeRefs(session.agentId, { stripeCustomerId: customerId });
    }

    const prices = await ensurePricesForAgent({ ...profile, stripeCustomerId: customerId });
    if (!prices) {
      return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
    }
    if (
      prices.basePriceId !== profile.stripeBasePriceId ||
      prices.usagePriceId !== profile.stripeUsagePriceId
    ) {
      await setBillingStripeRefs(session.agentId, {
        stripeBasePriceId: prices.basePriceId,
        stripeUsagePriceId: prices.usagePriceId,
      });
    }

    const base = getPublicBaseUrl(req);
    const url = await createCheckoutSessionForAgent({
      profile: { ...profile, stripeCustomerId: customerId },
      customerId,
      basePriceId: prices.basePriceId,
      usagePriceId: prices.usagePriceId,
      successUrl: `${base}/agent/settings/billing?checkout=done`,
      cancelUrl: `${base}/agent/settings/billing?checkout=cancelled`,
    });
    if (!url) {
      return NextResponse.json({ ok: false, error: "billing not configured" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, url });
  } catch (err: any) {
    // Full detail to the server log ONLY — never into the HTTP body.
    console.error("[billing/checkout] Stripe session setup failed", err);
    // Fixed, scrubbed messages: err.message is NEVER interpolated (it can carry Stripe
    // request internals / ids). A payment-method misconfiguration gets an actionable hint;
    // everything else gets a generic retry message.
    const isPaymentMethodError =
      err?.type === "StripeInvalidRequestError" &&
      typeof err?.message === "string" &&
      /payment method/i.test(err.message);
    const error = isPaymentMethodError
      ? "Payment could not be started — a payment method needs to be enabled in Stripe."
      : "Payment setup failed, please try again.";
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
