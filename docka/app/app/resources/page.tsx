import type { Metadata } from "next";
import Link from "next/link";
import { abs, breadcrumbList, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { WhatDockaIs } from "@/components/WhatDockaIs";

// PUBLIC, INDEXABLE resources index (SEO Phase 2b; revised by the SEO implementation plan
// WP-D, D7). Server component. A hub that links to the guides that exist, says who each one
// is for, and states the review policy. Copy follows docs/WRITING-STYLE-GUIDE.md.
// Route is /resources (canonical self).
const TITLE = "Resources: Seafarer Certificate Verification Guides";
const DESCRIPTION =
  "Plain-English guides to seafarer certificate verification from the team behind the Docka crewing agency CRM: primary-source checks, revalidation and PSC.";
const PATH = "/resources";

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
    { name: "Resources", path: PATH },
  ],
  PATH
);

// The guides, in the order we suggest reading them. `slug` values are resolved to route files
// by the dead-href test; `audience` is the visible "who should read this" line.
const ARTICLES: Array<{ slug: string; title: string; blurb: string; audience: string }> = [
  {
    slug: "/resources/how-seafarer-certificate-verification-works",
    title: "How seafarer certificate verification actually works",
    blurb:
      "Why reading a PDF is not verification, what a primary-source check against a flag-state register does, the difference between confirming a document exists and confirming it is valid, and the full L0 to L3 trust-level table.",
    audience: "Start here if you are new to registry checks: crewing managers, compliance officers and anyone who has to explain a result to an inspector.",
  },
  {
    slug: "/resources/check-stcw-certificate-valid",
    title: "How to check if an STCW certificate is still valid",
    blurb:
      "The expiry date printed on an STCW PDF is a claim, not proof. How to check a certificate's real status against the live flag-state register, what each of the eight live registers asks for, and what to do if the certificate is your own.",
    audience: "Seafarers checking their own certificate, and agencies with a contract starting soon.",
  },
  {
    slug: "/resources/spot-forged-recycled-seafarer-certificate",
    title: "Spot a forged or recycled seafarer certificate",
    blurb:
      "A forged certificate passes a human eye but not the issuing register, and a recycled one is a real number on the wrong person. How both get caught with a primary-source check and a cross-seafarer duplicate-number check.",
    audience: "Crewing desks that receive scanned certificates from applicants they have not met.",
  },
  {
    slug: "/resources/stcw-certificate-types",
    title: "CoC vs CoP vs endorsement: STCW certificate types explained",
    blurb:
      "Certificate of competency, certificate of proficiency, flag state endorsement, GMDSS certificate and the ENG 1 medical: what each document proves, who issues it, and how to verify it.",
    audience: "Anyone new to crewing paperwork, and seafarers asked for a document they have not heard of.",
  },
  {
    slug: "/resources/required-stcw-documents-by-rank",
    title: "STCW documents required by rank: crewing agency checklist",
    blurb:
      "Which certificates a crewing agency should hold on file for each rank, from master to cadet, in Docka's document set, with a printable checklist.",
    audience: "Crewing managers building or auditing a crew file.",
  },
  {
    slug: "/resources/port-state-control-crew-certificate-deficiencies",
    title: "Port State Control crew certificate deficiencies explained",
    blurb:
      "How PSC inspectors check crew certificates, the Paris MoU and Tokyo MoU deficiency codes, what can warrant a detention, and how to prepare the crew file before the inspector boards.",
    audience: "Masters, designated persons ashore and agencies preparing a vessel for inspection.",
  },
  {
    slug: "/resources/stcw-revalidation-every-5-years",
    title: "STCW revalidation every 5 years: what expires and when",
    blurb:
      "STCW regulation I/11 revalidation at intervals not exceeding five years: which certificates are revalidated, which need a refresher, what expired means to a register, and how to check yours.",
    audience: "Seafarers with a fifth anniversary coming up, and the agencies that keep their files.",
  },
];

// CollectionPage built on the shared WebPage shape (@id #webpage, isPartOf the WebSite node,
// breadcrumb @id), typed as CollectionPage, with the guide ItemList as its mainEntity.
const LIST_ID = `${abs(PATH)}#guides`;
const collectionJsonLd = {
  ...webPageJsonLd({ path: PATH, name: "Resources", description: DESCRIPTION, dateModified: CONTENT_LAST_UPDATED_ISO }),
  "@type": "CollectionPage",
  publisher: { "@id": abs("/#organization") },
  mainEntity: { "@id": LIST_ID },
};

// ItemList enumerating the guides: its OWN JSON-LD block (not folded into the CollectionPage,
// not a BreadcrumbList); reuses the ONE ARTICLES array above.
const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  "@id": LIST_ID,
  name: "Seafarer certificate verification guides",
  itemListOrder: "https://schema.org/ItemListOrderAscending",
  numberOfItems: ARTICLES.length,
  itemListElement: ARTICLES.map((a, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: a.title,
    url: abs(a.slug),
  })),
};

export default function ResourcesIndexPage() {
  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(collectionJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(itemListJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          Resources
        </p>
        <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Guides to seafarer certificate verification
        </h1>
        <LastUpdated />
        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          These guides explain how to check an STCW certificate against the register of the authority
          that issued it, and what the answer does and does not prove. They are written for three
          readers: the crewing manager with a crew change this month, the seafarer checking their own
          status, and the inspector or auditor who wants the register&apos;s answer, not the PDF.
        </p>

        <WhatDockaIs heading="h2" />

        <h2 className="mt-8 text-xl font-bold text-slate-900">Who these guides are for, and in what order</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          If you have never run a registry check, read the first guide first. It sets out the one idea
          everything else depends on: a certificate is a copy, the authority&apos;s register is the
          original, and verification means comparing the two. It also carries the full trust-level table,
          L0 to L3, that every other page on this site links to instead of copying.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          A seafarer with a certificate in hand should go straight to the guide on checking whether an
          STCW certificate is still valid, and then to the revalidation guide if the fifth anniversary is
          near. An agency that receives scanned documents from people it has not met should read the
          forged-and-recycled guide before it reads anything else, because the mistake it describes is
          the expensive one. The certificate-types guide and the by-rank checklist are reference pages:
          open them when a document name is unfamiliar or when a crew file is being built. The Port State
          Control guide is for the week before an inspection.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          What the guides do not do: they do not tell you whether a particular seafarer is fit for a
          particular post, they do not compute revalidation eligibility, and they do not restate the STCW
          regulation text. Where a rule matters, the guide names the regulation and links the primary
          document, and the reader checks the flag state&apos;s own notice.
        </p>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700" data-testid="reviewer-block">
          <p className="font-semibold text-slate-900">Reviewed by the Docka team</p>
          <p className="mt-1">
            Every guide is written and reviewed by the people who build Docka&apos;s registry connectors,
            and each one carries a &quot;Last updated&quot; date. We re-read a guide when a register
            changes its form, its coverage or its portal address, and when a cited primary document is
            revised; the current review date across these pages is {CONTENT_LAST_UPDATED_LABEL}. Registry
            names, portal links and lookup fields on these pages are generated from the same data the
            product runs on, so they change when the code does. If you find a statement that the linked
            source does not support, tell us through the{" "}
            <Link href="/contact" className={LINK}>
              contact page
            </Link>{" "}
            and we will correct it.
          </p>
        </div>

        <h2 className="mt-10 text-xl font-bold text-slate-900">The guides</h2>
        <div className="mt-4 space-y-4">
          {ARTICLES.map((a, i) => (
            <article key={a.slug} className="rounded-2xl border border-slate-200 bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Guide {i + 1}</p>
              <h3 className="mt-1 text-lg font-bold text-slate-900">
                <Link href={a.slug} className="text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
                  {a.title}
                </Link>
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{a.blurb}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                <span className="font-semibold text-slate-800">Who should read this:</span> {a.audience}
              </p>
            </article>
          ))}
        </div>

        {/* Hub-and-spoke internal links (descriptive anchors). */}
        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Explore Docka</h2>
          <ul className="mt-3 space-y-2 text-slate-700">
            <li>
              <Link href="/registries" className={LINK}>
                Which seafarer certificate registries Docka verifies
              </Link>
            </li>
            <li>
              <Link href="/what-is-primary-source-verification" className={LINK}>
                What primary source verification means
              </Link>
            </li>
            <li>
              <Link href="/verify" className={LINK}>
                Verify a seafarer certificate against its flag-state registry
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
        </div>
      </div>
    </div>
  );
}
