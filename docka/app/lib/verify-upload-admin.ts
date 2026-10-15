// Admin-side server core for the verify-upload corpus (plan §7). The admin API
// routes under app/api/admin/verify-uploads stay thin HTTP shells (adminSession
// guard + admin-audit line); everything with a correctness rule lives here so
// it is unit-testable without the Next/auth runtime:
//
//  - listing: sidecar-driven, newest first, paginated; per-country demand
//    counts across the WHOLE corpus (the operator's radar for which registry
//    adapter to build next — countries with no adapter included);
//  - serving: Content-Type from the SNIFFED magic of the bytes actually served
//    (never the extension, never origName), X-Content-Type-Options: nosniff on
//    every byte response, Content-Disposition filename sanitized (CRLF /
//    zero-width / RTL-override / path separators stripped; itemId fallback);
//  - delete: original + derived + sidecar removed, tombstone event appended to
//    the verify-uploads chain (the chain itself is immutable — approved).
//
// The re-run pipeline itself lives in lib/verify-upload.ts (rerunRecognition)
// next to the anonymous settle logic it mirrors.

import fs from "fs";
import path from "path";
import { appendAudit, AUDIT_NO_IMPERSONATION, id } from "@/lib/db";
import { safeExt, sniffMagic, type SniffedType } from "@/lib/image-dims";
import { COUNTRIES, countryEntry } from "@/lib/registry/countries";
import type { CountryCode } from "@/lib/registry/types";
import {
  readSidecar,
  sidecarPath,
  UPLOAD_DIR,
  type VerifyUploadSidecar,
} from "@/lib/verify-upload";

// ---- Item-id gate ---------------------------------------------------------

// Every admin item route param passes through this BEFORE touching the
// filesystem. Store ids are crypto.randomUUID() (db.ts id()) — anything else
// (traversal attempts, extensions, separators) is refused outright.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafeItemId(itemId: string): boolean {
  return UUID_RE.test(itemId);
}

// ---- Sniffed-magic serving --------------------------------------------------

const MIME: Record<SniffedType, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  heic: "image/heic",
};

/** Content-Type from the sniffed magic ONLY — unknown sniff = opaque bytes. */
export function contentTypeFor(sniffed: SniffedType | null): string {
  return sniffed ? MIME[sniffed] : "application/octet-stream";
}

/**
 * Sanitize a client-supplied original filename for a Content-Disposition
 * header (plan §7): strips CR/LF (header splitting), zero-width chars
 * (U+200B–D / U+FEFF), the RTL override (U+202E) and every other bidi control,
 * path separators, quotes and anything else outside printable ASCII (an HTTP
 * header rejects non-Latin1 anyway). Leading dots go too (no dotfiles /
 * relative-path shapes). Empty after cleaning → the caller's fallback
 * (itemId-based) name.
 */
export function sanitizeDownloadName(origName: string | null | undefined, fallback: string): string {
  const cleaned = String(origName ?? "")
    .replace(/[^\x20-\x7e]/g, "") // controls (CR/LF), zero-width, bidi, non-ASCII
    .replace(/[\\/]/g, "") // path separators
    .replace(/"/g, "'") // header quoting safety
    .replace(/^[\s.]+/, "") // leading dots / whitespace
    .trim()
    .slice(0, 150);
  return cleaned || fallback;
}

export type ServableFile = {
  buf: Buffer;
  sniffed: SniffedType | null;
  /** Complete response headers — sniffed Content-Type + nosniff (+ disposition). */
  headers: Record<string, string>;
};

function readItemFile(fileName: string): { buf: Buffer; sniffed: SniffedType | null } | null {
  try {
    // basename() belt-and-braces: the name comes from OUR sidecar writer, but a
    // corrupted sidecar must still never escape the corpus directory.
    const buf = fs.readFileSync(path.join(UPLOAD_DIR, path.basename(fileName)));
    return { buf, sniffed: sniffMagic(buf) };
  } catch (e) {
    console.warn(
      `[verify-upload-admin] item file unreadable: ${path.basename(fileName)} (${(e as Error)?.message ?? e})`
    );
    return null;
  }
}

function baseHeaders(sniffed: SniffedType | null): Record<string, string> {
  return {
    // SNIFFED magic of the bytes actually served — never extension or origName.
    "Content-Type": contentTypeFor(sniffed),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

/**
 * Thumbnail source (plan §7): the derived JPEG when present, else the
 * original. Served inline under an itemId-based name — origName never reaches
 * a non-download response header.
 */
export function readThumbnailSource(itemId: string): ServableFile | null {
  const sc = readSidecar(itemId);
  if (!sc) return null;
  const f = readItemFile(sc.derived ? sc.derived.storedFile : sc.storedFile) ??
    (sc.derived ? readItemFile(sc.storedFile) : null); // derived vanished → original
  if (!f) return null;
  const ext = f.sniffed ? safeExt(f.sniffed) : "bin";
  return {
    ...f,
    headers: {
      ...baseHeaders(f.sniffed),
      "Content-Disposition": `inline; filename="${itemId}.${ext}"`,
    },
  };
}

/** Download of the ORIGINAL bytes: attachment, sanitized origName (itemId fallback). */
export function readOriginalForDownload(itemId: string): ServableFile | null {
  const sc = readSidecar(itemId);
  if (!sc) return null;
  const f = readItemFile(sc.storedFile);
  if (!f) return null;
  const ext = f.sniffed ? safeExt(f.sniffed) : "bin";
  const name = sanitizeDownloadName(sc.origName, `${itemId}.${ext}`);
  return {
    ...f,
    headers: {
      ...baseHeaders(f.sniffed),
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  };
}

// ---- Listing + per-country demand -------------------------------------------

/**
 * One dispatched registry candidate from the sidecar's candidatesTried, with
 * the pinned host it targeted — the operator's per-row answer to "WHICH
 * country registry API did this verification actually exercise?" (every
 * thumbnail URL is the same internal endpoint, so the table must say).
 */
export type RegistryTraceStep = {
  via: "embedded" | "qr" | "ocr";
  /** null for embedded/QR candidates dispatched through full detection. */
  country: CountryCode | null;
  /** Pinned primary hostname (countries.ts domains[0]); null when no country. */
  adapterHost: string | null;
  outcome: string;
};

/** Derive the per-row registry trace from a sidecar (exported for unit tests). */
export function registryTrace(sc: VerifyUploadSidecar): RegistryTraceStep[] {
  return (sc.extraction?.candidatesTried ?? []).map((c) => ({
    via: c.via,
    country: c.country,
    adapterHost: c.country ? countryEntry(c.country)?.domains[0] ?? null : null,
    outcome: c.outcome,
  }));
}

export type AdminUploadRow = {
  itemId: string;
  receivedAt: string;
  settledAt: string | null;
  sniffedType: SniffedType;
  size: number;
  /** Sidecar-only detail — this listing is an ADMIN surface (auth-gated). */
  origName: string;
  /** Terse extraction summary for the table cell. */
  summary: string;
  /** Which registry APIs this item's recognition actually called, in order. */
  registryTrace: RegistryTraceStep[];
  countryDetected: CountryCode | null;
  outcome: string | null;
  phase: string;
  deferredReason: string | null;
  /** Extraction-failure label (plan Decision 8) — slate chip in the table. */
  skipReason: string | null;
  /** Planning-yielded-nothing companion label (plan Decision 8). */
  dispatchSkipReason: string | null;
  /** Timeout-loser completion (plan Decision 17) — rendered above Re-run. */
  lateResult: { outcome: string | null; candidateCount: number; completedAt: string } | null;
  hasDerived: boolean;
  retryCount: number;
};

export type DemandRow = {
  country: CountryCode;
  countryName: string;
  /** Wired connector exists (capability auto / auto-presence). */
  hasAdapter: boolean;
  count: number;
};

export type VerifyUploadListing = {
  total: number;
  offset: number;
  limit: number;
  items: AdminUploadRow[];
  /** Corpus-wide (NOT page-scoped) keyword-detection counts, descending. */
  demand: DemandRow[];
  /** Corpus items where no country was detected. */
  undetected: number;
};

/** Terse one-cell extraction summary (operator rule: explanations elsewhere). */
export function extractionSummary(sc: VerifyUploadSidecar): string {
  const parts: string[] = [];
  if (sc.extraction.embeddedCode) parts.push("embedded");
  if (sc.extraction.qrText) parts.push("QR");
  // PDF meta (pdf-verify plan A5): pages OCRed / total, text-layer size.
  if (typeof sc.extraction.pages === "number") {
    parts.push(`PDF ${sc.extraction.pagesOcred ?? 0}/${sc.extraction.pages}p`);
  }
  if ((sc.extraction.textLayerChars ?? 0) > 0) {
    parts.push(`text-layer ${sc.extraction.textLayerChars} ch`);
  }
  if (sc.extraction.ocrTextAll) parts.push(`OCR ${sc.extraction.ocrTextAll.length} ch`);
  if (sc.extraction.workerRanOn) parts.push(`ran ${sc.extraction.workerRanOn}`);
  if (sc.extraction.candidatesTried.length) parts.push(`${sc.extraction.candidatesTried.length} tried`);
  // Empty parts list → the skipReason IS the summary (never a naked "—").
  if (parts.length === 0) {
    return sc.extraction.skipReason ? `skip: ${sc.extraction.skipReason}` : "—";
  }
  // Planning-yielded-nothing companion label rides along when set.
  if (sc.extraction.dispatchSkipReason) {
    parts.push(`no dispatch: ${sc.extraction.dispatchSkipReason}`);
  }
  return parts.join(" · ");
}

function readAllSidecars(): VerifyUploadSidecar[] {
  let files: string[];
  try {
    files = fs.readdirSync(UPLOAD_DIR).filter((f) => /\.json$/i.test(f));
  } catch {
    return []; // no corpus dir yet — empty listing
  }
  const out: VerifyUploadSidecar[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), "utf-8")) as VerifyUploadSidecar);
    } catch {
      // unparseable sidecar: skip, never break the listing
      console.warn(`[verify-upload-admin] unparseable sidecar skipped: ${f}`);
      continue;
    }
  }
  return out;
}

/**
 * Paginated corpus listing, newest first (receivedAt desc, itemId tiebreak for
 * a stable order), plus the corpus-WIDE per-country demand counts — the
 * operator-requested radar for which registry adapter to build next, so
 * countries with no adapter are first-class here.
 */
export function listVerifyUploads(offset = 0, limit = 50): VerifyUploadListing {
  const all = readAllSidecars().sort(
    (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.itemId.localeCompare(a.itemId)
  );

  const counts = new Map<CountryCode, number>();
  let undetected = 0;
  for (const sc of all) {
    if (sc.countryDetected) counts.set(sc.countryDetected, (counts.get(sc.countryDetected) ?? 0) + 1);
    else undetected++;
  }
  const demand: DemandRow[] = [...counts.entries()]
    .map(([country, count]) => {
      const entry = COUNTRIES.find((c) => c.country === country);
      return {
        country,
        countryName: entry?.countryName ?? country,
        hasAdapter: !!entry && (entry.capability === "auto" || entry.capability === "auto-presence"),
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

  const items = all.slice(offset, offset + limit).map((sc) => ({
    itemId: sc.itemId,
    receivedAt: sc.receivedAt,
    settledAt: sc.settledAt,
    sniffedType: sc.sniffedType,
    size: sc.size,
    origName: sc.origName,
    summary: extractionSummary(sc),
    registryTrace: registryTrace(sc),
    countryDetected: sc.countryDetected,
    outcome: sc.outcome,
    phase: sc.phase,
    deferredReason: sc.deferredReason,
    skipReason: sc.extraction?.skipReason ?? null,
    dispatchSkipReason: sc.extraction?.dispatchSkipReason ?? null,
    lateResult: sc.extraction?.lateResult
      ? {
          outcome: sc.extraction.lateResult.outcome,
          candidateCount: sc.extraction.lateResult.candidatesTried?.length ?? 0,
          completedAt: sc.extraction.lateResult.completedAt,
        }
      : null,
    hasDerived: !!sc.derived,
    retryCount: sc.retries.length,
  }));

  return { total: all.length, offset, limit, items, demand, undetected };
}

// ---- Per-item delete (plan §7) ----------------------------------------------

export type DeleteUploadResult = { ok: true } | { ok: false; reason: "not-found" };

/**
 * Remove one corpus item: original bytes + derived JPEG + sidecar, then append
 * the tombstone event to the verify-uploads chain (immutable by design — the
 * PII-free chain core stays; the DELETABLE detail was the sidecar + bytes).
 * Bytes go first, sidecar last: a re-run racing this delete trips its
 * tombstone check on whichever it probes.
 */
export async function deleteVerifyUpload(itemId: string): Promise<DeleteUploadResult> {
  const sc = readSidecar(itemId);
  if (!sc) return { ok: false, reason: "not-found" };

  const rm = (p: string) => {
    try {
      fs.rmSync(p, { force: true });
    } catch (e) {
      /* force:true already swallows ENOENT; anything else must not stop the rest */
      console.warn(
        `[verify-upload-admin] delete failed for ${itemId} (${path.basename(p)}): ${(e as Error)?.message ?? e}`
      );
    }
  };
  rm(path.join(UPLOAD_DIR, path.basename(sc.storedFile)));
  if (sc.derived) rm(path.join(UPLOAD_DIR, path.basename(sc.derived.storedFile)));
  rm(sidecarPath(itemId));

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
      countryDetected: sc.countryDetected,
      outcome: "deleted",
      phase: "deleted",
      tombstone: true,
    },
    AUDIT_NO_IMPERSONATION
  );
  return { ok: true };
}
