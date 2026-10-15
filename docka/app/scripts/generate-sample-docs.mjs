// Public Sample Profiles — watermarked sample-document fixture generator (Phase 2).
//
// Clones the Playwright HTML-render approach of generate-country-specimens.mjs:
// each curated sample certificate is rendered as a JPEG "photo of the document"
// with a BOLD DIAGONAL "SAMPLE" watermark, SAMPLE-prefixed certificate numbers
// and "— SAMPLE"-suffixed holder names, so a screenshot of any sample page can
// never be mistaken for a real person's document (plan §D8 PII rule).
//
// UNLIKE the (gitignored) country specimens, the output directory
// scripts/sample-fixtures/ is COMMITTED: prod has no Playwright, and the deploy
// tar ships scripts/ verbatim, so seed-samples.mjs can copy the images into
// uploads/ on the box without any render step.
//
// The fixture list below is duplicated (fileName-for-fileName) by the doc rows
// in scripts/seed-samples.mjs; the sample-seed test asserts every seeded
// Doc.fileName exists in this directory, so the two lists cannot drift.
//
// Run:  node scripts/generate-sample-docs.mjs        (from app/)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES_DIR = path.join(APP_ROOT, "scripts", "sample-fixtures");

// ---- The curated fixture set -----------------------------------------------
//
// One entry per committed image. `accent` only varies the card tint so the demo
// document wall does not look like eight copies of one template.

export const SAMPLE_FIXTURES = [
  // Flagship — Marten Sarapuu — SAMPLE (Chief Officer)
  {
    fileName: "sample-flagship-coc.jpg",
    kind: "CERTIFICATE OF COMPETENCY",
    title: "Certificate of Competency — Chief Mate",
    authority: "Maritime Administration of Latvia",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-LV-88214",
    lines: ["STCW Regulation II/2", "Issued 2024 — demonstration document"],
    accent: "#1d4ed8",
  },
  {
    fileName: "sample-flagship-medical.jpg",
    kind: "MEDICAL CERTIFICATE",
    title: "Seafarer Medical Fitness Certificate",
    authority: "Sample Maritime Health Board",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-MED-3401",
    lines: ["Fit for sea service — no limitations", "Demonstration document"],
    accent: "#0f766e",
  },
  {
    fileName: "sample-flagship-bst.jpg",
    kind: "STCW TRAINING CERTIFICATE",
    title: "Basic Safety Training (STCW A-VI/1)",
    authority: "Sample Maritime Training Centre",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-BST-1207",
    lines: ["Personal survival · fire prevention · first aid", "Demonstration document"],
    accent: "#b45309",
  },
  {
    fileName: "sample-flagship-endorsement.jpg",
    kind: "FLAG STATE ENDORSEMENT",
    title: "Endorsement Attesting Recognition of a CoC",
    authority: "Sample Flag State Administration",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-END-5520",
    lines: ["STCW Regulation I/10", "Demonstration document"],
    accent: "#7c3aed",
  },
  {
    fileName: "sample-flagship-passport.jpg",
    kind: "TRAVEL DOCUMENT",
    title: "Passport",
    authority: "Republic of Sampleland",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-PSP-7788",
    lines: ["Machine readable travel document", "Demonstration document"],
    accent: "#334155",
  },
  {
    fileName: "sample-flagship-seamanbook.jpg",
    kind: "SEAFARER'S IDENTITY DOCUMENT",
    title: "Seaman's Discharge Book",
    authority: "Sample Registry of Seamen",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-SBK-2210",
    lines: ["Continuous certificate of discharge", "Demonstration document"],
    accent: "#0e7490",
  },
  {
    fileName: "sample-flagship-tankerfam.jpg",
    kind: "STCW TRAINING CERTIFICATE",
    title: "Tanker Familiarisation (STCW A-V/1)",
    authority: "Sample Maritime Training Centre",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-TFM-0093",
    lines: ["Superseded — kept as an archived record", "Demonstration document"],
    accent: "#9f1239",
  },
  {
    fileName: "sample-flagship-sea.jpg",
    kind: "EMPLOYMENT AGREEMENT",
    title: "Seafarer's Employment Agreement (MLC A2.1)",
    authority: "Sample Crewing OÜ",
    holder: "MARTEN SARAPUU — SAMPLE",
    certNumber: "SAMPLE-SEA-2026-01",
    lines: ["Chief Officer — MV Sample Aurora", "Demonstration document"],
    accent: "#065f46",
  },
  // Board-only sample crew
  {
    fileName: "sample-crew-coc.jpg",
    kind: "CERTIFICATE OF COMPETENCY",
    title: "Certificate of Competency — Chief Engineer Officer",
    authority: "Maritime Administration of Latvia",
    holder: "AIVAR REBANE — SAMPLE",
    certNumber: "SAMPLE-LV-77120",
    lines: ["STCW Regulation III/2", "Issued 2023 — demonstration document"],
    accent: "#1d4ed8",
  },
  {
    fileName: "sample-crew-dgh-a.jpg",
    kind: "TRAINING CERTIFICATE",
    title: "Dangerous Goods Handling",
    authority: "Sample Maritime Training Centre",
    holder: "DAINIS OZOLS — SAMPLE",
    certNumber: "SAMPLE-DGH-4419",
    lines: ["IMDG Code awareness", "Demonstration document"],
    accent: "#b45309",
  },
  {
    // Deliberate forged-duplicate pair: SAME certificate number as -a, different
    // holder — drives the fleet-wide duplicate/forgery demo within the cohort.
    fileName: "sample-crew-dgh-b.jpg",
    kind: "TRAINING CERTIFICATE",
    title: "Dangerous Goods Handling",
    authority: "Sample Maritime Training Centre",
    holder: "TONU MERISTE — SAMPLE",
    certNumber: "SAMPLE-DGH-4419",
    lines: ["IMDG Code awareness", "Demonstration document"],
    accent: "#b45309",
  },
  {
    fileName: "sample-crew-photo.jpg",
    kind: "FLAG STATE ENDORSEMENT",
    title: "Flag State Endorsement",
    authority: "Sample Flag State Administration",
    holder: "LIIS TALVIK — SAMPLE",
    certNumber: "SAMPLE-END-8804",
    lines: ["Uploaded photo — expiry not yet confirmed", "Demonstration document"],
    accent: "#7c3aed",
  },
];

// ---- Template ----------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildFixtureHtml(fx) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1f2937; }
  .card {
    position: relative; width: 1200px; box-sizing: border-box;
    padding: 52px 64px 60px; border: 6px double ${fx.accent}; overflow: hidden;
    background:
      radial-gradient(circle at 12% 8%, rgba(0,0,0,0.035), transparent 42%),
      radial-gradient(circle at 88% 92%, rgba(0,0,0,0.03), transparent 40%),
      #fdfdf8;
  }
  .banner {
    font-family: Arial, sans-serif; font-size: 24px; letter-spacing: 3px;
    color: #6b7280; text-align: center; margin-bottom: 24px;
  }
  .kind { font-family: Arial, sans-serif; font-size: 26px; letter-spacing: 5px; color: ${fx.accent}; text-align: center; }
  .title { font-size: 44px; font-weight: bold; text-align: center; margin: 10px 0 6px; }
  .authority { font-size: 28px; font-style: italic; text-align: center; color: #374151; margin-bottom: 30px; }
  .rule { height: 2px; background: ${fx.accent}; opacity: 0.35; margin: 0 120px 30px; }
  .fields { font-size: 30px; line-height: 1.75; margin: 0 40px; }
  .fields .label { display: inline-block; width: 340px; color: #6b7280; font-family: Arial, sans-serif; font-size: 24px; letter-spacing: 1px; }
  .fields .code { font-family: "Courier New", monospace; font-weight: bold; letter-spacing: 2px; }
  .line { font-size: 24px; color: #4b5563; margin: 4px 40px; font-family: Arial, sans-serif; }
  .seal {
    position: absolute; right: 70px; bottom: 54px; width: 150px; height: 150px;
    border: 4px solid ${fx.accent}; border-radius: 50%; opacity: 0.5;
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, sans-serif; font-size: 26px; font-weight: bold;
    color: ${fx.accent}; transform: rotate(-12deg); letter-spacing: 2px;
  }
  .watermark {
    position: absolute; top: 50%; left: 50%; z-index: 2;
    transform: translate(-50%, -50%) rotate(-27deg);
    font-family: Arial, sans-serif; font-size: 200px; font-weight: 900;
    color: rgba(190, 24, 24, 0.18); letter-spacing: 30px; pointer-events: none;
    white-space: nowrap;
  }
  .watermark-sub {
    position: absolute; top: 72%; left: 50%; z-index: 2;
    transform: translate(-50%, -50%) rotate(-27deg);
    font-family: Arial, sans-serif; font-size: 40px; font-weight: bold;
    color: rgba(190, 24, 24, 0.30); letter-spacing: 6px; pointer-events: none;
    white-space: nowrap;
  }
  .fg { position: relative; z-index: 1; }
</style></head><body>
  <div class="card">
    <div class="watermark">SAMPLE</div>
    <div class="watermark-sub">SAMPLE — NOT A REAL DOCUMENT</div>
    <div class="fg">
      <div class="banner">SAMPLE DOCUMENT — FOR DEMONSTRATION ONLY</div>
      <div class="kind">${esc(fx.kind)}</div>
      <div class="title">${esc(fx.title)}</div>
      <div class="authority">${esc(fx.authority)}</div>
      <div class="rule"></div>
      <div class="fields">
        <div><span class="label">HOLDER</span> ${esc(fx.holder)}</div>
        <div><span class="label">CERTIFICATE No</span> <span class="code">${esc(fx.certNumber)}</span></div>
      </div>
      ${fx.lines.map((l) => `<div class="line">${esc(l)}</div>`).join("\n      ")}
    </div>
    <div class="seal">SAMPLE</div>
  </div>
</body></html>`;
}

// ---- Playwright render -------------------------------------------------------

export async function generateAll({ outDir = FIXTURES_DIR, log = () => {} } = {}) {
  const { chromium } = await import("playwright");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const written = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    for (const fx of SAMPLE_FIXTURES) {
      await page.setContent(buildFixtureHtml(fx), { waitUntil: "load" });
      const card = page.locator(".card");
      const file = path.join(outDir, fx.fileName);
      await card.screenshot({ path: file, type: "jpeg", quality: 85 });
      written.push({ fileName: fx.fileName, size: fs.statSync(file).size });
      log(`${fx.fileName}  ${fs.statSync(file).size} bytes`);
    }
  } finally {
    await browser.close();
  }
  return written;
}

// ---- CLI ---------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const written = await generateAll({ log: (m) => console.log("  " + m) });
  console.log(`\nGenerated ${written.length} sample fixtures in ${FIXTURES_DIR}`);
}
