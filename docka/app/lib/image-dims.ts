// Server-side magic-byte sniffing + header-only image dimensions for the
// anonymous verify-upload endpoint (plan §1 + §3).
//
//  - `sniffMagic` trusts ONLY the leading bytes — never the client's filename
//    or Content-Type. `safeExt` (the stored file's extension) derives from it.
//  - `imageDimensions` parses ONLY headers (JPEG SOFn incl. progressive SOF2,
//    PNG IHDR, GIF logical-screen descriptor, BMP info header, WEBP
//    VP8/VP8L/VP8X) — no pixel decode, no dependencies.
//  - `exceedsPixelLimit` is the pixel-bomb gate run BEFORE any recognition
//    worker spawns: jpeg-js allocates W×H×4 bytes, so a 250-megapixel JPEG a
//    few KB on the wire would OOM the box. EXIF rotation never changes the
//    STORED dims, so gating on raw header dims is exact.

/** Types the anonymous upload endpoint accepts for the ORIGINAL part. */
export type SniffedType = "jpeg" | "png" | "webp" | "gif" | "bmp" | "pdf" | "heic";

/** Recognition pixel ceiling (plan §3): >40 MP → skip recognition. */
export const MAX_RECOGNITION_PIXELS = 40_000_000;

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.subarray(start, start + len).toString("latin1");
}

/**
 * Sniff the file type from magic bytes ONLY. Returns null for anything outside
 * the upload allowlist (the endpoint answers 415 and persists nothing).
 *
 * HEIC/HEIF (ISO-BMFF `ftyp` brands) is accepted for the ORIGINAL so an iPhone
 * photo is still SAVED for the corpus (plan §3) — it is never handed to the
 * recognition worker (no decoder); the user gets the guided fallback.
 */
export function sniffMagic(buf: Buffer): SniffedType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "webp";
  if (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a") return "gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp"; // "BM"
  if (ascii(buf, 0, 5) === "%PDF-") return "pdf";
  // ISO-BMFF: [4-byte box size]"ftyp"[4-byte major brand]. HEIC family brands.
  if (ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4).toLowerCase();
    if (["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"].includes(brand)) return "heic";
  }
  return null;
}

/** Stored-file extension from the SNIFFED type only — never from origName. */
export function safeExt(type: SniffedType): string {
  switch (type) {
    case "jpeg":
      return "jpg";
    default:
      return type; // png / webp / gif / bmp / pdf / heic
  }
}

export type ImageDims = { width: number; height: number };

// JPEG: walk the marker stream to the first SOFn (0xC0–0xCF minus DHT 0xC4,
// JPG 0xC8, DAC 0xCC — includes progressive SOF2). Height/width sit at
// payload offsets 3–6.
function jpegDims(buf: Buffer): ImageDims | null {
  let i = 2; // past SOI
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++; // permissive: skip filler/garbage between markers
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Standalone markers without a length (RSTn, TEM) — skip.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null; // corrupt length — stop
    i += 2 + len;
  }
  return null;
}

function webpDims(buf: Buffer): ImageDims | null {
  const chunk = ascii(buf, 12, 4);
  if (chunk === "VP8X" && buf.length >= 30) {
    // 24-bit little-endian minus-one canvas dims at offsets 24 / 27.
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    // Lossy: 3-byte frame tag + sync 9D 01 2A, then 14-bit dims.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    if (buf[20] !== 0x2f) return null; // lossless signature byte
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

function bmpDims(buf: Buffer): ImageDims | null {
  if (buf.length < 26) return null;
  const headerSize = buf.readUInt32LE(14);
  if (headerSize === 12) {
    // BITMAPCOREHEADER: 16-bit dims.
    return { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) };
  }
  // BITMAPINFOHEADER and later: signed 32-bit (height negative = top-down).
  const width = Math.abs(buf.readInt32LE(18));
  const height = Math.abs(buf.readInt32LE(22));
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Header-only dimensions for the worker-supported raster types. Returns null
 * when the type carries no parseable dims (PDF/HEIC, or a corrupt header) —
 * the caller decides; the pixel gate only blocks a PARSEABLE oversize.
 */
export function imageDimensions(buf: Buffer, type: SniffedType): ImageDims | null {
  try {
    switch (type) {
      case "jpeg":
        return jpegDims(buf);
      case "png":
        return buf.length >= 24
          ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
          : null;
      case "gif":
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case "bmp":
        return bmpDims(buf);
      case "webp":
        return webpDims(buf);
      default:
        return null; // pdf / heic — no raster header to gate on
    }
  } catch {
    return null;
  }
}

/**
 * Pixel-bomb gate (plan §3): true when the header declares MORE than the
 * recognition ceiling — the caller skips the worker (never a rejection of the
 * upload itself; the bytes are already saved for the corpus).
 */
export function exceedsPixelLimit(buf: Buffer, type: SniffedType): boolean {
  const dims = imageDimensions(buf, type);
  if (!dims) return false;
  return dims.width * dims.height > MAX_RECOGNITION_PIXELS;
}
