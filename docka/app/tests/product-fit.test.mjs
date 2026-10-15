// Unit tests for lib/product-fit.ts + lib/product-fit-store.ts — the pipeline's
// per-lead PRODUCT-FIT verdict store surfaced on /admin/leads.
//
// Covers: the join-key normalization is byte-identical to the pipeline
// (asserted against the SHARED golden vectors, incl. an IDN/punycode domain and
// uppercase/whitespace); validateProductFit is strict on the envelope and
// lenient per entry; parseStoredProductFit re-reads a stored file through the
// same normalizer; the fs store writes atomically and the memoized lookup
// degrades a missing/corrupt file to an EMPTY lookup (never throws).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/product-fit.test.mjs

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeEmail,
  validateProductFit,
  parseStoredProductFit,
  PRODUCT_FIT_VALUES,
  ENRICH_STATUS_VALUES,
} from "@/lib/product-fit";
import {
  writeProductFit,
  readProductFit,
  loadProductFitLookup,
  __clearProductFitCache,
} from "@/lib/product-fit-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- normalizeEmail: byte-exact parity with the pipeline's normalize_email ---

test("normalizeEmail matches the SHARED golden vectors byte-for-byte (incl. IDN + case/space)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "email-normalize-golden.json"), "utf8")
  );
  for (const c of golden.cases) {
    assert.equal(normalizeEmail(c.input), c.expected, `golden case ${c.name}`);
  }
  // Spot-pin the two the task calls out explicitly.
  assert.equal(normalizeEmail("ops@MÜNCHEN-shipping.de"), "ops@xn--mnchen-shipping-zvb.de");
  assert.equal(normalizeEmail("  CREWING@Alpha.Example.COM "), "crewing@alpha.example.com");
});

// --- validateProductFit: STRICT envelope -------------------------------------

const NOW = new Date().toISOString();

test("valid payload → verdicts normalized, keys re-normalized with the app rule", () => {
  const res = validateProductFit({
    schema_version: 1,
    generated_at: NOW,
    verdicts: {
      // key given in raw (uppercase / IDN) form — MUST be re-normalized on ingest
      "OPS@MÜNCHEN.de": { product_fit: "positive", enrich_status: "success", is_sendable_v2: true },
      "b@x.example": { product_fit: "negative", enrich_status: "blocked", is_sendable_v2: false },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.schemaVersion, 1);
  assert.equal(res.data.generatedAt, NOW);
  // Key was re-normalized to punycode+lowercase so the page lookup will match.
  const key = normalizeEmail("OPS@MÜNCHEN.de");
  assert.equal(key, "ops@xn--mnchen-3ya.de");
  assert.deepEqual(res.data.verdicts[key], {
    productFit: "positive",
    enrichStatus: "success",
    sendableV2: true,
  });
  assert.deepEqual(res.data.verdicts["b@x.example"], {
    productFit: "negative",
    enrichStatus: "blocked",
    sendableV2: false,
  });
});

test("envelope rejects: non-object, bad schema_version, bad generated_at, non-object verdicts", () => {
  assert.equal(validateProductFit(null).ok, false);
  assert.equal(validateProductFit([]).ok, false);
  assert.equal(validateProductFit("nope").ok, false);
  assert.match(
    validateProductFit({ schema_version: 2, generated_at: NOW, verdicts: {} }).error,
    /Unsupported schema_version 2/
  );
  assert.match(
    validateProductFit({ generated_at: "not-a-date", verdicts: {} }).error,
    /generated_at/
  );
  assert.match(
    validateProductFit({ generated_at: NOW, verdicts: [] }).error,
    /verdicts is not an object/
  );
  // schema_version may be absent (defaults to 1).
  const noSv = validateProductFit({ generated_at: NOW, verdicts: {} });
  assert.equal(noSv.ok, true);
  assert.equal(noSv.data.schemaVersion, 1);
});

// --- validateProductFit: LENIENT per entry -----------------------------------

test("per-entry: bad product_fit skipped, bad enrich_status → not_attempted, sendable coerced", () => {
  const res = validateProductFit({
    generated_at: NOW,
    verdicts: {
      "good@x.example": { product_fit: "ambiguous", enrich_status: "timeout", is_sendable_v2: false },
      "badfit@x.example": { product_fit: "maybe", enrich_status: "success", is_sendable_v2: true },
      "badenrich@x.example": { product_fit: "positive", enrich_status: "weird", is_sendable_v2: true },
      "badbool@x.example": { product_fit: "positive", enrich_status: "success", is_sendable_v2: "yes" },
      "notobj@x.example": 42,
    },
  });
  assert.equal(res.ok, true);
  const v = res.data.verdicts;
  // good one survives untouched
  assert.deepEqual(v["good@x.example"], {
    productFit: "ambiguous",
    enrichStatus: "timeout",
    sendableV2: false,
  });
  // invalid product_fit → the whole entry is DROPPED (not coerced)
  assert.equal(v["badfit@x.example"], undefined);
  // invalid enrich_status → degrades to not_attempted, entry kept
  assert.equal(v["badenrich@x.example"].enrichStatus, "not_attempted");
  assert.equal(v["badenrich@x.example"].productFit, "positive");
  // non-boolean is_sendable_v2 → false, entry kept
  assert.equal(v["badbool@x.example"].sendableV2, false);
  // non-object value → skipped
  assert.equal(v["notobj@x.example"], undefined);
  // every skip/coercion left a warning
  assert.ok(res.data.warnings.length >= 3, "lenient path warns, never rejects the whole upload");
});

test("allowlist constants are the exact shared contract", () => {
  assert.deepEqual([...PRODUCT_FIT_VALUES], ["positive", "negative", "ambiguous"]);
  assert.deepEqual(
    [...ENRICH_STATUS_VALUES],
    ["success", "error", "timeout", "blocked", "not_attempted"]
  );
});

// --- parseStoredProductFit: stored re-read is the same normalizer ------------

test("parseStoredProductFit accepts the stored camelCase shape; drops the envelope on drift", () => {
  const stored = {
    schemaVersion: 1,
    generatedAt: NOW,
    uploadedAt: NOW,
    verdicts: {
      "a@x.example": { productFit: "positive", enrichStatus: "success", sendableV2: true },
    },
  };
  const ok = parseStoredProductFit(stored);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.data.verdicts["a@x.example"], {
    productFit: "positive",
    enrichStatus: "success",
    sendableV2: true,
  });
  // Missing uploadedAt / bad generatedAt / non-object → corrupt.
  assert.equal(parseStoredProductFit({ generatedAt: NOW, verdicts: {} }).status, "corrupt");
  assert.equal(parseStoredProductFit({ ...stored, generatedAt: "x" }).status, "corrupt");
  assert.equal(parseStoredProductFit(null).status, "corrupt");
});

// --- fs store: atomic write + tolerant, memoized lookup ----------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-product-fit-"));
const originalCwd = process.cwd();
process.chdir(TMP);
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const PF_STORE_PATH = path.join(TMP, "data", "product-fit.json");

beforeEach(() => {
  __clearProductFitCache();
  fs.rmSync(PF_STORE_PATH, { force: true });
});

test("writeProductFit round-trips through readProductFit (stamps uploadedAt)", () => {
  writeProductFit({
    schemaVersion: 1,
    generatedAt: NOW,
    verdicts: { "a@x.example": { productFit: "negative", enrichStatus: "success", sendableV2: false } },
    warnings: [],
  });
  const r = readProductFit();
  assert.equal(r.status, "ok");
  assert.equal(typeof r.data.uploadedAt, "string");
  assert.equal(r.data.verdicts["a@x.example"].productFit, "negative");
});

test("loadProductFitLookup: missing file → EMPTY lookup (never throws), version 'empty'", () => {
  const lk = loadProductFitLookup(PF_STORE_PATH);
  assert.equal(lk.verdicts.size, 0);
  assert.equal(lk.generatedAt, null);
  assert.equal(lk.version, "empty");
});

test("loadProductFitLookup: corrupt file → EMPTY lookup, corrupt-tagged version", () => {
  fs.writeFileSync(PF_STORE_PATH, "not json {", "utf8");
  const lk = loadProductFitLookup(PF_STORE_PATH);
  assert.equal(lk.verdicts.size, 0);
  assert.match(lk.version, /^corrupt:/);
});

test("loadProductFitLookup: good file → Map keyed by normalized email; memo stable, refresh distinct", () => {
  const body = JSON.stringify({
    schemaVersion: 1,
    generatedAt: NOW,
    uploadedAt: NOW,
    verdicts: {
      "OPS@Alpha.Example": { productFit: "positive", enrichStatus: "success", sendableV2: true },
    },
  });
  fs.writeFileSync(PF_STORE_PATH, body, "utf8");
  fs.utimesSync(PF_STORE_PATH, 1_700_000_100, 1_700_000_100);
  const lk = loadProductFitLookup(PF_STORE_PATH);
  assert.equal(lk.verdicts.get("ops@alpha.example").productFit, "positive");
  const v1 = lk.version;

  // Same (mtime,size) → the SAME memoized lookup object.
  assert.equal(loadProductFitLookup(PF_STORE_PATH), lk);

  // A refresh (new mtime) → a DISTINCT version token so callers can invalidate.
  fs.utimesSync(PF_STORE_PATH, 1_700_000_200, 1_700_000_200);
  __clearProductFitCache();
  const lk2 = loadProductFitLookup(PF_STORE_PATH);
  assert.notEqual(lk2.version, v1);
});
