// Lead-base page loader for /admin/leads (admin-only surface).
//
// Reads the CLEAN, post-quarantine columnar snapshot `content/docka-leads.json`
// — the SAME file, via the SAME parser/decoder, as the §15 export route
// (lib/leads-export.ts: parseColumnarEnvelope + makeCellReader + asStr/asBool).
// One flattener, no fork: this module only states its own (page) column list and
// projects the rows the page shows. Nothing here touches db.json, the JSON
// store, or any customer data.
//
// Unlike the retired HTML-fragment page there is NO raw HTML anywhere: rows are
// plain strings/booleans/numbers rendered through JSX, so React escapes every
// cell. dangerouslySetInnerHTML does not appear on this surface at all.
//
// OPERATOR STANDING RULES this module implements:
//  * The snapshot is a PERMANENT fixture, replaced DAILY by the publisher
//    (handoff_publish_leads.py, scp to /opt/docka/content/). A fresh mtime/size
//    invalidates the memo on the next request — no restart needed (same
//    (mtimeMs, size) key as lib/leads-export-store.ts).
//  * The lead list must be VISIBLE AT ALL TIMES: if a daily refresh delivers a
//    broken file (or the file vanishes), the page keeps serving the LAST-KNOWN-
//    GOOD parse from this process, with an honest "latest refresh failed" note.
//    The empty state exists ONLY for a box that has never had a snapshot.
//  * generated_at is surfaced prominently so the operator sees each daily
//    refresh land.
//
// GDPR: the snapshot is gitignored and never travels in the deploy tar; it
// reaches the box by scp only. A fresh checkout has NO file here — a NORMAL
// state, not an error.

import fs from "fs";
import path from "path";
import {
  asBool,
  asStr,
  makeCellReader,
  parseColumnarEnvelope,
} from "@/lib/leads-export";
import { normalizeEmail, type EnrichStatus, type ProductFit } from "@/lib/product-fit";
import {
  loadProductFitLookup,
  type ProductFitLookup,
} from "@/lib/product-fit-store";
import { isoRegion } from "@/lib/registry/display";

/**
 * Normalize a raw `country_iso2` cell to a single stable key: uppercase, strip a
 * service suffix, and fold UK→GB (isoRegion does the suffix/UK rule but does NOT
 * uppercase, so we uppercase first). `gb`, `GB` and `UK` all collapse to `GB`; a
 * blank cell yields "" (the caller counts it as noCountry, never a stats bucket).
 */
export function normIso2(raw: string): string {
  const s = raw.trim();
  return s === "" ? "" : isoRegion(s.toUpperCase());
}

/** Where the snapshot lives, relative to the app root (process.cwd()). */
export const LEADS_JSON_REL_PATH = path.join("content", "docka-leads.json");

/** Columns the PAGE reads (superset axis: working-set/desk/scoring columns). */
export const PAGE_REQUIRED_COLUMNS = [
  "company_name",
  "country_iso2",
  "registry",
  "segment_guess",
  "tier",
  "fit_score",
  "action",
  "working_set",
  "is_desk",
  "is_sendable",
  "contact_email",
  "crewing_email",
  "outreach_channel_effective",
] as const;

/** One display row — every field a plain scalar; JSX escapes them on render. */
export type LeadRow = {
  company: string;
  countryIso2: string;
  registry: string;
  segment: string;
  tier: string;
  fitScore: string;
  action: string;
  /** Same selection rule as the §15 export: crewing/desk mailbox, else contact. */
  email: string;
  channel: string;
  sendable: boolean;
  desk: boolean;
  /**
   * The pipeline's PRODUCT-FIT verdict, joined by normalizeEmail(email). The
   * OLD `sendable` badge above lags the product-fit gate (the pipeline stops
   * emailing non-prospects but this snapshot still marks them sendable), so the
   * page renders BOTH — the divergence is the point. These three keys are
   * attached ONLY when a verdict is found for this row's email (no phantom key,
   * same rule as OutreachLead.events): an absent verdict → undefined, rendered
   * as "pending", NEVER as negative. `sendableV2` is the pipeline-precomputed
   * decision (the app renders it, it does not re-derive the rule).
   */
  productFit?: ProductFit;
  enrichStatus?: EnrichStatus;
  sendableV2?: boolean;
};

/**
 * Per-registry (lead-source) aggregate, folded over the WHOLE base in the same
 * single pass that projects the page (the ~29k research rows count too). Feeds
 * /admin/sources; a new registry value appears here with no code change. Bucket
 * keys are the raw `registry` cell verbatim (composite `a | b` keys included);
 * a blank registry buckets under "(unknown)", a row whose fold reads throw under
 * "(unreadable)", and any registry beyond MAX_SOURCE_BUCKETS under "(other)".
 */
export type SourceAgg = {
  registry: string;
  rows: number;
  /** Rows with a non-empty crewing OR contact mailbox. */
  withEmail: number;
  /** Rows the base flag marks is_sendable (asBool). */
  sendable: number;
  /** Max `extracted_at` (first 10 chars, YYYY-MM-DD) over the bucket, or null. */
  lastExtractedAt: string | null;
};

/** DoS guard: at most this many DISTINCT real registry buckets; overflow → "(other)". */
export const MAX_SOURCE_BUCKETS = 1000;

/**
 * Per-country aggregate folded over the WHOLE base in the SAME single pass that
 * projects the page (RV1 — no second read/parse). `iso2` is the normalized key
 * (normIso2); `total` is every row for that country; `sendable` sums the base
 * `is_sendable` flag independently. Feeds /admin/atlas.
 */
export type LeadCountryStat = { iso2: string; total: number; sendable: number };

export type LeadsPageData = {
  /** As stated by the snapshot itself — surfaced prominently (daily refresh). */
  generatedAt: string;
  sourceVersion: string;
  /** mtime (epoch ms) of the file = when the publisher landed it on the box. */
  publishedAt: number;
  /** Honest totals: the WHOLE base vs what the page shows. */
  totalRows: number;
  sendableCount: number;
  /** The ~507 published working-set rows (working_set === true). */
  workingSet: LeadRow[];
  /** Crewing-desk rows (is_desk === true) across the whole base. */
  desks: LeadRow[];
  /** Per-registry aggregate over the WHOLE base (sorted rows desc, registry asc). */
  sources: SourceAgg[];
  /** True when > MAX_SOURCE_BUCKETS distinct registries folded into "(other)". */
  sourcesTruncated: boolean;
  /** Rows whose lead-source fold reads threw (bucketed "(unreadable)"). */
  sourcesUnreadable: number;
  /** Per-country aggregate over the WHOLE base (sorted total desc, iso2 asc). */
  countryStats: LeadCountryStat[];
  /** Rows carrying a non-blank, readable country_iso2 (summed into countryStats). */
  withCountry: number;
  /** Rows with a blank / unreadable country_iso2 (never in countryStats). */
  noCountry: number;
};

export type LeadsPageSnapshot =
  | {
      ok: true;
      data: LeadsPageData;
      /**
       * null on a fresh parse; set when the CURRENT file is broken or gone and
       * `data` is the last-known-good parse from this process (operator top
       * priority: the list stays visible, with an honest note).
       */
      stale: { error: string } | null;
    }
  /** ONLY a box that has never had a snapshot (and none cached) sees these. */
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "invalid"; error: string };

// The good-parse memo is keyed on BOTH the leads file (mtimeMs,size) AND the
// product-fit file's version token: a product-fit refresh must invalidate the
// already-projected rows (the verdict badges are attached at projection time),
// even when the leads file itself is unchanged. A verdict refresh is a daily-
// cadence event, so re-reading + re-projecting the leads file when it happens
// is an acceptable cost.
type GoodEntry = { mtimeMs: number; size: number; pfVersion: string; data: LeadsPageData };
type FailEntry = { mtimeMs: number; size: number; error: string };

// Module-level memos, same reasoning as leads-export-store: the snapshot is one
// static file, identical for every admin (never user-scoped), so nothing here
// can leak between admins. lastGood doubles as the last-known-good fallback and
// is deliberately NOT dropped when a newer file is broken. lastFailure only
// spares us re-parsing a known-bad file on every request.
let lastGood: GoodEntry | null = null;
let lastFailure: FailEntry | null = null;

/** Test hook: forget both memos (tests rewrite the file rapidly). */
export function __clearLeadsPageCache(): void {
  lastGood = null;
  lastFailure = null;
}

function projectRow(
  at: (row: unknown[], col: string) => unknown,
  row: unknown[],
  verdicts: ProductFitLookup["verdicts"]
): LeadRow {
  const crewing = asStr(at(row, "crewing_email"));
  const contact = asStr(at(row, "contact_email"));
  const email = crewing !== "" ? crewing : contact;
  const lead: LeadRow = {
    company: asStr(at(row, "company_name")),
    countryIso2: asStr(at(row, "country_iso2")),
    registry: asStr(at(row, "registry")),
    segment: asStr(at(row, "segment_guess")),
    tier: asStr(at(row, "tier")),
    fitScore: asStr(at(row, "fit_score")),
    action: asStr(at(row, "action")),
    email,
    channel: asStr(at(row, "outreach_channel_effective")),
    sendable: asBool(at(row, "is_sendable")),
    desk: asBool(at(row, "is_desk")),
  };
  // Join the pipeline's product-fit verdict by NORMALIZED email — the same
  // normalizeEmail() the store keyed the map with, so lookup is parity-safe.
  // Attach the three keys ONLY when a verdict exists (no phantom key): an absent
  // verdict leaves them undefined so the page renders "pending".
  const v = email !== "" ? verdicts.get(normalizeEmail(email)) : undefined;
  if (v) {
    lead.productFit = v.productFit;
    lead.enrichStatus = v.enrichStatus;
    lead.sendableV2 = v.sendableV2;
  }
  return lead;
}

/** FAIL CLOSED over the whole file, like the §15 flattener: a half-projected
 *  page has no honest reading. Returns an error string instead of throwing. */
function buildPageData(
  parsed: unknown,
  publishedAt: number,
  verdicts: ProductFitLookup["verdicts"]
): { ok: true; data: LeadsPageData } | { ok: false; error: string } {
  const env = parseColumnarEnvelope(parsed, PAGE_REQUIRED_COLUMNS);
  if (!env.ok) return env;
  const doc = env.doc;
  const at = makeCellReader(doc);

  const workingSet: LeadRow[] = [];
  const desks: LeadRow[] = [];
  let sendableCount = 0;

  // Per-registry aggregate over EVERY row (research rows included), so a new
  // registry appears on /admin/sources with no code change. Each fold read sits
  // in its OWN try: a throwing cell in a NEVER-projected research row costs one
  // "(unreadable)" bucket entry instead of failing the page closed, while the
  // existing per-row try below still fails a PROJECTED bad row closed as before.
  type Acc = { rows: number; withEmail: number; sendable: number; lastExtractedAt: string | null };
  const sourceMap = new Map<string, Acc>();
  let realBuckets = 0;
  let sourcesUnreadable = 0;
  let sourcesTruncated = false;

  // Per-country aggregate, folded in the SAME row-walk (RV1). Keyed by normIso2 so
  // gb/GB/UK never split; a blank/unreadable country counts into noCountry only.
  type CountryAcc = { total: number; sendable: number };
  const countryMap = new Map<string, CountryAcc>();
  let withCountry = 0;
  let noCountry = 0;

  for (let i = 0; i < doc.rows.length; i++) {
    const row = doc.rows[i];
    if (!Array.isArray(row)) return { ok: false, error: `row ${i} is not an array` };

    // --- lead-source + country fold (own try; runs for every row, before the gate) ---
    let aggKey: string;
    let aggSendable = false;
    let aggWithEmail = false;
    let aggExtractedAt: string | null = null;
    // normalized ISO2 for this row, or null when blank / a fold read threw.
    let aggCountry: string | null = null;
    try {
      const reg = asStr(at(row, "registry"));
      aggSendable = asBool(at(row, "is_sendable"));
      const crewing = asStr(at(row, "crewing_email"));
      const contact = asStr(at(row, "contact_email"));
      aggWithEmail = crewing !== "" || contact !== "";
      const ext = asStr(at(row, "extracted_at")); // optional column → "" when absent
      aggExtractedAt = /^\d{4}-\d{2}-\d{2}/.test(ext) ? ext.slice(0, 10) : null;
      aggKey = reg === "" ? "(unknown)" : reg;
      const cc = normIso2(asStr(at(row, "country_iso2")));
      aggCountry = cc === "" ? null : cc;
    } catch {
      aggKey = "(unreadable)";
      sourcesUnreadable++;
      aggCountry = null; // a row we could not read has no country → noCountry
    }

    // Country fold: every row lands in exactly one of {a stats bucket, noCountry},
    // so totalRows === withCountry + noCountry holds for any successful build.
    if (aggCountry !== null) {
      withCountry++;
      let cacc = countryMap.get(aggCountry);
      if (!cacc) {
        cacc = { total: 0, sendable: 0 };
        countryMap.set(aggCountry, cacc);
      }
      cacc.total++;
      if (aggSendable) cacc.sendable++;
    } else {
      noCountry++;
    }
    if (aggKey !== "(unknown)" && aggKey !== "(unreadable)" && !sourceMap.has(aggKey)) {
      if (realBuckets >= MAX_SOURCE_BUCKETS) {
        aggKey = "(other)";
        sourcesTruncated = true;
      } else {
        realBuckets++;
      }
    }
    let acc = sourceMap.get(aggKey);
    if (!acc) {
      acc = { rows: 0, withEmail: 0, sendable: 0, lastExtractedAt: null };
      sourceMap.set(aggKey, acc);
    }
    acc.rows++;
    if (aggWithEmail) acc.withEmail++;
    if (aggSendable) acc.sendable++;
    if (
      aggExtractedAt !== null &&
      (acc.lastExtractedAt === null || aggExtractedAt > acc.lastExtractedAt)
    ) {
      acc.lastExtractedAt = aggExtractedAt;
    }

    // --- existing page projection (own try; semantics UNCHANGED) ---
    try {
      if (asBool(at(row, "is_sendable"))) sendableCount++;
      const inWorkingSet = asBool(at(row, "working_set"));
      const isDesk = asBool(at(row, "is_desk"));
      if (!inWorkingSet && !isDesk) continue; // the ~29k research rows stay on disk
      const lead = projectRow(at, row, verdicts);
      if (inWorkingSet) workingSet.push(lead);
      if (isDesk) desks.push(lead);
    } catch (err) {
      return { ok: false, error: `row ${i}: ${(err as Error).message}` };
    }
  }

  const sources: SourceAgg[] = Array.from(sourceMap.entries())
    .map(([registry, a]) => ({
      registry,
      rows: a.rows,
      withEmail: a.withEmail,
      sendable: a.sendable,
      lastExtractedAt: a.lastExtractedAt,
    }))
    .sort(
      (x, y) => y.rows - x.rows || (x.registry < y.registry ? -1 : x.registry > y.registry ? 1 : 0)
    );

  const countryStats: LeadCountryStat[] = Array.from(countryMap.entries())
    .map(([iso2, a]) => ({ iso2, total: a.total, sendable: a.sendable }))
    .sort((x, y) => y.total - x.total || (x.iso2 < y.iso2 ? -1 : x.iso2 > y.iso2 ? 1 : 0));

  return {
    ok: true,
    data: {
      generatedAt: doc.generated_at,
      sourceVersion: doc.source_version,
      publishedAt,
      totalRows: doc.rows.length,
      sendableCount,
      workingSet,
      desks,
      sources,
      sourcesTruncated,
      sourcesUnreadable,
      countryStats,
      withCountry,
      noCountry,
    },
  };
}

/** The failure arm: memoize the verdict for THIS file version, then serve the
 *  last-known-good data when there is one (the list stays visible). */
function fail(stat: fs.Stats | null, error: string): LeadsPageSnapshot {
  if (stat) lastFailure = { mtimeMs: stat.mtimeMs, size: stat.size, error };
  if (lastGood) return { ok: true, data: lastGood.data, stale: { error } };
  return { ok: false, reason: "invalid", error };
}

/**
 * Load the snapshot for the page. Never throws. `contentPath` is a test seam;
 * production always reads cwd-resolved content/docka-leads.json.
 */
export function loadLeadsPageData(
  contentPath: string = path.join(process.cwd(), LEADS_JSON_REL_PATH),
  pfContentPath?: string
): LeadsPageSnapshot {
  // Load the product-fit verdicts ONCE (memoized in the store by its own file
  // version); its version token folds into the good-parse memo below so a
  // verdict refresh invalidates the projected rows.
  const pf = loadProductFitLookup(pfContentPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(contentPath);
  } catch {
    // Gone (or unstatable). Never had one → the true empty state; otherwise
    // keep showing the last-known-good list with an honest note.
    if (lastGood) {
      return { ok: true, data: lastGood.data, stale: { error: "the snapshot file is missing from the box" } };
    }
    return { ok: false, reason: "missing" };
  }

  if (
    lastGood &&
    lastGood.mtimeMs === stat.mtimeMs &&
    lastGood.size === stat.size &&
    lastGood.pfVersion === pf.version
  ) {
    return { ok: true, data: lastGood.data, stale: null };
  }
  if (lastFailure && lastFailure.mtimeMs === stat.mtimeMs && lastFailure.size === stat.size) {
    // Same broken file as last time — do not re-parse 13 MB per request.
    if (lastGood) return { ok: true, data: lastGood.data, stale: { error: lastFailure.error } };
    return { ok: false, reason: "invalid", error: lastFailure.error };
  }

  let text: string;
  try {
    text = fs.readFileSync(contentPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (lastGood) {
        return { ok: true, data: lastGood.data, stale: { error: "the snapshot file is missing from the box" } };
      }
      return { ok: false, reason: "missing" };
    }
    return fail(stat, "the snapshot file is unreadable");
  }

  let parsed: unknown;
  try {
    // BOM tolerance, same stance as the stores (PowerShell-written files).
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fail(stat, "the snapshot file is not valid JSON");
  }

  const built = buildPageData(parsed, stat.mtimeMs, pf.verdicts);
  if (!built.ok) return fail(stat, built.error);

  lastGood = { mtimeMs: stat.mtimeMs, size: stat.size, pfVersion: pf.version, data: built.data };
  lastFailure = null;
  return { ok: true, data: built.data, stale: null };
}
