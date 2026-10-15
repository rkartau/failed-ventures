// UA-MARAD result-PDF date extraction (pdf-verify plan RUNG v2 item A).
//
// The vrf.marad.gov.ua hit page links per-request hash URLs that serve a
// ~45KB one-page verification-result PDF with a REAL text layer: a
// VALID/ДІЙСНИЙ status banner, an expire date (or "Unlimited"), the document
// number + issue date, and the holder fields. The adapter fetches that PDF in
// the same verify call (the tokens are ephemeral) and lifts ONLY the dates —
// never the holder PII — into the cert.
//
// DEPENDENCY-FREE BY HARD RULE: this module runs inside the Next server
// bundle, where pdfjs-dist / @napi-rs/canvas MUST NOT be imported (they live
// in the recognize worker only). The registry's generator is stable, so the
// parser is a purpose-built scan pinned against the two real captures
// (2026-08-24: result_en.pdf = CoC "expire: Unlimited"; endorse_1.pdf =
// endorsement "до : 20.10.2029"):
//
//   1. every `stream … endstream` segment is inflated with Node's built-in
//      zlib (FlateDecode; non-deflate segments are skipped, inflate output is
//      capped against bombs);
//   2. string literals of the text-showing operators (Tj / TJ arrays) are
//      collected in document order, PDF escapes decoded;
//   3. the generator writes ALL strings as UTF-16BE (a composite font whose
//      CIDs are Unicode code points: `04 21` = С, `00 32` = "2", `21 16` =
//      №), so the fragments decode to real readable text — "Статус
//      документу :", "ДІЙСНИЙ", "до :", "20.10.2029", "expire: Unlimited",
//      "№12345/2024 від 25.10.2024" — and the fields are matched on their
//      honest printed labels.
//
// zlib is reached via `process.getBuiltinModule` (the index.ts async_hooks
// precedent): this file sits under lib/registry/, which must stay
// client-bundle-safe — webpack cannot statically resolve the call, and in a
// browser the parser simply degrades to all-nulls (no server dispatch ever
// runs client-side).
//
// FAILURE HONESTY: the parser NEVER throws — garbage bytes, truncated
// streams, an unexpected layout all come back as nulls, and the caller's
// registry hit stands with the dates simply absent (today's behavior).

export type UAMARADResultPdfParse = {
  /** "valid" = VALID/ДІЙСНИЙ banner found; "invalid" = an explicit negative; "unknown" otherwise. */
  status: "valid" | "invalid" | "unknown";
  /** ISO "YYYY-MM-DD" expire date, or null (absent, unparsable, or unlimited). */
  validUntil: string | null;
  /** ISO "YYYY-MM-DD" issue date from the document-number line, or null. */
  issuedOn: string | null;
  /** TRUE when the expire field reads "Unlimited"/"Необмежен…" (CoC class). */
  unlimited: boolean;
};

const EMPTY: UAMARADResultPdfParse = {
  status: "unknown",
  validUntil: null,
  issuedOn: null,
  unlimited: false,
};

// Hostility bounds: the fetch layer caps input at 1 MB; these cap what the
// parser itself will expand/scan regardless of the caller.
const MAX_STREAMS_SCANNED = 64;
const MAX_INFLATED_PER_STREAM = 8_000_000; // zlib maxOutputLength (bomb guard)
const MAX_TOTAL_TEXT_CHARS = 2_000_000;

type ZlibLike = {
  inflateSync(buf: Uint8Array, opts?: { maxOutputLength?: number }): Uint8Array;
};

function zlibBuiltin(): ZlibLike | null {
  try {
    const getBuiltin = (
      globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }
    ).process?.getBuiltinModule;
    return (getBuiltin?.("zlib") as ZlibLike | undefined) ?? null;
  } catch {
    return null;
  }
}

// ---- content-stream string extraction -----------------------------------

const STREAM_KEYWORD = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "stream"

function indexOfSeq(buf: Uint8Array, seq: number[], from: number): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * PDF literal-string scanner over one (inflated) content stream: collects the
 * raw bytes of every `(...)` literal and `<...>` hex string in stream order,
 * handling nesting, the standard backslash escapes, and octal codes. In a
 * content stream, string literals belong to the text-showing operators
 * (Tj / TJ / ' / ") — which is exactly the text layer we are after.
 */
function stringLiterals(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = stream.length;
  for (let i = 0; i < n; i++) {
    const c = stream[i];
    if (c === 0x28 /* ( */) {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const b = stream[i];
        if (b === 0x5c /* \ */) {
          const e = stream[i + 1];
          if (e === undefined) break;
          if (e >= 0x30 && e <= 0x37) {
            // octal \d{1,3}
            let oct = 0;
            let k = 0;
            while (k < 3 && stream[i + 1 + k] >= 0x30 && stream[i + 1 + k] <= 0x37) {
              oct = oct * 8 + (stream[i + 1 + k] - 0x30);
              k++;
            }
            bytes.push(oct & 0xff);
            i += 1 + k;
            continue;
          }
          const map: Record<number, number> = {
            0x6e: 0x0a, // \n
            0x72: 0x0d, // \r
            0x74: 0x09, // \t
            0x62: 0x08, // \b
            0x66: 0x0c, // \f
            0x28: 0x28, // \(
            0x29: 0x29, // \)
            0x5c: 0x5c, // \\
          };
          if (e === 0x0a || e === 0x0d) {
            // line-continuation: swallow the EOL (and a CRLF pair)
            i += e === 0x0d && stream[i + 2] === 0x0a ? 3 : 2;
            continue;
          }
          bytes.push(map[e] ?? e);
          i += 2;
          continue;
        }
        if (b === 0x28) depth++;
        if (b === 0x29) {
          depth--;
          if (depth === 0) break;
        }
        bytes.push(b);
        i++;
      }
      out.push(Uint8Array.from(bytes));
    } else if (c === 0x3c /* < */ && stream[i + 1] !== 0x3c) {
      // hex string <...> (never the dict opener <<)
      const bytes: number[] = [];
      let hi = -1;
      let j = i + 1;
      for (; j < n; j++) {
        const b = stream[j];
        if (b === 0x3e /* > */) break;
        let v = -1;
        if (b >= 0x30 && b <= 0x39) v = b - 0x30;
        else if (b >= 0x41 && b <= 0x46) v = b - 0x41 + 10;
        else if (b >= 0x61 && b <= 0x66) v = b - 0x61 + 10;
        else continue; // whitespace inside hex strings is legal
        if (hi < 0) hi = v;
        else {
          bytes.push((hi << 4) | v);
          hi = -1;
        }
      }
      if (hi >= 0) bytes.push(hi << 4); // odd trailing digit: low nibble 0
      out.push(Uint8Array.from(bytes));
      i = j;
    }
  }
  return out;
}

/**
 * Decode one extracted string. The registry generator writes UTF-16BE
 * (Unicode-CID composite font); the heuristic checks that the high bytes sit
 * in the ranges the documents actually use (0x00 ASCII, 0x04 Cyrillic,
 * 0x20/0x21 general punctuation — №). Anything else falls back to latin1 so a
 * hypothetical single-byte string still surfaces.
 */
function decodeString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let plausible = 0;
    const pairs = bytes.length / 2;
    for (let i = 0; i < bytes.length; i += 2) {
      const hi = bytes[i];
      if (hi === 0x00 || hi === 0x04 || hi === 0x20 || hi === 0x21 || hi === 0x22) plausible++;
    }
    if (plausible / pairs >= 0.8) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 2) {
        s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return s;
    }
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * The decoded text layer of the PDF: every string literal of every
 * FlateDecode stream (plus any raw stream that visibly carries Tj operators),
 * in document order, newline-joined. Exported for tests/diagnostics.
 */
export function uaMaradPdfText(input: Uint8Array): string {
  const zlib = zlibBuiltin();
  const buf = input instanceof Uint8Array ? input : new Uint8Array(0);
  const parts: string[] = [];
  let total = 0;
  let pos = 0;
  for (let scanned = 0; scanned < MAX_STREAMS_SCANNED; scanned++) {
    const at = indexOfSeq(buf, STREAM_KEYWORD, pos);
    if (at === -1) break;
    let s = at + STREAM_KEYWORD.length;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const endKeyword = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"
    const end = indexOfSeq(buf, endKeyword, s);
    if (end === -1) break;
    const segment = buf.slice(s, end);
    pos = end + endKeyword.length;

    let content: Uint8Array | null = null;
    if (zlib) {
      try {
        content = zlib.inflateSync(segment, { maxOutputLength: MAX_INFLATED_PER_STREAM });
      } catch {
        content = null; // not deflate (image/font) or a bomb — skip
      }
    }
    if (!content) {
      // Uncompressed content stream? Only worth scanning if it shows text ops.
      const looksText = indexOfSeq(segment, [0x54, 0x6a], 0) !== -1 /* Tj */ ||
        indexOfSeq(segment, [0x54, 0x4a], 0) !== -1; /* TJ */
      if (!looksText) continue;
      content = segment;
    }
    for (const lit of stringLiterals(content)) {
      const decoded = decodeString(lit);
      total += decoded.length;
      if (total > MAX_TOTAL_TEXT_CHARS) return parts.join("\n");
      parts.push(decoded);
    }
  }
  return parts.join("\n");
}

// ---- field extraction ----------------------------------------------------

/** dd.mm.yyyy → ISO, rejecting rolled-over impossible dates (31.02 etc.). */
function isoFromDayFirst(ddmmyyyy: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null; // impossible calendar date — never ship a rolled-over guess
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const DATE_RE_SRC = "\\d{2}\\.\\d{2}\\.\\d{4}";

// Expire field, both sessions. EN prints "expire: Unlimited" / a date; the
// Ukrainian session prints the lowercase label "до :" before the date value
// (its own Tj op — \s* bridges the fragment join). Case-sensitive on the
// Ukrainian side so the endorsement title "…ДО ДИПЛОМУ" can never match.
const EXPIRE_EN_RE = new RegExp(`expire\\s*:\\s*(Unlimited|${DATE_RE_SRC})`, "i");
const EXPIRE_UK_RE = new RegExp(`до\\s*:\\s*(${DATE_RE_SRC})`);
const UNLIMITED_RE = /Unlimited|Необмежен/iu;

// Issue date: the document-number line prints "№NNNNN/YYYY from dd.mm.yyyy"
// (EN) / "№NNNNN/YYYY від dd.mm.yyyy" (UK). Anchoring on the "/YYYY →
// from|від" shape keeps every other printed date (DOB, verification
// timestamp, expire) structurally unable to match.
const ISSUED_RE = new RegExp(`/\\s*\\d{4}\\s*(?:from|від)\\s*(${DATE_RE_SRC})`, "iu");

// Status banner. The negative wordings are checked FIRST ("VALID" is a
// substring of "INVALID", "ДІЙСНИЙ" of "НЕДІЙСНИЙ").
const STATUS_INVALID_RE = /INVALID|НЕДІЙСНИЙ/u;
const STATUS_VALID_RE = /VALID|ДІЙСНИЙ/u;

/**
 * Parse a UA-MARAD verification-result PDF. Pure, never throws; garbage in →
 * `{status:"unknown", validUntil:null, issuedOn:null, unlimited:false}`.
 */
export function parseUAMARADResultPdf(input: Uint8Array): UAMARADResultPdfParse {
  try {
    const text = uaMaradPdfText(input);
    if (!text) return { ...EMPTY };

    const status: UAMARADResultPdfParse["status"] = STATUS_INVALID_RE.test(text)
      ? "invalid"
      : STATUS_VALID_RE.test(text)
        ? "valid"
        : "unknown";

    let validUntil: string | null = null;
    let unlimited = false;
    const en = EXPIRE_EN_RE.exec(text);
    if (en) {
      if (/^unlimited$/i.test(en[1])) unlimited = true;
      else validUntil = isoFromDayFirst(en[1]);
    } else {
      const uk = EXPIRE_UK_RE.exec(text);
      if (uk) validUntil = isoFromDayFirst(uk[1]);
      else if (UNLIMITED_RE.test(text)) unlimited = true;
    }

    const issued = ISSUED_RE.exec(text);
    const issuedOn = issued ? isoFromDayFirst(issued[1]) : null;

    return { status, validUntil, issuedOn, unlimited };
  } catch {
    return { ...EMPTY };
  }
}
