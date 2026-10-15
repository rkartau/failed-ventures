import { NextRequest, NextResponse } from "next/server";
import { updateDB, id, type CircularReply } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { findGrant, effectiveGrantStatus, isReadableStatus } from "@/lib/access";
import { inboxRateLimited, shapeReplyForSeaman } from "@/lib/inbox";

export const dynamic = "force-dynamic";

// POST /api/inbox/reply  { circularId, body, visibility, idempotencyKey }
//
// The return leg of in-app messaging: a recipient seaman replies to a circular.
//
// D1 — AUTHENTICATED SEAMAN SESSION ONLY. There is NO share-token path here (the open
// token resolves READ surfaces only). A caller without a live `seamanSession` — an
// open-link or email-link holder — is rejected 403 before any work. This route must
// NEVER reference the token resolver; the static isolation guard enforces that as a
// hard fail so a future edit can't quietly re-open a token-authorised write.
//
// The ENTIRE authorization gate AND the insert run inside ONE `updateDB` mutator on the
// SAME db handle (no read-then-write TOCTOU): (1) the circular exists and I am a frozen
// recipient; (2) it opted into replies (`allowReplies === true`, never trusting the
// client); (3) my grant to the sending agency is LIVE right now (re-derived on this
// handle — a departed/revoked seaman cannot post, D3); (4) visibility is whitelisted to
// {agent, all} (default agent); (5) the body is non-empty after trim and length-capped;
// (6) idempotency — a repeat of the same client `idempotencyKey`, or the identical body
// within a ~10s retry window, returns the existing row instead of a duplicate (F2).
const MAX_REPLY_BODY = 2000;
const DEDUP_WINDOW_MS = 10_000;

type ReplyResult =
  | { kind: "ok"; reply: CircularReply }
  | { kind: "duplicate"; reply: CircularReply }
  | { kind: "not_found" }
  | { kind: "forbidden"; error: string }
  | { kind: "bad_request"; error: string };

export async function POST(req: NextRequest) {
  // D1: session is the ONLY accepted identity. No token fallback, ever.
  const session = await seamanSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Sign in as a seafarer to reply." },
      { status: 403 }
    );
  }
  const mySeafarerId = session.seafarerId;

  // Abuse dampening, keyed by the resolved seafarerId (same limiter as the read routes).
  if (inboxRateLimited(mySeafarerId)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  const raw = (await req.json().catch(() => ({}))) as {
    circularId?: unknown;
    body?: unknown;
    visibility?: unknown;
    idempotencyKey?: unknown;
  };
  const circularId = typeof raw.circularId === "string" ? raw.circularId : "";
  const body = typeof raw.body === "string" ? raw.body.trim().slice(0, MAX_REPLY_BODY) : "";
  // Whitelist server-side (F6): anything other than "all" collapses to the safe default.
  const visibility: "agent" | "all" = raw.visibility === "all" ? "all" : "agent";
  const idempotencyKey =
    typeof raw.idempotencyKey === "string" ? raw.idempotencyKey.trim() : "";

  if (!circularId) {
    return NextResponse.json({ ok: false, error: "Missing message reference." }, { status: 400 });
  }
  if (!body) {
    return NextResponse.json({ ok: false, error: "Write a reply first." }, { status: 400 });
  }
  // F2: the idempotency key is REQUIRED per submit so an accidental double-fire dedups.
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "Missing request key." }, { status: 400 });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const result = await updateDB<ReplyResult>((db) => {
    const circular = db.circulars.find((c) => c.id === circularId);
    // Don't disclose the existence of a circular I'm not a recipient of.
    if (!circular || !circular.recipientIds.includes(mySeafarerId)) {
      return { kind: "not_found" };
    }
    // Server-enforced: legacy / opt-out circulars are read-only (read as ?? false).
    if ((circular.allowReplies ?? false) !== true) {
      return { kind: "forbidden", error: "Replies are not open on this message." };
    }
    // D3 / Tester#3: re-derive the grant on THIS handle — a revoked or expired seaman
    // (no live assignment) cannot post. No grant ⇒ no access.
    const grant = findGrant(db, mySeafarerId, circular.agentId);
    const eff = grant ? effectiveGrantStatus(grant, db.assignments) : null;
    if (!eff || !isReadableStatus(eff.status)) {
      return { kind: "forbidden", error: "Your access to this agency is no longer active." };
    }

    // (6) Idempotency — PRIMARY: same client key (scoped to me). Returns the stored row.
    const byKey = db.circularReplies.find(
      (r) => r.seafarerId === mySeafarerId && r.idempotencyKey === idempotencyKey
    );
    if (byKey) return { kind: "duplicate", reply: byKey };
    // FALLBACK: identical body on the same circular within the retry window. Honest
    // repeat replies later ("ok" at 09:00 and 15:00) fall OUTSIDE the window and persist.
    const byBody = db.circularReplies.find(
      (r) =>
        r.circularId === circularId &&
        r.seafarerId === mySeafarerId &&
        r.body === body &&
        now - new Date(r.createdAt).getTime() <= DEDUP_WINDOW_MS
    );
    if (byBody) return { kind: "duplicate", reply: byBody };

    const seafarer = db.seafarers.find((s) => s.id === mySeafarerId);
    if (!seafarer) return { kind: "not_found" };
    // Sample belt-and-braces (census row 14): no session can exist for a sample
    // row, but even a dev-door session must never write as one.
    if (seafarer.isSample === true) {
      return { kind: "forbidden", error: "Sample data is read-only." };
    }

    const reply: CircularReply = {
      id: id(),
      circularId,
      agentId: circular.agentId, // denormalised owning tenant → agent reads filter on it
      seafarerId: mySeafarerId,
      authorName: seafarer.name, // REAL name — shown to the agent only; peers see anon
      body,
      visibility,
      idempotencyKey,
      createdAt: nowIso,
    };
    db.circularReplies.push(reply);
    return { kind: "ok", reply };
  });

  switch (result.kind) {
    case "not_found":
      return NextResponse.json({ ok: false, error: "Message not found." }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ ok: false, error: result.error }, { status: 403 });
    case "bad_request":
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    case "duplicate":
    case "ok":
      // Return the reply shaped for MY view (author = "You"); the client appends it.
      return NextResponse.json(
        { ok: true, reply: shapeReplyForSeaman(result.reply, mySeafarerId) },
        { status: result.kind === "ok" ? 201 : 200 }
      );
  }
}
