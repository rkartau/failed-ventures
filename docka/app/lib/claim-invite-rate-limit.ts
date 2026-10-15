// Per-agentId in-memory rate limiter for the PROFILE-INVITE (claim) send path on
// /api/reminders. A deliberate twin of lib/delete-rate-limit.ts — sliding-window
// counter keyed by agentId, 10 POSTs / 60s. Combined with the id cap (≤50) this
// bounds a hijacked agent session to ≤500 claim addresses/min; the UI only ever
// sends ONE id per POST. Correct for the single pinned pm2 fork (no Redis). This is
// ABUSE dampening, not the isolation boundary (that is the session/grant checks).
// Returns true when the caller is over the limit and should be turned away with 429.
// (Follow-up, not here: fold this and delete-rate-limit into one factory.)

const CLAIM_INVITE_RATE_WINDOW_MS = 60_000;
const CLAIM_INVITE_RATE_MAX_HITS = 10;
const claimInviteHits = new Map<string, number[]>();

export function claimInviteRateLimited(agentId: string, now: number = Date.now()): boolean {
  const recent = (claimInviteHits.get(agentId) ?? []).filter(
    (t) => now - t < CLAIM_INVITE_RATE_WINDOW_MS
  );
  recent.push(now);
  claimInviteHits.set(agentId, recent);
  return recent.length > CLAIM_INVITE_RATE_MAX_HITS;
}

/** Test hook: clear every bucket so suites never bleed 429s into each other. */
export function _resetClaimInviteRateLimit(): void {
  claimInviteHits.clear();
}
