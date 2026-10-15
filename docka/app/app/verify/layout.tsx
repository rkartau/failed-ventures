import type { Metadata } from "next";
import { breadcrumbList, jsonLd } from "@/lib/seo";

// Metadata-ONLY layout for the public /verify segment. It adds NO UI chrome — it
// renders {children} untouched — and exists solely to give the bare /verify tool
// landing page a unique, indexable title/description + self-canonical. The
// per-person proof pages at /verify/[uuid] OVERRIDE this via their own
// generateMetadata (noindex + self-canonical), so this /verify canonical/title
// can never bleed onto them.
//
// SEO implementation plan WP-B: title <=60 and description <=160 (onpage §3), brand
// capitalised, plain punctuation. This layout keeps EXACTLY ONE JSON-LD block
// (seo-phase1 pin); the /verify WebPage node lives in verify/page.tsx (WP-C) and
// references this crumb by its "#breadcrumb" @id (plan R12).
const TITLE = "Verify a Seafarer Certificate Against Its Registry";
const DESCRIPTION =
  "Check a seafarer certificate against the official flag-state registry, free. Docka is the CRM crewing agencies use to run their roster and documents.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/verify" },
  openGraph: {
    type: "website",
    url: "/verify",
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

// Home › Verify breadcrumb for the /verify tool landing. The per-person /verify/[uuid]
// proof pages are noindex, so this crumb is only consumed on the indexable landing.
// selfPath "/verify" gives the list its "#breadcrumb" @id so the page's WebPage node
// (verify/page.tsx) can reference it instead of dangling (plan R12).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Verify", path: "/verify" },
  ],
  "/verify"
);

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      {children}
    </>
  );
}
