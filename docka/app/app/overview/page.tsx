import type { Metadata } from "next";
import Link from "next/link";
import {
  CONTENT_LAST_UPDATED_ISO,
  breadcrumbList,
  jsonLd,
  plainPunct,
  webPageJsonLd,
} from "@/lib/seo";
// Relative import on purpose: the Node route harness (tests/_route-harness.mjs, used by
// tests/seo-phase2a.test.mjs to render this page) resolves `@/components/*` to .tsx only,
// and overviewData is a .ts data module. Same module the two tour pages import via the alias.
import { AGENCY_SECTIONS, SEAFARER_SECTIONS } from "../../components/overview/overviewData";
import {
  AUTO_FLAG_STATE_COUNT,
  PRESENCE_ONLY_COUNTRIES,
  countryDisplayName,
  joinNames,
} from "@/lib/registry/display";
import { LEVEL_META, type VerificationLevel } from "@/lib/verification-level";

// Public "features overview" hub (SEO plan v3 C7). No auth, no data fetching: a plain
// server component. It links to the two audience tours, carries a "Docka in one page"
// summary (>= 400 words, every count derived from the registry table / LEVEL_META, never
// hand-typed) and a feature matrix <table> whose rows are the section headings of the
// two tours (overviewData.ts). middleware only gates /admin, so /overview is public.

// Plain title so the root `%s · Docka` template appends the brand ONCE (SEO A4: no
// title.absolute, no in-string "Docka" that would double-brand).
const TITLE = "Seafarer Management System and Crewing CRM Features";
const DESCRIPTION =
  "The whole seafarer management system on one page: the crewing agency CRM the desk works in, and the free account a seafarer keeps.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/overview" },
  openGraph: {
    type: "website",
    url: "/overview",
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

// ONE BreadcrumbList for this URL; selfPath gives it the "#breadcrumb" @id that the
// WebPage node below references (plan R12).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Overview", path: "/overview" },
  ],
  "/overview"
);

const WEBPAGE_JSONLD = webPageJsonLd({
  path: "/overview",
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

// Feature-title clean-up at the data boundary (style guide: no dashes as dashes). The
// one range in the data ("L0–L3") reads as "L0 to L3", everything else goes through
// plainPunct so the rendered table has no typographic punctuation.
function cleanTitle(s: string): string {
  return plainPunct(s.replace(/L0\s*[–—-]\s*L3/g, "L0 to L3"));
}

type MatrixRow = { area: string; agencies: string | null; seafarers: string | null };

// Rows = the section headings of the two tours, in tour order; the owning column lists
// that section's feature titles. Derived at module load from overviewData.ts, so a
// feature added to a tour appears here without a second edit.
const MATRIX_ROWS: MatrixRow[] = [
  ...AGENCY_SECTIONS.map((s) => ({
    area: plainPunct(s.heading),
    agencies: s.features.map((f) => cleanTitle(f.title)).join(", "),
    seafarers: null,
  })),
  ...SEAFARER_SECTIONS.map((s) => ({
    area: plainPunct(s.heading),
    agencies: null,
    seafarers: s.features.map((f) => cleanTitle(f.title)).join(", "),
  })),
];

const LEVELS: VerificationLevel[] = [0, 1, 2, 3];

const linkClass =
  "font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500";

// The card is a <div>; only the heading and the CTA are links (plan C7), each with a
// short descriptive anchor (<= 60 characters) instead of the whole card body.
function ChooserCard({
  href,
  eyebrow,
  title,
  body,
  cta,
}: {
  href: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <div
      className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="overview-chooser-card"
    >
      <span className="inline-block w-fit rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">
        {eyebrow}
      </span>
      <h2 className="mt-4 text-xl font-bold text-slate-900">
        <Link href={href} className="hover:text-brand-700">
          {title}
        </Link>
      </h2>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{body}</p>
      <Link
        href={href}
        className="mt-4 inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-brand-700 hover:gap-2"
      >
        {cta} <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

const thClass = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600";
const tdClass = "px-3 py-2 align-top text-sm text-slate-700";

export default function OverviewChooser() {
  const presenceNames = joinNames(
    PRESENCE_ONLY_COUNTRIES.map((c) => countryDisplayName(c.country, "en", c.countryName)),
    "en"
  );

  return (
    <div className="hero-bg">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(WEBPAGE_JSONLD) }} />

      <section className="mx-auto max-w-6xl px-4 pb-8 pt-14 sm:pt-20">
        <p className="inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          Features overview
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Everything Docka does today, on one page. Pick your side.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Two guided tours of the live product: one for the crewing agency that manages crew,
          one for the seafarer who owns the certificates. Every graph on the tours is
          illustrative and runs in your browser. No sign-in, and none of your data is involved.
        </p>

        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          <ChooserCard
            href="/overview/agencies"
            eyebrow="For crewing agencies"
            title="One verified view of every crew member"
            body="Live government verification, a 5-stage pipeline, compliance hard-blocks, and the external surfaces that keep your clients coming through you."
            cta="See the agency tour"
          />
          <ChooserCard
            href="/overview/seafarers"
            eyebrow="For seafarers"
            title="Your certificates, and you decide who sees them"
            body="Upload once by photo, verify against the source, get renewal reminders, and share with the agencies you choose, in control on any phone."
            cta="See the seafarer tour"
          />
        </div>
      </section>

      {/* Docka in one page (plan C7: >= 400 words; counts derived, never typed). */}
      <section className="mx-auto max-w-6xl px-4 py-8" data-testid="overview-summary">
        <h2 className="text-2xl font-bold text-slate-900">Docka in one page</h2>
        <div className="mt-4 max-w-3xl space-y-4 text-base leading-relaxed text-slate-700">
          <p>
            Docka is a CRM for crewing agencies, and the primary source verification (PSV)
            check is what the roster is built on. A certificate is a copy. The issuing
            authority&apos;s register is the original record.
            Docka checks the certificate number against that register instead of reading the
            PDF, and labels the answer with how far the check reached. Today the check is live
            and automatic for {AUTO_FLAG_STATE_COUNT} flag states. For {presenceNames} the check
            confirms only that the document exists, which is not a validity verdict. For every
            other country Docka opens the official portal, fills in the fields it can read from
            the document, and a person completes the check there. Coverage limits per register
            (issue-year thresholds, for example) are stated on the{" "}
            <Link href="/registries" className={linkClass}>
              registry coverage page
            </Link>
            , straight from the same table the verifier uses.
          </p>
          <p>
            Every document on Docka carries one of four trust levels. The level is derived
            from the check that produced it and is never rounded up in prose or on a badge, so
            a compliance officer sees which kind of check stands behind each green mark, and a
            seafarer sees exactly what a port state control inspector will see.
          </p>
          <ul className="list-disc space-y-1 pl-5" data-testid="overview-trust-levels">
            {LEVELS.map((l) => (
              <li key={l}>
                <span className="font-semibold text-slate-900">
                  {LEVEL_META[l].code} {plainPunct(LEVEL_META[l].word)}
                </span>
                : {plainPunct(LEVEL_META[l].tip)}
              </li>
            ))}
          </ul>
          <p>
            Crewing agencies get a board. It holds the crew list in a five-stage pipeline, the
            required-document set for each rank, a hard block on any seafarer whose required
            certificate has lapsed, duplicate-person and forgery signals, and read-only surfaces
            for the shipowners the agency serves. Seafarers get a profile. They add each
            certificate by photo once, Docka verifies the ones from supported registers against
            the official record, reminders go out before an expiry date, and the seafarer decides
            which agencies see what. The seafarer profile is free. Agencies pay a monthly licence
            plus a fee per billable seafarer; the current figures are on the{" "}
            <Link href="/pricing" className={linkClass}>
              pricing page
            </Link>
            .
          </p>
          <p>
            What Docka does not do: it cannot verify a certificate whose flag state has no public
            register or no machine connection, it cannot confirm a holder&apos;s identity from a
            document-existence lookup, and it never re-types a PDF and calls the result
            verified. Where a check stops short, the label says so.
          </p>
          <p>
            Where to start. If you have a certificate in front of you, the{" "}
            <Link href="/verify" className={linkClass}>
              certificate verifier
            </Link>{" "}
            answers in one step. If you want to see the product with data in it, the{" "}
            <Link href="/sample/agency" className={linkClass}>
              sample agency board
            </Link>{" "}
            and the{" "}
            <Link href="/sample/seafarer" className={linkClass}>
              sample seafarer profile
            </Link>{" "}
            are live, read-only and built on fictional records. If you run a crewing desk,{" "}
            <Link href="/book" className={linkClass}>
              book a 20-minute call
            </Link>{" "}
            and we will walk through your own roster. To read how a register check works end
            to end, see{" "}
            <Link href="/resources/how-seafarer-certificate-verification-works" className={linkClass}>
              how seafarer certificate verification works
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Feature matrix: rows from the two tours' section headings (overviewData.ts). */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-4" data-testid="overview-feature-matrix">
        <h2 className="text-2xl font-bold text-slate-900">Feature matrix</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Each row is a section of one of the two tours; the cell lists the features that are
          live in the product today under that heading. Open the tour for the detail behind
          each item.
        </p>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className={thClass}>
                  Area
                </th>
                <th scope="col" className={thClass}>
                  Crewing agencies
                </th>
                <th scope="col" className={thClass}>
                  Seafarers
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {MATRIX_ROWS.map((row) => (
                <tr key={row.area}>
                  <th scope="row" className={`${tdClass} whitespace-nowrap font-semibold text-slate-900`}>
                    {row.area}
                  </th>
                  <td className={tdClass}>
                    {row.agencies ?? <span className="text-slate-500">Seafarer side only</span>}
                  </td>
                  <td className={tdClass}>
                    {row.seafarers ?? <span className="text-slate-500">Agency side only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-slate-600">
          <Link href="/overview/agencies" className={linkClass}>
            Open the agency tour
          </Link>{" "}
          or{" "}
          <Link href="/overview/seafarers" className={linkClass}>
            open the seafarer tour
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
