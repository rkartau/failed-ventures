import { NextRequest, NextResponse } from "next/server";
import {
  readDB,
  transact,
  id as newId,
  AUDIT_NO_IMPERSONATION,
  type IssuedSeaRecord,
} from "@/lib/db";
import { auth } from "@/auth";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { getSeafarerForAgent } from "@/lib/agentData";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
  pruneSampleReferences,
} from "@/lib/sample-guard";
import {
  buildContractModel,
  renderContractHtml,
  renderNoContractHtml,
  sanitizeContractTerms,
  type ContractKind,
} from "@/lib/contract";

export const dynamic = "force-dynamic";

// billing-guard: session-branch — R2-9. This route serves TWO trust models. The
// billing tier binds ONLY to the resolved agent-session path; the possession-token
// path is deliberately untouched, so a blocked agency never costs its seafarers
// access to their own data via /share, /portal or a share link (decision 6).
// (requireBillingReadable / requireBillingWritable both fail open on a session-less
// caller, which is what makes the token branch structurally exempt.)

// SEA / contract generation (#45).
//   - POST (agent) : generate a DRAFT SEA. UPSERTS a minimal issuedSeaTerms row keyed
//     to assignmentId (idempotent), audits EXPORTED, and returns the rendered draft.
//     Tenant-gated: the acting agent must hold the assignment.
//   - GET ?token=&assignmentId= (seaman) : the seaman downloads THEIR OWN issued SEA.
//     Ownership-404 replicated VERBATIM from /api/cv/[id] PLUS an assignment-ownership
//     check; terms are REHYDRATED from issuedSeaTerms (never a blank SEA). No record yet
//     => an explicit "no SEA issued" page.

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---- POST (agent generate) ---------------------------------------------
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const pathId = params.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to generate an agreement." },
      { status: 401 }
    );
  }

  // Fail-closed, grant-scoped, propagation-projected seafarer (no log — we audit EXPORTED).
  const scoped = getSeafarerForAgent(session.agentId, pathId, { log: false });
  if (!scoped) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const assignmentId = typeof body.assignmentId === "string" ? body.assignmentId.trim() : "";
  if (!assignmentId) {
    return NextResponse.json({ ok: false, error: "assignmentId is required." }, { status: 400 });
  }

  const db0 = readDB();
  const assignment = db0.assignments.find((a) => a.id === assignmentId) ?? null;
  // The assignment must belong to THIS seafarer AND be held by THIS agent.
  if (!assignment || assignment.seafarerId !== pathId || assignment.agentId !== session.agentId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const kind: ContractKind = body.kind === "contract" ? "contract" : "sea";
  const terms = sanitizeContractTerms(body.terms);
  const agencyOrg = db0.agents.find((a) => a.id === session.agentId)?.orgName ?? session.agentId;
  const identityVerifiedAtIssue = scoped.seafarer.identityVerified === true;
  const nowIso = new Date().toISOString();
  const grantId = checkAccess(session.agentId, pathId).grant?.id ?? null;

  const record = await transact((db, audit) => {
    // Upsert by assignmentId — regenerating updates the SAME row (no duplicate).
    let row = db.issuedSeaTerms.find((r) => r.assignmentId === assignmentId) ?? null;
    if (row) {
      row.terms = terms;
      row.identityVerifiedAtIssue = identityVerifiedAtIssue;
      row.issuedBy = agencyOrg;
      row.generatedAt = nowIso;
    } else {
      row = {
        id: newId(),
        assignmentId,
        seafarerId: pathId,
        agentId: session.agentId,
        terms,
        identityVerifiedAtIssue,
        issuedBy: agencyOrg,
        generatedAt: nowIso,
      } satisfies IssuedSeaRecord;
      db.issuedSeaTerms.push(row);
    }
    // Bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(db, pathId);
    audit("access-log", {
      id: newId(),
      at: nowIso,
      seafarerId: pathId,
      agentId: session.agentId,
      grantId,
      action: "EXPORTED",
      documentRef: assignmentId,
    });
    return { ...row };
  }, AUDIT_NO_IMPERSONATION);

  const model = buildContractModel({
    seafarer: scoped.seafarer,
    assignment,
    terms: record.terms,
    agencyOrg,
    kind,
    generatedAt: record.generatedAt,
  });
  return htmlResponse(renderContractHtml(model));
}

// ---- GET (seaman download) ---------------------------------------------
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const pathId = params.id;
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  const assignmentId = (req.nextUrl.searchParams.get("assignmentId") ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const db = readDB();
  // CHOKEPOINT: open + gated email (PHASE0-CENSUS row 7). Sample subjects render
  // CURATED (sample:true) assignments/terms only, rate-limited + cacheable.
  const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
  if (subject === null || subject === SAMPLE_WRITE_DENIED) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const owner = subject.seafarer;
  if (subject.isSample && sampleTokenRateLimited(token)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  // The token must belong to the seafarer named in the path.
  if (owner.id !== pathId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  if (subject.mode === "email") {
    const gate = await evaluateShareAccess(owner, "email");
    let allowed = gate.allowed;
    if (!allowed) {
      const session = await auth();
      if (session?.role === "seaman" && session.seafarerId === owner.id) allowed = true;
    }
    if (!allowed) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
  }

  // The assignment must exist AND belong to the TOKEN-resolved owner (never a
  // request-supplied seafarerId). Sample subjects resolve CURATED rows only.
  const assignment = db.assignments.find((a) => a.id === assignmentId) ?? null;
  if (
    !assignment ||
    assignment.seafarerId !== owner.id ||
    (subject.isSample && assignment.sample !== true)
  ) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Rehydrate the real issued terms — no record yet => explicit "no SEA" page.
  const record =
    db.issuedSeaTerms.find(
      (r) =>
        r.assignmentId === assignmentId &&
        r.seafarerId === owner.id &&
        (!subject.isSample || r.sample === true)
    ) ?? null;
  if (!record) {
    const empty = htmlResponse(renderNoContractHtml());
    if (subject.isSample) empty.headers.set("Cache-Control", SAMPLE_CACHE_CONTROL);
    return empty;
  }
  const agencyOrg =
    record.issuedBy || db.agents.find((a) => a.id === assignment.agentId)?.orgName || "Agency";
  const model = buildContractModel({
    seafarer: owner,
    assignment,
    terms: record.terms,
    agencyOrg,
    kind: "sea",
    generatedAt: record.generatedAt,
  });
  const res = htmlResponse(renderContractHtml(model));
  // Sample FILTER GETs are publicly cacheable (content immutable between seeds).
  if (subject.isSample) res.headers.set("Cache-Control", SAMPLE_CACHE_CONTROL);
  return res;
}
