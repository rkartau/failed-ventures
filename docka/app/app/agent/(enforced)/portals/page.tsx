import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { readDB } from "@/lib/db";
import { listSeafarersForAgent } from "@/lib/agentData";
import { previewPortalVisibility, listPortalsForAgent } from "@/lib/client-portal";
import { PortalManager, type CrewOption, type PortalRow } from "@/components/PortalManager";
import { DirectoryConsentToggle } from "@/components/DirectoryConsentToggle";

export const dynamic = "force-dynamic";

export default async function AgentPortalsPage() {
  const session = await agentSession();
  if (!session?.user) return <SignInGate />;

  // GRANT-SCOPED crew picker — the roster comes through lib/agentData (default-deny),
  // and each seaman's client-portal visibility is previewed BEFORE send [R42.5].
  const crew = listSeafarersForAgent(session.agentId, false);
  const vis = previewPortalVisibility(
    session.agentId,
    crew.map((s) => s.id)
  );
  const visById = new Map(vis.map((v) => [v.seafarerId, v]));
  const options: CrewOption[] = crew.map((s) => ({
    id: s.id,
    name: s.name,
    rank: s.rank,
    visible: visById.get(s.id)?.visible ?? false,
    reason: visById.get(s.id)?.reason ?? null,
  }));
  const portals: PortalRow[] = listPortalsForAgent(session.agentId).map((p) => ({
    id: p.id,
    vessel: p.vessel,
    clientLabel: p.clientLabel,
    mode: p.mode,
    token: p.token,
    count: p.seafarerIds.length,
    revokedAt: p.revokedAt,
    createdAt: p.createdAt,
  }));

  // #49 — current per-seaman directory consent for THIS agency's grants (agency half of
  // the dual consent). Read from the stored grant flag; the toggle re-checks the grant.
  const grantConsent = new Map(
    readDB()
      .accessGrants.filter((g) => g.agentId === session.agentId)
      .map((g) => [g.seafarerId, g.directoryConsent === true] as const)
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Client read-portals</h1>
          <p className="mt-1 text-sm text-slate-500">
            Build a read-only crew summary a shipowner client can open by link. Only crew who
            marked you client-visible are included; documents and personal data are never shared.
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
        <PortalManager options={options} portals={portals} />
      </div>

      <section className="mt-10">
        <h2 className="font-semibold text-slate-900">docka-verified directory consent</h2>
        <p className="mt-1 text-sm text-slate-500">
          Consent to route each seaman as a lead in the docka-verified directory. They are
          listed only when they have ALSO opted in and are government-verified.
        </p>
        <ul className="mt-3 space-y-1.5">
          {crew.map((s) => (
            <li key={s.id}>
              <DirectoryConsentToggle
                seafarerId={s.id}
                name={s.name}
                rank={s.rank}
                initial={grantConsent.get(s.id) ?? false}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

