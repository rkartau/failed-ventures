// Server-side VerifierRegistry (plan §2.1): input resolution, adapter dispatch,
// the guarded outbound fetch helper, the §2.4 abuse controls (token buckets +
// fetch-layer result cache) and the §2.5 holder-binding choke point.
//
// Increment 1 wired Estonia (adapter #1) through this dispatcher with ZERO
// behavior change; increment 3 completes `resolveInput` (countryOverride
// round-trip, fan-out-capped bare-code ranking, tri-state dispatch), turns on
// the rate limiter + result cache on the public surfaces, and implements the
// full holder-binding rules 2–3.
//
// NOTE ON MODULE GRAPH: this file is imported (indirectly, via lib/cert.ts
// re-exports) into client bundles, so it must stay free of server-only VALUE
// imports (fs, lib/db, node:crypto, …) — types only. SHA-256 hashing uses the
// Web Crypto API (globalThis.crypto.subtle), available in both Node ≥18 and
// browsers. Adapter references live inside functions so the ee.ts <-> index.ts
// import cycle never touches an uninitialized binding at module-evaluation time.

import type { CertResult, VerifiedCert } from "@/lib/cert";
import type { Seafarer } from "@/lib/db";
import { COUNTRIES, countryEntry } from "./countries";
import { detectRegistry, eeNormalize, genericNormalize, type DetectCandidate } from "./detect";
import type {
  AdapterOutcome,
  CountryCode,
  CountryEntry,
  RegistryInputField,
  RegistryKeyKind,
  ResolveOutcome,
} from "./types";
import { verifyEE } from "./adapters/ee";
import { verifyDK } from "./adapters/dk";
import { verifyUK } from "./adapters/uk";
import { verifyNO } from "./adapters/no";
import { verifyFR } from "./adapters/fr";
import { verifyHR } from "./adapters/hr";
import { verifyBG } from "./adapters/bg";
import { verifyCY } from "./adapters/cy";
import { verifyTCCS } from "./adapters/ua-tccs";
import { verifyUAMARAD } from "./adapters/ua-marad";
import { verifyAZ } from "./adapters/az";

// ---- Shared guarded fetch (§2.4) ---------------------------------------

export type GuardedResponse = {
  status: number;
  ok: boolean;
  bodyText: string;
  /**
   * Raw body bytes — populated ONLY when the caller opted into binary mode
   * (`fetchWithGuard(url, init, { binary: true })`). Text callers never pay
   * for it; binary callers (UA-MARAD result-PDF fetch) read the bytes here
   * because a TextDecoder round-trip corrupts PDF streams.
   */
  bodyBytes?: Uint8Array;
  /** Set-Cookie headers of THIS response — for session-stateful registries (HR APEX). */
  setCookies: string[];
  /** Location header (redirects surface only under `redirect:"manual"`). */
  location: string | null;
};

const FETCH_TIMEOUT_MS = 12_000; // same 12s AbortController pattern as legacy verifyCode
const MAX_RESPONSE_BYTES = 1_000_000; // 1 MB response-size cap

// ---- Per-dispatch fetch timeout (pdf-verify plan Decision 15b) -----------
//
// The anon verify-upload dispatch loops need a REDUCED per-fetch timeout (6s)
// so the worst case (2 candidates × GET+POST) fits the 45s settle clock; the
// 12s default stands everywhere else. FETCH_TIMEOUT_MS is module-level and
// adapters call fetchWithGuard directly with the uniform (inputs) signature,
// so the override travels via AsyncLocalStorage — zero adapter churn, correct
// under concurrent interleaved requests.
//
// MODULE-GRAPH NOTE: this file must stay client-bundle-safe (header note), so
// node:async_hooks is NOT imported statically — the store is built lazily on
// the server via `process.getBuiltinModule` (Node ≥20.16 runtime API, present
// on the prod box's 20.20.2; webpack cannot statically resolve it, and it is
// the same mechanism pdfjs-dist's node path uses). In a browser the store is
// simply absent and the default timeout applies (no anon dispatch ever runs
// client-side).
type FetchCtx = { timeoutMs?: number; registryResilience?: boolean };
type FetchCtxStore = {
  run<T>(ctx: FetchCtx, fn: () => T): T;
  getStore(): FetchCtx | undefined;
};
let fetchCtxStore: FetchCtxStore | null | undefined;
function getFetchCtxStore(): FetchCtxStore | null {
  if (fetchCtxStore !== undefined) return fetchCtxStore;
  try {
    const getBuiltin = (
      globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }
    ).process?.getBuiltinModule;
    const hooks = getBuiltin?.("async_hooks") as
      | { AsyncLocalStorage: new () => FetchCtxStore }
      | undefined;
    fetchCtxStore = hooks ? new hooks.AsyncLocalStorage() : null;
  } catch {
    fetchCtxStore = null;
  }
  return fetchCtxStore;
}

function currentFetchTimeoutMs(): number {
  return getFetchCtxStore()?.getStore()?.timeoutMs ?? FETCH_TIMEOUT_MS;
}

// EE-resilience opt-in (ee-sample-cert-resilience plan): the two interactive
// /api/cert lanes set this so the EE adapter may retry a fast network throw
// once AND fan out the remaining categories after a throw. OFF (anon upload,
// backfill, recheck, any internal caller) → EE behaves byte-for-byte as before:
// fully sequential, short-circuit, no retry, no fan-out. Travels via the same
// AsyncLocalStorage as the timeout override — zero adapter-signature churn.
export function currentRegistryResilience(): boolean {
  return getFetchCtxStore()?.getStore()?.registryResilience ?? false;
}

function runWithFetchTimeout<T>(
  timeoutMs: number | undefined,
  registryResilience: boolean | undefined,
  fn: () => T
): T {
  // Enter the ALS store when EITHER a timeout override OR the resilience flag is
  // set (the dead-flag fix: previously the store was skipped unless a timeout
  // override was present, so a lane that set only the flag ran with no store and
  // the flag read its `false` default). Both values are carried in.
  const store = timeoutMs === undefined && !registryResilience ? null : getFetchCtxStore();
  if (!store) return fn();
  return store.run({ timeoutMs, registryResilience }, fn);
}

// ---- §2.4 abuse-control tunables ----------------------------------------

// Per-IP token bucket: enough for a human pasting/re-pasting, far below what a
// scraper needs. Refills continuously.
const PER_IP_CAPACITY = 8;
const PER_IP_REFILL_PER_MS = 8 / 60_000; // 8 tokens/minute
// Global bucket: caps TOTAL outbound pressure on the registries from this box.
const GLOBAL_CAPACITY = 80;
const GLOBAL_REFILL_PER_MS = 80 / 60_000; // 80 tokens/minute
// Bucket map entries idle longer than this are pruned (bounded memory).
const BUCKET_TTL_MS = 10 * 60_000;
// Fetch-layer result cache TTL (minutes-scale staleness is the accepted §2.4
// tradeoff on the public proof page).
const CACHE_TTL_MS = 5 * 60_000;

// Registry-wide mutable state is pinned on `globalThis` (plan §6.2): Next dev
// HMR / module-graph duplication would otherwise fork module state and make
// journal-empty test assertions vacuous. The journal records EVERY outbound
// registry host+path in mock/test mode — the ONLY valid way to assert "no
// fetch happened".
type RegistryGlobalState = {
  journal: { host: string; path: string; at: string }[];
  /**
   * §2.4 per-IP token buckets. Keyed `bucketName + "::" + ip` [V2] so different
   * surfaces (registry-verify vs the #49 directory) hold SEPARATE per-IP buckets and
   * cannot burn each other's budget. `cap` is stored per entry so the TTL-prune knows
   * each bucket's own capacity. TTL-pruned.
   */
  buckets: Map<string, { tokens: number; last: number; cap: number }>;
  /** §2.4 global token bucket. */
  globalBucket: { tokens: number; last: number };
  /**
   * NAMED per-surface global counters (verify-upload plan §1): each surface
   * that needs a TOTAL cap independent of the registry-outbound `globalBucket`
   * gets its own bucket here, keyed by `BudgetOpts.globalName`. An upload flood
   * must never burn the registry's outbound budget (and vice versa).
   */
  namedGlobals: Map<string, { tokens: number; last: number }>;
  /**
   * §2.4 fetch-layer result cache: SHA-256(country + normalized inputs) →
   * outcome. Stores ONLY match-valid / match-invalid / no-match — NEVER
   * indeterminate or errors (a transient blip must not lock a user out).
   */
  cache: Map<string, { outcome: AdapterOutcome; at: number }>;
  /** Mock-mode-only adapter overrides for unit tests. */
  testAdapters: Map<CountryCode, (inputs: Record<string, string>) => Promise<AdapterOutcome>>;
};

function globalState(): RegistryGlobalState {
  const g = globalThis as typeof globalThis & { __dockaRegistryState?: RegistryGlobalState };
  if (!g.__dockaRegistryState) {
    g.__dockaRegistryState = {
      journal: [],
      buckets: new Map(),
      globalBucket: { tokens: GLOBAL_CAPACITY, last: Date.now() },
      namedGlobals: new Map(),
      cache: new Map(),
      testAdapters: new Map(),
    };
  }
  // Older pinned state from a previous module generation (dev HMR) may predate
  // the increment-3 fields — heal them in place rather than forking the state.
  const s = g.__dockaRegistryState;
  if (!s.buckets) s.buckets = new Map();
  if (!s.globalBucket) s.globalBucket = { tokens: GLOBAL_CAPACITY, last: Date.now() };
  if (!s.namedGlobals) s.namedGlobals = new Map();
  if (!s.cache) s.cache = new Map();
  if (!s.testAdapters) s.testAdapters = new Map();
  return s;
}

function mockMode(): boolean {
  return process.env.REGISTRY_MOCK === "1" && process.env.NODE_ENV !== "production";
}

/** Exported for the §6.2 test-only endpoint (mock-mode preflight assert). */
export function registryMockMode(): boolean {
  return mockMode();
}

export function registryJournal(): readonly { host: string; path: string; at: string }[] {
  return globalState().journal;
}

export function resetRegistryJournal(): void {
  globalState().journal.length = 0;
}

/** §6.2 per-journey reset: clears result cache + token buckets (journal separate). */
export function resetRegistryAbuseState(): void {
  const s = globalState();
  s.buckets.clear();
  s.cache.clear();
  s.globalBucket.tokens = GLOBAL_CAPACITY;
  s.globalBucket.last = Date.now();
  s.namedGlobals.clear();
}

// All adapter traffic goes through here: HTTPS-only (plain http allowed only
// for the localhost mock seam), 12s timeout, 1 MB body cap, and the mock-mode
// request journal. Throws on network failure / timeout / over-cap — adapters
// map a throw to their "indeterminate" outcome, never to a verdict.
export async function fetchWithGuard(
  url: string,
  init?: RequestInit,
  opts?: {
    /**
     * Opt-in binary mode: the response body is returned as `bodyBytes`
     * (Uint8Array) and `bodyText` stays "" — a UTF-8 decode would corrupt
     * binary payloads (the UA-MARAD result PDF). Every existing text caller
     * is untouched; the 1 MB cap applies identically.
     */
    binary?: boolean;
  }
): Promise<GuardedResponse> {
  const u = new URL(url);
  if (u.protocol !== "https:" && !mockMode()) {
    throw new Error("registry fetches must use HTTPS");
  }
  if (mockMode()) {
    globalState().journal.push({ host: u.hostname, path: u.pathname, at: new Date().toISOString() });
  }

  const controller = new AbortController();
  // Per-dispatch override (anon verify-upload passes 6s via ResolveOpts.
  // fetchTimeoutMs → AsyncLocalStorage); everything else keeps the 12s default.
  const timeout = setTimeout(() => controller.abort(), currentFetchTimeoutMs());
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_RESPONSE_BYTES) {
      throw new Error("registry response exceeds size cap");
    }
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("registry response exceeds size cap");
    }
    // getSetCookie is standard on undici/Node ≥18.14; fall back to the single
    // combined header for anything older.
    const headersWithSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      headersWithSetCookie.getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    return {
      status: res.status,
      ok: res.ok,
      bodyText: opts?.binary ? "" : new TextDecoder("utf-8").decode(body),
      ...(opts?.binary ? { bodyBytes: new Uint8Array(body) } : {}),
      setCookies,
      location: res.headers.get("location"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- §2.4 client-IP derivation ------------------------------------------

// Preferred: the proxy on the box sets X-Real-IP from $remote_addr and the app
// reads ONLY that. Fallback: the RIGHTMOST X-Forwarded-For entry — the one the
// single trusted hop appended; entries to its LEFT are client-controlled and
// must never pick the bucket (the §6.4 spoof journey: a fresh fake XFF per
// request still lands in the same bucket → still 429). A dev/test override
// header is honored ONLY in mock mode (REGISTRY_MOCK=1, never production) so
// the rate-limit journey can simulate distinct clients without a proxy hop.
export function clientIpFromHeaders(headers: Headers): string {
  if (mockMode()) {
    const test = headers.get("x-registry-test-ip");
    if (test && test.trim()) return test.trim();
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]; // RIGHTMOST — never the leftmost
  }
  return "local";
}

/** Options for the generic per-IP token-bucket spend (§2.4, extracted for reuse [C2/V2]). */
export type BudgetOpts = {
  /** Per-IP bucket capacity (burst) for this NAMED bucket. */
  capacity: number;
  /** Per-IP refill rate, tokens per millisecond. */
  refillPerMs: number;
  /**
   * When true, ALSO require + spend a token from the shared `globalBucket` (cap 80),
   * the OUTBOUND-gov-fetch protector. Only the registry path passes this; the
   * directory makes no outbound registry fetch and passes it false/omitted so a
   * directory flood can never burn the registry's global outbound budget.
   */
  useGlobal?: boolean;
  /**
   * NAMED per-surface global counter (verify-upload plan §1): ALSO require +
   * spend a token from `namedGlobals[globalName]` — a TOTAL cap for this
   * surface that is fully independent of the registry-outbound `globalBucket`
   * (never reuse that via `useGlobal` for non-registry surfaces). Same
   * both-or-neither semantics as `useGlobal`. Requires `globalCapacity` +
   * `globalRefillPerMs`.
   */
  globalName?: string;
  /** Capacity (burst) of the named global counter. */
  globalCapacity?: number;
  /** Refill rate of the named global counter, tokens per millisecond. */
  globalRefillPerMs?: number;
};

/**
 * Generic namespaced token-bucket spend (§2.4, [C2/V2]). Each caller passes a
 * `bucketName` so per-IP buckets are keyed `bucketName::ip` — directory-verify and
 * registry-verify traffic hold SEPARATE per-IP buckets for the same IP. Returns false
 * when over-limit (the caller returns a friendly 429). This is the ONE limiter core;
 * `consumeRegistryBudget` is a thin wrapper over it, so there is no second IP parser
 * and no forked limiter.
 */
export function consumeBudget(bucketName: string, ip: string, opts: BudgetOpts): boolean {
  const s = globalState();
  const now = Date.now();

  // Refill + TTL-prune (bounded memory — plan §2.4). Prune an idle, FULL bucket using
  // its OWN stored capacity (buckets of different names have different caps).
  for (const [key, b] of s.buckets) {
    const cap = b.cap ?? PER_IP_CAPACITY;
    if (now - b.last > BUCKET_TTL_MS && b.tokens >= cap) s.buckets.delete(key);
  }

  // Optional shared global bucket (registry outbound protector) — refilled + checked
  // but only DECREMENTED once the per-IP bucket also has a token (both-or-neither).
  const g = s.globalBucket;
  let globalOk = true;
  if (opts.useGlobal) {
    g.tokens = Math.min(GLOBAL_CAPACITY, g.tokens + (now - g.last) * GLOBAL_REFILL_PER_MS);
    g.last = now;
    globalOk = g.tokens >= 1;
  }

  // Optional NAMED per-surface global counter — refilled + checked here, but
  // only DECREMENTED once every other gate also passes (both-or-neither).
  let named: { tokens: number; last: number } | undefined;
  let namedOk = true;
  if (opts.globalName) {
    const cap = opts.globalCapacity ?? opts.capacity;
    const refill = opts.globalRefillPerMs ?? opts.refillPerMs;
    named = s.namedGlobals.get(opts.globalName);
    if (!named) {
      named = { tokens: cap, last: now };
      s.namedGlobals.set(opts.globalName, named);
    } else {
      named.tokens = Math.min(cap, named.tokens + (now - named.last) * refill);
      named.last = now;
    }
    namedOk = named.tokens >= 1;
  }

  const key = `${bucketName}::${ip}`;
  let b = s.buckets.get(key);
  if (!b) {
    b = { tokens: opts.capacity, last: now, cap: opts.capacity };
    s.buckets.set(key, b);
  } else {
    b.tokens = Math.min(opts.capacity, b.tokens + (now - b.last) * opts.refillPerMs);
    b.last = now;
  }

  if (!globalOk || !namedOk || b.tokens < 1) return false;
  if (opts.useGlobal) g.tokens -= 1;
  if (named) named.tokens -= 1;
  b.tokens -= 1;
  return true;
}

/**
 * Consume one verification token for this client (§2.4): BOTH the per-IP and
 * the global bucket must have a token. Applied BEFORE any outbound registry
 * fetch. Returns false when over-limit → the caller returns a friendly 429,
 * never a partial verification, and NO doc is stored. Thin wrapper over
 * `consumeBudget` [V2]: keyed under the "registry" namespace + spends the
 * preserved `globalBucket` (cap 80). Byte-unchanged registry behaviour.
 */
export function consumeRegistryBudget(clientIp: string): boolean {
  return consumeBudget("registry", clientIp, {
    capacity: PER_IP_CAPACITY,
    refillPerMs: PER_IP_REFILL_PER_MS,
    useGlobal: true,
  });
}

// ---- §5b homepage sample lane (PSV frontpage plan, 2026-08-31) -----------

// Aggregate ceiling for the sample surface: the fetch-layer cache does NOT
// cache indeterminate/error outcomes, so during a registry outage every sample
// click would go outbound without a named total cap.
const SAMPLE_GLOBAL_CAPACITY = 30;
const SAMPLE_GLOBAL_REFILL_PER_MS = 30 / 60_000; // 30 tokens/minute

/**
 * Budget lane for the homepage sample button's sentinel lookup (§5b): the
 * elevated "Verify a certificate live" CTA funnels every homepage visitor at
 * the sample button, and the registry token spend happens BEFORE the fetch
 * cache — so without this lane a homepage traffic wave would drain the shared
 * 80/min registry global and 429 paying users' genuine verifications.
 * `useGlobal:false` keeps sample traffic out of the outbound-registry global;
 * the NAMED "sample" global keeps an aggregate ceiling of its own. Real
 * lookups (anything that is not the literal sentinel) never touch this lane.
 */
export function consumeSampleBudget(clientIp: string): boolean {
  return consumeBudget("sample", clientIp, {
    capacity: PER_IP_CAPACITY,
    refillPerMs: PER_IP_REFILL_PER_MS,
    useGlobal: false,
    globalName: "sample",
    globalCapacity: SAMPLE_GLOBAL_CAPACITY,
    globalRefillPerMs: SAMPLE_GLOBAL_REFILL_PER_MS,
  });
}

// ---- §2.4 fetch-layer result cache --------------------------------------

const CACHEABLE: ReadonlySet<AdapterOutcome["kind"]> = new Set([
  "match-valid",
  "match-invalid",
  "no-match",
]);

// SHA-256 of (country + canonical inputs) via Web Crypto — sensitive inputs
// (EGN/NIF) never sit raw in the cache map, only their digest.
async function cacheKey(country: CountryCode, inputs: Record<string, string>): Promise<string> {
  const canonical =
    country + "\n" + Object.keys(inputs).sort().map((k) => `${k}=${inputs[k]}`).join("\n");
  const data = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The cache lives AT THE ADAPTER-FETCH LAYER (plan §2.4) — never at
// resolveInput/outcome level — so the dispatcher's certainty logic (uncertain
// match-invalid → continue-as-no-match, mode → verified vs pending-binding)
// always runs downstream of a cache hit (§6.1 cache-position unit test).
async function verifyThroughCache(
  country: CountryCode,
  inputs: Record<string, string>,
  verify: (inputs: Record<string, string>) => Promise<AdapterOutcome>
): Promise<{ outcome: AdapterOutcome; fromCache: boolean }> {
  const s = globalState();
  const key = await cacheKey(country, inputs);
  const hit = s.cache.get(key);
  const now = Date.now();
  // `fromCache` feeds the honest proof-page wording (persona F10e): a
  // cache-served "live" answer reads "confirmed in the last few minutes",
  // never "just now".
  if (hit && now - hit.at <= CACHE_TTL_MS) return { outcome: hit.outcome, fromCache: true };
  if (hit) s.cache.delete(key);

  const outcome = await verify(inputs);
  if (CACHEABLE.has(outcome.kind)) s.cache.set(key, { outcome, at: now });
  return { outcome, fromCache: false };
}

// ---- Adapter lookup -----------------------------------------------------

// Deliberately a function (not a top-level map): the reference to each
// adapter's verify function is resolved at CALL time, which keeps the circular
// adapters <-> index.ts imports safe and lets future adapters register without
// eager evaluation. CY joined 2026-08-12 (deep-path probe from the production
// box confirmed the wire — the capability flip in countries.ts). HR remains
// registered but DORMANT: its capability is "assisted" since 2026-08-12 (R10
// reCAPTCHA demote), so the dispatcher answers assist before any lookup.
function adapterVerifyFor(
  country: CountryCode
): ((inputs: Record<string, string>) => Promise<AdapterOutcome>) | undefined {
  if (mockMode()) {
    const t = globalState().testAdapters.get(country);
    if (t) return t;
  }
  switch (country) {
    case "EE":
      return verifyEE;
    case "DK":
      return verifyDK;
    case "UK":
      return verifyUK;
    case "NO":
      return verifyNO;
    case "FR":
      return verifyFR;
    case "HR":
      return verifyHR;
    case "BG":
      return verifyBG;
    case "CY":
      return verifyCY;
    // Ukraine's TWO connectors (countries.ts): "UA" = the TCCS training-center
    // validator; "UA-MARAD" = the state registry vrf.marad.gov.ua (flag state).
    case "UA":
      return verifyTCCS;
    case "UA-MARAD":
      return verifyUAMARAD;
    case "AZ":
      return verifyAZ;
    default:
      return undefined;
  }
}

/**
 * TEST-ONLY (unit tests, §6.1): register/clear a fake adapter for a country.
 * Honored exclusively in mock mode (REGISTRY_MOCK=1 outside production) —
 * a no-op anywhere else, so the pinned adapter set cannot be redirected.
 */
export function __setTestAdapter(
  country: CountryCode,
  fn: ((inputs: Record<string, string>) => Promise<AdapterOutcome>) | undefined
): void {
  if (!mockMode()) return;
  const m = globalState().testAdapters;
  if (fn) m.set(country, fn);
  else m.delete(country);
}

// The §2.5 trust class of the lookup MODE actually used. The entry's keyKind is
// the per-country default; DETECTION refines per input path and stamps the
// candidate (DK `/validateqr/<code>` QR deep link → capability-token; DK bare
// cert number → the public-identifier default).
function lookupModeFor(entry: CountryEntry, cand?: DetectCandidate): RegistryKeyKind {
  return cand?.mode ?? entry.keyKind;
}

// §5.2 multi-key countries: the input keys an AUTO lookup needs BEYOND the
// pasted code (source !== "paste") that the caller has not supplied. The UI
// prompts for these (auto-filled from the profile where the source allows)
// and re-submits — nothing is fetched until they exist.
function missingInputsFor(
  entry: CountryEntry,
  extra: Record<string, string> | undefined
): RegistryInputField[] {
  return entry.inputs.filter((f) => f.source !== "paste" && !(extra?.[f.key] ?? "").trim());
}

// ---- Legacy-parity error strings (must stay byte-identical, plan §2.1) --

const ERR_INVALID_INPUT = "Enter a valid verification code or a full certificate URL.";
const ERR_EE_NETWORK =
  "Could not reach the Estonian registry. Check your connection and try again.";
const ERR_NETWORK = "Could not reach the registry. Check your connection and try again.";
const ERR_UNPINNED_DOMAIN =
  "This is not the official registry domain for any supported country.";
const ERR_RATE_LIMITED =
  "Too many verification attempts right now — please wait a minute and try again.";

function notFoundError(code: string): string {
  return `No certificate, medical, endorsement or qualification found for code "${code}".`;
}

// Persona B6 — honest per-country miss messages. The EE category-list wording
// above stays EXCLUSIVE to lookups where Estonia actually answered; a specific
// country's definitive miss names THAT authority instead.
function countryMissError(entry: CountryEntry): string {
  return `${entry.authority} found no record for these details.`;
}

function countryIndeterminateError(entry: CountryEntry): string {
  return `${entry.authority} could not confirm this certificate from these details. Try again, or contact the authority directly.`;
}

// ---- Assist prefill (§2.2) ----------------------------------------------

// resolveInput is context-less (no seafarer), so the only value it can prefill
// is the pasted code itself → every `source:"paste"` input key. Profile-backed
// fields (verifiedName → declared name → prompt) are assembled by the UI/route,
// which hold the profile.
function prefillFor(entry: CountryEntry, code: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entry.inputs) {
    if (f.source === "paste" && code) out[f.key] = code;
  }
  return out;
}

// ---- Dispatcher ---------------------------------------------------------

export type ResolveOpts = {
  /** Country-picker round-trip (§2.3): skip detection, target exactly this adapter. */
  countryOverride?: CountryCode;
  /**
   * Legacy verifyCode() mode (§2.1/§2.5): dispatch ONLY capability-token lookup
   * modes, so context-less callers can never mint an unbound public-identifier
   * green. Public-identifier AUTO candidates are skipped (rank order continues
   * to the EE fallback exactly as before).
   */
  capabilityTokenOnly?: boolean;
  /**
   * §2.4 rate limiting: when set (the public /api/cert + /api/documents paste
   * surfaces), one token is consumed from the per-IP + global buckets BEFORE
   * the first outbound adapter dispatch. Over-limit → `{kind:"error",
   * rateLimited:true}` with a friendly retry message and NO fetch performed.
   * Internal callers (backfill loops) pass nothing and are not throttled here.
   */
  clientIp?: string;
  /**
   * §5b sample lane: set (by /api/cert ONLY, for the literal sample sentinel)
   * to spend from the dedicated "sample" per-IP bucket + named global instead
   * of the registry buckets — never both (no double-spend). A homepage demo
   * wave can then never 429 real verifications, and vice versa.
   */
  budgetLane?: "sample";
  /**
   * §5.2 multi-key countries: extra lookup inputs from the POST body (e.g. UK
   * dob, BG EGN). Merged into the adapter inputs for the dispatched candidate.
   * Sensitive values are pass-through only — never logged, never persisted.
   */
  extraInputs?: Record<string, string>;
  /**
   * Per-dispatch registry fetch timeout in ms (pdf-verify plan Decision 15b).
   * The anon verify-upload dispatch loops pass 6000 so the settle-clock
   * arithmetic holds; absent → the 12s default. Plumbed to fetchWithGuard via
   * AsyncLocalStorage — adapters are untouched.
   */
  fetchTimeoutMs?: number;
  /**
   * EE-resilience opt-in (ee-sample-cert-resilience plan): set ONLY by the two
   * interactive /api/cert lanes (GET sample + POST sample/paste). When set, the
   * EE adapter may retry a fast network throw once and fan out the remaining
   * categories after a throw. Anon upload / backfill / recheck / internal
   * callers leave it unset → EE stays byte-for-byte sequential (no retry, no
   * fan-out). Plumbed to the adapter via AsyncLocalStorage; adapters untouched.
   */
  allowRegistryResilience?: boolean;
};

export async function resolveInput(raw: string, opts?: ResolveOpts): Promise<ResolveOutcome> {
  // ---- Candidate list ---------------------------------------------------
  let candidates: DetectCandidate[];
  if (opts?.countryOverride) {
    const entry = countryEntry(opts.countryOverride);
    if (!entry) {
      return { kind: "error", error: ERR_INVALID_INPUT };
    }
    const code =
      entry.country === "EE" ? eeNormalize(raw.trim()) : genericNormalize(raw.trim());
    if (!code) return { kind: "error", error: ERR_INVALID_INPUT };
    // An explicit user selection is a CERTAIN candidate (§2.3.4).
    candidates = [{ country: entry.country, code, certain: true }];
  } else {
    const detected = detectRegistry(raw);
    if (detected.kind === "invalid") {
      return { kind: "error", error: ERR_INVALID_INPUT };
    }
    if (detected.kind === "unpinned-domain") {
      // Fake-registry defense (§2.4): NEVER fetched, surfaced as a warning.
      return { kind: "error", error: ERR_UNPINNED_DOMAIN, unpinnedDomain: detected.hostname };
    }
    if (detected.kind === "ambiguous") {
      return { kind: "ambiguous", candidates: detected.candidates, code: detected.code };
    }
    candidates = detected.candidates;
  }

  // ---- Rank-order dispatch (tri-state, §2.3.4) --------------------------
  let sawNetworkFailure = false;
  let networkFailureCountry: CountryCode | null = null;
  let budgetSpent = false; // one token per resolve, taken before the FIRST fetch
  let lastCode = candidates[candidates.length - 1]?.code ?? "";
  // Persona B2/B6 exhaustion bookkeeping: which auto registries DEFINITIVELY
  // missed (no-match / continued match-invalid) vs answered indeterminately,
  // so the dead-end message can be honest per country — and the fallback-only
  // dead end can become an all-country picker instead of an EE-flavored error.
  const missedNonEE: CountryEntry[] = [];
  // EE misses are split by HOW Estonia entered the candidate list: a SPECIFIC
  // EE candidate (16-char token pattern / URL / countryOverride) that misses
  // keeps the legacy EE category-list wording, but the legacy ≥6-char FALLBACK
  // (appended after a specific-pattern country) missing must not steal the
  // attribution from that country's definitive no-match (persona vr2 item 1:
  // a bare DK-shaped code with a DK definitive miss names the Danish
  // authority, never the generic EE error).
  let eeMissedSpecific = false;
  let eeMissedAsFallback = false;
  const indeterminateNonEE: CountryEntry[] = [];
  const eeFallbackOnly =
    !opts?.countryOverride &&
    candidates.length === 1 &&
    candidates[0].country === "EE" &&
    candidates[0].fallback === true;
  // Deferred §5.2 prompt: an UNCERTAIN auto candidate whose lookup needs more
  // keys must not preempt the rest of the rank order (above all the EE
  // fallback) — it is remembered and surfaced only if nothing else answers.
  let pendingNeedsInputs: Extract<ResolveOutcome, { kind: "needs-inputs" }> | null = null;

  for (const cand of candidates) {
    const entry = countryEntry(cand.country);
    if (!entry) continue;
    const mode = lookupModeFor(entry, cand);
    lastCode = cand.code;

    switch (entry.capability) {
      case "manual":
        return { kind: "manual", country: entry, code: cand.code };

      case "assisted":
      case "unverified-endpoint":
        // unverified-endpoint adapters are NEVER fetched (§2.2) — both behave
        // as assisted at runtime.
        return { kind: "assist", country: entry, prefill: prefillFor(entry, cand.code) };

      case "auto":
      case "auto-presence": {
        if (opts?.capabilityTokenOnly && mode !== "capability-token") {
          continue; // legacy wrapper never dispatches public-identifier lookups
        }
        const verify = adapterVerifyFor(entry.country);
        if (!verify) {
          // Adapter not built yet (graceful downgrade, plan R2). A CERTAIN
          // candidate (URL/QR/countryOverride) surfaces the assisted panel; an
          // uncertain bare-code rank-order guess must NOT hijack the paste —
          // continue toward the EE fallback exactly as before this country
          // had a detection pattern.
          if (cand.certain) {
            return { kind: "assist", country: entry, prefill: prefillFor(entry, cand.code) };
          }
          continue;
        }

        // §5.2 multi-key lookups (UK/NO date of birth, …): nothing is fetched
        // until every REQUIRED key exists. A CERTAIN candidate prompts right
        // away; an uncertain rank-order guess defers the prompt so the EE
        // fallback still gets its chance first (EE zero-regression). OPTIONAL
        // fields (FR numeroVersion) ride along in the prompt but never gate it
        // — a lookup missing only optional keys proceeds without them.
        const missing = missingInputsFor(entry, opts?.extraInputs);
        if (missing.some((f) => !f.optional)) {
          const needs: Extract<ResolveOutcome, { kind: "needs-inputs" }> = {
            kind: "needs-inputs",
            country: entry,
            code: cand.code,
            missing,
          };
          if (cand.certain) return needs;
          pendingNeedsInputs ??= needs;
          continue;
        }

        // §2.4: consume the rate-limit budget once, BEFORE any outbound fetch.
        // §5b: the sample sentinel spends from its OWN lane — never the shared
        // registry buckets (and never both).
        if (opts?.clientIp && !budgetSpent) {
          const allowed =
            opts.budgetLane === "sample"
              ? consumeSampleBudget(opts.clientIp)
              : consumeRegistryBudget(opts.clientIp);
          if (!allowed) {
            return { kind: "error", error: ERR_RATE_LIMITED, rateLimited: true };
          }
          budgetSpent = true;
        }

        const inputs: Record<string, string> = { ...opts?.extraInputs, code: cand.code };
        let { outcome } = await runWithFetchTimeout(
          opts?.fetchTimeoutMs,
          opts?.allowRegistryResilience,
          () => verifyThroughCache(entry.country, inputs, verify)
        );

        // §2.5: stamp the trust class of the lookup MODE actually used onto the
        // cert — DOWNSTREAM of the result cache, so a cached bare-paste (public
        // identifier) hit re-answered for a QR lookup (capability token), or
        // vice versa, always carries the trust of THIS lookup, never the cached
        // one's.
        if (
          (outcome.kind === "match-valid" || outcome.kind === "match-invalid") &&
          outcome.cert.keyTrust !== mode
        ) {
          outcome = { ...outcome, cert: { ...outcome.cert, keyTrust: mode } };
        }

        if (outcome.kind === "match-valid") {
          return mode === "capability-token"
            ? { kind: "verified", cert: outcome.cert }
            : { kind: "pending-binding", cert: outcome.cert, country: entry };
        }
        if (outcome.kind === "match-invalid") {
          // Honest "registry says invalid" ONLY from a certain candidate or a
          // capability-token lookup (an unguessable token that answers IS the
          // right registry — EE parity: ok:true, isValid:false). An uncertain
          // public-identifier rank-order guess continues as no-match (§2.3.4).
          if (mode === "capability-token") {
            return { kind: "verified", cert: outcome.cert };
          }
          if (cand.certain) {
            return { kind: "pending-binding", cert: outcome.cert, country: entry };
          }
          // Uncertain match-invalid continues as a miss (§2.3.4) — record it
          // so the exhaustion message stays honest about who was asked.
          if (entry.country === "EE") {
            if (cand.fallback) eeMissedAsFallback = true;
            else eeMissedSpecific = true;
          } else missedNonEE.push(entry);
          continue;
        }
        if (outcome.kind === "indeterminate") {
          if (outcome.reason === "network") {
            sawNetworkFailure = true;
            networkFailureCountry = entry.country;
          } else if (entry.country !== "EE") {
            indeterminateNonEE.push(entry);
          }
          continue; // NEVER treated as invalid (§2.2)
        }
        // no-match — definitive miss for THIS registry; next candidate.
        if (entry.country === "EE") {
          if (cand.fallback) eeMissedAsFallback = true;
          else eeMissedSpecific = true;
        } else missedNonEE.push(entry);
        continue;
      }
    }
  }

  // ---- Exhausted --------------------------------------------------------
  // A deferred multi-key prompt beats a dead end: the user can still supply
  // the missing keys and get a real answer (more actionable than either error).
  if (pendingNeedsInputs) return pendingNeedsInputs;
  if (sawNetworkFailure) {
    // Observability (no PII): summarise the network dead-end the user will see.
    // Per-endpoint error detail lives in the adapter log; keep this to a single
    // line — country + lane (so we can see if it was the front-page `sample`).
    console.warn("[registry] returning network error to user", {
      country: networkFailureCountry,
      budgetLane: opts?.budgetLane,
    });
    return {
      kind: "error",
      error: networkFailureCountry === "EE" ? ERR_EE_NETWORK : ERR_NETWORK,
    };
  }
  // Persona B2 — bare-code dead-end rescue: when NOTHING but the legacy EE
  // fallback was ever in play and it missed, the honest outcome is not an
  // EE-flavored error but the country picker (ALL countries — the user
  // explicitly chooses; an assisted/manual pick routes to that flow with the
  // pasted code). The legacy capability-token wrapper keeps the EE error —
  // its context-less callers (recognize, backfill, proof) cannot show a picker.
  if (eeFallbackOnly && !opts?.capabilityTokenOnly) {
    return {
      kind: "ambiguous",
      candidates: COUNTRIES.map((c) => c.country),
      code: lastCode,
      unmatched: true,
    };
  }
  // Persona B6 (+ vr2 item 1) — honest per-country miss attribution. The EE
  // category-list wording is kept ONLY when Estonia itself was asked AS A
  // SPECIFIC candidate and missed; when one specific-pattern country returned
  // a DEFINITIVE no-match and the only other miss is the appended EE fallback,
  // the message is attributed to that specific country.
  if (!eeMissedSpecific && missedNonEE.length === 1) {
    return { kind: "error", error: countryMissError(missedNonEE[0]) };
  }
  if (!eeMissedSpecific && !eeMissedAsFallback && missedNonEE.length === 0 && indeterminateNonEE.length > 0) {
    return { kind: "error", error: countryIndeterminateError(indeterminateNonEE[0]) };
  }
  return { kind: "error", error: notFoundError(lastCode) };
}

// ---- Legacy CertResult mapping (plan §2.1) ------------------------------

// Non-verified outcomes map to STABLE legacy strings — callers at
// documents/route.ts branch on `result.ok` and surface/store `result.error`.
export function legacyResultForOutcome(outcome: ResolveOutcome): CertResult {
  switch (outcome.kind) {
    case "verified":
      return outcome.cert; // ok:true — including the honest isValid:false case
    case "pending-binding":
      return { ok: false, error: "registry-pending-binding" };
    case "assist":
      return { ok: false, error: "registry-assist" };
    case "needs-inputs":
      return { ok: false, error: "registry-needs-inputs" };
    case "ambiguous":
      return { ok: false, error: "registry-ambiguous" };
    case "manual":
      return { ok: false, error: "registry-manual" };
    case "error":
      return { ok: false, error: outcome.error };
  }
}

// ---- Legacy verifyCode() core (plan §2.1) -------------------------------

// The thin dispatcher behind lib/verify.ts `verifyCode(rawInput)` — EXACT
// legacy signature and semantics. Dispatches ONLY capability-token lookup
// modes (EE token today; DK QR in increment 4), so `ok: true` is returned
// ONLY for capability-token machine verification.
export async function verifyCapabilityToken(rawInput: string): Promise<CertResult> {
  const outcome = await resolveInput(rawInput, { capabilityTokenOnly: true });
  if (outcome.kind === "pending-binding") {
    // Unreachable under capabilityTokenOnly — fail closed regardless.
    return { ok: false, error: "registry-assist" };
  }
  return legacyResultForOutcome(outcome);
}

// ---- §5.4 outward-proof live re-check -----------------------------------

export type RecheckResult =
  | { state: "live"; cert: VerifiedCert; /** answered from the §2.4 result cache (minutes-fresh, not this instant). */ cached: boolean }
  | { state: "snapshot" }
  | { state: "rate-limited" }
  | { state: "unreachable" };

/**
 * Re-verify a STORED government-verified document against its registry for the
 * public proof surface (§5.4): keyed by the doc — `registryCountry` + the
 * stored NON-sensitive `registryInputs` — through the same guarded adapter
 * fetch layer (result cache + journal), never by re-parsing a bare string.
 *
 *  - `recheckable:false` countries (lookups needing unstored/sensitive inputs —
 *    BG EGN, HR name split) → `snapshot` BY DESIGN, no fetch attempted.
 *  - Required lookup inputs missing from the stored set (a UK doc whose DOB was
 *    never stored) → `snapshot`, no fetch.
 *  - §2.4 rate limit (per-IP + global buckets) applies BEFORE any fetch:
 *    over-limit → `rate-limited`, no fetch — the proof page stays friendly and
 *    falls back to the stored snapshot.
 *  - A dispatched lookup with no positive registry answer (`no-match` /
 *    `indeterminate` / network) → `unreachable` — the caller falls back to the
 *    stored snapshot and says so honestly (legacy EE behavior preserved).
 *
 * Display-only: the result never mints trust — `keyTrust`/holder binding are
 * untouched, and the proof gate (`source === "government"`) sits in the caller.
 */
export async function recheckStoredLookup(opts: {
  country: CountryCode;
  code: string;
  inputs?: Record<string, string> | null;
  clientIp?: string;
}): Promise<RecheckResult> {
  const entry = countryEntry(opts.country);
  if (!entry || !entry.recheckable || !opts.code) return { state: "snapshot" };
  const verify = adapterVerifyFor(entry.country);
  if (!verify) return { state: "snapshot" };

  // Nothing is fetched unless every REQUIRED non-paste lookup key was stored
  // at verification time (§4.6).
  const stored = opts.inputs ?? {};
  if (missingInputsFor(entry, stored).some((f) => !f.optional)) {
    return { state: "snapshot" };
  }

  if (opts.clientIp && !consumeRegistryBudget(opts.clientIp)) {
    return { state: "rate-limited" };
  }

  let outcome: AdapterOutcome;
  let fromCache = false;
  try {
    const r = await verifyThroughCache(entry.country, { ...stored, code: opts.code }, verify);
    outcome = r.outcome;
    fromCache = r.fromCache;
  } catch {
    return { state: "unreachable" };
  }
  if (outcome.kind === "match-valid" || outcome.kind === "match-invalid") {
    return { state: "live", cert: outcome.cert, cached: fromCache };
  }
  return { state: "unreachable" };
}

// ---- Holder-binding choke point (§2.5) ----------------------------------

export type BindHolderOpts = {
  /**
   * §2.5 rule 3 (first-set): the holder explicitly confirmed "yes, this is me"
   * in the UI after seeing the registry-returned name. Without it, a profile
   * with NO identity (no verifiedName and no declared name) can never be
   * silently named by a public-identifier verification.
   */
  confirmedByHolder?: boolean;
};

export type BindHolderResult =
  | { ok: true; cert: VerifiedCert }
  // First-set (§2.5 rule 3): show `holderName` and ask for explicit confirmation.
  | { ok: false; needsConfirmation: true; holderName: string }
  // Rule 2 mismatch: store unverified + flag `Doc.holderMismatch`, never green.
  | { ok: false; needsConfirmation?: undefined; error: string; holderMismatch: true };

const ERR_HOLDER_MISMATCH =
  "The registry lists a different holder for this certificate — it was saved unverified and flagged for review.";

// Order/case/diacritic-insensitive token-SET name compare (§2.5 rule 2):
// "SMITH John" matches "John Smith". Exported for the §6.1 unit tests.
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // fold diacritics (NFD combining marks)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort();
}

function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

function dateOnly(iso: string | null | undefined): string {
  return (iso ?? "").slice(0, 10);
}

// THE ONLY function allowed to turn a public-identifier `match-valid` into a
// storable government/registry verification (§2.5 rules 2–3). `resolveInput`
// stays context-less and returns `verified` ONLY for capability-token lookups;
// every route holding a `pending-binding` outcome MUST pass it through here
// (with the seafarer) before `newVerifiedDoc`. Identity self-heal remains
// separately gated INSIDE applyVerifiedIdentity (rule 1) — a bound
// public-identifier cert still never names a profile.
export function bindHolder(
  outcome: Extract<ResolveOutcome, { kind: "pending-binding" }>,
  seafarer: Seafarer,
  opts?: BindHolderOpts
): BindHolderResult {
  const cert = outcome.cert;

  // Training-center / presence-only results (§2.5 source semantics): a cert
  // whose adapter already classified it verifiedSource:"registry" NEVER claims
  // the holder — it stores as a teal "registry-confirmed document — holder not
  // verified" regardless of any name it carries (UA-TCCS echoes the SEARCHED
  // surname, which proves nothing about the profile). No name/DOB comparison
  // applies, and it can never be upgraded to government here.
  if (cert.verifiedSource === "registry") return { ok: true, cert };

  // Rule 4 — name-less results can never satisfy rule 2's match: they may only
  // ever yield source:"registry" (registry-confirmed document, holder NOT
  // verified). Fail closed — an adapter that mislabeled a name-less result as
  // "government" is downgraded here.
  if (!cert.hasName || !cert.fullName) {
    return { ok: true, cert: { ...cert, verifiedSource: "registry" } };
  }

  // The identity to match against: verified identity first, else the declared
  // profile name (§2.5 rule 2 accepts either).
  const profileName = (seafarer.verifiedName ?? "").trim() || (seafarer.name ?? "").trim();

  if (!profileName) {
    // Rule 3 — first-set: never silently name a profile from a public
    // identifier; require the explicit "yes, this is me" confirmation.
    if (opts?.confirmedByHolder) return { ok: true, cert };
    return { ok: false, needsConfirmation: true, holderName: cert.fullName };
  }

  if (!namesMatch(profileName, cert.fullName)) {
    return { ok: false, error: ERR_HOLDER_MISMATCH, holderMismatch: true };
  }

  // DOB exact when both known (rule 2).
  const certDob = dateOnly(cert.birthDate);
  const profileDob = dateOnly(seafarer.birthDate);
  if (certDob && profileDob && certDob !== profileDob) {
    return { ok: false, error: ERR_HOLDER_MISMATCH, holderMismatch: true };
  }

  return { ok: true, cert };
}
