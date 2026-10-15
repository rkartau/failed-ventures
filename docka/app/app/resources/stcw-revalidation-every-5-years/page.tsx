import type { Metadata } from "next";
import Link from "next/link";
import { abs, articleWebPageJsonLd, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { WhatDockaIs } from "@/components/WhatDockaIs";

// PUBLIC, INDEXABLE guide (SEO implementation plan WP-E, G9). Server component. Pairs with
// the seafarer section of /resources/check-stcw-certificate-valid (linked both ways). The
// five-year and refresher statements cite `[src:stcw-convention]` (plan R7c). Every sentence
// with a digit or a hotword carries an adjacent `[src:<id>:...]` code comment resolving to
// docs/seo-new-pages-claims-sources.md. Copy follows the writing style guide.
const TITLE = "STCW Revalidation Every 5 Years: What Expires";
// First published: the day the page went live on docka.me; dateModified is the maintained constant.
// [src:real-features:shipped in the 2026-09-07 deploy (docka.me/version.txt 79d707a)]
const DATE_PUBLISHED = "2026-09-07";
const DESCRIPTION =
  "STCW regulation I/11 revalidation every five years: which certificates are revalidated, which need a refresher, what expired means, how to check yours.";
const PATH = "/resources/stcw-revalidation-every-5-years";
const OG_ALT =
  "A seafarer's certificate of competency next to a calendar marking the fifth anniversary of its issue, with a flag-state registry lookup open beside it.";

const LINK =
  "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

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
    { name: "Resources", path: "/resources" },
    { name: "STCW revalidation every five years", path: PATH },
  ],
  PATH
);

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "STCW revalidation every five years: what expires, what needs a refresher, and how to check your own certificate",
  description: DESCRIPTION,
  image: [abs("/opengraph-image.jpg")],
  inLanguage: "en",
  isPartOf: { "@id": abs("/#website") },
  author: { "@id": abs("/#organization") },
  publisher: { "@id": abs("/#organization") },
  datePublished: DATE_PUBLISHED,
  dateModified: CONTENT_LAST_UPDATED_ISO,
  mainEntityOfPage: articleWebPageJsonLd({
    path: PATH,
    name: TITLE,
    description: DESCRIPTION,
    dateModified: CONTENT_LAST_UPDATED_ISO,
  }),
};

// FAQ: the ONE source for both the visible <dl> and the FAQPage JSON-LD.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "When does basic safety training expire?",
    // [src:stcw-convention:Manila 2010 - refresher training every five years for basic training in personal survival techniques and fire prevention and fire fighting] [src:paris-mou:PSCC57/2024/05 footnote 2 - CoPs do not have to have an expiry date but may do so]
    a: "The Convention does not force a printed expiry date onto a certificate of proficiency, and Paris MoU guidance says a CoP may carry one or not. What the 2010 Manila amendments do require is evidence, every five years, that the standard of competence in personal survival techniques and fire prevention and fire fighting has been maintained. In practice most administrations date the basic safety training certificate five years from issue, and an inspector reads a lapsed date as no evidence of basic training.",
  },
  {
    q: "Can I revalidate my certificate of competency before it expires?",
    // [src:paris-mou:PSCC57/2024/05 footnote 3 - application for revalidation within six months before expiry: revalidated until the fifth anniversary of the date of validity (STCW Code B-I/2)]
    a: "Yes, and it costs you no time. STCW Code section B-I/2, as cited in Paris MoU guidance, lets an administration that receives a revalidation application within the six months before expiry revalidate the certificate to the fifth anniversary of its current validity, not five years from the day you applied.",
  },
  {
    q: "Does a flag state endorsement need its own revalidation?",
    // [src:paris-mou:PSCC57/2024/05 para 10 - separate endorsement expiry not more than five years from issue and never beyond the certificate; expires when the certificate expires]
    a: "It has its own expiry date, which can be at most five years from issue and can never run past the CoC it endorses, and it dies the moment the CoC expires. So the sequence is: revalidate the CoC with the issuing administration first, then ask the recognising flag for a fresh endorsement against the revalidated CoC.",
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

export default function StcwRevalidationEveryFiveYearsPage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(articleJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500">
          <Link href="/resources" className={LINK}>
            Resources
          </Link>{" "}
          / Guide
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          STCW revalidation every five years: what expires, what needs a refresher, and how to check your
          own certificate
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        {/* [src:stcw-convention:reg I/11 revalidation at intervals not exceeding five years; Manila 2010 refresher every five years] */}
        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          Under STCW regulation I/11, a master, officer or radio operator must revalidate their certificate
          of competency at intervals not exceeding five years, by showing continued professional
          competence. Basic safety training and the survival craft and advanced fire fighting
          proficiencies also need evidence of continued competence every five years, a requirement added
          by the 2010 Manila amendments.
        </p>
        {/* [src:stcw-convention:STCW Convention chapter I general provisions (reg I/11 revalidation); Manila 2010 amendments - refresher training module every five years for basic training in personal survival techniques and fire prevention and fire fighting] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          That is the whole rule in two sentences. The detail, and the confusion, is in which documents
          carry a date, which do not, and what &quot;expired&quot; means when someone checks your
          certificate against a register.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Which documents carry the five-year clock</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The Convention was adopted in 1978, entered into force in 1984, and was rewritten twice: by the
          1995 amendments, which created the STCW Code with its mandatory Part A, and by the 2010 Manila
          amendments, which added the five-year refresher for basic training alongside new medical
          standards and measures against fraudulent certificates.
        </p>
        {/* [src:stcw-convention:adopted 7 July 1978; in force 28 April 1984; 1995 conference established the STCW Code with mandatory Part A; Manila 2010 - enhanced fraud prevention, medical standards, refresher training every five years] */}
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li>
            Certificate of competency (CoC): dated, and revalidated under regulation I/11 at intervals not
            exceeding five years.
          </li>
          {/* [src:stcw-convention:reg I/11 revalidation of certificates] */}
          <li>
            Flag state endorsement: dated; a separately issued endorsement cannot exceed five years from
            issue and cannot outlive the CoC.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 para 10] */}
          <li>
            GMDSS radio operator certificate (chapter IV): revalidated under I/11 in the same way as a CoC.
          </li>
          {/* [src:stcw-convention:chapter IV radiocommunication and radio operators; reg I/11 covers radio operators] */}
          <li>
            Certificates of proficiency under A-VI/1 (basic training), A-VI/2 (survival craft and rescue
            boats) and A-VI/3 (advanced fire fighting): evidence of continued competence every five years,
            usually a refresher course.
          </li>
          {/* [src:stcw-convention:Manila 2010 - refresher training every five years; chapter VI] */}
          <li>
            Tanker cargo proficiencies (chapter V): dated and revalidated; the exact route depends on the
            administration.
          </li>
          {/* [src:stcw-convention:chapter V special training for certain ship types] [src:paris-mou:PSCC57/2024/05 para 11 - CoPs under regs V/1-1 and V/1-2] */}
          <li>
            Medical fitness certificate: a shorter cycle. Docka&apos;s document catalogue records a
            one-year norm; your flag&apos;s rule may differ.
          </li>
          {/* [src:lib-doctypes:catalog Medical validityYears 1 (informational norm)] */}
        </ul>
        <p className="mt-3 leading-relaxed text-slate-700">
          Some proficiencies, security awareness among them, carry no revalidation requirement in the
          Convention text as we read it, yet an administration may still print a date on them. When the
          paper and the rule disagree, the register decides what is current, so read the certificate and
          then check it.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Revalidation and refresher are different things</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Revalidation is regulation I/11. The administration re-issues or re-dates the CoC once the
          holder proves continued competence, and the Convention lets that proof be approved seagoing
          service in the period before revalidation, an approved course, or an approved test. Each
          administration sets the exact months of service and the forms.
        </p>
        {/* [src:stcw-convention:reg I/11 continued professional competence; administrations implement through national requirements] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          We deliberately do not restate the month thresholds here. Administrations implement I/11 with
          their own detail, the flag&apos;s revalidation notice is the document to read, and Docka does not
          compute revalidation eligibility for anyone.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          A refresher is different. For A-VI/1, A-VI/2 and A-VI/3 the holder must show every five years
          that the standard of competence is maintained. Most seafarers do a short refresher course; some
          administrations accept documented on-board drills for parts of the syllabus. Ask the flag, not the
          training centre, which of the two it accepts.
        </p>
        {/* [src:stcw-convention:Manila 2010 - refresher training module every five years for A-VI/1 basic training] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Sea service evidence</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The evidence for revalidation by sea service is the seaman&apos;s book (discharge book) and the
          company&apos;s sea service testimonials. In our experience the reasons an administration
          rejects them are mundane: a testimonial whose dates do not match the discharge book, a capacity
          on the testimonial that does not match the CoC, or a vessel that does not qualify as seagoing
          under that administration&apos;s definition.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          Two habits prevent most of it. Have the master sign the testimonial before you leave the ship,
          and keep the discharge book entries and the testimonials in one place from the first contract
          onward. A crewing agency that holds both on file for its seafarers saves everyone weeks when the
          fifth year comes round.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What &quot;expired&quot; means to a register</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Each administration&apos;s register answers in its own way. The registers Docka queries return
          the certificate&apos;s current status or its recorded details; none of them consult the date
          printed on your PDF. If the register says expired, the paper is out of date, whatever it shows.
        </p>
        {/* [src:real-features:8 live-auto flag-state registers return current status; the printed date is a claim, not the record] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Three things follow from an expired CoC. The flag state endorsement expires at the same moment.
          An inspector treats expired certificates as an example of a detainable deficiency, and a lapsed
          basic training certificate as &quot;no evidence of basic training&quot;. And a medical that runs
          out mid-voyage has a grace rule in some flags: under the UK ENG 1 rules the seafarer may work
          until the next port where it can be replaced, or for up to 3 months, whichever is sooner.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 para 10 (endorsement expires with the certificate), s3.3 example 6 (expired certificates), s3.2 item 3 (no evidence of basic training)] [src:mca-eng1:gov.uk seafarer-medical-certificates - expired during a voyage: next port of call or up to 3 months] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">How to check your own certificate</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          <li>
            Find your issuing administration on the{" "}
            <Link href="/registries" className={LINK}>
              registry coverage page
            </Link>
            . It lists the eight flag-state registers Docka checks live and the fields each one asks for.
          </li>
          {/* [src:real-features:8 flag-state live-auto registers listed on /registries] */}
          <li>
            Enter the certificate number, and the date of birth where the register asks for it, on the{" "}
            <Link href="/verify" className={LINK}>
              free certificate check
            </Link>
            . Docka is free for seafarers.
          </li>
          {/* [src:real-features:free for seafarers] */}
          <li>
            Read the answer as the status. A &quot;not found&quot; can mean the register&apos;s coverage
            starts after your issue date, not that your certificate is bad; the coverage page states each
            register&apos;s limit.
          </li>
          <li>
            If the fifth anniversary is within six months, apply now. The administration can revalidate to
            the anniversary date, so applying early loses you nothing.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 footnote 3 - application within six months before expiry; revalidated until the fifth anniversary (STCW Code B-I/2)] */}
        </ol>
        <p className="mt-4 leading-relaxed text-slate-700">
          If your certificate is held in a Docka profile, the reminders go out ahead of the expiry date,
          and a required STCW certificate that has lapsed hard-blocks the profile until a current one is on
          file. The companion guide on{" "}
          <Link href="/resources/check-stcw-certificate-valid" className={LINK}>
            checking whether an STCW certificate is still valid
          </Link>{" "}
          covers the same check from the agency&apos;s side.
        </p>
        {/* [src:real-features:expiry reminders; hard-block on lapsed required STCW certificate] */}

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

        <h2 className="mt-10 text-xl font-bold text-slate-900">Sources</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li>
            <a href="https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx" target="_blank" rel="noopener noreferrer" className={LINK}>
              IMO: the STCW Convention
            </a>
            , for regulation I/11 and the five-yearly refresher training the 2010 Manila amendments added.
          </li>
          {/* [src:stcw-convention:reg I/11 revalidation at intervals not exceeding five years; Manila 2010 refresher training every five years] */}
          <li>
            <a href="https://www.parismou.org/pscc-instructions/" target="_blank" rel="noopener noreferrer" className={LINK}>
              Paris MoU: PSCC instruction 57/2024/05
            </a>
            , for the six-month application rule (STCW Code B-I/2), endorsement expiry and the expiry
            date on a certificate of proficiency.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 para 10, footnote 2, footnote 3] */}
          <li>
            <a href="https://www.gov.uk/seafarer-medical-certificates" target="_blank" rel="noopener noreferrer" className={LINK}>
              GOV.UK: seafarer medical certificates
            </a>
            , for what happens when an ENG 1 expires during a voyage.
          </li>
          {/* [src:mca-eng1:gov.uk seafarer-medical-certificates - expired during a voyage: next port of call or up to 3 months, whichever is sooner] */}
        </ul>

        <p className="mt-8 leading-relaxed text-slate-700">
          Which registers Docka checks live, and what each one asks for, is on the{" "}
          <Link href="/registries" className={LINK}>
            registry coverage page
          </Link>
          . The method behind every check is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
            how seafarer certificate verification works
          </Link>
          .
        </p>

        <div className="mt-8 rounded-2xl border border-brand-200 bg-brand-50 p-6" data-testid="guide-cta">
          <p className="text-lg font-bold text-slate-900">Check a certificate now, free</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-700">
            Enter the certificate number and Docka checks it against the issuing flag state&apos;s register.
          </p>
          <Link
            href="/verify"
            className="mt-4 inline-block rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Check a certificate now, free
          </Link>
        </div>

        <WhatDockaIs />

        <h2 className="mt-10 text-lg font-bold text-slate-900">Related guides</h2>
        <ul className="mt-3 space-y-2 text-slate-700">
          <li>
            <Link href="/resources/check-stcw-certificate-valid" className={LINK}>
              How to check if an STCW certificate is still valid
            </Link>
          </li>
          <li>
            <Link href="/resources/stcw-certificate-types" className={LINK}>
              CoC, CoP, endorsement, GMDSS and medical: what each STCW document proves
            </Link>
          </li>
          <li>
            <Link href="/resources/port-state-control-crew-certificate-deficiencies" className={LINK}>
              Port State Control and crew certificates: what inspectors check
            </Link>
          </li>
          <li>
            <Link href="/resources/spot-forged-recycled-seafarer-certificate" className={LINK}>
              How to spot a forged or recycled seafarer certificate
            </Link>
          </li>
        </ul>
      </article>
    </div>
  );
}
