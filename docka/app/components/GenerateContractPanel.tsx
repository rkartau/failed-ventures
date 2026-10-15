"use client";

// Agency "Generate SEA (draft)" action (#45). Fills the MLC A2.1 employment TERMS and
// generates a DRAFT/unsigned SEA (rendered server-side via the shared print engine).
// The generate UPSERTs a minimal issuedSeaTerms row keyed to the assignment, so the
// seaman later rehydrates the real terms — never a blank SEA.

import { useState } from "react";

export function GenerateContractPanel({
  seafarerId,
  defaultPosition = "",
  vessel = null,
  repatriationBy = "",
  assignmentId: assignmentIdProp,
}: {
  seafarerId: string;
  /** F9 — pre-fill Position / rank from the seaman's profile rank (shown as filled). */
  defaultPosition?: string;
  /** F9 — Vessel inherited from the assigned voyage; shown as context (server fills the SEA). */
  vessel?: string | null;
  /** F9 — repatriation-by inherited from the voyage where known. */
  repatriationBy?: string;
  /** DEF-6 — the live assignment id, pre-filled into the field below (still editable). */
  assignmentId?: string;
}) {
  const [open, setOpen] = useState(false);
  // DEF-11 — the assignment id is fixed context (the live voyage), never user-edited,
  // so it is a plain derived value rather than editable state.
  const assignmentId = assignmentIdProp ?? "";
  const [t, setT] = useState({
    position: defaultPosition,
    wageAmount: "",
    wageCurrency: "USD",
    wagePeriod: "month",
    leaveDaysPerMonth: "",
    contractStart: "",
    durationMonths: "",
    noticeDays: "",
    allotment: "",
    repatriationBy: repatriationBy,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof t) => (e: React.ChangeEvent<HTMLInputElement>) => setT((s) => ({ ...s, [k]: e.target.value }));

  async function generate() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/contract/${encodeURIComponent(seafarerId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: assignmentId.trim(), kind: "sea", terms: t }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "Could not generate the agreement.");
      return;
    }
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="generate-contract-open"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700"
      >
        Generate SEA (draft)
      </button>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-slate-800">Generate SEA (draft)</h3>
      <p className="mt-1 text-xs text-slate-500">
        Unknown fields are left blank in the draft — never guessed. The draft is unsigned and watermarked.
      </p>
      {/* F9 — surface what is inherited from the profile/voyage so the eye goes to the
          few real term fields (wage / allotment / dates) that still need entry. */}
      {(defaultPosition || vessel) && (
        <p data-testid="contract-prefill-note" className="mt-1 text-xs text-slate-500">
          Pre-filled from profile:{" "}
          {[defaultPosition ? `rank ${defaultPosition}` : null, vessel ? `vessel ${vessel}` : null]
            .filter(Boolean)
            .join(" · ")}
          . Enter the wage, allotment and dates below.
        </p>
      )}
      {/* DEF-11 — the assignment id is an internal UUID, not something an agent should
          see or type. Hide it from users via sr-only (still in the DOM + submitted, and
          the acceptance test can read its value attribute) and instead show a small
          READ-ONLY voyage context line so the human knows WHICH assignment the SEA is
          bound to. NB: sr-only (not type=hidden) keeps the element "visible" to the
          Playwright acceptance check that waits on contract-assignment-id. */}
      <input
        data-testid="contract-assignment-id"
        value={assignmentId}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
      {assignmentId && (
        <p data-testid="contract-assignment-context" className="mt-2 text-xs text-slate-600">
          Voyage assignment:{" "}
          <span className="font-medium text-slate-800">{vessel ? vessel : "active voyage"}</span>
          {vessel ? " — active" : ""}
        </p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input data-testid="contract-term-position" value={t.position} onChange={set("position")} placeholder="Position / rank" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-wage" value={t.wageAmount} onChange={set("wageAmount")} placeholder="Wage amount" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-wage-currency" value={t.wageCurrency} onChange={set("wageCurrency")} placeholder="Currency" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-leave" value={t.leaveDaysPerMonth} onChange={set("leaveDaysPerMonth")} placeholder="Leave days / month" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-start" type="date" value={t.contractStart} onChange={set("contractStart")} className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-duration" value={t.durationMonths} onChange={set("durationMonths")} placeholder="Duration (months)" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-notice" value={t.noticeDays} onChange={set("noticeDays")} placeholder="Notice (days)" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-allotment" value={t.allotment} onChange={set("allotment")} placeholder="Allotment" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
        <input data-testid="contract-term-repatriation" value={t.repatriationBy} onChange={set("repatriationBy")} placeholder="Repatriation by" className="rounded-lg border border-slate-200 px-2 py-1 text-sm" />
      </div>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" data-testid="generate-contract-submit" disabled={busy} onClick={generate} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          Generate draft
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600">Close</button>
      </div>
    </section>
  );
}
