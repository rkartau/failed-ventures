// Norway — Sjøfartsdirektoratet / Norwegian Maritime Authority (plan §3,
// promoted into Wave 1 — confirmed auto).
//
// Wire format CONFIRMED live 2026-07-20 (dossier norway.md): the SPA at
// https://verify.certificate.sdir.no is static; lookups go cross-origin to
// Azure API Management —
//
//   POST https://sdir-p-apim-common.azure-api.net
//        /aps-personalcertificate-internal/v3/verifycertificate/bynumberandidentity
//   headers: Content-Type: application/json, Accept-Language: nb,
//            Ocp-Apim-Subscription-Key: <public front-end key, see below>
//   body:    {"certificateNumber":"<certno>","dateofBirth":"YYYY-MM-DD"}
//            (⚠ the field really is spelled `dateofBirth` — lowercase "of")
//
// Miss semantics (§3.1): HTTP **404** with an RFC-9110 problem+json body (real
// fixture no-notfound.json) → `no-match`. A valid cert returns 200 with
// certificate details — schema NOT observed live (no valid sample existed), so
// the valid fixture is SYNTHETIC and the 200-parser only answers `match-valid`
// on an explicit positive validity signal; unknown shapes → indeterminate
// (never a false green — plan R2).
//
// The SSN / D-number lookup path is deliberately NOT built (sensitive — §3).

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { ukFormatDob } from "./uk";

const DEFAULT_BASE = "https://sdir-p-apim-common.azure-api.net";
const VERIFY_PATH =
  "/aps-personalcertificate-internal/v3/verifycertificate/bynumberandidentity";

// PUBLIC front-end APIM subscription key, baked into the verify.certificate.sdir.no
// SPA bundle and sent by every browser client (captured live in the 2026-07-20
// dossier). It is a public constant — NOT a secret, NOT a credential — but the
// APIM gateway rejects calls without it, so it lives here beside the pinned URL.
const OCP_APIM_SUBSCRIPTION_KEY = "cc74bc426b1b4b5cb0aa5f5b9ab2662a";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_NO
  ) {
    return process.env.REGISTRY_BASE_NO;
  }
  return DEFAULT_BASE;
}

// PURE response→outcome mapping (§2.2). Takes the HTTP status because Norway's
// miss signal IS the status (404 problem+json), unlike Denmark's in-body miss.
export function parseNO(status: number, raw: string | object, code: string): AdapterOutcome {
  if (status === 404) return { kind: "no-match" };
  if (status !== 200) return { kind: "indeterminate", reason: `http-${status}` };

  let d: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      d = null;
    }
  } else if (raw && typeof raw === "object") {
    d = raw as Record<string, unknown>;
  }
  if (!d) return { kind: "indeterminate", reason: "unrecognized-response" };

  // Defensive extraction — the 200 schema is synthetic-fixture-defined, so a
  // verdict needs an EXPLICIT validity signal; anything else is indeterminate.
  const statusText = (tidy(d.status) || tidy(d.certificateStatus)).toLowerCase();
  const boolValid =
    d.isValid === true || d.valid === true
      ? true
      : d.isValid === false || d.valid === false
        ? false
        : null;
  const negative = /\b(expired|invalid|not\s+valid|revoked|suspended|withdrawn|ugyldig|utløpt)\b/.test(
    statusText
  );
  const positive = boolValid === true || (/\b(valid|gyldig)\b/.test(statusText) && !negative);
  const explicitInvalid = boolValid === false || negative;

  const hasRecord = !!(tidy(d.certificateNumber) || tidy(d.certificateName) || tidy(d.name));
  if (!hasRecord || (!positive && !explicitInvalid)) {
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  const firstName = tidy(d.firstName);
  const lastName = tidy(d.lastName) || tidy(d.surname);
  const fullName = tidy(`${firstName} ${lastName}`) || tidy(d.name);
  const certificateType = tidy(d.certificateName) || tidy(d.certificateType) || "Norwegian certificate";

  const cert: VerifiedCert = {
    ok: true,
    code,
    docCategory: "competency",
    hasName: fullName.length > 0,
    fullName,
    firstName,
    lastName: fullName ? lastName : "",
    title: certificateType,
    personalCode: "",
    birthDate: tidy(d.dateOfBirth) || tidy(d.dateofBirth),
    status: positive ? "valid" : "invalid",
    isValid: positive,
    issuedOn: tidy(d.validFrom) || tidy(d.issuedDate),
    validUntil: tidy(d.validTo) || tidy(d.expiryDate),
    certificateType,
    issuerCountry: "Norway",
    institution: "",
    documentType: "",
    sourceUrl: "https://verify.certificate.sdir.no/#/certificate",
    photoUrl: undefined,
    registryCountry: "NO",
    keyTrust: "public-identifier", // cert number + DOB are printed/knowable (§2.5)
    verifiedSource: "government",
  };
  return positive ? { kind: "match-valid", cert } : { kind: "match-invalid", cert };
}

// Adapter verify (auto). Inputs: `code` (certificate number) + `dob` (ISO
// instant or YYYY-MM-DD — same UTC-slice rule as the UK adapter).
export async function verifyNO(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  const dob = ukFormatDob(inputs.dob ?? "");
  if (!code) return { kind: "no-match" };
  if (!dob) return { kind: "indeterminate", reason: "missing-input:dob" };

  let res;
  try {
    res = await fetchWithGuard(`${base()}${VERIFY_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "nb",
        "Ocp-Apim-Subscription-Key": OCP_APIM_SUBSCRIPTION_KEY,
      },
      // ⚠ dossier-confirmed spelling: `dateofBirth`, not `dateOfBirth`.
      body: JSON.stringify({ certificateNumber: code, dateofBirth: dob }),
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  return parseNO(res.status, res.bodyText, code);
}
