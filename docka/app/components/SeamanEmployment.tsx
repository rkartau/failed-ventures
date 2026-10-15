"use client";

// Seaman-facing employment doc-set checklist + own-SEA download (#41 item 18 + #45.4).
// Read-only: the assignment-scoped employment "you still owe" list is derived from the
// seaman's OWN documents via the shared read-model, and the SEA download uses the
// seaman's own share token (no agency data crosses).

import type { Doc, Seafarer } from "@/lib/db";
import { employmentContextFor, employmentCompleteness } from "@/lib/required-docs";

type Flow = {
  agentId: string;
  orgName: string;
  status: string;
  lockedVessel: string | null;
  lockedByAssignmentId?: string | null;
};

const SLOT_LABEL: Record<string, string> = {
  SEA: "Seafarer's Employment Agreement (SEA)",
  "Wage Account": "wage account confirmation",
  Allotment: "allotment form",
  "Contract Addendum": "contract addendum",
};

export function SeamanEmployment({
  seafarer,
  documents,
  flows,
}: {
  seafarer: Seafarer;
  documents: Doc[];
  flows: Flow[];
}) {
  // At sea under ANY agency => the employment doc-set is in scope for that voyage.
  const assigned = flows.some((f) => f.status === "LOCKED");
  const ec = employmentCompleteness(
    documents.map((d) => d.requiredType),
    documents,
    employmentContextFor(seafarer),
    { assigned }
  );
  const owedAll = [...ec.missing, ...ec.unknownExpiry];
  const seaLinks = flows.filter((f) => f.status === "LOCKED" && f.lockedByAssignmentId);
  const hasSeaDownload = seaLinks.length > 0;
  // F8 — resolve the "you still owe: SEA" vs "Download my SEA" contradiction: when the
  // draft SEA is downloadable, SEA becomes a SINGLE download → sign → return flow and is
  // NOT listed again as a bare owed bullet.
  const seaFlow = owedAll.includes("SEA") && hasSeaDownload;
  const owed = owedAll.filter((slot) => !(slot === "SEA" && hasSeaDownload));

  if (!assigned) return null;

  const seaHref = (assignmentId: string) =>
    `/api/contract/${encodeURIComponent(seafarer.id)}?token=${encodeURIComponent(
      seafarer.shareToken
    )}&assignmentId=${encodeURIComponent(assignmentId)}`;

  return (
    <section data-testid="seaman-employment-checklist" className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Employment documents for your voyage</h3>
        {/* F8 — a plain progress state so "X of 3 provided" is visible at a glance. */}
        <span
          data-testid="employment-progress"
          className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
            owedAll.length === 0
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
              : "bg-amber-50 text-amber-700 ring-amber-200"
          }`}
        >
          {ec.count} of {ec.total} provided
        </span>
      </div>

      {owedAll.length === 0 ? (
        <p className="mt-2 text-sm text-emerald-700">Your employment documents are complete for this voyage.</p>
      ) : (
        <>
          {/* F8 — SEA download → sign → return, as ONE flow (not a contradiction). */}
          {seaFlow && (
            <div data-testid="seaman-sea-flow" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
              <p className="text-sm font-semibold text-sky-900">Seafarer's Employment Agreement (SEA)</p>
              <p className="mt-0.5 text-sm text-sky-800">Download the draft SEA, sign it, and return it to your agency.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {seaLinks.map((f) => (
                  <a
                    key={f.agentId}
                    data-testid="seaman-download-sea"
                    href={seaHref(f.lockedByAssignmentId!)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
                  >
                    <DownloadIcon />
                    Download my SEA{f.lockedVessel ? ` — ${f.lockedVessel}` : ""} (draft)
                  </a>
                ))}
              </div>
            </div>
          )}

          {owed.length > 0 && (
            <>
              <p className="mt-3 text-sm text-slate-600">You still owe:</p>
              <ul className="mt-1 space-y-2">
                {owed.map((slot) => (
                  <li
                    key={slot}
                    data-testid="employment-owed-item"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2"
                  >
                    <span className="min-w-0 text-sm text-slate-700">
                      {SLOT_LABEL[slot] ?? slot}
                      {ec.unknownExpiry.includes(slot) && (
                        <span className="ml-1 text-amber-600">(on file — please reconfirm the expiry)</span>
                      )}
                    </span>
                    {/* F8 — a clear Upload action affordance (≥44px tap target). */}
                    <a
                      href="#add-documents"
                      data-testid="employment-upload-link"
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      <UploadIcon />
                      Upload
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {/* SEA already provided/current but still downloadable — keep the draft available
          as a real button (icon + button styling), separate from the owed list. */}
      {hasSeaDownload && !seaFlow && (
        <div className="mt-3 flex flex-wrap gap-2">
          {seaLinks.map((f) => (
            <a
              key={f.agentId}
              data-testid="seaman-download-sea"
              href={seaHref(f.lockedByAssignmentId!)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <DownloadIcon />
              Download my SEA{f.lockedVessel ? ` — ${f.lockedVessel}` : ""} (draft)
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
