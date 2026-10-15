import type { Metadata } from "next";
import Link from "next/link";
import { HomeClient } from "@/components/HomeClient";
import { SITE_URL, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO } from "@/lib/seo";

// SERVER component so the home route can export `metadata` (the interactive hero
// lives in the HomeClient client child, still rendered inside LanguageProvider by
// the root layout, so useT + VerifyBox keep working). title.default + description
// come from the root layout; here we pin the home canonical + OG.
export const metadata: Metadata = {
  // Home canonical == the bare origin, NO trailing slash. Next 14 (trailingSlash:false,
  // our default) normalises the rendered <link rel="canonical"> by stripping a trailing
  // slash, so abs("/") ("https://docka.me/") would RENDER as "https://docka.me" anyway —
  // and every other page's canonical is already slash-less. We therefore pin the origin
  // and align the sitemap's home loc to the SAME slash-less value (see sitemap.ts), so the
  // rendered canonical and the sitemap URL are byte-identical. Flipping trailingSlash:true
  // to keep the slash was rejected: it would 308-redirect and slash EVERY route, breaking
  // the canonical/sitemap match on all the other (slash-less) pages.
  alternates: { canonical: SITE_URL },
  openGraph: { url: SITE_URL },
};

// WebPage node for the home route (/), emitted from the SERVER wrapper so it does NOT touch
// the HomeClient render (the home-dom test renders HomeClient in isolation). Built by the
// shared webPageJsonLd helper (plan R6: one shape site-wide): "#webpage" @id, slash-less
// url === SITE_URL (matching the canonical), isPartOf the sitewide WebSite node by @id
// (never re-declaring WebSite/Organization here). breadcrumbId:false because the home
// route emits no BreadcrumbList. dateModified is the STATIC maintained content date.
const homeWebPageJsonLd = webPageJsonLd({
  path: "/",
  name: "Docka: a crewing agency CRM with seafarer certificate checks",
  description:
    "Docka is a CRM for crewing agencies: the crew roster, the documents and the expiry dates in one place, with certificates checked live against the issuing flag-state register.",
  dateModified: CONTENT_LAST_UPDATED_ISO,
  breadcrumbId: false,
});

// SEO Tier 1 / GEO (Iteration 2.2 + 2.3) — a single-sourced FAQ emitted from the SERVER
// wrapper (NOT HomeClient, so the home-dom render + the emerald===1 invariant are untouched).
// HOME_FAQ is the ONE source of truth: it drives BOTH the visible <dl data-faq-q> below AND
// the FAQPage JSON-LD, so the two can never drift. Every answer restates a fact already on
// the home page / in SITE_DESCRIPTION (PSV = primary source verification, live flag-state
// registry checks, the L0–L3 trust ladder, timestamped PSC-ready proof) — no invented stats.
// Positioning batch 2026-09-07 (plan v4 §2d): entry 0 is rewritten so the DefinedTerm on
// /what-is-primary-source-verification opens on the definition, not on the vendor, and it
// must stay BYTE-IDENTICAL to PSV_DEFINITION there. Two CRM entries are appended; nothing
// is dropped, and the test only asserts a lower bound on the pair count.
// This section also carries the definitional word-count expansion (2.3): its numeric prose
// lives here, OUTSIDE the swept home.* i18n keys, and the flag-state count stays a derived
// enumeration of the same eight states named on /registries, never a hardcoded home.* digit.
const HOME_FAQ: Array<{ q: string; a: string }> = [
  {
    q: "What is primary source verification (PSV)?",
    a: "Primary source verification (PSV) means asking the authority that issued the certificate (the flag state's official register) instead of trusting the PDF. Docka queries that register directly and returns a timestamped, PSC-ready result.",
  },
  {
    q: "How does Docka verify an STCW certificate?",
    a: "Docka checks the STCW certificate live against the issuing country's official flag-state register. For eight flag-state registries the check is live and automatic; for other countries Docka takes you to the correct official portal and pre-fills what it can so a person completes the check there.",
  },
  {
    q: "Is a PDF certificate proof that a credential is valid?",
    a: "No. A stamp, a signature or a QR code can all be copied, and an expiry date printed on a PDF is a claim, not a fact. Only the issuing authority's own register reflects the certificate's current status, which is why Docka verifies against the register rather than the document.",
  },
  {
    q: "What does a government-verified (L3) result mean?",
    a: "Docka labels every document on a trust ladder from L0 (Unverified) to L3 (Government-verified). L3 means the certificate was confirmed against the issuing country's official register — the strongest level — so a document-existence check is never presented as a full government verification.",
  },
  {
    q: "What does Docka do for a crewing agency?",
    a: "Docka is the CRM the agency's crewing desk works in. Every seafarer who granted the agency access sits on a five-stage board with their documents, expiry dates, sea service and appraisals, and Docka checks the certificates against the register of the flag state that issued them.",
  },
  {
    q: "Can I move my existing crew list into Docka?",
    a: "Yes. Upload the spreadsheet you already keep and each row becomes a crew card with its own claim link, so the seafarer uploads the documents and photographs the certificates. Nothing is emailed automatically: you send the links when you are ready.",
  },
];

const homeFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: HOME_FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(homeWebPageJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(homeFaqJsonLd) }}
      />
      <HomeClient />
      {/* Definitional depth + FAQ (server-rendered, below the interactive hero). */}
      <section className="mx-auto max-w-3xl px-4 pb-16 pt-4" data-testid="home-faq">
        <h2 className="text-2xl font-bold text-slate-900">
          What Docka does, in plain words
        </h2>
        <p className="mt-4 leading-relaxed text-slate-700">
          Docka is a CRM for crewing agencies. It checks maritime credentials the way a
          port-state inspection trusts them: against the issuing flag state&apos;s official
          register, not against the paper. Eight flag-state registries (Estonia, Denmark,
          Cyprus, the United Kingdom, Norway, France, Ukraine&apos;s state registry and
          Azerbaijan) are checked live and automatically. Bulgaria is confirmed
          as a document-existence check for certificates issued 2017 and later, and every other
          country is handled as an assisted check on the authority&apos;s official portal, where a
          person completes the check. Each result is labelled on a four-level trust ladder, from L0
          (Unverified) to L3 (Government-verified), so you always know how far a check actually
          reached. A document-existence result is never rounded up to a government verification.{" "}
          <Link
            href="/what-is-primary-source-verification"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            Read the full definition of primary source verification
          </Link>
          .
        </p>
        {/* Disambiguator (WP-B): Docka is often confused with crew-scheduling / rest-hours
            software in search; one plain sentence, server-rendered, outside the i18n keys. */}
        <p className="mt-4 leading-relaxed text-slate-700">
          Docka is a crewing agency CRM with certificate verification built in. It is not a
          rest-hours or watch-scheduling tool.
        </p>
        <h2 className="mt-10 text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 space-y-6">
          {HOME_FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
