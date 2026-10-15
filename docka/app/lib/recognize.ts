// Server-side, two-tier photo recognition run on every uploaded image.
//
//  Tier (a) — QR / embedded code: decode a QR from the image pixels and scan the
//  raw bytes/filename for a printed registry URL or token. Any code found is
//  verified LIVE against the Estonian registry; success => a government-VERIFIED
//  (green) document.
//
//  Tier (b) — OCR: if no verifiable code, best-effort read a title, holder name
//  and expiry date off the photo. The document is stored "read from photo — not
//  government-verified" (amber). We NEVER leave an uploaded image with zero
//  metadata.
//
// The heavy native work (jsQR / jpeg-js / tesseract.js) runs in a SEPARATE Node
// process (scripts/recognize-worker.mjs) so it stays out of the Next webpack
// bundle — bundling tesseract's worker hangs recognition. This module only
// orchestrates and does the interpretation with the shared TS libs.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { detectCodeFromFile } from "@/lib/detect";
import type { VerifiedCert } from "@/lib/cert";
import { resolveInput } from "@/lib/registry";
import type { CountryEntry } from "@/lib/registry/types";
import { parseOcr, pickTitle, type OcrFields } from "@/lib/ocr-parse";

export type Recognition =
  | { source: "government"; cert: VerifiedCert; via: "qr" | "embedded" }
  // §2.5: a PUBLIC-IDENTIFIER registry match (e.g. a foreign cert QR carrying
  // printed identifiers). NOT a verification yet — the caller MUST pass it
  // through bindHolder (the single choke point) before any doc can become
  // source:"government"; a holder mismatch is stored unverified + flagged.
  | { source: "pending-binding"; cert: VerifiedCert; country: CountryEntry; via: "qr" | "embedded" }
  | { source: "photo"; fields: OcrFields; ocrText: string }
  | { source: "none" };

const WORKER_TIMEOUT = 120_000;

// Parent-side worker RSS watchdog (pdf-verify plan Decision 16): a hostile
// PDF ballooning pdfjs/canvas memory is SIGKILLed at this threshold instead
// of OOM-ing the single pm2 process. Linux-only (/proc); WORKER_TIMEOUT still
// bounds every platform.
const WORKER_RSS_LIMIT_BYTES =
  Math.max(64, Number(process.env.WORKER_RSS_LIMIT_MB) || 700) * 1024 * 1024;
const WORKER_RSS_POLL_MS = 2_000;

/** Worker argv for the anonymous lane (plan A2/A3): 28s soft budget, 4-page PDF cap. */
export const ANON_WORKER_ARGS: readonly string[] = ["--ocr-budget-ms=28000", "--max-pages=4"];

function isImage(fileName: string): boolean {
  return /\.(jpe?g|png|webp|gif|bmp)$/i.test(fileName);
}

// TEST-ONLY (mock mode): a log of every spawned worker argv, so the anon/auth
// arg plumbing is assertable without a real tesseract run.
function spawnLog(): string[][] | null {
  if (process.env.REGISTRY_MOCK !== "1" || process.env.NODE_ENV === "production") return null;
  const g = globalThis as typeof globalThis & { __dockaWorkerSpawnLog?: string[][] };
  if (!g.__dockaWorkerSpawnLog) g.__dockaWorkerSpawnLog = [];
  return g.__dockaWorkerSpawnLog;
}
export function __workerSpawnLog(): readonly string[][] {
  return spawnLog() ?? [];
}

// Spawn ONE recognition worker and resolve when it exits. Never throws — a
// failed worker degrades to empty results. NEVER resolves before the child
// actually exits (the one-lane invariant is exit-gated): the RSS watchdog only
// flags + SIGKILLs; the execFile callback does the resolving.
function spawnWorker(filePath: string, args: string[] = []): Promise<WorkerResult> {
  spawnLog()?.push([filePath, ...args]);
  return new Promise((resolve) => {
    let killedByWatchdog = false;
    let poll: NodeJS.Timeout | null = null;
    const clearPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    };
    const worker = path.join(process.cwd(), "scripts", "recognize-worker.mjs");
    const child = execFile(
      process.execPath,
      [worker, filePath, ...args],
      { cwd: process.cwd(), timeout: WORKER_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout, stderr) => {
        clearPoll();
        const errText = String(stderr ?? "");
        if (killedByWatchdog) {
          console.error(
            `[recognize] worker ${child.pid} SIGKILLed by RSS watchdog (> ${Math.round(WORKER_RSS_LIMIT_BYTES / 1024 / 1024)} MB)`
          );
          resolve({ qrText: null, ocrText: "", ocrTextAll: "", skipReason: "worker-crash" });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || "").trim());
          if (errText.trim()) {
            // Worker diagnostics ride stderr by contract — surface them.
            console.error("[recognize] worker stderr:", errText.slice(0, 2000));
          }
          const ocrText = parsed.ocrText ?? "";
          resolve({
            qrText: parsed.qrText ?? null,
            ocrText,
            ocrTextAll: parsed.ocrTextAll ?? ocrText,
            pages: typeof parsed.pages === "number" ? parsed.pages : undefined,
            pagesProcessed:
              typeof parsed.pagesProcessed === "number" ? parsed.pagesProcessed : undefined,
            pagesOcred: typeof parsed.pagesOcred === "number" ? parsed.pagesOcred : undefined,
            textLayerChars:
              typeof parsed.textLayerChars === "number" ? parsed.textLayerChars : undefined,
            skipReason: typeof parsed.skipReason === "string" ? parsed.skipReason : null,
          });
        } catch (e) {
          console.error(
            `[recognize] worker output unparseable (stdout ${String(stdout ?? "").length} ch, ${
              (e as Error)?.constructor?.name ?? "Error"
            })${errText.trim() ? "; stderr: " + errText.slice(0, 2000) : ""}`
          );
          resolve({ qrText: null, ocrText: "", ocrTextAll: "", skipReason: "worker-crash" });
        }
      }
    );

    // RSS watchdog: Linux-only (/proc); graceful no-op elsewhere (Windows dev
    // has no /proc — WORKER_TIMEOUT still bounds the run).
    if (process.platform === "linux" && child.pid) {
      poll = setInterval(() => {
        try {
          const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf-8");
          const m = /VmRSS:\s*(\d+)\s*kB/.exec(status);
          if (m && Number(m[1]) * 1024 > WORKER_RSS_LIMIT_BYTES) {
            killedByWatchdog = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* already dying */
            }
          }
        } catch {
          /* /proc entry can vanish between exit and callback — ignore */
        }
      }, WORKER_RSS_POLL_MS);
      poll.unref?.();
      child.on("exit", clearPoll);
      child.on("error", clearPoll);
    }
  });
}

// SERIALIZE recognition. tesseract.js is a heavy native/wasm engine, and two (or
// three — the mass-upload sends a batch concurrently) workers initialising at
// the same moment race each other and BOTH silently return empty text — the root
// cause of "OCR reads half my photos as a generic number". THE ONE LANE below
// guarantees only one worker runs at a time; because execFile's callback fires
// on process exit, the next upload's OCR starts only after the previous process
// has fully exited, so there is never any overlap. One photo ~4 s; a batch is
// processed back-to-back rather than all-at-once-and-mostly-failing.
// NEVER add a second concurrent worker/lane.
//
// Verify-upload plan §4 puts a PRIORITY QUEUE in front of the lane (still ONE
// worker at a time): authenticated jobs (the existing documents flow) enqueue
// AHEAD of anonymous verify-upload jobs, and anonymous jobs are capped at
// ANON_PENDING_CAP pending — the 5th concurrent anonymous upload skips
// recognition entirely (the caller records outcome "deferred"; the bytes are
// already persisted and an admin re-run picks them up).

export type WorkerResult = {
  qrText: string | null;
  ocrText: string;
  ocrTextAll: string;
  /** PDF meta (plan A2, additive): total pages in the document. */
  pages?: number;
  /** Pages within the --max-pages cap (first N in document order). */
  pagesProcessed?: number;
  /** Pages that actually got an OCR pass (budget may stop the loop early). */
  pagesOcred?: number;
  /** Text-layer length seen by the born-digital fast path. */
  textLayerChars?: number;
  /** Closed-vocabulary extraction-failure label (plan Decision 8), or null. */
  skipReason?: string | null;
};
type LaneJob = { filePath: string; args?: string[]; resolve: (r: WorkerResult) => void };

/** Anonymous jobs allowed queued-or-running at once (plan §4). */
const ANON_PENDING_CAP = 4;

const authQueue: LaneJob[] = [];
const anonQueue: LaneJob[] = [];
let laneBusy = false;
let anonPending = 0;

// Drain ONE job at a time: auth strictly first, then anonymous. spawnWorker
// never rejects by contract, but the lane must not wedge if it ever does
// (laneBusy stuck true forever) — the rejection arm frees the lane, degrades
// the job to empty results (same shape spawnWorker's own catch produces) and
// keeps pumping.
function pumpLane(): void {
  if (laneBusy) return;
  const job = authQueue.shift() ?? anonQueue.shift();
  if (!job) return;
  laneBusy = true;
  void spawnWorker(job.filePath, job.args ?? []).then(
    (r) => {
      laneBusy = false;
      job.resolve(r);
      pumpLane();
    },
    () => {
      laneBusy = false;
      job.resolve({ qrText: null, ocrText: "", ocrTextAll: "" });
      pumpLane();
    }
  );
}

// Authenticated lane entry — exact legacy semantics (unbounded queue, 120s
// worker run-time, no extra argv), now expressed through the priority queue.
function runWorker(filePath: string, args?: string[]): Promise<WorkerResult> {
  return new Promise((resolve) => {
    authQueue.push({ filePath, args, resolve });
    pumpLane();
  });
}

/**
 * Anonymous lane entry (verify-upload plan §4): queued BEHIND every
 * authenticated job; returns null WITHOUT enqueueing when ANON_PENDING_CAP
 * anonymous jobs are already pending (the caller settles that upload as
 * "deferred"). The anonymous 45 s enqueue-to-settle clock lives in the CALLER
 * (lib/verify-upload.ts) — this promise still resolves when the worker exits,
 * a late result is simply discarded there.
 *
 * Default argv is ANON_WORKER_ARGS (28s soft budget + 4-page PDF cap); the
 * escape-hatch retry (plan A4) passes its own shrunken-budget args instead.
 */
export function runWorkerAnon(filePath: string, args?: string[]): Promise<WorkerResult> | null {
  if (anonPending >= ANON_PENDING_CAP) return null;
  anonPending++;
  return new Promise((resolve) => {
    anonQueue.push({
      filePath,
      args: args ?? [...ANON_WORKER_ARGS],
      resolve: (r) => {
        anonPending--;
        resolve(r);
      },
    });
    pumpLane();
  });
}

/**
 * Admin re-run lane entry (verify-upload plan §7): rides the AUTH priority
 * queue — ahead of every anonymous job, unbounded, legacy worker run-time
 * semantics (no soft budget; worker default --max-pages=8) — so an
 * operator-triggered re-run is never starved or capped by anonymous upload
 * load. Still THE ONE lane: one worker at a time. Optional args exist for the
 * re-run escape hatch (--force-ocr) only.
 */
export function runWorkerAuthPriority(filePath: string, args?: string[]): Promise<WorkerResult> {
  return runWorker(filePath, args);
}

export type RecognizeOptions = {
  /**
   * Verify-upload plan §5: when set (public surfaces), registry lookups spend
   * the §2.4 per-IP + global budget BEFORE any outbound fetch. Existing
   * internal callers pass nothing — behavior unchanged.
   */
  clientIp?: string;
};

export async function recognizeImage(
  buf: Buffer,
  fileName: string,
  storedPath: string,
  opts?: RecognizeOptions
): Promise<Recognition> {
  // Cheap, native-free pre-check: a printed registry URL or token-named file.
  const candidates: { raw: string; via: "qr" | "embedded" }[] = [];
  const embedded = detectCodeFromFile(buf, fileName);
  if (embedded) candidates.push({ raw: embedded, via: "embedded" });

  // QR + OCR from the isolated worker.
  const { qrText, ocrText, ocrTextAll } = await runWorker(storedPath);
  if (qrText && qrText.trim()) candidates.push({ raw: qrText.trim(), via: "qr" });

  // --- Tier (a): route any code candidate through the registry --------
  // detectRegistry + dispatcher (plan §2.3.5): a foreign cert QR routes to the
  // right adapter with no other change. `verified` = capability-token machine
  // verification (EE parity, green); `pending-binding` = public-identifier
  // match that still must pass bindHolder. Every other outcome (no-match,
  // assist, unpinned fake domain, …) falls through to the OCR tier — exactly
  // the legacy behavior for an unverifiable code.
  for (const c of candidates) {
    const outcome = await resolveInput(c.raw, opts?.clientIp ? { clientIp: opts.clientIp } : undefined);
    if (outcome.kind === "verified") {
      return { source: "government", cert: outcome.cert, via: c.via };
    }
    if (outcome.kind === "pending-binding") {
      return { source: "pending-binding", cert: outcome.cert, country: outcome.country, via: c.via };
    }
  }

  // --- Tier (b): OCR best-effort --------------------------------------
  if (isImage(fileName)) {
    // Name/expiry/number come from the single cleanest (winning-orientation)
    // read, but the TITLE is matched over the union of every OCR pass so a
    // certificate name any orientation managed to read is never dropped by one
    // noisy pass — the fix for inconsistent title recognition across photos.
    const fields = parseOcr(ocrText);
    fields.title = pickTitle(ocrTextAll) ?? fields.title;
    // Even when OCR returns nothing readable, mark it as a photo (with null
    // fields) so the caller never leaves it with zero metadata.
    return { source: "photo", fields, ocrText };
  }

  return { source: "none" };
}
