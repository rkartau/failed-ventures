import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { setDirectoryConsent } from "@/lib/directory";

export const dynamic = "force-dynamic";

// #49 — AGENCY-controlled per-grant directory consent toggle (the agency half of the
// dual consent).
//   POST { seafarerId, on:boolean }
//
// Isolation: the acting agent is resolved via `agentSession`; `checkAccess` (a
// fail-closed guard symbol) confirms the agent holds a LIVE grant to this seaman before
// any write — an agent with no grant gets a 404 and can toggle nobody's consent.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { seafarerId?: string; on?: boolean };
  const seafarerId = (body.seafarerId ?? "").trim();
  const on = body.on === true;
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  // Fail-closed: only an agency holding a live grant may set directory consent.
  const { allowed } = checkAccess(session.agentId, seafarerId);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const res = await setDirectoryConsent(seafarerId, session.agentId, on, `agent:${session.agentId}`);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.reason ?? "no grant" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, grant: res.grant });
}
