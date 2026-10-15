import Link from "next/link";
import type { Metadata } from "next";
import { TrackedLink } from "@/components/TrackedLink";
import { getBillingSettings } from "@/lib/billing-store";
import { pricingModel } from "@/components/billing-ui";
import { t, DEFAULT_LANG } from "@/lib/i18n";
import {
  CONTENT_LAST_UPDATED_ISO,
  CONTENT_LAST_UPDATED_LABEL,
  PRICE_VALID_UNTIL,
  SITE_URL,
  abs,
  breadcrumbList,
  jsonLd,
  seafarerFreeOfferJsonLd,
  webPageJsonLd,
} from "@/lib/seo";

// PUBLIC, unauthenticated pricing page. It resolves NO agent session (it is not under
// app/agent and never calls agentSession), reads ONLY the global billing-settings
// defaults, and is INDEXED (no robots noindex — unlike /terms and the agent pages).
//
// ISR, not force-dynamic (R1-1): /pricing is public AND crawlable, so a per-request
// `force-dynamic` would run getBillingSettings() -> readDB() (a full multi-tenant
// db.json parse) on every crawler hit. The admin-editable default rate does not need
// per-request freshness on a marketing page; a 5-minute revalidate keeps "change the
// admin default, the shown price changes" true within the window. This is the one
// deliberate divergence from /terms (whose force-dynamic is correctness-driven).
export const revalidate = 300;

// Pricing lede (WP-B): who pays, what the licence covers (only features already stated
// on /overview/agencies) and how a billable seafarer is counted (the /terms §2 rule).
// No rate literal here: every number the visitor sees comes from `pricingModel`.
const PRICING_LEDE =
  "Crewing agencies pay for Docka, the CRM their desk runs on. Seafarers never do. The agency licence covers the board: every seafarer's certificates checked against the issuing flag-state register, a trust level from L0 to L3 on each document, required-document sets by rank and a hard block when a required certificate lapses. On top of the licence, the agency pays a metered fee for each billable seafarer: one who is visible on the board for 24 hours or more in a calendar month (Europe/Tallinn).";

const TITLE = "Pricing for Crewing Agencies";
const DESCRIPTION =
  "Crewing software pricing for agencies: a flat monthly licence plus a metered fee per billable seafarer, in EUR, no long-term contract. Free for seafarers.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  // Explicit OG/twitter so the social card carries THIS page's URL/title (the root
  // layout's og:url is the home page and would otherwise be inherited).
  openGraph: {
    type: "website",
    url: "/pricing",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image.jpg", width: 1200, height: 630, alt: OG_IMAGE_ALT }],
  },
  twitter: {
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/twitter-image.jpg", alt: OG_IMAGE_ALT }],
  },
};

// FAQ — the ONE source for both the FAQPage JSON-LD and the visible <dl>, built ONLY from
// facts already stated on this page (billable rule, no long-term contract, Stripe card/SEPA
// + no card/IBAN storage, free for seafarers). FAQPage is emitted for AI/entity parsing
// (LLMs, knowledge graph), NOT for SERP FAQ rich results. A fifth "Can I cancel" entry
// linking /terms is DEFERRED until the owner confirms the ToS text (plan R10).
const PRICING_FAQ: Array<{ q: string; a: string }> = [
  {
    q: "What is a billable seafarer?",
    a: "A seafarer is billable in a calendar month (Europe/Tallinn) when they are visible on your agency board for 24 hours or more in total during that month. Hiding a seafarer does not pause billing; withdrawing, revoking, expiring or deleting the access grant does.",
  },
  {
    q: "Is there a long-term contract?",
    a: "No. There is no setup fee and no long-term contract. The monthly licence and the metered per-seafarer fee are billed month to month.",
  },
  {
    q: "How are payments taken?",
    a: "Payment is collected by Stripe by card or SEPA direct debit. Docka never receives or stores your card, IBAN or mandate details.",
  },
  {
    q: "Is Docka free for seafarers?",
    a: "Yes. Docka is always free for seafarers. This pricing is for crewing agencies only.",
  },
];

export default function PricingPage() {
  // Source of truth: the admin-editable defaults on the billing-settings singleton.
  // pricingModel tolerates a missing/partial `defaults` (R1-2) and never throws, so this
  // public page can never 500 on a legacy/hand-edited db.json. Only `.defaults` is read —
  // the full settings object (with its internal stripe*/portal ids) is never rendered
  // or serialized here (R1-4).
  const model = pricingModel(getBillingSettings().defaults);

  // SoftwareApplication + Offer structured data (SEO B1, schema.md Fix B shape). The Offer
  // prices are the SAME resolved numbers the visible price card renders (model.base /
  // model.perSeafarer, both from getBillingSettings().defaults via pricingModel), so
  // schema == display and cannot drift. Numeric price + priceCurrency:"EUR"; NO
  // aggregateRating/reviews. The seafarer Offer is price 0 (a real, public fact).
  const pricingJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": abs("/#software"),
    name: "Docka",
    // Slash-less, matching the canonical / WebSite / Organization identity URL.
    url: SITE_URL,
    description:
      "A CRM for crewing agencies: the crew roster, required-document sets and expiry reminders, with certificates checked live against the official flag-state registers of supported countries and labelled L0 to L3.",
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Compliance / credential verification",
    operatingSystem: "Web",
    browserRequirements: "Requires JavaScript. Requires HTML5.",
    image: abs("/opengraph-image.jpg"),
    screenshot: [abs("/screenshots/docka-verify-certificate-tool.webp")],
    // Five features, each already stated on /overview/agencies (no invented capability).
    featureList: [
      "Live government verification against the issuing flag-state register",
      "Verification levels L0 to L3 on every document",
      "Required document sets per agency (STCW rank baseline)",
      "Sea-ready hard-block on an expired or missing required certificate",
      "Timestamped, shareable verification proof",
    ],
    dateModified: CONTENT_LAST_UPDATED_ISO,
    provider: { "@id": abs("/#organization") },
    publisher: { "@id": abs("/#organization") },
    offers: [
      {
        "@type": "Offer",
        "@id": abs("/pricing#offer-licence"),
        name: "Monthly licence",
        url: abs("/pricing"),
        category: "Subscription",
        availability: "https://schema.org/InStock",
        eligibleCustomerType: "https://schema.org/Business",
        price: model.base,
        priceCurrency: "EUR",
        priceValidUntil: PRICE_VALID_UNTIL,
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: model.base,
          priceCurrency: "EUR",
          billingDuration: 1,
          billingIncrement: 1,
          unitCode: "MON",
          unitText: "per month",
          valueAddedTaxIncluded: false,
        },
        seller: { "@id": abs("/#organization") },
      },
      {
        "@type": "Offer",
        "@id": abs("/pricing#offer-metered"),
        name: "Per billable seafarer, per month",
        url: abs("/pricing"),
        category: "Usage-based",
        availability: "https://schema.org/InStock",
        eligibleCustomerType: "https://schema.org/Business",
        price: model.perSeafarer,
        priceCurrency: "EUR",
        priceValidUntil: PRICE_VALID_UNTIL,
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: model.perSeafarer,
          priceCurrency: "EUR",
          unitCode: "MON",
          unitText: "per billable seafarer per month",
          referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "billable seafarer" },
          valueAddedTaxIncluded: false,
        },
        seller: { "@id": abs("/#organization") },
      },
      // The free seafarer Offer comes from the ONE builder /overview/seafarers also uses.
      seafarerFreeOfferJsonLd(),
    ],
  };

  // Breadcrumb trail: Home › Pricing (exactly one BreadcrumbList on this URL); selfPath
  // gives it the "#breadcrumb" @id the WebPage node references (plan R12).
  const breadcrumbJsonLd = breadcrumbList(
    [
      { name: "Home", path: "/" },
      { name: "Pricing", path: "/pricing" },
    ],
    "/pricing"
  );

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: PRICING_FAQ.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  const webPage = webPageJsonLd({
    path: "/pricing",
    name: TITLE,
    description: DESCRIPTION,
    dateModified: CONTENT_LAST_UPDATED_ISO,
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {/* SoftwareApplication stays the FIRST block (seo-phase1/2a read [0]). */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(pricingJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(webPage) }}
      />
      <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
        {t(DEFAULT_LANG, "pricing.title")}
      </h1>

      {/* Pricing card directly under the H1 — the two live default rates. */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-500">For crewing agencies</p>
        <h2 className="text-lg font-semibold text-slate-900">What it costs</h2>
        <dl className="mt-4 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <dt className="text-sm text-slate-500">Monthly licence</dt>
            <dd className="text-2xl font-bold text-slate-900">{model.baseLine}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-slate-100 pt-4">
            <dt className="text-sm text-slate-500">Per billable seafarer, per month</dt>
            <dd className="text-2xl font-bold text-slate-900">{model.perSeafarerLine}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          Prices are in EUR. No setup fee and no long-term contract.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Prices shown are current as of{" "}
          <time dateTime={CONTENT_LAST_UPDATED_ISO}>{CONTENT_LAST_UPDATED_LABEL}</time>.
        </p>

        {/* GA4 funnel: plan CTAs fire cta_click {location:"pricing_plan"} (TrackedLink). */}
        <div className="mt-6 flex flex-wrap gap-3">
          <TrackedLink
            href="/agent/settings/billing"
            location="pricing_plan"
            className="rounded-xl bg-brand-600 px-5 py-3 min-h-[44px] text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Get started
          </TrackedLink>
          <TrackedLink
            href="/sample/seafarer"
            location="pricing_plan"
            className="rounded-xl border border-slate-300 bg-white px-5 py-3 min-h-[44px] text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            See a sample seafarer profile
          </TrackedLink>
          <TrackedLink
            href="/sample/agency"
            location="pricing_plan"
            className="rounded-xl border border-slate-300 bg-white px-5 py-3 min-h-[44px] text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            See a sample agency view
          </TrackedLink>
        </div>
      </section>

      <p className="mt-4 text-base font-medium text-slate-700">
        Always free for seafarers. This pricing is for crewing agencies only.
      </p>
      <p className="mt-4 text-lg text-slate-600">{PRICING_LEDE}</p>
      <p className="mt-2 text-sm text-slate-600">
        For the full feature list,{" "}
        <Link
          href="/overview/agencies"
          className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
        >
          see what the agency plan includes
        </Link>
        .
      </p>

      {/* How a seafarer becomes billable — reuses /terms §2 wording verbatim. */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-slate-900">
          When is a seafarer billable?
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">
          The agency pays a monthly licence fee plus a metered fee per billable seafarer. A
          seafarer is billable in a calendar month (Europe/Tallinn) when they are visible on the
          agency&apos;s board for 24 hours or more in total during that month. Hiding a seafarer does
          not pause billing; withdrawal, revocation, expiry or deletion of the access grant does.
          Both rates are shown on the agency&apos;s billing page.
        </p>
      </section>

      {/* Billing cycle + proration — reuses /terms §3 wording verbatim. */}
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-slate-900">Billing cycle</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">
          Subscriptions are anchored to the 1st of the month. The first period is prorated from the
          day the subscription starts. Metered usage for a closed month is reported at the start of
          the following month and appears on that month&apos;s invoice. Payment is collected by Stripe
          by card or SEPA direct debit; Docka never receives or stores card, IBAN or mandate
          details.
        </p>
      </section>

      {/* FAQ — rendered from the SAME PRICING_FAQ const as the FAQPage JSON-LD, so the
          visible set and the schema set cannot drift. */}
      <section className="mt-10">
        <h2 className="text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 space-y-6">
          {PRICING_FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-10">
        <TrackedLink
          href="/agent/settings/billing"
          location="pricing_footer"
          className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-4 py-3 min-h-[44px] text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Get started
        </TrackedLink>
      </div>
    </div>
  );
}
