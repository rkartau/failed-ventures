// Croatia — COCV, Ministarstvo mora, prometa i infrastrukture (plan §3 Wave 2).
//
// Wire format CONFIRMED live 2026-07-20 (dossier croatia.md) — Oracle APEX 24.2,
// SESSION-STATEFUL (always under the /ords/ prefix; without it the host serves
// a maintenance page):
//
//   1. GET  /ords/f?p=300:10:0:::10::            -> 302 into a fresh session
//      (Set-Cookie) -> GET the redirected form URL -> page-10 search form with
//      the APEX plumbing as hidden inputs (p_flow_id=300, p_flow_step_id=10,
//      p_instance=<session>, p_page_submission_id, p_request, pSalt,
//      pPageItemsProtected, …) which MUST be replayed verbatim.
//   2. POST /ords/wwv_flow.accept?p_context=300:10:<session> — form-urlencoded:
//      the hidden plumbing + P10_IME (first name) + P10_PREZIME (surname) +
//      P10_BROJ (serial). All three are REQUIRED and are prompted as SEPARATE
//      fields — a stored fullName is never auto-split (§3).
//   3. 302 back to f?p=300:10:<session>::::: which renders the result region:
//      miss  -> <div id="no_data">Nema podataka.</div> (REAL fixture
//               hr-nomatch.html) → `no-match`
//      match -> an APEX report region with certificate rows (NOT observed live —
//               hr-valid.html is SYNTHETIC; parseHR requires the Ime/Prezime
//               report headers AND the echoed serial, else indeterminate).
//
// R10 POLICY (no bot-detection evasion, ever): this adapter performs EXACTLY
// ONE honest lookup per user action — a plain form GET, one POST replaying the
// hidden fields the server itself handed us (what any browser form submission
// does), one redirect follow — under a plain descriptive User-Agent. There is
// NO CAPTCHA solving, NO fingerprint mimicry, NO input-event simulation and NO
// retry loop. The dossier notes APEX's "suspicious activity" guard (ORA-20999)
// fired on event-less in-page JS submission; a server-side replay of the
// served form is a different, honest path — but if the LIVE portal turns out to
// reject it too, the ORA-20999 answer maps to `indeterminate` (never a verdict)
// and Croatia auto-demotes to "assisted" via a one-line countries.ts flip.
//
// >>> THE TRIPWIRE FIRED — DEMOTED TO "assisted" 2026-08-12 (countries.ts). <<<
// Live probe from the production box: the portal (upgraded to APEX 24.2.10)
// now guards the search with Google reCAPTCHA v3 — grecaptcha.execute() fills
// a P10_TOKEN page item on load, P10_SCORE is a server-protected item
// (pPageItemsProtected), and an AI_CAPTCHA_MISSING dynamic action handles the
// token's absence server-side. An honest replay (fresh session, correct
// plumbing, the button's real request name SEARCH_1, empty token) answers
// "ORA-20999: Došlo je do nepredviđene greške." — the search never executes
// without a captcha token, which we will never fabricate. Markup drift found
// by the same probe, RELEVANT ONLY IF the captcha gate ever goes away and this
// adapter is re-flipped: (a) pSalt/pContext hidden inputs no longer carry a
// name attribute (extractApexForm's required-plumbing check would need
// relaxing), (b) hidden-input values are HTML-entity-encoded
// (p_page_submission_id contains &#x2F;), (c) the served p_request is EMPTY —
// the submit button injects request:'SEARCH_1' client-side, so a verbatim
// hidden-field replay never runs the search. This file stays DORMANT (the
// dispatcher answers assist for "assisted" countries before any adapter
// lookup); it is kept for that future re-flip.

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard, type GuardedResponse } from "../index";
import { REGISTRY_USER_AGENT } from "./fr";

const DEFAULT_BASE = "https://cocv.pomorstvo.hr";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_HR
  ) {
    return process.env.REGISTRY_BASE_HR;
  }
  return DEFAULT_BASE;
}

// ---- Pure pieces (fixture-tested) ----------------------------------------

export type ApexForm = { action: string; fields: Record<string, string> };

// Extract the APEX form action + every hidden input from the page-10 form HTML.
// Returns null when the required plumbing is missing (drift → indeterminate).
export function extractApexForm(html: string): ApexForm | null {
  const actionMatch = /<form[^>]*\baction="([^"]*wwv_flow\.accept[^"]*)"[^>]*>/i.exec(html);
  if (!actionMatch) return null;
  const fields: Record<string, string> = {};
  const re = /<input[^>]*\btype="hidden"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = (/\bname="([^"]*)"/i.exec(tag) ?? [])[1];
    const value = (/\bvalue="([^"]*)"/i.exec(tag) ?? [])[1] ?? "";
    if (name) fields[name] = value;
  }
  for (const required of ["p_flow_id", "p_flow_step_id", "p_instance", "pSalt"]) {
    if (!(required in fields)) return null;
  }
  return { action: actionMatch[1], fields };
}

// Croatian dd.mm.yyyy (or ISO yyyy-mm-dd) -> ISO instant at UTC midnight.
function hrIsoDate(value: string): string {
  const v = tidy(value);
  let m = /^(\d{2})\.(\d{2})\.(\d{4})\.?$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T00:00:00+00:00`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${v}T00:00:00+00:00`;
  return "";
}

const strip = (s: string) => tidy(s.replace(/<[^>]+>/g, ""));

// PURE response→outcome mapping (§2.2). `raw` is the final result-page HTML;
// `code` is the searched serial (echo guard against markup drift).
export function parseHR(raw: string | object, code: string): AdapterOutcome {
  // Strip HTML comments first — annotations (incl. in recorded fixtures) must
  // never be mistaken for page content.
  const html = (typeof raw === "string" ? raw : "").replace(/<!--[\s\S]*?-->/g, "");
  if (!html.trim()) return { kind: "indeterminate", reason: "empty-response" };

  // APEX anti-automation / session-state guard: an input/session error, NEVER a
  // verdict (§3.1). R10 watch item — if the live portal answers this to honest
  // replays, demote HR to "assisted" in countries.ts (one-line flip).
  if (/ORA-20999/i.test(html)) {
    return {
      kind: "indeterminate",
      reason: "ora-20999 (APEX suspicious-activity guard — if persistent on honest lookups, demote HR to 'assisted', policy R10)",
    };
  }

  // Definitive miss (REAL fixture): the no_data region.
  if (/id="no_data"/i.test(html) || /Nema\s+podataka\./i.test(html)) {
    return { kind: "no-match" };
  }

  // High-confidence match: an APEX report table whose headers include Ime AND
  // Prezime, with at least one data row. Anything else is markup drift.
  const tableMatch = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return { kind: "indeterminate", reason: "unrecognized-response" };
  const table = tableMatch[1];
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((h) =>
    strip(h[1]).toLowerCase()
  );
  if (!headers.some((h) => h === "ime") || !headers.some((h) => h === "prezime")) {
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }
  const rowMatch = /<tbody[^>]*>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(table);
  if (!rowMatch) return { kind: "indeterminate", reason: "unrecognized-response" };
  const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]));
  const col = (name: RegExp): string => {
    const i = headers.findIndex((h) => name.test(h));
    return i >= 0 && i < cells.length ? cells[i] : "";
  };

  const firstName = col(/^ime$/);
  const lastName = col(/^prezime$/);
  const serial = col(/broj/);
  const title = col(/svjedod/);
  const validUntil = hrIsoDate(col(/vrijedi/));

  // Serial echo guard: a report that does not echo the searched serial is not a
  // trustworthy answer for THIS lookup.
  if (serial && serial.replace(/\s+/g, "") !== code.replace(/\s+/g, "")) {
    return { kind: "indeterminate", reason: "serial-mismatch" };
  }

  const fullName = tidy(`${firstName} ${lastName}`);
  const isValid = validUntil ? Date.parse(validUntil) > Date.now() : true;
  const cert: VerifiedCert = {
    ok: true,
    code,
    docCategory: "competency",
    hasName: fullName.length > 0,
    fullName,
    firstName,
    lastName,
    title: title || "Croatian certificate of competency",
    personalCode: "",
    birthDate: "",
    status: isValid ? "valid" : "expired",
    isValid,
    issuedOn: "",
    validUntil,
    certificateType: title || "Certificate of competency",
    issuerCountry: "Croatia",
    institution: "",
    documentType: "",
    sourceUrl: `${DEFAULT_BASE}/`,
    photoUrl: undefined,
    registryCountry: "HR",
    keyTrust: "public-identifier", // name + serial are printed on the cert (§2.5)
    verifiedSource: "government",
  };
  return { kind: "match-valid", cert };
}

// ---- Session round-trip helpers ------------------------------------------

type Jar = { cookies: string[] };

function collectCookies(jar: Jar, res: GuardedResponse): void {
  for (const c of res.setCookies) {
    const pair = c.split(";")[0].trim();
    if (!pair) continue;
    const name = pair.split("=")[0];
    // Replace an existing cookie of the same name (fresh session wins).
    jar.cookies = jar.cookies.filter((p) => p.split("=")[0] !== name);
    jar.cookies.push(pair);
  }
}

function jarHeader(jar: Jar): Record<string, string> {
  return jar.cookies.length > 0 ? { Cookie: jar.cookies.join("; ") } : {};
}

// GET with manual redirect-following (max `hops`), staying strictly on the
// pinned host, collecting cookies at every hop. Returns the final 200 body.
async function followGet(url: string, jar: Jar, hops = 4): Promise<GuardedResponse> {
  const origin = new URL(base()).host;
  let current = url;
  for (let i = 0; i < hops; i++) {
    const res = await fetchWithGuard(current, {
      redirect: "manual",
      headers: { Accept: "text/html", "User-Agent": REGISTRY_USER_AGENT, ...jarHeader(jar) },
    });
    collectCookies(jar, res);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = new URL(res.location, current);
      if (next.host !== origin) throw new Error("redirect left the pinned registry host");
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new Error("redirect loop");
}

// Adapter verify (auto). Inputs: `code` (serial / P10_BROJ — pasted) +
// `firstName` (P10_IME) + `lastName` (P10_PREZIME) — BOTH prompted as separate
// fields, never auto-split from a stored full name (§3). ONE honest lookup:
// form GET → single POST replay → result render.
export async function verifyHR(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = (inputs.code ?? "").trim();
  const firstName = (inputs.firstName ?? "").trim();
  const lastName = (inputs.lastName ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!firstName || !lastName) {
    return { kind: "indeterminate", reason: "missing-input:firstName,lastName" };
  }

  const jar: Jar = { cookies: [] };
  try {
    // 1. The page-10 search form (fresh session via the initial redirect).
    const formRes = await followGet(`${base()}/ords/f?p=300:10:0:::10::`, jar);
    if (formRes.status !== 200) return { kind: "indeterminate", reason: `http-${formRes.status}` };
    const form = extractApexForm(formRes.bodyText);
    if (!form) return { kind: "indeterminate", reason: "unrecognized-form" };

    // 2. ONE submission: replay the served hidden plumbing + the three items.
    const body = new URLSearchParams({
      ...form.fields,
      P10_IME: firstName,
      P10_PREZIME: lastName,
      P10_BROJ: code,
    }).toString();
    // The form action is relative to /ords/ ("wwv_flow.accept?p_context=…").
    const actionUrl = new URL(form.action, `${base()}/ords/`);
    if (actionUrl.host !== new URL(base()).host) {
      return { kind: "indeterminate", reason: "unrecognized-form" };
    }
    const postRes = await fetchWithGuard(actionUrl.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": REGISTRY_USER_AGENT,
        ...jarHeader(jar),
      },
      body,
    });
    collectCookies(jar, postRes);

    // 3. The result render: APEX 302s back to f?p=300:10:<session>.
    if (postRes.status >= 300 && postRes.status < 400 && postRes.location) {
      const next = new URL(postRes.location, actionUrl);
      if (next.host !== new URL(base()).host) {
        return { kind: "indeterminate", reason: "unrecognized-response" };
      }
      const resultRes = await followGet(next.toString(), jar);
      if (resultRes.status !== 200) {
        return { kind: "indeterminate", reason: `http-${resultRes.status}` };
      }
      return parseHR(resultRes.bodyText, code);
    }
    // Some APEX error paths render inline on the POST (e.g. ORA-20999).
    if (postRes.status === 200) return parseHR(postRes.bodyText, code);
    return { kind: "indeterminate", reason: `http-${postRes.status}` };
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }
}
