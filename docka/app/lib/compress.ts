// Client-side image downscale + re-compress, run in the browser BEFORE a photo
// is uploaded. A phone snap of a paper certificate is 4–5 MB at 12 MP — far more
// than OCR needs — and on a metered ship link that is slow and expensive. We cap
// the longest edge and re-encode as JPEG, typically turning a ~5 MB photo into a
// few hundred KB while keeping the text sharp enough to read.
//
// Pure browser APIs (createImageBitmap + canvas), no dependencies. Anything that
// isn't a raster image (PDF, unknown type) is returned untouched, and any failure
// degrades gracefully to the original file — compression must never lose a doc.

export type CompressResult = {
  file: File;
  originalSize: number;
  compressedSize: number;
  compressed: boolean;
};

export type CompressOptions = {
  /**
   * Verify-upload plan §3: ALWAYS return the JPEG re-encode when one could be
   * produced, ignoring MIN_GAIN. The recognition worker QR-decodes JPEG ONLY,
   * so a PNG/WebP/BMP upload needs a JPEG derived part even when re-encoding
   * saves nothing (or grows the file). HEIC decodes only where the browser
   * itself can (iOS Safari); everywhere else createImageBitmap throws and this
   * degrades to the untouched original — which is still uploaded and SAVED.
   */
  forceJpeg?: boolean;
};

const MAX_EDGE = 2000; // px — plenty for OCR/QR, a fraction of a 12 MP photo
const QUALITY = 0.8;
const MIN_GAIN = 0.9; // only keep the re-encode if it actually saved ≥10%

function isRasterImage(file: File): boolean {
  // heic/heif ride along so iOS Safari (the one browser that decodes its own
  // HEIC) can produce a JPEG derived part; other browsers fail the decode and
  // fall through to the untouched original.
  return (
    /^image\/(jpe?g|png|webp|bmp|heic|heif)$/i.test(file.type) ||
    /\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(file.name)
  );
}

export async function compressImage(file: File, opts?: CompressOptions): Promise<CompressResult> {
  const originalSize = file.size;
  const untouched: CompressResult = {
    file,
    originalSize,
    compressedSize: originalSize,
    compressed: false,
  };

  if (typeof window === "undefined" || !isRasterImage(file)) return untouched;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return untouched;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return untouched;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", QUALITY)
    );
    if (!blob) return untouched;
    // MIN_GAIN keeps uploads honest for the classic path; forceJpeg (§3)
    // bypasses it — the JPEG bytes ARE the point, not the size win.
    if (!opts?.forceJpeg && blob.size >= originalSize * MIN_GAIN) return untouched;

    const base = file.name.replace(/\.[a-z0-9]+$/i, "");
    const out = new File([blob], `${base}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    return { file: out, originalSize, compressedSize: out.size, compressed: true };
  } catch {
    return untouched;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
