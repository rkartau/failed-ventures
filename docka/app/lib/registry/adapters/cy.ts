// Cyprus — Shipping Deputy Ministry / Department of Merchant Shipping.
//
// Wire format CONFIRMED live 2026-08-12 from the PRODUCTION box (EU egress) —
// the deploy-time probe this adapter always waited for (plan §3 / R1). The
// /emarcos/ ROOT still answers 403 (WAF), but the DEEP form path is open:
//
//   1. GET  /emarcos/cert_ver/stcw/sea_auth_search_form.php
//        -> 200 plain PHP form (Apache/Win32, PHP 5.6) + Set-Cookie PHPSESSID.
//           Fields: sea_id (Seafarer ID) + cert_no (Certificate No), submit
//           button name="search" value="search". No CSRF token, no CAPTCHA.
//   2. POST the same path (form-urlencoded, Cookie: PHPSESSID=…)
//        sea_id=…&cert_no=…&search=search
//        -> 200: the form re-rendered, plus the verdict below it:
//           miss -> <div class="alert alert-danger">The Certificate was not
//                   found</div>  (REAL fixture cy-nomatch.html) → `no-match`
//           hit  -> NOT observed live (no valid specimen pair exists) — the
//                   valid/invalid fixtures stay SYNTHETIC, so the parser only
//                   answers on explicit keyword signals and anything unknown
//                   maps to indeterminate, never invalid (§3.1 / plan R2).
//
// Capability flipped "unverified-endpoint" -> "auto" in countries.ts the same
// day (the one-line flip this file was built for).

import type { VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { REGISTRY_USER_AGENT } from "./fr";

const DEFAULT_BASE = "https://eservices.dms.gov.cy";
// The pinned DEEP path — the /emarcos/ root 403s (WAF), this form does not.
const FORM_PATH = "/emarcos/cert_ver/stcw/sea_auth_search_form.php";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_CY
  ) {
    return process.env.REGISTRY_BASE_CY;
  }
  return DEFAULT_BASE;
}

// PURE response→outcome mapping. Every verdict requires an explicit,
// CERTIFICATE-ANCHORED keyword signal and everything else is indeterminate
// (never a false green, never a false invalid — plan R2). Anchoring style
// mirrors uk.ts's NOT_VALID_BANNER: the verdict word only counts within ~80
// chars of "certificate"/"record" in the SAME text node and sentence
// ([^<.]{0,80} can bridge neither a tag nor a period), matching the structure
// of the real alert-div capture ("The Certificate was not found" inside
// <div class="alert alert-danger">). Drifted pages with bare verdict words
// ("Your session has expired", "please enter a valid certificate number")
// therefore map to indeterminate, never a verdict. The miss wording is REAL
// (captured 2026-08-12); the positive wordings remain documented-shape
// keywords until a live hit sample exists.

// Definitive miss — the REAL anchored wording ("The Certificate was not
// found") plus the self-anchored older phrasings.
const CY_NO_MATCH =
  /\b(?:certificate|record)\b[^<.]{0,80}\bnot\s+found\b|\bno\s+(?:records?|results?)\s+found\b/i;
// POSITIVE invalid verdict — negation word anchored to certificate/record.
const CY_MATCH_INVALID =
  /\b(?:certificate|record)\b[^<.]{0,80}\b(?:not\s+valid|invalid|expired|revoked|suspended|cancelled)\b/i;
// POSITIVE valid verdict — "is valid" anchored to certificate/record. The old
// bare "valid certificate" alternative is deliberately GONE: instructional
// text like "please enter a valid certificate number" must never verify.
const CY_MATCH_VALID = /\b(?:certificate|record)\b[^<.]{0,80}\bis\s+valid\b/i;

export function parseCY(raw: string | object, code: string): AdapterOutcome {
  const html0 = typeof raw === "string" ? raw : "";
  if (!html0.trim()) return { kind: "indeterminate", reason: "empty-response" };
  // Strip scripts/comments only — tags STAY so [^<.] sentence-scoping holds.
  const html = html0
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  if (CY_NO_MATCH.test(html)) {
    return { kind: "no-match" };
  }

  // POSITIVE invalid before positive valid — "not valid" contains "valid".
  if (CY_MATCH_INVALID.test(html)) {
    return { kind: "match-invalid", cert: cyCert(code, false) };
  }
  if (CY_MATCH_VALID.test(html)) {
    return { kind: "match-valid", cert: cyCert(code, true) };
  }

  return { kind: "indeterminate", reason: "unrecognized-response" };
}

function cyCert(code: string, isValid: boolean): VerifiedCert {
  return {
    ok: true,
    code,
    docCategory: "competency",
    // The result shape carries no structured holder fields — name-less until a
    // real hit capture proves otherwise (§2.5 rule 4 then keeps it from ever
    // naming a profile: bindHolder downgrades it to a teal registry doc).
    hasName: false,
    fullName: "",
    firstName: "",
    lastName: "",
    title: "Cyprus seafarer certificate",
    personalCode: "",
    birthDate: "",
    status: isValid ? "valid" : "invalid",
    isValid,
    issuedOn: "",
    validUntil: "",
    certificateType: "Certificate of Competency",
    issuerCountry: "Cyprus",
    institution: "",
    documentType: "",
    sourceUrl: `${DEFAULT_BASE}${FORM_PATH}`,
    photoUrl: undefined,
    registryCountry: "CY",
    keyTrust: "public-identifier", // sea_id + cert_no are printed/knowable (§2.5)
    verifiedSource: "government",
  };
}

// Adapter verify (auto). Inputs: `code` (certificate number — pasted) +
// `seafarerId` (sea_id, prompted; printed on the cert's top-left corner).
// ONE honest lookup = the same two requests a browser makes: the form GET that
// mints the PHPSESSID + one POST with it.
export async function verifyCY(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = (inputs.code ?? "").trim();
  const seafarerId = (inputs.seafarerId ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!seafarerId) return { kind: "indeterminate", reason: "missing-input:seafarerId" };

  let res;
  try {
    // 1. Session GET (PHP session cookie).
    const form = await fetchWithGuard(`${base()}${FORM_PATH}`, {
      headers: { Accept: "text/html", "User-Agent": REGISTRY_USER_AGENT },
    });
    if (form.status !== 200) return { kind: "indeterminate", reason: `http-${form.status}` };
    const cookie = form.setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");

    // 2. ONE submission, exactly like the served form (search=search included).
    const body = new URLSearchParams({
      sea_id: seafarerId,
      cert_no: code,
      search: "search",
    }).toString();
    res = await fetchWithGuard(`${base()}${FORM_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": REGISTRY_USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  return parseCY(res.bodyText, code);
}
