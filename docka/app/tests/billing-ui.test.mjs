// Unit tests for the PURE billing-UI helpers (components/billing-ui.ts).
//
// R3-FR1-1: the R3-6 (checkout banner) and R3-7 (reported cell) pins must NOT invoke the
// "use client" BillingSettings component — it has React hooks and throws "Invalid hook
// call" when called as a plain function. So the two decisions were extracted into pure
// helpers (deriveCheckoutBanner, reportedCell) and are asserted directly here. No db, no
// network, no React.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { deriveCheckoutBanner, deriveCheckoutView, reportedCell } from "@/components/billing-ui";

// ===========================================================================
// R3-7 — the "Reported to Stripe" cell distinguishes closed months from "not reached"
// ===========================================================================

const row = (o = {}) => ({
  pushedToStripeAt: o.pushedToStripeAt ?? null,
  pushAttemptedAt: o.pushAttemptedAt ?? null,
  closedAs: o.closedAs ?? null,
  closedReason: o.closedReason ?? null,
});

test("R3-7 reportedCell: a pushed month shows the push date", () => {
  const cell = reportedCell(row({ pushedToStripeAt: "2026-10-01T00:20:00.000Z" }), () => "01 Oct 2026");
  assert.equal(cell.text, "01 Oct 2026");
  assert.equal(cell.subtext ?? null, null);
});

test("R3-7 reportedCell: an attempted-but-unconfirmed month shows 'processing'", () => {
  assert.equal(reportedCell(row({ pushAttemptedAt: "2026-10-01T00:20:00.000Z" })).text, "processing");
});

test("R3-7 reportedCell: a never-billed month shows 'not billed' with its reason subtext", () => {
  const cell = reportedCell(row({ closedAs: "never-billed", closedReason: "agency is exempt from billing" }));
  assert.equal(cell.text, "not billed");
  assert.equal(cell.subtext, "agency is exempt from billing");
});

test("R3-7 reportedCell: a no-usage month shows 'no billable seafarers'", () => {
  const cell = reportedCell(row({ closedAs: "no-usage" }));
  assert.equal(cell.text, "no billable seafarers");
  assert.equal(cell.subtext ?? null, null);
});

test("R3-7 reportedCell: a month the cron has not reached yet is a dash", () => {
  assert.equal(reportedCell(row()).text, "—");
});

test("R3-7 reportedCell: pushedToStripeAt wins over a stale pushAttemptedAt on the same row", () => {
  // The attempt is always stamped BEFORE the push, so a confirmed row carries both.
  const cell = reportedCell(
    row({ pushAttemptedAt: "2026-10-01T00:20:00.000Z", pushedToStripeAt: "2026-10-01T00:20:05.000Z" }),
    () => "01 Oct 2026"
  );
  assert.equal(cell.text, "01 Oct 2026");
});

// ===========================================================================
// R3-6 — the checkout-return banner + the self-terminating refresh
// ===========================================================================

test("R3-6 deriveCheckoutBanner: no checkout param => no banner, no refresh", () => {
  assert.equal(deriveCheckoutBanner("none", null), null);
  assert.equal(deriveCheckoutBanner("active", undefined), null);
});

test("R3-6 deriveCheckoutBanner: cancelled => acknowledgement, never a refresh", () => {
  const b = deriveCheckoutBanner("none", "cancelled");
  assert.equal(b.text, "Payment setup was cancelled.");
  assert.equal(b.refresh, false);
});

test("R3-6 deriveCheckoutBanner: done + not-yet-live => confirming text AND a self-terminating refresh", () => {
  for (const status of ["none", "incomplete", "canceled"]) {
    const b = deriveCheckoutBanner(status, "done");
    assert.match(b.text, /Confirming your payment/);
    assert.equal(b.refresh, true, `status=${status} is not yet live => refresh`);
  }
});

test("R3-6 deriveCheckoutBanner: done + already live => confirmed, NO refresh (no meta-refresh once live)", () => {
  for (const status of ["active", "past_due"]) {
    const b = deriveCheckoutBanner(status, "done");
    assert.equal(b.refresh, false, `status=${status} is live => no meta refresh`);
    assert.ok(b.text && !/Confirming/.test(b.text), "not the pending text once live");
  }
});

// ===========================================================================
// Owner request — the post-checkout THANK-YOU view descriptor
//
// deriveCheckoutView drives the four-state thank-you card WITHOUT invoking the
// hook-bearing BillingSettings client component. Full matrix over
// (status) x (checkoutReturn), asserting kind + showRefresh + showManage + showRetry.
// ===========================================================================

const ALL_STATUSES = ["none", "incomplete", "active", "past_due", "canceled"];

test("deriveCheckoutView: no checkout param => 'none' across every status, all flags false", () => {
  for (const status of ALL_STATUSES) {
    for (const ret of [null, undefined]) {
      const v = deriveCheckoutView(status, ret);
      assert.equal(v.kind, "none", `status=${status} ret=${ret}`);
      assert.equal(v.showRefresh, false);
      assert.equal(v.showManage, false);
      assert.equal(v.showRetry, false);
    }
  }
});

test("deriveCheckoutView: done + confirmed status (active/past_due) => confirmed, manage on, no refresh, no retry", () => {
  for (const status of ["active", "past_due"]) {
    const v = deriveCheckoutView(status, "done");
    assert.equal(v.kind, "confirmed", `status=${status}`);
    assert.equal(v.showRefresh, false, "confirmed never refreshes");
    assert.equal(v.showManage, true, "confirmed offers the portal");
    assert.equal(v.showRetry, false);
    assert.ok(v.heading.length > 0, "has a real heading");
    assert.match(v.heading, /Thank you/);
  }
});

test("deriveCheckoutView: done + not-yet-live status => confirming, self-terminating refresh, no manage/retry", () => {
  for (const status of ["none", "incomplete", "canceled"]) {
    const v = deriveCheckoutView(status, "done");
    assert.equal(v.kind, "confirming", `status=${status}`);
    assert.equal(v.showRefresh, true, `status=${status} not yet live => refresh`);
    assert.equal(v.showManage, false);
    assert.equal(v.showRetry, false);
    assert.match(v.heading, /confirming/i);
  }
});

test("deriveCheckoutView: cancelled => cancelled card with retry, never a refresh, no manage (across every status)", () => {
  for (const status of ALL_STATUSES) {
    const v = deriveCheckoutView(status, "cancelled");
    assert.equal(v.kind, "cancelled", `status=${status}`);
    assert.equal(v.showRefresh, false, "cancelled never refreshes");
    assert.equal(v.showRetry, true, "cancelled offers a try-again path");
    assert.equal(v.showManage, false);
    assert.ok(v.heading.length > 0, "has a real heading");
  }
});

test("deriveCheckoutView: null checkoutReturn => 'none' (explicit spec case)", () => {
  const v = deriveCheckoutView("active", null);
  assert.equal(v.kind, "none");
  assert.equal(v.showRefresh, false);
  assert.equal(v.showManage, false);
  assert.equal(v.showRetry, false);
});
