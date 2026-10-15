// app/admin/sources/page.tsx — ADMIN-ONLY lead-source ledger view.
//
// Read-only reconciliation of the source ledger (content/docka-sources.json,
// rendered from SOURCE_INDEX.csv by handoff_publish_leads.py) against the
// per-registry aggregate the leads loader folds over the WHOLE base. TWO honest
// clocks: the counts come from content/docka-leads.json on every request; the
// ledger TEXT only changes when someone publishes + scp's the file. No writes,
// no customer data.
//
// GATE: re-checks adminSession() itself (Layer C, per-page — pages are the
// isolation unit here), on top of app/admin/layout.tsx and the edge middleware
// allowlist (Layer B). Same mechanism as every other admin page. Every rendered
// cell is a plain scalar through JSX — nothing is injected raw.

import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { loadLeadsPageData } from "@/lib/docka-leads";
import { loadSourcesDoc } from "@/lib/docka-sources";
import { SourcesView } from "./view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sources" };

export default async function AdminSourcesPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  // Both feeds are box-only files; each degrades independently (a missing ledger
  // still shows the base-derived counts, and vice versa).
  const leads = loadLeadsPageData();
  const sources = loadSourcesDoc();
  return <SourcesView leads={leads} sources={sources} searchParams={searchParams ?? {}} />;
}
