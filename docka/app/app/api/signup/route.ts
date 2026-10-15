// feat/password-signup Step 6 — POST /api/signup (D1).
//
//   { side: "seaman" | "agent", username, password, email?, adoptToken?,
//     confirmBind? }
//
// Order (binding): (1) CSRF stance (lib/auth-csrf.ts — JSON MIME + Origin/
// Referer host check) BEFORE any rate-bucket charge; (2) the invited/walk-in
// bucket split (v5 fold 1 — a VALID adoptToken is a pure lookup, burns no
// scrypt, charges auth-signup-invited keyed by the TOKEN and SKIPS the per-IP
// bucket; invalid/absent tokens get the normal auth-signup IP + global
// buckets, so token guessing cannot bypass IP limits); (3) validation (i18n
// error keys); (4) create — or, when the username exists, the explicit
// side-bind arm (v5 fold 8: an AUTHENTICATION attempt — bindSideWithPassword
// charges auth-login-id/-acct itself, this route re-charges NOTHING).
//
// Bind-arm responses (no oracle beyond what a login attempt already gives):
//   - existing username + VERIFIED password + unbound side, no confirmBind
//       ⇒ { ok:false, needsBindConfirm:true }  (revealed only after verify)
//   - same with confirmBind:true ⇒ { ok:true, bound:true, side } — NO recovery
//     codes (none were minted; the account keeps its existing codes)
//   - wrong password, OR correct password with the side already bound/dangling
//     (v6 fold 6 — a dangling binding heals only via the 2f-b sign-in path)
//       ⇒ plain generic pw.errTaken, NEVER needsBindConfirm.
// Replay of a committed-but-response-lost signup therefore yields pw.errTaken
// and no duplicate user (usernameLower CAS); the codes cannot be re-shown —
// the client recovery for that case is Step 7's codes-lost flow.
//
// Success: { ok:true, recoveryCodes:[…8 plaintext…], username } — the ONLY
// time the codes exist in plaintext.

import { readDB } from "@/lib/db";
import {
  createCredentialUser,
  bindSideWithPassword,
  findAdoptableProfileByToken,
  coerceCredentialValue,
  validateUsername,
  validatePassword,
  usernameKey,
  type CredentialSide,
} from "@/lib/credential-auth";
import { consumeAuthBudget, clientIpFromHeaders } from "@/lib/auth-rate-limit";
import { sameOriginJsonOk } from "@/lib/auth-csrf";
import { verifyTrackingToken } from "@/lib/tracking-token";
import { sanitizeLeadKey } from "@/lib/booking";
import { appendEvent } from "@/lib/outreach-events";

export const dynamic = "force-dynamic";

/**
 * Outreach attribution (Increment 5): resolve an optional CTA token from the
 * body to a leadKey. SERVER-side re-verify (the /signup page's verify is only
 * a UX gate): HMAC token with expectEvent:"signup", then the ^LD\d{1,15}$
 * contract regex (reuse: lib/booking.sanitizeLeadKey — same rule as /api/book).
 * NEVER throws and NEVER blocks the signup — any failure (bad signature,
 * foreign secret, wrong event, malformed, unconfigured secret, off-contract
 * send_key) simply drops attribution and returns undefined.
 */
function resolveLeadKey(body: Record<string, unknown>): string | undefined {
  const token = body.leadToken;
  if (typeof token !== "string" || token.length === 0) return undefined;
  try {
    const v = verifyTrackingToken(token, "signup");
    if (!v.ok) return undefined;
    return sanitizeLeadKey(v.payload.send_key);
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  try {
    // (1) CSRF BEFORE any bucket charge — cross-origin junk burns no budget.
    if (!sameOriginJsonOk(req)) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
    }
    const side: CredentialSide | null =
      body.side === "seaman" ? "seaman" : body.side === "agent" ? "agent" : null;
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const email = coerceCredentialValue(body.email);
    const adoptToken = coerceCredentialValue(body.adoptToken);
    const confirmBind = body.confirmBind === true;
    if (!side) {
      return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 400 });
    }

    const ip = clientIpFromHeaders(req.headers);

    // (2) Invited vs walk-in bucket split (v5 fold 1). Validity is a PURE token
    // lookup (no scrypt): whole crews sign up behind ONE ship-WiFi/CGNAT IP, so
    // a valid claim token must not compete for the per-IP walk-in budget.
    const invited =
      side === "seaman" && adoptToken
        ? findAdoptableProfileByToken(readDB(), adoptToken) !== null
        : false;
    if (invited) {
      if (!consumeAuthBudget("auth-signup-invited", adoptToken as string)) {
        return Response.json({ ok: false, errorKey: "pw.errRate" }, { status: 429 });
      }
    } else if (!consumeAuthBudget("auth-signup", ip)) {
      return Response.json({ ok: false, errorKey: "pw.errRate" }, { status: 429 });
    }

    // (3) Validation — i18n error KEYS in the JSON, before any scrypt work.
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      return Response.json({ ok: false, errorKey: usernameErr }, { status: 400 });
    }
    const passwordErr = validatePassword(password);
    if (passwordErr) {
      return Response.json({ ok: false, errorKey: passwordErr }, { status: 400 });
    }

    // (4) Create — the pre-check just avoids burning 9 scrypt hashes on an
    // obviously-taken name; the CAS inside createCredentialUser stays the
    // authority under races (a lost race falls into the bind arm below, which
    // answers pw.errTaken exactly like any taken username).
    // Outreach attribution (Increment 5): verified-or-dropped, never blocking.
    const leadKey = resolveLeadKey(body);

    const exists = readDB().credentialUsers.some(
      (u) => u.usernameLower === usernameKey(username)
    );
    if (!exists) {
      const created = await createCredentialUser({
        side,
        username,
        password,
        email,
        adoptToken,
        clientIp: ip,
        leadKey,
      });
      if (created.ok) {
        // Append the `signup` outreach event AFTER the account committed.
        // Fail-soft: an event-sink hiccup can never flip the created 200
        // (mirrors /api/book's booking-event stance).
        if (leadKey) {
          try {
            // [R2-7] wrong-person-signup protection: carry the account's email
            // (when it has one — signups are username/password, email optional)
            // as an ADDITIVE row field for the pipeline's email-match fold.
            // Never in the event_key: the key stays [send_key,"","signup",user_id].
            await appendEvent({
              event: "signup",
              send_key: leadKey,
              user_id: created.user.id,
              ...(created.user.emailUnverified ? { email: created.user.emailUnverified } : {}),
            });
          } catch {
            /* never let the sink block a signup */
          }
        } else if (created.user.emailUnverified) {
          // TOKENLESS signup event (go-live readiness plan 2026-08-25 item 3):
          // an organic signup that PROVIDED AN EMAIL is still a signup the
          // pipeline must see — send_key is the EMPTY STRING (no verified CTA
          // attribution), the pipeline fold matches it to a lead by normalized
          // EXACT email only and DISCARDS no-matches. No email -> no event.
          // The schema key `email` and the row shape are pinned by the shared
          // fixture tests/fixtures/signup-tokenless-golden.json (contract test
          // in both repos). The tokened path above is untouched.
          try {
            await appendEvent({
              event: "signup",
              send_key: "",
              user_id: created.user.id,
              email: created.user.emailUnverified,
            });
          } catch {
            /* never let the sink block a signup */
          }
        }
        return Response.json({
          ok: true,
          recoveryCodes: created.recoveryCodes,
          username: created.user.username,
        });
      }
      if (created.errorKey !== "pw.errTaken") {
        return Response.json({ ok: false, errorKey: created.errorKey }, { status: 400 });
      }
      // lost the signup race — the username is taken now; fall into the bind arm
    }

    // Explicit side-bind arm (v5 fold 8 / D2). Charges its own auth buckets.
    const bind = await bindSideWithPassword({
      username,
      password,
      side,
      adoptToken,
      confirmBind,
      clientIp: ip,
    });
    if (bind.ok) {
      // Outreach: a successful side-bind via a valid CTA token is ALSO a
      // signup outcome — emit the event so the pipeline stops cold sends
      // (guard 15). No leadKey is stamped on the record: the account already
      // existed, "created account record" stamping is create-path only.
      if (leadKey) {
        try {
          const bound = readDB().credentialUsers.find(
            (u) => u.usernameLower === usernameKey(username)
          );
          if (bound) {
            // Same [R2-7] additive email field as the create path — the bound
            // account's stored (unverified) email, when present.
            await appendEvent({
              event: "signup",
              send_key: leadKey,
              user_id: bound.id,
              ...(bound.emailUnverified ? { email: bound.emailUnverified } : {}),
            });
          }
        } catch {
          /* never let the sink block a signup */
        }
      }
      return Response.json({ ok: true, bound: true, side: bind.side });
    }
    if ("needsBindConfirm" in bind && bind.needsBindConfirm) {
      return Response.json({ ok: false, needsBindConfirm: true });
    }
    // Wrong password / side already bound or dangling / over-limit — ONE
    // generic answer (v6 fold 6): pw.errTaken, never needsBindConfirm.
    return Response.json({ ok: false, errorKey: "pw.errTaken" }, { status: 400 });
  } catch {
    return Response.json({ ok: false, errorKey: "pw.errGeneric" }, { status: 500 });
  }
}
