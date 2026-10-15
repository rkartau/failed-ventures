// Public Sample Profiles — the INDEXABLE sample agency board (plan §D2, Phase 4).
//
// SERVER component: assembles the whole curated dataset via lib/sample-data (never
// the agent session gate or the tenant data accessors — the Phase-7 static rule
// locks this) and renders the REAL board + review components read-only:
//   - <AgentBoard sampleMode>: 5 pipeline columns from the sample-agency GRANTS'
//     stage (never Seafarer.state), zero mutation affordances, SAMPLE chips;
//   - one opened read-only <ReviewPanel> (incl. its read-only DocRequestPanel)
//     for the flagship — the one subject whose doc images are reachable through
//     the PUBLISHED open token;
//   - the sent-circular thread with replies, props-fed via the presentational
//     <SentCircularList> extracted from CircularBroadcast.
//
// ISR, not force-dynamic (plan §D9): data changes only when the seed runs.

import type { Metadata } from "next";
import Link from "next/link";
import { AgentBoard } from "@/components/AgentBoard";
import { ReviewPanel } from "@/components/ReviewPanel";
import { SentCircularList } from "@/components/CircularBroadcast";
import { SampleBanner } from "@/components/SampleBanner";
import {
  getSampleBoardData,
  getSampleCircularThread,
  getSampleReviewData,
} from "@/lib/sample-data";
import { SAMPLE_FLAGSHIP_ID, SAMPLE_OPEN_TOKEN } from "@/lib/sample-ids";
import { breadcrumbList, jsonLd } from "@/lib/seo";

export const revalidate = 300;

// Indexable by design (locked operator decision). No inherited noindex — the
// /sample segment has no such layout; explicit robots is belt-and-braces.
const TITLE = "Sample Crewing Agency Board: Live Read-Only Demo";
const DESCRIPTION =
  "A live, read-only demo of the Docka crewing agency CRM: the five-stage crew pipeline, document compliance and forged-certificate flags, on fictional data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  alternates: { canonical: "/sample/agency" },
  openGraph: {
    url: "/sample/agency",
    title: TITLE,
    description:
      "A live, read-only demo of a crewing agency's Docka crew pipeline on fictional sample data.",
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

export default function SampleAgencyPage() {
  const board = getSampleBoardData();
  const review = getSampleReviewData(SAMPLE_FLAGSHIP_ID);
  const thread = getSampleCircularThread();
  if (!board || !review) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-slate-500">
        The sample agency board is not available right now.{" "}
        <Link href="/" className="font-semibold text-brand-600 hover:text-brand-800">
          Back to Docka
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            breadcrumbList([
              { name: "Home", path: "/" },
              { name: "Sample agency board", path: "/sample/agency" },
            ])
          ),
        }}
      />
      <SampleBanner cta={{ href: "/agent" }} />

      {/* ONE H1 for the page (SEO plan v3 C8); the board title and the review panel's
          seafarer name are H2s below it. */}
      <div className="mt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Crewing agent · Sample Crewing OÜ
        </p>
        <h1 className="text-2xl font-bold text-slate-900">
          Sample crewing agency board (read-only demo)
        </h1>
        <h2 className="mt-3 text-lg font-bold text-slate-900">Fleet pipeline</h2>
        <p className="mt-1 text-sm text-slate-500">
          {board.roster.length} sample seafarers across all five pipeline stages: expiring,
          expired, missing and duplicate-flagged documents included. Read-only.
        </p>
      </div>

      <div className="mt-6">
        <AgentBoard
          sampleMode
          initial={board.roster}
          duplicates={board.duplicates}
          requiredConfig={board.requiredConfig}
        />
      </div>

      {/* One OPENED read-only review — what an agent sees inside a crew card. */}
      <section id="sample-review" className="mt-12 scroll-mt-4">
        <h2 className="text-lg font-bold text-slate-900">
          Inside a crew review <span className="align-middle text-xs font-bold uppercase tracking-wide text-amber-700">(read-only sample)</span>
        </h2>
        <ReviewPanel
          readOnly
          titleAs="h2"
          fileToken={SAMPLE_OPEN_TOKEN}
          seafarer={review.seafarer}
          documents={review.documents}
          agentName="Kai Lepik — SAMPLE"
          duplicates={review.duplicates}
          initialNotes={review.notes}
          initialRestHours={review.restHours}
          requiredConfig={review.requiredConfig}
          initialDocRequests={review.docRequests}
          initialSeaService={review.seaService}
          assigned={review.assigned}
        />
      </section>

      {/* The agency's circular thread — real author names, both visibilities. */}
      {thread && (
        <section className="mt-12">
          <h2 className="text-lg font-bold text-slate-900">
            Crew circulars <span className="align-middle text-xs font-bold uppercase tracking-wide text-amber-700">(read-only sample)</span>
          </h2>
          <div className="mt-3">
            <SentCircularList
              circulars={thread.circulars}
              repliesByCircular={thread.repliesByCircular}
            />
          </div>
        </section>
      )}
    </div>
  );
}
