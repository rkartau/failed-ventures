import type { Metadata } from "next";
import Link from "next/link";
import { abs, articleWebPageJsonLd, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink, portalHostname } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { registryRow } from "@/lib/registry/public-rows";

// PUBLIC, INDEXABLE guide (SEO implementation plan WP-E, G3). Server component. Every
// sentence with a digit or a hotword carries an adjacent `[src:<id>:...]` code comment; the
// ids resolve to docs/seo-new-pages-claims-sources.md ("## Guides"). Copy follows
// docs/WRITING-STYLE-GUIDE.md. Route under /resources; canonical self.
const TITLE = "STCW Certificate Types: CoC, CoP and Endorsement";
// First published: the day the page went live on docka.me; dateModified is the maintained constant.
// [src:real-features:shipped in the 2026-09-07 deploy (docka.me/version.txt 79d707a)]
const DATE_PUBLISHED = "2026-09-07";
const DESCRIPTION =
  "CoC, CoP, flag state endorsement, GMDSS certificate and ENG 1 medical: what each STCW document proves, who issues it, and how to verify it.";
const PATH = "/resources/stcw-certificate-types";
const OG_ALT =
  "Five seafarer documents side by side: a certificate of competency, a certificate of proficiency, a flag state endorsement, a GMDSS radio certificate and a medical certificate, each labelled with its issuing authority.";

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
    { name: "STCW certificate types", path: PATH },
  ],
  PATH
);

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "Certificate of competency, certificate of proficiency, endorsement: what each STCW document proves",
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

// The four registers the CoC section names, from the public projection (portal URLs are never
// hand-typed); linked in the Sources list.
// [src:real-features:UK, Denmark, Norway, Estonia are among the eight live-auto flag-state registers Docka queries]
const SOURCE_PORTALS = ["UK", "DK", "NO", "EE"].flatMap((code) => {
  const r = registryRow(code);
  return r ? [r] : [];
});

// FAQ: the ONE source for both the visible <dl> and the FAQPage JSON-LD.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Is a certificate of proficiency the same as a certificate of competency?",
    a: "No. A certificate of competency (CoC) entitles the holder to serve in a named capacity, such as chief mate or second engineer. A certificate of proficiency (CoP) confirms completion of a specific training, such as basic safety training or advanced fire fighting. An officer holds one CoC and several CoPs; a rating usually holds CoPs only.",
  },
  {
    q: "Does a flag state endorsement expire when the CoC expires?",
    // [src:paris-mou:PSCC57/2024/05 para 10 - endorsement expires as soon as the certificate endorsed expires or is suspended, cancelled or withdrawn]
    a: "Yes, at the same moment. Paris MoU inspection guidance states that an endorsement expires as soon as the certificate it endorses expires or is suspended, cancelled or withdrawn. A separately issued endorsement also carries its own expiry date, which may not run past the CoC.",
  },
  {
    q: "Can Docka verify a certificate issued by a training centre?",
    // [src:real-features:Docka checks flag-state registers; assisted portal deep-link for the rest]
    a: "Only when the flag state records that certificate in the register it publishes. Docka checks flag-state registers, not training-centre databases. A CoP that appears nowhere in the administration's register has to be confirmed with the centre that printed it, and Docka will show it as unverified until you do.",
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

export default function StcwCertificateTypesPage() {
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
          Certificate of competency, certificate of proficiency, endorsement: what each STCW document proves
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          A certificate of competency (CoC) proves a seafarer may serve in a rank. A certificate of
          proficiency (CoP) proves they completed a specific training. A flag state endorsement proves
          that a particular flag accepts the CoC for service on its ships. The GMDSS radio certificate
          and the medical certificate prove something narrower still.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          Below: what each document is, who issues it, and how you check it.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Certificate of competency (CoC)</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          A CoC is issued by a flag state administration under chapters II (deck), III (engine) and IV
          (radio) of the STCW Convention, which was adopted in 1978 and has been in force since 1984.
        </p>
        {/* [src:stcw-convention:IMO STCW page - adopted 7 July 1978, entry into force 28 April 1984; chapters II master and deck, III engine, IV radiocommunication] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          It names the capacity the holder may serve in (master, chief mate, officer in charge of a
          navigational watch, chief engineer and so on) and any limitations, such as tonnage or trading
          area. It carries a unique number and a date of expiry.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 paras 9-10 - CoCs assigned a unique number and include a date of expiry] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Who issues it: the administration whose examination the seafarer passed. The Maritime and
          Coastguard Agency (MCA) in the United Kingdom, Søfartsstyrelsen (the Danish Maritime Authority),
          Sjøfartsdirektoratet (the Norwegian Maritime Authority) and Transpordiamet (the Estonian Transport
          Administration) all issue CoCs, and all four run a public register for them.
        </p>
        {/* [src:real-features:UK, Denmark, Norway, Estonia are among the eight live-auto flag-state registers Docka queries] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          How it is verified: against that register, by certificate number and usually the holder&apos;s
          date of birth. The paper is a copy; the register is the record. Docka runs this check live and
          automatically for eight flag states and takes you to the official portal for the rest.
        </p>
        {/* [src:real-features:8 flag-state live-auto registers + assisted portal deep-link for the rest] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          What Docka cannot do is confirm a CoC from an administration with no online register. There,
          the check is an email to the administration, and it takes days.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Certificate of proficiency (CoP)</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          A CoP proves completion of a specific training or a specific competence, not the right to hold a
          rank. The common ones are basic safety training (STCW Code section A-VI/1), proficiency in
          survival craft and rescue boats (A-VI/2), advanced fire fighting (A-VI/3), medical first aid and
          medical care (A-VI/4), security training (A-VI/6), and the tanker cargo certificates under
          chapter V.
        </p>
        {/* [src:stcw-convention:chapter VI emergency, occupational safety, security, medical care and survival functions; chapter V special training for certain ship types] [src:paris-mou:PSCC57/2024/05 s3.2 cites STCW regs VI/1, VI/1.2, VI/3, VI/4 and VI/6; V/1-1 and V/1-2 tanker CoPs] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Who issues it: either the administration itself or a training centre it has approved, acting
          under the administration&apos;s authority. This is where verification gets uneven. A CoP that
          the administration issued or recorded appears in its register. A CoP printed by a training
          centre often does not. Paris MoU guidance to inspectors also notes that a CoP does not have to
          carry an expiry date, although many do.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 footnote 2 - certificates of proficiency and documentary evidence do not have to have an expiry date but may do so] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          How it is verified: check the flag state register first. If the CoP is not there, ask the
          training centre directly, and ask the administration whether that centre is on its approved
          list. We think a CoP that no register and no centre will confirm should be treated as
          unverified, whatever the paper looks like.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Flag state endorsement</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          An endorsement is a flag state&apos;s statement about a CoC, and there are two kinds. An
          endorsement attesting issue is added by the administration that issued the CoC (STCW Article VI
          and regulation I/2). An endorsement attesting recognition is issued by a different flag state
          under regulation I/10 when it accepts a foreign CoC for service on its ships.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 paras 5-7, 12 - Article VI endorsement in the form of reg I/2; recognition endorsement under reg I/10] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The second kind is what people usually mean by &quot;flag state endorsement&quot;. It is what a
          Cypriot, Liberian or Panamanian ship needs before a Danish-certificated officer can sign on.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          The endorsement can be printed on the CoC itself or issued as a separate document. A separately
          issued endorsement must carry its own expiry date, which cannot be more than five years from
          issue and can never run past the expiry of the CoC it endorses. An endorsement expires the
          moment the underlying CoC expires or is suspended, cancelled or withdrawn.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 paras 6-7, 10 - incorporated or separate; separate endorsement expiry not more than 5 years and never beyond the certificate; expires with the certificate] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          So &quot;the endorsement is still valid&quot; says nothing on its own. Check the CoC first.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          While a recognition endorsement is being processed, a flag state may let the seafarer serve for
          up to three months on documentary proof that the application was submitted. Inspectors call
          this the confirmation of receipt of application (CRA).
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 para 16 - serve for a period not exceeding three months while the application is processed; confirmation of receipt of application] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Verify an endorsement against the register of the flag that issued the endorsement, not the flag
          that issued the CoC. Those are two different registers.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">GMDSS radio certificates</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The general operator&apos;s certificate (GOC) and restricted operator&apos;s certificate (ROC)
          come under chapter IV of the Convention and are issued by the administration, in some countries
          through its telecoms regulator, not its maritime authority.
        </p>
        {/* [src:stcw-convention:chapter IV radiocommunication and radio operators] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          On most ships the deck officers hold the GOC, so the radio certificate is checked alongside the
          CoC. A watch with no certificated GMDSS radio operator is one of the worked examples of a
          detainable deficiency in Paris MoU inspection guidance.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 s3.3 example 4 - absence in watch of a radio operator (general/restricted GMDSS); certificates and endorsement not available] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Verification follows the CoC path: number and holder against the issuing body&apos;s register.
          Where a different body issued the radio certificate, expect a second register, or none.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Medical certificate</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The medical fitness certificate is required by STCW regulation I/9 and is issued by a doctor the
          administration has approved, not by the administration itself.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 para 19 and s3.3 example 6 - valid medical certificate; STCW reg I/9.6 and I/9.7] [src:mca-eng1:ENG 1 must be issued by a doctor approved by the MCA] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          In the United Kingdom that is the ENG 1, issued by an MCA-approved doctor, with a maximum
          examination fee of 115 GBP. If it expires during a voyage, the seafarer may keep working until
          the next port where it can be replaced, or for up to 3 months after expiry, whichever is sooner.
        </p>
        {/* [src:mca-eng1:gov.uk seafarer-medical-certificates - maximum fee for an ENG 1 medical examination is 115 GBP; expired during a voyage: next port of call or up to 3 months, whichever is sooner] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Verification is the weak spot of the whole set. Medical certificates are rarely in a public
          register, so the check is with the issuing doctor or against the administration&apos;s published
          list of approved doctors. Docka records the medical and its expiry and reminds you before it
          lapses. It does not verify a medical against a register unless the flag state publishes one.
        </p>
        {/* [src:real-features:expiry reminders; registry checks only where a flag-state register exists] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">The confusions we see most</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-slate-700">
          <li>
            &quot;STCW certificate&quot; used to mean the basic safety training CoP. There is no single STCW
            certificate. A seafarer holds a CoC, several CoPs and often an endorsement, all under STCW.
          </li>
          <li>
            An endorsement filed as if it were the CoC. It only says a flag accepts the CoC; without the
            CoC register check, nothing has been verified.
          </li>
          <li>
            A valid-looking endorsement on an expired CoC: impossible by rule, so nobody checked the
            endorsement against the CoC.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 para 10 - endorsement expires as soon as the certificate endorsed expires] */}
          <li>
            The GMDSS certificate assumed to be part of the deck CoC. It is a separate document with its own
            number and often its own register.
          </li>
          <li>The medical treated as verified because the PDF looks right. Call the doctor.</li>
        </ul>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Who issues what, and where to check</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left align-bottom">
                <th className="py-2 pr-4 font-semibold text-slate-900">Document</th>
                <th className="py-2 pr-4 font-semibold text-slate-900">Issued by</th>
                <th className="py-2 font-semibold text-slate-900">Where to check</th>
              </tr>
            </thead>
            <tbody className="align-top text-slate-700">
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-4 font-semibold">Certificate of competency</td>
                <td className="py-2 pr-4">Flag state administration</td>
                <td className="py-2">The administration&apos;s register, by number and date of birth</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-4 font-semibold">Certificate of proficiency</td>
                <td className="py-2 pr-4">Administration or an approved training centre</td>
                <td className="py-2">The register if recorded there; otherwise the centre</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-4 font-semibold">Endorsement (recognition)</td>
                <td className="py-2 pr-4">The recognising flag state</td>
                <td className="py-2">That flag state&apos;s register, not the CoC issuer&apos;s</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-4 font-semibold">GMDSS GOC or ROC</td>
                <td className="py-2 pr-4">Administration or its telecoms regulator</td>
                <td className="py-2">The issuing body&apos;s register, where one exists</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-semibold">Medical (ENG 1 and equivalents)</td>
                <td className="py-2 pr-4">A doctor approved by the administration</td>
                <td className="py-2">The issuing doctor; the approved-doctor list</td>
              </tr>
              {/* [src:mca-eng1:ENG 1 issued by an MCA-approved doctor; approved doctor lists updated monthly] */}
            </tbody>
          </table>
        </div>

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
            , chapters, 1978 adoption, 1984 entry into force.
          </li>
          {/* [src:stcw-convention:adopted 7 July 1978; entry into force 28 April 1984; chapters II, III, IV, V, VI] */}
          <li>
            <a href="https://www.parismou.org/pscc-instructions/" target="_blank" rel="noopener noreferrer" className={LINK}>
              Paris MoU: PSCC instruction 57/2024/05
            </a>
            , endorsement and expiry rules.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 paras 5-12, 16, 19; footnote 2] */}
          <li>
            <a href="https://www.gov.uk/seafarer-medical-certificates" target="_blank" rel="noopener noreferrer" className={LINK}>
              GOV.UK: seafarer medical certificates
            </a>
            , the ENG 1 rules.
          </li>
          {/* [src:mca-eng1:gov.uk seafarer-medical-certificates - ENG 1 issued by an MCA-approved doctor; maximum fee; expired during a voyage] */}
          <li>
            Registers named above:{" "}
            {SOURCE_PORTALS.map((r, i) => (
              <span key={r.code}>
                {i > 0 ? ", " : ""}
                {r.country} (<RegistryPortalLink portalUrl={r.portalUrl} label={portalHostname(r.portalUrl)} className={LINK} />)
              </span>
            ))}
            .
          </li>
          {/* [src:real-features:UK, Denmark, Norway, Estonia are among the eight live-auto flag-state registers Docka queries; portal URLs come from the public registry rows, never hand-typed] */}
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
            <Link href="/resources/required-stcw-documents-by-rank" className={LINK}>
              Which STCW documents a crewing agency should hold on file, by rank
            </Link>
          </li>
          <li>
            <Link href="/resources/stcw-revalidation-every-5-years" className={LINK}>
              STCW revalidation every five years: what expires and what needs a refresher
            </Link>
          </li>
          <li>
            <Link href="/resources/check-stcw-certificate-valid" className={LINK}>
              How to check if an STCW certificate is still valid
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
