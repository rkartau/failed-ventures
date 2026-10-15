// Batch-1 persona-UX screenshot capture (#30 levels, #37 dup/merge import, #38 propagation).
// Drives the LIVE dev server + curated seed. Saves PNGs to tests/shots/batch1/.
// Each surface is wrapped so one failure never aborts the rest. Prints a JSON manifest.
//
//   DOCKA_BASE_URL=http://localhost:3000 node tests/batch1-shots.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = J.BASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "batch1");
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf-8"));
const byName = (n) => db.seafarers.find((s) => s.name === n);
const govDocId = (sfId) => (db.documents.find((d) => d.seafarerId === sfId && d.source === "government") || {}).id;

const marek = byName("Marek Tamm");
const results = [];
const consoleErrors = [];

function attach(page, surface) {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push({ surface, text: m.text().slice(0, 300) });
  });
  page.on("pageerror", (e) => consoleErrors.push({ surface, text: "pageerror: " + String(e).slice(0, 300) }));
}
async function shot(page, name) {
  const p = path.join(OUT, name + ".png");
  // #S15 — neutralise the Chromium fullPage-screenshot artifact where a
  // position:sticky header repaints down the page (the "duplicated Docka header
  // over the board" seen in review). Capture-only; product behaviour is unchanged.
  await page
    .addStyleTag({ content: ".sticky{position:static !important;}" })
    .catch(() => {});
  await page.screenshot({ path: p, fullPage: true });
  return p;
}
async function run(label, fn) {
  try {
    const files = await fn();
    results.push({ surface: label, ok: true, files });
    console.log(`[OK] ${label} -> ${(files || []).map((f) => path.basename(f)).join(", ")}`);
  } catch (e) {
    results.push({ surface: label, ok: false, error: String(e).split("\n")[0].slice(0, 200) });
    console.log(`[FAIL] ${label}: ${String(e).split("\n")[0]}`);
  }
}

const browser = await chromium.launch();

// ---- Agent context (desktop) -------------------------------------------------
const agentCtx = await browser.newContext({ viewport: DESKTOP });
const agent = await agentCtx.newPage();
attach(agent, "agent");
await J.loginAsTestAgent(agent);

// (A) Roster verification-level badges — the whole dev board shows a MIX
//     (DK gov L3 · GR reviewer L1 · RO requested L0 · BG registry L2 · manual L0).
await run("roster-verification-levels (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="roster-verification-level"]').first().waitFor({ state: "visible", timeout: 30000 });
  const levels = await agent.$$eval('[data-testid="roster-verification-level"] [data-testid="verification-level"]', (els) =>
    els.map((e) => e.getAttribute("data-level"))
  );
  console.log("   roster levels seen:", JSON.stringify(levels));
  return [await shot(agent, "01-roster-verification-levels")];
});

// (B) CV / certificate matrix with per-row cv-level badge (Marek: gov L3 + manual L0 mix).
await run("cv-level matrix (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${marek.id}`, { waitUntil: "domcontentloaded" });
  // Wait for the review panel to HYDRATE before clicking, so the open-cv handler is
  // attached (otherwise the click is a no-op and the modal never opens).
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await agent.locator('[data-testid="open-cv"]').first().waitFor({ state: "visible", timeout: 30000 });
  await agent.locator('[data-testid="open-cv"]').first().click();
  await agent.locator('[data-testid="cv-level"]').first().waitFor({ state: "visible", timeout: 15000 });
  // Capture the identity-bound vs holder-bound tooltip text (native title attr, #30.7).
  const tips = await agent.$$eval('[data-testid="cv-level"] [data-testid="verification-level"]', (els) =>
    els.map((e) => ({ level: e.getAttribute("data-level"), title: e.getAttribute("title") }))
  );
  console.log("   cv-level tooltips:", JSON.stringify(tips.slice(0, 6)));
  return [await shot(agent, "02-cv-level-matrix")];
});

// (F) Import → duplicate-person BATCH REVIEW + merge PREVIEW (#37.3).
await run("import batch-review + merge preview (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await agent.locator('[data-testid="import-open"]').first().click();
  await agent.locator('[data-testid="import-text"]').first().waitFor({ state: "visible", timeout: 10000 });
  // A dup of a seeded man (Viktor Petrov) + a transliteration variant so matches surface.
  await agent.locator('[data-testid="import-text"]').first().fill(
    "Name,Rank\nViktor Petrov,Fitter\nWiktor Petroff,Fitter\nBrand New Sailor,Cook\n"
  );
  await agent.locator('[data-testid="import-confirm"]').first().click();
  const files = [];
  const review = agent.locator('[data-testid="person-batch-review"]').first();
  await review.waitFor({ state: "visible", timeout: 30000 });
  files.push(await shot(agent, "04-import-batch-review"));
  // Load a merge preview on the first match row.
  const previewBtn = agent.locator('[data-testid="person-batch-review"] button', { hasText: "Preview" }).first();
  if (await previewBtn.count()) {
    await previewBtn.click();
    await agent.locator('[data-testid="person-match-preview"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    files.push(await shot(agent, "05-import-merge-preview"));
  }
  return files;
});

// (D) Manual single-add → inline "possible existing person" match + dismiss control (#37.8).
await run("manual-create inline match + dismiss (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await agent.locator('[data-testid="invite-open"]').first().click();
  await agent.locator('[data-testid="invite-names"]').first().waitFor({ state: "visible", timeout: 10000 });
  await agent.locator('[data-testid="invite-names"]').first().fill("Katrin Meri");
  await agent.locator('[data-testid="invite-send"]').first().click();
  await agent.locator('[data-testid="person-match-inline"]').first().waitFor({ state: "visible", timeout: 30000 });
  return [await shot(agent, "06-manual-create-inline-match")];
});

// ---- Public / seafarer-facing proof surfaces ---------------------------------
// (C) Per-doc verification badge on cert cards — public share view. Desktop + mobile.
await run("per-doc cert badges on share (desktop+mobile)", async () => {
  const files = [];
  const d = await agentCtx.newPage();
  attach(d, "share");
  await d.goto(`${BASE}/share/${marek.shareToken}`, { waitUntil: "domcontentloaded" });
  await d.locator('[data-testid="verification-level"]').first().waitFor({ state: "visible", timeout: 30000 });
  files.push(await shot(d, "03-share-cert-badges-desktop"));
  await d.close();
  const m = await (await browser.newContext({ viewport: MOBILE })).newPage();
  attach(m, "share-mobile");
  await m.goto(`${BASE}/share/${marek.shareToken}`, { waitUntil: "domcontentloaded" });
  await m.locator('[data-testid="verification-level"]').first().waitFor({ state: "visible", timeout: 30000 });
  files.push(await shot(m, "03-share-cert-badges-mobile"));
  await m.context().close();
  return files;
});

// (A2) verify-level on the public proof page (#30 on /verify/[uuid]).
await run("verify-level public proof (desktop)", async () => {
  const gid = govDocId(marek.id);
  const linkRes = await agent.request.get(`${BASE}/api/verify-link?documentId=${gid}&token=${marek.shareToken}`);
  const link = await linkRes.json();
  if (!link.ok) throw new Error("verify-link mint failed: " + JSON.stringify(link));
  const v = await agentCtx.newPage();
  attach(v, "verify");
  await v.goto(`${BASE}${link.path}`, { waitUntil: "domcontentloaded" });
  await v.locator('[data-testid="verify-level"]').first().waitFor({ state: "visible", timeout: 30000 });
  const f = await shot(v, "07-verify-level");
  await v.close();
  return [f];
});

// (E) Seafarer propagation consent screen (#38): per-agency toggles, contact vs bank/NOK
//     buckets, plain-language sentence, "certificates always shared" note, onboarding panel,
//     and a pending agent-raised request. Two contexts (seaman + agent). Desktop + mobile.
await run("propagation consent screen (desktop+mobile)", async () => {
  // Seaman context: fresh owned profile + session.
  const seaCtx = await browser.newContext({ viewport: DESKTOP });
  const sea = await seaCtx.newPage();
  attach(sea, "propagation");
  const { shareToken } = await J.createSeaman(sea, "Arjun Demo Seafarer");
  const meRes = await sea.request.get(`${BASE}/api/seafarers?token=${shareToken}`);
  const me = await meRes.json();
  const sfId = me.seafarer.id;

  // Agent forms a grant (opens the seaman's share link) then raises TWO pending requests.
  await J.agentOpenSeamanShare(agent, shareToken);
  for (const bucket of ["contact", "financial"]) {
    await agent.request.post(`${BASE}/api/access/propagation/request`, { data: { seafarerId: sfId, bucket } });
  }

  // Reload the seaman page so flows + onboarding + pending requests render.
  await sea.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await sea.locator('[data-testid="seaman-flows"]').first().waitFor({ state: "visible", timeout: 30000 });
  await sea.locator('[data-testid="seaman-flows"]').first().scrollIntoViewIfNeeded();
  const files = [];
  files.push(await shot(sea, "08-propagation-consent-desktop"));

  // Mobile shot (persona Arjun on an iPhone).
  const mCtx = await browser.newContext({ viewport: MOBILE });
  const mp = await mCtx.newPage();
  attach(mp, "propagation-mobile");
  // Reuse the same seaman session cookies in a mobile context.
  const cookies = await seaCtx.cookies();
  await mCtx.addCookies(cookies);
  await mp.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await mp.locator('[data-testid="seaman-flows"]').first().waitFor({ state: "visible", timeout: 30000 });
  await mp.locator('[data-testid="seaman-flows"]').first().scrollIntoViewIfNeeded();
  files.push(await shot(mp, "08-propagation-consent-mobile"));

  // Report which sub-elements are present.
  const present = {};
  for (const t of ["propagation-onboarding", "flow-propagation-contact", "flow-propagation-financial", "propagation-request"]) {
    present[t] = (await sea.locator(`[data-testid="${t}"]`).count()) > 0;
  }
  console.log("   propagation elements present:", JSON.stringify(present));

  // Mobile CV badge (seafarer-facing) — open the seaman's own CV on the profile page.
  const cvBtn = sea.locator('[data-testid="open-cv"]').first();
  if (await cvBtn.count()) {
    const mcv = await mCtx.newPage();
    attach(mcv, "cv-mobile");
    await mcv.addInitScript(() => {});
    await mcv.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
    // best-effort; seaman CV may need docs — skip silently if not available
  }
  await mCtx.close();
  await seaCtx.close();
  return files;
});

// ---- Mobile CV badge (required seafarer-facing mobile shot) -------------------
await run("cv-level matrix (mobile)", async () => {
  const mCtx = await browser.newContext({ viewport: MOBILE });
  const m = await mCtx.newPage();
  attach(m, "cv-mobile");
  // Sign the agent session into this mobile context to reach the review CV.
  const cookies = await agentCtx.cookies();
  await mCtx.addCookies(cookies);
  await m.goto(`${BASE}/agent/${marek.id}`, { waitUntil: "domcontentloaded" });
  await m.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await m.locator('[data-testid="open-cv"]').first().waitFor({ state: "visible", timeout: 30000 });
  await m.locator('[data-testid="open-cv"]').first().click();
  await m.locator('[data-testid="cv-level"]').first().waitFor({ state: "visible", timeout: 15000 });
  const f = await shot(m, "02-cv-level-matrix-mobile");
  await mCtx.close();
  return [f];
});

// (G) NEW #38.5 agent-side "Request profile access" button on the review page. Shown
//     when the agency has NOT been granted the personal-profile overlay and has no
//     request outstanding — an agent onboarding an unreachable seaman pings them to
//     consent later. Marek is on the dev agent's grant-scoped board with propagation
//     OFF by default, so the button renders. We do NOT click it (that would create a
//     pending request and flip the button to its sent state).
await run("agent request-profile-access button (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${marek.id}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const btn = agent.locator('[data-testid="request-profile-access"]').first();
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.scrollIntoViewIfNeeded();
  return [await shot(agent, "09-agent-request-button")];
});

// (G2) #S17 — the SENT state actually renders after a successful POST. Uses a FRESH
//      seaman (not Marek) so clicking the request button doesn't pollute the seeded
//      board. Proves the button flips to "Requested — awaiting seafarer approval".
await run("agent request-profile-access SENT state (desktop)", async () => {
  const seaCtx = await browser.newContext({ viewport: DESKTOP });
  const sea = await seaCtx.newPage();
  attach(sea, "request-sent");
  const { shareToken } = await J.createSeaman(sea, "Request Sent Seafarer");
  const sfId = (await (await sea.request.get(`${BASE}/api/seafarers?token=${shareToken}`)).json()).seafarer.id;
  await J.agentOpenSeamanShare(agent, shareToken);
  await agent.goto(`${BASE}/agent/${sfId}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const btn = agent.locator('[data-testid="request-profile-access"]').first();
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click();
  const sent = agent.locator('[data-testid="request-profile-access-sent"]').first();
  await sent.waitFor({ state: "visible", timeout: 15000 });
  await sent.scrollIntoViewIfNeeded();
  const f = await shot(agent, "09b-agent-request-sent");
  await seaCtx.close();
  return [f];
});

// (H) NEW #38.5 SESSION-path pending request card. This is the QA gap: a
//     Google/session-signed-in seaman must see agent-raised pending requests, not only
//     the ?token= path. createSeaman() establishes a seaman SESSION and the /seafarer
//     reload resolves via loadMe() (the session path), so this shot proves the card now
//     renders on the session path. Desktop + mobile.
await run("session-path pending request card (desktop+mobile)", async () => {
  const files = [];
  const seaCtx = await browser.newContext({ viewport: DESKTOP });
  const sea = await seaCtx.newPage();
  attach(sea, "session-pending");
  const { shareToken } = await J.createSeaman(sea, "Session Path Seafarer");
  const meRes = await sea.request.get(`${BASE}/api/seafarers?token=${shareToken}`);
  const sfId = (await meRes.json()).seafarer.id;

  // Agent forms a grant (opens the share link) then raises a pending CONTACT request.
  await J.agentOpenSeamanShare(agent, shareToken);
  await agent.request.post(`${BASE}/api/access/propagation/request`, { data: { seafarerId: sfId, bucket: "contact" } });

  // Reload the seaman page — resolves via the SESSION (loadMe), NOT ?token=.
  await sea.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await sea.locator('[data-testid="propagation-request"]').first().waitFor({ state: "visible", timeout: 30000 });
  await sea.locator('[data-testid="propagation-request"]').first().scrollIntoViewIfNeeded();
  const count = await sea.locator('[data-testid="propagation-request"]').count();
  console.log("   session-path propagation-request cards:", count);
  files.push(await shot(sea, "08c-session-pending-request-desktop"));

  // Mobile — reuse the same seaman session cookies.
  const mCtx = await browser.newContext({ viewport: MOBILE });
  await mCtx.addCookies(await seaCtx.cookies());
  const mp = await mCtx.newPage();
  attach(mp, "session-pending-mobile");
  await mp.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await mp.locator('[data-testid="propagation-request"]').first().waitFor({ state: "visible", timeout: 30000 });
  await mp.locator('[data-testid="propagation-request"]').first().scrollIntoViewIfNeeded();
  files.push(await shot(mp, "08c-session-pending-request-mobile"));

  await mCtx.close();
  await seaCtx.close();
  return files;
});

await browser.close();

console.log("\n===== MANIFEST =====");
console.log(JSON.stringify(results, null, 2));
console.log("\n===== CONSOLE ERRORS (" + consoleErrors.length + ") =====");
console.log(JSON.stringify(consoleErrors.slice(0, 40), null, 2));
