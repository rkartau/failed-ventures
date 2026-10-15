// §5b sample budget lane (psv-frontpage plan, v3-GREEN): the homepage demo
// sentinel (__docka-sample__) spends from a DEDICATED "sample" per-IP bucket +
// named "sample" global (30/min) via the existing consumeBudget limiter —
// NEVER from the shared registry buckets — so a homepage demo wave can never
// 429 paying users' genuine verifications, and vice versa.
//
// Route-level: the REAL /api/cert handlers are driven directly (duck-typed
// requests — the account-mgmt.test.mjs precedent) under REGISTRY_MOCK=1 with
// a stubbed EE adapter (no outbound fetch ever) and per-test client IPs via
// the mock-mode-only x-registry-test-ip header.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/cert-sample-lane.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.REGISTRY_MOCK = "1";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const APP_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-lane-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { resetRegistryAbuseState, __setTestAdapter, consumeSampleBudget } = await import(
  "@/lib/registry"
);
const { GET, POST } = await import("@/app/api/cert/route");

// The literal sentinel VerifyBox posts (route.ts resolves it server-side).
const SENTINEL = "__docka-sample__";
// A non-sentinel 16-char EE-shaped code — a REAL lookup, normal lane.
const REAL_CODE = "A1B2C3D4E5F6G7H8";

// Bucket capacities (index.ts §2.4/§5b) — the sample global refills 30/min and
// the per-IP bucket 8/min; used by the 1-token-per-lookup assertion below.
const SAMPLE_GLOBAL_CAPACITY = 30;
const PER_IP_CAPACITY = 8;

// Complete VerifiedCert shape (registry-units mkCert precedent) so respond()'s
// redaction + legacy mapping run over a realistic payload.
const eeCert = (code) => ({
  ok: true,
  code,
  docCategory: "competency",
  hasName: true,
  fullName: "JAAN TAMM",
  firstName: "JAAN",
  lastName: "TAMM",
  title: "Certificate of competency",
  personalCode: "39001010000",
  birthDate: "1990-01-01T00:00:00+00:00",
  status: "valid",
  isValid: true,
  issuedOn: "",
  validUntil: "2027-01-01T00:00:00+00:00",
  certificateType: "CoC",
  issuerCountry: "EE",
  institution: "",
  documentType: "",
  sourceUrl: "",
  registryCountry: "EE",
  keyTrust: "capability-token",
});

// The §2.4/§5b mutable limiter state is pinned on globalThis (plan §6.2) —
// read directly to assert WHICH buckets a request drew from.
const state = () => globalThis.__dockaRegistryState;

function getReq(code, ip) {
  return {
    nextUrl: new URL(`http://docka.test/api/cert?code=${encodeURIComponent(code)}`),
    headers: new Headers({ "x-registry-test-ip": ip }),
  };
}

function postReq(body, ip) {
  return {
    headers: new Headers({ "x-registry-test-ip": ip, "content-type": "application/json" }),
    json: async () => body,
  };
}

function fresh() {
  resetRegistryAbuseState();
  __setTestAdapter("EE", async (inputs) => ({
    kind: "match-valid",
    cert: eeCert(inputs.code),
  }));
}

test.after(() => {
  __setTestAdapter("EE", undefined);
  process.chdir(APP_CWD);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

// (1) THE DISTINGUISHING TEST — fails against unmodified code: with the shared
// registry global exhausted, the sentinel still succeeds (its own lane) while
// a real lookup rate-limits.
test("registry global exhausted: sentinel still succeeds, real lookup 429s", async () => {
  fresh();
  // Exhaust the shared 80/min registry global robustly: zero tokens and a
  // far-future `last` keeps the refill arithmetic non-positive for the whole test.
  state().globalBucket = { tokens: 0, last: Date.now() + 60 * 60_000 };

  const sample = await POST(postReq({ input: SENTINEL }, "10.5.0.1"));
  assert.equal(sample.status, 200, "sentinel lookup must not draw from the registry global");
  const sampleBody = await sample.json();
  assert.equal(sampleBody.ok, true);

  const real = await POST(postReq({ input: REAL_CODE }, "10.5.0.2"));
  assert.equal(real.status, 429, "real lookup must still hit the exhausted registry global");
  const realBody = await real.json();
  assert.equal(realBody.ok, false);
  assert.equal(realBody.outcome?.rateLimited, true);
});

// (2) The GET form (?code=__docka-sample__) takes the SAME sample lane as POST.
test("GET sentinel takes the sample lane (named global spent, registry untouched)", async () => {
  fresh();
  const res = await GET(getReq(SENTINEL, "10.5.1.1"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const s = state();
  const named = s.namedGlobals.get("sample");
  assert.ok(named, 'the named "sample" global exists after a GET sentinel lookup');
  assert.ok(named.tokens < 30, 'the named "sample" global was spent');
  assert.ok(s.buckets.has("sample::10.5.1.1"), "per-IP spend lands in the sample namespace");
  assert.ok(!s.buckets.has("registry::10.5.1.1"), "no registry per-IP bucket was touched");
  assert.equal(s.globalBucket.tokens, 80, "the shared registry global is untouched (no double-spend)");
});

// (3) A real lookup never draws from the sample lane.
test("non-sentinel lookup never draws from the sample bucket", async () => {
  fresh();
  const res = await POST(postReq({ input: REAL_CODE }, "10.5.2.1"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const s = state();
  assert.ok(!s.namedGlobals.has("sample"), 'a real lookup must not create/spend the "sample" global');
  assert.ok(!s.buckets.has("sample::10.5.2.1"), "no sample per-IP bucket for a real lookup");
  assert.ok(s.buckets.has("registry::10.5.2.1"), "the real lookup spent the registry namespace");
  assert.ok(s.globalBucket.tokens < 80, "the real lookup spent the shared registry global");
});

// (4) Drain the named "sample" global (30) across many IPs: the sentinel 429s
// while a real lookup from a fresh IP still succeeds — the lanes are
// independent in BOTH directions.
test("sample named global drained: sentinel 429s, real lookup from fresh IP succeeds", async () => {
  fresh();
  // Drain deterministically through the real lane spender: 8 per IP (per-IP
  // cap) across 4 IPs = 32 > 30, so the named global runs dry first.
  let granted = 0;
  for (let ipN = 1; ipN <= 4; ipN++) {
    for (let i = 0; i < 8; i++) {
      if (consumeSampleBudget(`10.5.3.${ipN}`)) granted++;
    }
  }
  assert.equal(granted, 30, 'the named "sample" global caps aggregate sentinel spend at 30');

  const sample = await POST(postReq({ input: SENTINEL }, "10.5.3.99"));
  assert.equal(sample.status, 429, "sentinel from a FRESH IP still 429s once the sample global is dry");
  const sampleBody = await sample.json();
  assert.equal(sampleBody.ok, false);
  assert.equal(sampleBody.outcome?.rateLimited, true);

  const real = await POST(postReq({ input: REAL_CODE }, "10.5.3.100"));
  assert.equal(real.status, 200, "real lookups are unaffected by a drained sample lane");
  assert.equal((await real.json()).ok, true);
});

// ===========================================================================
// SAMPLE PII REDACTION (privacy fix): the hardcoded homepage DEMO cert must
// NEVER expose the real person's PII to ANY viewer — signed-in admins/agents
// INCLUDED — while REAL lookups keep today's behaviour exactly.
//
// The lane tests above run the route through the direct import (viewer always
// anonymous — auth()/cookies() throw outside a request scope). To prove the
// signed-in BYPASS no longer applies to the sample we must flip
// isSignedInViewer() true, which means stubbing @/auth — so these cases drive a
// SECOND copy of the real route via the in-memory route harness (the sanctioned
// tool, batch2/billing precedent). The registry abuse/adapter state lives on
// globalThis, so both copies share it; each test resets + re-stubs.
// ===========================================================================

const { createRouteHarness } = await import("./_route-harness.mjs");

// Mutable signed-in state the @/auth stub returns. A truthy `user` => signed in.
let currentSession = null;

const { loadTs, LIB, API } = createRouteHarness({
  stubs: {
    "@/auth": { auth: async () => currentSession },
    // Keep the graph light + deterministic: the dev-cookie branches are driven
    // to false by the harness cookies() stub (get()->undefined) regardless.
    "@/lib/agent-session": { DEV_COOKIE: "docka_dev_agent", isDevLoginEnabled: true },
    "@/lib/seaman-session": { DEV_SEAMAN_COOKIE: "docka_dev_seaman", isDevSeamanLoginEnabled: true },
  },
});

// Same registry INSTANCE the harness route uses (harness cache is keyed by path).
const hReg = loadTs(path.join(LIB, "registry.ts"));
const hRoute = loadTs(path.join(API, "cert", "route.ts"));

// A throwaway, REAL-SHAPED (but fake) Estonian personal code + DOB, and a
// sourceUrl whose last path segment carries the access token — so we can prove
// each is redacted/neutered. NONE of these are the real demo person's values.
const THROWAWAY_PERSONAL = "39001010000";
const THROWAWAY_DOB = "1990-01-01T00:00:00+00:00";
const eeCertWithSource = (code) => ({
  ...eeCert(code),
  personalCode: THROWAWAY_PERSONAL,
  birthDate: THROWAWAY_DOB,
  sourceUrl: `https://meremees.transpordiamet.ee/certificates/${code}`,
});

// Capture the code the route hands the adapter (the sentinel resolves to the
// real 16-char access token server-side — we assert it is ABSENT from the
// response WITHOUT ever writing it into this file).
let resolvedCode = null;
function armAdapter() {
  hReg.resetRegistryAbuseState();
  hReg.__setTestAdapter("EE", async (inputs) => {
    resolvedCode = inputs.code;
    return { kind: "match-valid", cert: eeCertWithSource(inputs.code) };
  });
}

test.after(() => hReg.__setTestAdapter("EE", undefined));

const isMasked = (v) => typeof v === "string" && v.includes("•"); // "•"

// (5) SAMPLE + viewer treated as SIGNED-IN: personalCode, code, sourceUrl and
// birthDate are ALL redacted — the signed-in bypass does not apply to the demo.
test("sample lookup by a SIGNED-IN viewer is fully redacted (no bypass)", async () => {
  armAdapter();
  currentSession = { user: { name: "Admin" }, agentId: "agent:admin" };
  resolvedCode = null;

  const res = await hRoute.POST(postReq({ input: SENTINEL }, "10.6.0.1"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const cert = res.body.outcome.cert;

  assert.ok(isMasked(cert.personalCode), "personalCode masked for the sample");
  assert.ok(isMasked(cert.code), "verification code masked for the sample");
  assert.ok(resolvedCode, "adapter received the resolved sample code");
  assert.ok(
    !cert.sourceUrl.includes(resolvedCode),
    "sourceUrl carries no raw access token for the sample"
  );
  assert.ok(cert.sourceUrl.endsWith("/certificates/"), "sourceUrl neutered to the listing path");
  assert.equal(cert.birthDate, "", "birthDate blanked for the sample");

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(THROWAWAY_PERSONAL), "no raw personal code anywhere in the body");
  assert.ok(!serialized.includes(resolvedCode), "no raw access token anywhere in the body");
  assert.ok(!serialized.includes("1990-01-01"), "no raw DOB anywhere in the body");
});

// (6) NON-sample lookup by a SIGNED-IN viewer: FULL values (guard against
// over-masking the real agent workflow — sourceUrl deep link intact per the
// owner 2026-07-28 de-path directive, DOB + codes in full).
test("non-sample lookup by a SIGNED-IN viewer keeps full values", async () => {
  armAdapter();
  currentSession = { user: { name: "Agent" }, agentId: "agent:acme" };

  const res = await hRoute.POST(postReq({ input: REAL_CODE }, "10.6.1.1"));
  assert.equal(res.status, 200);
  const cert = res.body.outcome.cert;

  assert.equal(cert.personalCode, THROWAWAY_PERSONAL, "personalCode shown in full");
  assert.equal(cert.code, REAL_CODE, "verification code shown in full");
  assert.equal(
    cert.sourceUrl,
    `https://meremees.transpordiamet.ee/certificates/${REAL_CODE}`,
    "real deep link preserved (de-path directive intact)"
  );
  assert.equal(cert.birthDate, THROWAWAY_DOB, "birthDate shown in full");
});

// (7) ANONYMOUS real lookup: still masked EXACTLY as today — codes masked, but
// sourceUrl + birthDate untouched (regression lock: the anon redactor was NOT
// broadened, and the sample-only neutering never leaks onto real lookups).
test("anonymous real lookup keeps today's masking (codes only)", async () => {
  armAdapter();
  currentSession = null; // anonymous

  const res = await hRoute.POST(postReq({ input: REAL_CODE }, "10.6.2.1"));
  assert.equal(res.status, 200);
  const cert = res.body.outcome.cert;

  assert.ok(isMasked(cert.personalCode), "personalCode masked for anon");
  assert.ok(isMasked(cert.code), "verification code masked for anon");
  assert.equal(
    cert.sourceUrl,
    `https://meremees.transpordiamet.ee/certificates/${REAL_CODE}`,
    "anon real-lookup sourceUrl deep link unchanged (not de-pathed)"
  );
  assert.equal(cert.birthDate, THROWAWAY_DOB, "anon real-lookup birthDate unchanged");
});

// (5) Budget = exactly 1 token per lookup — the rate budget is spent ONCE per
// resolve (index.ts, before the first outbound fetch), independent of the EE
// adapter's per-category probe count, its retry, or its fan-out. A single cold
// sentinel lookup decrements the sample global by 1 (not 4, not 8).
test("sample lookup spends exactly one token (not per EE category / retry / fan-out)", async () => {
  fresh();
  const res = await POST(postReq({ input: SENTINEL }, "10.5.4.1"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const named = state().namedGlobals.get("sample");
  assert.ok(named, 'the named "sample" global exists after the lookup');
  const spent = SAMPLE_GLOBAL_CAPACITY - named.tokens;
  assert.ok(
    spent > 0.9 && spent < 1.1,
    `exactly one sample token spent per lookup (spent≈${spent.toFixed(3)}, not 4 or 8)`
  );

  const perIp = state().buckets.get("sample::10.5.4.1");
  assert.ok(perIp, "the per-IP sample bucket exists");
  const perIpSpent = PER_IP_CAPACITY - perIp.tokens;
  assert.ok(
    perIpSpent > 0.9 && perIpSpent < 1.1,
    `exactly one per-IP token spent per lookup (spent≈${perIpSpent.toFixed(3)})`
  );
});
