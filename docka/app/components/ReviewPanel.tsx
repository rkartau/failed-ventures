"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Comment, Doc, Seafarer, ReviewStatus } from "@/lib/db";
import { STATE_LABELS, nextState, type SeafarerState } from "@/lib/pipeline";
import { docStatusForDoc, docBadgeForDoc, CHECKED_AGAINST_REGISTRY_LABEL, type DocStatus } from "@/lib/cert";
import { type RequiredDocType } from "@/lib/doctypes";
import {
  requiredSetFor,
  requiredCompleteness,
  employmentCompleteness,
  employmentContextFor,
  VESSEL_TYPE_KEYS,
  VESSEL_TYPE_LABELS,
  FLAG_KEYS,
  FLAG_LABELS,
  type RequiredDocsConfig,
} from "@/lib/required-docs";
import {
  assignmentBlockers,
  blockIssues,
  isAssignmentAdvance,
  type AssignmentBlock,
  type BlockIssue,
} from "@/lib/compliance";
import { docNumber, duplicateOthers, type DuplicateNameIndex } from "@/lib/duplicates";
import { AVAILABILITY_VALUES, AVAILABILITY_LABELS, type Availability } from "@/lib/availability";
import { verifiedFirst } from "@/lib/archive";
import type { RestHourEntry } from "@/lib/db";
import { evaluateRestHours, MIN_REST_24H, MIN_REST_7D } from "@/lib/rest-hours";
import { StatusBadge } from "@/components/StatusBadge";
import { DocViewer } from "@/components/DocViewer";
import { RegistryAgentActions } from "@/components/RegistryInfo";
import { rescuedDocDisplay } from "@/lib/registry/prefill";
import { DocImage, DocPlaceholder } from "@/components/DocImage";
import { sampleThumbSrc } from "@/lib/sample-thumbs";
import { CvMatrix } from "@/components/CvMatrix";
import { DocRequestPanel } from "@/components/DocRequestPanel";
import { ProfileApprovals } from "@/components/ProfileApprovals";
import { SeaServiceLedger } from "@/components/SeaServiceLedger";
import { AppraisalPanel } from "@/components/AppraisalPanel";
import { GenerateContractPanel } from "@/components/GenerateContractPanel";
import { PlaceholderClaimPanel } from "@/components/PlaceholderClaimPanel";
import type { DocRequest, ProfileChangeRequest, SeaServiceEntry } from "@/lib/db";
import { claimStateOf } from "@/lib/claim-state";
import { useT } from "@/components/LanguageProvider";

// MEDICAL GATING IS OFF (owner decision D3): there is no medical-reviewer role,
// no health-data redaction, and no lawful-basis note. A medical / fitness
// certificate renders exactly like every other document.

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function isImage(name?: string | null): boolean {
  return !!name && /\.(jpe?g|png|webp|gif|bmp)$/i.test(name);
}

const REVIEW_TONE: Record<ReviewStatus, string> = {
  pending: "bg-slate-100 text-slate-600 ring-slate-200",
  approved: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  rejected: "bg-rose-100 text-rose-800 ring-rose-200",
  reupload: "bg-amber-100 text-amber-800 ring-amber-200",
};
const REVIEW_LABEL: Record<ReviewStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  reupload: "Re-upload requested",
};

export function ReviewPanel({
  seafarer,
  documents,
  agentName,
  duplicates = {},
  initialNotes,
  initialRestHours = [],
  requiredConfig = null,
  initialDocRequests = [],
  initialProfileChanges = [],
  initialSeaService = [],
  profileShared = false,
  requestPending = false,
  assigned = false,
  liveAssignmentId = null,
  readOnly = false,
  fileToken,
  titleAs = "h1",
}: {
  seafarer: Seafarer;
  documents: Doc[];
  agentName: string;
  /** cert-number -> crew entries sharing it (fleet-wide duplicate index). */
  duplicates?: DuplicateNameIndex;
  initialNotes: Comment[];
  initialRestHours?: RestHourEntry[];
  /** Per-agent required-docs config; when null the universal baseline is used. */
  requiredConfig?: RequiredDocsConfig | null;
  /** This agent's document-request checklist for this seafarer (tenant-scoped). */
  initialDocRequests?: DocRequest[];
  /** The seaman's self-service profile-change queue awaiting shore approval (T1.7). */
  initialProfileChanges?: ProfileChangeRequest[];
  /** This seafarer's sea-service ledger (digital discharge book, T2.2). */
  initialSeaService?: SeaServiceEntry[];
  /**
   * #38.5 — the acting agent's personal-profile (contact/CV) overlay already
   * consented by this seaman for this agency. Hides the "request access" control.
   */
  profileShared?: boolean;
  /**
   * #38.5 — this agent already has an undecided profile-access request outstanding
   * for this seaman. Shows the "Request sent" state instead of the button.
   */
  requestPending?: boolean;
  /**
   * #41 — TRUE when THIS agent holds a live assignment for the seaman, so the
   * employment doc-set (SEA/wage/allotment) is in scope for the voyage. Drives the
   * prominent SEA-missing banner. Benched (false) => no banner. Server-derived.
   */
  assigned?: boolean;
  /**
   * DEF-6 — the acting agent's live assignment id (from activeAssignmentsFor),
   * threaded to GenerateContractPanel so the "Assignment id" field is pre-filled.
   * null when no live assignment.
   */
  liveAssignmentId?: string | null;
  /**
   * Public sample review (plan Phase 4): content renders REAL — header,
   * completeness, attention table, doc rows with images/badges/duplicate flags,
   * the doc-request checklist, the notes thread — but every DECISION and editing
   * surface is hidden (accept/send-back, approve/reject, registry actions, the
   * voyage editors, appraisal/contract/ledger/approvals composers, note posting).
   * No session-gated fetch fires.
   */
  readOnly?: boolean;
  /**
   * Heading level of the seafarer-name title (SEO plan v3 C8). The agent dashboard
   * renders it as the page H1 (default); the public /sample/agency page already has
   * its own H1 and passes "h2" so the page keeps a single H1.
   */
  titleAs?: "h1" | "h2";
  /**
   * Share token for the doc-image/file URLs on a session-less render (the public
   * sample review — the flagship's PUBLISHED open token). Omitted on the real
   * agent surface, where the session + grant scope authorises the file reads.
   */
  fileToken?: string;
}) {
  const router = useRouter();
  const { t } = useT();
  const [docs, setDocs] = useState<Doc[]>(documents);
  const [state, setState] = useState<SeafarerState>(seafarer.state);
  const [notes, setNotes] = useState<Comment[]>(initialNotes);
  const [noteText, setNoteText] = useState("");
  // Agent notes thread is COLLAPSED by default so it stays a compact one-line row;
  // the count is shown in the toggle header and clicking reveals the full thread.
  const [notesOpen, setNotesOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Voyage metadata (drives rotation-end readiness + the PSC/MLC dossier).
  const [vessel, setVessel] = useState(seafarer.vessel ?? "");
  const [rotationEnd, setRotationEnd] = useState(
    seafarer.rotationEnd ? seafarer.rotationEnd.slice(0, 10) : ""
  );
  // Vessel type + flag drive the vessel/flag add-on layer of the required-docs
  // matrix — a chemical-tanker berth requires certs a general-cargo berth doesn't.
  const [vesselType, setVesselType] = useState(seafarer.vesselType ?? "");
  const [flagState, setFlagState] = useState(seafarer.flagState ?? "");
  // Agent override of the seaman's rank + availability (grant-scoped save; direct,
  // no shore-approval gate). Rank stays the authoritative required-docs driver.
  const [rankDraft, setRankDraft] = useState(seafarer.rank ?? "");
  const [availSel, setAvailSel] = useState<"" | Availability>(seafarer.availability ?? "");
  const [availFrom, setAvailFrom] = useState(seafarer.availableFrom ?? "");
  const [restHours, setRestHours] = useState<RestHourEntry[]>(initialRestHours);
  // Assignment hard block state (mirrors the server rule). Tracks the target
  // state we were trying to reach so an override advances to the right stage.
  const [seaBlock, setSeaBlock] = useState<AssignmentBlock | null>(null);
  const [blockTarget, setBlockTarget] = useState<SeafarerState | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  // CV / certificate matrix modal. Built from `docs` (already grant-scoped by the
  // server page load), so no seafarer data leaves the fail-closed guard.
  const [showCv, setShowCv] = useState(false);
  // #38.5 — local "request sent" latch so the button flips to the sent state without
  // a reload after a successful POST (the server-derived `requestPending` covers the
  // reload / already-pending case).
  const [requestSent, setRequestSent] = useState(false);
  // C3 — transient "Link copied" feedback for the no-email copy-link fallback.
  const [linkCopied, setLinkCopied] = useState(false);
  // F2 — surface a prior NEGATIVE appraisal ("Do not re-hire" / "Conditional") right
  // at the decision point, so a career-relevant flag is not buried in the appraisal
  // history far below the Accept button. Read-only, grant-scoped by the same route the
  // AppraisalPanel uses.
  const [priorAppraisal, setPriorAppraisal] = useState<
    { recommend: "no" | "conditional"; vessel: string | null; createdAt: string } | null
  >(null);
  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (readOnly) return; // sample render: session-gated fetch would only 401
    let live = true;
    (async () => {
      const res = await fetch(`/api/appraisals?seafarerId=${encodeURIComponent(seafarer.id)}`);
      const data = await res.json().catch(() => ({}));
      if (!live || !data?.ok || !Array.isArray(data.appraisals)) return;
      const negatives = (data.appraisals as Array<{ recommend?: string; vessel?: string | null; createdAt?: string }>)
        .filter((a) => a.recommend === "no" || a.recommend === "conditional");
      if (negatives.length === 0) return;
      // Strongest signal first ("no" over "conditional"), then most recent.
      negatives.sort((a, b) => {
        const rank = (r?: string) => (r === "no" ? 0 : 1);
        return rank(a.recommend) - rank(b.recommend) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
      const top = negatives[0];
      setPriorAppraisal({
        recommend: top.recommend === "no" ? "no" : "conditional",
        vessel: top.vessel ?? null,
        createdAt: top.createdAt ?? "",
      });
    })();
    return () => {
      live = false;
    };
  }, [seafarer.id, readOnly]);

  const restReport = useMemo(() => evaluateRestHours(restHours), [restHours]);

  // Config-driven required set for THIS seafarer's rank (single rank source of
  // truth = the profile rank). Drives completeness, the missing-slot list, and the
  // assignment hard-block — all against the agent's configured requirements.
  const req = useMemo(
    () =>
      requiredSetFor({
        rank: seafarer.rank,
        config: requiredConfig,
        vesselType: seafarer.vesselType,
        flag: seafarer.flagState,
      }),
    [seafarer.rank, seafarer.vesselType, seafarer.flagState, requiredConfig]
  );

  const c = useMemo(
    () => requiredCompleteness(docs.map((d) => d.requiredType), req),
    [docs, req]
  );

  // #41 — assignment-scoped employment doc-set (SEA/wage/allotment), off the SAME
  // shared read-model the board column + CSV use. Benched => applicable:false (no
  // banner). CBA fields are carried through even while benched (self-declared cover).
  const employment = useMemo(
    () =>
      employmentCompleteness(
        docs.map((d) => d.requiredType),
        docs,
        employmentContextFor(seafarer),
        { assigned }
      ),
    [docs, seafarer, assigned]
  );
  // The SEA attention state for the prominent banner: missing / expired / unknown
  // (present but no end date). null => banner not shown (in-date SEA, or benched).
  const seaBannerState: "missing" | "expired" | "unknown" | null = employment.applicable
    ? employment.missing.includes("SEA")
      ? "missing"
      : employment.expired.includes("SEA")
        ? "expired"
        : employment.unknownExpiry.includes("SEA")
          ? "unknown"
          : null
    : null;

  // Live, always-on compliance read for the "Attention needed" summary at the top
  // of the review. Same rule the assignment hard-block uses, so what the agent sees
  // matches what the server will enforce. Flattened + DEDUPLICATED into one row per
  // (issue, document) so a duplicated document is never listed twice.
  const liveIssues = useMemo<BlockIssue[]>(
    () =>
      blockIssues(
        assignmentBlockers(docs, {
          duplicates,
          ownName: seafarer.name,
          rotationEnd: seafarer.rotationEnd ?? null,
          required: req.required,
          holderDOB: seafarer.birthDate ?? null,
          seaServiceEntries: initialSeaService,
        })
      ),
    [docs, duplicates, seafarer.name, seafarer.rotationEnd, req, initialSeaService]
  );

  // Group documents by REQUIRED slot for the "who is missing what" view. Only the
  // slots in the required set are shown as required; a document that fills a
  // non-required slot goes under "Other documents".
  const bySlot = useMemo(() => {
    const map = new Map<RequiredDocType, Doc[]>();
    const requiredSet = new Set<RequiredDocType>(req.required);
    for (const rt of req.required) map.set(rt, []);
    const extra: Doc[] = [];
    for (const d of docs) {
      if (d.requiredType && requiredSet.has(d.requiredType)) map.get(d.requiredType)!.push(d);
      else extra.push(d);
    }
    // Government-verified documents rank FIRST within each required slot and within
    // the "Other documents" group; the rest keep their existing order.
    for (const rt of req.required) map.set(rt, verifiedFirst(map.get(rt)!));
    return { map, extra: verifiedFirst(extra) };
  }, [docs, req]);

  // F8 — SOFT advisory (never a gate): required slots that are FILLED, but only
  // by documents that were never registry-verified (no holder-bound government
  // verification and no registry-confirmed presence). Priya's ask: surface
  // "document on file is not registry-verified" beside the block modal and the
  // attention list — advisory wording only, ZERO change to the gating logic.
  const unverifiedRequiredSlots = useMemo(
    () =>
      [...req.required].filter((rt) => {
        const slotDocs = bySlot.map.get(rt) ?? [];
        return (
          slotDocs.length > 0 &&
          !slotDocs.some((d) => d.source === "government" || d.source === "registry")
        );
      }),
    [req, bySlot]
  );

  async function reviewDoc(documentId: string, action: string, reason?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId, action, reason }),
      });
      const data = await res.json();
      if (data.ok) {
        setDocs((prev) => prev.map((d) => (d.id === documentId ? data.document : d)));
      } else {
        setBanner(data.error ?? "Could not update the document.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function moveState(to: SeafarerState, note?: string, override?: { reason: string }) {
    // Assignment hard block: refuse to advance a non-compliant man into an
    // assignment state ("Accepted"/"Sent to sea") unless a documented override is
    // supplied. Mirror of the server rule for instant UX.
    if (!override && isAssignmentAdvance(state, to)) {
      const b = assignmentBlockers(docs, {
        duplicates,
        ownName: seafarer.name,
        rotationEnd: seafarer.rotationEnd ?? null,
        required: req.required,
        holderDOB: seafarer.birthDate ?? null,
      });
      if (b.blocked) {
        setSeaBlock(b);
        setBlockTarget(to);
        return;
      }
    }
    setBusy(true);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          override
            ? { id: seafarer.id, state: to, override: true, overrideReason: override.reason }
            : { id: seafarer.id, state: to }
        ),
      });
      if (res.ok) {
        setState(to);
        setSeaBlock(null);
        setBlockTarget(null);
        setOverrideReason("");
        if (note) await postNote(note);
        setBanner(`Seafarer moved to “${STATE_LABELS[to]}”.`);
        router.refresh();
      } else if (res.status === 409) {
        const data = await res.json().catch(() => null);
        if (data?.blockers) {
          setSeaBlock(data.blockers);
          setBlockTarget(to);
        }
      } else {
        setBanner("Could not move the seafarer.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Persist voyage metadata (vessel / rotation end). rotationEnd feeds the
  // sea-readiness gate: a cert lapsing before it blocks the assignment.
  async function saveVoyage(next: {
    vessel?: string;
    rotationEnd?: string;
    vesselType?: string;
    flagState?: string;
  }) {
    setBusy(true);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, ...next }),
      });
      if (res.ok) {
        setBanner("Voyage details saved.");
        router.refresh();
      } else {
        setBanner("Could not save voyage details.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Agent override of rank (grant-scoped; the signed-in agent's grant authorises the
  // write server-side). Saves on blur only when the value changed.
  async function saveRank() {
    if (rankDraft.trim() === (seafarer.rank ?? "")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, rank: rankDraft.trim() }),
      });
      if (res.ok) {
        setBanner("Rank saved.");
        router.refresh();
      } else {
        setBanner("Could not save rank.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Agent override of availability (grant-scoped). availableFrom is sent only for
  // open_from; open/occupied clear it server-side.
  async function saveAvailability(availability: Availability, availableFrom?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarer.id, availability, availableFrom: availableFrom ?? null }),
      });
      if (res.ok) {
        setBanner("Availability saved.");
        router.refresh();
      } else {
        setBanner("Could not save availability.");
      }
    } finally {
      setBusy(false);
    }
  }
  function onAvailabilityChange(v: "" | Availability) {
    setAvailSel(v);
    if (v === "open" || v === "occupied") void saveAvailability(v);
    else if (v === "open_from" && availFrom) void saveAvailability("open_from", availFrom);
  }
  function onAvailFromChange(v: string) {
    setAvailFrom(v);
    if (availSel === "open_from" && v) void saveAvailability("open_from", v);
  }

  async function logRestHours(date: string, hoursRest: number) {
    const res = await fetch("/api/rest-hours", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seafarerId: seafarer.id, date, hoursRest }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok && data.entries) setRestHours(data.entries);
  }

  // #38.5 — agent-side ASYNC "request profile access": ping the seaman to consent to
  // the personal-profile (contact/CV) overlay later. This writes NO grant/flag — it
  // only raises a pending request the seaman approves or declines. Tenant isolation is
  // enforced server-side: the route requires this agent's own live grant on the
  // seafarer, and the seafarerId is the only body field (the acting agentId comes from
  // the session, never the client).
  async function requestProfileAccess() {
    setBusy(true);
    try {
      const res = await fetch("/api/access/propagation/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId: seafarer.id, bucket: "contact" }),
      });
      const data = await res.json();
      if (data.ok) setRequestSent(true);
      else setBanner(data.error ?? "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  // C3 — copy the open upload/share link so "Request profile access" can never silently
  // no-op for a seaman with no email on file (the propagation ping only fires on ownerEmail).
  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/share/${seafarer.shareToken}`);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the "Open public share view" link stays as a manual fallback */
    }
  }

  async function postNote(text: string) {
    const res = await fetch("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seafarerId: seafarer.id, authorName: agentName, text }),
    });
    const data = await res.json();
    if (data.ok) setNotes((prev) => [...prev, data.comment]);
  }

  async function submitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteText.trim()) return;
    await postNote(noteText.trim());
    setNoteText("");
  }

  const next = nextState(state);
  const atEnd = next === state;

  // C3 — a usable contact email is EITHER a claimed owner's confirmed address OR an
  // agent-typed imported address. Without one the propagation ping can't fire, so the
  // "Request profile access" button would silently no-op; we guard it below.
  const hasContactEmail = !!((seafarer.ownerEmail ?? "").trim() || (seafarer.importedEmail ?? "").trim());
  // Placeholder gating is a REAL-agent concern only; the sample review is readOnly and a
  // legacy-unowned row is NOT a placeholder (renders the full profile). When true, the
  // voyage / sea-service / appraisal sections are replaced by PlaceholderClaimPanel.
  const claim = claimStateOf(seafarer);
  const isPlaceholder = !readOnly && claim.kind === "placeholder";

  // Render one document row with the fleet-wide duplicate-number flag. Medical
  // gating is OFF: every document renders in full.
  function renderDocRow(d: Doc, slot: RequiredDocType | null) {
    return (
      <DocReviewRow
        key={d.id}
        doc={d}
        slot={slot}
        busy={busy}
        onReview={reviewDoc}
        onUpdate={(u) => setDocs((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
        reviewerName={agentName}
        duplicateWith={duplicateOthers(d, duplicates, seafarer.name)}
        seafarer={seafarer}
        allDocs={docs}
        readOnly={readOnly}
        fileToken={fileToken}
      />
    );
  }

  return (
    <div className="mt-4" data-testid="review-panel" data-hydrated={hydrated ? "true" : "false"}>
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Agent review
            </p>
            {titleAs === "h2" ? (
              <h2 className="text-2xl font-bold text-slate-900">{seafarer.name}</h2>
            ) : (
              <h1 className="text-2xl font-bold text-slate-900">{seafarer.name}</h1>
            )}
            <p className="text-sm text-slate-500">{seafarer.rank || "—"}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              Stage: {STATE_LABELS[state]}
            </span>
            <span
              data-testid="completeness"
              className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                c.missing.length === 0
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-amber-50 text-amber-700 ring-amber-200"
              }`}
            >
              {c.count}/{c.total}
              {c.missing.length > 0 ? ` — missing ${c.missing.join(", ")}` : " — complete"}
            </span>
            {/* #41 item 15 — CBA cover is SELF-DECLARED, never verified. Amber (not the
                emerald reserved for government verification); the free-text cbaRef is
                shown explicitly as a claim, so it can't read as an authority-confirmed fact. */}
            {employment.cbaCovered && (
              <span
                data-testid="cba-claimed-chip"
                title="Collective Bargaining Agreement cover is self-declared by the seafarer/agency — not verified against a registry."
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                CBA: claimed (self-declared)
                {employment.cbaRef ? ` · ref ${employment.cbaRef} (claimed)` : ""}
              </span>
            )}
          </div>
        </div>

        {/* #41 — PROMINENT SEA banner for an ASSIGNED seaman whose SEA is missing /
            expired / has an unknown expiry. Not a buried chip: full-width, coloured
            block at the top of the review. Benched crew never see it (seaBannerState null). */}
        {seaBannerState && (
          <div
            data-testid="sea-missing-banner"
            data-sea-state={seaBannerState}
            className={`mt-4 flex items-start gap-3 rounded-xl border p-4 ${
              seaBannerState === "unknown"
                ? "border-amber-300 bg-amber-50"
                : "border-rose-300 bg-rose-50"
            }`}
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                seaBannerState === "unknown"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-rose-100 text-rose-700"
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <div className="min-w-0">
              <p
                className={`text-sm font-bold ${
                  seaBannerState === "unknown" ? "text-amber-900" : "text-rose-900"
                }`}
              >
                {seaBannerState === "missing"
                  ? "SEA missing for active voyage"
                  : seaBannerState === "expired"
                    ? "SEA expired"
                    : "SEA expiry unknown — reconfirm"}
              </p>
              <p
                className={`mt-0.5 text-xs ${
                  seaBannerState === "unknown" ? "text-amber-700" : "text-rose-700"
                }`}
              >
                {seaBannerState === "missing"
                  ? "This seafarer is assigned to a voyage but has no Seafarer's Employment Agreement (MLC A2.1) on file. Collect it before departure."
                  : seaBannerState === "expired"
                    ? "The SEA on file has lapsed for this voyage. A current SEA is required for the assignment."
                    : "The SEA is on file but its end date is not recorded. Reconfirm the SEA validity for this voyage — a null date is never treated as current."}
              </p>
            </div>
          </div>
        )}

        {/* F2 — prior negative appraisal flag, shown at the decision point (next to
            Accept), not only in the history list far below. */}
        {priorAppraisal && (
          <div
            data-testid="prior-appraisal-warning"
            data-recommend={priorAppraisal.recommend}
            className={`mt-4 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${
              priorAppraisal.recommend === "no"
                ? "border-rose-300 bg-rose-50 text-rose-800"
                : "border-amber-300 bg-amber-50 text-amber-800"
            }`}
          >
            <span aria-hidden="true">⚠</span>
            <span>
              Prior: {priorAppraisal.recommend === "no" ? "Do not re-hire" : "Conditional"}
              {(priorAppraisal.vessel || priorAppraisal.createdAt) && (
                <span className="font-medium">
                  {" "}(
                  {[priorAppraisal.vessel, fmtDate(priorAppraisal.createdAt)].filter(Boolean).join(", ")}
                  )
                </span>
              )}
            </span>
          </div>
        )}

        {/* Overall actions — decision buttons hidden on the read-only sample review. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {!atEnd && !readOnly && (
            <button
              data-testid="accept-seafarer"
              disabled={busy}
              onClick={() => moveState(next, `Accepted — advanced to ${STATE_LABELS[next]}.`)}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              Accept → {STATE_LABELS[next]}
            </button>
          )}
          {!readOnly && (
            <button
              data-testid="send-back"
              disabled={busy}
              onClick={() => moveState("review", "Sent back to seafarer for corrections.")}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Send back to seafarer
            </button>
          )}
          <a
            href={`/share/${seafarer.shareToken}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Open public share view
          </a>
          <button
            type="button"
            data-testid="open-cv"
            onClick={() => setShowCv(true)}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            CV / certificate matrix
          </button>
          {/* #38.5 — agent-side "request profile access". Shown only when this agency
              has NOT been granted the personal-profile overlay and no request is
              outstanding; onboarding an unreachable seaman, the agent pings them to
              consent later. It grants nothing until the seaman approves. */}
          {!readOnly &&
            !profileShared &&
            (requestPending || requestSent ? (
              <span
                data-testid="request-profile-access-sent"
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Requested — awaiting seafarer approval
              </span>
            ) : !hasContactEmail ? (
              // C3 — no ownerEmail AND no importedEmail: the request would silently
              // no-op (nothing to ping). Disable + relabel, and surface a copy-link so
              // the agent can still hand the seaman their upload card directly.
              <div className="inline-flex flex-wrap items-center gap-2" data-testid="request-profile-access-no-email">
                <button
                  type="button"
                  data-testid="request-profile-access"
                  data-disabled-reason="no-contact-email"
                  disabled
                  title="This seafarer has no email on file. Add one first, or copy the upload link and share it directly."
                  className="cursor-not-allowed rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-400"
                >
                  Add an email first
                </button>
                <button
                  type="button"
                  data-testid="copy-upload-link"
                  onClick={copyShareLink}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {linkCopied ? "Link copied" : "Copy upload link"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="request-profile-access"
                disabled={busy}
                onClick={requestProfileAccess}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Request profile access
              </button>
            ))}
        </div>
        {/* #S18 — microcopy so the agent knows this only ASKS; nothing is granted until
            the seafarer approves, and the request is logged. Hidden when there's no
            contact email (C3): the button is disabled there, so the "sends a request"
            copy would be misleading. */}
        {!readOnly && !profileShared && hasContactEmail && (
          <p className="mt-1.5 text-xs text-slate-500" data-testid="request-profile-access-note">
            Sends a request — the agency gets access only after the seafarer approves. This is logged.
          </p>
        )}
        {showCv && (
          <CvMatrix seafarer={seafarer} documents={docs} onClose={() => setShowCv(false)} />
        )}
        {banner && (
          <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800" data-testid="review-banner">
            {banner}
          </p>
        )}

        {/* Attention needed — a deduped, scannable summary of every compliance
            problem. When there is nothing to fix it collapses to a small green
            line, so an empty red box is never shown. */}
        {liveIssues.length > 0 ? (
          <section
            data-testid="attention-needed"
            className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3"
          >
            <p className="text-sm font-bold text-rose-800">{t("review.attention")}</p>
            <div className="mt-2">
              <AttentionTable issues={liveIssues} />
            </div>
          </section>
        ) : (
          <p
            data-testid="attention-none"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t("review.noIssues")}
          </p>
        )}

        {/* F8 — soft verification advisory beside the attention list: filled
            required slots whose document was never registry-verified. Advisory
            only, never a blocker — the gate logic is untouched. */}
        {unverifiedRequiredSlots.length > 0 && (
          <div
            data-testid="verify-advisory"
            className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"
          >
            <p className="font-semibold text-slate-500">Advisory — not blocking</p>
            <ul className="mt-1 space-y-0.5">
              {unverifiedRequiredSlots.map((rt) => (
                <li key={rt} data-testid="verify-advisory-row">
                  {rt}: document on file is not registry-verified.
                </li>
              ))}
            </ul>
          </div>
        )}

        {seaBlock && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3" data-testid="review-sea-block">
            <p className="text-sm font-bold text-rose-800">
              Blocked — not sea-ready{blockTarget ? ` for “${STATE_LABELS[blockTarget]}”` : ""}
            </p>
            <p className="mt-1 text-xs text-rose-700">
              Resolve the items in “{t("review.attention")}” above, or record a documented reason to override.
            </p>
            {/* F8 — same soft advisory inside the block modal: what is on file
                but never registry-verified. Advisory only, not a blocker. */}
            {unverifiedRequiredSlots.length > 0 && (
              <div
                data-testid="verify-advisory-block"
                className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"
              >
                <p className="font-semibold text-slate-500">Also worth knowing (not blocking):</p>
                <ul className="mt-1 space-y-0.5">
                  {unverifiedRequiredSlots.map((rt) => (
                    <li key={rt}>{rt}: document on file is not registry-verified.</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-3 space-y-2">
              <label className="text-xs font-medium text-slate-600">
                To assign anyway, record a documented reason (kept in the audit trail):
              </label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={2}
                data-testid="review-override-reason"
                placeholder="e.g. Endorsement confirmed by flag state by phone, ref #…"
                className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setSeaBlock(null); setBlockTarget(null); setOverrideReason(""); }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  Keep in yard
                </button>
                <button
                  type="button"
                  data-testid="review-override-confirm"
                  disabled={busy || !overrideReason.trim() || !blockTarget}
                  onClick={() => {
                    const target = blockTarget ?? "accepted";
                    moveState(target, `Override — advanced to ${STATE_LABELS[target]}. Reason: ${overrideReason.trim()}`, {
                      reason: overrideReason.trim(),
                    });
                  }}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  {busy ? "Saving…" : `Override & advance${blockTarget ? ` to ${STATE_LABELS[blockTarget]}` : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Document-request checklist — the collect-from-seaman loop. Seeded with the
          still-missing required slots so a request is one tap; each item auto-clears
          when the matching upload lands. */}
      <DocRequestPanel
        seafarerId={seafarer.id}
        initialRequests={initialDocRequests}
        requiredSlots={[...req.required]}
        missingSlots={c.missing}
        docs={docs}
        readOnly={readOnly}
      />

      {/* Seaman self-service profile changes awaiting shore approval (T1.7). Approve
          writes the value to the live profile; reject leaves it untouched. An
          approve/reject surface — hidden on the read-only sample review. */}
      {!readOnly && (
        <ProfileApprovals seafarerId={seafarer.id} initialChanges={initialProfileChanges} />
      )}

      {/* Unclaimed roster placeholder: the voyage / sea-service / appraisal tools are
          irrelevant until a seaman claims the profile. Replace them with the claim panel
          (copy / refresh link, add e-mail, send invite). Legacy-unowned + sample rows are
          NOT placeholders and keep the full surface. */}
      {isPlaceholder && (
        <PlaceholderClaimPanel
          seafarerId={seafarer.id}
          token={seafarer.shareToken}
          initialClaim={claim as Extract<typeof claim, { kind: "placeholder" }>}
          initialEmail={seafarer.importedEmail ?? null}
          onChanged={() => router.refresh()}
        />
      )}

      {/* Voyage / PSC-MLC panel: vessel, end-of-rotation, rest-hours, dossier.
          Pure editing surface (every field saves on blur) + session-gated dossier
          link — hidden on the read-only sample review + unclaimed placeholders. */}
      {!readOnly && !isPlaceholder && (
      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="voyage-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            Voyage &amp; inspection
          </h2>
          <a
            href={`/agent/inspection?seafarerId=${seafarer.id}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="crew-dossier-link"
            className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
          >
            Open PSC/MLC dossier
          </a>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-600">
            Rank / position (drives the required-documents set)
            <input
              value={rankDraft}
              onChange={(e) => setRankDraft(e.target.value)}
              onBlur={saveRank}
              data-testid="rank-override-input"
              placeholder="e.g. Chief Officer"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Availability (seaman-declared; you can override)
            <select
              value={availSel}
              onChange={(e) => onAvailabilityChange(e.target.value as "" | Availability)}
              data-testid="availability-override-select"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Not set</option>
              {AVAILABILITY_VALUES.map((a) => (
                <option key={a} value={a}>
                  {AVAILABILITY_LABELS[a]}
                </option>
              ))}
            </select>
            {availSel === "open_from" && (
              <input
                type="date"
                value={availFrom}
                onChange={(e) => onAvailFromChange(e.target.value)}
                data-testid="availability-override-from"
                aria-label="Available from date"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            )}
          </label>
          <label className="text-xs font-medium text-slate-600">
            Vessel
            <input
              value={vessel}
              onChange={(e) => setVessel(e.target.value)}
              onBlur={() => { if ((seafarer.vessel ?? "") !== vessel) void saveVoyage({ vessel }); }}
              data-testid="vessel-input"
              placeholder="e.g. MV Baltic Trader"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Rotation end date (validity is checked to this date, not just today)
            <input
              type="date"
              value={rotationEnd}
              onChange={(e) => setRotationEnd(e.target.value)}
              onBlur={() => {
                const cur = seafarer.rotationEnd ? seafarer.rotationEnd.slice(0, 10) : "";
                if (cur !== rotationEnd) void saveVoyage({ rotationEnd });
              }}
              data-testid="rotation-end-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Vessel type (adds vessel-specific required documents)
            <select
              value={vesselType}
              onChange={(e) => {
                const v = e.target.value;
                setVesselType(v);
                if ((seafarer.vesselType ?? "") !== v) void saveVoyage({ vesselType: v });
              }}
              data-testid="vessel-type-input"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Not set</option>
              {VESSEL_TYPE_KEYS.filter((k) => k !== "other").map((k) => (
                <option key={k} value={k}>
                  {VESSEL_TYPE_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Flag state / registry
            <select
              value={flagState}
              onChange={(e) => {
                const v = e.target.value;
                setFlagState(v);
                if ((seafarer.flagState ?? "") !== v) void saveVoyage({ flagState: v });
              }}
              data-testid="flag-state-input"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              <option value="">Not set</option>
              {FLAG_KEYS.filter((k) => k !== "other").map((k) => (
                <option key={k} value={k}>
                  {FLAG_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* STCW/MLC rest-hours */}
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Rest hours (STCW/MLC 2006 — min {MIN_REST_24H}h/24h, {MIN_REST_7D}h/7d)
            </h3>
            <span
              data-testid="rest-hours-summary"
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
                restReport.violationCount === 0
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-rose-50 text-rose-700 ring-rose-200"
              }`}
            >
              {restReport.entryCount === 0
                ? "No rest hours logged"
                : restReport.violationCount === 0
                  ? `Compliant · ${restReport.entryCount} days logged`
                  : `${restReport.violationCount} ILO violation(s)`}
            </span>
          </div>

          <RestHourLogger busy={busy} onLog={logRestHours} />

          {restReport.days.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-xs" data-testid="rest-hours-table">
                <thead>
                  <tr className="text-slate-400">
                    <th className="py-1 pr-3 font-semibold">Date</th>
                    <th className="py-1 pr-3 font-semibold">Rest (24h)</th>
                    <th className="py-1 pr-3 font-semibold">Rest (7d)</th>
                    <th className="py-1 font-semibold">ILO status</th>
                  </tr>
                </thead>
                <tbody>
                  {restReport.days.map((d) => (
                    <tr
                      key={d.date}
                      data-violation={d.violations.length > 0 ? "true" : "false"}
                      className={d.violations.length > 0 ? "bg-rose-50" : ""}
                    >
                      <td className="py-1 pr-3 font-mono text-slate-700">{d.date}</td>
                      <td className={`py-1 pr-3 ${d.hoursRest < MIN_REST_24H ? "font-bold text-rose-700" : "text-slate-700"}`}>
                        {d.hoursRest}h
                      </td>
                      <td className="py-1 pr-3 text-slate-700">{d.daysIn7dWindow >= 7 ? `${d.rest7d}h` : "—"}</td>
                      <td className="py-1">
                        {d.violations.length === 0 ? (
                          <span className="text-emerald-600">OK</span>
                        ) : (
                          <span className="font-semibold text-rose-700">{d.violations.join("; ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Sea-service ledger — the digital discharge book. Agent-maintained here (no
          token: the signed-in agent's grant authorises writes); accumulated sea time
          + the 5-year revalidation window are computed server-side. Skipped on the
          read-only sample review (it is an editing surface; the flagship's ledger
          renders in full on /sample/seafarer). */}
      {!readOnly && !isPlaceholder && (
        <SeaServiceLedger
          seafarerId={seafarer.id}
          initialEntries={initialSeaService}
          documents={docs}
          holderDOB={seafarer.birthDate ?? null}
        />
      )}

      {/* #43 Appraisal scorecards + re-hire summary (agency-authored, tenant-scoped).
          Compose surface with a session-gated load — hidden on the sample review. */}
      {!readOnly && !isPlaceholder && (
        <div className="mt-6">
          <AppraisalPanel seafarerId={seafarer.id} prefill={{ vessel: seafarer.vessel ?? null }} />
        </div>
      )}

      {/* #45 Generate a DRAFT/unsigned SEA from the issued employment terms.
          Compose surface — hidden on the sample review. */}
      {!readOnly && (
        <div className="mt-4">
          <GenerateContractPanel
            seafarerId={seafarer.id}
            defaultPosition={seafarer.rank ?? ""}
            vessel={seafarer.vessel ?? null}
            assignmentId={liveAssignmentId ?? undefined}
          />
        </div>
      )}

      {/* Required documents */}
      <h2 className="mt-6 text-sm font-bold uppercase tracking-wide text-slate-500">
        Required documents
      </h2>
      <div className="mt-2 space-y-3">
        {!(seafarer.rank ?? "").trim() && (
          <div
            data-testid="rank-hint"
            className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500"
          >
            No rank set — add one to tailor the required documents (optional).
          </div>
        )}
        {req.required.map((rt) => {
          const slotDocs = bySlot.map.get(rt)!;
          if (slotDocs.length === 0) {
            return (
              <div
                key={rt}
                data-testid="doc-row"
                data-title={rt}
                data-missing="true"
                className="flex items-center justify-between rounded-xl border border-dashed border-rose-200 bg-rose-50/50 px-4 py-3"
              >
                <span className="text-sm font-semibold text-slate-700">{rt}</span>
                <StatusBadge status="expired" label="MISSING" />
              </div>
            );
          }
          return slotDocs.map((d) => renderDocRow(d, rt));
        })}
      </div>

      {/* Extra documents that fill no required slot */}
      {bySlot.extra.length > 0 && (
        <>
          <h2 className="mt-6 text-sm font-bold uppercase tracking-wide text-slate-500">
            Other documents
          </h2>
          <div className="mt-2 space-y-3">
            {bySlot.extra.map((d) => renderDocRow(d, null))}
          </div>
        </>
      )}

      {/* Agent notes thread — collapsed by default; the toggle row shows the count
          so the notes take no room until the agent opens them. */}
      <button
        type="button"
        onClick={() => setNotesOpen((v) => !v)}
        aria-expanded={notesOpen}
        data-testid="notes-toggle"
        className="mt-6 flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Agent notes ({notes.length})
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-slate-400 transition-transform ${notesOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {notesOpen && (
      <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-4">
        <ul className="space-y-2">
          {notes.length === 0 && (
            <li className="text-sm text-slate-400">No notes yet. Add the first note below.</li>
          )}
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">{n.authorName}</span>
                <span className="text-xs text-slate-400">{fmtDate(n.createdAt)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">{n.text}</p>
            </li>
          ))}
        </ul>
        {!readOnly && (
        <form onSubmit={submitNote} className="mt-3 flex flex-col gap-2">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={2}
            data-testid="note-input"
            placeholder="Add a note for your team…"
            className="w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="note-submit"
              disabled={!noteText.trim()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Post note
            </button>
          </div>
        </form>
        )}
      </div>
      )}
    </div>
  );
}

// Compact, scannable table of the deduped compliance issues. Subtle severity tint:
// red for hard failures (expired / missing), amber for warnings (mid-rotation
// lapse, possible duplicate). Small text — never a wall of run-on red.
function AttentionTable({ issues }: { issues: BlockIssue[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-left text-xs" data-testid="attention-table">
        <thead>
          <tr className="text-slate-500">
            <th className="py-1 pr-3 font-semibold">Issue</th>
            <th className="py-1 pr-3 font-semibold">Document</th>
            <th className="py-1 font-semibold">Detail</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i, idx) => (
            <tr
              key={`${i.kind}-${i.document}-${idx}`}
              data-testid="attention-row"
              data-issue-kind={i.kind}
              className={i.severity === "red" ? "bg-rose-100/40" : "bg-amber-100/40"}
            >
              <td className="py-1 pr-3 align-top">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
                    i.severity === "red"
                      ? "bg-rose-100 text-rose-800 ring-rose-200"
                      : "bg-amber-100 text-amber-800 ring-amber-200"
                  }`}
                >
                  {i.issue}
                </span>
              </td>
              <td className="py-1 pr-3 align-top font-semibold text-slate-800">{i.document}</td>
              <td className="py-1 align-top text-slate-600">{i.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sourceBadge(doc: Doc, status: DocStatus) {
  // The emerald "VERIFIED" state is RESERVED for government-registry-verified
  // documents. A government doc is the ONLY source that earns it; everything else
  // is shown as honestly-not-verified so an unverified paper/photo can never be
  // mistaken for an authority-confirmed credential.
  if (doc.source === "government") {
    if (status === "expired") return <StatusBadge status="expired" label="EXPIRED" />;
    return <StatusBadge status={status === "unknown" ? "valid" : status} label="VERIFIED" />;
  }
  if (doc.source === "photo") {
    if (status === "expired") return <StatusBadge status="expired" label="Expired — from photo" />;
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Read from photo — not verified
      </span>
    );
  }
  // Registry / manual / plain document: NOT holder-verified, so it must never
  // show a green "Valid". Use the single honest, source-aware badge — teal
  // "Registry-confirmed — holder not verified" for source:"registry" (expiry
  // warning outranks the teal), violet "Verification requested" for an open
  // manual request, blue "Checked against registry" for a portal sign-off,
  // neutral "Not verified" for a future date, amber/rose for expiring/expired
  // — the same rule the seafarer and share views already apply via docBadge.
  const b = docBadgeForDoc({
    verified: false,
    validUntil: doc.validUntil,
    expiryConfirmed: doc.expiryConfirmed,
    source: doc.source,
    checkedVia: doc.reviewerChecked ? doc.checkedVia : null,
    manualRequested: doc.manualVerification?.status === "requested",
    noExpiry: doc.noExpiry,
  });
  return <StatusBadge status={b.status} label={b.label} />;
}

function DocReviewRow({
  doc,
  slot,
  busy,
  onReview,
  onUpdate,
  reviewerName = "",
  duplicateWith = [],
  seafarer,
  allDocs,
  readOnly = false,
  fileToken,
}: {
  doc: Doc;
  slot: RequiredDocType | null;
  busy: boolean;
  onReview: (documentId: string, action: string, reason?: string) => void;
  onUpdate?: (d: Doc) => void;
  reviewerName?: string;
  duplicateWith?: string[];
  /** Owner profile — feeds the §5.3 registry-check prefill fallback chain. */
  seafarer?: Seafarer;
  /** All docs of this seafarer — source of a structured name split (vr2 item 2). */
  allDocs?: Doc[];
  /** Sample review: no approve/reject/registry actions; view-only doc viewer. */
  readOnly?: boolean;
  /** Token-authorised file URLs for the session-less sample render. */
  fileToken?: string;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [viewerOpen, setViewerOpen] = useState(false);
  const status = docStatusForDoc(doc);
  // F10f (Giorgos) — sourceBadge already renders the blue "Checked against
  // registry"/"Checked by reviewer" pill when docBadge resolves to "checked";
  // the standalone reviewer-checked pill below must not repeat it. It stays
  // for sources whose primary pill says something else (photo, expired, teal).
  const primaryBadgeShowsChecked =
    doc.source !== "government" &&
    doc.source !== "photo" &&
    docBadgeForDoc({
      verified: false,
      validUntil: doc.validUntil,
      expiryConfirmed: doc.expiryConfirmed,
      source: doc.source,
      checkedVia: doc.reviewerChecked ? doc.checkedVia : null,
      manualRequested: doc.manualVerification?.status === "requested",
      noExpiry: doc.noExpiry,
    }).status === "checked";
  // Agent review surface: the file URL carries the opaque document ID; the agent
  // session + grant scope authorises serving on the server (lib/agentData). The
  // session-less sample review authorises via the published open token instead
  // (census row 3 — the files route serves curated sample docs only).
  const fileUrl = doc.fileName
    ? `/api/files/${doc.id}${fileToken ? `?token=${encodeURIComponent(fileToken)}` : ""}`
    : null;
  // Thumbnail source (SEO plan v3 C9): the committed 400px WebP for curated SAMPLE
  // docs only (public/samples/thumbs, lazy + sized); every real doc, and the viewer
  // for every doc, keeps the /api/files URL.
  const thumbSrc = sampleThumbSrc(doc) ?? fileUrl;
  const number = docNumber(doc);

  return (
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      data-testid="doc-row"
      data-title={doc.title}
      data-review={doc.reviewStatus}
      data-duplicate={duplicateWith.length > 0 ? "true" : "false"}
    >
      {duplicateWith.length > 0 && (
        <div className="flex items-start gap-2 bg-rose-600 px-4 py-2 text-xs font-semibold text-white" data-testid="duplicate-flag">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Possible forgery — certificate number {number} also appears on{" "}
            {duplicateWith.join(", ")}. Verify before accepting.
          </span>
        </div>
      )}
      <div className="flex flex-col gap-4 p-4 sm:flex-row">
        {/* Inline image / file — click to open the full document viewer. */}
        <div className="sm:w-40 sm:shrink-0">
          {fileUrl && isImage(doc.fileName) ? (
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              data-testid="doc-open-viewer"
              aria-label={`Open ${doc.title} to view and verify`}
              className="group relative block h-32 w-full cursor-pointer overflow-hidden rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-40"
            >
              <DocImage
                src={thumbSrc}
                alt={doc.title}
                testId="doc-thumb"
                rotation={doc.rotation}
                width={400}
                height={181}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition group-hover:brightness-90"
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-slate-900/60 py-1 text-center text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                Click to view &amp; verify
              </span>
            </button>
          ) : fileUrl ? (
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              data-testid="doc-open-viewer"
              aria-label={`Open ${doc.title} to view and verify`}
              className="flex h-32 w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs font-semibold text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-40"
            >
              View file
            </button>
          ) : (
            <div
              data-testid="doc-no-file"
              className="h-32 w-full overflow-hidden rounded-lg border border-dashed border-slate-200 sm:h-40"
            >
              <DocPlaceholder />
            </div>
          )}
        </div>

        {viewerOpen && (
          <DocViewer
            doc={doc}
            reviewer={!readOnly}
            viewOnly={readOnly}
            reviewerName={reviewerName}
            seafarer={seafarer}
            onUpdate={onUpdate}
            onClose={() => setViewerOpen(false)}
            fileToken={fileToken}
          />
        )}

        {/* Details + actions */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* vr2 item 5 — rescued registry docs name their country instead of
                a bare "Unverified document" (data-title keeps the stored one). */}
            <h3 className="font-semibold text-slate-900">
              {rescuedDocDisplay(doc)?.title ?? doc.title}
            </h3>
            {sourceBadge(doc, status)}
            {doc.source !== "government" && doc.reviewerChecked && !primaryBadgeShowsChecked && (
              <StatusBadge
                status="checked"
                label={
                  doc.checkedVia === "registry-portal"
                    ? CHECKED_AGAINST_REGISTRY_LABEL
                    : "Checked by reviewer"
                }
              />
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${REVIEW_TONE[doc.reviewStatus]}`}
            >
              {REVIEW_LABEL[doc.reviewStatus]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {(() => {
              // vr2 item 5 — country · code · capability state for rescued docs.
              const rescued = rescuedDocDisplay(doc);
              const base = slot ? `Fills: ${slot}` : doc.docType;
              return rescued
                ? [base === doc.docType ? null : base, rescued.countryName, rescued.code, rescued.state]
                    .filter(Boolean)
                    .join(" · ")
                : base;
            })()}
            {doc.noExpiry
              ? " · no expiry"
              : doc.validUntil
                ? ` · valid until ${fmtDate(doc.validUntil)}`
                : " · no expiry read"}
            {doc.holderName ? ` · name read: ${doc.holderName}` : ""}
            {doc.estonianCode ? ` · code ${doc.estonianCode}` : ""}
          </p>
          {doc.reviewReason && (
            <p className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-xs text-rose-700">
              Reason: {doc.reviewReason}
            </p>
          )}
          {doc.reviewStatus !== "pending" && doc.reviewedBy && (
            <p className="mt-1 text-xs text-slate-400" data-testid="doc-reviewed-by">
              {REVIEW_LABEL[doc.reviewStatus]} by {doc.reviewedBy}
              {doc.reviewedAt ? ` · ${fmtDate(doc.reviewedAt)}` : ""}
            </p>
          )}

          {/* #S20 — flex-wrap so the review actions stack cleanly on a 390px phone
              instead of pinching. Approve hides once the doc is already approved
              (an agent may still Reject to revoke). Decision buttons are hidden
              entirely on the read-only sample review. */}
          {!readOnly && (
          <div className="mt-3 flex flex-wrap gap-2">
            {doc.reviewStatus !== "approved" && (
              <button
                data-testid="doc-approve"
                disabled={busy}
                onClick={() => onReview(doc.id, "approve")}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                Approve
              </button>
            )}
            <button
              data-testid="doc-reject"
              disabled={busy}
              onClick={() => setRejecting((v) => !v)}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
            >
              Reject
            </button>
          </div>
          )}

          {rejecting && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="reject-reason"
                placeholder="Reason for rejection…"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
              />
              <button
                data-testid="reject-confirm"
                disabled={busy || !reason.trim()}
                onClick={() => {
                  onReview(doc.id, "reject", reason.trim());
                  setRejecting(false);
                  setReason("");
                }}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Confirm rejection
              </button>
            </div>
          )}

          {/* Registry-era agent actions (plan §5.3): assisted countries get the
              "Check on official registry" + confirm flow; manual-wave countries
              get the request / confirm / close workflow. Renders nothing for
              docs without an applicable registryCountry. Hidden on the read-only
              sample review (they drive session-gated writes). */}
          {!readOnly && (
            <RegistryAgentActions
              doc={doc}
              seafarer={seafarer}
              reviewerName={reviewerName}
              onUpdate={onUpdate}
              allDocs={allDocs}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Compact rest-hours logger: one calendar day + total rest hours -> POST. Defaults
// the date to today so an agent can log the current day in one action.
function RestHourLogger({
  busy,
  onLog,
}: {
  busy: boolean;
  onLog: (date: string, hoursRest: number) => Promise<void> | void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState("");

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="text-xs font-medium text-slate-600">
        Date
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          data-testid="rest-date-input"
          className="mt-1 block rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Rest hours (0–24)
        <input
          type="number"
          min={0}
          max={24}
          step={0.5}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          data-testid="rest-hours-input"
          placeholder="e.g. 11"
          className="mt-1 block w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>
      <button
        type="button"
        data-testid="rest-hours-log"
        disabled={busy || !date || hours === "" || isNaN(Number(hours))}
        onClick={() => {
          void onLog(date, Number(hours));
          setHours("");
        }}
        className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
      >
        Log rest hours
      </button>
    </div>
  );
}
