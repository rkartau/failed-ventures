import type { Metadata } from "next";
import Link from "next/link";
import {
  breadcrumbList,
  jsonLd,
  plainPunct,
  webPageJsonLd,
  CONTENT_LAST_UPDATED_ISO,
  CONTENT_LAST_UPDATED_LABEL,
} from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink, portalHostname } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { REGISTRY_PAGE_SLUGS, registryPagePath, registryRow } from "@/lib/registry/public-rows";
import { LEVEL_META } from "@/lib/verification-level";
import { REGISTRY_PAGES_PUBLISHED_ISO, registryPagePathFor, type RegistryPageData } from "@/lib/registry-pages";

// Shared shell for the six per-country registry pages (SEO plan WP-E, E2). Server
// component. Everything country-specific comes from `lib/registry-pages.ts` (prose) and
// `lib/registry/public-rows.ts` (authority, portal URL, input labels, userNotes): the only
// registry data this file may touch (plan R7; never `notes`). JSON-LD: one WebPage (with
// `about: GovernmentOrganization`), one FAQPage built from the SAME array as the visible
// <dl data-faq-q>, one BreadcrumbList with @id.

const LINK = "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";
const HOW_WORKS_GUIDE = "/resources/how-seafarer-certificate-verification-works";

// Trust ladder rendered from LEVEL_META (plan R6: never a re-typed table). Punctuation is
// normalised at the DATA layer, module scope, not in JSX (plan R8/S1).
// [src:real-features:L0-L3 ladder from lib/verification-level.ts LEVEL_META]
const LADDER = ([0, 1, 2, 3] as const).map((n) => ({
  code: LEVEL_META[n].code,
  word: plainPunct(LEVEL_META[n].word),
  tip: plainPunct(LEVEL_META[n].tip),
}));

/** `metadata` for a registry page: plain-string title, self-canonical, OG article. */
export function registryPageMetadata(page: RegistryPageData): Metadata {
  const path = registryPagePathFor(page);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      url: path,
      title: page.title,
      description: page.description,
      images: [{ url: "/opengraph-image.jpg", alt: page.ogAlt }],
    },
    twitter: { title: page.title, description: page.description, images: ["/twitter-image.jpg"] },
  };
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-base font-semibold text-slate-900" data-faq-q>
        {q}
      </dt>
      <dd className="mt-1 text-sm leading-relaxed text-slate-700">{children}</dd>
    </div>
  );
}

export function RegistryCountryPage({ page }: { page: RegistryPageData }) {
  const row = registryRow(page.code);
  if (!row) throw new Error(`RegistryCountryPage: no public registry row for ${page.code}`);
  const path = registryPagePathFor(page);
  const host = portalHostname(row.portalUrl);

  const breadcrumbJsonLd = breadcrumbList(
    [
      { name: "Home", path: "/" },
      { name: "Registries", path: "/registries" },
      { name: page.country, path },
    ],
    path
  );

  const webPage = {
    ...webPageJsonLd({
      path,
      name: page.title,
      description: page.description,
      dateModified: CONTENT_LAST_UPDATED_ISO,
    }),
    datePublished: REGISTRY_PAGES_PUBLISHED_ISO,
    about: { "@type": "GovernmentOrganization", name: row.authority, url: row.portalUrl },
  };

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faq.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  // Sibling registry pages (every slug in the shared map except this one).
  const siblings = (Object.keys(REGISTRY_PAGE_SLUGS) as Array<keyof typeof REGISTRY_PAGE_SLUGS>)
    .filter((code) => code !== page.code)
    .map((code) => ({ code, href: registryPagePath(code)!, name: registryRow(code)?.country ?? String(code) }));

  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(webPage) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500">
          <Link href="/registries" className="text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            Registry coverage
          </Link>{" "}
          / {page.country}
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {page.h1}
        </h1>
        <LastUpdated />
        <p data-testid="byline" className="mt-1 text-xs text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>

        {page.intro.map((p, i) => (
          <p key={i} className={i === 0 ? "mt-5 text-lg leading-relaxed text-slate-700" : "mt-4 leading-relaxed text-slate-700"}>
            {p}
          </p>
        ))}

        {/* Authority line: the ONE portal-link primitive, fed from the public row (plan R6/S1). */}
        <p className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700" data-testid="authority-line">
          <span className="font-semibold text-slate-900">Authority:</span> {row.authority}.{" "}
          <span className="font-semibold text-slate-900">Official verification portal:</span>{" "}
          <RegistryPortalLink portalUrl={row.portalUrl} label={host} className={LINK} />
          . {page.localHint}
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What Docka confirms</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          {page.whatDockaConfirms.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the portal asks for</h2>
        <table className="mt-3 w-full border-collapse text-sm text-slate-700" data-testid="inputs-table">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="py-2 pr-4 font-semibold text-slate-900">Input</th>
              <th className="py-2 font-semibold text-slate-900">Required</th>
            </tr>
          </thead>
          <tbody>
            {row.inputs.map((label) => (
              <tr key={label} className="border-b border-slate-100">
                <td className="py-2 pr-4">{label}</td>
                <td className="py-2">{/(if present)/i.test(label) ? "Only when printed on the document" : "Yes"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Do it yourself on the official portal</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          {page.diySteps.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What to watch for</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          {row.userNotes ? <li>{row.userNotes}</li> : null}
          {page.caveats.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>

        {page.sections.map((s) => (
          <section key={s.h2}>
            <h2 className="mt-10 text-xl font-bold text-slate-900">{s.h2}</h2>
            {s.paras.map((p, i) => (
              <p key={i} className="mt-3 leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
          </section>
        ))}

        <h2 className="mt-10 text-xl font-bold text-slate-900">How Docka labels the result</h2>
        {/* [src:real-features:four-level L0-L3 ladder; a lower level is never rounded up] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Every document in Docka carries one of four levels. The level says how far the check reached, and a lower level is never rounded up.
        </p>
        <ul className="mt-3 space-y-1 text-slate-700" data-testid="trust-ladder">
          {LADDER.map((l) => (
            <li key={l.code}>
              <span className="font-semibold text-slate-900">
                {l.code} {l.word}
              </span>
              : {l.tip}
            </li>
          ))}
        </ul>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 space-y-6">
          {page.faq.map(({ q, a }) => (
            <Faq key={q} q={q}>
              {a}
            </Faq>
          ))}
        </dl>

        <WhatDockaIs />

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Related pages</h2>
          <ul className="mt-3 space-y-2 text-slate-700">
            <li>
              <Link href="/overview/agencies" className={LINK}>
                How Docka works for crewing agencies
              </Link>
            </li>
            <li>
              <Link href="/verify" className={LINK}>
                {page.h1} now
              </Link>
            </li>
            <li>
              <Link href="/registries" className={LINK}>
                All registries Docka verifies
              </Link>
            </li>
            <li>
              <Link href={HOW_WORKS_GUIDE} className={LINK}>
                How seafarer certificate verification actually works
              </Link>
            </li>
            <li>
              <Link href="/pricing" className={LINK}>
                Agency pricing
              </Link>
            </li>
          </ul>
          <p className="mt-4 text-sm font-semibold text-slate-900">Other flag states</p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
            {siblings.map((s) => (
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

export default RegistryCountryPage;
