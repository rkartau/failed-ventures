import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { auth } from "@/auth";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";
import { buildCvModel, renderCvHtml } from "@/lib/cv";

export const dynamic = "force-dynamic";

// GET /api/cv/<seafarerId>?token=<owner share token>
//
// A standalone, printable seafarer CV / certificate matrix (self-contained HTML the
// seaman can open, print, or "Save as PDF" and send to an agent). Authorisation is by
// POSSESSION of the seaman's OWN share token — the SAME trust model as /api/calendar
// and /api/files:
//   - matched Seafarer.openShareToken  -> serve (the token alone authorises).
//   - matched Seafarer.emailShareToken -> RESTRICTED: only a signed-in allow-listed
//     Google viewer, OR the owner's own seaman session, gets the CV.
//   - no / wrong / foreign token, or an id that doesn't match the token's owner -> 404,
//     revealing nothing.
//
// This route resolves NEITHER the agent-session role gate NOR the seaman-session role
// gate — it is a possession-token export exactly like /api/calendar — so it sits
// OUTSIDE the agent / seaman isolation guards by construction. The agent-facing copy of
// this CV is rendered client-side in the already-grant-scoped ReviewPanel (no agent
// data leaves the guard).

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const db = readDB();
  // CHOKEPOINT: open + gated email (PHASE0-CENSUS row 6). Sample subjects render a
  // CURATED (sample:true) CV only, rate-limited + publicly cacheable.
  const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
  if (subject === null || subject === SAMPLE_WRITE_DENIED) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const owner = subject.seafarer;
  if (subject.isSample && sampleTokenRateLimited(token)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  // The token must belong to the seafarer named in the path — a valid token cannot
  // be used to render a DIFFERENT seafarer's CV.
  if (owner.id !== params.id) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // PRIVATE (email) token: the token alone is NOT sufficient — same rule as the share
  // page, /api/files, and /api/calendar. Serve only to a signed-in allow-listed viewer,
  // or the owner's own seaman session. Anything else 404s.
  if (subject.mode === "email") {
    const gate = await evaluateShareAccess(owner, "email");
    let ok = gate.allowed;
    if (!ok) {
      const session = await auth();
      if (session?.role === "seaman" && session.seafarerId === owner.id) ok = true;
    }
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
  }

  const docs = subject.filterRows(db.documents.filter((d) => d.seafarerId === owner.id));
  const html = renderCvHtml(buildCvModel(owner, docs));

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": subject.isSample ? SAMPLE_CACHE_CONTROL : "no-store",
    },
  });
}
