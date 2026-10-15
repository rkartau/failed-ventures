"use client";

import { useRef, useState } from "react";
import type { Seafarer } from "@/lib/db";
import type { SeafarerWithDocs } from "@/components/AgentBoard";
import { parseXlsx } from "@/lib/xlsx";
import { gridToRoster, parseRoster } from "@/lib/roster-parse";
import { useMenuDismiss } from "@/components/useMenuDismiss";
import { useCopyLink } from "@/components/useCopyLink";
import { claimLinkFor } from "@/components/claim-link";

// One-step crew import: take an existing Excel/CSV roster and turn every row into
// a placeholder seafarer with its own self-upload share link — so a manager with
// 80+ men can onboard the whole list at once instead of typing them in one by
// one. A native Excel .xlsx is read DIRECTLY (unzipped + parsed in the browser),
// so the agent never has to "Save As CSV" first; CSV/TSV pasted or chosen still
// works too (comma / semicolon / tab, quoted fields, optional header row).
//
// Handoff model here: NO email is sent from THIS component. After import the agent
// gets each new crew member's upload link to COPY and share manually. The email
// column is parsed and stored (as importedEmail) — it is used later as the recipient
// of the explicit per-row "Send invite" on the ReviewPanel placeholder panel, never
// sent from here.

// #37.2 — the import row carries DOB / passport / seaman's-book when the roster has
// those columns, so import-time matching is strong (not name-only).
type Row = {
  name: string;
  rank: string;
  dob?: string | null;
  passportNo?: string | null;
  seamanBookNo?: string | null;
  // A1 — an OPTIONAL email captured per row by the parser (validated via isEmailish in
  // roster-parse). Flows through confirm()'s {crew} POST body so /api/invite can store it
  // as importedEmail (NEVER ownerEmail). null when the roster had no/invalid email cell.
  // Later the recipient of the per-row "Send invite" (ReviewPanel); NOT sent from here.
  email?: string | null;
};

// One matched-existing-crew candidate for a just-imported row (#37.3 batch review).
type PersonMatchRow = {
  seafarerId: string;
  name: string;
  rank: string;
  confidence: number;
  corroborated: boolean;
  reasons: string[];
};
type MatchResult = {
  rowIndex: number;
  candidateId: string | null;
  candidateName: string;
  matches: PersonMatchRow[];
};

// Client-side mirror of lib/share-access.ts `parseShareToken` (that module imports
// server-only `@/auth`, so it can't be pulled into this "use client" bundle). Same
// shape: strip protocol/host/query/hash/trailing-slash, take the last path segment,
// tolerate the real base64url token alphabet (incl. `_`) with optional trailing `=`,
// cap ≤64. Returns the raw token, or null when the cell can't be a docka share token.
function parseShareToken(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const segs = s.split("/").filter(Boolean);
  s = segs.length ? segs[segs.length - 1] : "";
  if (!s) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return null;
  }
  decoded = decoded.trim();
  if (decoded.length === 0 || decoded.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(decoded)) return null;
  return decoded;
}

// Route a roster cell to the SHARE-LINK path only when it is actually a share LINK —
// i.e. it carries URL/path structure (a "/" — every docka share link is
// ".../share/<token>", and a bare crew NAME never contains a slash). Without this a
// single-word name like "Andres" (which happens to match the base64url token
// alphabet) was misclassified as a token, routed to /api/invite/link, resolved to no
// seafarer, and silently dropped — so it never became a placeholder and never got an
// upload link. Names now always take the placeholder path; genuine pasted share URLs
// still route to the link path. A bare token (no slash) belongs in the dedicated
// "Add by link" popover, not the roster box.
function looksLikeShareLink(cell: string): boolean {
  const s = cell.trim();
  if (!s.includes("/")) return false;
  return parseShareToken(s) !== null;
}

// Human-readable copy for a /api/invite/link skip status (shared shape with AgentBoard).
const LINK_SKIP_COPY: Record<string, string> = {
  invalid: "not a valid link",
  "not-found": "no seafarer matches this link",
  "view-only": "this is a view-only link",
  forbidden: "this private link isn't shared with your agency",
  withdrawn: "this seafarer withdrew your access",
  "already-added": "already on your board",
};

// Parser helpers now live in the pure, client-safe lib/roster-parse module (imported
// at the top of this file) so they are unit-testable without this "use client" shell
// and reusable by the /api/invite route. Re-exported here so existing importers of
// gridToRoster/parseRoster from this component keep working.
export { gridToRoster, parseRoster };

export function ImportCrew({
  onImported,
}: {
  onImported: (created: SeafarerWithDocs[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Click-outside / hover-away close — but never mid-import (results/links must
  // land somewhere).
  const dismiss = useMenuDismiss(open, () => {
    if (busy) return;
    setOpen(false);
  });
  // Split outcome: placeholder rows created (Name[,Rank]) vs share-link rows resolved
  // to existing seamen, plus any skipped links.
  const [done, setDone] = useState<{
    placeholders: number;
    linked: number;
    skipped: { input: string; status: string }[];
  } | null>(null);
  // #37.3 batch review after import — a SINGLE consolidated end screen, not per-row.
  const [matches, setMatches] = useState<MatchResult[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set()); // "survivorId|absorbedId"
  const [preview, setPreview] = useState<Record<string, string>>({}); // pairKey -> summary
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  // The surviving placeholder set to OFFER copy-paste upload links for. Seeded from the
  // /api/invite result (each created row carries its own shareToken); a placeholder merged
  // away in the batch-review below is dropped from here (server-authoritative surviving set).
  const [sendCandidates, setSendCandidates] = useState<Seafarer[]>([]);
  const { copiedId, copy: copyLink } = useCopyLink(1500);
  const fileRef = useRef<HTMLInputElement>(null);

  const pairKey = (survivorId: string, absorbedId: string) => `${survivorId}|${absorbedId}`;

  async function loadPreview(
    survivorId: string,
    absorbedId: string,
    survivorName: string,
    absorbedName: string
  ) {
    const key = pairKey(survivorId, absorbedId);
    const res = await fetch("/api/seafarers/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId, absorbedId, preview: true }),
    });
    const data = await res.json();
    if (data.ok) {
      const m = data.preview.moves;
      const grants = (m.accessGrants?.move ?? 0) + (m.accessGrants?.dropDuplicatePair ?? 0);
      // #S12 — plain words naming the SURVIVOR that is kept and what moves, not jargon.
      setPreview((p) => ({
        ...p,
        [key]:
          `${absorbedName} → merged into ${survivorName} (kept). ` +
          `${absorbedName} record removed. ` +
          `Moves: ${m.documents} document${m.documents === 1 ? "" : "s"}, ${grants} access grant${grants === 1 ? "" : "s"}.`,
      }));
    }
  }

  async function confirmMerge(survivorId: string, absorbedId: string) {
    const key = pairKey(survivorId, absorbedId);
    setMergeBusy(key);
    try {
      const res = await fetch("/api/seafarers/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survivorId, absorbedId }),
      });
      const data = await res.json();
      if (data.ok) {
        // Drop the merged (absorbed) row from the review list.
        setMatches((prev) =>
          (prev ?? []).filter((r) => r.candidateId !== absorbedId)
        );
        // The absorbed placeholder no longer resolves (merged into an existing seaman);
        // drop it from the copy-links set so we never surface a stale link.
        setSendCandidates((prev) => prev.filter((s) => s.id !== absorbedId));
      }
    } finally {
      setMergeBusy(null);
    }
  }

  function dismissPair(survivorId: string, absorbedId: string) {
    setDismissed((prev) => new Set(prev).add(pairKey(survivorId, absorbedId)));
  }

  function ingest(text: string) {
    setDone(null);
    const parsed = parseRoster(text);
    if (parsed.length === 0) {
      setRows([]);
      setError("No crew rows found. Expected a Name column (Rank optional).");
      return;
    }
    setError(null);
    setRows(parsed);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDone(null);
    // Native Excel .xlsx — read it directly (unzip + parse in the browser). No
    // "Save As CSV" second step.
    if (/\.xlsx$/i.test(file.name)) {
      try {
        const grid = await parseXlsx(await file.arrayBuffer());
        const parsed = gridToRoster(grid);
        if (parsed.length === 0) {
          setRows([]);
          setError("No crew rows found in that Excel file. Expected a Name column (Rank optional).");
          return;
        }
        setError(null);
        setRows(parsed);
      } catch {
        setRows([]);
        setError(
          "Could not read that Excel file. It may use an older .xls format — re-save as .xlsx, or export CSV, then import here."
        );
      }
      return;
    }
    if (/\.xls$/i.test(file.name)) {
      setRows([]);
      setError(
        "That's the older .xls format. Re-save it as .xlsx (or CSV) in Excel, then import here."
      );
      return;
    }
    const text = await file.text();
    ingest(text);
  }

  async function confirm() {
    if (rows.length === 0) return;
    setBusy(true);
    setError(null);
    // A fresh import clears any prior copy-links offer.
    setSendCandidates([]);
    try {
      // Pre-pass: rows whose first cell is a docka share link/token route to
      // /api/invite/link (they resolve to EXISTING seamen and form a grant); the
      // remaining Name[,Rank] rows stay on the placeholder path /api/invite {crew}.
      const linkInputs: string[] = [];
      const crewRows: Row[] = [];
      for (const r of rows) {
        if (looksLikeShareLink(r.name)) linkInputs.push(r.name);
        else crewRows.push(r);
      }

      let linked = 0;
      let placeholders = 0;
      let skipped: { input: string; status: string }[] = [];
      let createdRows: Seafarer[] = [];

      // 1) Share-link rows -> existing seamen (added to this agent's board + grant).
      if (linkInputs.length > 0) {
        const lres = await fetch("/api/invite/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ links: linkInputs }),
        });
        const ld = await lres.json().catch(() => null);
        if (lres.ok && ld?.ok) {
          const added: Seafarer[] = ld.added ?? [];
          linked = added.length;
          skipped = ld.skipped ?? [];
          if (added.length > 0) onImported(added.map((s: Seafarer) => ({ ...s, documents: [] })));
        } else {
          setError(ld?.error ?? "Some links could not be added.");
        }
      }

      // 2) Name[,Rank] rows -> placeholder seafarers (unchanged behaviour). The email
      //    column, when present, is POSTed and stored as importedEmail (dormant).
      if (crewRows.length > 0) {
        const res = await fetch("/api/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ crew: crewRows }),
        });
        const data = await res.json();
        if (data.ok) {
          createdRows = data.seafarers;
          placeholders = createdRows.length;
          // Seed the copy-links offer from the SERVER's created rows (each carries its own
          // shareToken). A later merge in the batch review drops absorbed ids.
          setSendCandidates(createdRows);
          onImported(createdRows.map((s: Seafarer) => ({ ...s, documents: [] })));
        } else {
          setError(data.error ?? "Import failed.");
        }
      }

      setDone({ placeholders, linked, skipped });
      setRows([]);
      if (fileRef.current) fileRef.current.value = "";

      // #37.3 — after import, run ONE consolidated dup check across the newly-created
      // PLACEHOLDER rows (link-added existing seamen are already real profiles).
      if (createdRows.length > 0) {
        try {
          const mr = await fetch("/api/seafarers/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidates: createdRows.map((s) => ({ id: s.id })) }),
          });
          const md = await mr.json();
          if (md.ok) {
            const flagged = (md.results as MatchResult[]).filter((r) => r.matches.length > 0);
            setMatches(flagged.length > 0 ? flagged : null);
          }
        } catch {
          /* dedup is best-effort — a failed check never blocks the import */
        }
      }
    } catch {
      setError("Import failed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" {...dismiss}>
      <button
        data-testid="import-open"
        onClick={() => setOpen((v) => !v)}
        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Import crew
      </button>
      {open && (
        // #S15 — z-30 keeps this popover ABOVE the sticky page header (z-20).
        <div className="absolute right-0 z-30 mt-2 w-96 rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
          <p className="text-sm font-semibold text-slate-800">Import your crew list</p>

          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
            data-testid="import-file"
            onChange={onFile}
            className="mt-3 block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-brand-700 hover:file:bg-brand-100"
          />

          <div className="my-2 text-center text-[11px] uppercase tracking-wide text-slate-400">
            or paste
          </div>

          <textarea
            rows={4}
            data-testid="import-text"
            onChange={(e) => ingest(e.target.value)}
            placeholder={"Name,Rank\nIvan Petrov,Able Seaman\nMaria Silva,Second Officer"}
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />

          {error && (
            <p data-testid="import-error" className="mt-2 text-xs font-medium text-rose-600">
              {error}
            </p>
          )}

          {rows.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-slate-600">
                <span data-testid="import-count" className="font-semibold text-slate-800">
                  {rows.length}
                </span>{" "}
                crew ready to import:
              </p>
              <div className="mt-1 max-h-32 space-y-0.5 overflow-auto rounded-lg bg-slate-50 p-2">
                {rows.slice(0, 8).map((r, i) => (
                  <div key={i} className="text-xs text-slate-700">
                    <span className="font-semibold">{r.name}</span>
                    {r.rank ? <span className="text-slate-500"> · {r.rank}</span> : null}
                    {/* A1/A4 — surface the detected email so the agent can eyeball it
                        before creating the placeholder. */}
                    {r.email ? (
                      <span data-testid="import-preview-email" className="text-brand-600"> · {r.email}</span>
                    ) : null}
                  </div>
                ))}
                {rows.length > 8 && (
                  <div className="text-xs text-slate-400">…and {rows.length - 8} more</div>
                )}
              </div>
            </div>
          )}

          {/* The primary action is ALWAYS visible while the panel is open, so a
              low-tech user sees exactly one clear button to finish the import — it
              starts disabled with a hint and enables the moment rows are ready,
              instead of only materialising after content is added. */}
          <button
            onClick={confirm}
            disabled={busy || rows.length === 0}
            data-testid="import-confirm"
            className="mt-3 w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
          >
            {busy
              ? "Importing…"
              : rows.length > 0
                ? `Import ${rows.length} crew`
                : "Choose a file or paste rows first"}
          </button>

          {done !== null && (
            <div data-testid="import-done" className="mt-2 space-y-1 text-xs font-medium">
              {done.linked > 0 && (
                <p className="text-emerald-600">
                  {done.linked} linked to existing seafarer{done.linked === 1 ? "" : "s"}.
                </p>
              )}
              {done.placeholders > 0 && (
                <p className="text-emerald-600">
                  {done.placeholders} added as roster placeholder{done.placeholders === 1 ? "" : "s"} —
                  they appear in Review as “not uploaded” until their documents arrive.
                </p>
              )}
              {done.skipped.length > 0 && (
                <div className="text-slate-600" data-testid="import-skipped">
                  <p>
                    {done.skipped.length} link{done.skipped.length === 1 ? "" : "s"} skipped:
                  </p>
                  <ul className="mt-0.5 list-inside list-disc">
                    {done.skipped.map((sk, i) => (
                      <li key={`${sk.input}-${i}`} data-status={sk.status} className="text-amber-700">
                        <span className="font-mono text-[11px] text-slate-500">{sk.input}</span> —{" "}
                        {LINK_SKIP_COPY[sk.status] ?? sk.status}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {done.linked === 0 && done.placeholders === 0 && done.skipped.length === 0 && (
                <p className="text-slate-500">Nothing to import.</p>
              )}
            </div>
          )}

          {/* #37.3 — ONE consolidated batch-review screen, not a per-row blocking prompt. */}
          {matches && (() => {
            const visible = matches
              .map((r) => ({
                ...r,
                matches: r.matches.filter(
                  (m) => !dismissed.has(pairKey(m.seafarerId, r.candidateId ?? ""))
                ),
              }))
              .filter((r) => r.candidateId && r.matches.length > 0);
            if (visible.length === 0) return null;
            const total = visible.length;
            // #S10 — only rows with a corroborated (mergeable) ≥0.85 best match are
            // "obvious"; the button names that COUNT and disables at 0.
            const obviousCount = visible.filter((r) =>
              r.matches.some((m) => m.corroborated && m.confidence >= 0.85)
            ).length;
            return (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="person-batch-review">
                <p className="text-xs font-semibold text-amber-900">
                  {total} of {done?.placeholders ?? total} imported crew may already exist —
                  review before they become duplicates.
                </p>
                <button
                  type="button"
                  data-testid="person-bulk-confirm"
                  disabled={obviousCount === 0}
                  className="mt-2 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  onClick={() => {
                    // Select-all-obvious: bulk-merge every corroborated ≥0.85 pair.
                    for (const r of visible) {
                      const best = r.matches.find((m) => m.corroborated && m.confidence >= 0.85);
                      if (best && r.candidateId) void confirmMerge(best.seafarerId, r.candidateId);
                    }
                  }}
                >
                  {obviousCount === 0
                    ? "Merge 0 obvious matches"
                    : `Merge ${obviousCount} strong match${obviousCount === 1 ? "" : "es"}`}
                </button>
                <ul className="mt-2 space-y-2">
                  {visible.map((r) => {
                    const absorbedId = r.candidateId as string;
                    return (
                      <li key={absorbedId} className="rounded-lg bg-white p-2 ring-1 ring-amber-200">
                        <p className="text-xs font-medium text-slate-700">{r.candidateName}</p>
                        {r.matches.map((m) => {
                          const key = pairKey(m.seafarerId, absorbedId);
                          const pct = Math.round(m.confidence * 100);
                          return (
                            <div
                              key={m.seafarerId}
                              data-testid="person-match-row"
                              data-confidence={m.confidence}
                              data-corroborated={m.corroborated ? "true" : "false"}
                              className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-600"
                            >
                              <p>
                                matches <span className="font-semibold">{m.name}</span>
                              </p>
                              {/* #S11 — coloured confidence chip: GREEN if mergeable
                                  (corroborated), AMBER if flag-only. */}
                              <span
                                data-testid="person-match-confidence"
                                className={`mt-1 inline-block rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${
                                  m.corroborated
                                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                    : "bg-amber-100 text-amber-800 ring-amber-200"
                                }`}
                              >
                                {pct}% — {m.reasons.join(", ")}
                              </span>
                              {/* #S13 — spaced controls; destructive Merge separated
                                  from the one-click Dismiss (pushed right). */}
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  className="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-200"
                                  onClick={() => void loadPreview(m.seafarerId, absorbedId, m.name, r.candidateName)}
                                >
                                  Preview
                                </button>
                                <button
                                  type="button"
                                  data-testid="person-merge-confirm"
                                  disabled={!m.corroborated || mergeBusy === key}
                                  onClick={() => void confirmMerge(m.seafarerId, absorbedId)}
                                  className="rounded bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                                  title={m.corroborated ? "" : "Needs a matching ID or exact name + DOB before merge"}
                                >
                                  {mergeBusy === key ? "Merging…" : "Merge"}
                                </button>
                                <button
                                  type="button"
                                  data-testid="person-match-dismiss"
                                  aria-label="Dismiss this match"
                                  onClick={() => dismissPair(m.seafarerId, absorbedId)}
                                  className="ml-auto inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M18 6 6 18" />
                                    <path d="M6 6l12 12" />
                                  </svg>
                                  Dismiss
                                </button>
                              </div>
                              {preview[key] && (
                                <p data-testid="person-match-preview" className="mt-2 rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                                  {preview[key]}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })()}

          {/* Copy-paste handoff: NO email is sent. For the surviving imported placeholders,
              show each crew member's upload link for the agent to copy and share manually.
              Each shareUrl is built CLIENT-SIDE from window.location.origin — the agent is on
              docka.me in their own browser, so this is the sanctioned client-side origin (NOT
              the server req.nextUrl bug; do NOT reach for getPublicBaseUrl, which is server-only). */}
          {(() => {
            const linkRows = sendCandidates.map((s) => ({
              id: s.id,
              name: s.name,
              shareUrl: claimLinkFor(s.shareToken, window.location.origin),
            }));
            // Single-name rule: for a lone import, do NOT surface the multi-link box —
            // just a compact inline "Copy link" so the one link is still reachable. The
            // full copy-all + per-line list appears only for 2+ crew.
            if (linkRows.length === 1) {
              const r = linkRows[0];
              return (
                <div
                  className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                  data-testid="invite-copy-single"
                >
                  <span className="min-w-0 truncate text-[11px] text-slate-600">
                    Upload link for <span className="font-semibold text-slate-700">{r.name}</span>
                  </span>
                  <button
                    type="button"
                    data-testid="invite-copy-link"
                    onClick={() => void copyLink(r.shareUrl, r.id)}
                    className="flex-shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {copiedId === r.id ? "Copied!" : "Copy link"}
                  </button>
                </div>
              );
            }
            if (linkRows.length < 2) return null;
            const allLinksText = linkRows.map((r) => `${r.name} — ${r.shareUrl}`).join("\n");
            return (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="invite-copy-links">
                <p className="text-xs font-semibold text-slate-800">
                  Upload links — copy and send each crew member their link
                </p>

                {/* One paste gives a labelled link block for WhatsApp/email. */}
                <button
                  type="button"
                  data-testid="invite-copy-links-all"
                  onClick={() => void copyLink(allLinksText, "all-links")}
                  className="mt-2 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {copiedId === "all-links" ? "Copied!" : `Copy all ${linkRows.length} links`}
                </button>
                {/* Clipboard-blocked/kiosk fallback: the SAME joined content in a selectable
                    readOnly block, so one manual select-all still grabs every link when
                    navigator.clipboard is unavailable. */}
                <textarea
                  data-testid="invite-send-copy-all-fallback"
                  readOnly
                  rows={Math.min(linkRows.length, 6)}
                  value={allLinksText}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1 w-full resize-y rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-600"
                />

                <ul className="mt-2 space-y-1" data-testid="invite-copy-links-list">
                  {linkRows.map((r) => (
                    <li
                      key={r.id}
                      data-testid="invite-copy-links-row"
                      className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-700">{r.name}</span>
                        <button
                          type="button"
                          data-testid="invite-copy-link"
                          onClick={() => void copyLink(r.shareUrl, r.id)}
                          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {copiedId === r.id ? "Copied!" : "Copy link"}
                        </button>
                      </div>
                      {/* Selectable + wrapping so the link can be transcribed when the
                          clipboard API is unavailable. */}
                      <code className="mt-1 block max-w-full select-all break-all rounded bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600 ring-1 ring-slate-200">
                        {r.shareUrl}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
