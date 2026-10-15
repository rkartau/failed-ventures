// app/admin/outreach/timeline.tsx — per-lead full-letter timeline (Increment 6,
// Director decision 1: the admin dashboard shows FULL bodies per lead).
//
// SERVER component, presentational only: renders the ALREADY-validated
// OutreachLeadEvent[] (lib/outreach-snapshot.ts strict allowlist — kind enum,
// 20 KB body cap). Expansion is a native <details> element (no client JS, same
// admin-only page, auth model untouched). ESCAPING IS LOAD-BEARING: every
// pipeline-supplied string (bodies, actors, classifications, template ids)
// renders EXCLUSIVELY as JSX text inside an escaped <pre>/<span> — the raw
// innerHTML escape hatch is BANNED in this file (test-pinned), so a
// script-close or img-onerror payload in a reply body displays as text.

import { type OutreachLeadEvent } from "@/lib/outreach-snapshot";
import { fmtDateTime, BADGE } from "../ui";

// Same palette family as the page's stage/sentiment badges.
const KIND_BADGE: Record<OutreachLeadEvent["kind"], string> = {
  sent: "border-slate-200 bg-slate-100 text-slate-600",
  reply: "border-sky-200 bg-sky-50 text-sky-700",
  draft: "border-amber-200 bg-amber-50 text-amber-700",
  "state-change": "border-slate-200 bg-white text-slate-400",
};

function EventItem({ ev }: { ev: OutreachLeadEvent }): JSX.Element {
  return (
    <li className="border-l-2 border-slate-200 pl-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
        <span className={`${BADGE} ${KIND_BADGE[ev.kind]}`}>{ev.kind}</span>
        <span>{fmtDateTime(ev.ts ? Date.parse(ev.ts) : null)}</span>
        {ev.actor ? <span title="Actor">· {ev.actor}</span> : null}
        {ev.templateId ? (
          <span className={`${BADGE} border-slate-200 bg-white text-slate-500`} title="Template">
            {ev.templateId}
          </span>
        ) : null}
        {ev.classification ? (
          <span className={`${BADGE} border-sky-200 bg-sky-50 text-sky-700`} title="Classification">
            {ev.classification}
          </span>
        ) : null}
        {ev.arm ? (
          <span className={`${BADGE} border-emerald-200 bg-emerald-50 text-emerald-700`} title="A/B arm">
            {ev.arm}
          </span>
        ) : null}
        {ev.thread ? (
          <span className="text-slate-400" title="Thread reference">
            thread {ev.thread}
          </span>
        ) : null}
      </div>
      {ev.bodyFull ? (
        <pre className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-2 font-sans text-xs leading-5 text-slate-700">
          {ev.bodyFull}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * The expandable per-lead timeline block. Rendered by the page inside a
 * full-width table row under the lead's main row — only when the (v3) snapshot
 * carried events for that lead.
 */
export function LeadTimeline({
  events,
  sendKey,
}: {
  events: OutreachLeadEvent[];
  sendKey: string;
}): JSX.Element {
  return (
    <details className="group" data-testid="lead-timeline">
      <summary className="cursor-pointer select-none text-xs font-medium text-slate-500 hover:text-slate-700">
        Timeline · {events.length} event{events.length === 1 ? "" : "s"}
        <span className="ml-1 text-slate-300 group-open:hidden">▸</span>
        <span className="ml-1 hidden text-slate-300 group-open:inline">▾</span>
      </summary>
      <ul className="mt-2 space-y-3" title={sendKey || undefined}>
        {events.map((ev, i) => (
          <EventItem key={i} ev={ev} />
        ))}
      </ul>
    </details>
  );
}
