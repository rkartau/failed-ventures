// Shared, seaman-scoped helpers for the in-app inbox (circulars → seaman inbox).
//
// The seaman IDENTITY GATE (`seamanSession`) is called by every inbox ROUTE
// directly, never here — so the router-driven isolation guard still sees each route
// resolve + scope to its own `seafarerId`. This file only carries pieces that do NOT
// hide the identity gate: the OPEN-token fallback resolver (read-only surfaces), a
// per-seaman in-memory rate limiter, the newest-first compound-cursor pager, and the
// peer-anonymising shaping. Nothing here grants agent scope.

import type { Circular, CircularReply, DB } from "@/lib/db";

/** Hard page cap for the inbox list (F4 — bounded payload even with 200 circulars). */
export const INBOX_PAGE_SIZE = 50;

/** The ONLY label a peer's "everyone" reply is shown under to other crew (D2/F5). */
export const PEER_LABEL = "A crew member";

// ---- OPEN-token fallback resolver (read-only share surfaces) -----------
//
// Resolves the acting seaman from the possession-trust OPEN share token ONLY
// (`seafarer.shareToken`, aliased to `openShareToken`). The PRIVATE `emailShareToken`
// is a DIFFERENT value, so it never matches here — an email-link holder without a
// signed-in seaman session is rejected (D1/Tester#5). Returns the owning seafarerId
// or null. NEVER used by the reply-write route (that is authenticated-session only).
export function resolveOpenTokenSeafarerId(db: DB, token: string): string | null {
  const t = (token ?? "").trim();
  if (!t) return null;
  const holder = db.seafarers.find((s) => s.shareToken === t);
  return holder ? holder.id : null;
}

// ---- Per-seaman in-memory rate limiter (F6) ----------------------------
//
// Sliding-window counter keyed by seafarerId. Correct for the single pinned pm2 fork
// (no Redis). This is ABUSE dampening on the seaman inbox routes, not the isolation
// boundary (that is the session/grant checks). Returns true when the caller is over
// the limit and should be turned away with 429.
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_HITS = 40;
const rateHits = new Map<string, number[]>();

export function inboxRateLimited(seafarerId: string, now: number = Date.now()): boolean {
  const recent = (rateHits.get(seafarerId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  rateHits.set(seafarerId, recent);
  return recent.length > RATE_MAX_HITS;
}

// ---- Newest-first compound cursor (createdAt, id) — F1/F4 --------------
//
// A stable tiebreak on id makes pagination correct even for same-millisecond bulk
// sends. The cursor is opaque to the client; it is just the last-seen (createdAt,id).
export function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf("|");
  if (i < 0) return null;
  return { createdAt: cursor.slice(0, i), id: cursor.slice(i + 1) };
}

/** Newest-first order: createdAt desc, then id desc (stable tiebreak). */
export function circularNewestFirst(a: Circular, b: Circular): number {
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.id.localeCompare(a.id);
}

/** True when `c` sorts strictly OLDER than the cursor position (i.e. belongs on a later page). */
function isBeforeCursor(c: Circular, cur: { createdAt: string; id: string }): boolean {
  if (c.createdAt !== cur.createdAt) return c.createdAt < cur.createdAt;
  return c.id < cur.id;
}

/**
 * Page a newest-first list. `sorted` MUST already be in `circularNewestFirst` order.
 * Returns up to INBOX_PAGE_SIZE items strictly after the cursor, plus the next cursor
 * (null when the page is the last one).
 */
export function pageCirculars(
  sorted: Circular[],
  cursor: string | null
): { page: Circular[]; nextCursor: string | null } {
  const cur = parseCursor(cursor);
  const rest = cur ? sorted.filter((c) => isBeforeCursor(c, cur)) : sorted;
  const page = rest.slice(0, INBOX_PAGE_SIZE);
  const hasMore = rest.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { page, nextCursor };
}

// ---- Reply shaping for the SEAMAN view (peers anonymised) --------------
//
// The seaman NEVER sees another crew member's name: their own replies show as "You",
// every peer "everyone" reply shows as PEER_LABEL. (The AGENT-side view — real names —
// is a separate, tenant-scoped route.)
export type InboxReplyView = {
  id: string;
  body: string;
  visibility: "agent" | "all";
  createdAt: string;
  /** True when the acting seaman authored it. */
  mine: boolean;
  /** Display author: "You" for own replies, PEER_LABEL for peers. Never a real name. */
  author: string;
};

export function shapeReplyForSeaman(r: CircularReply, mySeafarerId: string): InboxReplyView {
  const mine = r.seafarerId === mySeafarerId;
  return {
    id: r.id,
    body: r.body,
    visibility: r.visibility,
    createdAt: r.createdAt,
    mine,
    author: mine ? "You" : PEER_LABEL,
  };
}
