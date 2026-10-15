import { NextRequest, NextResponse } from "next/server";
import { readDB, type Circular } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { findGrant, effectiveGrantStatus, isReadableStatus } from "@/lib/access";
import {
  inboxRateLimited,
  circularNewestFirst,
  pageCirculars,
  shapeReplyForSeaman,
  type InboxReplyView,
} from "@/lib/inbox";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// GET /api/inbox  — the signed-in SEAMAN's own in-app message inbox.
//
// IDENTITY (fail-closed): resolve the acting seaman from the seaman SESSION first
// (`seamanSession` → seafarerId, works on any device), else fall back to the OPEN
// share token (`?token=`, possession-trust, read-only). The PRIVATE `emailShareToken`
// never matches the open-token resolver, so an email-link holder WITHOUT a signed-in
// seaman session is rejected here (D1) — the private link must arrive with an
// allow-listed Google session via the /share gate, never straight at the inbox API.
//
// SCOPE: returns ONLY circulars this seafarerId is a recipient of (frozen
// `recipientIds` at send time), newest-first, paginated (compound cursor). Never
// returns `recipientIds` or any other recipient's email — a seaman sees the message
// body + who sent it, nothing about the rest of the crew.
//
// REPLIES (only when the circular opted in via `allowReplies`): the seaman's OWN
// replies (any visibility) always; peers' "everyone" replies ONLY on the AUTHENTICATED
// session path (never the token path, D1), anonymised to "A crew member" (D2), and
// gated by LIVE readability recomputed now (D3 read-forward): a departed crew member
// keeps their own history but sees no peer chatter posted after they left.
export async function GET(req: NextRequest) {
  const db = readDB();

  // --- Resolve the acting seaman (session first, then open token) ---
  const session = await seamanSession();
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const authenticated = Boolean(session);
  // CHOKEPOINT: OPEN token only (PHASE0-CENSUS row 11 — the private email token
  // never resolves here, D1). Sample subjects read CURATED circulars/replies only.
  const tokenSubject =
    !session && token ? resolveTokenSubject(db, token, "read", ["open"]) : null;
  const subject =
    tokenSubject !== null && tokenSubject !== SAMPLE_WRITE_DENIED ? tokenSubject : null;
  const sampleView = subject?.isSample === true;
  const mySeafarerId = session ? session.seafarerId : subject ? subject.seafarer.id : null;
  if (sampleView && sampleTokenRateLimited(token)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  if (!mySeafarerId) {
    return NextResponse.json(
      { ok: false, error: "Sign in as a seafarer or use your own link." },
      { status: 401 }
    );
  }

  // Per-seaman rate limit (abuse dampening; keyed by the resolved seafarerId).
  if (inboxRateLimited(mySeafarerId)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  // My circulars = every circular whose (frozen) recipient set includes me.
  // Sample subjects: CURATED (sample:true) circulars only.
  const mine: Circular[] = db.circulars.filter(
    (c) => c.recipientIds.includes(mySeafarerId) && (!sampleView || c.sample === true)
  );
  mine.sort(circularNewestFirst);

  // Highwater source (F1): the createdAt of the NEWEST circular that currently exists
  // for me — NEVER server now(). The client hands this straight to POST /api/inbox/seen
  // so a circular created AFTER this read still counts as unread.
  const newestCreatedAt = mine.length > 0 ? mine[0].createdAt : "";

  const lastSeen = db.seafarers.find((s) => s.id === mySeafarerId)?.inboxLastSeenAt ?? "";
  const unreadCount = mine.filter((c) => c.createdAt > lastSeen).length;

  // Page (newest-first, compound cursor).
  const cursor = (req.nextUrl.searchParams.get("cursor") ?? "").trim() || null;
  const { page, nextCursor } = pageCirculars(mine, cursor);

  const items = page.map((c) => {
    const allowReplies = c.allowReplies ?? false;
    let replies: InboxReplyView[] = [];
    if (allowReplies) {
      const all = db.circularReplies.filter(
        (r) => r.circularId === c.id && (!sampleView || r.sample === true)
      );
      // My own replies — always visible to me, any visibility.
      const own = all.filter((r) => r.seafarerId === mySeafarerId);
      // Peer "everyone" replies — authenticated path ONLY, with D3 read-forward.
      let peers = all.filter((r) => r.seafarerId !== mySeafarerId && r.visibility === "all");
      if (!authenticated) {
        peers = [];
      } else {
        const grant = findGrant(db, mySeafarerId, c.agentId);
        const eff = grant ? effectiveGrantStatus(grant, db.assignments) : null;
        const live = eff ? isReadableStatus(eff.status) : false;
        const cutoff = grant?.revokedAt ?? null;
        // Live recipient sees all peer chatter; a departed one sees only replies
        // posted up to their revoke instant. No grant / no revoke timestamp ⇒ none.
        peers = live ? peers : peers.filter((r) => cutoff != null && r.createdAt <= cutoff);
      }
      replies = [...own, ...peers]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => shapeReplyForSeaman(r, mySeafarerId));
    }
    return {
      id: c.id,
      subject: c.subject,
      message: c.message,
      authorName: c.authorName,
      createdAt: c.createdAt,
      allowReplies,
      unread: c.createdAt > lastSeen,
      replies,
    };
  });

  return NextResponse.json(
    {
      ok: true,
      items,
      nextCursor,
      newestCreatedAt,
      unreadCount,
      authenticated,
    },
    sampleView ? { headers: { "Cache-Control": SAMPLE_CACHE_CONTROL } } : undefined
  );
}
