// app/admin/outreach/page.tsx — cold-email campaign pipeline dashboard.
//
// READ-ONLY viewer over the last uploaded board.json snapshot (produced by an
// external outreach pipeline tool; nothing here sends email). Re-checks
// adminSession() (Layer C, per-page — the layout is not a substitute). All
// logic lives in lib/outreach-snapshot.ts; this page only renders. send_key is
// display-only and appears ONLY as a title tooltip — never inside a link.

import { Fragment } from "react";
import Link from "next/link";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { recordAdminAction } from "@/lib/admin-audit";
import {
  EXTENDED_STAGES,
  MAX_RENDER_ROWS,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  annotateBookingCall,
  freshness,
  isOverdue,
  pendingDrafts,
  queueOrder,
  repliedPlusCount,
  stageCounts,
  visibleLeads,
  type ArmStats,
  type MailboxStats,
  type OutreachLead,
  type OutreachRunsheetItem,
} from "@/lib/outreach-snapshot";
import { readOutreachSnapshot } from "@/lib/outreach-snapshot-store";
import { readDB } from "@/lib/db";
import {
  holdDisposition,
  companyHoldCount,
  latestMoveFor,
  pendingDecisionFor,
  type OutreachOverrides,
} from "@/lib/outreach-overrides";
import { headers } from "next/headers";
import { getPublicBaseUrl } from "@/lib/base-url";
import { Card, Kpi, fmtDate, fmtDateTime, BADGE, toggleParamHref } from "../ui";
import { UploadBoard, LeadHoldControls, DraftDecision, NeedsHumanCard } from "./actions";
import { BookingLinkPanel } from "./booking-link";
import { LeadTimeline } from "./timeline";

export const dynamic = "force-dynamic";

/** Canonical public /book URL, resolved server-side (AUTH_URL → x-forwarded-host → origin). */
function bookingUrl(): string {
  return `${getPublicBaseUrl({ headers: headers() })}/book`;
}

function clip(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Extra classes layered onto a funnel stage box: a persistent ring for the
 * active stage, a hover ring otherwise. cursor-pointer signals it is clickable.
 * Layout/size classes stay on the box itself so the visual footprint is unchanged. */
function stageBoxExtras(active: boolean): string {
  return active
    ? "block cursor-pointer ring-2 ring-sky-400"
    : "block cursor-pointer hover:ring-1 hover:ring-slate-300";
}

const STAGE_BADGE: Record<string, string> = {
  trial_won: "border-emerald-200 bg-emerald-50 text-emerald-700",
  replied: "border-sky-200 bg-sky-50 text-sky-700",
  conversation: "border-sky-200 bg-sky-50 text-sky-700",
  queued: "border-slate-200 bg-slate-100 text-slate-600",
  email1: "border-slate-200 bg-slate-100 text-slate-600",
  followup: "border-slate-200 bg-slate-100 text-slate-600",
  breakup: "border-slate-200 bg-slate-100 text-slate-600",
  suppressed: "border-slate-200 bg-white text-slate-400",
  closed: "border-slate-200 bg-white text-slate-400",
  // Increment 6: real-world-flow stages (EXTENDED_STAGES).
  signed_up: "border-emerald-200 bg-emerald-50 text-emerald-700",
  re_engage: "border-sky-200 bg-sky-50 text-sky-700",
  snoozed: "border-amber-200 bg-amber-50 text-amber-700",
  paused_ooo: "border-amber-200 bg-amber-50 text-amber-700",
  referred: "border-slate-200 bg-slate-100 text-slate-600",
  closed_lost: "border-slate-200 bg-white text-slate-400",
  undeliverable: "border-rose-200 bg-white text-rose-400",
  unknown: "border-amber-200 bg-amber-50 text-amber-700",
};

const SENTIMENT_BADGE: Record<string, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-700",
  neutral: "border-slate-200 bg-slate-100 text-slate-600",
  negative: "border-amber-200 bg-amber-50 text-amber-700",
  hostile: "border-rose-200 bg-rose-50 text-rose-700",
  none: "border-slate-200 bg-white text-slate-400",
};

/** One arm's counters (Increment 5/6). Presentational; null renders "—". */
function ArmCard({
  name,
  label,
  stats,
}: {
  name: string;
  label: string;
  stats: ArmStats;
}): JSX.Element {
  const cell = (v: number | null) => (v === null ? "—" : v);
  return (
    <div data-testid={`outreach-arm-${name}`}>
      <Card title={label}>
        <div className="mt-2 grid grid-cols-5 gap-2 text-center">
          {(
            [
              ["Sends", stats.sends],
              ["Replies", stats.replies],
              ["Positive", stats.positiveReplies],
              ["Bookings", stats.bookings],
              ["Signups", stats.signups],
            ] as const
          ).map(([l, v]) => (
            <div key={l} className="rounded-lg border border-slate-200 bg-slate-50 px-1 py-1.5">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">{l}</p>
              <p className="text-lg font-bold text-slate-900">{cell(v)}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Per-mailbox send-count panel. Rendered ONLY when campaign.mailboxes is
 * present and non-empty (matches the arms precedent — no "not reported" note).
 * Read-only; one row per sending address, no links. */
function MailboxPanel({ mailboxes }: { mailboxes: MailboxStats[] }): JSX.Element {
  return (
    <div data-testid="outreach-mailboxes">
      <Card title="Mailboxes" subtitle="sends per sending address">
        <ul className="mt-2 divide-y divide-slate-100">
          {mailboxes.map((mb, i) => (
            <li
              key={`${mb.address}-${i}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2 last:border-b-0"
              data-testid="outreach-mailbox-row"
            >
              <span className="font-mono text-sm text-slate-800">{mb.address}</span>
              {mb.flow !== null ? (
                <span className={`${BADGE} border-slate-200 bg-white text-slate-600`}>
                  Flow {mb.flow}
                </span>
              ) : null}
              <span className="ml-auto tabular-nums text-xs text-slate-500">
                {mb.sendsToday ?? "—"} / {mb.cap ?? "—"} today
              </span>
              <span className="tabular-nums text-xs text-slate-400">
                {mb.sendsTotal ?? "—"} total
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function StageBadge({ stage }: { stage: string }): JSX.Element {
  return (
    <span className={`${BADGE} ${STAGE_BADGE[stage] ?? STAGE_BADGE.unknown}`}>{stage}</span>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }): JSX.Element {
  return (
    <span className={`${BADGE} ${SENTIMENT_BADGE[sentiment] ?? SENTIMENT_BADGE.none}`}>
      {sentiment}
    </span>
  );
}

/** Compact engagement cell (Plan D3): opens / booked / bounced counters folded
 * by the pipeline. A null counter (older board.json) shows "—"; each number
 * carries a full-word tooltip so the letters need no legend. */
function EngagementCell({ lead }: { lead: OutreachLead }): JSX.Element {
  if (lead.opens === null && lead.booked === null && lead.bounced === null) {
    return <span className="text-slate-300">—</span>;
  }
  const opens = lead.opens ?? 0;
  const booked = lead.booked ?? 0;
  const bounced = lead.bounced ?? 0;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums text-xs">
      <span className={opens > 0 ? "text-slate-700" : "text-slate-300"} title="Opens">
        {opens}o
      </span>
      <span className={booked > 0 ? "font-semibold text-emerald-700" : "text-slate-300"} title="Booked calls">
        {booked}b
      </span>
      <span className={bounced > 0 ? "font-semibold text-rose-700" : "text-slate-300"} title="Bounces">
        {bounced}x
      </span>
    </span>
  );
}

// ---- "Waiting for you" queue (schema v4, wave 3 M1) ----------------------
//
// One filtered, sorted list of everything the pipeline is waiting on the
// operator for. Server-rendered from the uploaded snapshot ONLY — it is part
// of the adminSession-gated page, so an unauthenticated request never sees a
// draft body. Every string goes through React text escaping.

const QUEUE_BADGE: Record<string, string> = {
  halt: "border-rose-200 bg-rose-50 text-rose-700",
  fetch_degraded: "border-rose-200 bg-rose-50 text-rose-700",
  draft_pending: "border-sky-200 bg-sky-50 text-sky-700",
  needs_human: "border-amber-200 bg-amber-50 text-amber-700",
  review: "border-amber-200 bg-amber-50 text-amber-700",
  unmatched_inbound: "border-amber-200 bg-amber-50 text-amber-700",
  draft_failed: "border-amber-200 bg-amber-50 text-amber-700",
  draft_discarded: "border-slate-200 bg-slate-100 text-slate-600",
  publish_stale: "border-slate-200 bg-slate-100 text-slate-600",
  lead_source_stale: "border-slate-200 bg-slate-100 text-slate-600",
  next_action: "border-slate-200 bg-white text-slate-600",
};

/** Human label for a queue row kind (terse — the detail lives in tooltips). */
const QUEUE_KIND_LABEL: Record<string, string> = {
  halt: "halt",
  fetch_degraded: "degraded",
  draft_pending: "draft",
  needs_human: "Needs a human look",
  review: "review",
  unmatched_inbound: "unmatched",
  draft_failed: "failed",
  draft_discarded: "discarded",
  publish_stale: "publish",
  lead_source_stale: "leads",
  next_action: "to do",
};

function QueueRow({
  item,
  overrides,
}: {
  item: OutreachRunsheetItem;
  overrides: OutreachOverrides;
}): JSX.Element {
  // A drafted answer is the one queue row the operator can DECIDE on: render
  // the full detail view + Approve / Approve-with-edits / Reject in its place.
  if (item.kind === "draft_pending" && item.draftId !== null) {
    const queued = pendingDecisionFor(overrides, item.draftId);
    return (
      <li className="py-1.5" data-testid="outreach-queue-row-draft_pending">
        <DraftDecision
          draftId={item.draftId}
          label={item.label}
          company={item.company}
          sendKey={item.sendKey}
          subject={item.subject}
          body={item.bodyFull}
          bodyTruncated={item.bodyTruncated}
          footer={item.footer}
          inboundBody={item.inboundBody}
          inboundBodyTruncated={item.inboundBodyTruncated}
          inboundSubject={item.inboundSubject}
          inboundFromDomain={item.inboundFromDomain}
          inboundTs={item.inboundTs}
          ts={item.ts}
          decided={queued ? { action: queued.action, ts: queued.ts } : null}
        />
      </li>
    );
  }
  // A stopped-on-suspected-auto-ack row: the operator says "machine" (the
  // sequence resumes) or "person" (the card closes, they answer from Gmail).
  if (item.kind === "needs_human" && item.draftId !== null) {
    const queued = pendingDecisionFor(overrides, item.draftId);
    return (
      <li className="py-1.5" data-testid="outreach-queue-row-needs_human">
        <NeedsHumanCard
          draftId={item.draftId}
          label={item.label}
          company={item.company}
          sendKey={item.sendKey}
          subject={item.subject}
          note={item.note}
          inboundBody={item.inboundBody}
          inboundBodyTruncated={item.inboundBodyTruncated}
          inboundSubject={item.inboundSubject}
          inboundFromDomain={item.inboundFromDomain}
          inboundTs={item.inboundTs}
          ts={item.ts}
          decided={queued ? { action: queued.action, ts: queued.ts } : null}
        />
      </li>
    );
  }
  const stamp = item.ts ? fmtDateTime(Date.parse(item.ts)) : "—";
  const body = (
    <>
      <span className={`${BADGE} ${QUEUE_BADGE[item.kind] ?? QUEUE_BADGE.next_action}`}>
        {QUEUE_KIND_LABEL[item.kind] ?? item.kind}
      </span>
      <span className="ml-2 text-sm text-slate-700">{item.label}</span>
      <span className="ml-2 text-xs text-slate-400">{stamp}</span>
    </>
  );
  return (
    <li className="py-1.5" data-testid={`outreach-queue-row-${item.kind}`}>
      {item.sendKey ? (
        // Click-through to the lead's row in the table below (same page — the
        // send_key is an anchor target, never a link target off-site).
        <a href={`#lead-${encodeURIComponent(item.sendKey)}`} className="hover:underline">
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}

function WaitingForYou({
  rows,
  overrides,
}: {
  rows: OutreachRunsheetItem[] | undefined;
  overrides: OutreachOverrides;
}): JSX.Element {
  if (rows === undefined) {
    return (
      <Card title="Waiting for you">
        <p className="mt-2 text-sm text-slate-500" data-testid="outreach-queue-unavailable">
          This snapshot predates the queue (board.json v3) — upload a v4 board from the
          pipeline to see it.
        </p>
      </Card>
    );
  }
  const ordered = queueOrder(rows);
  const drafts = pendingDrafts(rows).length;
  if (ordered.length === 0) {
    return (
      <Card title="Waiting for you">
        <p className="mt-2 text-sm text-slate-500" data-testid="outreach-queue-empty">
          Nothing waiting. No drafts to approve, no reviews, no blockers.
        </p>
      </Card>
    );
  }
  return (
    <div data-testid="outreach-queue">
      <Card
        title={`Waiting for you (${ordered.length})`}
      >
        <p className="mt-1 text-xs text-slate-400" data-testid="outreach-queue-counts">
          {drafts} draft{drafts === 1 ? "" : "s"} to approve · {ordered.length - drafts} other
          item{ordered.length - drafts === 1 ? "" : "s"}
        </p>
        <ul className="mt-2 divide-y divide-slate-100">
          {ordered.map((item, i) => (
            <QueueRow
              key={`${item.kind}-${item.draftId ?? item.sendKey ?? i}`}
              item={item}
              overrides={overrides}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LeadRow({
  lead,
  now,
  booked,
  overrides,
  allLeads,
}: {
  lead: OutreachLead;
  now: number;
  /** Pre-computed by annotateBookingCall (byKey lookup) in the page — LeadRow stays
   * presentational and does no lookups itself. */
  booked: boolean;
  overrides: OutreachOverrides;
  allLeads: OutreachLead[];
}): JSX.Element {
  const lastEventClipped = clip(lead.lastEvent);
  const nextActionClipped = lead.nextAction ? clip(lead.nextAction) : null;
  const overdue = isOverdue(lead.nextActionDue, now);
  // [R10] Held badge + controls are derived SOLELY from the APP override store,
  // never from the board's echoed manualHold (which lags one cycle).
  const disp = holdDisposition(overrides, { sendKey: lead.sendKey, company: lead.company });
  const move = latestMoveFor(overrides, lead.sendKey);
  return (
    <tr className="hover:bg-slate-50" id={lead.sendKey ? `lead-${lead.sendKey}` : undefined}>
      <td className="px-3 py-2 font-medium text-slate-800" title={lead.sendKey || undefined}>
        {lead.company}
        {disp.held ? (
          <span
            className={`${BADGE} ml-1.5 border-amber-200 bg-amber-50 text-amber-700`}
            title={disp.heldByCompany ? "Held by a company-wide hold" : "Held (per-lead)"}
          >
            held
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-slate-600">{lead.country}</td>
      <td className="px-3 py-2 text-slate-600">
        <span
          className={`${BADGE} border-slate-200 bg-white text-slate-600`}
          title={`Messaging angle ${lead.angle}`}
        >
          {lead.angle}
        </span>
      </td>
      <td className="px-3 py-2 text-slate-600">
        <StageBadge stage={lead.stage} />
        {booked ? (
          <span
            className={`${BADGE} ml-1.5 border-emerald-200 bg-emerald-50 text-emerald-700`}
            title="Booked via outreach link (reported, not verified)"
          >
            Booking call
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-slate-600">
        <SentimentBadge sentiment={lead.sentiment} />
      </td>
      <td className="px-3 py-2 text-slate-600">
        <EngagementCell lead={lead} />
      </td>
      <td
        className="px-3 py-2 text-slate-600"
        title={lastEventClipped !== lead.lastEvent ? lead.lastEvent : undefined}
      >
        {lastEventClipped}
        <div className="text-xs text-slate-400">
          {fmtDateTime(lead.lastEventAt ? Date.parse(lead.lastEventAt) : null)}
        </div>
      </td>
      <td
        className="px-3 py-2 text-slate-600"
        title={
          nextActionClipped !== null && nextActionClipped !== lead.nextAction
            ? lead.nextAction ?? undefined
            : undefined
        }
      >
        {nextActionClipped ?? "—"}
        <div
          className={`text-xs ${overdue ? "text-amber-600" : "text-slate-400"}`}
          title={overdue ? "Overdue" : undefined}
        >
          {fmtDate(lead.nextActionDue ? Date.parse(lead.nextActionDue) : null)}
        </div>
      </td>
      <td className="px-3 py-2">
        {lead.sendKey ? (
          <LeadHoldControls
            sendKey={lead.sendKey}
            company={lead.company}
            currentStage={lead.stage}
            heldByLead={disp.heldByLead}
            heldByCompany={disp.heldByCompany}
            companyCount={companyHoldCount(allLeads, lead.company)}
            moveStatus={move?.status ?? null}
            moveReason={move?.rejectedReason ?? null}
            pendingToStage={move && move.status === "pending" ? move.toStage : null}
          />
        ) : (
          <span className="text-[11px] text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

export default async function AdminOutreachPage({
  searchParams,
}: {
  searchParams?: { stage?: string | string[] };
}): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();
  const email = (session.user.email ?? "").trim().toLowerCase();

  // Click-to-filter: a ?stage= param filters the LEAD TABLE only (the funnel
  // counts always render the full distribution). null = no filter.
  const rawStage = Array.isArray(searchParams?.stage)
    ? searchParams?.stage[0]
    : searchParams?.stage;
  const activeStage = rawStage && rawStage.trim() ? rawStage.trim() : null;

  const snap = readOutreachSnapshot();
  // THE single db read of this render (the board itself comes from the SEPARATE
  // readOutreachSnapshot store). It feeds the booking overlay, the [R13] hold
  // badges, and the queue's pending-decision markers — on every render path,
  // including the empty-snapshot one.
  const db = readDB();
  const overrides = db.outreachOverrides;

  await recordAdminAction({
    adminEmail: email,
    action: "outreach-view",
    detail: { status: snap.status },
  });

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Outreach</h1>
        <p className="mt-1 text-sm text-slate-500">
          Cold-email campaign pipeline. Read-only snapshot.
        </p>
      </div>
      <UploadBoard />
    </div>
  );

  if (snap.status === "empty") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        {header}
        <div className="mt-6">
          <BookingLinkPanel url={bookingUrl()} />
        </div>
        <div className="mt-6">
          <WaitingForYou rows={[]} overrides={overrides} />
        </div>
        <div className="mt-6" data-testid="outreach-empty">
          <Card>
            <p className="text-sm text-slate-500">
              No campaign data yet — upload board.json from the outreach pipeline.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  if (snap.status === "corrupt") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        {header}
        <div className="mt-6 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          Stored snapshot unreadable — re-upload board.json.
        </div>
      </div>
    );
  }

  const { generatedAt, uploadedAt, campaign, leads, runsheet, warnings } = snap.snapshot;
  const now = Date.now();
  const fresh = freshness(generatedAt, now);
  // Suppressed leads (stage === "suppressed") will never be emailed, so they are
  // excluded from this page's ACTIVE working view — the funnel, the lead table,
  // and the Leads / Replied+ KPIs all compute over `activeLeads`. The full funnel
  // incl. suppressed still lives on /admin/flow; suppressedCount below keeps an
  // honest note of how many were hidden.
  const suppressedCount = leads.filter((l) => l.stage === "suppressed").length;
  const activeLeads = leads.filter((l) => l.stage !== "suppressed");
  const counts = stageCounts(activeLeads);
  const replied = repliedPlusCount(activeLeads);
  // `total` (Leads KPI) always reflects the FULL active distribution. The funnel
  // counts likewise stay over activeLeads. Only the TABLE narrows to activeStage.
  const { total } = visibleLeads(activeLeads);
  const tableLeads = activeStage
    ? activeLeads.filter((l) => l.stage === activeStage)
    : activeLeads;
  const { rows, total: tableTotal, truncated } = visibleLeads(tableLeads);
  const unknownCount = counts.get("unknown") ?? 0;

  // Booking-call overlay: join LIVE outreach bookings onto board leads by exact
  // leadKey===sendKey, from the SAME single db read taken above. Matching runs
  // over the ACTIVE (non-suppressed) leads; per-row badges use byKey. [R13] The
  // override store is read DIRECTLY (no HTTP hop to the machine-only GET).
  const liveBookings = db.bookings.filter((b) => b.status === "booked");
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(activeLeads, liveBookings);

  const capReached =
    campaign.sendsToday !== null &&
    campaign.dailyCap !== null &&
    campaign.sendsToday >= campaign.dailyCap;
  // Bounce-rate stat. The pipeline's smart bounce-halt (commit 8b304f1)
  // publishes the rate that actually drives the halt — reputation+unknown
  // bounces over the deliverable base (haltRatePct, ~0.3%) — separately from the
  // RAW total (bounceRatePct, ~4.13%, dominated by benign dead addresses). When
  // the new field is present we headline the halt-driving rate and colour it off
  // the halt threshold; when it is absent (older snapshot not yet republished)
  // we fall back to the raw total exactly as before, so nothing regresses.
  const haltRatePct = campaign.haltRatePct;
  const haltThresholdPct = campaign.haltThresholdPct ?? 2;
  const bounceIsHalt = haltRatePct !== null;
  const bounceValue = bounceIsHalt ? haltRatePct : campaign.bounceRatePct;
  const bounceTone = bounceIsHalt
    ? haltRatePct >= haltThresholdPct
      ? "rose"
      : haltRatePct >= haltThresholdPct * 0.5
        ? "amber"
        : "emerald"
    : campaign.bounceRatePct === null
      ? "slate"
      : campaign.bounceRatePct >= 5
        ? "rose"
        : campaign.bounceRatePct >= 2
          ? "amber"
          : "emerald";
  // Breakdown subtext (halt mode only): threshold context + the parts that make
  // up the raw total, each degrading gracefully when its field is null.
  const bounceBreakdown = [
    campaign.deadAddressRatePct !== null ? `dead-address ${campaign.deadAddressRatePct}%` : null,
    campaign.undeliverableRatePct !== null
      ? `undeliverable ${campaign.undeliverableRatePct}%`
      : null,
    campaign.bounceRatePct !== null ? `total ${campaign.bounceRatePct}%` : null,
  ].filter((p): p is string => p !== null);
  const bounceSub = bounceIsHalt
    ? `halt at ${haltThresholdPct}%${bounceBreakdown.length ? ` · ${bounceBreakdown.join(" · ")}` : ""}`
    : undefined;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {header}

      {/* The one list of everything waiting on the operator (wave 3 M1) —
          above every KPI, because it is the only part of this page that is a
          to-do rather than a read-out. */}
      <div className="mt-6">
        <WaitingForYou rows={runsheet} overrides={overrides} />
      </div>

      <div className="mt-6">
        <BookingLinkPanel url={bookingUrl()} />
      </div>

      {campaign.halted === true ? (
        <div
          className="mt-6 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
          data-testid="outreach-halted"
          title="halted=true in the uploaded snapshot"
        >
          <p className="font-semibold">CAMPAIGN HALTED</p>
          <p className="mt-0.5 text-xs">Sending is stopped by the pipeline tool.</p>
        </div>
      ) : null}

      {fresh === "stale" ? (
        <div
          className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          data-testid="outreach-stale"
        >
          Snapshot older than 24 h — re-upload.
        </div>
      ) : null}
      {fresh === "future" ? (
        <div
          className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          data-testid="outreach-future"
        >
          Snapshot timestamp is in the future — check the pipeline clock.
        </div>
      ) : null}

      {/* KPI band */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          label="Sends today"
          value={campaign.sendsToday ?? "—"}
          sub={`of ${campaign.dailyCap ?? "—"} cap`}
          tone={capReached ? "amber" : "slate"}
        />
        <div
          title={
            bounceIsHalt
              ? `Halt-driving rate: reputation+unknown bounces over the deliverable base — the figure the pipeline halts on (rose ≥${haltThresholdPct}% · amber ≥${haltThresholdPct * 0.5}%). The raw total (${campaign.bounceRatePct !== null ? `${campaign.bounceRatePct}%` : "—"}) is dominated by benign dead addresses.`
              : "rose ≥5% · amber ≥2%"
          }
        >
          <Kpi
            label={bounceIsHalt ? "Bounce rate (halt)" : "Bounce rate"}
            value={bounceValue !== null ? `${bounceValue}%` : "—"}
            sub={bounceSub}
            tone={bounceTone}
          />
        </div>
        <Kpi label="Leads" value={total} />
        <div title="replied + conversation + trial_won">
          <Kpi label="Replied+" value={replied} tone={replied > 0 ? "emerald" : "slate"} />
        </div>
        <div title="Leads reporting a booking via their outreach link — reported, not verified. Counts matched leads across the whole current snapshot; may exceed visible emerald badges because the table renders at most 1000 rows.">
          <Kpi label="Booking call" value={kpiCount} tone={kpiCount > 0 ? "emerald" : "slate"} />
        </div>
      </div>
      {/* Per-arm A/B comparison (Increment 5/6) — rendered ONLY when the v3
          snapshot carries campaign.arms. */}
      {campaign.arms ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="outreach-arms">
          <ArmCard name="signup" label='Arm A — "sign up"' stats={campaign.arms.signup} />
          <ArmCard name="demo" label='Arm B — "book a demo"' stats={campaign.arms.demo} />
        </div>
      ) : null}
      {/* Per-mailbox send counts — rendered ONLY when the snapshot carries a
          non-empty campaign.mailboxes (same render-when-present rule as arms). */}
      {campaign.mailboxes && campaign.mailboxes.length > 0 ? (
        <div className="mt-3">
          <MailboxPanel mailboxes={campaign.mailboxes} />
        </div>
      ) : null}
      {unmatchedCount > 0 ? (
        <p
          className="mt-2 text-xs text-slate-400"
          data-testid="outreach-unmatched-bookings"
          title="Live outreach bookings whose leadKey is not present anywhere in the current snapshot — lagging snapshot or an unrecognised/guessed (possibly forged) key. Matched leads beyond the 1000-row display cap are NOT here — they count in the KPI."
        >
          unmatched outreach bookings: {unmatchedCount}
        </p>
      ) : null}

      {/* Funnel strip */}
      <div className="mt-6" data-testid="outreach-funnel">
        <Card title="Funnel">
          <div className="mt-3 flex flex-wrap items-stretch gap-2">
            {PIPELINE_STAGES.map((stage, i) => (
              <div key={stage} className="flex items-center gap-2">
                {i > 0 ? <span className="text-slate-300">→</span> : null}
                <Link
                  href={toggleParamHref("/admin/outreach", { stage: activeStage }, "stage", stage)}
                  className={`w-20 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 ${stageBoxExtras(activeStage === stage)}`}
                >
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">{stage}</p>
                  <p className="text-xl font-bold text-slate-900">{counts.get(stage) ?? 0}</p>
                </Link>
              </div>
            ))}
            <div className="ml-1 flex items-center gap-2 border-l border-slate-200 pl-3">
              {TERMINAL_STAGES.filter((stage) => (counts.get(stage) ?? 0) > 0).map((stage) => (
                <Link
                  key={stage}
                  href={toggleParamHref("/admin/outreach", { stage: activeStage }, "stage", stage)}
                  className={`w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 ${stageBoxExtras(activeStage === stage)}`}
                >
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">{stage}</p>
                  <p className="text-xl font-bold text-slate-500">{counts.get(stage) ?? 0}</p>
                </Link>
              ))}
              {/* Increment 6: real-world-flow stages — shown only when populated
                  so a v2 board renders the funnel exactly as before. */}
              {EXTENDED_STAGES.filter((stage) => (counts.get(stage) ?? 0) > 0).map((stage) => (
                <Link
                  key={stage}
                  href={toggleParamHref("/admin/outreach", { stage: activeStage }, "stage", stage)}
                  className={`w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 ${stageBoxExtras(activeStage === stage)}`}
                >
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">{stage}</p>
                  <p className="text-xl font-bold text-slate-500">{counts.get(stage) ?? 0}</p>
                </Link>
              ))}
              {unknownCount > 0 ? (
                <Link
                  href={toggleParamHref("/admin/outreach", { stage: activeStage }, "stage", "unknown")}
                  className={`w-20 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 ${stageBoxExtras(activeStage === "unknown")}`}
                  title="Stages this dashboard version does not recognise"
                >
                  <p className="text-[10px] uppercase tracking-wide text-amber-700">unknown</p>
                  <p className="text-xl font-bold text-amber-700">{unknownCount}</p>
                </Link>
              ) : null}
            </div>
          </div>
          {suppressedCount > 0 ? (
            <p className="mt-3 text-xs text-slate-400" data-testid="outreach-suppressed-note">
              {suppressedCount} suppressed (not a fit) hidden — see{" "}
              <Link href="/admin/flow" className="underline hover:text-slate-600">
                Flow
              </Link>
            </p>
          ) : null}
        </Card>
      </div>

      {/* Table filter indicator — shown only when a funnel stage is selected. */}
      {activeStage ? (
        <p className="mt-6 text-xs text-slate-400" data-testid="outreach-stage-filter">
          Filtered to stage: <span className="font-medium text-slate-600">{activeStage}</span> (
          {tableTotal}) ·{" "}
          <Link href="/admin/outreach" className="underline hover:text-slate-600">
            show all
          </Link>
        </p>
      ) : null}

      {/* Lead table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-medium">Company</th>
              <th className="px-3 py-2 text-left font-medium">Country</th>
              <th className="px-3 py-2 text-left font-medium">Angle</th>
              <th className="px-3 py-2 text-left font-medium">Stage</th>
              <th className="px-3 py-2 text-left font-medium">Sentiment</th>
              <th className="px-3 py-2 text-left font-medium" title="Opens · Booked · Bounces">
                Engmt
              </th>
              <th className="px-3 py-2 text-left font-medium">Last event</th>
              <th className="px-3 py-2 text-left font-medium">Next action</th>
              <th className="px-3 py-2 text-left font-medium">Manual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No leads in this snapshot.
                </td>
              </tr>
            ) : (
              rows.map((lead, index) => (
                <Fragment key={`${lead.sendKey}-${index}`}>
                  <LeadRow
                    lead={lead}
                    now={now}
                    booked={byKey.get(lead.sendKey)?.booked ?? false}
                    overrides={overrides}
                    allLeads={leads}
                  />
                  {/* Increment 6: full-letter timeline (v3 snapshots only) —
                      an extra full-width row, collapsed by default. */}
                  {lead.events && lead.events.length > 0 ? (
                    <tr className="bg-slate-50/50">
                      <td colSpan={9} className="px-3 py-1.5">
                        <LeadTimeline events={lead.events} sendKey={lead.sendKey} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="mt-2 text-xs text-slate-400">
          Showing {MAX_RENDER_ROWS.toLocaleString("en-US")} of {tableTotal} leads — funnel counts
          cover all.
        </p>
      ) : null}

      <div className="mt-6 text-xs text-slate-400" data-testid="outreach-asof">
        <p>
          Data as of {fmtDateTime(Date.parse(generatedAt))} · uploaded{" "}
          {fmtDateTime(Date.parse(uploadedAt))} · read-only snapshot — nothing here sends email.
        </p>
        {warnings.length > 0 ? (
          <p className="mt-1">
            Warnings: {warnings.slice(0, 5).join(" · ")}
            {warnings.length > 5 ? ` · and ${warnings.length - 5} more` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
