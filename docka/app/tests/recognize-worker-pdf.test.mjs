// Worker PDF e2e (pdf-verify plan, v1 test plan item 1) — spawns the REAL
// recognition worker (pdfjs-dist + @napi-rs/canvas + tesseract) against the
// committed synthetic PDF fixtures in tests/fixtures/verify-upload/.
//
// SLOW (~30-60s: two full raster+OCR passes over the 2-page specimen) and
// therefore DELIBERATELY NOT in `npm test` — it runs via `npm run
// test:registry` (or standalone). Fixtures come from
// scripts/generate-pdf-specimens.mjs; regenerate them AFTER any UA-MARAD
// keyword change (B3 sequencing: keywords → country specimens → these PDFs).
//
// Run: node --test tests/recognize-worker-pdf.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");
const WORKER = path.join(APP, "scripts", "recognize-worker.mjs");
const FIX = path.join(__dirname, "fixtures", "verify-upload");

function runWorker(file, args = []) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    execFile(
      process.execPath,
      [WORKER, file, ...args],
      { cwd: APP, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ms = Date.now() - t0;
        // Contract: the worker ALWAYS exits 0 with a single JSON line.
        if (err) return reject(new Error(`worker exited abnormally: ${err.message}\n${stderr}`));
        try {
          resolve({ result: JSON.parse(String(stdout).trim()), ms, stderr: String(stderr) });
        } catch (e) {
          reject(new Error(`unparseable worker stdout (${e.message}): ${String(stdout).slice(0, 200)}`));
        }
      }
    );
  });
}

const fixture = (name) => path.join(FIX, name);

// Case-folded, whitespace-collapsed keyword probe over the union text.
const flat = (r) => r.ocrTextAll.toUpperCase().replace(/\s+/g, " ");
const hasAzKeyword = (r) =>
  flat(r).includes("STATE MARITIME AND PORT AGENCY") || flat(r).includes("REPUBLIC OF AZERBAIJAN");
const fallbackLines = (stderr) =>
  String(stderr)
    .split("\n")
    .filter((l) => l.includes("orientation fallback"));

test("ua-scan-specimen.pdf: 2 image-only pages raster+OCR; keywords survive", async () => {
  const { result: r, ms } = await runWorker(fixture("ua-scan-specimen.pdf"));
  console.log(`  ua-scan-specimen: ${ms}ms, ocr ${r.ocrTextAll.length} ch`);
  assert.equal(r.pages, 2);
  assert.equal(r.pagesProcessed, 2);
  assert.equal(r.pagesOcred, 2);
  assert.equal(r.skipReason, null);
  assert.equal(r.textLayerChars, 0, "image-only: no text layer");
  assert.ok(r.ocrText.trim().length > 0, "non-empty OCR text");
  const up = r.ocrTextAll.toUpperCase();
  assert.ok(
    up.includes("GOVERNMENT OF UKRAINE") || up.includes("SHIPPING ADMINISTRATION"),
    `UA-MARAD keyword must survive OCR of the rendered specimen; got: ${up.slice(0, 300)}`
  );
  // az-adapter plan A1 regression guard: the orientation fallback is
  // INVISIBLE for upright documents (score > 0 on the first read).
  assert.equal(r.orientFallbackPages, 0, "upright pages never fire the fallback");
});

// ---- az-adapter plan A1: PDF-page orientation fallback -----------------------

test("az-sideways-specimen.pdf: fallback recovers the rotated page (AZ keyword in ocrTextAll)", async () => {
  const { result: r, ms, stderr } = await runWorker(fixture("az-sideways-specimen.pdf"));
  console.log(`  az-sideways: ${ms}ms, fallback pages ${r.orientFallbackPages}`);
  assert.equal(r.pages, 1);
  assert.equal(r.pagesOcred, 1);
  assert.equal(r.skipReason, null);
  assert.ok(r.orientFallbackPages >= 1, "fallback fired on the sideways page");
  assert.ok(hasAzKeyword(r), `AZ keyword must survive via the rotation winner; got: ${flat(r).slice(0, 300)}`);
  const lines = fallbackLines(stderr);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /probes=\d+ winner=(90|180|270)/, "diagnostic line names a winner rotation");
});

test("az-blank-then-sideways.pdf: blank page short-circuits WITHOUT consuming a slot (cap decoupled from counter)", async () => {
  const { result: r, stderr } = await runWorker(fixture("az-blank-then-sideways.pdf"));
  assert.equal(r.pages, 2);
  assert.equal(r.pagesOcred, 2);
  // BOTH pages count in the telemetry (fallback fired on each)...
  assert.equal(r.orientFallbackPages, 2, "blank page still counted (telemetry truthful)");
  const lines = fallbackLines(stderr);
  assert.equal(lines.length, 2);
  // ...but the blank page stopped after ONE probe (short-circuit)...
  assert.match(lines[0], /page 1 .*probes=1 winner=none/, "blank page: exactly one 90° probe, no winner");
  // ...and consumed NO slot — the LATER sideways page still got its full
  // fallback and its rotated text landed (the round-2 cap-decoupling pin).
  assert.match(lines[1], /page 2 .*probes=3 winner=(90|180|270)/, "sideways page after the blank still gets its full fallback");
  assert.ok(hasAzKeyword(r), "the sideways page's rotated read reached ocrTextAll");
});

test("az-three-sideways.pdf: slot cap consumed by the first 2 pages; page 3 keeps upright text; honest counts", async () => {
  const { result: r, stderr } = await runWorker(fixture("az-three-sideways.pdf"));
  assert.equal(r.pages, 3);
  assert.equal(r.pagesOcred, 3, "every page still OCRed upright");
  assert.equal(r.skipReason, null);
  // Cap: only 2 slots — pages 1-2 fire, the capped-out page 3 neither probes
  // nor increments (capped-out zero-score pages keep their upright text).
  assert.equal(r.orientFallbackPages, 2, "cap enforced — page 3 not counted");
  const lines = fallbackLines(stderr);
  assert.equal(lines.length, 2, "no fallback diagnostic for the capped-out page");
  assert.match(lines[0], /page 1 /);
  assert.match(lines[1], /page 2 /);
  assert.ok(hasAzKeyword(r), "recovered pages' keywords present");
  assert.equal(typeof r.ocrText, "string", "valid JSON contract intact");
});

test("az-token-upright.pdf: all probes zero -> original upright text survives untouched (token in ocrTextAll)", async () => {
  const { result: r, stderr } = await runWorker(fixture("az-token-upright.pdf"));
  assert.equal(r.pages, 1);
  assert.equal(r.orientFallbackPages, 1, "zero ORIENT_WORDS upright -> fallback fires");
  const lines = fallbackLines(stderr);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /winner=none/, "no rotation scored — honest none");
  assert.ok(
    r.ocrTextAll.includes("123456/24"),
    `the upright read's code token must survive; got: ${flat(r).slice(0, 300)}`
  );
});

test("az-mixed-orientation.pdf: rotation wins, yet the upright read's token is RETAINED via extraTexts (silent-data-loss guard)", async () => {
  const { result: r, stderr } = await runWorker(fixture("az-mixed-orientation.pdf"));
  assert.equal(r.pages, 1);
  assert.equal(r.orientFallbackPages, 1);
  const lines = fallbackLines(stderr);
  assert.match(lines[0], /winner=(90|180|270)/, "the rotated vocabulary block wins the probe");
  // The winner read replaced pageTexts — but the ONLY readable code token
  // lives in the discarded-from-pageTexts upright read; extraTexts joins it
  // into ocrTextAll (plan A1 point 4 — never discard the upright read).
  assert.ok(
    r.ocrTextAll.includes("123456/24"),
    `upright token must still be present via extraTexts; got: ${flat(r).slice(0, 400)}`
  );
});

test("az-sideways + --ocr-budget-ms=1: budget stops before any OCR — zero pages, zero fallback, valid JSON", async () => {
  const { result: r } = await runWorker(fixture("az-sideways-specimen.pdf"), ["--ocr-budget-ms=1"]);
  assert.equal(r.pages, 1);
  assert.equal(r.pagesOcred, 0, "budget expired before the page loop");
  assert.equal(r.orientFallbackPages, 0);
  assert.equal(typeof r.ocrText, "string", "contract intact under the budget path");
});

test("az-sideways + mid-range budget: budget may die inside the fallback — always exit 0, valid JSON, honest counts", async () => {
  // The budget boundary between the winning probe and the full re-OCR cannot
  // be injected deterministically (wall-clock seam) — this run lands the
  // budget somewhere inside the upright-OCR/probe/re-OCR sequence and pins
  // the invariants that must hold WHEREVER it dies: valid JSON, exit 0,
  // counts consistent, and any kept text is honest (probe text fallback).
  const { result: r, stderr } = await runWorker(fixture("az-sideways-specimen.pdf"), [
    "--ocr-budget-ms=4500",
  ]);
  assert.equal(r.pages, 1);
  assert.ok(r.pagesOcred === 0 || r.pagesOcred === 1, "0 or 1 pages, never fabricated");
  assert.ok(
    (r.orientFallbackPages ?? 0) <= (r.pagesOcred ?? 0),
    "fallback count never exceeds OCRed pages"
  );
  assert.equal(typeof r.ocrTextAll, "string", "valid JSON contract intact");
  if (r.orientFallbackPages === 1) {
    assert.match(fallbackLines(stderr)[0], /probes=\d+/, "probe count reported honestly");
  }
});

test("text-layer.pdf: born-digital fast path — no OCR, short runtime", async () => {
  const { result: r, ms } = await runWorker(fixture("text-layer.pdf"));
  console.log(`  text-layer: ${ms}ms`);
  assert.equal(r.pages, 1);
  assert.ok(r.textLayerChars > 200, `text layer read (${r.textLayerChars} ch)`);
  assert.equal(r.pagesOcred, 0, "fast path: OCR skipped");
  assert.ok(r.ocrTextAll.includes("BORN-DIGITAL"), "layer text surfaced as ocrTextAll");
  assert.ok(ms < 15_000, `fast path must be quick (took ${ms}ms)`);
});

test("text-layer-junk.pdf: fast path without --force-ocr; OCR with it", async () => {
  const plain = await runWorker(fixture("text-layer-junk.pdf"));
  assert.ok(plain.result.textLayerChars >= 250, "junk layer present");
  assert.equal(plain.result.pagesOcred, 0, "fast path taken without the flag");
  assert.ok(plain.result.ocrTextAll.includes("lorem-ipsum-watermark"));

  const forced = await runWorker(fixture("text-layer-junk.pdf"), ["--force-ocr"]);
  console.log(`  junk --force-ocr: ${forced.ms}ms`);
  assert.ok(forced.result.pagesOcred > 0, "--force-ocr rasters + OCRs the pages");
  const up = forced.result.ocrTextAll.toUpperCase();
  assert.ok(
    up.includes("GOVERNMENT OF UKRAINE") || up.includes("SHIPPING ADMINISTRATION"),
    "raster text present in ocrTextAll under --force-ocr"
  );
  assert.ok(
    forced.result.ocrTextAll.includes("lorem-ipsum-watermark"),
    "partial text-layer fragments still ride along in the union"
  );
});

test("--ocr-budget-ms=1: budget path yields partial pages, exit 0, valid JSON", async () => {
  const { result: r } = await runWorker(fixture("ua-scan-specimen.pdf"), ["--ocr-budget-ms=1"]);
  assert.equal(r.pages, 2);
  assert.ok(
    (r.pagesOcred ?? 0) < r.pagesProcessed,
    `budget must stop the loop early (ocred ${r.pagesOcred}/${r.pagesProcessed})`
  );
  assert.equal(typeof r.ocrText, "string", "contract intact under the budget path");
});

test("--max-pages=1: page cap respected, total page count still reported", async () => {
  const { result: r } = await runWorker(fixture("ua-scan-specimen.pdf"), ["--max-pages=1"]);
  assert.equal(r.pages, 2, "total pages reported");
  assert.equal(r.pagesProcessed, 1, "cap respected");
  assert.equal(r.pagesOcred, 1);
});

test("encrypted.pdf → skipReason pdf-encrypted, exit 0, valid JSON", async () => {
  const { result: r } = await runWorker(fixture("encrypted.pdf"));
  assert.equal(r.skipReason, "pdf-encrypted");
  assert.equal(r.ocrTextAll, "");
});

test("zero-page.pdf → skipReason pdf-no-pages, exit 0, valid JSON", async () => {
  const { result: r } = await runWorker(fixture("zero-page.pdf"));
  assert.equal(r.skipReason, "pdf-no-pages");
});

test("truncated bytes → skipReason pdf-parse-error, exit 0, valid JSON", async () => {
  const tmp = path.join(os.tmpdir(), `docka-truncated-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, Buffer.from("%PDF-1.4\n1 0 obj\n<< garbage", "latin1"));
  try {
    const { result: r } = await runWorker(tmp);
    assert.equal(r.skipReason, "pdf-parse-error");
    assert.equal(r.qrText, null);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
