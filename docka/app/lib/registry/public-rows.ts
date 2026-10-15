// PUBLIC projection of the registry table for the marketing/content pages (SEO plan
// v3 S1/R6). ONE whitelist, ONE place: every public rendering of "which registries
// Docka checks against" (the /registries table, the how-it-works list, the /verify
// "Which official portal?" table, the per-country registry pages' authority line)
// reads from here, never from `COUNTRIES` directly, so the wire/dev `notes` field
// (persona rule F10c) can never leak into rendered text or JSON-LD.
//
// Rules:
//   - ONLY these fields: code, country, authority, authorityShort, portalUrl,
//     capability, inputs[].label, userNotes. NEVER `notes`, `domains`, `keywords`,
//     `codePattern`, `contactEmail` or anything else.
//   - Every string passes through `plainPunct()` HERE (data layer, never in JSX) so
//     visible text and JSON-LD text are byte-identical and style-guide clean.
//   - Capabilities listed: auto | auto-presence | assisted | manual. The
//     "unverified-endpoint" entries (adapter unconfirmed, never fetched) are not public.
//   - Product data (`countries.ts`) is NOT edited by this projection.

import { COUNTRIES } from "./countries";
import type { CountryCode, RegistryCapability } from "./types";
import { plainPunct } from "@/lib/seo";

export type PublicRegistryCapability = Exclude<RegistryCapability, "unverified-endpoint">;

export type RegistryPublicRow = {
  /** Table code, e.g. "EE", "UA-MARAD" (NOT always ISO-2: see display.ts `displayRegion`). */
  code: CountryCode;
  /** `countryName` from the table, e.g. "Ukraine (training center)". */
  country: string;
  authority: string;
  /** Present only when the table has a short public name (e.g. "UK MCA"). */
  authorityShort?: string;
  /** The pinned official portal deep link. Never altered by plainPunct. */
  portalUrl: string;
  capability: PublicRegistryCapability;
  /** Human labels of the lookup inputs (never keys, sources or sensitivity flags). */
  inputs: string[];
  /** USER-facing guidance only (fake-domain warnings, coverage caveats). */
  userNotes?: string;
};

const PUBLIC_CAPABILITIES: ReadonlySet<RegistryCapability> = new Set<RegistryCapability>([
  "auto",
  "auto-presence",
  "assisted",
  "manual",
]);

function isPublicCapability(c: RegistryCapability): c is PublicRegistryCapability {
  return PUBLIC_CAPABILITIES.has(c);
}

function toRow(c: (typeof COUNTRIES)[number]): RegistryPublicRow | null {
  if (!isPublicCapability(c.capability)) return null;
  return {
    code: c.country,
    country: plainPunct(c.countryName),
    authority: plainPunct(c.authority),
    ...(c.authorityShort ? { authorityShort: plainPunct(c.authorityShort) } : {}),
    portalUrl: c.portalUrl,
    capability: c.capability,
    inputs: c.inputs.map((i) => plainPunct(i.label)),
    ...(c.userNotes ? { userNotes: plainPunct(c.userNotes) } : {}),
  };
}

/**
 * The module-level projection (computed once at import; `COUNTRIES` is a static
 * table). Table order is preserved so the public listing matches the product order.
 */
export const REGISTRY_PUBLIC_ROWS: readonly RegistryPublicRow[] = Object.freeze(
  COUNTRIES.map(toRow).filter((r): r is RegistryPublicRow => r !== null)
);

/** Function form of `REGISTRY_PUBLIC_ROWS` for call sites that prefer a call. */
export function registryTableRows(): readonly RegistryPublicRow[] {
  return REGISTRY_PUBLIC_ROWS;
}

/** One public row by table code (e.g. `registryRow("UA-MARAD")`). */
export function registryRow(code: CountryCode): RegistryPublicRow | undefined {
  return REGISTRY_PUBLIC_ROWS.find((r) => r.code === code);
}

/**
 * Table code -> `/registries/<slug>` for the flag states that have (or, per the SEO
 * plan WP-E, get) a public registry page. Ukraine maps to the STATE registry entry
 * "UA-MARAD" (vrf.marad.gov.ua), not the "UA" training-center validator: the page is
 * about the flag-state authority. Everyone builds these hrefs from this map, never
 * from a hand-typed literal (the dead-href test in tests/seo-new-pages-e.test.mjs
 * resolves every value here to an existing route).
 */
export const REGISTRY_PAGE_SLUGS: Readonly<Record<CountryCode, string>> = Object.freeze({
  EE: "estonia",
  DK: "denmark",
  CY: "cyprus",
  UK: "united-kingdom",
  NO: "norway",
  FR: "france",
  "UA-MARAD": "ukraine",
  AZ: "azerbaijan",
});

/** `/registries/<slug>` for a table code, or `undefined` when no page exists. */
export function registryPagePath(code: CountryCode): string | undefined {
  const slug = REGISTRY_PAGE_SLUGS[code];
  return slug ? `/registries/${slug}` : undefined;
}
