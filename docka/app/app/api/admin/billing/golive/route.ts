import { NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { updateDB } from "@/lib/db";
import { applyGoLive } from "@/lib/billing-store";
import { recordBillingAlert } from "@/lib/billing-health";
import { recordAdminAction } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

// BILLING GO-LIVE (T0) — STRIPE-BILLING-PLAN.md P1, owner decisions 3 + 7.
//
// POST /api/admin/billing/golive
//
// One-shot, IDEMPOTENT-BY-REFUSAL switch that starts the billing clock:
//   1. stamps `billingSettings.goLiveAt = now` (until then every agent's tier is
//      `exempt` — goLiveAt null is the global off-switch, plan §4);
//   2. writes a `billingBaseline` row for every currently-READABLE agent<->seafarer
//      pair, so the usage engine opens each pair's interval at T0 and pre-T0 history is
//      simply out of scope (decision 3: no retro-billing, and the prod consent sink was
//      0 bytes on 2026-07-20 so reconstruction is impossible anyway). Hidden-but-readable
//      pairs ARE included — hiding does not pause billing (decision 4);
//   3. creates a default profile for every agent that exists at that moment with
//      `exemptFromBilling: true` (decision 7 — the ~6 pre-existing test/real agents are
//      grandfathered comped until the owner un-exempts them one by one).
//
// A second call returns 409: re-running would move T0 and re-baseline live rosters.
// There is deliberately NO `?reset=` escape hatch (plan P8.7) — the owner resets by
// restoring db.json from a backup.
//
// This module references ONLY adminSession -> the isolation static guard classifies it
// "n/a (not agent-facing)"; `readableSeafarerIds` is the fail-closed visibility
// predicate, used here read-only across ALL tenants by design (a system snapshot).

export async function POST() {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const adminEmail = (admin.user.email ?? "").trim().toLowerCase();

  const nowIso = new Date().toISOString();
  // D-D — the whole mutation is `applyGoLive` in lib/billing-store.ts: a PURE function
  // over the db, so the finding-2 free-rider case is unit-testable without standing up
  // an admin HTTP session. This route body is now auth + call + audit.
  const result = await updateDB((db) => applyGoLive(db, nowIso));

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "Billing go-live has already been run.",
        goLiveAt: result.alreadyLiveAt,
      },
      { status: 409 }
    );
  }

  // FR1-3 — an agency that ALREADY holds a live subscription is deliberately not
  // comped by the grandfathering sweep (Stripe is invoicing it), so the owner is told
  // to decide rather than silently losing the revenue.
  for (const agentId of result.subscribedSkipped) {
    recordBillingAlert(
      "error",
      `go-live did NOT comp ${agentId}: it already holds a live subscription, so exempting ` +
        `it would stop billing an agency Stripe keeps invoicing — decide manually`,
      { agentId }
    );
  }

  await recordAdminAction({
    adminEmail,
    action: "billing-golive",
    detail: {
      goLiveAt: result.goLiveAt,
      profilesCreated: result.profilesCreated,
      profilesExempted: result.profilesExempted,
      subscribedSkipped: result.subscribedSkipped.join(", "),
      baselineRows: result.baselineRows,
    },
  });

  return NextResponse.json({
    ok: true,
    goLiveAt: result.goLiveAt,
    profilesCreated: result.profilesCreated,
    profilesExempted: result.profilesExempted,
    subscribedSkipped: result.subscribedSkipped,
    baselineRows: result.baselineRows,
    perAgent: result.perAgent,
  });
}
