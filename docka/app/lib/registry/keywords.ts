// Client-safe keyword→country matching for the anonymous verify-upload flow
// (verify-upload plan §5). A photographed certificate carries its issuing
// authority's name in print; OCR reads it (noisily), and this module turns that
// text into (a) the detected country for guided fallback / manual-entry prefill
// and (b) the ranked BARE-CODE candidate list the upload endpoint may dispatch.
//
// Matching is deliberately dumb and robust: diacritics-stripped UPPERCASE
// substring over whitespace-collapsed text. v1 is Latin-script only — Cyrillic
// (BG) and Greek authority names are DEAD until a non-eng tesseract
// traineddata ships (the OCR worker is eng-only; documented known limit).
//
// SECURITY (§5 anonymous candidate rules): the legacy EE ≥6-char FALLBACK is
// EXCLUDED for anonymous OCR candidates — any random digit string on a foreign
// certificate must NOT be sprayed at the Estonian registry — unless the
// keyword map INDEPENDENTLY says the document is Estonian. Candidates are
// hard-capped at 3 per upload.

import { COUNTRIES } from "./countries";
import { eeNormalize, genericNormalize } from "./detect";
import type { CountryCode } from "./types";

/** Hard cap on bare-code candidates dispatched per anonymous upload (§5). */
export const MAX_ANON_CANDIDATES = 3;

/**
 * Normalize free text for keyword matching: fold diacritics (NFD combining
 * marks — same recipe as nameTokens in registry/index.ts), uppercase, collapse
 * ALL whitespace (incl. OCR line breaks) to single spaces so multi-word
 * keywords match across wrapped lines.
 */
export function normalizeForKeywords(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // fold diacritics (NFD combining marks)
      .toUpperCase()
      // Letters that do NOT decompose under NFD (S\u00f8fartsstyrelsen must match
      // SOFARTSSTYRELSEN even when OCR reads the \u00d8 correctly).
      .replace(/\u00d8/g, "O")
      .replace(/\u00c6/g, "AE")
      .replace(/\u0152/g, "OE")
      .replace(/\u0110|\u00d0/g, "D")
      .replace(/\u00de/g, "TH")
      .replace(/\u0141/g, "L")
      .replace(/\u00df/g, "SS")
      .replace(/\s+/g, " ")
  );
}

export type KeywordEvidence = {
  /** Strong authority-keyword hits (`keywords`, plain substring), table order. */
  strong: CountryCode[];
  /** Weak state-name hits (`hintKeywords`, word-bounded), table order. */
  hint: CountryCode[];
};

// Hint regexes are precompiled ONCE at module load, word-bounded on the
// NORMALIZED text (uppercase, diacritics folded, whitespace collapsed —
// normalizeForKeywords above): "(^|[^A-Z])" + hint + "([^A-Z]|$)". NO flags —
// a `g` flag would make `.test()` stateful (lastIndex). No escape helper: the
// table contract is uppercase letters + spaces only, asserted here so a bad
// table entry fails the build/smoke loudly, never silently.
const HINT_SHAPE_RE = /^[A-Z ]+$/;
const HINT_PATTERNS: ReadonlyArray<{ country: CountryCode; res: RegExp[] }> = COUNTRIES.filter(
  (c) => c.hintKeywords && c.hintKeywords.length > 0
).map((c) => ({
  country: c.country,
  res: (c.hintKeywords ?? []).map((h) => {
    if (!HINT_SHAPE_RE.test(h)) {
      throw new Error(`registry table: hintKeywords entry "${h}" (${c.country}) must match /^[A-Z ]+$/`);
    }
    return new RegExp(`(^|[^A-Z])${h}([^A-Z]|$)`);
  }),
}));

/**
 * One pass over the registry table: strong authority-keyword hits (plain
 * substring — stem-style keywords like "JURNIEKU REGISTR" rely on it) and
 * weak word-bounded state-name hints, both in table order. Consumers decide
 * how to weigh them: strong hits lock (planner rule 0) and attribute the
 * country; hints only rank/activate and never lock (see `hintKeywords`).
 */
export function keywordEvidence(ocrTextAll: string): KeywordEvidence {
  const out: KeywordEvidence = { strong: [], hint: [] };
  if (!ocrTextAll || !ocrTextAll.trim()) return out;
  const text = normalizeForKeywords(ocrTextAll);
  for (const c of COUNTRIES) {
    if (!c.keywords || c.keywords.length === 0) continue;
    if (c.keywords.some((k) => text.includes(k))) out.strong.push(c.country);
  }
  for (const h of HINT_PATTERNS) {
    if (h.res.some((re) => re.test(text))) out.hint.push(h.country);
  }
  return out;
}

/**
 * Countries the OCR text points at, in registry table order: the strong
 * authority-keyword hits when any exist, otherwise the weak hint hits (ANY
 * strong hit silences ALL hints). Empty when nothing matched — the caller
 * falls back to the generic (country-less) guided fallback.
 */
export function keywordCountries(ocrTextAll: string): CountryCode[] {
  const e = keywordEvidence(ocrTextAll);
  return e.strong.length ? e.strong : e.hint;
}

export type BareCodeCandidate = {
  country: CountryCode;
  /** Normalized per the candidate country's rules (EE vs generic). */
  code: string;
  /**
   * Extra lookup inputs the planner could extract from the OCR text itself
   * (UA-MARAD: issuedOn + doctype). Passed through resolveInput's
   * `extraInputs` — never logged, sidecar-only via candidatesTried.
   */
  extraInputs?: Record<string, string>;
};

// Token extraction from OCR noise: runs of code-ish characters (letters,
// digits, common in-code separators), at least 5 long. Bounded scan so a
// pathological OCR blob cannot explode the candidate work.
const TOKEN_RE = /[A-Z0-9][A-Z0-9\-/.]{3,}[A-Z0-9]/g;
const MAX_TOKENS_SCANNED = 400;

/** Exported for the verify-upload dispatchSkipReason computation (plan A4). */
export function isAutoCapability(country: CountryCode): boolean {
  const c = COUNTRIES.find((e) => e.country === country);
  return !!c && (c.capability === "auto" || c.capability === "auto-presence");
}

/**
 * Rank bare-code candidates for an anonymous upload (§5):
 *
 *  0. KEYWORD LOCK: when EXACTLY ONE country's authority keywords appear in
 *     the OCR text, that printed authority name is treated as the issuing
 *     state — a detected-LV certificate must never spray its number-shaped
 *     tokens at the DK/EE registries just because the digit shapes fit.
 *       - locked country WITHOUT an auto adapter (assisted/manual): NO
 *         bare-code candidates at all — the caller lands on the guided
 *         fallback carrying countryDetected (the UI preselects the country
 *         and the manual round-trip renders that country's assist panel);
 *       - locked AUTO country: only THAT country's candidates are planned;
 *       - MULTIPLE countries hit (e.g. a bilingual endorsement naming two
 *         authorities): ambiguous — no lock, the ranking below stands;
 *       - QR/URL/embedded candidates are NEVER suppressed by the lock (the
 *         caller dispatches them before this planner — pinned-domain
 *         certainty beats keywords);
 *       - HINTS (`hintKeywords`, consulted only when NO strong keyword hit)
 *         rank and activate `ocrCodePattern` but NEVER lock — a state name
 *         is printed as holder nationality on foreign certs, so a hint must
 *         never suppress the other countries' shape candidates.
 *  1. tokens are matched against each AUTO country's `codePattern` (specific
 *     matches only — a specific EE 16-char match counts; the ≥6-char EE
 *     fallback does NOT);
 *  2. matches for keyword-detected countries rank FIRST (the printed authority
 *     name is stronger evidence than a bare digit shape), then table order;
 *  3. the EE fallback lane (token-shaped 12–20 alnum with a digit) is added
 *     ONLY when the keyword map independently says EE;
 *  4. deduped, hard-capped at MAX_ANON_CANDIDATES.
 *
 * Pure and fetch-free — the caller dispatches each candidate through
 * `resolveInput(code, { countryOverride, clientIp })` and stops at the first
 * match-valid / match-invalid / pending-binding.
 */
export function planBareCodeCandidates(ocrTextAll: string): BareCodeCandidate[] {
  if (!ocrTextAll || !ocrTextAll.trim()) return [];
  const text = normalizeForKeywords(ocrTextAll);
  // ONE evidence pass: strong hits when any exist, else hints (keywordCountries
  // semantics, derived here rather than re-scanned).
  const ev = keywordEvidence(ocrTextAll);
  const kwList = ev.strong.length ? ev.strong : ev.hint;
  const kwCountries = new Set(kwList);
  const strong = new Set(ev.strong);

  // §5 keyword lock (rule 0 above): a single STRONG hit locks the plan; hints
  // never lock.
  const locked: CountryCode | null = ev.strong.length === 1 ? ev.strong[0] : null;
  if (locked && !isAutoCapability(locked)) return [];

  const tokens = (text.match(TOKEN_RE) ?? []).slice(0, MAX_TOKENS_SCANNED);

  const keywordHits: BareCodeCandidate[] = [];
  const otherHits: BareCodeCandidate[] = [];
  const eeFallbackHits: BareCodeCandidate[] = [];
  const seen = new Set<string>();
  const push = (list: BareCodeCandidate[], cand: BareCodeCandidate) => {
    const key = `${cand.country}::${cand.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(cand);
  };

  for (const token of tokens) {
    const generic = genericNormalize(token);
    const ee = eeNormalize(token);
    for (const c of COUNTRIES) {
      // `codePattern` is the paste-detection shape; `ocrCodePattern` (types.ts)
      // is the planner-only companion active EXCLUSIVELY when this country's
      // own keywords (or, with no strong hit anywhere, its hints) matched —
      // how UA-MARAD's DK-colliding digit shape powers keyword-anchored OCR
      // candidates without touching paste detection.
      const fromOcrPattern = !c.codePattern && kwCountries.has(c.country) && !!c.ocrCodePattern;
      const pat = c.codePattern ?? (fromOcrPattern ? c.ocrCodePattern : undefined);
      if (!pat || !isAutoCapability(c.country)) continue;
      // Hint-only activation (no strong keyword) is weaker evidence: the RAW
      // token must also carry the country's printed shape (ocrCodeRawPattern)
      // — a bare digit run under a mere state-name hint stays in the shape
      // lane of whichever country's codePattern it fits. No ocrCodeRawPattern
      // in the table → hint-only activation is impossible (fail-closed).
      if (fromOcrPattern && !strong.has(c.country) && !(c.ocrCodeRawPattern?.test(token) ?? false)) {
        continue;
      }
      // Keyword lock: a single detected country suppresses every OTHER
      // country's bare-code candidates (foreign-registry cross-fire guard).
      if (locked && c.country !== locked) continue;
      if (c.country === "EE") {
        // SPECIFIC EE match only (16-char token) — never the ≥6 fallback here.
        if (ee && pat.test(ee)) {
          push(kwCountries.has("EE") ? keywordHits : otherHits, { country: "EE", code: ee });
        }
        continue;
      }
      // ocrCodePattern is ALSO tested against the RAW uppercase token (the
      // TOKEN_RE match keeps in-code separators like "/"): a slash-anchored
      // pattern (AZ "NNNNNN/YY") can never match under genericNormalize (the
      // slash is stripped), while its normalized 8-digit form would self-
      // collide with in-document dd.mm.yyyy dates — raw-form testing is how
      // that shape stays candidate-safe. The emitted candidate still carries
      // the NORMALIZED code (adapter reconstructs the wire form — the
      // uaMaradDocParam precedent). codePattern countries are unaffected:
      // raw testing applies to ocrCodePattern ONLY.
      const rawHit = fromOcrPattern && pat.test(token);
      if ((generic && pat.test(generic)) || rawHit) {
        push(kwCountries.has(c.country) ? keywordHits : otherHits, {
          country: c.country,
          code: generic,
        });
      }
    }
    // EE fallback lane — ONLY when the keyword map independently says EE:
    // token-shaped (12–20 alnum incl. a digit, mirroring detect.ts's
    // token-named-file heuristic) so ordinary words never reach the registry.
    if (kwCountries.has("EE") && /^[A-Z0-9]{12,20}$/.test(ee) && /\d/.test(ee)) {
      push(eeFallbackHits, { country: "EE", code: ee });
    }
  }

  const merged = [...keywordHits, ...otherHits, ...eeFallbackHits].slice(0, MAX_ANON_CANDIDATES);
  // UA-MARAD post-processing (fan-out ADDS a candidate after the cap above,
  // so the cap is re-applied afterwards — total stays ≤ MAX_ANON_CANDIDATES
  // even when other countries' candidates coexist), then the AZ enrichment
  // (first-token dedupe + DOB extraction — never adds candidates).
  return enrichAZCandidates(enrichUAMARADCandidates(merged, ocrTextAll), ocrTextAll).slice(
    0,
    MAX_ANON_CANDIDATES
  );
}

// ---- UA-MARAD candidate enrichment (pdf-verify plan B5) --------------------

// Day-first printed-date scan (the UA document prints dd.mm.yyyy). Kept local
// (not ocr-parse.ts extractDates) because `iso()` there silently ROLLS OVER
// impossible calendar dates (31.02 → 02.03) — an OCR digit mis-read must be
// discarded, never shipped to the registry as a "valid" wrong issuedOn.
const DAY_FIRST_DATE_RE = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\b/g;

function realCalendarIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip check: a rolled-over date (31.02 → 02.03) is NOT the printed
  // date — discard it as if not found.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * UA-MARAD post-processing over the planner's capped candidate list:
 *
 *  1. FIRST-TOKEN DEDUPE: a document whose OCR yields two distinct
 *     `ocrCodePattern` tokens produces two UA-MARAD candidates — only the one
 *     whose token matched FIRST (document order) survives; every other
 *     UA-MARAD candidate is dropped. At most 2 UA-MARAD candidates ever
 *     leave the planner — never 71/70 pairs for two different tokens.
 *  2. ISSUE-DATE extraction: day-first dates whose YEAR equals the code's
 *     trailing 4 digits ("123452024" → "2024") — year-anchoring selects the
 *     issue date among several printed dates (the endorsement's 20.10.2029
 *     expiry is excluded); calendar-validated (no iso() rollover); earliest
 *     such date wins.
 *  3. DOCTYPE FAN-OUT (only with a date): TWO candidates — doctype "71"
 *     (endorsement, carries real validity) first, "70" (CoC, "Unlimited")
 *     second. The two documents in this class may print DIFFERENT issue
 *     dates; v1 sends the one extracted date to both dispatches — a
 *     wrong-date 71 miss falls through to the 70 hit (documented, accepted).
 *  4. No matching date → the single candidate goes out WITHOUT extraInputs;
 *     dispatch yields needs-inputs → the settle COMPLETES with that outcome
 *     and the UI renders the §5.2 prompt, extracted code prefilled
 *     (2026-08-24 defect fix — no longer the code-discarding fallback).
 *
 * DIVERGENCE FROM enrichAZCandidates IS DELIBERATE — do not unify: this
 * helper's date rule is EARLIEST-WINS year-anchored (an issue date is
 * DETERMINISTIC — the earliest printed date of the code's year), while the AZ
 * helper's DOB rule is exactly-one-DISTINCT-ISO-or-nothing (a wrong guessed
 * DOB is a false registry miss, so ambiguity must defer to the user). Paired
 * pin tests in both suites break any "unification" refactor loudly.
 *
 * Pure and fetch-free, exported for unit tests.
 */
export function enrichUAMARADCandidates(
  cands: BareCodeCandidate[],
  ocrTextAll: string
): BareCodeCandidate[] {
  const firstUA = cands.find((c) => c.country === "UA-MARAD");
  if (!firstUA) return cands;

  const year = firstUA.code.slice(-4);
  let issuedOn: string | null = null;
  const text = normalizeForKeywords(ocrTextAll);
  DAY_FIRST_DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DAY_FIRST_DATE_RE.exec(text)) !== null) {
    if (m[3] !== year) continue; // year-anchor: issue year = code's year suffix
    const iso = realCalendarIso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (iso && (issuedOn === null || iso < issuedOn)) issuedOn = iso;
  }

  const out: BareCodeCandidate[] = [];
  let inserted = false;
  for (const c of cands) {
    if (c.country === "UA-MARAD") {
      if (inserted) continue; // first-token dedupe: drop later UA candidates
      inserted = true;
      if (issuedOn) {
        out.push({ country: "UA-MARAD", code: firstUA.code, extraInputs: { issuedOn, doctype: "71" } });
        out.push({ country: "UA-MARAD", code: firstUA.code, extraInputs: { issuedOn, doctype: "70" } });
      } else {
        out.push({ country: "UA-MARAD", code: firstUA.code });
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

// ---- AZ (DDLA) candidate enrichment (az-adapter plan B5) -------------------

// AZ-local day-first printed-date scan, BOTH centuries — a DOB like 18.05.1992
// must match (UA's issue-date regex above is 20\d{2}-anchored and would never
// see it). Shares realCalendarIso: an OCR digit mis-read that rolls over
// (31.02 → 02.03) is discarded, never shipped to the registry.
// ":" is in the separator class per the B2 real-OCR gate (2026-08-24): the
// operator sample's DOB rendered "18:05.3992" — the dot after the day reads
// as a colon on this doc class. (That sample's YEAR also misread, 1992→3992,
// which no tolerant separator can recover — digit substitution is guessing
// and stays rejected; the year anchor keeps such reads out and the honest
// needs-inputs path takes over.)
const AZ_DAY_FIRST_DATE_RE = /\b(\d{1,2})[.\-/:](\d{1,2})[.\-/:]((?:19|20)\d{2})\b/g;

/**
 * AZ post-processing over the planner's capped candidate list:
 *
 *  1. FIRST-TOKEN DEDUPE: only the first AZ candidate (document order)
 *     survives — AZ never fans out, so at most ONE AZ candidate ever leaves
 *     the planner (cap-friendly by construction).
 *  2. DOB extraction (Decision 2): day-first dates in either century; with
 *     `issueYear = 2000 + <the code's /YY suffix>`, a date QUALIFIES as a DOB
 *     iff its year ≤ issueYear − 15 (the issue date and endorsement-era dates
 *     are excluded; a seafarer is at least 15 years older than their cert).
 *     Calendar-validated via realCalendarIso.
 *  3. EXACTLY-ONE rule, counted over DISTINCT qualifying ISO values — NOT
 *     occurrences: the AZ document prints both cert sides in ONE image, so
 *     the same DOB appears twice; two prints of one value = one distinct DOB
 *     → extracted. Zero or ≥2 distinct values → NO extraInputs → the
 *     dispatch yields needs-inputs → the settle COMPLETES with that outcome
 *     and the UI prompts for the DOB with the extracted code prefilled
 *     (2026-08-24 defect fix; honest path — a wrong guessed DOB would be a
 *     false registry miss).
 *
 * `/9x`-SUFFIX EDGE (documented, not guarded): a hypothetical suffix "/98"
 * gives issueYear = 2098, threshold 2083 — nearly every printed date would
 * qualify and the rule turns silently permissive. Harmless today (5-year
 * validity keeps live suffixes in the 2x band); revisit in v2 before wiring
 * any doc class with long-lived numbers.
 *
 * DIVERGENCE FROM enrichUAMARADCandidates IS DELIBERATE — do not unify: UA's
 * rule is earliest-wins year-anchored ISSUE-date extraction (deterministic),
 * this one is exactly-one-distinct DOB-or-defer (a wrong DOB is a false miss,
 * so ambiguity defers to the user). Paired pin tests in both suites break any
 * "unification" refactor loudly.
 *
 * Pure and fetch-free, exported for unit tests.
 */
export function enrichAZCandidates(
  cands: BareCodeCandidate[],
  ocrTextAll: string
): BareCodeCandidate[] {
  const firstAZ = cands.find((c) => c.country === "AZ");
  if (!firstAZ) return cands;

  const issueYear = 2000 + Number(firstAZ.code.slice(-2));
  const cutoffYear = issueYear - 15;
  const distinct = new Set<string>();
  const text = normalizeForKeywords(ocrTextAll);
  AZ_DAY_FIRST_DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AZ_DAY_FIRST_DATE_RE.exec(text)) !== null) {
    const year = Number(m[3]);
    if (year > cutoffYear) continue; // issue/expiry/endorsement-era dates out
    const iso = realCalendarIso(year, Number(m[2]), Number(m[1]));
    if (iso) distinct.add(iso);
  }
  const dob = distinct.size === 1 ? [...distinct][0] : null;

  const out: BareCodeCandidate[] = [];
  let inserted = false;
  for (const c of cands) {
    if (c.country === "AZ") {
      if (inserted) continue; // first-token dedupe: drop later AZ candidates
      inserted = true;
      out.push(
        dob
          ? { country: "AZ", code: firstAZ.code, extraInputs: { dob } }
          : { country: "AZ", code: firstAZ.code }
      );
      continue;
    }
    out.push(c);
  }
  return out;
}
