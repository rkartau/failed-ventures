// France — Direction des affaires maritimes / DGAMPA "Promete" (plan §3 Wave 2).
//
// Wire format CONFIRMED live 2026-07-20 (dossier france.md), RE-PROBED
// 2026-08-12: plain server-rendered Bootstrap-3 HTML app, no CAPTCHA, no CSRF,
// no login — but (drift, Promete v1.6.7) the app is now SESSION-STATEFUL:
//
//   1. GET  /promete/ConsulterTitreOuVisa?language=en
//        -> 200 search form + Set-Cookie JSESSIONID (also pins the session
//           language to English so the miss wording is deterministic)
//   2. POST /promete/ConsulterTitreOuVisa  (application/x-www-form-urlencoded,
//           Cookie: JSESSIONID=…)
//        numeroTitre=<cert no>&numeroVersion=<optional>&numeroAdm=<mariner no>
//        -> full HTML page rendered into #contenu
//
// A cookie-less cold POST (the pre-2026-08 flow) now renders the "Promete :
// Erreur technique" page (REAL fixture fr-technical-error.html) → mapped to
// indeterminate, never a verdict.
//
// Miss semantics (§3.1, REAL fixture fr-nomatch.html, re-confirmed live
// 2026-08-12): an alert-warning with "No result correponds to your research."
// (the typo is genuinely the site's — language follows the session, so the
// French "aucun titre/résultat" wording is matched too) → `no-match`.
//
// The MATCH page was NOT observed live (no valid sample number is public), so
// the valid/invalid fixtures are SYNTHETIC and parseFR only answers on
// high-confidence markers: a label/value table carrying holder/title rows plus
// an EXPLICIT Statut verdict ("Valide" / "Non valide"). Anything else →
// indeterminate, never a verdict (plan R2).

import { tidy, type VerifiedCert } from "@/lib/cert";
import type { AdapterOutcome } from "../types";
import { fetchWithGuard } from "../index";

const DEFAULT_BASE = "https://promete.din.developpement-durable.gouv.fr";

// Plain descriptive User-Agent (policy R10) — one honest lookup per user action.
export const REGISTRY_USER_AGENT = "docka.me registry verifier (+https://docka.me)";

// Mock-registry e2e seam (plan §6.2): pinned constant, overridable ONLY outside
// production AND with REGISTRY_MOCK=1 — never redirectable on the Hetzner box.
function base(): string {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.REGISTRY_MOCK === "1" &&
    process.env.REGISTRY_BASE_FR
  ) {
    return process.env.REGISTRY_BASE_FR;
  }
  return DEFAULT_BASE;
}

// The documented miss wording, both session languages. "correponds" is the
// site's genuine typo (dossier-confirmed) — `corres?ponds` matches BOTH the
// typo and a future corrected spelling.
const NO_RESULT =
  /(no\s+result\s+corres?ponds\s+to\s+your\s+research|aucun\s+(?:titre|r[ée]sultat))/i;

// Extract <th>label</th><td>value</td> pairs (Bootstrap 3 detail table) plus
// dt/dd pairs into a lowercased key -> value map.
function labelRows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const strip = (s: string) => tidy(s.replace(/<[^>]+>/g, ""));
  const thTd = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  const dtDd = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  for (const re of [thTd, dtDd]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const key = strip(m[1]).toLowerCase();
      if (key) out[key] = strip(m[2]);
    }
  }
  return out;
}

// French dd/mm/yyyy (or an already-ISO yyyy-mm-dd) -> ISO instant at UTC
// midnight. String rearrangement only — no Date()/timezone math (§3 rule).
export function frIsoDate(value: string): string {
  const v = tidy(value);
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T00:00:00+00:00`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${v}T00:00:00+00:00`;
  return "";
}

// PURE response→outcome mapping (§2.2). `raw` is the ConsulterTitreOuVisa HTML.
export function parseFR(raw: string | object, code: string): AdapterOutcome {
  // Strip HTML comments first — annotations (incl. in recorded fixtures) must
  // never be mistaken for page content.
  const html = (typeof raw === "string" ? raw : "").replace(/<!--[\s\S]*?-->/g, "");
  if (!html.trim()) return { kind: "indeterminate", reason: "empty-response" };

  // Definitive miss (REAL fixture): the alert-warning no-result page.
  if (NO_RESULT.test(html)) return { kind: "no-match" };

  // "Promete : Erreur technique" (REAL fixture, 2026-08-12): the app's own
  // technical-error page — e.g. a session-less POST. An app error, NEVER a
  // verdict (§3.1).
  if (/erreur\s+technique/i.test(html)) {
    return { kind: "indeterminate", reason: "promete-technical-error" };
  }

  const rows = labelRows(html);
  const statut = (rows["statut"] ?? rows["status"] ?? "").toLowerCase();
  const lastName = rows["nom"] ?? "";
  const firstName = rows["prénom"] ?? rows["prenom"] ?? "";
  const fullName =
    tidy(`${firstName} ${lastName}`) || tidy(rows["titulaire"] ?? rows["holder"] ?? "");
  const title =
    rows["libellé du titre"] ?? rows["libelle du titre"] ?? rows["titre"] ?? rows["title"] ?? "";
  const validUntil = frIsoDate(
    rows["date de fin de validité"] ?? rows["date de fin de validite"] ?? rows["valid until"] ?? ""
  );
  const issuedOn = frIsoDate(
    rows["date de début de validité"] ?? rows["date de debut de validite"] ?? rows["valid from"] ?? ""
  );

  // EXPLICIT verdict only — "non valide" is checked before "valide" (substring).
  const invalid = /\b(non\s+valide|invalide|not\s+valid|expir[ée]|suspendu|retir[ée]|revoked)\b/i.test(
    statut
  );
  const valid = !invalid && /\b(valide|valid)\b/i.test(statut);

  // High-confidence match markers: a detail table echoing holder or title.
  const looksLikeMatch = Object.keys(rows).length > 0 && (fullName || title);
  if (!looksLikeMatch || (!valid && !invalid)) {
    return { kind: "indeterminate", reason: "unrecognized-response" };
  }

  const cert: VerifiedCert = {
    ok: true,
    code,
    docCategory: "competency",
    hasName: fullName.length > 0,
    fullName,
    firstName: fullName ? tidy(firstName) : "",
    lastName: fullName ? tidy(lastName) : "",
    title: title || "French maritime certificate",
    personalCode: "",
    birthDate: "", // never echoed by the portal — never store lookup identity here
    status: valid ? "valid" : "invalid",
    isValid: valid,
    issuedOn,
    validUntil,
    certificateType: title || "Certificate of competency",
    issuerCountry: "France",
    institution: "",
    documentType: "",
    sourceUrl: `${DEFAULT_BASE}/promete/authentifierTitreOuVisa`,
    photoUrl: undefined,
    registryCountry: "FR",
    keyTrust: "public-identifier", // numeroTitre + numeroAdm are printed on the document (§2.5)
    verifiedSource: "government",
  };
  return valid ? { kind: "match-valid", cert } : { kind: "match-invalid", cert };
}

// Adapter verify (auto). Inputs: `code` (numeroTitre — the pasted cert number),
// `numeroAdm` (required, prompted), `numeroVersion` (OPTIONAL — printed only on
// certs whose number exceeds 10,000,000; the portal answers honestly without it).
// ONE honest lookup = the same two requests a browser makes: the form GET that
// mints the JSESSIONID (and pins the session language) + one POST with it.
export async function verifyFR(inputs: Record<string, string>): Promise<AdapterOutcome> {
  const code = inputs.code ?? "";
  const numeroAdm = (inputs.numeroAdm ?? "").trim();
  const numeroVersion = (inputs.numeroVersion ?? "").trim();
  if (!code) return { kind: "no-match" };
  if (!numeroAdm) return { kind: "indeterminate", reason: "missing-input:numeroAdm" };

  let res;
  try {
    // 1. Session GET (2026-08-12 drift: a cookie-less POST answers the
    //    technical-error page). English pins the deterministic miss wording.
    const form = await fetchWithGuard(`${base()}/promete/ConsulterTitreOuVisa?language=en`, {
      headers: { Accept: "text/html", "User-Agent": REGISTRY_USER_AGENT },
    });
    if (form.status !== 200) return { kind: "indeterminate", reason: `http-${form.status}` };
    const cookie = form.setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");

    // 2. The lookup POST, riding the session cookie.
    const body = new URLSearchParams({
      numeroTitre: code,
      numeroVersion,
      numeroAdm,
    }).toString();
    res = await fetchWithGuard(`${base()}/promete/ConsulterTitreOuVisa`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": REGISTRY_USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
    });
  } catch {
    return { kind: "indeterminate", reason: "network" };
  }

  if (res.status !== 200) return { kind: "indeterminate", reason: `http-${res.status}` };
  return parseFR(res.bodyText, code);
}
