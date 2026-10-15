// feat/password-signup Step 3 — auth rate limiting: a THIN configuration wrapper
// over the hardened, exported registry limiter. NO new limiter core lives here.
//
// Reused pieces (app/lib/registry/index.ts, spoof-tested in tests/rate-limit.spec.mjs):
//   - clientIpFromHeaders(headers): prefers x-real-ip, else the RIGHTMOST
//     x-forwarded-for entry (leftmost entries are client-controlled and never
//     pick the bucket), "local" fallback, mock-mode-only test override header.
//   - consumeBudget(bucketName, key, opts): the ONE namespaced token-bucket
//     limiter (keys `bucketName::key`). It TTL-prunes on every call (idle > 10
//     min AND refilled to cap ⇒ deleted), so attacker-chosen keys (identifiers)
//     are bounded. Caveat: a slow-refill bucket (e.g. 3/h) only becomes prunable
//     once refilled, so an exhausted identifier bucket lingers up to a few
//     hours — memory stays bounded by attack-rate × (TTL + refill time); no
//     hard cap needed.
//
// Named per-surface globals use BudgetOpts.globalName (NEVER useGlobal, which is
// the registry-outbound protector) so total scrypt work is hard-bounded
// regardless of attacker IP count (D8 DoS budget).
//
// All state is in-memory and resets on pm2 restart — accepted (single fork,
// abuse-dampening only, matches the codebase's existing stance); the
// RATE_LIMITED aggregator below is lost on restart too (same stance).
//
// Documented trade-off (accepted, R7): the per-identifier login bucket
// (5/5 min) means an attacker spamming a victim's username temporarily locks
// the victim out — a bounded, self-expiring DoS; the alternative (IP-only
// limits) would allow distributed brute force against one account.

import crypto from "crypto";
import { consumeBudget, clientIpFromHeaders, type BudgetOpts } from "@/lib/registry";
import { appendAudit, id, AUDIT_NO_IMPERSONATION } from "@/lib/db";

// Re-exported so auth callers have one import site for the whole gate.
export { clientIpFromHeaders };

const HOUR = 3_600_000;
const MIN = 60_000;

export type AuthBucketName =
  | "auth-signup"
  | "auth-login-ip"
  | "auth-login-id"
  | "auth-recovery-ip"
  | "auth-recovery-id"
  | "auth-login-acct"
  | "auth-recovery-acct"
  | "auth-signup-invited"
  | "auth-account-mgmt";

/**
 * Bucket table (plan Step 3 — exact caps). Token-bucket equivalents of the
 * window limits; the three cross-IP `globalName` caps bound TOTAL scrypt work:
 * login 60/min, signup 20/h, recovery 20/h, invited-signup 100/h,
 * account-mgmt 60/h (v6 fold 4).
 */
const BUCKETS: Record<AuthBucketName, BudgetOpts> = {
  "auth-signup": {
    capacity: 5,
    refillPerMs: 5 / HOUR,
    globalName: "auth-signup-global",
    globalCapacity: 20,
    globalRefillPerMs: 20 / HOUR,
  },
  "auth-login-ip": {
    capacity: 10,
    refillPerMs: 10 / MIN,
    globalName: "auth-login-global",
    globalCapacity: 60,
    globalRefillPerMs: 60 / MIN,
  },
  "auth-login-id": { capacity: 5, refillPerMs: 5 / 300_000 },
  "auth-recovery-ip": {
    capacity: 5,
    refillPerMs: 5 / HOUR,
    globalName: "auth-recovery-global",
    globalCapacity: 20,
    globalRefillPerMs: 20 / HOUR,
  },
  "auth-recovery-id": { capacity: 3, refillPerMs: 3 / HOUR },
  // Per-ACCOUNT buckets (r2 revision 7): username and emailUnverified are TWO
  // addressable identifiers for one account, so identifier buckets alone give
  // an attacker 2× the intended budget. Keyed on CredentialUser.id, charged
  // AFTER identifier resolution succeeds and BEFORE any scrypt.
  "auth-login-acct": { capacity: 5, refillPerMs: 5 / 300_000 },
  "auth-recovery-acct": { capacity: 3, refillPerMs: 3 / HOUR },
  // Invited-signup (v5 fold 1): whole crews sign up behind ONE ship-WiFi/CGNAT
  // IP; a signup carrying a VALID adoptToken charges this bucket keyed by the
  // TOKEN and SKIPS the per-IP auth-signup bucket. Own global 100/h.
  "auth-signup-invited": {
    capacity: 3,
    refillPerMs: 3 / HOUR,
    globalName: "auth-signup-invited-global",
    globalCapacity: 100,
    globalRefillPerMs: 100 / HOUR,
  },
  // Step 13 account management (change-password / regenerate / claim-report):
  // ≤ 9 scrypts per op, globally capped 60/h (v6 fold 4 — the only
  // scrypt-running bucket that previously had no global cap).
  "auth-account-mgmt": {
    capacity: 5,
    refillPerMs: 5 / HOUR,
    globalName: "auth-account-mgmt-global",
    globalCapacity: 60,
    globalRefillPerMs: 60 / HOUR,
  },
};

/**
 * Charge one token from a named auth bucket. `key` is the per-bucket partition
 * key: an IP for the *-ip buckets, a first-16-hex sha256 identifier hash for
 * the *-id buckets (never the raw identifier — see idHash16), a
 * CredentialUser.id for the *-acct buckets, an adoptToken for
 * auth-signup-invited. Returns false when over-limit; the over-limit outcome is
 * recorded in the RATE_LIMITED aggregator below — callers must NEVER append a
 * per-request RATE_LIMITED line themselves.
 */
export function consumeAuthBudget(bucket: AuthBucketName, key: string): boolean {
  maybeRollWindow(Date.now());
  const ok = consumeBudget(bucket, key, BUCKETS[bucket]);
  if (!ok) recordRateLimited(bucket);
  return ok;
}

// ---- Hash helpers (never a raw identifier/IP in map keys, logs, or sinks) ----

/** First 16 hex of sha256(identifierLower) — the *-id bucket key + sink idHash. */
export function idHash16(identifierLower: string): string {
  return crypto.createHash("sha256").update(identifierLower).digest("hex").slice(0, 16);
}

// Date-rotated ipHash following the verify-uploads pattern (db.ts sink rule):
// HMAC-SHA256(ip, key = HMAC-SHA256(salt, YYYY-MM-DD)) — same-day abuse
// correlation works, long-term linkability dies with the day key. Unlike
// verify-uploads (which 503s when VERIFY_IP_SALT is unset), auth events must
// never fail for want of a salt: fall back to a per-process random salt (still
// date-rotated, never a raw IP, unlinkable across restarts).
let ephemeralIpSalt: string | null = null;

export function authIpHash(ip: string, at: Date = new Date()): string {
  const configured = process.env.VERIFY_IP_SALT;
  const salt =
    configured && configured.trim()
      ? configured.trim()
      : (ephemeralIpSalt ??= crypto.randomBytes(16).toString("hex"));
  const day = at.toISOString().slice(0, 10);
  const dayKey = crypto.createHmac("sha256", salt).update(day).digest();
  return crypto.createHmac("sha256", dayKey).update(ip).digest("hex");
}

// ---- RATE_LIMITED aggregation (r2 revision 1 — the append-cost fix) ---------
//
// appendAuditRaw re-reads the WHOLE auth-events sink per append under the
// app-wide mutex (db.ts; auth-events is NOT tail-cached and must not be added
// to the single-slot TAIL_CACHED_SINKS cache — it would thrash). A per-request
// RATE_LIMITED append is the one event an attacker can trigger without any
// bucket bounding it ⇒ attacker-controlled app-wide write stall + disk fill.
// Therefore: NO per-request RATE_LIMITED append, EVER. Over-limit outcomes are
// aggregated in memory and emitted as ONE line per bucket per 10-minute window
// carrying { bucket, count, firstAt, lastAt }. Flushing is LAZY — checked on
// the next auth event (any limiter call or auth-events append) and on window
// rollover; a window whose flush is delayed because traffic stopped simply
// flushes on the next event (acceptable for an abuse-forensics signal — raw
// per-request 429 visibility still exists in the nginx access logs).

const AGG_WINDOW_MS = 10 * MIN;

type RateLimitedAgg = { count: number; firstAt: string; lastAt: string };

let aggWindowStart = 0;
const aggregates = new Map<string, RateLimitedAgg>();

function flushAggregates(): Promise<unknown>[] {
  const appends: Promise<unknown>[] = [];
  for (const [bucket, a] of aggregates) {
    // Fire-and-forget on the hot path: the append rides the shared mutex; a
    // failed flush loses only an abuse-forensics aggregate, never a security
    // decision. The returned promises exist for the awaitable test hook.
    appends.push(
      appendAudit(
        "auth-events",
        {
          id: id(),
          at: new Date().toISOString(),
          type: "RATE_LIMITED",
          bucket,
          count: a.count,
          firstAt: a.firstAt,
          lastAt: a.lastAt,
        },
        AUDIT_NO_IMPERSONATION
      ).catch(() => {
        /* best-effort */
      })
    );
  }
  aggregates.clear();
  return appends;
}

function maybeRollWindow(now: number): void {
  const winStart = Math.floor(now / AGG_WINDOW_MS) * AGG_WINDOW_MS;
  if (winStart !== aggWindowStart) {
    if (aggregates.size > 0) flushAggregates();
    aggWindowStart = winStart;
  }
}

function recordRateLimited(bucket: string): void {
  const at = new Date().toISOString();
  const a = aggregates.get(bucket);
  if (a) {
    a.count++;
    a.lastAt = at;
  } else {
    aggregates.set(bucket, { count: 1, firstAt: at, lastAt: at });
  }
}

/**
 * Append one bucket-bounded credential-auth event to the auth-events sink.
 * `core` must follow the sink's hash-only rule ({ type, credId?, idHash?,
 * ipHash?, ... counts/enums } — NEVER a raw username, e-mail, IP, token, or
 * secret). Also runs the lazy RATE_LIMITED flush check (any auth event is a
 * flush opportunity). Use ONLY for standalone events with no db mutation; an
 * event that rides a db change goes through its transact's audit collector.
 */
export function appendAuthEvent(core: Record<string, unknown>): Promise<unknown> {
  maybeRollWindow(Date.now());
  return appendAudit("auth-events", { id: id(), at: new Date().toISOString(), ...core }, AUDIT_NO_IMPERSONATION);
}

// ---- Test hooks (mirrors resetRegistryAbuseState's role for the buckets) ----

/** Test hook: flush any pending RATE_LIMITED aggregates NOW (awaitable). */
export async function _flushRateLimitedAggregates(): Promise<void> {
  await Promise.all(flushAggregates());
}

/** Test hook: drop aggregator state (window + pending counts). */
export function _resetRateLimitedAggregates(): void {
  aggregates.clear();
  aggWindowStart = 0;
}
