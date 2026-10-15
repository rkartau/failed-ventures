import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { TrackedLink } from "@/components/TrackedLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";
import { CONTENT_LAST_UPDATED_ISO, breadcrumbList, jsonLd, webPageJsonLd } from "@/lib/seo";

// Minimal, PUBLIC, indexable contact page — plain informational page (no form, no
// backend), just a mailto link and the company's legal/registry details. Server
// component so it can export metadata. Mirrors app/app/privacy/page.tsx.
// WP-B: SERP-length title/description (onpage §3) + a ContactPage JSON-LD node.
const TITLE = "Contact Docka: Certificate Verification Support";
const DESCRIPTION =
  "Email the Docka team about the crewing agency CRM, seafarer certificate verification or agency onboarding, and find our legal and registry details.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/contact" },
  openGraph: {
    type: "website",
    url: "/contact",
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

function Block({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-bold text-slate-900">{heading}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

// Legal entity facts that stay LITERAL across every language (data / proper nouns).
// The legal-form value and the address's "county" word are localized via i18n
// (contact.legalFormValue / contact.addressValue) instead of living here.
const COMPANY = {
  legalName: "Docka Development OÜ",
  registryCode: "17579582",
  // Real, already-public contact address (identical to the one the /privacy page has
  // always server-rendered). SEO Phase 2c: render it as a real server-side mailto in the
  // initial HTML so AI engines / trust crawlers see a contact email in view-source — the
  // previous client-only obfuscated component left the address absent from the SSR payload.
  contactEmail: "info@docka.me",
};

// Home › Contact (selfPath gives the "#breadcrumb" @id the ContactPage node references).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Contact", path: "/contact" },
  ],
  "/contact"
);

// The per-URL node is a ContactPage (a WebPage subtype) extended with the public
// contact email, so entity crawlers find the address in structured data too.
const CONTACT_PAGE_JSONLD = {
  ...webPageJsonLd({
    path: "/contact",
    name: TITLE,
    description: DESCRIPTION,
    dateModified: CONTENT_LAST_UPDATED_ISO,
    type: "ContactPage",
  }),
  email: COMPANY.contactEmail,
};

export default function ContactPage() {
  // Language comes from the same cookie the root layout reads, so this server render
  // is already localised (labels + legal-form + address county word).
  const raw = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(raw) ? raw : DEFAULT_LANG;

  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(CONTACT_PAGE_JSONLD) }}
      />
      <section className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          Contact
        </p>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Get in touch
        </h1>
        <p className="mt-3 text-slate-600">
          Questions about Docka, our registry checks, or your data? Email us and the Docka
          team will get back to you.
        </p>

        <WhatDockaIs />

        <div className="mt-8 space-y-4">
          <Block heading={t(lang, "contact.emailHeading")}>
            <p>
              Reach the Docka team at{" "}
              {/* Still a real server-rendered mailto anchor; TrackedLink only adds the
                  PII-free cta_click {location:"contact", target:"mailto"} on click. */}
              <TrackedLink
                href={`mailto:${COMPANY.contactEmail}`}
                location="contact"
                cta="mailto"
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
                aria-label="Email the Docka team"
              >
                {COMPANY.contactEmail}
              </TrackedLink>
              .
            </p>
          </Block>

          <Block heading={t(lang, "contact.companyDetails")}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold text-slate-900">{t(lang, "contact.companyLabel")}</dt>
              <dd>{COMPANY.legalName}</dd>

              <dt className="font-semibold text-slate-900">{t(lang, "contact.registryCodeLabel")}</dt>
              <dd>{COMPANY.registryCode}</dd>

              <dt className="font-semibold text-slate-900">{t(lang, "contact.legalFormLabel")}</dt>
              <dd>{t(lang, "contact.legalFormValue")}</dd>

              <dt className="font-semibold text-slate-900">{t(lang, "contact.addressLabel")}</dt>
              <dd>{t(lang, "contact.addressValue")}</dd>
            </dl>
          </Block>
        </div>

        <p className="mt-8 text-sm">
          <Link
            href="/"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            ← Back to Docka
          </Link>
        </p>
      </section>
    </div>
  );
}
