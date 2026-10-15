// Bulgaria — IA "Morska Administratsia" / Bulgarian Maritime Administration
// (plan §3 Wave 2, capability "auto-presence").
//
// Wire format CONFIRMED live 2026-07-20 (dossier bulgaria.md):
//
//   POST /seaman/validate   (application/x-www-form-urlencoded)
//     identifier=<EGN or LNCh>&doc_number=<certificate number>&culture=en
//     -> JSON, HTTP 200 even on failure:
//        miss  : {"success":false,"error":"An error occurred. Please contact
//                 verification@marad.bg for verification","canPrint":false}
//                (REAL fixture bg-nomatch.json — same generic body for garbage
//                 AND checksum-valid unknown EGNs) → `no-match`, NEVER invalid
//        match : {"valid":true,"document":{"image":<…>},"canPrint":true}
//                (shape read from the site's own client JS — the success body
//                 renders the certificate as an IMAGE)
//        400   : express-validator {"error": "..."} on malformed input.
//
// PRESENCE-ONLY SEMANTICS (§2.5): a hit proves the document EXISTS in the
// registry (covers certificates issued 2017+ only); it does NOT verify the
// holder and — until proven otherwise — presence ≠ validity (the dossier could
// not confirm whether EXPIRED certs are also served). Every hit is therefore a
// name-less VerifiedCert with verifiedSource:"registry": stored as a teal
// "Registry-confirmed — holder not verified" document, NEVER a green Valid,
// never an identity write, never an outward proof.
//
// SENSITIVE INPUT (§2.4): the EGN/LNCh is the holder's national personal
// number. It is pass-through only — POST body only, never persisted (stripped
// by stripSensitiveInputs before any store), never logged, never echoed in any
// reason/error string, and it reaches the result cache only as a SHA-256 digest.
//
// R10 TRIPWIRE: the live form carries an EMPTY, INACTIVE reCAPTCHA placeholder.
// If a response ever comes back as an active challenge instead of JSON, parseBG
// maps it to indeterminate (reason "captcha-active") — the auto-demote path is
// a one-line countries.ts capability flip to "assisted"; CAPTCHA is never solved.

import type { VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { REGISTRY_USER_AGENT } from "./fr";

const DEFAULT_BASE = "https://online.marad.bg";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_BG
  ) {
    return process.env.REGISTRY_BASE_BG;
  }
  return DEFAULT_BASE;
}

// PURE response→outcome mapping (§2.2). Takes the HTTP status (400 is the
// express-validator input-rejection path). `code` is the DOCUMENT number — the
// EGN is deliberately NOT a parameter here, so no code path can echo it.
export function parseBG(status: number, raw: string | object, code: string): AdapterOutcome {
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

  // R10 tripwire: an active CAPTCHA challenge instead of the JSON API answer.
  // Indeterminate + the demote hint — NEVER solved, NEVER a verdict.
  if (!d && typeof raw === "string" && /recaptcha|g-recaptcha|hcaptcha/i.test(raw)) {
    return {
      kind: "indeterminate",
      reason: "captcha-active (reCAPTCHA placeholder has been activated — demote BG to 'assisted' in countries.ts, policy R10)",
    };
  }
  if (!d) return { kind: "indeterminate", reason: "unrecognized-response" };

  // 400 = express-validator rejected OUR input — an input error, not a verdict.
  if (status === 400) return { kind: "indeterminate", reason: "input-rejected" };
  if (status !== 200) return { kind: "indeterminate", reason: `http-${status}` };

  // Documented generic failure body → definitive miss for THIS registry.
  // NEVER match-invalid: a presence-only source cannot assert invalidity (§3.1).
  if (d.success === false) return { kind: "no-match" };

  // Match: the client-code-documented success shape — the certificate image.
  const docField = d.document as Record<string, unknown> | null | undefined;
  const image = docField && typeof docField.image === "string" ? docField.image : "";
  if (d.valid === true && image) {
    const cert: VerifiedCert = {
      ok: true,
      code,
      docCategory: "competency",
      // Presence-only: the registry returns an IMAGE, no structured holder —
      // name-less by design (§2.5 rule 4: can never name a profile).
      hasName: false,
      fullName: "",
      firstName: "",
      lastName: "",
      title: "Bulgarian certificate — registry-confirmed (covers 2017+)",
      personalCode: "",
      birthDate: "",
      status: "registry-confirmed",
      isValid: true, // presence, not a validity verdict — teal badge, never emerald
      issuedOn: "",
      validUntil: "",
      certificateType: "Certificate of competency",
      issuerCountry: "Bulgaria",
      institution: "",
      documentType: "",
      sourceUrl: `${DEFAULT_BASE}/seaman`,
      photoUrl: undefined,
      registryCountry: "BG",
      keyTrust: "public-identifier", // EGN + doc number are knowable by a third party (§2.5)
      verifiedSource: "registry", // §2.5: presence → registry-confirmed doc, NOT government
    };
    return { kind: "match-valid", cert };
  }

  return { kind: "indeterminate", reason: "unrecognized-response" };
}

// Adapter verify (auto-presence). Inputs: `code` (the document number — pasted)
// + `egn` (SENSITIVE — prompted, pass-through only). The EGN goes into the POST
// body and NOWHERE else: not the URL (fetchWithGuard journals host+path only),
// not the reasons, not the returned cert.
export async function verifyBG(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  const egn = (inputs.egn ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!egn) return { kind: "indeterminate", reason: "missing-input:egn" };

  let res;
  try {
    const body = new URLSearchParams({
      identifier: egn,
      doc_number: code,
      culture: "en",
    }).toString();
    res = await fetchWithGuard(`${base()}/seaman/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": REGISTRY_USER_AGENT,
      },
      body,
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  return parseBG(res.status, res.bodyText, code);
}
