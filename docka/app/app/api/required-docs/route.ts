import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { impersonationStampFor } from "@/lib/impersonation";
import { baselineAt } from "@/lib/required-docs";
import {
  getConfigForAgent,
  hasCustomConfig,
  saveConfigForAgent,
  governedSeafarerIds,
  auditForAgent,
} from "@/lib/required-docs-store";

export const dynamic = "force-dynamic";

// GET /api/required-docs -> the signed-in agent's required-docs config, the
// baseline catalog it derives from, the blast radius (governed seafarer count),
// and the config-edit audit trail.
export async function GET() {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const config = getConfigForAgent(session.agentId);
  const baseline = baselineAt();
  return NextResponse.json({
    ok: true,
    config,
    custom: hasCustomConfig(session.agentId),
    catalog: baseline.catalog,
    baselineVersion: baseline.version,
    governedCount: governedSeafarerIds(session.agentId).length,
    audit: auditForAgent(session.agentId),
  });
}

// PUT /api/required-docs -> save the agent's config edit. Writes an audit row with
// the human diff + blast radius. Applies to ALL the agent's seafarers.
export async function PUT(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    universalRequired?: unknown;
    perRankRequired?: Record<string, unknown>;
    perVesselTypeRequired?: Record<string, unknown>;
    perFlagRequired?: Record<string, unknown>;
    baselineVersion?: string;
  };
  const actor = session.user.name ?? session.user.email ?? "Agent";
  const { config, audit } = await saveConfigForAgent(
    {
      agentId: session.agentId,
      actor,
      universalRequired: body.universalRequired,
      perRankRequired: body.perRankRequired as never,
      perVesselTypeRequired: body.perVesselTypeRequired as never,
      perFlagRequired: body.perFlagRequired as never,
      baselineVersion: body.baselineVersion,
    },
    impersonationStampFor(session)
  );
  return NextResponse.json({ ok: true, config, audit });
}
