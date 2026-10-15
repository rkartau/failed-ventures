// lib/segment-lock.ts — the ONE cross-process advisory lock for the append-only
// outreach event store (plan §2 C1, R2 / A-BT1).
//
// WHY A LOCK AT ALL (R2): appends to a single segment are already atomic under
// O_APPEND for lines < PIPE_BUF, but the segment-ROLLOVER decision is not: two
// processes could each decide "the active segment is full" and one could then
// append to a segment the reader has already advanced past, losing that event
// (a lost `unsub` → mail-after-unsubscribe). Every append AND every rollover is
// therefore serialized through this lock.
//
// WHO CONTENDS (plan-vs-code correction): the live app runs pm2 FORK mode,
// SINGLE process (lib/db.ts refuses to boot as a cluster instance), so the app
// is NOT N cluster workers. The real cross-process contenders are: (a) the app
// writer vs the Python pipeline READER, which takes THIS SAME lock to snapshot
// (§2 D1); (b) a brief pm2-reload overlap where an old and a new app process are
// momentarily both alive; (c) the concurrency tests, which spawn true separate
// node processes. The lock is correct and required for all of these.
//
// PRIMITIVE CHOICE (A-BT1 — pinned): an O_CREAT|O_EXCL lockFILE (the lock IS the
// existence of `.segment.lock`), NOT flock(2) and NOT fcntl/lockf. Rationale:
//   * flock(2) and fcntl/lockf are SEPARATE, non-interoperating lock spaces on
//     Linux; a Node flock and a Python fcntl.flock on the same fd do NOT exclude
//     each other unless both pick the identical space, and the `fs-ext` flock
//     binding for Node has known reliability caveats. The plan flagged this as a
//     build-time hazard.
//   * An O_EXCL lockfile is a single, language-agnostic protocol that BOTH Node
//     and Python implement natively with zero native modules and zero ambiguity
//     about which lock space is in play. It composes trivially with the reader.
//
// PYTHON READER CONTRACT (mirror this exactly on the pipeline side):
//   acquire  = os.open(lockPath, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
//              write f"{os.getpid()}\n{time.time_ns()//1_000_000}" then close the fd
//   on EEXIST: if the file's mtime is older than STALE_MS, OR the pid on line 1
//              is dead, steal it (os.unlink) and retry; else sleep a few ms and
//              retry until ACQUIRE_TIMEOUT_MS.
//   release  = os.unlink(lockPath)
//   The reader holds the lock ONLY to snapshot each segment's EOF, then releases
//   and folds outside the lock (§2 D1).

import fs from "fs";
import path from "path";

/** Basename of the lock file inside the data dir. Shared with the Python reader. */
export const SEGMENT_LOCK_FILE = ".segment.lock";

/**
 * A held lock older than this (by file mtime) is considered stale and may be
 * stolen — the previous holder crashed without releasing. Must be comfortably
 * larger than the longest legitimate critical section (a single O_APPEND).
 */
export const LOCK_STALE_MS = 15_000;

/** Give up acquiring after this long (a wedged lock is a bug, not a wait). */
const ACQUIRE_TIMEOUT_MS = 10_000;

/** Poll interval bounds while spinning for the lock (jittered to de-sync peers).
 *  Kept small so heavy in-process contention (the C4 500-append test) drains
 *  quickly; cross-process contention is rare (few hundred events/day). */
const RETRY_MIN_MS = 1;
const RETRY_MAX_MS = 8;

export class SegmentLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentLockError";
  }
}

function lockPathFor(dataDir: string): string {
  return path.join(dataDir, SEGMENT_LOCK_FILE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Is `pid` a live process? Signal 0 is an existence probe (never delivers). */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it → alive. ESRCH → dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if the existing lock is stale (aged out or held by a dead pid) → stealable. */
function lockIsStale(lp: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(lp);
  } catch {
    return false; // vanished between EEXIST and here — the retry will just re-create it
  }
  if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
  try {
    const holder = Number(fs.readFileSync(lp, "utf8").split("\n", 1)[0]?.trim());
    if (Number.isFinite(holder) && holder > 0 && holder !== process.pid && !pidAlive(holder)) {
      return true;
    }
  } catch {
    /* unreadable lock — fall through to age-based stealing only */
  }
  return false;
}

/** Try once to create the lock exclusively. Returns true on success, false when
 *  it is already held (retry). On the Linux deploy target an already-held lock is
 *  a clean EEXIST; on Windows the same race surfaces as EPERM/EACCES while the
 *  previous holder's unlink is still delete-pending — treated identically as
 *  "held, retry" so the lock is correct on both. */
function tryCreate(lp: string): boolean {
  try {
    const fd = fs.openSync(lp, "wx"); // wx = O_CREAT | O_EXCL | O_WRONLY
    try {
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") return false;
    throw err;
  }
}

/**
 * Acquire the segment lock, run `fn`, and ALWAYS release it (even if `fn`
 * throws). The critical section must be short (a re-scan + O_EXCL create + one
 * O_APPEND). Acquisition spins with jittered backoff and steals a provably-stale
 * lock; it throws SegmentLockError only if it cannot acquire within the timeout
 * (which indicates a genuinely wedged holder, not normal contention).
 */
export async function withSegmentLock<T>(dataDir: string, fn: () => Promise<T> | T): Promise<T> {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const lp = lockPathFor(dataDir);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  // Stale-checking (statSync + readFileSync + kill-probe) is expensive; under
  // heavy in-process contention doing it on EVERY retry is O(N²). Throttle it to
  // at most once per STALE_CHECK_INTERVAL_MS — a held lock only becomes stealable
  // after LOCK_STALE_MS anyway, so a quarter-second cadence loses nothing.
  const STALE_CHECK_INTERVAL_MS = 250;
  let lastStaleCheck = Date.now();
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (tryCreate(lp)) break;

    const now = Date.now();
    if (now - lastStaleCheck >= STALE_CHECK_INTERVAL_MS) {
      lastStaleCheck = now;
      if (lockIsStale(lp)) {
        try {
          fs.unlinkSync(lp);
        } catch {
          /* someone else stole/released it first — just retry */
        }
        continue;
      }
    }
    if (now > deadline) {
      throw new SegmentLockError(
        `could not acquire ${SEGMENT_LOCK_FILE} within ${ACQUIRE_TIMEOUT_MS}ms (wedged holder?)`
      );
    }

    // First few misses: yield via setImmediate so an in-process holder that just
    // released is picked up almost instantly (no timer-granularity floor, no
    // O(N²) syscall storm). After that, back off to a short jittered sleep so a
    // cross-process wait doesn't busy-spin the event loop.
    attempt += 1;
    if (attempt <= 4) {
      await new Promise<void>((r) => setImmediate(r));
    } else {
      await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lp);
    } catch {
      /* best-effort release; a stale-steal will reclaim it if this ever fails */
    }
  }
}
