import type { Metadata } from "next";
import Link from "next/link";
import { LastUpdated } from "@/components/LastUpdated";
import { CONTENT_LAST_UPDATED_ISO, breadcrumbList, jsonLd, webPageJsonLd } from "@/lib/seo";

// Minimal, PUBLIC, indexable privacy & cookies page (required for consent lawfulness
// + E-E-A-T). Plain language, on-brand. Server component so it can export metadata.
// WP-B: SERP-length title, visible "Last updated" line (shared LastUpdated component,
// static maintained date), a Controller block naming the legal entity + Stripe as the
// payment processor. No retention table and no hosting/email vendors (owner-gated).
const TITLE = "Privacy and Cookie Policy: Your Data on Docka";
const DESCRIPTION =
  "How Docka handles your data: your certificates stay private, cookies we use, and privacy-friendly analytics that load only with your consent.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    type: "website",
    url: "/privacy",
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

// Home › Privacy (selfPath gives the "#breadcrumb" @id the WebPage node references).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Privacy", path: "/privacy" },
  ],
  "/privacy"
);

const WEBPAGE_JSONLD = webPageJsonLd({
  path: "/privacy",
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

// Legal-entity facts (already public on /contact and in the Organization JSON-LD).
const CONTROLLER = {
  legalName: "Docka Development OÜ",
  registryCode: "17579582",
  location: "Tallinn, Estonia",
  email: "info@docka.me",
};

function Block({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-bold text-slate-900">{heading}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-600">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(WEBPAGE_JSONLD) }}
      />
      <section className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          Privacy &amp; cookies
        </p>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
          Your privacy on Docka
        </h1>
        <LastUpdated />
        <p className="mt-3 text-slate-600">
          Docka helps seafarers keep their certificates and share them only with the agencies
          they choose. This page explains, in plain terms, who is responsible for your data,
          what we collect, the cookies we use, and how analytics works.
        </p>

        <div className="mt-8 space-y-4">
          <Block heading="Who is responsible for your data">
            <p>
              Docka is a CRM for crewing agencies, operated by Docka Development OÜ.
              The data controller is {CONTROLLER.legalName} (registry code{" "}
              {CONTROLLER.registryCode}), {CONTROLLER.location}. Contact{" "}
              <a
                href={`mailto:${CONTROLLER.email}`}
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                {CONTROLLER.email}
              </a>
              .
            </p>
            <p>
              Agency subscription payments are processed by Stripe, which acts as our payment
              processor. Docka never receives or stores card, IBAN or mandate details.
            </p>
          </Block>

          <Block heading="Your documents stay private">
            <p>
              The certificates and personal details you add are private to you. They are visible
              only to the people you send your personal share link to, and to the agencies you
              grant access. They are never public and never search-indexed. You can reset a share
              link or revoke an agency&apos;s access at any time.
            </p>
          </Block>

          <Block heading="What we collect">
            <p>
              To run the product we store the documents you upload, the details on them (such as a
              certificate name and expiry date) and, where a document is government-verified, the
              identity the official registry returns. We keep only what the features you use need.
            </p>
            <p>
              Documents uploaded to the public certificate check are retained by Docka to improve
              document recognition and to test registry integrations, and can be removed on
              request.
            </p>
          </Block>

          <Block heading="Cookies we use">
            <p>
              We use a small number of cookies. A <strong>language cookie</strong> remembers the
              language you pick so the site loads in it. When signed in, a{" "}
              <strong>session cookie</strong> keeps you logged in. If analytics is offered on this
              site, a <strong>consent cookie</strong> remembers your choice so we don&apos;t ask
              again.
            </p>
          </Block>

          <Block heading="Analytics, only with your consent">
            <p>
              If Docka uses analytics, it is privacy-friendly and loads <strong>only after you
              accept</strong>. Nothing that tracks you runs before that, and you can decline with a
              single click. We never send your name, your documents, your personal code, or any
              share token to an analytics service, only anonymous, aggregated page usage.
            </p>
          </Block>

          <Block heading="B2B outreach emails">
            <p>
              We send business emails to crewing and manning agencies to tell them about Docka.
              Our legal basis is legitimate interest (GDPR Art. 6(1)(f)): offering a B2B service
              to companies it is relevant for.
            </p>
            <p>
              The addresses we write to come from public sources: official and public business
              and maritime registries, and company websites. Each email states the specific
              source its address came from.
            </p>
            <p>
              For this outreach we store the company name, the work email address, our
              correspondence, and, if you follow a link in one of our emails, which pages you
              visit on docka.me. This data is not sold or shared with third parties.
            </p>
            <p>
              Don&apos;t want to hear from us? Reply &quot;no&quot; to any email and we remove
              you permanently, or write to{" "}
              <a
                href="mailto:info@docka.me"
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                info@docka.me
              </a>
              .
            </p>
          </Block>

          <Block heading="Contact">
            <p>
              Questions about your data or this page? Contact the Docka team at{" "}
              <a
                href="mailto:info@docka.me"
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                info@docka.me
              </a>
              .
            </p>
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
