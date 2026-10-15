// The authoritative billing-country whitelist — the SINGLE source of truth shared by
// the server validator (app/api/billing/profile/route.ts) and the client country picker
// (components/BillingSettings.tsx). Pure and client-safe: no server-only imports, so it
// can be pulled into a "use client" bundle without dragging Node APIs in.
//
// ISO-3166-1 alpha-2 for the EEA + UK + CH + the handful of flags docka works with.
// Moved VERBATIM from the route — the codes here ARE the codes the server accepts.

export const SUPPORTED_COUNTRY_CODES: string[] = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GR",
  "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT",
  "RO", "SE", "SI", "SK", "UA",
];

export const COUNTRY_WHITELIST: ReadonlySet<string> = new Set(SUPPORTED_COUNTRY_CODES);

/**
 * The whitelist as `{ code, name }` options for a <select>, sorted by display name.
 *
 * Names come from `Intl.DisplayNames` (region type, English). The box runs Node 20 with
 * full ICU, but the lookup is guarded: if the API is missing or throws, or returns
 * undefined for a code, we fall back to the raw code so an option is never blank. Because
 * the option VALUE is always the alpha-2 code, a display-name fallback never changes what
 * gets submitted or validated. Computed once at module load.
 */
function buildOptions(): { code: string; name: string }[] {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    display = null;
  }

  const options = SUPPORTED_COUNTRY_CODES.map((code) => {
    let name = code;
    try {
      name = (display?.of(code) as string | undefined) ?? code;
    } catch {
      name = code;
    }
    return { code, name };
  });

  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
}

const OPTIONS = buildOptions();

export function supportedCountryOptions(): { code: string; name: string }[] {
  return OPTIONS;
}
