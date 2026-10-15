// Branded, email-client-safe HTML builder for docka outbound mail.
//
// The rules email HTML must obey (Outlook/Gmail/Apple Mail), and how this file keeps them:
//   - TABLE-based layout only — no flexbox/grid, no CSS positioning (Outlook uses Word's
//     rendering engine and ignores most modern CSS).
//   - ALL styles INLINE on the elements — no <style> block, no external stylesheet
//     (Gmail strips <head>/<style>, and CSP on the box would block external CSS anyway).
//   - max-width 600px content column — the widely-safe email width.
//   - The CTA is a "bulletproof" padded table-cell button (no VML) — a coloured <td>
//     wrapping a white <a>, so it renders as a solid button everywhere without Outlook VML.
//   - A hidden preheader span carries the inbox-preview text.
//   - Every interpolated user value is HTML-escaped (escapeHtml) so a name/company that
//     contains "<" or "&" can never inject markup.
//
// This module is PURE (no db / no fs / no env) so it is safe to import from a route, a
// test, or the standalone preview script with zero side effects.

// ---- Brand tokens (kept in one place; inlined by the builder) ----------
const BRAND = {
  primary: "#1F66F0", // brand-600 — CTA + "a" accent
  gradFrom: "#3385FB",
  gradTo: "#1942B2",
  darkText: "#0F172A", // slate-900
  lightBg: "#eef6ff",
  cardBg: "#ffffff",
  muted: "#64748b", // slate-500 — footer text
  border: "#e2e8f0", // slate-200
  markUrl: "https://docka.me/brand/docka-mark-256.png",
};

/** Minimal HTML-entity escape for text interpolated into the email markup. */
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type BrandedEmailInput = {
  /** Inbox-preview text (hidden preheader). */
  previewText: string;
  /** Card heading (plain text — escaped). */
  heading: string;
  /** Body HTML — the CALLER is responsible for escaping any user data placed here. */
  bodyHtml: string;
  /** CTA button label (plain text — escaped). */
  ctaLabel: string;
  /** CTA + fallback-link URL (escaped). */
  ctaUrl: string;
  /** Small note under the footer explaining why they received this (plain text — escaped). */
  footerNote: string;
};

// Header band: icon mark + "Docka" wordmark rendered as styled TEXT (no wordmark PNG,
// and inline SVG is unreliable in email — so the "a" accent is a coloured <span>).
function headerBand(): string {
  return `
  <tr>
    <td style="padding:24px 32px 8px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;padding-right:10px;">
          <img src="${BRAND.markUrl}" width="40" height="40" alt="Docka"
               style="display:block;border:0;width:40px;height:40px;border-radius:10px;" />
        </td>
        <td style="vertical-align:middle;">
          <span style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.02em;color:${BRAND.darkText};">Dock<span style="color:${BRAND.primary};">a</span></span>
        </td>
      </tr></table>
    </td>
  </tr>`;
}

// Bulletproof CTA: a padded, rounded, brand-coloured <td> wrapping a white <a>. No VML,
// so it degrades gracefully in Outlook (a solid rectangle) and looks right everywhere else.
function ctaButton(label: string, url: string): string {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px 0;"><tr>
    <td align="center" bgcolor="${BRAND.primary}" style="border-radius:8px;background-color:${BRAND.primary};">
      <a href="${safeUrl}" target="_blank"
         style="display:inline-block;padding:14px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
        ${safeLabel}
      </a>
    </td>
  </tr></table>`;
}

/**
 * Assemble one full branded email HTML document from its parts. Returns a complete
 * `<!doctype html>` string ready to hand to a transport's `html` field.
 */
export function brandedEmail(input: BrandedEmailInput): string {
  const { previewText, heading, bodyHtml, ctaLabel, ctaUrl, footerNote } = input;
  const safeUrl = escapeHtml(ctaUrl);
  const font = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.lightBg};">
<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.lightBg};opacity:0;">${escapeHtml(previewText)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.lightBg};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">
        ${headerBand()}
        <tr>
          <td style="padding:8px 12px 24px 12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:14px;">
              <tr>
                <td style="padding:32px;">
                  <h1 style="margin:0 0 16px 0;font-family:${font};font-size:22px;line-height:1.3;font-weight:700;color:${BRAND.darkText};">${escapeHtml(heading)}</h1>
                  <div style="font-family:${font};font-size:15px;line-height:1.6;color:${BRAND.darkText};">
                    ${bodyHtml}
                  </div>
                  ${ctaButton(ctaLabel, ctaUrl)}
                  <p style="margin:16px 0 0 0;font-family:${font};font-size:13px;line-height:1.5;color:${BRAND.muted};">
                    or copy this link: <a href="${safeUrl}" target="_blank" style="color:${BRAND.primary};text-decoration:underline;word-break:break-all;">${safeUrl}</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px 32px;">
            <p style="margin:0 0 6px 0;font-family:${font};font-size:12px;line-height:1.5;color:${BRAND.muted};">
              Verify seafarer certificates against official maritime registries.
            </p>
            <p style="margin:0 0 6px 0;font-family:${font};font-size:12px;line-height:1.5;color:${BRAND.muted};">
              Docka Development O&Uuml; &middot; Reg. 17579582 &middot; docka.me
            </p>
            <p style="margin:0 0 12px 0;font-family:${font};font-size:12px;line-height:1.5;color:${BRAND.muted};">
              Questions? <a href="mailto:hello@trydocka.me" style="color:${BRAND.primary};text-decoration:underline;">hello@trydocka.me</a>
            </p>
            <p style="margin:0;font-family:${font};font-size:12px;line-height:1.5;color:${BRAND.muted};">
              ${escapeHtml(footerNote)}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---- Claim / invite composer ------------------------------------------

export type ClaimInviteInput = {
  /** Raw seafarer name from the roster (may be polluted with an email token). */
  seafarerName?: string | null;
  /** Agency display name (already resolved — legalName or orgName fallback). */
  agencyName: string;
  /** The /seafarer?token=... claim link. */
  claimUrl: string;
};

// The "name" cell can be a header-less paste of "Name email@x.com" mashed into one field,
// so before greeting a human we strip any email-shaped token and collapse whitespace. If
// nothing human survives, we greet "there".
export function cleanGreetingName(raw?: string | null): string {
  const stripped = String(raw ?? "")
    .replace(/\S+@\S+\.\S+/g, " ") // remove any email-shaped token
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : "there";
}

/**
 * Build the full claim/invite message (subject + plain-text fallback + branded HTML) for
 * one seafarer. Pure: all inputs are provided by the caller (the route resolves the agency
 * name and claim URL). User values are escaped inside the HTML builder.
 */
export function composeClaimInvite(input: ClaimInviteInput): {
  subject: string;
  text: string;
  html: string;
} {
  const agency = input.agencyName;
  const claimUrl = input.claimUrl;
  const name = cleanGreetingName(input.seafarerName);

  const subject = `${agency} invited you to Docka — claim your seafarer profile`;

  const p1 = `${escapeHtml(agency)} uses Docka to manage seafarer certificates and has set up a profile for you.`;
  const p2 =
    "Claim it to upload your documents, keep your certificates current, and share verified credentials — it takes about a minute.";

  const bodyHtml = `
    <p style="margin:0 0 14px 0;">Hello ${escapeHtml(name)},</p>
    <p style="margin:0 0 14px 0;">${p1}</p>
    <p style="margin:0 0 20px 0;">${p2}</p>`;

  const footerNote = `You received this because ${agency} added you as crew on Docka. If you weren't expecting it, you can ignore this email.`;

  const html = brandedEmail({
    previewText: `${agency} set up a Docka profile for you — claim it in about a minute.`,
    heading: "Claim your seafarer profile",
    bodyHtml,
    ctaLabel: "Claim your profile",
    ctaUrl: claimUrl,
    footerNote,
  });

  const text =
    `Hello ${name},\n\n` +
    `${agency} uses Docka to manage seafarer certificates and has set up a profile for you.\n\n` +
    `Claim it to upload your documents, keep your certificates current, and share verified credentials — it takes about a minute.\n\n` +
    `Claim your profile: ${claimUrl}\n\n` +
    `— Docka Development OÜ · docka.me\n` +
    `Sent by ${agency} via Docka.`;

  return { subject, text, html };
}
