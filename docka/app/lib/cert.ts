// Shared types + helpers for the Estonian maritime certificate verification.
//
// The registry exposes four public "by-access-token" endpoints. A pasted code
// can belong to any of them, so the /api/cert route tries them in order until
// one answers 200. Every successful lookup is normalised to the single
// VerifiedCert shape below, tagged with a docCategory so the UI can render the
// right kind of card — importantly, medical certificates come back as a
// MinimalDocumentModel with NO name.

import type { CountryCode } from "@/lib/registry/types";

export type DocCategory = "competency" | "medical" | "endorsement" | "qualification";

export type VerifiedCert = {
  ok: true;
  code: string;
  docCategory: DocCategory;
  /** Medical (MinimalDocumentModel) has no holder name — render name-less. */
  hasName: boolean;
  fullName: string; // "" for medical
  /** Registry holder given name; "" for a name-less (medical) model. */
  firstName: string;
  /** Registry holder surname; "" for a name-less (medical) model. */
  lastName: string;
  /** Human title for the document, e.g. the certificate legal name. */
  title: string;
  personalCode: string;
  /** Registry-held date of birth (ISO instant); "" when the model carries none. */
  birthDate: string;
  status: string;
  isValid: boolean;
  issuedOn: string;
  validUntil: string;
  certificateType: string;
  issuerCountry: string;
  institution: string;
  documentType: string;
  sourceUrl: string;
  photoUrl?: string;
  /** Which registry answered (plan §2.2) — the EE adapter sets "EE". */
  registryCountry: CountryCode;
  /**
   * §2.5 trust class of the lookup MODE actually used, stamped by the adapter:
   * "capability-token" (unguessable secret — EE access token, DK QR) may drive
   * identity self-heal; "public-identifier" (printed/knowable key) must pass
   * holder binding first and never self-heals identity.
   */
  keyTrust: "capability-token" | "public-identifier";
  /**
   * What `newVerifiedDoc` writes into `doc.source`: "government" for flag-state
   * verifications that pass holder binding; "registry" for presence-only /
   * training-center confirmations (holder not verified).
   */
  verifiedSource: "government" | "registry";
};

export type CertError = { ok: false; error: string };

export type CertResult = VerifiedCert | CertError;

// ---- Endpoint registry -------------------------------------------------
//
// Estonia's endpoint table, URL builders and payload normalisation moved
// VERBATIM into the pluggable VerifierRegistry as adapter #1
// (lib/registry/adapters/ee.ts, plan §2.1). Re-exported here so every existing
// import keeps compiling unchanged during the refactor.

export { CERT_ENDPOINTS, apiUrl, publicUrl, normalizeCert } from "@/lib/registry/adapters/ee";

export const CATEGORY_LABELS: Record<DocCategory, string> = {
  competency: "Certificate of competency",
  medical: "Medical certificate",
  endorsement: "Endorsement",
  qualification: "Qualification",
};

// ---- Small helpers -----------------------------------------------------

// Extract a verification code from either a raw code or a full pasted URL.
// e.g. "https://meremees.transpordiamet.ee/certificates/SAMPLE0SAFETY001" -> "SAMPLE0SAFETY001"
export function extractCode(input: string): string | null {
  if (!input) return null;
  let s = input.trim();

  // If it looks like a URL, take the last non-empty path segment.
  if (s.includes("/")) {
    s = s.split(/[?#]/)[0]; // drop query/hash
    const parts = s.split("/").filter(Boolean);
    s = parts[parts.length - 1] ?? "";
  }

  s = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 6 ? s : null;
}

// Collapse the double-spaces the registry sometimes returns in legal names.
export function tidy(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

// ---- Public-surface redaction (owner 2026-07-28) ---------------------
//
// The homepage "try a live verification" demo and /verify run a REAL registry
// lookup against a REAL person's certificate, so the card would otherwise print
// that person's national personal code and the certificate's access token in
// clear text on an anonymous public page. Those two values are redacted
// SERVER-SIDE, before the response is serialised — deliberately NOT a CSS blur,
// which still ships the value in the HTML source for anyone who reads it.
//
// ONE rule for both fields: keep the first 4 characters and the last quarter
// (clamped to 2–4 characters), replace everything between with one bullet per
// hidden character. Values too short to redact meaningfully are fully masked.
//   "30000000000"      -> "3000•••••00"
//   "SAMPLE0SAFETY001" -> "SAMP••••••••Y001"
export function maskCode(value: string | null | undefined): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "";
  const head = 4;
  const tail = Math.min(Math.max(Math.floor(s.length / 4), 2), 4);
  if (s.length < head + tail + 2) return "•".repeat(s.length);
  return s.slice(0, head) + "•".repeat(s.length - head - tail) + s.slice(-tail);
}

/**
 * The copy of a verified certificate that a PUBLIC (unauthenticated) caller is
 * allowed to see: ONLY the two displayed field values — personal code and
 * verification code — are redacted. Everything else is untouched.
 *
 * `sourceUrl` in particular stays the EXACT registry deep link the adapter
 * built (…/certificates/<code>), so "View on the official registry" keeps
 * working and lands on the specific certificate. It does embed the
 * verification code; that is a deliberate, accepted trade-off (owner
 * 2026-07-28) — an earlier version de-pathed the link to the registry
 * homepage and broke the feature. Do not re-introduce that. That directive is
 * scoped to REAL lookups (the "View on the official registry" feature), so it
 * is NOT violated by the `sample` branch below, which fires ONLY for the
 * hardcoded homepage demo prop.
 *
 * `opts.sample` = the fixed homepage DEMO certificate. It is a public prop that
 * happens to show a REAL person's data, so it must never leak that person's PII
 * to ANY viewer — signed-in admins/agents INCLUDED (the route forces this
 * branch for the sample regardless of `isSignedInViewer()`). On top of the two
 * masked codes it additionally:
 *   - neuters `sourceUrl` so the raw 16-char access token is not in the href
 *     and the link no longer deep-links to the real person's government page
 *     (SAMPLE-SCOPED: real lookups keep their exact deep link, per the directive
 *     above);
 *   - blanks `birthDate` (the registry-held DOB otherwise ships in the JSON).
 */
export function redactCertForPublic(
  cert: VerifiedCert,
  opts?: { sample?: boolean }
): VerifiedCert {
  const base: VerifiedCert = {
    ...cert,
    code: maskCode(cert.code),
    personalCode: maskCode(cert.personalCode),
  };
  if (!opts?.sample) return base;
  return {
    ...base,
    sourceUrl: neuterSampleSourceUrl(cert.sourceUrl),
    birthDate: "",
  };
}

// Strip a sample cert's `sourceUrl` down to a NON-identifying registry URL:
// drop the token-bearing last path segment plus any query/hash, keeping only
// the origin + the category listing path (e.g.
// …/certificates/<token> -> …/certificates/). Guarantees the raw access token
// is never present in the href. SAMPLE-SCOPED — never applied to real lookups.
function neuterSampleSourceUrl(url: string): string {
  const s = typeof url === "string" ? url.trim() : "";
  if (!s) return "";
  try {
    const u = new URL(s);
    const parts = u.pathname.split("/").filter(Boolean);
    parts.pop(); // remove the access-token segment
    return u.origin + "/" + (parts.length ? parts.join("/") + "/" : "");
  } catch {
    // Not an absolute URL we can parse — drop it entirely rather than risk
    // leaving the token in a relative form.
    return "";
  }
}

// ---- Validity status (shared by seafarer + agent views) ---------------

// "none" = the document INTENTIONALLY has no expiry date (perpetual — the owner
// set the `noExpiry` flag). It is a VALID/compliant state, distinct from "unknown"
// (a null date we simply have not read yet). Only the doc-aware `docStatusForDoc`
// ever returns "none"; the bare `docStatus(date)` never does (it only sees a date).
export type DocStatus = "valid" | "expiring" | "expired" | "unknown" | "none";

export const EXPIRING_DAYS = 60;

// Classify a document by its expiry date. "expiring" = valid but within 60 days.
export function docStatus(validUntil?: string | null): DocStatus {
  if (!validUntil) return "unknown";
  const d = new Date(validUntil);
  if (isNaN(d.getTime())) return "unknown";
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (days < 0) return "expired";
  if (days < EXPIRING_DAYS) return "expiring";
  return "valid";
}

/**
 * DOC-AWARE status (Feature 3, "No end date" flag). A document flagged
 * `noExpiry === true` is a perpetual document and resolves to the valid-equivalent
 * "none" state REGARDLESS of any date — never "unknown"/"expiring"/"expired". Every
 * other document falls through to the plain date-based `docStatus`.
 *
 * `effectiveValidUntil` lets callers that compute an age-shortened LEGAL expiry
 * (cert-rules) pass it through, exactly as they already do for `docStatus`; omit it
 * to judge on the document's own `validUntil`. The `noExpiry` short-circuit wins
 * over whatever date is passed, so a stray future date can never un-perpetual a doc.
 */
export function docStatusForDoc(
  doc: { validUntil?: string | null; noExpiry?: boolean },
  effectiveValidUntil?: string | null
): DocStatus {
  if (doc.noExpiry === true) return "none";
  const vu = effectiveValidUntil !== undefined ? effectiveValidUntil : doc.validUntil ?? null;
  return docStatus(vu);
}

const SEVERITY: Record<DocStatus, number> = {
  expired: 3,
  expiring: 2,
  valid: 1,
  // Perpetual (no-expiry) is a compliant state — never the "worst" over a set, and
  // never dominates a genuine warning. `worstStatus` (date-only) never yields it.
  none: 1,
  unknown: 0,
};

// Worst-case status across a set of expiry dates — what the agent triages on.
export function worstStatus(validUntils: (string | null | undefined)[]): DocStatus {
  let worst: DocStatus = "unknown";
  for (const v of validUntils) {
    const s = docStatus(v);
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

export const STATUS_LABELS: Record<DocStatus, string> = {
  valid: "Valid",
  expiring: "Expiring soon",
  expired: "Expired",
  // "unknown" = a null date we have NOT read yet (distinct from the perpetual
  // "No expiry" below). Feature 3 de-overloads the old shared "No expiry" wording.
  unknown: "Expiry unknown",
  // Perpetual — the owner marked this document as having no end date.
  none: "No expiry",
};

// ---- Honest, source-aware badge --------------------------------------
//
// The single source of truth for the pill shown on a document, used by BOTH the
// seafarer's own view and the (open, no-login) agent share view. The rule it
// enforces is the anti-fraud invariant round 8 flagged repeatedly:
//
//   The emerald "Valid" badge is RESERVED for government-registry-verified
//   documents. A photo/manual document is NEVER shown as a confident green
//   "Valid" — even if it carries a plausible future expiry — because that expiry
//   is only an OCR guess or a self-typed date, not issuer verification. Blending
//   "a machine read a JPG" with "this certificate is genuine" is exactly the gap
//   an authenticity-conscious agent must not be walked into.
//
// Two extra badge kinds make the honest states explicit:
//   "unverified" — arrived, not registry-verified (neutral, no assurance).
//   "unread"     — an expiry we could not trust (OCR-guessed on a photo we
//                  couldn't even title): flagged for a human to confirm, never
//                  presented as fact.
// "checked" is a NON-government reviewer sign-off: a human opened the actual
// document and confirmed the name + expiry match. It is deliberately a distinct
// blue label — never the emerald "Valid"/"Verified" reserved for the registry —
// so a reviewer-checked paper photo can never be mistaken for authority proof.
// Two registry-era additions (plan §5.1):
//   "requested"    — a manual verification request is OPEN with the authority
//                    (Wave-4 email/process countries). An OUTCOME, never an
//                    error — violet, distinct from every trust colour.
//   "registry-doc" — teal "Registry-confirmed document — holder not verified":
//                    presence-only results (BG) and training-center
//                    confirmations (UA-TCCS), i.e. `source:"registry"`. NEVER
//                    emerald — it confirms the document exists, not who holds it.
export type BadgeStatus =
  | DocStatus
  | "unverified"
  | "unread"
  | "checked"
  | "requested"
  | "registry-doc";

export const BADGE_LABELS: Record<BadgeStatus, string> = {
  // #S3 — "In date" reads as an EXPIRY status, not a trust claim ("Valid" was
  // being confused with "verified"). Expired stays red; expiring unchanged.
  valid: "In date",
  expiring: "Expiring soon",
  expired: "Expired",
  // A null date not yet read — NOT the perpetual "No expiry" (that is `none`).
  unknown: "Expiry unknown",
  // Perpetual document (Feature 3 "No end date" flag) — valid/compliant, no end date.
  none: "No expiry",
  unverified: "Not verified",
  // "unread" is only ever used when a date WAS read off the photo but is not yet
  // human-confirmed. Say exactly that — "confirm expiry" — never "expiry unread",
  // which contradicts the date shown right beside the badge.
  unread: "Not verified · confirm expiry",
  checked: "Checked by reviewer",
  requested: "Verification requested",
  "registry-doc": "Registry-confirmed — holder not verified",
};

// Label variant for a reviewer sign-off done on the official registry portal
// (checkedVia === "registry-portal") — still the blue "checked" tone, NEVER
// emerald: a human portal check is not machine verification.
export const CHECKED_AGAINST_REGISTRY_LABEL = "Checked against registry";

// Decide the badge for a document from its trust signals.
//  - verified (government): normal expiry colours — valid=green, expiring, expired.
//    Emerald stays EXCLUSIVE to holder-bound government verification.
//  - source "registry": teal "registry-doc" (holder not verified) — but the
//    expiry warning ALWAYS outranks the teal (plan §5.1 precedence): an expired
//    registry-confirmed doc shows "Registry-confirmed · expired" with the
//    existing expiry visuals, never a calm plain teal.
//  - NOT verified (photo/manual):
//      * expired / expiring  -> honest warning colour (a warning never over-asserts).
//      * manual verification REQUESTED -> violet "requested" (an outcome, not an error).
//      * reviewer-checked on the official portal -> blue "checked" with the
//        "Checked against registry" label (never emerald).
//      * a future expiry the seaman CONFIRMED -> neutral "Not verified" (never green).
//      * a future expiry that is only an OCR guess -> amber "unread" (confirm me).
//      * no expiry            -> neutral "Not verified".
export function docBadge(opts: {
  verified: boolean;
  validUntil?: string | null;
  /** A human (seaman) or the registry set this date — vs a best-effort OCR guess. */
  expiryConfirmed?: boolean;
  /**
   * Doc source passthrough (plan §5.1) — only "registry" changes the outcome
   * (teal registry-doc state). Every other value falls through to the existing
   * non-government behavior; omitting it keeps all legacy call sites intact.
   */
  source?: "government" | "registry" | "photo" | "manual" | null;
  /** §4.3 — how the reviewer sign-off was performed (label variant only). */
  checkedVia?: "document" | "registry-portal" | null;
  /** §4.4 — a manual verification request is open on this doc. */
  manualRequested?: boolean;
}): { status: BadgeStatus; label: string } {
  const s = docStatus(opts.validUntil);
  if (opts.verified) {
    // Blocker (persona re-review) — the status pill expresses the VALIDITY axis
    // ONLY ("In date" / "Expiring soon" / "Expired" / "No expiry"). The trust
    // wording ("Government-verified") is carried EXACTLY ONCE, by the
    // VerificationLevelBadge rendered beside it. Emitting "Government-verified"
    // here too produced two adjacent identical green pills on the CV matrix and
    // the share doc list; the two pills must state different things. Expiry
    // warnings keep their own colour via the status tone.
    return { status: s, label: BADGE_LABELS[s] };
  }
  if (opts.source === "registry") {
    // Precedence (§5.1): expired/expiring ALWAYS outranks the teal registry-doc
    // state — the warning keeps its visuals, the label keeps the honesty.
    if (s === "expired") return { status: "expired", label: "Registry-confirmed · expired" };
    if (s === "expiring") return { status: "expiring", label: "Registry-confirmed · expiring soon" };
    return { status: "registry-doc", label: BADGE_LABELS["registry-doc"] };
  }
  if (s === "expired") return { status: "expired", label: "Expired · not verified" };
  if (s === "expiring") return { status: "expiring", label: "Expiring · not verified" };
  if (opts.manualRequested) {
    return { status: "requested", label: BADGE_LABELS.requested };
  }
  if (opts.checkedVia === "registry-portal") {
    return { status: "checked", label: CHECKED_AGAINST_REGISTRY_LABEL };
  }
  if (s === "valid") {
    return opts.expiryConfirmed
      ? { status: "unverified", label: "Not verified" }
      : { status: "unread", label: BADGE_LABELS.unread };
  }
  return { status: "unverified", label: "Not verified" };
}

/**
 * DOC-AWARE badge (Feature 3, "No end date" flag). A document flagged
 * `noExpiry === true` is perpetual: it ALWAYS renders the neutral-green, valid-
 * equivalent "No expiry" badge (`status:"none"`), never "Not verified"/"unread"/
 * an expiry warning — even for a non-government document. Every other document
 * falls through to the existing `docBadge` behaviour unchanged.
 *
 * Callers pass the SAME opts object they already build for `docBadge` (with the
 * age-shortened `validUntil`, `source`, `checkedVia`, `manualRequested`, …) plus
 * the document's `noExpiry` flag — so switching a call site from `docBadge` to
 * `docBadgeForDoc` is purely additive.
 */
export function docBadgeForDoc(
  opts: Parameters<typeof docBadge>[0] & { noExpiry?: boolean }
): { status: BadgeStatus; label: string } {
  if (opts.noExpiry === true) {
    return { status: "none", label: BADGE_LABELS.none };
  }
  return docBadge(opts);
}
