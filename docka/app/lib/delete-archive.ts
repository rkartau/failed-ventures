// Shared archive-before-delete appender (#37 person-merge + hidden-crew delete).
// Serialises the full about-to-be-removed payload to data/merge-archive.ndjson BEFORE
// any mutation. Callers invoke it INSIDE their `transact` fn: a throwing append means
// writeAtomic never runs, so no archive line => no deletion (reversibility guarantee).
// The file lives under data/ (deploy-excluded) — PII never leaves the box; only the
// returned HASH goes into the PII-free audit sinks.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ARCHIVE_PATH = path.join(process.cwd(), "data", "merge-archive.ndjson");

export function archiveBeforeDelete(
  kind: string,
  payload: Record<string, unknown>
): { hash: string } {
  const json = JSON.stringify({ kind, ...payload });
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  // Throws on failure -> the caller's transact never reaches writeAtomic -> nothing mutated.
  fs.appendFileSync(ARCHIVE_PATH, json + "\n", "utf-8");
  return { hash };
}

/**
 * Tolerant read of the pre-delete snapshots. Used ONLY by the billing usage engine as
 * the third link of its grantId -> (agentId, seafarerId) recovery chain
 * (STRIPE-BILLING-ANALYSIS.md §C.3): a HARD-deleted grant leaves no row in db.json, so
 * a snapshot here can still resolve which agency a surviving consent event belongs to.
 * A missing file, or an unparseable line, is skipped rather than thrown — a corrupt
 * archive must never take the month-end billing job down.
 */
export function readMergeArchive(): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = fs.readFileSync(ARCHIVE_PATH, "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}
