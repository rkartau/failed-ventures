import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { readDB } from "@/lib/db";
import {
  ensureBillingProfileForAgent,
  setBillingRatesForAgent,
} from "@/lib/billing-store";
import { applyRateChange, stripeConfigured } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// PUT /api/admin/billing  { agentId, baseEurMonthly?, perSeafarerEur?, exemptFromBilling? }
//
// The per-agent rate / comp knobs (plan P6). adminSession()-gated with the 404 shape
// the other admin endpoints use; the acting admin's e-mail ALWAYS comes from the
// session, never the body. Every change writes ONE recordAdminAction line carrying the
// old -> new values, so a rate override or a comp is auditable after the fact.
//
// When a live subscription exists the change is propagated to Stripe by
// applyRateChange (new Price objects, item swap with `proration_behavior: "none"` so
// the licensed change takes effect NEXT cycle, old Prices archived). That call happens
// OUTSIDE any db critical section — the R2-2 standing rule.
//
// This module references ONLY adminSession, so the isolation static guard classifies it
// "n/a (not agent-facing)".

/** Owner guidance ranges (decision 1). Outside them is allowed but flagged back. */
const BASE_MIN = 200;
const BASE_MAX = 500;
const PER_SEAFARER_MIN = 1;
const PER_SEAFARER_MAX = 5;
/** Hard sanity bounds — a typo must never create a 1,000,000 EUR price. */
const BASE_HARD_MAX = 100_000;
const PER_SEAFARER_HARD_MAX = 1_000;
/**
 * R3-FR1-2 (OWNER DECISION 2026-08-20) — per-seafarer floor. No agent may have a €0
 * per-seafarer rate: every seafarer on the board bills at least €0.10. This is the
 * CANONICAL source of truth; components/AdminBillingEditor.tsx mirrors this value and
 * points back here. (0.10 EUR = 10 Stripe cents — sub-€1 metered rates are fine.)
 */
const MIN_PER_SEAFARER_EUR = 0.1;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function PUT(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const adminEmail = (admin.user.email ?? "").trim().toLowerCase();

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: unknown;
    baseEurMonthly?: unknown;
    perSeafarerEur?: unknown;
    exemptFromBilling?: unknown;
  };
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "agentId is required." }, { status: 400 });
  }
  if (!readDB().agents.some((a) => a.id === agentId)) {
    return NextResponse.json({ ok: false, error: "Agent not found." }, { status: 404 });
  }

  const baseEurMonthly = num(body.baseEurMonthly);
  const perSeafarerEur = num(body.perSeafarerEur);
  const exemptFromBilling =
    typeof body.exemptFromBilling === "boolean" ? body.exemptFromBilling : undefined;

  // R3-4 / R3-FR1-2 — base must be strictly POSITIVE (a €0 base license is the
  // accidental-clear footgun, not a real deal; a genuinely free arrangement is
  // exemptFromBilling). Per-seafarer has a HARD FLOOR of €0.10 (OWNER DECISION
  // 2026-08-20): flat-fee / €0 per-seafarer is DISALLOWED — every seafarer on the board
  // bills at least €0.10. Blank fields never reach here — the client omits them
  // (blank-means-unchanged), and num() returns undefined for "".
  if (baseEurMonthly !== undefined && (baseEurMonthly <= 0 || baseEurMonthly > BASE_HARD_MAX)) {
    return NextResponse.json({ ok: false, error: "baseEurMonthly must be a positive number within range." }, { status: 400 });
  }
  if (
    perSeafarerEur !== undefined &&
    (perSeafarerEur < MIN_PER_SEAFARER_EUR || perSeafarerEur > PER_SEAFARER_HARD_MAX)
  ) {
    return NextResponse.json({ ok: false, error: "perSeafarerEur must be at least €0.10 per seafarer (flat-fee / €0 is not allowed)." }, { status: 400 });
  }
  if (baseEurMonthly === undefined && perSeafarerEur === undefined && exemptFromBilling === undefined) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  // C5 — create-if-absent RETURNS the profile; the re-read and its unreachable null
  // branch were copy-paste.
  const before = await ensureBillingProfileForAgent(agentId);

  const after = await setBillingRatesForAgent(agentId, {
    baseEurMonthly,
    perSeafarerEur,
    exemptFromBilling,
  });
  if (!after) {
    return NextResponse.json({ ok: false, error: "Could not save the billing profile." }, { status: 500 });
  }

  // Propagate a RATE change to Stripe (never inside a db critical section).
  let stripeUpdated = false;
  let stripeError: string | null = null;
  const ratesChanged =
    after.baseEurMonthly !== before.baseEurMonthly || after.perSeafarerEur !== before.perSeafarerEur;
  if (ratesChanged && stripeConfigured() && before.stripeCustomerId) {
    try {
      // FINDING 15(b/c) — applyRateChange persists the new price ids ITSELF, before it
      // touches the subscription, so a crash can no longer desync the profile from
      // Stripe; and `stripeUpdated` is now the truth (the item swap actually ran, or
      // there was genuinely no live subscription to swap), not "a price pair was made".
      const next = await applyRateChange(before, after.baseEurMonthly, after.perSeafarerEur);
      if (next) stripeUpdated = next.subscriptionUpdated;
    } catch (err) {
      // The stored rates ARE the source of truth for the next checkout; a failed
      // Stripe propagation is surfaced, never silently swallowed.
      stripeError = err instanceof Error ? err.message : String(err);
      console.error(`BILLING-RATE-PROPAGATION-FAILURE agent=${agentId}`, err);
    }
  }

  await recordAdminAction({
    adminEmail,
    action: "billing-rate-change",
    detail: {
      agentId,
      baseEurMonthlyBefore: before.baseEurMonthly,
      baseEurMonthlyAfter: after.baseEurMonthly,
      perSeafarerEurBefore: before.perSeafarerEur,
      perSeafarerEurAfter: after.perSeafarerEur,
      exemptBefore: before.exemptFromBilling,
      exemptAfter: after.exemptFromBilling,
      billingActiveFromAfter: after.billingActiveFrom,
      stripeUpdated,
      stripeError,
    },
  });

  const outsideGuidance =
    after.baseEurMonthly < BASE_MIN ||
    after.baseEurMonthly > BASE_MAX ||
    after.perSeafarerEur < PER_SEAFARER_MIN ||
    after.perSeafarerEur > PER_SEAFARER_MAX;

  return NextResponse.json({
    ok: true,
    profile: after,
    stripeUpdated,
    stripeError,
    outsideGuidance,
  });
}
