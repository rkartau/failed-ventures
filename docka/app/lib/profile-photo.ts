// Shared helpers for the persistent profile photo.
//
// The government registry returns the holder photo as a TIME-LIMITED signed URL
// that expires. We download it ONCE server-side and keep only the local uploads/
// filename on the seafarer (verifiedPhotoFile). An owner may also upload their own
// image (customPhotoFile) which OVERRIDES the verified one. Both are served via
// /api/profile-photo/<id> with the same access rules as the person's documents.

import path from "path";

export const UPLOAD_DIR = path.join(process.cwd(), "uploads");

/** Hard cap on any stored profile photo — a downloaded registry photo or an upload. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** Map an image MIME content-type to a safe file extension, or null if not an image. */
export function extForImageType(contentType?: string | null): string | null {
  if (!contentType) return null;
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return EXT_BY_TYPE[ct] ?? null;
}

/**
 * Sniff an image type from the file's MAGIC BYTES, independent of any declared
 * content-type. The registry serves its photo as `application/octet-stream`, so a
 * content-type check alone rejects a perfectly valid JPEG — the magic bytes are the
 * reliable signal. Returns null for bytes that are not a recognised image.
 */
export function extFromMagic(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return ".png";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return ".webp";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return ".gif";
  return null;
}

/** Extract a safe image extension from a filename, or null if it is not an image. */
export function extFromImageName(name?: string | null): string | null {
  if (!name) return null;
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  return ALLOWED_EXT.has(ext) ? ext : null;
}

/**
 * The profile photo filename to DISPLAY. Fallback order:
 *   custom (owner upload) -> verified (registry download) -> null (show initials).
 */
export function activeProfilePhotoFile(sf: {
  customPhotoFile?: string | null;
  verifiedPhotoFile?: string | null;
}): string | null {
  return sf.customPhotoFile ?? sf.verifiedPhotoFile ?? null;
}
