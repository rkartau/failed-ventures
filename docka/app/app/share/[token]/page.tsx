import Link from "next/link";
import { cookies } from "next/headers";
import { readDB } from "@/lib/db";
import { AgentDocList } from "@/components/AgentDocList";
import { DocRequestChecklist } from "@/components/DocRequestChecklist";
import { ShareChecklist } from "@/components/ShareChecklist";
import { ShareEmailGate } from "@/components/ShareEmailGate";
import { evaluateShareAccess, resolveSeafarerByShareToken } from "@/lib/share-access";
import { agentSession } from "@/lib/agent-session";
import { grantAccess, openGrantLink, findGrant } from "@/lib/access";
import { duplicateNameIndex } from "@/lib/duplicates";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";

// isolation-guard: exempt — this PUBLIC share view resolves an agent only to form
// the seafarer-consented access grant (grantAccess/openGrantLink below), which IS
// the grant-creation seam, not a cross-tenant tenant-data READ. It never reads
// another tenant's data by agent identity; document rendering here is authorised by
// the seafarer's own share token, not by the agent grant.
export const dynamic = "force-dynamic";

// NOINDEX — a single dynamic child carries a secret share token; page-level export
// is sufficient (TS2). Kept crawlable (no robots.txt disallow).
export const metadata = { robots: { index: false, follow: false } };

export default async function SharePage({ params }: { params: { token: string } }) {
  const rawLang = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(rawLang) ? rawLang : DEFAULT_LANG;
  const db = readDB();
  // Resolve by EITHER share token; the ACCESS MODE is decided by which one matched.
  // Open link -> no login. Private (email) link -> gated by the signed-in allow-list.
  // #6 — a token that is not a LIVE token may be a carried alias from an absorbed record
  // (post-merge). It resolves to the SURVIVOR but PRESERVES its original mode, so an email
  // alias stays email-gated and can never downgrade to open. Carried aliases are VIEW-ONLY:
  // `viaCarriedAlias` makes the onboarding handshake skip any auto-grant (b). This is the
  // canonical resolver shared with the paste-link endpoint (behaviour-preserving refactor).
  const resolved = resolveSeafarerByShareToken(db, params.token);
  const seafarer = resolved?.seafarer;
  const shareLinkMode: "open" | "email" =
    resolved?.mode === "open"
      ? "open"
      : resolved?.mode === "email"
        ? "email"
        : (resolved?.aliasMode ?? "email");
  const viaCarriedAlias = resolved?.mode === "alias";

  if (!seafarer) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Link not found</h1>
        <p className="mt-2 text-slate-500">
          This share link is invalid or has expired.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Back to home
        </Link>
      </div>
    );
  }

  // SHARE-MODE GATE (server-side, fail-closed). When the seafarer restricted the link
  // to specific agent e-mails, the token alone is NOT enough: a viewer must be signed
  // in with Google AND on the allow-list. A non-allowed viewer sees ONLY the gate — no
  // documents, no document IDs, no file links are rendered — so nothing leaks. "open"
  // mode is unaffected and keeps the original no-login behaviour.
  const gate = await evaluateShareAccess(seafarer, shareLinkMode);
  if (!gate.allowed) {
    return (
      <ShareEmailGate token={params.token} reason={gate.reason} viewerEmail={gate.viewerEmail} />
    );
  }

  // ONBOARDING HANDSHAKE — the missing grant seam. When a SIGNED-IN AGENT opens a
  // link the seafarer chose to share, form the consent-based access grant so the
  // seafarer appears on THAT agent's grant-scoped board. This is the ONLY place a
  // self-registered seafarer becomes reachable by an agent. Constraints kept:
  //   - An ANONYMOUS open-link viewer (no agent session) forms NO grant — the public
  //     view-only behaviour is unchanged, so we never auto-grant an arbitrary agent.
  //   - "email" mode only reaches here when the viewer's e-mail is on the seafarer's
  //     allow-list (evaluateShareAccess), i.e. an agent the seafarer explicitly named.
  //   - A withdrawn (REVOKED) or lapsed (EXPIRED) grant is NOT silently reactivated:
  //     only a brand-new (seafarer, agent) pair is granted, and a PENDING one activated
  //     via openGrantLink. Re-approval of a withdrawn grant stays the seafarer's call.
  //   - #6(b): a CARRIED alias (from an absorbed record) is a strictly VIEW-ONLY affordance
  //     and NEVER auto-forms a grant — an agent opening a thin absorbed record's old link
  //     post-merge must not silently mint an ACTIVE grant on the richer survivor.
  const agentViewer = await agentSession();
  if (agentViewer?.user && !viaCarriedAlias) {
    const existing = findGrant(db, seafarer.id, agentViewer.agentId);
    if (!existing) {
      await grantAccess({ seafarerId: seafarer.id, agentId: agentViewer.agentId });
    } else if (existing.status === "PENDING") {
      await openGrantLink(existing.shareToken, agentViewer.agentId);
    }
  }

  // Public Sample Profiles (plan v4-4): for a sample subject EVERY collection on
  // this indexed public page is filtered to the CURATED (sample:true) rows, and
  // the duplicate-cert index is scoped to the sample cohort — no real seafarer's
  // name or document metadata can render on the published sample link.
  const isSampleSubject = seafarer.isSample === true;

  const documents = db.documents
    .filter((d) => d.seafarerId === seafarer.id && (!isSampleSubject || d.sample === true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Document-request checklist raised to this seafarer — shown on the shared view so
  // whoever holds the link (the seaman, or an agent they shared with) sees exactly
  // what is still outstanding before a crew change.
  const docRequests = db.docRequests.filter(
    (r) => r.seafarerId === seafarer.id && (!isSampleSubject || r.sample === true)
  );

  // Fleet-wide duplicate-number index so a certificate number that also sits on
  // another crew member is flagged even on the open share view. Sample subjects
  // scope the index to the sample cohort's curated docs (v4-4).
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const sampleCohortIds = new Set(
    db.seafarers.filter((s) => s.isSample === true).map((s) => s.id)
  );
  const dupSource = isSampleSubject
    ? db.documents.filter((d) => sampleCohortIds.has(d.seafarerId) && d.sample === true)
    : db.documents;
  const duplicates = duplicateNameIndex(dupSource, (id) => nameById.get(id) ?? id);

  // READ-ONLY inbox on the share surface — this seafarer's OWN company messages,
  // newest-first. No peer replies and no reply composer here: replies require an
  // authenticated seaman session (D1), and a share-link viewer is not one. This is a
  // thin, view-only mirror of the inbox so a seaman who only uses their link still sees
  // what the agency sent.
  const myCirculars = db.circulars
    .filter(
      (c) => c.recipientIds.includes(seafarer.id) && (!isSampleSubject || c.sample === true)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fmtCircular = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          {t(lang, "sh.eyebrow")}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{seafarer.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t(lang, "sh.docsShared", { n: documents.length })}
        </p>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
          {t(lang, "sh.privateNote")}
        </p>
      </div>

      {docRequests.some((r) => r.status === "pending") && (
        <div className="mt-6">
          {/* Per-item upload is enabled ONLY in OPEN mode: there the visitor's URL
              token already equals seafarer.shareToken, so embedding it leaks nothing
              and the server POST gate accepts it. In email/alias mode the visitor's
              token is NOT the open key, so passing seafarer.shareToken would leak the
              owner's open key and bypass the email allow-list — those stay read-only.
              A carried alias (view-only) is likewise never open, so it stays read-only. */}
          {resolved?.mode === "open" && !viaCarriedAlias ? (
            <ShareChecklist
              requests={docRequests}
              seafarerId={seafarer.id}
              shareToken={seafarer.shareToken}
            />
          ) : (
            <DocRequestChecklist requests={docRequests} />
          )}
        </div>
      )}

      {myCirculars.length > 0 && (
        <div className="mt-6" data-testid="inbox">
          <h2 className="font-semibold text-slate-900">Messages</h2>
          <ul className="mt-2 space-y-2">
            {myCirculars.map((c) => (
              <li
                key={c.id}
                data-testid="inbox-item"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <p className="font-medium text-slate-800">{c.subject}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {c.authorName} · {fmtCircular(c.createdAt)}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{c.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <AgentDocList documents={documents} seafarerName={seafarer.name} duplicates={duplicates} fileToken={params.token} />
      </div>
    </div>
  );
}
