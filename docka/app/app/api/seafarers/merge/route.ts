import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { readDB } from "@/lib/db";
import { checkAccess } from "@/lib/access";
import { impersonationStampFor } from "@/lib/impersonation";
import { mergePersons, previewMerge } from "@/lib/person-merge";

export const dynamic = "force-dynamic";

// POST /api/seafarers/merge  (agent-gated, per-tenant)
//   { survivorId, absorbedId }               -> perform the merge
//   { survivorId, absorbedId, preview:true } -> read-only preview (#37.4)
//
// AUTHZ fail-closed: an agent session AND a LIVE grant for BOTH survivor and absorbed
// (per-tenant, #37.11); else 404, no mutation. The merge itself re-derives corroboration
// server-side and refuses if absent (#37.6); a LOCKED grant on either side => 409.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    survivorId?: string;
    absorbedId?: string;
    preview?: boolean;
  };
  const survivorId = (body.survivorId ?? "").trim();
  const absorbedId = (body.absorbedId ?? "").trim();
  if (!survivorId || !absorbedId) {
    return NextResponse.json(
      { ok: false, error: "survivorId and absorbedId are required." },
      { status: 400 }
    );
  }

  // Per-tenant fail-closed: BOTH sides must be in this agent's own roster.
  const agentId = session.agentId;
  if (!checkAccess(agentId, survivorId).allowed || !checkAccess(agentId, absorbedId).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  // Public Sample Profiles (plan v3-A / §D5 no-token-symbol seams): a sample
  // record can never be merged in EITHER direction — a merge would carry the
  // published sample token into a real row's aliases (or delete the flagship).
  // The authoritative refusals live in lib/person-merge (previewMerge check,
  // mergePersons early guard, pre-token-carry throwing assert); this route-level
  // deny is belt-and-braces and answers before any preview leaks shape data.
  // Reachable for real agents: the flagship IS grantable via the share link, so
  // checkAccess alone does not fence samples out.
  const dbSnap = readDB();
  if (
    [survivorId, absorbedId].some(
      (sid) => dbSnap.seafarers.find((s) => s.id === sid)?.isSample === true
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "Sample records cannot be merged." },
      { status: 403 }
    );
  }

  if (body.preview) {
    const preview = previewMerge(survivorId, absorbedId);
    if ("error" in preview) {
      return NextResponse.json({ ok: false, error: preview.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, preview });
  }

  const actor = `agent:${agentId}`;
  const res = await mergePersons(survivorId, absorbedId, actor, impersonationStampFor(session));
  if (!res.ok) {
    const reason = res.reason ?? "merge refused";
    const status =
      reason === "record not found"
        ? 404
        : reason === "needs corroboration" || reason.startsWith("locked") || reason.startsWith("survivor is at sea")
          ? 409
          : 400;
    return NextResponse.json({ ok: false, error: reason, reason }, { status });
  }
  return NextResponse.json({ ok: true, preview: res.preview });
}
