// Server-side gate for the PUBLIC /share/<token> view (and the file API it calls).
//
// A seafarer now has TWO independent share links, and the MODE is decided by WHICH
// token the caller's URL matched (never a stored flag):
//   - matched Seafarer.openShareToken  -> "open" : the token alone opens the
//               documents, no login (the original open behaviour).
//   - matched Seafarer.emailShareToken -> "email": RESTRICTED. A viewer only sees
//               documents if they are signed in with Google AND their e-mail is on
//               the seafarer's `allowedEmails` list. The token alone is NOT enough.
//
// The caller passes the resolved `mode` in; this is the ONE place the decision is
// applied, so the share PAGE and the file-serving API enforce it identically. It
// reads the caller's Google identity via `auth()` only — it never trusts an id/token
// from the request for the allow-list check, and it resolves NO agent/seaman role
// symbol (so it does not affect the multi-tenant isolation guards, which key off
// agentSession/seamanSession).

import { auth } from "@/auth";
import type { DB, Seafarer } from "@/lib/db";

/** Trim + lower-case an e-mail for a case-insensitive allow-list compare. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Canonical share-token → seafarer resolution, matching the /share page order EXACTLY:
 *   1. `openShareToken`  -> mode "open"  (token alone opens the docs)
 *   2. `emailShareToken` -> mode "email" (RESTRICTED: caller must be signed-in + allow-listed)
 *   3. a `priorShareTokens[]` carried alias (post-merge) -> mode "alias" (VIEW-ONLY, never grants).
 * `aliasMode` carries the alias's ORIGINAL mode (open/email) so a caller that still needs
 * to run the share-mode gate on a carried alias (the /share page) does not lose it — an
 * email alias must stay email-gated and can never downgrade to open. The link endpoint
 * only cares that mode==="alias" (=> view-only skip). Final authorisation is always the
 * exact-equality match here, never a charclass guess.
 */
export function resolveSeafarerByShareToken(
  db: Pick<DB, "seafarers">,
  token: string
): { seafarer: Seafarer; mode: "open" | "email" | "alias"; aliasMode?: "open" | "email" } | null {
  const openMatch = db.seafarers.find((s) => s.openShareToken === token);
  if (openMatch) return { seafarer: openMatch, mode: "open" };
  const emailMatch = db.seafarers.find((s) => s.emailShareToken === token);
  if (emailMatch) return { seafarer: emailMatch, mode: "email" };
  for (const s of db.seafarers) {
    const alias = (s.priorShareTokens ?? []).find((p) => p.token === token);
    if (alias) return { seafarer: s, mode: "alias", aliasMode: alias.mode };
  }
  return null;
}

/**
 * Normalise a pasted share LINK or bare TOKEN to the raw token, or null when it can't
 * be a token. Tolerant of the REAL token alphabet: `shareToken()` is
 * `randomBytes(9).toString("base64url")`, whose alphabet INCLUDES `_` and `-` (so we do
 * NOT reuse `isSafeId`, which rejects `_`); trailing `=` padding is tolerated. Strips
 * protocol/host/query/hash/trailing-slash and takes the last path segment, so
 * `https://docka.me/share/<tok>?lang=et#x` and a bare `<tok>` both resolve. The
 * `decodeURIComponent` is wrapped in try/catch → null, so a crafted malformed-`%` row
 * can never throw (the batch route must not 500 on one bad row). The charclass is only a
 * cheap guard; the authoritative check is the exact-equality resolve against the DB.
 */
export function parseShareToken(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  // Drop query + hash, then any trailing slashes, then take the last non-empty segment.
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const segs = s.split("/").filter(Boolean);
  s = segs.length ? segs[segs.length - 1] : "";
  if (!s) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return null; // malformed %-escape — never throw / 500 on a bad row
  }
  decoded = decoded.trim();
  if (decoded.length === 0 || decoded.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(decoded)) return null;
  return decoded;
}

export type ShareGate =
  | { allowed: true; mode: "open"; viewerEmail: string | null }
  | { allowed: true; mode: "email"; viewerEmail: string }
  | { allowed: false; mode: "email"; reason: "need-signin"; viewerEmail: null }
  | { allowed: false; mode: "email"; reason: "not-allowed"; viewerEmail: string };

/**
 * Decide whether the CURRENT caller (by their signed-in Google session, if any) may
 * open this seafarer's shared documents. Fail-closed for "email" mode: no session, or
 * a session whose e-mail is not on the list, is denied. "open" mode always allows.
 */
export async function evaluateShareAccess(
  seafarer: Pick<Seafarer, "allowedEmails">,
  mode: "open" | "email"
): Promise<ShareGate> {
  const session = await auth();
  const viewerEmail = session?.user?.email ? normalizeEmail(session.user.email) : null;

  if (mode === "open") return { allowed: true, mode: "open", viewerEmail };

  if (!viewerEmail) return { allowed: false, mode: "email", reason: "need-signin", viewerEmail: null };

  const allow = (seafarer.allowedEmails ?? []).map(normalizeEmail).filter(Boolean);
  if (allow.includes(viewerEmail)) return { allowed: true, mode: "email", viewerEmail };

  return { allowed: false, mode: "email", reason: "not-allowed", viewerEmail };
}
