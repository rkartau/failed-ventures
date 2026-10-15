import type { Metadata } from "next";
import Link from "next/link";
import { abs, breadcrumbList, jsonLd, webPageJsonLd, CONTENT_LAST_UPDATED_ISO } from "@/lib/seo";
import { LastUpdated } from "@/components/LastUpdated";
import { RegistryPortalLink } from "@/components/RegistryPortalLink";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import {
  REGISTRY_PUBLIC_ROWS,
  REGISTRY_PAGE_SLUGS,
  registryPagePath,
  registryRow,
  type RegistryPublicRow,
} from "@/lib/registry/public-rows";

// PUBLIC, INDEXABLE registry-coverage hub (SEO Phase 2b; revised by the SEO implementation
// plan WP-D, D4). Server component. Lists Docka's coverage by the SAME capability tiers the
// product uses (Live automatic / Document-existence / Assisted / Manual). Every authority
// name, portal link, input label and caveat is derived from lib/registry/public-rows.ts at
// render time (never from COUNTRIES directly, never the dev `notes` field), so this page can
// never drift from what the code does. Copy follows docs/WRITING-STYLE-GUIDE.md.
// Route is /registries (canonical self); spokes are the eight /registries/<slug> pages.
// Title carries no inline "Docka" (the root `%s · Docka` template appends it once).
const TITLE = "Seafarer Certificate Registries We Verify";
const DESCRIPTION =
  "Docka checks some flag-state registries live for crewing agencies. Others return a document-existence answer only, and the rest are assisted or manual.";
const PATH = "/registries";
const LIVE_LIST_ID = `${abs(PATH)}#live-list`;

const LINK =
  "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    url: PATH,
    title: TITLE,
    description: DESCRIPTION,
    images: ["/opengraph-image.jpg"],
  },
  twitter: { title: TITLE, description: DESCRIPTION, images: ["/twitter-image.jpg"] },
};

// The eight LIVE-automatic flag states = exactly the codes that have a public registry page
// (REGISTRY_PAGE_SLUGS is that set; the Ukrainian training-centre validator has none).
const LIVE_ROWS: RegistryPublicRow[] = Object.keys(REGISTRY_PAGE_SLUGS)
  .map((code) => registryRow(code))
  .filter((r): r is RegistryPublicRow => r !== undefined);
const PRESENCE_ROWS = REGISTRY_PUBLIC_ROWS.filter((r) => r.capability === "auto-presence");
const ASSISTED_ROWS = REGISTRY_PUBLIC_ROWS.filter((r) => r.capability === "assisted");
const MANUAL_ROWS = REGISTRY_PUBLIC_ROWS.filter((r) => r.capability === "manual");
const CHECK_TYPE: Record<string, string> = {
  auto: "Live automatic",
  "auto-presence": "Document-existence check",
  assisted: "Assisted, you complete it on the portal",
  manual: "Manual, by request",
};
const shortName = (r: RegistryPublicRow) => r.authorityShort ?? r.authority;

const breadcrumbJsonLd = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Registries", path: PATH },
  ],
  PATH
);

// CollectionPage built on the shared WebPage shape (@id #webpage, isPartOf the WebSite node,
// breadcrumb @id), typed as CollectionPage, with the live-state ItemList as its mainEntity.
const collectionJsonLd = {
  ...webPageJsonLd({ path: PATH, name: "Seafarer certificate registries Docka verifies", description: DESCRIPTION, dateModified: CONTENT_LAST_UPDATED_ISO }),
  "@type": "CollectionPage",
  publisher: { "@id": abs("/#organization") },
  mainEntity: { "@id": LIVE_LIST_ID },
};

// ItemList enumerating the eight live-automatic flag states, each pointing at its own
// registry page. Its OWN JSON-LD block (not folded into the CollectionPage, not a
// BreadcrumbList); reuses LIVE_ROWS, no second hardcoded list.
const itemListJsonLd = {
  "@context": "https://schema.org",
  "@type": "ItemList",
  "@id": LIVE_LIST_ID,
  name: "Flag-state registries Docka verifies live and automatically",
  itemListOrder: "https://schema.org/ItemListUnordered",
  numberOfItems: LIVE_ROWS.length,
  itemListElement: LIVE_ROWS.map((r, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: r.country,
    url: abs(registryPagePath(r.code)!),
  })),
};

// FAQ seeded from the real GSC queries (seafarer certificate verification, azerbaijan seafarer
// verification, ukraine coc verification, coc checker) plus the Latvia question. The ONE source
// of truth for BOTH the visible <dl> and the FAQPage JSON-LD (parity test). The Latvia answer
// is composed from the public row so no authority name or input label is hand-typed.
const LV = registryRow("LV");
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "How do I verify a seafarer certificate?",
    a: "Check the certificate against the issuing flag state's official register, not against the PDF. Docka runs live automatic checks against eight flag-state registers and, for countries whose portals cannot be automated, opens the official form and pre-fills what it can so you complete the check there.",
  },
  {
    q: "How do I verify an Azerbaijan seafarer certificate?",
    a: "Azerbaijan is a live-automatic flag state. Docka queries the State Maritime and Port Agency (DDLA) verification service directly using the certificate number and the holder's date of birth, so an Azerbaijani certificate can reach a government-verified result.",
  },
  {
    q: "How do I verify a Ukraine Certificate of Competency (CoC)?",
    a: "Docka runs a live automatic check against Ukraine's state maritime register. Coverage is reliable for documents issued 2023 and later; a not-found result on an older document is inconclusive, not a definite fail.",
  },
  {
    q: "Does Docka support Latvia?",
    a: LV
      ? `Yes, as an assisted check. The portal of the ${LV.authority} asks for the ${LV.inputs.join(" and the ")}. Docka opens that official form with the fields it can fill already entered, and you complete the check on the authority's site; the answer you read there is the portal's, not a Docka verdict.`
      : "Yes, as an assisted check: Docka opens the Maritime Administration of Latvia's official form and you complete the check there.",
  },
  {
    q: "Is there a free seafarer certificate (CoC) checker?",
    a: "Yes, for the seafarer. A seafarer holds and checks their own certificates in Docka at no cost. An agency pays a licence of 300 EUR a month plus 2 EUR for each billable seafarer; the pricing page has the detail.",
  },
  {
    q: "Does 'verified' mean the same thing for every country?",
    a: "No, and Docka never pretends it does. A live government check, a document-existence check, an assisted check you complete yourself, and a manual request are different capabilities. Each result is labelled with the trust level it reached, from L0 (Self-uploaded, not yet verified) to L3 (Government-verified).",
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

export default function RegistriesHubPage() {
  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(collectionJsonLd) }}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(itemListJsonLd) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          Registry coverage
        </p>
        <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          Seafarer certificate registries Docka verifies
        </h1>
        <LastUpdated />
        <p className="mt-5 text-lg leading-relaxed text-slate-700">
          Docka checks seafarer certificates live against the official registers of eight flag states,
          confirms that a Bulgarian document exists, and for every other country takes you to the
          authority&apos;s own portal. Maritime authorities are not consistent about what they let an
          outsider check, so this page groups the coverage into capability tiers and never blurs the
          lines between them. A live government check and an email you have to send yourself are not the
          same capability.
        </p>
        <p className="mt-4 leading-relaxed text-slate-700">
          Every check on this page is{" "}
          <Link href="/what-is-primary-source-verification" className={LINK}>
            primary source verification
          </Link>
          : the certificate is checked against the record of the authority that issued it, not against
          the PDF. The method behind the tiers is in{" "}
          <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
            how seafarer certificate verification actually works
          </Link>
          . To run a check now, go to{" "}
          <Link href="/verify" className={LINK}>
            verify a seafarer certificate
          </Link>
          .
        </p>

        <WhatDockaIs heading="h2" />

        {/* Tier 1: Live automatic (flag-state validity) */}
        <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Live automatic verification</h2>
          <p className="mt-1 text-sm text-slate-500">Flag-state validity, reachable to L3, Government-verified</p>
          <p className="mt-3 leading-relaxed text-slate-700">
            For these eight flag states, Docka connects to the authority&apos;s official verification
            service and returns a result automatically. Each country name opens a page on that register:
            what it asks for, how to run the same check by hand, and where the coverage stops.
          </p>
          <ul className="mt-4 space-y-2 text-slate-700">
            {LIVE_ROWS.map((r) => (
              <li key={r.code}>
                <Link href={registryPagePath(r.code)!} className="font-semibold text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">
                  {r.country}
                </Link>
                : {r.authority}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            Two caveats within this tier. For <strong>Cyprus</strong>, Docka connects live to the register
            and reports what it returns: a live check against the register, not a guaranteed positive
            verdict. For the <strong>Ukraine state register</strong>, the quick search reliably covers
            documents issued 2023 and later; a &quot;not found&quot; on an older document is inconclusive,
            not a verdict.
          </p>
        </section>

        {/* Tier 2: Presence only */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Document-existence check</h2>
          <p className="mt-1 text-sm text-slate-500">Presence only, not a validity verdict</p>
          <ul className="mt-3 space-y-2 text-slate-700">
            {PRESENCE_ROWS.map((r) => (
              <li key={r.code}>
                <span className="font-semibold text-slate-900">{r.country}</span>: {r.authority}. Docka can
                automatically confirm that a document <strong>exists</strong> in the official register.
                This is a presence check, not a validity verdict: it tells you the document is on file, not
                that it is currently valid.{r.userNotes ? ` ${r.userNotes}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            Bulgaria is the only register in this tier today.
          </p>
        </section>

        {/* Tier 3: Assisted */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Assisted checks</h2>
          <p className="mt-1 text-sm text-slate-500">You complete the official check</p>
          <p className="mt-3 leading-relaxed text-slate-700">
            For these countries the official portal requires a step that cannot be automated, typically a
            CAPTCHA or a legal-requester declaration. Docka takes you to the correct official form and
            pre-fills the fields it can, and you complete the check on the authority&apos;s own site. This
            is not a Docka verdict; it is help getting to the right place quickly.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-slate-700">
            {ASSISTED_ROWS.map((r) => (
              <li key={r.code}>
                <span className="font-semibold text-slate-900">{r.country}</span>: {shortName(r)},{" "}
                <RegistryPortalLink portalUrl={r.portalUrl} className={LINK} />
              </li>
            ))}
          </ul>
        </section>

        {/* Tier 4: Manual / vetted access */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Manual, vetted-access verification</h2>
          <p className="mt-1 text-sm text-slate-500">By request</p>
          <p className="mt-3 leading-relaxed text-slate-700">
            For these countries there is no public lookup tool: access is granted only to vetted accounts,
            or confirmation happens by email. Verification is handled as a request, and we do not quote a
            turnaround time because it is the authority&apos;s, not ours.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-slate-700">
            {MANUAL_ROWS.map((r) => (
              <li key={r.code}>
                <span className="font-semibold text-slate-900">{r.country}</span>: {shortName(r)},{" "}
                <RegistryPortalLink portalUrl={r.portalUrl} className={LINK} />
                {r.userNotes ? <span className="block text-xs text-slate-500">{r.userNotes}</span> : null}
              </li>
            ))}
          </ul>
        </section>

        {/* The full table: every public register, derived from the projection at render time. */}
        <h2 className="mt-12 text-xl font-bold text-slate-900">Every register, what it asks for, and the caveats</h2>
        <p className="mt-3 leading-relaxed text-slate-700">
          The table is generated from the same registry table the product runs on, so it changes when the
          code does and not before. Country names link to the per-register page where one exists; the
          portal link goes to the authority&apos;s own site.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm text-slate-700" data-testid="registry-table">
            <thead>
              <tr className="border-b border-slate-300 text-left align-bottom text-slate-900">
                <th className="py-2 pr-4 font-semibold">Flag state</th>
                <th className="py-2 pr-4 font-semibold">Authority</th>
                <th className="py-2 pr-4 font-semibold">Check type</th>
                <th className="py-2 pr-4 font-semibold">Fields the lookup needs</th>
                <th className="py-2 font-semibold">Caveat</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {REGISTRY_PUBLIC_ROWS.map((r) => {
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
                    <td className="py-2 pr-4">{CHECK_TYPE[r.capability]}</td>
                    <td className="py-2 pr-4">{r.inputs.join("; ")}</td>
                    <td className="py-2 text-xs text-slate-600">{r.userNotes ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* FAQ (visible), mirrored by the FAQPage JSON-LD above. */}
        <h2 className="mt-12 text-xl font-bold text-slate-900">Frequently asked questions</h2>
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

        {/* Hub-and-spoke internal links (descriptive anchors). */}
        <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-bold text-slate-900">Per-registry guides and next steps</h2>
          <ul className="mt-3 space-y-2 text-slate-700">
            <li>
              <Link href="/registries/azerbaijan" className={LINK}>
                Verify an Azerbaijan seafarer certificate (DDLA)
              </Link>
            </li>
            <li>
              <Link href="/registries/ukraine" className={LINK}>
                Verify a Ukraine seafarer certificate (Certificate of Competency)
              </Link>
            </li>
            <li>
              <Link href="/verify" className={LINK}>
                Verify a seafarer certificate against its flag-state registry
              </Link>
            </li>
            <li>
              <Link href="/resources/how-seafarer-certificate-verification-works" className={LINK}>
                Read how seafarer certificate verification actually works
              </Link>
            </li>
            <li>
              <Link href="/overview/agencies" className={LINK}>
                See how Docka works for crewing agencies
              </Link>
            </li>
            <li>
              <Link href="/pricing" className={LINK}>
                Review agency pricing
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
