// Bug-4 acceptance (Phase 4a end-to-end):
//   An agent adds a seaman by their REAL open share link via the "Add by link" panel,
//   then — viewing as that seaman — the seaman's "Access & reviews" page lists the
//   grant-only agent. This exercises the /api/invite/link route AND the <AccessReviews>
//   wiring (app/seafarer/page.tsx) end-to-end — the true Bug-4 acceptance.
//
// Modelled on tests/smoke.mjs + tests/jaan-r6-import.mjs (same journeys.mjs harness).
// Requires the dev server running in NON-prod mode (the /api/test-login + share
// handshake are dev-only). Run:
//
//   # from app/ with the dev server up on :3000 (npm run dev)
//   node tests/bug4-add-by-link.mjs
//   # or point at another origin:
//   DOCKA_BASE_URL=http://localhost:3000 node tests/bug4-add-by-link.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  // Two independent contexts (independent cookie jars): one seaman session, one agent.
  const seamanCtx = await browser.newContext();
  const agentCtx = await browser.newContext();
  const seamanPage = await seamanCtx.newPage();
  const agentPage = await agentCtx.newPage();

  try {
    const name = `Bug4 Seaman ${Date.now()}`;

    // --- SEAMAN: create a fresh profile, get their open share link ---------
    console.log("[bug4] creating seaman:", name);
    const seaman = await J.createSeaman(seamanPage, name);
    assert(seaman.shareToken, "seaman should have an open share token");
    assert(seaman.shareUrl, "seaman should have a share URL");
    console.log("[bug4] share link:", seaman.shareUrl);

    // Baseline: before any grant, the seaman's Access & reviews view is EMPTY.
    await seamanPage.goto(`${J.BASE_URL}/seafarer`, { waitUntil: "domcontentloaded" });
    await seamanPage
      .locator('[data-testid="access-reviews"]')
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
    await seamanPage.waitForTimeout(1000); // let AccessReviews fetch settle
    const rowsBefore = await seamanPage.locator('[data-testid="access-row"]').count();
    console.log("[bug4] access rows before grant:", rowsBefore);
    assert(rowsBefore === 0, "seaman should have NO reviewers before the agent adds them");

    // --- AGENT: add the seaman via the "Add by link" panel (real UI) -------
    console.log("[bug4] signing in as test agent…");
    await J.loginAsTestAgent(agentPage);

    console.log("[bug4] opening the Add-by-link panel and pasting the share link…");
    await agentPage.locator('[data-testid="invite-open"]').first().click();
    const ta = agentPage.locator('[data-testid="invite-names"]').first();
    await ta.waitFor({ state: "visible", timeout: 10_000 });
    await ta.fill(seaman.shareUrl);
    await Promise.all([
      agentPage.waitForResponse(
        (r) => r.url().includes("/api/invite/link") && r.request().method() === "POST",
        { timeout: 30_000 }
      ),
      agentPage.locator('[data-testid="invite-send"]').first().click(),
    ]);

    // The panel must report the seaman as ADDED (not skipped).
    const added = agentPage.locator('[data-testid="invite-link-added"]');
    await added.first().waitFor({ state: "visible", timeout: 15_000 });
    const addedCount = await added.count();
    const skippedCount = await agentPage.locator('[data-testid="invite-link-skipped"]').count();
    console.log("[bug4] panel outcome — added:", addedCount, "skipped:", skippedCount);
    assert(addedCount >= 1, "the pasted open link must resolve to an ADDED seafarer");
    assert(skippedCount === 0, "a valid open link must not be skipped");

    // --- SEAMAN: the grant-only agent now appears on their Access page -----
    console.log("[bug4] reloading the seaman's Access & reviews view…");
    await seamanPage.goto(`${J.BASE_URL}/seafarer`, { waitUntil: "domcontentloaded" });
    const accessRow = seamanPage.locator('[data-testid="access-row"]').first();
    await accessRow.waitFor({ state: "visible", timeout: 30_000 });
    const rowsAfter = await seamanPage.locator('[data-testid="access-row"]').count();
    const agentLabel = (await accessRow.innerText()).replace(/\s+/g, " ").trim();
    console.log("[bug4] access rows after grant:", rowsAfter);
    console.log("[bug4] reviewer row text:", agentLabel);
    assert(rowsAfter >= 1, "the grant-only agent MUST appear on the seaman's Access page");
    const emptyShown = await seamanPage.locator('[data-testid="access-empty"]').count();
    assert(emptyShown === 0, "the empty-state must be gone once a reviewer exists");

    console.log("\n[bug4] PASSED — agent added by link and surfaces on the seaman's Access page.");
    await browser.close();
    process.exit(0);
  } catch (err) {
    try {
      await agentPage.screenshot({ path: `${J.SHOTS_DIR}/bug4-agent-failure.png`, fullPage: true });
      await seamanPage.screenshot({ path: `${J.SHOTS_DIR}/bug4-seaman-failure.png`, fullPage: true });
    } catch {}
    console.error("\n[bug4] FAILED");
    console.error(err);
    await browser.close();
    process.exit(1);
  }
}

main();
