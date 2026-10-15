// Public sample-document thumbnails (SEO plan v3 C9 / R6 / S9).
//
// The curated /sample pages render document thumbnails through /api/files/<id>?token=
// (the 1200x542 fixture JPEGs, ~100 KB each). For the SAMPLE docs only, a committed
// 400px WebP under public/samples/thumbs/ is served instead (lazy, sized, ~10 KB),
// which is what the crawler and the first paint see. The lightbox / DocViewer keeps
// the full-size /api/files URL.
//
// Safety: a path is returned ONLY for a basename that (a) matches /^[a-z0-9-]+$/ and
// (b) is present in the generated manifest (lib/sample-thumbs-manifest.ts, written by
// scripts/generate-web-assets.mjs). Anything else (a real tenant doc, a fileName
// with a path segment, an unknown fixture) gets null and falls back to the API URL.
//
// IMPORT-FREE except the manifest const, so tests/isolation-static.mjs and the Node
// test harness can load it without a loader.

import { SAMPLE_THUMB_BASENAMES, SAMPLE_THUMB_EXT } from "@/lib/sample-thumbs-manifest";

const SAFE_BASENAME = /^[a-z0-9-]+$/;
const KNOWN: ReadonlySet<string> = new Set<string>(SAMPLE_THUMB_BASENAMES);

/** Public path under /samples/thumbs/ for a curated sample doc, else null. */
export function sampleThumbSrc(doc: { sample?: boolean; fileName?: string | null }): string | null {
  if (doc.sample !== true || !doc.fileName) return null;
  const base = doc.fileName.replace(/\.[^.]*$/, "");
  if (!SAFE_BASENAME.test(base) || !KNOWN.has(base)) return null;
  return `/samples/thumbs/${base}.${SAMPLE_THUMB_EXT}`;
}
