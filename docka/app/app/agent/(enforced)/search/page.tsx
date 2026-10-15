import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { listSeafarersForAgent, getDocumentsForAgent } from "@/lib/agentData";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { buildSearchRow, type RosterSearchRow } from "@/lib/roster-search";
import { RosterSearch } from "@/components/RosterSearch";
import { readDB } from "@/lib/db";
import { findGrant } from "@/lib/access";
import { getFlagshipSearchRow } from "@/lib/sample-data";
import { SAMPLE_FLAGSHIP_ID } from "@/lib/sample-ids";

export const dynamic = "force-dynamic";

export default async function AgentSearchPage() {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  // GRANT-SCOPED talent index. Both the roster AND every seafarer's documents come
  // through lib/agentData.ts (default-deny, live re-checked) — no raw db.seafarers /
  // db.documents read here, so the search can never surface a foreign tenant's crew.
  // getDocumentsForAgent returns the ACTIVE (non-archived) set, matching the board.
  const config = getConfigForAgent(session.agentId);
  const rows: RosterSearchRow[] = listSeafarersForAgent(session.agentId, false).map((s) =>
    buildSearchRow(s, getDocumentsForAgent(session.agentId, s.id), config)
  );

  // Public Sample Profiles (plan §D10, R10): inject the ONE fictional flagship row
  // while this agent holds NO grant for it yet — a deliberate, documented bypass of
  // grant scoping for exactly one curated demo row (built solely from sample:true
  // fixtures in lib/sample-data, never from tenant data). Once the agent presses
  // "Add to board" (the /share auto-grant seam), the flagship flows through
  // lib/agentData like any granted seafarer and this injection stops — including
  // for PENDING/REVOKED grants, where re-injection would sidestep the seafarer-
  // consent lifecycle the grant records.
  let sampleInjected = false;
  if (!findGrant(readDB(), SAMPLE_FLAGSHIP_ID, session.agentId)) {
    const flagship = getFlagshipSearchRow();
    if (flagship) {
      rows.push(flagship);
      sampleInjected = true;
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Talent search</h1>
          <p className="mt-1 text-sm text-slate-500">
            Search across the {rows.length} seafarer{rows.length === 1 ? "" : "s"} who granted
            you access — by rank, nationality, certificate held, vessel-type fit, flag or
            availability. Find the qualified crew already sitting in your roster.
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
        <RosterSearch rows={rows} sampleUngranted={sampleInjected} />
      </div>
    </div>
  );
}
