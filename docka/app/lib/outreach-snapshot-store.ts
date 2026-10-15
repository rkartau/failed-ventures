// lib/outreach-snapshot-store.ts — fs shell for the outreach board snapshot.
//
// Server-only storage for data/outreach-snapshot.json, mirroring
// lib/registry-health.ts: cwd-resolved data dir, tolerant read that never
// throws (missing → empty, unreadable → corrupt), atomic tmp+rename write.
// ALL validation/coercion logic lives in the PURE lib/outreach-snapshot.ts
// (parseStoredSnapshot) — this file only touches the disk, so the client
// upload island can import the pure module without bundling node builtins.

import fs from "fs";
import path from "path";
import {
  parseStoredSnapshot,
  stripBom,
  type OutreachSnapshot,
} from "@/lib/outreach-snapshot";

const DATA_DIR = path.join(process.cwd(), "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "outreach-snapshot.json");

export function writeOutreachSnapshot(s: Omit<OutreachSnapshot, "uploadedAt">): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const full: OutreachSnapshot = { ...s, uploadedAt: new Date().toISOString() };
  // Atomic: full write to a sibling tmp file, then rename over the target —
  // a crash mid-write can never leave a half-written snapshot behind the page.
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2), "utf-8");
  fs.renameSync(tmp, SNAPSHOT_PATH);
}

/** Tolerant read — never throws. Missing file = "nothing uploaded yet". */
export function readOutreachSnapshot():
  | { status: "ok"; snapshot: OutreachSnapshot }
  | { status: "empty" }
  | { status: "corrupt" } {
  let text: string;
  try {
    text = fs.readFileSync(SNAPSHOT_PATH, "utf-8");
  } catch (err) {
    // Only "file does not exist" is the honest empty state; any other read
    // error (EACCES/EISDIR/EIO/…) means a snapshot may exist but is unreadable.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "empty" };
    return { status: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return { status: "corrupt" };
  }
  return parseStoredSnapshot(parsed);
}
