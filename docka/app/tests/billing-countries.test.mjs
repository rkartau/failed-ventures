// Unit tests for the shared billing-country whitelist + picker options
// (lib/billing-countries.ts). Pure: no db, no network, no React.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-countries.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_COUNTRY_CODES,
  COUNTRY_WHITELIST,
  supportedCountryOptions,
} from "@/lib/billing-countries";

test("SUPPORTED_COUNTRY_CODES: 33 length-2 uppercase codes, no dups", () => {
  assert.equal(SUPPORTED_COUNTRY_CODES.length, 33);
  for (const code of SUPPORTED_COUNTRY_CODES) {
    assert.match(code, /^[A-Z]{2}$/, `${code} must be a 2-letter uppercase code`);
  }
  assert.equal(new Set(SUPPORTED_COUNTRY_CODES).size, 33, "no duplicate codes");
});

test("COUNTRY_WHITELIST matches the route's accepted set (EE/GB in, ZZ/US out)", () => {
  assert.equal(COUNTRY_WHITELIST.size, 33);
  assert.ok(COUNTRY_WHITELIST.has("EE"), "EE is accepted");
  assert.ok(COUNTRY_WHITELIST.has("GB"), "GB is accepted (not 'UK')");
  assert.ok(!COUNTRY_WHITELIST.has("ZZ"), "ZZ is rejected");
  assert.ok(!COUNTRY_WHITELIST.has("US"), "US is rejected");
  assert.ok(!COUNTRY_WHITELIST.has("UK"), "'UK' is not a valid alpha-2 code here");
});

test("supportedCountryOptions: one entry per code, each with a non-empty name", () => {
  const options = supportedCountryOptions();
  assert.equal(options.length, SUPPORTED_COUNTRY_CODES.length);
  const codes = options.map((o) => o.code).sort();
  assert.deepEqual(codes, [...SUPPORTED_COUNTRY_CODES].sort(), "every code appears exactly once");
  for (const o of options) {
    assert.ok(typeof o.name === "string" && o.name.length > 0, `${o.code} has a name`);
    assert.ok(COUNTRY_WHITELIST.has(o.code), `${o.code} is a whitelisted code`);
  }
});

test("supportedCountryOptions: sorted by display name (localeCompare)", () => {
  const names = supportedCountryOptions().map((o) => o.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted, "options are alphabetised by name");
});
