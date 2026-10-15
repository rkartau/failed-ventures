// app/admin/leads/page.tsx — ADMIN-ONLY "Leads" working-set view.
//
// Personal outreach surface for the platform owners: a read-only projection of
// the clean lead-base snapshot `content/docka-leads.json` (published DAILY by
// handoff_publish_leads.py, scp'd onto the box). It is READ-ONLY — no customer
// data, no writes of any kind. (feat/manual-hold: it now also READS the operator
// override store from db.json to render the company-level Hold badge/control;
// still a read, and no customer data is touched.)
//
// GATE: re-checks adminSession() itself (Layer C, per-page — pages are the
// isolation unit in this codebase), on top of app/admin/layout.tsx and the edge
// middleware allowlist (Layer B). The same mechanism as every other admin page;
// nothing new was invented, and the allowlist itself is untouched by this route.
//
// Data flows through lib/docka-leads.ts, which shares the columnar parser with
// the §15 export route (lib/leads-export.ts) — one flattener for both surfaces.
// Every cell is a plain scalar rendered through JSX; nothing is injected raw.

import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { loadLeadsPageData } from "@/lib/docka-leads";
import { readDB } from "@/lib/db";
import { LeadsPageView } from "./view";

export const dynamic = "force-dynamic";

export const metadata = { title: "Leads" };

export default async function AdminLeadsPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  // [R13] Read the override store DIRECTLY (no HTTP hop). The company-level Hold
  // badge + control are derived from this store, joined by normalizeCompanyKey.
  const overrides = readDB().outreachOverrides;
  return <LeadsPageView snap={loadLeadsPageData()} overrides={overrides} />;
}
