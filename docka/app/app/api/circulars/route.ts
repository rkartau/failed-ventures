import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  isSeafarerState,
  type Circular,
  type NotifyChannel,
  type Seafarer,
  type SeafarerState,
} from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { listSeafarersForAgent } from "@/lib/agentData";
import { send, type NotifyResult } from "@/lib/notify";
import { pruneSampleReferences } from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// Email today; the notify channel stubs SMS/WhatsApp behind the same interface, so
// switching or adding a channel here is a one-line change once a transport ships.
const CHANNEL: NotifyChannel = "email";

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;

type CircularFilter = { rank: string | null; state: SeafarerState | null; vessel: string | null };

// Roster filter — pure, applied to the ALREADY grant-scoped set. Any axis left null
// imposes no constraint. Rank/vessel match case-insensitively on the trimmed value.
function matchesFilter(s: Seafarer, f: CircularFilter): boolean {
  if (f.rank && (s.rank ?? "").trim().toLowerCase() !== f.rank.trim().toLowerCase()) return false;
  if (f.state && s.state !== f.state) return false;
  if (f.vessel && (s.vessel ?? "").trim().toLowerCase() !== f.vessel.trim().toLowerCase()) {
    return false;
  }
  return true;
}

// A short, human delivery outcome for the per-recipient audit note.
function deliveryNote(res: NotifyResult, to: string | null): string {
  if (res.delivered) return `emailed to ${to}`;
  if (res.status === "failed") return `email failed (${res.reason ?? "unknown error"})`;
  if (!to) return "recorded only — no e-mail on file";
  return `recorded only (${res.reason ?? "channel not configured"})`;
}

// GET /api/circulars
//   The signed-in agent's own sent circulars (newest first) + a grant-scoped roster
//   summary the compose UI uses to build its rank/state/vessel filter options and a
//   live recipient count. Everything is tenant-scoped via lib/agentData.ts.
export async function GET() {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  // GRANT-SCOPED roster (default-deny). We expose ONLY the small slices the filter
  // UI needs (id, name, rank, state, vessel, whether an e-mail is on file) — never
  // documents or verified identity — so the compose panel can preview reach.
  const roster = listSeafarersForAgent(session.agentId, false).map((s) => ({
    id: s.id,
    name: s.name,
    rank: s.rank ?? "",
    state: s.state,
    vessel: s.vessel ?? null,
    hasEmail: Boolean(s.ownerEmail?.trim()),
  }));

  const circulars = readDB()
    .circulars.filter((c) => c.agentId === session.agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({ ok: true, roster, circulars });
}

// POST /api/circulars
//   { subject, message, filter?: { rank?, state?, vessel? } }
//
// Broadcast a circular to (all, or a filtered slice of) the agent's roster. The
// recipient set is ALWAYS the grant-scoped roster from lib/agentData.ts, then the
// optional filter narrows it — a foreign/un-granted seafarer can never be reached.
// Each recipient is e-mailed through the shared lib/notify channel (email today;
// SMS/WhatsApp stubbed behind the same interface). notify() never throws — a missing
// e-mail or unconfigured SMTP resolves to a recorded "logged only" result. The
// circular is stored as a durable, auditable record of what went out.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    subject?: unknown;
    message?: unknown;
    allowReplies?: unknown;
    filter?: { rank?: unknown; state?: unknown; vessel?: unknown };
  };

  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, MAX_SUBJECT) : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (!subject) {
    return NextResponse.json({ ok: false, error: "Add a subject." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ ok: false, error: "Add a message." }, { status: 400 });
  }

  const rawState = typeof body.filter?.state === "string" ? body.filter.state : null;
  const filter: CircularFilter = {
    rank:
      typeof body.filter?.rank === "string" && body.filter.rank.trim()
        ? body.filter.rank.trim()
        : null,
    state: rawState && isSeafarerState(rawState) ? rawState : null,
    vessel:
      typeof body.filter?.vessel === "string" && body.filter.vessel.trim()
        ? body.filter.vessel.trim()
        : null,
  };
  const hasFilter = Boolean(filter.rank || filter.state || filter.vessel);

  // Two-way replies are opt-in per circular; strictly boolean, defaulting OFF, so a
  // legacy client that omits the field keeps producing read-only notices.
  const allowReplies = body.allowReplies === true;

  // GRANT-SCOPED roster, then the optional filter. Isolation boundary: the roster is
  // the ONLY source of recipients, so nothing outside this agent's grants is reached.
  const recipients = listSeafarersForAgent(session.agentId, false).filter((s) =>
    matchesFilter(s, filter)
  );
  if (recipients.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No crew in your roster match that filter." },
      { status: 404 }
    );
  }

  const author = session.user.name || session.user.email || "Agency";
  let delivered = 0;
  const results: { seafarerId: string; name: string; delivered: boolean; delivery: string }[] = [];

  for (const s of recipients) {
    // §D7 — a sample recipient STAYS in recipientIds (the agent-side thread works)
    // but send() is skipped: no notifications-log noise, nothing outbound.
    if (s.isSample === true) {
      results.push({
        seafarerId: s.id,
        name: s.name,
        delivered: false,
        delivery: "skipped — sample profile",
      });
      continue;
    }
    const to = s.ownerEmail?.trim() || null;
    const emailBody =
      `Hello ${s.name || "seafarer"},\n\n` +
      `${message}\n\n` +
      `— circular from ${author}, sent via docka`;
    const res = await send({
      channel: CHANNEL,
      to: { name: s.name, email: to },
      subject,
      message: emailBody,
      kind: "circular",
    });
    if (res.delivered) delivered++;
    results.push({
      seafarerId: s.id,
      name: s.name,
      delivered: res.delivered,
      delivery: deliveryNote(res, to),
    });
  }

  const circular: Circular = {
    id: id(),
    agentId: session.agentId,
    authorName: author,
    subject,
    message,
    filter: hasFilter ? filter : null,
    channel: CHANNEL,
    recipientIds: recipients.map((s) => s.id),
    delivered,
    allowReplies,
    createdAt: new Date().toISOString(),
  };
  await updateDB((db) => {
    db.circulars.push(circular);
    // Bound real-agent interactions with sample recipients (no-op otherwise).
    for (const s of recipients) {
      if (s.isSample === true) pruneSampleReferences(db, s.id);
    }
  });

  return NextResponse.json({
    ok: true,
    circular,
    recipientCount: recipients.length,
    delivered,
    results,
  });
}
