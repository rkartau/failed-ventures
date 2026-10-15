// SEO WP-A — the ONE shared web-asset generator (plan v2 R6, v3 S9).
//
// Regenerates, deterministically from committed sources:
//   (a) app/favicon.ico                  PNG-in-ICO (16/32/48 px) rendered from app/icon.png
//   (b) public/samples/thumbs/<name>.webp 400 px-wide thumbnails of scripts/sample-fixtures/*.jpg
//   (c) public/screenshots/<name>-640.webp 640 px-wide variants of public/screenshots/*.webp
//   (d) lib/sample-thumbs-manifest.ts     const array of thumb basenames (no JSON loader needed)
//
// Everything it writes is a static public asset that is COMMITTED — run it locally,
// commit the outputs. It is not part of the build. Uses @napi-rs/canvas only (already a
// dependency; it decodes JPEG/PNG/WebP and encodes PNG/WebP/JPEG natively — no sharp).
//
// Run (from app/):  node scripts/generate-web-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

const ICON_SRC = path.join(APP_ROOT, "app", "icon.png");
const FAVICON_OUT = path.join(APP_ROOT, "app", "favicon.ico");
const FIXTURES_DIR = path.join(APP_ROOT, "scripts", "sample-fixtures");
const THUMBS_DIR = path.join(APP_ROOT, "public", "samples", "thumbs");
const SCREENSHOTS_DIR = path.join(APP_ROOT, "public", "screenshots");
const MANIFEST_OUT = path.join(APP_ROOT, "lib", "sample-thumbs-manifest.ts");

const THUMB_WIDTH = 400;
const THUMB_MAX_BYTES = 25 * 1024; // plan target: <= 25 KB per thumbnail
const SCREENSHOT_WIDTH = 640;
const ICO_SIZES = [16, 32, 48];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** Draw `img` scaled to `width` (aspect preserved) on a fresh canvas. */
function resizeToWidth(img, width) {
  const scale = width / img.width;
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/**
 * Encode a canvas as WebP, stepping quality down until the output fits `maxBytes`
 * (never below `minQuality`). Returns { buf, quality }.
 */
async function encodeWebpUnder(canvas, maxBytes, startQuality = 80, minQuality = 40) {
  let quality = startQuality;
  let buf = await canvas.encode("webp", quality);
  while (buf.length > maxBytes && quality > minQuality) {
    quality -= 5;
    buf = await canvas.encode("webp", quality);
  }
  return { buf, quality };
}

// ---------------------------------------------------------------------------------
// (a) favicon.ico — PNG-in-ICO container.
//   ICONDIR (6 bytes): reserved u16=0, type u16=1 (icon), count u16
//   ICONDIRENTRY (16 bytes each): width u8, height u8 (0 means 256), colorCount u8=0,
//     reserved u8=0, planes u16=1, bitCount u16=32, bytesInRes u32, imageOffset u32
//   followed by the raw PNG blobs in entry order.
// ---------------------------------------------------------------------------------
async function buildFavicon() {
  const src = await loadImage(fs.readFileSync(ICON_SRC));
  const frames = [];
  for (const size of ICO_SIZES) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, size, size);
    frames.push({ size, png: await canvas.encode("png") });
  }

  const headerLen = 6 + 16 * frames.length;
  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = headerLen;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(f.size < 256 ? f.size : 0, e + 0); // width
    header.writeUInt8(f.size < 256 ? f.size : 0, e + 1); // height
    header.writeUInt8(0, e + 2); // color count (0 = no palette)
    header.writeUInt8(0, e + 3); // reserved
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(f.png.length, e + 8); // bytes in resource
    header.writeUInt32LE(offset, e + 12); // offset of the PNG blob
    offset += f.png.length;
  });

  const ico = Buffer.concat([header, ...frames.map((f) => f.png)]);
  fs.writeFileSync(FAVICON_OUT, ico);
  console.log(`favicon: ${path.relative(APP_ROOT, FAVICON_OUT)} (${kb(ico.length)}, frames ${ICO_SIZES.join("/")} px)`);
}

// ---------------------------------------------------------------------------------
// (b) sample thumbnails + (d) manifest
// ---------------------------------------------------------------------------------
async function buildSampleThumbs() {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => /\.jpe?g$/i.test(f))
    .sort();
  if (fixtures.length === 0) throw new Error(`no *.jpg fixtures in ${FIXTURES_DIR}`);

  const basenames = [];
  const sizes = [];
  for (const file of fixtures) {
    const base = path.basename(file).replace(/\.jpe?g$/i, "");
    if (!/^[a-z0-9-]+$/.test(base)) {
      throw new Error(`fixture basename must match /^[a-z0-9-]+$/ (sampleThumbSrc guard): ${file}`);
    }
    const img = await loadImage(fs.readFileSync(path.join(FIXTURES_DIR, file)));
    const canvas = resizeToWidth(img, THUMB_WIDTH);
    const { buf, quality } = await encodeWebpUnder(canvas, THUMB_MAX_BYTES);
    const out = path.join(THUMBS_DIR, `${base}.webp`);
    fs.writeFileSync(out, buf);
    basenames.push(base);
    sizes.push(buf.length);
    const flag = buf.length > THUMB_MAX_BYTES ? "  ** OVER 25 KB **" : "";
    console.log(`thumb:   ${path.relative(APP_ROOT, out)} ${canvas.width}x${canvas.height} q${quality} ${kb(buf.length)}${flag}`);
  }
  basenames.sort();

  const manifest =
    "// GENERATED by scripts/generate-web-assets.mjs — do not edit by hand.\n" +
    "// Basenames (no extension) of the committed sample-document thumbnails under\n" +
    "// public/samples/thumbs/. A `const` TS array (plan v3 S9) so the Node test harness\n" +
    "// and tests/isolation-static.mjs can import it without a JSON loader.\n" +
    "export const SAMPLE_THUMB_BASENAMES = [\n" +
    basenames.map((b) => `  ${JSON.stringify(b)},\n`).join("") +
    "] as const;\n" +
    "\n" +
    'export const SAMPLE_THUMB_EXT = "webp";\n';
  fs.writeFileSync(MANIFEST_OUT, manifest);
  console.log(
    `manifest: ${path.relative(APP_ROOT, MANIFEST_OUT)} (${basenames.length} entries; thumbs ${kb(Math.min(...sizes))}..${kb(Math.max(...sizes))})`,
  );
}

// ---------------------------------------------------------------------------------
// (c) 640 px screenshot variants
// ---------------------------------------------------------------------------------
async function buildScreenshotVariants() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.log("screenshots: directory absent, skipping");
    return;
  }
  const originals = fs
    .readdirSync(SCREENSHOTS_DIR)
    .filter((f) => /\.webp$/i.test(f) && !/-640\.webp$/i.test(f))
    .sort();
  for (const file of originals) {
    const base = file.replace(/\.webp$/i, "");
    const img = await loadImage(fs.readFileSync(path.join(SCREENSHOTS_DIR, file)));
    const canvas = resizeToWidth(img, Math.min(SCREENSHOT_WIDTH, img.width));
    const buf = await canvas.encode("webp", 80);
    const out = path.join(SCREENSHOTS_DIR, `${base}-${SCREENSHOT_WIDTH}.webp`);
    fs.writeFileSync(out, buf);
    console.log(`screenshot: ${path.relative(APP_ROOT, out)} ${canvas.width}x${canvas.height} ${kb(buf.length)}`);
  }
}

await buildFavicon();
await buildSampleThumbs();
await buildScreenshotVariants();
console.log("done");
