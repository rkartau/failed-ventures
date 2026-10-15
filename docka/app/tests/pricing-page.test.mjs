// Unit tests for the public /pricing page's data path (PRICING-PAGE-PLAN.md §6, R1-2/R1-3).
//
// The harness cannot render the JSX server component (Node strips types, no JSX transform,
// no react-dom/server, no new deps). So the "reads the configured rate, never a hardcoded
// one" guarantee is proven at the SEAM the page uses: the pure `pricingModel` helper fed
// the live billing-settings defaults, plus a STATIC source guard on the page file itself.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/pricing-page.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pricingModel } from "@/components/billing-ui";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(TESTS_DIR, "..");

// ---- (c) STATIC source guards on the page (no db needed; run before the chdir) ----------
// Locks: no hardcoded EUR rate, the source-of-truth wiring is present, and the CTA target.

test("static: /pricing page reads the source of truth and hardcodes no rate (R1-3)", () => {
  const src = fs.readFileSync(path.join(APP_DIR, "app", "pricing", "page.tsx"), "utf-8");
  // MUST NOT match a literal EUR rate ("300 EUR"/"2 EUR") — without false-positiving on
  // Tailwind (max-w-6xl / py-10), an SVG viewBox, or a year like 2026.
  assert.doesNotMatch(src, /\d[\d.,\s]*\s*EUR/, "the page must not hardcode any EUR rate");
  // Proves it wires the single source of truth.
  assert.match(src, /pricingModel\(/, "must derive the price lines via pricingModel(");
  assert.match(src, /getBillingSettings\(/, "must read the billing-settings singleton");
  // CTA target regression lock.
  assert.ok(
    src.includes('href="/agent/settings/billing"'),
    "the CTA must target /agent/settings/billing"
  );
});

// ---- (b) pricingModel tolerates missing/partial defaults and never throws (R1-2) --------

test("pricingModel(undefined | null | {}) falls back to 300/2 safely, no throw", () => {
  for (const arg of [undefined, null, {}]) {
    let model;
    assert.doesNotThrow(() => {
      model = pricingModel(arg);
    }, `pricingModel(${JSON.stringify(arg)}) must not throw`);
    assert.equal(model.base, 300, "base falls back to the canonical 300");
    assert.equal(model.perSeafarer, 2, "perSeafarer falls back to the canonical 2");
    assert.match(model.baseLine, /300 EUR/);
    assert.match(model.perSeafarerLine, /2 EUR/);
  }
  // Partial object: only one field present — the other still falls back.
  const half = pricingModel({ baseEurMonthly: 999 });
  assert.match(half.baseLine, /999 EUR/);
  assert.match(half.perSeafarerLine, /2 EUR/, "the missing field falls back to 2");
});

// ---- (a) the CONFIGURED default rate flows through to the formatted lines ---------------
// Seed a throwaway db.json with NON-default rates BEFORE importing billing-store: lib/db.ts
// resolves DATA_DIR from process.cwd() at module load (per tests/billing-store.test.mjs).

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-pricing-page-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "data", "db.json"),
  JSON.stringify(
    { billingSettings: { defaults: { baseEurMonthly: 350, perSeafarerEur: 3 } } },
    null,
    2
  ),
  "utf-8"
);
process.chdir(TMP);
process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const { getBillingSettings } = await import("@/lib/billing-store");

test("configured defaults (350/3) flow through pricingModel; the fallbacks never appear", () => {
  const model = pricingModel(getBillingSettings().defaults);
  const blob = `${model.baseLine} | ${model.perSeafarerLine}`;
  assert.match(blob, /350 EUR/, "the configured base rate is shown");
  assert.match(blob, /3 EUR/, "the configured per-seafarer rate is shown");
  assert.ok(!blob.includes("300 EUR"), "the fallback base rate (300) must not leak");
  assert.ok(!/\b2 EUR/.test(blob), "the fallback per-seafarer rate (2) must not leak");
});
