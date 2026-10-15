// Standalone recognition worker — runs as its OWN Node process, spawned by the
// document-upload route. Kept out of the Next.js webpack bundle on purpose:
// bundling tesseract.js breaks its worker_threads worker and hangs recognition.
// Here it is a plain Node process (like a CLI), so the native/wasm entrypoints
// resolve normally from node_modules.
//
// It does ONLY the things that need these heavy libraries:
//   1. decode a QR out of a JPEG frame or a rendered PDF page (jpeg-js + jsQR)
//   2. OCR the image / PDF pages to raw text                  (tesseract.js)
//   3. open + rasterize PDFs (pdfjs-dist legacy + @napi-rs/canvas — both
//      lazy-imported INSIDE the PDF branch only, never in the Next bundle)
// All interpretation (code extraction, live verification, field parsing) stays
// in the TypeScript libs on the route side.
//
// Usage:   node scripts/recognize-worker.mjs "<absolute-file-path>"
//              [--ocr-budget-ms=N] [--max-pages=N] [--force-ocr]
//   --ocr-budget-ms  soft budget gating the WHOLE per-page PDF loop (raster
//                    included); absent = no soft budget (admin/auth semantics)
//   --max-pages      PDF page cap (default 8 = admin; the anon lane passes 4)
//   --force-ocr      skip the born-digital text-layer fast path and OCR the
//                    rasterized pages regardless (the no-signal escape hatch)
// Output:  a single JSON line on stdout:
//   { qrText, ocrText, ocrTextAll,
//     pages?, pagesProcessed?, pagesOcred?, textLayerChars?, skipReason? }
// Diagnostics go to STDERR only — stdout is the JSON contract. The process
// ALWAYS exits 0.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The app ships eng.traineddata in its root (one level up from scripts/). Point
// tesseract at that LOCAL copy instead of letting it fetch the language data
// from a CDN on every run. On a ship link the download is slow/flaky, and — the
// real cause behind "half my photos read nothing" — several uploads recognising
// at once each raced to fetch/cache the same lang file and silently came back
// empty. A local, read-only file removes that dependency entirely. gzip:false
// because the shipped file is the plain (uncompressed) .traineddata.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANG_PATH = path.resolve(HERE, "..").split(path.sep).join("/");

async function makeOcrWorker() {
  const { createWorker } = await import("tesseract.js");
  return createWorker("eng", 1, {
    langPath: LANG_PATH,
    gzip: false,
    logger: () => {},
  });
}

// Cap the longest edge fed to OCR. Phone photos are ~2000–3000px; tesseract's
// cost scales with pixel count, and text on a certificate is still legible at
// ~1400px, so downscaling roughly halves OCR time with no loss of readable text
// (a 4.7 MB photo drops from ~8 s to ~4 s). QR decoding still uses full res.
const OCR_MAX_DIM = 1400;

// Phone photos of paper certificates are very often rotated 90°/180°/270° (the
// seaman lays the landscape certificate down and snaps it in portrait). Tesseract
// does NOT auto-correct a 90° turn, so a sideways certificate OCRs to pure noise
// and the whole photo path reads nothing. To fix this we OCR at all four
// orientations and keep the one whose text looks most like a real certificate.
// The probe pass runs at a small size (fast, just enough to pick the winner),
// then the winning orientation is re-OCR'd at full quality for the field read.
const ORIENT_PROBE_DIM = 700;

// Real certificate vocabulary (English + Estonian) used to score an orientation:
// upright text hits many of these words, sideways noise hits almost none.
const ORIENT_WORDS =
  /\b(certificate|proficiency|fire|fighting|prevention|medical|training|survival|safety|first\s*aid|seafarer|tallinn|maritime|academy|estonian|university|surname|given|name|date|expiry|expires|valid|issue|issued|holder|competency|endorsement|passport|security|tanker|radio|gmdss|convention|standards|watchkeeping|tuletõrje|meremees|meremeeste|tunnistus|kehtib|kehtiv|nimi|ohutus|esmaabi|pädevus)\b/gi;

// Rotate a decoded RGBA frame 90° clockwise. Cheap pixel copy (no libs), so we
// can derive all four orientations from a single JPEG decode.
function rotate90(raw) {
  const { data, width: w, height: h } = raw;
  const nw = h;
  const nh = w;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const nx = h - 1 - y;
      const ny = x;
      const di = (ny * nw + nx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return { data: Buffer.from(out.buffer), width: nw, height: nh };
}

function orientationScore(text) {
  return (String(text || "").match(ORIENT_WORDS) || []).length;
}

// Decode a JPEG once (shared by QR + OCR). Returns { data, width, height } or null.
async function decodeJpeg(buf) {
  try {
    const jpeg = (await import("jpeg-js")).default;
    return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  } catch {
    return null;
  }
}

function qrFromRaw(jsQR, raw) {
  try {
    const res = jsQR(new Uint8ClampedArray(raw.data.buffer), raw.width, raw.height);
    return res?.data ?? null;
  } catch {
    return null;
  }
}

// Nearest-neighbour downscale of a decoded frame to a re-encoded JPEG buffer.
async function downscaledJpeg(raw, maxDim) {
  const jpeg = (await import("jpeg-js")).default;
  const scale = Math.min(1, maxDim / Math.max(raw.width, raw.height));
  if (scale >= 1) return jpeg.encode(raw, 80).data;
  const nw = Math.round(raw.width * scale);
  const nh = Math.round(raw.height * scale);
  const out = new Uint8Array(nw * nh * 4);
  const src = raw.data;
  for (let y = 0; y < nh; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < nw; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * raw.width + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = 255;
    }
  }
  return jpeg.encode({ data: Buffer.from(out.buffer), width: nw, height: nh }, 80).data;
}

async function ocrImage(image) {
  try {
    const worker = await makeOcrWorker();
    const { data } = await worker.recognize(image);
    await worker.terminate();
    return data.text ?? "";
  } catch {
    return "";
  }
}

// OCR a decoded frame at whichever of the four 90° orientations reads best.
// One tesseract worker is reused for all passes. Falls back to the plain 0°
// read if anything goes wrong, so a paper photo is never left with zero text.
async function ocrBestOrientation(raw) {
  let worker;
  try {
    worker = await makeOcrWorker();
  } catch {
    return { text: "", allText: "" };
  }
  // Every non-empty pass we read, in ANY orientation. Title/keyword matching runs
  // over the UNION of these (see recognize.ts) so a certificate name that a single
  // noisy pass drops is still recovered from another pass — the fix for "OCR reads
  // the title on some photos but silently drops others of the same quality".
  const collected = [];
  try {
    const rots = [raw];
    for (let i = 0; i < 3; i++) rots.push(rotate90(rots[i]));

    // Probe pass: small + fast, just to pick the upright orientation.
    let best = { score: -1, idx: 0, text: "" };
    for (let i = 0; i < rots.length; i++) {
      let text = "";
      try {
        const small = await downscaledJpeg(rots[i], ORIENT_PROBE_DIM);
        const { data } = await worker.recognize(small);
        text = data.text ?? "";
      } catch {
        /* keep empty */
      }
      if (text.trim()) collected.push(text);
      const score = orientationScore(text);
      if (score > best.score) best = { score, idx: i, text };
    }

    // Re-OCR the winning orientation at full quality for accurate field reads
    // (titles, expiry dates). If the probe found no real words at all, this is
    // just the 0° frame and the result stays best-effort noise (→ caller falls
    // back to a numbered photo), which is the correct honest outcome.
    let winning = best.text;
    try {
      const big = await downscaledJpeg(rots[best.idx], OCR_MAX_DIM);
      const { data } = await worker.recognize(big);
      if ((data.text ?? "").trim()) winning = data.text;
    } catch {
      /* fall through to probe text */
    }
    // Winning full-res text FIRST (cleanest — name/expiry parse prefers it), then
    // every probe pass appended for maximum title/keyword recall.
    const allText = [winning, ...collected].filter(Boolean).join("\n");
    return { text: winning, allText };
  } finally {
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
  }
}

// ---- PDF branch (pdf-verify plan A2) ---------------------------------------
//
// pdfjs-dist (legacy build) + @napi-rs/canvas are lazy-imported HERE ONLY —
// an import failure (missing platform .node artifact on a half-broken box)
// degrades to skipReason "pdf-lib-missing" while image uploads keep working.

/** Anon/admin page caps arrive via --max-pages; 8 is the admin default. */
const MAX_PDF_PAGES_DEFAULT = 8;
/** Born-digital fast path: a text layer this long skips rasterization. */
const PDF_TEXT_LAYER_MIN = 200;
/**
 * Per-page raster clamp: SHORT-edge target (px). An A4 page rasters to
 * ≈1600×2263 ≈ 3.6MP (the Decision-2 arithmetic). B3-gate finding
 * (2026-08-24, incident PDF): the certificate card occupies only ~55% of the
 * scanned page, so at a 1600 LONG edge the printed keywords/number are below
 * tesseract's readable size — short-edge 1600 (long edge ~2263, still under
 * the 4MP cap) is the resolution at which the incident document's keywords,
 * code token and issue date all survive real OCR.
 */
const PDF_RASTER_MAX_DIM = 1600;
/** Per-page raster clamp: total pixels (the hard cap). */
const PDF_RASTER_MAX_PIXELS = 4_000_000;
/**
 * OCR input cap for PDF pages: the full clamped raster (≤4MP) goes to
 * tesseract — downscaling PDF pages to the photo path's 1400px would negate
 * the raster resolution the B3 gate requires. Photos keep OCR_MAX_DIM.
 */
const PDF_OCR_MAX_DIM = 2400;
/** MediaBox-bomb guard: pages with a pre-scale edge outside (0, 20000]pt skip. */
const PDF_MAX_PAGE_EDGE_PT = 20_000;
/**
 * PDF-page orientation fallback (az-adapter plan A1): per-document cap on the
 * number of pages that may run the FULL 90/180/270 probe set (+ winner
 * re-OCR). The cap counts SLOTS, decoupled from the orientFallbackPages
 * telemetry counter: a blank-short-circuited page (see ORIENT_BLANK_CHARS)
 * costs ~1-2s, not the ~10s of a full fallback, so it increments the counter
 * (the fallback DID fire) but consumes NO slot — blanks must never starve a
 * genuinely sideways page later in the document. Consequence:
 * orientFallbackPages can legitimately exceed this cap when blanks are present.
 */
const MAX_ORIENT_FALLBACK_PAGES = 2;
/**
 * Blank-page short-circuit threshold (non-whitespace chars). Deliberately LOW:
 * photo pages hallucinate >20 chars of OCR noise and therefore take the full
 * probe path (bounded by the slot cap + budget) — do NOT raise this constant,
 * or photo pages would start short-circuiting and a sideways photo-heavy cert
 * page could be skipped. Known documented sacrifice: a SPARSE page that is
 * genuinely 180/270-rotated (near-zero upright chars AND a near-zero 90 probe)
 * short-circuits and its rotation is never found — known loss; the admin
 * re-run recovers it.
 */
const ORIENT_BLANK_CHARS = 20;

// The two worker-local seams the PDF library touches (Decision 1 swappability):
// pdfExtractText (text-layer pass) + pdfRasterPages (render+QR+OCR loop).

async function pdfExtractText(doc, pageLimit) {
  const parts = [];
  for (let i = 1; i <= pageLimit; i++) {
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => it.str ?? "").join(" "));
    } catch {
      parts.push(""); // one broken page never kills the text pass
    }
  }
  return parts;
}

/**
 * Raster + QR + OCR over the processed pages. ONE tesseract worker for all
 * pages (Decision 5); a SINGLE-orientation OCR pass per page first (Decision
 * 4 — pdfjs applies /Rotate in the viewport, scans come out upright), then the
 * ORIENTATION FALLBACK (az-adapter plan A1, Decision 3) for pages whose
 * upright read scores ZERO orientation words: probe-OCR the 90/180/270
 * rotations at ORIENT_PROBE_DIM, re-OCR the winning rotation at full quality,
 * all inside the same soft budget that gates the WHOLE loop including
 * rasterization (Decision 6). The original upright read is NEVER discarded —
 * it rides along in `extraTexts` (silent-data-loss guard: orientationScore is
 * English-vocabulary, so an upright non-English page carrying a readable code
 * token scores 0, and a "winning" rotation of noise must not eat that token).
 */
async function pdfRasterPages(doc, canvasMod, opts) {
  const { pageLimit, budgetMs, startedAt } = opts;
  const pageTexts = [];
  // Retained non-winner reads: original upright full reads of pages whose
  // pageTexts entry was replaced by a rotation winner, plus every non-empty
  // probe text. Joined into ocrTextAll by processPdf.
  const extraTexts = [];
  let qrText = null;
  let pagesOcred = 0;
  let orientFallbackPages = 0; // telemetry: pages the fallback FIRED on
  let orientSlotsUsed = 0; // cap accounting: full-probe-set pages only
  let ocrWorker = null;
  try {
    for (let i = 1; i <= pageLimit; i++) {
      if (budgetMs && Date.now() - startedAt > budgetMs) {
        process.stderr.write(
          `[recognize-worker] pdf budget exhausted before page ${i} (${Date.now() - startedAt}ms > ${budgetMs}ms)\n`
        );
        break; // over budget → stop processing further pages entirely
      }
      let raw = null;
      try {
        const page = await doc.getPage(i);
        const v0 = page.getViewport({ scale: 1 });
        // MediaBox-bomb guard: degenerate/absurd pre-scale bounds skip the page.
        if (
          !(v0.width > 0) || !(v0.height > 0) ||
          v0.width > PDF_MAX_PAGE_EDGE_PT || v0.height > PDF_MAX_PAGE_EDGE_PT
        ) {
          process.stderr.write(`[recognize-worker] pdf page ${i} degenerate bounds ${v0.width}x${v0.height}pt — skipped\n`);
          continue;
        }
        const scale = Math.min(
          PDF_RASTER_MAX_DIM / Math.min(v0.width, v0.height),
          Math.sqrt(PDF_RASTER_MAX_PIXELS / (v0.width * v0.height))
        );
        const viewport = page.getViewport({ scale });
        const w = Math.max(1, Math.floor(viewport.width));
        const h = Math.max(1, Math.floor(viewport.height));
        const canvas = canvasMod.createCanvas(w, h);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        const img = ctx.getImageData(0, 0, w, h);
        raw = { data: Buffer.from(img.data.buffer), width: w, height: h };
      } catch (e) {
        process.stderr.write(`[recognize-worker] pdf page ${i} raster failed: ${e?.message ?? e}\n`);
        continue; // one hostile page never kills the rest
      }

      // QR on the full-res render, BEFORE the OCR downscale (extends QR
      // support to PDFs for free — orientation-independent finder patterns).
      if (!qrText) {
        try {
          const jsQR = (await import("jsqr")).default;
          qrText = qrFromRaw(jsQR, raw);
        } catch {
          /* QR failure is non-fatal */
        }
      }

      // Single-orientation OCR (upright by /Rotate), one shared worker.
      let uprightText = null;
      try {
        if (!ocrWorker) ocrWorker = await makeOcrWorker();
        const jpegBuf = await downscaledJpeg(raw, PDF_OCR_MAX_DIM);
        const { data } = await ocrWorker.recognize(jpegBuf);
        uprightText = data.text ?? "";
        pagesOcred++;
      } catch (e) {
        process.stderr.write(`[recognize-worker] pdf page ${i} ocr failed: ${e?.message ?? e}\n`);
        pageTexts.push("");
        continue;
      }

      // Orientation fallback (plan A1): a zero-score upright read on a page we
      // still hold the raster for, while a fallback SLOT remains. Capped-out
      // zero-score pages keep their upright text and increment nothing.
      let pageText = uprightText;
      if (orientationScore(uprightText) === 0 && orientSlotsUsed < MAX_ORIENT_FALLBACK_PAGES) {
        const overBudget = () => budgetMs && Date.now() - startedAt > budgetMs;
        const uprightBlank = uprightText.replace(/\s+/g, "").length < ORIENT_BLANK_CHARS;
        let probes = 0;
        let shortCircuited = false;
        let best = { score: 0, deg: 0, text: "", frame: null };
        let frame = raw;
        for (let deg = 90; deg <= 270; deg += 90) {
          if (overBudget()) break; // budget check BEFORE every probe pass
          frame = rotate90(frame);
          let text = "";
          try {
            const small = await downscaledJpeg(frame, ORIENT_PROBE_DIM);
            const { data } = await ocrWorker.recognize(small);
            text = data.text ?? "";
          } catch {
            /* keep empty */
          }
          probes++;
          if (text.trim()) extraTexts.push(text); // every non-empty probe retained
          const score = orientationScore(text);
          if (score > best.score) best = { score, deg, text, frame };
          // Blank-page short-circuit: upright near-zero AND the first (90)
          // probe near-zero -> skip the remaining 180/270 probes. Blank back
          // sides score 0 upright; without this a doc with blank sides burns
          // ~8-12s of the budget on noise.
          if (
            deg === 90 &&
            uprightBlank &&
            text.replace(/\s+/g, "").length < ORIENT_BLANK_CHARS
          ) {
            shortCircuited = true;
            break;
          }
        }
        orientFallbackPages++; // telemetry: the fallback fired on this page
        // Cap decoupled from counter: only a FULL probe set consumes a slot —
        // a short-circuited blank costs ~1-2s and must not starve a genuinely
        // sideways page later in the document.
        if (!shortCircuited) orientSlotsUsed++;
        let winnerLabel = "none";
        if (best.score > 0 && best.frame) {
          winnerLabel = String(best.deg);
          let winText = best.text;
          // Budget check between winning probe and full re-OCR: budget dead ->
          // keep the winning probe text (mirrors ocrBestOrientation).
          if (!overBudget()) {
            try {
              const big = await downscaledJpeg(best.frame, PDF_OCR_MAX_DIM);
              const { data } = await ocrWorker.recognize(big);
              if ((data.text ?? "").trim()) winText = data.text;
            } catch {
              /* fall through to probe text */
            }
          }
          // Winner replaces the page text; the original upright read is
          // RETAINED in extraTexts (never discarded — silent-data-loss guard).
          if (uprightText.trim()) extraTexts.push(uprightText);
          pageText = winText;
        }
        // All probes 0: pageText stays the original upright read (honest).
        // One stderr line per fallback page — page number, probes attempted,
        // winner rotation or "none". NO OCR text on stderr (PII rule).
        process.stderr.write(
          `[recognize-worker] pdf page ${i} orientation fallback: probes=${probes} winner=${winnerLabel}\n`
        );
      }
      pageTexts.push(pageText);
    }
  } finally {
    try {
      if (ocrWorker) await ocrWorker.terminate();
    } catch {
      /* ignore */
    }
  }
  return { pageTexts, qrText, pagesOcred, orientFallbackPages, extraTexts };
}

async function processPdf(filePath, { budgetMs, maxPages, forceOcr }) {
  const startedAt = Date.now();
  const out = {
    qrText: null,
    ocrText: "",
    ocrTextAll: "",
    pages: 0,
    pagesProcessed: 0,
    pagesOcred: 0,
    orientFallbackPages: 0,
    textLayerChars: 0,
    skipReason: null,
  };

  // BOTH lazy imports sit inside the PDF branch try/catch: a missing platform
  // .node artifact maps to its own skipReason instead of worker-crash noise.
  let pdfjs;
  let canvasMod;
  try {
    [pdfjs, canvasMod] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
  } catch (e) {
    process.stderr.write(`[recognize-worker] pdf libs failed to import: ${e?.message ?? e}\n`);
    out.skipReason = "pdf-lib-missing";
    return out;
  }

  let doc;
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    doc = await pdfjs.getDocument({
      data,
      // Hardening: no PostScript-function eval paths, no system font probing.
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
  } catch (e) {
    const name = e?.name ?? "";
    out.skipReason = name === "PasswordException" ? "pdf-encrypted" : "pdf-parse-error";
    process.stderr.write(`[recognize-worker] pdf open failed (${name || "unknown"}): ${e?.message ?? e}\n`);
    return out;
  }

  try {
    out.pages = doc.numPages;
    if (doc.numPages === 0) {
      out.skipReason = "pdf-no-pages";
      return out;
    }
    const pageLimit = Math.min(doc.numPages, maxPages);
    out.pagesProcessed = pageLimit;

    // 1. Text-layer pass first (Decision 3): born-digital PDFs answer in
    //    milliseconds. --force-ocr (the no-signal escape hatch) skips the
    //    fast path so a junk/watermark text layer can never mask the scan.
    const textParts = await pdfExtractText(doc, pageLimit);
    const layerText = textParts.join("\f");
    out.textLayerChars = layerText.trim().length;
    if (out.textLayerChars >= PDF_TEXT_LAYER_MIN && !forceOcr) {
      out.ocrText = layerText;
      out.ocrTextAll = layerText;
      process.stderr.write(
        `[recognize-worker] pdf pages=${out.pages} text-layer=${out.textLayerChars}ch fast-path elapsed=${Date.now() - startedAt}ms\n`
      );
      return out;
    }

    // 2. Raster + QR + OCR per page (budget-gated).
    const r = await pdfRasterPages(doc, canvasMod, { pageLimit, budgetMs, startedAt });
    out.qrText = r.qrText;
    out.pagesOcred = r.pagesOcred;
    out.orientFallbackPages = r.orientFallbackPages;
    out.ocrText = r.pageTexts.filter(Boolean).join("\f");
    // Any partial text-layer fragments still ride along in the union text, as
    // do the orientation fallback's retained upright/probe reads (extraTexts).
    // ORDERING IS LOAD-BEARING: winner reads FIRST, retained texts LAST — the
    // planner's first-token dedupe (enrichAZCandidates/enrichUAMARADCandidates)
    // keeps the FIRST occurrence of a code token, so the highest-quality read
    // must win the dedupe. Never reorder.
    out.ocrTextAll = [out.ocrText, out.textLayerChars > 0 ? layerText : "", ...r.extraTexts]
      .filter(Boolean)
      .join("\f");
    process.stderr.write(
      `[recognize-worker] pdf pages=${out.pages} raster=${PDF_RASTER_MAX_DIM}px ocr=${out.pagesOcred}/${out.pagesProcessed} orientFallback=${out.orientFallbackPages} elapsed=${Date.now() - startedAt}ms\n`
    );
    return out;
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ---- argv ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { filePath: null, budgetMs: 0, maxPages: MAX_PDF_PAGES_DEFAULT, forceOcr: false };
  for (const a of argv) {
    let m;
    if ((m = /^--ocr-budget-ms=(\d+)$/.exec(a))) args.budgetMs = Number(m[1]);
    else if ((m = /^--max-pages=(\d+)$/.exec(a))) args.maxPages = Math.max(1, Number(m[1]));
    else if (a === "--force-ocr") args.forceOcr = true;
    else if (args.filePath === null) args.filePath = a;
  }
  return args;
}

async function main() {
  const { filePath, budgetMs, maxPages, forceOcr } = parseArgs(process.argv.slice(2));
  if (!filePath || !fs.existsSync(filePath)) {
    process.stdout.write(JSON.stringify({ qrText: null, ocrText: "", ocrTextAll: "" }));
    return;
  }

  const isPdf = /\.pdf$/i.test(filePath);
  const isJpeg = /\.jpe?g$/i.test(filePath);
  const isImage = /\.(jpe?g|png|webp|gif|bmp)$/i.test(filePath);

  if (isPdf) {
    // Safe on extension alone: stored corpus files are named from SNIFFED
    // magic (verify-upload persist path), never from origName.
    const result = await processPdf(filePath, { budgetMs, maxPages, forceOcr });
    process.stdout.write(JSON.stringify(result));
    return;
  }

  let qrText = null;
  let ocrText = "";
  // Union of every OCR pass/orientation — the corpus title/keyword matching runs
  // over so a name read in one pass is never lost. Falls back to ocrText.
  let ocrTextAll = "";

  if (isJpeg) {
    // Decode once: QR needs full-res pixels; OCR tries all four orientations.
    const buf = fs.readFileSync(filePath);
    const raw = await decodeJpeg(buf);
    if (raw) {
      const jsQR = (await import("jsqr")).default;
      // QR is orientation-independent (finder patterns), so decode it at full
      // res up front; the multi-orientation OCR then runs on the same frame.
      qrText = qrFromRaw(jsQR, raw);
      const r = await ocrBestOrientation(raw);
      ocrText = r.text;
      ocrTextAll = r.allText || r.text;
    } else {
      ocrText = await ocrImage(filePath);
      ocrTextAll = ocrText;
    }
  } else if (isImage) {
    // Non-JPEG image: jpeg-js can't decode it, so OCR straight from the path.
    ocrText = await ocrImage(filePath);
    ocrTextAll = ocrText;
  }

  process.stdout.write(JSON.stringify({ qrText, ocrText, ocrTextAll }));
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`[recognize-worker] crashed: ${e?.message ?? e}\n`);
    process.stdout.write(
      JSON.stringify({ qrText: null, ocrText: "", ocrTextAll: "", skipReason: "worker-crash" })
    );
    process.exit(0);
  }
);
