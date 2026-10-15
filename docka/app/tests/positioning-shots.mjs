// Docka CRM-positioning rewrite — Playwright screenshot capture (plan v4 §5.5;
// the plan file is not part of this archive). SELF-CONTAINED: if
// nothing is answering on :3000 it starts `next dev` itself; if a server is
// already serving :3000 (a developer's own session, or another agent's) it
// ATTACHES to it instead and leaves it running — this script only ever kills a
// dev server it spawned as its OWN child process, never someone else's.
//
// Captures, at three viewports (desktop 1280x800, tablet 820x1180 — the
// MANDATORY nav-wrap check per plan v4 §8 risk 8/D16 — and mobile 390x844),
// full-page PNGs of every changed surface:
//   /  /overview  /overview/agencies  /overview/seafarers  /verify
//   /registries  /registries/estonia  /resources
//   /resources/stcw-certificate-types  /what-is-primary-source-verification
//   /about  /contact  /book  /pricing  /sample/agency
// plus these extra, spec'd captures:
//   - mobile hamburger menu OPEN on /                      -> pos-nav-mobile-open-390.png
//   - header region only, 820 + 1280, on /                 -> pos-header-<w>.png
//   - footer region only, 390 + 1280, on /                 -> pos-footer-<w>.png
//   - homepage CRM section (data-testid="home-crm-card")   -> pos-home-crm-390.png
//   - WhatDockaIs strip (data-testid="what-docka-is") on
//     /registries/estonia and /resources/stcw-certificate-types
//                                                           -> pos-strip-<slug>-390.png
//   - consent banner still VISIBLE (no cookie pre-set), /  -> pos-home-consent-390.png
//   - / in zh and ru (docka_lang cookie), 390               -> pos-home-zh-390.png, pos-home-ru-390.png
//
// All routes except the one "banner visible" shot pre-set the docka_consent
// cookie the same way ConsentBanner's Accept button does (lib/consent.ts), so
// the fixed bottom bar never covers the capture.
//
// Every PNG lands in tests/shots/ as pos-<slug>-<width>.png (slug: "home" for
// "/", else the path with "/" -> "-"); tests/shots/pos-index.md lists them all
// with route + viewport. The dev server (if we started it) is ALWAYS hard-
// killed in a finally block — PID-rooted `taskkill /pid <pid> /T /F` on
// Windows — so a leftover `next dev` never hangs the calling agent
// (an internal rule: screenshot scripts must not hang). Exits non-zero if any
// capture failed, but only after that cleanup has run.
//
// Run: node tests/positioning-shots.mjs   (from app/, or via `node app/tests/positioning-shots.mjs`)
//      DOCKA_BASE_URL=http://localhost:3000 node tests/positioning-shots.mjs   (attach explicitly)
//      POS_SHOTS_ONLY=header node tests/positioning-shots.mjs   (partial re-capture)
//
// POS_SHOTS_ONLY=header limits the run to the three captures a nav/header fix
// round needs — pos-header-1280.png, pos-header-820.png and pos-home-820.png (/
// full-page at the tablet width) — so a chrome-only re-capture takes ~40s
// instead of ~4min. In that mode pos-index.md is deliberately NOT rewritten, so
// the index of the full 56-capture run stays intact. The dev-server lifecycle
// (attach-or-spawn, and the finally-block hard kill of a server we spawned) is
// identical in both modes.

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const PORT = 3000;
const BASE = process.env.DOCKA_BASE_URL ?? `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const ROUTES = [
  "/",
  "/overview",
  "/overview/agencies",
  "/overview/seafarers",
  "/verify",
  "/registries",
  "/registries/estonia",
  "/resources",
  "/resources/stcw-certificate-types",
  "/what-is-primary-source-verification",
  "/about",
  "/contact",
  "/book",
  "/pricing",
  "/sample/agency",
];

// Partial re-capture switch (see the header comment). "header" = the three
// captures a nav/header fix round is graded on; anything else = the full run.
const HEADER_ONLY = process.env.POS_SHOTS_ONLY === "header";

const LANG_COOKIE = "docka_lang"; // lib/i18n.ts LANG_COOKIE
const CONSENT_COOKIE = "docka_consent"; // lib/consent.ts CONSENT_COOKIE
const NAV_TOGGLE_SEL = '[aria-controls="site-mobile-nav"]'; // SiteNav.tsx hamburger button
const CRM_CARD_SEL = '[data-testid="home-crm-card"]';
const WHAT_DOCKA_IS_SEL = '[data-testid="what-docka-is"]';

function slug(route) {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/\//g, "-");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const index = []; // { file, route, viewport, note }
const ok = (m) => console.log("  ok  -", m);
const bad = (m) => {
  failures++;
  console.error("  FAIL -", m);
};
function record(file, route, viewportLabel, note = "") {
  index.push({ file, route, viewport: viewportLabel, note });
  ok(file);
}

// ---- dev server: attach if already serving, else spawn + hard-kill ---------

let devProc = null;
let startedByUs = false;

async function pingOnce() {
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (await pingOnce()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`dev server on ${BASE} did not return 200 on GET / within ${timeoutMs}ms`);
    }
    await sleep(1000);
  }
}

function startDevServer() {
  const nextBin = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextBin, "dev", "-p", String(PORT)], {
    cwd: APP_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    if (process.env.POS_VERBOSE) process.stdout.write(`[next] ${d}`);
  });
  proc.stderr.on("data", (d) => {
    if (process.env.POS_VERBOSE) process.stderr.write(`[next] ${d}`);
  });
  return proc;
}

async function ensureServerRunning() {
  if (await pingOnce()) {
    console.log(`[positioning-shots] :${PORT} already serving — attaching (will NOT be killed on exit)`);
    return;
  }
  console.log(`[positioning-shots] starting dev server (next dev -p ${PORT}) in ${APP_DIR} ...`);
  devProc = startDevServer();
  startedByUs = true;
  await waitForServer(120_000);
  console.log(`[positioning-shots] dev server ready on ${BASE}`);
}

// PID-rooted tree kill on Windows (never by image name) — mirrors
// verify-upload-e2e.mjs's killTree. Only ever called on a server THIS script
// spawned; an attached, pre-existing server is left running.
async function killDevServerIfOurs() {
  if (!startedByUs || !devProc || devProc.exitCode !== null) return;
  console.log("[positioning-shots] hard-killing the dev server we started...");
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(devProc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    devProc.kill("SIGTERM");
  }
  devProc = null;
  // Best-effort confirmation the port is actually free again (non-fatal).
  for (let i = 0; i < 5; i++) {
    if (!(await pingOnce())) return;
    await sleep(500);
  }
  console.warn(`[positioning-shots] warning: :${PORT} still answering shortly after kill`);
}

// ---- cookies -----------------------------------------------------------------

async function withConsentGranted(ctx) {
  // Same cookie/value ConsentBanner's Accept button writes (lib/consent.ts
  // writeConsentCookie) — pre-set it so the fixed bottom bar never renders
  // and never covers the capture.
  await ctx.addCookies([{ name: CONSENT_COOKIE, value: "granted", url: BASE }]);
}

async function withLang(ctx, lang) {
  await ctx.addCookies([{ name: LANG_COOKIE, value: lang, url: BASE }]);
}

// ---- capture helpers -----------------------------------------------------------

async function openPage(browser, viewport, { consent = true, lang = null } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (consent) await withConsentGranted(ctx);
  if (lang) await withLang(ctx, lang);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function goto(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForTimeout(400); // let mount animations settle
}

// Full-page capture of one route at one named viewport.
async function captureRoute(browser, route, viewportName) {
  const viewport = VIEWPORTS[viewportName];
  const { ctx, page } = await openPage(browser, viewport);
  try {
    await goto(page, route);
    const file = `pos-${slug(route)}-${viewport.width}.png`;
    await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
    record(file, route, `${viewportName} ${viewport.width}x${viewport.height}`);
  } catch (e) {
    bad(`${route} @ ${viewportName} (${viewport.width}x${viewport.height}) — ${e?.message ?? e}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  await ensureServerRunning();

  const browser = await chromium.launch({ headless: true });
  try {
    // ==== 1+2. Every route x every viewport, EN, consent pre-granted ==========
    // POS_SHOTS_ONLY=header narrows this to "/" at the tablet width, which is the
    // one full-page capture the header acceptance criteria are graded on.
    if (HEADER_ONLY) {
      await captureRoute(browser, "/", "tablet");
    } else {
      for (const route of ROUTES) {
        for (const viewportName of Object.keys(VIEWPORTS)) {
          await captureRoute(browser, route, viewportName);
        }
      }
    }

    // ==== 3a. Mobile hamburger menu OPEN on / =================================
    if (!HEADER_ONLY) {
      const { ctx, page } = await openPage(browser, VIEWPORTS.mobile);
      try {
        await goto(page, "/");
        const toggle = page.locator(NAV_TOGGLE_SEL).first();
        await toggle.waitFor({ state: "visible", timeout: 30_000 });
        await toggle.click();
        await page.locator("#site-mobile-nav").waitFor({ state: "visible", timeout: 10_000 });
        await page.waitForTimeout(300);
        const file = "pos-nav-mobile-open-390.png";
        await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
        record(file, "/", "mobile 390x844", "hamburger menu open (SiteNav.tsx)");
      } catch (e) {
        bad(`nav-mobile-open — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 3b. Header region only, 820 + 1280, on / =============================
    for (const [viewportName, width] of [["tablet", 820], ["desktop", 1280]]) {
      const { ctx, page } = await openPage(browser, VIEWPORTS[viewportName]);
      try {
        await goto(page, "/");
        const header = page.locator("header").first();
        await header.waitFor({ state: "visible", timeout: 30_000 });
        await header.scrollIntoViewIfNeeded();
        const file = `pos-header-${width}.png`;
        await header.screenshot({ path: path.join(SHOTS, file) });
        record(file, "/", `${viewportName} ${width}`, "header region only");
      } catch (e) {
        bad(`header @ ${width} — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 3c. Footer region only, 390 + 1280, on / ==============================
    for (const [viewportName, width] of HEADER_ONLY ? [] : [["mobile", 390], ["desktop", 1280]]) {
      const { ctx, page } = await openPage(browser, VIEWPORTS[viewportName]);
      try {
        await goto(page, "/");
        const footer = page.locator("footer").first();
        await footer.waitFor({ state: "visible", timeout: 30_000 });
        await footer.scrollIntoViewIfNeeded();
        const file = `pos-footer-${width}.png`;
        await footer.screenshot({ path: path.join(SHOTS, file) });
        record(file, "/", `${viewportName} ${width}`, "footer region only");
      } catch (e) {
        bad(`footer @ ${width} — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 3d. Homepage CRM section, scrolled into view, 390 =====================
    if (!HEADER_ONLY) {
      const { ctx, page } = await openPage(browser, VIEWPORTS.mobile);
      try {
        await goto(page, "/");
        const firstCard = page.locator(CRM_CARD_SEL).first();
        await firstCard.waitFor({ state: "visible", timeout: 30_000 });
        await firstCard.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const file = "pos-home-crm-390.png";
        await page.screenshot({ path: path.join(SHOTS, file) }); // viewport only
        record(file, "/", "mobile 390x844", "CRM section scrolled into view (home-crm-card)");
      } catch (e) {
        bad(`home-crm-390 — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 3e. WhatDockaIs strip on two content routes, 390 ========================
    for (const route of HEADER_ONLY ? [] : ["/registries/estonia", "/resources/stcw-certificate-types"]) {
      const { ctx, page } = await openPage(browser, VIEWPORTS.mobile);
      try {
        await goto(page, route);
        const strip = page.locator(WHAT_DOCKA_IS_SEL).first();
        await strip.waitFor({ state: "visible", timeout: 30_000 });
        await strip.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const file = `pos-strip-${slug(route)}-390.png`;
        await page.screenshot({ path: path.join(SHOTS, file) }); // viewport only
        record(file, route, "mobile 390x844", "WhatDockaIs strip scrolled into view");
      } catch (e) {
        bad(`strip ${route} — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 4. Consent banner VISIBLE (no cookie pre-set), / at 390 ================
    if (!HEADER_ONLY) {
      const { ctx, page } = await openPage(browser, VIEWPORTS.mobile, { consent: false });
      try {
        await goto(page, "/");
        await page.locator('[data-testid="consent-banner"]').waitFor({ state: "visible", timeout: 15_000 });
        const file = "pos-home-consent-390.png";
        await page.screenshot({ path: path.join(SHOTS, file) }); // viewport only — bar is fixed-bottom
        record(file, "/", "mobile 390x844", "consent banner visible (no choice stored)");
      } catch (e) {
        bad(`home-consent-390 — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }

    // ==== 7. Language spot checks: / at 390 in zh + ru ============================
    for (const lang of HEADER_ONLY ? [] : ["zh", "ru"]) {
      const { ctx, page } = await openPage(browser, VIEWPORTS.mobile, { lang });
      try {
        await goto(page, "/");
        const file = `pos-home-${lang}-390.png`;
        await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
        record(file, "/", "mobile 390x844", `docka_lang=${lang}`);
      } catch (e) {
        bad(`home-${lang}-390 — ${e?.message ?? e}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  } catch (e) {
    failures++;
    console.error("FATAL:", e);
  } finally {
    await browser.close().catch(() => {});
    await killDevServerIfOurs();
  }

  // ==== 5. Write the index ========================================================
  // A partial POS_SHOTS_ONLY run must NOT rewrite the index — it would replace the
  // full run's 56-row table with its own 3 rows.
  if (HEADER_ONLY) {
    console.log("[positioning-shots] POS_SHOTS_ONLY=header — pos-index.md left untouched (full-run index preserved)");
  } else {
    const lines = [
      "# Positioning-rewrite screenshots (plan v4 §5.5)",
      "",
      `Generated ${new Date().toISOString()} — ${index.length} capture(s), ${failures} failure(s).`,
      "",
      "| File | Route | Viewport | Note |",
      "| --- | --- | --- | --- |",
      ...index.map((r) => `| ${r.file} | ${r.route} | ${r.viewport} | ${r.note} |`),
      "",
    ];
    fs.writeFileSync(path.join(SHOTS, "pos-index.md"), lines.join("\n"), "utf-8");
    console.log(`[positioning-shots] wrote ${path.join(SHOTS, "pos-index.md")}`);
  }

  console.log("");
  if (failures) {
    console.error(`FAIL — ${failures} capture(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS — ${index.length} positioning screenshots captured in tests/shots/`);
}

main().catch(async (e) => {
  console.error("\n[positioning-shots] FAILED:", e);
  await killDevServerIfOurs().catch(() => {});
  process.exitCode = 1;
});
