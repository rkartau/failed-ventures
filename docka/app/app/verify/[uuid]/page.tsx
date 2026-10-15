import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { buildPublicProof } from "@/lib/verify-record";
import { clientIpFromHeaders } from "@/lib/registry";
import { abs } from "@/lib/seo";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";

export const dynamic = "force-dynamic";

// NOINDEX — a specific person's public proof page (per-uuid); page-level export is
// sufficient (TS2). Bare /verify (the public tool landing) stays INDEXABLE. Kept
// crawlable (no robots.txt disallow).
//
// generateMetadata (NOT a static `metadata`) so each proof page SELF-CANONICALIZES
// to its own /verify/<uuid> URL — this OVERRIDES the /verify layout's canonical so
// the indexable "/verify" canonical can never bleed onto these noindex per-person
// pages. Single metadata source: there is no static `metadata` export.
export function generateMetadata({ params }: { params: { uuid: string } }): Metadata {
  return {
    robots: { index: false, follow: false },
    alternates: { canonical: abs("/verify/" + params.uuid) },
  };
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

// PUBLIC, no-login outward re-verification page (roadmap T1.4; per-country since
// increment 8). Anyone who scans the certificate QR lands here and sees a minimal,
// privacy-safe confirmation that the credential is government-verified — re-checked
// LIVE against the issuing country's registry where that registry supports it, or an
// honest snapshot of the verified record where it does not (§5.4) — with NO sensitive
// data (no personal code, no date of birth, no photo, no file). Rate-limited (§2.4):
// over the limit the page stays friendly and shows the stored record with NO fetch.
export default async function VerifyPage({ params }: { params: { uuid: string } }) {
  const clientIp = clientIpFromHeaders(headers() as unknown as Headers);
  const proof = await buildPublicProof(params.uuid, { clientIp });

  if (!proof) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </div>
        <h1 className="mt-4 text-2xl font-bold text-slate-900">Verification link not recognised</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          This link is invalid, has been reset, or does not point to a government-verified
          credential. Ask the seafarer for a current verification QR.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Go to docka
        </Link>
      </div>
    );
  }

  const ok = proof.valid;
  // #S1 (SAFETY) — emerald "verified live today" is reserved for a GENUINE fresh live
  // re-check against the registry on THIS request. A cached (short-TTL), rate-limited,
  // unreachable, or by-design snapshot record is an honest AMBER "not live-verified
  // today", never the full green, so a stale record can never masquerade as a live
  // government confirmation. Only reVerified (recheckState === "live") AND not served
  // from cache keeps the emerald.
  const freshLive = proof.reVerified && !proof.liveCached;
  const verdict: "live" | "cached" | "invalid" = !ok ? "invalid" : freshLive ? "live" : "cached";
  const accent =
    verdict === "live"
      ? { ring: "ring-emerald-200", bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" }
      : verdict === "cached"
        ? { ring: "ring-amber-200", bg: "bg-amber-50", text: "text-amber-900", dot: "bg-amber-500" }
        : { ring: "ring-rose-200", bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" };

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* Verdict banner */}
        <div className={`flex items-center gap-3 rounded-t-2xl px-6 py-5 ${accent.bg} ring-1 ${accent.ring}`}>
          <span className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full ${accent.dot} text-white`}>
            {verdict === "live" ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : verdict === "cached" ? (
              // A CLOCK — this record is on file but was not re-confirmed live today.
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            )}
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">docka credential check</p>
            <h1 className={`text-lg font-bold ${accent.text}`} data-testid="verify-verdict">
              {verdict === "live"
                ? "Government-verified · verified live today"
                : verdict === "cached"
                  ? "Cached record — not live-verified today"
                  : "Not currently valid"}
            </h1>
            {/* #S1 — in the AMBER cached state the LAST VERIFIED date is made prominent,
                so the reader sees exactly how fresh the record on file is. */}
            {verdict === "cached" && (
              <p className="mt-0.5 text-sm font-semibold text-amber-900" data-testid="verify-last-verified">
                {proof.verifiedOn
                  ? `Last verified ${fmtDate(proof.verifiedOn)} — re-confirm live below`
                  : "Not re-confirmed live today — see the record on file below"}
              </p>
            )}
            <div className="mt-1.5" data-testid="verify-level">
              <VerificationLevelBadge
                level={proof.level}
                tooltip={proof.levelTooltip}
                size="sm"
                verifiedOn={proof.verifiedOn}
                // #S1 (SAFETY) — in the amber CACHED state the trust badge is demoted
                // to amber too, so emerald appears ONLY on a genuine live re-check.
                {...(verdict === "cached"
                  ? {
                      toneClassName: "bg-amber-100 text-amber-800 ring-amber-200",
                      dotClassName: "bg-amber-500",
                    }
                  : {})}
              />
            </div>
          </div>
        </div>

        {/* Fields */}
        <dl className="divide-y divide-slate-100 px-6 py-2">
          {proof.holderName && (
            <Row label="Holder" value={proof.holderName} testId="verify-holder" />
          )}
          <Row label="Certificate" value={proof.certificateTitle} testId="verify-title" />
          <Row label="Type" value={proof.category} />
          {proof.rank && <Row label="Rank / position" value={proof.rank} testId="verify-rank" />}
          <Row
            label="Expiry"
            value={proof.expiry ? fmtDate(proof.expiry) : "No expiry"}
            testId="verify-expiry"
          />
          {proof.printedExpiry && (
            <Row label="Printed expiry" value={`${fmtDate(proof.printedExpiry)} (see note)`} />
          )}
          <Row label="Issued by" value={proof.issuedBy} testId="proof-issuer" />
          <Row label="Verified against" value={proof.verifiedAgainst} testId="proof-registry" />
          {/* F10e — an honest timestamp: only a LIVE re-check may claim this
              page-load instant. Snapshot / unreachable / rate-limited states
              show the LAST REAL verification time of the stored record. */}
          {proof.reVerified ? (
            <Row label="Checked" value={fmtInstant(proof.verifiedAt)} testId="verify-at" />
          ) : (
            <Row
              label="Last verified"
              value={proof.verifiedOn ? fmtInstant(proof.verifiedOn) : "—"}
              testId="verify-at"
            />
          )}
        </dl>

        {proof.legalNote && (
          <div className="mx-6 mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200" data-testid="verify-legal-note">
            {proof.legalNote}
          </div>
        )}

        {/* Provenance line — §5.4 re-check states, honestly worded per state. */}
        <div className="rounded-b-2xl border-t border-slate-100 bg-slate-50 px-6 py-4">
          <p
            className="flex items-center gap-2 text-xs text-slate-500"
            data-testid="proof-recheck-state"
            data-state={proof.recheckState}
          >
            <span
              className={`h-2 w-2 flex-shrink-0 rounded-full ${proof.reVerified ? "bg-emerald-500" : "bg-amber-500"}`}
              aria-hidden="true"
            />
            {proof.recheckState === "live"
              ? proof.liveCached
                ? "Confirmed against the official government registry in the last few minutes."
                : "Re-checked live against the official government registry just now."
              : proof.recheckState === "snapshot"
                ? `Verified${proof.verifiedOn ? ` on ${fmtDate(proof.verifiedOn)}` : ""} — a live re-check is not available for this registry, so this shows the government-verified record on file.`
                : proof.recheckState === "rate-limited"
                  ? "Too many checks right now — showing the last government-verified record on file. Please try again in a minute."
                  : "The registry could not be reached just now — showing the last government-verified record on file."}
          </p>
          {proof.registryUrl && (
            <a
              href={proof.registryUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
              data-testid="verify-registry-link"
            >
              Open the official registry record
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 17 17 7" />
                <path d="M7 7h10v10" />
              </svg>
            </a>
          )}
        </div>
      </div>

      <p className="mx-auto mt-4 max-w-md text-center text-[11px] leading-relaxed text-slate-400">
        This page confirms only that the named credential is (or is not) valid in the government
        registry. It intentionally shows no personal code, date of birth, photo or document image.
        Powered by <Link href="/" className="font-medium text-slate-500 hover:underline">docka</Link>.
      </p>
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-right text-sm font-semibold text-slate-800" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
