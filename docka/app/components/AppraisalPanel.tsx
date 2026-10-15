"use client";

// Agency-facing appraisal scorecards (#43). Lists this tenant's appraisal history +
// a re-hire summary, and files new interview / post-voyage appraisals. Grant-scoped +
// tenant-isolated on the server; this is the authoring surface.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  competenciesFor,
  CURRENT_COMPETENCY_SET_VERSION,
} from "@/lib/appraisals";
import type { Appraisal, AppraisalKind, RehireRecommendation } from "@/lib/db";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const RECO_TONE: Record<RehireRecommendation, string> = {
  yes: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  conditional: "bg-amber-100 text-amber-800 ring-amber-200",
  no: "bg-rose-100 text-rose-800 ring-rose-200",
};
const RECO_LABEL: Record<RehireRecommendation, string> = {
  yes: "Re-hire",
  conditional: "Conditional",
  no: "Do not re-hire",
};

export function AppraisalPanel({
  seafarerId,
  prefill,
}: {
  seafarerId: string;
  /** Optional pre-fill for a post-voyage card from the active/most-recent assignment. */
  prefill?: { vessel?: string | null; voyageFrom?: string | null; voyageTo?: string | null; assignmentId?: string | null };
}) {
  const [rows, setRows] = useState<Appraisal[]>([]);
  const [kind, setKind] = useState<AppraisalKind>("interview");
  const [fastPath, setFastPath] = useState(true);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [overall, setOverall] = useState<number | "">("");
  const [recommend, setRecommend] = useState<RehireRecommendation>("yes");
  const [rehireReason, setRehireReason] = useState("");
  const [comments, setComments] = useState("");
  // #11 — second free-text note the agent chooses to SHARE with the seaman (distinct
  // from the agency-private `comments`).
  const [sharedComment, setSharedComment] = useState("");
  const [vessel, setVessel] = useState(prefill?.vessel ?? "");
  const [voyageFrom, setVoyageFrom] = useState(prefill?.voyageFrom ?? "");
  const [voyageTo, setVoyageTo] = useState(prefill?.voyageTo ?? "");
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #12 — brief inline note surfaced after a delete that turned into a seaman
  // keep/delete consent request (ever-shared appraisal).
  const [deleteNote, setDeleteNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/appraisals?seafarerId=${encodeURIComponent(seafarerId)}`);
    const data = await res.json().catch(() => ({}));
    if (data?.ok) setRows(data.appraisals ?? []);
  }, [seafarerId]);
  useEffect(() => { void load(); }, [load]);

  const competencies = useMemo(() => competenciesFor(CURRENT_COMPETENCY_SET_VERSION, kind), [kind]);
  const latest = rows[0] ?? null;

  async function submit(useFastPath: boolean) {
    setError(null);
    // F1 — a "Do not re-hire" verdict ALWAYS requires a reason, including on the
    // fast-path. Block before the network call so the fast-path can never file a
    // career-ending recommendation blind. (The server enforces the same rule.)
    if (recommend === "no" && !rehireReason.trim()) {
      setError("Add a reason before filing a “Do not re-hire” recommendation.");
      return;
    }
    setBusy(true);
    const body = {
      seafarerId,
      kind,
      fastPath: kind === "interview" ? useFastPath : false,
      competencySetVersion: CURRENT_COMPETENCY_SET_VERSION,
      recommend,
      rehireReason: recommend === "no" ? rehireReason : null,
      comments: comments || null,
      sharedComment: sharedComment || null,
      overall: overall === "" ? undefined : overall,
      vessel: vessel || null,
      voyageFrom: voyageFrom || null,
      voyageTo: voyageTo || null,
      assignmentId: kind === "post_voyage" ? prefill?.assignmentId ?? null : null,
      scores: competencies.filter((c) => scores[c] != null).map((c) => ({ competency: c, rating: scores[c] })),
      idempotencyKey: idemKey,
    };
    const res = await fetch("/api/appraisals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!data?.ok) {
      setError(data?.error ?? "Could not file the appraisal.");
      return;
    }
    setIdemKey(crypto.randomUUID());
    setScores({});
    setOverall("");
    setComments("");
    setSharedComment("");
    setRehireReason("");
    await load();
  }

  // #12 — delete an appraisal. Same auth as POST/PATCH: a same-origin fetch carrying
  // the agent session cookie (no explicit credentials needed). Server tells us which
  // path ran via `disposition`.
  async function onDelete(a: Appraisal) {
    if (!window.confirm("Delete this appraisal?")) return;
    setDeleteNote(null);
    setError(null);
    const res = await fetch("/api/appraisals", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) {
      // Already gone (or already agent-hidden) — drop it from our view.
      setRows((rs) => rs.filter((r) => r.id !== a.id));
      return;
    }
    if (!data?.ok) {
      setError(data?.error ?? "Could not delete the appraisal.");
      return;
    }
    // Both success paths remove the row from the agent's view.
    setRows((rs) => rs.filter((r) => r.id !== a.id));
    if (data.disposition === "consent_requested") {
      setDeleteNote(
        "Removed from your view. The seafarer was asked whether to keep or delete their copy."
      );
    }
  }

  return (
    <section data-testid="appraisal-panel" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-slate-800">Appraisals</h3>

      {latest && (
        <div
          data-testid="appraisal-rehire-summary"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3 text-sm"
        >
          <span className="font-semibold text-slate-700">Latest: {latest.overall}/5</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${RECO_TONE[latest.recommend]}`}>
            {RECO_LABEL[latest.recommend]}
          </span>
          {/* F3 — tag a fast-path overall so it can't read as equal to a full-card overall. */}
          {latest.fastPath && (
            <span
              data-testid="appraisal-summary-quick-tag"
              title="Quick appraisal — no competency scores"
              className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
            >
              Quick
            </span>
          )}
          {latest.vessel && <span className="text-slate-500">{latest.vessel}</span>}
          <span className="text-slate-400">{rows.length} on file</span>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          data-testid="appraisal-kind-interview"
          onClick={() => { setKind("interview"); setFastPath(true); }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${kind === "interview" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600"}`}
        >
          Interview
        </button>
        <button
          type="button"
          data-testid="appraisal-kind-postvoyage"
          onClick={() => { setKind("post_voyage"); setFastPath(false); }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${kind === "post_voyage" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600"}`}
        >
          Post-voyage
        </button>
      </div>

      {kind === "post_voyage" && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input data-testid="appraisal-vessel" value={vessel} onChange={(e) => setVessel(e.target.value)} placeholder="Vessel" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
          <input data-testid="appraisal-voyage-from" type="date" value={voyageFrom} onChange={(e) => setVoyageFrom(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
          <input data-testid="appraisal-voyage-to" type="date" value={voyageTo} onChange={(e) => setVoyageTo(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        </div>
      )}

      {(!fastPath || kind === "post_voyage") && (
        <div className="mt-3 space-y-1">
          {competencies.map((c) => (
            <label key={c} className="flex items-center justify-between gap-3 text-sm">
              {/* F4 — show the 1–5 scale hint on each competency row. */}
              <span className="text-slate-600">
                {c} <span className="text-slate-400">(1–5)</span>
              </span>
              <select
                data-testid={`appraisal-score-${slug(c)}`}
                value={scores[c] ?? ""}
                onChange={(e) => setScores((s) => ({ ...s, [c]: Number(e.target.value) }))}
                className="rounded-lg border border-slate-200 px-2 py-1"
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {/* F4 — the Overall control auto-derives from the competency rows; label it so. */}
        <label className="text-sm text-slate-600">Overall (avg of rows, editable)</label>
        <select data-testid="appraisal-overall" value={overall} onChange={(e) => setOverall(e.target.value === "" ? "" : Number(e.target.value))} className="rounded-lg border border-slate-200 px-2 py-1">
          <option value="">avg</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <div className="flex gap-1">
          {(["yes", "conditional", "no"] as const).map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`appraisal-recommend-${r}`}
              onClick={() => setRecommend(r)}
              className={`rounded-lg px-2 py-1 text-xs font-semibold ring-1 ${recommend === r ? RECO_TONE[r] : "bg-white text-slate-500 ring-slate-200"}`}
            >
              {RECO_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {recommend === "no" && (
        <textarea
          data-testid="appraisal-rehire-reason"
          value={rehireReason}
          onChange={(e) => setRehireReason(e.target.value)}
          placeholder="Reason (required when 'do not re-hire')"
          className="mt-2 w-full rounded-lg border border-rose-200 px-2 py-1 text-sm"
        />
      )}

      <textarea
        data-testid="appraisal-comments"
        value={comments}
        onChange={(e) => setComments(e.target.value)}
        placeholder="Internal comments (agency-private — never shown to the seaman)"
        className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm"
      />

      {/* #11 — the note the agent chooses to SHARE with the seaman. */}
      <textarea
        data-testid="appraisal-shared-comment"
        value={sharedComment}
        onChange={(e) => setSharedComment(e.target.value)}
        placeholder="Comment shared with the seaman"
        className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm"
      />

      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      {deleteNote && (
        <p data-testid="appraisal-delete-note" className="mt-2 text-sm text-slate-600">
          {deleteNote}
        </p>
      )}

      {/* F3 — name the fast-path so a quick file isn't mistaken for a scored card. */}
      {kind === "interview" && fastPath && (
        <p data-testid="appraisal-fastpath-label" className="mt-3 text-xs font-medium text-slate-500">
          Quick appraisal — no competency scores.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        {kind === "interview" && (
          <button
            type="button"
            data-testid="appraisal-fastpath-submit"
            disabled={busy}
            onClick={() => submit(true)}
            className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Fast-path file
          </button>
        )}
        <button
          type="button"
          data-testid="appraisal-submit"
          disabled={busy}
          onClick={() => submit(false)}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          File appraisal
        </button>
      </div>

      <ul className="mt-4 space-y-2">
        {rows.map((a) => (
          <li key={a.id} data-testid="appraisal-row" className="border-t border-slate-100 pt-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-700">{a.kind === "post_voyage" ? "Post-voyage" : "Interview"}</span>
              <span className="text-slate-500">{a.overall}/5</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${RECO_TONE[a.recommend]}`}>{RECO_LABEL[a.recommend]}</span>
              {a.vessel && <span className="text-slate-400">{a.vessel}</span>}
              {/* #12 — delete this appraisal. */}
              <button
                type="button"
                data-testid="appraisal-delete"
                onClick={() => onDelete(a)}
                className="ml-auto rounded-lg px-2 py-0.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
              >
                Delete
              </button>
            </div>
            {/* #10 — the agent's own internal notes, previously not rendered anywhere. */}
            {a.comments?.trim() && (
              <p data-testid="appraisal-row-comments" className="mt-1 text-xs text-slate-500">
                <span className="font-semibold text-slate-600">Internal notes:</span> {a.comments}
              </p>
            )}
            {a.recommend === "no" && a.rehireReason?.trim() && (
              <p data-testid="appraisal-row-rehire-reason" className="mt-1 text-xs text-rose-600">
                <span className="font-semibold">Do-not-rehire reason:</span> {a.rehireReason}
              </p>
            )}
            {/* #11 — what the agent shared with the seaman. */}
            {a.sharedComment?.trim() && (
              <p data-testid="appraisal-row-shared-comment" className="mt-1 text-xs text-slate-500">
                <span className="font-semibold text-slate-600">Shared with seaman:</span> {a.sharedComment}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
