// Auto-generated seafarer CV / certificate matrix — client-safe (no Node built-ins,
// type-only import of Doc/Seafarer) so the seaman page, the agent review panel, AND
// the server-rendered printable route all build ONE identical model from ONE code
// path. This is pure export off data already on file: it computes NOTHING new about
// a document beyond the status/expiry logic the rest of the app already uses.
//
// The matrix reuses the app's existing single sources of truth:
//   - archive.ts   activeDocs / verifiedFirst  (which docs count, verified-first order)
//   - cert.ts      docStatus / docBadge         (honest, source-aware status + badge)
//   - cert-rules.ts effectiveValidUntil / legalExpiryForDoc (age-shortened LEGAL expiry)
//   - cert.ts      CATEGORY_LABELS              (government category display names)
//   - doctypes.ts  classifyRequiredType         (which required slot a doc fills)
// so the CV can never drift from what the review board / reminders / compliance show.

import type { Doc, Seafarer } from "@/lib/db";
import {
  docStatusForDoc,
  docBadgeForDoc,
  CATEGORY_LABELS,
  type DocStatus,
  type BadgeStatus,
} from "@/lib/cert";
import { effectiveValidUntil, legalExpiryForDoc } from "@/lib/cert-rules";
import { classifyRequiredType } from "@/lib/doctypes";
import { activeDocs, verifiedFirst } from "@/lib/archive";
import { esc, printPage } from "@/lib/print-html";
import {
  verificationLevelForDoc,
  docLevelTooltip,
  profileVerificationSummary,
  type VerificationLevel,
  type ProfileVerdict,
} from "@/lib/verification-level";

/** One row of the certificate matrix — a single document on file. */
export type CvCertRow = {
  docId: string;
  /** Certificate name / title. */
  title: string;
  /** Human category (government category, else the required slot it fills, else its type). */
  category: string;
  /** Certificate / registration number (explicit number, else the registry code). "" when none. */
  number: string;
  /** How the record was obtained. */
  source: Doc["source"];
  /** True only for a government-registry-verified document (earns the emerald stamp). */
  verified: boolean;
  /** Printed expiry as stored on the document. null when none was read. */
  printedExpiry: string | null;
  /** The LEGAL expiry (age-shortened medicals etc.); equals printed when no rule shortens it. */
  legalExpiry: string | null;
  /** True when the legal expiry is EARLIER than the printed one — a silent-lapse flag. */
  legalDiffers: boolean;
  /** Short human note explaining the legal-vs-printed difference, when there is one. */
  legalNote: string | null;
  /** Status computed on the EFFECTIVE (legal) expiry, so an age-lapsed medical reads expired. */
  status: DocStatus;
  /** Honest, source-aware badge (emerald only for verified) computed on the legal expiry. */
  badge: { status: BadgeStatus; label: string };
  /** #30 verification level (L0–L3) — the authoritative per-doc trust signal. */
  level: VerificationLevel;
  /** #30 identity-bound vs holder-bound tooltip for the level badge. */
  levelTooltip: string;
  /** Agent review decision, for the agent-facing copy. */
  reviewStatus: Doc["reviewStatus"];
};

/** The full CV model: identity header + certificate matrix + a compliance summary. */
export type CvModel = {
  /** Government-verified name when available, else the typed/Google name. */
  name: string;
  rank: string;
  identityVerified: boolean;
  personalCode: string | null;
  birthDate: string | null;
  issuerCountry: string | null;
  /** #30 structured profile verdict (floor + counts + headline) — NOT max(docs). */
  verdict: ProfileVerdict;
  /** ISO instant the CV was generated (for the printed footer). */
  generatedAt: string;
  rows: CvCertRow[];
  summary: {
    total: number;
    verified: number;
    valid: number;
    expiring: number;
    expired: number;
    /** Documents whose LEGAL expiry is earlier than their printed one. */
    legalDiffers: number;
  };
};

/** "2026-01-02T…" -> "02 Jan 2026" (UTC, stable across server/client). "" for empty/invalid. */
export function fmtCvDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Human category for a document: prefer the government registry category, then the
// required slot it best fills, then its own free-text type.
function categoryOf(doc: Doc): string {
  if (doc.docCategory) return CATEGORY_LABELS[doc.docCategory];
  const req = classifyRequiredType({
    title: doc.title,
    docType: doc.docType,
    docCategory: doc.docCategory,
  });
  if (req) return req;
  return doc.docType || "Document";
}

/**
 * Build the CV model from a seafarer + their documents. Only ACTIVE (non-archived)
 * documents are included — the same set the agent board counts — and they are ordered
 * government-verified-first, exactly like every other doc list in the app. Status and
 * the badge are computed on the LEGAL (effective) expiry, so an age-shortened medical
 * that prints a later date is honestly shown as expiring/expired.
 */
export function buildCvModel(seafarer: Seafarer, documents: Doc[]): CvModel {
  const dob = seafarer.birthDate ?? null;
  const docs = verifiedFirst(activeDocs(documents));

  const rows: CvCertRow[] = docs.map((doc) => {
    const legal = legalExpiryForDoc(doc, dob);
    const effective = effectiveValidUntil(doc, dob);
    const verified = doc.source === "government";
    const status = docStatusForDoc(doc, effective);
    const badge = docBadgeForDoc({
      verified,
      validUntil: effective,
      expiryConfirmed: doc.expiryConfirmed,
      // Registry-era states (plan §5.1) — CvMatrix picks them up automatically.
      source: doc.source,
      checkedVia: doc.reviewerChecked ? doc.checkedVia : null,
      manualRequested: doc.manualVerification?.status === "requested",
      // Feature 3 — a perpetual doc renders the valid-equivalent "No expiry" badge.
      noExpiry: doc.noExpiry,
    });
    return {
      docId: doc.id,
      title: doc.title,
      category: categoryOf(doc),
      number: (doc.certNumber || doc.estonianCode || "").trim(),
      source: doc.source,
      verified,
      printedExpiry: doc.validUntil ?? null,
      legalExpiry: effective,
      legalDiffers: legal.differs,
      legalNote: legal.differs ? legal.reason : null,
      status,
      badge,
      level: verificationLevelForDoc(doc),
      levelTooltip: docLevelTooltip(doc),
      reviewStatus: doc.reviewStatus,
    };
  });

  const summary = {
    total: rows.length,
    verified: rows.filter((r) => r.verified).length,
    // Feature 3 — perpetual (no-expiry) docs are valid/compliant, so they count
    // toward the "in date" tally rather than being dropped as unknown.
    valid: rows.filter((r) => r.status === "valid" || r.status === "none").length,
    expiring: rows.filter((r) => r.status === "expiring").length,
    expired: rows.filter((r) => r.status === "expired").length,
    legalDiffers: rows.filter((r) => r.legalDiffers).length,
  };

  return {
    name: (seafarer.verifiedName || seafarer.name || "Seafarer").trim(),
    rank: seafarer.rank || "",
    identityVerified: seafarer.identityVerified === true,
    personalCode: seafarer.personalCode ?? null,
    birthDate: seafarer.birthDate ?? null,
    issuerCountry: seafarer.issuerCountry ?? null,
    verdict: profileVerificationSummary(seafarer, docs),
    generatedAt: new Date().toISOString(),
    rows,
    summary,
  };
}

// ---- Standalone printable HTML (server route) --------------------------
//
// A single self-contained HTML document (inline CSS, no external assets) the seaman
// can open, print, or "Save as PDF" and send to an agent. The on-screen React copy
// (components/CvMatrix.tsx) renders the SAME CvModel; this is the shareable file form.

// CV-specific certificate-cell CSS — cv.ts pre-extraction lines 274-282, moved
// byte-verbatim into `extraCss`. printPage inserts it between the shared base CSS and
// the @media print block, reproducing the exact original byte order (byte-parity test).
const CV_EXTRA_CSS = `  .cert-title { font-weight:600; }
  .verified { margin-left:6px; font-size:10px; font-weight:700; color:#047857; background:#ecfdf5; padding:1px 6px; border-radius:999px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#334155; }
  .legal { display:block; font-weight:600; }
  .printed { display:block; font-size:11px; color:var(--muted); text-decoration:line-through; }
  .note { margin-top:4px; font-size:11px; color:#b45309; }
  .pill { display:inline-block; font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; white-space:nowrap; }
  .empty { text-align:center; color:var(--muted); padding:24px; }
  footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); display:flex; justify-content:space-between; gap:12px; }
`;

// Status pill colour for the printable table — plain inline styles so it survives
// "print backgrounds off" as coloured text on a light tint.
const STATUS_STYLE: Record<DocStatus, { bg: string; fg: string; label: string }> = {
  valid: { bg: "#ecfdf5", fg: "#047857", label: "In date" },
  expiring: { bg: "#fffbeb", fg: "#b45309", label: "Expiring soon" },
  expired: { bg: "#fef2f2", fg: "#b91c1c", label: "Expired" },
  // A null date not yet read (Feature 3 de-overloads this from perpetual).
  unknown: { bg: "#f1f5f9", fg: "#475569", label: "Expiry unknown" },
  // Perpetual (no end date) — valid/compliant, neutral-green like "in date".
  none: { bg: "#ecfdf5", fg: "#047857", label: "No expiry" },
};

/** Render a full standalone printable HTML page for a CV model. */
export function renderCvHtml(model: CvModel): string {
  const s = model.summary;
  const identityLine = [
    model.personalCode ? `Personal code ${esc(model.personalCode)}` : "",
    model.birthDate ? `Born ${esc(fmtCvDate(model.birthDate))}` : "",
    model.issuerCountry ? `Issued by ${esc(model.issuerCountry)}` : "",
  ]
    .filter(Boolean)
    .join(" &middot; ");

  const rowsHtml = model.rows.length
    ? model.rows
        .map((r) => {
          const st = STATUS_STYLE[r.status];
          const expiryCell = r.legalDiffers
            ? `<span class="legal">${esc(fmtCvDate(r.legalExpiry))}</span>` +
              `<span class="printed">printed ${esc(fmtCvDate(r.printedExpiry))}</span>`
            : esc(fmtCvDate(r.legalExpiry)) || "&mdash;";
          return `
          <tr>
            <td>
              <span class="cert-title">${esc(r.title)}</span>
              ${r.verified ? `<span class="verified">verified</span>` : ""}
              ${r.legalDiffers ? `<div class="note">${esc(r.legalNote)}</div>` : ""}
            </td>
            <td>${esc(r.category)}</td>
            <td class="mono">${r.number ? esc(r.number) : "&mdash;"}</td>
            <td>${expiryCell}</td>
            <td><span class="pill" style="background:${st.bg};color:${st.fg}">${esc(
            r.badge.label
          )}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">No documents on file yet.</td></tr>`;

  const bodyHtml = `  <div class="sheet">
    <header>
      <div>
        <h1>${esc(model.name)}</h1>
        ${model.rank ? `<div class="rank">${esc(model.rank)}</div>` : ""}
        ${
          model.identityVerified
            ? `<div style="margin-top:8px"><span class="stamp">&#10003; Government-verified identity</span></div>`
            : ""
        }
        ${identityLine ? `<div class="identity">${identityLine}</div>` : ""}
      </div>
      <div class="brand">
        <div class="name">docka</div>
        <div class="tag">Seafarer credential platform</div>
      </div>
    </header>

    <!-- #S7 + persona re-review — ONE coherent line covering BOTH axes (verification
         tally + validity tally); the separate verdict-headline line was folded in. -->
    <div class="summary">
      <span class="chip">
        <b>${s.verified}</b> of <b>${s.total}</b> verified${s.valid ? ` &middot; <b>${s.valid}</b> in date` : ""}${s.expiring ? ` &middot; <b>${s.expiring}</b> expiring soon` : ""}${s.expired ? ` &middot; <b>${s.expired}</b> expired` : ""}${s.legalDiffers ? ` &middot; <b>${s.legalDiffers}</b> legal expiry earlier than printed` : ""}
      </span>
    </div>

    <h2>Certificate matrix</h2>
    <table>
      <thead>
        <tr>
          <th>Certificate</th>
          <th>Category</th>
          <th>Number</th>
          <th>Expiry</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <footer>
      <span>Generated by docka on ${esc(fmtCvDate(model.generatedAt))}. Government-verified entries are confirmed against the issuing government's maritime registry.</span>
      <span class="noprint">Use your browser's Print &rarr; Save as PDF to keep a copy.</span>
    </footer>
  </div>`;

  return printPage({
    title: `${esc(model.name)} — Seafarer CV &amp; certificate matrix`,
    bodyHtml,
    extraCss: CV_EXTRA_CSS,
  });
}
