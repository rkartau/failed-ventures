import Link from "next/link";
import { readDB } from "@/lib/db";
import { AgentBoard, type SeafarerWithDocs } from "@/components/AgentBoard";
import { agentSession, isDevLoginEnabled } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { DevAgentPicker } from "@/components/DevAgentPicker";
import { duplicateNameIndex } from "@/lib/duplicates";
import { getConfigForAgent } from "@/lib/required-docs-store";
import { listSeafarersForAgent } from "@/lib/agentData";

export const dynamic = "force-dynamic";

export default async function AgentPage({
  searchParams,
}: {
  searchParams: { filter?: string; q?: string };
}) {
  // Agent area is gated: unauthenticated visitors see the sign-in screen.
  // agentSession() accepts Google OR, in dev only, the test-agent cookie.
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  // GRANT-SCOPED roster: the agent sees ONLY the seafarers who granted them access
  // (default-deny via lib/agentData.ts). No raw db.seafarers read here — that is
  // the multi-tenant isolation boundary.
  const db = readDB();
  // Bug1 — the board render drops board-hidden crew (includeHidden:false). The hidden
  // panel + every other agent surface (reminders/circulars/inspection/export…) keep the
  // default true, so a hidden seaman still gets reminders and appears in inspection/export.
  const visible = listSeafarersForAgent(session.agentId, false);
  // #41 — set of seafarers THIS agent has a LIVE assignment for (returnedAt === null),
  // built in ONE pass (the N+1-safe map) so the employment doc-set column/filter can
  // scope per seaman without re-scanning db.assignments per row. Tenant-isolated: only
  // this agent's own assignments count toward "assigned".
  const liveAssignedIds = new Set(
    db.assignments
      .filter((a) => a.agentId === session.agentId && a.returnedAt === null)
      .map((a) => a.seafarerId)
  );
  const roster: SeafarerWithDocs[] = visible
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      ...s,
      documents: db.documents
        .filter((d) => d.seafarerId === s.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      // This agent's document-request checklist for the card's package-ready badge.
      // Tenant-scoped: own-tenant rows for an already grant-visible seafarer.
      docRequests: db.docRequests.filter(
        (r) => r.seafarerId === s.id && r.agentId === session.agentId
      ),
      // #41 — employment doc-set is in scope only for an active voyage this agent owns.
      assigned: liveAssignedIds.has(s.id),
    }));

  // CROSS-seafarer forgery signal: computed over ALL documents so a shared/forged
  // certificate number is still caught — but the OTHER crew's identity is masked
  // unless this agent may actually see them (isolation: a non-granted seafarer's
  // NAME must not leak into another agent's page via the duplicate map).
  const visibleIds = new Set(visible.map((s) => s.id));
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const duplicates = duplicateNameIndex(db.documents, (id) =>
    visibleIds.has(id) ? nameById.get(id) ?? id : "another crew member"
  );

  // Per-agent required-docs config (defaults to the researched baseline) — drives
  // the config-driven missing-docs / completeness computation on every card.
  const requiredConfig = getConfigForAgent(session.agentId);

  // Dev-only agent switcher so isolation is demonstrable without Google.
  const demoAgents = isDevLoginEnabled
    ? db.agents.map((a) => ({ id: a.id, orgName: a.orgName, contact: a.contact }))
    : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Fleet pipeline</h1>
          <p className="mt-1 text-sm text-slate-500">
            {roster.length} seafarer{roster.length === 1 ? "" : "s"} who granted you
            access. Filter by problem, review a seafarer, move them through the
            pipeline, invite a crew, or export for audit.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {demoAgents.length > 0 && (
            <DevAgentPicker agents={demoAgents} current={session.agentId} compact />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/agent/analytics"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Analytics
            </Link>
            <Link
              href="/agent/search"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Talent search
            </Link>
            <Link
              href="/agent/settings/circulars"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Circulars
            </Link>
            <Link
              href="/agent/settings/required-docs"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Required documents
            </Link>
            <Link
              href="/agent/settings/billing"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Billing
            </Link>
            {/* feat/password-signup Step 13: password accounts manage their
                credential (change password / regenerate recovery codes) here.
                Google agents have nothing to manage — no card for them. */}
            {session.authMethod === "password" && (
              <Link
                href="/agent/settings/account"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Account
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <AgentBoard
          initial={roster}
          initialFilter={searchParams.filter ?? "all"}
          initialQuery={searchParams.q ?? ""}
          duplicates={duplicates}
          requiredConfig={requiredConfig}
        />
      </div>
    </div>
  );
}
