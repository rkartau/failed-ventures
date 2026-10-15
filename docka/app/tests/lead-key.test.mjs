// Unit tests for the outreach lead-key contract (book-a-call-outreach-plan Wave A1/A2).
//
// PURE — no store, no IO. Covers:
//   - sanitizeLeadKey table: valid / too-long / xss / sqli / wrong-case / undefined / array
//   - the GOLDEN real-key contract list (the single shared ^LD\d{1,15}$ contract) all pass
//   - pickLeadKey array-form selection ("first NON-EMPTY that sanitizes", not blind [0])
//
// Run: node --import ./tests/_register-alias.mjs --test tests/lead-key.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeLeadKey, pickLeadKey, LEAD_KEY_RE } from "@/lib/booking";

// ---- sanitizeLeadKey table --------------------------------------------------

test("sanitizeLeadKey: valid keys round-trip unchanged", () => {
  assert.equal(sanitizeLeadKey("LD00042"), "LD00042");
  assert.equal(sanitizeLeadKey("LD42"), "LD42");
  assert.equal(sanitizeLeadKey("LD7"), "LD7");
});

test("sanitizeLeadKey: too-long (>15 digits) -> undefined", () => {
  assert.equal(sanitizeLeadKey("LD" + "9".repeat(16)), undefined);
  assert.equal(sanitizeLeadKey("LD" + "9".repeat(20)), undefined);
});

test("sanitizeLeadKey: XSS / SQLi / junk payloads -> undefined", () => {
  assert.equal(sanitizeLeadKey("<script>"), undefined);
  assert.equal(sanitizeLeadKey("LD1<script>"), undefined);
  assert.equal(sanitizeLeadKey("' OR 1=1"), undefined);
  assert.equal(sanitizeLeadKey("LD1' OR '1'='1"), undefined);
  assert.equal(sanitizeLeadKey("LD 42"), undefined); // space
  assert.equal(sanitizeLeadKey("LD42\n"), undefined); // newline
  assert.equal(sanitizeLeadKey("LD-42"), undefined); // separator
  assert.equal(sanitizeLeadKey("LD42x"), undefined); // trailing non-digit
  assert.equal(sanitizeLeadKey("XLD42"), undefined); // wrong prefix
  assert.equal(sanitizeLeadKey("LD"), undefined); // no digits
});

test("sanitizeLeadKey: wrong-case is rejected (case-strict, matches generator)", () => {
  assert.equal(sanitizeLeadKey("ld42"), undefined);
  assert.equal(sanitizeLeadKey("Ld42"), undefined);
  assert.equal(sanitizeLeadKey("lD42"), undefined);
});

test("sanitizeLeadKey: undefined / null / non-string -> undefined", () => {
  assert.equal(sanitizeLeadKey(undefined), undefined);
  assert.equal(sanitizeLeadKey(null), undefined);
  assert.equal(sanitizeLeadKey(42), undefined);
  assert.equal(sanitizeLeadKey({}), undefined);
});

test("sanitizeLeadKey: array input -> undefined (arrays are handled by pickLeadKey, not here)", () => {
  // A non-string must never coerce-and-match (String(['LD00001']) would be a bypass).
  assert.equal(sanitizeLeadKey(["LD00001"]), undefined);
  assert.equal(sanitizeLeadKey(["LD00001", "LD00002"]), undefined);
});

// ---- GOLDEN contract list (the single shared ^LD\d{1,15}$ contract) ----------

test("golden real-key contract: every representative key passes sanitizeLeadKey unchanged", () => {
  // smallest padded, mid, pad-boundary, first 6-digit, 10-digit, largest plausible 15-digit.
  const golden = [
    "LD00001",
    "LD00042",
    "LD99999",
    "LD100000",
    "LD1000000000",
    "LD999999999999999",
  ];
  for (const key of golden) {
    assert.equal(sanitizeLeadKey(key), key, `${key} must round-trip unchanged`);
    assert.match(key, LEAD_KEY_RE, `${key} must match the shared contract regex`);
  }
});

// ---- pickLeadKey (Next.js searchParams.lead) --------------------------------

test("pickLeadKey scalar form sanitizes directly", () => {
  assert.equal(pickLeadKey("LD00001"), "LD00001");
  assert.equal(pickLeadKey("<x>"), undefined);
  assert.equal(pickLeadKey(undefined), undefined);
});

test("pickLeadKey array-form: first NON-EMPTY that sanitizes (?lead=&lead=LD00001)", () => {
  assert.equal(pickLeadKey(["", "LD00001"]), "LD00001");
});

test("pickLeadKey array-form: takes the first VALID (?lead=LD00001&lead=LD00002)", () => {
  assert.equal(pickLeadKey(["LD00001", "LD00002"]), "LD00001");
});

test("pickLeadKey array-form: all empty -> undefined", () => {
  assert.equal(pickLeadKey(["", ""]), undefined);
});

test("pickLeadKey array-form: skips an invalid first element (?lead=<x>&lead=LD00007)", () => {
  assert.equal(pickLeadKey(["<x>", "LD00007"]), "LD00007");
});
