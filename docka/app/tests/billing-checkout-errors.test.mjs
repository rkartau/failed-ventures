// EXECUTED error-path tests for POST /api/billing/checkout — the REAL route handler,
// driven through the shared in-memory harness (tests/_route-harness.mjs).
//
// Two things are pinned here:
//   1. When the Stripe session setup THROWS, the route no longer emits a bare 500 — it
//      returns a scrubbed JSON `{ ok:false, error }` with status 502, and it NEVER leaks
//      the raw err.message or any secret-key fragment into the body.
//   2. The pre-existing 401/409/400 guards still short-circuit BEFORE the wrapped
//      customer/prices/session block: with a stripe lib that throws on session create,
//      an unauthenticated / already-subscribed / incomplete request is answered by its
//      guard, never by the catch — proving the try/catch wraps only the Stripe block.
//
// Only the edges are stubbed: @/lib/agent-session, @/lib/stripe and @/lib/billing-store.
// The route's OWN control flow (guard ordering + the new try/catch) runs for real, and
// @/lib/billing-onboarding + @/lib/base-url resolve to the real (pure) modules.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-checkout-errors.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { createRouteHarness, API } = await import("./_route-harness.mjs");

// ---- Mutable stub state (each test sets what it needs) ----------------------

let currentSession = null;
let currentProfile = null;
let stripeConfiguredValue = true;
let customerResult = "cus_1";
let pricesResult = { basePriceId: "price_base", usagePriceId: "price_usage" };
let checkoutThrow = null; // an Error/Stripe-shaped object to throw, or null to succeed

// A recognizable secret-like fragment we plant in thrown error messages, then assert is
// NEVER echoed to the client. If it ever appears in a response body the scrub is broken.
const SECRET_FRAGMENT = "sk_live_LEAKED_KEY_9f8e7d";

const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/agent-session": { agentSession: async () => currentSession },
    "@/lib/billing-store": {
      ensureBillingProfileForAgent: async () => currentProfile,
      setBillingStripeRefs: async () => {},
    },
    "@/lib/stripe": {
      stripeConfigured: () => stripeConfiguredValue,
      ensureCustomerForAgent: async () => customerResult,
      ensurePricesForAgent: async () => pricesResult,
      createCheckoutSessionForAgent: async () => {
        if (checkoutThrow) throw checkoutThrow;
        return "https://checkout.stripe.test/cs_ok";
      },
    },
  },
});

const checkoutRoute = loadTs(path.join(API, "billing", "checkout", "route.ts"));

// ---- Fixtures --------------------------------------------------------------

/** A minimal request that satisfies getPublicBaseUrl (no AUTH_URL / no fwd host). */
const req = () => ({
  headers: { get: () => null },
  nextUrl: { origin: "https://docka.me" },
});

const signedInSession = { user: { name: "A" }, agentId: "agent:A" };

/** A fully-onboarded profile: complete business fields, ToS accepted, non-blocking status. */
const completeProfile = () => ({
  agentId: "agent:A",
  subscriptionStatus: "incomplete",
  legalName: "Acme Crewing OÜ",
  regCode: "12345678",
  billingEmail: "billing@acme.example",
  address: { line1: "Sadama 1", city: "Tallinn", postal: "10111", country: "EE" },
  tosAcceptedAt: "2026-08-01T00:00:00.000Z",
  stripeCustomerId: "cus_1",
  stripeBasePriceId: "price_base",
  stripeUsagePriceId: "price_usage",
});

function reset() {
  currentSession = signedInSession;
  currentProfile = completeProfile();
  stripeConfiguredValue = true;
  customerResult = "cus_1";
  pricesResult = { basePriceId: "price_base", usagePriceId: "price_usage" };
  checkoutThrow = null;
}

/** Assert a scrubbed body: never the raw err.message, never any key fragment. */
function assertNoLeak(body) {
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(SECRET_FRAGMENT), "no sk_/key fragment reaches the client");
  assert.ok(!/sk_(live|test)_/.test(serialized), "no Stripe secret-key shape in the body");
  assert.ok(!serialized.includes("ensure the provided type is activated"), "no raw Stripe message text leaks");
  assert.ok(!serialized.includes("internal boom detail"), "no raw generic-error text leaks");
}

// ===========================================================================
// The new error path — a throw becomes a scrubbed 502, not a bare 500
// ===========================================================================

test("checkout 502 (payment-method): a StripeInvalidRequestError about a payment method maps to the actionable hint, scrubbed", async () => {
  reset();
  checkoutThrow = {
    type: "StripeInvalidRequestError",
    message: `payment method type sepa_debit is invalid; ensure the provided type is activated in your dashboard ${SECRET_FRAGMENT}`,
  };

  const res = await checkoutRoute.POST(req());
  assert.equal(res.status, 502, "a Stripe failure is a 502, never a bare 500");
  assert.equal(res.body.ok, false);
  assert.equal(
    res.body.error,
    "Payment could not be started — a payment method needs to be enabled in Stripe.",
    "the specific payment-method hint is returned verbatim"
  );
  assertNoLeak(res.body);
});

test("checkout 502 (generic): any other error maps to the generic retry message, scrubbed", async () => {
  reset();
  checkoutThrow = new Error(`internal boom detail ${SECRET_FRAGMENT}`);

  const res = await checkoutRoute.POST(req());
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "Payment setup failed, please try again.", "generic mapped message");
  assertNoLeak(res.body);
});

test("checkout 502 (generic): a StripeInvalidRequestError NOT about a payment method still gets the generic message", async () => {
  reset();
  // Right type, but the message is unrelated to payment methods — must NOT get the hint.
  checkoutThrow = { type: "StripeInvalidRequestError", message: `no such price price_base ${SECRET_FRAGMENT}` };

  const res = await checkoutRoute.POST(req());
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "Payment setup failed, please try again.");
  assertNoLeak(res.body);
});

// ===========================================================================
// Guard preservation — with the SAME throwing lib, the 401/409/400 guards
// still short-circuit BEFORE the wrapped Stripe block (never reach the catch).
// ===========================================================================

test("guard order: 401 (no session) fires before the wrapped block — throw never reached", async () => {
  reset();
  currentSession = null;
  checkoutThrow = new Error(`should never run ${SECRET_FRAGMENT}`);

  const res = await checkoutRoute.POST(req());
  assert.equal(res.status, 401, "unauthenticated is answered by the 401 guard, not the 502 catch");
  assert.equal(res.body.error, "Sign in as an agent.");
});

test("guard order: 409 (active/past_due) fires before the wrapped block", async () => {
  for (const status of ["active", "past_due"]) {
    reset();
    currentProfile = { ...completeProfile(), subscriptionStatus: status };
    checkoutThrow = new Error(`should never run ${SECRET_FRAGMENT}`);

    const res = await checkoutRoute.POST(req());
    assert.equal(res.status, 409, `${status}: the double-checkout guard answers, not the catch`);
    assert.equal(res.body.status, status);
  }
});

test("guard order: 400 (missing business fields, then missing ToS) fires before the wrapped block", async () => {
  // (a) missing business fields -> 400 with the field list, never the 502.
  reset();
  currentProfile = {
    ...completeProfile(),
    legalName: "  ",
    regCode: "",
    address: { line1: "", city: "", postal: "", country: "" },
  };
  checkoutThrow = new Error(`should never run ${SECRET_FRAGMENT}`);
  const missingFields = await checkoutRoute.POST(req());
  assert.equal(missingFields.status, 400, "incomplete business details are a 400, not a 502");
  assert.equal(missingFields.body.error, "Complete your business details first.");
  assert.ok(Array.isArray(missingFields.body.missing) && missingFields.body.missing.length > 0);

  // (b) business complete but ToS not accepted -> the SEPARATE ToS 400, still before the block.
  reset();
  currentProfile = { ...completeProfile(), tosAcceptedAt: null };
  checkoutThrow = new Error(`should never run ${SECRET_FRAGMENT}`);
  const missingTos = await checkoutRoute.POST(req());
  assert.equal(missingTos.status, 400, "unaccepted ToS is a 400, not a 502");
  assert.equal(missingTos.body.error, "Accept the terms of service first.");
  assert.deepEqual(missingTos.body.missing, ["tosAcceptedAt"]);
});

// A happy-path sanity anchor: with no throw, the route returns the URL — proving the
// tests above pin the error mapping, not a route that is simply always failing.
test("sanity: with no throw the wrapped block returns ok:true + the checkout URL", async () => {
  reset();
  const res = await checkoutRoute.POST(req());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.url, "https://checkout.stripe.test/cs_ok");
});
