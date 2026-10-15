// app/admin/atlas/page.tsx — ADMIN-ONLY Lead Atlas (choropleth over the live base).
//
// Read-only. Consumes the SAME memoized snapshot as /admin/leads and /admin/sources
// (loadLeadsPageData → one mtime+size-memoized parse of content/docka-leads.json,
// RV1) so this page adds ZERO extra reads/parses of the 13 MB base. The static world
// geometry is precomputed once server-side (buildAtlasGeometry) and shipped to the
// client as plain data — no d3/topojson in the browser bundle.
//
// GATE: re-checks adminSession() itself (Layer C, per-page — pages are the isolation
// unit here), verbatim with every other admin page, on top of layout + edge
// middleware. All props handed to the client view are plain-serializable.

import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { loadLeadsPageData } from "@/lib/docka-leads";
import { buildAtlasGeometry } from "@/lib/atlas/geo";
import { LeadAtlasView } from "./view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Atlas" };

/** Shared page shell so every state (missing / empty / data) matches admin chrome. */
function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>;
}

function EmptyNote({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-slate-900">Lead Atlas</h1>
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-slate-700">{title}</p>
        <p className="mt-1 text-sm text-slate-500">{body}</p>
      </div>
    </Shell>
  );
}

export default async function AdminAtlasPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const snap = loadLeadsPageData();

  // DISTINCT missing-file / invalid state vs the present-but-no-country state below.
  if (!snap.ok) {
    return snap.reason === "missing" ? (
      <EmptyNote
        title="Lead base snapshot not on this host"
        body="The base file (content/docka-leads.json) is box-only and reaches production by scp — a fresh checkout has none. The atlas fills in once a snapshot is present."
      />
    ) : (
      <EmptyNote
        title="Lead base snapshot could not be read"
        body="The latest snapshot on this host failed to parse. Fix or re-publish the base file; the atlas renders as soon as a valid snapshot is available."
      />
    );
  }

  const d = snap.data;

  // Present but no readable country on ANY row → a distinct empty state (not missing).
  if (d.withCountry === 0) {
    return (
      <EmptyNote
        title="No country data in this snapshot"
        body={`The base holds ${d.totalRows.toLocaleString("en-US")} rows but none carry a readable country — nothing to map yet.`}
      />
    );
  }

  const geometry = buildAtlasGeometry();

  return (
    <Shell>
      <LeadAtlasView
        geometry={geometry}
        stats={d.countryStats}
        provenance={{
          generatedAt: d.generatedAt,
          sourceVersion: d.sourceVersion,
          totalRows: d.totalRows,
          withCountry: d.withCountry,
          noCountry: d.noCountry,
        }}
        stale={snap.stale ? snap.stale.error : null}
      />
    </Shell>
  );
}
