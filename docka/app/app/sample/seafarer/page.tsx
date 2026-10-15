// Public Sample Profiles — the INDEXABLE sample seafarer page (plan §D3, Phase 3).
//
// SERVER component: assembles the whole curated dataset via lib/sample-data (the
// §D8 allowlist projection — never the agent/seaman session gates, never the
// tenant data accessors; the Phase-7 static rule locks this) and renders the REAL
// owner dashboard component
// with props-seeded state, so the served HTML already contains the full dashboard
// (doc titles, inbox thread, ledger — SSR-proof without JS).
//
// ISR, not force-dynamic (plan §D9): the data only changes when the seed runs; a
// pm2 restart after seeding clears the cache immediately.

import type { Metadata } from "next";
import Link from "next/link";
import SeafarerPage from "@/app/seafarer/page";
import { SampleBanner } from "@/components/SampleBanner";
import { getSampleSeafarerPayload } from "@/lib/sample-data";
import { breadcrumbList, jsonLd } from "@/lib/seo";

export const revalidate = 300;

// Indexable by design (locked operator decision). The /sample segment has no
// layout that could inherit the /seafarer noindex; the explicit robots below is
// belt-and-braces so a future default can never flip it silently.
const TITLE = "Sample Seafarer Profile: Live Read-Only Demo";
const DESCRIPTION =
  "A live, read-only demo of a seafarer's Docka dashboard: verified certificates, expiry tracking, share links and agency messages, all on fictional sample data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: "/sample/seafarer" },
  openGraph: {
    url: "/sample/seafarer",
    title: TITLE,
    description:
      "A live, read-only demo of a seafarer's Docka dashboard on fictional sample data.",
    type: "website",
    images: [
      {
        url: "/opengraph-image.jpg",
        width: 1200,
        height: 630,
        alt: "Docka: live seafarer certificate verification against flag-state registries",
      },
    ],
  },
  twitter: { title: TITLE, description: DESCRIPTION, images: ["/twitter-image.jpg"] },
};

export default function SampleSeafarerPage() {
  const payload = getSampleSeafarerPayload();
  if (!payload) {
    // Sample data not seeded on this deployment — an honest, terse fallback
    // (never a crash; the page simply has nothing to demo yet).
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-slate-500">
        The sample profile is not available right now.{" "}
        <Link href="/" className="font-semibold text-brand-600 hover:text-brand-800">
          Back to Docka
        </Link>
      </div>
    );
  }
  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            breadcrumbList([
              { name: "Home", path: "/" },
              { name: "Sample seafarer profile", path: "/sample/seafarer" },
            ])
          ),
        }}
      />
      <div className="mx-auto max-w-3xl px-4 pt-6">
        {/* The page's ONE H1 (SEO plan v3 C8); the dashboard below renders the
            seafarer's name as an H2 in sample mode. Visually hidden: the banner and
            the dashboard header already say what this is. */}
        <h1 className="sr-only">Sample seafarer profile (read-only demo)</h1>
        <SampleBanner cta={{ href: "/seafarer" }} />
        {/* Positioning batch 2026-09-07 (plan v4 D5): the CRM identity reaches this
            seafarer-intent route through one visible body sentence, not the description. */}
        <p className="mt-3 text-sm text-slate-600">
          Crewing agencies run Docka as their CRM. For a seafarer it is free.
        </p>
      </div>
      {/* The REAL owner dashboard, props-seeded + server-guarded read-only. */}
      <SeafarerPage sample initialData={payload} />
    </div>
  );
}
