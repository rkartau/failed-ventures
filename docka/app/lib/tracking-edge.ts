// lib/tracking-edge.ts — edge-safe abuse controls for the /o and /u endpoints,
// applied in middleware.ts (plan §2 B6). EDGE RUNTIME CONSTRAINTS: no fs, no
// node:crypto value imports, no lib/db / lib/registry (those pull node "fs").
// So this is a small self-contained per-IP token bucket + client-IP derivation,
// mirroring the accepted in-memory / resets-on-restart stance of every other
// limiter in this codebase (lib/registry, lib/booking-rate-limit).
//
// NOTE ON SCOPE: middleware enforces the per-IP RATE cap and a small REQUEST-body
// size cap here (both edge-safe). The event-FILE / disk ceiling is a filesystem
// fact the edge runtime cannot read, so it is enforced in the Node route handler
// via appendEvent's segment ceiling (OutreachEventsError → 503). Documented split.

/** Per-IP burst + refill for tracking hits. Generous for a real recipient
 *  (a mail client may fire the pixel + a human may click unsub), far below a
 *  scraper. */
export const TRACKING_IP_CAPACITY = 20;
export const TRACKING_IP_REFILL_PER_MS = 20 / 60_000; // 20 tokens/minute

/** Max bytes we accept on a /u POST body (one-click unsub bodies are tiny). */
export const TRACKING_MAX_BODY_BYTES = 4096;

/** Idle-bucket prune horizon (bounded memory). */
const BUCKET_TTL_MS = 10 * 60_000;

type Bucket = { tokens: number; last: number };
type EdgeState = { buckets: Map<string, Bucket> };

// Pin state on globalThis so any module-graph duplication shares one map.
function state(): EdgeState {
  const g = globalThis as typeof globalThis & { __dockaTrackingEdge?: EdgeState };
  if (!g.__dockaTrackingEdge) g.__dockaTrackingEdge = { buckets: new Map() };
  return g.__dockaTrackingEdge;
}

/**
 * Client IP from proxy headers. Preferred: X-Real-IP (the box's proxy sets it
 * from $remote_addr). Fallback: the RIGHTMOST X-Forwarded-For entry — the one
 * the single trusted hop appended; entries to its left are client-controlled and
 * must never pick the bucket. Same rule as lib/registry.clientIpFromHeaders,
 * re-implemented here to stay edge-safe (no registry import).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "local";
}

/**
 * Spend one token for `ip`. Returns false when over-limit (caller returns 429).
 * Continuously refilled; idle full buckets are pruned.
 */
export function consumeTrackingBudget(ip: string, now: number = Date.now()): boolean {
  const s = state();

  // Prune idle, full buckets.
  for (const [k, b] of s.buckets) {
    if (now - b.last > BUCKET_TTL_MS && b.tokens >= TRACKING_IP_CAPACITY) s.buckets.delete(k);
  }

  let b = s.buckets.get(ip);
  if (!b) {
    b = { tokens: TRACKING_IP_CAPACITY, last: now };
    s.buckets.set(ip, b);
  } else {
    b.tokens = Math.min(TRACKING_IP_CAPACITY, b.tokens + (now - b.last) * TRACKING_IP_REFILL_PER_MS);
    b.last = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Test-only: clear buckets so each case starts fresh. */
export function __resetTrackingEdge(): void {
  state().buckets.clear();
}

/**
 * Is the declared request body over the size cap? Reads only the Content-Length
 * header (edge-safe — never buffers the body). A missing/invalid header → not
 * over cap (GET pixels carry none; a real over-limit POST declares its length).
 */
export function bodyOverCap(headers: Headers, cap: number = TRACKING_MAX_BODY_BYTES): boolean {
  const len = Number(headers.get("content-length") ?? "");
  return Number.isFinite(len) && len > cap;
}
