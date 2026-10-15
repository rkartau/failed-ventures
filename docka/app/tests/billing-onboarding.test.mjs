// Unit tests for lib/billing-onboarding.ts — the pure "is billing onboarding done?"
// helpers shared by the checkout route (its two distinct 400s) and agentSession()
// (the first-time redirect to /agent/settings/billing).
//
// Pure, no I/O — the module only imports a TYPE from @/lib/db, so no store is touched.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-onboarding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { missingProfileFields, billingProfileIncomplete } = await import(
  "@/lib/billing-onboarding"
);

/** A fully-populated, complete profile; `patch` breaks whichever part a case is about. */
function profile(patch = {}) {
  return {
    agentId: "agent:acme",
    legalName: "Acme Crewing OÜ",
    regCode: "12345678",
    vatNumber: "EE100000000",
    billingEmail: "billing@acme.example",
    address: {
      line1: "Sadama 1",
      line2: "",
      city: "Tallinn",
      postal: "10111",
      country: "EE",
    },
    tosAcceptedAt: "2026-06-01T00:00:00.000Z",
    tosVersion: "2026-06-01",
    exemptFromBilling: false,
    subscriptionStatus: "none",
    ...patch,
  };
}

// ---- billingProfileIncomplete ---------------------------------------------

test("billingProfileIncomplete(null) => true and never throws", () => {
  assert.doesNotThrow(() => billingProfileIncomplete(null));
  assert.equal(billingProfileIncomplete(null), true);
});

test("fully-populated profile => complete (false)", () => {
  assert.equal(billingProfileIncomplete(profile()), false);
});

test("only ToS missing => incomplete (true)", () => {
  assert.equal(billingProfileIncomplete(profile({ tosAcceptedAt: null })), true);
});

test("whitespace-only legalName => incomplete (.trim() parity)", () => {
  assert.equal(billingProfileIncomplete(profile({ legalName: "   " })), true);
});

test("ToS accepted at an OLD tosVersion => complete (presence-not-version parity)", () => {
  const p = profile({ tosVersion: "2024-01-01", tosAcceptedAt: "2024-02-02T00:00:00.000Z" });
  assert.equal(billingProfileIncomplete(p), false);
});

// ---- missingProfileFields --------------------------------------------------

test("missingProfileFields returns the exact ordered array for a partial profile", () => {
  // Blank legalName + blank address.city + blank address.country — the rest present.
  const p = profile({
    legalName: "  ",
    address: { line1: "Sadama 1", line2: "", city: "", postal: "10111", country: "  " },
  });
  assert.deepEqual(missingProfileFields(p), ["legalName", "address.city", "address.country"]);
});

test("missingProfileFields returns [] for a complete profile", () => {
  assert.deepEqual(missingProfileFields(profile()), []);
});

test("missingProfileFields preserves the full canonical order when everything is blank", () => {
  const p = profile({
    legalName: "",
    regCode: "",
    billingEmail: "",
    address: { line1: "", line2: "", city: "", postal: "", country: "" },
  });
  assert.deepEqual(missingProfileFields(p), [
    "legalName",
    "regCode",
    "billingEmail",
    "address.line1",
    "address.city",
    "address.postal",
    "address.country",
  ]);
});
