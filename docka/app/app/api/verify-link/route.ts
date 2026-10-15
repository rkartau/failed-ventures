import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { resolveTokenSubject, SAMPLE_WRITE_DENIED } from "@/lib/sample-guard";
import {
  documentIdForShareToken,
  proofDocIdForOwner,
  publicVerifyPath,
} from "@/lib/verify-record";

export const dynamic = "force-dynamic";

// GET /api/verify-link?documentId=<id>&token=<share token>
//
// Returns the PUBLIC outward re-verification path for a government-verified document,
// authorised by a SHARE TOKEN the caller already holds (the seaman's own open/private
// token, or an agent access-grant token that already opens this seafarer's documents).
// The returned link is public by design — strictly less sensitive than the documents
// the same token already reveals — so this is the mint point used by the seaman page
// and the shared view to draw the QR. It resolves NO agent session (stays outside the
// tenant-isolation gate) and returns nothing for a non-verified document or a token
// that does not open the document's owning seafarer.
//
// D6 v4 chokepoint (Phase 7): the SEAMAN-token half resolves through
// resolveTokenSubject, pinned to today's exact acceptance — open + (ungated) email,
// census row 8; the deprecated `shareToken` field is the open value, aliases stay
// rejected. A token matching NO seafarer falls through to the audited grant-token
// resolver in lib/verify-record (allowlisted lib). Both halves share ONE
// eligibility core (proofDocIdForOwner), so the proofEligible + ownership +
// sample-curated rules can never drift.
export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get("documentId") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";

  const db = readDB();
  const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
  const resolvedId =
    subject && subject !== SAMPLE_WRITE_DENIED
      ? proofDocIdForOwner(db, subject.seafarer, documentId)
      : documentIdForShareToken(token, documentId);
  if (!resolvedId) {
    return NextResponse.json(
      { ok: false, error: "Not authorised or not a verified credential." },
      { status: 403 }
    );
  }

  return NextResponse.json({ ok: true, path: publicVerifyPath(resolvedId) });
}
