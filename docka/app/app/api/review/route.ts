import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, type ReviewStatus } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";

export const dynamic = "force-dynamic";

const ACTIONS: Record<string, ReviewStatus> = {
  approve: "approved",
  reject: "rejected",
  reupload: "reupload",
  reset: "pending",
};

// POST /api/review  { documentId, action: "approve"|"reject"|"reupload"|"reset", reason? }
// Records the agent's per-document decision. Rejections carry a reason.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    action?: string;
    reason?: string;
  };
  const documentId = (body.documentId ?? "").trim();
  const action = (body.action ?? "").trim();
  const reason = (body.reason ?? "").trim();
  const status = ACTIONS[action];

  if (!documentId || !status) {
    return NextResponse.json(
      { ok: false, error: "documentId and a valid action are required." },
      { status: 400 }
    );
  }
  if (status === "rejected" && !reason) {
    return NextResponse.json(
      { ok: false, error: "A reason is required to reject a document." },
      { status: 400 }
    );
  }

  // The reviewer's identity comes from the authenticated agent session, never
  // from client input — that's what makes the audit trail defensible at an
  // inspection. Only a signed-in agent can record a decision.
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to review documents." },
      { status: 401 }
    );
  }
  const reviewer = session.user.name ?? session.user.email ?? "Agent";

  // GRANT-SCOPE the write: an agent may only review a document that belongs to a
  // seafarer they hold a live grant for. Resolve the doc's owner and gate via
  // checkAccess BEFORE any mutation. A foreign / missing documentId 404s with no
  // state change — an agent cannot approve/reject/reset another tenant's docs.
  const target = readDB().documents.find((x) => x.id === documentId);
  if (!target || !checkAccess(session.agentId, target.seafarerId).allowed) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }

  const doc = await updateDB((db) => {
    const d = db.documents.find((x) => x.id === documentId);
    if (!d) return null;
    d.reviewStatus = status;
    d.reviewReason = status === "rejected" || status === "reupload" ? reason || null : null;
    // "reset" clears the decision back to pending — so it clears the actor too.
    if (status === "pending") {
      d.reviewedBy = null;
      d.reviewedAt = null;
    } else {
      d.reviewedBy = reviewer;
      d.reviewedAt = new Date().toISOString();
    }
    return d;
  });

  if (!doc) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, document: doc });
}
