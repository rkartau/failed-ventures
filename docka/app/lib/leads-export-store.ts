// lib/leads-export-store.ts — fs shell for the §15 lead export.
//
// Mirrors lib/outreach-snapshot-store.ts: cwd-resolved path, tolerant read
// that never throws, ALL flattening/validation logic in the PURE
// lib/leads-export.ts. Source of truth is content/docka-leads.json, which the
// lead-base publisher (handoff_publish_leads.py) ships onto the box by scp —
// it is gitignored (GDPR) and never travels in the deploy tar, so "missing"
// is a NORMAL state until the first publish (route answers a clean 503).
//
// The flattened response body (~14.6 MB from ~30k rows) is cached per
// (mtimeMs, size) of the source file, so the pipeline's once-per-cycle fetch
// re-flattens only when the publisher actually shipped a new file.

import fs from "fs";
import path from "path";
import {
  flattenLeadsDoc,
  serializeExport,
  type ExportReadStatus,
} from "@/lib/leads-export";

const CONTENT_PATH = path.join(process.cwd(), "content", "docka-leads.json");

type CacheEntry = { path: string; mtimeMs: number; size: number; body: string };
let cache: CacheEntry | null = null;

export type LeadsExportRead =
  | { status: "ok"; body: string }
  | { status: Exclude<ExportReadStatus, "ok">; error?: string };

/** Test hook: drop the mtime cache (tests rewrite the file rapidly). */
export function __clearLeadsExportCache(): void {
  cache = null;
}

/** Tolerant read + flatten — never throws. */
export function readLeadsExport(contentPath: string = CONTENT_PATH): LeadsExportRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(contentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }

  if (cache && cache.path === contentPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return { status: "ok", body: cache.body };
  }

  let text: string;
  try {
    text = fs.readFileSync(contentPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable" };
  }

  let parsed: unknown;
  try {
    // BOM tolerance, same stance as the outreach store (PowerShell files).
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { status: "invalid", error: "not valid JSON" };
  }

  const flat = flattenLeadsDoc(parsed);
  if (!flat.ok) return { status: "invalid", error: flat.error };

  const ser = serializeExport(flat.export);
  if (!ser.ok) return { status: "invalid", error: ser.error };

  cache = { path: contentPath, mtimeMs: stat.mtimeMs, size: stat.size, body: ser.body };
  return { status: "ok", body: ser.body };
}
