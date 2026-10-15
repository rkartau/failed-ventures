import Link from "next/link";
import { readDB } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { impersonationStampFor } from "@/lib/impersonation";
import { SignInGate } from "@/components/SignInGate";
import { ReviewPanel } from "@/components/ReviewPanel";
import { duplicateNameIndex } from "@/lib/duplicates";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { getSeafarerForAgent, listSeafarersForAgent } from "@/lib/agentData";
import { hasActiveAssignment, activeAssignmentsFor } from "@/lib/access";

export const dynamic = "force-dynamic";

export default async function AgentReviewPage({ params }: { params: { id: string } }) {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  // GRANT-SCOPED read: returns null (=> 404) unless THIS agent holds a live grant
  // to this seafarer. Opening the single-seaman review is a REVIEW-level action, so
  // this call also writes a REVIEWED entry to the tamper-evident access log (that is
  // what the seaman's "Access & reviews" view surfaces). Medical gating is OFF
  // (owner D3): a granted agent sees documents in full, medical certs included.
  const scoped = getSeafarerForAgent(session.agentId, params.id, {
    onBehalf: impersonationStampFor(session),
  });
  if (!scoped) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Seafarer not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          This seafarer has not granted you access, or the grant is no longer active.
        </p>
        <Link
          href="/agent"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }
  const seafarer = scoped.seafarer;

  const db = readDB();
  const documents = scoped.documents
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const notes = db.comments
    .filter((c) => c.seafarerId === seafarer.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const restHours = db.restHours
    .filter((e) => e.seafarerId === seafarer.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Fleet-wide duplicate-number index (over ALL documents) so a certificate number
  // shared with another crew member is flagged on this review page — but a crew
  // member THIS agent may not see is masked, so no foreign name leaks here.
  const visibleIds = new Set(listSeafarersForAgent(session.agentId, false).map((s) => s.id));
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (id) =>
    visibleIds.has(id) ? nameById.get(id) ?? id : "another crew member"
  );

  // Per-agent required-docs config (defaults to the researched baseline).
  const requiredConfig = getConfigForAgent(session.agentId);

  // This agent's document-request checklist for this seafarer. Tenant-scoped: rows
  // are filtered to the acting agent's tenant, and the seafarer itself only reached
  // here via the fail-closed getSeafarerForAgent grant check above.
  const docRequests = db.docRequests
    .filter((r) => r.seafarerId === seafarer.id && r.agentId === session.agentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // The seaman's self-service profile-change queue for this seafarer. Seaman-owned
  // (not agent-partitioned): any granted agent may approve/reject, and this agent
  // only reached the seafarer via the fail-closed getSeafarerForAgent grant check.
  const profileChanges = db.profileChanges
    .filter((r) => r.seafarerId === seafarer.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // This seafarer's sea-service ledger (digital discharge book). The seafarer was
  // only reached via the fail-closed getSeafarerForAgent grant check above, so no
  // foreign ledger is exposed here.
  const seaService = db.seaService
    .filter((e) => e.seafarerId === seafarer.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // #38.5 — agent-side "request profile access" state (tenant-scoped to THIS agent's
  // own grant on this seafarer). `profileShared` = the seaman has already consented to
  // the personal-profile (contact/CV) overlay for this agency; `requestPending` = this
  // agent already has an undecided request outstanding. The button is only offered when
  // neither is true, so an agent onboarding an unreachable seaman can ping them to
  // consent later without ever self-granting visibility.
  const actingGrant = db.accessGrants.find(
    (g) =>
      g.agentId === session.agentId &&
      g.seafarerId === seafarer.id &&
      g.status === "ACTIVE"
  );
  // #41 — is the employment doc-set (SEA/wage/allotment) in scope? True iff THIS agent
  // holds a live assignment for this seaman. Reuses the same sea-lock predicate the
  // grant/lock logic uses, so "assigned" means exactly one thing across the app.
  const assigned = hasActiveAssignment(seafarer.id, session.agentId, db.assignments);
  // DEF-6 — the acting agent's live assignment id, threaded to the Generate SEA
  // panel so the "Assignment id" field is pre-filled (agent never hand-copies an
  // opaque id). null when no live assignment (field stays empty, still editable).
  const liveAssignmentId =
    activeAssignmentsFor(seafarer.id, session.agentId, db.assignments)[0]?.id ?? null;

  const profileShared = actingGrant?.propagateContact === true;
  const requestPending = db.profileShareRequests.some(
    (r) =>
      r.agentId === session.agentId &&
      r.seafarerId === seafarer.id &&
      r.bucket === "contact" &&
      r.status === "pending"
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/agent" className="text-sm font-medium text-brand-600 hover:text-brand-800">
        ← Back to dashboard
      </Link>
      <ReviewPanel
        seafarer={seafarer}
        documents={documents}
        agentName={session.user.name ?? session.user.email ?? "Agent"}
        duplicates={duplicates}
        initialNotes={notes}
        initialRestHours={restHours}
        requiredConfig={requiredConfig}
        initialDocRequests={docRequests}
        initialProfileChanges={profileChanges}
        initialSeaService={seaService}
        profileShared={profileShared}
        requestPending={requestPending}
        assigned={assigned}
        liveAssignmentId={liveAssignmentId}
      />
    </div>
  );
}
