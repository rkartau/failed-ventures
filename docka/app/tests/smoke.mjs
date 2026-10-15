// End-to-end smoke journey against the LIVE dev server (http://localhost:3000).
//
// Proves both personas can actually drive the app:
//   Seaman  — create a profile, mass-upload real certificate photos (OCR/amber
//             path), and paste a real government code (verified/green path).
//   Agent   — sign in via the dev test door, filter the pipeline, open the
//             single-seaman review page, approve/reject documents, move the
//             seafarer, export the crew CSV, and view the public share page.
//
// Saves screenshots to tests/shots/. Exits non-zero on any failure.
//
// Run:  node tests/smoke.mjs        (uses all sample photos)
//       SMOKE_FILES=3 node tests/smoke.mjs   (first 3 photos, faster)

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Public archive: the original samples/ folder (real certificate photos) was removed.
// Set SAMPLES_DIR to a folder of your own test JPEGs to run this script.
const SAMPLES_DIR = process.env.SAMPLES_DIR || path.resolve(__dirname, "../../samples");
const VERIFIED_CODE = "SAMPLE0SAFETY001"; // safety training, full registry record

function pickSamples() {
  const all = fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort()
    .map((f) => path.join(SAMPLES_DIR, f));
  const n = process.env.SMOKE_FILES ? parseInt(process.env.SMOKE_FILES, 10) : all.length;
  return all.slice(0, n);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const files = pickSamples();
  console.log(`[smoke] using ${files.length} sample photo(s) + verified code ${VERIFIED_CODE}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const shots = [];

  try {
    const name = `Smoke Tester ${Date.now()}`;

    // --- SEAMAN ---------------------------------------------------------
    console.log("[smoke] creating seaman:", name);
    const seaman = await J.createSeaman(page, name);
    assert(seaman.shareToken, "seaman should have a share token");

    console.log("[smoke] pasting verified government code…");
    const pasted = await J.pasteCode(page, VERIFIED_CODE);
    assert(pasted, "verified code should be accepted");

    console.log("[smoke] mass-uploading photos (OCR)…");
    const statuses = await J.uploadFiles(page, files);
    console.log("[smoke] upload statuses:", statuses.join(", "));
    assert(statuses.length === files.length, "every uploaded file should produce a row");
    assert(
      statuses.every((s) => s !== "error"),
      "no upload should hard-fail"
    );
    shots.push(await J.screenshot(page, "01-seaman-profile"));

    // --- AGENT ----------------------------------------------------------
    console.log("[smoke] signing in as test agent…");
    await J.loginAsTestAgent(page);
    // Consent handshake: the agent board is grant-scoped (default-deny) — the
    // signed-in agent opens the seaman's share link once to form the grant
    // (same step every persona journey performs), otherwise the fresh seaman
    // never appears on the board.
    await J.agentOpenSeamanShare(page, seaman.shareToken);
    shots.push(await J.screenshot(page, "02-agent-dashboard"));

    console.log("[smoke] applying 'problems' filter…");
    const shownProblems = await J.applyFilter(page, "problems");
    console.log("[smoke]", shownProblems);
    shots.push(await J.screenshot(page, "03-agent-filter-problems"));
    await J.applyFilter(page, "all");

    console.log("[smoke] opening single-seaman review page…");
    await J.reviewSeaman(page, name);

    // Approve the first real (non-missing) document, reject the second if present.
    const realTitles = await page.evaluate(() => {
      const out = [];
      for (const r of document.querySelectorAll('[data-testid="doc-row"]')) {
        if (r.querySelector('[data-testid="doc-approve"]')) out.push(r.getAttribute("data-title"));
      }
      return out;
    });
    assert(realTitles.length > 0, "review page should show at least one uploaded document");
    console.log("[smoke] documents on review page:", realTitles.length);

    await J.approveDoc(page, realTitles[0]);
    console.log("[smoke] approved:", realTitles[0]);
    if (realTitles[1]) {
      await J.rejectDoc(page, realTitles[1], "Photo unreadable — please re-scan.");
      console.log("[smoke] rejected:", realTitles[1]);
    }
    shots.push(await J.screenshot(page, "04-agent-review"));

    // --- ASSIGNMENT HARD BLOCK + DOCUMENTED OVERRIDE -------------------
    // This seaman is not sea-ready (missing required docs, plus he pasted the same
    // registry code the seeded reference seaman carries → a duplicate/forgery
    // flag). Advancing him to an assignment state MUST be hard-blocked, not merely
    // warned. Prove the block, then prove the only way past is a documented
    // override that is recorded — the core round-10 control.
    console.log("[smoke] attempting to assign a non-sea-ready seaman (must be blocked)…");
    await page.goto(`${J.BASE_URL}/agent`, { waitUntil: "domcontentloaded" });
    const blocked = await J.moveSeamanExpectBlock(page, name, "accepted");
    assert(blocked, "advancing a non-sea-ready seaman to 'accepted' must be HARD-BLOCKED");
    console.log("[smoke] assignment correctly blocked.");

    // Confirm the block held server-side: he must still be in 'review'.
    const stillReview = await fetch(`${J.BASE_URL}/api/seafarers?token=${seaman.shareToken}`).then((r) => r.json());
    assert(
      stillReview.ok && stillReview.seafarer.state === "review",
      "a blocked assignment must NOT change the pipeline state"
    );
    console.log("[smoke] server-side block confirmed: state still =", stillReview.seafarer.state);

    console.log("[smoke] recording a documented override to advance…");
    await J.overrideAssignment(page, "Smoke test: endorsement confirmed by flag state by phone, ref #SMOKE-1.");
    shots.push(await J.screenshot(page, "05-agent-moved"));

    // Confirm the override move persisted to db.json (survives reload).
    const check = await fetch(`${J.BASE_URL}/api/seafarers?token=${seaman.shareToken}`).then((r) =>
      r.json()
    );
    assert(check.ok && check.seafarer.state === "accepted", "override move must persist to the store");
    console.log("[smoke] persistence confirmed: state =", check.seafarer.state);

    // The override must be recorded to the audit trail (a seafarer-level note).
    const audit = await fetch(
      `${J.BASE_URL}/api/comments?seafarerId=${check.seafarer.id}`
    ).then((r) => r.json()).catch(() => null);
    if (audit?.ok && Array.isArray(audit.comments)) {
      assert(
        audit.comments.some((c) => /OVERRIDDEN/i.test(c.text ?? "")),
        "override must be recorded to the audit trail"
      );
      console.log("[smoke] audit trail confirmed: override note recorded.");
    }

    // --- EXPORT + SHARE -------------------------------------------------
    console.log("[smoke] exporting crew CSV…");
    const csv = await J.exportCrew(page);
    assert(fs.existsSync(csv) && fs.statSync(csv).size > 0, "CSV export should be non-empty");
    console.log("[smoke] CSV saved:", csv);

    console.log("[smoke] opening public share view…");
    await J.openShare(page, seaman.shareToken);
    shots.push(await J.screenshot(page, "06-share-view"));

    console.log("\n[smoke] SMOKE PASSED");
    console.log("[smoke] screenshots:");
    for (const s of shots) console.log("   -", s);
    console.log("[smoke] csv:", csv);
  } catch (err) {
    try {
      await J.screenshot(page, "99-failure");
    } catch {}
    console.error("\n[smoke] SMOKE FAILED");
    console.error(err);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  process.exit(0);
}

main();
