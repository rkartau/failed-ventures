// Claim-state model — the ONE shared derivation behind "is this roster row still an
// unclaimed placeholder awaiting its seaman, or a real owned/legacy profile?" Pure;
// no React; no `window`. Consumed by the board card model, ReviewPanel gating, the
// reminders `claim` kind, the seafarers importedEmail PATCH branch, and the
// hidden-crew delete predicate — so those surfaces can never fork a parallel notion
// of "claimed".
//
// TOKEN-LINT CONSTRAINT (tests/isolation-static.mjs TOKEN_REGEX): this module must
// NEVER reference the raw share-token field or any token builder — the word-bounded
// regex flags the bare token symbol, but the last-used timestamp field read below
// carries a longer name that does not match (an idle timestamp, not a secret). The
// claim LINK builder lives in components/claim-link.ts (components/ is not
// lint-scanned), never in lib/. This header must itself stay free of the bare symbol.

import type { Seafarer } from "@/lib/db";

/** 24h sliding idle window for the seaman self-access (?token=) path. SINGLE
 *  definition — app/api/seafarers/route.ts imports this instead of its local const. */
export const SELF_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

export type ClaimState =
  | { kind: "sample" } // isSample — never gated, no chip
  | { kind: "claimed" } // a real person owns the profile
  | { kind: "legacy-unowned" } // unowned, NOT agent-created → normal profile
  | { kind: "placeholder"; opened: false; linkStale: false }
  | { kind: "placeholder"; opened: true; openedAt: number; linkStale: boolean };

type OwnerPtrs = Pick<Seafarer, "googleSub" | "ownerEmail" | "credentialUserId">;
const has = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

/** Canonical ownership test (db.ts:115). Whitespace-only pointers are NOT ownership. */
export function isClaimed(s: OwnerPtrs): boolean {
  return has(s.googleSub) || has(s.ownerEmail) || has(s.credentialUserId);
}

/** PROVENANCE: a placeholder is an AGENT-CREATED row awaiting its seaman. */
export function hasPlaceholderProvenance(s: Pick<Seafarer, "invited" | "createdByAgentId">): boolean {
  return s.invited === true || has(s.createdByAgentId);
}

/** May `agentId` manage (mail / edit e-mail of) this placeholder? Stamped rows:
 *  creator only (mirrors the hidden-crew delete gate, lib/access.ts). Unstamped
 *  legacy imports (invited, no createdByAgentId): grant scope alone decides (caller
 *  is already grant-scoped). */
export function placeholderManagedBy(s: Pick<Seafarer, "createdByAgentId">, agentId: string): boolean {
  return !has(s.createdByAgentId) || s.createdByAgentId === agentId;
}

export function claimStateOf(
  s: OwnerPtrs & Pick<Seafarer, "isSample" | "invited" | "createdByAgentId" | "shareTokenLastUsedAt">,
  now: number = Date.now()
): ClaimState {
  if (s.isSample === true) return { kind: "sample" };
  if (isClaimed(s)) return { kind: "claimed" };
  if (!hasPlaceholderProvenance(s)) return { kind: "legacy-unowned" };
  const last = s.shareTokenLastUsedAt; // word-boundary-safe for the token lint
  if (typeof last !== "number") return { kind: "placeholder", opened: false, linkStale: false };
  return { kind: "placeholder", opened: true, openedAt: last, linkStale: now - last > SELF_ACCESS_TTL_MS };
}
