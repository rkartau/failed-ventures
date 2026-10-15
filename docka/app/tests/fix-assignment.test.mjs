// DEF-1 / DEF-6 acceptance suite — the assignment/voyage lifecycle fix.
//
// Drives the REAL app at http://localhost:3000 (dev server already up, EU registry
// mock on :4123, disposable demo db.json). Every criterion HARD-ASSERTS an
// observable outcome: a db.json delta, a derived grant status, an API status, or a
// data-testid on the live UI. Reuses tests/journeys.mjs helpers (loginAsTestAgent,
// createSeaman, agentOpenSeamanShare, moveSeaman, moveSeamanExpectBlock,
// overrideAssignment, reviewSeaman, screenshot).
//
// Subjects are freshly-created disposable seamen (prefixed ZZFIX-) granted to the
// dev agent; SEA-ready ones are seeded with a recognised rank + the 5 base required
// documents via a direct db.json patch (the task explicitly permits mutating the
// demo db). The seed touches ONLY the freshly-created subject, never a seed seaman,
// so no existing assertion is perturbed.
//
// Run (dev server up):  node app/tests/fix-assignment.test.mjs

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const CONSENT_PATH = path.join(__dirname, "..", "data", "consent-events.ndjson");
const SHOTS_DIR = path.join(__dirname, "shots", "demo", "fix-assignment");
const BASE = J.BASE_URL;
const DEV = "dev"; // the test agent tenant (POST /api/test-login with no body)

fs.mkdirSync(SHOTS_DIR, { recursive: true });

// ---- tiny assert + result table --------------------------------------
const results = [];
let hardFail = null;
function pass(id, msg) {
  results.push({ id, ok: true, msg });
  console.log(`  PASS  ${id}  ${msg}`);
}
function assert(cond, id, msg) {
  if (!cond) {
    const e = new Error(`ASSERTION FAILED [${id}]: ${msg}`);
    results.push({ id, ok: false, msg });
    throw e;
  }
  pass(id, msg);
}

// ---- db.json / derived-state helpers ---------------------------------
function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function liveAssignments(db, sid, agentId = DEV) {
  return db.assignments.filter(
    (a) => a.seafarerId === sid && a.agentId === agentId && a.returnedAt === null
  );
}
function allAssignments(db, sid, agentId = DEV) {
  return db.assignments.filter((a) => a.seafarerId === sid && a.agentId === agentId);
}
function grantFor(db, sid, agentId = DEV) {
  return db.accessGrants.find((g) => g.seafarerId === sid && g.agentId === agentId) ?? null;
}
// Mirror of lib/access.effectiveGrantStatus for the cases we assert (LOCKED derives
// purely from a live assignment; otherwise the stored grant status).
function effStatus(db, sid, agentId = DEV) {
  const g = grantFor(db, sid, agentId);
  if (!g) return null;
  if (liveAssignments(db, sid, agentId).length > 0) return "LOCKED";
  if (g.status === "REVOKED") return "REVOKED";
  if (g.status === "EXPIRED") return "EXPIRED";
  if (g.expiresAt != null && new Date(g.expiresAt).getTime() <= Date.now()) return "EXPIRED";
  return g.status; // ACTIVE / PENDING
}
// Re-implementation of lib/db.verifyAuditChain for the consent-events sink (flat
// entries): hash = sha256(prevHash + "|" + stableStringify(core)); genesis GENESIS.
function verifyConsentChain() {
  if (!fs.existsSync(CONSENT_PATH)) return { ok: true, brokenAt: null };
  const lines = fs.readFileSync(CONSENT_PATH, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  let prev = "GENESIS";
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, brokenAt: i }; }
    const { prevHash, hash, ...core } = e;
    if (prevHash !== prev) return { ok: false, brokenAt: i };
    const recomputed = crypto
      .createHash("sha256")
      .update(`${prev}|${JSON.stringify(core, Object.keys(core).sort())}`)
      .digest("hex");
    if (recomputed !== hash) return { ok: false, brokenAt: i };
    prev = hash ?? "GENESIS";
  }
  return { ok: true, brokenAt: null };
}

// ---- app helpers ------------------------------------------------------
// moveSeaman resolves on the OPTIMISTIC board column flip, which can precede the
// server finishing the awaited startAssignment/closeAssignment hook. Poll db.json
// until the expected server state lands (API PATCHes are fully awaited and need no
// poll).
async function waitUntil(fn, { timeout = 20_000, interval = 150 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function seafarerIdByToken(page, token) {
  const r = await page.request.get(`${BASE}/api/seafarers?token=${token}`);
  const j = await r.json();
  if (!j.ok) throw new Error(`could not resolve seafarer id for token ${token}`);
  return j.seafarer.id;
}

// Seed a freshly-created subject SEA-ready: a recognised rank (base-5 required set,
// no vessel add-ons) + the 5 base required documents, valid far into the future,
// each with a unique cert number (so no forgery flag). Optionally mark identity
// verified. Direct db.json read-modify-write; the subject has no in-flight request.
const BASE_TYPES = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];
function seedSeaReady(sid, { verified = false, rank = "Chief Officer" } = {}) {
  const db = readDb();
  const s = db.seafarers.find((x) => x.id === sid);
  if (!s) throw new Error(`seed: seafarer ${sid} not found`);
  s.rank = rank;
  s.vesselType = null;
  s.flagState = null;
  s.rotationEnd = null;
  if (verified) {
    s.identityVerified = true;
    s.verifiedName = s.name;
  }
  const now = new Date().toISOString();
  for (const t of BASE_TYPES) {
    db.documents.push({
      id: crypto.randomUUID(),
      seafarerId: sid,
      title: t,
      docType: t,
      docCategory: null,
      requiredType: t,
      certNumber: `ZZFIX-${crypto.randomBytes(5).toString("hex")}`,
      estonianCode: null,
      validUntil: "2032-01-01T00:00:00.000Z",
      isValid: true,
      expiryConfirmed: true,
      reviewStatus: "approved",
      reviewedBy: DEV,
      reviewedAt: now,
      fileName: null,
      source: "manual",
      registryCountry: null,
      verifiedKeyTrust: null,
      archived: false,
      archivedAt: null,
      rotation: 0,
      seaEndDate: null,
      createdAt: now,
    });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

async function cardColumn(page, name) {
  return page.evaluate((nm) => {
    const c = document.querySelector(`[data-testid="seafarer-card"][data-name="${nm}"]`);
    if (!c) return null;
    const col = c.closest('[data-testid^="column-"]');
    return col ? (col.getAttribute("data-testid") || "").replace(/^column-/, "") : null;
  }, name);
}
async function gotoBoard(page) {
  await page.goto(`${BASE}/agent`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="filter-all"]').first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="agent-board"][data-hydrated="true"]').first().waitFor({ state: "attached", timeout: 30_000 });
}
// A guarded PATCH move via the API (used for BACKWARD pulls the board's forward-only
// move-next button cannot express, and for the concurrent double-submit test). Goes
// through the SAME /api/seafarers state-move branch under test.
async function patchState(page, sid, state, extra = {}) {
  return page.request.patch(`${BASE}/api/seafarers`, {
    data: { id: sid, state, ...extra },
  });
}

// ======================================================================
async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  // Pre-decline the cookie-consent banner: its fixed bottom dialog otherwise
  // intercepts clicks on controls scrolled to the viewport's bottom edge
  // (move-next on the last card). "denied" = the privacy-default choice.
  await context.addCookies([
    { name: "docka_consent", value: "denied", url: BASE },
  ]);
  const page = await context.newPage();
  const tag = Date.now();

  try {
    await J.loginAsTestAgent(page);

    // ============================================================
    // SUBJECT V — verified, SEA-ready. Non-override ENTER path.
    //   Criterion 1 (assignment row + LOCKED + card in column),
    //   Criterion 2 (revoke-locked UI + revoke-blocked + ashore revoke blocked:true),
    //   R4 + Criterion 3 (assignment id pre-filled == liveAssignmentId, contract 200,
    //     identityVerifiedAtIssue true).
    // ============================================================
    const vName = `ZZFIX-V ${tag}`;
    const v = await J.createSeaman(page, vName);
    const vId = await seafarerIdByToken(page, v.shareToken);
    await J.agentOpenSeamanShare(page, v.shareToken);
    seedSeaReady(vId, { verified: true });
    await gotoBoard(page);

    await J.moveSeaman(page, vName, "sent_to_sea");
    await waitUntil(() => liveAssignments(readDb(), vId).length === 1);
    await J.screenshot(page, `demo/fix-assignment/v-01-sent-to-sea-${tag}`);

    let db = readDb();
    const vLive = liveAssignments(db, vId);
    assert(vLive.length === 1 && vLive[0].returnedAt === null, "C1a",
      "sea-ready ENTER creates exactly one live assignment (returnedAt:null) for (V,dev)");
    assert(effStatus(db, vId) === "LOCKED", "C1b",
      "effectiveGrantStatus derives LOCKED from the live assignment");
    assert((await cardColumn(page, vName)) === "sent_to_sea", "C1c",
      "V's card sits in column-sent_to_sea");
    const vAssignmentId = vLive[0].id;

    // Criterion 2 — server truth behind the seaman's AccessReviews.
    const revList = await (await page.request.get(`${BASE}/api/access?seafarerId=${vId}`)).json();
    const devRow = revList.reviews.find((r) => r.agentId === DEV);
    assert(devRow && devRow.status === "LOCKED", "C2a",
      "GET /api/access dev row reads LOCKED (drives revoke-locked)");
    const vGrantId = devRow.grantId;
    const revokeTry = await (await page.request.post(`${BASE}/api/access`, {
      data: { action: "revoke", grantId: vGrantId, seafarerId: vId },
    })).json();
    assert(revokeTry.ok === false && revokeTry.blocked === true, "C2b",
      "ashore revoke of a LOCKED grant returns ok:false blocked:true");
    db = readDb();
    assert(grantFor(db, vId).status !== "REVOKED", "C2c",
      "the LOCKED grant was NOT revoked (still readable)");

    // Criterion 2 — the seaman's OWN AccessReviews UI (V's seaman session is current).
    await page.goto(`${BASE}/seafarer`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="access-reviews"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const row = page.locator('[data-testid="access-row"][data-agent="dev"]').first();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    assert((await row.getAttribute("data-status")) === "LOCKED", "C2d-ui",
      "seaman AccessReviews row for dev shows data-status=LOCKED");
    assert(await row.locator('[data-testid="revoke-locked"]').first().isVisible(), "C2e-ui",
      "revoke-locked control is shown");
    assert(await row.locator('[data-testid="revoke-locked"]').first().isDisabled(), "C2f-ui",
      "revoke-locked control is DISABLED");
    assert((await row.locator('[data-testid="revoke-grant"]').count()) === 0, "C2g-ui",
      "revoke-grant (withdraw) is ABSENT while LOCKED");
    assert(await row.locator('[data-testid="revoke-blocked"]').first().isVisible(), "C2h-ui",
      "revoke-blocked reason is shown");
    await J.screenshot(page, `demo/fix-assignment/v-02-seaman-revoke-locked-${tag}`);

    // R4 + Criterion 3 — the Generate SEA panel pre-fills the assignment id.
    await gotoBoard(page); // return to the agent board (we were on the seaman view)
    await J.reviewSeaman(page, vName);
    await page.locator('[data-testid="generate-contract-open"]').first().click();
    const idInput = page.locator('[data-testid="contract-assignment-id"]').first();
    await idInput.waitFor({ state: "visible", timeout: 15_000 });
    const prefilled = await idInput.inputValue();
    assert(prefilled.length > 0 && prefilled === vAssignmentId, "R4",
      `Assignment id input is pre-filled with the live assignment id (${prefilled === vAssignmentId ? "== liveAssignmentId" : "MISMATCH"})`);
    await J.screenshot(page, `demo/fix-assignment/v-03-contract-prefilled-${tag}`);
    const [contractRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/contract/`) && r.request().method() === "POST", { timeout: 30_000 }),
      page.locator('[data-testid="generate-contract-submit"]').first().click(),
    ]);
    assert(contractRes.status() === 200, "C3a",
      `POST /api/contract/<id> returns 200 for the verified seaman (got ${contractRes.status()})`);
    db = readDb();
    const vTerms = db.issuedSeaTerms.find((r) => r.assignmentId === vAssignmentId);
    assert(vTerms && vTerms.identityVerifiedAtIssue === true, "C3b",
      "issuedSeaTerms.identityVerifiedAtIssue === true for the VERIFIED seaman");

    // ============================================================
    // SUBJECT U — unverified, NOT sea-ready. OVERRIDE ENTER path
    // (lock-on-override = YES) + unverified contract.
    // ============================================================
    const uName = `ZZFIX-U ${tag}`;
    const u = await J.createSeaman(page, uName);
    const uId = await seafarerIdByToken(page, u.shareToken);
    await J.agentOpenSeamanShare(page, u.shareToken); // NOT seeded => sea-block on advance
    await gotoBoard(page);

    let blocked = await J.moveSeamanExpectBlock(page, uName, "accepted");
    assert(blocked === true, "OVR-block-1", "advancing a non-ready seaman to accepted is HARD-BLOCKED");
    await J.overrideAssignment(page, "ZZFIX override to accepted — endorsement confirmed by phone.");
    await gotoBoard(page);
    blocked = await J.moveSeamanExpectBlock(page, uName, "sent_to_sea");
    assert(blocked === true, "OVR-block-2", "advancing a non-ready seaman to sent_to_sea is HARD-BLOCKED");
    await J.overrideAssignment(page, "ZZFIX override to sea — master accepts risk, ref ZZ-2.");
    await J.screenshot(page, `demo/fix-assignment/u-01-override-sea-${tag}`);

    db = readDb();
    const uLive = liveAssignments(db, uId);
    assert(uLive.length === 1 && uLive[0].returnedAt === null, "OVR1",
      "override to sent_to_sea DOES create the assignment (lock-on-override=YES)");
    assert(effStatus(db, uId) === "LOCKED", "OVR2", "overridden seaman's grant reads LOCKED");
    const uAssignmentId = uLive[0].id;
    const uContract = await page.request.post(`${BASE}/api/contract/${uId}`, {
      data: { assignmentId: uAssignmentId, kind: "sea", terms: {} },
    });
    assert(uContract.status() === 200, "C4a",
      `POST /api/contract/<id> returns 200 (not 400) for the UNVERIFIED seaman (got ${uContract.status()})`);
    const uHtml = await uContract.text();
    assert(/IDENTITY NOT GOVERNMENT-VERIFIED/.test(uHtml) && /DRAFT/.test(uHtml), "C4b",
      "unverified SEA renders the DRAFT + unverified banner");
    db = readDb();
    const uTerms = db.issuedSeaTerms.find((r) => r.assignmentId === uAssignmentId);
    assert(uTerms && uTerms.identityVerifiedAtIssue === false, "C4c",
      "issuedSeaTerms.identityVerifiedAtIssue === false for the unverified/override seaman");

    // ============================================================
    // SUBJECT A — R8a backward-pull unlock (the permanent-lock regression guard).
    // ============================================================
    const aName = `ZZFIX-A ${tag}`;
    const a = await J.createSeaman(page, aName);
    const aId = await seafarerIdByToken(page, a.shareToken);
    await J.agentOpenSeamanShare(page, a.shareToken);
    seedSeaReady(aId);
    await gotoBoard(page);
    await J.moveSeaman(page, aName, "sent_to_sea");
    await waitUntil(() => effStatus(readDb(), aId) === "LOCKED");
    db = readDb();
    assert(effStatus(db, aId) === "LOCKED", "R8a-pre", "A is LOCKED at sea");
    // Backward pull sent_to_sea -> review (board move-next is forward-only; the PATCH
    // goes through the SAME state-move branch + LEAVE hook).
    const back = await patchState(page, aId, "review");
    assert(back.ok(), "R8a-patch", "backward PATCH to review succeeds");
    db = readDb();
    assert(liveAssignments(db, aId).length === 0, "R8a1", "backward pull CLOSES the assignment (no live row)");
    assert(effStatus(db, aId) === "ACTIVE", "R8a2", "grant returns to ACTIVE after the pull-back");
    const aRev = await (await page.request.get(`${BASE}/api/access?seafarerId=${aId}`)).json();
    const aRow = aRev.reviews.find((r) => r.agentId === DEV);
    assert(aRow.status === "ACTIVE", "R8a3", "AccessReviews dev row is ACTIVE again (revoke-grant returns)");
    const aRevoke = await (await page.request.post(`${BASE}/api/access`, {
      data: { action: "revoke", grantId: aRow.grantId, seafarerId: aId },
    })).json();
    assert(aRevoke.ok === true && aRevoke.blocked !== true, "R8a4",
      "revokeGrant now succeeds (ok:true, not blocked) — the lock was NOT permanent");

    // ============================================================
    // SUBJECT B — R8b re-entry => exactly ONE live assignment.
    // ============================================================
    const bName = `ZZFIX-B ${tag}`;
    const b = await J.createSeaman(page, bName);
    const bId = await seafarerIdByToken(page, b.shareToken);
    await J.agentOpenSeamanShare(page, b.shareToken);
    seedSeaReady(bId);
    await gotoBoard(page);
    await J.moveSeaman(page, bName, "sent_to_sea");
    await waitUntil(() => liveAssignments(readDb(), bId).length === 1);
    await patchState(page, bId, "review"); // close assignment 1 (API, fully awaited)
    await gotoBoard(page);
    await J.moveSeaman(page, bName, "sent_to_sea"); // open assignment 2
    await waitUntil(() => allAssignments(readDb(), bId).length === 2 && liveAssignments(readDb(), bId).length === 1);
    db = readDb();
    assert(liveAssignments(db, bId).length === 1, "R8b1",
      "after exit + re-entry there is exactly ONE live assignment");
    assert(allAssignments(db, bId).length === 2, "R8b2",
      "history preserved: two assignment rows, one closed + one live");

    // ============================================================
    // SUBJECT C — R8c concurrent double-submit => exactly ONE row.
    // ============================================================
    const cName = `ZZFIX-C ${tag}`;
    const c = await J.createSeaman(page, cName);
    const cId = await seafarerIdByToken(page, c.shareToken);
    await J.agentOpenSeamanShare(page, c.shareToken);
    seedSeaReady(cId);
    await gotoBoard(page);
    await J.moveSeaman(page, cName, "accepted"); // stage the grant at accepted
    await waitUntil(() => grantFor(readDb(), cId)?.stage === "accepted");
    const [r1, r2] = await Promise.all([
      patchState(page, cId, "sent_to_sea"),
      patchState(page, cId, "sent_to_sea"),
    ]);
    assert(r1.ok() && r2.ok(), "R8c-patch", "both concurrent PATCHes to sent_to_sea return ok");
    db = readDb();
    assert(liveAssignments(db, cId).length === 1, "R8c1",
      "concurrent double-submit collapses to exactly ONE live assignment (idempotency guard)");
    assert(allAssignments(db, cId).length === 1, "R8c2",
      "no duplicate assignment row was pushed");

    // ============================================================
    // SUBJECT F — R8d (move-next enabled under LOCKED, reaches finished) +
    //             R8f (walk-through => net basis CONSENT + consent chain verifies).
    // ============================================================
    const fName = `ZZFIX-F ${tag}`;
    const f = await J.createSeaman(page, fName);
    const fId = await seafarerIdByToken(page, f.shareToken);
    await J.agentOpenSeamanShare(page, f.shareToken);
    seedSeaReady(fId);
    await gotoBoard(page);
    await J.moveSeaman(page, fName, "sent_to_sea");
    await waitUntil(() => effStatus(readDb(), fId) === "LOCKED");
    db = readDb();
    assert(effStatus(db, fId) === "LOCKED", "R8d-pre", "F is LOCKED at sea");
    // move-next must stay ENABLED under LOCKED (regression guard R5/R8d).
    const fCard = page.locator(`[data-testid="seafarer-card"][data-name="${fName}"]`).first();
    const fMoveNext = fCard.locator('[data-testid="move-next"]').first();
    assert((await fMoveNext.count()) === 1 && !(await fMoveNext.isDisabled()), "R8d1",
      "board move-next is present + ENABLED while the seaman is LOCKED");
    await J.moveSeaman(page, fName, "finished");
    await waitUntil(() => grantFor(readDb(), fId)?.stage === "finished" && liveAssignments(readDb(), fId).length === 0);
    assert((await cardColumn(page, fName)) === "finished", "R8d2",
      "moveSeaman(...,'finished') reaches the finished column under the fix");
    db = readDb();
    assert(liveAssignments(db, fId).length === 0, "R8f1", "walk-through closes the assignment");
    assert(grantFor(db, fId).legalBasis === "CONSENT", "R8f2",
      "net legal basis returns to CONSENT after the walk-through");
    const chain = verifyConsentChain();
    assert(chain.ok === true, "R8f3",
      `consent-events hash chain still verifies (brokenAt=${chain.brokenAt})`);
    await J.screenshot(page, `demo/fix-assignment/f-01-finished-${tag}`);

    // ---- summary -----------------------------------------------------
    console.log(`\n[fix-assignment] ALL ${results.length} assertions PASSED`);
  } catch (err) {
    hardFail = err;
    try { await J.screenshot(page, `demo/fix-assignment/99-failure-${Date.now()}`); } catch {}
    console.error(`\n[fix-assignment] FAILED\n`, err);
  } finally {
    await browser.close();
  }

  // Print a compact table for the report.
  console.log("\n=== RESULT TABLE ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}\t${r.id}\t${r.msg}`);
  process.exit(hardFail ? 1 : 0);
}

main();
