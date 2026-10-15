// Per-agentId in-memory rate limiter for the DESTRUCTIVE hidden-crew DELETE route.
// Sliding-window counter keyed by agentId, modeled on `inboxRateLimited` (lib/inbox.ts)
// but deliberately far tighter (10 per 60s vs 40 per 10s) — deleting crew is not a
// bulk operation. Correct for the single pinned pm2 fork (no Redis). This is ABUSE
// dampening, not the isolation boundary (that is the session/grant checks). Returns
// true when the caller is over the limit and should be turned away with 429.

const DELETE_RATE_WINDOW_MS = 60_000;
const DELETE_RATE_MAX_HITS = 10;
const deleteHits = new Map<string, number[]>();

export function deleteRateLimited(agentId: string, now: number = Date.now()): boolean {
  const recent = (deleteHits.get(agentId) ?? []).filter((t) => now - t < DELETE_RATE_WINDOW_MS);
  recent.push(now);
  deleteHits.set(agentId, recent);
  return recent.length > DELETE_RATE_MAX_HITS;
}

/** Test hook: clear every bucket so suites never bleed 429s into each other. */
export function _resetDeleteRateLimit(): void {
  deleteHits.clear();
}
