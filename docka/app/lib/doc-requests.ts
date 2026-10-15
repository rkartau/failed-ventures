// Pure rule helpers for the document-request checklist — client-safe (NO Node
// built-ins), so the agent panel, the seaman checklist, the share view and the
// server route all share ONE set of rules (deadline state, auto-clear matching,
// package-ready summary). This module owns the DERIVED logic only; the records
// live in lib/db.ts and the persistence/notify live in the route.
//
// Reuse-first: the "which slot does this document fill" decision is NOT re-invented
// here — it is lib/doctypes.ts `classifyRequiredType`, the same classifier the
// completeness / compliance code already uses. A request carries a `requiredType`
// slot (or null for an ad-hoc item); an uploaded document is matched to a pending
// request by that slot, so the checklist clears itself the instant the seaman
// uploads what was asked for.

import type { Doc, DocRequest } from "@/lib/db";
import { classifyRequiredType, type RequiredDocType } from "@/lib/doctypes";

/** Requests still awaiting the seaman (the ones that count as "open"). */
export function isOpen(req: DocRequest): boolean {
  return req.status === "pending";
}

// ---- Deadline state ----------------------------------------------------

export type DueState =
  /** No deadline was set. */
  | "none"
  /** Past its deadline and still pending — the item an agent must chase now. */
  | "overdue"
  /** Due within DUE_SOON_DAYS and still pending. */
  | "due-soon"
  /** Pending with a deadline further out. */
  | "upcoming"
  /** No longer pending (received / waived / cancelled) — deadline is moot. */
  | "resolved";

/** A pending item this many days from its deadline (or fewer) counts as "due soon". */
export const DUE_SOON_DAYS = 3;

// yyyy-mm-dd for a Date in UTC — the calendar-day granularity deadlines use.
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `now` (UTC day) until `dueDate` (yyyy-mm-dd). Negative
 * when the deadline has passed, 0 on the due day itself. Null when there is no
 * deadline or it can't be parsed.
 */
export function daysUntilDue(dueDate: string | null, now: Date = new Date()): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00Z`);
  if (isNaN(due.getTime())) return null;
  const today = new Date(`${isoDay(now)}T00:00:00Z`);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

/** Deadline state of a request, combining its status and its due date. */
export function dueState(req: DocRequest, now: Date = new Date()): DueState {
  if (req.status !== "pending") return "resolved";
  const days = daysUntilDue(req.dueDate, now);
  if (days === null) return "none";
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_DAYS) return "due-soon";
  return "upcoming";
}

/** A pending request whose deadline has passed. */
export function isOverdue(req: DocRequest, now: Date = new Date()): boolean {
  return dueState(req, now) === "overdue";
}

// ---- Auto-clear matching -----------------------------------------------

/**
 * Does an uploaded document satisfy this PENDING request? A request tied to a
 * required slot is cleared by any document that classifies into that same slot
 * (the seaman uploaded the Medical that was asked for). An ad-hoc request (no
 * slot) is never auto-matched — the agent clears it by hand — so a stray upload
 * can't silently tick off a bespoke ask. Resolved requests never re-match.
 */
export function matchesDoc(req: DocRequest, doc: Doc): boolean {
  if (req.status !== "pending") return false;
  if (!req.requiredType) return false;
  const slot: RequiredDocType | null =
    doc.requiredType ??
    classifyRequiredType({ title: doc.title, docType: doc.docType, docCategory: doc.docCategory });
  return slot === req.requiredType;
}

/**
 * Mutate the given requests IN PLACE: every pending request for `seafarerId` that
 * the uploaded `doc` satisfies is marked received (resolvedVia "upload"). Returns
 * the ids that were cleared. Called from inside the document write critical section
 * so the checklist clears atomically with the upload. Pure w.r.t. Node — safe on
 * both server and client, though only the server ever persists the result.
 */
export function autoClearForDoc(
  requests: DocRequest[],
  seafarerId: string,
  doc: Doc,
  at: string = new Date().toISOString()
): string[] {
  const cleared: string[] = [];
  for (const req of requests) {
    if (req.seafarerId !== seafarerId) continue;
    if (!matchesDoc(req, doc)) continue;
    req.status = "received";
    req.resolvedAt = at;
    req.resolvedVia = "upload";
    cleared.push(req.id);
  }
  return cleared;
}

/**
 * TARGETED clear (Feature 1+2): mark the ONE pending request `requestId` (for this
 * seafarer) as received via an upload — even when its `requiredType` is null (an
 * ad-hoc request that `autoClearForDoc`/`matchesDoc` intentionally never auto-match).
 * This is how a per-request upload fills the exact item the seaman was asked for.
 * Mutates IN PLACE and returns the ids cleared ([] when the id is unknown, belongs
 * to another seafarer, or is already resolved). Call INSIDE an updateDB critical
 * section. `doc` is accepted for signature parity / future use but not required to
 * match — the request was explicitly targeted by the uploader.
 */
export function clearRequestById(
  requests: DocRequest[],
  seafarerId: string,
  requestId: string,
  _doc?: Doc,
  at: string = new Date().toISOString()
): string[] {
  const req = requests.find(
    (r) => r.id === requestId && r.seafarerId === seafarerId && r.status === "pending"
  );
  if (!req) return [];
  req.status = "received";
  req.resolvedAt = at;
  req.resolvedVia = "upload";
  return [req.id];
}

// ---- Agent-side "all approved" gate (Fix 8) ----------------------------

/**
 * Fix 8 — is every requested document not merely handed in, but AGENT-APPROVED?
 * Drives whether the AGENT's request-STATUS box may disappear (a stricter twin of
 * the seaman-side "nothing pending" hide).
 *
 * TRUE only when ALL of these hold:
 *   - there is at least one request (an empty checklist is never "approved" — there
 *     is simply nothing collected yet), and
 *   - NO request is still `pending` (nothing left for the seaman to hand in), and
 *   - every RECEIVED request's fulfilling document has `reviewStatus === "approved"`.
 *
 * `waived` / `cancelled` requests never block (the agent decided they weren't
 * needed). A received request's fulfilling document is found by the SAME slot match
 * `matchesDoc` uses (its `requiredType` classified onto a doc) — DocRequest stores no
 * fulfilling-doc id, so there is no direct link to follow. An ad-hoc received request
 * (`requiredType === null`) has no reliable slot link, so it is treated as satisfied
 * without a review check: it can only have reached "received" via a targeted upload or
 * a deliberate agent action, so re-gating it on a review it can't be tied to would keep
 * the box open forever. This is the one spot where "approved" cannot be computed from
 * the data, and the chosen behaviour is to NOT block on it.
 */
export function allRequestsApproved(requests: DocRequest[], docs: Doc[]): boolean {
  if (!requests || requests.length === 0) return false;
  for (const req of requests) {
    if (req.status === "pending") return false; // still awaiting the seaman's upload
    if (req.status !== "received") continue; // waived / cancelled never block
    if (!req.requiredType) continue; // ad-hoc: no slot link — treat received as satisfied
    const fulfilling = docs.find((d) => {
      const slot: RequiredDocType | null =
        d.requiredType ??
        classifyRequiredType({ title: d.title, docType: d.docType, docCategory: d.docCategory });
      return slot === req.requiredType;
    });
    if (!fulfilling || fulfilling.reviewStatus !== "approved") return false;
  }
  return true;
}

// ---- Roster summary ----------------------------------------------------

export type RequestSummary = {
  total: number;
  pending: number;
  overdue: number;
  received: number;
  /** Resolved a way OTHER than received (waived + cancelled). */
  closed: number;
  /**
   * "Package ready" for a crew change: at least one request was raised and NONE
   * is still pending. An empty checklist is NOT "ready" — there is simply nothing
   * to collect yet, so the badge only appears once a collection loop was started.
   */
  packageReady: boolean;
};

/** Summarise a seafarer's requests for the board badge + panel header. */
export function summarizeRequests(reqs: DocRequest[], now: Date = new Date()): RequestSummary {
  let pending = 0;
  let overdue = 0;
  let received = 0;
  let closed = 0;
  for (const r of reqs) {
    if (r.status === "pending") {
      pending++;
      if (isOverdue(r, now)) overdue++;
    } else if (r.status === "received") {
      received++;
    } else {
      closed++;
    }
  }
  return {
    total: reqs.length,
    pending,
    overdue,
    received,
    closed,
    packageReady: reqs.length > 0 && pending === 0,
  };
}

/** Sort for display: pending first (overdue → soonest deadline → no deadline), resolved last. */
export function sortForDisplay(reqs: DocRequest[], now: Date = new Date()): DocRequest[] {
  const rank = (r: DocRequest): number => (r.status === "pending" ? 0 : 1);
  return reqs.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      // Both pending: order by urgency. No-deadline items sort after dated ones.
      const da = daysUntilDue(a.dueDate, now);
      const db = daysUntilDue(b.dueDate, now);
      if (da === null && db === null) return a.createdAt.localeCompare(b.createdAt);
      if (da === null) return 1;
      if (db === null) return -1;
      if (da !== db) return da - db;
    }
    // Resolved (or tied): newest activity first.
    return (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt);
  });
}
