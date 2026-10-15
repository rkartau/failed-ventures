// SINGLE registry of every INDEXABLE public URL on docka.me (SEO implementation plan
// WP-E, E1). `app/sitemap.ts` and `app/llms.txt/route.ts` are pure projections of this
// array, so a page can never be in one and missing from the other, and the inverse test
// in tests/seo-new-pages-e.test.mjs fails when an indexable `app/**/page.tsx` is added
// without a row here (or a row points at a route that does not exist).
//
// `lastmod` POLICY (hand-maintained, never build-time `new Date()`):
//   - a date is bumped ONLY when the page's OWN visible copy changes;
//   - header, schema/JSON-LD, layout, nav, cache or deploy-only changes NEVER bump it
//     (crawlers discount a sitemap whose lastmod moves on every deploy);
//   - the format is the date-only string `YYYY-MM-DD` (tests/sample-pages.test.mjs pins
//     `^\d{4}-\d{2}-\d{2}$`), never an ISO timestamp.
// The sample pages keep the dates the previous hand-written sitemap carried unless their
// own visible copy moves. Every page whose visible copy changed in the 2026-09-07 round
// (the WP-E pages going live, the guide dedupe, the /verify rewrite, the privacy
// controller block, and then the positioning batch: the shared WhatDockaIs strip on
// /book, /contact and the long-tail pages, plus a CRM body sentence on /sample/seafarer)
// is dated 2026-09-07. /sample/agency changed metadata only and keeps 2026-08-18.
//
// NOT listed (by design): /terms while its metadata says `robots.index: false` (the ToS
// text still reads "draft"; E6 keeps it noindex until the owner signs it off), /signup
// (auth page), /directory (owner to decide whether public), and every private surface
// (/admin, /agent, /seafarer, /o, /u, /share, /portal, /api, /verify/<uuid>).

export type LlmsSection = "Key pages" | "Guides" | "Registries" | "Legal";

export type SitePage = {
  /** Site-relative path; "/" is the home route (rendered slash-less as SITE_URL). */
  path: string;
  /** `YYYY-MM-DD`, hand-bumped on real content edits only (see policy above). */
  lastmod: string;
  changeFrequency: "monthly" | "yearly";
  priority: number;
  /** When present the page is listed in /llms.txt under `section` with this label/blurb. */
  llms?: { section: LlmsSection; label: string; blurb?: string };
};

export const SITE_PAGES: readonly SitePage[] = Object.freeze([
  // ---- Core marketing --------------------------------------------------------------
  { path: "/", lastmod: "2026-09-07", changeFrequency: "monthly", priority: 1 },
  { path: "/overview", lastmod: "2026-09-07", changeFrequency: "monthly", priority: 0.8 },
  {
    path: "/overview/agencies",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.8,
    llms: {
      section: "Key pages",
      label: "For crewing agencies",
      blurb:
        "the crewing agency CRM: crew pipeline, required-document sets, expiry reminders, and certificates checked against the issuing registry.",
    },
  },
  {
    path: "/overview/seafarers",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.8,
    llms: {
      section: "Key pages",
      label: "For seafarers",
      blurb: "keep your certificates verified, tracked and shareable.",
    },
  },
  // Public Sample Profiles: indexable live demos on fictional data. Bump when the
  // CURATED fixture content (not its relative dates) changes.
  { path: "/sample/seafarer", lastmod: "2026-09-07", changeFrequency: "monthly", priority: 0.7 },
  { path: "/sample/agency", lastmod: "2026-08-18", changeFrequency: "monthly", priority: 0.7 },
  {
    path: "/verify",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.8,
    llms: {
      section: "Key pages",
      label: "Verify a seafarer certificate",
      blurb: "run a live primary-source check against the official flag-state registry.",
    },
  },
  {
    path: "/pricing",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.8,
    llms: {
      section: "Key pages",
      label: "Pricing",
      blurb: "flat monthly licence + a metered fee per billable seafarer, in EUR. Always free for seafarers.",
    },
  },
  // /book and /contact both gained the visible WhatDockaIs positioning strip on
  // 2026-09-07, so the policy above bumps them; a metadata-only change would not.
  { path: "/book", lastmod: "2026-09-07", changeFrequency: "monthly", priority: 0.6 },
  {
    path: "/privacy",
    lastmod: "2026-09-07",
    changeFrequency: "yearly",
    priority: 0.3,
    llms: { section: "Legal", label: "Privacy and cookies" },
  },
  {
    path: "/contact",
    lastmod: "2026-09-07",
    changeFrequency: "yearly",
    priority: 0.3,
    llms: {
      section: "Key pages",
      label: "Contact",
      blurb: "email and company/registry details.",
    },
  },
  {
    path: "/about",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Key pages", label: "About Docka", blurb: "who runs Docka and how the registry checks work." },
  },
  {
    path: "/what-is-primary-source-verification",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: {
      section: "Key pages",
      label: "What is primary source verification (PSV)?",
      blurb: "the definition, and why PSV in maritime is a registry check, not a PDF read.",
    },
  },
  // ---- Registry coverage hub + per-country spokes ---------------------------------
  {
    path: "/registries",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.7,
    llms: {
      section: "Registries",
      label: "Registry coverage",
      blurb: "which flag-state registers Docka checks live, and which are assisted.",
    },
  },
  {
    path: "/registries/estonia",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Estonia (Transpordiamet)" },
  },
  {
    path: "/registries/denmark",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Denmark (Danish Maritime Authority)" },
  },
  {
    path: "/registries/cyprus",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Cyprus (Shipping Deputy Ministry)" },
  },
  {
    path: "/registries/united-kingdom",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "United Kingdom (MCA)" },
  },
  {
    path: "/registries/norway",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Norway (Sjøfartsdirektoratet)" },
  },
  {
    path: "/registries/france",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "France (Affaires maritimes)" },
  },
  {
    path: "/registries/ukraine",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Ukraine (Maritime Administration of Ukraine)" },
  },
  {
    path: "/registries/azerbaijan",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Registries", label: "Azerbaijan (State Maritime and Port Agency)" },
  },
  // ---- Resources hub + guides ------------------------------------------------------
  {
    path: "/resources",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.5,
    llms: { section: "Guides", label: "All guides" },
  },
  {
    path: "/resources/how-seafarer-certificate-verification-works",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "How seafarer certificate verification actually works" },
  },
  {
    path: "/resources/spot-forged-recycled-seafarer-certificate",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "How to spot a forged or recycled seafarer certificate" },
  },
  {
    path: "/resources/check-stcw-certificate-valid",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "How to check if an STCW certificate is still valid" },
  },
  // WP-E2 guides (written in parallel; pre-registered here so sitemap + llms.txt list
  // them the moment the page files land).
  {
    path: "/resources/stcw-certificate-types",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "STCW certificate types explained" },
  },
  {
    path: "/resources/required-stcw-documents-by-rank",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "Required STCW documents by rank" },
  },
  {
    path: "/resources/port-state-control-crew-certificate-deficiencies",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "Port State Control crew certificate deficiencies" },
  },
  {
    path: "/resources/stcw-revalidation-every-5-years",
    lastmod: "2026-09-07",
    changeFrequency: "monthly",
    priority: 0.6,
    llms: { section: "Guides", label: "STCW revalidation every five years" },
  },
]);

/** Order in which /llms.txt prints its sections. */
export const LLMS_SECTION_ORDER: readonly LlmsSection[] = ["Key pages", "Guides", "Registries", "Legal"];

/** One row by path, or undefined. */
export function sitePage(path: string): SitePage | undefined {
  return SITE_PAGES.find((p) => p.path === path);
}
