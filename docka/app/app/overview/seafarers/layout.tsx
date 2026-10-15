import type { Metadata } from "next";
import { CONTENT_LAST_UPDATED_ISO, abs, breadcrumbList, jsonLd, seafarerFreeOfferJsonLd, webPageJsonLd } from "@/lib/seo";

// Metadata + JSON-LD for /overview/seafarers. Lives in this layout because the page
// (app/overview/seafarers/page.tsx) is a "use client" component and cannot export
// `metadata`. Plain title → the root `%s · Docka` template appends.
// SEO Tier 1: this page is the designated OWNER for the query "seafarer documentation
// service" (GSC-validated, seafarer-side intent); the title keeps that phrase
// (seo-tier1-articles pin). WP-B: title <=60, description <=160, plain punctuation.
// The page's H1/hero are untouched (owner-gated).
const TITLE = "Seafarer Documentation Service: Verify and Share";
const DESCRIPTION =
  "Free for seafarers. Add your certificates by photo, verify them against supported registries, get reminders, and share them with the agencies you choose.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/overview/seafarers" },
  openGraph: {
    type: "website",
    url: "/overview/seafarers",
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

// Shared BreadcrumbList helper; selfPath gives the "#breadcrumb" @id the WebPage references.
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Overview", path: "/overview" },
    { name: "For Seafarers", path: "/overview/seafarers" },
  ],
  "/overview/seafarers"
);

const WEBPAGE_JSONLD = webPageJsonLd({
  path: "/overview/seafarers",
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

// The seafarer-side product as a SoftwareApplication that is free of charge (the agency
// side is priced on /pricing under abs("/#software")). Offer price 0 is a real, public
// fact ("always free for seafarers"); no aggregateRating (there are no real ratings).
const SOFTWARE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": abs("/#software-seafarer"),
  name: "Docka for seafarers",
  url: abs("/overview/seafarers"),
  description: DESCRIPTION,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  isAccessibleForFree: true,
  // The SAME node /pricing emits (one builder), so the shared @id resolves identically.
  offers: seafarerFreeOfferJsonLd(),
  provider: { "@id": abs("/#organization") },
  publisher: { "@id": abs("/#organization") },
};

// Mirror Service for the seafarer audience (schema.md B2): free, worldwide, consumer.
const SERVICE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Service",
  "@id": abs("/#service-seafarers"),
  name: TITLE,
  url: abs("/overview/seafarers"),
  serviceType: "Seafarer documentation service",
  description: DESCRIPTION,
  isAccessibleForFree: true,
  provider: { "@id": abs("/#organization") },
  areaServed: { "@type": "Place", name: "Worldwide" },
  audience: { "@type": "PeopleAudience", name: "Seafarers" },
};

export default function SeafarersOverviewLayout({ children }: { children: React.ReactNode }) {
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
        dangerouslySetInnerHTML={{ __html: jsonLd(SOFTWARE_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(SERVICE_JSONLD) }}
      />
      {children}
    </>
  );
}
