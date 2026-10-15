// T8 (MANDATORY, RV7): admin nav grouping integrity. Imports the nav DATA directly
// (app/admin/nav.ts — pure, no auth chain) and pins the owner's regrouping so a
// future edit that drops/moves/duplicates a route fails the build.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/admin-nav.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { NAV_GROUPS, NAV_STANDALONE } from "@/app/admin/nav";

const groupOf = new Map(); // href -> group name ("Sales"/"Admin")
const allHrefs = [];
for (const g of NAV_GROUPS) {
  for (const it of g.items) {
    groupOf.set(it.href, g.group);
    allHrefs.push(it.href);
  }
}
const standaloneHrefs = NAV_STANDALONE.map((it) => it.href);
const everyHref = [...allHrefs, ...standaloneHrefs];

const EXISTING_ROUTES = [
  "/admin",
  "/admin/seamen",
  "/admin/agents",
  "/admin/leads",
  "/admin/verify-uploads",
  "/admin/outreach",
  "/admin/flow",
  "/admin/sources",
  "/admin/bookings",
];

test("T8: all 9 existing routes appear exactly once", () => {
  for (const r of EXISTING_ROUTES) {
    const count = everyHref.filter((h) => h === r).length;
    assert.equal(count, 1, `${r} should appear exactly once (found ${count})`);
  }
});

test("T8: /admin/atlas appears exactly once and lives in the Sales group", () => {
  assert.equal(everyHref.filter((h) => h === "/admin/atlas").length, 1);
  assert.equal(groupOf.get("/admin/atlas"), "Sales");
});

test("T8: Sales group membership is exactly the lead-machine surfaces", () => {
  for (const r of ["/admin/leads", "/admin/outreach", "/admin/flow", "/admin/sources", "/admin/atlas"]) {
    assert.equal(groupOf.get(r), "Sales", `${r} must be in Sales`);
  }
});

test("T8: Admin group membership is exactly the platform-ops surfaces (Bookings included)", () => {
  for (const r of ["/admin", "/admin/seamen", "/admin/agents", "/admin/verify-uploads", "/admin/bookings"]) {
    assert.equal(groupOf.get(r), "Admin", `${r} must be in Admin`);
  }
});

test("T8: no standalone nav items remain", () => {
  assert.deepEqual(standaloneHrefs, []);
});

test("T8: nav carries no unexpected/duplicate routes", () => {
  const expected = new Set([...EXISTING_ROUTES, "/admin/atlas"]);
  assert.equal(everyHref.length, expected.size, "no duplicates and no extras");
  for (const h of everyHref) assert.ok(expected.has(h), `unexpected route ${h}`);
});
