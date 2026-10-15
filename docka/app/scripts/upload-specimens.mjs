// Upload every generated country specimen (tests/fixtures/verify-upload-specimens/
// <CC>.jpg — see generate-country-specimens.mjs) to a verify-upload endpoint so
// each registry country appears in the /admin/verify-uploads corpus for
// per-country detection validation.
//
//   node scripts/upload-specimens.mjs --target https://docka.me
//   node scripts/upload-specimens.mjs --target http://localhost:3000 --only DK,NO
//
// Pacing: >= 25 s between uploads (endpoint budget is 3/min/IP, global 10/min —
// 25 s keeps well clear; a full 27-country run takes ~11-12 min). On 429 the
// script honors Retry-After and retries. Prints a per-country result table
// (itemId | phase | countryDetected | outcome) and writes
// specimen-upload-results.json next to the JPEGs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPECIMENS_DIR = path.join(APP_ROOT, "tests", "fixtures", "verify-upload-specimens");
const PACE_MS = 25_000;
const MAX_RETRIES = 4;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg("--target", "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(target)) {
  console.error("Usage: node scripts/upload-specimens.mjs --target https://docka.me [--only DK,NO]");
  process.exit(2);
}
const only = arg("--only", "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadOne(cc, filePath) {
  const buf = fs.readFileSync(filePath);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "image/jpeg" }), `TEST-SPECIMEN-${cc}.jpg`);
    let res;
    try {
      res = await fetch(`${target}/api/verify-upload`, { method: "POST", body: fd });
    } catch (e) {
      return { cc, status: "transport-error", error: String(e?.message ?? e) };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "20");
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 20) * 1000 + 1000;
      console.log(`  ${cc}: 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = { error: `non-JSON response (HTTP ${res.status})` };
    }
    return {
      cc,
      status: res.status,
      itemId: body.itemId ?? null,
      phase: body.phase ?? null,
      countryDetected: body.countryDetected ?? null,
      outcome: body.outcome?.kind ?? null,
      message: body.error ?? body.message ?? null,
      raw: body,
    };
  }
  return { cc, status: "gave-up-429" };
}

const files = fs
  .readdirSync(SPECIMENS_DIR)
  .filter((f) => /^[A-Z]{2}\.jpg$/.test(f))
  .sort()
  .map((f) => ({ cc: f.slice(0, 2), file: path.join(SPECIMENS_DIR, f) }))
  .filter((x) => only.length === 0 || only.includes(x.cc));

if (files.length === 0) {
  console.error(`No specimens found in ${SPECIMENS_DIR} — run scripts/generate-country-specimens.mjs first.`);
  process.exit(2);
}

console.log(`Uploading ${files.length} specimens to ${target} (>=${PACE_MS / 1000}s apart)\n`);
const results = [];
for (let i = 0; i < files.length; i++) {
  const { cc, file } = files[i];
  const t0 = Date.now();
  const r = await uploadOne(cc, file);
  results.push(r);
  console.log(
    `  ${cc}  http=${r.status}  itemId=${r.itemId ?? "-"}  phase=${r.phase ?? "-"}  ` +
      `country=${r.countryDetected ?? "null"}  outcome=${r.outcome ?? "-"}  ` +
      (r.message ? `msg="${String(r.message).slice(0, 70)}"` : "")
  );
  if (i < files.length - 1) {
    const wait = Math.max(0, PACE_MS - (Date.now() - t0));
    if (wait > 0) await sleep(wait);
  }
}

const outPath = path.join(SPECIMENS_DIR, "specimen-upload-results.json");
fs.writeFileSync(outPath, JSON.stringify({ target, at: new Date().toISOString(), results }, null, 2));

console.log("\nCC | itemId | phase | countryDetected | outcome");
for (const r of results) {
  console.log(
    `${r.cc} | ${r.itemId ?? "-"} | ${r.phase ?? "-"} | ${r.countryDetected ?? "null"} | ${r.outcome ?? r.message ?? "-"}`
  );
}
console.log(`\nResults written to ${outPath}`);
