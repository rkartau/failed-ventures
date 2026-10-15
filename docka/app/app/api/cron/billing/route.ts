import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized, runBillingCron } from "@/lib/billing-cron";

export const dynamic = "force-dynamic";

// SYSTEM cron entry point — NOT an agent- or seaman-scoped request.
//
// GET/POST /api/cron/billing  (called every 30 min by the root crontab on the box)
//
// Same construction as /api/cron/reminders: a trusted system job, gated by a shared
// secret, that reads across ALL tenants by design. It resolves neither the agent
// identity gate nor the seaman gate, so it is outside the per-request tenant isolation
// guard by construction and the static scan classifies it "n/a (not agent-facing)".
//
// AUTH: `Authorization: Bearer <CRON_SECRET>` or `?secret=<CRON_SECRET>`. With no
// CRON_SECRET configured it runs only outside production (fail-closed in prod). The
// `?secret=` variant is manual-testing only — the crontab uses the Bearer header.
//
// All dispatch logic lives in lib/billing-cron.ts so it is unit-testable without a
// server; this file only translates HTTP to that call.
//
// billing-guard: exempt — a secret-authenticated system endpoint with no agent
// session. It must keep running for every agency at every tier: it is what reports the
// usage that a past-due agency's next invoice is built from.

async function run(req: NextRequest) {
  const authorized = cronAuthorized({
    authorization: req.headers.get("authorization"),
    secretParam: new URL(req.url).searchParams.get("secret"),
  });
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runBillingCron();
    return NextResponse.json(result);
  } catch (err) {
    console.error("BILLING-CRON-FAILURE:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
