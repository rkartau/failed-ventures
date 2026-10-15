// Ukraine — STATE registry (vrf.marad.gov.ua), the flag-state counterpart to
// the UA-TCCS training-center validator (countries.ts "UA-MARAD" entry).
// Морська адміністрація / Maritime Administration of Ukraine — this IS the
// government seafarer registry, so (unlike TCCS) a positive answer carries
// verifiedSource:"government" and rides the normal §2.5 holder-binding path.
//
// Wire format captured live 2026-08-13 (authoritative dossier):
//
//   1. GET  https://vrf.marad.gov.ua/check-document
//        -> 200 quick-search form + Set-Cookie PHPSESSID (+ Cloudflare __cf_bm
//           on .marad.gov.ua). The host sits behind Cloudflare and requires a
//           BROWSER User-Agent — the plain descriptive registry UA is refused
//           at the edge, so this adapter (alone) sends a browser UA string.
//   2. POST the same URL (application/x-www-form-urlencoded, Cookie riding):
//        qualification_doctype=<70|71|72|73|74>
//        doc=<document number as printed, e.g. NNNNN/YYYY>
//        qualification_gmzlb_date_day/_month/_year=<issue date, NON-padded
//          day/month select values ("7", not "07")>
//        submit=Зробити запит
//
// Outcome mapping (§3.1 honesty rules; hit page CAPTURED LIVE 2026-08-24 —
// fixtures in tests/fixtures/registry/ua-marad/ are scrubbed-in-place copies
// of the real capture bytes):
//   - miss marker "документ не знайдено" (hardcoded Ukrainian even in the EN
//     session; never anchored on the site's "Нажаль" typo) →
//       issue date >= 2023 → definitive `no-match`
//       issue date <  2023 → `indeterminate` reason "not-in-quick-index"
//     (the quick index reliably covers 2023+ issuances only — an old
//     document's miss is inconclusive, never a verdict);
//   - the result block ("Результат пошуку") with the bilingual download
//     anchors → `match-valid` (government). The REAL hit page (2026-08-24)
//     links `/services/documents/pdf/hash/{~55-char token}` — NO ".pdf"
//     suffix — with title "Підтвердження кваліфікації моряка українською";
//     the legacy ".pdf"-suffixed shape stays accepted for portal variants.
//     Guarded three ways: only same-host (*.marad.gov.ua) anchors whose
//     text/title reads as a verification result count (uaMaradPdfHrefs) — a
//     stray manual .pdf, the "Запит на верифікацію" request anchor, or a
//     foreign-host link never turns into a verdict. The hash tokens are
//     per-request/ephemeral — v1 knowingly stores the link as-is (v2 fetches
//     it immediately);
//   - ANYTHING else (blank form re-render, Cloudflare challenge, drift) →
//     `indeterminate`. NOTHING ever maps to `match-invalid` (TCCS precedent:
//     no observed wording positively asserts invalidity).

import type { VerifiedCert, DocCategory } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";
import { countryEntry } from "../countries";
import { parseUAMARADResultPdf, type UAMARADResultPdfParse } from "./ua-marad-pdf";

const DEFAULT_BASE = "https://vrf.marad.gov.ua";
const FORM_PATH = "/check-document";

// Cloudflare-fronted host: the edge refuses non-browser User-Agents (dossier
// 2026-08-13), so this adapter sends a mainstream browser UA. This is the ONE
// documented exception to the plain descriptive REGISTRY_USER_AGENT — still
// one honest lookup per user action, nothing about the request is disguised
// beyond what the CDN demands to serve the public form at all.
const UA_MARAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_UA_MARAD
  ) {
    return process.env.REGISTRY_BASE_UA_MARAD;
  }
  return DEFAULT_BASE;
}

// The quick index reliably covers issuances from this year on (dossier
// 2026-08-13) — the date gate that keeps an old document's miss honest.
const QUICK_INDEX_FROM_YEAR = 2023;

// SOFT shape of the printed document number ("NNNNN/YYYY", the year part
// optional). Used for normalization decisions ONLY — never to block a lookup
// (the registry itself is the authority on what exists).
export const UA_MARAD_CODE_PATTERN = /^\d{1,8}(\s*\/\s*\d{4})?$/;

// Deterministic miss marker — hardcoded Ukrainian even in the EN session.
// Deliberately NOT anchored on the page's leading "Нажаль" (a typo the site
// may fix); \s+ bridges wrapped/normalized whitespace.
const MISS_RE = /документ\s+не\s+знайдено/i;

/** The five wire doctype codes — sourced from the countries.ts entry options. */
export function uaMaradDoctypes(): Map<string, string> {
  const entry = countryEntry("UA-MARAD");
  const opts = entry?.inputs.find((f) => f.key === "doctype")?.options ?? [];
  return new Map(opts.map((o) => [o.value, o.label]));
}

// Wire doctype -> the platform's document category.
const DOCTYPE_CATEGORY: Record<string, DocCategory> = {
  "70": "competency",
  "71": "endorsement",
  "72": "competency",
  "73": "endorsement",
  "74": "qualification",
};

/**
 * The `doc` form value from the dispatcher-normalized code. genericNormalize
 * strips the printed "NNNNN/YYYY" slash (and every separator), so a code whose
 * trailing four digits equal the ISSUE year is restored to the printed slash
 * form ("123452024" + 2024 → "12345/2024" — on these documents the number's
 * year suffix IS the issue year) — but ONLY in the unambiguous >= 9 digit
 * band. A bare 5-8 digit code that happens to END with the issue year
 * ("12024" issued 2024) could be EITHER "1/2024" or the literal five-digit
 * number; regex backtracking must never pick for the user (review hardening
 * 2026-08-13 — the old \d{1,8} form silently queried "1/2024" and could turn
 * a real document into a false definitive no-match). That band passes through
 * unchanged, and the miss side is downgraded (uaMaradAmbiguousCode →
 * parseUAMARAD). A code that still carries its "/" (direct callers, stored
 * recheck inputs) is passed through with spaces stripped; anything else goes
 * as-is — soft handling, never a block (UA_MARAD_CODE_PATTERN is advisory
 * only).
 */
export function uaMaradDocParam(code: string, issueYear: string): string {
  const c = (code ?? "").replace(/\s+/g, "");
  if (!c) return "";
  if (c.includes("/")) return c;
  const m = /^(\d{5,8})(\d{4})$/.exec(c);
  if (m && m[2] === issueYear) return `${m[1]}/${m[2]}`;
  return c;
}

/**
 * TRUE when the searched code sits in the ambiguous normalization band: a
 * bare (slash-less) 5-8 digit number ENDING with the 4-digit issue year. The
 * lookup then queried the literal digits, but the printed document could have
 * been "N/YYYY" — so a 2023+ miss on such a code is honest only as
 * indeterminate, never as a definitive no-match.
 */
export function uaMaradAmbiguousCode(code: string, issueYear: string): boolean {
  const c = (code ?? "").replace(/\s+/g, "");
  if (c.includes("/") || !/^\d{4}$/.test(issueYear)) return false;
  return /^\d{5,8}$/.test(c) && c.endsWith(issueYear);
}

/** ISO "YYYY-MM-DD" (the date-input format) → the form's non-padded selects. */
function dateParts(issuedOn: string): { day: string; month: string; year: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((issuedOn ?? "").trim());
  if (!m) return null;
  return { year: m[1], month: String(Number(m[2])), day: String(Number(m[3])) };
}

/**
 * The exact urlencoded body a lookup posts — exported so the doctype/date
 * wiring is unit-testable without a wire (dossier field names verbatim).
 */
export function buildUAMARADForm(
  doctype: string,
  code: string,
  issuedOn: string
): URLSearchParams | null {
  const d = dateParts(issuedOn);
  if (!d) return null;
  return new URLSearchParams({
    qualification_doctype: doctype,
    doc: uaMaradDocParam(code, d.year),
    qualification_gmzlb_date_day: d.day,
    qualification_gmzlb_date_month: d.month,
    qualification_gmzlb_date_year: d.year,
    submit: "Зробити запит",
  });
}

// A hit's evidence .pdf must live on the registry's own domain — the portal
// host itself or a *.marad.gov.ua sibling. A foreign-host link is NEVER
// evidence (review hardening 2026-08-13).
function uaMaradHostOk(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "vrf.marad.gov.ua" || h === "marad.gov.ua" || h.endsWith(".marad.gov.ua");
}

// A hit's download links are RESULT links. The REAL hit page (captured
// 2026-08-24) titles them "Підтвердження кваліфікації моряка українською";
// the portal's rules page speaks of "verification results" and the result
// heading is "Результат пошуку". The anchor must SAY one of these (text or
// title), in either language; a stray manual/regulation link or the
// "Запит на верифікацію" request anchor never reads as a hit.
const RESULT_LINK_RE = /результат|підтвердження кваліфікації|verification result/i;

// The two accepted evidence-href shapes:
//   (1) the REAL portal shape (2026-08-24 capture): a per-request hash link
//       /services/documents/pdf/hash/<20+ chars of [A-Za-z0-9_-]> — no ".pdf"
//       suffix. The distractor /services/documents/add/collection/… never
//       matches this;
//   (2) the legacy ".pdf"-suffixed shape (synthetic fixture + any portal
//       variant), kept for back-compat.
const HASH_HREF_RE = /href\s*=\s*["']([^"']*\/services\/documents\/pdf\/hash\/[A-Za-z0-9_-]{20,})["']/i;
const LEGACY_PDF_HREF_RE = /href\s*=\s*["']([^"']*\.pdf(?:\?[^"']*)?)["']/i;

/**
 * Evidence result hrefs in the (comment/script-stripped) page. Guarded three
 * ways (review hardening 2026-08-13; href shapes re-keyed to the REAL captured
 * hit page 2026-08-24 — the old `.pdf`-only scan returned indeterminate on a
 * genuine hit):
 *   (a) anchor-scoped — only `<a>` elements are read, never bare attributes;
 *   (b) href shape — the portal's hash-link form or the legacy `.pdf` suffix;
 *   (c) result-context — anchor text or title must match RESULT_LINK_RE;
 *   (d) same-host — the resolved URL must stay on (vrf.)marad.gov.ua.
 */
export function uaMaradPdfHrefs(html: string): string[] {
  const out: string[] = [];
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(html)) !== null) {
    const anchor = a[0];
    const href = HASH_HREF_RE.exec(anchor)?.[1] ?? LEGACY_PDF_HREF_RE.exec(anchor)?.[1];
    if (!href) continue;
    const title = /title\s*=\s*["']([^"']*)["']/i.exec(anchor)?.[1] ?? "";
    const text = anchor.replace(/<[^>]+>/g, " ");
    if (!RESULT_LINK_RE.test(text) && !RESULT_LINK_RE.test(title)) continue;
    try {
      const url = new URL(href, `${DEFAULT_BASE}${FORM_PATH}`);
      if (!uaMaradHostOk(url.hostname)) continue;
      out.push(url.toString());
    } catch {
      /* an unparsable href is not evidence */
    }
  }
  return out;
}

// PURE response→outcome mapping. `issuedOn` (ISO date) feeds the date-gated
// miss semantics — the caller validated it before any fetch.
export function parseUAMARAD(raw: string | object, code: string, issuedOn: string): AdapterOutcome {
  const html0 = typeof raw === "string" ? raw : "";
  if (!html0.trim()) return { kind: "indeterminate", reason: "empty-response" };
  // Strip comments + scripts so annotations/embedded JS never read as content;
  // tags are then flattened for the text-level miss-marker scan.
  const html = html0
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  if (MISS_RE.test(text)) {
    const yearStr = (dateParts(issuedOn) ?? { year: "" }).year;
    const year = Number(yearStr);
    if (Number.isFinite(year) && year >= QUICK_INDEX_FROM_YEAR) {
      // Ambiguous-band code (5-8 bare digits ending in the issue year): the
      // posted `doc` may not be the printed number — a definitive no-match
      // would be dishonest (review hardening 2026-08-13).
      if (uaMaradAmbiguousCode(code, yearStr)) {
        return { kind: "indeterminate", reason: "ambiguous-number-normalization" };
      }
      return { kind: "no-match" }; // 2023+ issuance: the quick index IS authoritative
    }
    return {
      kind: "indeterminate",
      reason: "not-in-quick-index (pre-2023 issuance — the miss is inconclusive)",
    };
  }

  const pdfs = uaMaradPdfHrefs(html);
  if (pdfs.length > 0) {
    return { kind: "match-valid", cert: uaMaradCert(code, pdfs[0]) };
  }

  return { kind: "indeterminate", reason: "unrecognized-response" };
}

function uaMaradCert(code: string, evidencePdfUrl: string, doctype?: string): VerifiedCert {
  const label = doctype ? uaMaradDoctypes().get(doctype) : undefined;
  return {
    ok: true,
    code,
    docCategory: (doctype && DOCTYPE_CATEGORY[doctype]) || "competency",
    // The result page carries no structured holder fields (confirmed against
    // the real 2026-08-24 capture — only the download anchors; the PII lives
    // in the linked result PDFs) — name-less, so §2.5 rule 4 keeps it from
    // ever naming a profile: bindHolder downgrades it to a teal
    // registry-confirmed doc.
    hasName: false,
    fullName: "",
    firstName: "",
    lastName: "",
    title: label ?? "Ukrainian seafarer qualification document",
    personalCode: "",
    birthDate: "",
    status: "valid",
    isValid: true,
    issuedOn: "",
    validUntil: "",
    certificateType: label ?? "Seafarer qualification document",
    issuerCountry: "Ukraine",
    institution: "Maritime Administration of Ukraine",
    documentType: label ?? "",
    // The captured .pdf link IS the evidence (the portal's downloadable
    // bilingual verification result).
    sourceUrl: evidencePdfUrl || `${DEFAULT_BASE}${FORM_PATH}`,
    photoUrl: undefined,
    registryCountry: "UA-MARAD",
    keyTrust: "public-identifier", // number + issue date are printed on the document (§2.5)
    verifiedSource: "government", // the flag state — unlike TCCS
  };
}

/**
 * v2-A result-PDF date extraction: fetch the hit's evidence PDF IMMEDIATELY
 * (the hash tokens are per-request/ephemeral — a later fetch gets nothing)
 * with the SAME session cookies, and lift the printed dates out of its text
 * layer. Returns null on ANY failure — fetch, status, size, parse — so the
 * registry hit itself always stands exactly as before; the failure is one
 * PII-free log line, never a thrown error and never a changed verdict.
 *
 * The fetch URL: in production the evidence URL IS the portal URL; under the
 * mock seam (REGISTRY_MOCK=1) the href was resolved against the real portal
 * for display, so the path is re-based onto the mock origin.
 */
async function fetchUAMARADResultDates(
  evidenceUrl: string,
  cookie: string
): Promise<UAMARADResultPdfParse | null> {
  try {
    const b = base();
    const url = b === DEFAULT_BASE ? evidenceUrl : `${b}${new URL(evidenceUrl).pathname}`;
    const res = await fetchWithGuard(
      url,
      {
        headers: {
          Accept: "application/pdf",
          "User-Agent": UA_MARAD_USER_AGENT,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      { binary: true }
    );
    if (res.status !== 200 || !res.bodyBytes || res.bodyBytes.length === 0) {
      console.warn(`[registry] UA-MARAD result-PDF fetch: http-${res.status}, dates skipped`);
      return null;
    }
    return parseUAMARADResultPdf(res.bodyBytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[registry] UA-MARAD result-PDF fetch failed (${msg}), dates skipped`);
    return null;
  }
}

// Adapter verify (auto). Inputs: `code` (document number — pasted) +
// `issuedOn` (issue date, prompted) + `doctype` (prompted select, wire codes).
// ONE honest lookup = the same two requests a browser makes: the form GET that
// mints the PHPSESSID/__cf_bm cookies + one POST riding them. A hit adds ONE
// more same-session request: the ephemeral result-PDF, fetched immediately
// for its validity dates (v2-A).
export async function verifyUAMARAD(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = (inputs.code ?? "").trim();
  const issuedOn = (inputs.issuedOn ?? "").trim();
  const doctype = (inputs.doctype ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!issuedOn) return { kind: "indeterminate", reason: "missing-input:issuedOn" };
  if (!doctype) return { kind: "indeterminate", reason: "missing-input:doctype" };
  // Only the five dossier-approved doctypes are ever wired (never 76/849).
  if (!uaMaradDoctypes().has(doctype)) {
    return { kind: "indeterminate", reason: `unsupported-doctype:${doctype}` };
  }
  const body = buildUAMARADForm(doctype, code, issuedOn);
  if (!body) return { kind: "indeterminate", reason: "invalid-input:issuedOn" };

  let res;
  let cookie = "";
  try {
    // 1. Session GET (PHPSESSID + Cloudflare __cf_bm).
    const form = await fetchWithGuard(`${base()}${FORM_PATH}`, {
      headers: { Accept: "text/html", "User-Agent": UA_MARAD_USER_AGENT },
    });
    if (form.status !== 200) return { kind: "indeterminate", reason: `http-${form.status}` };
    cookie = form.setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");

    // 2. ONE submission, exactly like the served quick-search form.
    res = await fetchWithGuard(`${base()}${FORM_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": UA_MARAD_USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body.toString(),
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  const outcome = parseUAMARAD(res.bodyText, code, issuedOn);
  // Stamp the doctype-derived category/title onto a hit (parse alone cannot
  // know which of the five types was searched).
  if (outcome.kind === "match-valid") {
    const cert = uaMaradCert(code, outcome.cert.sourceUrl, doctype);
    // v2-A: lift the printed dates from the linked result PDF (same session,
    // fetched now — the token dies with it). The first evidence href is the
    // EN result; the parser reads both the EN and Ukrainian layouts anyway.
    // Failure leaves the dates empty — the hit itself NEVER depends on this.
    const dates = await fetchUAMARADResultDates(outcome.cert.sourceUrl, cookie);
    if (dates?.validUntil) cert.validUntil = dates.validUntil;
    // The PDF's own "date of issue" wins; the searched-with input (already
    // registry-confirmed by the hit) is the honest fallback.
    cert.issuedOn = dates?.issuedOn ?? issuedOn;
    return { kind: "match-valid", cert };
  }
  return outcome;
}
