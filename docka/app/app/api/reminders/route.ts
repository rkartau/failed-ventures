import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type Comment, type Doc, type NotifyChannel } from "@/lib/db";
import { docStatus } from "@/lib/cert";
import { completeness } from "@/lib/doctypes";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { listSeafarersForAgent } from "@/lib/agentData";
import { activeDocs } from "@/lib/archive";
import { send, type NotifyResult } from "@/lib/notify";
import { effectiveValidUntil } from "@/lib/cert-rules";
import { getPublicBaseUrl } from "@/lib/base-url";
import { claimStateOf, isClaimed, placeholderManagedBy } from "@/lib/claim-state";
import { isEmailish } from "@/lib/roster-parse";
import { claimInviteRateLimited } from "@/lib/claim-invite-rate-limit";
import { agencyDisplayName } from "@/lib/billing-store";
import { composeClaimInvite } from "@/lib/email-template";

export const dynamic = "force-dynamic";
// sample-token: exempt(link-construction only — the token is embedded into outbound
// reminder links, never used to authorise the caller; sample recipients are skipped)

type ReminderKind = "request" | "renewal" | "claim";

// A hijacked agent session is bounded to (id cap × per-minute limiter) claim
// addresses; the UI only ever sends one id per POST.
const CLAIM_ID_CAP = 50;

// Email today; the notify channel stubs SMS/WhatsApp behind the same interface, so
// switching or adding a channel here is a one-line change once a transport ships.
const CHANNEL: NotifyChannel = "email";

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Build the per-seaman body of the reminder from what that man actually needs,
// so a bulk action produces a specific, honest note per crew member — not one
// canned sentence. "request" lists the missing required documents; "renewal"
// lists the expired / soon-to-expire certificates.
function messageFor(kind: ReminderKind, docs: Doc[], holderDOB?: string | null): string {
  if (kind === "claim") {
    // Fixed template only — no free-text relay for the claim kind (A2a).
    return (
      "Your crewing agency has prepared your docka profile — open the link to claim it " +
      "and upload your certificates."
    );
  }
  if (kind === "request") {
    const c = completeness(docs.map((d) => d.requiredType));
    return c.missing.length
      ? `Document request — please upload: ${c.missing.join(", ")}.`
      : "Document request — please confirm your file is complete and up to date.";
  }
  // renewal — judge each cert on its LEGAL expiry (cert-rules shortens an age-based
  // medical etc.), not the printed date, so a legally-expired cert is flagged for renewal.
  const worst: { title: string; when: string; expired: boolean }[] = [];
  for (const d of docs) {
    const effective = effectiveValidUntil(d, holderDOB);
    const st = docStatus(effective);
    if (st === "expired" || st === "expiring") {
      worst.push({ title: d.title, when: fmtDate(effective), expired: st === "expired" });
    }
  }
  if (!worst.length) return "Renewal reminder — please keep your certificates up to date.";
  const parts = worst
    .slice(0, 6)
    .map((w) => `${w.title} ${w.expired ? "expired" : "expires"} ${w.when}`.trim());
  return `Renewal reminder — renew: ${parts.join("; ")}.`;
}

// A short, human delivery outcome for the audit trail + the agent's result panel,
// so the recorded note reflects what ACTUALLY happened (real send / logged-only /
// failed / no address) instead of always claiming "sent".
function deliveryNote(res: NotifyResult, to: string | null): string {
  if (res.delivered) return `emailed to ${to}`;
  if (res.status === "failed") return `email failed (${res.reason ?? "unknown error"})`;
  if (!to) return "recorded only — no e-mail on file for this seaman";
  return `recorded only (${res.reason ?? "channel not configured"})`;
}

// POST /api/reminders
//   { seafarerIds: string[], kind: "request" | "renewal", note?: string }
//
// Bulk document-request / renewal-reminder for existing crew. For every selected
// man this now (1) actually SENDS the nudge through the shared lib/notify channel
// to the seaman's e-mail (email today; SMS/WhatsApp stubbed behind the same
// interface), (2) records the honest delivery outcome to that seaman's audit
// trail, and (3) returns his self-upload share link + delivery status so the agent
// can see who was reached and pass the link on to anyone who wasn't. This is the
// multi-select counterpart to the single-seaman review flow, for fleets of 150+
// where chasing each man individually is not workable.
export async function POST(req: NextRequest) {
  // Agent-only: reuse the same session gate as the rest of the agent area.
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    seafarerIds?: unknown;
    kind?: unknown;
    note?: unknown;
  };

  const seafarerIds = Array.isArray(body.seafarerIds)
    ? Array.from(new Set(body.seafarerIds.map((x) => String(x)).filter(Boolean)))
    : [];
  const kind: ReminderKind =
    body.kind === "request" ? "request" : body.kind === "claim" ? "claim" : "renewal";
  const extraNote = typeof body.note === "string" ? body.note.trim() : "";

  if (seafarerIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Select at least one crew member." },
      { status: 400 }
    );
  }

  // A2(b) cap + A2(c) rate limit — claim only. Bounds a hijacked agent session; the
  // single-row UI never hits either.
  if (kind === "claim") {
    if (seafarerIds.length > CLAIM_ID_CAP) {
      return NextResponse.json(
        { ok: false, error: "Send invites to at most 50 crew at a time." },
        { status: 400 }
      );
    }
    if (claimInviteRateLimited(session.agentId)) {
      return NextResponse.json(
        { ok: false, error: "Too many invites — wait a minute and try again." },
        { status: 429 }
      );
    }
  }

  const db = readDB();
  // GRANT-SCOPE the target ids: an agent may only remind seafarers they hold a
  // live grant for. Any id outside that set is dropped BEFORE we read its name /
  // share token / e-mail, so a replayed session with a foreign seafarerId can never
  // leak that seafarer's details (cross-tenant read leak).
  const allowedIds = new Set(listSeafarersForAgent(session.agentId, false).map((s) => s.id));
  const author = session.user.name || session.user.email || "Agent";
  // Real agency name for the branded claim invite: billing legalName, else the signup
  // handle (orgName), else a neutral generic — resolved ONCE for the batch. Only the
  // claim kind renders it; request/renewal are untouched.
  const agentOrgName = db.agents.find((a) => a.id === session.agentId)?.orgName ?? null;
  const agencyName = agencyDisplayName(session.agentId, agentOrgName);
  const label =
    kind === "request"
      ? "DOCUMENT REQUEST"
      : kind === "claim"
        ? "PROFILE INVITE"
        : "RENEWAL REMINDER";
  const origin = getPublicBaseUrl(req);

  const reminders: {
    seafarerId: string;
    name: string;
    shareToken: string;
    message: string;
    delivered: boolean;
    delivery: string;
  }[] = [];
  const newComments: Comment[] = [];
  // R2-4: ONLY grant-scoped ids ever appear here — every push sits strictly AFTER the
  // grant-scope + unknown-id `continue`s below, so `skipped` is never an existence oracle.
  const skipped: { id: string; reason: string }[] = [];
  // Ids that reached the send step as placeholders — their idle window is refreshed
  // (stamp deleted) on commit, with a live re-check (R2-5).
  const claimRefreshIds: string[] = [];
  let delivered = 0;

  for (const sid of seafarerIds) {
    if (!allowedIds.has(sid)) continue; // not granted to this agent — never touched
    const s = db.seafarers.find((x) => x.id === sid);
    if (!s) continue; // silently skip unknown ids — a partial select is fine
    // §D7 — sample subjects never receive notifications and never pollute the
    // notifications log or the audit comment trail.
    if (s.isSample === true) continue;
    // CLAIM kind is placeholder-only + creator-gated: a claimed profile's PRIVATE
    // dashboard link must NEVER be mailed, even on a stale/forged client request. Both
    // skip pushes sit AFTER the grant-scope + unknown-id continues above (R2-4).
    if (kind === "claim") {
      const st = claimStateOf(s);
      if (st.kind !== "placeholder") {
        skipped.push({ id: sid, reason: st.kind === "claimed" ? "claimed" : "not-placeholder" });
        continue;
      }
      if (!placeholderManagedBy(s, session.agentId)) {
        skipped.push({ id: sid, reason: "not-creator" });
        continue;
      }
    }
    // ACTIVE docs only — a reminder's missing/expiry summary ignores archived docs.
    const docs = activeDocs(db.documents.filter((d) => d.seafarerId === sid));
    let message = messageFor(kind, docs, s.birthDate);
    // A2(a) — the claim kind is a fixed template; agent free-text is never relayed.
    if (extraNote && kind !== "claim") message += ` ${extraNote}`;

    // Actually send it. The seaman is the recipient; his self-upload link rides in
    // the body so the nudge is actionable. notify() never throws — a missing e-mail
    // or unconfigured SMTP resolves to a recorded "logged only" result.
    //   claim → importedEmail (the roster contact, re-validated at send time); the
    //           /seafarer?token= claim link. request/renewal → ownerEmail + /share/.
    const to =
      kind === "claim"
        ? isEmailish(s.importedEmail ?? "")
          ? s.importedEmail!.trim().toLowerCase()
          : null
        : s.ownerEmail?.trim() || null;
    const shareUrl =
      kind === "claim" ? `${origin}/seafarer?token=${s.shareToken}` : `${origin}/share/${s.shareToken}`;
    // CLAIM: a branded HTML invite (+ improved plain-text fallback) naming the real
    // agency. request/renewal keep the plain-text nudge exactly as before (no html).
    const claim = kind === "claim"
      ? composeClaimInvite({ seafarerName: s.name, agencyName, claimUrl: shareUrl })
      : null;
    const subject = claim
      ? claim.subject
      : kind === "request"
        ? `Document request — ${s.name}`.trim()
        : `Certificate renewal reminder — ${s.name}`.trim();
    const emailBody = claim
      ? claim.text
      : `Hello ${s.name || "seafarer"},\n\n` +
        `${message}\n\n` +
        `Upload or review your documents here:\n${shareUrl}\n\n` +
        `— sent via docka on behalf of ${author}`;

    const res = await send({
      channel: CHANNEL,
      to: { name: s.name, email: to },
      subject,
      message: emailBody,
      html: claim?.html,
      kind: `reminder:${kind}`,
    });
    if (kind === "claim") claimRefreshIds.push(sid);
    if (res.delivered) delivered++;
    const note = deliveryNote(res, to);

    // The claim kind ALSO refreshes the idle window (Send = Refresh, A3), so its audit
    // line names that action rather than "sent" — honest on the recorded-only path too.
    const auditText =
      kind === "claim"
        ? `${label} — link refreshed [${note}]`
        : `${label} sent — ${message} [${note}]`;
    newComments.push({
      id: id(),
      documentId: null,
      seafarerId: sid,
      authorName: author,
      text: auditText,
      createdAt: new Date().toISOString(),
    });
    reminders.push({
      seafarerId: sid,
      name: s.name,
      shareToken: s.shareToken,
      message,
      delivered: res.delivered,
      delivery: note,
    });
  }

  if (reminders.length === 0) {
    // T4 — a claim POST whose only granted rows were ALL already claimed gets a
    // specific 409 (so the panel can say "already claimed"); everything else keeps
    // today's indistinguishable 404 (no existence signal from a foreign/unknown id).
    if (kind === "claim" && skipped.length > 0 && skipped.every((x) => x.reason === "claimed")) {
      return NextResponse.json(
        {
          ok: false,
          error: "This profile has already been claimed — no invite sent.",
          claimed: true,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "None of the selected crew were found." },
      { status: 404 }
    );
  }

  await updateDB((d) => {
    d.comments.push(...newComments);
    // R2-5 — refresh the idle window for every claim row that reached the send step,
    // re-checking the LIVE row inside the mutex: a seaman may have claimed it during
    // the awaited send() above. Deleting the stamp on a now-claimed row would re-open
    // a 24h window on what is now the seaman's PRIVATE dashboard link; skipping it
    // costs nothing (the seaman is signed in). Absent stamp == fresh window.
    for (const sid of claimRefreshIds) {
      const fresh = d.seafarers.find((x) => x.id === sid);
      if (!fresh || fresh.isSample === true || isClaimed(fresh)) continue;
      delete fresh.shareTokenLastUsedAt;
    }
  });

  return NextResponse.json({
    ok: true,
    kind,
    count: reminders.length,
    delivered,
    reminders,
    ...(kind === "claim" ? { skipped } : null),
  });
}
