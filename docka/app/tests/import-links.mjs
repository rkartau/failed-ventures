// Import-crew claim-links acceptance (dev-server e2e, like bug1-hide-restore.mjs).
// Guards the fix for the missing-links bug: a single-word crew name must NOT be
// misread as a docka share token — every imported name gets its own upload link.
// Also asserts the removed helper copy and the single-name rule.
//
//   # from app/ with the dev server up on :3000 (npm run dev)
//   node tests/import-links.mjs
//   # or:  DOCKA_BASE_URL=http://localhost:3000 node tests/import-links.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext().then((c) => c.newPage());
  try {
    await J.loginAsTestAgent(page);

    // --- CASE A: 8 single-word names => 8 upload links, no skips ----------
    console.log("[import] importing 8 single-word names…");
    await page.locator('[data-testid="import-open"]').click();
    // Intro helper paragraph must be gone.
    assert(
      (await page.getByText("Bring your existing roster", { exact: false }).count()) === 0,
      "intro helper paragraph must be removed"
    );
    const names = ["Andres", "Katrin", "Peeter", "Liis", "Toomas", "Kadri", "Margus", "Nina"];
    await page.locator('[data-testid="import-text"]').fill(names.join("\n"));
    await page.locator('[data-testid="import-confirm"]').click();
    await page.locator('[data-testid="invite-copy-links"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800);
    const rows = await page.locator('[data-testid="invite-copy-links-row"]').count();
    assert(rows === names.length, `expected ${names.length} upload links, got ${rows}`);
    assert(
      (await page.locator('[data-testid="import-skipped"]').count()) === 0,
      "no single-word name may be skipped as a bogus share link"
    );
    assert(
      (await page.getByText("No email is sent", { exact: false }).count()) === 0,
      "email-warning paragraph must be removed"
    );
    console.log(`[import] all ${rows} links present, none skipped, helper copy gone.`);

    // --- CASE B: a lone import hides the multi box (single inline instead) -
    console.log("[import] single-name import hides the links box…");
    await page.reload();
    await page.locator('[data-testid="import-open"]').click();
    await page.locator('[data-testid="import-text"]').fill("Solo Sailor");
    await page.locator('[data-testid="import-confirm"]').click();
    await page.locator('[data-testid="import-done"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(500);
    assert(
      (await page.locator('[data-testid="invite-copy-links"]').count()) === 0,
      "single import must NOT show the multi-link box"
    );
    assert(
      (await page.locator('[data-testid="invite-copy-single"]').count()) === 1,
      "single import shows the compact inline copy link"
    );
    console.log("[import] single-name rule holds.");

    console.log("\n[import] PASSED — every imported name gets a link; single-name hides the list.");
    await browser.close();
    process.exit(0);
  } catch (err) {
    try {
      await page.screenshot({ path: `${J.SHOTS_DIR}/import-links-failure.png`, fullPage: true });
    } catch {}
    console.error("\n[import] FAILED");
    console.error(err);
    await browser.close();
    process.exit(1);
  }
}

main();
