"use client";

import { useState } from "react";
import { SEAFARER_STATES, type SeafarerState } from "@/lib/pipeline";

// One "flow" = one agency the seaman shared documents with, and where that agency is
// with them. Shape mirrors lib/access.ts SeamanFlow (the server projection). The
// seaman cannot change their own stage here — but they DO control propagation (#38).
export type Flow = {
  agentId: string;
  orgName: string;
  /** Stored per-agent stage truth. */
  stage: SeafarerState;
  stageLabel: string;
  stageUpdatedAt: number | null;
  status: "PENDING" | "ACTIVE" | "LOCKED" | "REVOKED" | "EXPIRED";
  lockedVessel: string | null;
  /** #45 — live LOCKED assignment id, for the seaman's own-SEA download link. */
  lockedByAssignmentId?: string | null;
  overCap: boolean;
  agencyContact: string | null;
  /** #38 — this agency's current propagation consent per bucket (seaman-controlled). */
  propagateContact: boolean;
  propagateFinancial: boolean;
  /** #42 — may this agency show me on a shipowner/client read-portal. Default false. */
  clientVisible?: boolean;
};

// #38.5 — a pending agent-side request for propagation, shown to the seaman to decide.
export type PropagationRequest = {
  id: string;
  agentId: string;
  orgName: string;
  bucket: "contact" | "financial";
  requestedBy: string;
};

// #12 — a PENDING agent-initiated appraisal delete, shown to the seaman to keep or
// delete from their own records. Shape mirrors the AppraisalDeleteRequest store record
// the seaman GET now delivers (only `id` is used to render + decide).
export type AppraisalDeleteRequest = {
  id: string;
  appraisalId: string;
  seafarerId: string;
  agentId: string;
  status: "pending" | "kept" | "deleted";
  createdAt: string;
  decidedAt: string | null;
};

// D.0 — the SINGLE derived stage the card reads (F1). A LOCKED grant reads as at sea
// everywhere even if its stored `stage` has not yet been dragged to sent_to_sea, so
// the pill, Row 2, the rail, the copy, the summary, and the sort can never contradict
// each other. `?? "review"` mirrors the server default (F4).
function displayStage(flow: Flow): SeafarerState {
  return flow.status === "LOCKED" ? "sent_to_sea" : (flow.stage ?? "review");
}

// ONE coherent vocabulary across the pill, the summary line, AND Row 2 (persona
// polish): the seaman never sees "Shortlisted" in one place and "Accepted" in
// another. DISPLAY_WORD is the capitalised form (pill + Row 2); SUMMARY_WORD is the
// lower-case form used inside the running summary sentence.
const DISPLAY_WORD: Record<SeafarerState, string> = {
  review: "In review",
  accepted: "Shortlisted",
  sent_to_sea: "At sea",
  returning: "Wrapping up",
  finished: "Finished",
};
const SUMMARY_WORD: Record<SeafarerState, string> = {
  review: "in review",
  accepted: "shortlisted",
  sent_to_sea: "at sea",
  returning: "wrapping up",
  finished: "finished",
};

// D.3 — ACTIONABLE-FIRST sort rank over displayStage (F1). Attention-needing states
// sort to the top.
const STAGE_RANK: Record<SeafarerState, number> = {
  returning: 0, // coming back — may need action soon
  accepted: 1, // shortlisted — live, waiting on a berth
  review: 2, // earliest — agency still checking docs
  sent_to_sea: 3, // at sea / LOCKED — informational
  finished: 4, // closed
};

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 21 * DAY_MS;

// "Updated <relative>" for a finite stageUpdatedAt. Coarse + locale-agnostic.
function relativeUpdated(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < DAY_MS) return "Updated today";
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return "Updated yesterday";
  if (days < 7) return `Updated ${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "Updated 1 week ago" : `Updated ${weeks} weeks ago`;
}

// Pill colours by displayStage — amber for at sea (locked), muted for finished.
function pillClasses(stage: SeafarerState): string {
  switch (stage) {
    case "sent_to_sea":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "finished":
      return "bg-slate-100 text-slate-500 ring-slate-200";
    case "returning":
      return "bg-sky-50 text-sky-700 ring-sky-200";
    case "accepted":
      return "bg-indigo-50 text-indigo-700 ring-indigo-200";
    default:
      return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
}

// Row 3 — a compact 5-dot progress rail. Filled/current/hollow are distinguished by
// SHAPE (fill + ring), not colour alone (accessibility): filled = solid disc; current
// = hollow disc with a heavy ring; later = thin outline only.
function ProgressRail({ stage }: { stage: SeafarerState }) {
  const current = SEAFARER_STATES.indexOf(stage);
  return (
    <ol
      role="list"
      className="flex items-center gap-1.5 overflow-hidden"
      data-testid="flow-rail"
    >
      {SEAFARER_STATES.map((s, i) => {
        const state = i < current ? "filled" : i === current ? "current" : "hollow";
        const dot =
          state === "filled"
            ? "h-3 w-3 rounded-full bg-slate-700"
            : state === "current"
              ? "h-3 w-3 rounded-full bg-white ring-2 ring-slate-700 ring-offset-1"
              : "h-2.5 w-2.5 rounded-full border border-slate-300 bg-transparent";
        return (
          <li
            key={s}
            role="listitem"
            aria-label={`Stage ${i + 1} of 5: ${DISPLAY_WORD[s]}`}
            className="flex flex-col items-center gap-1"
          >
            <span className={dot} aria-hidden="true" />
            <span className="hidden text-[11px] text-slate-400 sm:block">
              {DISPLAY_WORD[s]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// D.5 — status-line copy, selected by displayStage.
function StatusLine({ flow, stage }: { flow: Flow; stage: SeafarerState }) {
  if (stage === "review") {
    return <>In review — the agency is checking your documents.</>;
  }
  if (stage === "accepted") {
    return <>Shortlisted — you&apos;re on their shortlist, waiting for a berth (a job on a ship).</>;
  }
  if (stage === "returning") {
    return <>Wrapping up — this placement is coming to an end.</>;
  }
  if (stage === "finished") {
    return <>Finished — this placement is complete.</>;
  }
  // sent_to_sea OR LOCKED
  const lockClause =
    " You can't withdraw them until you return; it unlocks automatically then.";
  const head = flow.lockedVessel
    ? `At sea on ${flow.lockedVessel} — ${flow.orgName} placed you here.`
    : "At sea — vessel not recorded.";
  // Overrun affordance — renders cleanly whether or not the agency contact is known
  // (no dangling separator when agencyContact is absent).
  const overrun = flow.overCap
    ? " — This voyage has run longer than expected — contact the agency" +
      (flow.agencyContact ? ` at ${flow.agencyContact}.` : ".")
    : "";
  return (
    <>
      {head}
      {lockClause}
      {overrun}
    </>
  );
}

// #38 — the two per-agency consent toggles (contact + financial/NOK), independent.
// Fires POST /api/access/propagation (seaman-controlled). A missing token disables them.
function PropagationToggles({
  flow,
  seafarerId,
  token,
}: {
  flow: Flow;
  seafarerId: string | null;
  token: string | null;
}) {
  const [contact, setContact] = useState(flow.propagateContact);
  const [financial, setFinancial] = useState(flow.propagateFinancial);
  const [clientVisible, setClientVisible] = useState(flow.clientVisible === true);
  const [busy, setBusy] = useState<"contact" | "financial" | "client" | null>(null);

  async function toggle(bucket: "contact" | "financial", next: boolean) {
    if (!seafarerId || !token) return;
    // Honest revoke copy (#38.4) on a toggle-OFF — the seaman must know it can't un-see.
    if (!next) {
      const okToStop = window.confirm(
        `Stopping sharing hides this from ${flow.orgName} from now on. It cannot un-see or delete what they already viewed or saved. Stop sharing?`
      );
      if (!okToStop) return;
    }
    setBusy(bucket);
    try {
      const res = await fetch("/api/access/propagation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId, agentId: flow.agentId, bucket, on: next, token }),
      });
      const data = await res.json();
      if (data.ok) {
        if (bucket === "contact") setContact(next);
        else setFinancial(next);
      }
    } finally {
      setBusy(null);
    }
  }

  // #42 — per-agency client-portal visibility. Going-forward only; the toggle-OFF copy
  // is honest that a portal already shown cannot be un-seen.
  async function toggleClientVisible(next: boolean) {
    if (!seafarerId || !token) return;
    if (!next) {
      const okToStop = window.confirm(
        `Hiding you from ${flow.orgName}'s client portals stops NEW views from now on. It cannot un-see a portal already shown. Hide me?`
      );
      if (!okToStop) return;
    }
    setBusy("client");
    try {
      const res = await fetch("/api/seafarer/client-visible", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId, agentId: flow.agentId, on: next, token }),
      });
      const data = await res.json();
      if (data.ok) setClientVisible(next);
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || !token;
  return (
    <div className="mt-2 border-t border-slate-100 pt-1">
      {/* #S19 — the WHOLE row is a ≥44px tap target and uses a proper on/off SWITCH
          (44px track), not a tiny corner checkbox — mobile-friendly. */}
      <ConsentSwitch
        testId="flow-propagation-contact"
        label="Share my contact details & CV"
        on={contact}
        disabled={disabled}
        onChange={(next) => void toggle("contact", next)}
      />
      <ConsentSwitch
        testId="flow-propagation-financial"
        label="Share my bank details & emergency family contact"
        on={financial}
        disabled={disabled}
        onChange={(next) => void toggle("financial", next)}
      />
      <ConsentSwitch
        testId="flow-client-visible"
        label="Show me on this agency's shipowner/client portals"
        on={clientVisible}
        disabled={disabled}
        onChange={(next) => void toggleClientVisible(next)}
      />
    </div>
  );
}

// #S19 / #S21 — one tappable consent row: full-width ≥44px label + a 44px on/off
// switch. The hidden checkbox drives the state (so clicking anywhere on the row
// toggles it) while the styled track gives a clear, large switch.
function ConsentSwitch({
  testId,
  label,
  on,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      data-testid={testId}
      data-on={on ? "true" : "false"}
      className={`flex min-h-[44px] items-center justify-between gap-3 text-sm text-slate-700 ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-6 w-11 flex-shrink-0 rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-brand-600 peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-300"
      />
    </label>
  );
}

function FlowCard({
  flow,
  now,
  seafarerId,
  token,
}: {
  flow: Flow;
  now: number;
  seafarerId: string | null;
  token: string | null;
}) {
  const stage = displayStage(flow);
  const index = SEAFARER_STATES.indexOf(stage);
  const isFinished = stage === "finished";
  const showUpdated = !isFinished && flow.stageUpdatedAt !== null;
  let updatedLine: string | null = null;
  if (showUpdated && flow.stageUpdatedAt !== null) {
    const age = now - flow.stageUpdatedAt;
    if (age >= STALE_MS) {
      const weeks = Math.floor(age / (7 * DAY_MS));
      updatedLine = `No update in ${weeks} weeks`;
    } else {
      updatedLine = relativeUpdated(flow.stageUpdatedAt, now);
    }
  }
  return (
    <li
      data-testid="flow-card"
      data-agent={flow.agentId}
      data-stage={stage}
      data-status={flow.status}
      className={`rounded-xl border px-4 py-3 ${
        isFinished ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"
      }`}
    >
      {/* Row 1 — agency name + status pill (name truncates, pill never pushed off). */}
      <div className="flex items-center justify-between gap-3">
        <p
          className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-base font-semibold ${
            isFinished ? "text-slate-500" : "text-slate-900"
          }`}
        >
          {flow.orgName}
        </p>
        <span
          data-testid="flow-pill"
          className={`flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${pillClasses(
            stage
          )}`}
        >
          {DISPLAY_WORD[stage]}
        </span>
      </div>

      {/* Row 2 — prominent current-stage line in words (>=14px, wraps not truncates). */}
      <p
        data-testid="flow-step"
        className="mt-2 break-words text-sm font-medium text-slate-700"
      >
        {DISPLAY_WORD[stage]} — step {index + 1} of 5
      </p>

      {/* Row 3 — compact 5-dot progress rail. */}
      <div className="mt-2">
        <ProgressRail stage={stage} />
      </div>

      {/* Row 4 — status line. */}
      <p className="mt-2 text-sm text-slate-600" data-testid="flow-status-line">
        <StatusLine flow={flow} stage={stage} />
      </p>

      {/* Row 5 — "last updated" (non-finished only; omitted when not finite). */}
      {updatedLine && (
        <p className="mt-1 text-xs text-slate-400" data-testid="flow-updated">
          {updatedLine}
        </p>
      )}

      {/* Row 6 — #38 propagation consent toggles (contact / financial), seaman-controlled. */}
      <PropagationToggles flow={flow} seafarerId={seafarerId} token={token} />
    </li>
  );
}

export function SeamanFlows({
  flows,
  seafarerId = null,
  token = null,
  requests = [],
  appraisalDeleteRequests = [],
}: {
  flows: Flow[];
  /** Owner seafarer id + share token, threaded so the propagation toggles can write (#38). */
  seafarerId?: string | null;
  token?: string | null;
  /** #38.5 pending agent-side propagation requests for this seaman to approve/decline. */
  requests?: PropagationRequest[];
  /** #12 pending agent-deleted appraisals for this seaman to keep or delete. */
  appraisalDeleteRequests?: AppraisalDeleteRequest[];
}) {
  const now = Date.now();
  // #12 — locally hide a keep/delete card once the seaman decides it (the store record
  // is still delivered until the next full page load; the set filters it out meanwhile).
  const [decidedDeleteReqs, setDecidedDeleteReqs] = useState<Set<string>>(new Set());
  const [busyDeleteReq, setBusyDeleteReq] = useState<string | null>(null);

  // #12 — the seaman's keep/delete decision on an agent-removed, ever-shared appraisal.
  // Uses the SAME owner share token the propagation card rides. On success the card is
  // removed; on "delete" the appraisal is hard-deleted server-side and disappears from the
  // appraisals list on the next load.
  async function decideAppraisalDelete(requestId: string, decision: "keep" | "delete") {
    if (!token) return;
    setBusyDeleteReq(requestId);
    try {
      const res = await fetch("/api/appraisals/delete-request", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, decision, token }),
      });
      const data = await res.json().catch(() => ({}));
      // A 409 (already decided) is terminal too — drop the stale card either way.
      if (data.ok || res.status === 409) {
        setDecidedDeleteReqs((prev) => {
          const next = new Set(prev);
          next.add(requestId);
          return next;
        });
      }
    } finally {
      setBusyDeleteReq(null);
    }
  }
  const pendingDeleteReqs = appraisalDeleteRequests.filter((r) => !decidedDeleteReqs.has(r.id));
  // #38.1 — one-time onboarding: show the "choose which agencies see your profile" panel
  // when there is ≥1 active grant and the seaman has never set ANY propagation flag.
  const everSetPropagation = flows.some((f) => f.propagateContact || f.propagateFinancial);
  const [onboardingDone, setOnboardingDone] = useState(false);
  const showOnboarding = !everSetPropagation && flows.length > 0 && !onboardingDone && !!token;

  async function decideRequest(requestId: string, decision: "approved" | "declined") {
    if (!token) return;
    await fetch("/api/access/propagation/request", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision, token }),
    });
  }
  // D.2 — summary line by displayStage, omitting zero buckets.
  const counts: Record<SeafarerState, number> = {
    review: 0,
    accepted: 0,
    sent_to_sea: 0,
    returning: 0,
    finished: 0,
  };
  for (const f of flows) counts[displayStage(f)] += 1;
  const agencyToken = `${flows.length} ${flows.length === 1 ? "agency" : "agencies"}`;
  const buckets = SEAFARER_STATES.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]} ${SUMMARY_WORD[s]}`
  );
  const summary = [agencyToken, ...buckets].join(" · ");

  // D.3 — actionable-first sort; F3-safe tiebreak (NaN never leaks in).
  const sorted = [...flows].sort((a, b) => {
    const ra = STAGE_RANK[displayStage(a)];
    const rb = STAGE_RANK[displayStage(b)];
    if (ra !== rb) return ra - rb;
    const ta = Number.isFinite(a.stageUpdatedAt) ? (a.stageUpdatedAt as number) : 0;
    const tb = Number.isFinite(b.stageUpdatedAt) ? (b.stageUpdatedAt as number) : 0;
    return tb - ta; // most-recent change first
  });

  return (
    <div className="mt-8" data-testid="seaman-flows">
      <h2 className="font-semibold text-slate-900">My applications</h2>
      <p className="mt-1 text-sm text-slate-500">
        Only you can see this page — agencies never see it, and they cannot see which
        other agencies you are talking to. This list shows only the agencies you
        personally shared documents with. If you revoke an agency, or its access
        expires, it disappears from here and loses access.
      </p>

      {/* Persona Wei — the ONE-LINE clarification that documents are always shared. */}
      <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
        Your certificates are always shared with agencies you granted; the switches below
        only control your personal contact and bank info.
      </p>

      {/* #38.1 — one-time onboarding panel: choose which agencies see your profile. */}
      {showOnboarding && (
        <div
          data-testid="propagation-onboarding"
          className="mt-3 rounded-xl border border-brand-200 bg-brand-50 p-3"
        >
          <p className="text-sm font-semibold text-brand-800">
            Choose which agencies see your profile
          </p>
          <p className="mt-1 text-xs text-brand-700">
            By default your personal contact and bank details are private. Use the switches
            on each agency below to share them — only with the agencies you choose.
          </p>
          <button
            type="button"
            className="mt-2 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
            onClick={() => setOnboardingDone(true)}
          >
            Got it
          </button>
        </div>
      )}

      {/* #38.5 — pending requests an agency raised, for the seaman to approve/decline. */}
      {requests.length > 0 && (
        <ul className="mt-3 space-y-2">
          {requests.map((r) => (
            <li
              key={r.id}
              data-testid="propagation-request"
              data-bucket={r.bucket}
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
            >
              <p className="text-amber-900">
                <span className="font-semibold">{r.orgName}</span> asked to see your{" "}
                {r.bucket === "contact" ? "contact details & CV" : "bank details & emergency family contact"}.
              </p>
              {/* #S22 — make the link between this decision and the persistent per-agency
                  switches explicit. */}
              <p className="mt-1 text-xs text-amber-800">
                Approving turns on the matching “{r.bucket === "contact" ? "Share my contact details & CV" : "Share my bank details & emergency family contact"}” switch for {r.orgName} below — you can turn it off any time.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="propagation-request-approve"
                  className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700"
                  onClick={() => void decideRequest(r.id, "approved")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  data-testid="propagation-request-decline"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  onClick={() => void decideRequest(r.id, "declined")}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* #12 — agent removed an ever-shared appraisal: the seaman keeps it in their own
          records or deletes it. Mirrors the propagation Approve/Decline card pattern above. */}
      {pendingDeleteReqs.length > 0 && (
        <ul className="mt-3 space-y-2">
          {pendingDeleteReqs.map((r) => (
            <li
              key={r.id}
              data-testid="appraisal-delete-request"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
            >
              <p className="text-amber-900">
                Your agent removed an appraisal filed about you. Keep it in your records, or
                delete it?
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="appraisal-delete-request-keep"
                  disabled={busyDeleteReq === r.id || !token}
                  className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                  onClick={() => void decideAppraisalDelete(r.id, "keep")}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  data-testid="appraisal-delete-request-delete"
                  disabled={busyDeleteReq === r.id || !token}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                  onClick={() => void decideAppraisalDelete(r.id, "delete")}
                >
                  Delete it
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {flows.length === 0 ? (
        <p
          data-testid="flows-empty"
          className="mt-3 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400"
        >
          You have not shared your documents with any agency yet. Share your link with
          an agency and your progress with them will show up here.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm font-medium text-slate-600" data-testid="flows-summary">
            {summary}
          </p>
          <ul className="mt-3 space-y-2" data-testid="flows-list">
            {sorted.map((flow) => (
              <FlowCard
                key={flow.agentId}
                flow={flow}
                now={now}
                seafarerId={seafarerId}
                token={token}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
