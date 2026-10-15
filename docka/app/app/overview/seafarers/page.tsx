"use client";

import { useState } from "react";
import Link from "next/link";
import { FeatureGrid } from "@/components/overview/FeatureCard";
import { PersonaSelector } from "@/components/overview/PersonaSelector";
import { TrustLadder } from "@/components/overview/TrustLadder";
import { CredentialFlow } from "@/components/overview/CredentialFlow";
import { RemindersTimeline } from "@/components/overview/RemindersTimeline";
import { PropagationHub } from "@/components/overview/PropagationHub";
import { SEAFARER_SECTIONS, SEAFARER_PERSONAS } from "@/components/overview/overviewData";
import { track } from "@/lib/analytics-events";
import { jsonLd } from "@/lib/seo";
import { REGISTRY_PAGE_SLUGS, registryPagePath, registryRow } from "@/lib/registry/public-rows";
import { countryDisplayName, displayRegion } from "@/lib/registry/display";

// The per-country registry pages linked below (plan v3 C5): built from the ONE
// code -> slug map in lib/registry/public-rows.ts, never a hand-typed href list.
const REGISTRY_PAGE_CODES = Object.keys(REGISTRY_PAGE_SLUGS);

// SEO Tier 1 / GEO (Iteration 2.2) — a single-sourced FAQ for the seafarers overview. This
// page is "use client" but still SSRs, so the FAQPage JSON-LD lands in the initial HTML.
// SEAFARERS_FAQ is the ONE source of truth: it drives BOTH the visible <dl data-faq-q> AND
// the FAQPage JSON-LD (mapped twice over the same const), so they cannot drift. Every answer
// restates a fact already visible on this page (free for seafarers, add-by-photo, live checks
// against supported registries, renewal reminders, share control) — no invented statistics.
const SEAFARERS_FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Is Docka free for seafarers?",
    a: "Yes. Docka is free for seafarers, so you can hold and verify your own maritime certificates at no cost, and share them with the agencies you choose.",
  },
  {
    q: "How do I verify my own seafarer certificate?",
    a: "Add each certificate by photo once. Docka verifies the ones issued by supported flag-state registries live against the official record, and guides you to the official portal for the others.",
  },
  {
    q: "Will Docka remind me before a certificate expires?",
    a: "Yes. Docka sends renewal reminders ahead of the expiry date, so you can renew a certificate before it lapses rather than after.",
  },
  {
    q: "Who can see my certificates?",
    a: "You decide. Your certificates stay in one place and you choose which agencies get to see what, staying in control on any phone.",
  },
];

const seafarersFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: SEAFARERS_FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

// Public seafarers overview. Client component (interactive graphs) — imports ONLY
// static overviewData + presentational components. No lib/db, no auth, no /api.
export default function SeafarersOverview() {
  const [persona, setPersona] = useState<string | null>(null);
  const selected = SEAFARER_PERSONAS.find((p) => p.id === persona) ?? null;
  const isActive = (g: string) => selected?.graphs.includes(g) ?? false;

  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(seafarersFaqJsonLd) }}
      />
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-6 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          For seafarers
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Your certificates, in one place — and you decide who sees them.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Add each certificate by photo once, verify the ones from supported registries live
          (others are guided to the official portal), get renewal reminders, and share with the
          agencies you choose — staying in control on any phone.
        </p>
        {/* Positioning batch 2026-09-07 (plan v4 D5): this route carries the CRM identity in
            the body, not in the description, so the seafarer's own framing stays in the SERP. */}
        <p className="mt-3 max-w-2xl text-base text-slate-600">
          Crewing agencies run Docka as their CRM. For a seafarer it is free.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/seafarer"
            onClick={() => track("cta_click", { location: "seafarers_hero", target: "/seafarer" })}
            className="rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Start your profile
          </Link>
          <Link
            href="/overview/agencies"
            onClick={() =>
              track("cta_click", { location: "seafarers_hero", target: "/overview/agencies" })
            }
            className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            See the agency side
          </Link>
        </div>
        {/* Public Sample Profiles (Phase 6) — one descriptive, keyword-rich,
            crawlable link to the live demo profile (indexable /sample surface). */}
        <p className="mt-4 text-sm">
          <Link
            href="/sample/seafarer"
            onClick={() => track("cta_click", { location: "seafarers_hero", target: "/sample/seafarer" })}
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            See a live sample seafarer profile: verified maritime certificates, expiry
            reminders and share links on fictional data →
          </Link>
        </p>
      </section>

      {/* Key features */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">
          What you get: verify, organise and share your certificates
        </h2>
        <p className="mt-1 text-sm text-slate-500">Every item below is live in the product today.</p>
        <div className="mt-6 space-y-8">
          {SEAFARER_SECTIONS.map((section) => (
            <div key={section.heading}>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {section.heading}
              </h3>
              <FeatureGrid features={section.features} />
            </div>
          ))}
        </div>
      </section>

      {/* SEO Tier 1 — owner section for "seafarer documentation service" (additive; the
          hero/H1 above are untouched). Plain buyer-language depth + descriptive links into
          the verification cluster. */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">
          A seafarer documentation service, built around you
        </h2>
        <p className="mt-3 max-w-3xl leading-relaxed text-slate-700">
          Docka is a seafarer documentation service: one place to keep every maritime certificate,
          endorsement and sea-service record, and to prove they are genuine. You add each document once,
          Docka verifies the ones issued by supported flag-state registries live against the official
          record, and you decide which agencies get to see what. It is free for seafarers, and it works
          on any phone.
        </p>
        <p className="mt-3 max-w-3xl leading-relaxed text-slate-700">
          The difference from a folder of PDFs is that verification goes back to the issuing authority
          rather than trusting the document. To see how that works, read{" "}
          <Link
            href="/resources/how-seafarer-certificate-verification-works"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            how seafarer certificate verification actually works
          </Link>
          , check{" "}
          <Link
            href="/registries"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            which registries Docka verifies
          </Link>
          , or{" "}
          <Link
            href="/verify"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            verify a seafarer certificate
          </Link>{" "}
          now.
        </p>
        <p className="mt-3 max-w-3xl leading-relaxed text-slate-700">
          Each flag state Docka checks live has its own page with the register&apos;s name, what
          it asks for and how to run the same lookup yourself on the official portal:
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="seafarers-registry-pages">
          {REGISTRY_PAGE_CODES.map((code) => {
            const row = registryRow(code);
            const href = registryPagePath(code);
            if (!row || !href) return null;
            return (
              <li key={code}>
                <Link
                  href={href}
                  className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
                >
                  {countryDisplayName(displayRegion(code), "en", row.country)} registry
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Product screenshot (below the fold): a real capture of the live public sample
          seafarer profile (fictional, watermarked SAMPLE data). images:{unoptimized:true}
          in next.config.js means next/image emits NO srcset, so this is a plain <img> with
          a pre-generated 640px variant (plan v3 C5). Explicit width/height (the file's
          real 1200x806) keeps CLS at 0; lazy + async (well below the fold). */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <figure className="mx-auto max-w-4xl">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screenshots/docka-sample-seafarer-profile.webp"
              srcSet="/screenshots/docka-sample-seafarer-profile-640.webp 640w, /screenshots/docka-sample-seafarer-profile.webp 1200w"
              sizes="(min-width: 1024px) 896px, 100vw"
              width={1200}
              height={806}
              loading="lazy"
              decoding="async"
              alt="A sample Docka seafarer profile showing a seafarer's maritime certificates and crew-change messages on fictional, watermarked demonstration data"
              className="h-auto w-full"
            />
          </div>
          <figcaption className="mt-3 text-center text-sm text-slate-500">
            A live sample seafarer profile: certificates and crew messages in one place, shown on
            fictional demonstration data.
          </figcaption>
        </figure>
      </section>

      {/* Persona selector + graphs */}
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h2 className="text-2xl font-bold text-slate-900">Built for real crews</h2>
        <p className="mt-1 text-sm text-slate-500">
          Pick a person; the part of Docka they lean on lights up.
        </p>
        <div className="mt-6">
          <PersonaSelector
            personas={SEAFARER_PERSONAS}
            selectedId={persona}
            onSelect={(id) => {
              setPersona(id);
              if (id) track("persona_select", { persona: id });
            }}
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <TrustLadder active={isActive("S1")} />
          <CredentialFlow active={isActive("S2")} />
          <RemindersTimeline active={isActive("S3")} />
          <PropagationHub active={isActive("S4")} />
        </div>
      </section>

      {/* FAQ (SEO Tier 1 / GEO) — visible <dl> mirrors the FAQPage JSON-LD above. */}
      <section className="mx-auto max-w-6xl px-4 py-8" data-testid="seafarers-faq">
        <h2 className="text-2xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 max-w-3xl space-y-6">
          {SEAFARERS_FAQ.map(({ q, a }) => (
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
            Every certificate in one place, verified and ready to share.
          </h2>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Link
              href="/seafarer"
              onClick={() => track("cta_click", { location: "seafarers_footer", target: "/seafarer" })}
              className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
            >
              Start your profile
            </Link>
            <Link
              href="/overview/agencies"
              onClick={() =>
                track("cta_click", { location: "seafarers_footer", target: "/overview/agencies" })
              }
              className="rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              See the agency side
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
