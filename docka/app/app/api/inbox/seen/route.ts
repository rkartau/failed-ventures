import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { inboxRateLimited } from "@/lib/inbox";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// POST /api/inbox/seen  { seenAt }
//
// Advance the acting SEAMAN's single inbox highwater. `seenAt` is the `newestCreatedAt`
// the client got from GET /api/inbox (the createdAt of the newest circular that existed
// at read time) — NEVER server now() (F1). We set `inboxLastSeenAt = max(old, seenAt)`
// so the highwater only ever moves forward and a circular created between the GET and
// this debounced call stays unread. Idempotent by construction (a monotonic max).
//
// Scope: strictly the acting seafarerId's OWN record. The OPEN token path is allowed
// (harmless — it can only mark its own inbox seen) but rate-limited. The private
// `emailShareToken` never resolves here (D1).
export async function POST(req: NextRequest) {
  const db = readDB();

  const session = await seamanSession();
  const body = (await req.json().catch(() => ({}))) as { seenAt?: unknown; token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  // CHOKEPOINT: OPEN token only (PHASE0-CENSUS row 13). This is a WRITE (the
  // highwater stamp) — a sample subject's token gets the read-only 403 so the
  // public sample inbox performs ZERO writes.
  const tokenSubject =
    !session && token ? resolveTokenSubject(db, token, "write", ["open"]) : null;
  if (tokenSubject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
  const mySeafarerId = session ? session.seafarerId : tokenSubject ? tokenSubject.seafarer.id : null;

  if (!mySeafarerId) {
    return NextResponse.json(
      { ok: false, error: "Sign in as a seafarer or use your own link." },
      { status: 401 }
    );
  }
  if (inboxRateLimited(mySeafarerId)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  const seenAt = typeof body.seenAt === "string" ? body.seenAt : "";

  const inboxLastSeenAt = await updateDB((d) => {
    const seafarer = d.seafarers.find((s) => s.id === mySeafarerId);
    if (!seafarer) return null;
    const old = seafarer.inboxLastSeenAt ?? "";
    // Monotonic max — never regress, never use now().
    seafarer.inboxLastSeenAt = seenAt > old ? seenAt : old;
    return seafarer.inboxLastSeenAt;
  });

  if (inboxLastSeenAt === null) {
    return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, inboxLastSeenAt });
}
