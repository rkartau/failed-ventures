// Public Sample Profiles — the ONE shared owner-payload projection (plan §D8).
//
// This is the payload assembly of `GET /api/seafarers?token=` (and `/api/seafarers/me`)
// extracted into a single server function so the real routes and the public sample
// page can never drift. TWO modes:
//
//   curatedOnly:false (default) — byte-identical to the previous inline assembly on
//     the real token/me paths: ALL rows for the seafarerId, flows for every live
//     grant, pending propagation + appraisal-delete requests. The raw seafarer row.
//
//   curatedOnly:true — the PUBLIC sample projection: only curated (`sample:true`)
//     rows render, flows are filtered to sample agencies (a REAL agent's grant on
//     the flagship must never leak publicly), ProfileShareRequest /
//     AppraisalDeleteRequest rows are never curated (real users' pending decisions
//     never render), and the seafarer goes through the §D8 allowlist redaction.
//
// The two modes return the SAME shape (the client component consumes both without
// branching) — locked by the shape-compat unit test in tests/sample-pages.test.mjs.

import type {
  AppraisalDeleteRequest,
  DB,
  Doc,
  DocRequest,
  ProfileChangeRequest,
  Seafarer,
  SeaServiceEntry,
} from "@/lib/db";
import { flowsForSeafarer, type SeamanFlow } from "@/lib/access";
import {
  pendingPropagationRequestsForSeafarer,
  type PendingPropagationRequestView,
} from "@/lib/propagation";
import { redactSampleSeafarer } from "@/lib/sample-guard";
import { isSampleId } from "@/lib/sample-ids";

export type OwnerPayload = {
  /** null when the seafarerId resolves no row (callers keep their own 404s). */
  seafarer: Seafarer | null;
  documents: Doc[];
  docRequests: DocRequest[];
  profileChanges: ProfileChangeRequest[];
  seaService: SeaServiceEntry[];
  flows: SeamanFlow[];
  propagationRequests: PendingPropagationRequestView[];
  appraisalDeleteRequests: AppraisalDeleteRequest[];
};

export function buildOwnerPayload(
  db: DB,
  seafarerId: string,
  opts: { curatedOnly?: boolean } = {}
): OwnerPayload {
  const curated = opts.curatedOnly === true;
  const keep = <T extends { sample?: boolean }>(rows: T[]): T[] =>
    curated ? rows.filter((r) => r.sample === true) : rows;

  const row = db.seafarers.find((s) => s.id === seafarerId) ?? null;
  const seafarer = row && curated ? redactSampleSeafarer(row) : row;

  const documents = keep(db.documents.filter((d) => d.seafarerId === seafarerId)).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
  // The document-request checklist the seaman sees on their own dashboard (all
  // requests raised to THIS seafarer, across any granting agent).
  const docRequests = keep(db.docRequests.filter((r) => r.seafarerId === seafarerId));
  // The seaman's OWN self-service change queue (proposed personal-profile edits +
  // their shore-approval outcomes).
  const profileChanges = keep(db.profileChanges.filter((r) => r.seafarerId === seafarerId));
  // The seaman's OWN sea-service ledger (digital discharge book).
  const seaService = keep(db.seaService.filter((e) => e.seafarerId === seafarerId));
  // "My applications" flows derive from grants. Curated view: only the seeded
  // sample-agency flow may render — a real agent's grant must never leak publicly.
  const flows = curated
    ? flowsForSeafarer(seafarerId).filter((f) => isSampleId(f.agentId))
    : flowsForSeafarer(seafarerId);
  // #38.5 pending propagation requests / #12 appraisal keep-delete consents this
  // seaman must decide. NEVER curated — real users' pending decisions must not
  // render on the public surface.
  const propagationRequests = curated
    ? []
    : pendingPropagationRequestsForSeafarer(seafarerId, db.profileShareRequests, db.agents);
  const appraisalDeleteRequests = curated
    ? []
    : db.appraisalDeleteRequests.filter(
        (r) => r.seafarerId === seafarerId && r.status === "pending"
      );

  return {
    seafarer,
    documents,
    docRequests,
    profileChanges,
    seaService,
    flows,
    propagationRequests,
    appraisalDeleteRequests,
  };
}
