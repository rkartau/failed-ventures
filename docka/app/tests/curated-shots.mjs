// Capture curated-demo screenshots against the LIVE dev server (localhost:3000):
//   - the full /agent board
//   - the single-seaman REVIEW view for three representative cards:
//       Katrin Meri (all-verified), Sergei Popov (messy multi-issue),
//       Oleksandr Kovalenko (one of the duplicate pair)
// Saves into tests/shots/curated/. Run: node tests/curated-shots.mjs

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "curated");

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`  saved ${out} (${kb} KB)`);
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  // Smaller viewport keeps the PNGs small.
  const context = await browser.newContext({ viewport: { width: 1100, height: 780 } });
  const page = await context.newPage();
  try {
    console.log("[shots] login as test agent (crewing role)…");
    await J.loginAsTestAgent(page);
    console.log("[shots] full agent board…");
    await shot(page, "board");

    for (const [name, file] of [
      ["Katrin Meri", "review-all-verified"],
      ["Sergei Popov", "review-messy"],
      ["Oleksandr Kovalenko", "review-duplicate"],
    ]) {
      console.log(`[shots] review view: ${name}…`);
      await page.goto(`${J.BASE_URL}/agent`, { waitUntil: "domcontentloaded" });
      await J.reviewSeaman(page, name);
      await shot(page, file);
    }
    console.log("[shots] DONE");
  } catch (err) {
    console.error("[shots] FAILED", err);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  process.exit(0);
}
main();
