// Client-safe registry detection (plan §2.3) — max automation: work out WHICH
// registry an arbitrary pasted input belongs to, so the UI never shows a
// country dropdown unless detection genuinely fails.
//
//   1. URL paste / QR content containing a URL → exact hostname match against
//      the union of all pinned domain allowlists. A host in NO allowlist is
//      refused ({kind:"unpinned-domain"}) and NEVER fetched — the fake-registry
//      defense (rnaro.com, hcg-gov.gr, itados.org, …).
//   2. Bare code → normalize, run each country's codePattern, rank. Estonia is
//      the FALLBACK candidate for ANY unmatched bare code ≥6 chars — this
//      preserves the legacy `extractCode` semantics (cert.ts) EXACTLY: today
//      any ≥6-char alphanumeric goes to the EE endpoints, and it still does.
//   3. Fan-out cap: ≥2 auto-capability SPECIFIC pattern matches → ambiguous
//      (country picker) — a pasted code is never sprayed across registries.
//      The EE fallback is EXEMPT from the cap and always appended LAST.

import { COUNTRIES, countryEntry, entryForHostname } from "./countries";
import type { CountryCode, RegistryKeyKind } from "./types";

export type DetectCandidate = {
  country: CountryCode;
  /** The lookup code, normalized per the candidate country's rules. */
  code: string;
  /** true only for pinned-URL/QR detection (and countryOverride) — §2.3.4 certainty. */
  certain: boolean;
  /**
   * §2.5 lookup MODE override, when the input path itself proves the trust
   * class — set to "capability-token" for a QR deep link on a pinned domain
   * (DK `/validateqr/<code>`). Absent → the country's default keyKind applies.
   */
  mode?: RegistryKeyKind;
  /**
   * true ONLY for the legacy EE ≥6-char fallback candidate (no specific
   * pattern matched). When the fallback is the ONLY candidate and it misses,
   * the dispatcher turns the dead end into an all-country picker (persona B2)
   * instead of the EE-flavored not-found error.
   */
  fallback?: boolean;
};

export type DetectResult =
  | { kind: "candidates"; candidates: DetectCandidate[] }
  | { kind: "ambiguous"; candidates: CountryCode[]; code: string }
  | { kind: "unpinned-domain"; hostname: string }
  | { kind: "invalid" };

/** Legacy minimum accepted by extractCode — the EE fallback threshold. */
const EE_FALLBACK_MIN = 6;

// EXACT legacy extractCode normalization (cert.ts): uppercase, strip everything
// outside A-Z0-9.
export function eeNormalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Generic normalization for per-country pattern matching: uppercase, strip
// separator characters only — KEEPS non-Latin letters, because BG/UA (Cyrillic)
// and GR (Greek) certificate identifiers must survive normalization (§2.3).
export function genericNormalize(s: string): string {
  return s.toUpperCase().replace(/[\s\-_./\\]+/g, "");
}

// Parse the input as a URL only when it plausibly IS one: an explicit http(s)
// scheme, or a hostname-shaped first segment ("meremees.transpordiamet.ee/…").
// Anything else falls through to the bare-code path, which replicates the
// legacy extractCode handling of slash-containing strings.
function tryParseUrl(s: string): URL | null {
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s);
    } catch {
      return null;
    }
  }
  const head = s.split("/")[0] ?? "";
  if (s.includes("/") && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(head)) {
    try {
      return new URL("https://" + s);
    } catch {
      return null;
    }
  }
  return null;
}

function isAutoCapability(country: CountryCode): boolean {
  const c = countryEntry(country);
  return !!c && (c.capability === "auto" || c.capability === "auto-presence");
}

export function detectRegistry(raw: string): DetectResult {
  if (!raw || !raw.trim()) return { kind: "invalid" };
  const s = raw.trim();

  // ---- 1. URL / QR-URL path --------------------------------------------
  const url = tryParseUrl(s);
  if (url) {
    const entry = entryForHostname(url.hostname);
    if (!entry) return { kind: "unpinned-domain", hostname: url.hostname.toLowerCase() };
    // SPA hash routes (DK Angular, NO React use `#/route/...` deep links): when
    // the fragment is itself a path, it IS the route — extract from it instead
    // of the bare "/" pathname. Query/hash otherwise dropped by URL parsing.
    const routePath =
      url.hash && url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
    // Reuse the legacy rule: the code is the last non-empty path segment.
    const parts = routePath.split("/").filter(Boolean);
    const segment = parts[parts.length - 1] ?? "";
    const code = entry.country === "EE" ? eeNormalize(segment) : genericNormalize(segment);
    if (!code || (entry.country === "EE" && code.length < EE_FALLBACK_MIN)) {
      return { kind: "invalid" };
    }
    // §2.5 lookup-mode stamp: a QR deep-link path on the pinned domain carries
    // a capability token (unguessable secret), e.g. DK /validateqr/<code>.
    const mode: RegistryKeyKind | undefined =
      entry.qrPathPrefix && routePath.toLowerCase().startsWith(entry.qrPathPrefix)
        ? "capability-token"
        : undefined;
    return {
      kind: "candidates",
      candidates: [{ country: entry.country, code, certain: true, ...(mode ? { mode } : {}) }],
    };
  }

  // ---- 2. Bare-code path (legacy extractCode semantics) -----------------
  // extractCode treats ANY slash-containing input as URL-ish: drop query/hash,
  // keep the last non-empty segment. Replicate that exactly.
  let t = s;
  if (t.includes("/")) {
    t = t.split(/[?#]/)[0];
    const parts = t.split("/").filter(Boolean);
    t = parts[parts.length - 1] ?? "";
  }

  const generic = genericNormalize(t);
  const eeCode = eeNormalize(t);

  // Specific pattern matches, in table (rank) order. EE's own pattern tests
  // against the EE normalization; everything else against the generic one.
  const specific: DetectCandidate[] = [];
  for (const c of COUNTRIES) {
    if (!c.codePattern) continue;
    if (c.country === "EE") {
      if (eeCode && c.codePattern.test(eeCode)) {
        specific.push({ country: "EE", code: eeCode, certain: false });
      }
      continue;
    }
    if (generic && c.codePattern.test(generic)) {
      specific.push({ country: c.country, code: generic, certain: false });
    }
  }

  // ---- 3. Fan-out cap (§2.3) — EE fallback exempt -----------------------
  const autoSpecific = specific.filter((m) => m.country !== "EE" && isAutoCapability(m.country));
  if (autoSpecific.length >= 2) {
    return {
      kind: "ambiguous",
      candidates: autoSpecific.map((m) => m.country),
      code: generic,
    };
  }

  // Candidates in rank order: specific non-EE matches first, then EE — either
  // its own specific match or the ≥6-char fallback — appended LAST, exactly
  // once. The dispatcher reaches EE on a preceding candidate's `no-match`.
  const candidates: DetectCandidate[] = specific.filter((m) => m.country !== "EE");
  const eeSpecific = specific.find((m) => m.country === "EE");
  if (eeSpecific) {
    candidates.push(eeSpecific);
  } else if (eeCode.length >= EE_FALLBACK_MIN) {
    candidates.push({ country: "EE", code: eeCode, certain: false, fallback: true });
  }

  if (candidates.length === 0) return { kind: "invalid" };
  return { kind: "candidates", candidates };
}
