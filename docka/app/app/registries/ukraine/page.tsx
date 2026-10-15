import type { Metadata } from "next";
import Link from "next/link";
import { breadcrumbList, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink, portalHostname } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { REGISTRY_PAGE_SLUGS, registryPagePath, registryRow } from "@/lib/registry/public-rows";

// PUBLIC, INDEXABLE per-registry page for Ukraine (SEO Phase 2b; revised by the SEO
// implementation plan WP-D, D5). Server component. The authority name, portal URL and input
// labels come from lib/registry/public-rows.ts (the STATE registry row "UA-MARAD" and the
// training-centre row "UA"); the dev `notes` field is never read. Facts about the portal's
// interface were read on the portal page on 7 September 2026 and are marked [src:portal-UA-MARAD].
// One FAQ array drives both the visible <dl data-faq-q> and the FAQPage JSON-LD. Copy follows
// docs/WRITING-STYLE-GUIDE.md. Route: /registries/ukraine (canonical self).
function requireRow(code: string) {
  const row = registryRow(code);
  if (!row) throw new Error(`registries/ukraine: public registry row ${code} is required`);
  return row;
}
const ROW = requireRow("UA-MARAD");
const TCCS = requireRow("UA");

const TITLE = "Verify a Ukraine Seafarer Certificate (CoC)";
const DESCRIPTION =
  "Check a Ukrainian STCW Certificate of Competency against the Maritime Administration of Ukraine's state register. Live check; coverage reliable from 2023.";
const PATH = "/registries/ukraine";
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
    { name: "Ukraine", path: PATH },
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
    q: "Which authority does Docka check against for Ukraine?",
    a: `For a flag-state check, the state register of the ${ROW.authorityShort ?? ROW.authority}. Docka also supports the separate Odessa training-centre validator, but that is not a flag-state verification.`,
  },
  {
    q: "Is this a live check or a manual one?",
    a: "Live and automatic. Docka queries the authority's own check-document service and returns the result.",
  },
  {
    q: "Why did an older certificate come back not found?",
    a: "The state register's quick search reliably covers documents issued 2023 and later. A not-found result on an older document is inconclusive, not proof that anything is wrong. You can ask Docka for a manual verification, which a person follows up with the administration.",
  },
  {
    q: "What do I need to run a check?",
    a: `Three things printed on the document: the ${ROW.inputs.join(", the ")}.`,
  },
  {
    q: "Is the Odessa training-centre result the same as a government check?",
    a: "No. That validator confirms the document exists in the training centre's records, an L2 registry-confirmed result. Only the state register can reach L3, Government-verified.",
  },
  {
    q: "Is Docka part of the Ukrainian government?",
    a: "No. Docka is independent software built by Docka Development OÜ (Tallinn, Estonia). It queries the official Ukrainian services on your behalf.",
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

export default function UkraineRegistryPage() {
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
          / Ukraine
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Verify a Ukraine seafarer certificate (Certificate of Competency)
        </h1>
        <LastUpdated />
        <p data-testid="byline" className="mt-1 text-xs text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          To verify a Ukrainian STCW certificate, check it against the state register of the{" "}
          <strong>{ROW.authorityShort ?? ROW.authority}</strong>. Docka runs that check live and
          automatically: it queries the authority&apos;s official check-document service and reports what
          it returns.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          Ukraine is worth reading carefully, because two very different Ukrainian services exist and they
          do not mean the same thing. This page is about the <strong>state register</strong>, the
          flag-state authority. It is not the Odessa training-centre validator (see the note below).
        </p>

        {/* Authority line: the ONE portal-link primitive, fed from the public row. */}
        <p className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700" data-testid="authority-line">
          <span className="font-semibold text-slate-900">Authority:</span> {ROW.authority}.{" "}
          <span className="font-semibold text-slate-900">Official verification portal:</span>{" "}
          <RegistryPortalLink portalUrl={ROW.portalUrl} label={`official verification portal (${HOST})`} className={LINK} />
          . {/* [src:portal-UA-MARAD:interface in Ukrainian with a language switcher offering English] */}
          The portal is in Ukrainian and has an English switcher at the top of the page.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What Docka can confirm</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li>
            <strong>Live automatic verification against the state register.</strong> Docka submits the
            document details to the authority&apos;s own service and returns the result, stamped with the
            time of the query.
          </li>
          <li>
            <strong>A government-verified result (level L3)</strong> is reachable for the Ukrainian state
            register, because the check goes to the flag-state authority.
          </li>
          <li>
            <strong>What it cannot confirm:</strong> a document the quick search does not index. For
            older issues the answer is inconclusive, and Docka says so instead of reporting a failure.
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

        <h2 className="mt-10 text-xl font-bold text-slate-900">The coverage caveat you must know</h2>
        <p className="mt-3 leading-relaxed text-slate-700">{ROW.userNotes}</p>
        <p className="mt-3 leading-relaxed text-slate-700">
          A not-found answer on an older document does not mean the certificate is fake or invalid; it may
          simply predate the searchable index. Docka records such a result as inconclusive and never as a
          failure.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Do it yourself on the official portal</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The Ukrainian service matches on three things printed on the document. The labels below are
          Docka&apos;s; the fields are the portal&apos;s.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          <li>
            Open the{" "}
            <RegistryPortalLink portalUrl={ROW.portalUrl} label={`official portal at ${HOST}`} className={LINK} />
            . If you do not read Ukrainian, switch the interface to English first.
            {/* [src:portal-UA-MARAD:language switcher Українська / English] */}
          </li>
          <li>
            Choose the <strong>{ROW.inputs[2]}</strong> from the portal&apos;s list (a certificate of
            competency is a &quot;Диплом&quot;) and enter the <strong>{ROW.inputs[0]}</strong>.
            {/* [src:portal-UA-MARAD:document-type list includes "Диплом"; document number field] */}
          </li>
          <li>
            Enter the <strong>{ROW.inputs[1]}</strong> using the day, month and year selectors, submit, and
            read the answer as the status of the document.
            {/* [src:portal-UA-MARAD:date of issue entered as day / month / year selectors] */}
          </li>
        </ol>

        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-slate-700" data-testid="not-found-block">
          <p className="font-semibold text-slate-900">Not found?</p>
          <p className="mt-1">
            For a document issued before 2023, a not-found answer is inconclusive: the quick search may not
            index it. Docka marks the result inconclusive, and you can request a manual verification, which
            a person follows up with the administration. We do not quote a turnaround time for that
            request; it depends on the administration.
          </p>
        </div>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Two Ukrainian services: don&apos;t confuse them</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          There is also a <strong>training-centre validator</strong> run by the {TCCS.authority}, at{" "}
          <RegistryPortalLink portalUrl={TCCS.portalUrl} className={LINK} />. Docka can query it too, but
          it is <strong>not</strong> the flag state. A result from the training centre confirms that a
          document exists in that training centre&apos;s records: a{" "}
          <strong>registry-confirmed document (L2)</strong>, never a government or flag-state validity
          verdict. Only the state register above can reach L3. Docka keeps the two clearly separate and
          labels each result for what it is.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          The training-centre validator keys its lookup on the {TCCS.inputs.join(" and the ")}, so a
          certificate of proficiency issued by the centre can be checked there even when the state
          register&apos;s quick search does not index it.
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
                Verify a Ukraine seafarer certificate now
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
