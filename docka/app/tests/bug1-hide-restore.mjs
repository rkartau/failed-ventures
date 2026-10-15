// Bug-1 acceptance (Phase 4c end-to-end):
//   An agent's crew card shows a "Remove from my board" control → clicking it HIDES
//   the seaman (drops the card) → the "Hidden crew" panel lists them → "Restore"
//   returns them to the board. Exercises the real PATCH /api/seafarers
//   { hide } / { restore } route + the GET ?view=hidden projection.
//
// Modelled on tests/smoke.mjs (same journeys.mjs harness — one context carrying both
// a seaman and an agent session, exactly as smoke.mjs does). Requires the dev server
// running in NON-prod mode. Run:
//
//   # from app/ with the dev server up on :3000 (npm run dev)
//   node tests/bug1-hide-restore.mjs
//   # or:  DOCKA_BASE_URL=http://localhost:3000 node tests/bug1-hide-restore.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const card = (page, name) =>
  page.locator(`[data-testid="seafarer-card"][data-name="${name}"]`).first();

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const name = `Bug1 Seaman ${Date.now()}`;

    // --- SEAMAN: fresh profile (review state, NOT at sea) ------------------
    console.log("[bug1] creating seaman:", name);
    const seaman = await J.createSeaman(page, name);
    assert(seaman.shareToken, "seaman should have a share token");

    // --- AGENT: sign in + form the grant by opening the share link --------
    console.log("[bug1] signing in as test agent + opening the seaman's share…");
    await J.loginAsTestAgent(page);
    await J.agentOpenSeamanShare(page, seaman.shareToken);

    // The card is on the board with an ENABLED "Remove from my board" control
    // (a review-state seaman is not at sea → not LOCKED). B2 redesign: the
    // control lives inside the card's kebab menu — open it first.
    await card(page, name).waitFor({ state: "visible", timeout: 30_000 });
    await card(page, name).locator('[data-testid="card-menu"]').click();
    const removeBtn = card(page, name).locator('[data-testid="remove-from-board"]');
    await removeBtn.waitFor({ state: "visible", timeout: 10_000 });
    assert(!(await removeBtn.isDisabled()), "Remove control must be enabled for a not-at-sea seaman");

    // --- HIDE: click removes the card from the board ----------------------
    console.log("[bug1] removing from board…");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH",
        { timeout: 30_000 }
      ),
      removeBtn.click(),
    ]);
    await card(page, name).waitFor({ state: "detached", timeout: 15_000 });
    console.log("[bug1] card dropped from the board.");

    // --- HIDDEN CREW: the seaman is listed there --------------------------
    console.log("[bug1] opening the Hidden crew panel…");
    await page.locator('[data-testid="hidden-crew-open"]').first().click();
    const hiddenRow = page.locator(`[data-testid="hidden-crew-row"][data-name="${name}"]`).first();
    await hiddenRow.waitFor({ state: "visible", timeout: 15_000 });
    console.log("[bug1] seaman appears in Hidden crew.");

    // --- RESTORE: returns the seaman to the board -------------------------
    console.log("[bug1] restoring…");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH",
        { timeout: 30_000 }
      ),
      hiddenRow.locator('[data-testid="hidden-crew-restore"]').click(),
    ]);
    // Row leaves the hidden list AND the card is back on the board.
    await hiddenRow.waitFor({ state: "detached", timeout: 15_000 });
    await card(page, name).waitFor({ state: "visible", timeout: 15_000 });
    console.log("[bug1] card restored to the board.");

    // --- DELETE: hide again, then the two-step delete journey -------------
    // arm → disarm (blur) → re-arm → confirm (rapid double-click) → row gone,
    // exactly ONE result note, ZERO error notes (in-flight guard).
    console.log("[bug1] hiding again for the delete journey…");
    // B2: open the card kebab first — Remove lives in the menu now.
    await card(page, name).locator('[data-testid="card-menu"]').click();
    await card(page, name)
      .locator('[data-testid="remove-from-board"]')
      .waitFor({ state: "visible", timeout: 10_000 });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH",
        { timeout: 30_000 }
      ),
      card(page, name).locator('[data-testid="remove-from-board"]').click(),
    ]);
    await card(page, name).waitFor({ state: "detached", timeout: 15_000 });
    // Reopen the panel so it refetches the re-hidden seaman. The panel may have
    // ALREADY closed itself (hover-away: the remove click moved the pointer out of
    // it), so click once and only toggle again if the row doesn't appear.
    const hiddenOpenBtn = page.locator('[data-testid="hidden-crew-open"]').first();
    await hiddenOpenBtn.click();
    try {
      await hiddenRow.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      await hiddenOpenBtn.click();
      await hiddenRow.waitFor({ state: "visible", timeout: 15_000 });
    }

    console.log("[bug1] arming delete…");
    await hiddenRow.locator('[data-testid="hidden-crew-delete"]').click();
    const confirmBtn = hiddenRow.locator('[data-testid="hidden-crew-delete-confirm"]');
    await confirmBtn.waitFor({ state: "visible", timeout: 10_000 });

    // Disarm by clicking elsewhere in the panel (blur) — the plain Delete returns.
    console.log("[bug1] disarming (click elsewhere)…");
    await hiddenRow.locator("p").first().click();
    await hiddenRow
      .locator('[data-testid="hidden-crew-delete"]')
      .waitFor({ state: "visible", timeout: 10_000 });

    // Re-arm and confirm with a RAPID double-click — the in-flight guard must
    // collapse it to ONE request / ONE result note, no error note.
    console.log("[bug1] re-arming + confirming (double-click)…");
    await hiddenRow.locator('[data-testid="hidden-crew-delete"]').click();
    await confirmBtn.waitFor({ state: "visible", timeout: 10_000 });
    // Layout check: the armed row must not overflow its panel (compact confirm copy).
    await page.screenshot({ path: `${J.SHOTS_DIR}/bug1-delete-armed.png` });
    const overflows = await hiddenRow.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert(!overflows, "armed hidden-crew row must not overflow horizontally");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/seafarers") && r.request().method() === "DELETE",
        { timeout: 30_000 }
      ),
      confirmBtn.dblclick({ delay: 30 }),
    ]);
    await hiddenRow.waitFor({ state: "detached", timeout: 15_000 });
    const noteCount = await page.locator('[data-testid="hidden-crew-note"]').count();
    assert(noteCount === 1, `exactly one result note after delete (got ${noteCount})`);
    const errorCount = await page.locator('[data-testid="hidden-crew-error"]').count();
    assert(errorCount === 0, `no error note after a successful delete (got ${errorCount})`);
    // The card must NOT return to the board — delete is not a restore.
    assert(
      (await card(page, name).count()) === 0,
      "deleted seaman must not reappear on the board"
    );
    console.log("[bug1] delete journey done — row gone, one note, no errors.");

    // --- DISMISSAL: click-outside closes immediately; hover-away closes even
    // while the TRIGGER holds focus (the real post-click state — a focused trigger
    // button must not suppress the close; only a focused text field may).
    // Panel body = the crew list OR the "No hidden crew." note (whichever loads).
    const panelBody = page.locator(
      '[data-testid="hidden-crew-list"], [data-testid="hidden-crew-empty"]'
    );
    const OUTSIDE = { x: 300, y: 130 }; // the "Fleet pipeline" heading area — inert

    console.log("[bug1] click-outside should close the panel immediately…");
    await page.waitForTimeout(500); // let any pending hover-close resolve
    if ((await panelBody.count()) === 0) {
      await hiddenOpenBtn.click(); // panel closed itself — open it fresh
    }
    await panelBody.first().waitFor({ state: "visible", timeout: 10_000 });
    await page.mouse.click(OUTSIDE.x, OUTSIDE.y);
    await page.waitForTimeout(150); // immediate — well under the hover grace delay
    assert(
      (await panelBody.count()) === 0,
      "hidden crew panel must close IMMEDIATELY on an outside click"
    );

    console.log("[bug1] hover-away should close the panel (trigger focused)…");
    await hiddenOpenBtn.click(); // reopen — focus now sits ON the trigger button
    await panelBody.first().waitFor({ state: "visible", timeout: 10_000 });
    await page.mouse.move(OUTSIDE.x, OUTSIDE.y); // leave WITHOUT clicking/refocusing
    await page.waitForTimeout(700); // > the 300ms grace delay
    assert(
      (await panelBody.count()) === 0,
      "hover-away must close the panel even while the trigger button holds focus"
    );
    console.log("[bug1] panel dismissal (click-outside + hover-away) verified.");

    console.log("\n[bug1] PASSED — remove → Hidden crew → restore → delete round-trips through the real route.");
    await browser.close();
    process.exit(0);
  } catch (err) {
    try {
      await page.screenshot({ path: `${J.SHOTS_DIR}/bug1-failure.png`, fullPage: true });
    } catch {}
    console.error("\n[bug1] FAILED");
    console.error(err);
    await browser.close();
    process.exit(1);
  }
}

main();
