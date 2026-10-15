"use client";

import { useState } from "react";
import Link from "next/link";
import { FeatureGrid } from "@/components/overview/FeatureCard";
import { PersonaSelector } from "@/components/overview/PersonaSelector";
import { FunnelBars } from "@/components/overview/FunnelBars";
import { ComplianceDonut } from "@/components/overview/ComplianceDonut";
import { LevelDistribution } from "@/components/overview/LevelDistribution";
import { StatTiles } from "@/components/overview/StatTiles";
import { AGENCY_SECTIONS, AGENCY_PERSONAS } from "@/components/overview/overviewData";
import { track } from "@/lib/analytics-events";
import { jsonLd, plainPunct } from "@/lib/seo";
import { LEVEL_META, type VerificationLevel } from "@/lib/verification-level";

// The trust ladder rendered on this page comes from LEVEL_META (the product truth in
// lib/verification-level.ts), never a hand-typed table (SEO plan v3 C5 / ground truth
// 3: the old cards said L1 = "Self-added", which the product never used).
const LADDER_LEVELS: VerificationLevel[] = [0, 1, 2, 3];

// SEO Tier 1 / GEO (Iteration 2.2) — a single-sourced FAQ for the agencies overview. This
// page is "use client" but still SSRs, so the FAQPage JSON-LD lands in the initial HTML.
// AGENCIES_FAQ is the ONE source of truth: it drives BOTH the visible <dl data-faq-q> AND
// the FAQPage JSON-LD (mapped twice over the same const), so they cannot drift. Every answer
// restates a fact already visible on this page (checks against the issuing registry, the
// L0–L3 trust ladder, the hard-block on a lapsed cert, honest capability labelling) — no
// invented statistics.
const AGENCIES_FAQ: Array<{ q: string; a: string }> = [
  {
    q: "How does Docka help a crewing agency verify certificates?",
    a: "Docka gives a crewing agency one live view of every seafarer, checking each certificate against the issuing country's official maritime registry rather than the PDF: government-verified where the registry supports it, and honestly labelled where it does not.",
  },
  {
    q: "What happens when a required certificate lapses?",
    a: "Docka hard-blocks a seafarer the moment a required certificate lapses, so an expired credential cannot be carried forward into a crewing decision unnoticed.",
  },
  {
    q: "What do the L0 to L3 trust levels mean for compliance?",
    a: "Every document is labelled from L0 (Unverified) to L3 (Government-verified). L2 means the document exists in the official registry; L3 means it was confirmed against the issuing country's registry, so a compliance officer sees not just a green tick but what kind of check produced it.",
  },
  {
    q: "Does Docka verify every flag state automatically?",
    a: "No, and it never pretends to. Some flag-state registries are checked live and automatically, others confirm only that a document exists, and the rest are assisted checks completed on the authority's official portal, each result labelled with the capability it actually used.",
  },
  {
    q: "What does the crew board actually track?",
    a: "Each seafarer sits in one of five stages, from review to accepted, sent to sea, coming back and finished. The card carries the documents on file, the next expiry date, the sea-service record, appraisals and your own notes and tags, and you can filter the board by what is missing or expiring.",
  },
  {
    q: "Can I import the roster I already keep in a spreadsheet?",
    a: "Yes. Upload the spreadsheet and each row becomes a crew card with its own claim link. The seafarer opens the link, uploads the documents and photographs the certificates, and the card stops being a placeholder once it is claimed.",
  },
];

const agenciesFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: AGENCIES_FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

// Public agencies overview. Client component (interactive graphs) — imports ONLY
// static overviewData + presentational components. No lib/db, no lib/agentData, no
// auth, no /api. The persona selector is the shared controller: the selected
// persona's mapped graph(s) get a highlight ring; neutral by default.
export default function AgenciesOverview() {
  const [persona, setPersona] = useState<string | null>(null);
  const selected = AGENCY_PERSONAS.find((p) => p.id === persona) ?? null;
  const isActive = (g: string) => selected?.graphs.includes(g) ?? false;

  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(agenciesFaqJsonLd) }}
      />
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-6 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          For crewing agencies
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Crew compliance software built into the CRM your crewing desk runs on.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Your crewing desk sees every seafarer who granted you access on a five-stage board:
          what is on file, what expires next, who is sea-ready. Docka checks each certificate
          against the register of the flag state that issued it, and a lapsed required document
          holds the seafarer back from sea until you clear it.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/book"
            onClick={() => track("cta_click", { location: "agencies_hero", target: "/book" })}
            className="inline-flex min-h-[44px] items-center rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Book a 20-min demo
          </Link>
          <Link
            href="/verify"
            onClick={() => track("cta_click", { location: "agencies_hero", target: "/verify" })}
            className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Try the live verifier
          </Link>
        </div>
        <p className="mt-3 text-sm text-slate-600">
          Already a customer?{" "}
          <Link
            href="/agent"
            onClick={() => track("cta_click", { location: "agencies_hero", target: "/agent" })}
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            Open the agent dashboard
          </Link>
          . Or{" "}
          <Link
            href="/overview/seafarers"
            onClick={() =>
              track("cta_click", { location: "agencies_hero", target: "/overview/seafarers" })
            }
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            see the seafarer side
          </Link>
          .
        </p>
        {/* Public Sample Profiles (Phase 6) — one descriptive, keyword-rich,
            crawlable link to the live demo board (indexable /sample surface). */}
        <p className="mt-4 text-sm">
          <Link
            href="/sample/agency"
            onClick={() => track("cta_click", { location: "agencies_hero", target: "/sample/agency" })}
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            Explore a live sample crewing-agency board: the five-stage crew pipeline, document
            compliance and forged-certificate flags on fictional data →
          </Link>
        </p>
      </section>

      {/* Key features */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">
          What you get: verification, crew compliance and pipeline
        </h2>
        <p className="mt-1 text-sm text-slate-500">Every item below is live in the product today.</p>
        <div className="mt-6 space-y-8">
          {AGENCY_SECTIONS.map((section) => (
            <div key={section.heading}>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {section.heading}
              </h3>
              <FeatureGrid features={section.features} />
            </div>
          ))}
        </div>
      </section>

      {/* How verification works — honest E-E-A-T trust block (OC6). Names the
          government-registry method + the L0–L3 trust levels; shipped-only claims. */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">How verification works</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Docka checks each seafarer certificate against the issuing country&apos;s official
          maritime registry, live where that registry supports it, and against an honest
          snapshot of the confirmed record where it does not. We never re-type a PDF and call it
          verified, and every document is labelled with exactly how much we could confirm.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="agencies-ladder">
          {LADDER_LEVELS.map((level) => {
            const meta = LEVEL_META[level];
            const top = level === 3;
            return (
              <div
                key={level}
                data-level={level}
                className={`rounded-xl border p-4 ${
                  top ? "border-brand-200 bg-brand-50" : "border-slate-200 bg-white"
                }`}
              >
                <p className={`text-xs font-bold ${top ? "text-brand-700" : level === 2 ? "text-brand-500" : "text-slate-500"}`}>
                  {meta.code}
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{plainPunct(meta.word)}</p>
                <p className={`mt-1 text-xs ${top ? "text-slate-600" : "text-slate-500"}`}>
                  {plainPunct(meta.tip)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Product screenshot (below the fold): a real capture of the live verification
          tool. images:{unoptimized:true} in next.config.js means next/image emits NO
          srcset, so this is a plain <img> with a pre-generated 640px variant (plan v3 C5):
          phones download the small file, desktops the 1200px one. Explicit width/height
          (the file's real 1200x806) keeps CLS at 0; lazy + async (well below the fold). */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <figure className="mx-auto max-w-4xl">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screenshots/docka-verify-certificate-tool.webp"
              srcSet="/screenshots/docka-verify-certificate-tool-640.webp 640w, /screenshots/docka-verify-certificate-tool.webp 1200w"
              sizes="(min-width: 1024px) 896px, 100vw"
              width={1200}
              height={806}
              loading="lazy"
              decoding="async"
              alt="Docka's certificate verification tool showing the code-entry and document-upload options for checking a seafarer certificate against the issuing flag-state registry"
              className="h-auto w-full"
            />
          </div>
          <figcaption className="mt-3 text-center text-sm text-slate-500">
            The live verification tool: paste a certificate code or upload the document to check it
            against the issuing flag state.
          </figcaption>
        </figure>
      </section>

      {/* Persona selector + graphs */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">Who it's for, and what they watch</h2>
        <p className="mt-1 text-sm text-slate-500">
          Pick a person; the graph they rely on lights up.
        </p>
        <div className="mt-6">
          <PersonaSelector
            personas={AGENCY_PERSONAS}
            selectedId={persona}
            onSelect={(id) => {
              setPersona(id);
              if (id) track("persona_select", { persona: id });
            }}
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <FunnelBars active={isActive("G1")} />
          <ComplianceDonut active={isActive("G2")} />
          <LevelDistribution active={isActive("G3")} />
          <StatTiles active={isActive("G4")} />
        </div>
      </section>

      {/* FAQ (SEO Tier 1 / GEO) — visible <dl> mirrors the FAQPage JSON-LD above. */}
      <section className="mx-auto max-w-6xl px-4 py-8" data-testid="agencies-faq">
        <h2 className="text-2xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 max-w-3xl space-y-6">
          {AGENCIES_FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Footer CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-4">
        <div className="rounded-2xl border border-brand-200 bg-brand-50 p-8 text-center">
          <h2 className="text-2xl font-bold text-slate-900">
            Give your crewing desk one verified view.
          </h2>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link
              href="/book"
              onClick={() => track("cta_click", { location: "agencies_footer", target: "/book" })}
              className="inline-flex min-h-[44px] items-center rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
            >
              Book a 20-min demo
            </Link>
            <Link
              href="/verify"
              onClick={() => track("cta_click", { location: "agencies_footer", target: "/verify" })}
              className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Try the live verifier
            </Link>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            <Link
              href="/agent"
              onClick={() => track("cta_click", { location: "agencies_footer", target: "/agent" })}
              className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
            >
              Open the agent dashboard
            </Link>{" "}
            or{" "}
            <Link
              href="/overview/seafarers"
              onClick={() =>
                track("cta_click", { location: "agencies_footer", target: "/overview/seafarers" })
              }
              className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
            >
              see the seafarer side
            </Link>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
