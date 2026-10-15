import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { baselineAt } from "@/lib/required-docs";
import {
  getConfigForAgent,
  hasCustomConfig,
  governedSeafarerIds,
  auditForAgent,
} from "@/lib/required-docs-store";
import { RequiredDocsSettings } from "@/components/RequiredDocsSettings";

export const dynamic = "force-dynamic";

export default async function RequiredDocsSettingsPage() {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  const config = getConfigForAgent(session.agentId);
  const baseline = baselineAt();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Required documents</h1>
          <p className="mt-1 text-sm text-slate-500">
            Define which documents must be on file. Seeded from the researched STCW/MLC
            baseline; edits apply to all your seafarers and drive the missing-docs and
            sea-readiness checks.
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
        <RequiredDocsSettings
          initialConfig={config}
          catalog={baseline.catalog}
          baselineVersion={baseline.version}
          governedCount={governedSeafarerIds(session.agentId).length}
          custom={hasCustomConfig(session.agentId)}
          initialAudit={auditForAgent(session.agentId)}
        />
      </div>
    </div>
  );
}
