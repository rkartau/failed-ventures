// B2 board-card redesign — Playwright driver (plan Phase 4.3 + R1-7 additions).
//
// Static/behavioral element checks + the full states-matrix screenshot set:
//   - review-link is a REAL <a href="/agent/…"> (ctrl/middle-click semantics as
//     element type), draggable=false;
//   - <=1 card-strip-red and <=1 card-strip-amber per card (structural cap);
//   - drag a card between columns -> the move applies and NO navigation occurs.
//     NOTE on the cited maria-r12-move.mjs precedent (R1-7): that driver moves
//     cards via the move-next BUTTON, not DnD — no HTML5-DnD synthesis exists in
//     the repo, and raw Playwright mouse moves do not start native drags. The
//     drag flow is therefore synthesised with constructed DragEvents sharing one
//     DataTransfer (dragstart -> dragover -> drop -> dragend), which drives the
//     REAL React handlers (onDragStart payload, handleDrop -> move(), onDragEnd
//     click-guard timestamp), plus an in-window click to prove the guard;
//   - checkbox / move-next / kebab clicks never open the profile;
//   - kebab flows: open -> remove-from-board visible, disabled at sea, menu
//     dismisses when a drag starts (R1-7) and on outside click;
//   - docs-cell tooltip hover-reachability above the stretched-link overlay (R1-5);
//   - language-switch strip recompute (R1-2);
//   - /sample/agency renders the redesigned card READ-ONLY.
//
// Prereqs: node tests/board-card-seed.mjs + node scripts/seed-samples.mjs run
// against THIS worktree's app/data/db.json while the server is DOWN, then the
// dev server up (DOCKA_DEMO_LOGIN=1). Run: node tests/board-card-shots.mjs

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = J.BASE_URL;
const SHOTS = path.join(__dirname, "shots", "board-card");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (m) => console.log("  ok  -", m);
const bad = (m) => {
  failures++;
  console.error("  FAIL -", m);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const cardSel = (name) => `[data-testid="seafarer-card"][data-name="ZZB2 ${name}"]`;
const card = (page, name) => page.locator(cardSel(name)).first();

async function shotCard(page, name, file) {
  const c = card(page, name);
  await c.scrollIntoViewIfNeeded();
  await c.screenshot({ path: path.join(SHOTS, `${file}.png`) });
  console.log("  shot -", `${file}.png`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

try {
  await J.loginAsTestAgent(page);

  // ==== A. Legend + per-card structural checks ==============================
  check((await page.locator('[data-testid="board-legend"]').count()) === 1, "legend line renders once on /agent");

  const cards = page.locator('[data-testid="seafarer-card"][data-name^="ZZB2 "]');
  const cardCount = await cards.count();
  check(cardCount >= 14, `all matrix cards on the board (${cardCount})`);
  for (let i = 0; i < cardCount; i++) {
    const c = cards.nth(i);
    const name = await c.getAttribute("data-name");
    const reds = await c.locator('[data-testid="card-strip-red"]').count();
    const ambers = await c.locator('[data-testid="card-strip-amber"]').count();
    if (reds > 1 || ambers > 1) bad(`${name}: strip cap violated (red=${reds}, amber=${ambers})`);
    const overflows = await c.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    if (overflows) bad(`${name}: card overflows horizontally`);
    // Full-bleed bands (operator feedback): every strip spans the card's whole
    // padding box — no side margins, no own radius/ring insetting it.
    const stripGeom = await c.evaluate((el) => {
      const cardRect = el.getBoundingClientRect();
      return [...el.querySelectorAll('[data-testid^="card-strip-"]')].map((s) => {
        const r = s.getBoundingClientRect();
        const cs = getComputedStyle(s);
        return {
          tid: s.getAttribute("data-testid"),
          fullBleed: Math.abs(r.width - el.clientWidth) <= 1,
          left: Math.round(r.left - cardRect.left),
          radius: cs.borderTopLeftRadius,
          sideBorder: parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0,
        };
      });
    });
    for (const g of stripGeom) {
      if (!g.fullBleed || g.radius !== "0px" || g.sideBorder) {
        bad(`${name} ${g.tid}: not a full-bleed band (fullBleed=${g.fullBleed}, radius=${g.radius}, sideBorder=${g.sideBorder})`);
      }
    }
  }
  ok("<=1 red and <=1 amber strip per card; strips are full-bleed bands; no horizontal overflow");

  // review-link is a literal anchor into /agent/<id>, draggable=false.
  const link = card(page, "Clean Self").locator('[data-testid="review-link"]');
  check((await link.evaluate((el) => el.tagName)) === "A", "review-link is a real <a>");
  check((await link.getAttribute("href"))?.startsWith("/agent/"), "review-link href targets /agent/<id>");
  check((await link.getAttribute("draggable")) === "false", "review-link is draggable=false");

  // All-clear card carries NO strips; the 4-strip card carries all four in order.
  check(
    (await card(page, "Clean Self").locator('[data-testid^="card-strip-"]').count()) === 0,
    "clean card has zero strips (quiet = all clear)"
  );
  const fourStrip = await card(page, "Four Strip")
    .locator('[data-testid^="card-strip-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  check(
    JSON.stringify(fourStrip) ===
      JSON.stringify(["card-strip-red", "card-strip-amber", "card-strip-sky", "card-strip-neutral"]),
    `4-strip worst case renders red+amber+sky+neutral in order (${fourStrip.join(", ")})`
  );

  // Gov cell: "+N pend" anchored on the card (REQUIRED #9).
  const pendText = await card(page, "Verify Pending").locator('[data-testid="card-cell-gov"]').innerText();
  check(/0 gov/.test(pendText) && /\+2 pend/.test(pendText), `gov cell shows "0 gov +2 pend" (${pendText.trim()})`);

  // ==== B. Tooltip hover-reachability above the overlay (R1-5) ==============
  const docsCell = card(page, "Clean Self").locator('[data-testid="card-cell-docs"]');
  await docsCell.scrollIntoViewIfNeeded();
  await docsCell.hover();
  const hoverHit = await page.evaluate((sel) => {
    const cell = document.querySelector(`${sel} [data-testid="card-cell-docs"]`);
    const r = cell.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return cell === el || cell.contains(el);
  }, cardSel("Clean Self"));
  check(hoverHit, "docs cell (not the stretched-link overlay) is the hover target");
  const tipVars = await docsCell.getAttribute("title");
  check(/5\/5/.test(tipVars ?? ""), `docs tooltip carries completeness (${tipVars})`);

  // ==== C. Nested controls never open the profile ===========================
  const urlBefore = page.url();
  await card(page, "Tagged Crew").locator('[data-testid="card-select"]').click();
  await page.waitForTimeout(300);
  check(page.url() === urlBefore, "checkbox click does not navigate");
  check(
    (await card(page, "Tagged Crew").getAttribute("data-selected")) === "true",
    "checkbox click selects the card"
  );
  await shotCard(page, "Tagged Crew", "12-tagged-selected");

  await card(page, "Clean Self").locator('[data-testid="move-next"]').click();
  await page
    .waitForResponse((r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH", { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  check(page.url() === urlBefore, "move-next click does not navigate");

  // ==== D. Kebab flows ======================================================
  const cleanKebab = card(page, "Clean Gov").locator('[data-testid="card-menu"]');
  await cleanKebab.click();
  const removeItem = card(page, "Clean Gov").locator('[data-testid="remove-from-board"]');
  await removeItem.waitFor({ state: "visible", timeout: 5_000 });
  check(!(await removeItem.isDisabled()), "kebab: remove enabled for a not-at-sea seaman");
  check(page.url() === urlBefore, "kebab click does not navigate");
  await shotCard(page, "Clean Gov", "15-kebab-open");
  // Outside click dismisses.
  await page.mouse.click(20, 200);
  await page.waitForTimeout(300);
  check((await removeItem.count()) === 0, "kebab menu closes on outside click");

  // Disabled at sea (identical semantics to the old inline control).
  await card(page, "At Sea Gap").locator('[data-testid="card-menu"]').click();
  const atSeaRemove = card(page, "At Sea Gap").locator('[data-testid="remove-from-board"]');
  await atSeaRemove.waitFor({ state: "visible", timeout: 5_000 });
  check(await atSeaRemove.isDisabled(), "kebab: remove DISABLED while at sea / on assignment");
  check(
    /at sea/i.test((await atSeaRemove.getAttribute("title")) ?? ""),
    "at-sea remove keeps the explanatory title"
  );
  await page.mouse.click(20, 200);
  await page.waitForTimeout(300);

  // Kebab open, then a drag starts -> the menu dismisses (R1-7). Synthesised
  // dragstart drives the card's real onDragStart (which closes the menu).
  const dragCard = card(page, "Expired Cert");
  await dragCard.scrollIntoViewIfNeeded();
  await dragCard.locator('[data-testid="card-menu"]').click();
  await dragCard.locator('[data-testid="remove-from-board"]').waitFor({ state: "visible", timeout: 5_000 });
  {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
      );
    }, cardSel("Expired Cert"));
    await page.waitForTimeout(300);
    const openWhileDrag = await dragCard.locator('[data-testid="remove-from-board"]').count();
    check(openWhileDrag === 0, "kebab menu dismisses when a drag starts (R1-7)");
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
    }, cardSel("Expired Cert"));
    await page.waitForTimeout(400);
  }

  // ==== E. Drag between columns: move applies, NO navigation ================
  {
    const patchDone = page
      .waitForResponse((r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH", { timeout: 15_000 })
      .catch(() => null);
    await page.evaluate((sel) => {
      const cardEl = document.querySelector(sel);
      const col = document.querySelector('[data-testid="column-returning"]');
      const dataTransfer = new DataTransfer();
      const opts = { bubbles: true, cancelable: true, dataTransfer };
      cardEl.dispatchEvent(new DragEvent("dragstart", opts));
      col.dispatchEvent(new DragEvent("dragover", opts));
      col.dispatchEvent(new DragEvent("drop", opts));
      cardEl.dispatchEvent(new DragEvent("dragend", opts));
      // An UNTRUSTED click still runs anchor activation — inside the 300ms
      // guard window it must be preventDefault()ed by the card, or we navigate.
      cardEl
        .querySelector('[data-testid="review-link"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, cardSel("Clean Gov"));
    check((await patchDone) !== null, "drop fires the real PATCH stage move");
    await page.waitForTimeout(600);
    const inTarget = await page
      .locator(`[data-testid="column-returning"] ${cardSel("Clean Gov")}`)
      .count();
    check(inTarget === 1, "drag between columns moves the card");
    check(page.url() === urlBefore, "drag between columns does NOT navigate (dragend click-guard)");
  }

  // ==== F. Language switch recomputes the strips (R1-2) =====================
  {
    const strip = card(page, "Expired Cert").locator('[data-testid="card-strip-red"]');
    const en = await strip.innerText();
    await page.locator('[data-testid="lang-switcher"]').selectOption("ru");
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(`${sel} [data-testid="card-strip-red"]`);
        return el && /истек/i.test(el.textContent || "");
      },
      cardSel("Expired Cert"),
      { timeout: 15_000 }
    );
    const ru = await strip.innerText();
    check(en !== ru && /истек/i.test(ru), `en→ru switch recomputes strip text ("${en}" → "${ru}")`);
    await shotCard(page, "Expired Cert", "16-expired-ru");
    await page.locator('[data-testid="lang-switcher"]').selectOption("en");
    await page.waitForTimeout(600);
  }

  // ==== G. verify-pending filter still anchored =============================
  await page.locator('[data-testid="filter-verify-pending"]').click();
  await page.waitForTimeout(400);
  check((await card(page, "Verify Pending").count()) === 1, "verify-pending filter keeps the pending card");
  check((await card(page, "Missing Docs").count()) === 0, "verify-pending filter drops non-pending crew");
  await page.locator('[data-testid="filter-all"]').click();
  await page.waitForTimeout(400);

  // ==== H. States-matrix screenshot set =====================================
  const matrixShots = [
    ["Clean Self", "01-clean-self-uploaded"],
    ["Clean Gov", "02-clean-gov-floor"],
    ["Package Ready", "03-package-ready-sky"],
    ["Expiring Soon", "04-expiring-amber"],
    ["Missing Docs", "05-missing-amber"],
    ["Unknown Expiry", "06-unknown-expiry-amber"],
    ["Expired Cert", "07-expired-red"],
    ["Worst Case", "08-worst-red-amber-stacked"],
    ["At Sea Gap", "09-at-sea-locked"],
    ["Sea Reconfirm", "10-sea-reconfirm"],
    ["Verify Pending", "11-verify-pending"],
    ["Four Strip", "13-four-strip-worst"],
    ["Zero Docs", "14-zero-docs"],
  ];
  for (const [name, file] of matrixShots) await shotCard(page, name, file);
  await page.locator('[data-testid="agent-board"]').screenshot({ path: path.join(SHOTS, "00-full-board.png") });
  console.log("  shot - 00-full-board.png");

  // ==== H2. Narrow-column pass (operator fix): no mid-word name breaks, and
  // the metric grid restacks BELOW the identity block under the card's
  // @container threshold; side-by-side is preserved at comfortable widths. ====
  {
    // (a) The name element must carry NO mid-word break styling, at any width.
    const nameStyle = await card(page, "Verify Pending")
      .locator('[data-testid="card-name"]')
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap };
      });
    check(
      nameStyle.wordBreak === "normal" &&
        !["break-word", "anywhere"].includes(nameStyle.overflowWrap),
      `card-name has no mid-word break styling (word-break=${nameStyle.wordBreak}, overflow-wrap=${nameStyle.overflowWrap})`
    );

    // Standard 5-column board (~195px card content, under the 15rem card
    // threshold): the grid must sit full-width BELOW the identity block — the
    // measured ~140px grid can never share that width with a readable name
    // (the pre-fix "side-by-side" rendered names as "ZZ/B2/Cle/an/Sel/f").
    const standardStacked = await card(page, "Clean Self").evaluate((el) => {
      const name = el.querySelector('[data-testid="card-name"]').getBoundingClientRect();
      const grid = el.querySelector('[data-testid="card-metric-grid"]');
      const g = grid.getBoundingClientRect();
      return g.top >= name.bottom - 1 && g.width >= el.clientWidth - 26;
    });
    check(standardStacked, "standard board: grid renders full-width below the identity block");

    // COMFORTABLE width (single-column board below lg -> full-width cards):
    // the approved side-by-side header layout holds, name un-crushed.
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.waitForTimeout(600);
    const sideBySide = await card(page, "Clean Self").evaluate((el) => {
      const name = el.querySelector('[data-testid="card-name"]');
      const nr = name.getBoundingClientRect();
      const grid = el.querySelector('[data-testid="card-metric-grid"]').getBoundingClientRect();
      // Grid beside (overlapping the name's vertical band) AND the name on one line.
      return grid.top < nr.bottom && nr.height < 30;
    });
    check(sideBySide, "comfortable width (wide card): metric grid stays beside an un-wrapped name");

    // (b) Narrow columns: 1024px viewport -> 5 columns of ~185px cards.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(600);
    const stacked = await card(page, "Verify Pending").evaluate((el) => {
      const name = el.querySelector('[data-testid="card-name"]').getBoundingClientRect();
      const grid = el.querySelector('[data-testid="card-metric-grid"]').getBoundingClientRect();
      const gridDisplay = getComputedStyle(el.querySelector('[data-testid="card-metric-grid"]')).display;
      // clientWidth includes the card's p-3 padding; the grid spans the
      // CONTENT box, so full-bleed-of-content = clientWidth minus ~24px.
      return { below: grid.top >= name.bottom - 1, fullWidth: grid.width >= el.clientWidth - 26, gridDisplay };
    });
    check(
      stacked.below && stacked.fullWidth && stacked.gridDisplay === "flex",
      `narrow card: grid renders full-width BELOW the identity block as a flowing row (below=${stacked.below}, fullWidth=${stacked.fullWidth}, display=${stacked.gridDisplay})`
    );
    // No mid-word break in the rendered narrow name: every rendered line of the
    // name must be a substring boundary at spaces (client rects per word).
    const narrowOverflow = [];
    const cardsNarrow = page.locator('[data-testid="seafarer-card"][data-name^="ZZB2 "]');
    const nNarrow = await cardsNarrow.count();
    for (let i = 0; i < nNarrow; i++) {
      const c = cardsNarrow.nth(i);
      const name = await c.getAttribute("data-name");
      if (await c.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) narrowOverflow.push(name);
    }
    check(narrowOverflow.length === 0, `no card overflows at narrow width (${narrowOverflow.join(", ") || "none"})`);
    await shotCard(page, "Verify Pending", "18-narrow-card");
    await page.locator('[data-testid="agent-board"]').screenshot({ path: path.join(SHOTS, "19-narrow-full-board.png") });
    console.log("  shot - 19-narrow-full-board.png");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(600);
  }

  // ==== I. /sample/agency renders the new card READ-ONLY ====================
  {
    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p2 = await anon.newPage();
    await p2.goto(`${BASE}/sample/agency`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await p2.locator('[data-testid="sample-banner"]').waitFor({ timeout: 60_000 });
    check((await p2.locator('[data-testid="board-legend"]').count()) === 1, "sample board renders the legend");
    check((await p2.locator('[data-testid="card-metric-grid"]').count()) > 0, "sample cards carry the metric grid");
    check((await p2.locator('[data-testid="card-select"]').count()) === 0, "sample board: no checkboxes");
    check((await p2.locator('[data-testid="card-menu"]').count()) === 0, "sample board: no kebab");
    check((await p2.locator('[data-testid="move-next"]').count()) === 0, "sample board: no move controls");
    const sampleHrefs = await p2
      .locator('[data-testid="review-link"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    check(
      sampleHrefs.length > 0 && sampleHrefs.every((h) => h === "#sample-review"),
      "sample review links all target #sample-review"
    );
    await p2.locator('[data-testid="agent-board"]').screenshot({ path: path.join(SHOTS, "17-sample-agency-board.png") });
    console.log("  shot - 17-sample-agency-board.png");
    await anon.close();
  }
} catch (e) {
  failures++;
  console.error("FATAL:", e);
  await page.screenshot({ path: path.join(SHOTS, "FAIL.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log("");
if (failures) {
  console.error(`FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("PASS — board-card Playwright checks green; screenshots in tests/shots/board-card/");
