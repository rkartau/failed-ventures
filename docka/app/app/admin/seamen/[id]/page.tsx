// app/admin/seamen/[id]/page.tsx — Per-seaman drill-down (+ the ONE audit write).
//
// Flow (order is security-critical, plan §4.4 / F1):
//   1. adminSession() passes (Layer C).
//   2. Resolve the seaman; notFound() if the id does not exist — NO audit line for a
//      denied / 404 / bad-id request.
//   3. recordAdminAccess(...): prefetch-guarded (zero lines on <Link> prefetch),
//      exactly one line per real view, loud-fail but non-throwing.
//   4. Render the identity header + dated/undated timeline.

import Link from "next/link";
import { notFound } from "next/navigation";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../../access";
import { recordAdminAccess } from "@/lib/admin-audit";
import { TakeOverButton } from "@/components/TakeOverButton";
import { CredentialRescueButton } from "@/components/CredentialRescueButton";
import { readDB, readAccessLog, readConsentEvents } from "@/lib/db";
import { buildUserTimeline } from "@/lib/admin-funnel";
import { STATE_LABELS } from "@/lib/pipeline";
import { Timeline } from "../../ui";

export const dynamic = "force-dynamic";

export default async function AdminSeamanDrilldownPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  // 1) Gate.
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  // 2) Resolve the subject BEFORE any audit write.
  const db = readDB();
  const seaman = db.seafarers.find((s) => s.id === params.id);
  if (!seaman) notFound();

  // 3) The single compliance write — only now, on a resolved real view.
  await recordAdminAccess({
    adminEmail: session.user.email ?? "",
    view: "seaman-drilldown",
    subjectKind: "seaman",
    subjectId: seaman.id,
  });

  // 4) Timeline.
  const accessLog = readAccessLog();
  const consent = readConsentEvents();
  const { dated, undated } = buildUserTimeline(db, accessLog, consent, "seaman", seaman.id);

  // Ownership label (feat/password-signup Step 14): now credentialUserId-aware.
  // A Google/e-mail claim wins the label even when co-owned with a credential
  // (fold 2 — the rescue path for that shape is Google sign-in, not the button).
  const googleOwned =
    (seaman.googleSub && seaman.googleSub.length > 0) ||
    (seaman.ownerEmail && seaman.ownerEmail.length > 0);
  const credentialOwned = Boolean(seaman.credentialUserId);
  const owner = googleOwned
    ? "Google-owned"
    : credentialOwned
      ? "Password-owned"
      : "Anonymous / local";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <p className="text-xs text-slate-400">
        <Link href="/admin/seamen" className="underline hover:text-slate-600">
          ← Back to seamen
        </Link>
      </p>

      {/* Identity header */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{seaman.name}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {seaman.rank} · {STATE_LABELS[seaman.state] ?? seaman.state}
            </p>
          </div>
          <dl className="text-right text-xs text-slate-500">
            <div>
              <dt className="inline font-medium text-slate-600">Owner: </dt>
              <dd className="inline">{owner}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-600">Availability: </dt>
              <dd className="inline">{seaman.availability ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-600">Signup: </dt>
              <dd className="inline">{seaman.invited === true ? "Agent-invited" : "Self-signup"}</dd>
            </div>
          </dl>
        </div>

        {/* Admin take-over / act-as control. */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <TakeOverButton targetKind="seaman" targetId={seaman.id} />
        </div>

        {/* Credential rescue (feat/password-signup Step 14, D13): "seafarer lost
            password AND recovery codes" — unbind the password account + reissue
            a fresh claim link. Shown ONLY for a purely password-owned profile;
            the co-owned shape (googleSub/ownerEmail set too) is NOT rescuable
            (v6 fold 2 — the reissued token could never be adopted) and shows
            the Google-recovery note instead. */}
        {credentialOwned && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            {googleOwned ? (
              <p className="text-xs text-slate-500" data-testid="rescue-google-owned">
                Google-owned; recover via Google sign-in.
              </p>
            ) : (
              <CredentialRescueButton seafarerId={seaman.id} />
            )}
          </div>
        )}
      </div>

      {/* Dwell-time honesty banner */}
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Dwell time between stages is approximated from the intake date — not directly
        tracked. Individual milestones below carry their own provenance badge.
      </div>

      {/* Timeline */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Timeline</h2>
        <p className="mt-0.5 mb-4 text-xs text-slate-500">
          Key persisted milestones for this seaman, in ascending order.
        </p>
        <Timeline dated={dated} undated={undated} />
      </div>
    </div>
  );
}
