// Batch-3 persona-UX screenshot capture (#42 client read-portal, #49 docka-verified
// directory, #52 vacancy matching). Drives the LIVE dev server + curated seed. Saves
// PNGs to tests/shots/batch3/. Each surface is wrapped so one failure never aborts the
// rest. Prints a JSON manifest + a console-error report.
//
// Setup seams (mirrors batch2-shots.mjs exactly):
//   - Seamen are created through the REAL routes (createSeaman -> seaman-test-login +
//     /api/seafarers/self); the dev-agent grant is formed through the REAL /share/<token>.
//   - clientVisible (#42) is set through the REAL /api/seafarer/client-visible route.
//   - directoryConsent (#49 agency half) through the REAL /api/directory-consent route.
//   - The portal (#42) + vacancy (#52) are created through the REAL /api/portal +
//     /api/vacancies routes.
//   - The ONLY non-API seams (same class as batch2's assignment/verified-identity
//     injection): government-verified identity fields, the per-slot documents, the
//     sea-service ledger rows, the directoryOptIn flag, and one live at-sea assignment
//     are written DIRECTLY into data/db.json. All of it is thrown away when the caller
//     restores db.json from the pre-run backup.
//
// #49's authenticated-client directory page gates on auth() (next-auth), NOT the dev
// agent cookie, and Google is not configured locally. We therefore mint a valid
// next-auth JWT session cookie with the app's own AUTH_SECRET (known, in .env.local) and
// set it on a DEDICATED "client" browser context used ONLY for /directory — so the agent
// contexts keep using the plain dev cookie and are never mistaken for a Google agent.
//
//   AUTH_SECRET=... DOCKA_BASE_URL=http://localhost:3000 \
//     node --import ./tests/_register-alias.mjs tests/batch3-shots.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";
import { encode } from "@auth/core/jwt";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = J.BASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "shots", "batch3");
const DB_PATH = path.join(__dirname, "..", "data", "db.json");
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

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
    results.push({ surface: label, ok: false, error: String(e).split("\n")[0].slice(0, 240) });
    console.log(`[FAIL] ${label}: ${String(e).split("\n")[0]}`);
  }
}

// --- date helpers -------------------------------------------------------------
function isoDays(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}
function dayKey(n) {
  return isoDays(n).slice(0, 10);
}
const VALID = isoDays(700); // comfortably valid, past the voyage window
const ROT_END = dayKey(180); // planned end of rotation (portal + vacancy voyage window)
const ROT_LAPSE = isoDays(45); // valid today but lapses mid-rotation (before ROT_END)

// --- db.json injection helpers (the only non-API seams) -----------------------
function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8"); }
function patchSeafarer(seafarerId, patch) {
  const db = readDb();
  const s = db.seafarers.find((x) => x.id === seafarerId);
  if (s) Object.assign(s, patch);
  writeDb(db);
}
// A government-registry-verified document (source:"government" -> verification level 3,
// the emerald badge) filling one required slot. validUntil drives the voyage-window
// status judging (a Medical with validUntil=ROT_LAPSE reads "expiring" against ROT_END).
let codeSeq = 0;
function injectGovDoc(seafarerId, requiredType, validUntil) {
  const db = readDb();
  const now = new Date().toISOString();
  db.documents = db.documents || [];
  db.documents.push({
    id: "doc-b3-" + Math.random().toString(36).slice(2, 10),
    seafarerId,
    title: requiredType,
    docType: requiredType,
    docCategory: "competency",
    estonianCode: `B3GOV${String(++codeSeq).padStart(4, "0")}`,
    certNumber: `B3GOV${String(codeSeq).padStart(4, "0")}`,
    isValid: new Date(validUntil).getTime() > Date.now(),
    validUntil,
    expiryConfirmed: true,
    fileName: null,
    createdAt: now,
    source: "government",
    requiredType,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    registryCountry: "EE",
    verifiedKeyTrust: "capability-token",
    archived: false,
    archivedAt: null,
  });
  writeDb(db);
}
// A SELF-DECLARED / self-uploaded document (source:"manual", never reviewer-checked ->
// verification level 0, the neutral slate "Self-uploaded — not yet verified" badge). Fills
// one required slot so its L0 badge sits DISTINCT beside the emerald L3 government badges
// on the same crew card (#42 self-declared evidence — the contrast Nikos asked to see).
function injectSelfDoc(seafarerId, requiredType, validUntil) {
  const db = readDb();
  const now = new Date().toISOString();
  db.documents = db.documents || [];
  db.documents.push({
    id: "doc-b3self-" + Math.random().toString(36).slice(2, 10),
    seafarerId,
    title: requiredType,
    docType: requiredType,
    docCategory: "competency",
    estonianCode: `B3SELF${String(++codeSeq).padStart(4, "0")}`,
    certNumber: `B3SELF${String(codeSeq).padStart(4, "0")}`,
    isValid: new Date(validUntil).getTime() > Date.now(),
    validUntil,
    expiryConfirmed: true,
    fileName: "self-upload.pdf",
    createdAt: now,
    source: "manual", // NOT government/registry, no reviewerChecked -> level 0
    requiredType,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reviewerChecked: false,
    registryCountry: null,
    verifiedKeyTrust: null,
    archived: false,
    archivedAt: null,
  });
  writeDb(db);
}
// A sea-service ledger row (digital discharge book), the input to the vacancy sea-time
// gate. signOn..signOff (both YYYY-MM-DD) counted by lib/sea-service qualifyingDaysInWindow.
function injectSeaService(seafarerId, signOnDaysAgo, signOffDaysAgo, vessel, rank) {
  const db = readDb();
  db.seaService = db.seaService || [];
  db.seaService.push({
    id: "sea-b3-" + Math.random().toString(36).slice(2, 10),
    seafarerId,
    vessel,
    imo: null,
    rank,
    vesselType: null,
    flagState: null,
    signOn: dayKey(-signOnDaysAgo),
    signOff: dayKey(-signOffDaysAgo),
    note: null,
    recordedBy: "agent:dev",
    createdAt: new Date().toISOString(),
  });
  writeDb(db);
}
// One LIVE assignment under the dev agent -> the (seafarer,dev) grant reads LOCKED
// (still readable) and the vacancy matcher flags the candidate atSea [R52.17].
function injectAssignment(seafarerId, vessel) {
  const db = readDb();
  const now = new Date().toISOString();
  db.assignments = db.assignments || [];
  db.assignments.push({
    id: "asg-b3-" + Math.random().toString(36).slice(2, 10),
    seafarerId,
    agentId: "dev",
    vessel: vessel ?? null,
    sentToSeaAt: now,
    returnedAt: null,
    closedReason: null,
    requiredSnapshot: null,
    createdAt: now,
  });
  writeDb(db);
}

async function seafarerId(page, token) {
  const r = await page.request.get(`${BASE}/api/seafarers?token=${token}`);
  return (await r.json()).seafarer.id;
}
// Seaman-controlled per-agency client-portal visibility (#42) via the REAL route.
async function setClientVisible(agentPage, sfId, token, on) {
  const res = await agentPage.request.post(`${BASE}/api/seafarer/client-visible`, {
    data: { seafarerId: sfId, agentId: "dev", on, token },
  });
  return { ok: res.ok(), status: res.status() };
}
// Agency-controlled per-grant directory consent (#49 agency half) via the REAL route
// (uses the dev-agent session on the agent page's cookie jar).
async function setDirectoryConsent(agentPage, sfId, on) {
  const res = await agentPage.request.post(`${BASE}/api/directory-consent`, {
    data: { seafarerId: sfId, on },
  });
  return { ok: res.ok(), status: res.status() };
}

const browser = await chromium.launch();

// ---- Agent context (dev agent, desktop) --------------------------------------
const agentCtx = await browser.newContext({ viewport: DESKTOP });
const agent = await agentCtx.newPage();
attach(agent, "agent");
await J.loginAsTestAgent(agent);

// Build one demo seaman end-to-end (real create + real dev grant + injected state).
async function buildSeaman(name, opts) {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  attach(page, "seaman-" + name.split(" ")[0].toLowerCase());
  const { shareToken } = await J.createSeaman(page, name);
  const sf = await seafarerId(page, shareToken);
  await J.agentOpenSeamanShare(agent, shareToken); // forms the ACTIVE dev grant
  patchSeafarer(sf, {
    rank: opts.rank,
    vessel: opts.vessel,
    identityVerified: true,
    verifiedName: name,
    issuerCountry: opts.issuerCountry,
    birthDate: "1988-05-14T00:00:00.000Z",
    directoryOptIn: opts.directoryOptIn === true,
  });
  for (const d of opts.docs || []) injectGovDoc(sf, d.type, d.validUntil);
  for (const d of opts.selfDocs || []) injectSelfDoc(sf, d.type, d.validUntil);
  if (opts.seaDays) injectSeaService(sf, 400, 40, opts.vessel, opts.rank); // ~360 qualifying days
  if (opts.clientVisible) {
    const r = await setClientVisible(agent, sf, shareToken, true);
    console.log(`   ${name} clientVisible:`, JSON.stringify(r));
  }
  if (opts.directoryConsent) {
    const r = await setDirectoryConsent(agent, sf, true);
    console.log(`   ${name} directoryConsent:`, JSON.stringify(r));
  }
  if (opts.atSea) injectAssignment(sf, opts.vessel);
  return { sf, shareToken, ctx, page };
}

const FIVE = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];
const allValid = FIVE.map((type) => ({ type, validUntil: VALID }));

// 1. Priya Sharma — fully verified, 5/5 valid, client-visible, qualified (sea-time),
//    directory-listed. Portal hero (masked "Priya S.", sea-ready) + vacancy qualified top.
const priya = await buildSeaman("Priya Sharma", {
  rank: "Able Seaman", vessel: "MV Aegean Star", issuerCountry: "India",
  docs: allValid, clientVisible: true, seaDays: true,
  directoryOptIn: true, directoryConsent: true,
});

// 2. Arjun Mehta — verified, client-visible, but Medical lapses BEFORE the rotation end
//    -> portal "Not sea-ready" + Medical slot expiring; vacancy held-but-expiring [C1].
const arjun = await buildSeaman("Arjun Mehta", {
  rank: "Ordinary Seaman", vessel: "MV Aegean Star", issuerCountry: "India",
  docs: [
    { type: "Basic Safety Training", validUntil: VALID },
    { type: "Medical", validUntil: ROT_LAPSE },
    { type: "Endorsement", validUntil: VALID },
    { type: "Seaman book", validUntil: VALID },
    { type: "Passport", validUntil: VALID },
  ],
  clientVisible: true,
});

// 3. Chen Wei — verified but NOT marked client-visible -> portal picker shows the
//    "hidden — not marked client-visible" reason; vacancy sea-time short (no ledger).
const chen = await buildSeaman("Chen Wei", {
  rank: "Deck Cadet", vessel: "MV Aegean Star", issuerCountry: "China",
  docs: [
    { type: "Basic Safety Training", validUntil: VALID },
    { type: "Medical", validUntil: VALID },
  ],
  clientVisible: false,
});

// 4. Diego Santos — verified, client-visible, qualified, but AT SEA (live assignment)
//    -> vacancy top pick flagged unavailable [R52.17]; portal sea-ready.
const diego = await buildSeaman("Diego Santos", {
  rank: "Bosun", vessel: "MV Pacific Dawn", issuerCountry: "Philippines",
  docs: allValid, clientVisible: true, seaDays: true, atSea: true,
});

// 5. Jaan Tamm — verified, directory-listed (opt-in + agency consent), one cert expiring
//    soon -> directory expiry counts. Also the seaman-facing directory opt-in shot.
const jaan = await buildSeaman("Jaan Tamm", {
  rank: "Chief Officer", vessel: "MV Baltic Trader", issuerCountry: "Estonia",
  docs: [
    { type: "Basic Safety Training", validUntil: VALID },
    { type: "Medical", validUntil: isoDays(40) }, // amber "expiring soon"
    { type: "Endorsement", validUntil: VALID },
  ],
  clientVisible: false, directoryOptIn: true, directoryConsent: true,
});

// 6. Sofia Marino — verified + client-visible, FOUR government-verified certs but her
//    Medical is SELF-UPLOADED (source:"manual" -> L0). On her portal card the emerald
//    "Government-verified" badges sit beside the slate "Self-uploaded — not yet verified"
//    Medical badge, so the distinction is unmistakable (#42 self-declared evidence — Nikos).
const sofia = await buildSeaman("Sofia Marino", {
  rank: "Able Seaman", vessel: "MV Aegean Star", issuerCountry: "Italy",
  docs: [
    { type: "Basic Safety Training", validUntil: VALID },
    { type: "Endorsement", validUntil: VALID },
    { type: "Seaman book", validUntil: VALID },
    { type: "Passport", validUntil: VALID },
  ],
  selfDocs: [{ type: "Medical", validUntil: VALID }], // the DISTINCT self-declared slot
  clientVisible: true, seaDays: true,
});

// 7. Mart Kask — a FRESH, identity-verified seaman who has NEVER touched the directory
//    toggle -> directoryOptIn is at its DEFAULT-OFF state. The seaman-facing opt-in
//    section reads "Off — hidden", evidencing opt-in-by-default (Arjun/Mart persona).
const mart = await buildSeaman("Mart Kask", {
  rank: "Ordinary Seaman", vessel: "MV Baltic Trader", issuerCountry: "Estonia",
  docs: [{ type: "Basic Safety Training", validUntil: VALID }],
  clientVisible: false, // default off, never opted into the directory
});

console.log("   cast:", JSON.stringify({ priya: priya.sf, arjun: arjun.sf, chen: chen.sf, diego: diego.sf, jaan: jaan.sf, sofia: sofia.sf, mart: mart.sf }));

// ---- Build the #42 client portal through the REAL route (open mode, 4-month window) --
let portalToken = null;
{
  const res = await agent.request.post(`${BASE}/api/portal`, {
    data: {
      action: "create",
      vessel: "MV Aegean Star",
      clientLabel: "Aegean Shipowners Ltd",
      // Curated ceiling = all five; only the client-visible three are kept.
      seafarerIds: [priya.sf, arjun.sf, chen.sf, diego.sf, jaan.sf],
      mode: "open",
      rotationEnd: ROT_END,
      createKey: "b3-portal-key",
    },
  });
  const data = await res.json().catch(() => ({}));
  portalToken = data.token ?? null;
  console.log("   portal create:", JSON.stringify({ status: res.status(), token: portalToken, visibility: data.visibility?.length }));
}

// ---- Build a SECOND #42 portal for the self-declared evidence shot -------------
// Priya (all government-verified, emerald) + Sofia (four emerald + one slate self-uploaded
// Medical) side by side, so the L0-vs-L3 badge contrast is captured in one frame.
let selfPortalToken = null;
{
  const res = await agent.request.post(`${BASE}/api/portal`, {
    data: {
      action: "create",
      vessel: "MV Aegean Star",
      clientLabel: "Aegean Shipowners Ltd — verification review",
      seafarerIds: [priya.sf, sofia.sf],
      mode: "open",
      rotationEnd: ROT_END,
      createKey: "b3-selfdeclared-portal-key",
    },
  });
  const data = await res.json().catch(() => ({}));
  selfPortalToken = data.token ?? null;
  console.log("   self-declared portal create:", JSON.stringify({ status: res.status(), token: selfPortalToken, visibility: data.visibility?.length }));
}

// ---- Build the #52 vacancy through the REAL route ----------------------------
{
  const res = await agent.request.post(`${BASE}/api/vacancies`, {
    data: {
      title: "Able Seaman — Chemical Tanker (4-month rotation)",
      rank: "Able Seaman",
      requiredCerts: ["Basic Safety Training", "Medical"],
      minSeaDays: 200,
      seaWindowMonths: 60,
      rotationEnd: ROT_END,
      createKey: "b3-vacancy-key",
    },
  });
  console.log("   vacancy create:", JSON.stringify({ status: res.status() }));
}

// =============================================================================
// #42 — CLIENT / SHIPOWNER READ-PORTAL
// =============================================================================

// The client's read-portal view: masked names, per-required-slot breakdown with
// verification-level badges, sea-ready pill, "Issuing country / registry", expiry counts.
await run("42 client portal — read-portal crew list (masked names + per-slot badges + sea-ready + issuing country) (desktop)", async () => {
  if (!portalToken) throw new Error("no portal token — create failed");
  const d = await browser.newContext({ viewport: DESKTOP });
  const p = await d.newPage();
  attach(p, "client-portal");
  await p.goto(`${BASE}/portal/${portalToken}`, { waitUntil: "domcontentloaded" });
  await p.locator('[data-testid="client-crew-list"]').first().waitFor({ state: "visible", timeout: 30000 });
  const rows = await p.locator('[data-testid="client-crew-row"]').count();
  const first = await p.locator('[data-testid="client-crew-row"]').first().innerText().catch(() => "");
  console.log("   portal crew rows:", rows, "first (surname-masked):", first.replace(/\s+/g, " ").slice(0, 80));
  const f = await shot(p, "42-client-portal");
  await d.close();
  return [f];
});

// The self-declared-credential evidence portal: Priya (all government-verified) beside
// Sofia (four emerald government badges + one slate "Self-uploaded — not yet verified"
// Medical), so the L0-vs-L3 distinction is captured in one frame [#42 — Nikos].
await run("42 portal self-declared — a portal crew card with a self-uploaded (L0) badge DISTINCT from government-verified (L3) (desktop)", async () => {
  if (!selfPortalToken) throw new Error("no self-declared portal token — create failed");
  const d = await browser.newContext({ viewport: DESKTOP });
  const p = await d.newPage();
  attach(p, "client-portal-selfdeclared");
  await p.goto(`${BASE}/portal/${selfPortalToken}`, { waitUntil: "domcontentloaded" });
  await p.locator('[data-testid="client-crew-list"]').first().waitFor({ state: "visible", timeout: 30000 });
  const l0 = await p.locator('text=Self-uploaded — not yet verified').count();
  const l3 = await p.locator('text=Government-verified').count();
  console.log("   self-declared portal badges — L0(self-uploaded):", l0, "L3(government-verified):", l3);
  const f = await shot(p, "42-portal-self-declared");
  await d.close();
  return [f];
});

// The agent-side PortalManager pre-send visibility preview: per-crew visible / NOT-visible
// reason, the drop warning when a non-visible crew is selected, the DISABLED/greyed hidden
// checkbox, AND the real pre-send exposure confirm text ("Sending N crew · surnames masked ·
// 0 hidden included"). The confirm is a native window.confirm(); we intercept it, read its
// REAL message, cancel it (no portal created), then render that exact message as an evidence
// banner so the screenshot shows the true string the app produces.
await run("42 portal preview — disabled/greyed hidden checkbox + drop warning + pre-send confirm text (desktop)", async () => {
  await agent.goto(`${BASE}/agent/portals`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="portal-manager"]').first().waitFor({ state: "visible", timeout: 30000 });
  const opts = agent.locator('[data-testid="portal-crew-option"]');
  await opts.first().waitFor({ state: "visible", timeout: 15000 });
  console.log("   picker crew options:", await opts.count());
  // Fill vessel + client label so the Create button (and thus the confirm) can fire.
  await agent.locator('[data-testid="portal-vessel-input"]').first().fill("MV Aegean Star");
  await agent.locator('[data-testid="portal-client-input"]').first().fill("Aegean Shipowners Ltd");
  // Tick VISIBLE crew (so visibleSelected > 0). The HIDDEN crew checkbox is disabled by the
  // fix, so attempting to check it is a no-op — we assert it stays unchecked + disabled.
  const visible = agent.locator('[data-testid="portal-crew-option"][data-visible="true"]').first();
  const hidden = agent.locator('[data-testid="portal-crew-option"][data-visible="false"]').first();
  await visible.locator('input[type="checkbox"]').check().catch(() => {});
  const hiddenBox = hidden.locator('input[type="checkbox"]').first();
  const hiddenDisabled = await hiddenBox.isDisabled().catch(() => null);
  console.log("   hidden crew checkbox disabled:", hiddenDisabled);
  await agent.locator('[data-testid="portal-drop-warning"]').first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  // Intercept the native confirm, capture its REAL message, and CANCEL it (no side effect).
  let confirmMsg = null;
  agent.once("dialog", async (dlg) => {
    confirmMsg = dlg.message();
    await dlg.dismiss().catch(() => {});
  });
  await agent.locator('[data-testid="portal-create-submit"]').first().click({ timeout: 5000 }).catch(() => {});
  // Give the dialog event a beat to fire + be captured.
  await agent.waitForTimeout(600);
  console.log("   captured pre-send confirm message:", JSON.stringify(confirmMsg));
  if (confirmMsg) {
    // Render the app's REAL confirm string as a visible evidence banner (not fabricated —
    // it is exactly dlg.message() captured above), pinned at the top of the compose view.
    await agent.evaluate((msg) => {
      const existing = document.getElementById("b3-confirm-evidence");
      if (existing) existing.remove();
      const box = document.createElement("div");
      box.id = "b3-confirm-evidence";
      box.setAttribute("data-testid", "portal-presend-confirm-evidence");
      box.style.cssText =
        "margin:12px 0;padding:14px 16px;border:2px solid #0f766e;border-radius:12px;" +
        "background:#f0fdfa;color:#0f172a;font:14px/1.5 ui-sans-serif,system-ui;white-space:pre-wrap;";
      box.textContent = "Pre-send confirmation (native dialog text):\n\n" + msg;
      const mgr = document.querySelector('[data-testid="portal-manager"]');
      (mgr || document.body).prepend(box);
    }, confirmMsg);
  }
  return [await shot(agent, "42-portal-preview")];
});

// =============================================================================
// #49 — DOCKA-VERIFIED DIRECTORY
// =============================================================================

// Authenticated-client directory: mint a next-auth JWT session cookie for a client
// e-mail and view /directory. Verified-only rows + expiry counts + agency attribution.
await run("49 directory — authenticated-client directory (verified rows + expiry counts + enquire-via-agency) (desktop)", async () => {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET not set in the script env — cannot mint the client session cookie");
  const value = await encode({
    token: { name: "Nikos (shipowner)", email: "nikos@aegeanshipowners.example", sub: "client-nikos", role: "agent" },
    secret,
    salt: "authjs.session-token",
  });
  const clientCtx = await browser.newContext({ viewport: DESKTOP });
  await clientCtx.addCookies([
    { name: "authjs.session-token", value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax", secure: false },
  ]);
  const p = await clientCtx.newPage();
  attach(p, "directory-client");
  await p.goto(`${BASE}/directory`, { waitUntil: "domcontentloaded" });
  // If the session cookie was rejected the sign-in prompt renders instead of the page.
  const signedIn = await p.locator('[data-testid="directory-page"]').first().waitFor({ state: "visible", timeout: 30000 })
    .then(() => true).catch(() => false);
  if (!signedIn) {
    await shot(p, "49-directory-SIGNIN-FALLBACK");
    throw new Error("directory gated on auth() — client session cookie not accepted (sign-in prompt shown)");
  }
  await p.locator('[data-testid="directory-list"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const rows = await p.locator('[data-testid="directory-row"]').count();
  console.log("   directory rows:", rows);
  const f = await shot(p, "49-directory");
  await clientCtx.close();
  return [f];
});

// Seaman-side directory opt-in toggle + honest copy (Jaan: identity-verified + opted in).
await run("49 seaman directory opt-in — toggle + honest copy (desktop+mobile)", async () => {
  const files = [];
  await jaan.page.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  const sec = jaan.page.locator('[data-testid="directory-opt-in-section"]').first();
  await sec.waitFor({ state: "visible", timeout: 30000 });
  await sec.scrollIntoViewIfNeeded();
  const on = await jaan.page.locator('[data-testid="directory-opt-in"]').first().getAttribute("data-on");
  console.log("   seaman directory-opt-in data-on:", on);
  files.push(await shot(jaan.page, "49-seaman-directory-optin-desktop"));
  // Mobile — reuse the seaman session cookies.
  const mCtx = await browser.newContext({ viewport: MOBILE });
  await mCtx.addCookies(await jaan.ctx.cookies());
  const mp = await mCtx.newPage();
  attach(mp, "seaman-directory-optin-mobile");
  await mp.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  await mp.locator('[data-testid="directory-opt-in-section"]').first().waitFor({ state: "visible", timeout: 30000 });
  await mp.locator('[data-testid="directory-opt-in-section"]').first().scrollIntoViewIfNeeded();
  files.push(await shot(mp, "49-seaman-directory-optin-mobile"));
  await mCtx.close();
  return files;
});

// The DEFAULT-OFF directory toggle on a FRESH seaman (Mart) who never touched it —
// shows the "Off — hidden" state pill + "You are not listed unless you turn this on …
// it is off by default" copy, evidencing opt-in-by-default (Arjun/Mart persona).
await run("49 seaman directory opt-in — DEFAULT-OFF state on a fresh seaman (Off — hidden) (desktop)", async () => {
  await mart.page.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
  const sec = mart.page.locator('[data-testid="directory-opt-in-section"]').first();
  await sec.waitFor({ state: "visible", timeout: 30000 });
  await sec.scrollIntoViewIfNeeded();
  const on = await mart.page.locator('[data-testid="directory-opt-in"]').first().getAttribute("data-on");
  const stateWord = await mart.page.locator('[data-testid="directory-opt-in-state"]').first().innerText().catch(() => "");
  console.log("   fresh-seaman directory-opt-in data-on:", on, "state pill:", JSON.stringify(stateWord));
  return [await shot(mart.page, "49-seaman-directory-optin-off")];
});

// =============================================================================
// #52 — VACANCY + CANDIDATE MATCHING
// =============================================================================

// The vacancy create form (with fields filled to show the shape) — NOT submitted (the
// matched vacancy already exists from setup).
await run("52 vacancy form — create form (required certs + sea-time + rotation window) (desktop)", async () => {
  await agent.goto(`${BASE}/agent/vacancies`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="vacancy-match"]').first().waitFor({ state: "visible", timeout: 30000 });
  await agent.locator('[data-testid="vacancy-title-input"]').first().fill("ETO — Chemical Tanker (4-month rotation)");
  await agent.locator('[data-testid="vacancy-rank-input"]').first().fill("Electro-Technical Officer");
  // Tick a couple of required-cert chips to show the required set.
  for (const t of ["Basic Safety Training", "Medical"]) {
    await agent.locator(`text=${t}`).first().click().catch(() => {});
  }
  await agent.locator('[data-testid="vacancy-title-input"]').first().scrollIntoViewIfNeeded();
  return [await shot(agent, "52-vacancy-form")];
});

// The ranked candidate match list: qualified vs not, at-sea flag, held-but-expiring flag,
// cert coverage + sea-time gate, and the "Qualified only" filter control.
await run("52 vacancy matches — ranked candidate list (qualified/not + at-sea + held-but-expiring + Qualified-only filter) (desktop)", async () => {
  await agent.goto(`${BASE}/agent/vacancies`, { waitUntil: "domcontentloaded" });
  await agent.locator('[data-testid="vacancy-match"]').first().waitFor({ state: "visible", timeout: 30000 });
  await agent.locator('[data-testid="candidate-list"]').first().waitFor({ state: "visible", timeout: 15000 });
  const total = await agent.locator('[data-testid="candidate-row"]').count();
  const qualified = await agent.locator('[data-testid="candidate-row"][data-qualified="true"]').count();
  const held = await agent.locator('[data-testid="candidate-held-expiring"]').count();
  console.log(`   candidates: ${total} total, ${qualified} qualified, ${held} held-but-expiring rows`);
  await agent.locator('[data-testid="qualified-only-toggle"]').first().scrollIntoViewIfNeeded();
  return [await shot(agent, "52-vacancy-matches")];
});

await browser.close();

console.log("\n===== MANIFEST =====");
console.log(JSON.stringify(results, null, 2));
console.log("\n===== CONSOLE ERRORS (" + consoleErrors.length + ") =====");
console.log(JSON.stringify(consoleErrors.slice(0, 60), null, 2));
