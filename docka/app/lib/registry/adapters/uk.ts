// United Kingdom — Maritime and Coastguard Agency (plan §3 Wave 1).
//
// Wire format CONFIRMED live 2026-07-20 (dossier uk.md): the CoC/FSE checker at
// https://coccec.mcga.gov.uk is server-rendered (GOV.UK Design System); the
// real data request is a plain GET —
//
//   GET /Certificate-Search-Results/?documentId=<id>&date=<YYYY-MM-DD>
//     -> full HTML page; the verdict lives in #main-content:
//        miss  -> govuk-notification-banner "No Record Found, try searching
//                 again" (REAL fixture uk-noresults.html, re-captured
//                 2026-08-12 with the official specimen CoC0089297 — the
//                 2026-07 wording was "No CoC Record Found"; the parser
//                 accepts both).
//        match -> certificate/holder details in the same region (NOT observed
//                 live — no valid sample existed; the valid fixture is
//                 SYNTHETIC, so the match parser only answers on
//                 high-confidence markers and otherwise says indeterminate).
//
// 2026-08 checker drift (probed live 2026-08-12): the search FORM gained a
// required "Document Type" select (name=documentType — COC/COP/FSE/GOC/BML/…)
// whose requiredness is CLIENT-side only; its JS builds the same GET with an
// extra &documentType=<TYPE>. The server still answers the typeless GET with a
// definitive verdict (the specimen probe above returned the real miss banner
// without a type), so this adapter deliberately keeps the minimal typeless
// query — no extra prompt, no type-guessing fallback sequence. If the server
// ever starts requiring it, add a COC-then-COP retry before prompting.
//
// Id casing: genericNormalize UPPERCASES pasted codes, so the wire carries e.g.
// COC0089297 (not the printed CoC0089297). Uppercase confirmed accepted for
// misses 2026-08-12 — a live GET with documentId=COC0089297&date=1988-03-03
// returned the definitive "No Record Found, try searching again" banner;
// hit-path case-sensitivity unverifiable without a real cert.
//
// Inputs: documentId (public identifier printed on the cert) + date of birth
// (from the profile's registry-verified birthDate where present, else prompt).
// DOB formatting: profile birthDate is an ISO instant serialized at UTC
// midnight (verified against the live EE registry 2026-07-20 — see the note in
// adapters/ee.ts), so `YYYY-MM-DD` is the plain UTC string slice — NO timezone
// math, which would shift the calendar day for any non-UTC server locale.

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";

const DEFAULT_BASE = "https://coccec.mcga.gov.uk";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_UK
  ) {
    return process.env.REGISTRY_BASE_UK;
  }
  return DEFAULT_BASE;
}

// ISO instant -> `YYYY-MM-DD` by UTC string slice (plan §3): registry-served
// birthDate instants are UTC-midnight, so the date prefix IS the calendar day
// regardless of the "+00:00"/"Z" offset spelling. Never `new Date()` math — a
// local-timezone conversion of e.g. "1990-01-01T23:00:00Z" could shift a day.
// Also accepts an already-plain "YYYY-MM-DD" (prompted input). Returns "" for
// anything that does not start with a date.
export function ukFormatDob(iso: string): string {
  const s = (iso ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// ---- Pure HTML verdict parsing (fixture-tested) --------------------------

// Both observed wordings: "No CoC Record Found" (2026-07) and the generalized
// "No Record Found" (2026-08, after the multi-doc-type checker update).
const NO_MATCH_BANNER = /No\s+(?:CoC\s+)?Record\s+Found/i;
// A POSITIVE "this certificate is not valid" verdict, distinct from a miss.
const NOT_VALID_BANNER = /\b(?:certificate|record)[^<.]{0,80}\b(?:not\s+valid|no\s+longer\s+valid|suspended|revoked|cancelled)\b/i;

// Extract GOV.UK summary-list rows (dt/dd pairs) into a key->value map.
function summaryRows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /<dt[^>]*class="[^"]*govuk-summary-list__key[^"]*"[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*class="[^"]*govuk-summary-list__value[^"]*"[^>]*>([\s\S]*?)<\/dd>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const key = tidy(m[1].replace(/<[^>]+>/g, "")).toLowerCase();
    const val = tidy(m[2].replace(/<[^>]+>/g, ""));
    if (key) out[key] = val;
  }
  return out;
}

function isoDate(value: string): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00+00:00`;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString();
}

// PURE response→outcome mapping (§2.2). `raw` is the results-page HTML.
export function parseUK(raw: string | object, code: string): AdapterOutcome {
  const html = typeof raw === "string" ? raw : "";
  if (!html.trim()) return { kind: "indeterminate", reason: "empty-response" };

  // Definitive miss banner (real fixture) — no record under this id+DOB.
  if (NO_MATCH_BANNER.test(html)) return { kind: "no-match" };

  const rows = summaryRows(html);
  const status = (rows["status"] ?? "").toLowerCase();
  const fullName = rows["name"] ?? rows["holder name"] ?? "";
  const certificateType =
    rows["certificate type"] || rows["certificate"] || rows["document type"] || "";
  const expiry = rows["expiry date"] || rows["valid until"] || "";

  // POSITIVE invalid verdict: either an explicit banner or a summary Status
  // that negates validity.
  const statusInvalid = /\b(expired|not\s+valid|invalid|suspended|revoked|cancelled)\b/.test(status);
  const statusValid = /\bvalid\b/.test(status) && !statusInvalid;

  // High-confidence match markers: a summary list echoing the certificate.
  const looksLikeMatch = Object.keys(rows).length > 0 && (fullName || certificateType);

  if (!looksLikeMatch) {
    if (NOT_VALID_BANNER.test(html)) {
      return {
        kind: "match-invalid",
        cert: minimalCert(code, "", "", "", false),
      };
    }
    // Unknown page shape (markup drift, error page) — never a verdict.
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  const invalid = statusInvalid || (!statusValid && NOT_VALID_BANNER.test(html));
  const cert = minimalCert(code, fullName, certificateType, isoDate(expiry), !invalid);
  return invalid ? { kind: "match-invalid", cert } : { kind: "match-valid", cert };
}

function minimalCert(
  code: string,
  fullName: string,
  certificateType: string,
  validUntil: string,
  isValid: boolean
): VerifiedCert {
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    ok: true,
    code,
    docCategory: "competency",
    hasName: fullName.length > 0,
    fullName,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
    title: certificateType || "UK Certificate of Competency",
    personalCode: "",
    // The checker does not echo the DOB back — never store the lookup DOB here.
    birthDate: "",
    status: isValid ? "valid" : "invalid",
    isValid,
    issuedOn: "",
    validUntil,
    certificateType: certificateType || "Certificate of Competency",
    issuerCountry: "United Kingdom",
    institution: "",
    documentType: "",
    sourceUrl: `${DEFAULT_BASE}/Certificate-Search-Results/`,
    photoUrl: undefined,
    registryCountry: "UK",
    keyTrust: "public-identifier", // documentId+DOB are printed/knowable (§2.5)
    verifiedSource: "government",
  };
}

// Adapter verify (auto). Inputs: `code` (Document ID) + `dob` (ISO instant or
// YYYY-MM-DD — formatted by UTC slice). The dispatcher guarantees `dob` via the
// §5.2 needs-inputs prompt; missing here anyway → indeterminate, never a verdict.
export async function verifyUK(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  const dob = ukFormatDob(inputs.dob ?? "");
  if (!code) return { kind: "no-match" };
  if (!dob) return { kind: "indeterminate", reason: "missing-input:dob" };

  let res;
  try {
    // Trailing slash matters: the bare path 301s back to the form (dossier §2).
    res = await fetchWithGuard(
      `${base()}/Certificate-Search-Results/?documentId=${encodeURIComponent(code)}&date=${encodeURIComponent(dob)}`,
      { headers: { Accept: "text/html" } }
    );
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  return parseUK(res.bodyText, code);
}
