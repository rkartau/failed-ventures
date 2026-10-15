// Azerbaijan — Dövlət Dəniz və Liman Agentliyi / State Maritime and Port
// Agency (DDLA), countries.ts "AZ" entry (wired 2026-08-24).
//
// Wire format CONFIRMED live 2026-08-24 (evidence: az fixture README):
//
//   POST https://publicservices.ddla.gov.az/seamencheck/check
//   headers: Content-Type: application/json
//   body:    {"type":"competency","code":"NNNNNN/YY","birth":"YYYY-MM-DD"}
//
// No CAPTCHA, no login, no cookies, no CSRF enforcement — a bare JSON POST
// answers. type ∈ {competency, training, dss, dqk}; v1 wires COMPETENCY ONLY
// (verify-upload of this doc class IS a CoC; dss/dqk use different response
// columns with client-side expiry math — documented v2 path).
//
// Hit (HTTP 200): {"status":"success","person":{ADI,SOYADI,DOG_IL,image_url},
//   "data":[{kod,certkod,DV,DO,D_BADI,VZF_BADI,status}]} — the row `status`
//   is computed SERVER-side ("Valid"/"Expired"); this adapter NEVER computes
//   a verdict from the dates client-side (the registry verdict is
//   authoritative; vocab drift surfaces as indeterminate, not a wrong
//   verdict). Miss: status != "success" + message (per the portal check.js).
//
// The app is unversioned Laravel (check.js?v=da52505b8115) — the exact field
// names are pinned by the contract-drift fixture test, and BOTH row-selection
// branches below additionally require parseable DV+DO so a renamed date
// column surfaces loudly as indeterminate, never as a dateless "valid".
//
// PII (HARD RULE): the response carries the holder's PHOTO in
// `person.image_url` — it is NEVER read, logged, or persisted; photoUrl stays
// undefined. The registry holder ID `kod` is NOT mapped (personalCode stays
// "") — a second stored person-linked identifier with no consumer.

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { ukFormatDob } from "./uk";

const DEFAULT_BASE = "https://publicservices.ddla.gov.az";
const CHECK_PATH = "/seamencheck/check";
const PORTAL_URL = "https://publicservices.ddla.gov.az/seamencheck";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_AZ
  ) {
    return process.env.REGISTRY_BASE_AZ;
  }
  return DEFAULT_BASE;
}

/**
 * Wire form of the certificate number. The planner emits the NORMALIZED code
 * (genericNormalize strips the printed "/"), so the unambiguous 8-digit form
 * is restored to the printed "NNNNNN/YY" ("12345624" → "123456/24"); an
 * already-slashed code (direct callers, stored recheck inputs, the
 * registry-health probe) passes through verbatim. Anything else returns null
 * — a DEFINITIONAL miss (an AZ cert number is 6+2 digits), mapped to
 * `no-match` WITHOUT fetching (Decision 11/13: "indeterminate" would show
 * "try again" for an input that can never succeed; mirrors NO's empty-code
 * no-match). Exported for unit tests.
 */
export function azWireCode(code: string): string | null {
  const s = (code ?? "").trim();
  if (/^\d{6}\/\d{2}$/.test(s)) return s; // already-slashed: verbatim (defense)
  const m = /^(\d{6})(\d{2})$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

// "Parseable date" for the DV/DO guard: plain YYYY-MM-DD (the registry's wire
// format). Reuses the UK UTC-slice rule — never local-timezone Date math.
function parseableDate(v: unknown): string {
  return ukFormatDob(tidy(v));
}

// A plain (non-array) JSON object, or null. Hoisted so the 200 and 404 branches
// share ONE parse: a body-parse failure, a non-object, or an array all collapse
// to null (treated as "not a plain object").
function asPlainObject(raw: string | object): Record<string, unknown> | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

// The DDLA miss shape (portal check.js), gated on PRESENCE/TYPE only — never the
// English message text (locale-fragile): a plain object whose `status` is a
// string other than "success" AND which carries a non-empty string `message`.
// This is the SINGLE predicate both the 200 and 404 miss branches use, so a
// malformed error envelope (no/blank message, non-string status) can never be
// mistaken for a definitive miss — it stays indeterminate (the safe direction).
function isAZMissBody(d: Record<string, unknown> | null): boolean {
  return (
    !!d &&
    typeof d.status === "string" &&
    d.status !== "success" &&
    typeof d.message === "string" &&
    d.message.trim() !== ""
  );
}

// PURE response→outcome mapping (§2.2), exported for fixture tests. Takes the
// HTTP status; `code` is the WIRE (slash) form used in the request.
//
// STRICT HTTP-status allowlist (2026-09-08 fix): a certificate MISS can arise
// ONLY from 200 or 404 — DDLA signals a real miss as HTTP 404 + a
// status!="success" body (adopting the no.ts status-code-first idiom). A 404 can
// NEVER become a hit; outage/WAF/rate-limit/malformed (5xx/403/429/400/…) stay
// indeterminate, never no-match.
export function parseAZ(status: number, raw: string | object, code: string): AdapterOutcome {
  // Parse the body ONCE, before branching (shared by 200 and 404).
  const d = asPlainObject(raw);

  if (status === 200) {
    // A hit is reachable ONLY here: 200 + status "success" + a certificate row.
    if (d && d.status === "success") {
      // Row selection: certkod match first; else EXACTLY ONE row that carries a
      // certkod. Never guess among multiple rows.
      const rows = Array.isArray(d.data) ? (d.data as Record<string, unknown>[]) : [];
      let row = rows.find((r) => r && tidy(r.certkod) === code) ?? null;
      if (!row && rows.length === 1 && rows[0] && tidy(rows[0].certkod)) row = rows[0];
      if (!row) return { kind: "indeterminate", reason: "unrecognized-response" };

      // Date guard on BOTH branches (round-2 amendment): the selected row —
      // certkod-matched OR single-row fallback — must carry parseable DV + DO.
      // Renamed date columns in the unversioned app surface loudly as
      // indeterminate instead of a dateless valid.
      const issuedOn = parseableDate(row.DV);
      const validUntil = parseableDate(row.DO);
      if (!issuedOn || !validUntil) return { kind: "indeterminate", reason: "unrecognized-response" };

      // Registry verdict, verbatim vocabulary — NEVER computed from dates.
      const rowStatus = tidy(row.status);
      const positive = rowStatus === "Valid";
      const negative = rowStatus === "Expired";
      if (!positive && !negative) return { kind: "indeterminate", reason: "unrecognized-response" };

      const person = (d.person && typeof d.person === "object" ? d.person : {}) as Record<
        string,
        unknown
      >;
      // PII: person.image_url is deliberately NEVER read here.
      const firstName = tidy(person.ADI);
      const lastName = tidy(person.SOYADI);
      const fullName = tidy(`${firstName} ${lastName}`);
      const certName = tidy(row.D_BADI) || "Certificate of Competency";
      const position = tidy(row.VZF_BADI);

      const cert: VerifiedCert = {
        ok: true,
        code, // wire (slash) form
        docCategory: "competency",
        hasName: fullName.length > 0,
        fullName,
        firstName,
        lastName,
        title: position ? `${certName} — ${position}` : certName,
        personalCode: "", // registry `kod` NOT mapped (Decision 13b)
        birthDate: tidy(person.DOG_IL),
        status: positive ? "valid" : "invalid",
        isValid: positive,
        issuedOn,
        validUntil,
        certificateType: certName,
        issuerCountry: "Azerbaijan",
        institution: "",
        documentType: position,
        sourceUrl: PORTAL_URL,
        photoUrl: undefined, // HARD RULE — the registry photo never crosses this boundary
        registryCountry: "AZ",
        keyTrust: "public-identifier", // cert number + DOB are printed on the document (§2.5)
        verifiedSource: "government",
      };
      return positive ? { kind: "match-valid", cert } : { kind: "match-invalid", cert };
    }
    // 200 but not a success envelope: a well-formed miss body → no-match; any
    // other shape (non-JSON, no/blank message, non-string status) → the SAFE
    // indeterminate. This unifies the 200 miss under the same message-required
    // predicate as 404 (deliberate hardening — az-miss.json carries a message).
    if (isAZMissBody(d)) return { kind: "no-match" };
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  if (status === 404) {
    // The real DDLA miss (2026-09-08): 404 + status!="success" + message.
    if (isAZMissBody(d)) return { kind: "no-match" };
    return { kind: "indeterminate", reason: "http-404-unrecognized" };
  }

  // Any OTHER status (5xx/403/429/400/…): fail-safe indeterminate, never a miss.
  return { kind: "indeterminate", reason: `http-${status}` };
}

// Adapter verify (auto). Inputs: `code` (normalized or slashed certificate
// number) + `dob` (ISO instant or YYYY-MM-DD — UK UTC-slice rule).
export async function verifyAZ(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = azWireCode(inputs.code ?? "");
  if (!code) return { kind: "no-match" }; // definitional miss — no fetch (Decision 11)
  const birth = ukFormatDob(inputs.dob ?? "");
  // Defense behind missingInputsFor (NO precedent) — the dispatcher prompts
  // before ever calling this without a dob.
  if (!birth) return { kind: "indeterminate", reason: "missing-input:dob" };

  let res;
  try {
    res = await fetchWithGuard(`${base()}${CHECK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
      // v1 wires competency ONLY (countries.ts entry notes — v2 path).
      body: JSON.stringify({ type: "competency", code, birth }),
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  return parseAZ(res.status, res.bodyText, code);
}
