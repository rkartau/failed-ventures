// app/admin/seamen/page.tsx — Seamen per-stage breakdown + integrity notes + roster.
//
// Re-checks adminSession() (Layer C). Renders the independent per-stage bars, a
// data-integrity notes panel (out-of-order + conflict seamen from `flags`), and a
// table of every seaman with per-stage reached-at (epoch → readable date, or the
// honest "— not tracked" badge; approximated / out-of-order / conflict get their
// own badges). Each row links to the drill-down.

import Link from "next/link";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { readDB } from "@/lib/db";
import {
  buildSeamenStages,
  type SeamanRow,
  type SeamanStageKey,
  type StageMembership,
} from "@/lib/admin-funnel";
import {
  Card,
  StageBarList,
  ProvenanceLegend,
  ProvenanceBadge,
  OutOfOrderBadge,
  ConflictBadge,
  fmtDate,
} from "../ui";

export const dynamic = "force-dynamic";

// The stage columns shown in the roster table (a compact, meaningful subset order).
const TABLE_STAGES: { key: SeamanStageKey; short: string }[] = [
  { key: "account_created", short: "Created" },
  { key: "document_uploaded", short: "1st upload" },
  { key: "gov_verified", short: "Gov-verified" },
  { key: "identity_verified", short: "Identity" },
  { key: "agent_approved", short: "Approved" },
  { key: "placed_at_sea", short: "Placed" },
  { key: "returned_finished", short: "Returned" },
];

/** One stage cell: honest date + badge, or a muted em dash when not a member. */
function StageCell({ m }: { m: StageMembership }): JSX.Element {
  if (!m.member) {
    return <span className="text-slate-300">—</span>;
  }
  if (m.reachedAt === null) {
    return <ProvenanceBadge provenance="not-tracked" />;
  }
  return (
    <span className="flex items-center justify-end gap-1">
      <span className="text-slate-700">{fmtDate(m.reachedAt)}</span>
      {m.provenance === "approximated" ? <ProvenanceBadge provenance="approximated" /> : null}
    </span>
  );
}

export default async function AdminSeamenPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const db = readDB();
  const { stages, rows, flags } = buildSeamenStages(db, Date.now());

  const nameById = new Map(rows.map((r) => [r.id, r.name] as const));
  const outOfOrderIds = new Set(flags.filter((f) => f.kind === "out-of-order").map((f) => f.seamanId));
  const conflictIds = new Set(flags.filter((f) => f.kind === "conflict").map((f) => f.seamanId));

  // Stable sort: account created date, newest first. Rows with a missing / invalid
  // createdAt sink to the bottom; ties (and both-invalid) tiebreak by id.
  const sorted: SeamanRow[] = [...rows].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    const aValid = Number.isFinite(ta);
    const bValid = Number.isFinite(tb);
    if (aValid && bValid) {
      if (tb !== ta) return tb - ta;
      return a.id.localeCompare(b.id);
    }
    if (aValid) return -1;
    if (bValid) return 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Seamen</h1>
      <p className="mt-1 text-sm text-slate-500">
        Independent per-stage breakdown and the full roster ({rows.length} seamen).
      </p>

      <div className="mt-6">
        <Card
          title="Per-stage breakdown"
          subtitle="Independent per-stage counts — not a funnel, not strictly sequential."
        >
          <StageBarList stages={stages} />
          <div className="mt-4">
            <ProvenanceLegend />
          </div>
        </Card>
      </div>

      {/* Data-integrity notes */}
      <div className="mt-6">
        <Card
          title="Data-integrity notes"
          subtitle="Non-nested / conflicting cases surfaced, never hidden or coerced."
        >
          {flags.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No anomalies flagged.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {flags.map((f, i) => (
                <li
                  key={`${f.seamanId}-${f.kind}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2"
                >
                  {f.kind === "out-of-order" ? <OutOfOrderBadge /> : <ConflictBadge />}
                  <Link
                    href={`/admin/seamen/${f.seamanId}`}
                    className="font-medium text-slate-800 underline hover:text-slate-600"
                  >
                    {nameById.get(f.seamanId) ?? f.seamanId}
                  </Link>
                  <span className="text-slate-500">{f.note}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Roster table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2 text-left font-medium">Seaman</th>
              <th className="px-3 py-2 text-left font-medium">State</th>
              <th className="px-3 py-2 text-left font-medium">Signup</th>
              <th className="px-3 py-2 text-left font-medium">Owner</th>
              {TABLE_STAGES.map((c) => (
                <th key={c.key} className="px-3 py-2 text-right font-medium">
                  {c.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={`/admin/seamen/${r.id}`}
                      className="font-medium text-slate-800 underline hover:text-slate-600"
                    >
                      {r.name}
                    </Link>
                    {outOfOrderIds.has(r.id) ? <OutOfOrderBadge /> : null}
                    {conflictIds.has(r.id) ? <ConflictBadge /> : null}
                  </div>
                  <div className="text-xs text-slate-400">{r.rank}</div>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.currentStateLabel}</td>
                <td className="px-3 py-2 text-slate-600">
                  {r.signupType === "agent-invited" ? "Agent-invited" : "Self-signup"}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {r.owner === "google" ? "Google" : r.owner === "phone" ? "Phone" : "Anon"}
                </td>
                {TABLE_STAGES.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    <StageCell m={r.stages[c.key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
