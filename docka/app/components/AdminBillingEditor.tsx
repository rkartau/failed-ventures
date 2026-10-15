"use client";

import { useState } from "react";

// Admin-only per-agent billing knobs (plan P6). Same save shape as
// components/RequiredDocsSettings.tsx: local state, an async PUT to the API route,
// read `data.ok`, show a banner.
//
// The guidance ranges (200-500 base, 1-5 per seafarer) are SOFT: a value outside them
// is allowed but has to be confirmed, because a negotiated rate is a real business
// case and a typo is not.

type Props = {
  agentId: string;
  baseEurMonthly: number;
  perSeafarerEur: number;
  exemptFromBilling: boolean;
  hasSubscription: boolean;
};

const BASE_MIN = 200;
const BASE_MAX = 500;
const PER_MIN = 1;
const PER_MAX = 5;
// R3-FR1-2 (OWNER DECISION 2026-08-20) — per-seafarer hard floor. Mirrors
// MIN_PER_SEAFARER_EUR in app/app/api/admin/billing/route.ts (the SERVER is canonical);
// keep the two in sync. No agent may have a €0 per-seafarer rate.
const MIN_PER_SEAFARER_EUR = 0.1;

export function AdminBillingEditor({
  agentId,
  baseEurMonthly,
  perSeafarerEur,
  exemptFromBilling,
  hasSubscription,
}: Props) {
  const [base, setBase] = useState(String(baseEurMonthly));
  const [per, setPer] = useState(String(perSeafarerEur));
  const [exempt, setExempt] = useState(exemptFromBilling);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // R3-4 / D-4 / R3-FR1-2 — a BLANK rate field means "unchanged": it is omitted from the
  // payload, so clearing a field and saving keeps the stored rate instead of writing €0
  // (Number("") === 0 used to sail through as a real zero). Only PROVIDED fields are
  // validated and only PROVIDED fields drive the out-of-guidance confirm.
  const baseProvided = base.trim() !== "";
  const perProvided = per.trim() !== "";
  const baseNum = Number(base);
  const perNum = Number(per);
  const outside =
    (baseProvided && Number.isFinite(baseNum) && (baseNum < BASE_MIN || baseNum > BASE_MAX)) ||
    (perProvided && Number.isFinite(perNum) && (perNum < PER_MIN || perNum > PER_MAX));

  async function save() {
    if (baseProvided && !(Number.isFinite(baseNum) && baseNum > 0)) {
      setBanner("Base rate must be a positive number (leave it blank to keep the current rate).");
      return;
    }
    if (perProvided && !(Number.isFinite(perNum) && perNum >= MIN_PER_SEAFARER_EUR)) {
      setBanner("Per-seafarer rate must be at least €0.10 (leave it blank to keep the current rate).");
      return;
    }
    if (outside) {
      const proceed = window.confirm(
        `Those rates are outside the guidance ranges (${BASE_MIN}-${BASE_MAX} EUR base, ` +
          `${PER_MIN}-${PER_MAX} EUR per seafarer). Save anyway?`
      );
      if (!proceed) return;
    }
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/billing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          ...(baseProvided ? { baseEurMonthly: baseNum } : {}),
          ...(perProvided ? { perSeafarerEur: perNum } : {}),
          exemptFromBilling: exempt,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const parts = ["Saved."];
        if (data.stripeUpdated) parts.push("New Stripe prices applied from the next cycle.");
        if (data.stripeError) parts.push(`Stripe propagation FAILED: ${data.stripeError}`);
        if (data.outsideGuidance) parts.push("Note: outside the guidance ranges.");
        setBanner(parts.join(" "));
      } else {
        setBanner(data.error ?? "Could not save the billing settings.");
      }
    } catch {
      setBanner("Could not save the billing settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      {banner ? (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {banner}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">
            Base EUR / month
          </span>
          <input
            type="number"
            min={0}
            step={10}
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-400">
            Guidance {BASE_MIN}–{BASE_MAX}
          </span>
        </label>
        <label>
          <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">
            EUR per billable seafarer
          </span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={per}
            onChange={(e) => setPer(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-400">
            Guidance {PER_MIN}–{PER_MAX}
          </span>
        </label>
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={exempt}
          onChange={(e) => setExempt(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Not billed (comp / grandfathered).
          <span className="block text-xs text-slate-500">
            Instant per-agent kill switch: an exempt agency never accrues usage and never
            hits the paywall. Turning it back OFF restarts the billing clock from now, so
            comped days are never retro-billed.
          </span>
        </span>
      </label>

      {hasSubscription ? (
        <p className="mt-3 text-xs text-slate-500">
          This agency has a live Stripe subscription: a rate change creates new Price
          objects and swaps the subscription items with no proration, so the new licensed
          rate takes effect from the next cycle.
        </p>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={save}
        className="mt-4 rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save billing settings"}
      </button>
    </div>
  );
}
