// One-off visual verification for the DEF-12 sm verification-level badge redesign.
// Logs in via the reusable journey helper (dev test agent), then for a chosen
// verification level finds a seaman card, captures a close-up of the card, and
// measures the card for horizontal overflow (scrollWidth vs clientWidth).
//
// Usage:  node tests/badge-redesign-shots.mjs <phase>
//   <phase> = "before" | "after"  (only affects output filenames)

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "demo", "badge-redesign");
const phase = process.argv[2] ?? "after";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE-ERR:", m.text()); });

try {
  await J.loginAsTestAgent(page);
  await page.waitForTimeout(800);

  // Inventory every card: name + its roster verification level.
  const cards = await page.$$('[data-testid="seafarer-card"]');
  const inv = [];
  for (const c of cards) {
    const name = await c.getAttribute("data-name");
    const badge = await c.$('[data-testid="roster-verification-level"] [data-testid="verification-level"]');
    const level = badge ? await badge.getAttribute("data-level") : null;
    // Overflow check on the card root.
    const of = await c.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    inv.push({ name, level, of, handle: c });
  }
  console.log("PHASE:", phase, "cards:", inv.length);
  for (const r of inv) console.log(`  L${r.level}  ${r.name}  overflow: scrollWidth=${r.of.sw} clientWidth=${r.of.cw} ${r.of.sw > r.of.cw ? "OVERFLOW!" : "ok"}`);

  // Capture a close-up per level we care about (L0 self-uploaded, and L3 gov if present).
  for (const want of ["0", "3", "1", "2"]) {
    const hit = inv.find((r) => r.level === want);
    if (!hit) continue;
    await hit.handle.scrollIntoViewIfNeeded();
    await hit.handle.screenshot({ path: path.join(OUT, `${phase}-L${want}-card.png`) });
    console.log(`  shot: ${phase}-L${want}-card.png  (${hit.name})`);
  }

  // A wider board context shot too.
  const board = await page.$('[data-testid="agent-board"]');
  if (board) await board.screenshot({ path: path.join(OUT, `${phase}-board.png`) });
} catch (e) {
  console.log("FAIL:", e.message);
  await page.screenshot({ path: path.join(OUT, `${phase}-FAIL.png`) }).catch(() => {});
} finally {
  await browser.close();
}
