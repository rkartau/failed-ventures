import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  updateDB,
  id,
  type Doc,
  type Seafarer,
  type NotifyChannel,
  type ReminderSentEntry,
} from "@/lib/db";
import { cronAuthorized } from "@/lib/cron-auth";
import { activeDocs } from "@/lib/archive";
import { docStatus } from "@/lib/cert";
import {
  computeReminderDates,
  docHasReminderExpiry,
  settingsFromSeafarer,
} from "@/lib/reminders-calendar";
import { effectiveValidUntil } from "@/lib/cert-rules";
import { effectiveGrantStatus, isReadableStatus } from "@/lib/access";
import { send } from "@/lib/notify";

export const dynamic = "force-dynamic";

// SYSTEM cron entry point — NOT an agent- or seaman-scoped request.
//
// GET/POST /api/cron/reminders  (called daily by a pm2 cron / curl on the box)
//
// Walks every seafarer's active documents, asks lib/reminders-calendar which ones
// have a reminder falling on TODAY (UTC), and routes each due reminder through the
// shared lib/notify channel to (a) the seaman who owns the profile and (b) every
// agent currently holding a readable grant on that seafarer. A `remindersSent`
// ledger in db.json makes a same-day re-run idempotent: a (doc, recipient, day)
// already sent is never sent twice.
//
// This is a trusted system job — it reads across ALL tenants by design (it must
// reach every tenant's agents) and is gated by a shared secret, so it resolves
// neither the agent-session role gate nor the seaman-session role gate, and is
// outside the per-request tenant isolation guard by construction (like the seed
// scripts and the /api/calendar possession-token export).
//
// AUTH: `Authorization: Bearer <CRON_SECRET>` or `?secret=<CRON_SECRET>`. If
// CRON_SECRET is unset it runs only in non-production (local/dev convenience).

const CHANNEL: NotifyChannel = "email";

function authorized(req: NextRequest): boolean {
  // ONE implementation, shared with the billing cron (fix-plan C1).
  return cronAuthorized({
    authorization: req.headers.get("authorization"),
    secretParam: new URL(req.url).searchParams.get("secret"),
  });
}

function todayKeyUTC(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// One honest renewal line per due document, e.g. "ENG1 medical expires 12 Aug 2026".
// The date shown is the LEGAL expiry (cert-rules shortens an age-restricted medical
// etc.), not the possibly-optimistic printed date — the same date the schedule fires on.
function renewalMessage(name: string, docs: Doc[], holderDOB?: string | null): string {
  const parts = docs.map((d) => {
    const effective = effectiveValidUntil(d, holderDOB);
    const st = docStatus(effective);
    const verb = st === "expired" ? "expired" : "expires";
    return `${d.title} ${verb} ${fmtDate(effective)}`.trim();
  });
  return (
    `Hello ${name || "seafarer"},\n\n` +
    `The following certificate(s) need attention:\n` +
    parts.map((p) => `  - ${p}`).join("\n") +
    `\n\nPlease arrange renewal in good time.`
  );
}

type RecipientPlan = {
  /** Dedupe bucket key: "seaman" or `agent:<agentId>`. */
  bucket: string;
  name: string;
  email: string | null;
};

// GET and POST are equivalent — cron schedulers use whichever is convenient.
async function run(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const now = new Date();
  const todayKey = todayKeyUTC(now);
  const db = readDB();

  // Fast lookup of what has already been sent today (doc + recipient bucket).
  const alreadySent = new Set(
    db.remindersSent
      .filter((r) => r.reminderDate === todayKey)
      .map((r) => `${r.docId}::${r.recipient}`)
  );

  type Delivery = {
    seafarer: Seafarer;
    recipient: RecipientPlan;
    docs: Doc[];
  };
  const deliveries: Delivery[] = [];
  let seafarersWithDue = 0;

  for (const s of db.seafarers) {
    // §D7 — sample subjects are excluded from the reminder cron entirely.
    if (s.isSample === true) continue;
    const settings = settingsFromSeafarer(s);
    const docs = activeDocs(db.documents.filter((d) => d.seafarerId === s.id));

    // Documents whose reminder schedule lands ON today (UTC).
    const dueDocs = docs.filter((d) => {
      if (!docHasReminderExpiry(d)) return false;
      // Schedule against the LEGAL expiry (age-shortened medical etc.), not the
      // printed date — so a doc that is legally expired earlier is reminded on time.
      const dates = computeReminderDates(effectiveValidUntil(d, s.birthDate), settings, now);
      return dates.some((dt) => dt.toISOString().slice(0, 10) === todayKey);
    });
    if (dueDocs.length === 0) continue;
    seafarersWithDue++;

    // Recipient list: the seaman, plus every agent with a currently-readable grant.
    const recipients: RecipientPlan[] = [];
    recipients.push({ bucket: "seaman", name: s.name, email: s.ownerEmail ?? null });
    for (const g of db.accessGrants) {
      if (g.seafarerId !== s.id) continue;
      const eff = effectiveGrantStatus(g, db.assignments);
      if (!isReadableStatus(eff.status)) continue;
      const agent = db.agents.find((a) => a.id === g.agentId);
      if (!agent) continue;
      const email = agent.contact.includes("@") ? agent.contact : null;
      recipients.push({ bucket: `agent:${agent.id}`, name: agent.orgName, email });
    }

    for (const recipient of recipients) {
      // Per-recipient dedupe: only the docs NOT already sent to this bucket today.
      const fresh = dueDocs.filter((d) => !alreadySent.has(`${d.id}::${recipient.bucket}`));
      if (fresh.length === 0) continue;
      deliveries.push({ seafarer: s, recipient, docs: fresh });
    }
  }

  // Fire notifications + record the sent ledger. Each send() is itself serialized
  // (it records to the notifications log); the ledger append is one final write.
  const sentEntries: ReminderSentEntry[] = [];
  let delivered = 0;
  let loggedOnly = 0;
  let failed = 0;

  for (const d of deliveries) {
    const subject = `Certificate renewal reminder — ${d.seafarer.name}`.trim();
    const message = renewalMessage(d.seafarer.name, d.docs, d.seafarer.birthDate);
    const res = await send({
      channel: CHANNEL,
      to: { name: d.recipient.name, email: d.recipient.email },
      subject,
      message,
      kind: "reminder:renewal",
    });
    if (res.delivered) delivered++;
    else if (res.status === "failed") failed++;
    else loggedOnly++;

    // Record the ledger row per document so a same-day re-run skips these.
    for (const doc of d.docs) {
      sentEntries.push({
        id: id(),
        docId: doc.id,
        seafarerId: d.seafarer.id,
        recipient: d.recipient.bucket,
        reminderDate: todayKey,
        channel: CHANNEL,
        sentAt: new Date().toISOString(),
      });
    }
  }

  if (sentEntries.length > 0) {
    await updateDB((store) => {
      store.remindersSent.push(...sentEntries);
    });
  }

  return NextResponse.json({
    ok: true,
    date: todayKey,
    seafarersScanned: db.seafarers.length,
    seafarersWithDue,
    remindersAttempted: deliveries.length,
    delivered,
    loggedOnly,
    failed,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
