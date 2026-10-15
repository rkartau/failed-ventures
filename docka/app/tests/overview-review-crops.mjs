import { chromium } from "playwright";
const OUT = "tests/shots/demo/overview-review";
const browser = await chromium.launch();

async function cropGraphs(path, prefix) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  // screenshot each graph section (GraphShell renders as <section> inside the graphs grid)
  const secs = await page.locator("main section, div.hero-bg section").all();
  // Instead target the graph cards: they are the rounded-xl border bg-white p-5 sections containing the illustrative caption
  const cards = page.locator("section:has(p.italic)");
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    await cards.nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await cards.nth(i).screenshot({ path: `${OUT}/${prefix}-graph${i + 1}.png` }).catch((e) => console.log("skip", i, e.message));
  }
  console.log(`${prefix}: ${n} graph cards`);
  await ctx.close();
}

await cropGraphs("/overview/agencies", "m-ag");
await cropGraphs("/overview/seafarers", "m-sf");
await browser.close();
console.log("done");
