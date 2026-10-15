// Shared standalone-print HTML shell — client-safe (no Node built-ins), extracted
// VERBATIM from lib/cv.ts so the CV route, the SEA/contract route (#45), and any
// future printable share the ONE escaper + ONE page skeleton + base CSS instead of
// each forking their own. The extraction is byte-preserving: renderCvHtml(model)
// produces output identical to before this module existed (asserted by the CV
// byte-parity snapshot test, tests/print-html.test.mjs).
//
// Split point (cv.ts pre-extraction line numbers):
//   - BASE_CSS   = the layout/table CSS (`:root`..`td`) every printable reuses.
//   - printCss   = the `@media print` block, always emitted after extraCss.
//   - extraCss   = caller-specific CSS (CV passes its cert-cell classes; the SEA
//                  document passes its own). Inserted between base and print so the
//                  concatenation reproduces the original byte order.
// A caller opts into a diagonal DRAFT watermark by passing `watermark`; the watermark
// CSS + layer are emitted ONLY then, so a caller that omits it (the CV) is byte-identical.

/** HTML-escape a value for safe interpolation. Moved verbatim from lib/cv.ts. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Base CSS — cv.ts lines 253-273 (`:root`..`td`), moved byte-verbatim (no re-indent).
const BASE_CSS = `  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --brand:#0369a1; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background:#f8fafc; }
  .sheet { max-width: 900px; margin: 0 auto; padding: 32px; background:#fff; }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; border-bottom:2px solid var(--line); padding-bottom:16px; }
  h1 { font-size: 26px; margin:0; }
  .rank { color: var(--muted); font-size:14px; margin-top:2px; }
  .identity { color: var(--muted); font-size:12px; margin-top:6px; }
  .stamp { display:inline-flex; align-items:center; gap:6px; background:#059669; color:#fff; font-size:11px; font-weight:700; padding:4px 10px; border-radius:999px; white-space:nowrap; }
  .brand { text-align:right; }
  .brand .name { font-weight:800; color: var(--brand); font-size:18px; letter-spacing:-0.01em; }
  .brand .tag { color: var(--muted); font-size:11px; }
  .summary { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 8px; }
  .chip { font-size:12px; font-weight:600; padding:5px 10px; border-radius:8px; background:#f1f5f9; color:#334155; }
  .chip b { font-weight:800; }
  .chip.warn { background:#fffbeb; color:#b45309; }
  .chip.bad { background:#fef2f2; color:#b91c1c; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:22px 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
`;

// The @media print block — cv.ts lines 283-287, moved byte-verbatim. Always emitted
// after extraCss so a printable is print-friendly for free.
const PRINT_CSS = `  @media print {
    body { background:#fff; }
    .sheet { max-width:none; padding:0; }
    .noprint { display:none !important; }
  }
`;

// Diagonal DRAFT watermark layer — emitted ONLY when a caller passes `watermark`, so a
// caller that omits it (the CV) produces byte-identical output to the pre-extraction code.
const WATERMARK_CSS = `  .draft-watermark { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; z-index:9999; }
  .draft-watermark span { transform:rotate(-30deg); font-size:44px; font-weight:800; letter-spacing:0.08em; color:rgba(185,28,28,0.07); border:3px solid rgba(185,28,28,0.12); padding:10px 28px; border-radius:10px; white-space:nowrap; text-transform:uppercase; }
`;

export type PrintPageInput = {
  /** Full <title> text (already escaped by the caller if it interpolates data). */
  title: string;
  /** The <body>'s inner HTML (already escaped by the caller). */
  bodyHtml: string;
  /** Caller-specific CSS, inserted between the base and print blocks. Optional. */
  extraCss?: string;
  /** When set, a diagonal watermark is stamped across the page (e.g. "DRAFT"). */
  watermark?: string | null;
};

/**
 * Render a full standalone printable HTML page. The shell + base CSS are shared; the
 * caller supplies the title, body, its own extra CSS, and an optional DRAFT watermark.
 */
export function printPage(input: PrintPageInput): string {
  const extra = input.extraCss ?? "";
  const watermarkCss = input.watermark ? WATERMARK_CSS : "";
  const watermarkHtml = input.watermark
    ? `  <div class="draft-watermark" aria-hidden="true"><span>${esc(input.watermark)}</span></div>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${input.title}</title>
<style>
${BASE_CSS}${extra}${PRINT_CSS}${watermarkCss}</style>
</head>
<body>
${watermarkHtml}${input.bodyHtml}
</body>
</html>`;
}
