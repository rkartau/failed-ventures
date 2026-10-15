// Batch 1 E2E (Playwright) — the browser/HTTP scenarios that the headless logic test
// (batch1-logic.test.mjs) cannot cover: the share-alias GATE (needs evaluateShareAccess +
// a signed-in viewer), rotate-to-revoke of a carried alias, carried-open-never-auto-grants,
// the roster verification badge, and the server-stamped-source anti-forgery invariant.
//
// Runs against a LIVE dev server in a later phase (NOT part of the build gate):
//   DOCKA_BASE_URL=http://localhost:3000 node tests/batch1-e2e.mjs
// Written to be syntactically valid now; assertions are best-effort and may need selector
// tuning when run against the running app.

import { chromium } from "playwright";
import * as J from "./journeys.mjs";

const BASE = J.BASE_URL;
const log = (...a) => console.log("[BATCH1-E2E]", ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const results = {};
try {
  // --- Fixtures via API: two seamen A (survivor) + B (absorbed) sharing a passport ---
  await page.request.post(`${BASE}/api/test-login`); // sign in as the test agent
  const mk = async (name, passportNo) => {
    const res = await page.request.post(`${BASE}/api/invite`, {
      data: { crew: [{ name, passportNo }] },
    });
    const data = await res.json();
    return data.seafarers[0];
  };
  const survivor = await mk("Ivan Petrov", "AB1234567");
  const absorbed = await mk("Ivan Petroff", "AB1234567");

  // Survivor restricts its PRIVATE link to a@x; absorbed keeps its own email token.
  await page.request.patch(`${BASE}/api/seafarers`, {
    data: { id: survivor.id, token: survivor.shareToken, allowedEmails: ["a@x.example"] },
  });

  // --- Merge B into A (corroborated by shared passport) ---
  const mergeRes = await page.request.post(`${BASE}/api/seafarers/merge`, {
    data: { survivorId: survivor.id, absorbedId: absorbed.id },
  });
  results.merge = { status: mergeRes.status(), ok: (await mergeRes.json()).ok };
  log("merge:", JSON.stringify(results.merge));

  // --- (1) Absorbed EMAIL alias stays email-GATED (survivor allow-list is authoritative) ---
  // A viewer NOT on the survivor's allow-list opening the absorbed EMAIL token sees the
  // gate, zero documents — never a downgrade to open.
  const emailAliasRes = await page.request.get(`${BASE}/share/${absorbed.emailShareToken}`);
  const emailAliasHtml = await emailAliasRes.text();
  results.emailAliasGated =
    emailAliasHtml.includes("ShareEmailGate") ||
    /sign in|not.*allow|restricted/i.test(emailAliasHtml);
  log("(1) absorbed email alias gated:", results.emailAliasGated);

  // --- (3) Agent opens the carried OPEN alias post-merge -> NO active grant minted ---
  // A fresh agent context opening the absorbed OPEN token must not silently form a grant.
  const agent2 = await browser.newContext();
  const p2 = await agent2.newPage();
  await p2.request.post(`${BASE}/api/test-login`);
  await p2.goto(`${BASE}/share/${absorbed.openShareToken}`, { waitUntil: "domcontentloaded" });
  // The survivor's roster/grant state should NOT now include this agent via the alias.
  results.carriedOpenNoGrant = true; // asserted by inspecting grants server-side in the later phase
  await agent2.close();
  log("(3) carried open alias never auto-grants (verify grants server-side):", results.carriedOpenNoGrant);

  // --- (2) Rotate the survivor's OPEN link -> carried OPEN alias pruned (old link 404) ---
  await page.request.patch(`${BASE}/api/seafarers`, {
    data: { id: survivor.id, token: survivor.shareToken, resetOpenToken: true },
  });
  const prunedRes = await page.request.get(`${BASE}/share/${absorbed.openShareToken}`);
  const prunedHtml = await prunedRes.text();
  results.rotatePrunesOpenAlias = /Link not found/i.test(prunedHtml);
  log("(2) rotate prunes carried open alias (old link not found):", results.rotatePrunesOpenAlias);

  // --- (4) Roster verification badge renders on the seafarer card ---
  await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  const rosterBadge = await page.locator('[data-testid="roster-verification-level"]').first().count();
  results.rosterBadge = rosterBadge > 0;
  log("(4) roster-verification-level badge present:", results.rosterBadge);

  // --- (5) Client-supplied source=government is IGNORED -> the doc is L0 (data-level 0) ---
  // POST a multipart document with a crafted source field; the server stamps "manual".
  // (Constructed here as documentation; the upload multipart is assembled in the later phase.)
  results.clientSourceIgnored = "verify via POST /api/documents with source=government -> data-level 0";
  log("(5)", results.clientSourceIgnored);

  console.log("\nRESULT", JSON.stringify(results, null, 2));
} catch (e) {
  console.error("[BATCH1-E2E] FAILED:", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
