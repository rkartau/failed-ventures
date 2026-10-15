// lib/tracking-token.ts — HMAC-signed, self-describing per-recipient tracking
// tokens for the /o (open pixel) and /u (unsubscribe) endpoints (plan §2 B1).
//
// WHY A NEW MODULE (reuse note): lib/machine-token.ts is the repo's Bearer
// primitive — it verifies an OPAQUE token by comparing sha256(token) to a stored
// hash. That fits a server-to-server secret, but NOT a token that must TRAVEL in
// every sent email carrying {send_key, message_id, touch, event} so the endpoint
// can act without a lookup. This module therefore mirrors machine-token.ts's
// CONVENTIONS — pure decision logic (node:crypto only), FAIL-CLOSED on an unset
// secret, crypto.timingSafeEqual comparison, injectable env for tests — but
// implements a JWT-lite signed-payload scheme instead of a hashed opaque token.
//
// TOKEN FORMAT:  base64url(payload_json) "." base64url(HMAC-SHA256(secret, b64))
//   payload_json = {"send_key":…,"message_id":…,"touch":…,"event":…}  (fixed key
//   order). The signature is taken over the base64url payload STRING (JWT-style)
//   so verification never re-canonicalizes JSON.
//
// TRUST MODEL: tokens are per-recipient and PUBLIC BY NATURE — they ship in mail,
// so anyone who received the mail holds a valid token. That is fine: the token
// only lets its bearer (un)subscribe / mark-open THEIR OWN send_key. Forgery for
// a DIFFERENT send_key requires the HMAC secret. Dedup of replays happens at fold
// time by event_key (§2 C3), not here.
//
// FAIL-CLOSED: with TRACKING_HMAC_SECRET unset, verify returns `unconfigured`
// and the routes answer 503 for ALL of /o and /u (mirrors the Stripe webhook
// route's no-secret → 503 stance).

import crypto from "crypto";

export const TRACKING_SECRET_ENV = "TRACKING_HMAC_SECRET";

// "signup" (Increment 5 [R2-2]): the CTA-link token carried by outreach mail —
// payload pinned to {send_key, message_id:"cta-signup", touch:0, event:"signup"},
// deterministically re-minted by the pipeline at fill time [R3-A3]. Durable by
// design (no expiry — the link must live >= 3 weeks).
export type TrackingEventName = "open" | "unsub" | "signup";

export interface TrackingPayload {
  send_key: string;
  message_id: string;
  touch: number;
  event: TrackingEventName;
}

function readSecret(env: Record<string, string | undefined>): string | null {
  const s = (env[TRACKING_SECRET_ENV] ?? "").trim();
  return s.length > 0 ? s : null;
}

/** True when the HMAC secret is present — the routes gate their 503 on this. */
export function trackingSecretConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readSecret(env) !== null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Mint a signed token. Throws if the secret is unset (mint is a server-side,
 * pipeline-side operation that must never silently emit an unsigned token).
 * Exposed primarily so tests and the pipeline can generate matching tokens.
 */
export function mintTrackingToken(
  payload: TrackingPayload,
  env: Record<string, string | undefined> = process.env
): string {
  const secret = readSecret(env);
  if (!secret) throw new Error(`${TRACKING_SECRET_ENV} is unset — cannot mint a tracking token`);
  // Fixed key order so the encoded payload is stable.
  const json = JSON.stringify({
    send_key: payload.send_key,
    message_id: payload.message_id,
    touch: payload.touch,
    event: payload.event,
  });
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export type TrackingVerifyResult =
  | { ok: true; payload: TrackingPayload }
  | { ok: false; reason: "unconfigured" | "malformed" | "bad-signature" | "wrong-event" };

const EVENT_NAMES: ReadonlySet<string> = new Set(["open", "unsub", "signup"]);

/**
 * Verify a token. `expectEvent` pins the token to the endpoint reading it (an
 * `unsub` token presented to /o, or vice versa, is rejected `wrong-event`).
 * FAIL-CLOSED: no secret → `unconfigured` (caller returns 503). Any tamper →
 * `bad-signature`. Malformed structure/shape → `malformed`.
 */
export function verifyTrackingToken(
  token: string | null | undefined,
  expectEvent: TrackingEventName,
  env: Record<string, string | undefined> = process.env
): TrackingVerifyResult {
  const secret = readSecret(env);
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (typeof token !== "string" || token.length < 3 || token.length > 4096) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "malformed" };

  const body = token.slice(0, dot);
  const presentedSig = token.slice(dot + 1);
  if (presentedSig.length === 0) return { ok: false, reason: "malformed" };

  const expectedSig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(presentedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.send_key !== "string" ||
    typeof p.message_id !== "string" ||
    typeof p.touch !== "number" ||
    !Number.isInteger(p.touch) ||
    typeof p.event !== "string" ||
    !EVENT_NAMES.has(p.event)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const payload: TrackingPayload = {
    send_key: p.send_key,
    message_id: p.message_id,
    touch: p.touch,
    event: p.event as TrackingEventName,
  };
  if (payload.event !== expectEvent) return { ok: false, reason: "wrong-event" };
  return { ok: true, payload };
}
