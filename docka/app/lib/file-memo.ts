// lib/file-memo.ts — one shared (mtimeMs, size)-keyed memo for small JSON files.
//
// Lifted out of the product-fit / docka-leads memo shells so the new lead-source
// loader (lib/docka-sources.ts) and the product-fit lookup share ONE
// implementation instead of a fourth hand-rolled copy. Semantics match today's
// product-fit store byte-for-byte:
//   - stat fails            → DROP this path's memo entry, return {missing};
//                             a file that reappears is parsed fresh (as the old
//                             `lookupMemo = null` did).
//   - stat ok, size>maxBytes→ {invalid} WITHOUT reading the bytes.
//   - stat ok, read throws  → {unreadable} (carries the stat), MEMOISED by
//                             (mtimeMs, size) — e.g. the path is a directory
//                             (EISDIR); a second call does not re-read.
//   - stat ok, JSON throws  → {invalid}, MEMOISED by (mtimeMs, size).
//   - stat ok, parse ok/bad → {ok,value} / {invalid}, MEMOISED by (mtimeMs, size).
//
// A hit by (mtimeMs, size) returns the SAME result object (identity), so a
// caller may return `res.value` BY REFERENCE and fold the mtime/size into its
// own version token (product-fit's identity contract, pinned at
// tests/product-fit.test.mjs:235). ONE entry per path — never a growing list.
//
// The files this guards are box-only business data shipped by the pipeline,
// never through git; they are gitignored (see app/.gitignore).

import fs from "fs";
import { stripBom } from "@/lib/outreach-snapshot";

export type MemoResult<T> =
  | { status: "ok"; value: T; mtimeMs: number; size: number }
  | { status: "missing" }
  | { status: "unreadable"; error: string; mtimeMs: number; size: number }
  | { status: "invalid"; error: string; mtimeMs: number; size: number };

type Entry = { mtimeMs: number; size: number; result: MemoResult<unknown> };

// Module-level, keyed by the resolved path. Shared across every consumer; a
// per-path key means product-fit and sources never collide.
const memo = new Map<string, Entry>();

/** Test hook: forget one path's memo entry, or (no arg) the whole map. */
export function __clearFileMemo(path?: string): void {
  if (path === undefined) memo.clear();
  else memo.delete(path);
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read + parse a small JSON file with an (mtimeMs, size) memo. `parse` owns all
 * shape validation: it receives the parsed JSON plus the file's stat and returns
 * either `{ok:true, value}` or `{ok:false, error}`. Never throws.
 */
export function memoJsonFile<T>(
  filePath: string,
  parse: (
    raw: unknown,
    stat: { mtimeMs: number; size: number }
  ) => { ok: true; value: T } | { ok: false; error: string },
  opts?: { maxBytes?: number }
): MemoResult<T> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // Missing: drop the entry so a file that reappears re-parses (old behaviour).
    memo.delete(filePath);
    return { status: "missing" };
  }

  const mtimeMs = stat.mtimeMs;
  const size = stat.size;

  const hit = memo.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    return hit.result as MemoResult<T>;
  }

  let result: MemoResult<T>;
  if (size > maxBytes) {
    result = {
      status: "invalid",
      error: `file too large (${size} > ${maxBytes} bytes)`,
      mtimeMs,
      size,
    };
  } else {
    let text: string | null = null;
    let readErr: string | null = null;
    try {
      text = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      readErr = String(
        (err as NodeJS.ErrnoException)?.code || (err as Error)?.message || "read failed"
      );
    }
    if (readErr !== null || text === null) {
      result = { status: "unreadable", error: readErr ?? "read failed", mtimeMs, size };
    } else {
      let raw: unknown;
      let parseErr: string | null = null;
      try {
        raw = JSON.parse(stripBom(text));
      } catch (err) {
        parseErr = `JSON parse failed: ${(err as Error)?.message ?? "error"}`;
      }
      if (parseErr !== null) {
        result = { status: "invalid", error: parseErr, mtimeMs, size };
      } else {
        const parsed = parse(raw, { mtimeMs, size });
        result = parsed.ok
          ? { status: "ok", value: parsed.value, mtimeMs, size }
          : { status: "invalid", error: parsed.error, mtimeMs, size };
      }
    }
  }

  memo.set(filePath, { mtimeMs, size, result });
  return result;
}
