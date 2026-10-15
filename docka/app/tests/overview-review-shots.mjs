import { chromium } from "playwright";
import fs from "fs";

const OUT = "tests/shots/demo/overview-review";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shoot(path, name, { mobile = false } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true,
          userAgent: "Mozilla/5.0 (Linux; Android 10; SM-G970F) Mobile Safari/537.36" }
      : { viewport: { width: 1280, height: 900 } }
  );
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("PAGEERR: " + e.message));
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400); // let mount animations settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  // horizontal overflow check
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, overflow: de.scrollWidth - de.clientWidth };
  });
  console.log(`${name}: overflowX=${overflow.overflow}px (scrollW=${overflow.scrollW} clientW=${overflow.clientW}) errs=${errs.length ? JSON.stringify(errs) : "none"}`);
  return { page, ctx };
}

// 1. Chooser
await shoot("/overview", "01-chooser-desktop").then(({ ctx }) => ctx.close());
await shoot("/overview", "02-chooser-mobile", { mobile: true }).then(({ ctx }) => ctx.close());

// 2. Agencies — full page desktop + mobile
await shoot("/overview/agencies", "03-agencies-desktop").then(({ ctx }) => ctx.close());
await shoot("/overview/agencies", "04-agencies-mobile", { mobile: true }).then(({ ctx }) => ctx.close());

// 3. Agencies — interact: select Reyes persona (highlights G3+G2, shows callout)
{
  const { page, ctx } = await shoot("/overview/agencies", "05-agencies-pre-interact");
  const reyes = page.getByRole("button", { name: /Reyes/ });
  await reyes.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/06-agencies-reyes-selected.png`, fullPage: true });
  // click a level badge in the Verification-level mix (G3)
  const lvl = page.getByRole("button", { name: /Government-verified|Registry|Reviewed|Self/ }).first();
  if (await lvl.count()) { await lvl.click().catch(()=>{}); await page.waitForTimeout(400); }
  await page.screenshot({ path: `${OUT}/07-agencies-level-selected.png`, fullPage: true });
  await ctx.close();
}

// 4. Seafarers — full page desktop + mobile
await shoot("/overview/seafarers", "08-seafarers-desktop").then(({ ctx }) => ctx.close());
await shoot("/overview/seafarers", "09-seafarers-mobile", { mobile: true }).then(({ ctx }) => ctx.close());

// 5. Seafarers — interact: Wei persona (S1), open a trust rung, toggle an S4 spoke
{
  const { page, ctx } = await shoot("/overview/seafarers", "10-seafarers-pre-interact");
  const wei = page.getByRole("button", { name: /Wei/ });
  await wei.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/11-seafarers-wei-selected.png`, fullPage: true });
  // toggle off all S4 spokes to hit the empty-state
  for (const nm of ["Baltic Crewing", "North Sea Marine", "Pacific Fleet"]) {
    const b = page.getByRole("button", { name: new RegExp(nm) });
    if (await b.count()) { await b.first().click().catch(()=>{}); await page.waitForTimeout(200); }
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/12-seafarers-s4-all-off.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log("done");
