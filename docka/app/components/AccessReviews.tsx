"use client";

import { useEffect, useState } from "react";

type GrantStatus = "PENDING" | "ACTIVE" | "LOCKED" | "REVOKED" | "EXPIRED";
type AccessAction = "VIEWED" | "REVIEWED" | "DOWNLOADED" | "EXPORTED";

type ReviewerRow = {
  agentId: string;
  agentName: string;
  grantId: string | null;
  status: GrantStatus | null;
  lastAction: AccessAction | null;
  lastActionAt: string | null;
  lastReviewAction: AccessAction | null;
  lastReviewAt: string | null;
  reviewCount: number;
  overCap: boolean;
  lockedVessel: string | null;
  // #15/#16 — the agency's per-grant pipeline stage. `sent_to_sea`/`returning` block
  // withdrawal even when no live assignment forces a LOCKED status (server-authoritative
  // — the button state below only mirrors the server gate in revokeGrant).
  stage?: string;
  stageLabel?: string;
};

// What each logged action means to the seaman. VIEWED is a plain list/card view;
// the rest are REVIEW-level (opened your profile / a document / exported).
const ACTION_LABEL: Record<AccessAction, string> = {
  VIEWED: "Viewed your list",
  REVIEWED: "Reviewed your profile",
  DOWNLOADED: "Opened one of your documents",
  EXPORTED: "Exported your record",
};

// Timestamps are stored UTC ISO-8601; render them in the seaman's own locale.
function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function StatusPill({ row }: { row: ReviewerRow }) {
  const s = row.status;
  if (s === "ACTIVE") {
    return (
      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
        Active
      </span>
    );
  }
  if (s === "LOCKED") {
    return (
      <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
        Locked until you return{row.lockedVessel ? ` from ${row.lockedVessel}` : ""}
      </span>
    );
  }
  if (s === "REVOKED") {
    return (
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
        Revoked
      </span>
    );
  }
  if (s === "EXPIRED") {
    return (
      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
        Expired
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
      Invited (not opened)
    </span>
  );
}

// The seaman's own "Access & reviews" view: who has (or had) access to their
// documents, the last REVIEW-level action + when, the grant status, and a revoke
// control. A LOCKED grant cannot be revoked while at sea — the reason is shown.
export function AccessReviews({ seafarerId }: { seafarerId: string }) {
  const [rows, setRows] = useState<ReviewerRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/access?seafarerId=${encodeURIComponent(seafarerId)}`);
      const data = await res.json();
      if (data.ok) setRows(data.reviews as ReviewerRow[]);
      else setError(data.error ?? "Could not load access history.");
    } catch {
      setError("Could not load access history.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seafarerId]);

  async function revoke(grantId: string) {
    setBusy(grantId);
    setError(null);
    setBlocked((b) => {
      const next = { ...b };
      delete next[grantId];
      return next;
    });
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", grantId, seafarerId }),
      });
      const data = await res.json();
      if (data.ok) {
        setRows(data.reviews as ReviewerRow[]);
      } else if (data.blocked) {
        setBlocked((b) => ({ ...b, [grantId]: data.error }));
      } else {
        setError(data.error ?? "Could not revoke access.");
      }
    } catch {
      setError("Could not revoke access.");
    } finally {
      setBusy(null);
    }
  }

  // #15 — re-grant a previously REVOKED agent (direct, unilateral restore). Mirrors
  // revoke(): POSTs the ownership-checked {action:"regrant"} and refreshes the list
  // from the server's fresh transparency rows.
  async function regrant(grantId: string) {
    setBusy(grantId);
    setError(null);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regrant", grantId, seafarerId }),
      });
      const data = await res.json();
      if (data.ok) {
        setRows(data.reviews as ReviewerRow[]);
      } else {
        setError(data.error ?? "Could not re-grant access.");
      }
    } catch {
      setError("Could not re-grant access.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-8" data-testid="access-reviews">
      <h2 className="font-semibold text-slate-900">Access &amp; reviews</h2>
      <p className="mt-1 text-sm text-slate-500">
        Every agent who has access to your documents, what they last did, and when.
        You can withdraw an agent&apos;s access at any time while you are ashore.
      </p>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {rows === null ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p
          data-testid="access-empty"
          className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400"
        >
          No agent has been given access yet. When you share your link with an agent,
          they appear here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2" data-testid="access-list">
          {rows.map((row) => {
            // #16 — the agency's stage (sent_to_sea / returning) blocks withdrawal even
            // when the grant is ACTIVE (no live assignment => not LOCKED). Mirrors the
            // server gate in revokeGrant; the server is authoritative.
            const atSeaStage = row.stage === "sent_to_sea" || row.stage === "returning";
            const canRevoke = row.status === "ACTIVE" && !!row.grantId && !atSeaStage;
            const isLocked = row.status === "LOCKED";
            // #16 — ACTIVE but stage-gated (typically "returning" / coming back).
            const stageBlocked = row.status === "ACTIVE" && atSeaStage;
            // #15 — a withdrawn grant the seaman can restore.
            const isRevoked = row.status === "REVOKED";
            return (
              <li
                key={row.agentId}
                data-testid="access-row"
                data-agent={row.agentId}
                data-status={row.status ?? ""}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-800">{row.agentName}</p>
                      <StatusPill row={row} />
                    </div>
                    {/* REVIEW-level activity, shown distinctly from a plain view. */}
                    {row.lastReviewAt ? (
                      <p className="mt-1 text-xs text-slate-500" data-testid="last-review">
                        {ACTION_LABEL[row.lastReviewAction ?? "REVIEWED"]} ·{" "}
                        {fmtWhen(row.lastReviewAt)}
                        {row.reviewCount > 1 ? ` · ${row.reviewCount} reviews total` : ""}
                      </p>
                    ) : row.lastActionAt ? (
                      <p className="mt-1 text-xs text-slate-400">
                        {ACTION_LABEL[row.lastAction ?? "VIEWED"]} · {fmtWhen(row.lastActionAt)}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-slate-400">No activity yet.</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {canRevoke ? (
                      <button
                        type="button"
                        data-testid="revoke-grant"
                        disabled={busy === row.grantId}
                        onClick={() => revoke(row.grantId!)}
                        className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-semibold text-rose-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-60"
                      >
                        {busy === row.grantId ? "Revoking…" : "Withdraw access"}
                      </button>
                    ) : isLocked ? (
                      <button
                        type="button"
                        data-testid="revoke-locked"
                        disabled
                        title="Locked while you are at sea under this agent"
                        className="inline-flex min-h-[40px] cursor-not-allowed items-center rounded-lg px-3 text-sm font-semibold text-slate-300"
                      >
                        Can&apos;t withdraw
                      </button>
                    ) : stageBlocked ? (
                      <button
                        type="button"
                        data-testid="revoke-stage-blocked"
                        disabled
                        title="Can't withdraw while at sea / returning under this agent"
                        className="inline-flex min-h-[40px] cursor-not-allowed items-center rounded-lg px-3 text-sm font-semibold text-slate-300"
                      >
                        Can&apos;t withdraw
                      </button>
                    ) : isRevoked && row.grantId ? (
                      <button
                        type="button"
                        data-testid="regrant-grant"
                        disabled={busy === row.grantId}
                        onClick={() => regrant(row.grantId!)}
                        className="inline-flex min-h-[40px] items-center rounded-lg px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-60"
                      >
                        {busy === row.grantId ? "Granting…" : "Grant access again"}
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* A blocked revoke — LOCKED at sea, or the #16 stage gate
                    (sent_to_sea / returning) — shows the reason. */}
                {(isLocked || stageBlocked || (row.grantId && blocked[row.grantId])) && (
                  <p
                    data-testid="revoke-blocked"
                    className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200"
                  >
                    {row.grantId && blocked[row.grantId]
                      ? blocked[row.grantId]
                      : isLocked
                      ? `Access is locked while you are at sea${
                          row.lockedVessel ? ` on ${row.lockedVessel}` : ""
                        } under this agent and cannot be withdrawn until you return (MLC 2006 / flag-state crew-certification obligation, disclosed when you granted access).`
                      : "You can't withdraw access while you are at sea or on your way back to shore under this agent. You'll be able to withdraw it once the voyage is closed."}
                    {row.overCap ? " This assignment has passed its expected length — contact your agent to close it." : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
