// Client-safe core types for the pluggable VerifierRegistry (plan §2.2).
//
// A "registry" here is any authority that can confirm a seafarer credential:
// an EU flag-state administration (Estonia, Denmark, …) or a training-center
// validator (UA-TCCS). Estonia is adapter #1; every other country is either a
// machine connector, an assisted deep-link flow, or a manual email process —
// expressed by `RegistryCapability` below. The metadata for ALL countries lives
// in `countries.ts`; server-side fetch code lives per-country in `adapters/`.

import type { VerifiedCert } from "@/lib/cert";

export type RegistryCapability =
  | "auto" // machine connector, wire format confirmed -> can yield source:"government"
  | "auto-presence" // machine connector that only confirms existence (BG image response) — yields registry-confirmed with hasName:false, fields empty
  | "unverified-endpoint" // adapter code exists but wire format unconfirmed -> NEVER fetched; behaves as "assisted" at runtime
  | "assisted" // deep link + field prefill; human confirms on the official portal
  | "manual"; // email/process-only; "manual verification requested" workflow

// ISO-2 upper, e.g. "EE", "DK". Deliberately string-backed, NOT a closed EU-only
// enum — non-EU registries (India DGMA, Philippines MARINA, IMO FAL UTN) must be
// addable later without a type-level migration (roadmap T3.1).
export type CountryCode = string;

export type RegistryInputField = {
  key: string; // "certNumber" | "seafarerId" | "dob" | "surname" | ...
  label: string;
  // Max automation: auto-fill from the seafarer profile where possible, prompt
  // only when the data is absent or must never be stored.
  source: "paste" | "profile.birthDate" | "profile.verifiedName" | "prompt";
  /** e.g. BG EGN / ES NIF — NEVER persisted, NEVER logged, POST-body only. */
  sensitive?: boolean;
  /**
   * A lookup key that is only sometimes printed on the document (FR
   * numeroVersion — present only when the cert number exceeds 10,000,000).
   * Optional fields are SHOWN in the §5.2 needs-inputs prompt but never gate
   * it: the lookup proceeds without them, and the registry answers honestly.
   */
  optional?: boolean;
  /**
   * Closed value list for the field (UA-MARAD document type): the §5.2
   * needs-inputs prompt renders a select instead of a free-text input, and the
   * `value` is what the adapter receives (wire codes, e.g. "70"). Absent →
   * free-text prompt as before.
   */
  options?: { value: string; label: string }[];
};

// The §2.5 trust class of a lookup key. NOTE: this is the DEFAULT per country —
// the real class is per lookup MODE, resolved by the adapter per input path
// (DK bare cert number = public-identifier; DK QR token `/validateqr/<code>` =
// capability-token). The adapter stamps the mode actually used into
// `VerifiedCert.keyTrust`.
export type RegistryKeyKind = "capability-token" | "public-identifier";

export type CountryEntry = {
  country: CountryCode;
  countryName: string;
  authority: string; // "Søfartsstyrelsen — Danish Maritime Authority"
  /** Short public display name for the trust bar (e.g. "UK MCA"). Optional; falls back to `authority`. */
  authorityShort?: string;
  /** Default "flag-state"; UA-TCCS = "training-center" (never claims government). */
  issuerKind?: "flag-state" | "training-center";
  capability: RegistryCapability;
  keyKind: RegistryKeyKind; // §2.5 DEFAULT trust class — see RegistryKeyKind note
  /** §2.5/§5.4 — can we re-verify later from STORED non-sensitive inputs only? */
  recheckable: boolean;
  /** EXACT pinned hostname allowlist (security §2.4 — exact equality, never endsWith). */
  domains: string[];
  portalUrl: string; // human deep link (assisted/manual info panel)
  contactEmail?: string; // manual-wave countries
  inputs: RegistryInputField[];
  /** Bare-code format heuristic for detection (tested against normalized input). */
  codePattern?: RegExp;
  /**
   * Tested by planBareCodeCandidates ONLY; fires when the country's
   * `keywords` OR `hintKeywords` matched the OCR text (hint-only additionally
   * requires `ocrCodeRawPattern` on the raw token). Paste-safety comes from
   * detect.ts never reading this field — this is how a shape that collides
   * with another country's paste band can still power keyword-anchored OCR
   * candidates (UA-MARAD's "NNNNN/YYYY" digits vs DK's 8-digit band).
   *
   * Tested against the normalized token OR the raw uppercase token (either
   * passing emits the candidate — unchanged since 2026-08-24): a
   * slash-anchored pattern (AZ "NNNNNN/YY") matches only the raw form, which
   * is how a shape whose normalized digits collide with dates/DK can still be
   * candidate-safe. `ocrCodeRawPattern` below is a SEPARATE, additional AND
   * gate applied only in hint-only mode — it never relaxes this OR. The
   * emitted candidate always carries the NORMALIZED code; the adapter
   * reconstructs the wire form.
   */
  ocrCodePattern?: RegExp;
  /**
   * Required RAW-token evidence when this country is HINT-ONLY detected (no
   * strong keyword): the pre-normalize uppercase token must match this too
   * (UA-MARAD: the printed slash form "NNNNN/20YY"). Ignored when a strong
   * keyword matched. Absent → hint-only activation is IMPOSSIBLE for this
   * entry (fail-closed): a hint alone never emits a candidate. Table-driven
   * on purpose (08-24 rule: country data lives in the table, not in
   * keywords.ts).
   */
  ocrCodeRawPattern?: RegExp;
  /**
   * URL path prefix (lowercase, on the pinned domain) whose code segment is a
   * CAPABILITY TOKEN rather than a public identifier — e.g. Denmark's QR deep
   * link `/validateqr/<code>`. Detection stamps the candidate's lookup mode
   * from it (§2.5: the trust class is per lookup MODE, not per country).
   */
  qrPathPrefix?: string;
  /**
   * Developer/wire metadata (endpoint shapes, CAPTCHA gates, field ids). NEVER
   * rendered in the UI — persona F10c: agents were shown "Django POST + CSRF +
   * hCaptcha". User-relevant guidance lives in `userNotes` below.
   */
  notes?: string;
  /**
   * USER-facing guidance shown in the UI info panel: fake-domain warnings
   * ("rnaro.com imitates this authority") and coverage caveats ("covers 2017+
   * only"). Plain language only — no wire/dev jargon.
   */
  userNotes?: string;
  /**
   * Anonymous-upload keyword map (verify-upload plan §5): authority-name
   * keywords matched over a document's OCR text to work out WHICH country's
   * registry a photographed certificate belongs to. Matching is
   * diacritics-stripped UPPERCASE substring over whitespace-collapsed
   * `ocrTextAll` (see registry/keywords.ts). v1 ships LATIN-SCRIPT keywords
   * only — Cyrillic (BG) / Greek (GR native) authority names are DEAD until a
   * non-eng tesseract traineddata ships (the OCR worker is eng-only), so those
   * entries simply omit the field. Keywords must be distinctive enough not to
   * misfire on generic certificate boilerplate (never bare "MARITIME").
   */
  keywords?: string[];
  /**
   * WEAK hints (2026-09-07): consulted ONLY when no country's strong
   * `keywords` hit. A hint RANKS the country first and activates its
   * `ocrCodePattern` (subject to `ocrCodeRawPattern`), but NEVER
   * keyword-locks (a state name is printed as holder nationality on foreign
   * certs). Matched with a WORD BOUNDARY on the normalized text ("UKRAINIAN"
   * never hits "UKRAINE"). Uppercase letters and spaces only (asserted at
   * module load in keywords.ts). Distinctive state names only; never
   * boilerplate. Specimen generator does NOT read this field.
   */
  hintKeywords?: string[];
  /**
   * The assisted portal page can be shown in an in-app iframe (a convenience
   * view of the OFFICIAL portal — no proxying, no header stripping, nothing
   * injected into the frame; any CAPTCHA is solved by the human user). Set
   * ONLY where a live header probe confirmed the page is frameable AND works
   * in a third-party context (no X-Frame-Options, no CSP frame-ancestors, no
   * framebusting, and no cookie that breaks cross-site — Lithuania frames but
   * its PHPSESSID has no SameSite=None, so it must NEVER get this flag).
   * The iframe src is ALWAYS the pinned portalUrl — never user-supplied.
   */
  embeddable?: boolean;
};

// TRI-STATE adapter result — replaces binary CertResult at the adapter boundary.
// (verifyCode() still maps this back to the legacy CertResult for increment-1
// callers.) The distinction that matters for honesty:
//   no-match       — the registry DEFINITIVELY answered "nothing under this key"
//                    for THIS registry; the dispatcher continues in rank order.
//   match-invalid  — the registry POSITIVELY answered: this cert is invalid or
//                    expired. Surfaced honestly only from a CERTAIN candidate.
//   indeterminate  — ambiguous miss (UA-TCCS "contact us") or a network failure.
//                    NEVER treated as invalid, never cached.
export type AdapterOutcome =
  | { kind: "match-valid"; cert: VerifiedCert }
  | { kind: "match-invalid"; cert: VerifiedCert }
  | { kind: "no-match" }
  | { kind: "indeterminate"; reason: string };

export type RegistryAdapter = CountryEntry & {
  /** auto / auto-presence only. Inputs are the resolved RegistryInputField values. */
  verify?: (inputs: Record<string, string>) => Promise<AdapterOutcome>;
  /** PURE response→outcome mapping — separated from fetch for fixture tests. */
  parseResponse?: (raw: string | object, code: string) => AdapterOutcome;
};

export type ResolveOutcome =
  // Machine-verified — capability-token lookup modes ONLY (§2.5). May carry an
  // isValid:false cert (honest "registry says invalid" from a certain candidate).
  | { kind: "verified"; cert: VerifiedCert }
  // Public-identifier match-valid — MUST pass bindHolder (§2.5) before newVerifiedDoc.
  | { kind: "pending-binding"; cert: VerifiedCert; country: CountryEntry }
  | { kind: "assist"; country: CountryEntry; prefill: Record<string, string> }
  // An AUTO country matched but its lookup needs more keys than the paste
  // (UK/NO date of birth, …): the UI prompts for `missing` (auto-filled from
  // the profile where the field's source allows) and re-submits the same code
  // with `inputs`. Nothing is fetched and nothing is stored until then.
  | { kind: "needs-inputs"; country: CountryEntry; code: string; missing: RegistryInputField[] }
  | { kind: "manual"; country: CountryEntry; code: string }
  // Detection failed / fan-out cap hit -> UI country picker round-trips with
  // countryOverride. `unmatched:true` marks the persona-B2 dead-end rescue: a
  // bare code that matched NO registry (and missed the EE fallback) — the UI
  // may show the FULL country list here (the user explicitly chooses; an
  // assisted/manual selection then routes to that flow with the pasted code).
  | { kind: "ambiguous"; candidates: CountryCode[]; code: string; unmatched?: boolean }
  // incl. fake-registry refusal (unpinnedDomain) and the §2.4 rate limiter
  // (rateLimited: friendly retry, NO partial verification, NO doc stored).
  | { kind: "error"; error: string; unpinnedDomain?: string; rateLimited?: boolean };
