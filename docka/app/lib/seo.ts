// Central SEO/site-URL helper. RUNTIME server env (NOT NEXT_PUBLIC) so the box can
// set SITE_URL without a rebuild (metadata + JSON-LD are evaluated server-side on a
// dynamic root layout). Falls back to the production apex.
//
// WP-B0 seam (SEO implementation plan v3, S1/R6): the shared registry DISPLAY exports
// live in `@/lib/registry/display.ts`; import them from there, never re-derive:
//   AUTO_REGISTRY_COUNTRIES      lib/registry/display.ts:13
//   HERO_AUTO_REGISTRY_COUNTRIES lib/registry/display.ts:59
//   TRUST_BAR_AUTHORITIES        lib/registry/display.ts:66
//   AUTO_FLAG_STATE_COUNT        lib/registry/display.ts:78
//   PRESENCE_ONLY_COUNTRIES      lib/registry/display.ts:84
// The public registry-table projection (`registryTableRows()`, `REGISTRY_PUBLIC_ROWS`,
// `REGISTRY_PAGE_SLUGS`) lives in `@/lib/registry/public-rows.ts`; the server-safe
// portal link is `@/components/RegistryPortalLink`.
export const SITE_URL = (process.env.SITE_URL ?? "https://docka.me").replace(/\/+$/, "");

/**
 * The one-line entity description of Docka. SINGLE SOURCE so the root layout's
 * <meta description>/OG, the Organization JSON-LD and /llms.txt cannot drift.
 */
export const SITE_DESCRIPTION =
  "Docka is a CRM for crewing agencies: a crew roster of the seafarers who granted the agency access, with their documents and expiry dates, required-document sets, email expiry reminders and draft employment agreements, and certificates checked live against the official flag-state registers of supported countries.";

/**
 * The <meta name="description"> for the root layout / home. Distinct from
 * SITE_DESCRIPTION (the entity sentence, which is too long for a snippet): this one is
 * kept under 160 characters so search engines render it whole. Pinned by
 * tests/seo-b0.test.mjs.
 */
export const META_DESCRIPTION =
  "Docka is a CRM for crewing agencies. Keep the crew roster, documents and expiry dates in one place, and check certificates against the issuing registry.";

/**
 * Maintained "last updated" date for the evergreen marketing/content pages. Powers BOTH
 * the visible "Last updated: …" freshness line AND the JSON-LD date fields (Article
 * datePublished/dateModified, AboutPage/CollectionPage dateModified). A STATIC hand-bumped
 * constant — NEVER build-time `new Date()`, which would falsely re-date every page on each
 * deploy and get discounted by crawlers (same rule as the sitemap LASTMOD constants).
 * `_ISO` is the machine value (schema.org date fields); `_LABEL` is the human line.
 */
export const CONTENT_LAST_UPDATED_ISO = "2026-09-07";
export const CONTENT_LAST_UPDATED_LABEL = "7 September 2026";

/**
 * The ONE "valid until" date for every schema.org Offer (plan S5): rolling "end of next
 * year" so an Offer never reads as expired; bump here when the rate card changes. Shared by
 * /pricing (all three Offers) and /overview/seafarers (the free seafarer Offer), so the
 * `#offer-seafarer-free` node is byte-identical on both pages.
 */
export const PRICE_VALID_UNTIL = "2027-12-31";

/** Absolute URL for a site-relative path (JSON-LD requires absolute URLs). */
export function abs(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Build a valid schema.org BreadcrumbList from an ordered trail of
 * `{ name, path }` crumbs. `position` is 1-based and `item` is the ABSOLUTE URL
 * (crawlers reject relative). Reused by every marketing page that needs one so the
 * shape can never drift between pages, and so each URL emits EXACTLY ONE.
 *
 * - The home crumb (`path === "/"`) is emitted as the slash-less `SITE_URL`, matching
 *   the rendered home canonical byte-for-byte (a trailing-slash variant is a second URL
 *   to a crawler).
 * - When `selfPath` is given the list carries `"@id": abs(selfPath) + "#breadcrumb"`, so
 *   the page's WebPage node (see `webPageJsonLd`) can reference it by @id instead of
 *   dangling.
 */
export function breadcrumbList(trail: Array<{ name: string; path: string }>, selfPath?: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    ...(selfPath ? { "@id": `${abs(selfPath)}#breadcrumb` } : {}),
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.path === "/" ? SITE_URL : abs(c.path),
    })),
  };
}

/**
 * The per-URL schema.org WebPage node. ONE shape for every marketing page so the
 * `@id` graph never drifts: `#webpage` for the node itself, `isPartOf` the sitewide
 * WebSite node the root layout emits (`abs("/#website")`), and, unless
 * `breadcrumbId: false`, a `breadcrumb` reference to the page's own
 * `breadcrumbList(trail, path)` (`#breadcrumb`). Pass `breadcrumbId: false` on a page
 * that emits no BreadcrumbList (the home route), otherwise the reference dangles.
 * `dateModified` is the STATIC maintained content date (CONTENT_LAST_UPDATED_ISO), never
 * build-time `new Date()`.
 */
export function webPageJsonLd({
  path,
  name,
  description,
  dateModified,
  type = "WebPage",
  breadcrumbId = true,
}: {
  path: string;
  name: string;
  description: string;
  dateModified: string;
  type?: "WebPage" | "ContactPage";
  breadcrumbId?: boolean;
}) {
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${abs(path)}#webpage`,
    url: path === "/" ? SITE_URL : abs(path),
    name,
    description,
    dateModified,
    isPartOf: { "@id": abs("/#website") },
    ...(breadcrumbId ? { breadcrumb: { "@id": `${abs(path)}#breadcrumb` } } : {}),
  };
}

/**
 * The WebPage node an Article embeds as `mainEntityOfPage` (the seven /resources guides).
 * Same fields as `webPageJsonLd` (url, name, description, dateModified, isPartOf, breadcrumb
 * by @id) so the guides carry a full page node, not a stub; the `@context` is dropped
 * because the node is nested, and the `@id` stays the bare page URL, the convention every
 * guide already uses and the schema tests pin.
 */
export function articleWebPageJsonLd(args: { path: string; name: string; description: string; dateModified: string }) {
  const { "@context": _context, ...node } = webPageJsonLd(args);
  void _context;
  return { ...node, "@id": abs(args.path) };
}

/**
 * The free seafarer-account Offer (`/pricing#offer-seafarer-free`). ONE builder so the node
 * is identical wherever it is emitted (/pricing's Offer list and the /overview/seafarers
 * SoftwareApplication). Price 0 is a real, public fact: Docka is always free for seafarers.
 */
export function seafarerFreeOfferJsonLd() {
  return {
    "@type": "Offer",
    "@id": abs("/pricing#offer-seafarer-free"),
    name: "Seafarer account",
    url: abs("/overview/seafarers"),
    category: "Free",
    availability: "https://schema.org/InStock",
    eligibleCustomerType: "https://schema.org/Consumer",
    price: 0,
    priceCurrency: "EUR",
    priceValidUntil: PRICE_VALID_UNTIL,
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: 0,
      priceCurrency: "EUR",
      unitCode: "MON",
      unitText: "per month",
      valueAddedTaxIncluded: false,
    },
    seller: { "@id": abs("/#organization") },
  };
}

/**
 * Normalise typographic punctuation in DATA strings (countries.ts, LEVEL_META) to the
 * plain forms the writing style guide requires, at the DATA-LAYER boundary (never in
 * JSX) so visible text and JSON-LD `text` fields are byte-identical:
 *   em dash U+2014 / en dash U+2013 (with or without surrounding spaces) -> ", "
 *   curly single quotes U+2018 / U+2019                                   -> "'"
 *   curly double quotes U+201C / U+201D (and the low-9 U+201E opener)     -> '"'
 * URL tokens (http(s)://...) are left untouched so a dash inside a link never changes it.
 * Product data files are NOT edited: this is the one shared render-time helper (plan R8).
 */
export function plainPunct(s: string): string {
  return s
    .split(/(https?:\/\/\S+)/)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // URL capture group: untouched
      return seg
        .replace(/\s*[\u2014\u2013]\s*/g, ", ")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D\u201E]/g, '"');
    })
    .join("");
}

/**
 * Serialize an object to a JSON-LD string that is SAFE to inline inside a
 * `<script type="application/ld+json">`. `JSON.stringify` does NOT escape `<`,
 * so a string value containing `</script>` could break out of the tag. Escaping
 * `<`, `>` and `&` as their `\uXXXX` forms keeps the payload valid JSON (browsers
 * un-escape it) while making a tag break-out impossible. Use this for EVERY
 * JSON-LD block's `dangerouslySetInnerHTML`.
 */
export function jsonLd(obj: unknown): string {
  return JSON.stringify(obj)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
