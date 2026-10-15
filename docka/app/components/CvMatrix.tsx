"use client";

// On-screen (and printable) seafarer CV / certificate matrix. A modal overlay that
// renders the SHARED CvModel (lib/cv.ts) — the exact same data path as the standalone
// /api/cv/[id] printable page — so what the seaman sees, what the agent sees, and the
// saved PDF are always identical. Print isolation is done with a scoped visibility
// rule (only the CV sheet prints), so the browser's "Save as PDF" yields a clean CV
// with none of the surrounding app chrome.

import { useState } from "react";
import type { Doc, Seafarer } from "@/lib/db";
import { buildCvModel, fmtCvDate, type CvModel } from "@/lib/cv";
import { StatusBadge } from "@/components/StatusBadge";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";

export function CvMatrix({
  seafarer,
  documents,
  onClose,
  /** Optional deep-link to the standalone printable HTML (seaman side, token-authorised). */
  printableUrl,
}: {
  seafarer: Seafarer;
  documents: Doc[];
  onClose: () => void;
  printableUrl?: string;
}) {
  const [model] = useState<CvModel>(() => buildCvModel(seafarer, documents));
  const s = model.summary;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 print:static print:block print:bg-transparent print:p-0"
      data-testid="cv-matrix"
      role="dialog"
      aria-modal="true"
      aria-label="Certificate matrix"
      onClick={onClose}
    >
      {/* Print isolation: hide everything, then reveal only the CV sheet. Scoped to
          while this modal is mounted, so it never affects the rest of the app. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #cv-sheet, #cv-sheet * { visibility: visible !important; }
          #cv-sheet { position: absolute; inset: 0; margin: 0; box-shadow: none; border: 0; border-radius: 0; max-width: none; }
          .cv-noprint { display: none !important; }
        }
      `}</style>

      <div
        id="cv-sheet"
        onClick={(e) => e.stopPropagation()}
        className="my-4 w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl print:my-0 print:shadow-none sm:p-8"
      >
        {/* Toolbar — never printed. */}
        <div className="cv-noprint mb-5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            CV / certificate matrix
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="cv-print"
              onClick={() => window.print()}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Print / Save as PDF
            </button>
            {printableUrl && (
              <a
                href={printableUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="cv-open-printable"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Open printable page
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              data-testid="cv-close"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
            >
              Close
            </button>
          </div>
        </div>

        {/* Header — identity + brand */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-slate-100 pb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900" data-testid="cv-name">
              {model.name}
            </h1>
            {model.rank && <p className="text-sm text-slate-500">{model.rank}</p>}
            {model.identityVerified && (
              <span
                className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold text-white"
                data-testid="cv-verified-stamp"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Government-verified identity
              </span>
            )}
            {(model.personalCode || model.birthDate || model.issuerCountry) && (
              <p className="mt-1.5 text-xs text-slate-500">
                {[
                  model.personalCode ? `Personal code ${model.personalCode}` : "",
                  model.birthDate ? `Born ${fmtCvDate(model.birthDate)}` : "",
                  model.issuerCountry ? `Issued by ${model.issuerCountry}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-lg font-extrabold tracking-tight text-sky-700">docka</p>
            <p className="text-[11px] text-slate-400">Seafarer credential platform</p>
          </div>
        </div>

        {/* #S7 + persona re-review — ONE coherent line covering BOTH axes: the
            verification tally ("N of M verified") AND the validity tally ("in date /
            expiring / expired"), so the reader no longer sees two separate count lines.
            Base counts stay neutral (a completeness number never reads as "verified =
            green"); expired stays red and expiring amber so problems still stand out. */}
        <p className="mt-4 text-sm font-medium text-slate-600" data-testid="cv-summary-line">
          <span className="font-semibold text-slate-800">
            {s.verified} of {s.total}
          </span>{" "}
          verified
          {s.valid > 0 && <span> · {s.valid} in date</span>}
          {s.expiring > 0 && (
            <span className="text-amber-700"> · {s.expiring} expiring soon</span>
          )}
          {s.expired > 0 && <span className="text-rose-700"> · {s.expired} expired</span>}
          {s.legalDiffers > 0 && (
            <span className="text-amber-700"> · {s.legalDiffers} legal expiry earlier than printed</span>
          )}
        </p>

        {/* Matrix */}
        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-400">
          Certificate matrix
        </h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm" data-testid="cv-table">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="border-b border-slate-200 py-2 pr-3 font-semibold">Certificate</th>
                <th className="border-b border-slate-200 py-2 pr-3 font-semibold">Category</th>
                <th className="border-b border-slate-200 py-2 pr-3 font-semibold">Number</th>
                <th className="border-b border-slate-200 py-2 pr-3 font-semibold">Expiry</th>
                <th className="border-b border-slate-200 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                    No documents on file yet.
                  </td>
                </tr>
              ) : (
                model.rows.map((r) => (
                  <tr key={r.docId} data-testid="cv-row" className="align-top">
                    <td className="border-b border-slate-100 py-2.5 pr-3">
                      <span className="font-medium text-slate-800">{r.title}</span>
                      {/* #S5 — the plain-green "verified" pill was a DUPLICATE of the
                          emerald "Government-verified" level badge in the Status cell;
                          dropped here so a gov doc carries the trust word exactly once. */}
                      {r.legalDiffers && r.legalNote && (
                        <span className="mt-1 block text-[11px] text-amber-700">{r.legalNote}</span>
                      )}
                    </td>
                    <td className="border-b border-slate-100 py-2.5 pr-3 text-slate-600">
                      {r.category}
                    </td>
                    <td className="border-b border-slate-100 py-2.5 pr-3 font-mono text-xs text-slate-500">
                      {r.number || "—"}
                    </td>
                    <td className="border-b border-slate-100 py-2.5 pr-3 text-slate-700">
                      {r.legalDiffers ? (
                        <>
                          <span className="block font-medium">{fmtCvDate(r.legalExpiry) || "—"}</span>
                          <span className="block text-[11px] text-slate-400 line-through">
                            printed {fmtCvDate(r.printedExpiry)}
                          </span>
                        </>
                      ) : (
                        fmtCvDate(r.legalExpiry) || "—"
                      )}
                    </td>
                    <td className="border-b border-slate-100 py-2.5">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={r.badge.status} label={r.badge.label} />
                        <span data-testid="cv-level">
                          <VerificationLevelBadge
                            level={r.level}
                            tooltip={r.levelTooltip}
                            size="sm"
                          />
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-5 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          Generated by docka on {fmtCvDate(model.generatedAt)}. Government-verified entries are
          confirmed against the issuing government&apos;s maritime registry.
        </p>
      </div>
    </div>
  );
}
