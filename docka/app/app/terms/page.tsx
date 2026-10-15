import Link from "next/link";
import type { Metadata } from "next";
import { getBillingSettings } from "@/lib/billing-store";
import { breadcrumbList, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO } from "@/lib/seo";

// SEO plan WP-E E6: proper metadata + breadcrumb + WebPage node, but the page STAYS
// `robots.index: false` until the owner confirms the ToS text is final (the body below is
// still the draft). Because it is noindex it is deliberately NOT in lib/site-pages.ts; the
// inverse test there flips the moment either side changes. Body text, `force-dynamic` and
// the tosVersion read are unchanged (a body edit needs a tosVersion bump, owner-gated).
const PATH = "/terms";
const TITLE = "Terms of Service";
const DESCRIPTION =
  "Terms of service for crewing agencies using Docka: what the platform provides, fees, billing cycle, taxes, non-payment, data protection and termination.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    url: PATH,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image.jpg", alt: "Docka terms of service" }],
  },
  robots: { index: false, follow: false },
};

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Terms of service", path: PATH },
  ],
  PATH
);

const webPage = webPageJsonLd({
  path: PATH,
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

// R3-8 (D-8) — read the tosVersion at request time from getBillingSettings(), the SAME
// source the acceptance checkbox records against, so the displayed version and the
// recorded acceptance version can never disagree. This reads db.json per request.
export const dynamic = "force-dynamic";

// ============================================================================
// DRAFT — NOT LEGAL ADVICE, NOT REVIEWED, NOT FINAL (plan decision 9)
// ============================================================================
// This page exists so the billing onboarding flow has a real document to link to and
// a real version string to record against `BillingProfile.tosAcceptedAt`. The owner
// must replace the body below with terms drafted/reviewed by a lawyer BEFORE live
// keys are swapped in (P8.7). When the text changes, bump
// `EMPTY_BILLING_SETTINGS.tosVersion` in lib/db.ts (or set `billingSettings.tosVersion`)
// so the new version is what future acceptances record.

const SECTIONS: { heading: string; body: string }[] = [
  {
    heading: "1. What docka provides",
    body:
      "docka is a seafarer credential platform for crewing agencies. Access to a seafarer's " +
      "documents is granted by that seafarer, and is withdrawable by them at any time. docka " +
      "stores and displays what the seafarer and the agency put into it; it does not certify, " +
      "issue or validate any certificate beyond the registry checks it explicitly labels.",
  },
  {
    heading: "2. Fees",
    body:
      "The agency pays a monthly licence fee plus a metered fee per billable seafarer. A " +
      "seafarer is billable in a calendar month (Europe/Tallinn) when they are visible on the " +
      "agency's board for 24 hours or more in total during that month. Hiding a seafarer does " +
      "not pause billing; withdrawal, revocation, expiry or deletion of the access grant does. " +
      "Both rates are shown on the agency's billing page.",
  },
  {
    heading: "3. Billing cycle and payment",
    body:
      "Subscriptions are anchored to the 1st of the month. The first period is prorated from " +
      "the day the subscription starts. Metered usage for a closed month is reported at the " +
      "start of the following month and appears on that month's invoice. Payment is collected " +
      "by Stripe by card or SEPA direct debit; docka never receives or stores card, IBAN or " +
      "mandate details.",
  },
  {
    heading: "4. Taxes",
    body:
      "Prices are exclusive of VAT. VAT is calculated and collected by Stripe Tax on the basis " +
      "of the address and VAT number the agency supplies. A valid EU VAT number results in a " +
      "reverse-charge invoice. Supplying a correct VAT number and address is the agency's " +
      "responsibility.",
  },
  {
    heading: "5. Non-payment",
    body:
      "If payment fails, the agency's dashboard shows a notice immediately, becomes read-only " +
      "after 14 days, and is blocked after 30 days. Access is a paywall only: no grant is " +
      "revoked and no data is deleted, and access is restored as soon as payment succeeds. " +
      "Seafarers' own access to their data, their share links and shipowner read-portals are " +
      "never suspended for an agency's unpaid invoice.",
  },
  {
    heading: "6. Data protection",
    body:
      "The agency is a controller of the personal data it processes through docka. Consent, " +
      "access and board events are recorded in tamper-evident logs. Seafarers may withdraw " +
      "consent at any time, subject to the disclosed at-sea lock while a live assignment " +
      "exists.",
  },
  {
    heading: "7. Changes and termination",
    body:
      "docka may change these terms with notice; continued use after a change constitutes " +
      "acceptance of the new version. Either party may terminate with effect from the end of " +
      "the current billing period. Termination is arranged with docka directly.",
  },
];

export default function TermsPage() {
  const tosVersion = getBillingSettings().tosVersion;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(webPage) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />
      <p className="text-sm text-slate-500">
        <Link href="/" className="text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
          Home
        </Link>{" "}
        / Terms of service
      </p>
      <h1 className="mt-3 text-2xl font-bold text-slate-900">Terms of service</h1>
      <p className="mt-1 text-sm text-slate-500">
        Version {tosVersion}
      </p>

      <div className="mt-6 space-y-6">
        {SECTIONS.map((s) => (
          <section key={s.heading}>
            <h2 className="text-lg font-semibold text-slate-900">{s.heading}</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{s.body}</p>
          </section>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/agent/settings/billing"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to billing
        </Link>
        <Link
          href="/pricing"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to pricing
        </Link>
      </div>
    </div>
  );
}
