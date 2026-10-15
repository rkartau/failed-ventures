// app/app/admin/leads/view.tsx
//
// Presentational body of the admin "Leads" page. NOT a routable module (no
// page/layout/route filename), so it sits outside the inverted admin static
// guard — and it carries NO auth logic on purpose: the gate lives in page.tsx
// (adminSession) and app/admin/layout.tsx, with the edge middleware in front.
// Split out so the exact rendered body can be screenshot-verified without
// weakening, faking or bypassing the admin session.
//
// Pure server component, no client island: nothing to hydrate. Every cell value
// is a plain scalar interpolated through JSX, so React escapes everything —
// no raw-HTML injection exists anywhere on this surface (a meta-test in
// tests/docka-leads.test.mjs pins that as a greppable property).

import type { LeadRow, LeadsPageSnapshot } from "@/lib/docka-leads";
import {
  isCompanyHeld,
  companyHoldCount,
  type OutreachOverrides,
} from "@/lib/outreach-overrides";
import { CompanyHoldControls } from "../outreach/actions";
import { BADGE, TH, TD } from "../ui";

function fmt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function channelBadge(channel: string): string {
  if (channel === "GREEN") return `${BADGE} border-emerald-200 bg-emerald-50 text-emerald-700`;
  if (channel === "RED") return `${BADGE} border-rose-200 bg-rose-50 text-rose-700`;
  return `${BADGE} border-slate-200 bg-slate-100 text-slate-600`;
}

/**
 * The pipeline's PRODUCT-FIT verdict, rendered beside the (stale) `sendable`
 * badge so the divergence is visible: after the product-fit gate went live the
 * pipeline stops emailing non-prospects, but the snapshot's is_sendable still
 * marks them sendable. Rules: no verdict OR enrichment did not succeed →
 * grey "pending" (we do NOT trust an unenriched fit, and absence is NOT a
 * negative); negative → red "not a prospect"; positive → green "fit";
 * ambiguous → amber "fit (weak)".
 */
function productFitBadge(r: LeadRow): { cls: string; label: string } {
  if (r.productFit === undefined || r.enrichStatus !== "success") {
    return { cls: `${BADGE} border-slate-200 bg-slate-100 text-slate-500`, label: "pending" };
  }
  if (r.productFit === "negative") {
    return { cls: `${BADGE} border-rose-200 bg-rose-50 text-rose-700`, label: "not a prospect" };
  }
  if (r.productFit === "ambiguous") {
    return { cls: `${BADGE} border-amber-200 bg-amber-50 text-amber-700`, label: "fit (weak)" };
  }
  return { cls: `${BADGE} border-emerald-200 bg-emerald-50 text-emerald-700`, label: "fit" };
}

function LeadsTable({
  rows,
  testid,
  overrides,
  countRows,
}: {
  rows: LeadRow[];
  testid: string;
  overrides: OutreachOverrides;
  countRows: LeadRow[];
}): JSX.Element {
  return (
    <div className="overflow-x-auto" data-testid={testid}>
      <table className="w-full border-collapse text-sm text-slate-800">
        <thead>
          <tr className="border-b border-slate-200">
            <th className={TH}>Company</th>
            <th className={TH}>CC</th>
            <th className={TH}>Segment</th>
            <th className={TH}>Tier</th>
            <th className={TH}>Fit</th>
            <th className={TH}>Action</th>
            <th className={TH}>Email</th>
            <th className={TH}>Channel</th>
            <th className={TH}>Flags</th>
            <th className={TH}>Product-fit</th>
            <th className={TH}>Hold</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.company}-${r.email}-${i}`} className="border-b border-slate-100">
              <td className={`${TD} font-medium text-slate-900`}>{r.company}</td>
              <td className={TD}>{r.countryIso2}</td>
              <td className={TD}>{r.segment}</td>
              <td className={TD}>{r.tier}</td>
              <td className={TD}>{r.fitScore}</td>
              <td className={TD}>{r.action}</td>
              <td className={`${TD} font-mono text-xs`}>{r.email}</td>
              <td className={TD}>
                <span className={channelBadge(r.channel)}>{r.channel || "—"}</span>
              </td>
              <td className={TD}>
                {r.sendable ? (
                  <span className={`${BADGE} border-emerald-200 bg-emerald-50 text-emerald-700`}>
                    sendable
                  </span>
                ) : null}{" "}
                {r.desk ? (
                  <span className={`${BADGE} border-sky-200 bg-sky-50 text-sky-700`}>desk</span>
                ) : null}
              </td>
              <td className={TD}>
                {/* The pipeline's live product-fit verdict, joined by normalized
                    email — renders "pending" when there is no verdict (never a
                    negative). Sits beside the stale `sendable` badge on purpose. */}
                {(() => {
                  const b = productFitBadge(r);
                  return <span className={b.cls}>{b.label}</span>;
                })()}
              </td>
              <td className={TD}>
                {/* [R10] company-level Held from the APP override store; [R9] the
                    Hold button shows the coverage count in this snapshot. */}
                <CompanyHoldControls
                  company={r.company}
                  held={isCompanyHeld(overrides, r.company)}
                  companyCount={companyHoldCount(countRows, r.company)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeadsPageView({
  snap,
  overrides,
}: {
  snap: LeadsPageSnapshot;
  overrides: OutreachOverrides;
}): JSX.Element {
  const countRows: LeadRow[] = snap.ok ? [...snap.data.workingSet, ...snap.data.desks] : [];
  return (
    // Full width: a wide table in a centred
    // strip is unreadable on a desktop monitor.
    <div className="w-full px-3 py-8 sm:px-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        docka admin · private research
      </p>
      <h1 className="text-2xl font-bold text-slate-900">Leads</h1>

      {snap.ok ? (
        <>
          {/* generated_at PROMINENT (operator rule: the daily refresh must be
              visibly landing), above everything else. */}
          <div
            className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            data-testid="leads-staleness"
          >
            <p className="font-semibold">
              Snapshot generated {snap.data.generatedAt}
              {snap.data.sourceVersion ? ` · lead base ${snap.data.sourceVersion}` : ""}
            </p>
            <p className="mt-1">
              Published onto this box {fmt(snap.data.publishedAt)}. The publisher replaces this
              file daily; the page picks a new file up on the next request, no restart needed.
              Figures are frozen at the moment above.
            </p>
          </div>

          {/* Last-known-good arm: the CURRENT file on disk is broken or gone,
              and the list above/below is the previous good parse. The list must
              stay visible at all times — this note is the honest trade shown. */}
          {snap.stale ? (
            <div
              className="mt-3 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900"
              data-testid="leads-stale-note"
            >
              <p className="font-semibold">
                Latest refresh failed — showing the last good snapshot (generated{" "}
                {snap.data.generatedAt}).
              </p>
              <p className="mt-1">{snap.stale.error}. Re-run the publisher to replace the file.</p>
            </div>
          ) : null}

          {/* Honest counts: the whole base vs what this page shows. */}
          <p className="mt-4 text-sm text-slate-600" data-testid="leads-counts">
            <strong className="text-slate-900">{n(snap.data.totalRows)}</strong> companies in the
            snapshot · showing the published working set of{" "}
            <strong className="text-slate-900">{n(snap.data.workingSet.length)}</strong> and{" "}
            <strong className="text-slate-900">{n(snap.data.desks.length)}</strong> crewing desks ·{" "}
            {n(snap.data.sendableCount)} sendable base-wide. The remaining rows stay on the box
            (research data: exclusions, do-not-mail, sanctions and personal-address rows included)
            and are served only by the admin export API.
          </p>

          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              Working set <span className="font-normal text-slate-500">({n(snap.data.workingSet.length)})</span>
            </h2>
            <div className="mt-3">
              <LeadsTable
                rows={snap.data.workingSet}
                testid="leads-working-set"
                overrides={overrides}
                countRows={countRows}
              />
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              Crewing desks <span className="font-normal text-slate-500">({n(snap.data.desks.length)})</span>
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Desk mailboxes across the whole base (a few also sit in the working set above).
            </p>
            <div className="mt-3">
              <LeadsTable
                rows={snap.data.desks}
                testid="leads-desks"
                overrides={overrides}
                countRows={countRows}
              />
            </div>
          </div>
        </>
      ) : snap.reason === "missing" ? (
        // ONLY a box that has never had a snapshot sees this. Absence is the
        // ordinary state of a fresh checkout (the file is git-ignored contact
        // data) and must not read like an error.
        <div
          className="mt-6 rounded-xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-600"
          data-testid="leads-empty"
        >
          <p className="font-semibold text-slate-900">No lead snapshot on this box</p>
          <p className="mt-1">
            Publish one with the lead-base script (handoff_publish_leads.py), which lands{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">content/docka-leads.json</code>{" "}
            here by scp. The file is deliberately kept out of git.
          </p>
        </div>
      ) : (
        // A snapshot IS published, it is broken, and this process has never
        // held a good parse to fall back on — the one state left to alarm on.
        <div
          className="mt-6 rounded-xl border border-rose-300 bg-rose-50 px-4 py-4 text-sm text-rose-900"
          data-testid="leads-error"
        >
          <p className="font-semibold">Snapshot not rendered</p>
          <p className="mt-1">{snap.error}</p>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-400">
        Owner-only research tool. Business contact data — handle under GDPR. Not part of the
        docka product: no seafarer, agent or customer data is read by this page.
      </p>
    </div>
  );
}
