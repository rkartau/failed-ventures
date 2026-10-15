// Estonia — adapter #1 of the pluggable VerifierRegistry (plan §2.1).
//
// The endpoint table, URL builders and payload normalisation moved here
// VERBATIM from lib/cert.ts, and the four-endpoint fetch loop moved here from
// lib/verify.ts `verifyCode` — lib/cert.ts re-exports the moved symbols so no
// existing import breaks. Estonia's lookup key is a 16-char access token: an
// unguessable capability token (§2.5), so a successful lookup is full-trust
// ("capability-token") and may drive identity self-heal.

import { CATEGORY_LABELS, tidy, type DocCategory, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { currentRegistryResilience, fetchWithGuard } from "../index";

// ---- Endpoint registry (moved from lib/cert.ts) ------------------------

const DEFAULT_API_ROOT = "https://meremees-api.transpordiamet.ee";
const PUBLIC_ROOT = "https://meremees.transpordiamet.ee";

// Mock-registry e2e seam (plan §6.2): the base URL is a pinned constant,
// overridable ONLY outside production AND with REGISTRY_MOCK=1 — the pinned
// allowlist cannot be redirected on the production box.
function apiRoot(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_EE
  ) {
    return process.env.REGISTRY_BASE_EE;
  }
  return DEFAULT_API_ROOT;
}

export const CERT_ENDPOINTS: {
  category: DocCategory;
  apiPath: string; // …/by-access-token/
  publicPath: string; // human-facing registry page
}[] = [
  { category: "competency", apiPath: "/certificates/by-access-token/", publicPath: "/certificates/" },
  { category: "medical", apiPath: "/medical-certificates/by-access-token/", publicPath: "/medical-certificates/" },
  { category: "endorsement", apiPath: "/endorsements/by-access-token/", publicPath: "/endorsements/" },
  { category: "qualification", apiPath: "/qualifications/by-access-token/", publicPath: "/qualifications/" },
];

export function apiUrl(category: DocCategory, code: string): string {
  const ep = CERT_ENDPOINTS.find((e) => e.category === category)!;
  return apiRoot() + ep.apiPath + encodeURIComponent(code);
}

export function publicUrl(category: DocCategory, code: string): string {
  const ep = CERT_ENDPOINTS.find((e) => e.category === category)!;
  return PUBLIC_ROOT + ep.publicPath + code;
}

// ---- Normalisation (moved from lib/cert.ts) ----------------------------

// Increment-1 checklist (plan §7.1) — EE `birthDate` serialization INSPECTED
// against the live registry on 2026-07-20 (competency record for access token
// SAMPLE0SAFETY001): the registry serializes birthDate as an explicit
// UTC-midnight instant, e.g. "2000-09-11T00:00:00+00:00" (issuedOn, validUntil
// and trainingDate use the same shape). A UTC string slice `.slice(0, 10)`
// therefore yields the intended calendar day with NO timezone math — the §3
// UTC-slice rule is SAFE for EE-sourced birthDate values. Note the offset is
// written "+00:00" rather than "Z"; slicing the date prefix is offset-agnostic
// either way. (This governs the UK adapter's DOB formatting in increment 4.)

// Turn a raw registry payload into the common VerifiedCert shape. Medical
// certificates use the MinimalDocumentModel (isValid/issuedOn/validUntil only,
// no name) and are rendered as an anonymous "Medical certificate" card.
export function normalizeCert(
  category: DocCategory,
  code: string,
  d: Record<string, unknown>
): VerifiedCert {
  const isMinimal =
    category === "medical" ||
    tidy(d.type) === "MinimalDocumentModel" ||
    (!d.firstName && !d.lastName && !d.name);

  if (isMinimal) {
    return {
      ok: true,
      code,
      docCategory: category,
      hasName: false,
      fullName: "",
      firstName: "",
      lastName: "",
      title: CATEGORY_LABELS[category],
      personalCode: tidy(d.personalCode),
      birthDate: tidy(d.birthDate),
      status: statusFrom(d),
      isValid: d.isValid === true,
      issuedOn: tidy(d.issuedOn),
      validUntil: tidy(d.validUntil),
      certificateType: CATEGORY_LABELS[category],
      issuerCountry: tidy(d.issuerCountry),
      institution:
        tidy(d.educationalInstitutionNameEng) || tidy(d.educationalInstitutionName),
      documentType: tidy(d.documentType),
      sourceUrl: tidy(d.accessTokenUrl) || publicUrl(category, code),
      photoUrl: undefined,
      registryCountry: "EE",
      keyTrust: "capability-token",
      verifiedSource: "government",
    };
  }

  const firstName = tidy(d.firstName);
  const lastName = tidy(d.lastName);
  const fullName = tidy(`${firstName} ${lastName}`) || tidy(d.name);
  const certificateType =
    tidy(d.certificateTypeLegalName) || tidy(d.name) || CATEGORY_LABELS[category];

  return {
    ok: true,
    code,
    docCategory: category,
    hasName: fullName.length > 0,
    fullName,
    firstName,
    lastName,
    title: certificateType,
    personalCode: tidy(d.personalCode),
    birthDate: tidy(d.birthDate),
    status: statusFrom(d),
    isValid: d.isValid === true,
    issuedOn: tidy(d.issuedOn),
    validUntil: tidy(d.validUntil),
    certificateType,
    issuerCountry: tidy(d.issuerCountry),
    institution:
      tidy(d.educationalInstitutionNameEng) || tidy(d.educationalInstitutionName),
    documentType: tidy(d.documentType),
    sourceUrl: tidy(d.accessTokenUrl) || publicUrl(category, code),
    photoUrl: tidy(d.photoUrl) || undefined,
    registryCountry: "EE",
    keyTrust: "capability-token",
    verifiedSource: "government",
  };
}

// Some models carry an explicit "status" string; the minimal ones only carry
// isValid. Derive a sensible label either way.
function statusFrom(d: Record<string, unknown>): string {
  const s = tidy(d.status);
  if (s) return s;
  return d.isValid === true ? "valid" : "invalid";
}

// ---- Verification loop (moved from lib/verify.ts verifyCode) -----------

// Try the four public by-access-token endpoints in order until one answers 200,
// then normalise. Miss semantics (plan §3.1): 404 per endpoint, all four 404 =
// `no-match`; any network failure with no success = `indeterminate` ("network")
// — NEVER treated as invalid. A 200 answer maps to `match-valid` or, when the
// registry positively says the cert is invalid, `match-invalid` (the dispatcher
// surfaces that honestly — EE parity: ok:true, isValid:false).
// A single endpoint probe collapses to one of three tagged outcomes, mirroring
// today's per-iteration branches exactly:
//   MATCH — any successful JSON.parse (INCLUDING `{}` → normalizeCert →
//           match-invalid); the winning outcome is carried on the tag.
//   MISS  — 404 / !ok / parse-throw / !d (null body). Continue to the next.
//   THROW — fetchWithGuard rejected (timeout=AbortError, ECONNRESET, DNS, …).
type ProbeErr = { name?: string; message?: string; code?: string; cause?: { code?: string } };
type ProbeResult =
  | { tag: "match"; outcome: AdapterOutcome }
  | { tag: "miss" }
  | { tag: "throw"; err: ProbeErr };

// Retry only these transient, fast-failing network throws — an immediate
// connection/DNS blip that a single re-try commonly clears. An AbortError
// (the guard's timeout fired) is NEVER retried (it already waited a full
// window), nor is any unknown error shape.
const FAST_THROW_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const RETRY_BACKOFF_MS = 250;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isFastThrow(err: ProbeErr): boolean {
  if (err?.name === "AbortError") return false;
  const code = err?.cause?.code;
  return code !== undefined && FAST_THROW_CODES.has(code);
}

async function probe(ep: (typeof CERT_ENDPOINTS)[number], code: string): Promise<ProbeResult> {
  let res;
  try {
    res = await fetchWithGuard(apiUrl(ep.category, code), {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    // Observability (no PII): NEVER log the request URL — the EE endpoints
    // embed the 16-char access token in the path. Log only a static endpoint
    // label + the error shape so an intermittent network failure (timeout vs
    // ECONNRESET vs TLS vs DNS) is diagnosable. undici surfaces the OS error
    // code on err.cause.code; an AbortError means the guard's timeout fired.
    const e = err as ProbeErr;
    console.error("[registry:EE] endpoint fetch failed", {
      endpoint: ep.category,
      index: CERT_ENDPOINTS.indexOf(ep),
      name: e?.name,
      message: e?.message,
      code: e?.code ?? e?.cause?.code,
      aborted: e?.name === "AbortError",
    });
    return { tag: "throw", err: e };
  }

  if (res.status === 404) return { tag: "miss" }; // not this kind of document
  if (!res.ok) return { tag: "miss" }; // transient/other — treat as miss

  let d: Record<string, unknown> | null = null;
  try {
    d = JSON.parse(res.bodyText) as Record<string, unknown>;
  } catch {
    d = null;
  }
  if (!d) return { tag: "miss" };

  const cert = normalizeCert(ep.category, code, d);
  return {
    tag: "match",
    outcome: cert.isValid ? { kind: "match-valid", cert } : { kind: "match-invalid", cert },
  };
}

// Probe once, and (resilience path only) retry a single fast network throw
// after a short backoff. Used both for the remainder fan-out and — inline — for
// the throwing sequential category, so a fast throw retries once wherever it
// occurs; AbortError / unknown throws are never retried.
async function probeWithRetry(
  ep: (typeof CERT_ENDPOINTS)[number],
  code: string
): Promise<ProbeResult> {
  const first = await probe(ep, code);
  if (first.tag !== "throw" || !isFastThrow(first.err)) return first;
  await delay(RETRY_BACKOFF_MS);
  return probe(ep, code); // whatever the retry yields stands (match/miss/throw)
}

// Try the four public by-access-token endpoints IN ORDER (competency > medical >
// endorsement > qualification = match precedence). MATCH short-circuits and
// returns immediately; MISS continues; on a THROW behaviour depends on the
// interactive resilience flag (ALS, set only by the two /api/cert lanes):
//   flag OFF  — byte-for-byte as before: record the throw, continue sequentially,
//               post-loop indeterminate/network iff any throw & no match.
//   flag ON   — (1) retry a fast throw of THIS category once; retry MATCH returns,
//               retry MISS continues sequentially; then (2) fan out ALL not-yet-
//               probed categories concurrently (each retrying a fast throw once),
//               and MERGE in declared order: first MATCH wins, else any THROW →
//               indeterminate/network, else no-match. The merge is outcome-
//               identical to the sequential loop for every truth-table row.
export async function verifyEE(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  if (!code) return { kind: "no-match" };

  const resilience = currentRegistryResilience();
  const results: (ProbeResult | undefined)[] = new Array(CERT_ENDPOINTS.length);

  for (let i = 0; i < CERT_ENDPOINTS.length; i++) {
    const r = await probe(CERT_ENDPOINTS[i], code);

    if (r.tag === "match") return r.outcome; // short-circuit — identical to today
    if (r.tag === "miss") {
      results[i] = r;
      continue;
    }

    // r.tag === "throw"
    if (!resilience) {
      results[i] = r; // record; continue sequentially (byte-for-byte today)
      continue;
    }

    // ---- Resilience path (flag ON) --------------------------------------
    // Step 1: retry THIS category once iff the throw is a fast network throw.
    let cur: ProbeResult = r;
    if (isFastThrow(r.err)) {
      await delay(RETRY_BACKOFF_MS);
      cur = await probe(CERT_ENDPOINTS[i], code);
      if (cur.tag === "match") return cur.outcome; // retry self-healed
      if (cur.tag === "miss") {
        results[i] = cur; // retry MISS → treat as miss, continue sequentially
        continue;
      }
      // retry re-threw → fall through to the fan-out
    }
    results[i] = cur;

    // Step 2: fan out ALL not-yet-probed categories concurrently, then merge.
    const remainder: number[] = [];
    for (let j = i + 1; j < CERT_ENDPOINTS.length; j++) remainder.push(j);
    const settled = await Promise.allSettled(
      remainder.map((j) => probeWithRetry(CERT_ENDPOINTS[j], code))
    );
    settled.forEach((s, k) => {
      results[remainder[k]] =
        s.status === "fulfilled"
          ? s.value
          : { tag: "throw", err: { name: "Error", message: String(s.reason) } };
    });
    break; // every category is now probed — go to the merge
  }

  // ---- Merge: walk endpoints in declared order (reproduces the sequential
  // outcome for every row) — first MATCH wins, else any THROW → network, else
  // no-match. In the flag-OFF path this is the pure sequential post-loop.
  let sawNetworkError = false;
  for (let i = 0; i < CERT_ENDPOINTS.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.tag === "match") return r.outcome;
    if (r.tag === "throw") sawNetworkError = true;
  }

  return sawNetworkError
    ? { kind: "indeterminate", reason: "network" }
    : { kind: "no-match" };
}
