import Link from "next/link";
import { readDB } from "@/lib/db";
import { resolvePortal, crewForPortal, portalHeaderForViewer } from "@/lib/client-portal";
import { evaluateShareAccess } from "@/lib/share-access";
import { ShareEmailGate } from "@/components/ShareEmailGate";
import { ClientCrewList } from "@/components/ClientCrewList";
import { SurfaceRefSaltMissing } from "@/lib/surface-ref";

// isolation-guard: exempt — this PUBLIC (token) client read-portal resolves NO agent
// identity. It renders the allow-list projection (lib/client-view) authorised by the
// portal token (+ email allow-list in "email" mode), never by an agent grant read.
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-2xl font-bold text-slate-900">Link not found</h1>
      <p className="mt-2 text-slate-500">This portal link is invalid, revoked, or has expired.</p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Back to home
      </Link>
    </div>
  );
}

export default async function PortalPage({ params }: { params: { token: string } }) {
  const resolved = resolvePortal(params.token);
  if (!resolved) return <NotFound />;
  const { portal } = resolved;

  // Email-mode gate — a valid token + non-allowed viewer leaks neither crew NOR the
  // display header (vessel / client label) [C10]. Only after the gate passes is the
  // header computed + rendered.
  if (portal.mode === "email") {
    const gate = await evaluateShareAccess({ allowedEmails: portal.allowedEmails }, "email");
    if (!gate.allowed) {
      return <ShareEmailGate token={params.token} reason={gate.reason} viewerEmail={gate.viewerEmail} />;
    }
  }

  const header = portalHeaderForViewer(portal, true);

  // Public Sample Profiles (plan v4-4 belt-and-braces): strip any sample subject
  // from the portal's id list BEFORE building rows. The primary gates already
  // hold — clientVisible is seaman-token-set only (census row 20 DENY) and
  // lib/client-portal's visForDb carries its own isSample skip — this keeps the
  // PAGE self-defending even if a future lib refactor loses that skip.
  const dbSnap = readDB();
  const safePortal = {
    ...portal,
    seafarerIds: portal.seafarerIds.filter(
      (id) => dbSnap.seafarers.find((s) => s.id === id)?.isSample !== true
    ),
  };

  let rows;
  try {
    rows = crewForPortal(safePortal);
  } catch (e) {
    if (e instanceof SurfaceRefSaltMissing) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-20 text-center">
          <h1 className="text-2xl font-bold text-slate-900">Temporarily unavailable</h1>
          <p className="mt-2 text-slate-500">This portal cannot be shown right now. Please try again later.</p>
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10" data-testid="client-portal">
      <meta name="robots" content="noindex,nofollow" />
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Crew read-portal
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900" data-testid="portal-vessel">
          {header?.vessel}
        </h1>
        <p className="mt-1 text-sm text-slate-500" data-testid="portal-client-label">
          Prepared for {header?.clientLabel}
        </p>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
          A read-only crew summary. Names are shown surname-initial only; no documents,
          contact details or personal data are shared here.
        </p>
      </div>

      <div className="mt-6">
        <ClientCrewList rows={rows} />
      </div>
    </div>
  );
}
