"use client";

// A one-click "print / save as PDF" control for the inspection dossier, so an
// agent can hand a PSC/MLC inspector a clean printed copy on the spot. Uses the
// browser's own print dialog (which offers "Save as PDF") — no extra deps.
export function PrintButton() {
  return (
    <button
      type="button"
      data-testid="dossier-print"
      onClick={() => window.print()}
      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 print:hidden"
    >
      Print / Save as PDF
    </button>
  );
}
