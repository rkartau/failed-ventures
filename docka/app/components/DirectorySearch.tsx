"use client";

import { useEffect, useRef, useState } from "react";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import type { DirectoryRow } from "@/lib/directory";

// #49 — the docka-verified directory browser. Server-renders the initial projected rows;
// the search box calls /api/directory DEBOUNCED (~300ms) so a full readDB parse does not
// fire per keystroke [C5]. Renders the honest verification floor + expiry counts +
// "Represented by <agency> — enquire via agency" lead-routing [R49.11/R49.12].

function fmtDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function DirectoryCard({ row }: { row: DirectoryRow }) {
  return (
    <li
      data-testid="directory-row"
      data-ref={row.ref}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-slate-900">{row.name}</p>
          <p className="mt-0.5 text-sm text-slate-500">{row.rank || "Rank not set"}</p>
          {row.issuingCountry && (
            <p className="mt-0.5 text-xs text-slate-400">
              Issuing country / registry: {row.issuingCountry}
            </p>
          )}
        </div>
        <VerificationLevelBadge level={row.verificationFloor} size="sm" />
      </div>

      <p className="mt-2 text-xs text-slate-500">{row.verificationHeadline}</p>
      {(row.expiredCount > 0 || row.expiringCount > 0) && (
        <p className="mt-1 text-xs text-slate-500" data-testid="directory-expiry-counts">
          {row.expiredCount > 0 && <span className="text-rose-600">{row.expiredCount} expired</span>}
          {row.expiredCount > 0 && row.expiringCount > 0 ? " · " : ""}
          {/* Show the ACTUAL nearest expiry date, not just a bare count [E1]. */}
          {row.expiringCount > 0 && (
            <span className="text-amber-700">
              {row.expiringCount} expiring{row.nearestExpiry ? ` — next ${fmtDay(row.nearestExpiry)}` : " soon"}
            </span>
          )}
        </p>
      )}
      {row.expiredCount === 0 && row.expiringCount === 0 && row.nearestExpiry && (
        <p className="mt-1 text-xs text-emerald-700" data-testid="directory-next-expiry">
          All in date · next expiry {fmtDay(row.nearestExpiry)}
        </p>
      )}

      {row.sourcingAgencies.length > 0 && (
        <p className="mt-2 text-xs text-slate-600" data-testid="directory-agency">
          Represented by {row.sourcingAgencies.join(", ")} — enquire via agency.
        </p>
      )}
    </li>
  );
}

export function DirectorySearch({ initialRows }: { initialRows: DirectoryRow[] }) {
  const [text, setText] = useState("");
  // Server-side facet filters [E2] — the fetch below carries them; rows are always
  // filtered on the server (lib/directory), never in the browser.
  const [minLevel, setMinLevel] = useState<"" | "1" | "2" | "3">("");
  const [inDate, setInDate] = useState(false);
  const [rows, setRows] = useState<DirectoryRow[]>(initialRows);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = text.trim();
    // Below the 2-char floor and non-empty: don't fire — show the default listing.
    if (q.length === 1) {
      setStatus("Type at least 2 characters.");
      return;
    }
    timer.current = setTimeout(async () => {
      setBusy(true);
      setStatus(null);
      try {
        const params = new URLSearchParams();
        if (q.length >= 2) params.set("text", q);
        if (minLevel) params.set("minLevel", minLevel);
        if (inDate) params.set("inDate", "1");
        const res = await fetch(`/api/directory?${params.toString()}`);
        const data = await res.json();
        if (data.ok) {
          setRows(data.rows as DirectoryRow[]);
          if ((data.rows as DirectoryRow[]).length === 0) setStatus("No matches.");
        } else {
          setStatus(data.error ?? "Search failed.");
        }
      } catch {
        setStatus("Search failed.");
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, minLevel, inDate]);

  return (
    <div data-testid="directory-search">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search by name, rank or vessel…"
        maxLength={64}
        data-testid="directory-search-input"
        className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <span>Verification</span>
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as "" | "1" | "2" | "3")}
            data-testid="directory-filter-level"
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
          >
            <option value="">Any level</option>
            <option value="1">Level 1+ (self-declared)</option>
            <option value="2">Level 2+ (agency-checked)</option>
            <option value="3">Level 3 (government-verified)</option>
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600" data-testid="directory-filter-indate">
          <input type="checkbox" checked={inDate} onChange={(e) => setInDate(e.target.checked)} />
          All in date (no expiries)
        </label>
      </div>
      {status && (
        <p className="mt-2 text-xs text-slate-500" data-testid="directory-status">
          {busy ? "Searching…" : status}
        </p>
      )}
      {rows.length === 0 ? (
        <p
          data-testid="directory-empty"
          className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400"
        >
          No seafarers listed for these terms.
        </p>
      ) : (
        <ul className="mt-4 space-y-3" data-testid="directory-list">
          {rows.map((row) => (
            <DirectoryCard key={row.ref} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
