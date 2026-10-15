// Client-safe DISPLAY helpers over the registry table — shared by the home
// hero and the /verify page so both derive the "live connections" list from
// countries.ts capabilities at render time (never a hardcoded list/count that
// can drift from what the code actually does).

import { COUNTRIES } from "./countries";
import type { CountryEntry } from "./types";

// Registries Docka verifies against AUTOMATICALLY: "auto" + "auto-presence"
// (BG document-existence lookup) including the UA TCCS training-center
// connector (owner 2026-07-21: counts as Ukraine). Assisted / manual /
// unverified-endpoint entries are deliberately NOT listed anywhere public.
export const AUTO_REGISTRY_COUNTRIES: CountryEntry[] = COUNTRIES.filter(
  (c) => c.capability === "auto" || c.capability === "auto-presence"
);

// Registries whose OFFICIAL portal can be shown in an in-app iframe (LV only,
// per the 2026-07-21 header probe). Listed on /verify as their own honest
// card — "verify here on this page, you complete the check yourself" — and
// NEVER in the home-hero automatic list (that list claims machine
// verification; the embedded form is human-completed).
export const EMBEDDABLE_REGISTRY_COUNTRIES: CountryEntry[] = COUNTRIES.filter(
  (c) => c.embeddable === true
);

// USER-FACING region code: strips a service suffix ("UA-MARAD" -> "UA") but
// keeps the table's "UK" — the audience says UK; GB stays internal-only as
// the ISO input to Intl.DisplayNames (isoRegion below).
export function displayRegion(cc: string): string {
  return cc.split("-")[0];
}

// Entry code -> ISO 3166 region: a suffixed service code ("UA-MARAD") maps to
// its bare region ("UA" — Ukraine's two connectors are ONE country), and the
// table's "UK" maps to CLDR/Intl's "GB". Delegates the suffix-strip rule to
// displayRegion above (single source), then applies the UK->GB CLDR mapping.
export function isoRegion(cc: string): string {
  const bare = displayRegion(cc);
  return bare === "UK" ? "GB" : bare;
}

// Shared isoRegion dedupe: first entry per region wins (extracted so the hero
// list and the trust bar apply the SAME rule — byte-identical hero output).
function dedupeByIsoRegion(entries: CountryEntry[]): CountryEntry[] {
  return entries.filter(
    (c, i, arr) => arr.findIndex((o) => isoRegion(o.country) === isoRegion(c.country)) === i
  );
}

// The home-HERO badge list: full "auto" capability ONLY — auto-presence (BG
// document-existence lookup) is EXCLUDED here because the hero sentence claims
// verification, and a presence hit is not a validity verdict (honesty audit
// 2026-08-13). BG keeps its /verify card with the honest per-country line.
// Then deduped by isoRegion, so a country with TWO services (UA: TCCS + MARAD
// state registry) reads as ONE country name — "Ukraine", never "Ukraine and
// Ukraine (state registry)" (review fix 2026-08-13). First entry per region
// wins. The /verify page deliberately KEEPS all cards (honest presentation of
// each service) — it stays on AUTO_REGISTRY_COUNTRIES.
export const HERO_AUTO_REGISTRY_COUNTRIES: CountryEntry[] = dedupeByIsoRegion(
  AUTO_REGISTRY_COUNTRIES.filter((c) => c.capability === "auto")
);

// Trust-bar authority list: full-auto FLAG STATES only — the TCCS training
// centre is excluded (it is not a government authority), so UA is
// represented by UA-MARAD here. BG (auto-presence) stays out.
export const TRUST_BAR_AUTHORITIES: CountryEntry[] = dedupeByIsoRegion(
  AUTO_REGISTRY_COUNTRIES.filter(
    (c) => c.capability === "auto" && c.issuerKind !== "training-center"
  )
);

// SEO Phase 2c — SINGLE SOURCE for the "N flag-state registries" number surfaced on the
// home hero, /verify and /registries, so the count can never drift between pages (the
// 8-vs-9 inconsistency the audit flagged). This is the count of DISTINCT flag-state
// registries Docka verifies live-automatically: deduped by region, flag-state
// authorities only — it EXCLUDES the Bulgaria presence-only lookup AND the Ukraine
// training-centre validator (same rule as the trust bar). Today: 8.
export const AUTO_FLAG_STATE_COUNT: number = TRUST_BAR_AUTHORITIES.length;

// The presence-only (document-existence) registries — Bulgaria today. Surfaced ALONGSIDE
// the flag-state count ("N flag states, plus an existence check for Bulgaria") so the
// extra /verify card reads as an honest addition rather than a contradiction of the home
// hero's flag-state list. A presence hit is NOT a validity verdict (honesty audit).
export const PRESENCE_ONLY_COUNTRIES: CountryEntry[] = AUTO_REGISTRY_COUNTRIES.filter(
  (c) => c.capability === "auto-presence"
);

// Localised country name, falling back to the English countryName from the
// registry table if Intl.DisplayNames is unavailable.
export function countryDisplayName(cc: string, lang: string, fallback: string): string {
  // A suffixed service code ("UA-MARAD") keeps its DISTINCT table name
  // ("Ukraine (state registry)") — the /verify cards present two Ukrainian
  // services side by side; only the hero list dedupes (see above).
  if (cc.includes("-")) return fallback;
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(isoRegion(cc)) ?? fallback;
  } catch {
    return fallback;
  }
}

// Locale-aware "A, B and C" joining, with a plain comma fallback.
export function joinNames(names: string[], lang: string): string {
  try {
    return new Intl.ListFormat([lang], { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}
