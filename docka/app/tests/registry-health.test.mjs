// Unit tests for the admin registry-health surface (operator brief 2026-08-12):
// verdict mapping (expected-vs-actual matrix incl. UA's indeterminate-is-healthy
// and NO's KEY-ROTATED case), per-row registryTrace derivation from a fixture
// sidecar, the 60 s per-country probe cooldown (memory + persisted file), and
// the data/registry-health.json atomic write / tolerant read. Every probe runs
// against a REGISTRY_MOCK __setTestAdapter — NO live registry call is ever made
// (asserted via the journal).
//
// Follows the verify-upload-admin.test.mjs pattern: plain node + the `@/*`
// alias hook, synthetic fixtures, deterministic.
//
// Run: node --import ./tests/_register-alias.mjs tests/registry-health.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode + salt BEFORE any @/lib import.
process.env.REGISTRY_MOCK = "1";
process.env.VERIFY_IP_SALT = "unit-test-salt";

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-registry-health-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { registryJournal, resetRegistryAbuseState, __setTestAdapter } = await import("@/lib/registry");
const { COUNTRIES } = await import("@/lib/registry/countries");
const health = await import("@/lib/registry-health");
const vu = await import("@/lib/verify-upload");
const admin = await import("@/lib/verify-upload-admin");

const HEALTH_PATH = path.join(TMP, "data", "registry-health.json");
const UPLOAD_DIR = path.join(TMP, "data", "verify-uploads");
const journalBaseline = registryJournal().length;

const domain0 = (cc) => COUNTRIES.find((c) => c.country === cc).domains[0];

/** Reset everything that gates or caches a probe between cases. */
function freshProbe() {
  health.__resetRegistryHealthState(); // in-memory cooldown map
  resetRegistryAbuseState(); // §2.4 result cache — a cached no-match would mask the next mock
  fs.rmSync(HEALTH_PATH, { force: true }); // persisted last-probe times
}

// ---- Verdict mapping: pure expected-vs-actual matrix ---------------------------

{
  const v = health.verdictFor;
  assert.deepEqual(v("EE", "no-match", "no-match"), { verdict: "healthy", note: null });
  assert.deepEqual(v("UA", "indeterminate", "indeterminate"), { verdict: "healthy", note: null });
  ok("verdict: actual == expected => HEALTHY (incl. UA where indeterminate IS healthy)");

  const dk = v("DK", "no-match", "indeterminate");
  assert.equal(dk.verdict, "degraded");
  const no = v("NO", "no-match", "indeterminate");
  assert.equal(no.verdict, "degraded");
  assert.match(no.note, /KEY-ROTATED/);
  ok("verdict: indeterminate where no-match expected => DEGRADED; NO named KEY-ROTATED");

  assert.equal(v("DK", "no-match", "network-error").verdict, "error");
  assert.equal(v("UA", "indeterminate", "network-error").verdict, "error");
  ok("verdict: transport failure => ERROR");

  assert.equal(v("UA", "indeterminate", "no-match").verdict, "degraded");
  assert.equal(v("DK", "no-match", "match").verdict, "degraded");
  assert.equal(v("DK", "no-match", "no-lookup").verdict, "degraded");
  assert.equal(v("DK", "no-match", "error").verdict, "error");
  ok("verdict: off-script answers (unexpected no-match/match/no-lookup) => DEGRADED, unclassified => ERROR");
}

// ---- Probe-route [cc] validation: registry-TABLE lookup, never a shape regex ----
// (Review fix 2026-08-13: /^[A-Z]{2}$/ 400'd "UA-MARAD" and killed the panel's
// Probe button.) The auth-gated route itself is deliberately NOT imported
// (verify-upload-admin.test.mjs rule — it would pull the Next/auth runtime);
// its validation logic lives in lib/registry-health.normalizeProbeCountry and
// is exercised here directly.

{
  assert.equal(health.normalizeProbeCountry("UA-MARAD"), "UA-MARAD", "suffixed table code accepted");
  assert.equal(health.normalizeProbeCountry("ua-marad"), "UA-MARAD", "case-normalized");
  assert.equal(health.normalizeProbeCountry(" ee "), "EE", "trimmed two-letter code still accepted");
  assert.equal(health.normalizeProbeCountry("ZZ"), null, "unknown code -> null (route answers 400)");
  assert.equal(health.normalizeProbeCountry(""), null);
  assert.equal(health.normalizeProbeCountry("UA-EVIL"), null, "shape-plausible but not in the table");
  ok("probe route validation: table membership decides (UA-MARAD in, ZZ/UA-EVIL/empty out)");
}

// ---- Live-adapter list: derived from the demand panel's capability check --------

{
  const expected = COUNTRIES.filter(
    (c) => c.capability === "auto" || c.capability === "auto-presence"
  ).map((c) => c.country);
  assert.deepEqual(
    health.listRegistryHealth().map((r) => r.country),
    expected
  );
  ok(`health rows == live adapters from countries.ts capabilities (${expected.join(", ")})`);

  assert.deepEqual(await health.probeCountry("FI"), { status: "not-live" }); // assisted — CAPTCHA
  assert.deepEqual(await health.probeCountry("ZZ"), { status: "not-live" });
  ok("probe: assisted/unknown countries refused as not-live (dispatcher never fired)");
}

// ---- Probe through the dispatcher with mocked adapters ---------------------------

{
  // EE definitive miss (mocked adapter) => HEALTHY, and the exact-key inputs reach it.
  freshProbe();
  let eeInputs = null;
  __setTestAdapter("EE", async (inputs) => {
    eeInputs = inputs;
    return { kind: "no-match" };
  });
  const ee = await health.probeCountry("EE");
  assert.equal(ee.status, "ok");
  assert.equal(ee.result.outcome, "no-match");
  assert.equal(ee.result.verdict, "healthy");
  assert.equal(eeInputs.code, "AAAAAAAAAAAAAAAA");
  ok("probe EE: mocked no-match => HEALTHY; probe token delivered as inputs.code");
  __setTestAdapter("EE", undefined);

  // UA ambiguous "contact us" (indeterminate) IS the healthy state.
  freshProbe();
  let uaInputs = null;
  __setTestAdapter("UA", async (inputs) => {
    uaInputs = inputs;
    return { kind: "indeterminate", reason: "ambiguous-miss" };
  });
  const ua = await health.probeCountry("UA");
  assert.equal(ua.result.outcome, "indeterminate");
  assert.equal(ua.result.verdict, "healthy");
  assert.equal(uaInputs.surname, "TEST"); // countries.ts key id verbatim
  assert.equal(uaInputs.code, "00000000");
  ok("probe UA: indeterminate == expected => HEALTHY (indeterminate-is-healthy encoded)");

  // UA answering a DEFINITIVE no-match is off-script => DEGRADED.
  freshProbe();
  __setTestAdapter("UA", async () => ({ kind: "no-match" }));
  const ua2 = await health.probeCountry("UA");
  assert.equal(ua2.result.outcome, "no-match");
  assert.equal(ua2.result.verdict, "degraded");
  ok("probe UA: unexpected definitive no-match => DEGRADED");
  __setTestAdapter("UA", undefined);

  // UA-MARAD ("UA state registry" row — distinct from the "UA TCCS" row
  // above): the probe's 2023+ issue date makes the quick-index miss DEFINITIVE
  // under the adapter's date gate, so no-match IS the healthy state.
  const uamSpec = health.PROBE_INPUTS["UA-MARAD"];
  assert.equal(uamSpec.expected, "no-match");
  assert.ok(
    Number(uamSpec.extraInputs.issuedOn.slice(0, 4)) >= 2023,
    "probe issue date must be 2023+ — a pre-2023 date would answer indeterminate, never definitive"
  );
  assert.equal(uamSpec.extraInputs.doctype, "70");
  freshProbe();
  let uamInputs = null;
  __setTestAdapter("UA-MARAD", async (inputs) => {
    uamInputs = inputs;
    return { kind: "no-match" };
  });
  const uam = await health.probeCountry("UA-MARAD");
  assert.equal(uam.status, "ok");
  assert.equal(uam.result.outcome, "no-match");
  assert.equal(uam.result.verdict, "healthy");
  assert.equal(uamInputs.code, "00000");
  assert.equal(uamInputs.issuedOn, uamSpec.extraInputs.issuedOn); // countries.ts key ids verbatim
  assert.equal(uamInputs.doctype, "70");
  ok("probe UA-MARAD: definitive no-match (2023+ date gate) => HEALTHY; inputs delivered verbatim");

  // A date-gate-shaped indeterminate from the state registry is off-script
  // for the 2024 probe date => DEGRADED, never healthy.
  freshProbe();
  __setTestAdapter("UA-MARAD", async () => ({
    kind: "indeterminate",
    reason: "not-in-quick-index",
  }));
  const uam2 = await health.probeCountry("UA-MARAD");
  assert.equal(uam2.result.outcome, "indeterminate");
  assert.equal(uam2.result.verdict, "degraded");
  ok("probe UA-MARAD: indeterminate where no-match expected => DEGRADED");
  __setTestAdapter("UA-MARAD", undefined);

  // Both Ukrainian rows exist side by side and stay distinct.
  const rows = health.listRegistryHealth();
  assert.ok(rows.some((r) => r.country === "UA"), "UA TCCS row present");
  assert.ok(rows.some((r) => r.country === "UA-MARAD"), "UA state-registry row present");
  assert.notEqual(
    rows.find((r) => r.country === "UA").authority,
    rows.find((r) => r.country === "UA-MARAD").authority
  );
  ok("panel: distinct 'UA TCCS' and 'UA state registry' rows (codes + authorities differ)");

  // NO 401-shape: the adapter maps a 401 to indeterminate (http-401); the
  // dispatcher flattens the reason, so the probe surfaces NO's indeterminate
  // distinctly as the KEY-ROTATED verdict note.
  freshProbe();
  let noInputs = null;
  __setTestAdapter("NO", async (inputs) => {
    noInputs = inputs;
    return { kind: "indeterminate", reason: "http-401" };
  });
  const no = await health.probeCountry("NO");
  assert.equal(no.result.outcome, "indeterminate");
  assert.equal(no.result.verdict, "degraded");
  assert.match(no.result.note, /KEY-ROTATED/);
  assert.equal(noInputs.dob, "1990-01-01"); // countries.ts key id verbatim
  assert.equal(noInputs.code, "0000000001");
  ok("probe NO: 401-shaped indeterminate => DEGRADED with distinct KEY-ROTATED note");

  // NO healthy path for contrast.
  freshProbe();
  __setTestAdapter("NO", async () => ({ kind: "no-match" }));
  assert.equal((await health.probeCountry("NO")).result.verdict, "healthy");
  ok("probe NO: 404-shaped no-match => HEALTHY");
  __setTestAdapter("NO", undefined);

  // DK network failure => ERROR verdict.
  freshProbe();
  __setTestAdapter("DK", async () => ({ kind: "indeterminate", reason: "network" }));
  const dk = await health.probeCountry("DK");
  assert.equal(dk.result.outcome, "network-error");
  assert.equal(dk.result.verdict, "error");
  ok("probe DK: network indeterminate => ERROR (registry unreachable)");

  // DK matching a synthetic all-zero number would be alarming, never healthy.
  freshProbe();
  __setTestAdapter("DK", async (inputs) => ({
    kind: "match-valid",
    cert: {
      ok: true, code: inputs.code, docCategory: "competency", hasName: true,
      fullName: "JOHN SMITH", firstName: "JOHN", lastName: "SMITH",
      title: "CoC", personalCode: "", birthDate: "", status: "valid", isValid: true,
      issuedOn: "", validUntil: "", certificateType: "CoC", issuerCountry: "DK",
      institution: "", documentType: "", sourceUrl: "", registryCountry: "DK",
      keyTrust: "public-identifier", verifiedSource: "government",
    },
  }));
  const dk2 = await health.probeCountry("DK");
  assert.equal(dk2.result.outcome, "match");
  assert.equal(dk2.result.verdict, "degraded");
  ok("probe DK: synthetic input matching => DEGRADED (unexpected match), never HEALTHY");
  __setTestAdapter("DK", undefined);
}

// ---- Cooldown: 60 s per country, memory + persisted file --------------------------

{
  freshProbe();
  __setTestAdapter("EE", async () => ({ kind: "no-match" }));

  assert.equal((await health.probeCountry("EE")).status, "ok");
  const again = await health.probeCountry("EE");
  assert.equal(again.status, "cooldown");
  assert.ok(again.retryAfterMs > 0 && again.retryAfterMs <= health.PROBE_COOLDOWN_MS);
  ok("cooldown: immediate re-probe refused with retryAfterMs");

  // Restart simulation: in-memory map gone, but the PERSISTED at still gates.
  health.__resetRegistryHealthState();
  assert.equal((await health.probeCountry("EE")).status, "cooldown");
  ok("cooldown: survives a restart via the persisted last-probe time");

  // Other countries are NOT gated by EE's cooldown (per-country buckets).
  __setTestAdapter("DK", async () => ({ kind: "no-match" }));
  resetRegistryAbuseState();
  assert.equal((await health.probeCountry("DK")).status, "ok");
  ok("cooldown: per-country — EE's cooldown never blocks DK");
  __setTestAdapter("DK", undefined);

  // Cooldown elapsed (file rewritten 2 min back + memory cleared) => probe runs.
  const file = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf-8"));
  file.EE.at = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(HEALTH_PATH, JSON.stringify(file), "utf-8");
  health.__resetRegistryHealthState();
  resetRegistryAbuseState();
  assert.equal((await health.probeCountry("EE")).status, "ok");
  ok("cooldown: elapsed window => probe allowed again");
  __setTestAdapter("EE", undefined);
}

// ---- Health file: atomic write, tolerant read --------------------------------------

{
  freshProbe();
  __setTestAdapter("EE", async () => ({ kind: "no-match" }));
  await health.probeCountry("EE");

  assert.ok(fs.existsSync(HEALTH_PATH), "health file written");
  assert.ok(!fs.existsSync(`${HEALTH_PATH}.tmp`), "no tmp file left behind (rename landed)");
  const stored = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf-8"));
  assert.equal(stored.EE.country, "EE");
  assert.equal(stored.EE.verdict, "healthy");
  assert.equal(stored.EE.outcome, "no-match");
  assert.equal(stored.EE.expected, "no-match");
  assert.ok(Number.isFinite(Date.parse(stored.EE.at)));
  assert.ok(!("raw" in stored.EE) && !("extraInputs" in stored.EE), "no probe INPUTS persisted");
  ok("health file: valid JSON, per-country last result, inputs never persisted");

  const row = health.listRegistryHealth().find((r) => r.country === "EE");
  assert.equal(row.last.verdict, "healthy");
  assert.equal(row.hasProbe, true);
  ok("panel listing: persisted last result folded into the EE row");

  // Corrupt file => tolerant read (never probed), and the next probe heals it.
  fs.writeFileSync(HEALTH_PATH, "{ not json", "utf-8");
  assert.deepEqual(health.readRegistryHealthFile(), {});
  assert.equal(health.listRegistryHealth().find((r) => r.country === "EE").last, null);
  health.__resetRegistryHealthState();
  resetRegistryAbuseState();
  assert.equal((await health.probeCountry("EE")).status, "ok");
  assert.equal(JSON.parse(fs.readFileSync(HEALTH_PATH, "utf-8")).EE.verdict, "healthy");
  ok("health file: corrupt content reads as never-probed and is healed by the next probe");
  __setTestAdapter("EE", undefined);
}

// ---- registryTrace derivation from a fixture sidecar --------------------------------

{
  const fixture = {
    extraction: {
      candidatesTried: [
        { via: "embedded", country: null, code: "https://example/qr", outcome: "error" },
        { via: "ocr", country: "EE", code: "AAAAAAAAAAAAAAAA", outcome: "no-match" },
        { via: "ocr", country: "DK", code: "00000000", outcome: "error" },
      ],
    },
  };
  const trace = admin.registryTrace(fixture);
  assert.deepEqual(trace, [
    { via: "embedded", country: null, adapterHost: null, outcome: "error" },
    { via: "ocr", country: "EE", adapterHost: domain0("EE"), outcome: "no-match" },
    { via: "ocr", country: "DK", adapterHost: domain0("DK"), outcome: "error" },
  ]);
  ok("registryTrace: candidatesTried => per-candidate {country, adapterHost, outcome} in order");

  assert.deepEqual(admin.registryTrace({ extraction: { candidatesTried: [] } }), []);
  assert.deepEqual(admin.registryTrace({ extraction: {} }), []);
  ok("registryTrace: no candidates (or legacy sidecar shape) => empty trace, never a throw");

  // Integration: the listing rows carry the trace derived from real sidecars.
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n", "latin1");
  const item = await vu.persistUpload({
    originalBuf: pdf,
    sniffedType: vu.sniffMagic(pdf),
    origName: "trace.pdf",
    derivedBuf: null,
    clientIp: "203.0.113.9",
  });
  const scPath = path.join(UPLOAD_DIR, `${item.itemId}.json`);
  const sc = JSON.parse(fs.readFileSync(scPath, "utf-8"));
  sc.extraction.candidatesTried = [
    { via: "ocr", country: "EE", code: "AAAAAAAAAAAAAAAA", outcome: "no-match" },
  ];
  fs.writeFileSync(scPath, JSON.stringify(sc, null, 2), "utf-8");

  const listed = admin.listVerifyUploads(0, 100).items.find((r) => r.itemId === item.itemId);
  assert.deepEqual(listed.registryTrace, [
    { via: "ocr", country: "EE", adapterHost: domain0("EE"), outcome: "no-match" },
  ]);
  ok("listing: rows carry registryTrace derived from the sidecar");
}

// ---- No-live-calls invariant over the whole file --------------------------------------

{
  assert.equal(registryJournal().length, journalBaseline);
  ok("mock seam: ZERO live registry calls across every health test");
}

console.log(`\nregistry-health.test: ${pass} assertions passed`);
