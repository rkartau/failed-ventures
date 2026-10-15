// Persona UX review of the assignment/voyage-lifecycle fix (DEF-1/DEF-6).
// Creates locked fixtures, captures the real screens each persona sees.
// Screens -> app/tests/shots/demo/persona-fix/. Reuses journeys.mjs helpers.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const OUT = path.join(__dirname, "shots", "demo", "persona-fix");
const BASE = J.BASE_URL;
const DEV = "dev";
fs.mkdirSync(OUT, { recursive: true });

const BASE_TYPES = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];
function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
function liveAssignments(db, sid) { return db.assignments.filter((a) => a.seafarerId === sid && a.agentId === DEV && a.returnedAt === null); }
function seedSeaReady(sid, { verified = false, rank = "Chief Officer", vessel = null } = {}) {
  const db = readDb();
  const s = db.seafarers.find((x) => x.id === sid);
  s.rank = rank; s.vesselType = null; s.flagState = null; s.rotationEnd = null;
  if (vessel) s.vessel = vessel;
  if (verified) { s.identityVerified = true; s.verifiedName = s.name; }
  const now = new Date().toISOString();
  for (const t of BASE_TYPES) {
    db.documents.push({ id: crypto.randomUUID(), seafarerId: sid, title: t, docType: t, docCategory: null,
      requiredType: t, certNumber: `ZZFIX-${crypto.randomBytes(5).toString("hex")}`, estonianCode: null,
      validUntil: "2032-01-01T00:00:00.000Z", isValid: true, expiryConfirmed: true, reviewStatus: "approved",
      reviewedBy: DEV, reviewedAt: now, fileName: null, source: "manual", registryCountry: null,
      verifiedKeyTrust: null, archived: false, archivedAt: null, rotation: 0, seaEndDate: null, createdAt: now });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
async function seaId(page, token) { const j = await (await page.request.get(`${BASE}/api/seafarers?token=${token}`)).json(); return j.seafarer.id; }
async function waitUntil(fn, ms = 20000) { const t0 = Date.now(); for (;;) { let v; try { v = fn(); } catch { v = false; } if (v) return true; if (Date.now()-t0>ms) return false; await new Promise(r=>setTimeout(r,150)); } }
async function shot(page, name) { const p = path.join(OUT, `${name}.png`); await page.screenshot({ path: p, fullPage: true }); console.log("shot", p); return p; }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1200 } });
  const page = await context.newPage();
  const tag = Date.now();
  try {
    await J.loginAsTestAgent(page);

    // ---- Subject V: verified, sea-ready -> locked at sea ----
    const vName = `ZZFIX-V ${tag}`;
    const v = await J.createSeaman(page, vName);
    const vId = await seaId(page, v.shareToken);
    await J.agentOpenSeamanShare(page, v.shareToken);
    seedSeaReady(vId, { verified: true, vessel: "MV Baltic Trader" });
    await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30000 });
    await J.moveSeaman(page, vName, "sent_to_sea");
    await waitUntil(() => liveAssignments(readDb(), vId).length === 1);
    const vAssignmentId = liveAssignments(readDb(), vId)[0].id;
    console.log("V assignmentId:", vAssignmentId);

    // LENS 1 (Mart): seaman AccessReviews with a LOCKED grant.
    await page.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="access-reviews"]').first().waitFor({ state: "visible", timeout: 30000 });
    await page.locator('[data-testid="access-row"][data-agent="dev"]').first().waitFor({ state: "visible", timeout: 30000 });
    // scroll the access section into view for a focused crop too
    await page.locator('[data-testid="access-reviews"]').first().scrollIntoViewIfNeeded();
    await shot(page, "lens1-seaman-access-locked-full");
    // element-only shot of the access section
    const acc = page.locator('[data-testid="access-reviews"]').first();
    await acc.screenshot({ path: path.join(OUT, "lens1-seaman-access-locked-section.png") });
    const rowTxt = await page.locator('[data-testid="access-row"][data-agent="dev"]').first().innerText();
    console.log("---LENS1 access row text---\n" + rowTxt + "\n---");

    // LENS 2 (Priya): agent review panel, Generate SEA open, pre-filled assignment id.
    await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30000 });
    await J.reviewSeaman(page, vName);
    await page.locator('[data-testid="generate-contract-open"]').first().scrollIntoViewIfNeeded();
    await page.locator('[data-testid="generate-contract-open"]').first().click();
    const idInput = page.locator('[data-testid="contract-assignment-id"]').first();
    await idInput.waitFor({ state: "visible", timeout: 15000 });
    await idInput.scrollIntoViewIfNeeded();
    const prefilled = await idInput.inputValue();
    console.log("Generate-SEA assignment-id prefilled value:", JSON.stringify(prefilled), "== live?", prefilled === vAssignmentId);
    await shot(page, "lens2-priya-generate-sea-prefilled");
    // element shot of the panel
    const panel = page.locator('[data-testid="contract-assignment-id"]').first().locator("xpath=ancestor::section[1]");
    await panel.screenshot({ path: path.join(OUT, "lens2-priya-generate-sea-panel.png") }).catch(()=>{});

    // Verified SEA HTML
    const vContract = await page.request.post(`${BASE}/api/contract/${vId}`, { data: { assignmentId: vAssignmentId, kind: "sea", terms: { position: "Chief Officer", wageAmount: "4200", wageCurrency: "USD" } } });
    const vHtml = await vContract.text();
    const vp = await context.newPage();
    await vp.setContent(vHtml, { waitUntil: "domcontentloaded" });
    await vp.screenshot({ path: path.join(OUT, "lens2-priya-SEA-verified.png"), fullPage: true });
    console.log("verified SEA has verified-strip:", /contract-verified-strip/.test(vHtml), "unverified-banner:", /contract-unverified-banner/.test(vHtml));
    await vp.close();

    // ---- Subject U: unverified, override to sea ----
    const uName = `ZZFIX-U ${tag}`;
    const u = await J.createSeaman(page, uName);
    const uId = await seaId(page, u.shareToken);
    await J.agentOpenSeamanShare(page, u.shareToken);
    await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30000 });
    await J.moveSeamanExpectBlock(page, uName, "accepted");
    await J.overrideAssignment(page, "ZZFIX override to accepted — endorsement confirmed by phone.");
    await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30000 });
    await J.moveSeamanExpectBlock(page, uName, "sent_to_sea");
    await J.overrideAssignment(page, "ZZFIX override to sea — master accepts risk, ref ZZ-2.");
    await waitUntil(() => liveAssignments(readDb(), uId).length === 1);
    const uAssignmentId = liveAssignments(readDb(), uId)[0].id;
    const uContract = await page.request.post(`${BASE}/api/contract/${uId}`, { data: { assignmentId: uAssignmentId, kind: "sea", terms: { position: "Deckhand" } } });
    const uHtml = await uContract.text();
    const up = await context.newPage();
    await up.setContent(uHtml, { waitUntil: "domcontentloaded" });
    await up.screenshot({ path: path.join(OUT, "lens2-priya-SEA-unverified.png"), fullPage: true });
    console.log("unverified SEA has unverified-banner:", /contract-unverified-banner/.test(uHtml), "DRAFT watermark:", /DRAFT/.test(uHtml));
    await up.close();

    // LENS 3 (Nikos): show the agent board with the locked/at-sea card state.
    await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30000 });
    const vCard = page.locator(`[data-testid="seafarer-card"][data-name="${vName}"]`).first();
    await vCard.scrollIntoViewIfNeeded();
    await shot(page, "lens3-nikos-board-at-sea");
    const vCardTxt = await vCard.innerText().catch(()=>"(card text n/a)");
    console.log("---LENS3 V card text---\n" + vCardTxt + "\n---");

    console.log("\nSUBJECTS: V(verified,locked)=", vId, " U(unverified,override,locked)=", uId);
    console.log("DONE");
  } catch (e) {
    console.error("FAILED", e);
    try { await shot(page, `99-fail-${Date.now()}`); } catch {}
  } finally {
    await browser.close();
  }
}
main();
