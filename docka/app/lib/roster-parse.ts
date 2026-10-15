// Pure, client-safe roster parsing helpers — extracted from components/ImportCrew.tsx
// so they are unit-testable WITHOUT the "use client" React shell (same pattern as
// lib/fuzzy-name.ts). ImportCrew re-exports gridToRoster/parseRoster from here.
//
// This module imports NOTHING server-only (no fs, no @/auth), so it can be pulled into
// the client bundle AND into the /api/invite route on the server.

// The import row carries DOB / passport / seaman's-book when the roster has those
// columns (#37.2), plus an OPTIONAL email column (captured per row, validated).
export type Row = {
  name: string;
  rank: string;
  dob?: string | null;
  passportNo?: string | null;
  seamanBookNo?: string | null;
  /** Lower-cased, isEmailish-validated address; null when absent/invalid. */
  email?: string | null;
};

// Strip a single leading BOM (U+FEFF) so a cell that begins with one doesn't poison
// downstream matching / validation.
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Safely stringify an xlsx / grid cell (number, Date, hyperlink object, boolean,
 * null, undefined) to a plain string WITHOUT ever throwing. A Date becomes its ISO
 * string; a hyperlink-style object prefers its `text`/`result`/`hyperlink` field; an
 * un-stringifiable object degrades to "". A leading BOM is stripped.
 */
export function coerceCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return stripBom(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? "" : v.toISOString();
  }
  try {
    const o = v as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (typeof o.text === "string") return stripBom(o.text);
    if (typeof o.result === "string") return stripBom(o.result);
    if (typeof o.hyperlink === "string") return stripBom(o.hyperlink);
    const s = String(v);
    return s === "[object Object]" ? "" : stripBom(s);
  } catch {
    return "";
  }
}

/**
 * Is `s` an address safe to treat as an imported contact email? Deliberately strict
 * (a header-injection + spoofing guard, NOT full RFC 5322):
 *  - trims; exactly one `@`; a dot inside the domain (not leading/trailing).
 *  - no whitespace of any kind.
 *  - REJECTS CR/LF/ASCII-control + DEL (header-injection guard).
 *  - REJECTS zero-width space U+200B and BOM U+FEFF ANYWHERE (not just leading).
 *  - REJECTS a surrounding quote.
 *  - length <= 128.
 *  - MVP IDN policy: REJECTS any non-ASCII domain codepoint (> U+007F).
 * Invalid -> false; the caller treats that as "no email" and still imports the row.
 */
export function isEmailish(s: string): boolean {
  if (typeof s !== "string") return false;
  // Zero-width space / BOM anywhere — check the RAW string before trim (some of these
  // are whitespace-trimmable and would otherwise slip through).
  if (/[​﻿]/.test(s)) return false;
  const t = s.trim();
  if (t.length === 0 || t.length > 128) return false;
  // Surrounding quotes.
  if (/^["']/.test(t) || /["']$/.test(t)) return false;
  // CR / LF / ASCII control + DEL (header injection).
  if (/[\x00-\x1f\x7f]/.test(t)) return false;
  // Any whitespace (space, tab, unicode spaces, line/para separators, NBSP…).
  if (/\s/.test(t)) return false;
  // Exactly one @.
  const at = t.indexOf("@");
  if (at < 0 || at !== t.lastIndexOf("@")) return false;
  const local = t.slice(0, at);
  const domain = t.slice(at + 1);
  if (!local || !domain) return false;
  // A dot inside the domain, not at either edge.
  const dot = domain.indexOf(".");
  if (dot <= 0 || dot === domain.length - 1) return false;
  // MVP IDN policy — reject any non-ASCII domain codepoint (e.g. münchen.de).
  for (const ch of domain) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return false;
  }
  return true;
}

// Split a single delimited line, honouring "quoted, fields" and "" escapes.
export function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// The exact-ish set of email-column headers we accept. Deliberately NOT a loose
// /e-?mail/ (which would grab email_opt_in / email_verified / emailed_date).
const EMAIL_HEADERS = new Set([
  "email",
  "e-mail",
  "email address",
  "e-mail address",
  "contact email",
]);

// Grid (rows × cells) -> Row[], with header detection + column mapping. Shared by the
// CSV/TSV text path and the .xlsx path so both behave identically (a header row is
// auto-detected; default col0 = name, col1 = rank).
//
// E-mail capture, two rules (R2-1, security):
//   (1) HEADERED grid → ONLY an exact EMAIL_HEADERS column; no match → null. A
//       "Next of kin e-mail" / "Agency contact" column (deliberately not in
//       EMAIL_HEADERS) is therefore NEVER stored as importedEmail, so the
//       profile-takeover link can't be mailed to the wrong person.
//   (2) HEADER-LESS grid → positional sniff of the cells outside name/rank that pass
//       isEmailish; EXACTLY ONE such cell → captured; zero or ≥2 → null (ambiguous is
//       never "first wins").
//
// Surname support (R2-2, header-driven only): a "Surname" / "Last name" /
// "Perekonnanimi" column is matched first, then excluded from the generic /name/
// match, and joined onto the first name. Both column orders work (indices, not
// positions, drive the join). A header-less paste has NO surname handling (positional
// col0/col1 only) — a documented limitation.
export function gridToRoster(grid: string[][]): Row[] {
  grid = grid.filter((r) => r.some((c) => coerceCell(c).trim().length > 0));
  if (grid.length === 0) return [];

  let nameIdx = 0;
  let surnameIdx = -1;
  let rankIdx = grid[0].length > 1 ? 1 : -1;
  let dobIdx = -1;
  let passportIdx = -1;
  let emailIdx = -1;
  let start = 0;
  const head = grid[0].map((c) => coerceCell(c).toLowerCase());
  const norm = grid[0].map((c) => coerceCell(c).trim().toLowerCase());
  const looksLikeHeader = head.some((c) => /name|nimi|seafarer|crew/.test(c));
  if (looksLikeHeader) {
    start = 1;
    // R2-2: surname first, so the generic /name/ match below can exclude it.
    surnameIdx = head.findIndex((c) => /surname|last\s*name|family\s*name|perekonnanimi/.test(c));
    const ni = head.findIndex(
      (c, i) =>
        i !== surnameIdx &&
        /name|nimi|seafarer|crew|full\s*name|first\s*name|given|forename|eesnimi/.test(c)
    );
    const ri = head.findIndex((c) => /rank|position|role|rating|title|amet/.test(c));
    // #37.2 — recognise a DOB column and a passport / seaman's-book column.
    dobIdx = head.findIndex((c) => /dob|birth|sünni|date of birth/i.test(c));
    passportIdx = head.findIndex((c) => /passport|seaman'?s? book|book no|discharge/i.test(c));
    // Email — exact-ish header match; first index wins deterministically on duplicates.
    emailIdx = norm.findIndex((c) => EMAIL_HEADERS.has(c));
    if (ni >= 0) nameIdx = ni;
    else if (surnameIdx >= 0) nameIdx = surnameIdx; // surname-only sheet → the surname IS the name
    rankIdx = ri; // -1 if no rank column
  }

  const rows: Row[] = [];
  for (let i = start; i < grid.length; i++) {
    const cells = grid[i];
    const first = coerceCell(cells[nameIdx]).trim();
    const last =
      surnameIdx >= 0 && surnameIdx !== nameIdx ? coerceCell(cells[surnameIdx]).trim() : "";
    const name = [first, last].filter(Boolean).join(" ");
    if (!name) continue;
    const rank = rankIdx >= 0 ? coerceCell(cells[rankIdx]).trim() : "";
    const dob = dobIdx >= 0 ? coerceCell(cells[dobIdx]).trim() : "";
    const passport = passportIdx >= 0 ? coerceCell(cells[passportIdx]).trim() : "";
    let email: string | null = null;
    if (emailIdx >= 0) {
      // (1) headered grid → the exact EMAIL_HEADERS column only.
      const raw = coerceCell(cells[emailIdx]);
      email = isEmailish(raw) ? raw.trim().toLowerCase() : null;
    } else if (!looksLikeHeader) {
      // (2) header-less grid → positional sniff; exactly one emailish cell wins.
      // dobIdx/passportIdx are -1 here by construction, so only name/rank need excluding.
      const hits = cells
        .map((c, idx) => ({ idx, v: coerceCell(c) }))
        .filter(({ idx, v }) => idx !== nameIdx && idx !== rankIdx && isEmailish(v));
      email = hits.length === 1 ? hits[0].v.trim().toLowerCase() : null;
    }
    rows.push({
      name,
      rank,
      dob: dob ? dob.slice(0, 10) : null,
      passportNo: passport || null,
      email,
    });
  }
  return rows;
}

export function parseRoster(text: string): Row[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  // Pick the delimiter that splits the first line into the most columns.
  const delim = [",", ";", "\t"]
    .map((d) => ({ d, n: splitLine(lines[0], d).length }))
    .sort((a, b) => b.n - a.n)[0].d;

  const grid = lines.map((l) => splitLine(l, delim).map((c) => c.trim()));
  return gridToRoster(grid);
}
