// SEA / employment-contract generation (#45) — client-safe. Renders a DRAFT, UNSIGNED
// Seafarer's Employment Agreement (MLC A2.1) filled with the seaman's VERIFIED profile
// + assignment + the real employment TERMS the agency issued, via the SHARED CV print
// engine (lib/print-html.ts) — NO PDF lib, NO new npm dep.
//
// Correctness rules baked in:
//   - Item 1: an unknown term renders as an explicit BLANK underline, NEVER a fabricated
//     figure.
//   - Item 2: a diagonal DRAFT watermark + explicit UNSIGNED both-party signature/date
//     blocks + a provenance line.
//   - Item 3: NO silent `verifiedName || name` fill — an unverified identity gets a red
//     banner and every identity value is bracketed `[unverified: …]`.

import { esc, printPage } from "@/lib/print-html";
import type { Seafarer, Assignment, ContractTerms } from "@/lib/db";

export type ContractKind = "sea" | "contract";

export type ContractModel = {
  kind: ContractKind;
  /** Government-verified identity? Drives the red banner + bracketing (item 3). */
  identityVerified: boolean;
  /** Verified name when verified; the TYPED name when not (never silently merged). */
  seamanName: string;
  personalCode: string | null;
  birthDate: string | null;
  issuerCountry: string | null;
  rank: string | null;
  vessel: string | null;
  /** Assignment sign-on (sentToSeaAt) as an ISO date, when known. */
  voyageFrom: string | null;
  /** Issuing agency org name. */
  agencyOrg: string;
  terms: ContractTerms;
  /** ISO instant of generation (provenance). */
  generatedAt: string;
};

/** "2026-01-02T…" -> "02 Jan 2026" (UTC, stable). "" for empty/invalid. */
function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Build the contract model from a seafarer + assignment + issued terms + agency. The
 * verified-first discipline of buildCvModel, but WITHOUT its fallback: when the identity
 * is not government-verified the TYPED name is used as-is (and the renderer brackets it).
 */
export function buildContractModel(input: {
  seafarer: Seafarer;
  assignment: Assignment | null;
  terms: ContractTerms;
  agencyOrg: string;
  kind?: ContractKind;
  generatedAt?: string;
}): ContractModel {
  const s = input.seafarer;
  const identityVerified = s.identityVerified === true;
  // Item 3 — NO silent verifiedName||name merge. Verified => the verified name only;
  // unverified => the typed name only (the renderer marks it unverified).
  const seamanName = (identityVerified ? s.verifiedName ?? "" : s.name ?? "").trim();
  return {
    kind: input.kind ?? "sea",
    identityVerified,
    seamanName,
    personalCode: identityVerified ? s.personalCode ?? null : null,
    birthDate: identityVerified ? s.birthDate ?? null : null,
    issuerCountry: identityVerified ? s.issuerCountry ?? null : null,
    rank: s.rank || null,
    vessel: input.assignment?.vessel ?? s.vessel ?? null,
    voyageFrom: input.assignment?.sentToSeaAt ?? null,
    agencyOrg: input.agencyOrg,
    terms: input.terms,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

// Contract-specific CSS (passed as extraCss; the shared base + @media print come from
// printPage). Kept separate from the CV's extraCss so neither can drift the other.
const CONTRACT_EXTRA_CSS = `  .doc-title { font-size:20px; font-weight:800; margin:4px 0 2px; }
  .subtitle { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .unverified { background:#fef2f2; color:#b91c1c; border:1px solid #fca5a5; border-radius:8px; padding:10px 12px; font-size:12px; font-weight:700; margin:12px 0; }
  .verified-strip { display:flex; align-items:center; gap:8px; background:#ecfdf5; color:#047857; border:1px solid #6ee7b7; border-radius:8px; padding:8px 12px; font-size:12px; font-weight:700; margin:12px 0; }
  .verified-strip svg { flex:0 0 auto; }
  .terms-unverified-note { background:#fffbeb; color:#b45309; border:1px solid #fcd34d; border-radius:8px; padding:8px 12px; font-size:11px; font-weight:600; margin:8px 0 0; }
  .terms.unverified-terms td { color:#b45309; }
  .terms td:first-child { width:38%; color:var(--muted); font-weight:600; }
  .blank { display:inline-block; min-width:120px; border-bottom:1px solid #94a3b8; color:#94a3b8; }
  .sig-grid { display:flex; gap:24px; margin-top:28px; }
  .sig { flex:1; }
  .sig .line { margin-top:34px; border-top:1px solid var(--ink); padding-top:4px; font-size:11px; color:var(--muted); }
  .provenance { margin-top:22px; padding-top:12px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
`;

/** value when present, else an explicit BLANK underline — NEVER a fabricated figure. */
function orBlank(value: string | null | undefined): string {
  return value && String(value).trim() ? esc(value) : `<span class="blank">&nbsp;</span>`;
}

/** Compose the wage line from amount + currency + period; blank when the amount is unset. */
function wageLine(t: ContractTerms): string {
  if (!t.wageAmount || !t.wageAmount.trim()) return `<span class="blank">&nbsp;</span>`;
  const cur = t.wageCurrency ? `${esc(t.wageCurrency)} ` : "";
  const per = t.wagePeriod ? ` per ${esc(t.wagePeriod)}` : "";
  return `${cur}${esc(t.wageAmount)}${per}`;
}

/** Render a full standalone printable DRAFT SEA. */
export function renderContractHtml(model: ContractModel): string {
  const t = model.terms;
  const nameCell = model.identityVerified
    ? esc(model.seamanName || "Seafarer")
    : `[unverified: ${esc(model.seamanName || "typed name not provided")}]`;
  const idLine = model.identityVerified
    ? [
        model.personalCode ? `Personal code ${esc(model.personalCode)}` : "",
        model.birthDate ? `Born ${esc(fmtDate(model.birthDate))}` : "",
        model.issuerCountry ? `Issued by ${esc(model.issuerCountry)}` : "",
      ]
        .filter(Boolean)
        .join(" &middot; ")
    : "";

  const banner = model.identityVerified
    ? ""
    : `    <div class="unverified" data-testid="contract-unverified-banner">IDENTITY NOT GOVERNMENT-VERIFIED — the name and personal details below are as typed and have not been confirmed against any maritime registry. This DRAFT must not be executed until identity is verified.</div>\n`;

  // F12 — a POSITIVE green strip on a verified SEA, so verified/unverified are
  // symmetric states (not "verified = mere absence of the red banner").
  const registryName = model.issuerCountry ? `the ${esc(model.issuerCountry)} registry` : "a maritime registry";
  const verifiedStrip = model.identityVerified
    ? `    <div class="verified-strip" data-testid="contract-verified-strip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Identity verified against ${registryName}.</div>\n`
    : "";

  // F10 — under an UNVERIFIED identity the wage/terms are still concrete numbers; tag
  // the Terms block so figures cannot be lifted out of context as confirmed facts.
  const termsUnverifiedNote = model.identityVerified
    ? ""
    : `    <div class="terms-unverified-note" data-testid="contract-terms-unverified">Unverified — the wages and terms below are stated under an identity that has not been confirmed. Do not rely on these figures until identity is verified.</div>\n`;
  const termsTableClass = model.identityVerified ? "terms" : "terms unverified-terms";

  const bodyHtml = `  <div class="sheet" data-testid="contract-draft">
    <header>
      <div>
        <div class="doc-title">Seafarer's Employment Agreement</div>
        <div class="subtitle">MLC 2006, Standard A2.1 &middot; DRAFT for review</div>
      </div>
      <div class="brand">
        <div class="name">docka</div>
        <div class="tag">Seafarer credential platform</div>
      </div>
    </header>

${banner}${verifiedStrip}    <h2>Parties</h2>
    <table class="terms">
      <tbody>
        <tr><td>Seafarer</td><td>${nameCell}${idLine ? `<div class="identity">${idLine}</div>` : ""}</td></tr>
        <tr><td>Rank / position</td><td>${orBlank(t.position ?? model.rank)}</td></tr>
        <tr><td>Employer / manning agent</td><td>${esc(model.agencyOrg)}</td></tr>
        <tr><td>Vessel</td><td>${orBlank(model.vessel)}</td></tr>
      </tbody>
    </table>

    <h2>Terms of employment</h2>
${termsUnverifiedNote}    <table class="${termsTableClass}">
      <tbody>
        <tr><td>Wages</td><td>${wageLine(t)}</td></tr>
        <tr><td>Paid leave</td><td>${t.leaveDaysPerMonth ? `${esc(t.leaveDaysPerMonth)} days per month` : `<span class="blank">&nbsp;</span>`}</td></tr>
        <tr><td>Commencement</td><td>${orBlank(t.contractStart ? fmtDate(t.contractStart) : null)}</td></tr>
        <tr><td>Duration</td><td>${t.durationMonths ? `${esc(t.durationMonths)} months` : `<span class="blank">&nbsp;</span>`}</td></tr>
        <tr><td>Notice period</td><td>${t.noticeDays ? `${esc(t.noticeDays)} days` : `<span class="blank">&nbsp;</span>`}</td></tr>
        <tr><td>Allotment</td><td>${orBlank(t.allotment)}</td></tr>
        <tr><td>Repatriation by</td><td>${orBlank(t.repatriationBy)}</td></tr>
      </tbody>
    </table>

    <div class="sig-grid">
      <div class="sig">
        <div class="line">Seafarer — signature</div>
        <div class="line">Date</div>
      </div>
      <div class="sig">
        <div class="line">For the employer / master — signature</div>
        <div class="line">Date</div>
      </div>
    </div>

    <div class="provenance">
      Generated from profile data as of ${esc(fmtDate(model.generatedAt))}. Draft for review — not a signed instrument.
      This draft reflects only the latest issued terms for this assignment; a prior generation's exact terms are not retained.
    </div>
  </div>`;

  return printPage({
    title: `${esc(model.seamanName || "Seafarer")} — Seafarer's Employment Agreement (DRAFT)`,
    bodyHtml,
    extraCss: CONTRACT_EXTRA_CSS,
    watermark: "DRAFT — NOT AN EXECUTED AGREEMENT",
  });
}

/**
 * The explicit "no SEA issued yet" page a seaman sees when the agency has not generated
 * an employment agreement for a voyage — never a blank SEA masquerading as real.
 */
export function renderNoContractHtml(): string {
  const bodyHtml = `  <div class="sheet" data-testid="seaman-sea-none">
    <header>
      <div>
        <div class="doc-title">No employment agreement yet</div>
        <div class="subtitle">Seafarer's Employment Agreement (MLC A2.1)</div>
      </div>
      <div class="brand">
        <div class="name">docka</div>
        <div class="tag">Seafarer credential platform</div>
      </div>
    </header>
    <p style="margin-top:16px;color:#334155;font-size:14px;line-height:1.5">
      No employment agreement has been issued for this voyage yet. When your agency generates your
      SEA it will appear here with the actual terms — this page will never show a blank agreement as if it were real.
    </p>
  </div>`;
  return printPage({
    title: "No employment agreement issued",
    bodyHtml,
    extraCss: CONTRACT_EXTRA_CSS,
  });
}

/** Sanitise inbound ContractTerms from a request body — trims, caps, normalises. */
export function sanitizeContractTerms(input: unknown): ContractTerms {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (raw: unknown, max = 120): string | null =>
    typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
  const period = ((): "month" | "day" | null => {
    const v = typeof b.wagePeriod === "string" ? b.wagePeriod.trim().toLowerCase() : "";
    return v === "month" || v === "day" ? v : null;
  })();
  const dateKey = (raw: unknown): string | null => {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  return {
    position: text(b.position),
    wageAmount: text(b.wageAmount, 40),
    wageCurrency: text(b.wageCurrency, 10),
    wagePeriod: period,
    leaveDaysPerMonth: text(b.leaveDaysPerMonth, 10),
    contractStart: dateKey(b.contractStart),
    durationMonths: text(b.durationMonths, 10),
    noticeDays: text(b.noticeDays, 10),
    allotment: text(b.allotment),
    repatriationBy: text(b.repatriationBy),
  };
}

/** An all-null terms block — the seaman GET default when a field set is missing. */
export function emptyContractTerms(): ContractTerms {
  return {
    position: null,
    wageAmount: null,
    wageCurrency: null,
    wagePeriod: null,
    leaveDaysPerMonth: null,
    contractStart: null,
    durationMonths: null,
    noticeDays: null,
    allotment: null,
    repatriationBy: null,
  };
}
