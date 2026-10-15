// feat/password-signup Step 13c (v6 fold 3) — POST /api/account/claim-report
//
//   { token }
//
// The "tiny session-gated report POST": an ALREADY-SIGNED-IN user opened
// someone's claim link; the token is deliberately not adopted (invariant 7 —
// a bound user never re-adopts) but must not be silently ignored either
// (fold 7). This route records the visit as an ADOPT_SKIPPED auth-event
// carrying the token's idHash ONLY (first 16 hex of sha256 — NEVER the raw
// token: it is a live claim secret for someone else's profile).
//
// Order: (1) CSRF stance; (2) session gate — any signed-in session (password
// account validated via the Step 5 validators, or a Google session); (3)
// auth-account-mgmt bucket charged BEFORE any work (5/h/actor, global 60/h);
// (4) the body token is validated by pure LOOKUP (resolves to a real profile's
// claim token — no scrypt, no mutation); (5) appendAuthEvent(ADOPT_SKIPPED).

import { readDB } from "@/lib/db";
import { coerceCredentialValue } from "@/lib/credential-auth";
import { resolveTokenSubject, SAMPLE_WRITE_DENIED } from "@/lib/sample-guard";
import { claimReportActor } from "@/lib/account-session";
import { consumeAuthBudget, idHash16, appendAuthEvent } from "@/lib/auth-rate-limit";
import { sameOriginJsonOk } from "@/lib/auth-csrf";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!sameOriginJsonOk(req)) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 403 });
    }
    const actor = await claimReportActor();
    if (!actor) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 401 });
    }
    // Bucket BEFORE any work — the append below is what the bucket bounds.
    if (!consumeAuthBudget("auth-account-mgmt", actor.key)) {
      return Response.json({ ok: false, errorKey: "pw.errRate" }, { status: 429 });
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const token = coerceCredentialValue(body?.token);
    if (!token) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
    }
    // Pure lookup via the CHOKEPOINT (open + email — PHASE0-CENSUS row 21; the
    // deprecated shareToken alias is always equal to openShareToken). A SAMPLE
    // subject's token reports the SAME generic negative as an unknown token
    // (DENY-as-unclaimable — no oracle distinguishing "sample" from "unknown").
    const db = readDB();
    const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
    const resolves = subject !== null && subject !== SAMPLE_WRITE_DENIED && !subject.isSample;
    if (!resolves) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
    }
    await appendAuthEvent({
      type: "ADOPT_SKIPPED",
      idHash: idHash16(token), // hash only — never the raw token
      ...(actor.credId ? { credId: actor.credId } : {}),
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 500 });
  }
}
