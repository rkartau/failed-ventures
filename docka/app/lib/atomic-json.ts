// lib/atomic-json.ts — the ONE atomic JSON-snapshot writer (fix-plan C6).
//
// Extracted because it had been written twice, byte-for-byte in intent and subtly
// different in detail: lib/billing-health.ts used a pid-suffixed tmp file, while
// lib/registry-health.ts used a fixed `.tmp` (two processes writing at once would tread
// on each other's tmp file). Two implementations of a durability primitive means a fix
// applied to one silently misses the other.
//
// The contract: NEVER a partially-written file. Write the whole document to a sibling
// tmp path, then `rename` over the target — rename is atomic within a filesystem, so a
// reader either sees the previous snapshot or the new one, never a torn one.
//
// These are REGENERABLE operational snapshots (health files), not tenant data and not
// audit sinks, so a write failure is REPORTED and swallowed rather than thrown: the
// observability layer must never break the job it observes.

import fs from "fs";
import path from "path";

export type AtomicWriteResult = { ok: true } | { ok: false; error: unknown };

/** Serialise `value` and place it at `filePath` atomically. Creates the directory. */
export function writeJsonAtomic(filePath: string, value: unknown): AtomicWriteResult {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // The pid suffix keeps two processes from colliding on the same tmp path.
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
