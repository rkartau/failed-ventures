import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readDB, type Doc } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable } from "@/lib/billing-enforce";
import { impersonationStampFor } from "@/lib/impersonation";
import { resolveDocumentForAgent } from "@/lib/agentData";
import { auth } from "@/auth";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// billing-guard: session-branch — R2-9. This route serves TWO trust models. The
// billing tier binds ONLY to the resolved agent-session path; the possession-token
// path is deliberately untouched, so a blocked agency never costs its seafarers
// access to their own data via /share, /portal or a share link (decision 6).
// (requireBillingReadable / requireBillingWritable both fail open on a session-less
// caller, which is what makes the token branch structurally exempt.)

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// A documentRef is an OPAQUE document ID (uuid shape). A path, traversal sequence,
// null byte, or percent-encoded dot can never be a real ID, so it is rejected
// BEFORE any db or disk access — a crafted ref never reaches the filesystem.
function isSafeId(ref: string): boolean {
  if (ref.length === 0 || ref.length > 200) return false;
  return /^[A-Za-z0-9-]+$/.test(ref);
}

// GET /api/files/<documentRef>[?token=<shareToken>]
//
// The URL carries the document's opaque ID (documentRef), NEVER a filename. The
// document is resolved ONLY via a db lookup scoped to the caller — never a
// path-join — and the file is then served strictly by the resolved doc's own
// `fileName` field:
//   - agent context  -> resolveDocumentForAgent(agentId, ref) (fail-closed: a
//     foreign / missing / traversal / null-byte ref returns null => 404, no disk
//     read; a grant-scoped hit is logged as a DOWNLOAD-level action).
//   - seafarer/share -> a ?token matching the ref's OWNER share token authorises
//     the owner's own documents (the existing share mechanism).
// Anything else => 404. There is no path where an unauthenticated caller who
// merely knows a filename can pull a foreign document.
export async function GET(
  req: NextRequest,
  { params }: { params: { name: string } }
) {
  const ref = params.name;
  if (!isSafeId(ref)) {
    return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  }

  let doc: Doc | null = null;
  let sampleSubject = false;

  const token = req.nextUrl.searchParams.get("token");
  if (token) {
    // Seafarer / share context — CHOKEPOINT resolution (lib/sample-guard, plan D4),
    // pinned to TODAY'S modes for this route: open + gated email (PHASE0-CENSUS
    // row 3). The mode still follows WHICH token matched, identical to the
    // /share/<token> page. A sample subject serves CURATED (sample:true)
    // documents only (FILTER verdict), rate-limited + publicly cacheable.
    const db = readDB();
    const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
    const owner =
      subject !== null && subject !== SAMPLE_WRITE_DENIED ? subject.seafarer : undefined;
    sampleSubject = subject !== null && subject !== SAMPLE_WRITE_DENIED && subject.isSample;
    if (sampleSubject && sampleTokenRateLimited(token)) {
      return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
    }
    const shareLinkMode: "open" | "email" =
      subject !== null && subject !== SAMPLE_WRITE_DENIED && subject.mode === "email"
        ? "email"
        : "open";
    const found = db.documents.find((d) => d.id === ref) ?? null;
    const candidate = sampleSubject && found?.sample !== true ? null : found;
    if (owner && candidate && candidate.seafarerId === owner.id) {
      if (shareLinkMode === "email") {
        // PRIVATE (email) link: the token alone is NOT sufficient — same rule as the
        // share page. Serve the file only to (a) a signed-in Google viewer whose
        // e-mail is on the allow-list, or (b) the OWNER viewing their own dashboard
        // (role + owned seafarer id read straight off the auth session, so this module
        // resolves no extra role helper and stays agent-only for the isolation guard).
        // Anything else 404s, so a leaked private link cannot pull files.
        const gate = await evaluateShareAccess(owner, "email");
        let ok = gate.allowed;
        if (!ok) {
          const session = await auth();
          if (session?.role === "seaman" && session.seafarerId === owner.id) ok = true;
        }
        if (ok) doc = candidate;
      } else {
        doc = candidate;
      }
    }
  } else {
    // Agent context: fail-closed, grant-scoped resolution of the ref.
    const session = await agentSession();
    const billingGate = requireBillingReadable(session);
    if (!billingGate.ok) return billingGate.response;
    if (session?.user) {
      doc = resolveDocumentForAgent(session.agentId, ref, impersonationStampFor(session));
    }
  }

  if (!doc || !doc.fileName) {
    return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  }

  // Serve STRICTLY by the resolved doc's own fileName — never the raw ref. The
  // basename guard is belt-and-braces; fileName is server-generated on upload.
  const name = path.basename(doc.fileName);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  }

  const buf = fs.readFileSync(filePath);
  const ext = path.extname(name).toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": sampleSubject ? SAMPLE_CACHE_CONTROL : "no-store",
    },
  });
}
