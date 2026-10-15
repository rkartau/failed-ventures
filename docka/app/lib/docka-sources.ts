// lib/docka-sources.ts — the lead-source LEDGER for /admin/sources.
//
// Reads content/docka-sources.json (SOURCE_INDEX.csv rendered to JSON by
// handoff_publish_leads.py; box-only, gitignored, scp'd like docka-leads.json)
// and reconciles it against the per-registry aggregate the leads loader folds
// over the whole base (lib/docka-leads.ts SourceAgg). TWO clocks, stated
// honestly: the COUNTS come from docka-leads.json on every request; the LEDGER
// TEXT only changes when someone runs the publisher AND copies the file over.
//
// STRICT envelope, LENIENT entries (product-fit precedent): a drifted envelope
// is {invalid}; a single bad entry is dropped/re-capped with a parseWarning, so
// one malformed row never blanks the page. Read-side defenses mirror the emit
// guard: every string field is `\S*@\S*`-redacted (never `url`), url is
// re-validated (http(s), no `@`, parseable host or plain text), integers are
// re-checked. Read-only; no route; no customer data.

import path from "path";
import { memoJsonFile } from "@/lib/file-memo";
import type { SourceAgg } from "@/lib/docka-leads";

export const SOURCES_JSON_REL_PATH = path.join("content", "docka-sources.json");
export const SOURCES_SCHEMA_VERSION = 1;
export const SOURCES_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
export const SOURCES_MAX_ROWS = 2000;

// String caps (read-side re-cap; the emitter caps too — this is defense in depth).
const CAP = {
  name: 500,
  category: 120,
  country: 60,
  urlRecordedIn: 200,
  rowsExtracted: 80,
  inTheList: 40,
  accessMethod: 16000,
  licenceTerms: 16000,
  notes: 8000,
  urlNote: 120,
  verdict: 32,
  section: 4,
  assessedAt: 32,
  assessedAtBasis: 40,
  key: 120,
} as const;
const MAX_REGISTRY_KEYS = 20;

// ---- Status union (exhaustive; view maps declare `satisfies Record<…>`) -----

export type SourceStatus =
  | "in_base"
  | "enrichment"
  | "usable_not_merged"
  | "not_yet"
  | "gated"
  | "forbidden"
  | "dead"
  | "superseded"
  | "other";

export const SOURCE_STATUSES = [
  "in_base",
  "enrichment",
  "usable_not_merged",
  "not_yet",
  "gated",
  "forbidden",
  "dead",
  "superseded",
  "other",
] as const satisfies readonly SourceStatus[];

// ---- Wire shapes -----------------------------------------------------------

export type SourceRow = {
  row: number;
  section: string;
  name: string;
  country: string;
  category: string;
  url: string | null;
  urlNote: string | null;
  urlRecordedIn: string;
  accessMethod: string;
  accessMethodTruncated: boolean;
  rowsExtracted: string;
  licenceTerms: string;
  licenceTermsTruncated: boolean;
  verdict: string;
  inTheList: string;
  inListFlag: string;
  inListRows: number | null;
  notes: string;
  notesTruncated: boolean;
  registryKeys: string[];
  enrichment: boolean;
  assessedAt: string | null;
  assessedAtBasis: string | null;
};

export type SourceWarning =
  | { kind: "duplicate_key"; key: string; rows: number[] }
  | { kind: "unparsable_n"; row: number }
  | { kind: "future_date"; row: number }
  | { kind: "short_row"; row: number };

export type SourceLedgerMeta = {
  file: string;
  sha256: string;
  mtime: string;
  mtimeEpochMs: number | null;
  rows: number;
  hasRegistryColumn: boolean;
  hasAssessedAtColumn: boolean;
};

export type SourcesDoc = {
  schemaVersion: number;
  generatedAt: string;
  generatedAtEpochMs: number | null;
  sourceVersion: string;
  ledger: SourceLedgerMeta;
  sources: SourceRow[];
  warnings: SourceWarning[];
  /** Read-side notes (dropped/re-capped entries, redactions) — never trusted. */
  parseWarnings: string[];
};

// ---- Small coercions -------------------------------------------------------

/** Whole-token email redaction — NEVER applied to `url`. */
function redact(s: string): string {
  return s.replace(/\S*@\S*/g, "[email redacted]");
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function boolOf(v: unknown): boolean {
  return v === true;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Re-validate a url at read: http(s), ≤400, no `@`, else null. */
export function validSourceUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 400) return null;
  if (s.includes("@")) return null;
  if (!/^https?:\/\/\S+$/.test(s)) return null;
  return s;
}

/** Host for display, or null (renders as plain text, no anchor). */
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h ? h : null;
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD HH:MM UTC" → epoch ms, or null (deterministic UTC parse). */
export function parseUtcStamp(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(ms) ? ms : null;
}

/** Split a raw country cell on `;` into the valid code allowlist. */
export function splitCountries(raw: string): string[] {
  return raw
    .split(";")
    .map((c) => c.trim())
    .filter((c) => /^[A-Z]{2}$|^GLOBAL$|^MULTI$|^EU$/.test(c));
}

/** NFKD-strip + lowercase, for accent-insensitive name matching. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

// ---- parse -----------------------------------------------------------------

/**
 * Parse the docka-sources.json envelope. STRICT envelope (drift → invalid),
 * LENIENT entries (bad row dropped/re-capped with a parseWarning). Signature
 * matches memoJsonFile's `parse` callback.
 */
export function parseSourcesDoc(
  raw: unknown,
  _stat: { mtimeMs: number; size: number }
): { ok: true; value: SourcesDoc } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "document is not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== SOURCES_SCHEMA_VERSION) return { ok: false, error: "unexpected schema_version" };
  if (o.kind !== "docka-sources") return { ok: false, error: "unexpected kind" };
  if (!Array.isArray(o.sources)) return { ok: false, error: "sources is not an array" };
  if (o.sources.length > SOURCES_MAX_ROWS) return { ok: false, error: "too many sources" };

  const parseWarnings: string[] = [];
  let redactedFields = 0;
  const rc = (s: string, cap: number): string => {
    const r = redact(s);
    if (r !== s) redactedFields++;
    return r.length > cap ? r.slice(0, cap) : r;
  };

  // Ledger meta (tolerant).
  const lm =
    o.ledger && typeof o.ledger === "object" && !Array.isArray(o.ledger)
      ? (o.ledger as Record<string, unknown>)
      : {};
  const ledger: SourceLedgerMeta = {
    file: rc(asString(lm.file), 200),
    sha256: /^[0-9a-f]{64}$/.test(asString(lm.sha256)) ? asString(lm.sha256) : "",
    mtime: rc(asString(lm.mtime), 40),
    mtimeEpochMs: intOrNull(lm.mtime_epoch_ms),
    rows: intOrNull(lm.rows) ?? 0,
    hasRegistryColumn: boolOf(lm.has_registry_column),
    hasAssessedAtColumn: boolOf(lm.has_assessed_at_column),
  };

  const sources: SourceRow[] = [];
  const seenRows = new Set<number>();
  for (let i = 0; i < o.sources.length; i++) {
    const e = o.sources[i];
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      parseWarnings.push(`entry ${i} is not an object (dropped)`);
      continue;
    }
    const r = e as Record<string, unknown>;

    // Required-ish fields: name/section/verdict must be non-empty strings.
    const name = rc(asString(r.name), CAP.name);
    const section = rc(asString(r.section), CAP.section).toUpperCase();
    const verdict = rc(asString(r.verdict), CAP.verdict).toUpperCase();
    if (name === "" || section === "" || verdict === "") {
      parseWarnings.push(`entry ${i} missing name/section/verdict (dropped)`);
      continue;
    }

    // `row`: unique positive int, else array-index fallback + warning.
    let row = typeof r.row === "number" && Number.isInteger(r.row) && r.row > 0 ? r.row : -1;
    if (row === -1 || seenRows.has(row)) {
      parseWarnings.push(`entry ${i} has a missing/duplicate row number (using index)`);
      row = i;
    }
    seenRows.add(row);

    // registry_keys: sanitise each, cap the array.
    const rawKeys = Array.isArray(r.registry_keys) ? r.registry_keys : [];
    const registryKeys: string[] = [];
    for (const k of rawKeys) {
      if (typeof k !== "string") continue;
      const kk = k.trim();
      if (kk.length === 0 || kk.length > CAP.key) continue;
      if (!/^[A-Za-z0-9_.-]+( \| [A-Za-z0-9_.-]+)*$/.test(kk)) continue;
      registryKeys.push(kk);
      if (registryKeys.length >= MAX_REGISTRY_KEYS) break;
    }

    const url = validSourceUrl(r.url);

    sources.push({
      row,
      section,
      name,
      country: rc(asString(r.country), CAP.country),
      category: rc(asString(r.category), CAP.category),
      url,
      urlNote: url === null ? rc(asString(r.url_note), CAP.urlNote) || null : null,
      urlRecordedIn: rc(asString(r.url_recorded_in), CAP.urlRecordedIn),
      accessMethod: rc(asString(r.access_method), CAP.accessMethod),
      accessMethodTruncated:
        boolOf(r.access_method_truncated) || asString(r.access_method).length > CAP.accessMethod,
      rowsExtracted: rc(asString(r.rows_extracted), CAP.rowsExtracted),
      licenceTerms: rc(asString(r.licence_terms), CAP.licenceTerms),
      licenceTermsTruncated:
        boolOf(r.licence_terms_truncated) || asString(r.licence_terms).length > CAP.licenceTerms,
      verdict,
      inTheList: rc(asString(r.in_the_list), CAP.inTheList),
      inListFlag: rc(asString(r.in_list_flag), CAP.inTheList).toUpperCase(),
      inListRows: intOrNull(r.in_list_rows),
      notes: rc(asString(r.notes), CAP.notes),
      notesTruncated: boolOf(r.notes_truncated) || asString(r.notes).length > CAP.notes,
      registryKeys,
      enrichment: boolOf(r.enrichment),
      assessedAt: typeof r.assessed_at === "string" ? rc(r.assessed_at, CAP.assessedAt) || null : null,
      assessedAtBasis:
        typeof r.assessed_at_basis === "string" ? rc(r.assessed_at_basis, CAP.assessedAtBasis) || null : null,
    });
  }

  // Wire warnings (lenient).
  const warnings: SourceWarning[] = [];
  if (Array.isArray(o.warnings)) {
    for (const w of o.warnings) {
      if (w === null || typeof w !== "object" || Array.isArray(w)) continue;
      const ww = w as Record<string, unknown>;
      if (ww.kind === "duplicate_key" && typeof ww.key === "string" && Array.isArray(ww.rows)) {
        const rows = ww.rows.filter((x): x is number => typeof x === "number" && Number.isInteger(x));
        warnings.push({ kind: "duplicate_key", key: redact(ww.key).slice(0, CAP.key), rows });
      } else if (
        (ww.kind === "unparsable_n" || ww.kind === "future_date" || ww.kind === "short_row") &&
        typeof ww.row === "number" &&
        Number.isInteger(ww.row)
      ) {
        warnings.push({ kind: ww.kind, row: ww.row });
      }
    }
  }

  if (redactedFields > 0) {
    parseWarnings.push(`${redactedFields} field(s) contained an email token and were redacted at read`);
  }

  return {
    ok: true,
    value: {
      schemaVersion: SOURCES_SCHEMA_VERSION,
      generatedAt: rc(asString(o.generated_at), 40),
      generatedAtEpochMs: intOrNull(o.generated_at_epoch_ms),
      sourceVersion: rc(asString(o.source_version), 40),
      ledger,
      sources,
      warnings,
      parseWarnings,
    },
  };
}

// ---- load ------------------------------------------------------------------

export function loadSourcesDoc(
  contentPath: string = path.join(process.cwd(), SOURCES_JSON_REL_PATH)
):
  | { status: "ok"; doc: SourcesDoc; publishedAt: number }
  | { status: "missing" }
  | { status: "invalid"; error: string } {
  const res = memoJsonFile<SourcesDoc>(contentPath, parseSourcesDoc, { maxBytes: SOURCES_MAX_BYTES });
  if (res.status === "ok") return { status: "ok", doc: res.value, publishedAt: res.mtimeMs };
  if (res.status === "missing") return { status: "missing" };
  return { status: "invalid", error: res.error }; // invalid | unreadable
}

// ---- reconcile -------------------------------------------------------------

export type ReconciledSource = SourceRow & {
  status: SourceStatus;
  /** in_base by a YES* flag but with zero base rows. */
  claimOnly: boolean;
  baseRows: number;
  baseWithEmail: number;
  baseSendable: number;
  baseLastExtractedAt: string | null;
  /** Other ledger rows sharing one of this row's keys (duplicate_key warnings). */
  alsoRows: number[];
};

export type RegistryOnlyRow = {
  key: string;
  rows: number;
  withEmail: number;
  sendable: number;
  lastExtractedAt: string | null;
};

export type SourceKpis = {
  ledgerRows: number;
  feedingBase: number;
  registryOnlyCount: number;
  coverageRows: number;
  totalRows: number;
  coveragePct: number;
  usableNotMerged: number;
  gated: number;
  forbidden: number;
  deadNotYetSupersededOther: number;
};

export type Reconciliation = {
  inBase: ReconciledSource[];
  notInBase: ReconciledSource[];
  registryOnly: RegistryOnlyRow[];
  kpis: SourceKpis;
  versionSkew: { ledgerVersion: string; baseVersion: string } | null;
  ledgerAgeDays: number | null;
  warnings: SourceWarning[];
  parseWarnings: string[];
  nearMisses: { kind: "near_miss"; key: string; dataKey: string }[];
  sourcesTruncated: boolean;
  sourcesUnreadable: number;
  /** Filter-chip source sets. */
  countries: string[];
  verdicts: string[];
};

/** The in-base status rule (Decision 2): data-first, flag displayed not trusted. */
function classifyStatus(r: SourceRow, baseRows: number): SourceStatus {
  if (r.enrichment) return "enrichment";
  if (baseRows > 0) return "in_base";
  if (r.inListFlag.startsWith("YES")) return "in_base"; // claim only
  const v = r.verdict;
  if (v.startsWith("USABLE")) return "usable_not_merged";
  if (v === "NOT-YET-WORKED") return "not_yet";
  if (v === "GATED") return "gated";
  if (v === "FORBIDDEN") return "forbidden";
  if (v === "DEAD") return "dead";
  if (v === "SUPERSEDED") return "superseded";
  return "other";
}

/** The "Ledger extracted" badge (narrow, honest). */
export function ledgerBadge(r: ReconciledSource): "claimed_not_found" | "base_exceeds" | null {
  if (r.enrichment) return null;
  if (r.inListFlag.startsWith("YES") && r.inListRows === 0) return "claimed_not_found";
  if (r.inListRows !== null && r.baseRows > r.inListRows) return "base_exceeds";
  return null;
}

export function reconcileSources(input: {
  sources: SourceRow[];
  wireWarnings: SourceWarning[];
  parseWarnings: string[];
  aggs: SourceAgg[];
  totalRows: number;
  sourcesTruncated: boolean;
  sourcesUnreadable: number;
  baseSourceVersion: string | null;
  basePublishedAt: number | null;
  ledgerSourceVersion: string | null;
  ledgerMtimeMs: number | null;
}): Reconciliation {
  const aggByKey = new Map<string, SourceAgg>(input.aggs.map((a) => [a.registry, a]));

  // duplicate_key warnings → key → the rows that share it.
  const dupRowsByKey = new Map<string, number[]>();
  for (const w of input.wireWarnings) {
    if (w.kind === "duplicate_key") dupRowsByKey.set(w.key, w.rows);
  }

  // Every key claimed by ≥1 ledger row (for coverage / registry-only).
  const claimedKeys = new Set<string>();
  for (const s of input.sources) for (const k of s.registryKeys) claimedKeys.add(k);

  const inBase: ReconciledSource[] = [];
  const notInBase: ReconciledSource[] = [];
  const counts = {
    feedingBase: 0,
    usableNotMerged: 0,
    gated: 0,
    forbidden: 0,
    deadNotYetSupersededOther: 0,
  };

  for (const s of input.sources) {
    let baseRows = 0;
    let baseWithEmail = 0;
    let baseSendable = 0;
    let baseLastExtractedAt: string | null = null;
    for (const k of s.registryKeys) {
      const a = aggByKey.get(k);
      if (!a) continue;
      baseRows += a.rows;
      baseWithEmail += a.withEmail;
      baseSendable += a.sendable;
      if (a.lastExtractedAt && (baseLastExtractedAt === null || a.lastExtractedAt > baseLastExtractedAt)) {
        baseLastExtractedAt = a.lastExtractedAt;
      }
    }
    const status = classifyStatus(s, baseRows);
    const claimOnly = status === "in_base" && baseRows === 0;

    // "also row N": other rows that share one of this row's duplicated keys.
    const also = new Set<number>();
    for (const k of s.registryKeys) {
      const rows = dupRowsByKey.get(k);
      if (rows && rows.includes(s.row)) for (const rn of rows) if (rn !== s.row) also.add(rn);
    }

    const rec: ReconciledSource = {
      ...s,
      status,
      claimOnly,
      baseRows,
      baseWithEmail,
      baseSendable,
      baseLastExtractedAt,
      alsoRows: Array.from(also).sort((a, b) => a - b),
    };

    if (status === "in_base" || status === "enrichment") {
      counts.feedingBase++;
      inBase.push(rec);
    } else {
      notInBase.push(rec);
      if (status === "usable_not_merged") counts.usableNotMerged++;
      else if (status === "gated") counts.gated++;
      else if (status === "forbidden") counts.forbidden++;
      else counts.deadNotYetSupersededOther++; // dead | not_yet | superseded | other
    }
  }

  // Coverage + registry-only over DISTINCT base keys.
  let coverageRows = 0;
  const registryOnly: RegistryOnlyRow[] = [];
  for (const a of input.aggs) {
    if (claimedKeys.has(a.registry)) {
      coverageRows += a.rows;
    } else {
      registryOnly.push({
        key: a.registry,
        rows: a.rows,
        withEmail: a.withEmail,
        sendable: a.sendable,
        lastExtractedAt: a.lastExtractedAt,
      });
    }
  }
  registryOnly.sort((x, y) => y.rows - x.rows || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  // near_miss: a ledger key equals a data key under trim().toLowerCase() while
  // the raw strings differ (a likely typo/case mismatch that missed the join).
  const nearMisses: { kind: "near_miss"; key: string; dataKey: string }[] = [];
  const normDataKeys = new Map<string, string>();
  for (const a of input.aggs) normDataKeys.set(a.registry.trim().toLowerCase(), a.registry);
  const seenNear = new Set<string>();
  for (const k of claimedKeys) {
    if (aggByKey.has(k)) continue; // exact match already joined
    const dataKey = normDataKeys.get(k.trim().toLowerCase());
    if (dataKey !== undefined && dataKey !== k) {
      const sig = `${k} ${dataKey}`;
      if (!seenNear.has(sig)) {
        seenNear.add(sig);
        nearMisses.push({ kind: "near_miss", key: k, dataKey });
      }
    }
  }

  const totalRows = input.totalRows;
  const coveragePct = totalRows > 0 ? Math.round((coverageRows / totalRows) * 1000) / 10 : 0;

  // Filter-chip source sets.
  const countryFreq = new Map<string, number>();
  const verdictSet = new Set<string>();
  for (const s of input.sources) {
    verdictSet.add(s.verdict);
    for (const c of splitCountries(s.country)) countryFreq.set(c, (countryFreq.get(c) ?? 0) + 1);
  }
  const countries = Array.from(countryFreq.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([c]) => c);
  const verdicts = Array.from(verdictSet).sort();

  // versionSkew + ledgerAgeDays.
  const versionSkew =
    input.ledgerSourceVersion && input.baseSourceVersion && input.ledgerSourceVersion !== input.baseSourceVersion
      ? { ledgerVersion: input.ledgerSourceVersion, baseVersion: input.baseSourceVersion }
      : null;
  const ledgerAgeDays =
    input.ledgerMtimeMs !== null && input.basePublishedAt !== null
      ? Math.round((input.ledgerMtimeMs - input.basePublishedAt) / 86_400_000)
      : null;

  return {
    inBase: sortSectionA(inBase, "rows"),
    notInBase: sortSectionB(notInBase),
    registryOnly,
    kpis: {
      ledgerRows: input.sources.length,
      feedingBase: counts.feedingBase,
      registryOnlyCount: registryOnly.length,
      coverageRows,
      totalRows,
      coveragePct,
      usableNotMerged: counts.usableNotMerged,
      gated: counts.gated,
      forbidden: counts.forbidden,
      deadNotYetSupersededOther: counts.deadNotYetSupersededOther,
    },
    versionSkew,
    ledgerAgeDays,
    warnings: input.wireWarnings,
    parseWarnings: input.parseWarnings,
    nearMisses,
    sourcesTruncated: input.sourcesTruncated,
    sourcesUnreadable: input.sourcesUnreadable,
    countries,
    verdicts,
  };
}

// ---- sort (pinned) ---------------------------------------------------------

function cmpName(a: { name: string; row: number }, b: { name: string; row: number }): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.row - b.row;
}

/** Section A: rows desc, name (lower) asc, row asc; or name asc, row asc. */
export function sortSectionA(rows: ReconciledSource[], sort: "rows" | "name"): ReconciledSource[] {
  const out = [...rows];
  if (sort === "name") out.sort((a, b) => cmpName(a, b));
  else out.sort((a, b) => b.baseRows - a.baseRows || cmpName(a, b));
  return out;
}

/** Section B: assessed_at desc (nulls last), name asc, row asc. */
export function sortSectionB(rows: ReconciledSource[]): ReconciledSource[] {
  return [...rows].sort((a, b) => {
    const ax = a.assessedAt;
    const bx = b.assessedAt;
    if (ax !== bx) {
      if (ax === null) return 1;
      if (bx === null) return -1;
      return ax < bx ? 1 : -1; // desc
    }
    return cmpName(a, b);
  });
}

// ---- filters ---------------------------------------------------------------

export type SourceFilters = {
  status: SourceStatus | null;
  verdict: string | null;
  country: string | null;
  section: string | null;
  q: string | null;
  sort: "rows" | "name" | null;
};

/** Read one param: a plain string, else null (an array or absent param is invalid). */
function single(v: string | string[] | undefined): string | null {
  return typeof v === "string" ? v : null;
}

export function parseSourceFilters(sp: Record<string, string | string[] | undefined>): SourceFilters {
  const statusRaw = single(sp.status);
  const status =
    statusRaw !== null && (SOURCE_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as SourceStatus)
      : null;

  const verdictRaw = single(sp.verdict);
  const verdict = verdictRaw !== null && /^[A-Z0-9-]{1,32}$/.test(verdictRaw) ? verdictRaw : null;

  const countryRaw = single(sp.country);
  const country =
    countryRaw !== null && /^[A-Z]{2}$|^GLOBAL$|^MULTI$|^EU$/.test(countryRaw) ? countryRaw : null;

  const sectionRaw = single(sp.section);
  const section = sectionRaw !== null && /^[A-Z]$/.test(sectionRaw) ? sectionRaw : null;

  const qRaw = single(sp.q);
  let q: string | null = null;
  if (qRaw !== null) {
    const nfc = qRaw.normalize("NFC");
    if (/^[\p{L}\p{N}\p{M} .-]{1,40}$/u.test(nfc)) q = nfc;
  }

  const sortRaw = single(sp.sort);
  const sort = sortRaw === "rows" || sortRaw === "name" ? sortRaw : null;

  return { status, verdict, country, section, q, sort };
}

/** Filter a section's rows by the validated filter set (KPIs stay unfiltered). */
export function applySourceFilters(rows: ReconciledSource[], f: SourceFilters): ReconciledSource[] {
  const qFolded = f.q !== null ? fold(f.q) : null;
  return rows.filter((r) => {
    if (f.status !== null && r.status !== f.status) return false;
    if (f.verdict !== null && r.verdict !== f.verdict) return false;
    if (f.section !== null && r.section !== f.section) return false;
    if (f.country !== null && !splitCountries(r.country).includes(f.country)) return false;
    if (qFolded !== null && !fold(r.name).includes(qFolded)) return false;
    return true;
  });
}

/** The validated filter set as a plain record for toggleParamHref / hidden inputs. */
export function filterParams(f: SourceFilters): Record<string, string | null> {
  return {
    status: f.status,
    verdict: f.verdict,
    country: f.country,
    section: f.section,
    q: f.q,
    sort: f.sort,
  };
}
