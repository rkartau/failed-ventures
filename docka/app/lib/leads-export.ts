// lib/leads-export.ts — pure flattening logic for GET /api/admin/leads/export
// (PIPELINE_BUILD_SPEC §15: docka becomes the outreach pipeline's lead source).
//
// INPUT — content/docka-leads.json, written onto the box by the lead-base
// publisher (handoff_publish_leads.py) in its COLUMNAR layout:
//   { schema_version, generated_at, source_version, layout: "columnar",
//     columns: [name...], dictionary_columns: [name...],
//     dictionaries: {col: [value...]}, rows: [[cell...]...] }
// where a cell of a dictionary column is an integer index into
// dictionaries[col] (or null).
//
// OUTPUT — the §15 wire contract, binding fixture:
// docka-outreach-pipeline/tests/fixtures/docka_leads_export.json —
//   { schema_version: 1, generated_at, source_version, content_sha256,
//     leads: [flat object...] }
// Every lead carries the pipeline importer's gate fields as REAL booleans
// (is_sendable, do_not_mail, sanctions_hit, email_is_personal,
// email_domain_undeliverable, risky_role_mailbox), the strings the §3 gates
// and audit need (company_name, contact_email_primary, country_iso2,
// outreach_channel_effective) and the carry/provenance strings (registry,
// segment_guess, email_source_url, source_url, extracted_at).
//
// contact_email_primary SELECTION RULE (documented per §15): the crewing/desk
// mailbox (`crewing_email`) when present, else the general `contact_email`,
// else "" — the pipeline's guards re-apply every sendability gate anyway, so
// an empty address is carried honestly rather than a row being dropped here.
//
// SIZE: the full 29,837-row base flattens to ~14.6 MB — comfortably under the
// operator's ~25 MB threshold AND the importer's 30 MB fail-closed cap
// (import_leads.EXPORT_MAX_BYTES), so ALL rows are exported, no email filter.
// If the base ever grows past EXPORT_SOFT_MAX_BYTES the serializer refuses
// (honest 503) rather than shipping something the importer will refuse anyway.
//
// content_sha256 CONTRACT (verified against the fixture): sha256 hex of the
// UTF-8 bytes of the leads ARRAY serialized exactly like Python's
// json.dumps(leads, sort_keys=True, separators=(",",":"), ensure_ascii=False):
// object keys sorted, no whitespace, non-ASCII kept raw. All values here are
// strings/booleans, so JSON.stringify over sorted-key objects is byte-identical
// to that Python form.
//
// Validation is FAIL CLOSED (unlike the lenient board upload): this file is
// deterministic machine output, and the importer refuses malformed exports
// wholesale — a half-flattened export has no honest consumer. Node crypto is
// imported here (server-only module; no client island ever imports this).

import crypto from "crypto";

// ---- Constants -------------------------------------------------------------

/** Refuse to serve an export larger than this (importer caps at 30 MB). */
export const EXPORT_SOFT_MAX_BYTES = 25 * 1024 * 1024;

/** Gate fields — must be REAL booleans on the wire (importer fails closed). */
export const EXPORT_BOOL_FIELDS = [
  "is_sendable",
  "do_not_mail",
  "sanctions_hit",
  "email_is_personal",
  "email_domain_undeliverable",
  "risky_role_mailbox",
] as const;

/** String fields — "" when the source cell is null/absent. */
export const EXPORT_STR_FIELDS = [
  "company_name",
  "contact_email_primary",
  "country_iso2",
  "registry",
  "segment_guess",
  "email_source_url",
  "source_url",
  "extracted_at",
  "outreach_channel_effective",
] as const;

/** Source columns the §15 flattener needs; a file missing one is refused. */
export const REQUIRED_SOURCE_COLUMNS = [
  "company_name",
  "country_iso2",
  "registry",
  "segment_guess",
  "contact_email",
  "crewing_email",
  "email_source_url",
  "source_url",
  "extracted_at",
  "is_sendable",
  "outreach_channel_effective",
  "do_not_mail",
  "sanctions_hit",
  "email_is_personal",
  "email_domain_undeliverable",
  "risky_role_mailbox",
] as const;

export type ExportLead = Record<
  (typeof EXPORT_STR_FIELDS)[number] | (typeof EXPORT_BOOL_FIELDS)[number],
  string | boolean
>;

export type LeadsExport = {
  schema_version: 1;
  generated_at: string;
  source_version: string;
  content_sha256: string;
  leads: ExportLead[];
};

// ---- Canonical hashing (the §15 content_sha256 contract) -------------------

function sortedKeyCopy(lead: ExportLead): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const k of Object.keys(lead).sort()) out[k] = lead[k as keyof ExportLead];
  return out;
}

/**
 * Byte-identical to Python json.dumps(leads, sort_keys=True,
 * separators=(",",":"), ensure_ascii=False) — see file header for why plain
 * JSON.stringify suffices once keys are pre-sorted.
 */
export function canonicalLeadsJson(leads: ExportLead[]): string {
  return JSON.stringify(leads.map(sortedKeyCopy));
}

export function contentSha256(leads: ExportLead[]): string {
  return crypto.createHash("sha256").update(canonicalLeadsJson(leads), "utf8").digest("hex");
}

// ---- Columnar parsing (SHARED: §15 export route AND the /admin/leads page) --
//
// parseColumnarEnvelope / makeCellReader / asStr / asBool are exported so
// lib/docka-leads.ts (the /admin/leads page loader) consumes the SAME parser
// and decoder as the export — one flattener, no fork (each caller states its
// own required columns; the §15 default is REQUIRED_SOURCE_COLUMNS).

export type Columnar = {
  generated_at: string;
  source_version: string;
  columns: string[];
  dictionaryColumns: Set<string>;
  dictionaries: Record<string, unknown[]>;
  rows: unknown[][];
};

export function parseColumnarEnvelope(
  raw: unknown,
  requiredColumns: readonly string[] = REQUIRED_SOURCE_COLUMNS
): { ok: true; doc: Columnar } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "lead file is not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const generatedAt = typeof o["generated_at"] === "string" ? o["generated_at"].trim() : "";
  if (generatedAt === "") return { ok: false, error: "lead file missing generated_at" };
  const sourceVersion = typeof o["source_version"] === "string" ? o["source_version"].trim() : "";
  if (sourceVersion === "") return { ok: false, error: "lead file missing source_version" };

  const columns = o["columns"];
  if (!Array.isArray(columns) || !columns.every((c): c is string => typeof c === "string")) {
    return { ok: false, error: "lead file columns missing or not string[]" };
  }
  const rows = o["rows"];
  if (!Array.isArray(rows)) return { ok: false, error: "lead file rows missing" };

  const dictColsRaw = o["dictionary_columns"];
  const dictionaryColumns = new Set<string>(
    Array.isArray(dictColsRaw) ? dictColsRaw.filter((c): c is string => typeof c === "string") : []
  );
  const dictsRaw = o["dictionaries"];
  const dictionaries: Record<string, unknown[]> = {};
  if (dictsRaw !== null && typeof dictsRaw === "object" && !Array.isArray(dictsRaw)) {
    for (const [k, v] of Object.entries(dictsRaw as Record<string, unknown>)) {
      if (Array.isArray(v)) dictionaries[k] = v;
    }
  }
  for (const c of dictionaryColumns) {
    if (!dictionaries[c]) return { ok: false, error: `dictionary column "${c}" has no dictionary` };
  }

  const colIndex = new Map(columns.map((c, i) => [c, i]));
  for (const c of requiredColumns) {
    if (!colIndex.has(c)) return { ok: false, error: `lead file missing required column "${c}"` };
  }

  return {
    ok: true,
    doc: { generated_at: generatedAt, source_version: sourceVersion, columns, dictionaryColumns, dictionaries, rows: rows as unknown[][] },
  };
}

/** Resolve one cell, decoding dictionary indices; null/undefined pass through. */
function cell(doc: Columnar, row: unknown[], colIdx: number, col: string): unknown {
  const v = row[colIdx];
  if (doc.dictionaryColumns.has(col) && typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v >= doc.dictionaries[col].length) {
      throw new Error(`dictionary index ${v} out of range for "${col}"`);
    }
    return doc.dictionaries[col][v];
  }
  return v;
}

/**
 * Column-name cell accessor over a parsed doc (dictionary decode included).
 * Throws on an out-of-range dictionary index — callers fail closed per file.
 * Reading a column that was not in the caller's required list yields undefined
 * cells (asStr/asBool turn those into ""/false).
 */
export function makeCellReader(doc: Columnar): (row: unknown[], col: string) => unknown {
  const idx = new Map(doc.columns.map((c, i) => [c, i]));
  return (row, col) => {
    const i = idx.get(col);
    return i === undefined ? undefined : cell(doc, row, i, col);
  };
}

export function asStr(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`expected scalar, got ${Array.isArray(v) ? "array" : typeof v}`);
}

/** Real-boolean coercion: true / "true" (any case) -> true; all else false. */
export function asBool(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
}

/**
 * Flatten the columnar lead file into the §15 export document. FAIL CLOSED:
 * any malformed row refuses the whole export (see file header).
 */
export function flattenLeadsDoc(raw: unknown): { ok: true; export: LeadsExport } | { ok: false; error: string } {
  const env = parseColumnarEnvelope(raw);
  if (!env.ok) return env;
  const doc = env.doc;
  const at = makeCellReader(doc);

  const leads: ExportLead[] = [];
  for (let i = 0; i < doc.rows.length; i++) {
    const row = doc.rows[i];
    if (!Array.isArray(row)) return { ok: false, error: `row ${i} is not an array` };
    try {
      // contact_email_primary: crewing/desk mailbox first, else contact_email
      // (selection rule documented in the file header).
      const crewing = asStr(at(row, "crewing_email"));
      const contact = asStr(at(row, "contact_email"));
      leads.push({
        company_name: asStr(at(row, "company_name")),
        contact_email_primary: crewing !== "" ? crewing : contact,
        country_iso2: asStr(at(row, "country_iso2")),
        registry: asStr(at(row, "registry")),
        segment_guess: asStr(at(row, "segment_guess")),
        email_source_url: asStr(at(row, "email_source_url")),
        source_url: asStr(at(row, "source_url")),
        extracted_at: asStr(at(row, "extracted_at")),
        is_sendable: asBool(at(row, "is_sendable")),
        outreach_channel_effective: asStr(at(row, "outreach_channel_effective")),
        do_not_mail: asBool(at(row, "do_not_mail")),
        sanctions_hit: asBool(at(row, "sanctions_hit")),
        email_is_personal: asBool(at(row, "email_is_personal")),
        email_domain_undeliverable: asBool(at(row, "email_domain_undeliverable")),
        risky_role_mailbox: asBool(at(row, "risky_role_mailbox")),
      });
    } catch (err) {
      return { ok: false, error: `row ${i}: ${(err as Error).message}` };
    }
  }

  return {
    ok: true,
    export: {
      schema_version: 1,
      generated_at: doc.generated_at,
      source_version: doc.source_version,
      content_sha256: contentSha256(leads),
      leads,
    },
  };
}

/** Serialize the export response body (compact; hash already embedded). */
export function serializeExport(exp: LeadsExport): { ok: true; body: string } | { ok: false; error: string } {
  const body = JSON.stringify(exp);
  if (Buffer.byteLength(body, "utf8") > EXPORT_SOFT_MAX_BYTES) {
    return { ok: false, error: `export exceeds ${EXPORT_SOFT_MAX_BYTES} bytes` };
  }
  return { ok: true, body };
}

// ---- Route status mapping (pure, so the 503 semantics are testable) --------

export type ExportReadStatus = "ok" | "missing" | "unreadable" | "invalid";

/**
 * HTTP mapping for the export route: the snapshot not being on the box YET is
 * the documented 503 {ok:false, reason:"no lead snapshot"} (the publisher
 * ships it by scp); unreadable/invalid states are 503 too, with honest
 * distinct reasons — the pipeline fails closed on any non-200 alike.
 */
export function exportFailureResponse(
  status: Exclude<ExportReadStatus, "ok">
): { httpStatus: 503; body: { ok: false; reason: string } } {
  const reason =
    status === "missing"
      ? "no lead snapshot"
      : status === "unreadable"
        ? "lead snapshot unreadable"
        : "lead snapshot invalid";
  return { httpStatus: 503, body: { ok: false, reason } };
}
