"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Doc, DocRequest, Seafarer } from "@/lib/db";
import {
  SEAFARER_STATES,
  STATE_LABELS,
  nextState,
  type SeafarerState,
} from "@/lib/pipeline";
import type { DocStatus } from "@/lib/cert";
import {
  requiredSetFor,
  type RequiredDocsConfig,
} from "@/lib/required-docs";
import {
  assignmentBlockers,
  isAssignmentAdvance,
  type AssignmentBlock,
} from "@/lib/compliance";
import type { DuplicateNameIndex } from "@/lib/duplicates";
// B2 — the card's single derivation seam: the view-model plus the moved board
// helpers (worst-status ordering, date formatting) now live in lib/board-card.ts
// and are imported BACK here, so the card and the filters share one definition.
import {
  boardCardModel,
  worstStatusForDocs,
  fmtDate,
  SEVERITY,
  type BoardCardModel,
  type StripSeverity,
} from "@/lib/board-card";
import { ImportCrew } from "@/components/ImportCrew";
import { useMenuDismiss } from "@/components/useMenuDismiss";
import { useCopyLink } from "@/components/useCopyLink";
import { claimLinkFor } from "@/components/claim-link";
import { useT } from "@/components/LanguageProvider";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { LEVEL_META } from "@/lib/verification-level";

export type SeafarerWithDocs = Seafarer & {
  documents: Doc[];
  docRequests?: DocRequest[];
  /**
   * #41 — TRUE when THIS agent holds a live assignment (returnedAt === null) for the
   * seaman, so the employment doc-set (SEA/wage/allotment) is in scope for the voyage.
   * Server-derived on the agent page from a single assignments pass (the N+1-safe map);
   * undefined/false = benched => employment "not required". Display-only.
   */
  assigned?: boolean;
};

export type FilterKind =
  | "all"
  | "problems"
  | "expired"
  | "expiring"
  | "missing"
  | "verify-pending"
  | "missing-employment";

const FILTERS: { key: FilterKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "problems", label: "Problems" },
  { key: "expired", label: "Expired" },
  { key: "expiring", label: "Expiring soon" },
  { key: "missing", label: "Missing documents" },
  // F7 (Nikos) — crew with a document awaiting verification: an OPEN manual-
  // verification request or a flagged holder mismatch.
  { key: "verify-pending", label: "Verification pending" },
  // #41 — assigned crew missing / expired / unknown-expiry employment docs
  // (SEA · wage · allotment) for their active voyage. Benched crew are excluded.
  { key: "missing-employment", label: "Missing employment docs" },
];

const STATE_ACCENT: Record<SeafarerState, string> = {
  review: "border-slate-300",
  accepted: "border-brand-300",
  sent_to_sea: "border-sky-300",
  returning: "border-amber-300",
  finished: "border-emerald-300",
};

type Row = {
  s: SeafarerWithDocs;
  /** B2 — the whole card view-model (cells, strips, floor, action state). */
  m: BoardCardModel;
  status: DocStatus;
  /** Missing required docs — derived from the model's docs cell (total − covered). */
  missing: number;
  /** F7 — docs awaiting verification (the model's gov-cell pending count). */
  verifyPending: number;
};

// vr2 item 3 — the soft advisory the ReviewPanel block modal already shows,
// mirrored into the kanban sea-block dialog: required slots that are FILLED but
// only by documents never registry-verified. Advisory ONLY — the gating logic
// (assignmentBlockers) is untouched.
function unverifiedFilledSlots(
  s: SeafarerWithDocs,
  config: RequiredDocsConfig | null
): string[] {
  const req = requiredSetFor({
    rank: s.rank,
    config,
    vesselType: s.vesselType,
    flag: s.flagState,
  });
  return [...req.required].filter((rt) => {
    const slotDocs = s.documents.filter((d) => d.requiredType === rt);
    return (
      slotDocs.length > 0 &&
      !slotDocs.some((d) => d.source === "government" || d.source === "registry")
    );
  });
}

export function AgentBoard({
  initial,
  initialFilter = "all",
  initialQuery = "",
  duplicates = {},
  requiredConfig = null,
  sampleMode = false,
}: {
  initial: SeafarerWithDocs[];
  initialFilter?: string;
  initialQuery?: string;
  /** cert-number -> crew entries sharing it (fleet-wide duplicate/forgery index). */
  duplicates?: DuplicateNameIndex;
  /** Per-agent required-docs config; when null the universal baseline is used. */
  requiredConfig?: RequiredDocsConfig | null;
  /**
   * Public sample board (plan §D2, Phase 4): read-only demo. Hides import/invite,
   * hidden-crew, exports, the bulk bar and every mutation affordance (drag /
   * stage move / hide); card clicks open the in-page sample review anchor instead
   * of /agent/[id]. Filters + search stay live (client-side, harmless).
   */
  sampleMode?: boolean;
}) {
  const router = useRouter();
  // B2/R1-2 — the bound `t` (stable per language via useCallback([lang])) feeds the
  // rows memo below, so strips/cells recompute on a language switch.
  const { t } = useT();
  const [roster, setRoster] = useState<SeafarerWithDocs[]>(initial);
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<FilterKind>(
    (FILTERS.some((f) => f.key === initialFilter) ? initialFilter : "all") as FilterKind
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bug1 — a transient error banner for a failed board hide (optimistic drop rolled back).
  const [hideError, setHideError] = useState<string | null>(null);
  // Which column the pointer is currently dragging a card over, so we can
  // highlight it as a live drop target.
  const [dragOverState, setDragOverState] = useState<SeafarerState | null>(null);
  // Assignment hard block: when a forward move into an assignment state is
  // refused, this holds the blocked seafarer, why, and the state we were trying
  // to reach, so the agent must either fix it or record a documented override.
  const [block, setBlock] = useState<{
    seafarer: SeafarerWithDocs;
    blockers: AssignmentBlock;
    target: SeafarerState;
  } | null>(null);
  // Multi-select for bulk document-request / renewal-reminder actions. At 150+
  // crew an agent can't chase each man individually, so the board lets them pick
  // a cohort and nudge all of them in one action.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  function toggleSelect(sid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }
  // Hydration marker so automation waits until React handlers are attached.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Reflect filter + search in the URL so the view is shareable/testable.
  // Sample mode: the board lives on /sample/agency — never rewrite to /agent.
  function syncUrl(nextFilter: FilterKind, nextQuery: string) {
    if (sampleMode) return;
    const params = new URLSearchParams();
    if (nextFilter !== "all") params.set("filter", nextFilter);
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    const qs = params.toString();
    router.replace(qs ? `/agent?${qs}` : "/agent", { scroll: false });
  }
  function changeFilter(f: FilterKind) {
    setFilter(f);
    syncUrl(f, query);
  }
  function changeQuery(q: string) {
    setQuery(q);
    syncUrl(filter, q);
  }

  // B2/R1-2 — the model is computed HERE (once per row) with the bound `t` in the
  // deps, so a language switch recomputes every strip/cell text. The filter fields
  // below are DERIVED from the model (single definition in lib/board-card.ts), so
  // filter counts and card counts can never diverge.
  const rows: Row[] = useMemo(
    () =>
      roster.map((s) => {
        const m = boardCardModel({ s, requiredConfig }, { tr: t });
        return {
          s,
          m,
          status: worstStatusForDocs(s.documents),
          missing: m.cells.docs.total - m.cells.docs.covered,
          verifyPending: m.cells.gov.pending,
        };
      }),
    [roster, requiredConfig, t]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      // Filter predicate.
      if (filter === "expired" && r.status !== "expired") return false;
      if (filter === "expiring" && r.status !== "expiring") return false;
      if (filter === "missing" && r.missing === 0) return false;
      if (filter === "verify-pending" && r.verifyPending === 0) return false;
      if (filter === "missing-employment") {
        // Only ASSIGNED crew (benched => not required) with a real employment-doc
        // gap: a slot missing entirely, or a SEA that is expired / unknown-expiry.
        // B2 — the model's employment cell already encodes exactly this (kind "gap").
        if (r.m.cells.employment.kind !== "gap") return false;
      }
      if (filter === "problems") {
        // Actionable triage shortlist, not "everyone with any gap":
        //  - drop crew already at sea or finished — nothing to action on them now;
        //  - keep only crew with a REAL issue: an expired/expiring document or a
        //    missing required document.
        if (r.s.state === "sent_to_sea" || r.s.state === "finished") return false;
        const hasIssue =
          r.status === "expired" || r.status === "expiring" || r.missing > 0;
        if (!hasIssue) return false;
      }
      // Search predicate.
      if (!q) return true;
      return (
        r.s.name.toLowerCase().includes(q) || (r.s.rank ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, filter]);

  const byState = useMemo(() => {
    const map: Record<SeafarerState, Row[]> = {
      review: [],
      accepted: [],
      sent_to_sea: [],
      returning: [],
      finished: [],
    };
    for (const r of filtered) map[r.s.state].push(r);
    // Worst-first within each column.
    for (const st of SEAFARER_STATES) {
      map[st].sort(
        (a, b) =>
          SEVERITY[b.status] - SEVERITY[a.status] ||
          b.missing - a.missing ||
          a.s.name.localeCompare(b.s.name)
      );
    }
    return map;
  }, [filtered]);

  const triage = useMemo(() => {
    let expiring = 0,
      expired = 0,
      missing = 0;
    for (const r of filtered) {
      if (r.status === "expiring") expiring++;
      if (r.status === "expired") expired++;
      if (r.missing > 0) missing++;
    }
    return { expiring, expired, missing };
  }, [filtered]);

  // Ids currently visible under the active filter/search — the set "Select all
  // shown" operates on, so an agent can pick, say, everyone in "Missing
  // documents" and request from all of them at once.
  const shownIds = useMemo(() => filtered.map((r) => r.s.id), [filtered]);
  const allShownSelected = shownIds.length > 0 && shownIds.every((sid) => selected.has(sid));
  function toggleSelectAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shownIds.length > 0 && shownIds.every((sid) => next.has(sid))) {
        for (const sid of shownIds) next.delete(sid);
      } else {
        for (const sid of shownIds) next.add(sid);
      }
      return next;
    });
  }

  async function move(
    id: string,
    state: SeafarerState,
    override?: { reason: string }
  ) {
    // Client-side pre-check: advancing an out-of-compliance man into an
    // assignment state ("Accepted"/"Sent to sea") never even fires an optimistic
    // update — the server enforces the same rule authoritatively.
    if (!override) {
      const target = roster.find((s) => s.id === id);
      if (target && isAssignmentAdvance(target.state, state)) {
        const req = requiredSetFor({
          rank: target.rank,
          config: requiredConfig,
          vesselType: target.vesselType,
          flag: target.flagState,
        });
        const b = assignmentBlockers(target.documents, {
          duplicates,
          ownName: target.name,
          rotationEnd: target.rotationEnd ?? null,
          required: req.required,
          holderDOB: target.birthDate ?? null,
        });
        if (b.blocked) {
          setBlock({ seafarer: target, blockers: b, target: state });
          return;
        }
      }
    }

    setBusyId(id);
    const prev = roster;
    setRoster((r) => r.map((s) => (s.id === id ? { ...s, state } : s)));
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          override ? { id, state, override: true, overrideReason: override.reason } : { id, state }
        ),
      });
      if (!res.ok) {
        setRoster(prev);
        // Server refused the advance — surface the block with its reasons.
        if (res.status === 409) {
          const data = await res.json().catch(() => null);
          const target = prev.find((s) => s.id === id);
          if (data?.blockers && target) {
            setBlock({ seafarer: target, blockers: data.blockers, target: state });
          }
        }
      } else {
        setBlock(null);
      }
    } catch {
      setRoster(prev);
    } finally {
      setBusyId(null);
    }
  }

  // Drop a dragged card onto a column: route through the SAME move() flow the
  // old menu used, so the compliance hard-block + override prompt + server audit
  // all still apply. No-op if dropped back on the card's own column.
  function handleDrop(target: SeafarerState, e: React.DragEvent) {
    e.preventDefault();
    setDragOverState(null);
    if (sampleMode) return; // read-only board — belt-and-braces (cards aren't draggable)
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    const dragged = roster.find((s) => s.id === id);
    if (!dragged || dragged.state === target) return;
    void move(id, target);
  }

  // Bug1 — "Remove from my board": hide this seaman from THIS agent's board only.
  // Reversible; the grant stays ACTIVE (does NOT revoke access or alter the profile).
  // Optimistic: drop the card immediately, and ROLL BACK (re-insert) + toast on failure.
  // At-sea/LOCKED seamen return 409 { atSea:true } — kept on the board with a clear reason.
  async function hide(id: string) {
    const prev = roster;
    setBusyId(id);
    setHideError(null);
    setRoster((r) => r.filter((s) => s.id !== id));
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, hide: true }),
      });
      if (!res.ok) {
        setRoster(prev); // roll back the optimistic drop
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data?.atSea) {
          setHideError(
            "Can't remove — this seafarer is currently at sea / on assignment."
          );
        } else {
          setHideError(
            data?.error ?? "Couldn't remove this seafarer from your board. Please try again."
          );
        }
      }
    } catch {
      setRoster(prev);
      setHideError("Couldn't remove this seafarer from your board. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div data-testid="agent-board" data-hydrated={hydrated ? "true" : "false"}>
      {/* Controls */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="Search by name or rank…"
            data-testid="agent-search"
            className="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                data-testid={`filter-${f.key}`}
                onClick={() => changeFilter(f.key)}
                className={`rounded-xl px-3 py-2 text-sm font-semibold ring-1 transition ${
                  filter === f.key
                    ? "bg-brand-600 text-white ring-brand-600"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* Roster-management toolbar — real boards only (sample is read-only). */}
          {!sampleMode && (
          <div className="ml-auto flex items-center gap-2">
            <ImportCrew onImported={(created) => setRoster((r) => [...r, ...created])} />
            <InvitePanel onInvited={(created) => setRoster((r) => [...r, ...created])} />
            <HiddenCrewPanel
              onRestore={(restored) =>
                setRoster((r) => (r.some((s) => s.id === restored.id) ? r : [...r, restored]))
              }
            />
            <a
              href="/api/export"
              data-testid="export-crew"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Export CSV
            </a>
            <a
              href="/api/export?report=rest-hours"
              data-testid="export-rest-hours"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Rest-hours CSV
            </a>
            <a
              href="/agent/inspection"
              data-testid="inspection-dossier"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Inspection dossier
            </a>
          </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-rose-100 px-2.5 py-1 font-semibold text-rose-800 ring-1 ring-rose-200">
            {triage.expired} expired
          </span>
          <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800 ring-1 ring-amber-200">
            {triage.expiring} expiring
          </span>
          <span className="rounded-full bg-sky-100 px-2.5 py-1 font-semibold text-sky-800 ring-1 ring-sky-200">
            {triage.missing} missing docs
          </span>
          <span
            data-testid="shown-count"
            className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600 ring-1 ring-slate-200"
          >
            {filtered.length} shown
          </span>
        </div>

        {/* B2 — one PERMANENT legend line for the card metric cells + strips
            (labels make the cells self-explanatory on touch, REQUIRED #10). */}
        <p data-testid="board-legend" className="text-xs text-slate-400">
          {t("board.legend")} — {t("board.allClear")}
        </p>

        {filter === "verify-pending" && (
          <p data-testid="filter-note" className="text-xs text-slate-500">
            Verification pending — crew with a document awaiting manual verification or flagged
            with a holder mismatch.
          </p>
        )}
        {(filter === "problems" || filter === "missing") && (
          <p data-testid="filter-note" className="text-xs text-slate-500">
            {filter === "problems"
              ? "Problems — crew still in the yard (not yet at sea or finished) with an expired/expiring document or a missing required document. Fully-cleared and already-sailed crew are hidden."
              : "Missing documents — crew missing at least one required document (Basic Safety Training, Medical, Endorsement, Seaman book, Passport)."}
          </p>
        )}
        {filter === "missing-employment" && (
          <p data-testid="filter-note" className="text-xs text-slate-500">
            Missing employment docs — assigned crew whose voyage doc-set (SEA · wage
            account · allotment) is missing, expired, or has an unknown SEA expiry.
            Benched crew are not required to hold these and are hidden.
          </p>
        )}

        {/* Bulk nudge bar — multi-select existing crew and request documents or
            fire renewal reminders to the whole cohort in one action. Hidden on
            the read-only sample board. */}
        {!sampleMode && (
        <BulkActions
          selectedIds={[...selected]}
          allShownSelected={allShownSelected}
          shownCount={shownIds.length}
          onToggleSelectAllShown={toggleSelectAllShown}
          onClear={clearSelection}
          onStageApplied={(updated) =>
            setRoster((r) =>
              r.map((s) => {
                const u = updated.find((x) => x.id === s.id);
                return u ? { ...s, state: u.state } : s;
              })
            )
          }
          onTagApplied={(updated) =>
            setRoster((r) =>
              r.map((s) => {
                const u = updated.find((x) => x.id === s.id);
                return u ? { ...s, tags: u.tags } : s;
              })
            )
          }
        />
        )}
      </div>

      {/* Bug1 — failed-hide toast: the optimistic drop was rolled back, so the card is
          still on the board; this explains why (e.g. at-sea/LOCKED). */}
      {hideError && (
        <div
          data-testid="board-hide-error"
          className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          <span>{hideError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setHideError(null)}
            className="font-semibold text-rose-500 hover:text-rose-700"
          >
            ✕
          </button>
        </div>
      )}

      {/* Kanban columns */}
      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        {SEAFARER_STATES.map((state) => (
          <section key={state} className="flex flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-700">{STATE_LABELS[state]}</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                {byState[state].length}
              </span>
            </div>
            <div
              data-testid={`column-${state}`}
              onDragOver={(e) => {
                // preventDefault marks this element as a valid drop target.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverState !== state) setDragOverState(state);
              }}
              onDragLeave={(e) => {
                // Only clear when the pointer truly leaves the column, not when
                // it crosses onto a child card.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverState(null);
                }
              }}
              onDrop={(e) => handleDrop(state, e)}
              className={`flex-1 space-y-3 rounded-2xl border-t-4 bg-slate-100/50 p-2 transition ${STATE_ACCENT[state]} ${
                dragOverState === state ? "bg-brand-50 ring-2 ring-brand-400" : ""
              }`}
            >
              {byState[state].length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">None</p>
              ) : (
                byState[state].map((row) => (
                  <SeafarerCard
                    key={row.s.id}
                    row={row}
                    busy={busyId === row.s.id}
                    onMove={move}
                    onHide={hide}
                    selected={selected.has(row.s.id)}
                    onToggleSelect={toggleSelect}
                    sampleMode={sampleMode}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      {block && (
        <SeaReadinessBlock
          name={block.seafarer.name}
          targetLabel={STATE_LABELS[block.target]}
          blockers={block.blockers}
          advisorySlots={unverifiedFilledSlots(block.seafarer, requiredConfig)}
          busy={busyId === block.seafarer.id}
          onCancel={() => setBlock(null)}
          onOverride={(reason) => void move(block.seafarer.id, block.target, { reason })}
        />
      )}
    </div>
  );
}

// Hard-block dialog shown when an agent tries to advance a non-sea-ready seafarer
// into an assignment state. The primary action is to STOP; assigning anyway
// requires typing a documented reason, which the server records to the audit trail.
function SeaReadinessBlock({
  name,
  targetLabel,
  blockers,
  advisorySlots = [],
  busy,
  onCancel,
  onOverride,
}: {
  name: string;
  targetLabel: string;
  blockers: AssignmentBlock;
  /**
   * vr2 item 3 — soft advisory (never a gate): filled required slots whose
   * document was never registry-verified. Mirrors ReviewPanel's
   * verify-advisory-block; the blocking logic above is untouched.
   */
  advisorySlots?: string[];
  busy: boolean;
  onCancel: () => void;
  onOverride: (reason: string) => void;
}) {
  const [showOverride, setShowOverride] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      data-testid="sea-block"
    >
      <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-100 text-rose-700">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          <h3 className="text-lg font-bold text-slate-900">Blocked — cannot advance to “{targetLabel}”</h3>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-semibold">{name}</span> is not sea-ready and cannot be
          assigned. Fix these first:
        </p>
        <ul className="mt-3 space-y-1" data-testid="sea-block-reasons">
          {blockers.expired.map((e, i) => (
            <li key={`e${i}`} className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-800 ring-1 ring-rose-200">
              Expired: {e.title}
            </li>
          ))}
          {blockers.rotationExpiring.map((e, i) => (
            <li key={`r${i}`} className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-800 ring-1 ring-rose-200">
              Expires before rotation end: {e.title}
            </li>
          ))}
          {blockers.missing.map((m, i) => (
            <li key={`m${i}`} className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
              Missing: {m}
            </li>
          ))}
          {blockers.forgeries.map((f, i) => (
            <li key={`f${i}`} className="rounded-lg bg-rose-100 px-3 py-1.5 text-xs font-semibold text-rose-900 ring-1 ring-rose-300">
              Possible forgery: {f.number} ({f.title}) also on {f.others.join(", ")}
            </li>
          ))}
        </ul>

        {/* vr2 item 3 — same soft advisory as ReviewPanel's block modal: what
            is on file but never registry-verified. Advisory only, not a
            blocker — the gate list above is unchanged. */}
        {advisorySlots.length > 0 && (
          <div
            data-testid="sea-block-advisory"
            className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"
          >
            <p className="font-semibold text-slate-500">Also worth knowing (not blocking):</p>
            <ul className="mt-1 space-y-0.5">
              {advisorySlots.map((rt) => (
                <li key={rt}>{rt}: document on file is not registry-verified.</li>
              ))}
            </ul>
          </div>
        )}

        {!showOverride ? (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-testid="sea-override-open"
              onClick={() => setShowOverride(true)}
              className="rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50"
            >
              Override with documented reason
            </button>
            <button
              type="button"
              data-testid="sea-block-ok"
              onClick={onCancel}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              OK, keep in yard
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3">
            <label className="text-xs font-semibold text-slate-600">
              This overrides a compliance block and is recorded to the audit trail.
              State your reason:
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              data-testid="sea-override-reason"
              placeholder="e.g. Endorsement confirmed by flag state by phone, ref #…"
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowOverride(false)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
              >
                Back
              </button>
              <button
                type="button"
                data-testid="sea-override-confirm"
                disabled={busy || !reason.trim()}
                onClick={() => onOverride(reason.trim())}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Override & send to sea"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// B2 — footer-strip tints via the app's existing semantic classes (red=danger,
// amber=warning, sky=package/progress #S3, gray=neutral facts). Green/emerald
// stays exclusive to government verification. Strips are FULL-BLEED bands
// (operator feedback): tint only — no ring border, no radius, no side margins.
const STRIP_TONE: Record<StripSeverity, string> = {
  red: "bg-rose-50 text-rose-700",
  amber: "bg-amber-50 text-amber-700",
  sky: "bg-sky-50 text-sky-700",
  neutral: "bg-slate-50 text-slate-600",
};

function SeafarerCard({
  row,
  busy,
  onMove,
  onHide,
  selected,
  onToggleSelect,
  sampleMode = false,
}: {
  row: Row;
  busy: boolean;
  onMove: (id: string, state: SeafarerState) => void;
  onHide: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Read-only sample board: no drag/move/hide/select; review opens in-page. */
  sampleMode?: boolean;
}) {
  const { s, m } = row;
  const { t } = useT();
  // B2 — dragend click-guard (~300ms): a click landing right after a drag must
  // never follow the stretched link. Compliance, not polish: accidental opens
  // write seafarer-visible REVIEWED audit entries.
  const lastDragEnd = useRef(0);
  // Kebab menu (holds "Remove from my board"); shares the toolbar popovers'
  // dismissal behavior (click-outside + hover-away).
  const [menuOpen, setMenuOpen] = useState(false);
  const menuDismiss = useMenuDismiss(menuOpen, () => setMenuOpen(false));
  const { copiedId, copy } = useCopyLink();

  const emp = m.cells.employment;
  // #S9 — the sm badge drops the inline freshness stamp; carry it in the tooltip
  // instead (L2/L3 only — a registry/government check that can go stale).
  const floorTip =
    m.floor >= 2 && m.floorVerifiedAt
      ? `${LEVEL_META[m.floor].tip} · verified ${fmtDate(m.floorVerifiedAt)}`
      : undefined;

  return (
    <div
      draggable={!busy && !sampleMode}
      onDragStart={(e) => {
        // R1-7 — an open kebab must not survive into a drag.
        setMenuOpen(false);
        // Carry the seafarer id to the destination column's drop handler.
        e.dataTransfer.setData("text/plain", s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      // B2 — passive timestamp only; the DnD flow itself is untouched.
      onDragEnd={() => {
        lastDragEnd.current = Date.now();
      }}
      // `relative` roots the stretched-link ::after overlay to the whole card.
      // `container-type:inline-size` makes the card a size container so the
      // header can restack at narrow column widths via @container (no JS).
      className={`relative ${menuOpen ? "overflow-visible z-30" : "overflow-hidden"} rounded-xl border bg-white p-3 shadow-sm [container-type:inline-size] ${
        sampleMode ? "" : "cursor-grab active:cursor-grabbing"
      } ${selected ? "border-brand-400 ring-1 ring-brand-200" : "border-slate-200"}`}
      data-testid="seafarer-card"
      data-name={s.name}
      data-selected={selected ? "true" : "false"}
    >
      {/* Header row: checkbox · name / rank + floor word · metric grid.
          The IDENTITY block has layout priority (operator fix): a 6rem
          flex-basis floor (checkbox + a readable name column) means the grid
          WRAPS BELOW (flex-wrap) rather than crushing the name whenever
          side-by-side genuinely doesn't fit. Under the 15rem @container
          threshold — which includes today's 5-column board, whose ~195px card
          content can never host a readable name beside the ~140px grid — the
          grid restyles to a full-width flowing row of four cells below the
          identity block. True side-by-side remains for wide cards (e.g. the
          single-column board below lg). */}
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-[1_1_6rem] items-start gap-2">
          {!sampleMode && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(s.id)}
              onClick={(e) => e.stopPropagation()}
              data-testid="card-select"
              aria-label={`Select ${s.name} for a bulk reminder`}
              className="relative z-10 mt-0.5 h-4 w-4 flex-shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
          )}
          <div className="min-w-0">
            {/* F7 — never truncate the seaman NAME (identity), and never break
                it MID-WORD (no break-words/break-all): normal word wrapping
                only — the header restack above guarantees readable width. */}
            <p data-testid="card-name" className="text-sm font-semibold text-slate-900">
              {s.name}
              {/* SAMPLE chip — keyed on the ROW's isSample flag, so it renders on
                  the public sample board AND on a real agent's board once they
                  grant themselves the flagship (same code path, plan §D10). */}
              {s.isSample === true && (
                <span
                  data-testid="card-sample-chip"
                  title="Fictional sample profile — demo data"
                  className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300"
                >
                  Sample
                </span>
              )}
              {/* Claim-status chip (§5): Claimed / Invite pending / Link opened. No chip
                  for legacy-unowned or sample. `relative z-10` so its title stays
                  hoverable above the stretched-link overlay (R1-5 rule). */}
              {m.claim.label && (
                <span
                  data-testid="card-claim-chip"
                  data-state={m.claim.testid ?? undefined}
                  title={m.claim.tip ?? undefined}
                  className={`relative z-10 ml-1.5 inline-block rounded-full px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide ring-1 ${
                    m.claim.testid === "claimed"
                      ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                      : m.claim.testid === "pending"
                        ? "bg-amber-100 text-amber-800 ring-amber-300"
                        : "bg-sky-50 text-sky-800 ring-sky-200"
                  }`}
                >
                  {m.claim.label}
                </span>
              )}
            </p>
            {/* Rank + the verification FLOOR word (#30.6 — floor, never max(docs));
                the badge sits above the overlay (R1-5) so its tooltip — incl. the
                #S9 freshness stamp — stays hoverable. */}
            {/* Rank WRAPS at narrow widths (never an unreadable "M…" ellipsis);
                the floor word stays attached in the same wrapping row. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">{s.rank || "—"}</span>
              <span className="relative z-10 inline-block" data-testid="roster-verification-level">
                <VerificationLevelBadge
                  level={m.floor}
                  tooltip={floorTip}
                  size="sm"
                  verifiedOn={m.floorVerifiedAt}
                />
              </span>
            </div>
          </div>
        </div>

        {/* B2 — right-aligned 2×2 labeled metric grid (labels, not icon-only —
            REQUIRED #10). Above the overlay (R1-5) so every `title` tooltip the
            spec requires stays reachable. Under the card's 15rem @container
            threshold it becomes a full-width wrapping ROW of four cells below
            the identity block (operator fix — narrow board columns). */}
        <div
          data-testid="card-metric-grid"
          className="relative z-10 ml-auto grid flex-shrink-0 grid-cols-2 gap-x-2.5 gap-y-0.5 text-[12px] leading-tight text-slate-600 [@container(max-width:15rem)]:mt-0.5 [@container(max-width:15rem)]:flex [@container(max-width:15rem)]:w-full [@container(max-width:15rem)]:flex-wrap [@container(max-width:15rem)]:items-center [@container(max-width:15rem)]:justify-between [@container(max-width:15rem)]:gap-x-2 [@container(max-width:15rem)]:text-[11px]"
        >
          <span
            title={t("board.cell.docsTip", {
              covered: m.cells.docs.covered,
              total: m.cells.docs.total,
            })}
            className="whitespace-nowrap"
            data-testid="card-cell-docs"
          >
            <span aria-hidden="true">📄 </span>
            {t("board.cell.docs", { n: m.cells.docs.count })}
          </span>
          {/* Gov-only shield count (#30.6/#S3): registry-confirmed + checked live
              in the tooltip; "+N pend" keeps the verify-pending filter anchored
              on the card (REQUIRED #9). */}
          <span
            title={t("board.cell.govTip", {
              registry: m.cells.gov.registry,
              checked: m.cells.gov.checked,
            })}
            className="whitespace-nowrap"
            data-testid="card-cell-gov"
          >
            <span aria-hidden="true">🛡 </span>
            {t("board.cell.gov", { n: m.cells.gov.gov })}
            {m.cells.gov.pending > 0 && (
              <span className="text-slate-400">
                {" "}
                {t("board.cell.govPend", { n: m.cells.gov.pending })}
              </span>
            )}
          </span>
          <span
            title={t("board.cell.reqTip")}
            className="whitespace-nowrap"
            data-testid="card-cell-req"
          >
            <span aria-hidden="true">✉ </span>
            {t("board.cell.req", { n: m.cells.req.open })}
          </span>
          {/* 💼 employment (#41 shared read-model): benched text (F6 — never a
              bare "—"), ✓ complete, count when gapped; a reconfirm SEA is a gap,
              never a false all-clear (REQUIRED #8). Keeps the shipped testid +
              data attributes. */}
          {emp.kind === "benched" ? (
            <span
              data-testid="roster-employment-completeness"
              data-employment-applicable="false"
              title={t("board.cell.empTip")}
              className="whitespace-nowrap text-slate-400"
            >
              <span aria-hidden="true">💼 </span>
              {t("board.cell.empBenched")}
            </span>
          ) : (
            <span
              data-testid="roster-employment-completeness"
              data-employment-applicable="true"
              data-employment-count={emp.count}
              data-employment-total={emp.total}
              title={
                emp.kind === "gap" && emp.reconfirm
                  ? `${t("board.cell.empTip")} · SEA: ${t("board.cell.empReconfirm")}`
                  : t("board.cell.empTip")
              }
              className={`whitespace-nowrap font-semibold ${
                emp.kind === "complete"
                  ? // #S3 — completeness is sky, never the gov emerald.
                    "text-sky-700"
                  : emp.seaBad
                    ? "text-rose-600"
                    : "text-amber-600"
              }`}
            >
              <span aria-hidden="true">💼 </span>
              {emp.kind === "complete" ? "✓" : `${emp.count}/${emp.total}`}
            </span>
          )}
        </div>
      </div>

      {/* B2 footer strips — the card's ENTIRE status system. None = all clear
          (the legend documents it). Structurally ≤1 per severity (the model
          aggregates each bucket). 2-line wrap allowed — never whitespace-nowrap
          in this card (DEF-12).
          FULL-BLEED bands (operator feedback): the -mx-3 wrapper cancels the
          card root's p-3 so every strip runs edge-to-edge, flush with the
          card's left/right borders and clipped by the root's rounded corners
          (the root already carries overflow-hidden). Strips stack gapless; the
          px-3 inside re-aligns the strip text with the card's content edge. */}
      {m.strips.length > 0 && (
        <div className="-mx-3 mt-2">
          {m.strips.map((strip) => (
            <div
              key={strip.severity}
              data-testid={strip.testid}
              className={`px-3 py-1.5 text-[11px] font-semibold ${STRIP_TONE[strip.severity]}`}
            >
              {strip.severity === "neutral" && <span aria-hidden="true">🔒 </span>}
              {strip.text}
            </div>
          ))}
        </div>
      )}

      {/* Action row: "Review →" is a REAL stretched-link anchor (whole card =
          hit area via the ::after overlay; ctrl/middle-click/copy-link survive).
          Sample board: anchor targets the in-page read-only review instead
          (no /agent/[id] — that route is session-gated). */}
      <div className="mt-3 flex items-center gap-2">
        <a
          href={sampleMode ? "#sample-review" : `/agent/${s.id}`}
          data-testid="review-link"
          // Anchors are natively draggable — must not fight the card's drag.
          draggable={false}
          onClick={(e) => {
            // Dragend click-guard: plain left-clicks only — modified/middle
            // clicks never reach this branch's preventDefault window logic.
            if (Date.now() - lastDragEnd.current < 300) e.preventDefault();
          }}
          className="text-xs font-semibold text-brand-600 after:absolute after:inset-0 after:content-[''] hover:text-brand-800"
        >
          {t("board.review")} →
        </a>
        {/* "→ next" — unchanged semantics/testid; the only stage control on touch. */}
        {!m.actionState.atEnd && !sampleMode && (
          <button
            disabled={busy}
            data-testid="move-next"
            onClick={(e) => {
              e.stopPropagation();
              onMove(s.id, nextState(s.state));
            }}
            className="relative z-10 flex-1 rounded-lg bg-slate-900 px-2 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            → {m.actionState.nextLabel}
          </button>
        )}
        {/* Kebab — holds "Remove from my board" (Bug1 hidden-crew affordance;
            identical disabled-at-sea logic + title, handler untouched). */}
        {!sampleMode && (
          <div className="relative z-10 ml-auto" {...menuDismiss}>
            <button
              type="button"
              data-testid="card-menu"
              aria-label={t("board.menuLabel")}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="rounded-lg px-1.5 py-0.5 text-sm font-bold leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              ⋮
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                {/* Copy profile link — PLACEHOLDER rows only (after claim the
                    /seafarer?token= link is the seaman's PRIVATE dashboard). The menu
                    stays open so "Copied!" is visible; copy only (send/edit live on the
                    detail page). Claimed / legacy-unowned / sample keep today's kebab. */}
                {m.claim.kind === "placeholder" && (
                  <button
                    type="button"
                    data-testid="copy-profile-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      void copy(claimLinkFor(s.shareToken, window.location.origin), s.id);
                    }}
                    title={m.claim.tip ?? undefined}
                    className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                  >
                    {copiedId === s.id ? t("board.claim.copied") : t("board.claim.copyLink")}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="remove-from-board"
                  disabled={busy || s.assigned === true}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onHide(s.id);
                  }}
                  title={
                    s.assigned === true
                      ? t("board.removeAtSeaTip")
                      : t("board.removeTip")
                  }
                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent disabled:hover:text-slate-300"
                >
                  {t("board.removeFromBoard")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Agent tags — UNCHANGED violet cohort chips (bulk tag-remove depends on
          seeing them). */}
      {(s.tags?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" data-testid="card-tags">
          {s.tags!.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Bulk document-request / renewal-reminder bar. Multi-select crew (per-card
// checkboxes or "Select all shown"), then nudge the whole cohort at once. Each
// nudge is recorded to that seaman's audit trail and returns his self-upload
// share link so the agent can pass it on. Built for 150+ crew where opening and
// chasing each man individually is not workable.
type BulkResult =
  | { error: string }
  | {
      kind: "request" | "renewal";
      count: number;
      delivered: number;
      reminders: {
        seafarerId: string;
        name: string;
        shareToken: string;
        message: string;
        delivered: boolean;
        delivery: string;
      }[];
    }
  | {
      action: "message";
      count: number;
      delivered: number;
    }
  | {
      action: "stage";
      stateLabel: string;
      moved: number;
      blocked: { seafarerId: string; name: string; reasons: string[] }[];
    }
  | {
      action: "tag";
      tagOp: "add" | "remove";
      tag: string;
      count: number;
    };

function BulkActions({
  selectedIds,
  allShownSelected,
  shownCount,
  onToggleSelectAllShown,
  onClear,
  onStageApplied,
  onTagApplied,
}: {
  selectedIds: string[];
  allShownSelected: boolean;
  shownCount: number;
  onToggleSelectAllShown: () => void;
  onClear: () => void;
  onStageApplied: (updated: { id: string; state: SeafarerState }[]) => void;
  onTagApplied: (updated: { id: string; tags: string[] }[]) => void;
}) {
  // A single "busy" token gates every bulk button so two actions can't race.
  const [sending, setSending] = useState<
    null | "request" | "renewal" | "message" | "stage" | "tag"
  >(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  // Which secondary composer is open (free-text message / stage picker / tag box).
  const [panel, setPanel] = useState<null | "message" | "stage" | "tag">(null);
  const [message, setMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [stage, setStage] = useState<SeafarerState>("accepted");
  const [tag, setTag] = useState("");
  const count = selectedIds.length;

  async function send(kind: "request" | "renewal") {
    if (count === 0 || sending) return;
    setSending(kind);
    setResult(null);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerIds: selectedIds, kind }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult({
          kind: data.kind,
          count: data.count,
          delivered: data.delivered ?? 0,
          reminders: data.reminders,
        });
        onClear();
      } else {
        setResult({ error: data.error ?? "Could not send." });
      }
    } catch {
      setResult({ error: "Could not send. Check your connection and try again." });
    } finally {
      setSending(null);
    }
  }

  // POST /api/bulk for the message / stage / tag actions. Grant-scoped + (for
  // stage) sea-readiness-blocked server-side; the reply drives the local roster
  // update so the board reflects moves/tags without a reload.
  async function runBulk(action: "message" | "stage" | "tag") {
    if (count === 0 || sending) return;
    if (action === "message" && !message.trim()) return;
    if (action === "tag" && !tag.trim()) return;
    setSending(action);
    setResult(null);
    try {
      const payload: Record<string, unknown> = { action, seafarerIds: selectedIds };
      if (action === "message") {
        payload.message = message.trim();
        if (subject.trim()) payload.subject = subject.trim();
      } else if (action === "stage") {
        payload.state = stage;
      } else {
        payload.tagOp = "add";
        payload.tag = tag.trim();
      }
      const res = await fetch("/api/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setResult({ error: data.error ?? "Could not apply." });
        return;
      }
      if (action === "message") {
        setResult({ action: "message", count: data.count, delivered: data.delivered ?? 0 });
        setMessage("");
        setSubject("");
        setPanel(null);
        onClear();
      } else if (action === "stage") {
        onStageApplied(data.seafarers ?? []);
        setResult({
          action: "stage",
          stateLabel: data.stateLabel ?? "",
          moved: data.moved ?? 0,
          blocked: data.blocked ?? [],
        });
        setPanel(null);
        // Keep the selection when some were blocked so the agent can act on them.
        if (!data.blocked || data.blocked.length === 0) onClear();
      } else {
        onTagApplied(data.seafarers ?? []);
        setResult({ action: "tag", tagOp: data.tagOp, tag: data.tag, count: data.count });
        setTag("");
        setPanel(null);
      }
    } catch {
      setResult({ error: "Could not apply. Check your connection and try again." });
    } finally {
      setSending(null);
    }
  }

  const disabled = count === 0 || sending !== null;

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="bulk-bar"
        className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
      >
        <label className="inline-flex items-center gap-1.5 font-semibold text-slate-600">
          <input
            type="checkbox"
            checked={allShownSelected}
            onChange={onToggleSelectAllShown}
            disabled={shownCount === 0}
            data-testid="select-all-shown"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Select all shown ({shownCount})
        </label>
        <span data-testid="bulk-count" className="text-slate-500">
          {count} selected
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => send("request")}
            data-testid="bulk-request"
            className="rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 font-semibold text-brand-700 hover:bg-brand-100 disabled:opacity-50"
          >
            {sending === "request" ? "Sending…" : "Request documents"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => send("renewal")}
            data-testid="bulk-renewal"
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            {sending === "renewal" ? "Sending…" : "Send renewal reminders"}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPanel((p) => (p === "message" ? null : "message"))}
            data-testid="bulk-message-open"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Send message
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPanel((p) => (p === "stage" ? null : "stage"))}
            data-testid="bulk-stage-open"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Move stage
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPanel((p) => (p === "tag" ? null : "tag"))}
            data-testid="bulk-tag-open"
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Tag
          </button>
          {count > 0 && (
            <button
              type="button"
              onClick={onClear}
              data-testid="bulk-clear"
              className="rounded-lg px-2 py-1.5 font-medium text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Free-text message composer */}
      {panel === "message" && (
        <div
          data-testid="bulk-message-panel"
          className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs"
        >
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional)"
            data-testid="bulk-message-subject"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="Message to the selected crew…"
            data-testid="bulk-message-body"
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="rounded-lg px-3 py-1.5 font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={disabled || !message.trim()}
              onClick={() => runBulk("message")}
              data-testid="bulk-message-send"
              className="rounded-lg bg-brand-600 px-4 py-1.5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {sending === "message" ? "Sending…" : `Send to ${count}`}
            </button>
          </div>
        </div>
      )}

      {/* Stage-move picker */}
      {panel === "stage" && (
        <div
          data-testid="bulk-stage-panel"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs"
        >
          <span className="font-semibold text-slate-600">Move {count} to</span>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as SeafarerState)}
            data-testid="bulk-stage-select"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {SEAFARER_STATES.map((st) => (
              <option key={st} value={st}>
                {STATE_LABELS[st]}
              </option>
            ))}
          </select>
          <span className="text-slate-400">
            Crew not sea-ready are blocked and stay put.
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="rounded-lg px-3 py-1.5 font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => runBulk("stage")}
              data-testid="bulk-stage-apply"
              className="rounded-lg bg-slate-900 px-4 py-1.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {sending === "stage" ? "Moving…" : "Move"}
            </button>
          </div>
        </div>
      )}

      {/* Tag box */}
      {panel === "tag" && (
        <div
          data-testid="bulk-tag-panel"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs"
        >
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runBulk("tag");
            }}
            placeholder="Tag, e.g. priority"
            data-testid="bulk-tag-input"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="rounded-lg px-3 py-1.5 font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={disabled || !tag.trim()}
              onClick={() => runBulk("tag")}
              data-testid="bulk-tag-apply"
              className="rounded-lg bg-brand-600 px-4 py-1.5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {sending === "tag" ? "Tagging…" : `Add to ${count}`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          data-testid="bulk-result"
          className={`rounded-xl border px-3 py-2 text-xs ${
            "error" in result
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {"error" in result ? (
            result.error
          ) : "action" in result && result.action === "message" ? (
            <p className="font-semibold">
              Message sent to {result.count} crew — {result.delivered} e-mailed
              {result.delivered < result.count
                ? `, ${result.count - result.delivered} recorded only (no e-mail / channel off)`
                : ""}
              .
            </p>
          ) : "action" in result && result.action === "stage" ? (
            <div className="space-y-1">
              <p className="font-semibold">
                Moved {result.moved} crew to “{result.stateLabel}”
                {result.blocked.length > 0
                  ? ` — ${result.blocked.length} blocked (not sea-ready).`
                  : "."}
              </p>
              {result.blocked.length > 0 && (
                <div
                  data-testid="bulk-stage-blocked"
                  className="max-h-40 space-y-1 overflow-auto text-rose-700"
                >
                  {result.blocked.map((b) => (
                    <div key={b.seafarerId}>
                      <span className="font-semibold">{b.name}</span>: {b.reasons.join("; ")}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : "action" in result && result.action === "tag" ? (
            <p className="font-semibold">
              Tag “{result.tag}” added to {result.count} crew.
            </p>
          ) : "reminders" in result ? (
            <div className="space-y-1">
              <p className="font-semibold">
                {result.kind === "request" ? "Document request" : "Renewal reminder"} sent to{" "}
                {result.count} crew — {result.delivered} e-mailed
                {result.delivered < result.count
                  ? `, ${result.count - result.delivered} recorded only (no e-mail / channel off)`
                  : ""}
                . Share their upload links:
              </p>
              <div className="max-h-40 space-y-1 overflow-auto">
                {result.reminders.map((r) => (
                  <div key={r.seafarerId} className="flex flex-wrap items-center gap-1">
                    <span className="font-semibold text-slate-700">{r.name}</span>
                    <a
                      href={`/share/${r.shareToken}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-brand-600 hover:underline"
                    >
                      /share/{r.shareToken}
                    </a>
                    <span
                      className={`text-[11px] ${
                        r.delivered ? "text-emerald-600" : "text-slate-500"
                      }`}
                      title={r.delivery}
                    >
                      · {r.delivered ? "sent" : r.delivery}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Add by link: paste one or more docka share links (or bare tokens) to add the
// EXISTING seamen behind them to this agent's board. Mirrors the public /share
// handshake — token possession forms the seaman-consented access grant. This
// replaced the old free-text "Bulk invite" (which fabricated name-only placeholders
// and could never connect to a real seaman's profile).
const LINK_SKIP_COPY: Record<string, string> = {
  invalid: "not a valid link",
  "not-found": "no seafarer matches this link",
  "view-only": "this is a view-only link",
  forbidden: "this private link isn't shared with your agency",
  withdrawn: "this seafarer withdrew your access",
  "already-added": "already on your board",
};

function InvitePanel({ onInvited }: { onInvited: (created: SeafarerWithDocs[]) => void }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    added: Seafarer[];
    skipped: { input: string; status: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dismiss = useMenuDismiss(open, () => setOpen(false));

  async function send() {
    if (!links.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invite/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const added: Seafarer[] = data.added ?? [];
        setResult({ added, skipped: data.skipped ?? [] });
        // Add the resolved seamen to the board. Docs fill in on the next full load.
        if (added.length > 0) onInvited(added.map((s: Seafarer) => ({ ...s, documents: [] })));
        setLinks("");
      } else {
        setError(data?.error ?? "Couldn't add by link. Please try again.");
      }
    } catch {
      setError("Couldn't add by link. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" {...dismiss}>
      <button
        data-testid="invite-open"
        onClick={() => setOpen((v) => !v)}
        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Add by link
      </button>
      {open && (
        // #S15 — z-30 keeps this popover ABOVE the sticky page header (z-20) so an
        // open dropdown is never visually intersected by the "Docka" header bar.
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
          <p className="text-sm font-semibold text-slate-800">Add crew by link</p>
          <p className="mt-1 text-xs text-slate-500">
            Paste one docka share link or token per line. Each resolves to the
            seafarer who shared it and adds them to your board — they stay in control
            and can withdraw your access at any time.
          </p>
          <textarea
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            rows={4}
            data-testid="invite-names"
            placeholder={"https://docka.me/share/Z5cpz-zTY0Qq\nXy_9ab-QmR2z"}
            className="mt-2 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            onClick={send}
            disabled={busy}
            data-testid="invite-send"
            className="mt-2 w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "Adding…" : "Add by link"}
          </button>

          {error && (
            <p data-testid="invite-error" className="mt-2 text-xs font-medium text-rose-600">
              {error}
            </p>
          )}

          {result && (
            <div className="mt-3 max-h-56 space-y-2 overflow-auto" data-testid="invite-result">
              {result.added.length > 0 && (
                <div className="space-y-1" data-testid="invite-added">
                  <p className="text-xs font-semibold text-emerald-700">
                    Added {result.added.length} to your board
                  </p>
                  {result.added.map((s) => (
                    <div
                      key={s.id}
                      data-testid="invite-link-added"
                      className="rounded-lg bg-emerald-50 px-2 py-1 text-xs text-emerald-800 ring-1 ring-emerald-100"
                    >
                      <span className="font-semibold">{s.name}</span> added
                    </div>
                  ))}
                </div>
              )}
              {result.skipped.length > 0 && (
                <div className="space-y-1" data-testid="invite-skipped">
                  <p className="text-xs font-semibold text-slate-600">
                    Skipped {result.skipped.length}
                  </p>
                  {result.skipped.map((sk, i) => (
                    <div
                      key={`${sk.input}-${i}`}
                      data-testid="invite-link-skipped"
                      data-status={sk.status}
                      className="rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200"
                    >
                      <span className="break-all font-mono text-[11px] text-slate-500">{sk.input}</span>
                      <span className="ml-1 text-amber-700">
                        — {LINK_SKIP_COPY[sk.status] ?? sk.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {result.added.length === 0 && result.skipped.length === 0 && (
                <p className="text-xs text-slate-500">Nothing to add.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Bug1 — "Hidden crew" panel: the seamen this agent has removed from their board.
// Lists them (fetched on open) with a per-row "Restore" that returns them to the
// board and a two-step "Delete" (arm -> confirm) that removes them for good — the
// server decides view-only vs hard delete; `claimed` only picks the confirm copy.
type HiddenCrewRow = SeafarerWithDocs & { claimed?: boolean };

function HiddenCrewPanel({ onRestore }: { onRestore: (s: SeafarerWithDocs) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HiddenCrewRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteInFlight = useRef(false);
  // Click-outside / hover-away close — but never mid-DELETE (the result note must
  // land somewhere).
  const dismiss = useMenuDismiss(open, () => {
    if (deleteInFlight.current) return;
    setOpen(false);
  });

  async function load() {
    setError(null);
    setNote(null);
    setArmedId(null);
    setRows(null);
    try {
      const res = await fetch("/api/seafarers?view=hidden");
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) setRows((data.seafarers ?? []) as HiddenCrewRow[]);
      else setError(data?.error ?? "Couldn't load hidden crew.");
    } catch {
      setError("Couldn't load hidden crew.");
    }
  }

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) void load();
      return next;
    });
  }

  function arm(id: string) {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setArmedId(id);
    setNote(null);
    setError(null);
    disarmTimer.current = setTimeout(() => {
      if (!deleteInFlight.current) setArmedId(null);
    }, 6000);
  }

  function disarm() {
    if (deleteInFlight.current) return; // never disarm mid-request
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setArmedId(null);
  }

  async function confirmDelete(s: HiddenCrewRow) {
    if (deleteInFlight.current) return; // double-submit guard
    deleteInFlight.current = true;
    setDeletingId(s.id);
    setError(null);
    try {
      const res = await fetch(`/api/seafarers?id=${encodeURIComponent(s.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        // Drop the row; the seaman is NOT restored to the board.
        setRows((r) => (r ?? []).filter((x) => x.id !== s.id));
        setNote(
          data.mode === "hard"
            ? "Deleted permanently."
            : "Removed from your view. The profile itself was not deleted."
        );
      } else {
        setError(data?.error ?? "Couldn't delete this seafarer.");
      }
    } catch {
      setError("Couldn't delete this seafarer.");
    } finally {
      deleteInFlight.current = false;
      setDeletingId(null);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      setArmedId(null);
    }
  }

  async function restore(s: SeafarerWithDocs) {
    setBusyId(s.id);
    setError(null);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, restore: true }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setRows((r) => (r ?? []).filter((x) => x.id !== s.id));
        // Carry the (server-authoritative) grant stage/state back onto the board card,
        // keeping the documents we already loaded for the hidden view.
        onRestore({ ...s, ...(data.seafarer ?? {}), documents: s.documents });
      } else {
        setError(data?.error ?? "Couldn't restore this seafarer.");
      }
    } catch {
      setError("Couldn't restore this seafarer.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="relative" {...dismiss}>
      <button
        data-testid="hidden-crew-open"
        onClick={toggle}
        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Hidden crew
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
          <p className="text-sm font-semibold text-slate-800">Hidden crew</p>

          {note && (
            <p data-testid="hidden-crew-note" className="mt-2 text-xs font-medium text-slate-600">
              {note}
            </p>
          )}

          {error && (
            <p data-testid="hidden-crew-error" className="mt-2 text-xs font-medium text-rose-600">
              {error}
            </p>
          )}

          {rows === null && !error && (
            <p className="mt-3 text-xs text-slate-400">Loading…</p>
          )}

          {rows !== null && rows.length === 0 && (
            <p data-testid="hidden-crew-empty" className="mt-3 text-xs text-slate-500">
              No hidden crew.
            </p>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="mt-3 max-h-56 space-y-1 overflow-auto" data-testid="hidden-crew-list">
              {rows.map((s) => (
                <div
                  key={s.id}
                  data-testid="hidden-crew-row"
                  data-name={s.name}
                  className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs ring-1 ring-slate-200"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-700">{s.name}</p>
                    {s.rank ? <p className="truncate text-[11px] text-slate-500">{s.rank}</p> : null}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      data-testid="hidden-crew-restore"
                      disabled={busyId === s.id || deletingId === s.id}
                      onClick={() => void restore(s)}
                      className="rounded-lg bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                    >
                      {busyId === s.id ? "Restoring…" : "Restore"}
                    </button>
                    {armedId === s.id ? (
                      <button
                        type="button"
                        autoFocus
                        data-testid="hidden-crew-delete-confirm"
                        disabled={deletingId === s.id}
                        onClick={() => void confirmDelete(s)}
                        onBlur={disarm}
                        title={
                          s.claimed
                            ? "Removes this profile from your view only"
                            : "Permanent if you created it and no other agency lists it"
                        }
                        className="whitespace-nowrap rounded-lg bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                      >
                        {deletingId === s.id ? "Deleting…" : "Confirm delete?"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="hidden-crew-delete"
                        disabled={busyId === s.id || deletingId !== null}
                        onClick={() => arm(s.id)}
                        className="rounded-lg border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
