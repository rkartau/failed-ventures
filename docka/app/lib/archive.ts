// Archived-document helpers — client-safe (type-only import of Doc, no Node built-ins)
// so both server routes and browser components share ONE definition of "active".
//
// An archived document is a past/retired one the seaman chose to move out of their
// active list. It stays VISIBLE to the seaman (in a collapsible "Archived" section)
// but must NOT count as an active on-file document anywhere: it is excluded from the
// seaman's active list AND from every agent-side active-document set / completeness /
// validity / sea-readiness hard-block computation. `activeDocs` is the single seam
// that enforces that everywhere.

import type { Doc } from "@/lib/db";

/** True when the seaman archived this document (a past/retired doc, not counted active). */
export function isArchived(d: Pick<Doc, "archived">): boolean {
  return d.archived === true;
}

/** The ACTIVE (non-archived) subset of a document list — the on-file set that counts. */
export function activeDocs<T extends Pick<Doc, "archived">>(docs: T[]): T[] {
  return docs.filter((d) => !isArchived(d));
}

/**
 * Rank GOVERNMENT-VERIFIED documents FIRST, everything else after — preserving the
 * incoming relative order within each group (Array.prototype.sort is stable). Used by
 * every doc list (seaman view, share view, agent review) so a registry-verified
 * credential always sits at the top. This is presentation-only: it does NOT touch the
 * active/archived split — callers still keep archived docs in their own section.
 */
export function verifiedFirst<T extends Pick<Doc, "source">>(docs: T[]): T[] {
  return docs
    .slice()
    .sort((a, b) => (a.source === "government" ? 0 : 1) - (b.source === "government" ? 0 : 1));
}
