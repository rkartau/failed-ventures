import Link from "next/link";
import { readDB } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { listSeafarersForAgent } from "@/lib/agentData";
import { channelConfigured } from "@/lib/notify";
import { CircularBroadcast, type CircularRosterEntry } from "@/components/CircularBroadcast";

export const dynamic = "force-dynamic";

export default async function CircularsSettingsPage() {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  // GRANT-SCOPED roster (default-deny via lib/agentData.ts) — the ONLY source of
  // recipients + the filter options the compose UI offers. No raw db.seafarers read.
  const roster: CircularRosterEntry[] = listSeafarersForAgent(session.agentId, false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      rank: s.rank ?? "",
      state: s.state,
      vessel: s.vessel ?? null,
      hasEmail: Boolean(s.ownerEmail?.trim()),
    }));

  const circulars = readDB()
    .circulars.filter((c) => c.agentId === session.agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Whether a live email transport is configured — drives the compose reach line
  // (email may be dark, in which case crew still see the message inside docka).
  const emailLive = channelConfigured("email");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Messages to your crew</h1>
          <p className="mt-1 text-sm text-slate-500">
            Send a notice to your crew. They see it inside docka straight away. If
            email is switched on, they also get it by email.
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
        <CircularBroadcast initialRoster={roster} initialCirculars={circulars} emailLive={emailLive} />
      </div>
    </div>
  );
}
