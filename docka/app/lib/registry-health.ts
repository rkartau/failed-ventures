// lib/registry-health.ts — admin registry-health probes (verify-upload admin
// surface extension, operator brief 2026-08-12).
//
// The operator problem: every corpus row's thumbnail hits the same internal
// endpoint, so nothing on /admin/verify-uploads showed WHICH country registry
// a verification actually exercised, and there was no self-serve way to test a
// single country's API. This module is the self-serve half: one documented
// NEGATIVE-PATH probe per live adapter, fired through the SAME dispatcher as
// every real lookup (resolveInput + countryOverride — never a raw fetch), so
// the guarded-fetch rules, result-cache and redaction semantics all hold.
//
// Rules baked in:
//  - Probes run as an INTERNAL caller (no clientIp — mirrors rerunRecognition),
//    so NO rate-limit tokens are spent (per-IP or global). fetchWithGuard
//    inside the adapters still enforces its transport rules — HTTPS-only, 12s
//    timeout, 1 MB body cap — but it is NOT a rate limiter; probe-frequency
//    safety comes from the admin gate on the route plus the 60s cooldown below.
//  - 60 s per-country cooldown, enforced server-side: these probes hit REAL
//    government registries. The cooldown reads both the in-memory attempt map
//    (survives double-clicks and races) and the persisted last-probe time
//    (survives restarts).
//  - Last result per country persists to data/registry-health.json — a plain
//    JSON file with an atomic tmp+rename write. Deliberately NOT db.json and
//    NOT an audit sink (the admin-audit line lives in the route).
//  - Probe INPUTS are synthetic or official published specimens only — never a
//    real person's data — and are never persisted or logged (BG EGN is a
//    sensitive pass-through, same §4.6 rule as real lookups). The health file
//    stores only outcome classes, never inputs.
//  - Expected outcome is per country: UA-TCCS answers misses with an ambiguous
//    "contact us" page, so indeterminate IS its healthy state.

import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "@/lib/atomic-json";
import { COUNTRIES, countryEntry } from "@/lib/registry/countries";
import { registryMockMode, resolveInput } from "@/lib/registry";
import type { CountryCode, CountryEntry, ResolveOutcome } from "@/lib/registry/types";

const DATA_DIR = path.join(process.cwd(), "data");
const HEALTH_PATH = path.join(DATA_DIR, "registry-health.json");

/** Per-country probe cooldown — real government registries sit behind this. */
export const PROBE_COOLDOWN_MS = 60_000;

// ---- Live-adapter list -------------------------------------------------------

/**
 * The countries the health panel shows: exactly the capability check the
 * per-country demand panel uses for `hasAdapter` (verify-upload-admin.ts).
 * DERIVED, never hardcoded — a capability flip in countries.ts (CY promote,
 * HR reCAPTCHA demote) changes this list with zero edits here.
 */
export function liveAdapterCountries(): CountryEntry[] {
  return COUNTRIES.filter((c) => c.capability === "auto" || c.capability === "auto-presence");
}

/**
 * The probe route's [cc] validation (review fix 2026-08-13): uppercase the
 * path segment and accept ONLY codes present in the registry TABLE — never a
 * shape regex. CountryCode is deliberately open-ended ("UA-MARAD" is a legal
 * table code that /^[A-Z]{2}$/ used to 400). Returns the canonical code, or
 * null for anything the table doesn't know (the route answers 400). Lives
 * here (not in the route file) so it is unit-testable — the auth-gated route
 * itself is never imported in tests (verify-upload-admin.test.mjs rule).
 */
export function normalizeProbeCountry(raw: string): CountryCode | null {
  const cc = (raw ?? "").trim().toUpperCase();
  return countryEntry(cc) ? cc : null;
}

// ---- Probe-inputs table --------------------------------------------------------

export type ProbeSpec = {
  /** The pasted-code input (delivered to the adapter as `code`). */
  raw: string;
  /** Non-paste lookup keys — countries.ts input `key` ids VERBATIM. */
  extraInputs?: Record<string, string>;
  /** The outcome a HEALTHY registry answers for this synthetic input. */
  expected: "no-match" | "indeterminate";
};

/**
 * Documented negative-path probe inputs. Every value is synthetic or an
 * OFFICIAL published specimen — no real person's data anywhere. extraInputs
 * keys are the exact countries.ts input key ids (dob / numeroAdm / egn /
 * firstName / lastName / surname / seafarerId).
 */
export const PROBE_INPUTS: Record<CountryCode, ProbeSpec> = {
  // EE: well-formed 16-char access token that was never issued → definitive no-match.
  EE: { raw: "AAAAAAAAAAAAAAAA", expected: "no-match" },
  // DK: all-zero 8-digit certificate number → in-body miss from POST /api/validate.
  DK: { raw: "00000000", expected: "no-match" },
  // NO: zero-led 10-digit number + synthetic DOB → 404 problem+json = no-match.
  //     A 401-shaped answer means the public APIM subscription key rotated —
  //     surfaced distinctly as the KEY-ROTATED verdict note (see verdictFor).
  NO: { raw: "0000000001", extraInputs: { dob: "1990-01-01" }, expected: "no-match" },
  // UK: OFFICIAL MCA specimen document id (CoC0089297) + its published DOB → no-match.
  UK: { raw: "CoC0089297", extraInputs: { dob: "1988-03-03" }, expected: "no-match" },
  // FR: synthetic numeroTitre + numeroAdm pair → server-rendered miss = no-match.
  FR: { raw: "1234567", extraInputs: { numeroAdm: "12345678" }, expected: "no-match" },
  // BG: synthetic doc number + the PUBLISHED checksum-valid example EGN (a synthetic
  //     specimen, no real person). Sensitive pass-through only — never logged/stored.
  BG: { raw: "123456", extraInputs: { egn: "0847038794" }, expected: "no-match" },
  // HR: Test/Test + zero serial → no-match. DORMANT while countries.ts holds HR
  //     "assisted" (2026-08-12 reCAPTCHA demote) — the row only appears if HR re-flips.
  HR: { raw: "0000000", extraInputs: { firstName: "Test", lastName: "Test" }, expected: "no-match" },
  // UA — "UA TCCS" row (training-center validator): TCCS answers misses with an
  //     ambiguous "contact us" page → indeterminate IS the healthy state for
  //     this registry (expected encoded per country).
  UA: { raw: "00000000", extraInputs: { surname: "TEST" }, expected: "indeterminate" },
  // UA-MARAD — "UA state registry" row (vrf.marad.gov.ua flag-state quick
  //     search): synthetic zero doc number + a 2023+ issue date, so the
  //     "документ не знайдено" miss is DEFINITIVE under the adapter's date gate
  //     (pre-2023 dates would answer indeterminate "not-in-quick-index").
  "UA-MARAD": {
    raw: "00000",
    extraInputs: { issuedOn: "2024-01-01", doctype: "70" },
    expected: "no-match",
  },
  // CY: zero seafarer id + cert number → the entry's CONFIRMED deterministic miss
  //     ("The Certificate was not found") = no-match. Row appears only while the
  //     2026-08-12 capability flip holds.
  CY: { raw: "000000", extraInputs: { seafarerId: "000000" }, expected: "no-match" },
  // AZ: synthetic all-zero wire-form code (never issued — exercises the
  //     adapter's verbatim already-slashed branch) + synthetic DOB → the
  //     documented status!="success" miss = no-match. No real person anywhere.
  AZ: { raw: "000000/00", extraInputs: { dob: "1990-01-01" }, expected: "no-match" },
};

// ---- Outcome classification ----------------------------------------------------

// resolveInput flattens adapter outcomes into user-facing dispatcher strings;
// the probe classifies them back with the SAME patterns verify-upload.ts's
// deferredReasonForOutcome already relies on (stable legacy-parity constants
// in registry/index.ts).
export type ProbeOutcome =
  | "match" // verified / pending-binding — a synthetic input matching is NOT healthy
  | "no-match" // definitive "nothing under this key" from the registry
  | "indeterminate" // registry answered but could not confirm (incl. NO 401-shape)
  | "network-error" // transport failure — could not reach the registry
  | "no-lookup" // dispatcher never reached the wire (assist/manual/needs-inputs/ambiguous)
  | "error"; // unclassifiable dispatcher error

export function classifyProbeOutcome(o: ResolveOutcome): ProbeOutcome {
  switch (o.kind) {
    case "verified":
    case "pending-binding":
      return "match";
    case "error":
      if (o.rateLimited) return "error";
      if (/^Could not reach/.test(o.error)) return "network-error";
      if (/could not confirm this certificate/.test(o.error)) return "indeterminate";
      if (/found no record for these details/.test(o.error)) return "no-match";
      // EE's legacy category-list wording — Estonia's definitive miss.
      if (/^No certificate, medical, endorsement or qualification found/.test(o.error))
        return "no-match";
      return "error";
    default:
      return "no-lookup";
  }
}

// ---- Verdict mapping -------------------------------------------------------------

export type HealthVerdict = "healthy" | "degraded" | "error";

/**
 * actual == expected → HEALTHY; indeterminate where no-match was expected →
 * DEGRADED (for NO named KEY-ROTATED — the dispatcher flattens the adapter's
 * http-401 reason, so the note names the documented LIKELY cause, not a
 * certainty); transport error → ERROR. Everything else off-script → DEGRADED
 * with an honest note, except unclassifiable dispatcher errors → ERROR.
 */
export function verdictFor(
  country: CountryCode,
  expected: ProbeSpec["expected"],
  outcome: ProbeOutcome
): { verdict: HealthVerdict; note: string | null } {
  if (outcome === expected) return { verdict: "healthy", note: null };
  if (outcome === "network-error") return { verdict: "error", note: "registry unreachable" };
  if (outcome === "error") return { verdict: "error", note: "unclassified dispatcher error" };
  if (outcome === "indeterminate" && expected === "no-match") {
    return country === "NO"
      ? { verdict: "degraded", note: "KEY-ROTATED? (401-shaped or unrecognized answer)" }
      : { verdict: "degraded", note: "indeterminate where no-match expected" };
  }
  if (outcome === "match") return { verdict: "degraded", note: "unexpected match for a synthetic probe" };
  if (outcome === "no-lookup") return { verdict: "degraded", note: "lookup not dispatched (capability or missing keys)" };
  return { verdict: "degraded", note: `unexpected ${outcome}` };
}

// ---- Persisted last results (data/registry-health.json) ---------------------------

export type CountryHealth = {
  country: CountryCode;
  at: string; // ISO probe start time
  ms: number; // probe duration
  outcome: ProbeOutcome;
  expected: ProbeSpec["expected"];
  verdict: HealthVerdict;
  note: string | null;
};

/** Tolerant read — a missing or corrupt file is simply "never probed". */
export function readRegistryHealthFile(): Record<string, CountryHealth> {
  try {
    const parsed = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, CountryHealth>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

// Atomic: full write to a sibling tmp file, then rename over the target —
// a crash mid-write can never leave a half-written health file behind the
// panel (rename replaces atomically on POSIX and Windows/libuv alike).
function writeRegistryHealthFile(all: Record<string, CountryHealth>): void {
  // C6 — ONE writer, shared with lib/billing-health.ts (this copy also used a fixed
  // `.tmp` name, so two processes writing at once could tread on each other).
  const res = writeJsonAtomic(HEALTH_PATH, all);
  if (!res.ok) throw res.error;
}

// ---- Module state (globalThis-pinned — same §6.2 rationale as the registry) -------

type RegistryHealthState = {
  /** cc → last probe ATTEMPT (ms epoch), claimed synchronously before the fetch. */
  lastAttempt: Map<string, number>;
};

function state(): RegistryHealthState {
  const g = globalThis as typeof globalThis & { __dockaRegistryHealthState?: RegistryHealthState };
  if (!g.__dockaRegistryHealthState) g.__dockaRegistryHealthState = { lastAttempt: new Map() };
  return g.__dockaRegistryHealthState;
}

/** TEST-ONLY (mock mode): clear the in-memory cooldown map between cases. */
export function __resetRegistryHealthState(): void {
  if (!registryMockMode()) return;
  state().lastAttempt.clear();
}

// ---- Probe ----------------------------------------------------------------------

export type ProbeCountryResult =
  | { status: "ok"; result: CountryHealth }
  | { status: "cooldown"; retryAfterMs: number }
  | { status: "no-probe" } // live adapter, but no documented probe input yet
  | { status: "not-live" }; // unknown country, or no live adapter (assisted/manual)

/**
 * Fire one country's documented negative-path probe through the dispatcher.
 * NOTE: the §2.4 fetch-layer result cache applies as it does to real lookups —
 * a re-probe within its 5-minute TTL may be answered from cache (deliberate:
 * the probe exercises exactly the path real verifications take).
 */
export async function probeCountry(ccRaw: string): Promise<ProbeCountryResult> {
  const cc = ccRaw.trim().toUpperCase();
  const entry = liveAdapterCountries().find((c) => c.country === cc);
  if (!entry) return { status: "not-live" };
  const spec = PROBE_INPUTS[cc];
  if (!spec) return { status: "no-probe" };

  // Cooldown: newest of the in-memory attempt (double-click guard) and the
  // persisted last probe (restart guard).
  const now = Date.now();
  const mem = state().lastAttempt.get(cc) ?? 0;
  const fileAt = Date.parse(readRegistryHealthFile()[cc]?.at ?? "") || 0;
  const last = Math.max(mem, fileAt);
  if (now - last < PROBE_COOLDOWN_MS) {
    return { status: "cooldown", retryAfterMs: PROBE_COOLDOWN_MS - (now - last) };
  }
  state().lastAttempt.set(cc, now); // claimed BEFORE the first await — no concurrent double-probe

  let outcome: ProbeOutcome;
  try {
    // The SAME dispatcher as rerunRecognition's internal lookups: certain
    // candidate via countryOverride, documented extra keys, NO clientIp
    // (internal caller — no per-IP budget). Never a raw fetch.
    const resolved = await resolveInput(spec.raw, {
      countryOverride: cc,
      extraInputs: spec.extraInputs,
    });
    outcome = classifyProbeOutcome(resolved);
  } catch {
    outcome = "network-error";
  }

  const { verdict, note } = verdictFor(cc, spec.expected, outcome);
  const result: CountryHealth = {
    country: cc,
    at: new Date(now).toISOString(),
    ms: Date.now() - now,
    outcome,
    expected: spec.expected,
    verdict,
    note,
  };
  try {
    const all = readRegistryHealthFile();
    all[cc] = result;
    writeRegistryHealthFile(all);
  } catch {
    /* an unwritable health file must not fail the probe answer itself */
  }
  return { status: "ok", result };
}

// ---- Panel listing -----------------------------------------------------------------

export type RegistryHealthRow = {
  country: CountryCode;
  countryName: string;
  authority: string;
  /** A documented probe input exists (the Probe button renders). */
  hasProbe: boolean;
  last: CountryHealth | null;
};

/** One row per live adapter (countries.ts order), with the persisted last result. */
export function listRegistryHealth(): RegistryHealthRow[] {
  const file = readRegistryHealthFile();
  return liveAdapterCountries().map((c) => ({
    country: c.country,
    countryName: c.countryName,
    authority: c.authority,
    hasProbe: !!PROBE_INPUTS[c.country],
    last: file[c.country] ?? null,
  }));
}
