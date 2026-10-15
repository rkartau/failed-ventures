"use client";

// Real "Verify a certificate" page (owner 2026-07-21; reordered per the SEO
// implementation plan v3 C4, 2026-09-06). DOM order, top to bottom:
//   1. H1 (t("vp.title")) + a one-line trust strip of the flag-state codes Docka
//      checks live (TRUST_BAR_AUTHORITIES) plus the Bulgaria existence check.
//   2. The verificator: the existing VerifyBox flow, reused as-is (paste-first
//      single field; per-country extra inputs only when the registry mandates them).
//   3. "What you get back" (what the verdict card shows, and what it does not claim).
//   4. "Which countries need a date of birth" (derived from inputs[].source).
//   5. "Which official portal?" (REGISTRY_PUBLIC_ROWS + RegistryPortalLink: every
//      outbound authority link is the pinned portalUrl from countries.ts).
//   6. About our registry connections: the per-connection cards (auto +
//      auto-presence + the UA TCCS entry) and the LV embedded official form.
//   7. Links: /registries hub, the per-country registry pages, the agency tour.
//   8. FAQ (FAQPage JSON-LD mirrors the visible <dl>).
// Nothing about assisted/manual/other countries beyond the honest portal table
// (hero honesty steer). No logic duplicated here. The index route coexists with
// the /verify/[uuid] proof pages. English body copy: single-URL, cookie-localised
// site (same EN-content exception as the /resources articles); the H1 and the
// connection lines stay translated.

import { useState } from "react";
import Link from "next/link";
import { VerifyBox } from "@/components/VerifyBox";
import { useT } from "@/components/LanguageProvider";
import { RegistryEmbeddedPortal } from "@/components/RegistryInfo";
import { RegistryPortalLink, portalHostname } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { track } from "@/lib/analytics-events";
import { CONTENT_LAST_UPDATED_ISO, jsonLd, plainPunct, webPageJsonLd } from "@/lib/seo";
import {
  REGISTRY_PAGE_SLUGS,
  REGISTRY_PUBLIC_ROWS,
  registryPagePath,
  registryRow,
} from "@/lib/registry/public-rows";
import {
  AUTO_FLAG_STATE_COUNT,
  AUTO_REGISTRY_COUNTRIES,
  EMBEDDABLE_REGISTRY_COUNTRIES,
  PRESENCE_ONLY_COUNTRIES,
  TRUST_BAR_AUTHORITIES,
  countryDisplayName,
  displayRegion,
  joinNames,
} from "@/lib/registry/display";
import type { CountryEntry } from "@/lib/registry/types";

// One honest line per connection, keyed off the entry's shape in countries.ts:
// training-center -> TCCS wording; auto-presence (BG) -> document-existence
// wording; plain auto -> live validity check.
function lineKeyFor(c: CountryEntry): string {
  if (c.issuerKind === "training-center") return "vp.lineTraining";
  if (c.capability === "auto-presence") return "vp.linePresence";
  return "vp.lineAuto";
}

// Registries whose lookup needs the holder's date of birth on top of the certificate
// number: derived from the table's input sources, never a hand-typed country list.
const DOB_COUNTRIES: CountryEntry[] = AUTO_REGISTRY_COUNTRIES.filter((c) =>
  c.inputs.some((i) => i.source === "profile.birthDate")
);

// "Which official portal?" rows: the live connections (auto + auto-presence) plus the
// embeddable LV form, in table order, read through the PUBLIC projection (plainPunct
// applied in the data layer; never `notes`).
const PORTAL_CODES = new Set<string>([
  ...AUTO_REGISTRY_COUNTRIES.map((c) => c.country),
  ...EMBEDDABLE_REGISTRY_COUNTRIES.map((c) => c.country),
]);
const PORTAL_ROWS = REGISTRY_PUBLIC_ROWS.filter((r) => PORTAL_CODES.has(r.code));

// The per-country registry pages (Ukraine, Azerbaijan + the six WP-E pages), built
// from the ONE code -> slug map so no href is hand-typed.
const REGISTRY_PAGE_CODES = Object.keys(REGISTRY_PAGE_SLUGS);

const linkClass =
  "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

// SEO Tier 1 — FAQ on the /verify tool landing, seeded from the real proven-seam GSC
// queries (seafarer certificate verification, coc checker). The FAQPage JSON-LD is
// server-rendered into the initial HTML (this "use client" component still SSRs) and
// is the ONE source of truth for BOTH the visible <dl> and the JSON-LD, so they cannot
// drift. The /verify BreadcrumbList JSON-LD stays in verify/layout.tsx.
const VERIFY_FAQ: Array<{ q: string; a: string }> = [
  {
    q: "How does Docka verify a seafarer certificate?",
    a: "Docka runs a primary-source check: it queries the issuing flag state's official register instead of reading the PDF. For eight flag states the check is live and automatic. For Bulgaria it confirms the document exists. For every other country Docka takes you to the correct official portal and pre-fills what it can, and a person completes the check there.",
  },
  {
    q: "Is it free to verify a seafarer certificate?",
    a: "For seafarers, yes: you can look up and hold your own certificates at no cost, with no cap on the number of checks. Crewing agencies pay a monthly licence plus a fee per billable seafarer; the current figures are on the pricing page.",
  },
  {
    q: "What do I need to run a check?",
    a: "The certificate number exactly as printed, and, depending on the country, the holder's date of birth. The extra fields appear only when the flag-state registry itself requires them.",
  },
  {
    q: "Does a green result mean the certificate is government-verified?",
    a: "Only when the check reached the issuing authority's own register. Docka labels each result with the trust level it actually reached, from L0 (Unverified) to L3 (Government-verified), so a document-existence check is never presented as a full government verification.",
  },
  {
    q: "What if the flag state is not in the automatic list?",
    a: "Docka still helps, but a person finishes the check. It recognises the country from the certificate, opens that authority's official portal and fills in the fields it can read. The result you get there is the authority's own answer, and Docka records it as an assisted check, not as a government-verified one.",
  },
];

const verifyFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: VERIFY_FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

// The per-URL WebPage node (plan v3 C4/R12). Its `breadcrumb` @id resolves to the
// BreadcrumbList that verify/layout.tsx emits with `breadcrumbList(trail, "/verify")`.
const verifyWebPageJsonLd = webPageJsonLd({
  path: "/verify",
  name: "Verify a seafarer certificate online against the official flag-state registry",
  description:
    "Check a seafarer certificate against the official flag-state registry and get a labelled verdict: what the register confirmed, what it did not, and which portal to use.",
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

const thClass = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600";
const tdClass = "px-3 py-2 align-top text-sm text-slate-700";

export default function VerifyIndexPage() {
  const { t, lang } = useT();
  // Embeddable-country card (LV): clicking it opens the official portal
  // iframe box directly on this page. No code paste needed, no prefill
  // fields on this entry path (the user types into the official form).
  const [embedOpen, setEmbedOpen] = useState<string | null>(null);
  // Honest count sentence: same story as the home hero (N flag states) + the Bulgaria
  // existence check. Derived from the shared display constants so it can never drift.
  const presenceNames = joinNames(
    PRESENCE_ONLY_COUNTRIES.map((c) => countryDisplayName(c.country, lang, c.countryName)),
    lang
  );
  const name = (c: { country: string; countryName: string }) =>
    countryDisplayName(c.country, lang, c.countryName);
  // GA4 funnel: every outbound official-portal link fires ONE constant cta_click
  // (no portal URL, no country in the params) through the RegistryPortalLink hook.
  const trackPortalClick = () => track("cta_click", { location: "verify_portals", target: "portal-link" });

  return (
    <div className="hero-bg min-h-full">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(verifyWebPageJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(verifyFaqJsonLd) }}
      />
      <section className="mx-auto max-w-3xl px-4 pb-16 pt-12 sm:pt-16" data-testid="verify-page">
        {/* ---- 1. H1 + trust strip -------------------------------------------- */}
        <h1
          className="text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl"
          data-testid="verify-page-title"
        >
          {t("vp.title")}
        </h1>
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs" data-testid="verify-trust-strip">
          <span className="mr-1 font-medium text-slate-600">Live against:</span>
          {TRUST_BAR_AUTHORITIES.map((c) => (
            <span
              key={c.country}
              title={c.authority}
              className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md bg-brand-100 px-1.5 font-bold text-brand-700"
            >
              {displayRegion(c.country)}
            </span>
          ))}
          {PRESENCE_ONLY_COUNTRIES.map((c) => (
            <span
              key={c.country}
              title={c.authority}
              className="inline-flex h-6 items-center rounded-md border border-slate-300 bg-white px-1.5 font-semibold text-slate-600"
            >
              {displayRegion(c.country)} existence
            </span>
          ))}
        </p>

        {/* ---- 2. The verificator ------------------------------------------- */}
        <h2 className="mt-8 text-lg font-bold text-slate-900" data-testid="verify-box-title">
          {t("vp.verifTitle")}
        </h2>
        <p className="mt-2 text-sm text-slate-600" data-testid="verify-page-intro">
          {t("vp.intro")}
        </p>
        <div className="mt-4" data-testid="verify-page-box">
          <VerifyBox />
        </div>

        <WhatDockaIs />

        {/* ---- 3. What you get back ---------------------------------------- */}
        <h2 className="mt-12 text-lg font-bold text-slate-900">What you get back</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          Paste the certificate number, or upload a photo or PDF of the document, and Docka
          queries the issuing authority&apos;s register. The answer is a verdict card. It shows
          the document title as the register holds it, the holder&apos;s name where the register
          returns one (medical certificates carry no name), the status and validity, the issue
          and expiry dates, the certificate type, and the authority that answered. Under the card
          Docka states which register it checked against, so you never have to guess where the
          answer came from.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          The verdict also carries the trust level the check reached. L3 Government-verified
          means the flag state&apos;s own register confirmed the record for this holder. L2
          Registry-confirmed means the document exists in the register but the holder was not
          tied to it. When a register cannot be reached automatically, Docka says so and points
          you to the official portal instead of guessing. We never re-type a PDF and call it
          verified. A seafarer who adds the certificate to a Docka profile gets a proof page for
          it that a port state control (PSC) inspector or a crewing manager can open.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          What Docka cannot do: it cannot verify a certificate whose flag state has no public
          register or no machine connection, and it cannot confirm identity from a
          document-existence lookup. Coverage limits per register are shown on the connection
          cards further down this page, straight from the registry table.
        </p>

        {/* ---- 4. Which countries need a date of birth ----------------------- */}
        <h2 className="mt-10 text-lg font-bold text-slate-900">
          Which countries need a date of birth
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          Most registers answer on the certificate number alone. A few key the record on the
          holder as well, so their lookup asks for the date of birth printed on the document.
          Docka only shows the extra field when the register itself requires it; the list below
          is derived from the same table the verificator uses.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm" data-testid="verify-dob-table">
            <thead className="bg-slate-50">
              <tr>
                <th className={thClass}>Flag state</th>
                <th className={thClass}>Register</th>
                <th className={thClass}>What the register asks for</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {DOB_COUNTRIES.map((c) => {
                const row = registryRow(c.country);
                return (
                  <tr key={c.country}>
                    <td className={`${tdClass} font-semibold text-slate-900`}>{name(c)}</td>
                    <td className={tdClass}>{row?.authorityShort ?? row?.authority ?? c.authority}</td>
                    <td className={tdClass}>{(row?.inputs ?? c.inputs.map((i) => i.label)).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ---- 5. Which official portal? ------------------------------------ */}
        <h2 className="mt-10 text-lg font-bold text-slate-900">Which official portal?</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          Every check Docka runs goes to one of these portals. If you would rather do the lookup
          yourself, or you need to show an inspector the primary source, these are the links.
          Each one is the pinned address from our registry table, not a search result.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm" data-testid="verify-portal-table">
            <thead className="bg-slate-50">
              <tr>
                <th className={thClass}>Country</th>
                <th className={thClass}>Authority</th>
                <th className={thClass}>Official portal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {PORTAL_ROWS.map((r) => {
                const guide = registryPagePath(r.code);
                return (
                  <tr key={r.code}>
                    <td className={`${tdClass} font-semibold text-slate-900`}>
                      {guide ? (
                        <Link href={guide} className={linkClass}>
                          {r.country}
                        </Link>
                      ) : (
                        r.country
                      )}
                    </td>
                    <td className={tdClass}>{r.authorityShort ?? r.authority}</td>
                    <td className={tdClass}>
                      <RegistryPortalLink
                        portalUrl={r.portalUrl}
                        label={portalHostname(r.portalUrl)}
                        className={linkClass}
                        onClick={trackPortalClick}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ---- 6. About our registry connections --------------------------- */}
        <h2 className="mt-10 text-lg font-bold text-slate-900" data-testid="verify-conn-title">
          {t("vp.connTitle")}
        </h2>
        <p className="mt-2 text-sm text-slate-600" data-testid="verify-conn-summary">
          {t("vp.connSummary", { autoCount: AUTO_FLAG_STATE_COUNT, presence: presenceNames })}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="registry-connections">
          {AUTO_REGISTRY_COUNTRIES.map((c) => {
            // Public projection (plainPunct applied in the data layer; never `notes`).
            const row = registryRow(c.country);
            return (
              <div
                key={c.country}
                className="rounded-2xl border border-slate-200 bg-white p-4"
                data-testid="registry-connection"
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md bg-brand-100 px-1.5 text-xs font-bold text-brand-700">
                    {c.country}
                  </span>
                  <span className="font-semibold text-slate-900">{name(c)}</span>
                </div>
                <p className="mt-2 text-xs font-medium text-slate-600">{row?.authority ?? c.authority}</p>
                <p className="mt-1 text-xs text-slate-500">{plainPunct(t(lineKeyFor(c)))}</p>
                {/* Honesty audit 2026-08-13: coverage caveats (UA-MARAD 2023+,
                    BG 2017+) surface on the card via the entry's userNotes. */}
                {row?.userNotes && (
                  <p className="mt-1 text-xs text-slate-500" data-testid="registry-connection-note">
                    {row.userNotes}
                  </p>
                )}
                <p className="mt-2 text-xs">
                  <RegistryPortalLink
                    portalUrl={row?.portalUrl ?? c.portalUrl}
                    className={linkClass}
                    onClick={trackPortalClick}
                  />
                </p>
              </div>
            );
          })}
          {/* Embeddable countries (LV): honest in-page card. The official
              form is shown right here, the HUMAN completes the check. NEVER
              added to the home-hero automatic list. */}
          {EMBEDDABLE_REGISTRY_COUNTRIES.map((c) => (
            <div
              key={c.country}
              data-testid={`${c.country.toLowerCase()}-card`}
              role="button"
              tabIndex={0}
              onClick={() => setEmbedOpen((o) => (o === c.country ? null : c.country))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEmbedOpen((o) => (o === c.country ? null : c.country));
                }
              }}
              className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-brand-300"
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md bg-brand-100 px-1.5 text-xs font-bold text-brand-700">
                  {c.country}
                </span>
                <span className="font-semibold text-slate-900">{name(c)}</span>
              </div>
              <p className="mt-2 text-xs font-medium text-slate-600">
                {registryRow(c.country)?.authority ?? c.authority}
              </p>
              <p className="mt-1 text-xs text-slate-500">{plainPunct(t("vp.lineEmbed"))}</p>
              <span className="mt-2 inline-block min-h-[44px] rounded-lg border border-slate-300 bg-white px-2.5 py-2.5 text-xs font-semibold text-slate-700">
                {t("emb.open")}
              </span>
            </div>
          ))}
        </div>
        {/* The in-page official-portal box the card opens (full width, below
            the grid; a 2-col cell is too cramped for the framed form). No
            prefill on this entry path: the user types into the form itself. */}
        {EMBEDDABLE_REGISTRY_COUNTRIES.filter((c) => c.country === embedOpen).map((c) => (
          <div
            key={c.country}
            data-testid="verify-embed-box"
            className="mt-3 rounded-2xl border border-slate-200 bg-white p-4"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {name(c)}: {registryRow(c.country)?.authority ?? c.authority}
            </p>
            <RegistryEmbeddedPortal country={c} defaultOpen />
          </div>
        ))}

        {/* ---- 7. Links ------------------------------------------------------ */}
        <h2 className="mt-10 text-lg font-bold text-slate-900">
          Looking for a specific country&apos;s registry?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          The{" "}
          <Link href="/registries" className={linkClass}>
            registry coverage page
          </Link>{" "}
          lists every flag state Docka checks, the authority behind each register, the check
          type and the inputs it asks for. Each live register also has its own page with the
          do-it-yourself steps on the official portal:
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="verify-registry-pages">
          {REGISTRY_PAGE_CODES.map((code) => {
            const row = registryRow(code);
            const href = registryPagePath(code);
            if (!row || !href) return null;
            return (
              <li key={code}>
                <Link href={href} className={linkClass}>
                  {countryDisplayName(displayRegion(code), lang, row.country)} registry
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">
          Crewing an agency roster rather than one certificate? The{" "}
          <Link href="/overview/agencies" className={linkClass}>
            agency tour
          </Link>{" "}
          shows how the same check runs across a whole crew list, with a hard block the moment a
          required certificate lapses.
        </p>

        {/* ---- 8. FAQ (SEO Tier 1; mirrors the FAQPage JSON-LD above) ----- */}
        <h2 className="mt-12 text-lg font-bold text-slate-900" data-testid="verify-faq-title">
          Frequently asked questions
        </h2>
        <dl className="mt-4 space-y-6" data-testid="verify-faq">
          {VERIFY_FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
