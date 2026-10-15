import type { Metadata } from "next";
import Link from "next/link";
import {
  abs,
  breadcrumbList,
  jsonLd,
  plainPunct,
  webPageJsonLd,
  CONTENT_LAST_UPDATED_ISO,
  CONTENT_LAST_UPDATED_LABEL,
} from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { LEVEL_META } from "@/lib/verification-level";

// PUBLIC, INDEXABLE definition page (SEO plan WP-E, E4). Server component. The definition
// sentence is the home page's HOME_FAQ[0] answer (app/page.tsx), copied verbatim and passed
// through the shared plainPunct() at the data layer (plan R8); tests pin the equality.
// JSON-LD: WebPage, DefinedTerm, FAQPage (same array as the visible <dl>), BreadcrumbList.
// Sources for every digit/hotword line: `[src:...]` comments allowlisted in
// docs/seo-new-pages-claims-sources.md.
const PATH = "/what-is-primary-source-verification";
const TITLE = "What Is Primary Source Verification (PSV)?";
// First published: the day the page went live on docka.me (sha 79d707a).
const DATE_PUBLISHED = "2026-09-07";
const DESCRIPTION =
  "Primary source verification (PSV) means checking a seafarer certificate against the issuing flag state's register, not the PDF. Definition and examples.";
const OG_ALT =
  "A seafarer certificate PDF beside a flag-state register lookup, illustrating primary source verification: the register is the original, the PDF is a copy.";

// [src:home-faq:HOME_FAQ[0].a in app/page.tsx, verbatim, punctuation normalised by plainPunct]
const PSV_DEFINITION = plainPunct(
  "Primary source verification (PSV) means asking the authority that issued the certificate (the flag state's official register) instead of trusting the PDF. Docka queries that register directly and returns a timestamped, PSC-ready result."
);

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    type: "article",
    url: PATH,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image.jpg", alt: OG_ALT }],
  },
  twitter: { title: TITLE, description: DESCRIPTION, images: ["/twitter-image.jpg"] },
};

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "What is primary source verification (PSV)?", path: PATH },
  ],
  PATH
);

const webPage = {
  ...webPageJsonLd({
    path: PATH,
    name: TITLE,
    description: DESCRIPTION,
    dateModified: CONTENT_LAST_UPDATED_ISO,
  }),
  datePublished: DATE_PUBLISHED,
};

const definedTermJsonLd = {
  "@context": "https://schema.org",
  "@type": "DefinedTerm",
  "@id": `${abs(PATH)}#term`,
  name: "Primary source verification (PSV)",
  termCode: "PSV",
  description: PSV_DEFINITION,
  inDefinedTermSet: abs(PATH),
};

// [src:real-features:L0-L3 ladder from LEVEL_META]
const LADDER = ([0, 1, 2, 3] as const).map((n) => ({
  code: LEVEL_META[n].code,
  word: plainPunct(LEVEL_META[n].word),
}));

// FAQ: ONE array drives the visible <dl data-faq-q> and the FAQPage JSON-LD.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Is primary source verification the same as certificate verification?",
    // [src:home-faq:PSV = checking against the issuing authority's register instead of trusting the PDF]
    a: "It is one method of it, the strict one. Certificate verification can mean anything from glancing at a stamp to phoning a training centre. Primary source verification means one thing: asking the authority that issued the document, through its own register.",
  },
  {
    q: "Does a QR code on a certificate count as primary source verification?",
    // [src:portal-EE:"scan the QR-code on the document" on the Transpordiamet validity check] [src:home-faq:a QR code can be copied]
    a: "Only when the code opens the issuing authority's own register. Estonia's validity check accepts a scan of the QR code printed on the document and answers from the register. A QR code that opens a PDF hosted anywhere else is a copy of a copy.",
  },
  {
    q: "Can a seafarer run primary source verification on their own certificate?",
    // [src:portal-DK:public STCW certificate check with no login] [src:portal-CY:public form] [src:real-features:free for seafarers]
    a: "Yes. The flag-state portals described on this site are public forms with no login. Docka is free for seafarers, so a seafarer can also keep the verified result on file and share it.",
  },
  {
    q: "Is primary source verification possible for every flag state?",
    // [src:lib-registry-countries:capability auto for EE, DK, CY, UK, NO, FR, UA-MARAD, AZ; auto-presence for BG; assisted and manual for the rest]
    a: "Not automatically. Docka checks eight flag-state registers live: Estonia, Denmark, Cyprus, the United Kingdom, Norway, France, Ukraine's state registry and Azerbaijan. For Bulgaria the automatic check confirms only that the document exists. For other countries Docka opens the official portal with what it knows and a person finishes the check.",
  },
  {
    q: "What does PSV mean in shipping when it is not about verification?",
    // [src:real-features:PSV also abbreviates Platform Supply Vessel]
    // [src:real-features:PSV abbreviation collides with Platform Supply Vessel]
    a: "Platform supply vessel, the offshore ship that carries cargo and supplies to rigs. The two uses share three letters and nothing else.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

const LINK = "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

export default function WhatIsPsvPage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(webPage) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(definedTermJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500">
          <Link href="/" className="text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            Home
          </Link>{" "}
          / Definition
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          What is primary source verification (PSV) in maritime?
        </h1>
        <LastUpdated />
        <p data-testid="byline" className="mt-1 text-xs text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>

        <p className="mt-5 text-lg leading-relaxed text-slate-700" data-testid="psv-definition">
          {PSV_DEFINITION}
        </p>
        {/* [src:real-features:PSV abbreviation collides with Platform Supply Vessel] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          The rest of this page unpacks that sentence: what counts as a primary source, what does not, and why the same three letters mean a ship to half the industry.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Primary source, secondary source</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:home-faq:a stamp, a signature or a QR code can all be copied; an expiry date printed on a PDF is a claim] */}
          A certificate of competency (CoC) in a seafarer&apos;s hand is a copy of a record. The record is the entry in the
          flag state&apos;s register. Everything printed on the paper, the expiry date included, is a claim about that entry.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:portal-DK:"The STCW Convention requires that certificates and endorsements can be verified at the issuing administration."] */}
          The Danish Maritime Authority puts it plainly on its verification service: the STCW Convention requires that
          certificates and endorsements can be verified at the issuing administration. The administration is the primary
          source. A verification that stops at the paper, however careful, is a check of the copy.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:lib-registry-countries:UK inputs "Document ID" + "Date of birth"; CY inputs "Seafarer ID" + "Certificate number"; DK input "Certificate number"] */}
          Each authority decides what key opens its register. The Maritime and Coastguard Agency (MCA) wants a document ID
          and a date of birth. Cyprus wants the seafarer ID and the certificate number together. Denmark wants the
          certificate number alone. The method is the same; the key differs.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What primary source verification is not</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          {/* [src:home-faq:reading the document is not verification] */}
          <li>Reading the PDF, by eye or by OCR. That is transcription of the copy.</li>
          {/* [src:home-faq:a QR code can be copied] */}
          <li>Scanning a QR code that opens a PDF on a file host. Same copy, different route.</li>
          {/* [src:home-faq:a stamp or signature can be copied] */}
          <li>Comparing the stamp and signature with a specimen. A good forgery is made to pass that test.</li>
          {/* [src:real-features:Ukraine training-centre validator is L2 registry-confirmed, not the flag state] */}
          <li>
            Confirming with a training centre that it issued a course certificate. Useful, but the training centre is
            not the flag state, and Docka labels such a result one level below a government check.
          </li>
        </ul>

        <h2 className="mt-10 text-xl font-bold text-slate-900">PSV also means platform supply vessel</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:real-features:PSV abbreviation collides with Platform Supply Vessel] */}
          In shipping, PSV is the everyday abbreviation for a platform supply vessel, the offshore ship that carries
          cargo, fuel and drilling supplies out to rigs. This page is about the verification method, not the ship. If
          you searched for the vessel type, nothing here will help you; if you searched for how to check a seafarer&apos;s
          papers against the register, read on.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:real-features:Docka spells the term out before using the abbreviation] */}
          Because of the collision, Docka writes the phrase out in full before using the abbreviation, on every page.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">How Docka does it</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:lib-registry-countries:capability auto entries EE, DK, CY, UK, NO, FR, UA-MARAD, AZ; BG auto-presence; others assisted/manual] */}
          Docka queries eight flag-state registers directly: Estonia, Denmark, Cyprus, the United Kingdom, Norway,
          France, Ukraine&apos;s state registry and Azerbaijan. For Bulgaria the automatic check confirms that the document
          exists and nothing more. For every other country Docka opens the official portal, pre-fills what it can, and a
          person completes the check there. The{" "}
          <Link href="/registries" className={LINK}>
            registry coverage page
          </Link>{" "}
          lists each authority with its portal.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:real-features:L0-L3 ladder; a lower level is never rounded up] */}
          The result is labelled on a four-level ladder so nobody mistakes a weak check for a strong one:
        </p>
        <ul className="mt-2 space-y-1 text-slate-700" data-testid="trust-ladder">
          {LADDER.map((l) => (
            <li key={l.code}>
              <span className="font-semibold text-slate-900">{l.code}</span> {l.word}
            </li>
          ))}
        </ul>
        <p className="mt-3 leading-relaxed text-slate-700">
          {/* [src:real-features:timestamped, PSC-ready result] */}
          Each answer is stamped with the time the register was asked, so a port state control (PSC) inspector sees when
          the check happened, as well as what it found. The mechanics are in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
            how seafarer certificate verification actually works
          </Link>
          .
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <dl className="mt-4 space-y-6">
          {FAQ.map(({ q, a }) => (
            <div key={q}>
              <dt className="text-base font-semibold text-slate-900" data-faq-q>
                {q}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed text-slate-700">{a}</dd>
            </div>
          ))}
        </dl>

        <WhatDockaIs />

        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Run a primary source verification</h2>
          <p className="mt-2 text-slate-700">
            Paste a certificate number and Docka asks the issuing register.{" "}
            <Link href="/verify" className={LINK}>
              Verify a seafarer certificate
            </Link>
            .
          </p>
        </div>
      </article>
    </div>
  );
}
