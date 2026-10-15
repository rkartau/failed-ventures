import type { Metadata } from "next";
import Link from "next/link";
import { abs, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";

// PUBLIC, unauthenticated, INDEXABLE About page (SEO Phase 2b; revised by the SEO
// implementation plan WP-D, D6). Server component so it can export metadata + inline
// JSON-LD. The trust ladder and the registry tiers are no longer copied here: the ladder's
// canonical table lives on the how-verification-works guide (components/LevelTable.tsx) and
// the coverage list on /registries, both derived from product data. This page keeps the
// company facts, the method in brief, security and pricing. Copy follows
// docs/WRITING-STYLE-GUIDE.md. Route is /about (canonical self).
const TITLE = "About Docka Development OÜ";
const DESCRIPTION =
  "Docka Development OÜ (Tallinn, Estonia) builds a CRM for crewing agencies that checks seafarer certificates against official flag-state registries.";
const PATH = "/about";

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

// AboutPage whose mainEntity is a bare @id reference to the ONE sitewide Organization node
// emitted by the root layout (abs("/#organization")): legal name, registry code and address
// live there, once, and are not repeated here.
const aboutJsonLd = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  "@id": `${abs(PATH)}#webpage`,
  name: "About Docka Development OÜ",
  url: abs(PATH),
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
  isPartOf: { "@id": abs("/#website") },
  breadcrumb: { "@id": `${abs(PATH)}#breadcrumb` },
  mainEntity: { "@id": abs("/#organization") },
};

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "About", path: PATH },
  ],
  PATH
);

export default function AboutPage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(aboutJsonLd) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          About
        </p>
        <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          About Docka Development OÜ
        </h1>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          Docka is built by <strong>Docka Development OÜ</strong>, an Estonian company (registry code{" "}
          <strong>17579582</strong>) based in Tallinn. We build the CRM that crewing agencies run their
          desk on: the crew roster, the documents, the expiry dates and the sea-service record in the
          same place. Because a scanned PDF is a claim and not a fact, Docka also checks each
          certificate against the register of the flag state that issued it.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          This page explains who runs Docka, what &quot;primary-source verification&quot; means, how we
          label each result, and where our checks stop.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Who we are</h2>
        <ul className="mt-3 space-y-1 text-slate-700">
          <li>
            <strong>Legal entity:</strong> Docka Development OÜ
          </li>
          <li>
            <strong>Estonian registry code:</strong> 17579582
          </li>
          <li>
            <strong>Registered office:</strong> Tallinn, Estonia
          </li>
        </ul>
        <p className="mt-3 leading-relaxed text-slate-700">
          You can reach us by email through our{" "}
          <Link href="/contact" className={LINK}>
            contact page
          </Link>
          . The company&apos;s legal and registry details are published there in full.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">The Docka team</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Docka is a small team in Tallinn that has spent its working life around crewing paperwork and
          the software that handles it. We write the registry connectors ourselves, we read each
          authority&apos;s portal before we wire it, and we review the guides on this site against the
          primary documents they cite. When a register changes its form or its coverage, the same people
          who built the connector update the page that describes it; the &quot;Last updated&quot; line on
          each page is the date that review last happened.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          We do not publish individual names on the site. Questions about a page, a connector or a result
          go to the address on the contact page and reach the person who wrote the code.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">
          What &quot;primary-source verification&quot; means
        </h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The primary source for a seafarer certificate is the maritime authority that issued it: for
          example, Transpordiamet (the Estonian Transport Administration) or the UK Maritime and Coastguard
          Agency. A certificate is only as trustworthy as that authority&apos;s own records.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          So instead of reading a document and trusting what it says, Docka goes back to the issuing
          authority&apos;s official register and asks it directly. Where the authority runs a public
          verification service that answers automatically, Docka connects to that service and reports
          what it returns. We never re-type the contents of a PDF and call the result
          &quot;verified&quot;.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">Two principles hold everywhere in the product:</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          <li>
            <strong>We show you exactly how much we could confirm.</strong> Every certificate carries a
            label describing the strength of the check behind it.
          </li>
          <li>
            <strong>We are honest about our limits.</strong> Not every country exposes a live check.
            Where one doesn&apos;t, we say so plainly instead of dressing up a weaker check as a strong
            one.
          </li>
        </ol>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Trust levels and registry coverage</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Every document in Docka sits at one of four levels, L0 to L3, from a self-uploaded file that
          nobody has checked to a certificate confirmed against the issuing government&apos;s register. L3
          is the strongest claim we make, and we only make it when the issuing authority&apos;s own
          register backs it.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          The full trust-level table is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
            how seafarer certificate verification actually works
          </Link>
          , and the list of every register we check, grouped by what each one lets us do, is on the{" "}
          <Link href="/registries" className={LINK}>
            registry coverage page
          </Link>
          . Both are generated from the same data the product runs on, so they cannot say more than the
          code does.
        </p>

        <blockquote className="mt-6 border-l-4 border-brand-200 bg-brand-50/50 py-3 pl-4 text-slate-700">
          <strong>A note on fraud:</strong> some websites imitate real maritime authorities. Docka only
          ever talks to each authority&apos;s pinned official domain, and shows a warning for the impostor
          sites it knows about.
        </blockquote>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Security and your data</h2>
        <ul className="mt-3 space-y-2 text-slate-700">
          <li>
            <strong>We never store card or bank details.</strong> Payments run through Stripe (card or
            SEPA). Card and IBAN details go to Stripe; Docka does not keep them.
          </li>
          <li>
            <strong>Sensitive lookup inputs are pass-through only.</strong> Where a check needs a sensitive
            value (such as a national ID number), it is used for that single lookup and is not stored.
          </li>
          <li>
            <strong>Seafarers use Docka free.</strong> The agency side is a paid subscription; the seafarer
            side is free.
          </li>
        </ul>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Pricing, in brief</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          An agency pays <strong>300 EUR / month</strong> plus <strong>2 EUR per billable seafarer per
          month</strong>; seafarers pay nothing; the detail is on the{" "}
          <Link href="/pricing" className={LINK}>
            pricing page
          </Link>
          .
        </p>

        {/* Hub-and-spoke internal links (descriptive anchors) to the money pages. */}
        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Next steps</h2>
          <ul className="mt-3 space-y-2 text-slate-700">
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
      </article>
    </div>
  );
}
