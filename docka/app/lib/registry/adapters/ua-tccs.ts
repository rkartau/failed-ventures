// Ukraine — TCCS Odessa training-center validator (plan §3 "tc" row).
// tccs.online = IPE "Training Center for Certification of Seafarers", a unit of
// the state NU "Odessa Maritime Academy" — legitimate but a TRAINING CENTER,
// NOT the government seafarer registry (issuerKind:"training-center"). Every
// result therefore carries verifiedSource:"registry" (teal registry-confirmed
// document) and can NEVER claim government verification (§2.5).
//
// Wire format captured live 2026-07-20 (dossier tccs-online.md):
//
//   POST /en/validate-certificate/   (application/x-www-form-urlencoded)
//     surname=<holder surname>&certificate_number=<~8-digit number>&submit=Search
//     -> HTTP 200, full HTML page; the result renders inside
//        <div class="enquire_form validation-form-wrapper">.
//
// Miss semantics (§3.1): the OBSERVED miss text is the AMBIGUOUS
//   "Please contact us at info@tccs.online to validate this certificate"
// — it says "contact us", not "not found", so it maps to `indeterminate`,
// NEVER `match-invalid` and never even a definitive `no-match`.
//
// The HIT page was NOT observed live (no valid TCCS number was available), so
// the valid/expired fixtures are SYNTHETIC and parseTCCS answers ONLY on
// high-confidence markers: the result wrapper, the ECHO of the searched
// certificate number, and an explicit "is valid" / "has expired" wording.
// Anything that drifts → indeterminate.

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { REGISTRY_USER_AGENT } from "./fr";

const DEFAULT_BASE = "https://tccs.online";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_UA
  ) {
    return process.env.REGISTRY_BASE_UA;
  }
  return DEFAULT_BASE;
}

// dd.mm.yyyy (the site's date style) or yyyy-mm-dd -> ISO instant at UTC
// midnight. String rearrangement only — no Date()/timezone math.
function uaIsoDate(value: string): string {
  const v = tidy(value);
  let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T00:00:00+00:00`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${v}T00:00:00+00:00`;
  return "";
}

// PURE response→outcome mapping (§2.2). `raw` is the full page HTML; `code` is
// the searched certificate number (used for the echo guard).
export function parseTCCS(raw: string | object, code: string): AdapterOutcome {
  // Strip HTML comments first — annotations (incl. in recorded fixtures) must
  // never be mistaken for page content.
  const html = (typeof raw === "string" ? raw : "").replace(/<!--[\s\S]*?-->/g, "");
  if (!html.trim()) return { kind: "indeterminate", reason: "empty-response" };

  // OBSERVED ambiguous miss — "contact us" is NOT a verdict (§3.1): the
  // certificate may exist and simply predate the online index. NEVER invalid.
  if (/please\s+contact\s+us\s+at\s+info@tccs\.online/i.test(html)) {
    return { kind: "indeterminate", reason: "ambiguous-miss (contact-us page — never a verdict)" };
  }
  // Default page (no result rendered at all).
  if (/fill\s+up\s+the\s+form\s+to\s+check\s+certificate\s+validity/i.test(html)) {
    return { kind: "indeterminate", reason: "no-result-rendered" };
  }

  // High-confidence hit markers: the result wrapper AND the echoed number.
  const hasWrapper = /validation-form-wrapper/i.test(html);
  const text = tidy(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " "));
  const echoesCode = code.length > 0 && text.includes(code);
  if (!hasWrapper || !echoesCode) {
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  // Explicit verdict wording — negative before positive ("is not valid" would
  // otherwise match "is valid").
  const expired = /\b(has\s+expired|is\s+not\s+valid|invalid|revoked|annulled)\b/i.test(text);
  const valid = !expired && /\bis\s+valid\b/i.test(text);
  if (!valid && !expired) return { kind: "indeterminate", reason: "unrecognized-response" };

  const surname = tidy((/issued\s+to\s+([\p{L}'’-]+)/iu.exec(text) ?? [])[1] ?? "");
  const course = tidy((/course:\s*([^•|]+?)(?:\s+date\s+of\s+issue|\s+valid\s+until|$)/i.exec(text) ?? [])[1] ?? "");
  const issuedOn = uaIsoDate((/date\s+of\s+issue:\s*([\d.\-]+)/i.exec(text) ?? [])[1] ?? "");
  const validUntil = uaIsoDate((/valid\s+until:\s*([\d.\-]+)/i.exec(text) ?? [])[1] ?? "");

  const cert: VerifiedCert = {
    ok: true,
    code,
    docCategory: "qualification", // STCW training/refresher course certificates
    // The page echoes the SEARCHED surname — holder identity is NOT verified by
    // it; verifiedSource:"registry" keeps this out of every government path.
    hasName: surname.length > 0,
    fullName: surname,
    firstName: "",
    lastName: surname,
    title: course || "TCCS training certificate",
    personalCode: "",
    birthDate: "",
    status: valid ? "valid" : "expired",
    isValid: valid,
    issuedOn,
    validUntil,
    certificateType: course || "Training certificate",
    issuerCountry: "Ukraine",
    institution: "Training Centre for Certification of Seafarers — Odessa Maritime Academy",
    documentType: "Training certificate",
    sourceUrl: `${DEFAULT_BASE}/en/validate-certificate/`,
    photoUrl: undefined,
    registryCountry: "UA",
    keyTrust: "public-identifier", // surname + cert number are printed on the cert (§2.5)
    verifiedSource: "registry", // training center — NEVER government (§2.5)
  };
  return valid ? { kind: "match-valid", cert } : { kind: "match-invalid", cert };
}

// Adapter verify (auto). Inputs: `code` (certificate number — pasted) +
// `surname` (prompted — never auto-split from a stored full name).
export async function verifyTCCS(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  const surname = (inputs.surname ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!surname) return { kind: "indeterminate", reason: "missing-input:surname" };

  let res;
  try {
    const body = new URLSearchParams({
      surname,
      certificate_number: code,
      submit: "Search",
    }).toString();
    res = await fetchWithGuard(`${base()}/en/validate-certificate/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": REGISTRY_USER_AGENT,
      },
      body,
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  return parseTCCS(res.bodyText, code);
}
