import { NextRequest, NextResponse } from "next/server";
import { constructWebhookEvent, webhookSecret } from "@/lib/stripe";
import { handleStripeEvent, type StripeEventLike } from "@/lib/stripe-webhook";

export const dynamic = "force-dynamic";

// SYSTEM route — the Stripe webhook receiver. NOT agent- or seaman-scoped.
//
// POST /api/stripe/webhook
//
// Trust model: the Stripe SIGNATURE over the RAW request body, verified BEFORE any
// processing (plan §4). It resolves neither the agent-session gate nor the seaman
// gate, so the isolation static guard classifies it "n/a (not agent-facing)" — same
// construction as /api/cron/*. It is also outside middleware (the matcher is
// `/admin/:path*` only), so nothing rewrites or buffers the body.
//
// FAIL-CLOSED: with no STRIPE_WEBHOOK_SECRET this endpoint does nothing at all and
// answers 503 — an unconfigured deployment can never be driven by a forged delivery.
//
// The state machine itself lives in lib/stripe-webhook.ts (three-phase claim ->
// side effects -> mutate+processedAt, R2-2) so it is unit-testable without HTTP.
// A handler failure returns 5xx ON PURPOSE so Stripe redelivers; `processedAt` stays
// null and the redelivery converges the state.

// billing-guard: exempt — a signature-authenticated system endpoint. There is no
// agent session here, so no billing tier applies; blocking it would break the very
// payment webhook that clears a past-due agency.
export async function POST(req: NextRequest) {
  const secret = webhookSecret();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "billing not configured" },
      { status: 503 }
    );
  }

  // RAW body — must be read as text BEFORE any JSON parsing, or the HMAC will not
  // match (precedent for raw reads: api/verify-upload/route.ts:120).
  const raw = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  let event: StripeEventLike;
  try {
    event = (await constructWebhookEvent(raw, signature, secret)) as StripeEventLike;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event);
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // NEVER swallow into a 200 — a 5xx is what makes Stripe redeliver (R1-2c).
    console.error(`STRIPE-WEBHOOK-FAILURE: event ${event?.id} (${event?.type})`, err);
    return NextResponse.json(
      { ok: false, error: "Webhook handler failed; Stripe should retry." },
      { status: 500 }
    );
  }
}
