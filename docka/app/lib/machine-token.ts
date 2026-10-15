// lib/machine-token.ts — shared machine-token (Bearer) auth for the two
// automation endpoints of the lead/campaign data loop (PIPELINE_BUILD_SPEC
// §13 + §15):
//
//   scope "outreach-upload" — POST /api/admin/outreach   (pipeline `publish`)
//   scope "leads-read"      — GET  /api/admin/leads/export (pipeline
//                             `import-leads --source docka`)
//
// Security model (repo conventions, mirrored from credential-auth.ts /
// verify-record.ts):
//   * Tokens are NEVER stored on the server. `.env.local` on the box carries
//     only the SHA-256 hex digest of each token:
//         OUTREACH_UPLOAD_TOKEN_HASH=<64 hex>
//         LEADS_READ_TOKEN_HASH=<64 hex>
//     Set/rotate = replace that ONE line (hash of the new token) + `pm2
//     restart docka`. Generate a token with `openssl rand -hex 32`; hash it
//     with `echo -n "<token>" | sha256sum`. (Raw random 256-bit tokens need no
//     scrypt stretching — offline brute force of the digest is infeasible —
//     so a fast hash + timingSafeEqual is the right primitive here.)
//   * FAIL CLOSED: scope's env var unset, empty, or not exactly 64 hex chars
//     -> every token is rejected (the endpoint's token path is simply OFF).
//   * Constant-time: the presented token is hashed and the two 32-byte
//     digests compared with crypto.timingSafeEqual (pattern:
//     verify-record.ts:86). Hashing first also makes the comparison
//     length-independent — no early exit on token length.
//   * The two scopes are DISTINCT credentials: an upload token presented to
//     the read endpoint (or vice versa) fails, because each scope only ever
//     consults its own env hash.
//
// This module is PURE decision logic (node:crypto only — server-side routes
// only, never a client island). The routes own session fallback, rate
// limiting (lib/registry consumeBudget, directory-route pattern) and HTTP
// status mapping.

import crypto from "crypto";

export type MachineScope = "outreach-upload" | "leads-read";

/** scope -> the .env.local key holding the sha256 hex digest of its token. */
export const SCOPE_ENV_KEYS: Record<MachineScope, string> = {
  "outreach-upload": "OUTREACH_UPLOAD_TOKEN_HASH",
  "leads-read": "LEADS_READ_TOKEN_HASH",
};

/** Sanity bounds on a presented bearer token (ours are 64 hex chars). */
const MIN_TOKEN_CHARS = 16;
const MAX_TOKEN_CHARS = 512;

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Extract the token from an `Authorization: Bearer <token>` header value.
 * Anything else (missing header, other scheme, empty/oversized token) -> null.
 */
export function parseBearerToken(authHeader: string | null | undefined): string | null {
  if (typeof authHeader !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!m) return null;
  const token = m[1];
  if (token.length < MIN_TOKEN_CHARS || token.length > MAX_TOKEN_CHARS) return null;
  return token;
}

export type MachineAuthResult =
  | { ok: true; actor: `machine:${MachineScope}` }
  /**
   * no-bearer      — no usable Bearer credential was presented (routes fall
   *                  back to their session behaviour: 404/401, unchanged).
   * unconfigured   — a Bearer WAS presented but the scope's hash env var is
   *                  absent/malformed: the token path is off, deny.
   * invalid        — a Bearer was presented and does not match.
   */
  | { ok: false; reason: "no-bearer" | "unconfigured" | "invalid" };

/**
 * Decide machine access for one scope from the raw Authorization header.
 * `env` is injectable for tests; defaults to process.env.
 */
export function verifyMachineToken(
  authHeader: string | null | undefined,
  scope: MachineScope,
  env: Record<string, string | undefined> = process.env
): MachineAuthResult {
  const token = parseBearerToken(authHeader);
  if (token === null) return { ok: false, reason: "no-bearer" };

  const configured = (env[SCOPE_ENV_KEYS[scope]] ?? "").trim().toLowerCase();
  if (!HEX64_RE.test(configured)) return { ok: false, reason: "unconfigured" };

  const presented = crypto.createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(configured, "hex");
  // Both buffers are always 32 bytes here, so timingSafeEqual never throws.
  if (!crypto.timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, actor: `machine:${scope}` };
}

// ---- Rate-limit constants (consumed by the routes via lib/registry) --------
//
// One shared "machine-token" bucket namespace, keyed per client IP
// (directory-route pattern). The loop's legitimate traffic is ~1 upload +
// ~1 export fetch per pipeline cycle, so 30 burst / 30-per-minute refill is
// two orders of magnitude of headroom while still bounding token guessing
// and export-download hammering. In-memory, resets on pm2 restart — same
// accepted stance as every other limiter in this codebase.

export const MACHINE_TOKEN_BUCKET = "machine-token";
export const MACHINE_TOKEN_BUDGET = {
  capacity: 30,
  refillPerMs: 30 / 60_000,
} as const;
