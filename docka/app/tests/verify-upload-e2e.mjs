// End-to-end Playwright suite for wave 4 of the anonymous verify-upload plan
// (§8 e2e rows) — SELF-CONTAINED: starts its own EE mock registry (:4124) and
// its own `next dev` (:3101, REGISTRY_MOCK=1 + REGISTRY_BASE_EE override +
// VERIFY_IP_SALT), so it never collides with a developer's :3000 server and
// makes ZERO live registry calls.
//
// Scenarios:
//   1. Paste-mode REGRESSION with the tabs present: sample-cert button =>
//      verified card with the MASKED code; unmatched bare code => full-list
//      country picker => manual panel; tab switch keeps the paste input.
//   2. Upload happy path: a real /samples JPEG carrying an embedded EE
//      registry URL in its tail bytes => verified card, code redacted.
//   3. PNG upload: browser-real forceJpeg re-encode => derived JPEG kept,
//      sidecar workerRanOn "derived"; token-shaped FILENAME carries the code
//      (the PNG-QR substitute — jsQR only READS QRs, none can be generated
//      without a new dependency, so the QR-in-PNG decode itself is NOT covered
//      here; the forceJpeg + embedded-code path is).
//   4. PDF => saved + guided fallback.  5. Blurry 1×1 JPEG => saved + fallback.
//   6. 4 rapid uploads => 429 keep-and-retry countdown => ALL 4 persisted.
//   7. 11 MB file => immediate friendly too-large error (client-side gate).
//   (13 MB proxy-HTML 413: no proxy runs locally — the client parse fallback
//   is unit-tested in verify-upload-integration.test.mjs instead.)
//
// Uses the REAL recognition worker (tesseract/jsQR) — inputs are chosen so
// every assertion is deterministic whatever OCR reads (embedded codes /
// token-shaped filenames, never OCR quality).
//
// NOTE: the dev server runs with cwd app/, so accepted uploads persist into
// app/data/verify-uploads/ + app/data/verify-upload-events.ndjson (the normal
// dev data dir). Artifacts are left in place — the chain is append-only by
// design; the corpus files are tiny synthetic docs.
//
// Run: node tests/verify-upload-e2e.mjs

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
// Public archive: the original samples/ folder (real certificate photos) was removed.
// Set SAMPLES_DIR to a folder of your own test JPEGs to run this script.
const SAMPLES_DIR = process.env.SAMPLES_DIR || path.resolve(APP_DIR, "..", "samples");
const UPLOAD_DATA = path.join(APP_DIR, "data", "verify-uploads");
const SHOTS = path.join(__dirname, "shots", "verify-upload-e2e");

const APP_PORT = 3101;
const EE_MOCK_PORT = 4124;
const BASE = `http://localhost:${APP_PORT}`;

// Codes the EE mock answers 200-valid for. Everything else 404s on all four
// endpoints => the country's REAL no-match path.
const SAMPLE_CODE = process.env.SAMPLE_CERT_CODE || "SAMPLE0SAFETY001"; // the /api/cert sample-button token (fake placeholder in the public archive)
const HAPPY_CODE = "E2EHAPPYPATH0001"; // embedded-URL bytes in the samples JPEG
const PNG_CODE = "E2E9TESTTOKEN002"; // token-shaped PNG filename
const KNOWN = new Set([SAMPLE_CODE, HAPPY_CODE, PNG_CODE]);

const MASK = (code) => code.slice(0, 4) + "•".repeat(code.length - 8) + code.slice(-4);

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- EE mock registry (:4124) ---------------------------------------------

function startEeMock() {
  const server = http.createServer((req, res) => {
    const m = /^\/certificates\/by-access-token\/([A-Z0-9]+)$/i.exec(req.url ?? "");
    if (m && KNOWN.has(m[1].toUpperCase())) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          firstName: "ARVO",
          lastName: "MERI",
          certificateTypeLegalName: "Certificate of competency (e2e mock)",
          personalCode: "39001010000",
          birthDate: "1990-01-01T00:00:00+00:00",
          isValid: true,
          status: "valid",
          issuedOn: "2024-01-01T00:00:00+00:00",
          validUntil: "2030-01-01T00:00:00+00:00",
          issuerCountry: "EE",
        })
      );
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(EE_MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---- next dev (:3101) -------------------------------------------------------

function startNextDev() {
  const nextBin = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextBin, "dev", "-p", String(APP_PORT)], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      REGISTRY_MOCK: "1",
      REGISTRY_BASE_EE: `http://127.0.0.1:${EE_MOCK_PORT}`,
      VERIFY_IP_SALT: "e2e-test-salt",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[next] ${d}`);
  });
  proc.stderr.on("data", (d) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[next] ${d}`);
  });
  return proc;
}

// PID-rooted tree kill (never by image name).
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill("SIGTERM");
  }
}

async function waitForServer(timeoutMs = 180_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/registry-test`);
      if (r.ok) {
        const j = await r.json();
        if (j.mock === true) return;
        throw new Error("dev server is NOT in mock mode — refusing to run");
      }
    } catch (e) {
      if (String(e).includes("refusing")) throw e;
    }
    if (Date.now() - start > timeoutMs) throw new Error("next dev did not become ready");
    await sleep(1000);
  }
}

async function resetRegistryState() {
  await fetch(`${BASE}/api/registry-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });
}

// ---- data-dir bookkeeping ----------------------------------------------------

function sidecarSet() {
  try {
    return new Set(fs.readdirSync(UPLOAD_DATA).filter((f) => /\.json$/i.test(f)));
  } catch {
    return new Set();
  }
}

function newSidecars(before) {
  return [...sidecarSet()].filter((f) => !before.has(f));
}

async function waitNewSidecars(before, count, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const fresh = newSidecars(before);
    if (fresh.length >= count) return fresh;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`expected ${count} new sidecar(s), saw ${fresh.length}`);
    }
    await sleep(500);
  }
}

function readSidecarByOrigName(before, origName) {
  for (const f of newSidecars(before)) {
    const sc = JSON.parse(fs.readFileSync(path.join(UPLOAD_DATA, f), "utf-8"));
    if (sc.origName === origName) return sc;
  }
  return null;
}

// ---- fixtures (all generated — nothing committed) ----------------------------

const PLAIN_PDF = (label) =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<< /T (${label}) >>\nendobj\ntrailer\n%%EOF\n`, "latin1");

function happyPathJpeg() {
  const files = fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort();
  assert(files.length > 0, "a /samples JPEG must exist for the happy path");
  const buf = fs.readFileSync(path.join(SAMPLES_DIR, files[0]));
  // Tail bytes after EOI: detectCodeFromFile scans the RAW bytes for the
  // pinned registry URL — the exact mechanism a real registry PDF/print uses.
  return Buffer.concat([
    buf,
    Buffer.from(`\nhttps://meremees.transpordiamet.ee/certificates/${HAPPY_CODE}\n`, "latin1"),
  ]);
}

// Browser-real raster fixtures: canvas-encoded inside the page, so the PNG/JPEG
// bytes are exactly what a browser produces (decodable by createImageBitmap).
async function canvasBytes(page, type, w, h) {
  const dataUrl = await page.evaluate(
    ([t, width, height]) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      if (width > 50) {
        ctx.fillStyle = "#000000";
        ctx.font = "16px sans-serif";
        ctx.fillText("docka e2e fixture", 8, Math.min(24, height - 4));
      }
      return c.toDataURL(t, 0.9);
    },
    [type, w, h]
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

// ---- scenario harness ---------------------------------------------------------

let browser;
let scenarioN = 0;

async function inScenario(name, fn) {
  scenarioN++;
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-registry-test-ip": `e2e-ip-${scenarioN}` },
  });
  const page = await context.newPage();
  try {
    await resetRegistryState();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForSelector('[data-testid="verify-tab-upload"]', { timeout: 120_000 });
    // Wait for React hydration — a click on the server-rendered (inert) DOM
    // is silently lost. React 18 stamps __reactProps$ on hydrated nodes.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="verify-tab-upload"]');
        return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
      },
      { timeout: 60_000 }
    );
    await fn(page);
  } catch (e) {
    try {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `fail-${scenarioN}-${name}.png`), fullPage: true });
      console.error(`[e2e] screenshot saved for failing scenario '${name}'`);
    } catch {}
    throw e;
  } finally {
    await context.close();
  }
}

// Open the upload tab with a retry loop: a click dispatched before React
// hydration lands on inert DOM — re-click until the panel actually appears.
async function openUploadTab(page) {
  for (let i = 0; i < 20; i++) {
    await page.click('[data-testid="verify-tab-upload"]');
    try {
      await page.waitForSelector('[data-testid="upload-panel"]', { timeout: 1500 });
      return;
    } catch {}
  }
  throw new Error("upload panel never opened (hydration?)");
}

async function uploadFiles(page, files) {
  await openUploadTab(page);
  await page.setInputFiles('[data-testid="upload-input"]', files);
}

// ---- main ----------------------------------------------------------------------

async function main() {
  console.log("[e2e] starting EE mock registry + next dev (mock mode)…");
  const eeMock = await startEeMock();
  const next = startNextDev();
  try {
    await waitForServer();
    console.log(`[e2e] dev server ready on ${BASE} (mock mode confirmed)`);
    browser = await chromium.launch({ headless: true });

    // ---- 1. paste-mode regression (tabs present) --------------------------
    await inScenario("paste-regression", async (page) => {
      assert(await page.isVisible('[data-testid="verify-tab-paste"]'), "paste tab visible");
      assert(await page.isVisible('[data-testid="verify-tab-upload"]'), "upload tab visible");
      assert(await page.isVisible('input[placeholder^="e.g."]'), "paste input is the default mode");
      ok("both mode tabs render; paste stays the default mode");

      // Sample-cert button => verified card, code MASKED.
      await page.click("text=Use the sample certificate");
      await page.waitForSelector('[data-testid="registry-country"]', { timeout: 60_000 });
      const cardText = await page.innerText("body");
      assert(cardText.includes("Verified against"), "authority line rendered");
      assert(cardText.includes(MASK(SAMPLE_CODE)), "masked sample code shown");
      assert(!cardText.includes(SAMPLE_CODE), "full sample code NEVER in visible text");
      ok("sample-cert button still verifies — card renders with the MASKED code");

      // Unmatched bare code => full-list country picker => manual panel (RO).
      await page.fill('input[placeholder^="e.g."]', "ZXQW19KJH3");
      await page.click('button:has-text("Verify")');
      await page.waitForSelector('[data-testid="country-picker"][data-unmatched="true"]', {
        timeout: 60_000,
      });
      ok("unmatched bare code => full-list country picker (B2 rescue intact)");
      await page.selectOption('[data-testid="country-picker"]', "RO");
      await page.waitForSelector('[data-testid="manual-request-btn"]', { timeout: 30_000 });
      ok("picker round-trip: choosing Romania renders the manual-verification panel");

      // Tab switch keeps the paste input's value.
      await page.fill('input[placeholder^="e.g."]', "KEEPME123");
      await page.click('[data-testid="verify-tab-upload"]');
      await page.waitForSelector('[data-testid="upload-panel"]');
      // Retention notice moved to /privacy (operator decision 2026-08-12) —
      // it must NOT render in the upload tab anymore.
      assert(
        (await page.locator('[data-testid="upload-notice"]').count()) === 0,
        "notice line must be ABSENT from upload mode (disclosure lives on /privacy)"
      );
      await page.click('[data-testid="verify-tab-paste"]');
      const kept = await page.inputValue('input[placeholder^="e.g."]');
      assert(kept === "KEEPME123", `paste input survives tab switch (got '${kept}')`);
      ok("tab switch keeps paste-mode state (and the retention notice is gone from the upload tab)");
    });

    // ---- 2. upload happy path: /samples JPEG + embedded EE URL ------------
    await inScenario("upload-happy-path", async (page) => {
      const before = sidecarSet();
      await uploadFiles(page, [
        { name: "cert-photo.jpg", mimeType: "image/jpeg", buffer: happyPathJpeg() },
      ]);
      await page.waitForSelector('[data-testid="registry-country"]', { timeout: 90_000 });
      const text = await page.innerText("body");
      assert(text.includes("Verified against"), "verified card rendered");
      assert(text.includes(MASK(HAPPY_CODE)), "masked code shown");
      assert(!text.includes(HAPPY_CODE), "full code NEVER in visible text (redacted)");
      ok("samples JPEG + embedded EE URL => verified card, code redacted");

      const sc = readSidecarByOrigName(before, "cert-photo.jpg");
      assert(sc, "sidecar persisted");
      assert(sc.phase === "completed" && sc.outcome === "verified", "sidecar settled verified");
      assert(sc.extraction.embeddedCode === HAPPY_CODE, "embedded code recorded");
      ok("happy path persisted: sidecar completed/verified with the embedded code");
    });

    // ---- 3. PNG => browser-real forceJpeg derived + verified ---------------
    await inScenario("png-forcejpeg", async (page) => {
      const before = sidecarSet();
      const png = await canvasBytes(page, "image/png", 240, 100);
      await uploadFiles(page, [{ name: `${PNG_CODE}.png`, mimeType: "image/png", buffer: png }]);
      await page.waitForSelector('[data-testid="registry-country"]', { timeout: 90_000 });
      ok("PNG upload verifies via its token-shaped filename (PNG-QR substitute)");

      const sc = readSidecarByOrigName(before, `${PNG_CODE}.png`);
      assert(sc, "sidecar persisted");
      assert(sc.sniffedType === "png", "original sniffed png");
      assert(sc.derived && sc.derived.size > 0, "forceJpeg derived part kept by the server");
      assert(sc.extraction.workerRanOn === "derived", "worker ran on the DERIVED jpeg");
      ok("forceJpeg: browser re-encoded the PNG — derived JPEG stored, workerRanOn='derived'");
    });

    // ---- 4. PDF => saved + guided fallback ---------------------------------
    await inScenario("pdf-fallback", async (page) => {
      const before = sidecarSet();
      await uploadFiles(page, [
        { name: "scan-e2e.pdf", mimeType: "application/pdf", buffer: PLAIN_PDF("e2e-scan") },
      ]);
      await page.waitForSelector('[data-testid="upload-fallback"]', { timeout: 60_000 });
      assert(
        await page.isVisible('[data-testid="upload-fallback-code"]'),
        "manual-entry prefill input rendered"
      );
      ok("PDF => guided fallback card with manual entry");

      const sc = readSidecarByOrigName(before, "scan-e2e.pdf");
      assert(sc, "sidecar persisted");
      assert(sc.phase === "completed", "settled (no worker for a bare PDF)");
      assert(
        fs.existsSync(path.join(UPLOAD_DATA, sc.storedFile)) && sc.storedFile.endsWith(".pdf"),
        "original bytes stored as .pdf"
      );
      ok("PDF saved: bytes + sidecar persisted (the corpus point)");
    });

    // ---- 5. blurry 1×1 JPEG => saved + fallback -----------------------------
    await inScenario("blurry-fallback", async (page) => {
      const before = sidecarSet();
      const jpeg = await canvasBytes(page, "image/jpeg", 1, 1);
      await uploadFiles(page, [{ name: "blurry-e2e.jpg", mimeType: "image/jpeg", buffer: jpeg }]);
      await page.waitForSelector('[data-testid="upload-fallback"]', { timeout: 90_000 });
      ok("blurry 1×1 JPEG => guided fallback (real worker read nothing)");

      const sc = readSidecarByOrigName(before, "blurry-e2e.jpg");
      assert(sc, "sidecar persisted");
      assert(sc.phase === "completed", "settled completed");
      ok("blurry doc saved: sidecar persisted + settled");
    });

    // ---- 6. 4 rapid uploads => 429 countdown => all persisted ---------------
    await inScenario("rapid-4-uploads", async (page) => {
      const before = sidecarSet();
      await uploadFiles(
        page,
        [1, 2, 3, 4].map((n) => ({
          name: `burst-${n}.pdf`,
          mimeType: "application/pdf",
          buffer: PLAIN_PDF(`burst-${n}`),
        }))
      );
      // The 4th hits the per-IP burst cap (3) => keep-and-retry countdown.
      await page.waitForSelector('text=retrying automatically', { timeout: 60_000 });
      ok("4th rapid upload hit 429 — keep-and-retry countdown rendered");

      const fresh = await waitNewSidecars(before, 4, 90_000);
      const names = fresh
        .map((f) => JSON.parse(fs.readFileSync(path.join(UPLOAD_DATA, f), "utf-8")).origName)
        .sort();
      assert(
        JSON.stringify(names) ===
          JSON.stringify(["burst-1.pdf", "burst-2.pdf", "burst-3.pdf", "burst-4.pdf"]),
        `all four docs persisted (got ${names.join(", ")})`
      );
      ok("keep-and-retry: ALL 4 documents eventually persisted with zero re-selection");
    });

    // ---- 7. 11 MB => immediate friendly too-large error ---------------------
    await inScenario("too-large-11mb", async (page) => {
      const before = sidecarSet();
      await uploadFiles(page, [
        { name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(11 * 1024 * 1024, 0x20) },
      ]);
      await page.waitForSelector("text=This file is too large", { timeout: 30_000 });
      assert(newSidecars(before).length === 0, "nothing persisted for the refused file");
      ok("11 MB file => friendly too-large message, nothing uploaded/persisted");
    });

    console.log(`\nverify-upload-e2e: ${pass} assertions passed`);
  } finally {
    try {
      await browser?.close();
    } catch {}
    killTree(next);
    await new Promise((r) => eeMock.close(() => r()));
  }
}

main().catch((e) => {
  console.error("\n[e2e] FAILED:", e);
  process.exitCode = 1;
});
