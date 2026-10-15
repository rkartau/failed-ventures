import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { readDB } from "@/lib/db";
import { listSeafarersForAgent, getDocumentsForAgent } from "@/lib/agentData";
import { activeAssignmentsFor } from "@/lib/access";
import { duplicateNameIndex } from "@/lib/duplicates";
import { listVacancies } from "@/lib/vacancy-store";
import { matchCandidates, type CandidateInput, type CandidateScore } from "@/lib/vacancy";
import { VacancyMatch } from "@/components/VacancyMatch";

export const dynamic = "force-dynamic";

export default async function AgentVacanciesPage() {
  const session = await agentSession();
  if (!session?.user) return <SignInGate />;

  const db = readDB();
  // GRANT-SCOPED roster: the crew + each seaman's documents come through lib/agentData
  // (default-deny). atSea + sea-service are scoped to this agent's own live assignments.
  const crew = listSeafarersForAgent(session.agentId, false);
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (sfid) => nameById.get(sfid) ?? sfid);

  const candidates: CandidateInput[] = crew.map((s) => ({
    seafarer: s,
    docs: getDocumentsForAgent(session.agentId, s.id),
    entries: db.seaService.filter((e) => e.seafarerId === s.id),
    atSea: activeAssignmentsFor(s.id, session.agentId, db.assignments).length > 0,
  }));

  const vacancies = listVacancies(session.agentId);
  const matches: Record<string, CandidateScore[]> = {};
  for (const v of vacancies) matches[v.id] = matchCandidates(v, candidates, duplicates);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Vacancies &amp; matching</h1>
          <p className="mt-1 text-sm text-slate-500">
            Open a vacancy and match it against your granted roster. Coverage counts a
            certificate only when it is valid THROUGH the voyage; a cloned certificate number
            is never sea-ready.
          </p>
        </div>
        <Link
          href="/agent"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to pipeline
        </Link>
      </div>

      <div className="mt-6">
        <VacancyMatch vacancies={vacancies} matches={matches} />
      </div>
    </div>
  );
}
