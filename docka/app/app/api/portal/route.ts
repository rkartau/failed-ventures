import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { listSeafarersForAgent } from "@/lib/agentData";
import {
  createPortal,
  revokePortal,
  previewPortalVisibility,
  listPortalsForAgent,
} from "@/lib/client-portal";
import { serviceDateKey } from "@/lib/sea-service";

export const dynamic = "force-dynamic";

// #42 — agent-only client read-portal management.
//   GET  /api/portal            -> own portals + crew visibility preview (picker)
//   POST /api/portal {action:"create"|"revoke", ...}
//
// Isolation: the acting agent is resolved via `agentSession`; the crew picker is built
// through the grant-scoped `listSeafarersForAgent` (a fail-closed guard symbol) so the
// preview never surfaces a foreign tenant's crew. Portal rows are partitioned by
// agentId in lib/client-portal.

export async function GET() {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  }
  const crew = listSeafarersForAgent(session.agentId, false);
  const vis = previewPortalVisibility(
    session.agentId,
    crew.map((s) => s.id)
  );
  const visById = new Map(vis.map((v) => [v.seafarerId, v]));
  const options = crew.map((s) => ({
    id: s.id,
    name: s.name,
    rank: s.rank,
    visible: visById.get(s.id)?.visible ?? false,
    reason: visById.get(s.id)?.reason ?? null,
  }));
  const portals = listPortalsForAgent(session.agentId).map((p) => ({
    id: p.id,
    vessel: p.vessel,
    clientLabel: p.clientLabel,
    mode: p.mode,
    token: p.token,
    count: p.seafarerIds.length,
    revokedAt: p.revokedAt,
    createdAt: p.createdAt,
  }));
  return NextResponse.json({ ok: true, options, portals });
}

export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.action === "revoke") {
    const portalId = String(body.portalId ?? "").trim();
    if (!portalId) {
      return NextResponse.json({ ok: false, error: "portalId is required." }, { status: 400 });
    }
    const res = await revokePortal(session.agentId, portalId);
    if (!res.ok) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true, portal: res.portal });
  }

  // create
  const clientLabel = String(body.clientLabel ?? "").trim().slice(0, 120);
  const vessel = String(body.vessel ?? "").trim().slice(0, 120);
  if (!clientLabel || !vessel) {
    return NextResponse.json(
      { ok: false, error: "clientLabel and vessel are required." },
      { status: 400 }
    );
  }
  const seafarerIds = Array.isArray(body.seafarerIds)
    ? body.seafarerIds.filter((x): x is string => typeof x === "string").slice(0, 200)
    : [];
  const mode = body.mode === "email" ? "email" : "open";
  const allowedEmails = Array.isArray(body.allowedEmails)
    ? body.allowedEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean).slice(0, 200)
    : [];
  const joinDate = serviceDateKey(typeof body.joinDate === "string" ? body.joinDate : "") || null;
  const rotationEnd =
    serviceDateKey(typeof body.rotationEnd === "string" ? body.rotationEnd : "") || null;
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt.trim() ? body.expiresAt : null;
  const createKey = String(body.createKey ?? "").trim().slice(0, 64) || null;

  const { portal, visibility } = await createPortal(session.agentId, {
    vessel,
    clientLabel,
    seafarerIds,
    mode,
    allowedEmails,
    joinDate,
    rotationEnd,
    expiresAt,
    createKey,
  });
  return NextResponse.json({
    ok: true,
    portalId: portal.id,
    token: portal.token,
    visibility,
  });
}
