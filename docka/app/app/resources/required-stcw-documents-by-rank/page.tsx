import type { Metadata } from "next";
import Link from "next/link";
import { abs, articleWebPageJsonLd, breadcrumbList, jsonLd, CONTENT_LAST_UPDATED_ISO, CONTENT_LAST_UPDATED_LABEL } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { PrintButton } from "@/components/PrintButton";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { BASE_REQUIRED_DOC_TYPES } from "@/lib/doctypes";
import { RANK_KEYS, RANK_LABELS, VESSEL_TYPE_KEYS, VESSEL_TYPE_LABELS, baselineAt } from "@/lib/required-docs";

// PUBLIC, INDEXABLE guide (SEO implementation plan WP-E, G4). Server component. The rank
// labels, document-set names, validity years and per-rank / per-vessel layers are READ from
// lib/doctypes.ts and lib/required-docs.ts at render time (the product's own rule engine), so
// the page can never drift from what the board shows; those statements cite
// `[src:lib-doctypes]`. Every sentence with a digit or a hotword carries an adjacent
// `[src:<id>:...]` code comment resolving to docs/seo-new-pages-claims-sources.md.
const TITLE = "STCW Documents Required by Rank: Agency Checklist";
// First published: the day the page went live on docka.me; dateModified is the maintained constant.
// [src:real-features:shipped in the 2026-09-07 deploy (docka.me/version.txt 79d707a)]
const DATE_PUBLISHED = "2026-09-07";
const DESCRIPTION =
  "Which certificates a crewing agency should hold on file for each rank (master, officers, ratings, cadets), in Docka's document set. Printable checklist.";
const PATH = "/resources/required-stcw-documents-by-rank";
const OG_ALT =
  "A printed crew document checklist listing passport, seaman's book, medical certificate, basic safety training and flag state endorsement against seven ranks from master to cadet.";

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
    { name: "Required STCW documents by rank", path: PATH },
  ],
  PATH
);

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  "@id": `${abs(PATH)}#article`,
  headline: "Which STCW documents a crewing agency should hold on file, by rank",
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

// The product's default rule set, read from the engine (not re-typed).
const BASELINE = baselineAt();
const catalogName = (slug: string) => BASELINE.catalog.find((c) => c.slug === slug)?.name ?? slug;
const catalogYears = (slug: string) => BASELINE.catalog.find((c) => c.slug === slug)?.validityYears ?? null;
const requiredFor = (rank: (typeof RANK_KEYS)[number]) =>
  new Set<string>([...BASELINE.universalRequired, ...BASELINE.perRankRequired[rank]]);
const VESSEL_ADDONS = VESSEL_TYPE_KEYS.filter((v) => BASELINE.perVesselTypeRequired[v].length > 0);
const VESSEL_NONE = VESSEL_TYPE_KEYS.filter((v) => BASELINE.perVesselTypeRequired[v].length === 0 && v !== "other");

// FAQ: the ONE source for both the visible <dl> and the FAQPage JSON-LD.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Which STCW certificates does a chief officer need on file?",
    // [src:lib-doctypes:universalRequired Passport, Seaman book, Medical, Basic Safety Training; perRankRequired chief_officer Endorsement; chemical_tanker adds Tanker Familiarisation + Advanced Fire Fighting]
    a: "In Docka's default rule set: passport, seaman's book, medical fitness certificate, STCW Basic Safety Training and the flag-state endorsement of the CoC. On a chemical tanker or gas carrier the berth adds tanker familiarisation and Advanced Fire Fighting. The CoC itself, the GMDSS certificate and the survival craft and medical first aid proficiencies sit outside the default floor and should be in the file too.",
  },
  {
    q: "Do cadets and ratings need a flag state endorsement?",
    // [src:lib-doctypes:perRankRequired rating [] and cadet [] - no Endorsement slot]
    a: "Not in Docka's default rule set. The endorsement is the flag's recognition of a certificate of competency, and cadets do not hold one. Ratings forming part of a watch hold certificates of proficiency under STCW chapter II or III; an agency that wants those tracked adds them to its own required set.",
  },
  {
    q: "What does 3/5 mean on the Docka board?",
    // [src:lib-doctypes:BASE_REQUIRED_DOC_TYPES = 5 slots: Basic Safety Training, Medical, Endorsement, Seaman book, Passport]
    a: `The seafarer has documents classified into 3 of the 5 base slots (${BASE_REQUIRED_DOC_TYPES.join(", ")}) and is missing 2. The count is about presence of a classified document, not its verification status; a slot can be filled by an unverified upload, and the trust level is shown separately.`,
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

export default function RequiredStcwDocumentsByRankPage() {
  return (
    <div className="hero-bg">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(articleJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }} />
      <article className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="text-sm text-slate-500 print:hidden">
          <Link href="/resources" className={LINK}>
            Resources
          </Link>{" "}
          / Guide
        </p>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Which STCW documents a crewing agency should hold on file, by rank
        </h1>
        <p data-testid="byline" className="mt-3 text-sm text-slate-500">
          By the Docka team · Reviewed {CONTENT_LAST_UPDATED_LABEL}
        </p>
        <LastUpdated />

        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          Every seafarer on your roster needs four documents on file: a passport, a seaman&apos;s book, a
          medical fitness certificate and STCW basic safety training. Officers need a fifth, the flag state
          endorsement of their certificate of competency. The vessel type adds more.
        </p>
        {/* [src:lib-doctypes:universalRequired = Passport, Seaman book, Medical, Basic Safety Training (4); perRankRequired officers = Endorsement (5th)] */}
        <p className="mt-4 leading-relaxed text-slate-700">
          That is the floor Docka measures every seafarer against, and it is deliberately short. Below is
          the floor, the per-rank layer on top of it, the vessel-type add-ons, and a checklist you can
          print. The document names here are read from the product&apos;s own rule engine, so what you
          read on this page is what you will see on the board.
        </p>
        {/* [src:lib-doctypes:names rendered from lib/required-docs.ts baselineAt().catalog and RANK_LABELS] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">The universal floor (every rank)</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-slate-700">
          {BASELINE.universalRequired.map((slug) => (
            <li key={slug}>
              {catalogName(slug)}
              {catalogYears(slug) ? ` (typical validity ${catalogYears(slug)} ${catalogYears(slug) === 1 ? "year" : "years"})` : ""}
            </li>
          ))}
        </ul>
        {/* [src:lib-doctypes:catalog validityYears Passport 10, Seaman book 10, Medical 1, Basic Safety Training 5] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Why these four. The passport and seaman&apos;s book are identity and travel; without them the
          seafarer cannot join or leave the ship. The medical is STCW regulation I/9. Basic safety
          training is STCW Code section A-VI/1 and applies to everyone employed on board who is assigned
          safety or pollution-prevention duties.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 paras 19-21 - valid medical certificate (reg I/9); A-VI/1 basic training for seafarers with designated safety or pollution duties] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The validity years are the norms Docka&apos;s catalogue documents, not a rule of the Convention.
          A medical from your flag may run longer than a year, and an administration may date basic
          safety training differently. Read the certificate.
        </p>
        {/* [src:lib-doctypes:CatalogEntry.validityYears is informational - "documents the norm"] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Ratings and cadets stop here. Docka&apos;s default rule set requires nothing further of them.
        </p>
        {/* [src:lib-doctypes:perRankRequired rating [] and cadet []] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What officers add: the flag state endorsement</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          {RANK_KEYS.filter((r) => BASELINE.perRankRequired[r].includes("Endorsement"))
            .map((r) => RANK_LABELS[r])
            .join(", ")}{" "}
          all add one slot: {catalogName("Endorsement")}.
        </p>
        {/* [src:lib-doctypes:perRankRequired master, chief_officer, deck_officer, chief_engineer, engineer_officer = ["Endorsement"]] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          The endorsement is the recognising flag&apos;s acceptance of the CoC under STCW regulation I/10,
          and it cannot outlive the CoC. So the file for an officer holds the CoC and the endorsement,
          both verified, with the endorsement checked against the flag that issued it. Our guide to{" "}
          <Link href="/resources/stcw-certificate-types" className={LINK}>
            STCW certificate types
          </Link>{" "}
          walks through the difference.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 paras 10-12 - recognition endorsement under reg I/10; expires with the certificate] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          A note on what &quot;on file&quot; has to mean. Paris MoU instructions to inspectors say the
          seafarer must have the original certificates and original endorsements on board, and those may be
          electronic. A scan in your office is for your check. The original travels with the seafarer.
        </p>
        {/* [src:paris-mou:PSCC57/2024/05 para 15 - originals on board, may be in an electronic format] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the ship adds: vessel-type packs</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          Docka&apos;s default rule set adds documents by vessel type on top of the rank floor:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-slate-700">
          {VESSEL_ADDONS.map((v) => (
            <li key={v}>
              {VESSEL_TYPE_LABELS[v]}: {BASELINE.perVesselTypeRequired[v].map(catalogName).join("; ")}
            </li>
          ))}
          <li>{VESSEL_NONE.map((v) => VESSEL_TYPE_LABELS[v]).join(", ")}: nothing beyond the rank floor</li>
        </ul>
        {/* [src:lib-doctypes:perVesselTypeRequired oil_tanker Tanker Familiarisation; chemical_tanker + gas_carrier Tanker Familiarisation + Advanced Fire Fighting; passenger Advanced Fire Fighting; general_cargo, container, bulk_carrier, offshore []] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          These are Docka&apos;s defaults, not the Convention&apos;s full list. Chapter V of the Convention
          sets the special training for tankers, passenger ships and other ship types, and the
          flag&apos;s minimum safe manning document decides what a given berth needs. An agency can edit
          its own required set in Docka, and the per-flag layer starts empty for the agency to fill.
        </p>
        {/* [src:stcw-convention:chapter V special training requirements for personnel on certain types of ships] [src:lib-doctypes:perFlagRequired seeded empty; per-agent config editable] */}

        <h2 className="mt-10 text-xl font-bold text-slate-900">What the default set leaves out, on purpose</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The set above is a completeness floor, not a full crew list. It does not include the CoC itself
          as a separate slot, the GMDSS radio certificate, proficiency in survival craft and rescue boats
          (A-VI/2), medical first aid (A-VI/4), security duties (A-VI/6) or a ship security officer
          certificate. Inspectors do look for these where the rank or the muster list requires them.
        </p>
        {/* [src:stcw-convention:chapter VI emergency, occupational safety, security, medical care and survival functions] [src:paris-mou:PSCC57/2024/05 s3.2 - mandatory basic or advanced training or endorsement not presented; regs VI/1, VI/3, VI/4, VI/6] [src:tokyo-mou:deficiency codes 01203 radio personnel, 01211 survival craft and rescue boat, 01210 medical first aid, 01217 ship security officer] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          We chose a short floor because a board that shows &quot;3/5&quot; is something a crewing manager
          acts on. A board with fourteen slots per person becomes wallpaper. Add the rest per agency where
          your fleet needs it.
        </p>
        {/* [src:lib-doctypes:BASE_REQUIRED_DOC_TYPES has 5 slots; the "3/5" board indicator keys off it] */}
        <p className="mt-3 leading-relaxed text-slate-700">
          Employment documents are a separate, opt-in set:{" "}
          {["SEA", "Wage Account", "Allotment", "Contract Addendum"].map(catalogName).join("; ")}. They are
          in Docka&apos;s catalogue and count against an assignment, not against the seafarer&apos;s floor.
        </p>
        {/* [src:lib-doctypes:EMPLOYMENT_DOC_TYPES SEA, Wage Account, Allotment, Contract Addendum - in catalog, in no required layer, assignment-scoped] */}

        <section aria-labelledby="checklist-heading" className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="checklist-heading" className="text-xl font-bold text-slate-900">
              Checklist by rank
            </h2>
            <PrintButton />
          </div>
          <p className="mt-3 leading-relaxed text-slate-700 print:hidden">
            Print this section or save it as a PDF. The rows are Docka&apos;s rank groups; a tick means the
            slot is required for that rank in the default rule set.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm" data-testid="rank-checklist">
              <thead>
                <tr className="border-b border-slate-300 text-left align-bottom">
                  <th className="py-2 pr-4 font-semibold text-slate-900">Rank</th>
                  {BASE_REQUIRED_DOC_TYPES.map((slug) => (
                    <th key={slug} className="py-2 pr-4 font-semibold text-slate-900">
                      {catalogName(slug)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="align-top text-slate-700">
                {RANK_KEYS.map((rank) => {
                  const req = requiredFor(rank);
                  return (
                    <tr key={rank} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-semibold">{RANK_LABELS[rank]}</td>
                      {BASE_REQUIRED_DOC_TYPES.map((slug) => (
                        <td key={slug} className="py-2 pr-4">
                          {req.has(slug) ? "Required" : "Not in default set"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* [src:lib-doctypes:rows from RANK_KEYS/RANK_LABELS; cells from universalRequired + perRankRequired] */}
          <p className="mt-3 leading-relaxed text-slate-700">
            Tanker and passenger add-ons apply per berth, so they are listed under the vessel above, not the
            rank. Tick the row, then verify each document against the register on our registry coverage
            page. A ticked box is a present document, not a verified one.
          </p>
        </section>

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
            , for chapters V and VI, the ship-type and safety training the vessel-type packs rest on.
          </li>
          {/* [src:stcw-convention:chapter V special training for certain ship types; chapter VI emergency, occupational safety, security, medical care and survival functions] */}
          <li>
            <a href="https://www.parismou.org/pscc-instructions/" target="_blank" rel="noopener noreferrer" className={LINK}>
              Paris MoU: PSCC instruction 57/2024/05
            </a>
            , for the medical certificate, basic training, endorsement and originals-on-board statements.
          </li>
          {/* [src:paris-mou:PSCC57/2024/05 paras 10-12, 15, 19-21] */}
          <li>
            <a href="https://www.tokyo-mou.org/inspections-detentions/deficiency-codes/" target="_blank" rel="noopener noreferrer" className={LINK}>
              Tokyo MoU: deficiency codes
            </a>
            , for the crew-certificate codes quoted above.
          </li>
          {/* [src:tokyo-mou:deficiency codes 01203 radio personnel, 01210 medical first aid, 01211 survival craft and rescue boat, 01217 ship security officer] */}
          <li>
            The document-set names, validity years and the per-rank and per-vessel layers are read from
            Docka&apos;s own rule engine at render time, so the page shows what the board enforces.
          </li>
          {/* [src:lib-doctypes:BASE_REQUIRED_DOC_TYPES, catalog validityYears, universalRequired, perRankRequired, perVesselTypeRequired] */}
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

        <div className="mt-8 rounded-2xl border border-brand-200 bg-brand-50 p-6 print:hidden" data-testid="guide-cta">
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

        <h2 className="mt-10 text-lg font-bold text-slate-900 print:hidden">Related guides</h2>
        <ul className="mt-3 space-y-2 text-slate-700 print:hidden">
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
            <Link href="/resources/stcw-revalidation-every-5-years" className={LINK}>
              STCW revalidation every five years: what expires and what needs a refresher
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
