// lib/stripe.ts — the ONE module that owns outbound Stripe calls
// (STRIPE-BILLING-PLAN.md P3, with R1-4/R1-5, R2-1/R2-5/R2-7, R3-1/R3-2/R3-3 folded).
//
// Shape borrowed from two house precedents:
//   * lib/notify.ts:89-130 — a LAZY, cached client that degrades gracefully when the
//     environment is not configured. No STRIPE_SECRET_KEY (or no `stripe` package on
//     the box) => getStripe() returns null and every caller answers 503 "billing not
//     configured". The rest of the app is completely unaffected.
//   * lib/registry/index.ts — a lib module that owns the outbound calls so routes
//     never talk to a third party directly.
//
// STANDING RULE (R2-2), repeated because it is the one that bites: NEVER await any
// function in this file from inside `updateDB`/`transact`. The store mutex is
// process-wide; a Stripe round-trip inside it stalls every other writer.
//
// CARD DATA NEVER TOUCHES THIS APP: hosted Checkout + hosted Customer Portal only.
// We persist Stripe object ids and a status mirror, never a PAN, IBAN or mandate.

import type StripeNS from "stripe";
import { getBillingSettings, saveBillingSettings, setBillingStripeRefs } from "@/lib/billing-store";
import type { BillingProfile, BillingSubscriptionStatus } from "@/lib/db";

/**
 * PINNED API version — the SDK's own default for the pinned `stripe` 22.5.0. Upgrading
 * either is a deliberate commit (plan §6 "Stripe API version drift"), never a drift.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia";

/** The shared Billing Meter's event name — one meter for the whole account. */
export const METER_EVENT_NAME = "billable_seafarers";

const HOUR_MS = 3600_000;

// ---- Lazy client --------------------------------------------------------------

// `null` = not built yet; `false` = tried and unavailable (never retried).
let cachedClient: StripeNS | null | false = null;

export function stripeConfigured(): boolean {
  return Boolean((process.env.STRIPE_SECRET_KEY ?? "").trim());
}

export function webhookSecret(): string {
  return (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
}

/** True when the account is in TEST mode (drives the admin "open in Stripe" deep link). */
export function stripeTestMode(): boolean {
  return !(process.env.STRIPE_SECRET_KEY ?? "").trim().startsWith("sk_live_");
}

/**
 * Owner decision (2026-08-20): docka is a small Estonian OÜ with NO VAT registration
 * and does NOT charge VAT for now, so Stripe Tax is OPTIONAL and OFF by default. This
 * is the one place `STRIPE_TAX_ENABLED` is read; the checkout params gate both
 * `automatic_tax` and `tax_id_collection` on it. Unset/anything-else = OFF (no VAT, and
 * the integration does NOT depend on Stripe Tax being enabled on the Stripe account).
 * When the owner registers for VAT they set `STRIPE_TAX_ENABLED=1` (or `"true"`) in the
 * environment — no code change, deviating from plan §0.1 by explicit owner approval.
 */
export function taxEnabled(): boolean {
  const v = (process.env.STRIPE_TAX_ENABLED ?? "").trim();
  return v === "1" || v === "true";
}

/**
 * The cached Stripe client, or null when billing is not configured. Lazy-imported so
 * a build / a code path that never bills does not load the SDK, and a box missing the
 * package degrades to "not configured" instead of crashing on import (notify.ts rule).
 */
export async function getStripe(): Promise<StripeNS | null> {
  if (cachedClient !== null) return cachedClient === false ? null : cachedClient;
  if (!stripeConfigured()) {
    cachedClient = false;
    return null;
  }
  try {
    const mod = (await import("stripe")) as unknown as {
      default?: new (key: string, opts: unknown) => StripeNS;
    };
    const Ctor = (mod.default ?? (mod as unknown)) as new (key: string, opts: unknown) => StripeNS;
    const client = new Ctor((process.env.STRIPE_SECRET_KEY ?? "").trim(), {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      appInfo: { name: "docka", url: "https://docka.me" },
    });
    cachedClient = client;
    return client;
  } catch {
    cachedClient = false;
    return null;
  }
}

/**
 * Verify a webhook delivery and return the parsed event. Uses the SDK's
 * `constructEvent` over the RAW body — pure crypto, NO network — so it works even
 * when only STRIPE_WEBHOOK_SECRET is set. Throws on a bad signature; the route
 * answers 400 and never processes anything it could not verify.
 */
export async function constructWebhookEvent(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<unknown> {
  const mod = (await import("stripe")) as unknown as {
    default?: new (key: string, opts: unknown) => StripeNS;
  };
  const Ctor = (mod.default ?? (mod as unknown)) as new (key: string, opts: unknown) => StripeNS;
  // The key is irrelevant to signature verification (constructEvent is HMAC only);
  // a placeholder keeps verification working on a box configured for webhooks only.
  const client = new Ctor((process.env.STRIPE_SECRET_KEY ?? "").trim() || "sk_test_signature_verification_only", {
    apiVersion: STRIPE_API_VERSION,
  });
  return client.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/** Test hook — drops the memoised client so a test can flip the environment. */
export function __resetStripeClient(): void {
  cachedClient = null;
  ensureOnce = null;
}

/**
 * F5-T1, TEST-ONLY — inject a fake Stripe client so the OUTBOUND CALL SHAPE can be
 * asserted without a network or a key. R3-3a mandates that the portal session always
 * passes our explicit configuration id (the account default would re-open the R2-5
 * cancel-and-ride-free hole), and nothing proved it: the only way to prove a call's
 * arguments is to capture them.
 */
export function __setStripeClientForTests(client: unknown): void {
  cachedClient = (client as StripeNS | null) ?? null;
  ensureOnce = null;
}

// ---- Status mapping (R2-7 / R3-5) ---------------------------------------------
//
// D-5: the mapping and the liveness predicate live in `@/lib/billing-status` (a pure
// module that imports nothing from here or from billing-store, so there is no cycle).
// They are imported for internal use below AND re-exported so stripe-webhook.ts,
// billing-reconciler.ts and the F2 status test keep importing them from `@/lib/stripe`
// with no import-line change (R3-FR1-4).
import { isLiveStripeStatus, mapStripeStatus } from "@/lib/billing-status";
export { isLiveStripeStatus, mapStripeStatus };

// ---- One status-effect chain (finding 21 / R2-7) ------------------------------

/**
 * The ONE place a mapped subscription status turns into profile fields. Both the
 * webhook and the daily reconciler call it, so the two can no longer drift:
 *
 *   active    -> clear the past-due clock AND the cancel stamp;
 *   past_due  -> START the clock, and NEVER null it (finding 11: the reconciler used
 *                to clear `pastDueSince` whenever the latest invoice read `paid` even
 *                while the subscription itself was still past_due, which dropped the
 *                tier clock back to a months-old `billingRequiredSince` and BLOCKED the
 *                agency instantly, skipping the whole 14/30-day ladder);
 *   canceled  -> stamp `canceledAt`, KEEP the subscription id for audit (R3-1: a
 *                re-subscribe adopts over it);
 *   none      -> incomplete_expired: CLEAR the id (when it is the one we observed) so
 *                the reconciler's adoption and a fresh checkout both apply cleanly.
 *
 * `paymentMethodAttached` is applied ONLY when the caller actually observed it — the
 * webhook sees it on `customer.subscription.*` payloads, the reconciler on the fetched
 * subscription, and neither may guess for the other.
 */
export function applyMappedStatus(
  profile: BillingProfile,
  mapped: BillingSubscriptionStatus,
  opts: {
    nowIso: string;
    /** The subscription the caller observed, for the `none` id-clearing check. */
    subscriptionId?: string | null;
    /** Only pass this when the caller genuinely observed the payment method. */
    paymentMethodAttached?: boolean;
  }
): Partial<BillingProfile> {
  const patch: Partial<BillingProfile> = { subscriptionStatus: mapped };
  if (opts.paymentMethodAttached !== undefined) {
    patch.paymentMethodAttached = opts.paymentMethodAttached;
  }
  if (mapped === "active") {
    patch.pastDueSince = null;
    patch.canceledAt = null;
  } else if (mapped === "past_due") {
    // The escalation clock runs from the FIRST failure and is never restarted or
    // cleared while the subscription is still past_due.
    patch.pastDueSince = profile.pastDueSince ?? opts.nowIso;
  } else if (mapped === "canceled") {
    patch.canceledAt = profile.canceledAt ?? opts.nowIso;
  } else if (mapped === "none") {
    const subId = opts.subscriptionId ?? null;
    if (!subId || subId === profile.stripeSubscriptionId) patch.stripeSubscriptionId = null;
    patch.canceledAt = null;
  }
  return patch;
}

// ---- Anchor + checkout-window math (R2-1, R1-5 restated by R3-2) --------------

/** Stripe's hard bounds on a Checkout session lifetime. */
export const CHECKOUT_MIN_LIFETIME_MS = 30 * 60_000;
export const CHECKOUT_MAX_LIFETIME_MS = 24 * HOUR_MS;
/** Keep the session from outliving the anchor it was priced against. */
export const ANCHOR_SAFETY_MARGIN_MS = 15 * 60_000;
/**
 * R3-2's "~35 min" stale-anchor guard, widened to 45 min so that
 * `anchor - 15min` can never fall below Stripe's 30-minute minimum session lifetime.
 * Same intent (never hand out an anchor the session could outlive), but the resulting
 * `expires_at` is always a value the API will actually accept.
 */
export const MIN_ANCHOR_WINDOW_MS = 45 * 60_000;

/** 00:00 UTC on the 1st strictly after `ms` (R2-1: UTC never shifts with DST). */
function firstOfNextUtcMonth(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1, 0, 0, 0);
}

/**
 * The `billing_cycle_anchor` for a checkout started at `nowMs`: 00:00 UTC on the next
 * 1st (which is 02:00/03:00 Tallinn — still "the 1st", decision 5), rolled to the
 * FOLLOWING 1st when the window is too short to host a valid Checkout session.
 * Returned in UNIX SECONDS, which is what Stripe wants.
 */
export function nextUtcAnchorSec(nowMs: number = Date.now()): number {
  let anchor = firstOfNextUtcMonth(nowMs);
  if (anchor - nowMs < MIN_ANCHOR_WINDOW_MS) anchor = firstOfNextUtcMonth(anchor);
  return Math.floor(anchor / 1000);
}

/**
 * Checkout `expires_at` (unix seconds): `min(now + 24h, anchor - 15min)`, clamped up to
 * Stripe's 30-minute floor. A session created at 23:50 on the 31st therefore cannot be
 * completed after midnight against a now-past anchor (R1-5).
 */
export function checkoutExpiresAtSec(nowMs: number = Date.now(), anchorSec?: number): number {
  const anchorMs = (anchorSec ?? nextUtcAnchorSec(nowMs)) * 1000;
  const target = Math.min(nowMs + CHECKOUT_MAX_LIFETIME_MS, anchorMs - ANCHOR_SAFETY_MARGIN_MS);
  const floor = nowMs + CHECKOUT_MIN_LIFETIME_MS;
  return Math.floor(Math.max(target, floor) / 1000);
}

/**
 * R2-1 + R3-2 — the meter event `timestamp`, in unix seconds:
 *
 *   tallinnMonthEnd <= timestamp <= min(now, current_period_end - 60s)
 *
 * The Tallinn month closes 1-3h BEFORE the Stripe UTC period does, so the cron's first
 * attempt (~00:20 Tallinn on the 1st) lands INSIDE the still-open period and there is
 * no finalization race at all. If `now >= current_period_end` the push is LATE and
 * follows R1-1's manual-reconciliation path instead of guessing.
 */
export function meterEventTimestampSec(input: {
  nowMs: number;
  tallinnMonthEndMs: number;
  currentPeriodEndSec: number | null;
}): { ok: true; timestamp: number } | { ok: false; reason: "late" | "no-period" } {
  const { nowMs, tallinnMonthEndMs, currentPeriodEndSec } = input;
  if (!currentPeriodEndSec || !Number.isFinite(currentPeriodEndSec)) {
    return { ok: false, reason: "no-period" };
  }
  const periodEndMs = currentPeriodEndSec * 1000;
  if (nowMs >= periodEndMs) return { ok: false, reason: "late" };
  const upperMs = periodEndMs - 60_000;
  const lowerMs = tallinnMonthEndMs;
  if (lowerMs > upperMs) return { ok: false, reason: "late" };
  const clamped = Math.max(lowerMs, Math.min(nowMs, upperMs));
  return { ok: true, timestamp: Math.floor(clamped / 1000) };
}

// ---- Shared account objects (products + meter + portal config) ----------------

export type BillingObjects = {
  baseProductId: string;
  usageProductId: string;
  meterId: string;
  portalConfigId: string;
};

// R3-3b — in-process once-promise so a burst of first checkouts creates ONE set.
let ensureOnce: Promise<BillingObjects | null> | null = null;

/**
 * Create (once) the shared Products, the Billing Meter and the Billing Portal
 * Configuration, persisting their ids into `billingSettings`. Idempotent by data
 * presence; on a Stripe "already exists" for the meter's event_name it ADOPTS the
 * existing meter by listing on event_name rather than failing the agent's checkout.
 */
export function ensureBillingObjects(): Promise<BillingObjects | null> {
  if (!ensureOnce) {
    ensureOnce = ensureBillingObjectsInner().catch((err) => {
      ensureOnce = null; // a failed first run must not poison later attempts.
      throw err;
    });
  }
  return ensureOnce;
}

async function ensureBillingObjectsInner(): Promise<BillingObjects | null> {
  const stripe = await getStripe();
  if (!stripe) return null;

  const settings = getBillingSettings();
  let baseProductId = settings.stripeBaseProductId;
  let usageProductId = settings.stripeUsageProductId;
  let meterId = settings.stripeMeterId;
  let portalConfigId = settings.stripePortalConfigId;

  if (!baseProductId) {
    const p = await stripe.products.create({
      name: "Docka base license",
      description: "Monthly platform licence for a crewing agency.",
    });
    baseProductId = p.id;
  }
  if (!usageProductId) {
    const p = await stripe.products.create({
      name: "Docka billable seafarers",
      description: "Seafarers visible on the agency board for 24h or more in the month.",
    });
    usageProductId = p.id;
  }
  if (!meterId) {
    meterId = await ensureMeter(stripe);
  }
  if (!portalConfigId) {
    portalConfigId = await createPortalConfiguration(stripe);
  }

  await saveBillingSettings({
    stripeBaseProductId: baseProductId,
    stripeUsageProductId: usageProductId,
    stripeMeterId: meterId,
    stripePortalConfigId: portalConfigId,
  });

  return { baseProductId, usageProductId, meterId, portalConfigId };
}

async function ensureMeter(stripe: StripeNS): Promise<string> {
  try {
    const meter = await stripe.billing.meters.create({
      display_name: "Billable seafarers",
      event_name: METER_EVENT_NAME,
      // SUM is why a double push would double-bill — hence the R1-1 ledger protocol.
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
    return meter.id;
  } catch (err) {
    // R3-3b — "a meter with this event_name already exists": adopt it, never fail
    // the agent's checkout over a bookkeeping collision.
    const existing = await stripe.billing.meters.list({ status: "active", limit: 100 });
    const found = existing.data.find((m) => m.event_name === METER_EVENT_NAME);
    if (found) return found.id;
    throw err;
  }
}

/**
 * R2-5 — an EXPLICIT portal configuration: payment-method update + invoice history ON,
 * subscription CANCELLATION OFF. The account default would re-open the
 * cancel-and-ride-free hole, so `createPortalSessionForAgent` always passes this id.
 */
async function createPortalConfiguration(stripe: StripeNS): Promise<string> {
  const cfg = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Docka — billing" },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["address", "tax_id", "email"] },
      subscription_cancel: { enabled: false },
    },
  });
  return cfg.id;
}

// ---- Per-agent objects --------------------------------------------------------

/** Find-or-create the agent's Stripe Customer. Returns the id, or null if unconfigured. */
export async function ensureCustomerForAgent(profile: BillingProfile): Promise<string | null> {
  if (profile.stripeCustomerId) return profile.stripeCustomerId;
  const stripe = await getStripe();
  if (!stripe) return null;
  const customer = await stripe.customers.create({
    name: profile.legalName || undefined,
    email: profile.billingEmail || undefined,
    address: profile.address.line1
      ? {
          line1: profile.address.line1,
          line2: profile.address.line2 || undefined,
          city: profile.address.city || undefined,
          postal_code: profile.address.postal || undefined,
          country: profile.address.country || undefined,
        }
      : undefined,
    metadata: { agentId: profile.agentId, regCode: profile.regCode ?? "" },
  });
  return customer.id;
}

/**
 * Per-agent Price objects (plan §0.2 — real Prices, never inline `price_data`, because
 * the metered price must reference the Billing Meter unambiguously and an admin rate
 * override must leave an auditable object trail).
 */
export async function ensurePricesForAgent(
  profile: BillingProfile
): Promise<{ basePriceId: string; usagePriceId: string } | null> {
  if (profile.stripeBasePriceId && profile.stripeUsagePriceId) {
    return { basePriceId: profile.stripeBasePriceId, usagePriceId: profile.stripeUsagePriceId };
  }
  const objects = await ensureBillingObjects();
  const stripe = await getStripe();
  if (!stripe || !objects) return null;
  const created = await createPricePair(stripe, objects, profile.baseEurMonthly, profile.perSeafarerEur, profile.agentId);
  return created;
}

async function createPricePair(
  stripe: StripeNS,
  objects: BillingObjects,
  baseEurMonthly: number,
  perSeafarerEur: number,
  agentId: string
): Promise<{ basePriceId: string; usagePriceId: string }> {
  const base = await stripe.prices.create({
    currency: "eur",
    unit_amount: Math.round(baseEurMonthly * 100),
    recurring: { interval: "month" },
    product: objects.baseProductId,
    metadata: { agentId },
  });
  const usage = await stripe.prices.create({
    currency: "eur",
    unit_amount: Math.round(perSeafarerEur * 100),
    recurring: { interval: "month", usage_type: "metered", meter: objects.meterId },
    product: objects.usageProductId,
    metadata: { agentId },
  });
  return { basePriceId: base.id, usagePriceId: usage.id };
}

// ---- Checkout + Portal --------------------------------------------------------

export type CheckoutInput = {
  profile: BillingProfile;
  customerId: string;
  basePriceId: string;
  usagePriceId: string;
  successUrl: string;
  cancelUrl: string;
  nowMs?: number;
};

/**
 * The hosted Checkout session (plan §0.1): `mode: "subscription"`, both line items,
 * dynamic/dashboard-driven payment methods (we OMIT `payment_method_types`, so Stripe
 * offers every method enabled in Dashboard → Payment methods, auto-filtered to those
 * eligible for the subscription mode / currency / customer country), prorated first
 * period, and the R2-1 UTC anchor with the R1-5/R3-2 stale-anchor guard on `expires_at`. Stripe Tax + VAT-id collection are gated on
 * `taxEnabled()` (owner has no VAT registration — default OFF; §0.1 deviation, approved
 * 2026-08-20). `billing_address_collection: "required"` stays ON regardless (invoice
 * records), and `customer_update.address: "auto"` is fine with tax off given that.
 */
export async function createCheckoutSessionForAgent(input: CheckoutInput): Promise<string | null> {
  const stripe = await getStripe();
  if (!stripe) return null;
  const nowMs = input.nowMs ?? Date.now();
  const anchor = nextUtcAnchorSec(nowMs);
  const taxOn = taxEnabled();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: input.customerId,
    line_items: [
      { price: input.basePriceId, quantity: 1 },
      // A metered item carries no quantity — the meter supplies it.
      { price: input.usagePriceId },
    ],
    subscription_data: {
      billing_cycle_anchor: anchor,
      proration_behavior: "create_prorations",
      metadata: { agentId: input.profile.agentId },
    },
    automatic_tax: { enabled: taxOn },
    tax_id_collection: { enabled: taxOn },
    billing_address_collection: "required",
    customer_update: { name: "auto", address: "auto" },
    expires_at: checkoutExpiresAtSec(nowMs, anchor),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { agentId: input.profile.agentId },
  });
  return session.url ?? null;
}

/** The hosted Customer Portal, ALWAYS on the explicit R3-3a configuration id. */
export async function createPortalSessionForAgent(input: {
  customerId: string;
  returnUrl: string;
}): Promise<string | null> {
  const stripe = await getStripe();
  if (!stripe) return null;
  const objects = await ensureBillingObjects();
  if (!objects) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
    // NEVER the account default — that would re-open the R2-5 cancellation hole.
    configuration: objects.portalConfigId,
  });
  return session.url ?? null;
}

// ---- Usage push ---------------------------------------------------------------

/** The Stripe-side dedupe key for one (agent, period) push — see R1-1. */
export function usageIdempotencyKey(agentId: string, period: string): string {
  return `usage:${agentId}:${period}`;
}

/**
 * Push ONE month of metered usage. The caller (the cron) MUST have claimed the row via
 * `claimUsagePush` first and MUST confirm with `markUsagePushed` only on `ok: true` —
 * that is the R1-1 attempt/confirm protocol that keeps a sum-aggregated meter honest.
 */
export async function pushUsage(input: {
  agentId: string;
  period: string;
  quantity: number;
  stripeCustomerId: string;
  timestampSec: number;
}): Promise<{ ok: true; eventId: string } | { ok: false; error: string }> {
  const stripe = await getStripe();
  if (!stripe) return { ok: false, error: "billing not configured" };
  try {
    const event = await stripe.billing.meterEvents.create(
      {
        event_name: METER_EVENT_NAME,
        payload: {
          stripe_customer_id: input.stripeCustomerId,
          value: String(input.quantity),
        },
        identifier: usageIdempotencyKey(input.agentId, input.period),
        timestamp: input.timestampSec,
      },
      { idempotencyKey: usageIdempotencyKey(input.agentId, input.period) }
    );
    return { ok: true, eventId: event.identifier };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Admin rate change --------------------------------------------------------

/**
 * Plan §0.2 — an admin rate override creates NEW Price objects, swaps the subscription
 * items onto them with `proration_behavior: "none"` (so the licensed change takes
 * effect next cycle) and archives the old prices. Returns the new price ids so the
 * caller can persist them.
 */
/** The minimum shape of a subscription item the matcher needs (structural, testable). */
export type RateChangeItem = {
  id: string;
  price?: string | { id?: string; product?: string | { id?: string } } | null;
};

/**
 * FINDING 15 — which subscription items must move onto the new prices.
 *
 * Matching by the STORED price ids alone is a single point of desync: the old code
 * swapped items and archived prices BEFORE the caller persisted the new ids, so a
 * crash in between left the profile pointing at archived prices that match nothing on
 * the subscription — and every future rate change then silently no-opped while still
 * reporting `stripeUpdated: true`.
 *
 * The fallback is the PRODUCT id, which never changes (one shared base product, one
 * shared usage product), so a desynced profile self-heals on the very next rate change.
 * Pure and exported so the matching itself is unit-testable without a Stripe client.
 */
export function matchRateChangeItems(
  items: RateChangeItem[],
  stored: { basePriceId: string | null; usagePriceId: string | null },
  products: { baseProductId: string; usageProductId: string },
  next: { basePriceId: string; usagePriceId: string }
): { id: string; price: string }[] {
  const priceIdOf = (item: RateChangeItem): string | null =>
    typeof item.price === "string" ? item.price : (item.price?.id ?? null);
  const productIdOf = (item: RateChangeItem): string | null => {
    if (!item.price || typeof item.price === "string") return null;
    const p = item.price.product;
    return typeof p === "string" ? p : (p?.id ?? null);
  };

  const byPrice: { id: string; price: string }[] = [];
  for (const item of items) {
    const priceId = priceIdOf(item);
    if (priceId && priceId === stored.basePriceId) byPrice.push({ id: item.id, price: next.basePriceId });
    else if (priceId && priceId === stored.usagePriceId) byPrice.push({ id: item.id, price: next.usagePriceId });
  }
  if (byPrice.length > 0) return byPrice;

  // Nothing matched the stored ids — fall back to the products, which are stable.
  const byProduct: { id: string; price: string }[] = [];
  for (const item of items) {
    const productId = productIdOf(item);
    if (productId && productId === products.baseProductId) byProduct.push({ id: item.id, price: next.basePriceId });
    else if (productId && productId === products.usageProductId) byProduct.push({ id: item.id, price: next.usagePriceId });
  }
  return byProduct;
}

export async function applyRateChange(
  profile: BillingProfile,
  newBaseEurMonthly: number,
  newPerSeafarerEur: number
): Promise<{ basePriceId: string; usagePriceId: string; subscriptionUpdated: boolean } | null> {
  const stripe = await getStripe();
  const objects = await ensureBillingObjects();
  if (!stripe || !objects) return null;

  const next = await createPricePair(
    stripe,
    objects,
    newBaseEurMonthly,
    newPerSeafarerEur,
    profile.agentId
  );

  // FINDING 15(b) — PERSIST FIRST, then mutate Stripe. Every ordering below is chosen
  // so that a crash at any point leaves a state the next run repairs rather than one it
  // can never see: the ids are stored before the items move, and the old prices are
  // archived last (an archived price the profile still points at is the unrecoverable
  // shape). This write is a plain db write — no network inside it (R2-2).
  await setBillingStripeRefs(profile.agentId, {
    stripeBasePriceId: next.basePriceId,
    stripeUsagePriceId: next.usagePriceId,
  });

  let subscriptionUpdated = false;
  if (profile.stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(profile.stripeSubscriptionId);
    const updates = matchRateChangeItems(
      (sub.items?.data ?? []) as unknown as RateChangeItem[],
      { basePriceId: profile.stripeBasePriceId, usagePriceId: profile.stripeUsagePriceId },
      { baseProductId: objects.baseProductId, usageProductId: objects.usageProductId },
      next
    );
    if (updates.length > 0) {
      await stripe.subscriptions.update(profile.stripeSubscriptionId, {
        items: updates,
        proration_behavior: "none",
      });
      subscriptionUpdated = true;
    }
  } else {
    // There is genuinely nothing to update — the next checkout uses the new prices.
    subscriptionUpdated = true;
  }

  for (const old of [profile.stripeBasePriceId, profile.stripeUsagePriceId]) {
    if (!old) continue;
    try {
      await stripe.prices.update(old, { active: false });
    } catch {
      /* archiving is bookkeeping — never fail the rate change over it */
    }
  }
  return { ...next, subscriptionUpdated };
}

// ---- Reads used by the webhook (phase 2) and the reconciler --------------------

/** A trimmed subscription view — everything the mirror + reconciler needs. */
export type SubscriptionView = {
  id: string;
  status: string;
  currentPeriodEnd: number | null;
  defaultPaymentMethodAttached: boolean;
  created: number | null;
  latestInvoiceStatus: string | null;
};

function toSubscriptionView(sub: Record<string, unknown>): SubscriptionView {
  const items = (sub.items as { data?: { current_period_end?: number }[] } | undefined)?.data ?? [];
  const latestInvoice = sub.latest_invoice as { status?: string } | string | null | undefined;
  return {
    id: String(sub.id ?? ""),
    status: String(sub.status ?? ""),
    // The period end moved onto the subscription ITEM in recent API versions; fall
    // back to the top-level field for older shapes so both are handled.
    currentPeriodEnd:
      (typeof sub.current_period_end === "number" ? (sub.current_period_end as number) : null) ??
      (typeof items[0]?.current_period_end === "number" ? (items[0].current_period_end as number) : null),
    defaultPaymentMethodAttached: Boolean(sub.default_payment_method),
    created: typeof sub.created === "number" ? (sub.created as number) : null,
    latestInvoiceStatus:
      latestInvoice && typeof latestInvoice === "object" ? (latestInvoice.status ?? null) : null,
  };
}

/**
 * D-B — the TAGGED result of a subscription read. `null` used to mean three different
 * things at once ("gone", "Stripe is down", "billing unconfigured"), and finding 5 is
 * exactly what that collapse costs: a 429 during the duplicate check read as "the
 * stored subscription is dead", so the webhook ADOPTED the new subscription and left
 * the still-live old one invoicing forever, with no alert.
 *
 * Three call sites want three different behaviours — the webhook throws (5xx, Stripe
 * redelivers), the cron reports an error outcome and retries next tick, the reconciler
 * alerts and skips the profile — so the discrimination is made explicit here.
 */
export type SubscriptionFetch =
  | { kind: "found"; view: SubscriptionView }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** True for the Stripe error shapes that genuinely mean "this object does not exist". */
function isMissingObjectError(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown; type?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "resource_missing") return true;
  if (e.statusCode === 404) return true;
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch one subscription. A 404 is `not-found`; 429/5xx/network are `error` (D-B). */
export async function fetchSubscription(subscriptionId: string): Promise<SubscriptionFetch> {
  const stripe = await getStripe();
  // Billing unconfigured is not an error state for the callers — there is nothing to
  // reconcile against, exactly as if the object did not exist.
  if (!stripe) return { kind: "not-found" };
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
    return { kind: "found", view: toSubscriptionView(sub as unknown as Record<string, unknown>) };
  } catch (err) {
    if (isMissingObjectError(err)) return { kind: "not-found" };
    return { kind: "error", message: errorMessage(err) };
  }
}

/**
 * R2-6 — every LIVE subscription on a customer, for orphan adoption.
 *
 * THROWS on an API failure rather than swallowing it into `[]` (D-B): an empty list is
 * the load-bearing evidence for "dead, with no replacement", and manufacturing that
 * from a 500 is how a healthy agency gets mirrored as cancelled. The reconciler's
 * per-profile try/catch turns the throw into an alert instead.
 */
export async function listLiveSubscriptionsForCustomer(
  customerId: string
): Promise<SubscriptionView[]> {
  const stripe = await getStripe();
  if (!stripe) return [];
  const res = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  return res.data
    .map((s) => toSubscriptionView(s as unknown as Record<string, unknown>))
    .filter((s) => isLiveStripeStatus(s.status));
}

/**
 * R1-4/R3-1 — cancel a duplicate subscription immediately (no period-end grace).
 *
 * FINDING 4 — the failure used to be swallowed into `false` and then ignored by the
 * caller: `processedAt` was stamped, the alert claimed the duplicate "was cancelled",
 * and the agency paid two base fees forever. The result is now explicit, and a cancel
 * error is RE-CHECKED against Stripe: if the subscription is in fact already canceled
 * (a redelivery re-cancelling what the first delivery cancelled) the call converges to
 * ok instead of 5xx-ing until Stripe gives up.
 */
export async function cancelSubscriptionNow(
  subscriptionId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stripe = await getStripe();
  if (!stripe) return { ok: false, error: "billing not configured" };
  try {
    await stripe.subscriptions.cancel(subscriptionId, { prorate: true });
    return { ok: true };
  } catch (err) {
    const message = errorMessage(err);
    const recheck = await fetchSubscription(subscriptionId);
    if (recheck.kind === "found" && !isLiveStripeStatus(recheck.view.status)) {
      return { ok: true }; // already cancelled — converged.
    }
    if (recheck.kind === "not-found") return { ok: true }; // gone entirely.
    return { ok: false, error: message };
  }
}
