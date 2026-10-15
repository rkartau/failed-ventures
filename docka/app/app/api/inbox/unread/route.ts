import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { inboxRateLimited } from "@/lib/inbox";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// GET /api/inbox/unread  → { count }
//
// The lightweight badge endpoint the seaman dashboard polls (jitter + on focus). Count
// = my circulars with `createdAt > inboxLastSeenAt`. Same fail-closed seaman scoping as
// /api/inbox: seaman SESSION first, else the OPEN share token (read-only); the private
// `emailShareToken` never resolves here (D1). Rate-limited per seafarerId.
export async function GET(req: NextRequest) {
  const db = readDB();

  const session = await seamanSession();
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  // CHOKEPOINT: OPEN token only (PHASE0-CENSUS row 12). Sample: curated count only.
  const tokenSubject =
    !session && token ? resolveTokenSubject(db, token, "read", ["open"]) : null;
  const subject =
    tokenSubject !== null && tokenSubject !== SAMPLE_WRITE_DENIED ? tokenSubject : null;
  const sampleView = subject?.isSample === true;
  const mySeafarerId = session ? session.seafarerId : subject ? subject.seafarer.id : null;

  if (!mySeafarerId) {
    return NextResponse.json(
      { ok: false, error: "Sign in as a seafarer or use your own link." },
      { status: 401 }
    );
  }
  if (inboxRateLimited(mySeafarerId)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  const lastSeen = db.seafarers.find((s) => s.id === mySeafarerId)?.inboxLastSeenAt ?? "";
  const count = db.circulars.filter(
    (c) =>
      c.recipientIds.includes(mySeafarerId) &&
      c.createdAt > lastSeen &&
      (!sampleView || c.sample === true)
  ).length;

  return NextResponse.json(
    { ok: true, count },
    sampleView ? { headers: { "Cache-Control": SAMPLE_CACHE_CONTROL } } : undefined
  );
}
