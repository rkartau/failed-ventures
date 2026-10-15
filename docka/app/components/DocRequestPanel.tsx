"use client";

import { useMemo, useState } from "react";
import type { Doc, DocRequest } from "@/lib/db";
import { classifyRequiredType, type RequiredDocType } from "@/lib/doctypes";
import { docStatusForDoc } from "@/lib/cert";
import {
  dueState,
  daysUntilDue,
  sortForDisplay,
  summarizeRequests,
  allRequestsApproved,
  type DueState,
} from "@/lib/doc-requests";

// The agent-side, INTERACTIVE document-request checklist. Lives on the review page
// (app/agent/[id]) beneath the compliance summary. The agent picks the missing/needed
// documents, sets a deadline, optionally e-mails the seaman, then tracks each item to
// "received" — which also happens automatically when the matching upload lands. This
// is the collection loop the compliance gate never ran.

function fmtDate(day: string | null): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function deadlinePhrase(req: DocRequest): string {
  const days = daysUntilDue(req.dueDate);
  if (days === null) return "No deadline";
  if (days < 0) return `Overdue — was due ${fmtDate(req.dueDate)}`;
  if (days === 0) return `Due today`;
  if (days === 1) return `Due tomorrow`;
  return `Due ${fmtDate(req.dueDate)} (${days}d)`;
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
  waived: "Waived",
  cancelled: "Withdrawn",
};

export function DocRequestPanel({
  seafarerId,
  initialRequests,
  requiredSlots,
  missingSlots,
  docs,
  readOnly = false,
}: {
  seafarerId: string;
  initialRequests: DocRequest[];
  /** The full required set for this seafarer's rank — every slot the agent may ask for. */
  requiredSlots: RequiredDocType[];
  /** The still-missing required slots — pre-suggested as the quick-add picks. */
  missingSlots: RequiredDocType[];
  /**
   * Fix 8 — this seafarer's documents (with `reviewStatus`), so the status box can
   * hide only once every requested doc is uploaded AND agent-approved. Lives in the
   * review page state, so approving a doc reactively re-hides the box.
   */
  docs: Doc[];
  /**
   * Public sample review (plan Phase 4): render the checklist content — states,
   * deadlines, overdue tint — with ZERO mutation affordances (no compose, no
   * mark-received / waive / withdraw / re-open).
   */
  readOnly?: boolean;
}) {
  const [requests, setRequests] = useState<DocRequest[]>(initialRequests);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(!readOnly && initialRequests.length === 0);

  // Compose form state.
  const [picked, setPicked] = useState<Set<RequiredDocType>>(new Set(missingSlots));
  const [customLabel, setCustomLabel] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);

  // Fix 14 — a required slot is HIDDEN from the compose picker once the seafarer
  // already has a VALID CURRENT document of that type on file, so the agent is not
  // offered a slot they cannot usefully re-request. "Valid current" = a document that
  // classifies into the slot (same classifier the compliance/auto-clear code uses),
  // whose date-status is "valid" or "none" (perpetual — never "expiring"/"expired"/
  // "unknown"), and whose review is not "rejected"/"reupload". Expired/expiring/unknown
  // or rejected docs still OFFER the slot; a merely-pending doc-REQUEST never hides it
  // (this looks at documents on file, not requests).
  const satisfiedSlots = useMemo(() => {
    const sat = new Set<RequiredDocType>();
    for (const d of docs) {
      if (d.reviewStatus === "rejected" || d.reviewStatus === "reupload") continue;
      const slot: RequiredDocType | null =
        d.requiredType ??
        classifyRequiredType({ title: d.title, docType: d.docType, docCategory: d.docCategory });
      if (!slot) continue;
      const st = docStatusForDoc(d);
      if (st === "valid" || st === "none") sat.add(slot);
    }
    return sat;
  }, [docs]);

  // The slots actually shown as quick-add chips — the required set minus the ones
  // already satisfied. Free-text "Other document" stays available regardless.
  const visibleSlots = useMemo(
    () => requiredSlots.filter((s) => !satisfiedSlots.has(s)),
    [requiredSlots, satisfiedSlots]
  );

  const ordered = useMemo(() => sortForDisplay(requests), [requests]);
  const summary = useMemo(() => summarizeRequests(requests), [requests]);
  // Fix 8 — TRUE once every requested doc is handed in AND agent-approved. Hides the
  // STATUS box (summary chip + request list) only; the create control stays so the
  // agent can always ask for more, and a fresh pending request re-shows the box.
  const allApproved = useMemo(() => allRequestsApproved(requests, docs), [requests, docs]);

  function togglePick(slot: RequiredDocType) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }

  async function submit() {
    setError(null);
    setBanner(null);
    // The shared note is attached to every item (the route stores a note per item).
    const sharedNote = note.trim() || undefined;
    const items: { requiredType: RequiredDocType | null; label: string; note?: string }[] = [];
    for (const slot of requiredSlots) {
      if (picked.has(slot)) items.push({ requiredType: slot, label: slot, note: sharedNote });
    }
    const custom = customLabel.trim();
    if (custom) items.push({ requiredType: null, label: custom, note: sharedNote });
    if (items.length === 0) {
      setError("Pick at least one document to request.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/doc-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seafarerId,
          items,
          dueDate: dueDate || null,
          notify,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setRequests(data.requests as DocRequest[]);
        setPicked(new Set());
        setCustomLabel("");
        setNote("");
        setComposeOpen(false);
        const deliver = data.notified
          ? data.notified.delivered
            ? " Seaman e-mailed."
            : ` ${data.notified.delivery}.`
          : "";
        setBanner(`Requested ${data.created} document${data.created === 1 ? "" : "s"}.${deliver}`);
      } else {
        setError(data.error ?? "Could not raise the request.");
      }
    } catch {
      setError("Could not raise the request. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, patchBody: { status?: DocRequest["status"]; dueDate?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/doc-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patchBody }),
      });
      const data = await res.json();
      if (data.ok) setRequests(data.requests as DocRequest[]);
      else setError(data.error ?? "Could not update the request.");
    } catch {
      setError("Could not update. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="doc-request-panel"
      className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Document requests
        </h2>
        {!allApproved &&
          summary.total > 0 &&
          (summary.pending === 0 ? (
            <span
              data-testid="package-ready"
              className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
            >
              Package ready — all requested documents in
            </span>
          ) : (
            <span
              data-testid="package-pending"
              className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                summary.overdue > 0
                  ? "bg-rose-50 text-rose-700 ring-rose-200"
                  : "bg-amber-50 text-amber-700 ring-amber-200"
              }`}
            >
              {summary.pending} awaiting{summary.overdue > 0 ? ` · ${summary.overdue} overdue` : ""}
            </span>
          ))}
      </div>

      {banner && (
        <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800" data-testid="doc-request-banner">
          {banner}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="doc-request-error">
          {error}
        </p>
      )}

      {/* Existing checklist — hidden by Fix 8 once every requested doc is uploaded
          AND agent-approved; the create control below always remains. */}
      {!allApproved && ordered.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="doc-request-list">
          {ordered.map((req) => {
            const st = dueState(req);
            const done = req.status !== "pending";
            return (
              <li
                key={req.id}
                data-testid="doc-request-row"
                data-status={req.status}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 ${
                  done ? "border-slate-100 bg-slate-50/60" : st === "overdue" ? "border-rose-200 bg-rose-50/40" : "border-slate-200"
                }`}
              >
                <span className={`min-w-0 flex-1 text-sm font-medium ${done ? "text-slate-500 line-through" : "text-slate-800"}`}>
                  {req.label}
                  {req.requiredType ? null : <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-500">custom</span>}
                  {req.note ? <span className="ml-1 font-normal text-slate-400">— {req.note}</span> : null}
                  {req.status === "received" && req.resolvedVia === "upload" ? (
                    <span className="ml-1 text-[11px] font-normal text-emerald-600">(auto — upload received)</span>
                  ) : null}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${DUE_TONE[st]}`}>
                  {done ? STATUS_LABEL[req.status] : deadlinePhrase(req)}
                </span>
                {!readOnly && (
                <div className="flex items-center gap-1">
                  {req.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patch(req.id, { status: "received" })}
                        data-testid="doc-request-received"
                        className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Mark received
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patch(req.id, { status: "waived" })}
                        data-testid="doc-request-waive"
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Waive
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patch(req.id, { status: "cancelled" })}
                        data-testid="doc-request-cancel"
                        className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-600 disabled:opacity-50"
                      >
                        Withdraw
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch(req.id, { status: "pending" })}
                      data-testid="doc-request-reopen"
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-600 disabled:opacity-50"
                    >
                      Re-open
                    </button>
                  )}
                </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Compose — hidden entirely on the read-only sample review. */}
      {readOnly ? null : composeOpen ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="doc-request-compose">
          <p className="text-xs font-semibold text-slate-600">Request documents from this seafarer</p>
          {requiredSlots.length > 0 && visibleSlots.length === 0 && (
            <p className="mt-2 text-xs text-slate-400" data-testid="doc-request-all-on-file">
              All standard documents are on file — use “Other document” below to request anything else.
            </p>
          )}
          {visibleSlots.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {visibleSlots.map((slot) => {
                const on = picked.has(slot);
                const isMissing = missingSlots.includes(slot);
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => togglePick(slot)}
                    data-testid="doc-request-slot"
                    data-on={on ? "true" : "false"}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 transition ${
                      on
                        ? "bg-brand-600 text-white ring-brand-600"
                        : isMissing
                          ? "bg-white text-rose-700 ring-rose-200 hover:bg-rose-50"
                          : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-100"
                    }`}
                  >
                    {slot}
                    {isMissing ? " · missing" : ""}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-600">
              Other document (free text)
              <input
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                data-testid="doc-request-custom"
                placeholder="e.g. Yellow-fever vaccination card"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Deadline (applies to all items)
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="doc-request-due"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-medium text-slate-600">
            Note to the seafarer (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="doc-request-note"
              placeholder="e.g. must be the flag-state endorsement, not the CoC"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                data-testid="doc-request-notify"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              E-mail the seafarer their checklist + upload link
            </label>
            <div className="flex items-center gap-2">
              {requests.length > 0 && (
                <button
                  type="button"
                  onClick={() => setComposeOpen(false)}
                  className="rounded-lg px-3 py-2 text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={submit}
                data-testid="doc-request-submit"
                className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? "Sending…" : "Send request"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setComposeOpen(true)}
          data-testid="doc-request-open-compose"
          className="mt-4 rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100"
        >
          Request documents
        </button>
      )}
    </section>
  );
}
