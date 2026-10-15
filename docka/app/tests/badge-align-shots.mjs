// One-off visual verification, originally for the verification-chip LEFT-ALIGN
// fix. B2 card redesign: the `card-verification-summary` chip and the sibling
// completeness pill this driver measured are GONE (absorbed into the metric-grid
// cells/tooltips); the alignment claim it verified is superseded. Kept runnable
// as a card overflow + close-up shot tool: it now measures the floor badge
// against the metric grid's docs cell and still checks scrollWidth overflow.
//
// Usage:  node tests/badge-align-shots.mjs <phase>   (<phase> = "before" | "after")

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "demo", "badge-align");
const phase = process.argv[2] ?? "after";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE-ERR:", m.text()); });

try {
  await J.loginAsTestAgent(page);
  await page.waitForTimeout(800);

  const cards = await page.$$('[data-testid="seafarer-card"]');
  const measured = [];
  for (const c of cards) {
    const name = await c.getAttribute("data-name");
    const m = await c.evaluate((el) => {
      const chip = el.querySelector('[data-testid="roster-verification-level"] [data-testid="verification-level"]');
      // B2: the old completeness/verification-summary pills are gone — measure
      // against the metric grid's docs cell instead.
      const pill = el.querySelector('[data-testid="card-cell-docs"]');
      const r = (n) => (n ? +n.getBoundingClientRect().left.toFixed(2) : null);
      return { chipLeft: r(chip), pillLeft: r(pill), sw: el.scrollWidth, cw: el.clientWidth };
    });
    measured.push({ name, ...m, handle: c });
  }

  console.log("PHASE:", phase);
  for (const r of measured) {
    const delta = r.chipLeft != null && r.pillLeft != null ? (r.chipLeft - r.pillLeft).toFixed(2) : "n/a";
    console.log(`  ${r.name}: chipLeft=${r.chipLeft} pillLeft=${r.pillLeft} delta=${delta}px  overflow=${r.sw > r.cw ? "OVERFLOW!" : "ok"}(sw=${r.sw},cw=${r.cw})`);
  }

  const first = measured[0];
  await first.handle.scrollIntoViewIfNeeded();
  await first.handle.screenshot({ path: path.join(OUT, `${phase}-card.png`) });
  console.log(`  shot: ${phase}-card.png  (${first.name})`);

  const board = await page.$('[data-testid="agent-board"]');
  if (board) await board.screenshot({ path: path.join(OUT, `${phase}-board.png`) });
} catch (e) {
  console.log("FAIL:", e.message);
  await page.screenshot({ path: path.join(OUT, `${phase}-FAIL.png`) }).catch(() => {});
} finally {
  await browser.close();
}
