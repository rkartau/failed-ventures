"use client";

// Seaman-facing appraisal awareness (#43 item 11). The seaman sees ONLY the projection
// the server returns (overall + ratings + recommendation) — never the agency-private
// comments, re-hire reason, or the individual coordinator's name. Fetched by the
// seaman's own share token.

import { useEffect, useState } from "react";

type SeamanAppraisal = {
  id: string;
  kind: "interview" | "post_voyage";
  overall: number;
  scores: { competency: string; rating: number }[];
  recommend: "yes" | "no" | "conditional";
  vessel: string | null;
  voyageFrom: string | null;
  voyageTo: string | null;
  authorOrg: string;
  createdAt: string;
  // #11 — the agency's shared note, deliberately surfaced to the seaman (private
  // `comments` / re-hire reason stay stripped by the server projection). Null/absent
  // when the agency shared no note.
  sharedComment: string | null;
};

const RECO_LABEL: Record<SeamanAppraisal["recommend"], string> = {
  yes: "Recommended for re-hire",
  conditional: "Conditional",
  no: "Not recommended",
};

export function SeamanAppraisals({ token }: { token: string }) {
  const [rows, setRows] = useState<SeamanAppraisal[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`/api/appraisals?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (live && data?.ok) setRows(data.appraisals ?? []);
      if (live) setLoaded(true);
    })();
    return () => { live = false; };
  }, [token]);

  if (!loaded || rows.length === 0) return null;

  return (
    <section data-testid="seaman-appraisals" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-slate-800">Appraisals filed about you</h3>
      <p className="mt-1 text-xs text-slate-500">
        Your agency shares your overall rating, recommendation, and any note they chose to
        share with you. Their internal notes stay private and are not shown to you.
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map((a) => (
          <li key={a.id} className="border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {/* F5 — the overall reads as "Overall rating: 4/5"; the kind (interview /
                  post-voyage) is a separate small tag, not fused into the number. */}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {a.kind === "post_voyage" ? "Post-voyage" : "Interview"}
              </span>
              <span data-testid="seaman-appraisal-overall" className="font-semibold text-slate-800">Overall rating: {a.overall}/5</span>
              <span className="text-slate-500">{RECO_LABEL[a.recommend]}</span>
              <span className="text-slate-400">{a.authorOrg}</span>
              {a.vessel && <span className="text-slate-400">{a.vessel}</span>}
            </div>
            {a.scores.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                {a.scores.map((s) => (
                  <span key={s.competency} className="rounded bg-slate-50 px-2 py-0.5">{s.competency}: {s.rating}/5</span>
                ))}
              </div>
            )}
            {/* #11 — the agency's shared note, when present. Rendered as a quoted note so it
                reads as the agency speaking to the seaman, not an internal record. */}
            {a.sharedComment && a.sharedComment.trim() && (
              <p
                data-testid="seaman-appraisal-shared-comment"
                className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-100"
              >
                <span className="font-medium text-slate-500">Note from your agency: </span>
                {a.sharedComment}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
