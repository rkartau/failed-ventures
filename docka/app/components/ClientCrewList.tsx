// #42 — the shipowner/client crew list. Renders ONLY the allow-list projection
// (lib/client-view ClientCrewRow) — there is no document/id/DOB here to render. Per
// required-slot breakdown with a VerificationLevelBadge; safety-critical expiry dates
// [R42.3]; "Issuing country / registry" label [R42.8]; surname stays masked [R42.4].

import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import type { ClientCrewRow, ClientSlot } from "@/lib/client-view";
import type { DocStatus } from "@/lib/cert";

const STATUS_TONE: Record<DocStatus, string> = {
  valid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  // Perpetual (no-expiry) — valid/compliant, styled like "valid" (emerald).
  none: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  expiring: "bg-amber-50 text-amber-800 ring-amber-200",
  expired: "bg-rose-50 text-rose-700 ring-rose-200",
  unknown: "bg-slate-100 text-slate-500 ring-slate-200",
};
const STATUS_WORD: Record<DocStatus, string> = {
  valid: "In date",
  // Perpetual document — intentionally no end date.
  none: "No expiry",
  expiring: "Expiring",
  expired: "Expired",
  // A null date not yet read — de-overloaded from the perpetual "No expiry" above.
  unknown: "Expiry unknown",
};

function fmtDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function SlotRow({ slot }: { slot: ClientSlot }) {
  return (
    <li
      data-testid="client-slot"
      data-required-type={slot.requiredType}
      data-present={slot.present ? "true" : "false"}
      data-status={slot.status}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700">{slot.requiredType}</span>
        {slot.present ? (
          <VerificationLevelBadge level={slot.level} size="sm" />
        ) : (
          <span className="rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
            Not on file
          </span>
        )}
      </div>
      {slot.present && (
        <div className="flex items-center gap-2">
          <span
            className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${STATUS_TONE[slot.status]}`}
          >
            {STATUS_WORD[slot.status]}
          </span>
          {/* Safety-critical slots show the actual expiry date [R42.3]. */}
          {slot.safetyCritical && slot.expiry && (
            <span className="text-[11px] text-slate-500">exp {fmtDay(slot.expiry)}</span>
          )}
        </div>
      )}
    </li>
  );
}

function CrewCard({ row }: { row: ClientCrewRow }) {
  return (
    <li
      data-testid="client-crew-row"
      data-ref={row.ref}
      data-sea-ready={row.seaReady ? "true" : "false"}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">{row.name}</p>
          {/* The seaman's current/other-vessel assignment is deliberately NOT shown —
              this is a proposed crew list for the client's own vessel (see the header),
              not a disclosure of where the crew currently sails [R42]. */}
          <p className="mt-0.5 text-sm text-slate-500">{row.rank || "Rank not set"}</p>
          {/* "nationality" is relabeled issuing country / registry [R42.8]. */}
          {row.issuingCountry && (
            <p className="mt-0.5 text-xs text-slate-400">
              Issuing country / registry: {row.issuingCountry}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* Colour-coded so a long list scans in one pass: green-FILLED = go,
              amber/red-FILLED = stop [D]. */}
          <span
            data-testid="crew-sea-ready"
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
              row.seaReady
                ? "bg-emerald-600 text-white ring-emerald-600"
                : "bg-rose-600 text-white ring-rose-600"
            }`}
          >
            {row.seaReady ? "Sea-ready" : "Not sea-ready"}
          </span>
          {row.possibleForgery && (
            <span
              data-testid="crew-forgery"
              className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 ring-1 ring-rose-200"
            >
              Possible forgery
            </span>
          )}
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-500">{row.verificationHeadline}</p>
      {(row.expiredCount > 0 || row.expiringCount > 0) && (
        <p className="mt-1 text-xs text-slate-500">
          {row.expiredCount > 0 && (
            <span className="text-rose-600">{row.expiredCount} expired</span>
          )}
          {row.expiredCount > 0 && row.expiringCount > 0 ? " · " : ""}
          {row.expiringCount > 0 && (
            <span className="text-amber-700">{row.expiringCount} expiring before the voyage ends</span>
          )}
        </p>
      )}

      <ul className="mt-3 space-y-1.5">
        {row.slots.map((slot) => (
          <SlotRow key={slot.requiredType} slot={slot} />
        ))}
      </ul>
    </li>
  );
}

export function ClientCrewList({ rows }: { rows: ClientCrewRow[] }) {
  if (rows.length === 0) {
    return (
      <p
        data-testid="client-crew-empty"
        className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400"
      >
        No crew to show here yet.
      </p>
    );
  }
  return (
    <ul data-testid="client-crew-list" className="space-y-3">
      {rows.map((row) => (
        <CrewCard key={row.ref} row={row} />
      ))}
    </ul>
  );
}
