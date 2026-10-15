// "Documents your agent asked for" checklist — shown to the SEAMAN on their own
// dashboard and on the shared view.
//
// Two render modes from ONE component:
//   - READ-ONLY (share page, a server component): pass only `requests`. No
//     seafarerId ⇒ no per-row control, so it renders exactly as before — a plain
//     to-do list, safe to server-render.
//   - INTERACTIVE (the seaman's own client page): pass `seafarerId` (+ optional
//     `shareToken`/`onUploaded`) and each PENDING row gains an Upload control that
//     posts the file straight into THAT request (docRequestId), so it ticks off
//     without a manual refresh.
// The file is "use client" so the interactive path can hold hooks; a server
// component (the share page) can still render it as a client child in read-only
// mode. Interactive agent controls still live in the separate DocRequestPanel.
"use client";

import { useRef, useState } from "react";
import type { Doc, DocRequest } from "@/lib/db";
import { dueState, daysUntilDue, sortForDisplay, summarizeRequests, type DueState } from "@/lib/doc-requests";

// Shape of the /api/documents POST response the Upload control hands back to the
// parent so it can update its checklist + document state in one shot. A
// duplicate-skip response may omit clearedRequestIds/docRequests — hence optional.
export type ChecklistUploadResult = {
  ok: boolean;
  document?: Doc;
  duplicate?: boolean;
  clearedRequestIds?: string[];
  docRequests?: DocRequest[];
  error?: string;
};

function fmtDate(day: string | null): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// A short, plain-English deadline phrase for a pending item.
function deadlinePhrase(req: DocRequest): string {
  const st = dueState(req);
  if (st === "none") return "No deadline";
  const days = daysUntilDue(req.dueDate);
  if (days === null) return "No deadline";
  if (days < 0) return `Overdue — was due ${fmtDate(req.dueDate)}`;
  if (days === 0) return `Due today (${fmtDate(req.dueDate)})`;
  if (days === 1) return `Due tomorrow (${fmtDate(req.dueDate)})`;
  return `Due ${fmtDate(req.dueDate)} (${days} days)`;
}

const DUE_TONE: Record<DueState, string> = {
  overdue: "bg-rose-100 text-rose-800 ring-rose-200",
  "due-soon": "bg-amber-100 text-amber-800 ring-amber-200",
  upcoming: "bg-slate-100 text-slate-600 ring-slate-200",
  none: "bg-slate-100 text-slate-500 ring-slate-200",
  resolved: "bg-emerald-100 text-emerald-800 ring-emerald-200",
};

const STATUS_LABEL: Record<DocRequest["status"], string> = {
  pending: "Requested",
  received: "Received",
  waived: "No longer needed",
  cancelled: "Withdrawn",
};

// Per-row Upload control (interactive mode only). Uploads ONE file straight into
// the specific pending request via docRequestId, then hands the fresh response
// back to the parent so the checklist ticks off with no reload. The owner share
// token is forwarded when present so the call is authorised the same way the
// seaman's other self-service writes are.
function ChecklistUpload({
  req,
  seafarerId,
  shareToken,
  onUploaded,
}: {
  req: DocRequest;
  seafarerId: string;
  shareToken?: string;
  onUploaded?: (resp: ChecklistUploadResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("seafarerId", seafarerId);
      fd.append("file", file);
      // Targets THIS request so the server clears it even if it is ad-hoc
      // (requiredType null), which type-based auto-clear would never match.
      fd.append("docRequestId", req.id);
      if (shareToken) fd.append("token", shareToken);
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as ChecklistUploadResult;
      if (data.ok) {
        onUploaded?.(data);
      } else {
        setError(data.error ?? "Upload failed. Please try again.");
      }
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        data-testid="checklist-upload"
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {busy ? "Uploading…" : "Upload"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        data-testid="checklist-upload-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
        className="hidden"
      />
      {error && <span className="text-[11px] font-medium text-rose-600">{error}</span>}
    </div>
  );
}

export function DocRequestChecklist({
  requests,
  seafarerId,
  shareToken,
  onUploaded,
}: {
  requests: DocRequest[];
  /** Present ONLY in the interactive (seaman self-page) mode — enables per-row upload. */
  seafarerId?: string;
  /** Owner share token, forwarded to authorise the upload the same as other self writes. */
  shareToken?: string;
  /** Success callback with the fresh POST response so the parent can update state. */
  onUploaded?: (resp: ChecklistUploadResult) => void;
}) {
  if (!requests || requests.length === 0) return null;
  const summary = summarizeRequests(requests);
  // Fix 7 — hide the whole box (header included) when nothing is pending: all items
  // handed in, or none raised yet. It reappears automatically the moment a new
  // pending request exists ("until new requests come in"). The "All supplied" header
  // branch below is intentionally kept but simply no longer reached when pending===0.
  if (summary.pending === 0) return null;
  const ordered = sortForDisplay(requests);
  const canUpload = !!seafarerId;

  return (
    <section
      data-testid="doc-request-checklist"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Documents your agent asked for
        </h2>
        {summary.pending === 0 ? (
          <span
            data-testid="checklist-ready"
            className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
          >
            All supplied
          </span>
        ) : (
          <span
            data-testid="checklist-pending"
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
              summary.overdue > 0
                ? "bg-rose-50 text-rose-700 ring-rose-200"
                : "bg-amber-50 text-amber-700 ring-amber-200"
            }`}
          >
            {summary.pending} still needed{summary.overdue > 0 ? ` · ${summary.overdue} overdue` : ""}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Upload each item below and it ticks off automatically.
      </p>

      <ul className="mt-3 space-y-2">
        {ordered.map((req) => {
          const st = dueState(req);
          const done = req.status !== "pending";
          return (
            <li
              key={req.id}
              data-testid="checklist-item"
              data-status={req.status}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 ${
                done
                  ? "border-slate-100 bg-slate-50/60"
                  : st === "overdue"
                    ? "border-rose-200 bg-rose-50/50"
                    : "border-slate-200 bg-white"
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white ${
                  req.status === "received"
                    ? "bg-emerald-500"
                    : req.status === "pending"
                      ? st === "overdue"
                        ? "bg-rose-500"
                        : "bg-slate-300"
                      : "bg-slate-400"
                }`}
              >
                {req.status === "received" ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : null}
              </span>
              <span className={`min-w-0 flex-1 text-sm font-medium ${done ? "text-slate-500 line-through" : "text-slate-800"}`}>
                {req.label}
                {req.note ? <span className="ml-1 font-normal text-slate-400">— {req.note}</span> : null}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${DUE_TONE[st]}`}
              >
                {done ? STATUS_LABEL[req.status] : deadlinePhrase(req)}
              </span>
              {/* Interactive mode only: PENDING rows get a direct upload into this
                  exact request. Received/withdrawn rows never show it. */}
              {canUpload && !done && (
                <ChecklistUpload
                  req={req}
                  seafarerId={seafarerId as string}
                  shareToken={shareToken}
                  onUploaded={onUploaded}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
