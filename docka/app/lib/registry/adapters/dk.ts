// Denmark — Søfartsstyrelsen / Danish Maritime Authority (plan §3 Wave 1).
//
// Wire format CONFIRMED live 2026-07-20 (dossier denmark.md): the portal at
// https://verify.dma.dk is an Angular SPA over a same-origin JSON backend —
//
//   POST /api/validate  {"code":"<certno>"}
//     -> {"validationResult":<bool>,"validationMetadata":<null|obj>,"imagesId":<null|id>}
//
// covering STCW / SHIP / MEDICAL certificates in one endpoint (the backend
// resolves the category from the code itself). No auth, no API key, no CAPTCHA.
//
// Miss semantics (§3.1): a miss is HTTP **200** with a negative IN-BODY result
// (`validationResult:false`, metadata/imagesId null — real fixture
// dk-negative-result.json) → `no-match`, NOT a 404. No distinct "revoked"
// signal was observed, so a negative body is always the documented miss.
//
// §2.5 trust classes — per lookup MODE, resolved by DETECTION, not here:
//   bare cert number          -> public-identifier (printed on the cert)
//   /validateqr/<code> QR URL -> capability-token (unguessable deep-link token)
// The dispatcher stamps `keyTrust` from the candidate's mode downstream of the
// result cache; `parseDK` takes the mode only so fixture tests can assert both.

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome, RegistryKeyKind } from "../types";
import { fetchWithGuard } from "../index";

const DEFAULT_BASE = "https://verify.dma.dk";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1 — never redirectable on the Hetzner box.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_DK
  ) {
    return process.env.REGISTRY_BASE_DK;
  }
  return DEFAULT_BASE;
}

// PURE response→outcome mapping (fixture-tested, separated from fetch — §2.2).
export function parseDK(
  raw: string | object,
  code: string,
  mode: RegistryKeyKind = "public-identifier"
): AdapterOutcome {
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
  // Malformed / shape drift → indeterminate, NEVER a verdict (plan R2).
  if (!d || typeof d.validationResult !== "boolean") {
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  if (d.validationResult === false) {
    // Documented in-body miss (HTTP 200) — definitive for THIS registry.
    return { kind: "no-match" };
  }

  // validationResult:true — the registry positively validated the code. The
  // exact validationMetadata schema is not dossier-observed (no valid sample
  // cert existed), so field extraction is defensive: read the common shapes,
  // fall back to a name-less minimal cert. Validity itself comes from the
  // boolean, never from clock math here.
  const meta = (d.validationMetadata ?? {}) as Record<string, unknown>;
  const firstName = tidy(meta.firstName) || tidy(meta.firstname);
  const lastName = tidy(meta.lastName) || tidy(meta.lastname) || tidy(meta.surname);
  const fullName = tidy(`${firstName} ${lastName}`) || tidy(meta.name) || tidy(meta.fullName);
  const certificateType =
    tidy(meta.certificateName) || tidy(meta.certificateType) || tidy(meta.type) || "STCW certificate";

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
    birthDate: tidy(meta.dateOfBirth) || tidy(meta.birthDate),
    status: "valid",
    isValid: true,
    issuedOn: tidy(meta.issueDate) || tidy(meta.issuedOn) || tidy(meta.validFrom),
    validUntil: tidy(meta.expiryDate) || tidy(meta.validUntil) || tidy(meta.validTo),
    certificateType,
    issuerCountry: "Denmark",
    institution: "",
    documentType: tidy(meta.category),
    sourceUrl: `${DEFAULT_BASE}/validate/${encodeURIComponent(code)}`,
    photoUrl: undefined,
    registryCountry: "DK",
    keyTrust: mode,
    verifiedSource: "government",
  };
  return { kind: "match-valid", cert };
}

// Adapter verify (auto). Inputs: `code` (the certificate number — from a bare
// paste OR extracted from a /validate|/validateqr deep link by detection).
export async function verifyDK(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  if (!code) return { kind: "no-match" };

  let res;
  try {
    res = await fetchWithGuard(`${base()}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  // The documented miss is IN-BODY on a 200; any non-200 is unexpected drift.
  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  return parseDK(res.bodyText, code);
}
