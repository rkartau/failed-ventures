// lib/outreach-docs-store.ts — fs shell + name validation for the outreach
// campaign-docs mirror (PIPELINE_BUILD_SPEC §13: the pipeline `publish` step
// POSTs each CHANGED docs/*.md to /api/admin/outreach/docs/<name>).
//
// Mirrors lib/outreach-snapshot-store.ts: cwd-resolved data dir, atomic
// tmp+rename write, tolerant read that never throws. The NAME is an
// attacker-reachable path component, so validation is strict and runs BEFORE
// any disk access (pattern: api/files/[name] isSafeId): flat basename
// allowlist only — no separators, no dotfiles, no traversal, `.md` only.
// Content is opaque markdown; the 2 MB size cap (MAX_DOC_UPLOAD_BYTES below —
// deliberately NOT the board snapshot's 10 MB cap) is enforced by the route
// via the shared assertUploadSize (lib/outreach-snapshot.ts).

import fs from "fs";
import path from "path";

/** Per-doc size cap. Stayed at 2 MB when the BOARD upload cap moved to 10 MB
 * (Increment 6) — markdown docs never need more, and the disk-DoS math in the
 * MAX_DOC_COUNT comment is sized against this number. */
export const MAX_DOC_UPLOAD_BYTES = 2 * 1024 * 1024;

const DATA_DIR = path.join(process.cwd(), "data");
const DOCS_DIR = path.join(DATA_DIR, "outreach-docs");

/**
 * Disk-usage bound: the pipeline ships a fixed, small docs/ set (~10 files).
 * 50 distinct names is an order of magnitude of headroom while keeping a
 * stolen upload token from filling the disk with 2 MB files. Overwrites of an
 * EXISTING name are always allowed — only new names count against the cap.
 */
export const MAX_DOC_COUNT = 50;

// First char alphanumeric (no dotfiles), then a bounded run of the safe
// filename alphabet, mandatory ".md" suffix. The char class contains no
// separator, so traversal ("../") can never validate.
const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/;

export function isSafeDocName(name: unknown): name is string {
  return typeof name === "string" && DOC_NAME_RE.test(name);
}

/** Atomic write (tmp+rename, outreach-snapshot-store pattern). Fail-closed
 *  belt-and-braces: throws on an unsafe name even though the route validates
 *  first — this module must be safe for any future caller too. */
export function writeOutreachDoc(name: string, content: string): void {
  if (!isSafeDocName(name)) throw new Error("unsafe doc name");
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  const target = path.join(DOCS_DIR, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

/** Tolerant list — never throws. Missing dir = "nothing uploaded yet".
 *  Only names that pass the same allowlist are reported (a stray .tmp from a
 *  crashed write, or anything hand-placed, is invisible to the cap + readers). */
export function listOutreachDocs(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(DOCS_DIR);
  } catch {
    return [];
  }
  return entries.filter((n) => isSafeDocName(n)).sort();
}

export function hasOutreachDoc(name: string): boolean {
  if (!isSafeDocName(name)) return false;
  return fs.existsSync(path.join(DOCS_DIR, name));
}

/** Tolerant read — never throws. Missing file = "empty". */
export function readOutreachDoc(name: string):
  | { status: "ok"; content: string }
  | { status: "empty" }
  | { status: "corrupt" } {
  if (!isSafeDocName(name)) return { status: "empty" };
  try {
    return { status: "ok", content: fs.readFileSync(path.join(DOCS_DIR, name), "utf-8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "empty" };
    return { status: "corrupt" };
  }
}
