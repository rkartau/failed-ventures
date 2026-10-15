import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type Comment } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
  pruneSampleReferences,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// Resolve the seafarer that OWNS a thread target, then authorise the caller against
// that owner under one of TWO trust models (mirroring /api/files and /api/seafarers),
// FAIL-CLOSED — default-deny for an anonymous or foreign caller:
//   - agent context  : a signed-in agent needs a LIVE grant to the owner (checkAccess,
//     TOCTOU-safe). Closes the id-oracle — a foreign documentId/seafarerId can no
//     longer be replayed to read another tenant's notes, nor a note written onto one.
//   - share context  : the seaman's /share/<token> link is opened WITHOUT a session;
//     possession of the OWNER share token authorises that seafarer's own dossier
//     (the existing share mechanism). A token for another seafarer resolves nothing.
// Both a documentId thread and a seafarerId thread are covered. Returns the ownerId
// on success, or a NextResponse (401/404/402) to return verbatim on denial.
//
// billing-guard: session-branch — R2-9. The billing tier is applied ONLY on the
// resolved-agent-session path below. The share-token branch is deliberately untouched:
// a blocked agency's seafarers must NEVER lose access to their own dossier (decision 6).
async function authorizeThread(
  documentId: string,
  seafarerId: string,
  token: string,
  intent: "read" | "write"
  // Return type widened to Response (not NextResponse): live denials are NextResponse,
  // but a billing-gate denial is a plain Response (lib/billing-enforce). NextResponse
  // extends Response, so the callers' `instanceof Response` catches BOTH.
): Promise<{ ownerId: string; sampleView: boolean } | Response> {
  const db = readDB();
  // A document thread inherits the owner of the document; a seafarer thread names
  // the owner directly. An unknown/foreign target resolves to no owner => 404.
  let ownerId: string | null = null;
  if (documentId) {
    ownerId = db.documents.find((d) => d.id === documentId)?.seafarerId ?? null;
  } else if (seafarerId) {
    ownerId = db.seafarers.some((s) => s.id === seafarerId) ? seafarerId : null;
  }
  if (!ownerId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const session = await agentSession();
  if (session?.user) {
    // CANONICAL ACTOR ORDER (F3, finding 19): `checkAccess` FIRST. With the gate first,
    // a blocked agent probing a FOREIGN-tenant id got 402 while a nonexistent id got
    // 404 — a cross-tenant existence oracle available to any agency that stopped paying.
    // Both now answer 404, identically.
    if (!checkAccess(session.agentId, ownerId).allowed) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    const billingGate =
      intent === "write" ? requireBillingWritable(session) : requireBillingReadable(session);
    if (!billingGate.ok) {
      // FINDING 8 / decision 6 — fall through to the OWNER token when the request
      // carries one: the seafarer at a shared browser is never blocked by their
      // agency's billing state. Resolve through the sample chokepoint (open token
      // only, PHASE0-CENSUS row 4) so token semantics match the share branch below.
      if (token) {
        const subject = resolveTokenSubject(db, token, intent, ["open"]);
        if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
        if (subject && subject.seafarer.id === ownerId) {
          return { ownerId, sampleView: subject.isSample };
        }
      }
      return billingGate.response;
    }
    return { ownerId, sampleView: false };
  }
  // No agent session: only the owner share token authorises (share-link context).
  // CHOKEPOINT: open token only (PHASE0-CENSUS row 4). Sample verdicts: token GET
  // -> curated FILTER; token POST -> 403 read-only.
  if (token) {
    const subject = resolveTokenSubject(db, token, intent, ["open"]);
    if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
    if (subject && subject.seafarer.id === ownerId) {
      return { ownerId, sampleView: subject.isSample };
    }
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
}

// GET /api/comments?documentId=...   -> notes on one document (grant-scoped)
//     /api/comments?seafarerId=...   -> agent notes on one seafarer (grant-scoped)
export async function GET(req: NextRequest) {
  const documentId = (req.nextUrl.searchParams.get("documentId") ?? "").trim();
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();

  if (!documentId && !seafarerId) {
    return NextResponse.json(
      { ok: false, error: "documentId or seafarerId is required." },
      { status: 400 }
    );
  }

  // FAIL-CLOSED for BOTH thread kinds: a signed-in agent with a live grant, OR the
  // owner share token (share-link context). Anything else => 401/404, no data.
  const auth = await authorizeThread(documentId, seafarerId, token, "read");
  if (auth instanceof Response) return auth;

  const db = readDB();
  const comments = db.comments
    .filter((c) => (documentId ? c.documentId === documentId : c.seafarerId === seafarerId))
    // Sample subjects render CURATED notes only — an agent's real note on a sample
    // thread never leaks through the public token read.
    .filter((c) => !auth.sampleView || c.sample === true)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return NextResponse.json({ ok: true, comments });
}

// POST /api/comments  { documentId? , seafarerId? , authorName, text }
// Exactly one of documentId / seafarerId identifies the thread.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    seafarerId?: string;
    authorName?: string;
    text?: string;
    /** Owner share token — authorises a note from the share-link (no-session) context. */
    token?: string;
  };

  const documentId = (body.documentId ?? "").trim();
  const seafarerId = (body.seafarerId ?? "").trim();
  const authorName = (body.authorName ?? "").trim() || "Anonymous";
  const text = (body.text ?? "").trim();
  const token = (body.token ?? "").trim();

  if ((!documentId && !seafarerId) || !text) {
    return NextResponse.json(
      { ok: false, error: "documentId or seafarerId, plus text, are required." },
      { status: 400 }
    );
  }

  // FAIL-CLOSED write: a signed-in agent with a live grant, OR the owner share token
  // (share-link context). A foreign / missing target or an unauthorised caller 404s
  // (or 401s) with NO write — no note can land on another tenant's seafarer/document.
  const auth = await authorizeThread(documentId, seafarerId, token, "write");
  if (auth instanceof Response) return auth;

  const comment: Comment = {
    id: id(),
    documentId: documentId || null,
    seafarerId: seafarerId || null,
    authorName,
    text,
    createdAt: new Date().toISOString(),
  };
  await updateDB((d) => {
    d.comments.push(comment);
    // Bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(d, auth.ownerId);
  });

  return NextResponse.json({ ok: true, comment });
}
