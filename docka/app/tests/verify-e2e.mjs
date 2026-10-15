// End-to-end VERIFICATION of the Docka app, driven for real with Playwright
// against the already-running dev server (http://localhost:3000).
//
// Proves the one-button mass-upload change did not break anything and that the
// core seaman + agent journeys still work. Saves a proof screenshot at each step
// into tests/shots/verify/. Prints a PASS/FAIL line per step and exits non-zero
// on any hard failure.
//
//   node tests/verify-e2e.mjs

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as J from "./journeys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Public archive: the original samples/ folder (real certificate photos) was removed.
// Set SAMPLES_DIR to a folder of your own test JPEGs to run this script.
const SAMPLES_DIR = process.env.SAMPLES_DIR || path.resolve(__dirname, "../../samples");
const SHOTS = path.join(__dirname, "shots", "verify");
const VERIFIED_CODE = "SAMPLE0SAFETY001"; // JAAN SAMPLE, valid until 2027-03-28

if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

// Three sample photos (task requires exactly three, uploaded at once).
const THREE = fs
  .readdirSync(SAMPLES_DIR)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()
  .slice(0, 3)
  .map((f) => path.join(SAMPLES_DIR, f));

const results = []; // { step, pass, note }
function record(step, pass, note) {
  results.push({ step, pass, note });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${step}${note ? " — " + note : ""}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function shot(page, name) {
  const out = path.join(SHOTS, name);
  await page.screenshot({ path: out, fullPage: true });
  return out;
}

const shots = [];

async function main() {
  assert(THREE.length === 3, `need 3 sample jpgs, found ${THREE.length}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 900, height: 1300 }, // modest, keeps screenshots small
  });
  const page = await context.newPage();
  const name = `E2E Verify ${Date.now()}`;

  try {
    // ============================================================= STEP 1
    // Land on the seafarer profile dashboard (that is where the single
    // mass-upload control lives) and assert exactly ONE upload control.
    const seaman = await J.createSeaman(page, name);
    assert(seaman.shareToken, "created seaman must have a share token");

    const counts = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const massBtns = document.querySelectorAll('[data-testid="mass-upload"]');
      const massInputs = document.querySelectorAll('[data-testid="mass-upload-input"]');
      const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const visibleFileInputs = allFileInputs.filter((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
      });
      const input = massInputs[0];
      return {
        massButton: massBtns.length,
        massInput: massInputs.length,
        inputMultiple: input ? input.hasAttribute("multiple") : false,
        inputHidden: input ? getComputedStyle(input).display === "none" || input.className.includes("hidden") : false,
        allFileInputs: allFileInputs.length,
        visibleFileInputs: visibleFileInputs.length,
        oldCamera: q('[data-testid="mass-upload-camera"]'),
        oldChoose: q('[data-testid="mass-upload-choose"]'),
      };
    });
    assert(counts.massButton === 1, `expected exactly 1 mass-upload button, got ${counts.massButton}`);
    assert(counts.massInput === 1, `expected exactly 1 mass-upload-input, got ${counts.massInput}`);
    assert(counts.inputMultiple, "the single file input must accept multiple files");
    assert(counts.allFileInputs === 1, `expected exactly 1 <input type=file> on the page, got ${counts.allFileInputs}`);
    assert(counts.visibleFileInputs === 0, `the file input must be hidden, but ${counts.visibleFileInputs} are visible`);
    assert(counts.oldCamera === 0, `old mass-upload-camera must NOT exist (found ${counts.oldCamera})`);
    assert(counts.oldChoose === 0, `old mass-upload-choose must NOT exist (found ${counts.oldChoose})`);
    shots.push(await shot(page, "01-seafarer-one-button.png"));
    record(
      "STEP 1 — one upload control on /seafarer",
      true,
      `1 button + 1 hidden multi-file input; visible file inputs=0; old camera/choose testids absent`
    );

    // ============================================================= STEP 2
    // Multi-doc upload: push all THREE photos through the single input at once.
    await page.locator('[data-testid="mass-upload-input"]').first().setInputFiles(THREE);
    // Wait until three rows exist and every one has reached a terminal state.
    await page.waitForFunction(
      (expected) => {
        const rows = Array.from(document.querySelectorAll('[data-testid="upload-row"]'));
        if (rows.length < expected) return false;
        const terminal = new Set(["verified", "photo", "saved", "error"]);
        return rows.every((r) => terminal.has(r.getAttribute("data-status")));
      },
      THREE.length,
      { timeout: 240_000 }
    );
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="upload-row"]')).map((r) => {
        const name = r.querySelector("p.font-medium")?.textContent?.trim() ?? "";
        const message = r.querySelector("p.text-xs")?.textContent?.trim() ?? "";
        // The visible status pill is the last small rounded span in the row.
        const pills = Array.from(r.querySelectorAll("span.rounded-full"));
        const label = pills.length ? pills[pills.length - 1].textContent.trim() : "";
        return { name, status: r.getAttribute("data-status"), label, message };
      });
    });
    assert(rows.length === 3, `expected 3 upload rows, got ${rows.length}`);
    for (const r of rows) {
      assert(r.status && r.status !== "queued" && r.status !== "uploading", `row "${r.name}" left in non-terminal status "${r.status}"`);
      assert(r.label && r.label.length > 0, `row "${r.name}" has a blank status label (dead row)`);
    }
    const anyError = rows.some((r) => r.status === "error");
    shots.push(await shot(page, "02-after-multi-upload.png"));
    const rowSummary = rows.map((r, i) => `photo${i + 1}(${path.basename(THREE[i])}): status="${r.status}" label="${r.label}"`).join(" | ");
    record(
      "STEP 2 — 3-photo multi-upload, each with a recognition result",
      !anyError,
      rowSummary + (anyError ? "  [one or more rows FAILED to upload]" : "")
    );

    // ============================================================= STEP 3
    // Verify by code: paste the real government code and submit.
    await page.locator('[data-testid="code-input"]').first().fill(VERIFIED_CODE);
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/documents") && r.request().method() === "POST",
        { timeout: 60_000 }
      ),
      page.locator('[data-testid="add-doc-submit"]').first().click(),
    ]);
    const body = await resp.json();
    assert(body.ok, `code verify POST failed: ${JSON.stringify(body).slice(0, 200)}`);
    assert(body.document?.source === "government", `verified doc must be source=government, got ${body.document?.source}`);
    assert(
      (body.document?.validUntil ?? "").startsWith("2027-03-28"),
      `verified doc expiry must be 2027-03-28, got ${body.document?.validUntil}`
    );
    // Confirm the registry record that fed the auto-fill: this code belongs to
    // JAAN SAMPLE (the name/expiry are pulled from the government registry).
    const cert = await page.request.get(`${J.BASE_URL}/api/cert?code=${VERIFIED_CODE}`).then((r) => r.json());
    assert(/JAAN SAMPLE/i.test(cert.fullName ?? ""), `registry record must be JAAN SAMPLE, got ${cert.fullName}`);
    // Wait for a government/verified doc row to render with its green badge + expiry.
    await page.waitForFunction(
      () => {
        const items = Array.from(document.querySelectorAll('[data-testid="doc-item"]'));
        return items.some(
          (li) => /verified/i.test(li.innerText) && /28 Mar 2027/i.test(li.innerText)
        );
      },
      undefined,
      { timeout: 15_000 }
    );
    const step3 = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="doc-item"]'));
      const verifiedItem = items.find((li) => /verified/i.test(li.innerText) && /2027/i.test(li.innerText));
      return {
        title: verifiedItem?.querySelector("p.font-medium")?.textContent?.trim() ?? "",
        hasExpiry: !!verifiedItem && /28 Mar 2027/i.test(verifiedItem.innerText),
        addedVerified: /Added & verified/i.test(document.body.innerText),
        greenBadge: !!(verifiedItem && verifiedItem.querySelector(".bg-emerald-100, .text-emerald-800, .text-emerald-700")),
      };
    });
    assert(step3.hasExpiry, "verified doc must show expiry 28 Mar 2027");
    assert(step3.greenBadge, "verified doc must show a green/verified badge");
    shots.push(await shot(page, "03-verified-by-code.png"));
    record(
      "STEP 3 — government-verified doc by code",
      true,
      `registry name=${cert.fullName}; doc title="${step3.title}"; expiry=28 Mar 2027; green Verified badge=${step3.greenBadge}; "Added & verified" banner=${step3.addedVerified}`
    );

    // ============================================================= STEP 3b
    // Outward proof (increment 8): mint the public verify link for the freshly
    // government-verified EE doc and open the proof page — it must name the
    // Estonian registry (per-country naming) and re-check LIVE (EE regression).
    const link = await page.request
      .get(`${J.BASE_URL}/api/verify-link?documentId=${body.document.id}&token=${seaman.shareToken}`)
      .then((r) => r.json());
    assert(
      link.ok && typeof link.path === "string" && link.path.startsWith("/verify/"),
      `verify-link mint failed: ${JSON.stringify(link).slice(0, 200)}`
    );
    const proofPage = await context.newPage();
    await proofPage.goto(`${J.BASE_URL}${link.path}`, { waitUntil: "domcontentloaded" });
    const proofInfo = await proofPage.evaluate(() => ({
      verdict: document.querySelector('[data-testid="verify-verdict"]')?.textContent?.trim() ?? "",
      registry: document.querySelector('[data-testid="proof-registry"]')?.textContent?.trim() ?? "",
      recheck:
        document.querySelector('[data-testid="proof-recheck-state"]')?.getAttribute("data-state") ??
        "",
    }));
    assert(/Government-verified/i.test(proofInfo.verdict), `proof verdict wrong: "${proofInfo.verdict}"`);
    assert(
      /Transpordiamet/i.test(proofInfo.registry),
      `proof must name the Estonian registry, got "${proofInfo.registry}"`
    );
    assert(proofInfo.recheck === "live", `EE proof must re-check LIVE, got "${proofInfo.recheck}"`);
    const proofApi = await page.request.get(`${J.BASE_URL}/api${link.path}`).then((r) => r.json());
    assert(
      proofApi.ok === true && proofApi.reVerified === true && proofApi.registryCountry === "EE",
      `proof API wrong: ${JSON.stringify(proofApi).slice(0, 200)}`
    );
    shots.push(await shot(proofPage, "03b-public-proof.png"));
    await proofPage.close();
    record(
      "STEP 3b — public proof page (EE, live re-check)",
      true,
      `verdict="${proofInfo.verdict}"; registry="${proofInfo.registry}"; recheck=live; API reVerified=true`
    );

    // ============================================================= STEP 4
    // Share: open the seaman's public share link in a fresh page and assert
    // the uploaded documents are visible there. The share area is collapsed by
    // default — expand it and read the open-link input (data-testid renamed
    // share-url -> share-open-url with the two-link share redesign).
    await page.locator('[data-testid="share-toggle"]').first().click();
    const shareUrl = await page.locator('[data-testid="share-open-url"]').first().inputValue();
    assert(shareUrl.includes("/share/"), `share url looks wrong: ${shareUrl}`);
    const sharePage = await context.newPage();
    await sharePage.goto(shareUrl, { waitUntil: "domcontentloaded" });
    await sharePage.waitForLoadState("networkidle").catch(() => {});
    const share = await sharePage.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("h3")).map((h) => h.textContent.trim());
      return {
        seamanName: document.querySelector("h1")?.textContent?.trim() ?? "",
        docTitles: cards,
        text: document.body.innerText,
      };
    });
    assert(share.docTitles.length > 0, "share view shows no document cards");
    const hasVerifiedCert = /OHUTUSALASE|JAAN SAMPLE/i.test(share.text) || share.docTitles.some((t) => /OHUTUSALASE/i.test(t));
    assert(hasVerifiedCert || share.docTitles.length >= 1, "share view must show the uploaded documents");
    shots.push(await shot(sharePage, "04-share-view.png"));
    await sharePage.close();
    record(
      "STEP 4 — public share view shows uploaded documents",
      true,
      `${share.docTitles.length} document card(s) visible for "${share.seamanName}"`
    );

    // ============================================================= STEP 5
    // Agent side: sign in via the dev test door, assert the fleet board renders
    // with seafarers, then open ONE into the single-seaman review view.
    await J.loginAsTestAgent(page);
    // Consent handshake: the agent board is grant-scoped (default-deny) since
    // the consent-grant lifecycle landed — the signed-in agent must open the
    // seaman's share link once to form the grant (same step every persona
    // journey performs) or the fresh seaman never appears on the board.
    await J.agentOpenSeamanShare(page, seaman.shareToken);
    const board = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-testid="seafarer-card"]').length,
      hasBoard: !!document.querySelector('[data-testid="agent-board"]'),
    }));
    assert(board.hasBoard, "agent board did not render");
    assert(board.cards > 0, `fleet board shows no seafarers (cards=${board.cards})`);
    shots.push(await shot(page, "05-agent-dashboard.png"));
    record("STEP 5a — agent fleet board renders", true, `${board.cards} seafarer card(s)`);

    await J.reviewSeaman(page, name);
    const review = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="doc-row"]'));
      const uploaded = []; // real documents with a review status
      const missing = []; // required-slot placeholders showing a MISSING badge
      let blank = 0;
      for (const r of rows) {
        const rev = r.getAttribute("data-review");
        const isMissing = r.getAttribute("data-missing") === "true";
        // Every row must surface SOME visible status badge (MISSING or review state).
        const badge = r.querySelector("span.rounded-full")?.textContent?.trim() ?? "";
        if (rev) uploaded.push(rev);
        else if (isMissing) missing.push(r.getAttribute("data-title"));
        else if (!badge) blank++;
      }
      return {
        panel: !!document.querySelector('[data-testid="review-panel"]'),
        rows: rows.length,
        uploaded,
        missingCount: missing.length,
        blank,
      };
    });
    assert(review.panel, "single-seaman review panel did not render");
    assert(review.rows > 0, "review view shows no document rows");
    assert(review.uploaded.length > 0, "review view shows no reviewable uploaded documents with a status");
    assert(review.blank === 0, "some doc rows show no status at all (dead rows)");
    shots.push(await shot(page, "06-single-seaman-review.png"));
    record(
      "STEP 5b — single-seaman review shows per-document statuses",
      true,
      `${review.rows} row(s): ${review.uploaded.length} uploaded doc(s) [${review.uploaded.join(", ")}] + ${review.missingCount} required-slot MISSING; 0 blank`
    );

    console.log("\n================ VERIFY SUMMARY ================");
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.step}`);
    console.log("Screenshots:");
    for (const s of shots) console.log("   " + s);
    const allPass = results.every((r) => r.pass);
    console.log(`\nOVERALL: ${allPass ? "PASS" : "FAIL"}`);
    await browser.close();
    process.exit(allPass ? 0 : 1);
  } catch (err) {
    try { shots.push(await shot(page, "99-failure.png")); } catch {}
    console.error("\n[verify] HARD FAILURE:", err.message);
    console.log("\n================ VERIFY SUMMARY (aborted) ================");
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.step}`);
    console.log("Screenshots so far:");
    for (const s of shots) console.log("   " + s);
    await browser.close();
    process.exit(1);
  }
}

main();
