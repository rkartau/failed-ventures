import { NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable } from "@/lib/billing-enforce";
import { readableSeafarerIds } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/circulars/replies  → the signed-in AGENT's view of every reply to their own
// circulars, across BOTH visibilities, with the REAL author name (the agent is the one
// party who is never anonymised — peers are, in the seaman inbox).
//
// TENANT SCOPE (fail-closed): `reply.agentId` is denormalised from the circular's
// sending tenant, so filtering on `reply.agentId === session.agentId` is the exact same
// own-tenant lock every other agent collection uses — a foreign tenant's replies are
// never returned. The agent KEEPS the history of a crew member who has since revoked
// (D3 is about the seaman's peer view, not the agent's own audit trail), so replies are
// NOT filtered by current readability. We still compute `readableSeafarerIds` to tag
// each author `stillOnRoster` — a non-lossy signal the UI can surface ("former crew").
export async function GET() {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const db = readDB();
  const readable = readableSeafarerIds(session.agentId, db);

  const replies = db.circularReplies
    .filter((r) => r.agentId === session.agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({
      id: r.id,
      circularId: r.circularId,
      authorName: r.authorName, // REAL name — agent view
      body: r.body,
      visibility: r.visibility,
      createdAt: r.createdAt,
      stillOnRoster: readable.has(r.seafarerId),
    }));

  return NextResponse.json({ ok: true, replies });
}
