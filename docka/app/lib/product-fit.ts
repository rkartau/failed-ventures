// lib/product-fit.ts — the pipeline's per-lead PRODUCT-FIT verdict store.
//
// After the product-fit gate went live, the pipeline stops emailing
// non-prospects — but /admin/leads still renders the OLD builder `is_sendable`
// as a green "sendable" badge, so a company that will never receive an email
// still looks sendable on this page. This module carries the pipeline's verdict
// (positive / negative / ambiguous, plus the enrichment status and the
// pipeline-precomputed `is_sendable_v2`) so the page can render it beside the
// stale badge — the divergence is the point.
//
// SHARED DATA CONTRACT (produced by the pipeline, matched byte-for-byte here):
//   { "schema_version": 1, "generated_at": "<iso8601>",
//     "verdicts": { "<normalized_email>": {
//        "product_fit": "positive|negative|ambiguous",
//        "enrich_status": "success|error|timeout|blocked|not_attempted",
//        "is_sendable_v2": true|false } } }
//
// The verdict map is keyed by the NORMALIZED primary email. The join key MUST
// byte-match the pipeline's `common.normalize_email`; rather than re-implement
// that rule we REUSE the already-shipped byte-exact mirror
// (lib/email-match.ts normalizeEmailForMatch, pinned by the shared golden
// vectors tests/fixtures/email-normalize-golden.json). Re-exported here as
// `normalizeEmail` so the store, the page join and the tests all reach the one
// function — and the stored keys are re-normalized on ingest with the SAME
// function the page uses for lookup, so the join is parity-safe by construction.
//
// `is_sendable_v2` is PRECOMPUTED by the pipeline — the app renders it, it does
// NOT re-derive the rule.
//
// Validation follows lib/outreach-snapshot.ts: STRICT on the envelope (root
// shape, schema_version gate, generated_at), LENIENT per entry (coerce + warn,
// never reject the whole upload for one bad verdict). Like that module the
// per-entry normalizer accepts BOTH the wire keys (product_fit / enrich_status
// / is_sendable_v2) AND the stored camelCase keys (productFit / enrichStatus /
// sendableV2), so re-reading a stored file is the SAME code path as validating
// an upload.
//
// This module reaches node:url via lib/email-match.ts (server-side only — there
// is no client island importing it, unlike lib/outreach-snapshot.ts).

import { normalizeEmailForMatch } from "@/lib/email-match";

// ---- Constants ---------------------------------------------------------

/** 10 MB — the whole lead base's verdicts (~30k small objects) fit comfortably.
 *  The upload route enforces this cap on the DECOMPRESSED size (gzip-bomb safe),
 *  reusing lib/outreach-snapshot.ts assertUploadSize. */
export const MAX_PRODUCT_FIT_BYTES = 10 * 1024 * 1024;
/** Bound the verdict count (the whole base is ~30k rows). */
export const MAX_VERDICTS = 100_000;
export const MAX_STORED_WARNINGS = 50;

export const PRODUCT_FIT_VALUES = ["positive", "negative", "ambiguous"] as const;
export type ProductFit = (typeof PRODUCT_FIT_VALUES)[number];

export const ENRICH_STATUS_VALUES = [
  "success",
  "error",
  "timeout",
  "blocked",
  "not_attempted",
] as const;
export type EnrichStatus = (typeof ENRICH_STATUS_VALUES)[number];

const PRODUCT_FIT_SET = new Set<string>(PRODUCT_FIT_VALUES);
const ENRICH_STATUS_SET = new Set<string>(ENRICH_STATUS_VALUES);

// ---- Types -------------------------------------------------------------

/** One lead's verdict. `sendableV2` is the pipeline-precomputed decision. */
export type ProductFitVerdict = {
  productFit: ProductFit;
  enrichStatus: EnrichStatus;
  sendableV2: boolean;
};

export type ProductFitData = {
  schemaVersion: number;
  generatedAt: string;
  uploadedAt: string;
  /** key = app-normalized primary email -> verdict. */
  verdicts: Record<string, ProductFitVerdict>;
  warnings: string[];
};

// ---- normalizeEmail (the join key) -------------------------------------

/**
 * The join key: byte-exact mirror of the pipeline's common.normalize_email.
 * Re-export of the already-shipped, golden-vector-pinned implementation — the
 * store and the page both call THIS, so store-side keys and page-side lookups
 * are normalized by the identical function (parity by construction).
 */
export const normalizeEmail = normalizeEmailForMatch;

// ---- Small helpers -----------------------------------------------------

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return null;
  return v;
}

/** Cap stored warnings; append one honest "+ N more warnings" tail line. */
function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_STORED_WARNINGS) return warnings;
  const extra = warnings.length - MAX_STORED_WARNINGS;
  return [...warnings.slice(0, MAX_STORED_WARNINGS), `+ ${extra} more warnings`];
}

// ---- Per-entry normalizer (shared by upload + stored re-read) ----------

/**
 * Normalize the `verdicts` map. STRICT allowlist per entry: product_fit MUST be
 * one of PRODUCT_FIT_VALUES (else the entry is skipped + warning); enrich_status
 * outside ENRICH_STATUS_VALUES degrades to "not_attempted" (+ warning) rather
 * than dropping the row; is_sendable_v2 is coerced to a strict boolean (only
 * `true` is true). Each KEY is RE-NORMALIZED with the app's normalizeEmail so
 * the stored map is keyed exactly as the page will look it up; an empty
 * normalized key is skipped, and a collision keeps the last entry (+ warning).
 * Accepts BOTH wire keys and stored camelCase, so the stored re-read is the same
 * code path as upload validation.
 */
function normalizeVerdicts(
  raw: unknown,
  warnings: string[]
): Record<string, ProductFitVerdict> {
  const out: Record<string, ProductFitVerdict> = {};
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) warnings.push("verdicts is not an object — ignored");
    return out;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_VERDICTS) {
    warnings.push(`verdicts ${entries.length} entries — keeping the first ${MAX_VERDICTS}`);
  }
  let kept = 0;
  for (const [rawKey, val] of entries) {
    if (kept >= MAX_VERDICTS) break;
    const key = normalizeEmail(rawKey);
    if (key === "") {
      warnings.push("verdict with an empty email key — skipped");
      continue;
    }
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      warnings.push(`verdict "${key}" is not an object — skipped`);
      continue;
    }
    const o = val as Record<string, unknown>;
    const pick = (wire: string, stored: string): unknown =>
      o[wire] !== undefined ? o[wire] : o[stored];

    const productFitRaw = pick("product_fit", "productFit");
    if (typeof productFitRaw !== "string" || !PRODUCT_FIT_SET.has(productFitRaw)) {
      warnings.push(`verdict "${key}" product_fit "${String(productFitRaw)}" invalid — skipped`);
      continue;
    }

    const enrichRaw = pick("enrich_status", "enrichStatus");
    let enrichStatus: EnrichStatus = "not_attempted";
    if (typeof enrichRaw === "string" && ENRICH_STATUS_SET.has(enrichRaw)) {
      enrichStatus = enrichRaw as EnrichStatus;
    } else if (enrichRaw !== undefined && enrichRaw !== null) {
      warnings.push(
        `verdict "${key}" enrich_status "${String(enrichRaw)}" invalid — treated as not_attempted`
      );
    }

    const sendableRaw = pick("is_sendable_v2", "sendableV2");
    if (typeof sendableRaw !== "boolean" && sendableRaw !== undefined && sendableRaw !== null) {
      warnings.push(`verdict "${key}" is_sendable_v2 not a boolean — treated as false`);
    }
    const sendableV2 = sendableRaw === true;

    if (out[key] !== undefined) {
      warnings.push(`verdict "${key}" appears twice after normalization — keeping the last`);
    }
    out[key] = { productFit: productFitRaw as ProductFit, enrichStatus, sendableV2 };
    kept++;
  }
  return out;
}

// ---- Upload validation -------------------------------------------------

export function validateProductFit(
  raw: unknown
): { ok: true; data: Omit<ProductFitData, "uploadedAt"> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Not a product-fit object" };
  }
  const o = raw as Record<string, unknown>;

  // schema_version gate: absent / 1 = the current shape. Anything else is a
  // future format this validator does not understand — reject the envelope.
  const sv = o["schema_version"];
  if (sv !== undefined && sv !== null && sv !== 1) {
    return { ok: false, error: `Unsupported schema_version ${String(sv)} (accepted: 1)` };
  }
  const schemaVersion = sv === undefined || sv === null ? 1 : (sv as number);

  const generatedAt = isoOrNull(o["generated_at"]);
  if (generatedAt === null) {
    return { ok: false, error: "Missing or invalid generated_at" };
  }

  const verdictsRaw = o["verdicts"];
  if (verdictsRaw === null || typeof verdictsRaw !== "object" || Array.isArray(verdictsRaw)) {
    return { ok: false, error: "verdicts is not an object" };
  }

  const warnings: string[] = [];
  const verdicts = normalizeVerdicts(verdictsRaw, warnings);

  return {
    ok: true,
    data: { schemaVersion, generatedAt, verdicts, warnings: capWarnings(warnings) },
  };
}

// ---- Stored-file re-validation -----------------------------------------

/**
 * Re-validate a stored product-fit file that was already JSON-parsed by the
 * store shell. Envelope drift → corrupt; entry-level garbage degrades through
 * the SAME normalizer as uploads (skip + warning, never a throw) — defense
 * against hand-edits / schema drift.
 */
export function parseStoredProductFit(
  parsed: unknown
): { status: "ok"; data: ProductFitData } | { status: "corrupt" } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "corrupt" };
  }
  const o = parsed as Record<string, unknown>;
  const generatedAt = isoOrNull(o["generatedAt"]);
  if (generatedAt === null) return { status: "corrupt" };
  if (typeof o["uploadedAt"] !== "string") return { status: "corrupt" };
  if (o["verdicts"] === null || typeof o["verdicts"] !== "object" || Array.isArray(o["verdicts"])) {
    return { status: "corrupt" };
  }
  const schemaVersion =
    typeof o["schemaVersion"] === "number" && Number.isFinite(o["schemaVersion"])
      ? (o["schemaVersion"] as number)
      : 1;

  const warnings: string[] = Array.isArray(o["warnings"])
    ? (o["warnings"] as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  const verdicts = normalizeVerdicts(o["verdicts"], warnings);

  return {
    status: "ok",
    data: {
      schemaVersion,
      generatedAt,
      uploadedAt: o["uploadedAt"] as string,
      verdicts,
      warnings: capWarnings(warnings),
    },
  };
}
