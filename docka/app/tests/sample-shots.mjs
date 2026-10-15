// Public Sample Profiles — Phase 7 Playwright driver (plan Phase 7): logged-out
// journeys + operator-review screenshots, the JS-DISABLED SSR assertion, forced
// mutation probes, the Phase-5 agent journey (search chip → add-to-board
// auto-grant → board chip → silent doc request + circular), the /share/<token>
// HTML two-pass (the JSX half the unit two-pass cannot cover), tenant isolation
// of the interactions, and the ru/zh i18n spot checks.
//
// Prereqs (see tests/demo-populate.mjs conventions):
//   1. node scripts/seed-samples.mjs against THIS worktree's app/data/db.json
//      (+ two demo agents "dev" and "agent-b" present as real agent rows);
//   2. dev server: DOCKA_DEMO_LOGIN=1 next dev --port 3111 (or set DOCKA_BASE_URL).
//
// Run: node tests/sample-shots.mjs      (exit 0 = all assertions pass)

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");
const BASE = process.env.DOCKA_BASE_URL ?? "http://localhost:3111";
const SHOTS = path.join(__dirname, "shots", "sample");
const DB_PATH = path.join(APP, "data", "db.json");
fs.mkdirSync(SHOTS, { recursive: true });

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const FLAG = "sample-seafarer-flagship";
const flagship = db.seafarers.find((s) => s.id === FLAG && s.isSample === true);
if (!flagship) throw new Error("seed first: flagship missing from app/data/db.json");
const TOKEN = flagship.openShareToken;
const CURATED_DOC_TITLES = db.documents
  .filter((d) => d.sample === true && d.seafarerId === FLAG)
  .map((d) => d.title);
const INBOX_SUBJECT = db.circulars.find(
  (c) => c.sample === true && c.recipientIds.includes(FLAG)
).subject;
const NOTIFICATIONS_BEFORE = (db.notifications ?? []).length;

let failures = 0;
const ok = (m) => console.log("  ok  -", m);
const bad = (m) => {
  failures++;
  console.error("  FAIL -", m);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: name.includes("full") });
  console.log("  shot -", `${name}.png`);
}

const NAV = { waitUntil: "domcontentloaded", timeout: 120_000 };

const browser = await chromium.launch();
try {
  // ==== A. Logged-out journeys + operator screenshots ========================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/sample/seafarer`, NAV);
    await page.locator('[data-testid="sample-banner"]').waitFor({ timeout: 120_000 });
    await shot(page, "01-seafarer-top");
    // Documents region — scroll the first curated doc title into view.
    const firstDoc = page.getByText(CURATED_DOC_TITLES[0]).first();
    await firstDoc.waitFor({ timeout: 60_000 });
    await firstDoc.scrollIntoViewIfNeeded();
    await shot(page, "02-seafarer-docs");
    // Inbox thread.
    const inbox = page.locator('[data-testid="inbox"]');
    await inbox.scrollIntoViewIfNeeded();
    await shot(page, "03-seafarer-inbox");
    check(
      (await page.getByText(INBOX_SUBJECT).count()) > 0,
      "flagship page renders the curated inbox subject"
    );

    await page.goto(`${BASE}/sample/agency`, NAV);
    await page.locator('[data-testid="sample-banner"]').waitFor({ timeout: 120_000 });
    await shot(page, "04-agency-board");
    const review = page.locator("#sample-review");
    await review.scrollIntoViewIfNeeded();
    await shot(page, "05-agency-review");
    check(
      (await page.locator('[data-testid="card-sample-chip"]').count()) > 0,
      "agency board cards carry the SAMPLE chip"
    );
    await ctx.close();
  }

  // ==== B. JS-DISABLED SSR assertion =========================================
  {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/sample/seafarer`, NAV);
    const html = await page.content();
    check(html.includes("live demo on fictional data"), "no-JS HTML carries the banner");
    check(html.includes(INBOX_SUBJECT), "no-JS HTML carries the inbox subject");
    const missing = CURATED_DOC_TITLES.filter((t) => !html.includes(t));
    check(
      missing.length === 0,
      `no-JS HTML carries all ${CURATED_DOC_TITLES.length} curated doc titles` +
        (missing.length ? ` (missing: ${missing.join("; ")})` : "")
    );
    check(!/REAL |PW Adversarial/.test(html), "no-JS HTML carries no non-curated marker");
    await ctx.close();
  }

  // ==== C. Forced mutation probes (anonymous, published token) ===============
  {
    const ctx = await browser.newContext();
    const probes = [
      ["PATCH seafarers rank", () => ctx.request.patch(`${BASE}/api/seafarers`, { data: { id: FLAG, rank: "Hacked", token: TOKEN } })],
      ["PATCH seafarers rotate", () => ctx.request.patch(`${BASE}/api/seafarers`, { data: { id: FLAG, rotateToken: true, token: TOKEN } })],
      ["POST comments", () => ctx.request.post(`${BASE}/api/comments`, { data: { seafarerId: FLAG, text: "spam", token: TOKEN } })],
      ["POST sea-service", () => ctx.request.post(`${BASE}/api/sea-service`, { data: { seafarerId: FLAG, vessel: "X", rank: "Y", signOn: "2024-01-01", token: TOKEN } })],
      ["POST inbox/seen", () => ctx.request.post(`${BASE}/api/inbox/seen`, { data: { token: TOKEN } })],
      ["POST circulars (anon)", () => ctx.request.post(`${BASE}/api/circulars`, { data: { subject: "x", message: "y" } })],
      ["POST doc-requests (anon)", () => ctx.request.post(`${BASE}/api/doc-requests`, { data: { seafarerId: FLAG, items: [{ label: "x" }] } })],
    ];
    for (const [label, fire] of probes) {
      const res = await fire();
      check([401, 403].includes(res.status()), `${label} -> ${res.status()} (401/403)`);
    }
    await ctx.close();
  }

  // ==== D. Phase-5 agent journey =============================================
  const anonShare = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sharePage = await anonShare.newPage();
  const shareTextOf = async () => {
    await sharePage.goto(`${BASE}/share/${TOKEN}`, NAV);
    await sharePage.locator("h1").first().waitFor({ timeout: 60_000 });
    return sharePage.evaluate(() => document.body.innerText);
  };
  const sharePass1 = await shareTextOf(); // BEFORE any agent interaction

  {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const login = await ctxA.request.post(`${BASE}/api/test-login`, { data: { agentId: "dev" } });
    check(login.ok(), "dev-door login as agent A (dev)");
    const page = await ctxA.newPage();

    // Talent search: flagship injected with SAMPLE chip + Add to board.
    await page.goto(`${BASE}/agent/search`, NAV);
    await page.locator('[data-testid="search-sample-chip"]').waitFor({ timeout: 120_000 });
    check(true, "flagship appears in talent search with the SAMPLE chip");
    check(
      (await page.getByText(flagship.name).count()) > 0,
      "search row shows the flagship's name"
    );
    await shot(page, "06-search-sample-chip");

    // Add to board -> /share/<token> -> auto-grant.
    await page.locator('[data-testid="sample-add-to-board"]').click();
    await page.waitForURL(`**/share/${TOKEN}`, { timeout: 120_000 });
    await page.locator("h1").first().waitFor({ timeout: 60_000 });
    await shot(page, "07-share-after-add");
    const grant = JSON.parse(fs.readFileSync(DB_PATH, "utf8")).accessGrants.filter(
      (g) => g.seafarerId === FLAG && g.agentId === "dev"
    );
    check(grant.length === 1 && grant[0].status === "ACTIVE", "share open minted exactly ONE ACTIVE grant");

    // Board: flagship card with chip.
    await page.goto(`${BASE}/agent`, NAV);
    await page.locator('[data-testid="card-sample-chip"]').waitFor({ timeout: 120_000 });
    check(true, "granted flagship sits on agent A's board with the SAMPLE chip");
    await shot(page, "08-agent-board-flagship");

    // Search no longer offers Add to board (grant exists -> no injection).
    await page.goto(`${BASE}/agent/search`, NAV);
    await page.locator('[data-testid="search-sample-chip"]').waitFor({ timeout: 60_000 });
    check(
      (await page.locator('[data-testid="sample-add-to-board"]').count()) === 0,
      "granted flagship flows through agentData — injection (Add to board) stopped"
    );

    // Silent interactions: doc request + circular + an upload (share-HTML pass 2 fodder).
    const dr = await ctxA.request.post(`${BASE}/api/doc-requests`, {
      data: { seafarerId: FLAG, items: [{ label: "PW Adversarial Request" }], notify: true },
    });
    check(dr.ok(), "agent A files a doc request against the flagship");
    const circ = await ctxA.request.post(`${BASE}/api/circulars`, {
      data: { subject: "PW Adversarial Circular", message: "not for the public", allowReplies: false },
    });
    check(circ.ok(), "agent A sends a circular reaching the flagship");
    const fd = new FormData();
    fd.set("seafarerId", FLAG);
    fd.set("title", "PW Collider Upload");
    fd.set("file", new File(["collide"], "pw-collider.txt", { type: "text/plain" }));
    const up = await ctxA.request.post(`${BASE}/api/documents`, { multipart: fd });
    check(up.ok(), "agent A uploads a document onto the flagship");

    const dbAfter = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    check(
      (dbAfter.notifications ?? []).length === NOTIFICATIONS_BEFORE,
      "SILENT: db.notifications untouched by sample-directed sends"
    );
    const circRow = dbAfter.circulars.find((c) => c.subject === "PW Adversarial Circular");
    check(
      !!circRow && circRow.recipientIds.includes(FLAG),
      "circular keeps the flagship in recipientIds (agent-side thread intact)"
    );
    await ctxA.close();
  }

  // ==== E. Invisibility on every public surface ==============================
  {
    // /share/<token> two-pass: byte-identical visible text, no new doc metadata.
    const sharePass2 = await shareTextOf();
    check(sharePass1 === sharePass2, "/share HTML pass 2 is identical to pass 1 (two-pass)");
    check(!sharePass2.includes("PW "), "/share carries none of agent A's interactions");
    await anonShare.close();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const url of ["/sample/seafarer", "/sample/agency"]) {
      await page.goto(`${BASE}${url}`, NAV);
      await page.locator('[data-testid="sample-banner"]').waitFor({ timeout: 60_000 });
      const text = await page.evaluate(() => document.body.innerText);
      check(!text.includes("PW "), `${url} shows none of agent A's interactions`);
    }
    await ctx.close();
  }

  // ==== F. Second agent sees none of it ======================================
  {
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const login = await ctxB.request.post(`${BASE}/api/test-login`, { data: { agentId: "agent-b" } });
    check(login.ok(), "dev-door login as agent B (agent-b)");
    const page = await ctxB.newPage();

    await page.goto(`${BASE}/agent`, NAV);
    await page.locator('[data-testid="filter-all"]').first().waitFor({ timeout: 120_000 });
    check(
      (await page.locator('[data-testid="card-sample-chip"]').count()) === 0,
      "agent B's board has NO flagship (grants are per-tenant)"
    );
    const boardText = await page.evaluate(() => document.body.innerText);
    check(!boardText.includes("PW Adversarial"), "agent B sees none of A's interactions");

    await page.goto(`${BASE}/agent/search`, NAV);
    await page.locator('[data-testid="search-sample-chip"]').waitFor({ timeout: 60_000 });
    check(
      (await page.locator('[data-testid="sample-add-to-board"]').count()) === 1,
      "agent B (un-granted) still gets the injected flagship row with Add to board"
    );
    const searchText = await page.evaluate(() => document.body.innerText);
    check(!searchText.includes("PW Adversarial"), "agent B's search leaks nothing of A's");
    await ctxB.close();
  }

  // ==== G. i18n spot checks (ru, zh) =========================================
  for (const [lang, bannerNeedle, noteNeedle] of [
    ["ru", "вымышленных данных", "никто не отвечает"],
    ["zh", "虚构数据", "不会得到答复"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: "docka_lang", value: lang, url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/sample/seafarer`, NAV);
    await page.locator('[data-testid="sample-banner"]').waitFor({ timeout: 60_000 });
    const text = await page.evaluate(() => document.body.innerText);
    check(text.includes(bannerNeedle), `${lang}: banner renders translated`);
    check(text.includes(noteNeedle), `${lang}: compose note renders translated`);
    await shot(page, `09-seafarer-${lang}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log("");
if (failures) {
  console.error(`FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PASS — sample Playwright journeys green; screenshots in tests/shots/sample/");
