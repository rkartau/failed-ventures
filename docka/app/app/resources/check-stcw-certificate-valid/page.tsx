import type { Metadata } from "next";
import Link from "next/link";
import {
  abs,
  articleWebPageJsonLd,
  breadcrumbList,
  jsonLd,
  CONTENT_LAST_UPDATED_ISO,
  CONTENT_LAST_UPDATED_LABEL,
} from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { REGISTRY_PAGE_SLUGS, registryPagePath, registryRow } from "@/lib/registry/public-rows";
import { TRUST_LADDER } from "@/lib/verification-level";

// PUBLIC, INDEXABLE long-form article (SEO Tier 1; revised by the SEO implementation plan
// WP-D, D3). Server component. The honesty framing is preserved. Inline `[src:...]` fact
// tokens are kept as ADJACENT CODE COMMENTS next to each claim (not user-visible) so the
// committed fabrication test can gate every quantitative claim against the claim->source
// artifact (docs/seo-tier1-claims-sources.md). The trust ladder is ONE line derived from
// TRUST_LADDER (lib/verification-level.ts) plus a link to the pillar guide, which carries the
// full table; the "what each register asks for" table also lives ONLY on the pillar and
// /registries (content dedupe, 2026-09-07), so this page links the per-register pages from
// the ONE code -> slug map instead. Nothing about a register is re-typed here. Copy follows
// docs/WRITING-STYLE-GUIDE.md. Route is under /resources; canonical self.
const TITLE = "How to Check if an STCW Certificate Is Still Valid"; // [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record]
// First published (git: the page's first commit); dateModified is the maintained constant.
const DATE_PUBLISHED = "2026-09-04";
const DESCRIPTION =
  // [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record]
  "The expiry date on an STCW PDF is a claim, not proof. How to check a certificate against the live flag-state register, and what to do if it is your own.";
const PATH = "/resources/check-stcw-certificate-valid";
const OG_ALT =
  "An STCW certificate PDF showing an expiry date beside a live flag-state registry lookup returning the certificate's current status, illustrating that a printed date is a claim and the register is the proof.";

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
    { name: "Check if an STCW certificate is still valid", path: PATH },
  ],
  PATH
);

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "How to check if an STCW certificate is still valid",
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

// The per-register pages, from the ONE code -> slug map (never a hand-typed href list), and
// the UK row whose portal the worked example names.
// [src:lib-registry-countries:REGISTRY_PAGE_SLUGS; UK portalUrl]
const REGISTRY_PAGE_LINKS = Object.keys(REGISTRY_PAGE_SLUGS).flatMap((code) => {
  const href = registryPagePath(code);
  const name = registryRow(code)?.country;
  return href && name ? [{ code, href, name }] : [];
});
// [src:lib-registry-countries:UK is a public registry row; a missing row is a build-time data error]
function publicRow(code: string) {
  const row = registryRow(code);
  if (!row) throw new Error(`check-stcw-certificate-valid: no public registry row for ${code}`);
  return row;
}
const UK_ROW = publicRow("UK");

// One line for the ladder: its two ends, from the projection (the pillar has the table).
// [src:real-features:L0-L3 ladder from lib/verification-level.ts TRUST_LADDER]
const LADDER_FIRST = TRUST_LADDER[0];
const LADDER_LAST = TRUST_LADDER[TRUST_LADDER.length - 1];

// FAQ: the ONE source of truth for BOTH the visible <dl> and the FAQPage JSON-LD, so the
// two can never drift (the committed parity test asserts set-equality).
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Is my STCW certificate still valid?",
    // [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record] [src:real-features:free for seafarers]
    a: "Check it against the register of the administration that issued it, not against the date on your copy. If your flag state is one of the eight Docka checks live, enter the certificate number on the free check and read the register's answer as the status. If the register says expired or not found, contact the issuing administration; the paper will not tell you why.",
  },
  {
    q: "How long is an STCW certificate valid for?",
    // [src:stcw-convention:reg I/11 revalidation at intervals not exceeding five years; Manila 2010 refresher training module every five years for basic training, advanced firefighting, survival craft]
    a: "A certificate of competency is revalidated under STCW regulation I/11 at intervals not exceeding five years, so most administrations print a date five years from issue. Basic safety training, advanced fire fighting and survival craft proficiencies need evidence of continued competence every five years under the 2010 Manila amendments. Your flag state's register, not the printed date, says whether yours is current today.",
  },
  {
    q: "How do I check if an STCW certificate is still valid?",
    // [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record] [src:verifiable-registries-truth.md:SAFE CLAIMS - 8 flag-state live-auto + assisted deep-link]
    a: "Check the certificate against the issuing flag state's live official register, not against the printed PDF. The date on the document is a claim; the register holds the current status. Docka does this automatically for eight flag-state registers and takes you to the official portal for the rest.",
  },
  {
    q: "Does the expiry date on the certificate prove it is valid?",
    // [src:pillar:an expiry date printed on a PDF is a claim, not a fact]
    a: "No. The printed date can be edited, and a certificate can be suspended or withdrawn before that date without the paper showing it. Only the issuing register reflects the current status.",
  },
  {
    q: "What happens when a seafarer's STCW certificate expires?",
    // [src:real-features:hard-block on lapsed STCW certificate + expiry reminders]
    a: "In Docka, expiry reminders go out ahead of the date, and the system hard-blocks a seafarer the moment a required STCW certificate has lapsed, so an expired credential cannot be carried forward unnoticed.",
  },
  {
    q: "Is there a free STCW or CoC checker?",
    // [src:real-features:free for seafarers] [src:real-features:pricing 300 EUR/mo + 2 EUR/billable seafarer]
    a: "Yes, for the seafarer. A seafarer holds and checks their own certificates in Docka at no cost. An agency pays a licence of 300 EUR a month plus 2 EUR for each billable seafarer; the pricing page has the detail.",
  },
  {
    q: "Which countries can Docka verify a certificate against automatically?",
    // [src:verifiable-registries-truth.md:SAFE CLAIMS - 8 flag-state live-auto + Bulgaria presence 2017+ + assisted]
    a: "Eight flag-state registers are checked live and automatically: Estonia, Denmark, Cyprus, the United Kingdom, Norway, France, Ukraine's state register and Azerbaijan. Bulgaria is an automatic existence check for documents issued 2017 and later, and other countries are handled as assisted checks on the official portal.",
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

export default function CheckStcwValidArticlePage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(articleJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500">
          <Link href="/resources" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            Resources
          </Link>{" "}
          / Guide
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          How to check if an STCW certificate is still valid
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          The short answer: do not trust the expiry date printed on the document. Check the certificate
          against the flag state&apos;s live register. The printed date is a claim; the register is the
          proof.
        </p>
        {/* [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">If it&apos;s your own certificate</h2>
        {/* [src:stcw-convention:reg I/11 revalidation at intervals not exceeding five years] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Two rules set the clock. STCW regulation I/11 requires a master, officer or radio operator to
          revalidate the certificate of competency at intervals not exceeding five years, by showing
          continued professional competence to the issuing administration. And under the 2010 Manila
          amendments, which the{" "}
          <a href="https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            IMO&apos;s page on the STCW Convention
          </a>{" "}
          {/* [src:stcw-convention:Manila 2010 - "Refresher training module every five years for basic training on personal survival techniques and fire prevention and firefighting; advanced firefighting; and proficiency in survival craft, rescue boats and fast rescue boats"] */}
          summarises, the basic safety training (A-VI/1), survival craft and rescue boat (A-VI/2) and
          advanced fire fighting (A-VI/3) proficiencies need evidence of continued competence every five
          years, usually a refresher course.
        </p>
        {/* [src:stcw-convention:Manila 2010 - refresher training module every five years for basic training on personal survival techniques and fire prevention and firefighting; advanced firefighting; proficiency in survival craft, rescue boats and fast rescue boats] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The date on your certificate tells you when the administration expected the clock to run out.
          It does not tell you what the administration&apos;s register says today. To know that, find
          your issuing administration on the{" "}
          <Link href="/registries" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            registry coverage page
          </Link>
          , then enter the certificate number on the{" "}
          <Link href="/verify" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            free certificate check
          </Link>
          . Docka is free for seafarers. If the fifth anniversary is close, the companion guide on{" "}
          <Link href="/resources/stcw-revalidation-every-5-years" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            STCW revalidation every five years
          </Link>{" "}
          explains what expires, what needs a refresher and how early you can apply.
        </p>
        {/* [src:real-features:free for seafarers] [src:stcw-convention:reg I/11 five-year revalidation] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          A note on electronic certificates. Some administrations print a verification code or a QR code
          on the certificate; Estonia&apos;s Transpordiamet, for example, keys its validity check on a
          single &quot;Verification code&quot;. That code is a shortcut to the same register lookup. It is
          not proof by itself, because a code can be printed on a forged document as easily as a date can.
          Scan it, and then read what the register returns.
        </p>
        {/* [src:lib-registry-countries:EE input label "Verification code"; portal meremees.transpordiamet.ee] [src:pillar:the register, not the document, is the proof] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Why the printed date is not proof</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          An expiry date on an STCW PDF is typed text. It can be edited, and an out-of-date document can
          be re-saved to say whatever someone wants it to say. A certificate is a copy. The
          authority&apos;s register is the original record. A date on the copy tells you what the copy
          says, not what the register currently holds.
        </p>
        {/* [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          A certificate can also be suspended or withdrawn before its printed expiry, and the paper will
          not show it. So &quot;the date is in the future&quot; and &quot;the certificate is valid right
          now&quot; are two different statements, and only the register answers the second one.
        </p>
        {/* [src:pillar:check the live record (register = current status, not the PDF)] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">The reliable check, step by step</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-slate-700">
          <li>Take the certificate number and the holder&apos;s details from the document.</li>
          <li>Check them against the issuing flag state&apos;s official register, not against the PDF.</li>
          <li>
            Read the register&apos;s answer as the status, and treat the printed date as unconfirmed until
            the register agrees.
          </li>
        </ol>
        {/* [src:pillar:an expiry date printed on a PDF is a claim, not a fact; check the live record] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          For eight flag states this check is live and automatic. Docka runs live automatic verification
          against Estonia, Denmark, Cyprus, the United Kingdom, Norway, France, Ukraine&apos;s state
          register and Azerbaijan.
        </p>
        {/* [src:verifiable-registries-truth.md:SAFE CLAIMS - 8 flag-state live-auto: Estonia, Denmark, Cyprus, UK, Norway, France, Ukraine state, Azerbaijan] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          For Bulgaria, an automatic check confirms the document <em>exists</em> in the official register
          for certificates issued 2017 and later. That is a presence check, not a validity verdict. For
          other countries the check is assisted: Docka takes you to the correct official portal and a
          person completes it.
        </p>
        {/* [src:verifiable-registries-truth.md:Bulgaria auto-presence, 2017+, existence not validity] [src:verifiable-registries-truth.md:assisted - deep-link + prefill, user completes on official portal] */}

        <p className="mt-4 leading-relaxed text-slate-700">
          Each register keys its lookup on different fields printed on the certificate, and you need
          them exactly as printed. The table of what every live register asks for, with each
          authority&apos;s own portal, is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            how seafarer certificate verification actually works
          </Link>
          , and the tiered list of every register, live, assisted or manual, is on the{" "}
          <Link href="/registries" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            registry coverage page
          </Link>
          .
        </p>
        {/* [src:lib-registry-countries:the inputs table lives on the pillar guide and /registries] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">A worked example: a chief officer joining in three weeks</h2>
        {/* [src:pillar:check the live record] [src:real-features:timestamped registry result; L0-L3 label] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          A crewing manager has a British chief officer joining a vessel in three weeks and a scanned
          Certificate of Competency whose printed expiry is next year. The manager does not decide
          anything from the scan. She reads the document ID from it, notes the date of birth, and runs the
          check. Docka sends both to the Maritime and Coastguard Agency&apos;s verification service, the
          same one a person reaches at{" "}
          <RegistryPortalLink portalUrl={UK_ROW.portalUrl} className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500" />
          , and records the answer with a timestamp.
        </p>
        {/* [src:lib-registry-countries:UK inputs "Document ID" + "Date of birth"; portal coccec.mcga.gov.uk] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Whatever the register returns is the status. If it confirms the certificate, the document is
          labelled at the government-verified level, with the timestamp of the query beside it. If it
          does not recognise the document ID, nothing is rounded up: the manager sees a not-found result,
          the level stays where it was, and the next call is to the seafarer, then to the administration.
          The point of the example is what the manager never does: she never reads the date off the PDF
          and files it as checked.
        </p>
        {/* [src:real-features:timestamped result; a not-found result is never rounded up; L3 Government-verified] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Stopping a lapse before it sails</h2>
        {/* [src:real-features:hard-block on lapsed STCW certificate + expiry reminders] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Checking once is not the same as staying valid. STCW certificates expire on a rolling basis, and
          a document that was valid at hire can lapse mid-contract. Docka handles this in two ways: it
          sends expiry reminders ahead of the date, and it hard-blocks a seafarer the moment a required
          STCW certificate has lapsed, so an expired credential cannot be quietly carried forward. The
          reminder is the warning; the hard block is the backstop.
        </p>
        {/* [src:real-features:hard-block on lapsed STCW certificate + expiry reminders] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">When the register and the paper disagree</h2>
        {/* [src:pillar:check the live record; the register, not the document, is the proof] [src:real-features:a not-found result is never rounded up; Docka reports the register's answer] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The printed date says next year and the register says expired, or not found. That is the
          moment this guide exists for, and the order of operations matters. First, retype the number.
          A letter O read as a zero, or a digit dropped from a long certificate number, produces a
          clean not-found on every register, and it is the first thing to rule out. Second,
          check that you asked the right register: a flag state endorsement is checked with the flag
          that issued the endorsement, and the certificate it recognises is checked with the
          administration that examined the seafarer. Asking the wrong one returns nothing, and nothing
          looks like a fail.
        </p>
        {/* [src:pillar:check the live record] [src:real-features:Docka reports the register's answer at the level reached; never a Docka verdict] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Third, if the number is right and the register is right and the answer is still expired or
          not found, stop treating the document as current. Ask the seafarer for the administration&apos;s
          revalidation record or receipt, and put the question to the issuing administration in writing.
          Docka records the register&apos;s answer and the time it was asked; it does not decide who is
          right. What it will not do is let the printed date stand in for the register&apos;s answer on
          the board.
        </p>
        {/* [src:real-features:timestamped result; a not-found result is never rounded up] [src:pillar:the printed date is a claim, not the record] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Keep the evidence together while the disagreement is open: the scan you were sent, a
          screenshot of the portal answer with its date, and the correspondence exchanged with the
          seafarer and the administration, in one folder per vacancy, so a superintendent or an auditor
          can retrace the decision without a phone call. If the outcome is a renewed
          certificate, run the lookup again against the new number instead of assuming the old record
          was updated; a fresh timestamp on a fresh number closes the question cleanly. If the outcome
          is silence, the berth stays unfilled. An unanswered query justifies postponing a joining
          date, and a printed expiry never justifies advancing one.
        </p>
        {/* [src:real-features:timestamped registry result; the register's answer, not the paper, decides] [src:pillar:check the live record] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">How confident is the answer?</h2>
        {/* [src:real-features:L0-L3 ladder rendered from lib/verification-level.ts TRUST_LADDER] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Docka labels every document on a four-level ladder, from {LADDER_FIRST.code}{" "}
          {LADDER_FIRST.name} to {LADDER_LAST.code} {LADDER_LAST.name}, so a &quot;valid&quot; result
          also says how it was confirmed. The full table, with what each level means, is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            how seafarer certificate verification actually works
          </Link>
          .
        </p>
        {/* [src:real-features:L0-L3 ladder; the pillar guide carries the canonical LevelTable] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          Two of the eight deserve a footnote when you read the result. A Cyprus answer comes from a
          live connection to the ministry&apos;s form, and it is that connection you are trusting, not a
          guaranteed green verdict. The Ukrainian state register reliably covers documents issued 2023
          and later, so an older certificate that comes back not found is unresolved, not failed, and
          the next step is a question to the administration.
        </p>
        {/* [src:verifiable-registries-truth.md:Cyprus soft caveat - live connection, not a guaranteed verdict] [src:verifiable-registries-truth.md:Ukraine state registry 2023+ coverage caveat] */}

        <p className="mt-6 leading-relaxed text-slate-700">
          Each live register also has its own page, with the authority&apos;s name, the fields it
          takes and the steps to run the same lookup by hand:{" "}
          {/* [src:lib-registry-countries:per-register pages from REGISTRY_PAGE_SLUGS] */}
          {REGISTRY_PAGE_LINKS.map((l, i) => (
            <span key={l.code}>
              {i > 0 ? ", " : ""}
              <Link href={l.href} className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
                {l.name}
              </Link>
            </span>
          ))}
          .
        </p>
        {/* [src:lib-registry-countries:per-register pages from REGISTRY_PAGE_SLUGS] */}

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
            <Link href="/resources/how-seafarer-certificate-verification-works" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              How seafarer certificate verification actually works
            </Link>
          </li>
          <li>
            <Link href="/resources/stcw-revalidation-every-5-years" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              STCW revalidation every five years: what expires and when
            </Link>
          </li>
          <li>
            <Link href="/resources/spot-forged-recycled-seafarer-certificate" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              Spot a forged or recycled seafarer certificate
            </Link>
          </li>
          <li>
            <Link href="/resources/stcw-certificate-types" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              CoC, CoP, endorsement, GMDSS and medical: what each STCW document proves
            </Link>
          </li>
          <li>
            <Link href="/registries" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              Which seafarer certificate registers Docka verifies
            </Link>
          </li>
        </ul>
      </article>
    </div>
  );
}
