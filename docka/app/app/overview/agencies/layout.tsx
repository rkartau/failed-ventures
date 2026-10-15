import type { Metadata } from "next";
import { CONTENT_LAST_UPDATED_ISO, PRICE_VALID_UNTIL, abs, breadcrumbList, jsonLd, webPageJsonLd } from "@/lib/seo";
import { pricingModel } from "@/components/billing-ui";

// Metadata + JSON-LD for /overview/agencies. Lives in this layout because the page
// (app/overview/agencies/page.tsx) is a "use client" component and cannot export
// `metadata`. Plain title → the root `%s · Docka` template appends.
const TITLE = "Crew Compliance Software in a Crewing Agency CRM";
const DESCRIPTION =
  "Docka is a CRM for crewing agencies. Run the crew pipeline, document sets and expiry reminders, and check certificates against the issuing registry.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/overview/agencies" },
  openGraph: {
    type: "website",
    url: "/overview/agencies",
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

// Shared BreadcrumbList helper (one shape site-wide; item 1 is the slash-less SITE_URL).
// selfPath gives the list its "#breadcrumb" @id, referenced by the WebPage node below (R12).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Overview", path: "/overview" },
    { name: "For Agencies", path: "/overview/agencies" },
  ],
  "/overview/agencies"
);

// Per-URL WebPage node (isPartOf the sitewide WebSite; breadcrumb by @id).
const WEBPAGE_JSONLD = webPageJsonLd({
  path: "/overview/agencies",
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

// Service structured data (SEO B2) — the agency-facing offering. provider wires to
// the site-wide Organization @id; areaServed is worldwide (docka verifies against
// flag-state registries globally); audience is the crewing-agency business buyer.
// `offers` is the /pricing licence Offer INLINED under the same @id: crawlers parse
// structured data per page, so a bare cross-page @id read as an empty Offer here (post-audit
// schema N2). Name, url and currency match /pricing; the price is the canonical default rate
// from pricingModel() (the same fallback /pricing renders when no admin override is set), so
// the two nodes agree without this marketing layout parsing db.json on every request.
const LICENCE = pricingModel();
const SERVICE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Service",
  "@id": abs("/#service-agencies"),
  name: TITLE,
  url: abs("/overview/agencies"),
  serviceType: "Crewing agency CRM and crew compliance software",
  description: DESCRIPTION,
  provider: { "@id": abs("/#organization") },
  areaServed: { "@type": "Place", name: "Worldwide" },
  audience: { "@type": "BusinessAudience", name: "Crewing agencies" },
  offers: {
    "@type": "Offer",
    "@id": abs("/pricing#offer-licence"),
    name: "Monthly licence",
    url: abs("/pricing"),
    price: LICENCE.base,
    priceCurrency: "EUR",
    priceValidUntil: PRICE_VALID_UNTIL,
    availability: "https://schema.org/InStock",
  },
};

export default function AgenciesOverviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(WEBPAGE_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(SERVICE_JSONLD) }}
      />
      {children}
    </>
  );
}
