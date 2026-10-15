// Batch-2 persona-UX screenshot capture (#41 employment doc-set, #43 appraisals,
// #45 SEA/contract). Drives the LIVE dev server + curated seed. Saves PNGs to
// tests/shots/batch2/. Each surface is wrapped so one failure never aborts the rest.
// Prints a JSON manifest + a console-error report.
//
// Assignments have NO HTTP creation route (startAssignment has no caller), so this
// harness injects a live assignment + verified-identity fields DIRECTLY into
// data/db.json for the fresh demo seamen it creates — the ONLY non-API seam. Every
// appraisal / SEA / grant is formed through the REAL shipped routes. All of it is
// thrown away when the caller restores db.json from the pre-run backup.
//
//   DOCKA_BASE_URL=http://localhost:3000 node tests/batch2-shots.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = J.BASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "batch2");
const DB_PATH = path.join(__dirname, "..", "data", "db.json");
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const INTERVIEW_COMPETENCIES = ["Communication", "Technical knowledge", "Safety awareness", "Teamwork", "English proficiency"];

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
  await page.addStyleTag({ content: ".sticky{position:static !important;}" }).catch(() => {});
  await page.screenshot({ path: p, fullPage: true });
  return p;
}
async function run(label, fn) {
  try {
    const files = await fn();
    results.push({ surface: label, ok: true, files: (files || []).map((f) => path.basename(f)) });
    console.log(`[OK] ${label} -> ${(files || []).map((f) => path.basename(f)).join(", ")}`);
  } catch (e) {
    results.push({ surface: label, ok: false, error: String(e).split("\n")[0].slice(0, 220) });
    console.log(`[FAIL] ${label}: ${String(e).split("\n")[0]}`);
  }
}

// --- db.json injection helpers (the only non-API seam: assignment creation) ---
function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8"); }
function injectAssignment(seafarerId, agentId, vessel) {
  const db = readDb();
  const now = new Date().toISOString();
  const id = "asg-b2-" + Math.random().toString(36).slice(2, 10);
  db.assignments = db.assignments || [];
  db.assignments.push({
    id, seafarerId, agentId, vessel: vessel ?? null,
    sentToSeaAt: now, returnedAt: null, closedReason: null, requiredSnapshot: null, createdAt: now,
  });
  writeDb(db);
  return id;
}
function patchSeafarer(seafarerId, patch) {
  const db = readDb();
  const s = db.seafarers.find((x) => x.id === seafarerId);
  if (s) Object.assign(s, patch);
  writeDb(db);
}
// Non-API seam (same class as injectAssignment): attach the three employment doc-set
// slots (SEA + wage account + allotment) DIRECTLY to db.documents for a seaman, so an
// ASSIGNED man reads employmentCompleteness = complete → the board's positive green
// "employment ✓" cell. The SEA carries a FUTURE seaEndDate so its currency is "current"
// (not expired / unknown). Thrown away with db.json on restore.
function injectEmploymentDocs(seafarerId, seaEndDate) {
  const db = readDb();
  const now = new Date().toISOString();
  db.documents = db.documents || [];
  const mk = (title, requiredType, extra = {}) => ({
    id: "doc-b2-" + Math.random().toString(36).slice(2, 10),
    seafarerId,
    title,
    docType: "Employment",
    docCategory: null,
    estonianCode: null,
    certNumber: null,
    isValid: true,
    validUntil: null,
    expiryConfirmed: true,
    fileName: null,
    createdAt: now,
    source: "manual",
    requiredType,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    registryCountry: null,
    archived: false,
    archivedAt: null,
    ...extra,
  });
  db.documents.push(mk("Seafarer's Employment Agreement (SEA)", "SEA", { seaEndDate }));
  db.documents.push(mk("Wage account confirmation", "Wage Account"));
  db.documents.push(mk("Allotment authorisation", "Allotment"));
  writeDb(db);
}
async function seafarerId(page, token) {
  const r = await page.request.get(`${BASE}/api/seafarers?token=${token}`);
  return (await r.json()).seafarer.id;
}
async function fileInterviewAppraisal(agentPage, sfId, opts = {}) {
  const body = {
    seafarerId: sfId,
    kind: "interview",
    fastPath: true,
    competencySetVersion: "2024.1",
    recommend: opts.recommend ?? "yes",
    rehireReason: opts.recommend === "no" ? (opts.rehireReason ?? "reason") : null,
    comments: opts.comments ?? "Internal agency-private note — must never reach the seaman.",
    overall: opts.overall,
    vessel: opts.vessel ?? null,
    voyageFrom: null,
    voyageTo: null,
    assignmentId: null,
    scores: INTERVIEW_COMPETENCIES.map((c, i) => ({ competency: c, rating: [4, 5, 4, 3, 4][i] })),
    idempotencyKey: crypto.randomUUID(),
  };
  const res = await agentPage.request.post(`${BASE}/api/appraisals`, { data: body });
  return { ok: res.ok(), status: res.status(), json: await res.json().catch(() => ({})) };
}
async function generateSea(agentPage, sfId, assignmentId, terms) {
  const res = await agentPage.request.post(`${BASE}/api/contract/${encodeURIComponent(sfId)}`, {
    data: { assignmentId, kind: "sea", terms },
  });
  return { ok: res.ok(), status: res.status() };
}

const FILLED_TERMS = {
  position: "Chief Officer",
  wageAmount: "4200",
  wageCurrency: "USD",
  wagePeriod: "month",
  leaveDaysPerMonth: "8",
  contractStart: "2026-08-01",
  durationMonths: "6",
  noticeDays: "30",
  allotment: "80% to nominated account",
  repatriationBy: "", // deliberately BLANK -> explicit blank line in the SEA (never fabricated)
};

const browser = await chromium.launch();

// ---- Agent context (dev agent, desktop) --------------------------------------
const agentCtx = await browser.newContext({ viewport: DESKTOP });
const agent = await agentCtx.newPage();
attach(agent, "agent");
await J.loginAsTestAgent(agent);

// =============================================================================
// Build the VERIFIED demo seaman (sf1): dev grant + live assignment + appraisal + SEA
// =============================================================================
const seaCtx1 = await browser.newContext({ viewport: DESKTOP });
const sea1 = await seaCtx1.newPage();
attach(sea1, "seaman-verified");
const { shareToken: tok1 } = await J.createSeaman(sea1, "Arjun Verified Seafarer");
const sf1 = await seafarerId(sea1, tok1);
await J.agentOpenSeamanShare(agent, tok1);
patchSeafarer(sf1, {
  identityVerified: true,
  verifiedName: "ARJUN K. SEAFARER",
  personalCode: "39001010001",
  birthDate: "1990-01-01T00:00:00.000Z",
  issuerCountry: "Eesti",
  vessel: "MV Demo Voyager",
  rank: "Chief Officer",
  // #41 item 15 — SELF-DECLARED CBA cover, so the agent CBA-claimed chip renders.
  cbaCovered: true,
  cbaRef: "ITF TCCC 2026/EE-0417",
});
const asg1 = injectAssignment(sf1, "dev", "MV Demo Voyager");
const ap1 = await fileInterviewAppraisal(agent, sf1, { recommend: "yes", overall: 4, vessel: "MV Demo Voyager" });
console.log("   sf1 appraisal:", JSON.stringify(ap1).slice(0, 160));
const g1 = await generateSea(agent, sf1, asg1, FILLED_TERMS);
console.log("   sf1 SEA generate:", JSON.stringify(g1));

// =============================================================================
// Build the UNVERIFIED demo seaman (sf2): typed name, no gov verification, + SEA
// =============================================================================
const seaCtx2 = await browser.newContext({ viewport: DESKTOP });
const sea2 = await seaCtx2.newPage();
attach(sea2, "seaman-unverified");
const { shareToken: tok2 } = await J.createSeaman(sea2, "Typed Applicant Two");
const sf2 = await seafarerId(sea2, tok2);
await J.agentOpenSeamanShare(agent, tok2);
patchSeafarer(sf2, { vessel: "MV Unverified", rank: "Rating" }); // identityVerified stays falsy
const asg2 = injectAssignment(sf2, "dev", "MV Unverified");
const g2 = await generateSea(agent, sf2, asg2, { ...FILLED_TERMS, position: "Rating" });
console.log("   sf2 SEA generate:", JSON.stringify(g2));

// =============================================================================
// Build the ASSIGNED-AND-COMPLETE demo seaman (sf3): live assignment + all three
// employment slots present (SEA current + wage + allotment) => employmentCompleteness
// COMPLETE => the board's POSITIVE green "employment ✓" cell (Batch-2 evidence #1).
// Kept SEPARATE from sf1 (which stays "assigned, missing SEA") so every existing
// #41 capture — employment column, missing-employment filter, SEA-missing banner —
// still fires on sf1 unchanged.
// =============================================================================
const COMPLETE_NAME = "Priya Complete Seafarer";
const seaCtx3 = await browser.newContext({ viewport: DESKTOP });
const sea3 = await seaCtx3.newPage();
attach(sea3, "seaman-complete");
const { shareToken: tok3 } = await J.createSeaman(sea3, COMPLETE_NAME);
const sf3 = await seafarerId(sea3, tok3);
await J.agentOpenSeamanShare(agent, tok3);
patchSeafarer(sf3, { vessel: "MV Baltic Trader", rank: "Chief Officer" });
const asg3 = injectAssignment(sf3, "dev", "MV Baltic Trader");
injectEmploymentDocs(sf3, "2027-12-31T00:00:00.000Z"); // future SEA end => currency "current"
console.log("   sf3 (complete) built:", sf3, "asg", asg3);

// =============================================================================
// Build the PRIOR-NEGATIVE demo seaman (sfNeg): a filed "Do not re-hire" interview
// appraisal via the REAL /api/appraisals route => the ReviewPanel prior-appraisal
// warning chip fires red next to the Accept button (Batch-2 evidence #3).
// =============================================================================
const NEG_NAME = "Dmitri Flagged Seafarer";
const seaCtxNeg = await browser.newContext({ viewport: DESKTOP });
const seaNeg = await seaCtxNeg.newPage();
attach(seaNeg, "seaman-prior-negative");
const { shareToken: tokNeg } = await J.createSeaman(seaNeg, NEG_NAME);
const sfNeg = await seafarerId(seaNeg, tokNeg);
await J.agentOpenSeamanShare(agent, tokNeg);
patchSeafarer(sfNeg, { vessel: "MV Neva Star", rank: "Second Officer" });
const apNeg = await fileInterviewAppraisal(agent, sfNeg, {
  recommend: "no",
  overall: 2,
  vessel: "MV Neva Star",
  rehireReason: "Repeated unauthorised absence and failed safety drills.",
});
console.log("   sfNeg 'do not re-hire' appraisal:", JSON.stringify(apNeg).slice(0, 160));

// ---- #43 AGENT appraisal panel: FULL card (post-voyage) ----------------------
await run("43 appraisal FULL card — competency rows + overall + 3-value recommend + reason-on-no (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const panel = agent.locator('[data-testid="appraisal-panel"]').first();
  await panel.scrollIntoViewIfNeeded();
  await agent.locator('[data-testid="appraisal-kind-postvoyage"]').first().click(); // fastPath off -> full competency rows
  await agent.locator('[data-testid="appraisal-recommend-no"]').first().click();     // reveal reason-on-"no"
  await agent.locator('[data-testid="appraisal-rehire-reason"]').first().waitFor({ state: "visible", timeout: 8000 });
  await panel.scrollIntoViewIfNeeded();
  return [await shot(agent, "43-appraisal-full-card")];
});

// ---- #43 AGENT appraisal panel: FAST-PATH variant + re-hire summary ----------
await run("43 appraisal FAST-PATH variant + re-hire summary (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const panel = agent.locator('[data-testid="appraisal-panel"]').first();
  await panel.scrollIntoViewIfNeeded();
  // Interview kind = fast path (quick recommend + overall, no competency rows). Summary shows the latest filed appraisal.
  await agent.locator('[data-testid="appraisal-kind-interview"]').first().click();
  await agent.locator('[data-testid="appraisal-rehire-summary"]').first().waitFor({ state: "visible", timeout: 10000 });
  await agent.locator('[data-testid="appraisal-fastpath-submit"]').first().waitFor({ state: "visible", timeout: 8000 });
  return [await shot(agent, "43-appraisal-fastpath-and-rehire-summary")];
});

// ---- #45 AGENT GenerateContractPanel form ------------------------------------
await run("45 GenerateContractPanel form — ContractTerms inputs (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await agent.locator('[data-testid="generate-contract-open"]').first().scrollIntoViewIfNeeded();
  await agent.locator('[data-testid="generate-contract-open"]').first().click();
  await agent.locator('[data-testid="contract-term-wage"]').first().waitFor({ state: "visible", timeout: 8000 });
  await agent.locator('[data-testid="contract-term-wage"]').first().scrollIntoViewIfNeeded();
  return [await shot(agent, "45-generate-contract-form")];
});

// ---- #45 generated SEA (verified): DRAFT watermark + unsigned + provenance + filled + BLANK ----
await run("45 generated SEA (verified) — DRAFT watermark + unsigned blocks + provenance + filled terms + blank (desktop+mobile)", async () => {
  const files = [];
  const url1 = `${BASE}/api/contract/${sf1}?token=${tok1}&assignmentId=${asg1}`;
  const d = await agentCtx.newPage();
  attach(d, "sea-verified");
  await d.goto(url1, { waitUntil: "domcontentloaded" });
  await d.locator("text=DRAFT").first().waitFor({ timeout: 15000 });
  files.push(await shot(d, "45-sea-verified-desktop"));
  await d.close();
  const mCtx = await browser.newContext({ viewport: MOBILE });
  const m = await mCtx.newPage();
  attach(m, "sea-verified-mobile");
  await m.goto(url1, { waitUntil: "domcontentloaded" });
  await m.locator("text=DRAFT").first().waitFor({ timeout: 15000 });
  files.push(await shot(m, "45-sea-verified-mobile"));
  await mCtx.close();
  return files;
});

// ---- #45 generated SEA (unverified): red banner + bracketed values -----------
await run("45 generated SEA (unverified) — red IDENTITY-NOT-VERIFIED banner + bracketed value (desktop)", async () => {
  const url2 = `${BASE}/api/contract/${sf2}?token=${tok2}&assignmentId=${asg2}`;
  const d = await agentCtx.newPage();
  attach(d, "sea-unverified");
  await d.goto(url2, { waitUntil: "domcontentloaded" });
  await d.locator("text=NOT GOVERNMENT-VERIFIED").first().waitFor({ timeout: 15000 });
  const f = await shot(d, "45-sea-unverified-desktop");
  await d.close();
  return [f];
});

// ---- #41 SEAMAN employment checklist ("you still owe") + Download-my-SEA ------
await run("41 seaman employment checklist — you-still-owe + Download-my-SEA (desktop+mobile)", async () => {
  const files = [];
  await sea1.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  const cl = sea1.locator('[data-testid="seaman-employment-checklist"]').first();
  await cl.waitFor({ state: "visible", timeout: 30000 });
  await cl.scrollIntoViewIfNeeded();
  console.log("   download-my-SEA present:", await sea1.locator('[data-testid="seaman-download-sea"]').count());
  files.push(await shot(sea1, "41-seaman-employment-checklist-desktop"));
  // Mobile (Arjun on iPhone) — reuse the seaman session cookies.
  const mCtx = await browser.newContext({ viewport: MOBILE });
  await mCtx.addCookies(await seaCtx1.cookies());
  const mp = await mCtx.newPage();
  attach(mp, "seaman-employment-mobile");
  await mp.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await mp.locator('[data-testid="seaman-employment-checklist"]').first().waitFor({ state: "visible", timeout: 30000 });
  await mp.locator('[data-testid="seaman-employment-checklist"]').first().scrollIntoViewIfNeeded();
  files.push(await shot(mp, "41-seaman-employment-checklist-mobile"));
  await mCtx.close();
  return files;
});

// ---- #43 SEAMAN own appraisal view (ratings + recommend, NO internal notes) ---
await run("43 seaman own appraisal view — ratings + recommend, internal notes hidden (desktop+mobile)", async () => {
  const files = [];
  await sea1.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  const ap = sea1.locator('[data-testid="seaman-appraisals"]').first();
  await ap.waitFor({ state: "visible", timeout: 30000 });
  await ap.scrollIntoViewIfNeeded();
  files.push(await shot(sea1, "43-seaman-appraisals-desktop"));
  const mCtx = await browser.newContext({ viewport: MOBILE });
  await mCtx.addCookies(await seaCtx1.cookies());
  const mp = await mCtx.newPage();
  attach(mp, "seaman-appraisals-mobile");
  await mp.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await mp.locator('[data-testid="seaman-appraisals"]').first().waitFor({ state: "visible", timeout: 30000 });
  await mp.locator('[data-testid="seaman-appraisals"]').first().scrollIntoViewIfNeeded();
  files.push(await shot(mp, "43-seaman-appraisals-mobile"));
  await mCtx.close();
  return files;
});

// ---- #45 SEAMAN own-SEA download view (same verified SEA, seaman-facing) ------
await run("45 seaman own-SEA download view (desktop+mobile)", async () => {
  const files = [];
  const url1 = `${BASE}/api/contract/${sf1}?token=${tok1}&assignmentId=${asg1}`;
  // Desktop already captured as 45-sea-verified-desktop; re-capture explicitly as the seaman-facing view name.
  const d = await seaCtx1.newPage();
  attach(d, "seaman-own-sea");
  await d.goto(url1, { waitUntil: "domcontentloaded" });
  await d.locator("text=DRAFT").first().waitFor({ timeout: 15000 });
  files.push(await shot(d, "45-seaman-own-sea-desktop"));
  await d.close();
  const mCtx = await browser.newContext({ viewport: MOBILE });
  await mCtx.addCookies(await seaCtx1.cookies());
  const mp = await mCtx.newPage();
  attach(mp, "seaman-own-sea-mobile");
  await mp.goto(url1, { waitUntil: "domcontentloaded" });
  await mp.locator("text=DRAFT").first().waitFor({ timeout: 15000 });
  files.push(await shot(mp, "45-seaman-own-sea-mobile"));
  await mCtx.close();
  return files;
});

// ---- #41 AGENT BOARD — employment-completeness column (sf1 assigned, missing SEA) ----
await run("41 agent board — per-seaman employment doc-set column (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const cell = agent.locator('[data-testid="roster-employment-completeness"]').first();
  await cell.waitFor({ state: "visible", timeout: 10000 });
  await cell.scrollIntoViewIfNeeded();
  console.log("   employment cells on board:", await agent.locator('[data-testid="roster-employment-completeness"]').count());
  return [await shot(agent, "41-board-employment-column")];
});

// ---- #41 AGENT BOARD — "Missing employment docs" filter applied -------------
await run("41 agent board — missing-employment filter applied (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  await agent.locator('[data-testid="filter-missing-employment"]').first().click();
  await agent.locator('[data-testid="filter-note"]').first().waitFor({ state: "visible", timeout: 8000 });
  return [await shot(agent, "41-board-missing-filter")];
});

// ---- #41 REVIEWPANEL — prominent SEA-missing banner (sf1 assigned, no SEA) ---
await run("41 review panel — prominent SEA-missing banner (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const banner = agent.locator('[data-testid="sea-missing-banner"]').first();
  await banner.waitFor({ state: "visible", timeout: 10000 });
  await banner.scrollIntoViewIfNeeded();
  console.log("   sea-banner state:", await banner.getAttribute("data-sea-state"));
  return [await shot(agent, "41-sea-missing-banner")];
});

// ---- #41 REVIEWPANEL — CBA "claimed (self-declared)" chip -------------------
await run("41 review panel — CBA claimed (self-declared) chip (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const chip = agent.locator('[data-testid="cba-claimed-chip"]').first();
  await chip.waitFor({ state: "visible", timeout: 10000 });
  await chip.scrollIntoViewIfNeeded();
  console.log("   cba chip text:", (await chip.innerText()).replace(/\s+/g, " ").trim());
  return [await shot(agent, "41-cba-claimed-chip")];
});

// ---- CONTEXT shots: agent board filter row (documents which #41 board surfaces exist) ----
await run("context — agent board filter row (documents missing #41 employment column/filter)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  return [await shot(agent, "context-agent-board-filters")];
});

// ---- #41 EVIDENCE 1 — assigned-AND-complete: POSITIVE green "employment ✓" cell ----
await run("41 board — assigned+complete employment doc-set: positive green employment ✓ (desktop)", async () => {
  await agent.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const card = agent.locator(`[data-testid="seafarer-card"][data-name="${COMPLETE_NAME}"]`).first();
  await card.waitFor({ state: "visible", timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  const cell = card.locator('[data-testid="roster-employment-completeness"][data-employment-applicable="true"]').first();
  await cell.waitFor({ state: "visible", timeout: 10000 });
  const count = await cell.getAttribute("data-employment-count");
  const total = await cell.getAttribute("data-employment-total");
  const text = (await cell.innerText()).replace(/\s+/g, " ").trim();
  console.log(`   sf3 employment cell: ${count}/${total} — "${text}"`);
  if (count !== total || !text.includes("✓")) {
    throw new Error(`expected complete green cell with ✓, got ${count}/${total} "${text}"`);
  }
  return [await shot(agent, "41-board-employment-complete")];
});

// ---- #43 EVIDENCE 2 — fast-path (quick) appraisal, "Do not re-hire" reveals Reason ----
await run("43 appraisal FAST-PATH 'Do not re-hire' — client-revealed required Reason field (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sf1}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const panel = agent.locator('[data-testid="appraisal-panel"]').first();
  await panel.scrollIntoViewIfNeeded();
  // Interview kind = the FAST PATH (quick recommend + overall, no competency rows).
  await agent.locator('[data-testid="appraisal-kind-interview"]').first().click();
  await agent.locator('[data-testid="appraisal-fastpath-label"]').first().waitFor({ state: "visible", timeout: 8000 });
  // Select "Do not re-hire" — client reveals the required Reason field.
  await agent.locator('[data-testid="appraisal-recommend-no"]').first().click();
  const reason = agent.locator('[data-testid="appraisal-rehire-reason"]').first();
  await reason.waitFor({ state: "visible", timeout: 8000 });
  await reason.scrollIntoViewIfNeeded();
  console.log("   fast-path submit visible:", await agent.locator('[data-testid="appraisal-fastpath-submit"]').first().isVisible());
  return [await shot(agent, "43-fastpath-do-not-rehire-reason")];
});

// ---- #43 EVIDENCE 3 — ReviewPanel prior-negative chip next to the Accept button ----
await run("43 review panel — red 'Prior: ⚠ Do not re-hire' chip next to Accept (desktop)", async () => {
  await agent.goto(`${BASE}/agent/${sfNeg}`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="review-panel"][data-hydrated="true"]').first().waitFor({ timeout: 30000 });
  const chip = agent.locator('[data-testid="prior-appraisal-warning"]').first();
  await chip.waitFor({ state: "visible", timeout: 15000 });
  await chip.scrollIntoViewIfNeeded();
  // Bring the Accept button into the same viewport so the chip reads "next to Accept".
  await agent.locator('[data-testid="accept-seafarer"]').first().scrollIntoViewIfNeeded();
  await chip.scrollIntoViewIfNeeded();
  const recommend = await chip.getAttribute("data-recommend");
  const chipText = (await chip.innerText()).replace(/\s+/g, " ").trim();
  console.log(`   prior chip recommend=${recommend} text="${chipText}"`);
  if (recommend !== "no") throw new Error(`expected prior chip data-recommend="no", got "${recommend}"`);
  return [await shot(agent, "43-prior-negative-chip")];
});

await browser.close();

console.log("\n===== MANIFEST =====");
console.log(JSON.stringify(results, null, 2));
console.log("\n===== CONSOLE ERRORS (" + consoleErrors.length + ") =====");
console.log(JSON.stringify(consoleErrors.slice(0, 60), null, 2));
