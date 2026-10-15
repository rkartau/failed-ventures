// PDF test-specimen generator (pdf-verify plan, v1 test plan item 1).
//
// Builds the committed synthetic PDFs in tests/fixtures/verify-upload/ that
// tests/recognize-worker-pdf.test.mjs feeds to the REAL recognition worker:
//
//   ua-scan-specimen.pdf   image-only 2-page PDF built from the REGENERATED
//                          UA-MARAD Playwright specimen JPEG (B3 sequencing:
//                          countries.ts keywords land → specimens regenerate →
//                          THIS pdf is built; NEVER the incident PDF — PII).
//   az-sideways-specimen.pdf   the AZ specimen JPEG pixel-rotated 90° — the
//                          orientation-fallback happy-path fixture (NEVER the
//                          operator's sample — PII).
//   az-blank-then-sideways.pdf blank page FIRST, sideways AZ page second —
//                          the round-2 cap-decoupling pin (the blank page's
//                          short-circuited fallback consumes NO slot, so the
//                          later sideways page still gets its full fallback).
//   az-three-sideways.pdf  3 sideways AZ pages — the slot-cap fixture (cap
//                          consumed by the first 2; page 3 keeps upright text).
//   az-token-upright.pdf   Playwright-rendered upright card with a synthetic
//                          code token and ZERO ORIENT_WORDS vocabulary — the
//                          all-probes-zero fixture (upright text survives).
//   az-mixed-orientation.pdf   upright token line + 90°-rotated English cert
//                          vocabulary in ONE image — the silent-data-loss
//                          guard fixture (a rotation wins, and the upright
//                          read's token must still surface via extraTexts).
//   text-layer.pdf         born-digital text PDF (>200 chars) — the fast-path
//                          fixture; ALSO the on-box deploy-gate render target.
//   text-layer-junk.pdf    >=250 chars of JUNK text layer OVER scanned-image
//                          pages — the --force-ocr escape-hatch fixture.
//   encrypted.pdf          standard-security-handler /Encrypt with random O/U
//                          (empty user password fails) → skipReason
//                          pdf-encrypted.
//   zero-page.pdf          valid xref, /Pages /Count 0 → pdf-no-pages.
//
// The PDF writer below is deliberately tiny and dependency-free (objects +
// xref by hand; JPEGs embed verbatim via DCTDecode). Rendering-side checks
// happen through the same pdfjs-dist + @napi-rs/canvas stack the worker uses.
//
// Run:  node scripts/generate-pdf-specimens.mjs        (from app/)

import { register } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("../tests/_ts-alias-hooks.mjs", import.meta.url);

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PDF_FIXTURES_DIR = path.join(APP_ROOT, "tests", "fixtures", "verify-upload");
const SPECIMENS_DIR = path.join(APP_ROOT, "tests", "fixtures", "verify-upload-specimens");

// ---- Minimal PDF writer ------------------------------------------------------

class PdfBuilder {
  constructor() {
    this.objects = []; // 1-based; each entry: Buffer of the object BODY
  }
  add(body) {
    this.objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"));
    return this.objects.length; // object number
  }
  stream(dict, data) {
    return this.add(
      Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"),
        data,
        Buffer.from("\nendstream", "latin1"),
      ])
    );
  }
  build(rootRef, extraTrailer = "") {
    const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets = [0];
    let pos = chunks[0].length;
    this.objects.forEach((body, i) => {
      offsets.push(pos);
      const obj = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
        body,
        Buffer.from("\nendobj\n", "latin1"),
      ]);
      chunks.push(obj);
      pos += obj.length;
    });
    const xrefPos = pos;
    let xref = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= this.objects.length; i++) {
      xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootRef} 0 R ${extraTrailer} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(chunks);
  }
}

function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker in JPEG");
}

const escText = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// A4 in points.
const PAGE_W = 595;
const PAGE_H = 842;

/**
 * Pixel-rotate a JPEG 90° clockwise via jpeg-js (same decode/encode stack the
 * worker uses) — the "sideways scan" step for the orientation-fallback
 * fixtures. Lossless pixel copy, re-encoded at q90.
 */
export async function rotateJpeg90(jpegBuf) {
  const jpeg = (await import("jpeg-js")).default;
  const raw = jpeg.decode(jpegBuf, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const { data, width: w, height: h } = raw;
  const nw = h;
  const nh = w;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (x * nw + (h - 1 - y)) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return jpeg.encode({ data: Buffer.from(out.buffer), width: nw, height: nh }, 90).data;
}

/**
 * Mixed page list: each entry is a JPEG buffer (image page) or null (an
 * EMPTY page — no content stream; renders blank, the blank-short-circuit
 * fixture ingredient).
 */
export function buildPagesPdf(pageJpegs) {
  const b = new PdfBuilder();
  const pagesId = b.add("PLACEHOLDER");
  const kidIds = [];
  for (const jpegBuf of pageJpegs) {
    if (!jpegBuf) {
      const contentId = b.stream("", Buffer.from("", "latin1"));
      kidIds.push(
        b.add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R >>`
        )
      );
      continue;
    }
    const { width: iw, height: ih } = jpegDims(jpegBuf);
    const imgId = b.stream(
      `/Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpegBuf
    );
    const drawW = PAGE_W;
    const drawH = Math.round((PAGE_W * ih) / iw);
    const content = `q ${drawW} 0 0 ${drawH} 0 ${PAGE_H - drawH} cm /Im1 Do Q\n`;
    const contentId = b.stream("", Buffer.from(content, "latin1"));
    kidIds.push(
      b.add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im1 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
    );
  }
  b.objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Count ${kidIds.length} /Kids [${kidIds.map((k) => `${k} 0 R`).join(" ")}] >>`,
    "latin1"
  );
  const rootId = b.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return b.build(rootId);
}

/** Image-only pages (optionally with a junk text layer on top). */
export function buildImagePdf(jpegBuf, pageCount, junkTextLines = null) {
  const { width: iw, height: ih } = jpegDims(jpegBuf);
  const b = new PdfBuilder();
  const pagesId = b.add("PLACEHOLDER"); // patched below via known object order
  const kidIds = [];
  for (let p = 0; p < pageCount; p++) {
    const imgId = b.stream(
      `/Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpegBuf
    );
    // Fit the image to the page width, top-aligned (like a scanned card).
    const drawW = PAGE_W;
    const drawH = Math.round((PAGE_W * ih) / iw);
    let content = `q ${drawW} 0 0 ${drawH} 0 ${PAGE_H - drawH} cm /Im1 Do Q\n`;
    let fontRes = "";
    if (junkTextLines) {
      // Junk text layer UNDERNEATH-ish (drawn after, small, in the margin):
      // pdfjs getTextContent reads it regardless of visual placement.
      content += "BT /F1 8 Tf 20 40 Td 9 TL\n";
      for (const line of junkTextLines) content += `(${escText(line)}) Tj T*\n`;
      content += "ET\n";
      fontRes = " /Font << /F1 " + "FONTREF" + " >>";
    }
    const contentId = b.stream("", Buffer.from(content, "latin1"));
    const resources = junkTextLines
      ? `/XObject << /Im1 ${imgId} 0 R >> /Font << /F1 FONT_ID 0 R >>`
      : `/XObject << /Im1 ${imgId} 0 R >>`;
    const pageId = b.add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << ${resources} >> /Contents ${contentId} 0 R >>`
    );
    kidIds.push(pageId);
    void fontRes;
  }
  let fontId = null;
  if (junkTextLines) {
    fontId = b.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    // Patch the FONT_ID placeholders now that the id exists.
    for (const kid of kidIds) {
      b.objects[kid - 1] = Buffer.from(
        b.objects[kid - 1].toString("latin1").replace("FONT_ID", String(fontId)),
        "latin1"
      );
    }
  }
  b.objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Count ${kidIds.length} /Kids [${kidIds.map((k) => `${k} 0 R`).join(" ")}] >>`,
    "latin1"
  );
  const rootId = b.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return b.build(rootId);
}

/** Born-digital text-only PDF (single page). */
export function buildTextPdf(lines) {
  const b = new PdfBuilder();
  const pagesId = b.add("PLACEHOLDER");
  const fontId = b.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let content = "BT /F1 12 Tf 50 780 Td 16 TL\n";
  for (const line of lines) content += `(${escText(line)}) Tj T*\n`;
  content += "ET\n";
  const contentId = b.stream("", Buffer.from(content, "latin1"));
  const pageId = b.add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
  );
  b.objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`,
    "latin1"
  );
  const rootId = b.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return b.build(rootId);
}

/** Valid structure, zero pages. */
export function buildZeroPagePdf() {
  const b = new PdfBuilder();
  const pagesId = b.add("<< /Type /Pages /Count 0 /Kids [] >>");
  const rootId = b.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return b.build(rootId);
}

/**
 * Standard-security-handler /Encrypt with RANDOM /O and /U: pdfjs validates
 * the empty user password against /U, fails, and throws PasswordException —
 * exactly the pdf-encrypted skip path. (Not a decryptable document.)
 */
export function buildEncryptedPdf() {
  const b = new PdfBuilder();
  const pagesId = b.add("PLACEHOLDER");
  const contentId = b.stream("", Buffer.from("BT ET\n", "latin1"));
  const pageId = b.add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R >>`
  );
  b.objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`,
    "latin1"
  );
  const rootId = b.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const hex = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();
  const encId = b.add(
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(32)}> /U <${hex(32)}> /P -44 >>`
  );
  const fileId = hex(16);
  return b.build(rootId, `/Encrypt ${encId} 0 R /ID [<${fileId}> <${fileId}>]`);
}

// ---- generation --------------------------------------------------------------

const JUNK_LINES = [
  "lorem-ipsum-watermark scanner-metadata page-header footer-noise",
  "dolor sit amet consectetur adipiscing elit sed do eiusmod tempor",
  "incididunt ut labore et dolore magna aliqua ut enim ad minim veniam",
  "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea",
  "commodo consequat duis aute irure dolor in reprehenderit in voluptate",
];

const TEXT_LINES = [
  "TEST SPECIMEN - BORN-DIGITAL PDF - FOR SYSTEM VALIDATION ONLY",
  "This synthetic document exists to exercise the recognition worker's",
  "text-layer fast path: a PDF whose pages carry a real extractable text",
  "layer must answer in milliseconds without any rasterization or OCR.",
  "It is also the on-box deploy-gate render target (see v1 deploy notes).",
  "Nothing here matches any registry keyword or code pattern on purpose.",
];

// ---- AZ orientation-fallback worker cards (Playwright-rendered) --------------
//
// Synthetic values ONLY (123456/24 = the mock AZ_VALID code) — never the
// operator's sample or its number. The token card avoids EVERY ORIENT_WORD so
// its upright OCR scores zero and the fallback fires; the mixed card adds a
// 90°-rotated block of English certificate vocabulary so a rotation WINS while
// the upright read still holds the only readable token (extraTexts guard).

const AZ_TOKEN_LINES = ["DOKUMENT NR: 123456/24", "SYNTHETIC WORKER SPECIMEN"];
const AZ_ROTATED_VOCAB =
  "CERTIFICATE OF COMPETENCY MARITIME TRAINING SAFETY SEAFARER " +
  "CERTIFICATE VALID ISSUED HOLDER DATE EXPIRY COMPETENCY MARITIME";

function buildAzTokenCardHtml(withRotatedVocab) {
  const vocab = withRotatedVocab
    ? `<div style="margin-top:60px; display:flex; justify-content:center;">
         <div style="transform: rotate(90deg); transform-origin: center;
                     width: 560px; font-size: 46px; font-weight: bold;
                     line-height: 1.5; text-align: center; letter-spacing: 1px;">
           ${AZ_ROTATED_VOCAB}
         </div>
       </div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  .card { width: 1200px; ${withRotatedVocab ? "height: 1000px;" : ""} box-sizing: border-box; padding: 56px 64px; border: 6px double #333; }
  .tok { font-family: "Courier New", monospace; font-size: 52px; font-weight: bold; letter-spacing: 3px; text-align: center; }
  .sub { font-size: 34px; text-align: center; margin-top: 18px; letter-spacing: 2px; }
</style></head><body>
  <div class="card">
    <div class="tok">${AZ_TOKEN_LINES[0]}</div>
    <div class="sub">${AZ_TOKEN_LINES[1]}</div>
    ${vocab}
  </div>
</body></html>`;
}

async function renderAzWorkerCards(log) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
    const shots = {};
    for (const [name, html] of [
      ["az-token-upright.jpg", buildAzTokenCardHtml(false)],
      ["az-mixed-orientation.jpg", buildAzTokenCardHtml(true)],
    ]) {
      await page.setContent(html, { waitUntil: "load" });
      const buf = await page.locator(".card").screenshot({ type: "jpeg", quality: 90 });
      shots[name] = buf;
      log(`${name} rendered ${buf.length} bytes`);
    }
    return shots;
  } finally {
    await browser.close();
  }
}

export async function generateAllPdfSpecimens({ log = () => {} } = {}) {
  fs.mkdirSync(PDF_FIXTURES_DIR, { recursive: true });

  // The UA-MARAD + AZ specimen JPEGs — REGENERATED (B3 sequencing) if absent.
  const uaJpegPath = path.join(SPECIMENS_DIR, "UA-MARAD.jpg");
  const azJpegPath = path.join(SPECIMENS_DIR, "AZ.jpg");
  if (!fs.existsSync(uaJpegPath) || !fs.existsSync(azJpegPath)) {
    const { generateAll } = await import("./generate-country-specimens.mjs");
    await generateAll();
  }
  const uaJpeg = fs.readFileSync(uaJpegPath);
  const azJpeg = fs.readFileSync(azJpegPath);
  const azSideways = await rotateJpeg90(azJpeg);
  const azCards = await renderAzWorkerCards(log);

  const out = {
    "ua-scan-specimen.pdf": buildImagePdf(uaJpeg, 2),
    "text-layer.pdf": buildTextPdf(TEXT_LINES),
    "text-layer-junk.pdf": buildImagePdf(uaJpeg, 2, JUNK_LINES),
    "encrypted.pdf": buildEncryptedPdf(),
    "zero-page.pdf": buildZeroPagePdf(),
    "az-sideways-specimen.pdf": buildPagesPdf([azSideways]),
    "az-blank-then-sideways.pdf": buildPagesPdf([null, azSideways]),
    "az-three-sideways.pdf": buildPagesPdf([azSideways, azSideways, azSideways]),
    "az-token-upright.pdf": buildPagesPdf([azCards["az-token-upright.jpg"]]),
    "az-mixed-orientation.pdf": buildPagesPdf([azCards["az-mixed-orientation.jpg"]]),
  };
  const written = [];
  for (const [name, buf] of Object.entries(out)) {
    const file = path.join(PDF_FIXTURES_DIR, name);
    fs.writeFileSync(file, buf);
    written.push({ name, file, size: buf.length });
    log(`${name}  ${buf.length} bytes`);
  }
  return written;
}

// ---- CLI ---------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const written = await generateAllPdfSpecimens({ log: (m) => console.log("  " + m) });
  console.log(`\nGenerated ${written.length} PDF specimens in ${PDF_FIXTURES_DIR}`);
}
