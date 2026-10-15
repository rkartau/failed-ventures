import type { Metadata } from "next";
import Link from "next/link";
import { breadcrumbList, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink, portalHostname } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { REGISTRY_PAGE_SLUGS, registryPagePath, registryRow } from "@/lib/registry/public-rows";

// PUBLIC, INDEXABLE per-registry page for Azerbaijan (SEO Phase 2b; revised by the SEO
// implementation plan WP-D, D5). Server component. The authority name, portal URL and input
// labels come from lib/registry/public-rows.ts (row "AZ"); the dev `notes` field is never
// read. Facts about the portal's interface were read on the portal page on 7 September 2026
// and are marked [src:portal-AZ]. One FAQ array drives both the visible <dl data-faq-q> and the
// FAQPage JSON-LD. Copy follows docs/WRITING-STYLE-GUIDE.md. Route:
// /registries/azerbaijan (canonical self).
function requireRow(code: string) {
  const row = registryRow(code);
  if (!row) throw new Error(`registries/azerbaijan: public registry row ${code} is required`);
  return row;
}
const ROW = requireRow("AZ");

const TITLE = "Verify an Azerbaijan Seafarer Certificate";
const DESCRIPTION =
  "Check an Azerbaijan STCW seafarer certificate against the State Maritime and Port Agency (DDLA) register with the certificate number and date of birth.";
const PATH = "/registries/azerbaijan";
const HOST = portalHostname(ROW.portalUrl);

const LINK =
  "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    url: PATH,
    title: TITLE,
    description: DESCRIPTION,
    images: ["/opengraph-image.jpg"],
  },
  twitter: { title: TITLE, description: DESCRIPTION, images: ["/twitter-image.jpg"] },
};

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Registries", path: "/registries" },
    { name: "Azerbaijan", path: PATH },
  ],
  PATH
);

const webPage = {
  ...webPageJsonLd({ path: PATH, name: TITLE, description: DESCRIPTION, dateModified: CONTENT_LAST_UPDATED_ISO }),
  about: { "@type": "GovernmentOrganization", name: ROW.authority, url: ROW.portalUrl },
};

// FAQ: the ONE source for both the visible <dl> and the FAQPage JSON-LD (parity by construction).
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Which authority does Docka check against for Azerbaijan?",
    a: `The ${ROW.authority}, the Azerbaijani government body that issues and records seafarer certificates.`,
  },
  {
    q: "Is this a live check or a manual one?",
    a: "Live and automatic. Docka queries the agency's own verification service and returns the result; it does not re-type or interpret the PDF.",
  },
  {
    q: "What do I need to run a check?",
    a: `Two things: the ${ROW.inputs.join(" and the ")}. Keep any /YY suffix on the number.`,
  },
  {
    q: "Does a positive result mean the certificate is government-verified?",
    a: "Because the check goes to the agency's register directly, an Azerbaijani result can reach Docka's strongest level, L3 (Government-verified). Docka labels each result with the level it reached.",
  },
  {
    q: "Do you store the certificate holder's personal data?",
    a: "The agency's answer can include the holder's name and a photo; Docka does not read or keep the photo. Payment details are never stored by Docka either; billing runs through Stripe.",
  },
  {
    q: "Is Docka part of the Azerbaijani government?",
    a: "No. Docka is independent software built by Docka Development OÜ (Tallinn, Estonia). It queries the official agency service on your behalf.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

// Sibling registry pages: every slug in the shared map except this one.
const SIBLINGS = Object.keys(REGISTRY_PAGE_SLUGS)
  .filter((code) => code !== ROW.code)
  .map((code) => ({ code, href: registryPagePath(code)!, name: registryRow(code)?.country ?? code }));

export default function AzerbaijanRegistryPage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(webPage) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500">
          <Link href="/registries" className="text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            Registry coverage
          </Link>{" "}
          / Azerbaijan
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Verify an Azerbaijan seafarer certificate
        </h1>
        <LastUpdated />
        <p data-testid="byline" className="mt-1 text-xs text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          To verify an Azerbaijan STCW seafarer certificate, check it against the register of the{" "}
          <strong>{ROW.authority}</strong>, the country&apos;s maritime authority. Docka runs that check
          live and automatically: it queries the agency&apos;s public seafarer-verification service and
          reports back what it returns.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          If you crew vessels or manage compliance and you need to know whether an Azerbaijani certificate
          is on the authority&apos;s records, this is a primary-source check, not a look at the PDF.
        </p>

        {/* Authority line: the ONE portal-link primitive, fed from the public row. */}
        <p className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700" data-testid="authority-line">
          <span className="font-semibold text-slate-900">Authority:</span> {ROW.authority}.{" "}
          <span className="font-semibold text-slate-900">Official verification portal:</span>{" "}
          <RegistryPortalLink portalUrl={ROW.portalUrl} label={`official verification portal (${HOST})`} className={LINK} />
          . {/* [src:portal-AZ:page title "Verification of seafarer's documents", shown in Azerbaijani and English] */}
          The portal is bilingual, Azerbaijani and English, on one page.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What Docka can confirm</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li>
            <strong>Live automatic verification against the agency&apos;s register.</strong> Docka submits
            the certificate details to the agency&apos;s own service and returns the result, stamped with
            the time of the query.
          </li>
          <li>
            <strong>A government-verified result (level L3)</strong> is reachable for Azerbaijan, because
            the check goes straight to the flag-state authority&apos;s records.
          </li>
          <li>
            <strong>What it cannot confirm:</strong> anything the register does not hold. A not-found
            answer is reported as not found, and Docka does not guess at the reason.
          </li>
        </ul>
        <p className="mt-4 leading-relaxed text-slate-700">
          Every result carries one of Docka&apos;s four trust levels, L0 to L3, which say how far the check
          reached. The full table is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
            how seafarer certificate verification actually works
          </Link>
          .
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Do it yourself on the official portal</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The agency&apos;s service matches on two pieces of information printed on the certificate. The
          labels below are Docka&apos;s; the fields are the portal&apos;s.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          <li>
            Open the{" "}
            <RegistryPortalLink portalUrl={ROW.portalUrl} label={`official portal at ${HOST}`} className={LINK} />{" "}
            and choose <strong>Certificate of Competency</strong> in the document-type list.
            {/* [src:portal-AZ:"-- Select document type --" list: Certificate of Competency, Special Training Certificate, Seafarers' Identity Document, Seaman's Record Book] */}
          </li>
          <li>
            Enter the <strong>{ROW.inputs[0]}</strong>. Keep the slash and the two-digit year suffix
            exactly as they appear on the document.
          </li>
          <li>
            Enter the holder&apos;s <strong>{ROW.inputs[1]}</strong> and press Check. Read the answer as
            the status of the document.
            {/* [src:portal-AZ:"Check" button] */}
          </li>
        </ol>

        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-slate-700" data-testid="not-found-block">
          <p className="font-semibold text-slate-900">Not found?</p>
          <p className="mt-1">
            First re-check the number: the suffix after the slash is part of it, and the date of birth must
            match the document. If the register still does not know the certificate, Docka records the
            result as not found and you can request a manual verification, which a person follows up with
            the agency. We do not quote a turnaround time for that request; it depends on the agency.
          </p>
        </div>

        <h2 className="mt-10 text-xl font-bold text-slate-900">An Azerbaijan-specific detail</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The agency&apos;s public service answers a lookup straight away, with no step that a person
          has to complete on the portal first. That is what makes an automatic check possible here, and
          why an Azerbaijani certificate can reach a government-verified result instead of an assisted
          &quot;go and check it yourself&quot; hand-off.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          The answer can include the holder&apos;s name and a photo. Docka does not read or keep the photo;
          it records the certificate&apos;s status and the time of the query.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 space-y-6">
          {FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>

        <WhatDockaIs />

        {/* Hub-and-spoke internal links (descriptive anchors). */}
        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Next steps</h2>
          <ul className="mt-3 space-y-2 text-slate-700">
            <li>
              <Link href="/verify" className={LINK}>
                Verify an Azerbaijan seafarer certificate now
              </Link>
            </li>
            <li>
              <Link href="/registries" className={LINK}>
                Back to all registries Docka verifies
              </Link>
            </li>
            <li>
              <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
                How seafarer certificate verification actually works
              </Link>
            </li>
            <li>
              <Link href="/overview/agencies" className={LINK}>
                See how Docka works for crewing agencies
              </Link>
            </li>
            <li>
              <Link href="/pricing" className={LINK}>
                Review agency pricing
              </Link>
            </li>
          </ul>
          <p className="mt-4 text-sm font-semibold text-slate-900">Other flag states</p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
            {SIBLINGS.map((s) => (
              <li key={s.code}>
                <Link href={s.href} className={LINK}>
                  {s.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </article>
    </div>
  );
}
