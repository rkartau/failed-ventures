import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { getUsageRow, resolveUnconfirmedPush } from "@/lib/billing-store";
import { recordBillingAlert } from "@/lib/billing-health";

export const dynamic = "force-dynamic";

// POST /api/admin/billing/usage-resolution  { agentId, period, action }
//
// R2-10a — resolving an ATTEMPTED-BUT-UNCONFIRMED usage push is an ADMIN ACTION, not a
// db.json hand-edit. A row with `pushAttemptedAt` set and `pushedToStripeAt` null that
// has aged past Stripe's ~24h idempotency-key window is never auto-retried (R1-1),
// because the meter aggregates by SUM and a blind retry could double-bill. The admin
// checks the Stripe dashboard meter summary and then tells us which way it went:
//
//   action: "mark-pushed"   Stripe DID receive the event — record it as pushed.
//   action: "clear-attempt" Stripe did NOT — clear the claim so the cron can retry.
//
// adminSession()-gated (404 shape); the acting admin's e-mail comes from the session,
// never the body; every resolution writes an admin-audit line AND a billing-health
// alert so the decision is visible in both trails.
//
// This module references ONLY adminSession -> "n/a (not agent-facing)".

export async function POST(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const adminEmail = (admin.user.email ?? "").trim().toLowerCase();

  const body = (await req.json().catch(() => ({}))) as {
    agentId?: unknown;
    period?: unknown;
    action?: unknown;
  };
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const period = typeof body.period === "string" ? body.period.trim() : "";
  const action = body.action === "mark-pushed" || body.action === "clear-attempt" ? body.action : null;

  if (!agentId || !/^\d{4}-\d{2}$/.test(period) || !action) {
    return NextResponse.json(
      { ok: false, error: "agentId, period (YYYY-MM) and action (mark-pushed|clear-attempt) are required." },
      { status: 400 }
    );
  }

  const before = getUsageRow(agentId, period);
  if (!before) {
    return NextResponse.json({ ok: false, error: "No usage row for that agent and period." }, { status: 404 });
  }
  if (before.pushedToStripeAt) {
    return NextResponse.json(
      { ok: false, error: "That period is already confirmed as pushed.", row: before },
      { status: 409 }
    );
  }

  const row = await resolveUnconfirmedPush(agentId, period, action);

  await recordAdminAction({
    adminEmail,
    action: "billing-usage-resolution",
    detail: {
      agentId,
      period,
      resolution: action,
      quantity: before.quantity,
      attemptedAt: before.pushAttemptedAt,
    },
  });
  recordBillingAlert(
    "unconfirmedPush",
    `admin ${adminEmail} resolved the unconfirmed push for ${period} as "${action}" (quantity ${before.quantity})`,
    { agentId, period }
  );

  return NextResponse.json({ ok: true, row });
}
