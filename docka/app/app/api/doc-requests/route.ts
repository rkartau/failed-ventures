import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  type DocRequest,
  type DocRequestStatus,
} from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { getSeafarerForAgent } from "@/lib/agentData";
import { REQUIRED_DOC_TYPES, type RequiredDocType } from "@/lib/doctypes";
import { summarizeRequests, sortForDisplay, dueState } from "@/lib/doc-requests";
import { send, type NotifyResult } from "@/lib/notify";
import { getPublicBaseUrl } from "@/lib/base-url";

export const dynamic = "force-dynamic";
// sample-token: exempt(link-construction only — the open token is embedded into the
// outbound upload link, never used to authorise the caller; a POST targeting the
// sample flagship is ALLOWED by locked operator decision — silent, kept, pruned)
import { pruneSampleReferences } from "@/lib/sample-guard";

const MAX_LABEL = 120;
const MAX_NOTE = 1000;
const MAX_ITEMS = 40;

// Validate an optional yyyy-mm-dd deadline. Returns the normalised day, null (no
// deadline), or the sentinel "bad" so the caller can 400.
function parseDueDate(raw: unknown): string | null | "bad" {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return "bad";
  const day = raw.slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  if (isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "bad";
  return day;
}

function asRequiredType(raw: unknown): RequiredDocType | null {
  return typeof raw === "string" && (REQUIRED_DOC_TYPES as readonly string[]).includes(raw)
    ? (raw as RequiredDocType)
    : null;
}

// The signed-in agent's requests for ONE of their seafarers, tenant-scoped: rows
// are filtered to this agent's tenant AND we only ever expose them once the grant
// guard has confirmed the agent may see the seafarer at all.
function requestsForSeafarer(agentId: string, seafarerId: string): DocRequest[] {
  return readDB().docRequests.filter(
    (r) => r.seafarerId === seafarerId && r.agentId === agentId
  );
}

// A short, human delivery outcome for the notify result (mirrors /api/circulars).
function deliveryNote(res: NotifyResult, to: string | null): string {
  if (res.delivered) return `emailed to ${to}`;
  if (res.status === "failed") return `email failed (${res.reason ?? "unknown error"})`;
  if (!to) return "recorded only — no e-mail on file";
  return `recorded only (${res.reason ?? "channel not configured"})`;
}

// GET /api/doc-requests?seafarerId=...
//   The agent's checklist for that seafarer (tenant + grant scoped), newest-relevant
//   first, plus a package-ready summary.
export async function GET(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  // FAIL-CLOSED: no live grant => 404 (no data leak). An internal completeness read,
  // so it does not write a REVIEWED entry to the audit log.
  if (!getSeafarerForAgent(session.agentId, seafarerId, { log: false })) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  const requests = sortForDisplay(requestsForSeafarer(session.agentId, seafarerId));
  return NextResponse.json({ ok: true, requests, summary: summarizeRequests(requests) });
}

// POST /api/doc-requests
//   { seafarerId, items: [{ requiredType?, label?, dueDate?, note? }], dueDate?, notify? }
//
// Raise a checklist of documents to collect from a seaman, each with an optional
// deadline. The missing set already comes from lib/compliance.ts; this is the
// COLLECTION loop on top of it. Tenant-isolated: the seafarer must be one this
// agent holds a LIVE grant for (getSeafarerForAgent, fail-closed) — an agent can
// never raise a request against another tenant's crew. When `notify` is set the
// seaman is e-mailed one checklist summary + their upload link via lib/notify
// (never throws; a missing address resolves to a recorded "logged only").
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    seafarerId?: unknown;
    items?: unknown;
    dueDate?: unknown;
    notify?: unknown;
  };
  const seafarerId = typeof body.seafarerId === "string" ? body.seafarerId.trim() : "";
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }

  // FAIL-CLOSED grant check — an internal read (no audit-log entry for composing).
  const scoped = getSeafarerForAgent(session.agentId, seafarerId, { log: false });
  if (!scoped) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  const sharedDue = parseDueDate(body.dueDate);
  if (sharedDue === "bad") {
    return NextResponse.json({ ok: false, error: "Enter a valid deadline date." }, { status: 400 });
  }

  const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ ok: false, error: "Add at least one document to request." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const requestedBy = session.user.name || session.user.email || "Agent";
  const drafts: DocRequest[] = [];
  for (const raw of rawItems) {
    const it = (raw ?? {}) as { requiredType?: unknown; label?: unknown; dueDate?: unknown; note?: unknown };
    const requiredType = asRequiredType(it.requiredType);
    // Label falls back to the required-slot name so a quick "tick the missing slot"
    // pick needs no typing; an ad-hoc item must carry its own label.
    const label =
      (typeof it.label === "string" && it.label.trim().slice(0, MAX_LABEL)) || requiredType || "";
    if (!label) continue; // skip a blank, slot-less item rather than store an empty ask
    const perItemDue = parseDueDate(it.dueDate);
    if (perItemDue === "bad") {
      return NextResponse.json({ ok: false, error: "Enter a valid deadline date." }, { status: 400 });
    }
    const note = typeof it.note === "string" && it.note.trim() ? it.note.trim().slice(0, MAX_NOTE) : null;
    drafts.push({
      id: id(),
      seafarerId,
      agentId: session.agentId,
      requestedBy,
      requiredType,
      label,
      note,
      // A per-item deadline wins; otherwise the checklist-wide one.
      dueDate: perItemDue ?? sharedDue,
      status: "pending",
      createdAt: now,
      resolvedAt: null,
      resolvedVia: null,
    });
  }
  if (drafts.length === 0) {
    return NextResponse.json({ ok: false, error: "Add at least one document to request." }, { status: 400 });
  }

  await updateDB((db) => {
    for (const d of drafts) db.docRequests.push(d);
    // Bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(db, seafarerId);
  });

  // Optional: e-mail the seaman one checklist summary + their upload link.
  // §D7 — a sample subject is never notified (send skipped, log kept clean).
  let notified: { delivered: boolean; delivery: string } | null = null;
  if (body.notify === true && scoped.seafarer.isSample !== true) {
    const to = scoped.seafarer.ownerEmail?.trim() || null;
    const origin = getPublicBaseUrl(req);
    const link = `${origin}/share/${scoped.seafarer.openShareToken}`;
    const lines = drafts.map((d) => {
      const due = d.dueDate ? ` — due ${d.dueDate}` : "";
      const note = d.note ? ` (${d.note})` : "";
      return `• ${d.label}${due}${note}`;
    });
    const emailBody =
      `Hello ${scoped.seafarer.name || "seafarer"},\n\n` +
      `${requestedBy} needs the following document(s) from you:\n\n` +
      `${lines.join("\n")}\n\n` +
      `Please upload them here: ${link}\n\n` +
      `— sent via docka`;
    const res = await send({
      channel: "email",
      to: { name: scoped.seafarer.name, email: to },
      subject: `Documents needed${drafts.some((d) => d.dueDate) ? " (with deadlines)" : ""}`,
      message: emailBody,
      kind: "doc-request",
    });
    notified = { delivered: res.delivered, delivery: deliveryNote(res, to) };
  }

  const requests = sortForDisplay(requestsForSeafarer(session.agentId, seafarerId));
  return NextResponse.json({
    ok: true,
    created: drafts.length,
    requests,
    summary: summarizeRequests(requests),
    notified,
  });
}

// PATCH /api/doc-requests
//   { id, status?, dueDate? }
//
// Update ONE checklist item the agent owns: mark it received / waived / cancelled
// (or re-open to pending), and/or change its deadline. Tenant + grant scoped: the
// item must belong to THIS agent's tenant AND the agent must still hold a live grant
// to the seafarer, or it 404s with no write.
export async function PATCH(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    status?: unknown;
    dueDate?: unknown;
  };
  const requestId = typeof body.id === "string" ? body.id.trim() : "";
  if (!requestId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }

  const existing = readDB().docRequests.find((r) => r.id === requestId) ?? null;
  // Tenant + grant guard: own-tenant row AND a live grant to its seafarer.
  if (
    !existing ||
    existing.agentId !== session.agentId ||
    !checkAccess(session.agentId, existing.seafarerId).allowed
  ) {
    return NextResponse.json({ ok: false, error: "Request not found." }, { status: 404 });
  }

  const validStatuses: DocRequestStatus[] = ["pending", "received", "waived", "cancelled"];
  let nextStatus: DocRequestStatus | undefined;
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !validStatuses.includes(body.status as DocRequestStatus)) {
      return NextResponse.json({ ok: false, error: "Invalid status." }, { status: 400 });
    }
    nextStatus = body.status as DocRequestStatus;
  }

  let nextDue: string | null | undefined;
  if (body.dueDate !== undefined) {
    const parsed = parseDueDate(body.dueDate);
    if (parsed === "bad") {
      return NextResponse.json({ ok: false, error: "Enter a valid deadline date." }, { status: 400 });
    }
    nextDue = parsed;
  }

  const now = new Date().toISOString();
  const result = await updateDB((db) => {
    const r = db.docRequests.find((x) => x.id === requestId);
    if (!r) return null;
    if (nextDue !== undefined) r.dueDate = nextDue;
    if (nextStatus !== undefined && nextStatus !== r.status) {
      r.status = nextStatus;
      if (nextStatus === "pending") {
        r.resolvedAt = null;
        r.resolvedVia = null;
      } else {
        r.resolvedAt = now;
        r.resolvedVia = "agent";
      }
    }
    return r;
  });
  if (!result) {
    return NextResponse.json({ ok: false, error: "Request not found." }, { status: 404 });
  }

  const requests = sortForDisplay(requestsForSeafarer(session.agentId, existing.seafarerId));
  return NextResponse.json({
    ok: true,
    request: result,
    dueState: dueState(result),
    requests,
    summary: summarizeRequests(requests),
  });
}
