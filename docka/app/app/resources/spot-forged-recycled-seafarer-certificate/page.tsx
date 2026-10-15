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
// committed fabrication test can gate every quantitative/forgery claim against the
// claim->source artifact (docs/seo-tier1-claims-sources.md). Article author/publisher point
// at the sitewide Organization node (@id); no individual author is invented. The trust ladder
// is ONE line derived from TRUST_LADDER (lib/verification-level.ts) plus a link to the pillar
// guide, which carries the full table; the "what each register asks for" table lives ONLY on
// the pillar and /registries (content dedupe, 2026-09-07), so this page links the per-register
// pages from the ONE code -> slug map instead. Nothing about a register is re-typed here.
// Copy follows docs/WRITING-STYLE-GUIDE.md. Route is under /resources; canonical self.
const TITLE = "Spot a Forged or Recycled Seafarer Certificate"; // [src:real-features:a forgery passes a human eye but not the issuing registry]
// First published (git: the page's first commit); dateModified is the maintained constant.
const DATE_PUBLISHED = "2026-09-04";
const DESCRIPTION =
  // [src:real-features:a forgery passes a human eye but not the issuing registry] [src:pillar:primary-source verification checks the copy against the authority's register]
  "A forged Certificate of Competency passes a human eye but not the issuing register. How forged and recycled certificates are caught by a register check.";
const PATH = "/resources/spot-forged-recycled-seafarer-certificate";
const OG_ALT =
  "A seafarer Certificate of Competency held up to the light next to a laptop showing an official flag-state registry lookup, illustrating a primary-source verification check.";

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

// Article: author + publisher reference the ONE sitewide Organization node (@id). STATIC
// maintained dates (see @/lib/seo), never build-time new Date().
const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  // [src:real-features:a forgery passes a human eye but not the issuing registry]
  headline: "Spot a forged or recycled seafarer certificate",
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

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Resources", path: "/resources" },
    // [src:real-features:a forgery passes a human eye but not the issuing registry]
    { name: "Spot a forged or recycled seafarer certificate", path: PATH },
  ],
  PATH
);

// The per-register pages, from the ONE code -> slug map (never a hand-typed href list), and
// the Norwegian row whose portal the worked example names.
// [src:lib-registry-countries:REGISTRY_PAGE_SLUGS; NO portalUrl]
const REGISTRY_PAGE_LINKS = Object.keys(REGISTRY_PAGE_SLUGS).flatMap((code) => {
  const href = registryPagePath(code);
  const name = registryRow(code)?.country;
  return href && name ? [{ code, href, name }] : [];
});
// [src:lib-registry-countries:NO is a public registry row; a missing row is a build-time data error]
function publicRow(code: string) {
  const row = registryRow(code);
  if (!row) throw new Error(`spot-forged-recycled-seafarer-certificate: no public registry row for ${code}`);
  return row;
}
const NO_ROW = publicRow("NO");

// One line for the ladder: its two ends, from the projection (the pillar has the table).
// [src:real-features:L0-L3 ladder from lib/verification-level.ts TRUST_LADDER]
const LADDER_FIRST = TRUST_LADDER[0];
const LADDER_LAST = TRUST_LADDER[TRUST_LADDER.length - 1];

// FAQ: the ONE source of truth for BOTH the visible <dl> and the FAQPage JSON-LD, so the
// two can never drift (the committed parity test asserts set-equality). Plain-text answers
// (React escapes them). Each answer's factual claim is sourced by the adjacent comment.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "How can you tell if a seafarer certificate is fake?",
    // [src:real-features:a forgery passes a human eye but not the issuing registry] [src:pillar:primary-source verification checks the copy against the authority's register]
    a: "You generally cannot tell by inspecting it. A forged certificate can carry the correct stamp, layout and even a QR code and still pass a human eye. The reliable test is primary-source verification: checking the certificate number against the issuing maritime authority's own register, where a forgery has no matching record.",
  },
  {
    q: "What is a recycled seafarer certificate?",
    // [src:real-features:cross-seafarer duplicate certificate-number detection]
    a: "It is a real, genuinely issued certificate number reused on a document that belongs to a different person. Because the number is real, a single register lookup can pass it. It is caught by cross-referencing the same number across seafarers, so a duplicate certificate-number check flags when one number is attached to more than one holder.",
  },
  {
    q: "How do I verify a seafarer certificate of competency (CoC)?",
    // [src:verifiable-registries-truth.md:SAFE CLAIMS - 8 flag-state live-auto + assisted deep-link]
    a: "Check it against the flag state's official register, not against the PDF. Docka runs live automatic checks against eight flag-state registers (Estonia, Denmark, Cyprus, the United Kingdom, Norway, France, Ukraine's state register and Azerbaijan) and takes you to the official portal for countries where the check must be completed by a person.",
  },
  {
    q: "Can you verify a Ukrainian seafarer's CoC?",
    // [src:verifiable-registries-truth.md:Ukraine state registry auto, 2023+ coverage caveat]
    a: "Yes. Docka runs a live automatic check against Ukraine's state maritime register. Coverage is reliable for documents issued 2023 and later; a not-found result on an older document is inconclusive, not a definite fail.",
  },
  {
    q: "Can you verify an Azerbaijani seafarer certificate?",
    // [src:verifiable-registries-truth.md:Azerbaijan auto, live automatic verification]
    a: "Yes. Azerbaijan, through the State Maritime and Port Agency, is one of the eight flag-state registers Docka checks live and automatically.",
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

export default function ForgedCertificateArticlePage() {
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
          Spot a forged or recycled seafarer certificate
        </h1>
        {/* [src:real-features:a forgery passes a human eye but not the issuing registry] */}
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          You cannot spot a good forgery by looking at it; you spot it by asking the register that should
          hold it. A forged Certificate of Competency or STCW endorsement can carry the right stamp, the
          right layout, a plausible signature, even a QR code, and pass a careful human eye without
          raising a flag. The document looks correct because it was made to look correct. Reading it
          harder does not help.
        </p>
        {/* [src:real-features:a forgery passes a human eye but not the issuing registry] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          There are two problems hiding inside one word. A <strong>forged</strong> certificate is one
          that was never issued by the authority whose name is on it. A <strong>recycled</strong>{" "}
          certificate is trickier: it is a real certificate number that exists in a register, reused on a
          document that belongs to a different person. One is an invention. The other is a theft. Both
          survive a visual review, and both fail the same test.
        </p>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Why your eyes are the wrong tool</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Every signal a person uses to judge a certificate (the stamp, the paper, the font, the
          hologram, the QR code) is a property of the copy in front of you. A forger controls all of
          them. That is why &quot;it looked fine&quot; is not a verification method; it is a second
          opinion on a photo.
        </p>
        {/* [src:real-features:a forgery passes a human eye but not the issuing registry] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          The one thing a forger cannot control is the issuing authority&apos;s own register. A forged
          certificate was never entered there, so a check against the register comes back with nothing to
          match. The forgery does not fail because it looks wrong. It fails because the original it claims
          to copy does not exist.
        </p>
        {/* [src:real-features:a forgery passes a human eye but not the issuing registry] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">
          The recycled certificate: a real number on the wrong person
        </h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Recycling is the case that catches people out, because there is a genuine record behind it.
          Someone takes a certificate number that really was issued, often lifted from a real
          seafarer&apos;s document, and prints it onto a credential for somebody else. Check that number
          against the register and it may well come back valid. The number is real. The pairing is not.
        </p>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          This is where cross-referencing across many seafarers matters. Docka flags when the same
          certificate number turns up attached to more than one person: a cross-seafarer duplicate
          certificate-number check. A single lookup can be fooled by a recycled number. A system that has
          seen that number before, on someone else, is not. The duplicate is the tell.
        </p>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">A worked example: the same number twice</h2>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection] [src:lib-registry-countries:NO inputs "Certificate number" + "Date of birth"] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          An agency holds forty Norwegian deck officers. A new applicant sends a scanned certificate of
          competency, and the desk runs the usual check: certificate number and date of birth go to the
          Norwegian Maritime Authority&apos;s verification service at{" "}
          <RegistryPortalLink portalUrl={NO_ROW.portalUrl} className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500" />
          , the answer comes back and is stored with a timestamp. So far this is the standard
          flag-state check, and on its own it says nothing
          about recycling, because the register is asked about a number, not about a person.
        </p>
        {/* [src:real-features:timestamped registry result] [src:lib-registry-countries:NO authority Sjøfartsdirektoratet; portal verify.certificate.sdir.no] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The second step is the one that matters here. Docka compares the new certificate number with
          every certificate number already on file across the agency&apos;s seafarers. If the same number
          already sits on another person&apos;s profile, both documents are flagged for the desk to look
          at. Nobody is accused at this point; two people cannot both hold the same certificate, so
          one of the two documents needs the administration&apos;s attention. The process ends with a
          question for the issuing authority, not with a verdict from Docka.
        </p>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection flags the same number on more than one person] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">
          The only reliable check: go back to the register
        </h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The term for doing this properly is <strong>primary-source verification</strong>, spelled out,
          because the bare initials PSV also mean &quot;platform supply vessel&quot; in shipping and the
          collision causes real confusion. Primary-source verification means you do not trust the copy.
          You go back to the maritime authority that issued the certificate, the primary source, and ask
          its own register whether the document is really there.
        </p>
        {/* [src:real-features:PSV = primary source verification, collides with Platform Supply Vessel] [src:pillar:primary-source verification checks the copy against the authority's register] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          For some flag states this happens live, in seconds. Docka runs live automatic checks against
          eight flag-state registers: Estonia, Denmark, Cyprus, the United Kingdom, Norway, France,
          Ukraine&apos;s state register, and Azerbaijan.
        </p>
        {/* [src:verifiable-registries-truth.md:SAFE CLAIMS - 8 flag-state live-auto: Estonia, Denmark, Cyprus, UK, Norway, France, Ukraine state, Azerbaijan] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          Bulgaria is different again: the automatic check only confirms that a document issued in 2017
          or later <em>exists</em> in the official register, a presence check and never a validity
          verdict. Everywhere else the check is assisted; Docka opens the correct official portal,
          pre-fills what it can, and a person completes it.
        </p>
        {/* [src:verifiable-registries-truth.md:Bulgaria auto-presence, confirms document exists 2017+, never validity] [src:verifiable-registries-truth.md:assisted - deep-link + prefill, user completes on official portal] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          The eight are not equally deep, and a forgery check has to know that. Cyprus is a live
          connection to the ministry&apos;s own form, so read a confirmation as the form&apos;s answer
          rather than a verdict Docka is vouching for. Ukraine&apos;s state register reliably covers
          documents issued from 2023; a not-found on an older document is a question for the
          administration, not a forgery finding.
        </p>
        {/* [src:verifiable-registries-truth.md:Cyprus soft caveat - live connection, not a guaranteed verdict] [src:verifiable-registries-truth.md:Ukraine state registry 2023+ coverage caveat] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          A forger can print any number, so the check is only as good as the register you send it to.
          Every register Docka queries automatically, the fields each one keys the lookup on and the
          authority&apos;s own portal are tabulated in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            how seafarer certificate verification actually works
          </Link>
          ; the{" "}
          <Link href="/registries" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            registry coverage page
          </Link>{" "}
          sorts all of them by tier. The live registers have pages of their own:{" "}
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
        {/* [src:lib-registry-countries:the inputs table lives on the pillar guide and /registries; per-register pages from REGISTRY_PAGE_SLUGS] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          One warning that belongs next to any portal link: some websites imitate real maritime
          authorities and will happily &quot;confirm&quot; anything you type. Use the portal linked from
          the register&apos;s own page, or the administration&apos;s own domain, never a search result.
          Docka only talks to each authority&apos;s pinned official domain and shows a warning for the
          impostor domains it knows about.
        </p>
        {/* [src:lib-registry-countries:userNotes carry the fake-domain warnings; portalUrl is the pinned official domain] [src:real-features:Docka talks only to pinned official domains] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">Reading the result honestly</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          A register check that reaches the issuing authority is worth more than one that does not, so the
          result has to say which kind it was. Every document in Docka carries one of four levels,{" "}
          {LADDER_FIRST.code} {LADDER_FIRST.name} at the bottom and {LADDER_LAST.code}{" "}
          {LADDER_LAST.name} at the top;{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            how seafarer certificate verification actually works
          </Link>{" "}
          defines each one.
        </p>
        {/* [src:real-features:L0-L3 ladder from lib/verification-level.ts TRUST_LADDER; the pillar guide carries the canonical LevelTable] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          The gap between L2 and L3 is exactly where a recycled certificate lives. &quot;This number
          exists&quot; is L2. &quot;This authority confirms this document for this holder&quot; is L3. A
          forgery cannot reach L2, because the record was never there. A recycled number can reach L2 on
          its own, which is why the duplicate check matters, and why the level label refuses to round a
          maybe up to a yes.
        </p>
        {/* [src:real-features:L0-L3 ladder] [src:real-features:cross-seafarer duplicate certificate-number detection] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the Convention says about it</h2>
        {/* [src:stcw-convention:Manila 2010 amendments - improved measures to prevent fraudulent practices associated with certificates of competency; 1978 Convention in force 28 April 1984] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Certificate fraud is not a new worry. The{" "}
          <a href="https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx" target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
            IMO&apos;s page on the STCW Convention
          </a>{" "}
          {/* [src:stcw-convention:"Improved measures to prevent fraudulent practices associated with certificates of competency"; "The 1978 STCW Convention entered into force on 28 April 1984"] */}
          records that the 2010 Manila amendments introduced &quot;improved measures to prevent
          fraudulent practices associated with certificates of competency&quot;, for a treaty that has
          been in force since 28 April 1984. The measures work through the administrations: each one
          keeps the register of what it has issued, and that register is what a port state inspector, a
          flag state or a crewing agency asks when a certificate is in doubt.
        </p>
        {/* [src:stcw-convention:Manila 2010 - improved measures to prevent fraudulent practices associated with certificates of competency] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Docka does not judge whether a document is fraudulent. It puts the question to the register
          that can answer it and records the answer at the level the check reached. The judgement, if one
          is needed, belongs to the administration that issued the certificate.
        </p>
        {/* [src:real-features:Docka reports the register's answer at the level reached; never a Docka verdict] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What this means for a crewing desk</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Neither the forgery nor the recycled number survives two checks run together: the certificate
          against the register that issued it, and the number against every other seafarer you hold. The
          forged document has no original to match. The recycled one matches an original that belongs to
          someone else.
        </p>
        {/* [src:real-features:a forgery passes a human eye but not the issuing registry] [src:real-features:cross-seafarer duplicate certificate-number detection] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          Run both, record both, and the desk has an answer it can show an inspector: this number, this
          register, this time, this level, and no second holder on file.
        </p>
        {/* [src:real-features:timestamped registry result; L0-L3 level label; cross-seafarer duplicate certificate-number detection] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          A few habits make the routine harder to game. Ask for the certificate as a scan of the
          original, not a photograph of a photocopy, because a recycled number is usually pasted
          onto a low-resolution image where the edit hides. Compare the holder&apos;s name and birth date
          on the certificate with the passport before you send anything to a register, since a mismatch
          there is cheaper to catch than a mismatch in the ministry&apos;s reply. Log who ran each lookup
          and when, so an auditor can retrace the decision months later. And when a duplicate does
          surface, suspend the placement quietly and write to the administration; an accusation at the
          gangway helps nobody, and the register will settle it.
        </p>
        {/* [src:real-features:cross-seafarer duplicate certificate-number detection; timestamped result; the judgement belongs to the issuing administration] */}

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
            <Link href="/resources/check-stcw-certificate-valid" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              How to check if an STCW certificate is still valid
            </Link>
          </li>
          <li>
            <Link href="/resources/port-state-control-crew-certificate-deficiencies" className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
              Port State Control and crew certificates: what inspectors check
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
