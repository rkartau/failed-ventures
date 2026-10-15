import type { Metadata } from "next";
import Link from "next/link";
import { abs, articleWebPageJsonLd, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { LevelTable } from "@/components/LevelTable";
import { RegistryPortalLink } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { REGISTRY_PUBLIC_ROWS, registryPagePath } from "@/lib/registry/public-rows";

// PUBLIC, INDEXABLE long-form article (SEO Phase 2b; revised by the SEO implementation
// plan WP-D, D3). Server component. This is the PILLAR guide and the canonical home of the
// trust ladder: the full table renders once here via <LevelTable /> (from TRUST_LADDER,
// the plainPunct'd projection of LEVEL_META); every other public page carries one line and a
// link. The honesty framing (no "we verify 26 registries!" overcount, existence vs validity,
// PSV abbreviation collision) is preserved. The "what each register asks for" table is
// derived from lib/registry/public-rows.ts (never from COUNTRIES directly, never `notes`).
// Copy follows docs/WRITING-STYLE-GUIDE.md. Route is under /resources; canonical self.
const TITLE = "How Seafarer Certificate Verification Actually Works";
// First published (git: the page's first commit); dateModified is the maintained constant.
const DATE_PUBLISHED = "2026-09-04";
const DESCRIPTION =
  "How STCW seafarer certificate verification works: primary-source checks against flag-state registers, existence versus validity, and the L0 to L3 trust levels.";
const PATH = "/resources/how-seafarer-certificate-verification-works";
const OG_ALT =
  "A scanned seafarer Certificate of Competency beside a laptop showing a flag-state register lookup, illustrating a primary-source verification check.";

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
    { name: "How seafarer certificate verification works", path: PATH },
  ],
  PATH
);

// Article: author + publisher reference the ONE sitewide Organization node emitted by the
// root layout (abs("/#organization")). No named person is invented. STATIC maintained dates
// (see @/lib/seo), never build-time new Date().
const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "How seafarer certificate verification actually works",
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

// The registers Docka queries automatically: the flag-state registers plus the Bulgarian
// existence check and the Ukrainian training-centre validator. Derived from the public
// projection; the country cell links the per-registry page where one exists.
const AUTO_ROWS = REGISTRY_PUBLIC_ROWS.filter(
  (r) => r.capability === "auto" || r.capability === "auto-presence"
);
const CHECK_TYPE: Record<string, string> = {
  auto: "Live automatic",
  "auto-presence": "Document-existence check",
  assisted: "Assisted, you complete it on the portal",
  manual: "Manual, by request",
};

// FAQ: the ONE source of truth for BOTH the visible <dl data-faq-q> and the FAQPage JSON-LD
// (the parity test asserts set-equality). Each answer adds a fact that is not in the body.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "What does primary source verification of a seafarer certificate mean?",
    a: "It means the certificate is checked against the record held by the authority that issued it, not against the document in your hand. For an Estonian certificate that record is Transpordiamet's Seafarers Information System; for a British one it is the Maritime and Coastguard Agency's register. A copy of the certificate, however good, is never the primary source.",
  },
  {
    q: "What is the difference between registry-confirmed and government-verified?",
    a: "Registry-confirmed (L2) means a register says the document exists; the holder has not been tied to it. Government-verified (L3) means the issuing flag state's own register confirmed the certificate. In Docka the Bulgarian existence check and the Ukrainian training-centre validator stop at L2; only a flag-state register can produce L3.",
  },
  {
    q: "Why can't every flag state register be checked automatically?",
    a: "Because the authorities differ. Some publish a form that answers a query straight away. Others put a CAPTCHA or a legal-requester declaration in front of the form, which a machine must not pass on someone else's behalf. A few have no public lookup at all and confirm by email or to vetted accounts. Docka automates the first group, opens and pre-fills the form for the second, and treats the third as a request.",
  },
  {
    q: "What does a not-found result mean?",
    a: "Exactly what the register said, and no more. A forged certificate comes back not found because it was never recorded. A genuine certificate can also come back not found when the register's searchable coverage starts after the issue date, as with the Ukrainian state register, whose quick search reliably covers documents issued 2023 and later. Docka reports the register's answer and the coverage limit together; it does not turn a not-found into a verdict.",
  },
  {
    q: "Does Docka keep the details it sends to a register?",
    a: "Docka stores the certificate number and the result with a timestamp. A sensitive lookup input, such as the Bulgarian personal number (EGN), is sent to the authority for that single lookup and is not stored.",
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

export default function VerificationArticlePage() {
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
          <Link href="/resources" className={LINK}>
            Resources
          </Link>{" "}
          / Guide
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          How seafarer certificate verification actually works
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          Verification means asking the authority that issued a certificate whether it is on its
          records. Nothing else counts. A scanned Certificate of Competency looks reassuringly official:
          stamp, signature, a QR code in the corner. None of that proves anything. A stamp can be copied.
          A PDF can be edited. An expiry date can be typed to say whatever someone wants it to say.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          Real verification does not read the document. It goes back to the authority that issued it and
          asks.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Primary-source verification, in plain words</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The term for this is <strong>primary-source verification</strong>. The &quot;primary
          source&quot; is the maritime authority that issued the certificate: Transpordiamet in Estonia,
          the Maritime and Coastguard Agency in the United Kingdom, and so on. The certificate is a copy;
          the authority&apos;s register is the original. Verification means checking the copy against the
          original. There is a{" "}
          <Link href="/what-is-primary-source-verification" className={LINK}>
            longer definition of primary source verification
          </Link>{" "}
          on its own page.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          That is a different thing from what a lot of &quot;verification&quot; is in practice, which is:
          someone looks at the PDF, decides it looks fine, and files it. That is not verification. It is a
          second opinion on a photo.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          The honest version has a hard rule behind it: never re-type what a document says and call the
          result verified. If the check did not reach the issuing authority&apos;s own records, it did
          not verify anything.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">
          Why some registers can be checked automatically and others can&apos;t
        </h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Here is the part nobody enjoys explaining: maritime authorities are not consistent. Every flag
          state runs its own register, on its own system, with its own rules about who is allowed to
          look. That is the reality any verification tool has to work with, and pretending otherwise is
          where overselling starts.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">In practice, countries fall into a few honest tiers.</p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Live automatic checks.</strong> Some authorities publish a verification service that
          answers a query straight away. You give it a certificate number (and often a date of birth or
          holder name), and it tells you whether that certificate is on its records. These are the ones
          you can check in seconds. Docka runs live automatic checks against eight flag-state registers:
          Estonia, Denmark, Cyprus, the United Kingdom, Norway, France, Ukraine&apos;s state register and
          Azerbaijan.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Existence checks, not validity checks.</strong> This distinction matters more than it
          sounds. Some registers confirm that a document <em>exists</em> on file without telling you it
          is currently <em>valid</em>. Bulgaria is the clear example: Docka can confirm automatically that
          a Bulgarian document exists in the official register (for certificates issued 2017 and later),
          but that is a presence check, not a validity verdict. &quot;It&apos;s on file&quot; and
          &quot;it&apos;s valid right now&quot; are not the same sentence, and an honest tool never lets
          one masquerade as the other.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Assisted checks.</strong> Many official portals sit behind a step a machine is not
          allowed to pass: a CAPTCHA, or a declaration that the requester has a legal reason to look. You
          cannot automate those without either breaking the authority&apos;s rules or attesting to a
          legal declaration on someone else&apos;s behalf, and a responsible tool does neither. The
          honest thing is to take the user straight to the correct official form, pre-fill what it can,
          and let a person finish the check. That is help, not a verdict, and it should be labelled as
          help.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Manual and vetted access.</strong> A few authorities have no public lookup at all.
          Access is granted only to registered, vetted accounts, or confirmation happens by email. Here
          &quot;verification&quot; is a request with a turnaround time, not an instant answer.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          The temptation is to flatten all of this into one big number (&quot;we verify 26
          registries!&quot;) and hope nobody reads the footnote. But a number that lumps a live
          government check together with an email you have to send yourself is not describing a
          capability. It is describing a wish. The count that matters is the one you can stand behind.
          The full list by tier, with the authority behind each one, is on the{" "}
          <Link href="/registries" className={LINK}>
            registry coverage page
          </Link>
          .
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What each live register asks for</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          A register can only answer the question it was built to answer, and each one keys the lookup on
          different fields printed on the certificate. The table lists the registers Docka queries
          automatically, the fields each one takes, and the authority&apos;s own portal, so you can run
          the same check by hand. The labels are Docka&apos;s; the fields are the portal&apos;s.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm text-slate-700" data-testid="inputs-table">
            <thead>
              <tr className="border-b border-slate-300 text-left align-bottom text-slate-900">
                <th className="py-2 pr-4 font-semibold">Register</th>
                <th className="py-2 pr-4 font-semibold">Authority</th>
                <th className="py-2 pr-4 font-semibold">Fields the lookup needs</th>
                <th className="py-2 font-semibold">Check type</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {AUTO_ROWS.map((r) => {
                const page = registryPagePath(r.code);
                return (
                  <tr key={r.code} className="border-b border-slate-100">
                    <td className="py-2 pr-4 font-semibold text-slate-900">
                      {page ? (
                        <Link href={page} className={LINK}>
                          {r.country}
                        </Link>
                      ) : (
                        r.country
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {r.authority}.{" "}
                      <RegistryPortalLink portalUrl={r.portalUrl} className={LINK} />
                    </td>
                    <td className="py-2 pr-4">{r.inputs.join("; ")}</td>
                    <td className="py-2">
                      {CHECK_TYPE[r.capability]}
                      {r.userNotes ? <span className="block text-xs text-slate-500">{r.userNotes}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h2 className="mt-10 text-xl font-bold text-slate-900">A worked example: one Danish certificate, start to finish</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          A crewing desk receives a scanned Danish Certificate of Competency for a second engineer joining
          next month. The person at the desk reads the certificate number from the document, selects
          Denmark, and pastes the number. Docka sends that number to the Danish Maritime Authority&apos;s
          verification service, the same service a person reaches at verify.dma.dk. Nothing from the PDF
          is trusted at this point; the PDF only supplied the number to look up.
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          The register answers. Whatever it says is recorded as the result, with the time of the query,
          and the document is labelled at the level the check reached: a flag-state confirmation is L3,
          a register that only confirmed existence would be L2, and a number the register does not
          recognise earns no level at all. The desk sees the register&apos;s answer, the timestamp and
          the level. It never sees a Docka opinion about whether the scan looked genuine, because Docka
          does not form one. If the register cannot be reached, the result is marked inconclusive; an
          outage is not a fail.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">A note on the &quot;PSV&quot; abbreviation</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          If you research this topic you will run into the initials PSV. In credentialing they stand for{" "}
          <strong>primary source verification</strong>, the checking method described above. In shipping
          the same three letters mean <strong>platform supply vessel</strong>, a type of ship. Same
          letters, unrelated meanings. This article means the checking method, and spelling it out avoids
          the collision.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">
          The trust levels: saying exactly how much you confirmed
        </h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Because the checks differ in strength, the results have to differ in strength too. A tool that
          stamps everything &quot;verified&quot; is lying by rounding up. Docka labels every document
          with one of four levels, so a compliance officer sees a green tick and <em>what kind</em> of
          green tick it is. This table is the definition the whole product uses; the other pages on this
          site link here instead of copying it.
        </p>
        <LevelTable />
        <p className="mt-4 leading-relaxed text-slate-700">
          The ladder is not decoration. L1 means a human reviewer opened the actual document and
          confirmed it, which is worth recording and is still not a registry check. The gap between L2 and
          L3 is the gap between &quot;this document exists somewhere&quot; and &quot;this authority
          confirms this document&quot;, and that gap is exactly where forged and recycled certificates get
          caught.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the Convention says about fraud</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The problem is old enough to be written into the treaty. The{" "}
          <a
            href="https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx"
            target="_blank"
            rel="noopener noreferrer"
            className={LINK}
          >
            IMO&apos;s page on the STCW Convention
          </a>{" "}
          records that the 2010 Manila amendments introduced &quot;improved measures to prevent
          fraudulent practices associated with certificates of competency&quot;, alongside the
          five-yearly refresher training for basic safety, advanced fire fighting and survival craft
          proficiencies. The same page lists the Convention&apos;s chapters, from chapter I (general
          provisions, which carries the certification and revalidation rules) to chapter VIII
          (watchkeeping).
        </p>
        <p className="mt-3 leading-relaxed text-slate-700">
          Docka does not restate the regulation text, and it does not decide whether a seafarer meets a
          manning requirement. What it does is the part the treaty assumes someone will do: ask the
          issuing administration whether the certificate is real and current. The register lookups
          described on this page are how an agency acts on the fraud measures in practice.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">Why an agency should care</h2>
        <p className="mt-3 leading-relaxed text-slate-700">For a crewing agency, the payoff is not abstract.</p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Forged and duplicated certificates.</strong> A convincing fake passes a human eye. It
          does not pass the issuing register, because it was never in it. A primary-source check is the
          point where a forgery stops being your problem before a seafarer boards.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Lapsed STCW documents.</strong> An expiry date printed on a PDF is a claim, not a fact.
          Checking the live record, and hard-blocking a seafarer the moment a required certificate lapses,
          is how you avoid discovering the lapse during a port state inspection instead of before it.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          <strong>Defensible records.</strong> When every document carries an honest level, an audit is a
          matter of showing your work. &quot;L3, confirmed against the issuing register&quot; is a
          sentence you can stand behind. &quot;It looked fine&quot; is not.
        </p>

        <h2 className="mt-10 text-xl font-bold text-slate-900">The short version</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Verification worth the name checks a certificate against the authority that issued it, not
          against a nicer copy of the certificate. Where a register answers automatically, you get a live
          check in seconds. Where it only confirms existence, you should be told exactly that. Where it
          cannot be automated at all, the honest move is to say so and point you at the official source.
          And every result should carry a label that admits how far the check got, because a compliance
          record you can defend is built from what you confirmed, not from what the PDF claimed.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          Docka is built by Docka Development OÜ (Tallinn, Estonia). The{" "}
          <Link href="/about" className={LINK}>
            about page
          </Link>{" "}
          has the company details; the{" "}
          <Link href="/registries" className={LINK}>
            registry coverage page
          </Link>{" "}
          has the current list of registers by tier.
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
            <Link href="/resources/spot-forged-recycled-seafarer-certificate" className={LINK}>
              Spot a forged or recycled seafarer certificate
            </Link>
          </li>
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
            <Link href="/overview/agencies" className={LINK}>
              How Docka works for crewing agencies
            </Link>
          </li>
          <li>
            <Link href="/pricing" className={LINK}>
              Agency pricing
            </Link>
          </li>
        </ul>
      </article>
    </div>
  );
}
