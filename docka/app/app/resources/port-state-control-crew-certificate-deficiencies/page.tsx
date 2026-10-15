import type { Metadata } from "next";
import Link from "next/link";
import { abs, articleWebPageJsonLd, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { WhatDockaIs } from "@/components/WhatDockaIs";

// PUBLIC, INDEXABLE guide (SEO implementation plan WP-E, G5). Server component. Built from
// the Paris MoU instruction PSCC57/2024/05 (certification and manning) and the two MoUs'
// published deficiency-code lists. No detention or deficiency statistics are asserted. Every
// sentence with a digit or a hotword carries an adjacent `[src:<id>:...]` code comment
// resolving to docs/seo-new-pages-claims-sources.md. Copy follows the writing style guide.
const TITLE = "Port State Control Crew Certificate Deficiencies";
// First published: the day the page went live on docka.me; dateModified is the maintained constant.
// [src:real-features:shipped in the 2026-09-07 deploy (docka.me/version.txt 79d707a)]
const DATE_PUBLISHED = "2026-09-07";
const DESCRIPTION =
  "How PSC inspectors check crew certificates, the Paris and Tokyo MoU deficiency codes, what warrants detention, and how to prepare the crew file.";
const PATH = "/resources/port-state-control-crew-certificate-deficiencies";
const OG_ALT =
  "A port State control officer comparing a crew list and minimum safe manning document against a stack of seafarer certificates on a ship's bridge.";

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
    { name: "Port State Control crew certificate deficiencies", path: PATH },
  ],
  PATH
);

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "Port State Control and crew certificates: what inspectors check, and what gets a ship detained",
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
    q: "Does the PSC inspector test a seafarer's competence, or only the paperwork?",
    // [src:paris-mou:PSCC57/2024/05 s2.2 Assessment - only on clear grounds; onboard assessment commences with verification of the certificates]
    a: "Only the paperwork, unless there are clear grounds. The Paris MoU instruction allows an assessment of competence only where there are clear grounds for believing watchkeeping or security standards are not being maintained, and it says that assessment starts with verification of the certificates. Where doubt remains, the officer may ask the seafarer to perform an operational control at the place of duty.",
  },
  {
    q: "How are the Paris MoU and Tokyo MoU different for crew certificates?",
    // [src:tokyo-mou:22 member Authorities in the Asia-Pacific region; deficiency codes as of 25 December 2025] [src:paris-mou:deficiency codes list 1 July 2026, category Certificate & Documentation]
    a: "By region, mostly. The Paris MoU covers Europe and the North Atlantic; the Tokyo MoU has 22 member Authorities in the Asia-Pacific region. Both code certificate findings under category 01, Certificate and Documentation, with a crew-certificates sub-group, and the item names match. The Paris MoU also publishes the instruction its officers follow for STCW certification and manning; we have not found an equivalent public instruction on the Tokyo MoU site.",
  },
  {
    q: "What happens when an inspector suspects a certificate is fraudulent?",
    // [src:paris-mou:PSCC57/2024/05 s3.4 - consult the STCW Parties involved for verification of authenticity and validity; contact points on IMO GISIS; EMSA STCW-IS]
    a: "The instruction tells the officer to ask the issuing STCW Party to verify the certificate's authenticity and validity, using the contact points that issuing authorities have lodged with IMO on GISIS, and the EMSA STCW Information System for EU-recognised certificates. Evidence that a certificate was fraudulently obtained, or that the holder is not the person it was issued to, is listed among the examples of detainable deficiencies.",
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

export default function PortStateControlCrewCertificateDeficienciesPage() {
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
        {/* [src:paris-mou:PSCC57/2024/05 s3.3 - deficiencies that may warrant detention] */}
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Port State Control and crew certificates: what inspectors check, and what gets a ship detained
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          A Port State Control (PSC) inspector checks that every seafarer who must be certificated holds
          the right certificate of competency or proficiency, the flag state endorsement and a valid
          medical, and that the crew matches the minimum safe manning document. Missing, expired or
          fraudulent certificates are on the published list of deficiencies that may warrant detention.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 para 1 (initial inspection scope) and s3.3 (deficiencies that may warrant detention)] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          The two regimes that matter for most of our readers are the{" "}
          <a href="https://www.parismou.org" target="_blank" rel="noopener noreferrer" className={LINK}>
            Paris Memorandum of Understanding
          </a>{" "}
          (Europe and the North Atlantic) and the{" "}
          <a href="https://www.tokyo-mou.org" target="_blank" rel="noopener noreferrer" className={LINK}>
            Tokyo MoU
          </a>{" "}
          (Asia-Pacific, 22 member Authorities). Both publish the deficiency codes their inspectors use,
          and the Paris MoU publishes the instruction its officers follow for certification and manning.
          This guide is built from those documents, not from anecdotes.
        </p>
        {/* [src:tokyo-mou:homepage - "consists of 22 member Authorities in the Asia-Pacific region"] [src:paris-mou:pscc-instructions page lists PSCC57/2024/05 Certification and Manning according STCW Convention MLC and SOLAS] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the inspector checks first</h2>
        {/* [src:paris-mou:PSCC57/2024/05 - Port State Control Committee Instruction 57/2024/05, listed on parismou.org/pscc-instructions/] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The Paris MoU instruction{" "}
          {/* [src:paris-mou:PSCC57/2024/05 title and download URL as listed on parismou.org/pscc-instructions/] */}
          <a href="https://parismou.org/download/pscc57-2024-05-certification-and-manning-according-stcw-convention-mlc-and-solas/" target="_blank" rel="noopener noreferrer" className={LINK}>
            PSCC57/2024/05
          </a>{" "}
          limits the initial inspection of seafarer certificates to verifying that seafarers who are
          required to be certificated hold the appropriate CoC, CoP and documentary evidence under chapters
          II to VII of STCW, plus their flag state endorsement, a valid dispensation, or proof that an
          endorsement application has been submitted.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 para 1 - initial inspection limited to verification of CoC, CoP, documentary evidence under chapters II-VII, flag State endorsement, valid dispensation or proof of application] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The officer then confirms the certificates fit the ship&apos;s characteristics, its operation and
          the person&apos;s position on board. A chief mate&apos;s CoC on a chemical tanker without the
          tanker proficiency fails that test, however valid the CoC is.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 para 3 - confirm certificates are applicable to the ship's characteristics, operation and position on board] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Manning is checked alongside. The officer reads the Minimum Safe Manning Document (MSMD) and the
          muster list and verifies that the numbers and certificates on board match them. If the ship is
          manned in line with its MSMD, the officer should accept it as safely manned. Hours of rest come
          next: the watch schedule must be posted in the ship&apos;s working language and in English, and
          the daily rest records must be kept in the same way.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 paras 22-24 (MSMD and muster list; accept as safely manned) and 28-30 (watch schedule and rest records in working language and English)] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The instruction also says plainly that incorrect wording or missing information on a certificate
          may be cause for suspicion of fraud, and the officer should investigate. A capacity wording that
          does not match the endorsement, or a number format that is wrong for the issuing flag, draws
          attention for exactly that reason.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 para 13 - incorrect wording or missing information may be a cause for suspicion regarding fraudulent certificates or endorsements] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">The deficiency codes</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Both MoUs code certificate findings under category 01, Certificate and Documentation, which
          splits into ship certificates and crew certificates. The{" "}
          {/* [src:tokyo-mou:Tokyo-MOU-deficiency-codes-July-2026.pdf "As of 25 December 2025" - 012 Crew Certificates codes 01201-01218] */}
          <a href="https://www.tokyo-mou.org/inspections-detentions/deficiency-codes/" target="_blank" rel="noopener noreferrer" className={LINK}>
            Tokyo MoU deficiency code list
          </a>{" "}
          (as of 25 December 2025) numbers the crew items: 01201 certificates for master and officers,
          01202 certificate for rating for watchkeeping, 01203 certificates for radio personnel, 01204
          certificate for personnel on tankers, 01206 certificate for advanced fire-fighting, 01213
          evidence of basic training, 01214 endorsement by flag State, 01215 application for endorsement
          by flag State, and 01218 medical certificate.
        </p>
        {/* [src:tokyo-mou:Tokyo-MOU-deficiency-codes-July-2026.pdf "As of 25 December 2025" - 01 Certificate & Documentation; 012 Crew Certificates; codes 01201-01218 as named] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The{" "}
          <a href="https://parismou.org/deficiency-codes/" target="_blank" rel="noopener noreferrer" className={LINK}>
            Paris MoU list of 1 July 2026
          </a>{" "}
          uses the same item names, from &quot;Certificates for master and officers&quot; through
          &quot;Endorsement by flagstate&quot; and &quot;Evidence of Basic Training&quot; to &quot;Medical
          certificate&quot;.
        </p>
        {/* [src:paris-mou:"List of Deficiency Codes including Statutory Certificates, 1 July 2026" - crew certificate item names as quoted] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Why the code matters to you: it is what appears on the inspection report against the ship, and a
          pattern of crew-certificate findings across a company&apos;s ships is visible to the next
          inspector who looks the company up. We do not quote detention or deficiency counts here. Both
          MoUs publish current detention lists and annual reports, and those figures change monthly.
        </p>
        {/* [src:paris-mou:parismou.org publishes detentions and company performance] [src:tokyo-mou:tokyo-mou.org publishes a detention list] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Detention, or rectify before departure</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The instruction is specific. Deficiencies that may warrant detention are those that pose a danger
          to persons, property or the environment under STCW regulation I/4, and it lists them:
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s3.3 - deficiencies that may warrant detention, STCW reg I/4 para 2] */}
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-slate-700">
          <li>
            a seafarer who fails to hold a certificate, an appropriate certificate, a valid dispensation, or
            proof that an endorsement application was submitted;
          </li>
          <li>failure to comply with the flag state&apos;s safe manning requirement;</li>
          <li>navigational or engineering watch arrangements that do not meet the flag&apos;s requirements;</li>
          <li>
            nobody in the watch qualified to operate equipment essential to safe navigation, safety radio
            communications or pollution prevention;
          </li>
          <li>inability to provide rested, fit persons for the first watch and the relieving watches.</li>
        </ol>
        {/* [src:paris-mou:PSCC57/2024/05 s3.3 items 1-5, quoted in substance] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Its worked examples on the documentation side: a CoC not available or with a serious discrepancy;
          no GMDSS radio operator certificate or endorsement in the watch; missing documentation for
          personnel with designated safety, security or environmental duties; expired certificates,
          including expired medicals; and evidence that a certificate was fraudulently obtained or that
          the holder is not the person it was issued to.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s3.3 examples 3-7 - seafarers' documentation] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Everything short of that is a deficiency to rectify, usually before departure. The instruction
          gives the example of a missing or expired recognition endorsement: the officer considers whether
          the ship still meets the flag&apos;s safe manning with the remaining certificated crew, and the
          finding may be rectified before departure or detention may be applied. Before detaining, the
          officer weighs the length and nature of the voyage, whether the deficiency endangers anyone,
          whether rest periods can be kept, the ship&apos;s size and type, and the cargo.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s2.1 para 17 (rectified before departure or detention may be applied) and s3.4 para 2 (factors before detaining)] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          So a missing endorsement on a third officer with a fully manned bridge before a short coastal leg
          reads differently from the same gap on the only GMDSS holder before an ocean crossing. Same code,
          different outcome.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">How to prepare a crew file that passes</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-slate-700">
          <li>
            Verify every CoC, CoP and endorsement against the issuing register before the seafarer travels,
            and keep the timestamped result with the file. Docka does this live for eight flag-state
            registers and records each answer at the trust level the check reached.
          </li>
          {/* [src:real-features:8 flag-state live-auto registers; timestamped results; L0-L3 trust ladder] */}
          <li>
            Check the endorsement against the CoC: same holder, same capacity wording, expiry not beyond
            the CoC.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 paras 10 and 14 - endorsement expiry never beyond the certificate; capacity in terms identical to safe manning requirements] */}
          <li>
            Map the crew list to the MSMD by capacity, not by name, and confirm every capacity on the MSMD
            has a holder with the right certificate and endorsement.
          </li>
          <li>
            Put originals on board. Electronic originals are acceptable under the Paris MoU instruction;
            office scans are not the original.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 para 15 - original certificates and endorsements on board, may be in an electronic format] */}
          <li>
            Confirm medicals are valid for the whole voyage, or know the grace rule of the issuing flag. The
            UK ENG 1 allows work until the next port where it can be replaced, or up to 3 months after
            expiry, whichever is sooner.
          </li>
          {/* [src:mca-eng1:gov.uk seafarer-medical-certificates - expired during a voyage: next port of call or up to 3 months, whichever is sooner] */}
          <li>
            If a recognition endorsement is pending, carry the confirmation of receipt of application, and
            know that the flag can permit no more than three months of service on it.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 para 16 - not exceeding three months; confirmation of receipt of application] */}
        </ol>
        <p className="mt-4 leading-relaxed text-slate-700">
          What Docka does not do: it does not talk to the inspector, it does not read your MSMD, and it
          cannot verify a certificate whose flag publishes no register. What it does is give the master a
          printable dossier with every register answer and its timestamp, which is the document an
          inspector wants to see when the question is &quot;is this certificate real&quot;.
        </p>
        {/* [src:real-features:printable inspection dossier with timestamped registry results] */}

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
            <Link href="/resources/required-stcw-documents-by-rank" className={LINK}>
              Which STCW documents a crewing agency should hold on file, by rank
            </Link>
          </li>
          <li>
            <Link href="/resources/stcw-certificate-types" className={LINK}>
              CoC, CoP, endorsement, GMDSS and medical: what each STCW document proves
            </Link>
          </li>
          <li>
            <Link href="/resources/spot-forged-recycled-seafarer-certificate" className={LINK}>
              How to spot a forged or recycled seafarer certificate
            </Link>
          </li>
          <li>
            <Link href="/resources/check-stcw-certificate-valid" className={LINK}>
              How to check if an STCW certificate is still valid
            </Link>
          </li>
        </ul>
      </article>
    </div>
  );
}
