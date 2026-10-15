// "Book a call" — the coarse GLOBAL flood guard for the public booking POST (R5/R9).
//
// This is a PROCESS-LIFETIME, in-memory rolling counter that caps the TOTAL number of
// new bookings accepted across ALL IPs per window. It is deliberately NOT a
// `db.bookings` scan: R9 requires the flood defense to run BEFORE the ~435KB `readDB()`
// so an IP-rotating flood can neither amplify the hot read nor hammer the shared write
// mutex. The per-IP `consumeBudget` limiter (lib/registry) still runs first; this is the
// second, IP-agnostic ceiling that a rotating flood cannot evade.
//
// State is pinned on `globalThis` so Next dev HMR / module-graph duplication cannot fork
// it (mirrors the registry limiter's approach). In-memory, resets on pm2 restart — the
// same accepted stance as every other limiter in this codebase.

/** Rolling window length. */
export const GLOBAL_BOOKING_WINDOW_MS = 60_000;
/** Max NEW bookings accepted across all IPs within one window. */
export const GLOBAL_BOOKING_MAX = 30;

type GlobalBookingState = { hits: number[] };

function state(): GlobalBookingState {
  const g = globalThis as typeof globalThis & { __dockaBookingRate?: GlobalBookingState };
  if (!g.__dockaBookingRate) g.__dockaBookingRate = { hits: [] };
  return g.__dockaBookingRate;
}

/**
 * Returns true (and RECORDS a hit) when a new booking is under the global ceiling for
 * the current window; false when the ceiling is already reached (the caller returns a
 * friendly 429). Pruning is O(hits) but `hits` is bounded by GLOBAL_BOOKING_MAX, so the
 * whole check is cheap and never touches the store.
 */
export function checkGlobalBookingRate(now: number = Date.now()): boolean {
  const s = state();
  const cutoff = now - GLOBAL_BOOKING_WINDOW_MS;
  // Drop hits that have aged out of the window.
  while (s.hits.length > 0 && s.hits[0] <= cutoff) s.hits.shift();
  if (s.hits.length >= GLOBAL_BOOKING_MAX) return false;
  s.hits.push(now);
  return true;
}

/** Test-only: clear the rolling counter so each case starts from an empty window. */
export function __resetGlobalBookingRate(): void {
  state().hits.length = 0;
}
