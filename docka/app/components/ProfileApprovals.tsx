"use client";

import { useMemo, useState } from "react";
import type { ProfileChangeRequest } from "@/lib/db";
import { sortChangesForDisplay, summarizeChanges } from "@/lib/self-service";

// The agent-side APPROVAL QUEUE for a seaman's self-service profile changes (roadmap
// T1.7). Lives on the review page (app/agent/[id]) beside the document-request panel.
// The seaman proposes a change to a personal / next-of-kin / bank field; nothing on
// file moves until an agent here APPROVES it (which writes it to the live profile) or
// REJECTS it (which leaves the profile untouched). Mirrors the review flow: a pending
// queue with an approve / reject decision + an audit trail.

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Show a stored value, or a muted "(empty)" when it is null/blank. */
function ValueCell({ value }: { value: string | null }) {
  if (value === null || value === "") {
    return <span className="italic text-slate-400">(empty)</span>;
  }
  return <span className="break-words">{value}</span>;
}

const STATUS_TONE: Record<ProfileChangeRequest["status"], string> = {
  pending: "bg-amber-100 text-amber-800 ring-amber-200",
  approved: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  rejected: "bg-rose-100 text-rose-800 ring-rose-200",
  cancelled: "bg-slate-100 text-slate-500 ring-slate-200",
};
const STATUS_LABEL: Record<ProfileChangeRequest["status"], string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Withdrawn",
};

export function ProfileApprovals({
  seafarerId,
  initialChanges,
}: {
  seafarerId: string;
  initialChanges: ProfileChangeRequest[];
}) {
  const [changes, setChanges] = useState<ProfileChangeRequest[]>(initialChanges);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row optional rejection note editor (rowId -> text).
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const ordered = useMemo(() => sortChangesForDisplay(changes), [changes]);
  const summary = useMemo(() => summarizeChanges(changes), [changes]);

  async function decide(id: string, decision: "approve" | "reject", decisionNote?: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/profile-updates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision, decisionNote }),
      });
      const data = await res.json();
      if (data.ok) {
        setChanges(data.changes as ProfileChangeRequest[]);
        setRejecting(null);
        setRejectNote("");
      } else {
        setError(data.error ?? "Could not update the request.");
      }
    } catch {
      setError("Could not update. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  if (changes.length === 0) {
    // Nothing to approve — stay out of the way, but leave a discoverable stub so the
    // agent knows self-service exists for this seafarer.
    return (
      <section
        data-testid="profile-approvals"
        className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Profile updates
        </h2>
        <p className="mt-2 text-sm text-slate-400" data-testid="profile-approvals-empty">
          No self-service changes proposed. When this seafarer updates their contact,
          emergency family contact or bank details, the change waits here for your approval.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="profile-approvals"
      className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Profile updates
        </h2>
        {summary.pending > 0 ? (
          <span
            data-testid="profile-approvals-pending"
            className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200"
          >
            {summary.pending} awaiting approval
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
            All caught up
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="profile-approvals-error">
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-2" data-testid="profile-approvals-list">
        {ordered.map((req) => {
          const pending = req.status === "pending";
          return (
            <li
              key={req.id}
              data-testid="profile-approval-row"
              data-status={req.status}
              data-field={req.field}
              className={`rounded-xl border px-4 py-3 ${
                pending ? "border-amber-200 bg-amber-50/40" : "border-slate-100 bg-slate-50/60"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800">{req.fieldLabel}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    <ValueCell value={req.previousValue} />
                    <span className="mx-2 text-slate-400">→</span>
                    <span className="font-medium text-slate-900">
                      <ValueCell value={req.proposedValue} />
                    </span>
                  </p>
                  {req.note ? (
                    <p className="mt-1 text-xs text-slate-500">Seafarer&apos;s note: {req.note}</p>
                  ) : null}
                  {!pending && (
                    <p className="mt-1 text-xs text-slate-400" data-testid="profile-approval-decided">
                      {STATUS_LABEL[req.status]}
                      {req.decidedBy ? ` by ${req.decidedBy}` : ""}
                      {req.decidedAt ? ` · ${fmtWhen(req.decidedAt)}` : ""}
                      {req.decisionNote ? ` — ${req.decisionNote}` : ""}
                    </p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${STATUS_TONE[req.status]}`}
                >
                  {STATUS_LABEL[req.status]}
                </span>
              </div>

              {pending && (
                <div className="mt-3">
                  {rejecting === req.id ? (
                    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="profile-approval-reject-box">
                      <label className="block text-xs font-medium text-slate-600">
                        Reason (optional — shown to the seafarer)
                        <input
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                          data-testid="profile-approval-reject-note"
                          placeholder="e.g. IBAN doesn't match your bank letter"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                        />
                      </label>
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => { setRejecting(null); setRejectNote(""); }}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={busy === req.id}
                          onClick={() => decide(req.id, "reject", rejectNote.trim() || undefined)}
                          data-testid="profile-approval-reject-confirm"
                          className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                        >
                          {busy === req.id ? "Saving…" : "Reject change"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy === req.id}
                        onClick={() => decide(req.id, "approve")}
                        data-testid="profile-approval-approve"
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {busy === req.id ? "Saving…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={busy === req.id}
                        onClick={() => { setRejecting(req.id); setRejectNote(""); }}
                        data-testid="profile-approval-reject"
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
