// Server-side core of the anonymous certificate-upload verification feature
// (verify-upload plan §§1–5). The route (app/api/verify-upload) stays a thin
// HTTP shell; everything with a correctness rule lives here:
//
//  §2 persistence trio — every ACCEPTED upload leaves (a) the original bytes
//     under data/verify-uploads/<uuid>.<ext-from-magic>, (b) a DELETABLE
//     sidecar <uuid>.json holding the identifying detail (origName, hashes,
//     extraction), and (c) a PII-FREE hash-chained event in the
//     "verify-uploads" audit sink. The chain core NEVER holds origName or a
//     raw IP — only the date-rotated ipHash.
//  §4 recognition — anonymous jobs ride the ONE recognition lane behind auth
//     jobs (lib/recognize.ts), capped and bounded by a 45 s ENQUEUE-TO-SETTLE
//     clock. Every failure path (queue full, timeout, registry rate-limit /
//     network / 5xx, pm2 restart via the startup orphan sweep) converges to
//     phase "deferred": bytes + sidecar stay, admin re-runs later.
//  §5 routing — QR/URL candidates go straight through resolveInput (WITH
//     clientIp); bare OCR codes go through the keyword-gated candidate planner
//     (registry/keywords.ts) and are dispatched per-country via
//     countryOverride. Anonymous flows can NEVER mint a holder-bound green:
//     pending-binding stays pending-binding (bindHolder is never called here).

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { appendAudit, AUDIT_NO_IMPERSONATION, id } from "@/lib/db";
import { detectCodeFromFile } from "@/lib/detect";
import {
  exceedsPixelLimit,
  safeExt,
  sniffMagic,
  type SniffedType,
} from "@/lib/image-dims";
import { runWorkerAnon, runWorkerAuthPriority, type WorkerResult } from "@/lib/recognize";
import { registryMockMode, resolveInput } from "@/lib/registry";
import {
  isAutoCapability,
  keywordEvidence,
  planBareCodeCandidates,
  type BareCodeCandidate,
  type KeywordEvidence,
} from "@/lib/registry/keywords";
import type { CountryCode, ResolveOutcome } from "@/lib/registry/types";

// ---- §1 tunables ---------------------------------------------------------

/** Whole-request Content-Length ceiling (plan §1: >10 MB → 413, before body read). */
export const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
/** Original part cap (per-part re-check after formData). */
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
/** Derived (client JPEG re-encode) part cap — over → discarded non-fatally. */
export const MAX_DERIVED_BYTES = 5 * 1024 * 1024;
/** Refuse persistence when the data volume has less free space than this. */
export const DISK_FREE_FLOOR = 2 * 1024 * 1024 * 1024;
/** Corpus byte budget: 1 GB/day, in-memory, reset-on-restart BY DESIGN (§1). */
export const DAILY_BYTE_QUOTA = 1024 * 1024 * 1024;
/** Anonymous ENQUEUE-TO-SETTLE recognition budget (§4) — queue wait counts. */
export const ANON_SETTLE_MS = 45_000;
/**
 * Deadline-aware dispatch floor (pdf-verify plan Decision 15a): a registry
 * candidate is dispatched only with at least this much left on the anon
 * settle clock (2 fetches × 6s + slack). Below it, remaining candidates are
 * recorded as "skipped-budget" and — when nothing landed — the item settles
 * deferred with reason "budget" for the un-clocked admin re-run.
 */
export const CANDIDATE_MIN_MS = 14_000;
/** Reduced per-fetch registry timeout for anon dispatches (Decision 15b). */
const ANON_FETCH_TIMEOUT_MS = 6_000;
/**
 * Escape-hatch retry floor (plan A2.3/A4): a --force-ocr re-run only happens
 * with at least this much OCR budget left — a sub-6s pass can't produce a
 * usable read; the item settles honestly instead.
 */
const RETRY_MIN_BUDGET_MS = 6_000;
/** Sidecars still phase:"received" after this long are swept to "deferred". */
const ORPHAN_AGE_MS = 10 * 60_000;

/**
 * §1 rate limit for POST /api/verify-upload, spent through the SHARED
 * consumeBudget core: per-IP burst 3 / one token per 20 s, PLUS the NAMED
 * per-surface global counter (burst 10 / one token per 6 s) — deliberately its
 * own bucket, never the registry-outbound `globalBucket` (`useGlobal`).
 */
export const VERIFY_UPLOAD_BUDGET = {
  capacity: 3,
  refillPerMs: 1 / 20_000,
  globalName: "verify-upload",
  globalCapacity: 10,
  globalRefillPerMs: 1 / 6_000,
} as const;

const DATA_DIR = path.join(process.cwd(), "data");
/** Exported for the admin surface (plan §7) — single source for the corpus dir. */
export const UPLOAD_DIR = path.join(DATA_DIR, "verify-uploads");

// Sniffed types the recognition WORKER can raster (jpeg-js/tesseract path);
// PDF/HEIC are stored + code-scanned but never handed to the worker.
const WORKER_RASTER: ReadonlySet<SniffedType> = new Set(["jpeg", "png", "webp", "gif", "bmp"]);

// ---- Module state (pinned on globalThis — same §6.2 rationale as registry) -

type VerifyUploadState = {
  /** Daily corpus byte counter — {YYYY-MM-DD, bytes}. In-memory by design. */
  quota: { day: string; bytes: number };
  /** Startup orphan sweep runs at most once per process. */
  sweepDone: boolean;
  /** Mock-mode-only disk-free override for unit tests. */
  testDiskFree?: number | null;
};

function state(): VerifyUploadState {
  const g = globalThis as typeof globalThis & { __dockaVerifyUploadState?: VerifyUploadState };
  if (!g.__dockaVerifyUploadState) {
    g.__dockaVerifyUploadState = { quota: { day: "", bytes: 0 }, sweepDone: false };
  }
  return g.__dockaVerifyUploadState;
}

/** TEST-ONLY (mock mode): override the disk-free probe. undefined clears. */
export function __setTestDiskFree(bytes: number | null | undefined): void {
  if (!registryMockMode()) return;
  state().testDiskFree = bytes;
}

/** TEST-ONLY (mock mode): pre-charge today's quota counter (503 unit test). */
export function __setTestQuotaBytes(bytes: number): void {
  if (!registryMockMode()) return;
  state().quota = { day: new Date().toISOString().slice(0, 10), bytes };
}

/** TEST-ONLY (mock mode): reset quota counter + sweep flag between cases. */
export function __resetVerifyUploadState(): void {
  if (!registryMockMode()) return;
  const s = state();
  s.quota = { day: "", bytes: 0 };
  s.sweepDone = false;
  s.testDiskFree = undefined;
}

// TEST-ONLY (mock mode): shrink the anon settle clock so the deadline-aware
// dispatch (skipped-budget) and timeout/lateResult paths are testable without
// 45s waits. null restores the production constant.
let testAnonSettleMs: number | null = null;
export function __setTestAnonSettleMs(ms: number | null): void {
  if (!registryMockMode()) return;
  testAnonSettleMs = ms;
}
function anonSettleMs(): number {
  return registryMockMode() && testAnonSettleMs !== null ? testAnonSettleMs : ANON_SETTLE_MS;
}

// ---- §2 date-rotated ipHash ----------------------------------------------

/** The configured salt, or null — the route answers 503 when unconfigured. */
export function verifyIpSalt(): string | null {
  const s = process.env.VERIFY_IP_SALT;
  return s && s.trim() ? s.trim() : null;
}

/**
 * ipHash = HMAC-SHA256(ip, key = HMAC-SHA256(VERIFY_IP_SALT, YYYY-MM-DD)).
 * DATE-ROTATED (architect r2 #3): same-day abuse correlation works, long-term
 * linkability dies with the day key. Throws when the salt is unconfigured —
 * a chain line must never fall back to a weaker (linkable) form.
 */
export function ipHashFor(ip: string, at: Date = new Date()): string {
  const salt = verifyIpSalt();
  if (!salt) throw new Error("VERIFY_IP_SALT is not configured");
  const day = at.toISOString().slice(0, 10);
  const dayKey = crypto.createHmac("sha256", salt).update(day).digest();
  return crypto.createHmac("sha256", dayKey).update(ip).digest("hex");
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---- §1 storage gates ------------------------------------------------------

function diskFreeBytes(): number | null {
  const override = state().testDiskFree;
  if (registryMockMode() && override !== undefined) return override;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const s = fs.statfsSync(DATA_DIR);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // probe failure must not block uploads — the floor is best-effort
  }
}

export type StorageGate =
  | { ok: true }
  | { ok: false; reason: "disk-floor"; bytesFree: number }
  | { ok: false; reason: "daily-quota" };

/**
 * Disk-free floor + daily corpus byte budget (§1). Checked AFTER the cheap
 * request gates and BEFORE any byte touches disk. Over-floor appends a
 * bytes-free REFUSAL event to the chain (no file, no sidecar); over-quota is a
 * plain 503 (reset-on-restart in-memory counter, by design).
 */
export function checkStorageGates(incomingBytes: number): StorageGate {
  const free = diskFreeBytes();
  if (free !== null && free < DISK_FREE_FLOOR) {
    return { ok: false, reason: "disk-floor", bytesFree: free };
  }
  const s = state();
  const today = new Date().toISOString().slice(0, 10);
  if (s.quota.day !== today) s.quota = { day: today, bytes: 0 };
  if (s.quota.bytes + incomingBytes > DAILY_BYTE_QUOTA) {
    return { ok: false, reason: "daily-quota" };
  }
  return { ok: true };
}

/** Append the §1 disk-floor refusal event (persists NOTHING else). */
export async function auditDiskFloorRefusal(ipHash: string, bytesFree: number): Promise<void> {
  await appendAudit(
    "verify-uploads",
    {
      id: id(),
      at: new Date().toISOString(),
      ipHash,
      itemId: null,
      outcome: "refused",
      phase: "refused",
      reason: "disk-floor",
      bytesFree,
    },
    AUDIT_NO_IMPERSONATION
  );
}

// ---- §2 sidecar ------------------------------------------------------------

export type VerifyUploadPhase = "received" | "completed" | "deferred";

export type CandidateTried = {
  via: "embedded" | "qr" | "ocr";
  country: CountryCode | null;
  code: string;
  /**
   * ResolveOutcome kind, "error:<msg-class>", or the synthetic
   * "skipped-budget" marker (plan Decision 15a — the candidate was never
   * dispatched because the anon settle clock ran short; the admin re-run
   * picks it up). Sidecar-only vocabulary; the admin trace renders it.
   */
  outcome: string;
  /** UA-MARAD doctype fan-out (plan B5) — which wire doctype was dispatched. */
  doctype?: string;
};

/**
 * The DELETABLE per-item detail (plan §2b). This file (plus the original
 * bytes) is what the admin per-item delete removes; identifying detail
 * (origName, extraction text) lives HERE and never in the audit chain.
 */
export type VerifyUploadSidecar = {
  itemId: string;
  receivedAt: string;
  phase: VerifyUploadPhase;
  /** Client-supplied name — sidecar-only, NEVER in the chain core. */
  origName: string;
  /** Date-rotated hash (already in the chain; kept for the orphan sweep). */
  ipHash: string;
  sniffedType: SniffedType;
  size: number;
  sha256Original: string;
  storedFile: string; // basename of the stored original
  derived: { storedFile: string; sha256: string; size: number } | null;
  /** Keyword-map country hit (fallback prefill), null when nothing matched. */
  countryDetected: CountryCode | null;
  extraction: {
    embeddedCode: string | null;
    qrText: string | null;
    ocrText: string;
    ocrTextAll: string;
    /** Which bytes the worker actually ran on (plan §2b: which-bytes-verified). */
    workerRanOn: "derived" | "original" | null;
    candidatesTried: CandidateTried[];
    /**
     * Closed-vocabulary EXTRACTION-failure label (pdf-verify plan Decision 8):
     * worker-set (pdf-parse-error | pdf-encrypted | pdf-no-pages |
     * pdf-lib-missing | worker-crash), eligibility-set (heic-no-derived |
     * pixel-limit | unsupported-type), or post-hoc worker-empty. null = the
     * extraction itself did not fail. Old sidecars lack the field (optional).
     */
    skipReason?: string | null;
    /**
     * Companion label for "extraction succeeded but planning yielded nothing"
     * (Decision 8): "no-country-match" | "keyword-locked-manual" |
     * "hint-no-token" (2026-09-07: only a weak state-name hint matched and no
     * slash-form token backed it) | null — a cleanly-OCR'd unsupported-country
     * cert never renders as a naked "no registry called".
     */
    dispatchSkipReason?: string | null;
    /** PDF meta (additive, plan A2): total pages in the document. */
    pages?: number;
    /** Pages within the page cap (anon 4 / admin 8). */
    pagesProcessed?: number;
    /** Pages that actually got an OCR pass (soft budget may stop early). */
    pagesOcred?: number;
    /** Text-layer chars seen by the born-digital fast path. */
    textLayerChars?: number;
    /** Free-form processing notes (e.g. "text-layer-no-signal"). */
    notes?: string[];
    /**
     * Timeout-loser late completion (plan Decision 17): when the 45s settle
     * clock won the race, the still-running pipeline's eventual result is
     * merged in HERE (read-merge-write, staleness-guarded) so the operator
     * sees the answer without re-dispatching to the live registry.
     * Sidecar-only — never a chain event.
     */
    lateResult?: { outcome: string | null; candidatesTried: CandidateTried[]; completedAt: string };
  };
  /**
   * Settled label: a ResolveOutcome kind, "deferred", or the two nothing-
   * verifiable labels — "no-candidates" (nothing was ever dispatched) vs
   * "all-failed" (candidates WERE tried and every one errored / missed).
   */
  outcome: string | null;
  deferredReason: string | null;
  settledAt: string | null;
  /** Admin re-run history (wave 3 appends here). */
  retries: { at: string; outcome: string }[];
};

/** Exported for the admin surface (plan §7) — delete + tombstone checks. */
export function sidecarPath(itemId: string): string {
  return path.join(UPLOAD_DIR, `${itemId}.json`);
}

function writeSidecar(sc: VerifyUploadSidecar): void {
  fs.writeFileSync(sidecarPath(sc.itemId), JSON.stringify(sc, null, 2), "utf-8");
}

export function readSidecar(itemId: string): VerifyUploadSidecar | null {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(itemId), "utf-8")) as VerifyUploadSidecar;
  } catch {
    return null;
  }
}

// ---- §2 persistence (phase "received") -------------------------------------

export type PersistedUpload = {
  itemId: string;
  ipHash: string;
  sidecar: VerifyUploadSidecar;
  originalPath: string;
  derivedPath: string | null;
  /** IN-MEMORY ONLY (feeds the §2.4 registry budget) — never persisted. */
  clientIp: string;
};

export type PersistInput = {
  originalBuf: Buffer;
  sniffedType: SniffedType;
  origName: string;
  /** Already validated by the route: sniffed JPEG, ≤5 MB, pixel-gated. */
  derivedBuf: Buffer | null;
  clientIp: string;
};

/**
 * §2 persistence trio, phase "received": original bytes + sidecar + the
 * PII-free chain event, then the daily quota is charged. Runs only AFTER every
 * §1 gate passed — 411/413/415/429/503 persist NOTHING.
 */
export async function persistUpload(input: PersistInput): Promise<PersistedUpload> {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const itemId = id();
  const at = new Date();
  const ipHash = ipHashFor(input.clientIp, at);
  const ext = safeExt(input.sniffedType); // from SNIFFED magic only, never origName
  const storedFile = `${itemId}.${ext}`;
  const originalPath = path.join(UPLOAD_DIR, storedFile);
  fs.writeFileSync(originalPath, input.originalBuf);

  let derived: VerifyUploadSidecar["derived"] = null;
  let derivedPath: string | null = null;
  if (input.derivedBuf) {
    const derivedFile = `${itemId}.derived.jpg`;
    derivedPath = path.join(UPLOAD_DIR, derivedFile);
    fs.writeFileSync(derivedPath, input.derivedBuf);
    derived = {
      storedFile: derivedFile,
      sha256: sha256Hex(input.derivedBuf),
      size: input.derivedBuf.length,
    };
  }

  const sidecar: VerifyUploadSidecar = {
    itemId,
    receivedAt: at.toISOString(),
    phase: "received",
    origName: input.origName,
    ipHash,
    sniffedType: input.sniffedType,
    size: input.originalBuf.length,
    sha256Original: sha256Hex(input.originalBuf),
    storedFile,
    derived,
    countryDetected: null,
    extraction: {
      embeddedCode: null,
      qrText: null,
      ocrText: "",
      ocrTextAll: "",
      workerRanOn: null,
      candidatesTried: [],
      skipReason: null,
      dispatchSkipReason: null,
    },
    outcome: null,
    deferredReason: null,
    settledAt: null,
    retries: [],
  };
  writeSidecar(sidecar);

  // Phase-1 chain event — PII-FREE core (plan §2c).
  await appendAudit(
    "verify-uploads",
    {
      id: id(),
      at: at.toISOString(),
      ipHash,
      itemId,
      sha256Original: sidecar.sha256Original,
      size: sidecar.size,
      sniffedType: sidecar.sniffedType,
      countryDetected: null,
      outcome: "pending",
      phase: "received",
    },
    AUDIT_NO_IMPERSONATION
  );

  // Charge the daily quota only once the bytes actually landed.
  const s = state();
  const today = at.toISOString().slice(0, 10);
  if (s.quota.day !== today) s.quota = { day: today, bytes: 0 };
  s.quota.bytes += input.originalBuf.length + (input.derivedBuf?.length ?? 0);

  return { itemId, ipHash, sidecar, originalPath, derivedPath, clientIp: input.clientIp };
}

// ---- §4/§5 anonymous recognition -------------------------------------------

export type SettleResult =
  | { phase: "completed"; outcome: ResolveOutcome | null; countryDetected: CountryCode | null }
  | { phase: "deferred"; reason: string; countryDetected: CountryCode | null };

/**
 * Honest label for a completed settle with NOTHING verifiable: "no-candidates"
 * only when nothing was ever dispatched; "all-failed" when candidates WERE
 * tried and every one errored / missed (the old code mislabeled that case as
 * "no-candidates" — the LV specimen cross-fire bug's third finding).
 */
function settledNothingLabel(sc: VerifyUploadSidecar): string {
  return sc.extraction.candidatesTried.length > 0 ? "all-failed" : "no-candidates";
}

// ---- pdf-verify plan A4 helpers -------------------------------------------

/**
 * Eligibility skipReason when NO worker input exists (Decision 8): sniffed
 * heic without a derived JPEG, a raster image over the pixel ceiling, or a
 * type the worker cannot process at all.
 */
export function eligibilitySkipReason(sniffedType: SniffedType): string {
  if (sniffedType === "heic") return "heic-no-derived";
  if (WORKER_RASTER.has(sniffedType)) return "pixel-limit";
  return "unsupported-type";
}

/** Copy the worker's additive PDF meta into the sidecar extraction block. */
function applyWorkerMeta(sc: VerifyUploadSidecar, r: WorkerResult): void {
  if (typeof r.pages === "number") sc.extraction.pages = r.pages;
  if (typeof r.pagesProcessed === "number") sc.extraction.pagesProcessed = r.pagesProcessed;
  if (typeof r.pagesOcred === "number") sc.extraction.pagesOcred = r.pagesOcred;
  if (typeof r.textLayerChars === "number") sc.extraction.textLayerChars = r.textLayerChars;
  sc.extraction.skipReason = r.skipReason ?? null;
}

/**
 * Text-layer no-signal check (plan A2.3/A4 escape hatch): the fast path was
 * taken (≥200-char layer, zero pages OCRed) but the layer carries neither a
 * QR nor any STRONG keyword-country hit nor any code-token candidate — a
 * junk/watermark text layer over scanned pages must not mask the scan. A
 * weak hint alone (a layer that merely says "UKRAINE") is NOT signal: the
 * --force-ocr retry still runs (2026-09-07).
 */
function textLayerNoSignal(r: WorkerResult): boolean {
  return (
    (r.textLayerChars ?? 0) >= 200 &&
    (r.pagesOcred ?? 0) === 0 &&
    !r.qrText &&
    keywordEvidence(r.ocrTextAll).strong.length === 0 &&
    planBareCodeCandidates(r.ocrTextAll).length === 0
  );
}

/**
 * Settle-level `countryDetected` (2026-09-07, honest attribution): a STRONG
 * keyword hit attributes the country outright; a weak hint attributes it
 * ONLY when it produced a planned candidate ("Nationality: UKRAINE" on a
 * foreign CoC with no slash-form token stays null — as before the hint tier).
 * Exported for the unit pin.
 */
export function countryDetectedFrom(
  ev: KeywordEvidence,
  planned: readonly BareCodeCandidate[]
): CountryCode | null {
  if (ev.strong.length) return ev.strong[0];
  const hint = ev.hint[0];
  return hint && planned.some((c) => c.country === hint) ? hint : null;
}

/**
 * Companion "planning yielded nothing" label (Decision 8): OCR text exists
 * but the planner produced zero candidates. A hint never yields
 * "keyword-locked-manual" (hints never lock); hint-only evidence with no
 * backing token is its own label, "hint-no-token".
 */
export function dispatchSkipReasonFor(ocrTextAll: string, plannedCount: number): string | null {
  if (!ocrTextAll.trim() || plannedCount > 0) return null;
  const ev = keywordEvidence(ocrTextAll);
  if (ev.strong.length === 1 && !isAutoCapability(ev.strong[0])) return "keyword-locked-manual";
  if (ev.strong.length === 0 && ev.hint.length > 0) return "hint-no-token";
  return "no-country-match";
}

/**
 * Timeout-loser late-result persistence (Decision 17): READ-MERGE-WRITE. The
 * loser re-reads the sidecar from disk, merges ONLY extraction.lateResult
 * into the fresh content and writes back — never its stale in-memory object.
 * Staleness guard: if the settle state changed since the loser's settle (an
 * interim admin re-run), the write is skipped and the lateResult dropped.
 */
function writeLateResult(
  itemId: string,
  observed: { phase: string; outcome: string | null; settledAt: string | null },
  late: SettleResult,
  loserCandidates: CandidateTried[]
): void {
  try {
    const fresh = readSidecar(itemId);
    if (!fresh) return; // deleted in the interim — nothing to persist onto
    if (
      fresh.phase !== observed.phase ||
      fresh.outcome !== observed.outcome ||
      fresh.settledAt !== observed.settledAt
    ) {
      console.warn(
        `[verify-upload] lateResult dropped for ${itemId}: settle state changed since timeout (interim re-run holds the authoritative answer)`
      );
      return;
    }
    fresh.extraction.lateResult = {
      outcome:
        late.phase === "completed"
          ? late.outcome?.kind ?? (loserCandidates.length > 0 ? "all-failed" : "no-candidates")
          : `deferred:${late.reason}`,
      candidatesTried: loserCandidates,
      completedAt: new Date().toISOString(),
    };
    writeSidecar(fresh);
  } catch (e) {
    console.warn(
      `[verify-upload] lateResult write failed for ${itemId}: ${(e as Error)?.message ?? e}`
    );
  }
}

// §4: registry-side failures AFTER persist settle as re-runnable "deferred",
// never completed-with-error. rateLimited is flagged; transport failures and
// adapter 5xx surface as the stable "Could not reach…" / "could not confirm…"
// dispatcher strings (legacy-parity constants in registry/index.ts).
function deferredReasonForOutcome(outcome: ResolveOutcome): string | null {
  if (outcome.kind !== "error") return null;
  if (outcome.rateLimited) return "registry-rate-limited";
  if (/^Could not reach/.test(outcome.error)) return "registry-network";
  if (/could not confirm this certificate/.test(outcome.error)) return "registry-indeterminate";
  return null;
}

/**
 * Run §4/§5 recognition for a persisted anonymous upload and settle it —
 * sidecar updated + the phase-2 chain event appended EXACTLY once, whether the
 * pipeline finishes or the 45 s enqueue-to-settle clock expires first (a late
 * pipeline result is discarded; the admin re-run is the recovery path).
 */
export async function runAnonymousRecognition(item: PersistedUpload): Promise<SettleResult> {
  const sc = item.sidecar;
  let settled = false;

  const settleOnce = async (result: SettleResult): Promise<SettleResult> => {
    if (settled) return result;
    settled = true;
    // §7-parity tombstone guard (review fix): an admin delete racing the
    // INITIAL settle must never resurrect the sidecar. Same probe + event as
    // rerunRecognition's recordDeletedDuringRun; the check→write window below
    // stays synchronous (no await between), like the re-run path.
    if (itemDeleted(sc.itemId, item.originalPath)) {
      await appendAudit(
        "verify-uploads",
        {
          id: id(),
          at: new Date().toISOString(),
          ipHash: sc.ipHash,
          itemId: sc.itemId,
          sha256Original: sc.sha256Original,
          size: sc.size,
          sniffedType: sc.sniffedType,
          countryDetected: null,
          outcome: "deleted-during-run",
          phase: "deleted-during-run",
        },
        AUDIT_NO_IMPERSONATION
      );
      return result;
    }
    sc.phase = result.phase;
    sc.countryDetected = result.countryDetected;
    sc.outcome = result.phase === "completed" ? result.outcome?.kind ?? settledNothingLabel(sc) : "deferred";
    sc.deferredReason = result.phase === "deferred" ? result.reason : null;
    sc.settledAt = new Date().toISOString();
    try {
      writeSidecar(sc);
    } catch (e) {
      /* the chain event below is still the source of truth */
      console.error(
        `[verify-upload] sidecar write failed for ${sc.itemId}: ${(e as Error)?.message ?? e}`
      );
    }
    await appendAudit(
      "verify-uploads",
      {
        id: id(),
        at: sc.settledAt,
        ipHash: sc.ipHash,
        itemId: sc.itemId,
        sha256Original: sc.sha256Original,
        size: sc.size,
        sniffedType: sc.sniffedType,
        countryDetected: result.countryDetected,
        outcome: sc.outcome,
        phase: result.phase,
        // Non-PII counters (plan Decision 8; chain contract db.ts §):
        skipReason: sc.extraction.skipReason ?? null,
        pages: sc.extraction.pages ?? null,
      },
      AUDIT_NO_IMPERSONATION
    );
    return result;
  };

  // Settle-deadline (pdf-verify plan Decision 15a): computed BEFORE the
  // enqueue so queue wait counts; the pipeline closure captures it.
  const deadlineAt = Date.now() + anonSettleMs();
  const startedAt = Date.now();

  const pipeline = async (): Promise<SettleResult> => {
    const originalBuf = fs.readFileSync(item.originalPath);

    // 1. Cheap native-free pre-check (§4): embedded registry URLs / token-shaped
    //    names — works on PDF bytes too.
    const embedded = detectCodeFromFile(originalBuf, sc.origName);
    sc.extraction.embeddedCode = embedded;
    const rawCandidates: { raw: string; via: "embedded" | "qr" }[] = [];
    if (embedded) rawCandidates.push({ raw: embedded, via: "embedded" });

    // 2. Worker input (§4): derived JPEG when kept, else the original when the
    //    worker can process it — raster images pixel-gated BEFORE any spawn
    //    (§3); PDFs bypass exceedsPixelLimit BY DESIGN (header-based, null for
    //    PDFs) — the worker's own page/raster caps are the gate (plan A2.2).
    let workerPath: string | null = null;
    let workerRanOn: "derived" | "original" | null = null;
    if (item.derivedPath) {
      workerPath = item.derivedPath;
      workerRanOn = "derived";
    } else if (WORKER_RASTER.has(sc.sniffedType) && !exceedsPixelLimit(originalBuf, sc.sniffedType)) {
      workerPath = item.originalPath;
      workerRanOn = "original";
    } else if (sc.sniffedType === "pdf") {
      workerPath = item.originalPath;
      workerRanOn = "original";
    }

    let qrText: string | null = null;
    let ocrText = "";
    let ocrTextAll = "";
    if (workerPath) {
      const run = runWorkerAnon(workerPath);
      if (!run) {
        // Anonymous pending cap hit (§4) — nothing enqueued, settle deferred.
        return { phase: "deferred", reason: "queue-full", countryDetected: null };
      }
      sc.extraction.workerRanOn = workerRanOn;
      let r = await run;

      // Text-layer no-signal escape hatch (plan A2.3/A4): ONE --force-ocr
      // retry with the SHRUNKEN remaining budget — never the fixed 28000.
      if (textLayerNoSignal(r)) {
        sc.extraction.notes = [...(sc.extraction.notes ?? []), "text-layer-no-signal"];
        const retryBudget = Math.max(0, deadlineAt - Date.now() - CANDIDATE_MIN_MS);
        if (retryBudget >= RETRY_MIN_BUDGET_MS) {
          const rerun = runWorkerAnon(workerPath, [
            `--ocr-budget-ms=${retryBudget}`,
            "--max-pages=4",
            "--force-ocr",
          ]);
          if (rerun) r = await rerun;
          // cap-refused retry → settle honestly with the text-layer result
        }
        // sub-floor budget → settle honestly; deferral + re-run covers it
      }

      qrText = r.qrText;
      ocrText = r.ocrText;
      ocrTextAll = r.ocrTextAll;
      sc.extraction.qrText = qrText;
      sc.extraction.ocrText = ocrText;
      sc.extraction.ocrTextAll = ocrTextAll;
      applyWorkerMeta(sc, r);
      // Post-hoc: the worker ran but produced neither QR nor any text.
      if (!sc.extraction.skipReason && !qrText && !ocrTextAll.trim()) {
        sc.extraction.skipReason = "worker-empty";
      }
    } else {
      sc.extraction.skipReason = eligibilitySkipReason(sc.sniffedType);
    }
    if (qrText && qrText.trim()) rawCandidates.push({ raw: qrText.trim(), via: "qr" });

    const ev = keywordEvidence(ocrTextAll);
    const planned = planBareCodeCandidates(ocrTextAll);
    const countryDetected: CountryCode | null = countryDetectedFrom(ev, planned);
    sc.extraction.dispatchSkipReason = dispatchSkipReasonFor(ocrTextAll, planned.length);
    // Honesty note: only a weak state-name hint pointed at a country (the
    // strong authority keywords did not survive OCR) — recorded whether or
    // not the hint produced a candidate.
    if (!ev.strong.length && ev.hint.length) {
      sc.extraction.notes = [...(sc.extraction.notes ?? []), "country-hint-only"];
    }

    // Deadline guard (Decision 15a): a candidate dispatches only with at
    // least CANDIDATE_MIN_MS left on the settle clock; the rest are recorded
    // as "skipped-budget" and — when nothing landed — the item defers.
    let skippedBudget = false;
    const outOfTime = () => deadlineAt - Date.now() < CANDIDATE_MIN_MS;
    // A registry-INDETERMINATE candidate must not sink the ones after it
    // (pdf-verify plan, v1 test 3: a drifted 71 answer still lets the 70
    // dispatch land) — remembered, deferred only when nothing later lands.
    // Network/rate-limit failures still defer immediately (hammering the next
    // candidate during an outage helps nobody).
    let pendingIndeterminate: string | null = null;
    // A needs-inputs answer is the registry saying "right code, missing keys"
    // (AZ dob, UA-MARAD issuedOn/doctype) — the EXTRACTED code must survive to
    // the UI so the user supplies the keys instead of retyping the code the
    // OCR already read (2026-08-24 live AZ defect). Remembered, surfaced only
    // when nothing verifiable lands (mirrors resolveInput's own exhaustion
    // ranking: an actionable prompt beats a dead end).
    let pendingNeedsInputs: Extract<ResolveOutcome, { kind: "needs-inputs" }> | null = null;

    // 3. QR/URL/embedded candidates through the full dispatcher (§5) —
    //    detection handles pinned domains; budget + result cache apply.
    for (const c of rawCandidates) {
      if (outOfTime()) {
        skippedBudget = true;
        sc.extraction.candidatesTried.push({ via: c.via, country: null, code: c.raw, outcome: "skipped-budget" });
        continue;
      }
      const outcome = await resolveInput(c.raw, {
        clientIp: item.clientIp,
        fetchTimeoutMs: ANON_FETCH_TIMEOUT_MS,
      });
      sc.extraction.candidatesTried.push({ via: c.via, country: null, code: c.raw, outcome: outcome.kind });
      if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
        return { phase: "completed", outcome, countryDetected };
      }
      if (outcome.kind === "needs-inputs") pendingNeedsInputs ??= outcome;
      const deferred = deferredReasonForOutcome(outcome);
      if (deferred === "registry-indeterminate") {
        pendingIndeterminate ??= deferred;
        continue;
      }
      if (deferred) return { phase: "deferred", reason: deferred, countryDetected };
    }

    // 4. Bare OCR codes (§5): keyword-gated planner — EE fallback EXCLUDED
    //    unless the keyword map independently says EE; ≤3 candidates; each
    //    dispatched as a CERTAIN candidate at exactly its country (with any
    //    planner-extracted extraInputs, e.g. UA-MARAD issuedOn + doctype);
    //    stop at the first match-valid / match-invalid / pending-binding.
    for (const cand of planned) {
      if (outOfTime()) {
        skippedBudget = true;
        sc.extraction.candidatesTried.push({
          via: "ocr",
          country: cand.country,
          code: cand.code,
          outcome: "skipped-budget",
          ...(cand.extraInputs?.doctype ? { doctype: cand.extraInputs.doctype } : {}),
        });
        continue;
      }
      const outcome = await resolveInput(cand.code, {
        countryOverride: cand.country,
        clientIp: item.clientIp,
        extraInputs: cand.extraInputs,
        fetchTimeoutMs: ANON_FETCH_TIMEOUT_MS,
      });
      sc.extraction.candidatesTried.push({
        via: "ocr",
        country: cand.country,
        code: cand.code,
        outcome: outcome.kind,
        ...(cand.extraInputs?.doctype ? { doctype: cand.extraInputs.doctype } : {}),
      });
      if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
        return { phase: "completed", outcome, countryDetected };
      }
      if (outcome.kind === "needs-inputs") pendingNeedsInputs ??= outcome;
      const deferred = deferredReasonForOutcome(outcome);
      if (deferred === "registry-indeterminate") {
        pendingIndeterminate ??= deferred;
        continue;
      }
      if (deferred) return { phase: "deferred", reason: deferred, countryDetected };
    }

    // Budget-skipped candidates with NOTHING landed → deferred "budget": the
    // un-clocked admin re-run picks the skipped candidates up.
    if (skippedBudget) {
      return { phase: "deferred", reason: "budget", countryDetected };
    }
    // Needs-inputs with nothing verifiable after it → completed WITH the
    // needs-inputs outcome: the route ships it and the UI renders the §5.2
    // prompt (extracted code prefilled, missing keys asked) instead of the
    // code-discarding generic fallback. Ranked above indeterminate exactly as
    // in resolveInput's exhaustion order — the prompt is user-actionable NOW;
    // the doc stays saved and admin-re-runnable either way.
    if (pendingNeedsInputs) {
      return { phase: "completed", outcome: pendingNeedsInputs, countryDetected };
    }
    // An indeterminate answer with nothing landing after it: re-runnable.
    if (pendingIndeterminate) {
      return { phase: "deferred", reason: pendingIndeterminate, countryDetected };
    }

    // Nothing verifiable — completed with no outcome: the route renders the
    // guided fallback (retry tips + manual entry prefilled from the keyword hit).
    return { phase: "completed", outcome: null, countryDetected };
  };

  // §4 one-clock budget: enqueue-to-settle. The race winner settles; the loser
  // is discarded by the `settled` guard inside settleOnce — EXCEPT that a
  // timeout-loser pipeline completion is persisted as extraction.lateResult
  // (Decision 17) so its already-made registry dispatches are not wasted.
  const pipelinePromise = pipeline();
  const raced = await new Promise<SettleResult>((resolve) => {
    const timer = setTimeout(
      () => resolve({ phase: "deferred", reason: "timeout", countryDetected: null }),
      anonSettleMs()
    );
    // Node keeps the process alive for the worker anyway; don't let this timer
    // add its own hold on test/exit paths.
    timer.unref?.();
    pipelinePromise.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (err) => {
        clearTimeout(timer);
        console.error(
          `[verify-upload] pipeline-error for ${sc.itemId}: ${(err as Error)?.message ?? err}`
        );
        resolve({ phase: "deferred", reason: "pipeline-error", countryDetected: null });
      }
    );
  });

  const settledResult = await settleOnce(raced);

  if (raced.phase === "deferred" && raced.reason === "timeout") {
    // The loser keeps running; on completion, read-merge-write its result
    // into the sidecar (staleness-guarded — an interim admin re-run wins).
    const observed = { phase: sc.phase, outcome: sc.outcome, settledAt: sc.settledAt };
    void pipelinePromise.then(
      (late) => writeLateResult(sc.itemId, observed, late, sc.extraction.candidatesTried),
      () => {} // loser crashed after the settle — nothing to persist
    );
  }

  // One-line settle summary (Decision 9 — lengths/counts only, never OCR
  // text, never origName).
  console.error(
    `[verify-upload] settle ${sc.itemId}: type=${sc.sniffedType} pages=${sc.extraction.pages ?? "-"} ` +
      `ocrChars=${sc.extraction.ocrTextAll.length} country=${sc.countryDetected ?? "-"} ` +
      `candidates=${sc.extraction.candidatesTried.length} skip=${sc.extraction.skipReason ?? "-"} ` +
      `outcome=${sc.outcome ?? "-"} ms=${Date.now() - startedAt}`
  );

  return settledResult;
}

// ---- §2 startup orphan sweep -----------------------------------------------

/**
 * §2 (tester r2 #1): a pm2 restart mid-recognition leaves sidecars stuck at
 * phase "received". No cron exists on the box, so the sweep runs in-process:
 * once per boot (first request), any sidecar received >10 min ago is settled
 * as "deferred" (chain event + sidecar fix) for the admin re-run queue.
 */
export function ensureOrphanSweep(): void {
  const s = state();
  if (s.sweepDone) return;
  s.sweepDone = true;
  void sweepOrphans().catch(() => {});
}

async function sweepOrphans(): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(UPLOAD_DIR).filter((f) => /\.json$/i.test(f));
  } catch {
    return; // no upload dir yet — nothing to sweep
  }
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  for (const f of files) {
    let sc: VerifyUploadSidecar;
    try {
      sc = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), "utf-8")) as VerifyUploadSidecar;
    } catch {
      continue;
    }
    if (sc.phase !== "received") continue;
    const received = Date.parse(sc.receivedAt);
    if (!Number.isFinite(received) || received > cutoff) continue;

    sc.phase = "deferred";
    sc.outcome = "deferred";
    sc.deferredReason = "orphaned-restart";
    sc.settledAt = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, f), JSON.stringify(sc, null, 2), "utf-8");
    } catch {
      continue; // unwritable sidecar: skip, retried next boot
    }
    await appendAudit(
      "verify-uploads",
      {
        id: id(),
        at: sc.settledAt,
        ipHash: sc.ipHash,
        itemId: sc.itemId,
        sha256Original: sc.sha256Original,
        size: sc.size,
        sniffedType: sc.sniffedType,
        countryDetected: sc.countryDetected,
        outcome: "deferred",
        phase: "deferred",
        skipReason: sc.extraction?.skipReason ?? null,
        pages: sc.extraction?.pages ?? null,
      },
      AUDIT_NO_IMPERSONATION
    );
  }
}

// ---- §7 admin re-run ---------------------------------------------------

export type RerunResult =
  | { status: "not-found" }
  /** The item was tombstoned after the re-run started (plan §7 / tester r2 #4). */
  | { status: "deleted-during-run" }
  | { status: "completed"; outcome: string | null; countryDetected: CountryCode | null }
  | { status: "deferred"; reason: string; countryDetected: CountryCode | null };

/** Tombstone probe: the admin delete removes bytes AND sidecar — either gone = deleted. */
function itemDeleted(itemId: string, originalPath: string): boolean {
  return !fs.existsSync(sidecarPath(itemId)) || !fs.existsSync(originalPath);
}

/**
 * Admin "Re-run recognition" (plan §7). Same §4/§5 pipeline as the anonymous
 * settle, with the admin differences:
 *
 *  - AUTH priority on THE ONE worker lane (never the anonymous cap, never the
 *    45 s enqueue-to-settle clock — legacy worker run-time semantics);
 *  - registry lookups as an INTERNAL caller (no per-IP budget — same as the
 *    authenticated recognizeImage path);
 *  - tombstone check IMMEDIATELY before worker start AND again before the
 *    sidecar write: a delete racing the queued re-run yields outcome
 *    "deleted-during-run" in the chain and NEVER resurrects sidecar or bytes;
 *  - the attempt is recorded in sidecar `retries[]` and a completed/deferred
 *    chain event (flagged `rerun: true`) is appended on settle.
 */
export async function rerunRecognition(itemId: string): Promise<RerunResult> {
  const sc = readSidecar(itemId);
  if (!sc) return { status: "not-found" };
  const originalPath = path.join(UPLOAD_DIR, path.basename(sc.storedFile));
  const derivedPath = sc.derived ? path.join(UPLOAD_DIR, path.basename(sc.derived.storedFile)) : null;
  if (!fs.existsSync(originalPath)) return { status: "not-found" };

  // A deletion observed AFTER the re-run started — chain-record it, resurrect
  // NOTHING (no sidecar write, no bytes). The tombstone event from the delete
  // plus this line make the race fully reconstructable from the chain alone.
  const recordDeletedDuringRun = async (): Promise<RerunResult> => {
    await appendAudit(
      "verify-uploads",
      {
        id: id(),
        at: new Date().toISOString(),
        ipHash: sc.ipHash,
        itemId: sc.itemId,
        sha256Original: sc.sha256Original,
        size: sc.size,
        sniffedType: sc.sniffedType,
        countryDetected: null,
        outcome: "deleted-during-run",
        phase: "deleted-during-run",
        rerun: true,
      },
      AUDIT_NO_IMPERSONATION
    );
    return { status: "deleted-during-run" };
  };

  let result: SettleResult;
  try {
    const originalBuf = fs.readFileSync(originalPath);

    // Fresh extraction — the latest attempt overwrites `extraction`; history
    // lives in `retries[]` (in memory only until the guarded write below).
    sc.extraction.candidatesTried = [];
    sc.extraction.skipReason = null;
    sc.extraction.dispatchSkipReason = null;
    delete sc.extraction.pages;
    delete sc.extraction.pagesProcessed;
    delete sc.extraction.pagesOcred;
    delete sc.extraction.textLayerChars;
    delete sc.extraction.notes;
    delete sc.extraction.lateResult;
    const embedded = detectCodeFromFile(originalBuf, sc.origName);
    sc.extraction.embeddedCode = embedded;
    const rawCandidates: { raw: string; via: "embedded" | "qr" }[] = [];
    if (embedded) rawCandidates.push({ raw: embedded, via: "embedded" });

    // Worker input: derived JPEG when kept, else the pixel-gated raster
    // original; PDFs go to the worker's own page/raster caps (plan A2.2,
    // admin semantics: worker default --max-pages=8, no soft budget).
    let workerPath: string | null = null;
    let workerRanOn: "derived" | "original" | null = null;
    if (derivedPath && fs.existsSync(derivedPath)) {
      workerPath = derivedPath;
      workerRanOn = "derived";
    } else if (WORKER_RASTER.has(sc.sniffedType) && !exceedsPixelLimit(originalBuf, sc.sniffedType)) {
      workerPath = originalPath;
      workerRanOn = "original";
    } else if (sc.sniffedType === "pdf") {
      workerPath = originalPath;
      workerRanOn = "original";
    }

    let qrText: string | null = null;
    let ocrText = "";
    let ocrTextAll = "";
    if (workerPath) {
      // §7 tombstone check IMMEDIATELY before worker start.
      if (itemDeleted(itemId, originalPath)) return await recordDeletedDuringRun();
      let r = await runWorkerAuthPriority(workerPath);
      // Escape hatch, re-run flavor (plan A4): no clock here — a no-signal
      // text layer always earns ONE --force-ocr retry (worker defaults).
      if (textLayerNoSignal(r)) {
        sc.extraction.notes = [...(sc.extraction.notes ?? []), "text-layer-no-signal"];
        r = await runWorkerAuthPriority(workerPath, ["--force-ocr"]);
      }
      sc.extraction.workerRanOn = workerRanOn;
      qrText = r.qrText;
      ocrText = r.ocrText;
      ocrTextAll = r.ocrTextAll;
      sc.extraction.qrText = qrText;
      sc.extraction.ocrText = ocrText;
      sc.extraction.ocrTextAll = ocrTextAll;
      applyWorkerMeta(sc, r);
      if (!sc.extraction.skipReason && !qrText && !ocrTextAll.trim()) {
        sc.extraction.skipReason = "worker-empty";
      }
    } else {
      sc.extraction.skipReason = eligibilitySkipReason(sc.sniffedType);
    }
    if (qrText && qrText.trim()) rawCandidates.push({ raw: qrText.trim(), via: "qr" });

    const ev = keywordEvidence(ocrTextAll);
    const planned = planBareCodeCandidates(ocrTextAll);
    const countryDetected: CountryCode | null = countryDetectedFrom(ev, planned);
    sc.extraction.dispatchSkipReason = dispatchSkipReasonFor(ocrTextAll, planned.length);
    // Honesty note (mirrors the anon settle; `delete sc.extraction.notes`
    // above keeps it fresh per attempt — never duplicated across re-runs).
    if (!ev.strong.length && ev.hint.length) {
      sc.extraction.notes = [...(sc.extraction.notes ?? []), "country-hint-only"];
    }

    result = await (async (): Promise<SettleResult> => {
      // Indeterminate-continue mirrors the anon loop: a drifted answer on one
      // doctype must not sink the next dispatch.
      let pendingIndeterminate: string | null = null;
      // Needs-inputs mirrors the anon loop too (2026-08-24 defect fix): the
      // re-run's settled label must say "needs-inputs", never "all-failed",
      // when the registry only wants more keys for a code that WAS read.
      let pendingNeedsInputs: Extract<ResolveOutcome, { kind: "needs-inputs" }> | null = null;
      // QR/URL/embedded candidates through the full dispatcher (§5).
      for (const c of rawCandidates) {
        const outcome = await resolveInput(c.raw);
        sc.extraction.candidatesTried.push({ via: c.via, country: null, code: c.raw, outcome: outcome.kind });
        if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
          return { phase: "completed", outcome, countryDetected };
        }
        if (outcome.kind === "needs-inputs") pendingNeedsInputs ??= outcome;
        const deferred = deferredReasonForOutcome(outcome);
        if (deferred === "registry-indeterminate") {
          pendingIndeterminate ??= deferred;
          continue;
        }
        if (deferred) return { phase: "deferred", reason: deferred, countryDetected };
      }
      // Bare OCR codes: keyword-gated planner, EE fallback excluded, ≤3 cap;
      // planner-extracted extraInputs (UA-MARAD issuedOn + doctype) ride along.
      for (const cand of planned) {
        const outcome = await resolveInput(cand.code, {
          countryOverride: cand.country,
          extraInputs: cand.extraInputs,
        });
        sc.extraction.candidatesTried.push({
          via: "ocr",
          country: cand.country,
          code: cand.code,
          outcome: outcome.kind,
          ...(cand.extraInputs?.doctype ? { doctype: cand.extraInputs.doctype } : {}),
        });
        if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
          return { phase: "completed", outcome, countryDetected };
        }
        if (outcome.kind === "needs-inputs") pendingNeedsInputs ??= outcome;
        const deferred = deferredReasonForOutcome(outcome);
        if (deferred === "registry-indeterminate") {
          pendingIndeterminate ??= deferred;
          continue;
        }
        if (deferred) return { phase: "deferred", reason: deferred, countryDetected };
      }
      if (pendingNeedsInputs) {
        return { phase: "completed", outcome: pendingNeedsInputs, countryDetected };
      }
      if (pendingIndeterminate) {
        return { phase: "deferred", reason: pendingIndeterminate, countryDetected };
      }
      return { phase: "completed", outcome: null, countryDetected };
    })();
  } catch (err) {
    // ENOENT mid-pipeline IS the race — classify before falling back.
    if (itemDeleted(itemId, originalPath)) return await recordDeletedDuringRun();
    console.error(
      `[verify-upload] rerun pipeline-error for ${itemId}: ${(err as Error)?.message ?? err}`
    );
    result = { phase: "deferred", reason: "pipeline-error", countryDetected: null };
  }

  // §7 tombstone check AGAIN immediately before the sidecar write.
  if (itemDeleted(itemId, originalPath)) return await recordDeletedDuringRun();

  const at = new Date().toISOString();
  sc.phase = result.phase;
  sc.countryDetected = result.countryDetected;
  sc.outcome =
    result.phase === "completed" ? result.outcome?.kind ?? settledNothingLabel(sc) : "deferred";
  sc.deferredReason = result.phase === "deferred" ? result.reason : null;
  sc.settledAt = at;
  sc.retries.push({ at, outcome: sc.outcome });
  try {
    writeSidecar(sc);
  } catch (e) {
    /* the chain event below is still the source of truth */
    console.error(
      `[verify-upload] rerun sidecar write failed for ${sc.itemId}: ${(e as Error)?.message ?? e}`
    );
  }

  await appendAudit(
    "verify-uploads",
    {
      id: id(),
      at,
      ipHash: sc.ipHash,
      itemId: sc.itemId,
      sha256Original: sc.sha256Original,
      size: sc.size,
      sniffedType: sc.sniffedType,
      countryDetected: result.countryDetected,
      outcome: sc.outcome,
      phase: result.phase,
      rerun: true,
      skipReason: sc.extraction.skipReason ?? null,
      pages: sc.extraction.pages ?? null,
    },
    AUDIT_NO_IMPERSONATION
  );

  console.error(
    `[verify-upload] rerun settle ${sc.itemId}: type=${sc.sniffedType} pages=${sc.extraction.pages ?? "-"} ` +
      `ocrChars=${sc.extraction.ocrTextAll.length} country=${sc.countryDetected ?? "-"} ` +
      `candidates=${sc.extraction.candidatesTried.length} skip=${sc.extraction.skipReason ?? "-"} ` +
      `outcome=${sc.outcome ?? "-"}`
  );

  return result.phase === "completed"
    ? {
        status: "completed",
        outcome: result.outcome?.kind ?? null,
        countryDetected: result.countryDetected,
      }
    : { status: "deferred", reason: result.reason, countryDetected: result.countryDetected };
}

// Re-export the sniffer for the route (single import site).
export { sniffMagic, safeExt, exceedsPixelLimit };
export type { SniffedType };
