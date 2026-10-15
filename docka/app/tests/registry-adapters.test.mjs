// Unit tests for increment 4 of the EU VerifierRegistry plan — the Wave-1
// connectors DK / UK / NO (+ the CY doc-only adapter), each adapter's PURE
// parseResponse against the recorded/synthetic fixtures (§6.1), the dispatcher
// driven end-to-end against the §6.2 mock registry server (DK QR capability
// token, DK bare / UK public identifier, the §5.2 needs-inputs prompt), and
// the §5.4 EE-only backfill gate (zero-fetch / zero-write).
//
// Follows the admin-funnel/registry-units pattern: plain node + the `@/*`
// alias hook, deterministic, NO live registry traffic (REGISTRY_MOCK=1 + the
// REGISTRY_BASE_* overrides point every adapter at the local mock).
//
// Run: node --import ./tests/_register-alias.mjs tests/registry-adapters.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mock mode + adapter base overrides — MUST be set before any @/lib import.
process.env.REGISTRY_MOCK = "1";
process.env.REGISTRY_BASE_DK = "http://127.0.0.1:4123/dk";
process.env.REGISTRY_BASE_UK = "http://127.0.0.1:4123/uk";
process.env.REGISTRY_BASE_NO = "http://127.0.0.1:4123/no";
process.env.REGISTRY_BASE_EE = "http://127.0.0.1:4123/ee";
process.env.REGISTRY_BASE_FR = "http://127.0.0.1:4123/fr";
process.env.REGISTRY_BASE_HR = "http://127.0.0.1:4123/hr";
process.env.REGISTRY_BASE_BG = "http://127.0.0.1:4123/bg";
process.env.REGISTRY_BASE_CY = "http://127.0.0.1:4123/cy";
process.env.REGISTRY_BASE_UA = "http://127.0.0.1:4123/ua";
process.env.REGISTRY_BASE_UA_MARAD = "http://127.0.0.1:4123/ua-marad";
process.env.REGISTRY_BASE_AZ = "http://127.0.0.1:4123/az";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "registry");
const fixture = (...p) => fs.readFileSync(path.join(FIXTURES, ...p), "utf-8");
// Binary fixtures (UA-MARAD result PDFs) — utf-8 would corrupt the bytes.
const fixtureBytes = (...p) => fs.readFileSync(path.join(FIXTURES, ...p));

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

// ---- Throwaway data dir + fixture db.json (BEFORE any @/lib import) -----
// lib/db.ts resolves DATA_DIR from process.cwd() at module-evaluation time.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-registry-adapters-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });

const FIXTURE_DB = {
  seafarers: [
    // S1 — the §5.4 zero-fetch/zero-write case: identity NOT verified, holding
    // ONLY a DK public-identifier government doc (already resolved, no photo).
    {
      id: "S1",
      name: "John Smith",
      rank: "Master",
      state: "review",
      shareToken: "tok-s1-adapters",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    // S2 — EE positive control: a government EE doc with NO holder snapshot, so
    // the backfill slow path MUST still fetch the (mock) EE registry.
    {
      id: "S2",
      name: "Jaan Tamm",
      rank: "Chief Officer",
      state: "review",
      shareToken: "tok-s2-adapters",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  documents: [
    {
      id: "D1",
      seafarerId: "S1",
      title: "DK Certificate of Competency",
      docType: "Certificate of competency",
      docCategory: "competency",
      estonianCode: "70012345",
      certNumber: "70012345",
      isValid: true,
      validUntil: "2028-05-01T00:00:00.000Z",
      fileName: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      source: "government",
      reviewStatus: "pending",
      registryCountry: "DK",
      verifiedKeyTrust: "public-identifier",
      verifiedFullName: "JOHN SMITH",
      verifiedResolvedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "D2",
      seafarerId: "S2",
      title: "EE Certificate of competency",
      docType: "Certificate of competency",
      docCategory: "competency",
      estonianCode: "EEBACKFILL001",
      certNumber: "EEBACKFILL001",
      isValid: true,
      validUntil: "2027-03-28T00:00:00.000Z",
      fileName: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      source: "government",
      reviewStatus: "pending",
      registryCountry: "EE",
      verifiedKeyTrust: "capability-token",
      // NO verifiedFullName / verifiedResolvedAt — forces the slow path fetch.
    },
  ],
};
fs.writeFileSync(
  path.join(TMP, "data", "db.json"),
  JSON.stringify(FIXTURE_DB, null, 2),
  "utf-8"
);

const APP_CWD = process.cwd();
process.chdir(TMP); // MUST precede the imports below (DATA_DIR is cwd-resolved)

const { parseDK } = await import("@/lib/registry/adapters/dk");
const { parseUK, ukFormatDob } = await import("@/lib/registry/adapters/uk");
const { parseNO } = await import("@/lib/registry/adapters/no");
const { parseCY } = await import("@/lib/registry/adapters/cy");
const { parseFR, frIsoDate } = await import("@/lib/registry/adapters/fr");
const { parseHR, extractApexForm } = await import("@/lib/registry/adapters/hr");
const { parseBG } = await import("@/lib/registry/adapters/bg");
const { parseTCCS } = await import("@/lib/registry/adapters/ua-tccs");
const {
  parseUAMARAD,
  buildUAMARADForm,
  uaMaradDocParam,
  uaMaradDoctypes,
  uaMaradAmbiguousCode,
  verifyUAMARAD,
} = await import("@/lib/registry/adapters/ua-marad");
const { parseUAMARADResultPdf } = await import("@/lib/registry/adapters/ua-marad-pdf");
const { parseAZ, azWireCode, verifyAZ } = await import("@/lib/registry/adapters/az");
const { verifyEE } = await import("@/lib/registry/adapters/ee");
const { detectRegistry } = await import("@/lib/registry/detect");
const { countryEntry, stripSensitiveInputs } = await import("@/lib/registry/countries");
const {
  bindHolder,
  fetchWithGuard,
  registryJournal,
  resetRegistryJournal,
  resetRegistryAbuseState,
  resolveInput,
  verifyCapabilityToken,
} = await import("@/lib/registry");
const { backfillOwnerIdentity, newVerifiedDoc, applyVerifiedIdentity } = await import("@/lib/verify");
const { docBadge, redactCertForPublic } = await import("@/lib/cert");
const { readDB, updateDB } = await import("@/lib/db");
const { mintVerifyToken, buildPublicProof } = await import("@/lib/verify-record");
const { createMockRegistry, MOCK_CODES } = await import("./mock-registry.mjs");

// =========================================================================
// A. Denmark — parseDK (POST /api/validate JSON; §3.1 in-body 200 miss)
// =========================================================================
{
  // Valid (SYNTHETIC fixture — schema per dossier envelope).
  let out = parseDK(fixture("dk", "dk-valid.json"), "70012345");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "DK");
  assert.equal(out.cert.verifiedSource, "government");
  assert.equal(out.cert.isValid, true);
  assert.equal(out.cert.fullName, "METTE JENSEN");
  assert.equal(out.cert.certificateType, "Certificate of Competency as Master");
  assert.ok(out.cert.validUntil.startsWith("2028-05-01"));
  assert.equal(out.cert.keyTrust, "public-identifier");
  ok("DK valid fixture -> match-valid with correct VerifiedCert fields (default public-identifier)");

  // keyTrust per lookup MODE (§2.5): the QR deep-link mode stamps capability-token.
  out = parseDK(fixture("dk", "dk-valid.json"), "70012345", "capability-token");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.keyTrust, "capability-token");
  ok("DK valid fixture + QR mode -> keyTrust capability-token");

  // REAL captured miss: HTTP 200 with negative in-body result (§3.1) -> no-match.
  out = parseDK(fixture("dk", "dk-negative-result.json"), "DK-TEST-000001");
  assert.equal(out.kind, "no-match");
  ok("DK REAL negative fixture (200 in-body miss) -> no-match");

  // validationResult true with null metadata: still a positive validation.
  out = parseDK({ validationResult: true, validationMetadata: null, imagesId: "x" }, "70012345");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.hasName, false);
  ok("DK positive result with null metadata -> name-less match-valid (defensive)");

  // Malformed / drifted shapes -> indeterminate, NEVER invalid.
  out = parseDK(fixture("dk", "dk-malformed.html"), "70012345");
  assert.equal(out.kind, "indeterminate");
  out = parseDK("{\"unexpected\":true}", "70012345");
  assert.equal(out.kind, "indeterminate");
  out = parseDK("", "70012345");
  assert.equal(out.kind, "indeterminate");
  ok("DK malformed/drifted responses -> indeterminate (never a verdict)");
}

// =========================================================================
// B. United Kingdom — ukFormatDob + parseUK (GET -> HTML verdict banner)
// =========================================================================
{
  // §6.1 DOB formatting: UTC string slice, NO timezone math. The T23:00:00Z
  // instant is the one that would shift a calendar day under local-tz math.
  assert.equal(ukFormatDob("1990-01-01T00:00:00+00:00"), "1990-01-01");
  assert.equal(ukFormatDob("1990-01-01T23:00:00Z"), "1990-01-01");
  assert.equal(ukFormatDob("1990-01-01"), "1990-01-01");
  assert.equal(ukFormatDob("  1990-01-01T00:00:00.000Z "), "1990-01-01");
  assert.equal(ukFormatDob("garbage"), "");
  assert.equal(ukFormatDob(""), "");
  ok("ukFormatDob: ISO instant -> YYYY-MM-DD by UTC slice (incl. T23:00:00Z case)");

  // Valid (SYNTHETIC GOV.UK summary-list fixture).
  let out = parseUK(fixture("uk", "uk-valid.html"), "1122334455");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "UK");
  assert.equal(out.cert.fullName, "JOHN SMITH");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(out.cert.isValid, true);
  assert.ok(out.cert.validUntil.startsWith("2027-06-15"));
  assert.equal(out.cert.certificateType, "Certificate of Competency (Deck Officer)");
  assert.equal(out.cert.birthDate, "", "the lookup DOB must never be echoed into the cert");
  ok("UK valid fixture -> match-valid with holder name, expiry, type; DOB never stored");

  // REAL captured miss banner -> no-match (2026-08 wording, specimen probe).
  out = parseUK(fixture("uk", "uk-noresults.html"), "CoC0089297");
  assert.equal(out.kind, "no-match");
  ok("UK REAL 'No Record Found' fixture (2026-08 wording) -> no-match");

  // The pre-2026-08 banner wording must STAY recognized (drift tolerance both
  // directions — the checker generalized "No CoC Record Found" when it went
  // multi-doc-type).
  out = parseUK(
    "<main id=\"main-content\"><p class=\"govuk-notification-banner__heading\">No CoC Record Found, try searching again</p></main>",
    "TEST123"
  );
  assert.equal(out.kind, "no-match");
  ok("UK legacy 'No CoC Record Found' wording still -> no-match");

  // Distinct POSITIVE "not valid" verdict (§3.1) -> match-invalid.
  out = parseUK(fixture("uk", "uk-notvalid.html"), "1122334466");
  assert.equal(out.kind, "match-invalid");
  assert.equal(out.cert.isValid, false);
  ok("UK not-valid fixture -> match-invalid (honest rose, never no-match)");

  // Malformed / unknown page -> indeterminate, NEVER invalid.
  out = parseUK(fixture("uk", "uk-malformed.html"), "1122334455");
  assert.equal(out.kind, "indeterminate");
  out = parseUK("", "1122334455");
  assert.equal(out.kind, "indeterminate");
  ok("UK malformed/unknown page -> indeterminate (never a verdict)");
}

// =========================================================================
// C. Norway — parseNO (Azure APIM; §3.1 404 problem+json miss)
// =========================================================================
{
  // REAL captured miss: HTTP 404 problem+json -> no-match.
  let out = parseNO(404, fixture("no", "no-notfound.json"), "TEST-NO-000001");
  assert.equal(out.kind, "no-match");
  ok("NO REAL 404 problem+json fixture -> no-match");

  // Valid (SYNTHETIC — parser requires an explicit positive validity signal).
  out = parseNO(200, fixture("no", "no-valid.json"), "12345678901");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "NO");
  assert.equal(out.cert.fullName, "KARI NORDMANN");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.ok(out.cert.validUntil.startsWith("2028-01-01"));
  ok("NO valid fixture -> match-valid with holder + expiry");

  // Explicit negative status on a 200 record -> match-invalid.
  out = parseNO(200, fixture("no", "no-expired.json"), "12345678902");
  assert.equal(out.kind, "match-invalid");
  assert.equal(out.cert.isValid, false);
  ok("NO expired fixture -> match-invalid (explicit negative status)");

  // Unknown 200 schema / malformed -> indeterminate, NEVER a false green.
  out = parseNO(200, fixture("no", "no-malformed.json"), "12345678901");
  assert.equal(out.kind, "indeterminate");
  out = parseNO(200, "not json at all", "12345678901");
  assert.equal(out.kind, "indeterminate");
  out = parseNO(500, "{}", "12345678901");
  assert.equal(out.kind, "indeterminate");
  ok("NO unknown/malformed/5xx responses -> indeterminate (never a verdict)");
}

// =========================================================================
// D. Cyprus — capability FLIPPED to auto 2026-08-12 (deep-path probe from the
//    production box confirmed the wire; REAL miss fixture captured)
// =========================================================================
{
  assert.equal(countryEntry("CY").capability, "auto");
  ok("CY capability flipped to 'auto' (2026-08-12 production-box probe)");

  let out = parseCY(fixture("cy", "cy-valid.html"), "CY123456");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "CY");
  assert.equal(out.cert.hasName, false, "documented CY shape carries no structured holder");
  out = parseCY(fixture("cy", "cy-invalid.html"), "CY123456");
  assert.equal(out.kind, "match-invalid");
  // REAL captured miss: "The Certificate was not found" under the re-rendered form.
  out = parseCY(fixture("cy", "cy-nomatch.html"), "000000");
  assert.equal(out.kind, "no-match");
  ok("CY REAL 'The Certificate was not found' fixture -> no-match");
  // The bare form (no verdict) and unknown pages -> indeterminate, never invalid (§3.1).
  out = parseCY(fixture("cy", "cy-form.html"), "CY123456");
  assert.equal(out.kind, "indeterminate");
  out = parseCY("<html><body>totally unexpected page</body></html>", "CY123456");
  assert.equal(out.kind, "indeterminate");
  ok("CY parseResponse: valid/invalid/no-match/indeterminate mapping (unknown never invalid)");

  // 2026-08-12 tightening: verdict words WITHOUT a certificate/record anchor
  // in the same sentence must NEVER fire a verdict (drifted-page guard).
  // A session-timeout page — "expired" present, but not about a certificate.
  out = parseCY(
    `<html><body><h3>Authentication of Seafarer Certificate</h3>` +
      `<div class="alert alert-danger" role="alert">Your session has expired</div></body></html>`,
    "CY123456"
  );
  assert.equal(out.kind, "indeterminate", "session-expired page must not be match-invalid");
  // Instructional copy — "valid certificate" present, but not a verdict.
  out = parseCY(
    `<html><body><div class="alert alert-danger">Please enter a valid certificate number.</div></body></html>`,
    "CY123456"
  );
  assert.equal(out.kind, "indeterminate", "input-hint page must not be match-valid");
  // The anchor still works across the REAL alert-div structure (control case).
  out = parseCY(
    `<html><body><div class="alert alert-danger">The Certificate was not found <br></div></body></html>`,
    "CY123456"
  );
  assert.equal(out.kind, "no-match");
  ok("CY cert-anchored verdicts: session-expired / enter-a-valid-number pages -> indeterminate");

  // §5.2 multi-key prompt: nothing is fetched until the seafarerId exists.
  resetRegistryJournal();
  const res = await resolveInput("CY123456", { countryOverride: "CY" });
  assert.equal(res.kind, "needs-inputs");
  assert.equal(res.country.country, "CY");
  assert.deepEqual(res.missing.map((f) => f.key), ["seafarerId"]);
  assert.equal(registryJournal().length, 0);
  ok("CY countryOverride without seafarerId -> needs-inputs prompt, journal EMPTY");
}

// =========================================================================
// E. Detection — dossier-confirmed DK QR route + SPA hash routes (§2.5 mode)
// =========================================================================
{
  let r = detectRegistry("https://verify.dma.dk/validateqr/70012345");
  assert.equal(r.kind, "candidates");
  assert.deepEqual(r.candidates[0], {
    country: "DK",
    code: "70012345",
    certain: true,
    mode: "capability-token",
  });
  ok("DK /validateqr/<code> URL -> certain DK candidate with capability-token mode");

  // Hash-route (SPA deep-link) equivalent.
  r = detectRegistry("https://verify.dma.dk/#/validateqr/70012345");
  assert.equal(r.kind, "candidates");
  assert.equal(r.candidates[0].mode, "capability-token");
  assert.equal(r.candidates[0].code, "70012345");
  ok("DK #/validateqr/<code> hash route -> capability-token mode too");

  // The /validate/<code> deep link is NOT a QR token — default mode applies.
  r = detectRegistry("https://verify.dma.dk/validate/70012345");
  assert.equal(r.kind, "candidates");
  assert.equal(r.candidates[0].country, "DK");
  assert.equal(r.candidates[0].mode, undefined);
  ok("DK /validate/<code> deep link -> certain candidate, public-identifier default");
}

// =========================================================================
// F. Dispatcher end-to-end against the §6.2 mock registry server
// =========================================================================
const mock = createMockRegistry();
await mock.start();
try {
  resetRegistryAbuseState();
  resetRegistryJournal();

  // ---- DK QR (capability token) -> VERIFIED (§2.5 choke point) ----------
  let out = await resolveInput(`https://verify.dma.dk/validateqr/${MOCK_CODES.DK_VALID}`);
  assert.equal(out.kind, "verified");
  assert.equal(out.cert.registryCountry, "DK");
  assert.equal(out.cert.keyTrust, "capability-token");
  assert.equal(out.cert.fullName, "METTE JENSEN");
  const dkFetches = registryJournal().filter((e) => e.path === "/dk/api/validate");
  assert.equal(dkFetches.length, 1);
  ok("e2e: DK QR URL -> verified (capability-token), exactly 1 mock fetch");

  // ---- DK bare number (public identifier) -> PENDING-BINDING ------------
  // Same code: the fetch-layer cache answers, and the dispatcher's certainty
  // logic DOWNSTREAM of the cache re-stamps the trust of THIS lookup mode.
  out = await resolveInput(MOCK_CODES.DK_VALID);
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.country.country, "DK");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(
    registryJournal().filter((e) => e.path === "/dk/api/validate").length,
    1,
    "cache hit — the adapter must not be re-fetched"
  );
  ok("e2e: DK bare paste of the same code -> pending-binding via cache, keyTrust re-stamped");

  // ---- legacy verifyCode wrapper: DK QR yes, DK bare never --------------
  let legacy = await verifyCapabilityToken(`https://verify.dma.dk/validateqr/${MOCK_CODES.DK_VALID}`);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.keyTrust, "capability-token");
  legacy = await verifyCapabilityToken(MOCK_CODES.DK_VALID);
  assert.equal(legacy.ok, false);
  ok("legacy verifyCode: DK QR verifies; DK bare (public identifier) can never mint ok:true");

  // ---- DK miss -> continue-on-no-match -> EE fallback -> DK-attributed miss
  // STALE-TEST FIX (vr2 item 1, 2026-07-21): this previously expected the
  // generic EE not-found error. The dispatcher now attributes the dead end to
  // the SPECIFIC-pattern candidate that definitively missed (DK) when the only
  // other miss is the appended EE fallback — pinned in registry-units §J.
  resetRegistryJournal();
  out = await resolveInput("70099999"); // DK-pattern code the mock does not know
  assert.equal(out.kind, "error");
  assert.match(out.error, /Danish Maritime Authority/);
  assert.match(out.error, /found no record/i);
  assert.doesNotMatch(out.error, /No certificate, medical/);
  const paths = registryJournal().map((e) => e.path);
  assert.ok(paths.includes("/dk/api/validate"), "DK tried first");
  assert.ok(
    paths.some((p) => p.startsWith("/ee/")),
    "EE fallback reached AFTER the DK no-match (continue-on-miss)"
  );
  ok("e2e: DK in-body miss -> EE fallback still tried -> miss attributed to DK");

  // ---- UK multi-key: certain candidate prompts, then verifies ----------
  out = await resolveInput(MOCK_CODES.UK_VALID, { countryOverride: "UK" });
  assert.equal(out.kind, "needs-inputs");
  assert.equal(out.country.country, "UK");
  assert.deepEqual(out.missing.map((f) => f.key), ["dob"]);
  ok("e2e: UK countryOverride without dob -> needs-inputs prompt (nothing fetched)");

  out = await resolveInput(MOCK_CODES.UK_VALID, {
    countryOverride: "UK",
    extraInputs: { dob: MOCK_CODES.UK_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.registryCountry, "UK");
  assert.equal(out.cert.fullName, "JOHN SMITH");
  assert.equal(out.cert.keyTrust, "public-identifier");
  ok("e2e: UK with dob -> pending-binding (public identifier NEVER auto-green)");

  // ---- UK positive invalid verdict from a CERTAIN candidate -------------
  out = await resolveInput(MOCK_CODES.UK_NOTVALID, {
    countryOverride: "UK",
    extraInputs: { dob: MOCK_CODES.UK_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.isValid, false);
  ok("e2e: UK not-valid verdict (certain) -> honest pending-binding with isValid:false");

  // ---- NO bare code: deferred needs-inputs after the EE fallback misses -
  resetRegistryJournal();
  out = await resolveInput(MOCK_CODES.NO_VALID); // 11-digit -> [NO, EE]
  assert.equal(out.kind, "needs-inputs");
  assert.equal(out.country.country, "NO");
  assert.deepEqual(out.missing.map((f) => f.key), ["dob"]);
  assert.ok(
    registryJournal().every((e) => e.path.startsWith("/ee/")),
    "only the EE fallback was fetched — the NO prompt was deferred, not skipped"
  );
  ok("e2e: NO bare code without dob -> EE fallback first, deferred needs-inputs surfaces");

  out = await resolveInput(MOCK_CODES.NO_VALID, {
    countryOverride: "NO",
    extraInputs: { dob: MOCK_CODES.NO_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.registryCountry, "NO");
  assert.equal(out.cert.fullName, "KARI NORDMANN");
  ok("e2e: NO with dob -> pending-binding (mock APIM hit)");

  // ---- NO explicit invalid -> honest rose from a certain candidate ------
  out = await resolveInput(MOCK_CODES.NO_EXPIRED, {
    countryOverride: "NO",
    extraInputs: { dob: MOCK_CODES.NO_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.isValid, false);
  ok("e2e: NO expired verdict (certain) -> pending-binding with isValid:false");
} finally {
  await mock.stop();
}

// =========================================================================
// G. §5.4 EE-only backfill gate — zero-fetch / zero-write (mock still down:
//    any accidental fetch would surface in the journal regardless)
// =========================================================================
{
  const dbPath = path.join(TMP, "data", "db.json");

  // Positive control FIRST (§6.2: journal-empty assertions are meaningful only
  // after a fetch provably records): the EE profile S2 has an unresolved EE
  // doc, so its owner load MUST hit the (mock) EE registry.
  const mock2 = createMockRegistry();
  await mock2.start();
  try {
    resetRegistryJournal();
    resetRegistryAbuseState();
    await backfillOwnerIdentity("S2");
    assert.ok(
      registryJournal().some((e) => e.path.startsWith("/ee/")),
      "EE positive control must record EE fetches in the journal"
    );
    ok("backfill positive control: EE profile load DOES fetch (journal records it)");

    // The §5.4 case: S1 holds ONLY a DK public-identifier doc, no photo.
    // First and second owner load: ZERO registry fetches AND ZERO db writes.
    for (const round of [1, 2]) {
      resetRegistryJournal();
      const before = fs.readFileSync(dbPath, "utf-8");
      await backfillOwnerIdentity("S1");
      assert.equal(
        registryJournal().length,
        0,
        `owner load round ${round} must perform ZERO registry fetches`
      );
      assert.equal(
        fs.readFileSync(dbPath, "utf-8"),
        before,
        `owner load round ${round} must perform ZERO db writes`
      );
    }
    const s1 = readDB().seafarers.find((s) => s.id === "S1");
    assert.equal(s1.identityVerified ?? false, false);
    assert.equal(s1.verifiedName ?? undefined, undefined);
    ok("§5.4 gate: DK-public-identifier-only profile -> 0 fetches AND 0 db writes (both loads), identity untouched");
  } finally {
    await mock2.stop();
  }
}

// =========================================================================
// H. France — parseFR (POST -> server-rendered HTML; §3.1 alert-warning miss)
// =========================================================================
{
  // REAL captured miss: the alert-warning "No result correponds" page.
  let out = parseFR(fixture("fr", "fr-nomatch.html"), "1234567");
  assert.equal(out.kind, "no-match");
  ok("FR REAL no-result fixture -> no-match");

  // Valid (SYNTHETIC detail table + explicit Statut Valide).
  out = parseFR(fixture("fr", "fr-valid.html"), "7654321");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "FR");
  assert.equal(out.cert.verifiedSource, "government");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(out.cert.fullName, "CAMILLE MARTIN");
  assert.equal(out.cert.certificateType, "Brevet de capitaine 3000 (STCW II/2)");
  assert.ok(out.cert.validUntil.startsWith("2028-02-15"), "French dd/mm/yyyy converted by string rearrangement");
  ok("FR valid fixture -> match-valid with holder, title, converted expiry");

  // Explicit "Non valide" verdict -> match-invalid (honest rose from a certain candidate).
  out = parseFR(fixture("fr", "fr-invalid.html"), "7654329");
  assert.equal(out.kind, "match-invalid");
  assert.equal(out.cert.isValid, false);
  ok("FR 'Non valide' fixture -> match-invalid");

  // Malformed / drifted -> indeterminate, NEVER a verdict.
  out = parseFR(fixture("fr", "fr-malformed.html"), "7654321");
  assert.equal(out.kind, "indeterminate");
  out = parseFR("", "7654321");
  assert.equal(out.kind, "indeterminate");
  ok("FR malformed/empty responses -> indeterminate");

  // Date conversion is pure string rearrangement (no timezone math).
  assert.equal(frIsoDate("15/02/2028"), "2028-02-15T00:00:00+00:00");
  assert.equal(frIsoDate("2028-02-15"), "2028-02-15T00:00:00+00:00");
  assert.equal(frIsoDate("garbage"), "");
  ok("FR frIsoDate: dd/mm/yyyy + ISO accepted, garbage rejected");
}

// =========================================================================
// I. Croatia — extractApexForm + parseHR (§3.1: no_data miss, ORA-20999)
// =========================================================================
{
  // The APEX plumbing extractor against the form fixture.
  const form = extractApexForm(fixture("hr", "hr-form.html"));
  assert.ok(form, "form plumbing must extract");
  assert.match(form.action, /wwv_flow\.accept/);
  assert.equal(form.fields.p_flow_id, "300");
  assert.equal(form.fields.p_instance, "SID123");
  assert.equal(form.fields.pSalt, "SALT456");
  assert.equal(extractApexForm("<html><body>no form</body></html>"), null);
  ok("HR extractApexForm: action + hidden plumbing extracted; drift -> null");

  // REAL captured miss: the no_data region.
  let out = parseHR(fixture("hr", "hr-nomatch.html"), "12345");
  assert.equal(out.kind, "no-match");
  ok("HR REAL 'Nema podataka.' fixture -> no-match");

  // ORA-20999 -> indeterminate (input/session error, NEVER a verdict — §3.1).
  out = parseHR(fixture("hr", "hr-ora20999.html"), "12345");
  assert.equal(out.kind, "indeterminate");
  assert.match(out.reason, /ora-20999/i);
  assert.match(out.reason, /assisted/i, "the R10 auto-demote hint is part of the reason");
  ok("HR ORA-20999 fixture -> indeterminate with the R10 demote hint");

  // Valid (SYNTHETIC report region with Ime/Prezime headers + serial echo).
  out = parseHR(fixture("hr", "hr-valid.html"), "12345");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "HR");
  assert.equal(out.cert.fullName, "IVAN HORVAT");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.ok(out.cert.validUntil.startsWith("2028-03-21"), "Croatian dd.mm.yyyy converted");
  ok("HR valid fixture -> match-valid with holder + expiry");

  // Serial-echo guard: a report for a DIFFERENT serial is not an answer.
  out = parseHR(fixture("hr", "hr-valid.html"), "99999");
  assert.equal(out.kind, "indeterminate");
  ok("HR serial mismatch in the report -> indeterminate (drift guard)");

  // Malformed / drifted -> indeterminate.
  out = parseHR(fixture("hr", "hr-malformed.html"), "12345");
  assert.equal(out.kind, "indeterminate");
  out = parseHR("", "12345");
  assert.equal(out.kind, "indeterminate");
  ok("HR malformed/empty responses -> indeterminate");
}

// =========================================================================
// J. Bulgaria — parseBG (JSON presence check; §3.1 200 generic-failure miss)
// =========================================================================
{
  // REAL captured miss: HTTP 200 generic failure -> no-match, NEVER invalid.
  let out = parseBG(200, fixture("bg", "bg-nomatch.json"), "543210");
  assert.equal(out.kind, "no-match");
  ok("BG REAL generic-failure fixture (200) -> no-match (presence source never says invalid)");

  // Match (shape from the site's own client JS): presence -> name-less
  // registry-confirmed cert, NEVER government (§2.5).
  out = parseBG(200, fixture("bg", "bg-valid.json"), "543210");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "BG");
  assert.equal(out.cert.hasName, false, "presence result is name-less by design");
  assert.equal(out.cert.fullName, "");
  assert.equal(out.cert.verifiedSource, "registry", "presence -> registry, NOT government (§2.5)");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.match(out.cert.title, /2017\+/, "the 2017+ coverage note rides on the cert title");
  ok("BG presence fixture -> match-valid with verifiedSource 'registry', name-less");

  // 400 express-validator -> indeterminate (OUR input was rejected, no verdict).
  out = parseBG(400, fixture("bg", "bg-badrequest.json"), "543210");
  assert.equal(out.kind, "indeterminate");
  ok("BG 400 input-rejection -> indeterminate");

  // R10 tripwire: an ACTIVE reCAPTCHA challenge instead of the JSON answer.
  out = parseBG(200, fixture("bg", "bg-captcha.html"), "543210");
  assert.equal(out.kind, "indeterminate");
  assert.match(out.reason, /captcha-active/i);
  assert.match(out.reason, /assisted/i, "the auto-demote hint (countries.ts flip) is in the reason");
  ok("BG active-CAPTCHA response -> indeterminate + R10 demote hint (never solved)");

  // Malformed -> indeterminate.
  out = parseBG(200, "not json", "543210");
  assert.equal(out.kind, "indeterminate");
  out = parseBG(200, "{}", "543210");
  assert.equal(out.kind, "indeterminate");
  ok("BG malformed/unknown bodies -> indeterminate");
}

// =========================================================================
// K. UA-TCCS — parseTCCS (training center; §3.1 ambiguous miss NEVER invalid)
// =========================================================================
{
  // OBSERVED ambiguous miss ("contact us") -> indeterminate, NEVER invalid.
  let out = parseTCCS(fixture("ua", "ua-tccs-miss.html"), "20931231");
  assert.equal(out.kind, "indeterminate");
  assert.match(out.reason, /ambiguous-miss/);
  ok("UA-TCCS 'contact us' miss -> indeterminate (never invalid, never even no-match)");

  // Default (no submission) page -> indeterminate too.
  out = parseTCCS(fixture("ua", "ua-tccs-default.html"), "20931231");
  assert.equal(out.kind, "indeterminate");
  ok("UA-TCCS default page -> indeterminate");

  // Hit (SYNTHETIC high-confidence markers: wrapper + number echo + 'is valid').
  out = parseTCCS(fixture("ua", "ua-tccs-valid.html"), "20930001");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.registryCountry, "UA");
  assert.equal(out.cert.verifiedSource, "registry", "training center NEVER claims government (§2.5)");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(out.cert.lastName, "IVANOV");
  assert.match(out.cert.certificateType, /Basic Safety Training/);
  assert.ok(out.cert.validUntil.startsWith("2031-01-12"));
  ok("UA-TCCS valid fixture -> match-valid registry-source training cert");

  // Expired -> match-invalid (positive answer: exists AND expired).
  const expired = parseTCCS(fixture("ua", "ua-tccs-expired.html"), "20930002");
  assert.equal(expired.kind, "match-invalid");
  assert.equal(expired.cert.isValid, false);
  assert.ok(expired.cert.validUntil.startsWith("2020-01-10"));
  ok("UA-TCCS expired fixture -> match-invalid with past expiry");

  // §5.1 precedence wiring: the expired TCCS doc's badge reads
  // "Registry-confirmed · expired" — expiry visuals outrank the calm teal.
  const badge = docBadge({
    verified: false,
    source: "registry",
    validUntil: expired.cert.validUntil,
  });
  assert.deepEqual(badge, { status: "expired", label: "Registry-confirmed · expired" });
  ok("badge wiring: expired TCCS fixture -> 'Registry-confirmed · expired' (never plain teal)");

  // Wrong-number echo / drifted pages -> indeterminate.
  out = parseTCCS(fixture("ua", "ua-tccs-valid.html"), "555555");
  assert.equal(out.kind, "indeterminate");
  out = parseTCCS(fixture("ua", "ua-tccs-malformed.html"), "20930001");
  assert.equal(out.kind, "indeterminate");
  out = parseTCCS("", "20930001");
  assert.equal(out.kind, "indeterminate");
  ok("UA-TCCS echo-guard + malformed/empty -> indeterminate");
}

// =========================================================================
// K2. UA-MARAD — parseUAMARAD (state registry; date-gated miss, pdf-link hit)
// =========================================================================
{
  // REAL captured miss ("Нажаль документ не знайдено…", 2026-08-13) with a
  // 2023+ issue date -> the quick index is authoritative: definitive no-match.
  let out = parseUAMARAD(fixture("ua-marad", "ua-marad-miss.html"), "00000", "2024-01-01");
  assert.equal(out.kind, "no-match");
  ok("UA-MARAD miss + issue date >= 2023 -> definitive no-match (date gate, positive side)");

  // Same miss page with a PRE-2023 issue date -> inconclusive, never a verdict.
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-miss.html"), "00000", "2019-06-15");
  assert.equal(out.kind, "indeterminate");
  assert.match(out.reason, /not-in-quick-index/);
  ok("UA-MARAD miss + issue date < 2023 -> indeterminate 'not-in-quick-index' (date gate, negative side)");

  // The miss marker is hardcoded Ukrainian EVEN in the English session — the
  // EN capture must parse identically (never anchored on the "Нажаль" typo).
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-miss-en.html"), "00000", "2024-01-01");
  assert.equal(out.kind, "no-match");
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-miss-en.html"), "00000", "2020-01-01");
  assert.equal(out.kind, "indeterminate");
  ok("UA-MARAD EN-session miss page -> same Ukrainian marker, same date-gated mapping");

  // REAL captured hit page (2026-08-24, scrubbed in place — see the fixture
  // README): result block with the bilingual hash-link download anchors ->
  // match-valid GOVERNMENT (this IS the flag state, unlike TCCS), first
  // anchor captured as the evidence sourceUrl; name-less (the result page
  // carries no holder fields — the PII lives in the linked PDFs).
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-valid.html"), "12345/2024", "2024-05-07");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.verifiedSource, "government");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(out.cert.registryCountry, "UA-MARAD");
  assert.equal(out.cert.hasName, false);
  assert.match(
    out.cert.sourceUrl,
    /^https:\/\/vrf\.marad\.gov\.ua\/services\/documents\/pdf\/hash\/[A-Za-z0-9_-]{20,}$/,
    "evidence URL is the portal's hash-link form (real capture shape)"
  );
  ok("UA-MARAD REAL hit page -> match-valid government, hash-link evidence as sourceUrl");

  // The legacy synthetic hit page (.pdf-suffixed result links) STILL parses
  // match-valid — guard (b) keeps the legacy href shape for portal variants.
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-valid-legacy.html"), "12345/2024", "2024-05-07");
  assert.equal(out.kind, "match-valid");
  assert.match(out.cert.sourceUrl, /result-12345-2024-en\.pdf$/);
  ok("UA-MARAD legacy .pdf-link hit page still parses match-valid (guard back-compat)");

  // The bare form / drifted pages / empty body -> indeterminate; NOTHING ever
  // maps match-invalid (TCCS precedent).
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-form.html"), "00000", "2024-01-01");
  assert.equal(out.kind, "indeterminate");
  out = parseUAMARAD("<html><body>Cloudflare challenge</body></html>", "00000", "2024-01-01");
  assert.equal(out.kind, "indeterminate");
  out = parseUAMARAD("", "00000", "2024-01-01");
  assert.equal(out.kind, "indeterminate");
  ok("UA-MARAD blank form / drift / empty -> indeterminate (match-invalid unreachable)");

  // Doctype + date wiring (dossier field names verbatim; non-padded selects;
  // only the five approved codes; submit value is the Ukrainian button text).
  const form = buildUAMARADForm("70", "123452024", "2024-05-07");
  assert.equal(form.get("qualification_doctype"), "70");
  assert.equal(form.get("doc"), "12345/2024", "slash form restored from normalized digits + issue year");
  assert.equal(form.get("qualification_gmzlb_date_day"), "7");
  assert.equal(form.get("qualification_gmzlb_date_month"), "5");
  assert.equal(form.get("qualification_gmzlb_date_year"), "2024");
  assert.equal(form.get("submit"), "Зробити запит");
  assert.equal(buildUAMARADForm("70", "00000", "not-a-date"), null, "unparseable date never posts");
  assert.deepEqual([...uaMaradDoctypes().keys()], ["70", "71", "72", "73", "74"], "ONLY the five wire doctypes (never 76/849)");
  ok("UA-MARAD form wiring: doctype/doc/date fields verbatim, five doctypes only");

  // Doc-param normalization is SOFT: pass-through when the year doesn't match,
  // spaces stripped around a kept slash, never a block.
  assert.equal(uaMaradDocParam("12345 / 2024", "2024"), "12345/2024");
  assert.equal(uaMaradDocParam("00000", "2024"), "00000");
  assert.equal(uaMaradDocParam("123452023", "2024"), "123452023", "year mismatch -> no reconstruction");
  ok("UA-MARAD doc normalization: strips spaces, reconstructs only on an issue-year match");

  // ---- Review hardening 2026-08-13: scoped pdf-hit parsing ----------------
  // (a) The old page-wide href scan is dead: a stray manual/regulation .pdf
  // injected into the blank-form re-render must NOT read as a hit.
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-form.html") + '<a href="/docs/manual.pdf">manual</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "indeterminate", "non-result-context .pdf anchor is never evidence");
  // (b) A result-context anchor on a FOREIGN host is never evidence either.
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-form.html") +
      '<a href="https://evil.example/result.pdf" title="Verification result">Download the verification result</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "indeterminate", "foreign-host .pdf anchor is never evidence");
  // (c) Miss precedence pinned: the miss page WITH a plausible same-host
  // result .pdf link still answers the miss (marker beats link scan).
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-miss.html") +
      '<a href="/storage/verification/result-00000-2024-en.pdf" title="Verification result (EN)">Download the verification result (English)</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "no-match", "miss marker takes precedence over any .pdf link");
  ok("UA-MARAD pdf-hit guards: result-context + same-host anchors only, miss precedence pinned");

  // ---- 2026-08-24 real-capture guard deltas -------------------------------
  // (d) A REAL-shape hash anchor (no .pdf suffix, result-context title) is
  // accepted even outside the captured page.
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-form.html") +
      '<a href="/services/documents/pdf/hash/SOMEFAKETOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" title="Підтвердження кваліфікації моряка українською">EN</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "match-valid", "real-shape hash anchor with result-context title is evidence");
  // (e) The distractor "Запит на верифікацію" anchor (add/collection path,
  // non-result title) present on the REAL hit page is never evidence on its own.
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-form.html") +
      '<a href="/services/documents/add/collection/17" class="btn btn-primary" title="Запит на верифікацію">Запит на верифікацію</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "indeterminate", "the add/collection request anchor is never evidence");
  // (f) A hash-shaped link on a FOREIGN host is never evidence either.
  out = parseUAMARAD(
    fixture("ua-marad", "ua-marad-form.html") +
      '<a href="https://evil.example/services/documents/pdf/hash/SOMEFAKETOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" title="Підтвердження кваліфікації моряка українською">EN</a>',
    "00000",
    "2024-01-01"
  );
  assert.equal(out.kind, "indeterminate", "foreign-host hash anchor is never evidence");
  ok("UA-MARAD real-capture guards: hash shape accepted, distractor + foreign host rejected");

  // ---- Review hardening 2026-08-13: unambiguous slash restore -------------
  // "12024" issued 2024 is EITHER doc "1/2024" or the literal "12024" —
  // backtracking must not decide: the 5-8 digit band passes through unchanged.
  assert.equal(uaMaradDocParam("12024", "2024"), "12024", "ambiguous band passes through unchanged");
  assert.equal(uaMaradDocParam("123452024", "2024"), "12345/2024", ">=9 digits stays a deterministic restore");
  assert.equal(uaMaradAmbiguousCode("12024", "2024"), true);
  assert.equal(uaMaradAmbiguousCode("123452024", "2024"), false, ">=9 digits is unambiguous");
  assert.equal(uaMaradAmbiguousCode("00000", "2024"), false, "not ending in the issue year");
  assert.equal(uaMaradAmbiguousCode("12345/2024", "2024"), false, "explicit slash is never ambiguous");
  // And the honesty downgrade: a 2023+ miss on an ambiguous-band code is
  // indeterminate — the wrong document form may have been queried.
  out = parseUAMARAD(fixture("ua-marad", "ua-marad-miss.html"), "12024", "2024-01-01");
  assert.equal(out.kind, "indeterminate");
  assert.equal(out.reason, "ambiguous-number-normalization");
  ok("UA-MARAD ambiguous-band code: pass-through doc param + 2023+ miss downgraded to indeterminate");
}

// =========================================================================
// K2b. UA-MARAD result-PDF date parser (v2-A) — pure, dependency-free
// (zlib inflate + Tj/TJ text-operator scan, UTF-16BE string decode). The
// fixtures are SYNTHESIZED (scripts/generate-ua-marad-result-fixtures.mjs)
// mirroring the real 2026-08-24 captures' operator structure with the holder
// PII scrubbed; the parser was validated against the raw captures (CoC EN ->
// unlimited + issuedOn 2024-10-25; endorsement UK -> 2029-10-20/2024-10-25).
// =========================================================================
{
  // EN session, CoC: VALID banner, "expire: Unlimited", issue date from the
  // "№12345/2024 from 25.10.2024" number line (never the DOB, never the
  // verification timestamp — both are present in the fixture as decoys).
  let parsed = parseUAMARADResultPdf(new Uint8Array(fixtureBytes("ua-marad", "result-coc-en.pdf")));
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.unlimited, true, "CoC prints 'expire: Unlimited'");
  assert.equal(parsed.validUntil, null, "unlimited carries NO end date");
  assert.equal(parsed.issuedOn, "2024-10-25");
  ok("result-PDF parser: EN CoC -> valid / Unlimited / issuedOn 2024-10-25");

  // Ukrainian session, endorsement: ДІЙСНИЙ banner, "до: 20.10.2029" expire,
  // "№12345/2024 від 25.10.2024" issue line — the 5-year validity the
  // operator live-verified.
  parsed = parseUAMARADResultPdf(new Uint8Array(fixtureBytes("ua-marad", "result-endorse-uk.pdf")));
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.unlimited, false);
  assert.equal(parsed.validUntil, "2029-10-20");
  assert.equal(parsed.issuedOn, "2024-10-25");
  ok("result-PDF parser: UK endorsement -> valid / validUntil 2029-10-20 / issuedOn 2024-10-25");

  // Failure honesty: garbage, truncation, and empty input NEVER throw —
  // all-nulls, the caller's registry hit stands.
  parsed = parseUAMARADResultPdf(new Uint8Array(Buffer.from("this is not a pdf at all")));
  assert.deepEqual(parsed, { status: "unknown", validUntil: null, issuedOn: null, unlimited: false });
  const whole = fixtureBytes("ua-marad", "result-endorse-uk.pdf");
  parsed = parseUAMARADResultPdf(new Uint8Array(whole.subarray(0, 300))); // truncated mid-stream
  assert.equal(typeof parsed.status, "string");
  parsed = parseUAMARADResultPdf(new Uint8Array(0));
  assert.deepEqual(parsed, { status: "unknown", validUntil: null, issuedOn: null, unlimited: false });
  ok("result-PDF parser: garbage / truncated / empty bytes -> nulls, no throw");
}

// =========================================================================
// L. Malta — DOC-ONLY country entry, NO adapter registration (CY-style)
// =========================================================================
{
  assert.equal(countryEntry("MT").capability, "unverified-endpoint");
  ok("MT capability stays 'unverified-endpoint' (QR pattern needs a physical cert)");

  resetRegistryJournal();
  const res = await resolveInput("MT-QR-TOKEN-123456", { countryOverride: "MT" });
  assert.equal(res.kind, "assist");
  assert.equal(res.country.country, "MT");
  assert.equal(registryJournal().length, 0);
  ok("MT at runtime -> assist outcome, fetchWithGuard journal EMPTY (never fetched)");
}

// =========================================================================
// M. Wave-2 e2e against the §6.2 mock: FR / HR / BG / UA-TCCS resolve drives
// =========================================================================
const mock3 = createMockRegistry();
await mock3.start();
try {
  resetRegistryAbuseState();
  resetRegistryJournal();

  // ---- FR: needs-inputs prompt (optional numeroVersion never gates) ------
  let out = await resolveInput(MOCK_CODES.FR_TITRE, { countryOverride: "FR" });
  assert.equal(out.kind, "needs-inputs");
  assert.equal(out.country.country, "FR");
  const frKeys = out.missing.map((f) => f.key);
  assert.ok(frKeys.includes("numeroAdm"), "required numeroAdm prompted");
  assert.ok(frKeys.includes("numeroVersion"), "optional numeroVersion shown in the prompt");
  assert.equal(out.missing.find((f) => f.key === "numeroVersion").optional, true);
  ok("e2e FR: countryOverride without numeroAdm -> needs-inputs (optional field flagged)");

  // With ONLY the required key -> the lookup proceeds (optional never gates).
  resetRegistryJournal();
  out = await resolveInput(MOCK_CODES.FR_TITRE, {
    countryOverride: "FR",
    extraInputs: { numeroAdm: MOCK_CODES.FR_ADM },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.registryCountry, "FR");
  assert.equal(out.cert.fullName, "CAMILLE MARTIN");
  // 2026-08-12 session drift: the lookup is the browser-equivalent GET+POST
  // pair (the mock answers the REAL technical-error page to a cookie-less
  // POST, so a pending-binding here PROVES the session cookie rode along).
  const frPaths = registryJournal().filter((e) => e.path === "/fr/promete/ConsulterTitreOuVisa");
  assert.equal(frPaths.length, 2, "FR lookup = session GET + one POST");
  ok("e2e FR: numeroAdm alone -> pending-binding via session GET + POST (never auto-green)");

  // bindHolder completes the §2.5 choke point -> storable government doc.
  const frBind = bindHolder(out, { id: "sf-fr", name: "Camille Martin" });
  assert.equal(frBind.ok, true);
  const frDoc = newVerifiedDoc("sf-fr", frBind.cert);
  assert.equal(frDoc.source, "government");
  assert.equal(frDoc.registryCountry, "FR");
  ok("e2e FR: bindHolder match -> newVerifiedDoc stores source 'government'");

  // FR explicit invalid verdict from a certain candidate.
  out = await resolveInput(MOCK_CODES.FR_TITRE_INVALID, {
    countryOverride: "FR",
    extraInputs: { numeroAdm: MOCK_CODES.FR_ADM },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.isValid, false);
  ok("e2e FR: 'Non valide' -> honest pending-binding with isValid:false");

  // ---- HR: DEMOTED to assisted 2026-08-12 (R10 — reCAPTCHA v3 on the COCV
  // search). The dispatcher answers the ASSIST panel before any adapter
  // lookup; adapters/hr.ts stays dormant for a future re-flip.
  assert.equal(countryEntry("HR").capability, "assisted");
  resetRegistryJournal();
  out = await resolveInput(MOCK_CODES.HR_SERIAL, {
    countryOverride: "HR",
    extraInputs: { firstName: MOCK_CODES.HR_FIRST, lastName: MOCK_CODES.HR_LAST },
  });
  assert.equal(out.kind, "assist");
  assert.equal(out.country.country, "HR");
  assert.equal(out.prefill.serial, MOCK_CODES.HR_SERIAL, "pasted serial prefills the assist panel");
  assert.equal(registryJournal().length, 0, "assisted HR NEVER fetches (R10 demote)");
  // The two-field name prompt survives as assist metadata (§3 no-auto-split
  // rule): first/last stay SEPARATE prompted fields in the country entry.
  assert.deepEqual(
    countryEntry("HR").inputs.filter((f) => f.source === "prompt").map((f) => f.key),
    ["firstName", "lastName"]
  );
  ok("e2e HR: R10 demote -> assist outcome, journal EMPTY, two-field prompt metadata intact");

  // ---- CY: FLIPPED to auto 2026-08-12 — deep-path session GET + one POST ---
  resetRegistryJournal();
  out = await resolveInput(MOCK_CODES.CY_VALID, {
    countryOverride: "CY",
    extraInputs: { seafarerId: MOCK_CODES.CY_SEA_ID },
  });
  assert.equal(out.kind, "pending-binding", "public identifier NEVER auto-green");
  assert.equal(out.cert.registryCountry, "CY");
  assert.equal(out.cert.hasName, false, "CY results carry no structured holder");
  const cyPath = "/cy/emarcos/cert_ver/stcw/sea_auth_search_form.php";
  const cyPaths = registryJournal().filter((e) => e.path === cyPath);
  assert.equal(cyPaths.length, 2, "CY lookup = session GET + ONE POST (the mock enforces the PHPSESSID)");
  ok("e2e CY: valid pair -> pending-binding via deep-path session round-trip");

  // A name-less CY match can never name anyone: bindHolder downgrades it to a
  // teal registry doc (§2.5 rule 4) regardless of the profile name.
  const cyBind = bindHolder(out, { id: "sf-cy", name: "Someone Else" });
  assert.equal(cyBind.ok, true);
  assert.equal(cyBind.cert.verifiedSource, "registry");
  ok("e2e CY: name-less match -> bindHolder downgrade to 'registry' (never government)");

  // CY REAL miss from a certain candidate -> honest per-country message (B6).
  out = await resolveInput("999999", {
    countryOverride: "CY",
    extraInputs: { seafarerId: "111111" },
  });
  assert.equal(out.kind, "error");
  assert.match(out.error, /Shipping Deputy Ministry/);
  assert.match(out.error, /found no record/i);
  assert.doesNotMatch(out.error, /No certificate, medical/);
  ok("e2e CY: 'The Certificate was not found' -> no-match -> per-country honest miss (B6)");

  // ---- BG: EGN prompt -> presence -> registry doc, EGN never persists ----
  out = await resolveInput(MOCK_CODES.BG_DOC, { countryOverride: "BG" });
  assert.equal(out.kind, "needs-inputs");
  assert.deepEqual(out.missing.map((f) => f.key), ["egn"]);
  assert.equal(out.missing[0].sensitive, true, "the EGN field is marked sensitive");
  ok("e2e BG: countryOverride without EGN -> sensitive needs-inputs prompt");

  out = await resolveInput(MOCK_CODES.BG_DOC, {
    countryOverride: "BG",
    extraInputs: { egn: MOCK_CODES.BG_EGN },
  });
  assert.equal(out.kind, "pending-binding", "auto-presence is public-identifier -> pending-binding");
  assert.equal(out.cert.verifiedSource, "registry");
  assert.equal(out.cert.hasName, false);

  // bindHolder: a registry-source presence cert binds WITHOUT any name check
  // and stays 'registry' — and the identity gate never fires for it.
  const sfBG = { id: "S1", name: "John Smith", identityVerified: false };
  const bgBind = bindHolder(out, sfBG);
  assert.equal(bgBind.ok, true);
  assert.equal(bgBind.cert.verifiedSource, "registry");
  assert.equal(applyVerifiedIdentity(sfBG, bgBind.cert), false);
  assert.equal(sfBG.identityVerified, false);
  assert.equal(sfBG.verifiedName, undefined);
  ok("e2e BG: presence -> bindHolder ok as 'registry', identity NEVER written");

  const bgDoc = newVerifiedDoc("S1", bgBind.cert);
  assert.equal(bgDoc.source, "registry");
  const bgBadge = docBadge({
    verified: bgDoc.source === "government",
    source: bgDoc.source,
    validUntil: bgDoc.validUntil,
  });
  assert.equal(bgBadge.status, "registry-doc");
  assert.equal(bgBadge.label, "Registry-confirmed — holder not verified");
  ok("e2e BG: stored doc -> source 'registry' -> TEAL registry-doc badge (never green)");

  // Persist the BG doc and prove the WHOLE §2.4 sensitive contract:
  //   EGN never in db.json, never in the journal, cache keys hashed.
  await updateDB((d) => {
    d.documents.push(bgDoc);
  });
  const dbRaw = fs.readFileSync(path.join(TMP, "data", "db.json"), "utf-8");
  assert.ok(!dbRaw.includes(MOCK_CODES.BG_EGN), "EGN must NEVER land in db.json");
  const kept = stripSensitiveInputs("BG", { egn: MOCK_CODES.BG_EGN, other: "x" });
  assert.deepEqual(kept, { other: "x" }, "stripSensitiveInputs drops the EGN before any store");
  const stateRaw = JSON.stringify(globalThis.__dockaRegistryState ?? {});
  assert.ok(
    !stateRaw.includes(MOCK_CODES.BG_EGN),
    "EGN must not sit raw anywhere in registry state (journal, buckets, cache keys are SHA-256)"
  );
  assert.ok(
    registryJournal().every((e) => !e.path.includes(MOCK_CODES.BG_EGN)),
    "journal records host+path only — the EGN travels in the POST body"
  );
  ok("e2e BG: EGN absent from db.json + journal + registry state (cache keys hashed)");

  // Error messages never echo the EGN: unknown EGN -> BG generic failure ->
  // no-match -> the per-country miss message (B6), naming the authority only.
  out = await resolveInput(MOCK_CODES.BG_DOC, {
    countryOverride: "BG",
    extraInputs: { egn: "1111111111" },
  });
  assert.equal(out.kind, "error");
  assert.ok(!out.error.includes("1111111111"), "error text must never echo the EGN");
  assert.match(out.error, /found no record/i, "B6 per-country miss wording");
  ok("e2e BG: per-country miss message — EGN never echoed");

  // §5.4/§2.5 proof gate: the BG registry doc is EXCLUDED from outward proofs.
  const proof = await buildPublicProof(mintVerifyToken(bgDoc.id));
  assert.equal(proof, null, "source 'registry' never mints an outward proof");
  ok("e2e BG: outward proof gate -> null for the teal registry doc");

  // ---- UA-TCCS: surname prompt -> registry doc (never government) --------
  out = await resolveInput(MOCK_CODES.UA_VALID, { countryOverride: "UA" });
  assert.equal(out.kind, "needs-inputs");
  assert.deepEqual(out.missing.map((f) => f.key), ["surname"]);
  ok("e2e UA-TCCS: surname prompted (never auto-split from a stored full name)");

  out = await resolveInput(MOCK_CODES.UA_VALID, {
    countryOverride: "UA",
    extraInputs: { surname: MOCK_CODES.UA_SURNAME },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.verifiedSource, "registry");
  // bindHolder against a profile with a DIFFERENT name: the registry-source
  // guard stores it as a teal doc — no holder claim, no mismatch flag drama.
  const uaBind = bindHolder(out, { id: "S1", name: "John Smith" });
  assert.equal(uaBind.ok, true);
  const uaDoc = newVerifiedDoc("S1", uaBind.cert);
  assert.equal(uaDoc.source, "registry");
  assert.notEqual(uaDoc.source, "government");
  ok("e2e UA-TCCS: hit -> teal registry doc regardless of profile name (never government)");

  // The ambiguous TCCS miss surfaces as an error that never says "invalid".
  out = await resolveInput("20939999", {
    countryOverride: "UA",
    extraInputs: { surname: "PETRENKO" },
  });
  assert.equal(out.kind, "error");
  assert.doesNotMatch(out.error ?? "", /invalid/i);
  ok("e2e UA-TCCS: 'contact us' miss -> indeterminate -> never an invalid verdict");

  // ---- UA-MARAD: the SECOND Ukrainian connector (state registry) ---------
  // TCCS-untouched regression: the "UA" entry keeps its own surname prompt and
  // training-center identity — the new entry never bleeds into it.
  const uaEntry = countryEntry("UA");
  assert.equal(uaEntry.issuerKind, "training-center");
  assert.deepEqual(uaEntry.inputs.map((f) => f.key), ["surname", "certificateNumber"]);
  assert.deepEqual(uaEntry.domains, ["tccs.online"]);
  const uaMaradEntry = countryEntry("UA-MARAD");
  assert.notEqual(uaMaradEntry, undefined);
  assert.equal(uaMaradEntry.issuerKind, undefined, "MARAD is the flag state (default issuerKind)");
  assert.equal(uaMaradEntry.codePattern, undefined, "no detect pattern — the digit shape would trip the fan-out cap");
  ok("e2e UA split: TCCS entry byte-equivalent in behavior; MARAD is a separate flag-state entry");

  // A bare code routed to the state registry prompts for the issue date +
  // doctype (§5.2 needs-inputs — flows naturally from the entry's inputs),
  // with the doctype select options riding on the prompt field.
  out = await resolveInput("12345/2024", { countryOverride: "UA-MARAD" });
  assert.equal(out.kind, "needs-inputs");
  assert.deepEqual(out.missing.map((f) => f.key), ["issuedOn", "doctype"]);
  assert.deepEqual(
    out.missing.find((f) => f.key === "doctype").options.map((o) => o.value),
    ["70", "71", "72", "73", "74"]
  );
  ok("e2e UA-MARAD: bare code -> needs-inputs prompting issue date + doctype (5 options)");

  // Hit via the mock (session GET + ONE POST, PHPSESSID enforced): public
  // identifier -> pending-binding, never auto-green; name-less -> bindHolder
  // downgrades to a teal registry doc (§2.5 rule 4, CY precedent).
  resetRegistryJournal();
  out = await resolveInput(MOCK_CODES.UA_MARAD_DOC, {
    countryOverride: "UA-MARAD",
    extraInputs: { issuedOn: MOCK_CODES.UA_MARAD_ISSUED, doctype: MOCK_CODES.UA_MARAD_DOCTYPE },
  });
  assert.equal(out.kind, "pending-binding", "public identifier NEVER auto-green");
  assert.equal(out.cert.verifiedSource, "government", "the adapter answers as the flag state");
  assert.equal(out.cert.registryCountry, "UA-MARAD");
  assert.match(
    out.cert.sourceUrl,
    /\/services\/documents\/pdf\/hash\/[A-Za-z0-9_-]{20,}$/,
    "evidence hash link captured (real 2026-08-24 page shape)"
  );
  const maradPaths = registryJournal().filter((e) => e.path === "/ua-marad/check-document");
  assert.equal(maradPaths.length, 2, "UA-MARAD lookup = session GET + ONE POST (the mock enforces the PHPSESSID)");
  // v2-A: the hit fetched the ephemeral result PDF in the SAME verify call
  // (the mock refuses a cookie-less GET, so this also pins the session ride)
  // and the printed dates landed on the cert — the endorsement-layout fixture
  // carries "до: 20.10.2029" / "від 25.10.2024".
  const maradPdfFetches = registryJournal().filter((e) =>
    e.path.startsWith("/ua-marad/services/documents/pdf/hash/")
  );
  assert.equal(maradPdfFetches.length, 1, "exactly ONE result-PDF fetch rides the hit");
  assert.equal(out.cert.validUntil, "2029-10-20", "result-PDF expire date lands in cert.validUntil");
  assert.equal(out.cert.issuedOn, "2024-10-25", "result-PDF issue date lands in cert.issuedOn");
  ok("e2e UA-MARAD v2-A: hit fetches the result PDF same-session; validUntil/issuedOn populated");
  const maradBind = bindHolder(out, { id: "sf-uam", name: "Someone Else" });
  assert.equal(maradBind.ok, true);
  assert.equal(maradBind.cert.verifiedSource, "registry", "name-less match never names a profile");
  ok("e2e UA-MARAD: hit -> pending-binding via session GET+POST; bindHolder downgrade for the name-less cert");

  // Miss through the dispatcher, BOTH date gates: 2023+ -> the per-country
  // definitive-miss message; pre-2023 -> the could-not-confirm wording.
  out = await resolveInput("00000", {
    countryOverride: "UA-MARAD",
    extraInputs: { issuedOn: "2024-01-01", doctype: "70" },
  });
  assert.equal(out.kind, "error");
  assert.match(out.error, /Maritime Administration of Ukraine.*found no record/i);
  resetRegistryAbuseState(); // distinct cache key anyway (different issuedOn) — belt & braces
  out = await resolveInput("00000", {
    countryOverride: "UA-MARAD",
    extraInputs: { issuedOn: "2019-06-15", doctype: "70" },
  });
  assert.equal(out.kind, "error");
  assert.match(out.error, /could not confirm this certificate/i);
  assert.doesNotMatch(out.error, /invalid/i);
  ok("e2e UA-MARAD: dispatcher miss honest per date gate (definitive 2023+, inconclusive pre-2023)");

  // Unsupported doctype (76 NTZ / 849) is never wired to the registry.
  resetRegistryJournal();
  out = await resolveInput("00000", {
    countryOverride: "UA-MARAD",
    extraInputs: { issuedOn: "2024-01-01", doctype: "76" },
  });
  assert.equal(out.kind, "error");
  assert.equal(registryJournal().length, 0, "unsupported doctype -> ZERO wire traffic");
  ok("e2e UA-MARAD: doctype 76 (NTZ) refused before any fetch (only the five approved codes wire)");

  // ---- fetchWithGuard binary mode (v2-A) --------------------------------
  // Opt-in only: bodyBytes carries the raw PDF, bodyText stays ""; a default
  // (text) call is byte-for-byte the old contract — bodyBytes absent.
  {
    const pdfUrl =
      "http://127.0.0.1:4123/ua-marad/services/documents/pdf/hash/BINARYMODEPROBE_FAKETOKEN_00000000";
    const bin = await fetchWithGuard(
      pdfUrl,
      { headers: { Cookie: "PHPSESSID=MOCKUAMARADSESSION" } },
      { binary: true }
    );
    assert.equal(bin.status, 200);
    assert.ok(bin.bodyBytes instanceof Uint8Array, "binary mode returns bodyBytes");
    assert.equal(bin.bodyText, "", "binary mode never text-decodes the body");
    assert.equal(
      Buffer.from(bin.bodyBytes.subarray(0, 5)).toString("latin1"),
      "%PDF-",
      "the bytes are the unmangled PDF"
    );
    const txt = await fetchWithGuard("http://127.0.0.1:4123/ua-marad/check-document");
    assert.ok(txt.bodyText.length > 0, "default call still returns bodyText");
    assert.equal(txt.bodyBytes, undefined, "default call carries NO bodyBytes");
    ok("fetchWithGuard binary mode: opt-in bodyBytes, existing text contract untouched");
  }
} finally {
  await mock3.stop();
}

// =========================================================================
// M2. UA-MARAD v2-A failure honesty: a hit whose result-PDF fetch/parse
// fails MUST still be the same match-valid it was before v2 — dates simply
// stay empty (issuedOn falls back to the searched-with input). The ad-hoc
// server serves the REAL scrubbed hit page but breaks the hash endpoint.
// =========================================================================
{
  resetRegistryAbuseState();
  const http = await import("node:http");
  const hitHtml = fixture("ua-marad", "ua-marad-valid.html");
  const PDF_FAIL_PORT = 4178;
  let hashMode = "http-500"; // then "garbage-bytes"
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/services/documents/pdf/hash/")) {
      if (hashMode === "http-500") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("boom");
      }
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(Buffer.from("%PDF-1.4 completely mangled nonsense with no streams"));
    }
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "PHPSESSID=PDFFAILMOCK; Path=/",
      });
      return res.end("<html><body>form</body></html>");
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(hitHtml); // always a hit — only the evidence PDF is broken
    });
  });
  await new Promise((r) => srv.listen(PDF_FAIL_PORT, "127.0.0.1", r));
  const savedBase = process.env.REGISTRY_BASE_UA_MARAD;
  process.env.REGISTRY_BASE_UA_MARAD = `http://127.0.0.1:${PDF_FAIL_PORT}`;
  try {
    for (const mode of ["http-500", "garbage-bytes"]) {
      hashMode = mode;
      const out = await verifyUAMARAD({
        code: "12345/2024",
        issuedOn: "2024-10-25",
        doctype: "71",
      });
      assert.equal(out.kind, "match-valid", `${mode}: the registry hit STANDS`);
      assert.equal(out.cert.validUntil, "", `${mode}: no date invented`);
      assert.equal(
        out.cert.issuedOn,
        "2024-10-25",
        `${mode}: issuedOn falls back to the searched-with input`
      );
      assert.match(out.cert.sourceUrl, /\/services\/documents\/pdf\/hash\//);
    }
    ok("v2-A failure honesty: hash 500 AND garbage-bytes PDF both leave the hit match-valid, dates empty/fallback");
  } finally {
    process.env.REGISTRY_BASE_UA_MARAD = savedBase;
    await new Promise((r) => srv.close(r));
  }
}

// =========================================================================
// N. ALS fetch-timeout isolation pair (pdf-verify plan Decision 15b — THE
// test proving the 48s>45s settle hole stays closed, and that the 6s anon
// override cannot leak into a concurrently in-flight default dispatch)
// =========================================================================
{
  resetRegistryAbuseState();
  const http = await import("node:http");
  const missHtml = fixture("ua-marad", "ua-marad-miss.html");
  const SLOW_PORT = 4177;
  const GET_DELAY_MS = 7_500; // between the 6s anon timeout and the 12s default
  const slow = http.createServer((req, res) => {
    if (req.method === "GET") {
      // Session GET: slower than the anon 6s timeout, faster than the 12s default.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "PHPSESSID=SLOWMOCK; Path=/" });
        res.end("<html><body>form</body></html>");
      }, GET_DELAY_MS);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(missHtml); // immediate miss → date-gated no-match
    });
  });
  await new Promise((r) => slow.listen(SLOW_PORT, "127.0.0.1", r));
  const savedBase = process.env.REGISTRY_BASE_UA_MARAD;
  process.env.REGISTRY_BASE_UA_MARAD = `http://127.0.0.1:${SLOW_PORT}`;
  try {
    const t0 = Date.now();
    const [anon, dflt] = await Promise.all([
      // (a) anon-style dispatch: 6s per-fetch timeout → the 7.5s GET aborts.
      resolveInput("11111/2024", {
        countryOverride: "UA-MARAD",
        extraInputs: { issuedOn: "2024-03-04", doctype: "70" },
        fetchTimeoutMs: 6_000,
      }).then((out) => ({ out, ms: Date.now() - t0 })),
      // (b) CONCURRENT default dispatch: no override → 12s default → the
      // 7.5s GET completes and the lookup runs to its real (miss) answer.
      resolveInput("22222/2024", {
        countryOverride: "UA-MARAD",
        extraInputs: { issuedOn: "2024-03-04", doctype: "70" },
      }).then((out) => ({ out, ms: Date.now() - t0 })),
    ]);

    assert.equal(anon.out.kind, "error");
    assert.match(anon.out.error, /Could not reach/i, "6s abort surfaces as the network error");
    assert.ok(
      anon.ms < GET_DELAY_MS,
      `anon dispatch aborted BEFORE the slow GET completed (${anon.ms}ms < ${GET_DELAY_MS}ms)`
    );
    assert.ok(anon.ms >= 5_500, `abort near the 6s mark, not earlier (${anon.ms}ms)`);

    assert.equal(dflt.out.kind, "error");
    assert.match(
      dflt.out.error,
      /found no record/i,
      "concurrent default dispatch survived past 6s and got the registry's real answer"
    );
    assert.ok(
      dflt.ms >= GET_DELAY_MS,
      `default dispatch waited the slow GET out (${dflt.ms}ms >= ${GET_DELAY_MS}ms)`
    );
    ok("ALS isolation: 6s anon fetch timeout aborts its own dispatch only; interleaved default dispatch keeps the 12s timeout");
  } finally {
    process.env.REGISTRY_BASE_UA_MARAD = savedBase;
    await new Promise((r) => slow.close(r));
  }
}

// =========================================================================
// N. Azerbaijan (DDLA) — parseAZ matrix, azWireCode, verifyAZ e2e vs mock,
//    contract-drift pin, pending-binding consumer pins (az-adapter plan B4/B6/B8)
// =========================================================================

{
  // ---- parseAZ matrix over the synthetic fixtures ------------------------
  let out = parseAZ(200, fixture("az", "az-valid.json"), "123456/24");
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.code, "123456/24", "cert carries the WIRE (slash) form");
  assert.equal(out.cert.issuedOn, "2024-01-15", "DV -> issuedOn");
  assert.equal(out.cert.validUntil, "2029-01-15", "DO -> validUntil");
  assert.equal(out.cert.title, "Certificate of Competency — Chief Engineer Officer",
    "D_BADI + VZF_BADI compose the title");
  assert.equal(out.cert.certificateType, "Certificate of Competency");
  assert.equal(out.cert.documentType, "Chief Engineer Officer");
  assert.equal(out.cert.firstName, "TEST");
  assert.equal(out.cert.lastName, "SPECIMEN");
  assert.equal(out.cert.hasName, true);
  assert.equal(out.cert.birthDate, "1990-01-01", "DOG_IL -> birthDate");
  assert.equal(out.cert.registryCountry, "AZ");
  assert.equal(out.cert.keyTrust, "public-identifier");
  assert.equal(out.cert.verifiedSource, "government");
  assert.equal(out.cert.docCategory, "competency");
  ok("parseAZ: valid fixture -> match-valid, exact field mapping (the contract-drift pin)");

  // PII guards: the photo NEVER crosses the adapter boundary; kod not mapped.
  assert.equal(out.cert.photoUrl, undefined, "photoUrl stays undefined");
  assert.ok(!JSON.stringify(out.cert).includes("base64"),
    "no base64 payload anywhere in the serialized cert (photo guard)");
  assert.equal(out.cert.personalCode, "", "registry kod NOT mapped (Decision 13b)");
  ok("parseAZ: photo guard + kod-not-mapped (PII hard rules)");

  out = parseAZ(200, fixture("az", "az-expired.json"), "123457/24");
  assert.equal(out.kind, "match-invalid", "row status Expired -> match-invalid");
  assert.equal(out.cert.isValid, false);
  assert.equal(out.cert.status, "invalid");
  assert.equal(out.cert.validUntil, "2024-01-15");
  ok("parseAZ: expired fixture -> match-invalid (registry verdict verbatim, never date math)");

  out = parseAZ(200, fixture("az", "az-miss.json"), "123456/24");
  assert.equal(out.kind, "no-match", "status!=success -> definitive no-match");
  ok("parseAZ: documented miss shape -> no-match");

  // ---- drift shapes -> indeterminate, never a guessed verdict ------------
  const validObj = () => JSON.parse(fixture("az", "az-valid.json"));
  let j = validObj();
  j.data = [];
  assert.equal(parseAZ(200, j, "123456/24").kind, "indeterminate", "success + empty data");
  j = validObj();
  j.data[0].status = "Suspended";
  assert.equal(parseAZ(200, j, "123456/24").kind, "indeterminate", "unknown row status vocab");
  assert.equal(parseAZ(200, "not json at all", "123456/24").kind, "indeterminate", "non-JSON");
  out = parseAZ(500, "{}", "123456/24");
  assert.equal(out.kind, "indeterminate");
  assert.equal(out.reason, "http-500");
  ok("parseAZ: drift shapes (empty data / unknown status / non-JSON / http-500) -> indeterminate");

  // Row-tightening drift: a single row MISSING certkod never matches.
  j = validObj();
  delete j.data[0].certkod;
  out = parseAZ(200, j, "123456/24");
  assert.equal(out.kind, "indeterminate");
  assert.equal(out.reason, "unrecognized-response");
  ok("parseAZ: single row without certkod -> indeterminate (never guess)");

  // Date guard — the single-row fallback branch (code differs from certkod).
  j = validObj();
  delete j.data[0].DV;
  assert.equal(parseAZ(200, j, "999999/24").kind, "indeterminate",
    "fallback-branch row missing DV -> indeterminate");
  // Date guard — the PRIMARY certkod-match branch (round-2 amendment): a
  // renamed/garbled date column surfaces loudly, never a dateless valid.
  j = validObj();
  j.data[0].DV = "15/01/2024"; // wrong wire format = unparseable
  out = parseAZ(200, j, "123456/24");
  assert.equal(out.kind, "indeterminate");
  assert.equal(out.reason, "unrecognized-response");
  j = validObj();
  delete j.data[0].DO;
  assert.equal(parseAZ(200, j, "123456/24").kind, "indeterminate",
    "certkod-match branch missing DO -> indeterminate");
  ok("parseAZ: date guard on BOTH row-selection branches — certkod match is NOT exempt (round-2 pin)");

  // ---- HTTP-status allowlist (2026-09-08 fix): only 200/404 can miss --------
  // Bodies passed AS JSON STRINGS to prove the parse-hoist works.

  // THE FIX: the real DDLA miss is HTTP 404 + status!="success" + message.
  assert.equal(
    parseAZ(404, '{"status":"error","message":"Information not found."}', "123456/24").kind,
    "no-match",
    "404 + documented miss body -> no-match (the live-defect fix)"
  );

  // A 404 can NEVER be a hit — even a well-formed success+row envelope.
  assert.equal(
    parseAZ(404, fixture("az", "az-valid.json"), "123456/24").kind,
    "indeterminate",
    "404 + success + valid row -> indeterminate (404 is never a hit)"
  );
  assert.equal(
    parseAZ(404, '{"status":"success"}', "123456/24").kind,
    "indeterminate",
    "404 + success, no row -> indeterminate"
  );

  // Non-200/404 statuses: fail-safe indeterminate, NEVER a miss.
  for (const st of [500, 403, 429]) {
    const o = parseAZ(st, '{"status":"error","message":"x"}', "123456/24");
    assert.equal(o.kind, "indeterminate", `http-${st} -> indeterminate`);
    assert.equal(o.reason, `http-${st}`, `http-${st} carries the status reason`);
  }
  assert.equal(
    parseAZ(400, '{"status":"error","message":"Invalid birth"}', "123456/24").kind,
    "indeterminate",
    "400 -> indeterminate (never a miss)"
  );

  // 404 malformed bodies (not a plain object) -> indeterminate, never no-match.
  for (const body of ["[]", "{}", "42", "null"]) {
    assert.equal(
      parseAZ(404, body, "123456/24").kind,
      "indeterminate",
      `404 + ${body} -> indeterminate (not a plain miss object)`
    );
  }

  // 404 miss-shape narrowing: message + string status are REQUIRED.
  assert.equal(
    parseAZ(404, '{"status":"error"}', "123456/24").kind,
    "indeterminate",
    "404 + no message -> indeterminate"
  );
  assert.equal(
    parseAZ(404, '{"status":42,"message":"x"}', "123456/24").kind,
    "indeterminate",
    "404 + non-string status -> indeterminate"
  );
  assert.equal(
    parseAZ(404, '{"status":false,"message":"x"}', "123456/24").kind,
    "indeterminate",
    "404 + boolean status -> indeterminate"
  );
  assert.equal(
    parseAZ(404, '{"status":"error","message":"   "}', "123456/24").kind,
    "indeterminate",
    "404 + whitespace-only message -> indeterminate (pins .trim())"
  );
  ok("parseAZ: 404 allowlist — documented miss -> no-match; hit/malformed/non-404xx -> indeterminate");

  // 200 narrowing (intended hardening): a malformed 200 error envelope with no
  // usable message now -> indeterminate (the SAFE direction), while the real
  // fixture miss (which carries a message) stays no-match.
  assert.equal(
    parseAZ(200, fixture("az", "az-valid.json"), "123456/24").kind,
    "match-valid",
    "200 + success + valid row -> hit (preserved)"
  );
  assert.equal(
    parseAZ(200, '{"status":42}', "123456/24").kind,
    "indeterminate",
    "200 + non-string status -> indeterminate"
  );
  assert.equal(
    parseAZ(200, "{}", "123456/24").kind,
    "indeterminate",
    "200 + no status -> indeterminate"
  );
  assert.equal(
    parseAZ(200, '{"status":"error"}', "123456/24").kind,
    "indeterminate",
    "200 + status error, no message -> indeterminate (200 miss now message-gated)"
  );
  assert.equal(
    parseAZ(200, fixture("az", "az-miss.json"), "123456/24").kind,
    "no-match",
    "200 + documented miss fixture (carries a message) -> no-match (preserved)"
  );
  assert.equal(
    parseAZ(500, "<html>WAF block</html>", "123456/24").kind,
    "indeterminate",
    "500 + non-JSON -> indeterminate (preserved)"
  );
  assert.equal(
    parseAZ(200, "", "123456/24").kind,
    "indeterminate",
    "empty body -> indeterminate (preserved)"
  );
  ok("parseAZ: 200 narrowing — success->hit, miss fixture->no-match, malformed/empty->indeterminate");

  // ---- azWireCode reconstruction ----------------------------------------
  assert.equal(azWireCode("12345624"), "123456/24", "normalized 8-digit -> printed slash form");
  assert.equal(azWireCode("000000/00"), "000000/00", "already-slashed passes verbatim (health-probe branch)");
  assert.equal(azWireCode("1234567"), null, "7 digits -> definitional miss");
  assert.equal(azWireCode("123456789"), null, "9 digits -> definitional miss");
  assert.equal(azWireCode("ABCDEF24"), null, "letters -> definitional miss");
  ok("azWireCode: 6+2 reconstruction + verbatim slashed + bad shapes null");
}

// ---- verifyAZ e2e against the mock + dispatcher round-trips ---------------
const mock4 = createMockRegistry();
await mock4.start();
try {
  resetRegistryAbuseState();
  resetRegistryJournal();

  // Bad code shape -> no-match WITHOUT any fetch (Decision 11).
  let out = await verifyAZ({ code: "1234567", dob: "1990-01-01" });
  assert.equal(out.kind, "no-match");
  assert.equal(registryJournal().length, 0, "definitional miss never fetches");
  ok("verifyAZ: non-conforming code -> no-match with ZERO wire traffic");

  // Missing dob -> indeterminate defense (behind missingInputsFor).
  out = await verifyAZ({ code: MOCK_CODES.AZ_VALID });
  assert.equal(out.kind, "indeterminate");
  assert.equal(out.reason, "missing-input:dob");
  assert.equal(registryJournal().length, 0);
  ok("verifyAZ: missing dob -> indeterminate missing-input:dob, no fetch");

  // Hit / expired / miss through the real wire shape.
  out = await verifyAZ({ code: MOCK_CODES.AZ_VALID, dob: MOCK_CODES.AZ_DOB });
  assert.equal(out.kind, "match-valid");
  assert.equal(out.cert.fullName, "TEST SPECIMEN");
  out = await verifyAZ({ code: MOCK_CODES.AZ_EXPIRED, dob: MOCK_CODES.AZ_DOB });
  assert.equal(out.kind, "match-invalid");
  out = await verifyAZ({ code: "654321/24", dob: MOCK_CODES.AZ_DOB });
  assert.equal(out.kind, "no-match");
  ok("verifyAZ e2e: hit -> match-valid, expired -> match-invalid, unknown -> no-match");

  // The adapter posts type "competency" ONLY — the mock rejects other types,
  // so a hit here doubles as the doctype pin. Pin the reverse explicitly:
  const res = await fetch("http://127.0.0.1:4123/az/seamencheck/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "training", code: MOCK_CODES.AZ_VALID, birth: MOCK_CODES.AZ_DOB }),
  });
  const body = await res.json();
  assert.notEqual(body.status, "success", "mock rejects non-competency types (v1 scope pin)");
  ok("mock: non-competency type always misses — v1 wires competency only");

  // Dispatcher round-trip: normalized planner code + extraInputs dob ->
  // pending-binding (public identifier NEVER auto-green).
  resetRegistryJournal();
  out = await resolveInput("12345624", {
    countryOverride: "AZ",
    extraInputs: { dob: MOCK_CODES.AZ_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.registryCountry, "AZ");
  assert.equal(out.cert.code, "123456/24", "wire form reconstructed from the normalized code");
  assert.equal(
    registryJournal().filter((e) => e.path === "/az/seamencheck/check").length,
    1,
    "exactly one mock POST"
  );
  ok("e2e AZ: normalized code + dob -> pending-binding via ONE mock POST");

  // needs-inputs prompt when dob is absent (profile.birthDate field).
  out = await resolveInput("12345624", { countryOverride: "AZ" });
  assert.equal(out.kind, "needs-inputs");
  assert.deepEqual(out.missing.map((f) => f.key), ["dob"]);
  assert.equal(out.missing[0].source, "profile.birthDate");
  ok("e2e AZ: missing dob -> needs-inputs prompting the profile-backed field");

  // Expired -> pending-binding carrying the honest isValid:false cert, and
  // the B8 consumer pins: bindHolder passes it VERBATIM, newVerifiedDoc
  // stores it verbatim, redactCertForPublic (the /api/cert redaction gate)
  // leaves isValid/status untouched.
  out = await resolveInput("12345724", {
    countryOverride: "AZ",
    extraInputs: { dob: MOCK_CODES.AZ_DOB },
  });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.isValid, false);
  const bind = bindHolder(out, { id: "sf-az", name: "Test Specimen" });
  assert.equal(bind.ok, true);
  assert.equal(bind.cert.isValid, false, "bindHolder never coerces isValid");
  assert.equal(bind.cert.status, "invalid");
  const azDoc = newVerifiedDoc("sf-az", bind.cert);
  assert.equal(azDoc.isValid, false, "documents-route storage path keeps isValid:false verbatim");
  assert.equal(azDoc.source, "government");
  assert.equal(azDoc.registryCountry, "AZ");
  assert.equal(azDoc.validUntil, "2024-01-15");
  const redacted = redactCertForPublic(bind.cert);
  assert.equal(redacted.isValid, false, "public redaction keeps the honest verdict");
  assert.equal(redacted.status, "invalid");
  ok("e2e AZ expired: pending-binding isValid:false -> bindHolder/newVerifiedDoc/redaction all verbatim (B8 consumer pins)");

  // Definitive miss from a certain candidate -> the DDLA-attributed error.
  out = await resolveInput("99999924", {
    countryOverride: "AZ",
    extraInputs: { dob: MOCK_CODES.AZ_DOB },
  });
  assert.equal(out.kind, "error");
  assert.match(out.error, /State Maritime and Port Agency/);
  assert.match(out.error, /found no record/i);
  ok("e2e AZ: definitive miss -> honest DDLA-attributed error");
} finally {
  await mock4.stop();
}

// =========================================================================
// O. Estonia (EE) resilience — sequential short-circuit preserved for the
//    healthy/miss path; retry a fast network throw once + fan out the
//    remaining categories after a throw, gated behind the interactive
//    resilience flag (ee-sample-cert-resilience plan v3-GREEN).
//
//    NET-NEW dedicated EE mock: an http.createServer with per-category path
//    routing, a per-category hit COUNTER, and per-hit programmable behaviour
//    (200-JSON / 404 / 500 / ECONNRESET via res.socket.resetAndDestroy() /
//    never-respond → AbortError). savedBase is restored to the prior
//    :4123/ee value in teardown so the later e2e tests (:433/:471/:513-516)
//    are unaffected. Flag-ON cases drive verifyEE THROUGH resolveInput (only
//    the dispatch wrap's runWithFetchTimeout establishes the ALS store the
//    flag lives in); flag-OFF / healthy / miss cases drive verifyEE directly
//    (no store → flag reads its false default = today's sequential behaviour).
// =========================================================================
{
  const http = await import("node:http");

  const EE_VALID = { isValid: true, firstName: "JAAN", lastName: "TAMM" };
  const EE_INVALID_EMPTY = {}; // {} → normalizeCert → match-invalid (ee.ts parity)

  const hits = { competency: 0, medical: 0, endorsement: 0, qualification: 0 };
  let plan = {};
  const setPlan = (p) => {
    plan = p;
    hits.competency = 0;
    hits.medical = 0;
    hits.endorsement = 0;
    hits.qualification = 0;
  };

  const categoryOf = (url) => {
    const p = (url || "").split("?")[0];
    if (p.startsWith("/certificates/by-access-token/")) return "competency";
    if (p.startsWith("/medical-certificates/by-access-token/")) return "medical";
    if (p.startsWith("/endorsements/by-access-token/")) return "endorsement";
    if (p.startsWith("/qualifications/by-access-token/")) return "qualification";
    return null;
  };

  const reply = (res, action) => {
    if (action === "reset") {
      // A real TCP RST → undici surfaces cause.code === "ECONNRESET" (a
      // retriable fast throw). Plain socket.destroy() sends FIN → UND_ERR_SOCKET,
      // which is deliberately NOT in the fast-throw set.
      try {
        res.socket.resetAndDestroy();
      } catch {
        /* socket already gone */
      }
      return;
    }
    if (action === "hang") return; // never respond → the guard aborts → AbortError
    res.writeHead(action.status, { "Content-Type": "application/json" });
    res.end(typeof action.body === "string" ? action.body : JSON.stringify(action.body ?? {}));
  };

  const srv = http.createServer((req, res) => {
    req.socket.on("error", () => {});
    res.on("error", () => {});
    const cat = categoryOf(req.url);
    if (!cat) {
      res.writeHead(404);
      return res.end();
    }
    hits[cat] += 1;
    const fn = plan[cat] ?? (() => ({ status: 404 }));
    reply(res, fn(hits[cat]));
  });
  srv.on("clientError", (_e, sock) => {
    try {
      sock.destroy();
    } catch {
      /* noop */
    }
  });

  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const EE_PORT = srv.address().port;
  const savedBase = process.env.REGISTRY_BASE_EE;
  process.env.REGISTRY_BASE_EE = `http://127.0.0.1:${EE_PORT}`;

  // Shorthand: an EE lookup THROUGH resolveInput with the interactive
  // resilience flag ON (the two /api/cert lanes' opt-in).
  const eeResilient = (code, extra = {}) =>
    resolveInput(code, { countryOverride: "EE", allowRegistryResilience: true, ...extra });

  try {
    // (1) all-throw → indeterminate/network. DIRECT verifyEE (flag OFF → no
    // retry, no fan-out): four resets → every category throws → network.
    resetRegistryAbuseState();
    setPlan({
      competency: () => "reset",
      medical: () => "reset",
      endorsement: () => "reset",
      qualification: () => "reset",
    });
    let out = await verifyEE({ code: "EE00ALLTHROW0001" });
    assert.deepEqual(out, { kind: "indeterminate", reason: "network" }, "all-throw → network");
    ok("EE (direct, flag OFF): all-throw → indeterminate/network");

    // (2) healthy competency 200 = exactly ONE outbound (good-citizen, NO
    // fan-out). DIRECT verifyEE.
    resetRegistryAbuseState();
    setPlan({ competency: () => ({ status: 200, body: EE_VALID }) });
    out = await verifyEE({ code: "EE00HEALTHY00001" });
    assert.equal(out.kind, "match-valid");
    assert.equal(hits.competency, 1, "competency probed once");
    assert.equal(hits.medical + hits.endorsement + hits.qualification, 0, "NO fan-out on a healthy hit");
    ok("EE (direct): healthy competency-200 = 1 call, no fan-out");

    // (3) competency-404 then medical-200 = 2 sequential, no fan-out. DIRECT.
    resetRegistryAbuseState();
    setPlan({
      competency: () => ({ status: 404 }),
      medical: () => ({ status: 200, body: EE_VALID }),
    });
    out = await verifyEE({ code: "EE00SEQMEDICAL01" });
    assert.equal(out.kind, "match-valid");
    assert.equal(hits.competency, 1);
    assert.equal(hits.medical, 1);
    assert.equal(hits.endorsement + hits.qualification, 0, "short-circuit before the remaining two");
    ok("EE (direct): competency-404 → medical-200 = 2 sequential, no fan-out");

    // (4) competency THROWS (flag ON) → remainder fans out, medical-200 →
    // match-valid; elapsed well under two fetch windows. VIA resolveInput.
    resetRegistryAbuseState();
    const WINDOW = 2000;
    setPlan({
      competency: () => "reset", // resets on EVERY hit → retry re-throws → fan-out
      medical: () => ({ status: 200, body: EE_VALID }),
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    let t0 = Date.now();
    out = await eeResilient("EE00FANMEDVALID1", { fetchTimeoutMs: WINDOW });
    const elapsed = Date.now() - t0;
    assert.equal(out.kind, "verified", "MATCH in the remainder beats the competency THROW");
    assert.equal(hits.competency, 2, "competency fast-throw retried once");
    assert.ok(hits.endorsement >= 1 && hits.qualification >= 1, "remaining categories were fanned out");
    assert.ok(elapsed < 2 * WINDOW, `no sequential window cascade (${elapsed}ms < ${2 * WINDOW}ms)`);
    ok("EE (resolveInput, flag ON): competency throw → remainder fan-out finds medical-200");

    // (5) fast-throw retried once then 200 → verified, competency==2. VIA
    // resolveInput. NO fetchTimeoutMs → proves the flag alone enters the ALS
    // store (the §4.1 dead-flag fix).
    resetRegistryAbuseState();
    setPlan({ competency: (n) => (n === 1 ? "reset" : { status: 200, body: EE_VALID }) });
    out = await eeResilient("EE00RETRYHEAL001");
    assert.equal(out.kind, "verified");
    assert.equal(hits.competency, 2, "one reset then a 200 on the retry");
    ok("EE (resolveInput, flag ON): fast-throw self-heals on the single retry (competency==2)");

    // (6) AbortError (timeout) is NEVER retried → competency==1, bounded time.
    // VIA resolveInput with a short window so the hang aborts quickly.
    resetRegistryAbuseState();
    setPlan({
      competency: () => "hang",
      medical: () => ({ status: 404 }),
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    t0 = Date.now();
    out = await eeResilient("EE00ABORTNORTRY1", { fetchTimeoutMs: 700 });
    const abortMs = Date.now() - t0;
    assert.equal(out.kind, "error");
    assert.match(out.error, /Could not reach the Estonian registry/);
    assert.equal(hits.competency, 1, "AbortError NOT retried");
    assert.ok(abortMs < 2 * 700, `bounded to ~one window (${abortMs}ms)`);
    ok("EE (resolveInput, flag ON): competency AbortError not retried (==1) → network");

    // (7) double fast-throw → THROW (indeterminate), competency==2 (no 3rd try).
    resetRegistryAbuseState();
    setPlan({
      competency: () => "reset", // both the initial hit and the retry reset
      medical: () => ({ status: 404 }),
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    out = await eeResilient("EE00DOUBLETHROW1", { fetchTimeoutMs: 700 });
    assert.equal(out.kind, "error");
    assert.match(out.error, /Could not reach the Estonian registry/);
    assert.equal(hits.competency, 2, "exactly one retry, then give up");
    ok("EE (resolveInput, flag ON): double fast-throw → indeterminate (competency==2)");

    // (8) all-500 → no-match (!ok is a MISS, zero throws → no fan-out). DIRECT.
    resetRegistryAbuseState();
    setPlan({
      competency: () => ({ status: 500 }),
      medical: () => ({ status: 500 }),
      endorsement: () => ({ status: 500 }),
      qualification: () => ({ status: 500 }),
    });
    out = await verifyEE({ code: "EE00ALL500NOMTC1" });
    assert.deepEqual(out, { kind: "no-match" }, "all-500 → no-match, NOT network");
    assert.equal(hits.competency + hits.medical + hits.endorsement + hits.qualification, 4, "all sequential, no fan-out");
    ok("EE (direct): all-500 → no-match (no throw → no fan-out)");

    // (9) {}-body 200 → match-invalid (ee.ts parity). DIRECT.
    resetRegistryAbuseState();
    setPlan({ competency: () => ({ status: 200, body: EE_INVALID_EMPTY }) });
    out = await verifyEE({ code: "EE00EMPTYBODY001" });
    assert.equal(out.kind, "match-invalid");
    assert.equal(hits.competency, 1);
    ok("EE (direct): {}-body 200 → match-invalid");

    // (10) throw-after-miss: competency-404 + medical-reset(every hit) +
    // endorsement-200-valid (flag ON) → match-valid; competency==1, medical==2
    // (retried), endorsement==1. Proves the merge folds the sequential prefix
    // (competency MISS) with the fanned-out remainder. VIA resolveInput.
    resetRegistryAbuseState();
    setPlan({
      competency: () => ({ status: 404 }),
      medical: () => "reset",
      endorsement: () => ({ status: 200, body: EE_VALID }),
      qualification: () => ({ status: 404 }),
    });
    out = await eeResilient("EE00THROWAFTMISS", { fetchTimeoutMs: 700 });
    assert.equal(out.kind, "verified", "endorsement MATCH survives the medical THROW after a competency MISS");
    assert.equal(hits.competency, 1, "competency MISS probed once (prefix preserved)");
    assert.equal(hits.medical, 2, "medical fast-throw retried once");
    assert.equal(hits.endorsement, 1, "endorsement matched on its single fan-out probe");
    ok("EE (resolveInput, flag ON): throw-after-miss → merge prefix+remainder → match-valid");

    // (11) remainder retry: competency-404, medical-reset, endorsement
    // fast-throw-once-then-200 (flag ON) → endorsement==2. Proves the remainder
    // retry runs INSIDE the fan-out (the ALS scope reaches Promise.allSettled).
    resetRegistryAbuseState();
    setPlan({
      competency: () => ({ status: 404 }),
      medical: () => "reset",
      endorsement: (n) => (n === 1 ? "reset" : { status: 200, body: EE_VALID }),
      qualification: () => ({ status: 404 }),
    });
    out = await eeResilient("EE00REMRETRY0001", { fetchTimeoutMs: 700 });
    assert.equal(out.kind, "verified");
    assert.equal(hits.endorsement, 2, "a fast throw in the REMAINDER is retried once inside the fan-out");
    ok("EE (resolveInput, flag ON): remainder fast-throw retried inside the fan-out (endorsement==2)");

    // (12) remainder AbortError is NOT retried → ==1. competency-reset triggers
    // the fan-out; medical HANGS → AbortError in the remainder, single hit.
    resetRegistryAbuseState();
    setPlan({
      competency: () => "reset",
      medical: () => "hang",
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    out = await eeResilient("EE00REMABORT0001", { fetchTimeoutMs: 700 });
    assert.equal(out.kind, "error");
    assert.match(out.error, /Could not reach the Estonian registry/);
    assert.equal(hits.competency, 2, "competency fast-throw retried once → then fan-out");
    assert.equal(hits.medical, 1, "AbortError in the remainder is NOT retried");
    ok("EE (resolveInput, flag ON): remainder AbortError not retried (medical==1)");

    // (13) flag OFF (anon-style): competency fast-throw with resilience OFF →
    // fully sequential, competency==1, NO fan-out, indeterminate/network. VIA
    // resolveInput WITHOUT the flag (mirrors the anon-upload lane) — proves that
    // lane never enters the resilience path.
    resetRegistryAbuseState();
    setPlan({
      competency: () => "reset",
      medical: () => ({ status: 404 }),
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    out = await resolveInput("EE00FLAGOFFSEQ01", { countryOverride: "EE" });
    assert.equal(out.kind, "error");
    assert.match(out.error, /Could not reach the Estonian registry/);
    assert.equal(hits.competency, 1, "flag OFF → the throw is NOT retried");
    assert.equal(hits.medical, 1, "flag OFF → sequential, medical still probed after the throw");
    ok("EE (resolveInput, flag OFF): anon-style throw stays sequential (competency==1), network");

    // (14) e2e retry gating through resolveInput — fail-once mock: flag ON
    // self-heals to verified (competency==2); the flag-OFF counterpart on the
    // same shape → single hit → network. Proves the opt-in scoping.
    resetRegistryAbuseState();
    setPlan({ competency: (n) => (n === 1 ? "reset" : { status: 200, body: EE_VALID }) });
    out = await eeResilient("EE00E2EHEAL0001A");
    assert.equal(out.kind, "verified", "flag ON self-heals the transient throw");
    assert.equal(hits.competency, 2);

    resetRegistryAbuseState();
    setPlan({
      competency: (n) => (n === 1 ? "reset" : { status: 200, body: EE_VALID }),
      medical: () => ({ status: 404 }),
      endorsement: () => ({ status: 404 }),
      qualification: () => ({ status: 404 }),
    });
    out = await resolveInput("EE00E2EHEAL0001B", { countryOverride: "EE" });
    assert.equal(out.kind, "error", "flag OFF does NOT retry → the transient throw surfaces");
    assert.equal(hits.competency, 1, "flag OFF → single hit, no self-heal");
    ok("EE (resolveInput): e2e retry gating — ON self-heals (==2), OFF surfaces the error (==1)");
  } finally {
    process.env.REGISTRY_BASE_EE = savedBase;
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

// ---- Cleanup + summary --------------------------------------------------

process.chdir(APP_CWD);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best-effort temp cleanup */
}

console.log(`\nregistry-adapters: ${pass} assertions passed`);
