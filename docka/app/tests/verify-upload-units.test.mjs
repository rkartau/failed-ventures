// Unit tests for wave 1 of the anonymous verify-upload plan (§§1–5): magic
// sniff / safeExt, header-only pixel gate, keyword map + anonymous bare-code
// candidate planner, date-rotated ipHash, the named-global upload budget
// (isolation from the registry bucket), the §1 route gates (411/413/415/429/
// 503 persist NOTHING), the §2 persistence trio + PII-free chain, the
// verify-uploads tail-hash cache (+ external-append staleness guard), and the
// §3 compress forceJpeg / MIN_GAIN-bypass behavior under DOM stubs.
//
// Follows the registry-units.test.mjs pattern: plain node + the `@/*` alias
// hook, synthetic fixtures, deterministic, REGISTRY_MOCK seam — NO live
// registry call is ever made (asserted via the journal).
//
// Run: node --import ./tests/_register-alias.mjs tests/verify-upload-units.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode + salt BEFORE any @/lib import (route/lib read env at call time,
// but the registry pins mock-only test seams at import).
process.env.REGISTRY_MOCK = "1";
process.env.VERIFY_IP_SALT = "unit-test-salt";

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-verify-upload-units-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { sniffMagic, safeExt, imageDimensions, exceedsPixelLimit } = await import("@/lib/image-dims");
const {
  normalizeForKeywords,
  keywordCountries,
  keywordEvidence,
  planBareCodeCandidates,
  MAX_ANON_CANDIDATES,
  enrichAZCandidates,
  enrichUAMARADCandidates,
} = await import("@/lib/registry/keywords");
const { COUNTRIES } = await import("@/lib/registry/countries");
const { consumeBudget, consumeRegistryBudget, resetRegistryAbuseState, registryJournal } =
  await import("@/lib/registry");
const { appendAudit, verifyAuditChain, AUDIT_NO_IMPERSONATION } = await import("@/lib/db");
const vu = await import("@/lib/verify-upload");
const { POST } = await import("@/app/api/verify-upload/route");

const UPLOAD_DIR = path.join(TMP, "data", "verify-uploads");
const EVENTS_PATH = path.join(TMP, "data", "verify-upload-events.ndjson");

// ---- Synthetic magic-byte fixtures --------------------------------------

function jpegWithSof(sofMarker, width, height) {
  // SOI, SOFn(len 0x11): precision + height + width + 3 components.
  return Buffer.from([
    0xff, 0xd8,
    0xff, sofMarker, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

function pngWithDims(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gifWithDims(width, height) {
  const b = Buffer.alloc(20);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function bmpWithDims(width, height) {
  const b = Buffer.alloc(30);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  return b;
}

function webpVp8xWithDims(width, height) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1");
const HEIC_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypheic", "latin1"),
  Buffer.alloc(16),
]);
const HTML_BYTES = Buffer.from("<html><body>not an image</body></html>", "latin1");

// ---- §1 magic-sniff matrix + safeExt-from-magic --------------------------

{
  assert.equal(sniffMagic(jpegWithSof(0xc0, 100, 100)), "jpeg");
  assert.equal(sniffMagic(pngWithDims(10, 10)), "png");
  assert.equal(sniffMagic(webpVp8xWithDims(10, 10)), "webp");
  assert.equal(sniffMagic(gifWithDims(10, 10)), "gif");
  assert.equal(sniffMagic(bmpWithDims(10, 10)), "bmp");
  assert.equal(sniffMagic(PDF_BYTES), "pdf");
  assert.equal(sniffMagic(HEIC_BYTES), "heic");
  ok("magic sniff: every allowed type detected from leading bytes");

  // Polyglot GIF+HTML: the MAGIC wins (stored as .gif; nosniff on download).
  const polyglot = Buffer.concat([gifWithDims(1, 1), Buffer.from("<script>alert(1)</script>")]);
  assert.equal(sniffMagic(polyglot), "gif");
  ok("magic sniff: GIF+HTML polyglot sniffs as gif (bytes, not content)");

  // A mislabeled extension cannot influence the sniff — the API takes no
  // filename at all; HTML bytes are refused whatever they are called.
  assert.equal(sniffMagic(HTML_BYTES), null);
  assert.equal(sniffMagic(Buffer.alloc(4)), null);
  ok("magic sniff: HTML/short garbage => null (mislabeled ext has no input path)");

  assert.equal(safeExt("jpeg"), "jpg");
  assert.equal(safeExt("png"), "png");
  assert.equal(safeExt("pdf"), "pdf");
  assert.equal(safeExt("heic"), "heic");
  ok("safeExt derives from the sniffed type only");
}

// ---- §3 pixel-bomb gate (baseline + progressive JPEG, PNG, GIF, BMP, WEBP) --

{
  // 8000×5000 = exactly 40 MP → allowed; 8000×5001 → over the ceiling.
  assert.equal(exceedsPixelLimit(jpegWithSof(0xc0, 8000, 5000), "jpeg"), false);
  assert.equal(exceedsPixelLimit(jpegWithSof(0xc0, 8000, 5001), "jpeg"), true);
  ok("pixel gate: baseline JPEG (SOF0) 40MP boundary");

  assert.equal(exceedsPixelLimit(jpegWithSof(0xc2, 8000, 5001), "jpeg"), true);
  assert.equal(exceedsPixelLimit(jpegWithSof(0xc2, 2000, 1500), "jpeg"), false);
  ok("pixel gate: progressive JPEG (SOF2) parsed the same");

  assert.deepEqual(imageDimensions(pngWithDims(30000, 30000), "png"), { width: 30000, height: 30000 });
  assert.equal(exceedsPixelLimit(pngWithDims(30000, 30000), "png"), true);
  assert.equal(exceedsPixelLimit(gifWithDims(65000, 65000), "gif"), true);
  assert.equal(exceedsPixelLimit(bmpWithDims(9000, 9000), "bmp"), true);
  assert.equal(exceedsPixelLimit(webpVp8xWithDims(8000, 5001), "webp"), true);
  assert.equal(exceedsPixelLimit(webpVp8xWithDims(2000, 1000), "webp"), false);
  ok("pixel gate: PNG IHDR / GIF LSD / BMP header / WEBP VP8X dims");

  // Unparseable dims never block (the sniff already validated the container).
  assert.equal(exceedsPixelLimit(PDF_BYTES, "pdf"), false);
  ok("pixel gate: no parseable dims => not gated");
}

// ---- §5 keyword map: hits / diacritics / negatives ------------------------

{
  assert.deepEqual(keywordCountries("Issued by TRANSPORDIAMET — Estonian Transport Administration"), ["EE"]);
  assert.ok(keywordCountries("certificate of competency\nSøfartsstyrelsen\nDenmark").includes("DK"));
  assert.ok(keywordCountries("Latvijas Jūras administrācija apliecība").includes("LV"));
  assert.ok(keywordCountries("liikenne- ja viestintävirasto TRAFICOM").includes("FI"));
  ok("keyword map: Latin authority names hit (case + Ø/ū/ā/ä diacritics folded)");

  assert.equal(normalizeForKeywords("Søfartsstyrelsen").includes("SOFARTSSTYRELSEN"), true);
  ok("normalizeForKeywords folds non-decomposing letters (Ø→O)");

  assert.deepEqual(keywordCountries("STCW certificate of competency master mariner"), []);
  assert.deepEqual(keywordCountries(""), []);
  ok("keyword map: generic maritime boilerplate matches nothing");

  // Multi-word keyword across an OCR line break still matches.
  assert.ok(keywordCountries("MARITIME AND\nCOASTGUARD AGENCY").includes("UK"));
  ok("keyword map: whitespace collapse matches across line breaks");
}

// ---- §5 candidate planner: ranking + EE-fallback exclusion + ≤3 cap -------

{
  // A DK-shaped 8-digit code with NO keywords → DK candidate only; the EE
  // ≥6-char fallback is EXCLUDED for anonymous OCR candidates.
  const dkOnly = planBareCodeCandidates("certificate number 12345678 valid until 2030");
  assert.deepEqual(dkOnly, [{ country: "DK", code: "12345678" }]);
  ok("planner: bare 8-digit => DK specific match, EE fallback excluded");

  // A token-shaped 12-char code with NO EE keyword → nothing (would have been
  // the EE fallback); WITH the keyword → the EE candidate appears.
  assert.deepEqual(planBareCodeCandidates("document ABC123DEF456 issued"), []);
  const withKw = planBareCodeCandidates("TRANSPORDIAMET document ABC123DEF456 issued");
  assert.deepEqual(withKw, [{ country: "EE", code: "ABC123DEF456" }]);
  ok("planner: EE fallback lane opens ONLY on an independent EE keyword hit");

  // A specific EE 16-char match needs no keyword (it is not the fallback).
  const ee16 = planBareCodeCandidates("code SAMPLE0SAFETY001");
  assert.deepEqual(ee16, [{ country: "EE", code: "SAMPLE0SAFETY001" }]);
  ok("planner: specific 16-char EE pattern match allowed without keyword");

  // Keyword country ranks first: DK keyword + a UK-shaped 10-digit code + a
  // DK-shaped 8-digit code → DK candidate leads.
  const ranked = planBareCodeCandidates("Søfartsstyrelsen no. 1234567890 and 87654321");
  assert.equal(ranked[0].country, "DK");
  ok("planner: keyword-detected country's matches rank first");

  // Hard cap ≤3 across many code-shaped tokens.
  const many = planBareCodeCandidates("11111111 22222222 33333333 44444444 55555555");
  assert.equal(many.length, MAX_ANON_CANDIDATES);
  ok("planner: hard cap of 3 candidates per upload");
}

// ---- §5 keyword lock: a detected country suppresses foreign cross-fire ------

{
  // REAL header wording from the live LV specimen corpus (lv-coc.jpg sidecar
  // OCR, 2026-08-12). The issuing body printed on actual LV certificates is
  // the Registry of Seamen ("Latvijas Jūrnieku reģistrs") — NOT the "Jūras
  // administrācija" wording the old keyword list expected — and the document
  // carries DK/EE-shaped tokens (13.05.2019 → 13052019, 8-digit DK shape;
  // STARPTAUTISKAJAI → 16-char EE token shape) that were sprayed at the EE
  // and DK registries before the lock existed.
  const LV_OCR =
    "Latvijas Republika Sertifikats Nr. 1/19 izdots Latvijas Republikas\n" +
    "The Republic of Latvia valdibas varda. Sertifikata ipasnieka kvalifikacija atbilst\n" +
    "1978. gada Starptautiskajai konvencijai par jurnieku\n" +
    "KOMPETENCES SERTIFIKATS CERTIFICATE OF COMPETENCY\n" +
    "Date of issue (d. m. y.) 13.05.2019\n" +
    "Izdevejiestade: Latvijas Jurnieku registrs Issued by: Latvian Registry of Seamen";
  assert.deepEqual(keywordCountries(LV_OCR), ["LV"]);
  ok("keyword map: REAL LV specimen wording (Latvijas Republika / Registry of Seamen) hits LV");

  // LV has NO auto adapter (assisted) — the lock plans NO candidates at all.
  assert.deepEqual(planBareCodeCandidates(LV_OCR), []);
  ok("keyword lock: locked assisted country (LV) => ZERO bare-code candidates despite DK/EE-shaped tokens");

  // The English-only endorsement page carries just the state name.
  assert.deepEqual(keywordCountries("Republic of Latvia ENDORSEMENT ATTESTING THE ISSUE OF CERTIFICATE"), ["LV"]);
  ok("keyword map: LV endorsement page (English 'Republic of Latvia' only) hits LV");

  // Locked AUTO country: DK keyword + a DK-shaped code + an EE-16-shaped
  // token => ONLY the DK candidate survives; the EE shape is suppressed.
  const dkLocked = planBareCodeCandidates(
    "DANISH MARITIME AUTHORITY certificate 87654321 ref SAMPLE0SAFETY001"
  );
  assert.deepEqual(dkLocked, [{ country: "DK", code: "87654321" }]);
  ok("keyword lock: locked auto country (DK) => only DK-shaped candidates, foreign shapes suppressed");

  // Ambiguity guard: TWO countries' keywords (a bilingual endorsement naming
  // two authorities) => NO lock — both countries' shaped candidates stay.
  const multi = planBareCodeCandidates(
    "SOFARTSSTYRELSEN and SJOFARTSDIREKTORATET joint endorsement 87654321 no. 1234567890"
  );
  assert.ok(multi.some((c) => c.country === "DK"));
  assert.ok(multi.some((c) => c.country === "NO"));
  ok("keyword lock: multi-country keyword hit => no lock (ambiguous), pre-lock ranking stands");
}

// ---- §2 ipHash: determinism + date rotation + salt required ---------------

{
  const d1 = new Date("2026-08-12T10:00:00.000Z");
  const d1b = new Date("2026-08-12T23:59:59.000Z");
  const d2 = new Date("2026-08-13T00:00:01.000Z");
  const a = vu.ipHashFor("198.51.100.7", d1);
  assert.equal(vu.ipHashFor("198.51.100.7", d1b), a);
  assert.match(a, /^[0-9a-f]{64}$/);
  ok("ipHash: deterministic within a day");

  assert.notEqual(vu.ipHashFor("198.51.100.7", d2), a);
  assert.notEqual(vu.ipHashFor("198.51.100.8", d1), a);
  ok("ipHash: rotates across days, differs across IPs");

  const saved = process.env.VERIFY_IP_SALT;
  delete process.env.VERIFY_IP_SALT;
  assert.equal(vu.verifyIpSalt(), null);
  assert.throws(() => vu.ipHashFor("198.51.100.7"), /VERIFY_IP_SALT/);
  process.env.VERIFY_IP_SALT = saved;
  ok("ipHash: salt REQUIRED — no weaker fallback form exists");
}

// ---- §1 named-global counter: isolation from the registry bucket ----------

{
  resetRegistryAbuseState();
  const OPTS = { capacity: 3, refillPerMs: 0, globalName: "vu-test", globalCapacity: 10, globalRefillPerMs: 0 };

  // Per-IP burst: 3 tokens, then 429 for THAT ip only.
  assert.equal(consumeBudget("vu-surface", "10.0.0.1", OPTS), true);
  assert.equal(consumeBudget("vu-surface", "10.0.0.1", OPTS), true);
  assert.equal(consumeBudget("vu-surface", "10.0.0.1", OPTS), true);
  assert.equal(consumeBudget("vu-surface", "10.0.0.1", OPTS), false);
  ok("named-global budget: per-IP burst 3 then refusal");

  // Named global cap 10: 3 spent above; ips 2+3 spend 3 each (9 total), ip4
  // gets exactly one more, then the NAMED counter (not its per-IP) refuses.
  for (const ip of ["10.0.0.2", "10.0.0.3"]) {
    for (let i = 0; i < 3; i++) assert.equal(consumeBudget("vu-surface", ip, OPTS), true);
  }
  assert.equal(consumeBudget("vu-surface", "10.0.0.4", OPTS), true);
  assert.equal(consumeBudget("vu-surface", "10.0.0.4", OPTS), false);
  ok("named-global budget: surface-total cap enforced across IPs");

  // ISOLATION: the registry-outbound global bucket is untouched — the same
  // "exhausted" IPs still hold full registry budgets.
  assert.equal(consumeRegistryBudget("10.0.0.1"), true);
  assert.equal(consumeRegistryBudget("10.0.0.4"), true);
  ok("named-global budget: registry per-IP + global buckets unaffected");
  resetRegistryAbuseState();
}

// ---- §1 route gates (411/413/415/429/503 persist NOTHING) ------------------

// Duck-typed request: the handler touches only headers/formData. Every case
// uses the mock-mode x-registry-test-ip override for a distinct bucket.
function req({ ip, contentLength, form }) {
  const headers = new Headers({ "x-registry-test-ip": ip });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { headers, formData: async () => form };
}

function formWith(bytes, name, derived) {
  const fd = new FormData();
  fd.set("file", new File([bytes], name, { type: "application/octet-stream" }));
  if (derived) fd.set("derived", new File([derived], "derived.jpg", { type: "image/jpeg" }));
  return fd;
}

function persistedCount() {
  try {
    return fs.readdirSync(UPLOAD_DIR).length;
  } catch {
    return 0;
  }
}

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();

  // 411 — missing Content-Length, BEFORE any body read (formData would throw).
  const r411 = await POST({ headers: new Headers({ "x-registry-test-ip": "ip-a" }), formData: async () => { throw new Error("body must not be read"); } });
  assert.equal(r411.status, 411);
  ok("route: missing Content-Length => 411 before body read");

  // 413 — declared oversize, still before body read.
  const r413 = await POST({ headers: new Headers({ "x-registry-test-ip": "ip-a", "content-length": String(11 * 1024 * 1024) }), formData: async () => { throw new Error("body must not be read"); } });
  assert.equal(r413.status, 413);
  ok("route: Content-Length > 10 MB => 413 before body read");

  // 429 — the budget gate sits FIRST: ip-a already spent 2; one more passes,
  // the fourth request refuses regardless of its (missing) length header.
  const r3 = await POST(req({ ip: "ip-a", form: formWith(PDF_BYTES, "x.pdf") }));
  assert.equal(r3.status, 411);
  const r429 = await POST(req({ ip: "ip-a", contentLength: 100, form: formWith(PDF_BYTES, "x.pdf") }));
  assert.equal(r429.status, 429);
  assert.equal(r429.headers.get("retry-after"), "20");
  ok("route: 4th rapid upload from one IP => 429 (budget gate first)");

  // 415 — HTML bytes named .jpg: the magic sniff, not the name, decides.
  const r415 = await POST(req({ ip: "ip-b", contentLength: HTML_BYTES.length, form: formWith(HTML_BYTES, "cert.jpg") }));
  assert.equal(r415.status, 415);
  ok("route: mislabeled HTML => 415 (sniffed magic, not extension)");

  // Per-part cap — a lying small Content-Length with an oversize actual part.
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
  const rPart = await POST(req({ ip: "ip-c", contentLength: 100, form: formWith(big, "big.pdf") }));
  assert.equal(rPart.status, 413);
  ok("route: per-part re-check catches an oversize original behind a lying header");

  // 503 disk floor — refusal audited, NOTHING persisted.
  vu.__setTestDiskFree(1024 * 1024 * 1024); // 1 GB < 2 GB floor
  const r503 = await POST(req({ ip: "ip-d", contentLength: PDF_BYTES.length, form: formWith(PDF_BYTES, "x.pdf") }));
  assert.equal(r503.status, 503);
  assert.equal(persistedCount(), 0);
  const refusal = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(refusal.reason, "disk-floor");
  assert.equal(refusal.outcome, "refused");
  assert.equal(typeof refusal.bytesFree, "number");
  vu.__setTestDiskFree(undefined);
  ok("route: disk floor => 503 + bytes-free refusal event, no file");

  // 503 daily quota — plain refusal, nothing persisted, nothing audited extra.
  vu.__setTestQuotaBytes(vu.DAILY_BYTE_QUOTA);
  const rQuota = await POST(req({ ip: "ip-e", contentLength: PDF_BYTES.length, form: formWith(PDF_BYTES, "x.pdf") }));
  assert.equal(rQuota.status, 503);
  assert.equal(persistedCount(), 0);
  vu.__resetVerifyUploadState();
  ok("route: daily corpus quota => 503, no file");

  // All refusals above persisted NOTHING.
  assert.equal(persistedCount(), 0);
  ok("route: 411/413/415/429/503 persisted nothing");
}

// ---- §2 persistence trio + PII-free chain core -----------------------------

{
  const RAW_IP = "203.0.113.77";
  const ORIG_NAME = "SECRET-ORIGINAL-NAME-cert.pdf";
  const before = registryJournal().length;

  const res = await POST(req({ ip: RAW_IP, contentLength: PDF_BYTES.length, form: formWith(PDF_BYTES, ORIG_NAME) }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.phase, "completed"); // PDF, no derived: no worker, fast settle
  assert.equal(body.ok, false);
  assert.ok(body.itemId, "itemId returned");
  ok("route: accepted PDF => 200 { ok:false, phase:'completed', itemId } (guided fallback)");

  // (a) original bytes under <uuid>.<ext-from-magic>
  const stored = path.join(UPLOAD_DIR, `${body.itemId}.pdf`);
  assert.ok(fs.existsSync(stored));
  assert.deepEqual(fs.readFileSync(stored), PDF_BYTES);
  ok("persist: original bytes stored as <uuid>.pdf (ext from magic, not origName)");

  // (b) sidecar holds the deletable detail (origName lives HERE).
  const sidecar = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${body.itemId}.json`), "utf-8"));
  assert.equal(sidecar.origName, ORIG_NAME);
  assert.equal(sidecar.phase, "completed");
  // Label honesty: NOTHING was ever dispatched for this plain PDF — that is
  // "no-candidates" ("all-failed" is reserved for tried-and-missed).
  assert.equal(sidecar.outcome, "no-candidates");
  assert.equal(sidecar.sha256Original, crypto.createHash("sha256").update(PDF_BYTES).digest("hex"));
  ok("persist: sidecar carries origName + sha256 + settled phase");

  // (c) two-phase chain events, PII-FREE core.
  const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n");
  const mine = lines.map((l) => JSON.parse(l)).filter((e) => e.itemId === body.itemId);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].phase, "received");
  assert.equal(mine[0].outcome, "pending");
  assert.equal(mine[1].phase, "completed");
  ok("persist: two-phase received → completed chain events");

  const raw = fs.readFileSync(EVENTS_PATH, "utf-8");
  assert.ok(!raw.includes("SECRET-ORIGINAL-NAME"), "chain never contains origName");
  assert.ok(!raw.includes(RAW_IP), "chain never contains the raw IP");
  assert.equal(mine[0].ipHash, vu.ipHashFor(RAW_IP));
  ok("chain core: no origName, no raw IP — date-rotated ipHash only");

  assert.deepEqual(verifyAuditChain("verify-uploads"), { ok: true, brokenAt: null });
  ok("chain: verifyAuditChain green over refusal + two-phase events");

  // §5 safety: a foreign/unreadable doc made ZERO registry fetches.
  assert.equal(registryJournal().length, before);
  ok("no candidates => ZERO registry calls (journal unchanged)");
}

// ---- §2 tail-hash cache: parity + external-append staleness guard ---------

{
  // Cached appends chain correctly...
  await appendAudit("verify-uploads", { id: "t-cache-1", at: new Date().toISOString(), probe: 1 }, AUDIT_NO_IMPERSONATION);
  await appendAudit("verify-uploads", { id: "t-cache-2", at: new Date().toISOString(), probe: 2 }, AUDIT_NO_IMPERSONATION);
  assert.deepEqual(verifyAuditChain("verify-uploads"), { ok: true, brokenAt: null });
  ok("tail cache: consecutive cached appends keep the chain green");

  // ...and an EXTERNAL append (size change) drops the cache: the next
  // appendAudit must chain onto the foreign line, not the stale cached hash.
  const lines = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  const core = { at: new Date().toISOString(), ext: true, id: "t-external" };
  const stable = JSON.stringify(core, Object.keys(core).sort());
  const hash = crypto.createHash("sha256").update(`${last.hash}|${stable}`).digest("hex");
  fs.appendFileSync(EVENTS_PATH, JSON.stringify({ ...core, prevHash: last.hash, hash }) + "\n", "utf-8");

  await appendAudit("verify-uploads", { id: "t-cache-3", at: new Date().toISOString(), probe: 3 }, AUDIT_NO_IMPERSONATION);
  const after = fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(after.at(-1).prevHash, hash, "chained onto the external line, not the stale cache");
  assert.deepEqual(verifyAuditChain("verify-uploads"), { ok: true, brokenAt: null });
  ok("tail cache: fs.stat staleness guard picks up an external append");
}

// ---- §3 compress: forceJpeg always-JPEG + MIN_GAIN bypass (DOM stubs) ------

{
  // Minimal browser shims for the pure-canvas pipeline.
  const JPEG_BLOB_BYTES = new Uint8Array(2000); // BIGGER than the original → MIN_GAIN discards
  globalThis.window = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 400, height: 300, close() {} });
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (cb) => cb(new Blob([JPEG_BLOB_BYTES], { type: "image/jpeg" })),
    }),
  };
  const { compressImage } = await import("@/lib/compress");

  const png = new File([new Uint8Array(1000)], "scan.png", { type: "image/png" });

  const classic = await compressImage(png);
  assert.equal(classic.compressed, false);
  assert.equal(classic.file, png);
  ok("compress: classic path keeps MIN_GAIN (bigger re-encode discarded)");

  const forced = await compressImage(png, { forceJpeg: true });
  assert.equal(forced.compressed, true);
  assert.equal(forced.file.type, "image/jpeg");
  assert.equal(forced.file.name, "scan.jpg");
  assert.equal(forced.compressedSize, JPEG_BLOB_BYTES.length);
  ok("compress: forceJpeg bypasses MIN_GAIN — PNG always yields a JPEG derived part");

  // HEIC detection: now a raster candidate; a browser that cannot decode it
  // (createImageBitmap throws) degrades to the untouched original.
  globalThis.createImageBitmap = async () => {
    throw new Error("no HEIC decoder");
  };
  const heic = new File([HEIC_BYTES], "photo.heic", { type: "image/heic" });
  const heicOut = await compressImage(heic, { forceJpeg: true });
  assert.equal(heicOut.compressed, false);
  assert.equal(heicOut.file, heic);
  ok("compress: HEIC attempted (detected) but decode failure degrades to original");

  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.createImageBitmap;
}

// ---- pdf-verify plan B3–B5: UA-MARAD keyword-gated planner + enrichment -----

{
  // Synthetic OCR text mirroring the REAL incident scan's eng-tesseract read
  // (B3 gate 2026-08-24): keywords survive, the printed "№ 12345/2024"
  // renders as the OBSERVED mangled form "NE 12345/2024" (№ → separate "NE"
  // token, slash intact), issue + expiry dates survive.
  const UA_OCR =
    "UKRAINE ENDORSEMENT ATTESTING THE ISSUE OF A CERTIFICATE " +
    "The Government of Ukraine certifies that Certificate NE 12345/2024 has been issued " +
    "Authorized official of the Shipping Administration " +
    "Endorsement NE 12345/2024, issued on 25.10.2024 limitations indicated until 20.10.2029";

  assert.deepEqual(keywordCountries(UA_OCR), ["UA-MARAD"], "single-country keyword lock");
  const ua = planBareCodeCandidates(UA_OCR);
  assert.equal(ua.length, 2, "exactly two UA-MARAD candidates (doctype fan-out)");
  assert.deepEqual(
    ua.map((c) => [c.country, c.code, c.extraInputs?.doctype]),
    [
      ["UA-MARAD", "123452024", "71"],
      ["UA-MARAD", "123452024", "70"],
    ],
    "71 (endorsement, real validity) before 70 (CoC)"
  );
  assert.ok(
    ua.every((c) => c.extraInputs?.issuedOn === "2024-10-25"),
    "year-anchored issue date extracted (25.10.2024, not the 2029 expiry)"
  );
  ok("planner: B3-gate synthetic UA text -> lock + 2 candidates 71→70 + issuedOn 2024-10-25");

  // Date-shaped tokens are NOT candidates: normalized dd.mm.yyyy is always 8
  // digits; ocrCodePattern's minimum match is 9 (5+4).
  assert.ok(
    !ua.some((c) => c.code === "25102024" || c.code === "20102029"),
    "date tokens rejected by the 9-digit minimum"
  );
  // ...and the keyword lock keeps the 8-digit date shapes away from DK too.
  assert.ok(!ua.some((c) => c.country === "DK"), "lock suppresses the DK 8-digit date shape");
  ok("planner: date-shaped tokens never become candidates (pattern min-length + lock)");

  // A DK-shaped 8-digit token on NON-UA text still routes to DK, never
  // UA-MARAD (the ocrCodePattern is dead without a UA keyword hit).
  const dk = planBareCodeCandidates("certificate number 12345678 valid until 2030");
  assert.deepEqual(dk, [{ country: "DK", code: "12345678" }]);
  ok("planner: ocrCodePattern is keyword-gated — DK text never yields UA-MARAD");

  // TWO ocrCodePattern-matching tokens -> exactly 2 candidates, BOTH from the
  // FIRST token only (first-token dedupe before fan-out).
  const two = planBareCodeCandidates(
    "GOVERNMENT OF UKRAINE Certificate NE 12345/2024 second number 44444/2024 issued on 25.10.2024"
  );
  assert.equal(two.length, 2);
  assert.ok(two.every((c) => c.country === "UA-MARAD" && c.code === "123452024"),
    "both candidates carry the FIRST token; the second token is dropped");
  ok("planner: two matching tokens -> fan-out of the FIRST token only");

  // Calendar validation: 31.02.2024 would silently roll over in ocr-parse
  // iso(); the enrichment discards it -> candidate WITHOUT extraInputs (and
  // no doctype fan-out), the honest needs-inputs degraded path.
  const badDate = planBareCodeCandidates(
    "GOVERNMENT OF UKRAINE Certificate NE 12345/2024 issued on 31.02.2024"
  );
  assert.equal(badDate.length, 1);
  assert.equal(badDate[0].country, "UA-MARAD");
  assert.equal(badDate[0].extraInputs, undefined, "rolled-over calendar date rejected");
  ok("planner: impossible calendar date (31.02) discarded — no extraInputs, no fan-out");

  // Post-enrichment cap re-slice: mixed-country keywords (lock disabled), the
  // UA token fans out 71/70 -> total candidates stay <= MAX_ANON_CANDIDATES,
  // UA-MARAD candidates <= 2.
  const mixed = planBareCodeCandidates(
    "GOVERNMENT OF UKRAINE SHIPPING ADMINISTRATION and DANISH MARITIME AUTHORITY " +
      "Certificate NE 12345/2024 issued on 25.10.2024 also DK no. 87654321"
  );
  assert.ok(mixed.length <= MAX_ANON_CANDIDATES, `cap holds (got ${mixed.length})`);
  assert.equal(mixed.filter((c) => c.country === "UA-MARAD").length, 2);
  assert.ok(mixed.some((c) => c.country === "DK"), "coexisting DK candidate survives the re-slice");
  ok("planner: post-enrichment cap re-slice — fan-out never exceeds the ≤3 cap");
}

// ---- az-adapter plan B1/B5: AZ raw-token planner + DOB enrichment -----------

{
  // Synthetic OCR text mirroring the REAL sample's B2-gate read (2026-08-24):
  // both keywords survive verbatim, the raw token keeps its slash, the DOB
  // prints on BOTH cert sides (one image) — twice, same value.
  const AZ_OCR =
    "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY " +
    "Certificate of Competency No 000730/24 Date of Birth 18.05.1992 " +
    "issued 29.07.2024 second side No 000730/24 Date of Birth 18.05.1992";

  assert.deepEqual(keywordCountries(AZ_OCR), ["AZ"], "single-country keyword lock");
  const az = planBareCodeCandidates(AZ_OCR);
  assert.deepEqual(
    az,
    [{ country: "AZ", code: "00073024", extraInputs: { dob: "1992-05-18" } }],
    "EXACTLY one AZ candidate: normalized code + the one distinct DOB"
  );
  ok("planner: B2-gate synthetic AZ text -> lock + 1 candidate 00073024 + dob 1992-05-18 (twice-printed DOB counts ONCE)");

  // Decision-1 pin: dates print with DOTS — raw form has no slash, normalized
  // form has no slash either -> date tokens can NEVER become AZ candidates.
  assert.ok(
    !az.some((c) => c.code === "29072024" || c.code === "18051992"),
    "date tokens are never AZ candidates (raw slash anchor)"
  );
  // ...and an AZ-keyword doc with a bare 8-digit token (no slash) plans
  // NOTHING: the raw pattern demands the slash, the keyword lock suppresses
  // DK — the blank-failure-audit "AZ keywords, no code token" row.
  const azNoToken = planBareCodeCandidates(
    "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY number 12345678"
  );
  assert.deepEqual(azNoToken, [], "8-digit non-slash token under AZ lock -> no candidates");
  assert.equal(
    vu.dispatchSkipReasonFor("REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY number 12345678", 0),
    "no-country-match",
    "AZ is auto -> the label is no-country-match, never keyword-locked-manual"
  );
  ok("planner: dates + bare 8-digit shapes never become AZ candidates (Decision 1)");

  // DK text stays DK: the AZ ocrCodePattern is dead without AZ keywords, and
  // an 8-digit DK-band token routes to DK exactly as before.
  const dk = planBareCodeCandidates("certificate number 12345678 valid until 2030");
  assert.deepEqual(dk, [{ country: "DK", code: "12345678" }]);
  assert.ok(!dk.some((c) => c.country === "AZ"), "DK text never yields AZ");
  ok("planner: raw-token seam is keyword-gated — DK band untouched");

  // UA raw-test no-op pin: the UA-MARAD raw token CONTAINS a slash and its
  // ocrCodePattern (normalized digits) must not fire on the raw form — the
  // UA candidate keeps flowing through the NORMALIZED test unchanged.
  const ua = planBareCodeCandidates(
    "GOVERNMENT OF UKRAINE SHIPPING ADMINISTRATION Certificate NE 12345/2024 issued on 25.10.2024"
  );
  assert.equal(ua.length, 2);
  assert.ok(ua.every((c) => c.country === "UA-MARAD" && c.code === "123452024"),
    "UA behavior byte-identical under the raw-token seam");
  ok("planner: UA-MARAD no-op pin — the raw-token seam changes nothing for UA");

  // ---- enrichAZCandidates DOB rule matrix (Decision 2) --------------------
  const cand = [{ country: "AZ", code: "00073024" }]; // suffix 24 -> issueYear 2024, cutoff 2009
  const enrich = (text) => enrichAZCandidates(cand, text)[0];

  assert.deepEqual(enrich("Date of Birth 18.05.1992").extraInputs, { dob: "1992-05-18" },
    "exactly one qualifying date -> dob");
  assert.deepEqual(enrich("18.05.1992 and again 18.05.1992").extraInputs, { dob: "1992-05-18" },
    "duplicate prints of ONE value count once (distinct-ISO rule)");
  assert.equal(enrich("18.05.1992 but also 03.11.1988").extraInputs, undefined,
    "two DISTINCT qualifying dates -> ambiguous -> none");
  assert.equal(enrich("issued 29.07.2024 expires 29.07.2029").extraInputs, undefined,
    "only recent dates (> cutoff) -> none");
  assert.equal(enrich("31.02.1992").extraInputs, undefined,
    "impossible calendar date rejected (no iso() rollover)");
  assert.deepEqual(enrich("05.06.1975").extraInputs, { dob: "1975-06-05" },
    "19xx century accepted (UA's 20xx anchor would drop it)");
  // B2-gate licensed tokenization fix: ':' is a separator (observed form).
  assert.deepEqual(enrich("Date of Birth 18:05.1992").extraInputs, { dob: "1992-05-18" },
    "colon separator accepted (real-OCR observed form)");
  assert.equal(enrich("Date of Birth 18:05.3992").extraInputs, undefined,
    "the gate's ACTUAL misread (year 1992->3992) stays out — digit guessing rejected");
  ok("enrichAZCandidates: DOB matrix — distinct-exactly-one, calendar-validated, both centuries, colon tolerance");

  // First-token dedupe: two AZ candidates in, ONE out (never fans out).
  const deduped = enrichAZCandidates(
    [
      { country: "AZ", code: "00073024" },
      { country: "AZ", code: "11111124" },
    ],
    "18.05.1992"
  );
  assert.deepEqual(deduped, [{ country: "AZ", code: "00073024", extraInputs: { dob: "1992-05-18" } }]);
  ok("enrichAZCandidates: first-token dedupe — at most ONE AZ candidate ever leaves the planner");

  // ---- Paired divergence pins (B5.4) — a "unification" refactor must fail --
  // AZ-suite side: UA's rule on a UA shape is EARLIEST-WINS year-anchored
  // (deterministic issue date), NOT distinct-exactly-one.
  const uaPair = enrichUAMARADCandidates(
    [{ country: "UA-MARAD", code: "123452024" }],
    "issued 25.10.2024 or maybe 07.03.2024"
  );
  assert.equal(uaPair[0].extraInputs?.issuedOn, "2024-03-07",
    "UA picks the EARLIEST year-anchored date even with two distinct candidates");
  assert.equal(uaPair.length, 2, "UA fans out doctypes; AZ never does");
  // UA-suite side: AZ's rule on an AZ shape defers on the SAME ambiguity.
  const azPair = enrichAZCandidates(
    [{ country: "AZ", code: "00073024" }],
    "25.10.1990 or maybe 07.03.1991"
  );
  assert.equal(azPair[0].extraInputs, undefined,
    "AZ defers to the user on two distinct qualifying dates — never guesses");
  assert.equal(azPair.length, 1);
  ok("divergence pins: UA earliest-wins vs AZ exactly-one-distinct — unifying the helpers breaks here loudly");
}

// ---- pdf-verify plan Decision 8: skipReason / dispatchSkipReason units ------

{
  assert.equal(vu.eligibilitySkipReason("heic"), "heic-no-derived");
  assert.equal(vu.eligibilitySkipReason("jpeg"), "pixel-limit", "raster type only skips when over the pixel gate");
  assert.equal(vu.eligibilitySkipReason("pdf"), "unsupported-type",
    "function-level fallback — the pipeline never calls this for pdf (PDFs get a workerPath)");
  ok("skipReason matrix: heic-no-derived / pixel-limit / unsupported-type");

  // Planning-yielded-nothing labels.
  const FOREIGN = "REPUBLIC OF THE PHILIPPINES MARITIME INDUSTRY AUTHORITY CERT 1234567";
  assert.equal(vu.dispatchSkipReasonFor(FOREIGN, 0), "no-country-match");
  const LV = "Latvijas Republika Izdevejiestade: Latvijas Jurnieku registrs";
  assert.deepEqual(keywordCountries(LV), ["LV"]);
  assert.equal(vu.dispatchSkipReasonFor(LV, 0), "keyword-locked-manual",
    "keyword-locked non-auto country");
  assert.equal(vu.dispatchSkipReasonFor("", 0), null, "no OCR text -> extraction label territory, not dispatch");
  assert.equal(vu.dispatchSkipReasonFor(FOREIGN, 2), null, "candidates planned -> no label");
  // 2026-09-07 hint tier: a weak state-name hint with no backing slash token.
  assert.equal(vu.dispatchSkipReasonFor("UKRAINE certificate of proficiency", 0), "hint-no-token",
    "hint-only evidence, nothing planned");
  ok("dispatchSkipReason: no-country-match / keyword-locked-manual / hint-no-token / null cases");

  // Sidecar init literal carries the new fields (lockstep with the schema).
  const shaped = await vu.persistUpload({
    originalBuf: PDF_BYTES,
    sniffedType: "pdf",
    origName: "shape-check.pdf",
    derivedBuf: null,
    clientIp: "203.0.113.99",
  });
  const shapedSc = JSON.parse(
    fs.readFileSync(path.join(UPLOAD_DIR, `${shaped.itemId}.json`), "utf-8")
  );
  assert.ok("skipReason" in shapedSc.extraction, "init literal has skipReason");
  assert.equal(shapedSc.extraction.skipReason, null);
  assert.ok("dispatchSkipReason" in shapedSc.extraction, "init literal has dispatchSkipReason");
  assert.equal(shapedSc.extraction.dispatchSkipReason, null);
  ok("sidecar init literal: skipReason + dispatchSkipReason present and null");
}

// ---- 2026-09-07 UA hint tier: OCR-degraded strong keywords -> weak hint ------
//
// Incident (sidecar a533f540): a Ukrainian CoP PNG screenshot OCRed both
// strong UA-MARAD keywords into "GOVEMMENT OF UKRAINE" / "SHIPING
// ADVINISTATION" (no hit), so the planner sprayed the number at the UK/NO
// shape lanes. The bare state name "UKRAINE" survived → weak `hintKeywords`
// tier: ranks + activates ocrCodePattern (raw slash-form token required),
// NEVER locks, silenced by any strong hit.

{
  const FIXTURE = fs.readFileSync(
    new URL("./fixtures/registry/ua-marad/ocr-cop-degraded-2026-09-07.txt", import.meta.url),
    "utf-8"
  );
  const isUA = (c) => c.country === "UA-MARAD";

  // Table contract pins (the hint regex is built from these at module load).
  const uaEntry = COUNTRIES.find((c) => c.country === "UA-MARAD");
  assert.deepEqual(uaEntry.hintKeywords, ["UKRAINE"]);
  assert.equal(String(uaEntry.ocrCodeRawPattern), String(/^\d{5,8}\/20\d{2}$/));
  assert.ok(
    COUNTRIES.every((c) => (c.hintKeywords ?? []).every((h) => /^[A-Z ]+$/.test(h))),
    "every hint is uppercase letters + spaces (module-load assert contract)"
  );
  assert.ok(
    COUNTRIES.filter((c) => c.hintKeywords?.length).every((c) => c.country === "UA-MARAD"),
    "only UA-MARAD carries hints (the misfire surface is exactly one entry)"
  );
  ok("hint tier: table contract — UA-MARAD hintKeywords + ocrCodeRawPattern, hints uppercase-only");

  // Fixture guard (v3 T3): the hint tier is reachable ONLY through a RAW
  // slash-form token — fail loudly if the masked fixture ever drifts.
  const TOKEN_RE = /[A-Z0-9][A-Z0-9\-/.]{3,}[A-Z0-9]/g; // mirrors keywords.ts TOKEN_RE
  const rawSlash = (normalizeForKeywords(FIXTURE).match(TOKEN_RE) ?? []).filter((t) =>
    /^\d{5,8}\/20\d{2}$/.test(t)
  );
  assert.deepEqual(rawSlash, ["01234/2026"], "fixture carries exactly one raw slash-form token");
  assert.ok(FIXTURE.includes("SPECIMEN SEAFARER") && FIXTURE.includes("SPECIMEN OFFICIAL"),
    "fixture is the masked build (holder + signatory replaced)");
  const fxNorm = normalizeForKeywords(FIXTURE);
  assert.ok(fxNorm.includes("GOVEMMENT OF UKRAINE") && fxNorm.includes("SHIPING ADVINISTATION"),
    "the OCR-mangled strong strings are kept verbatim (document case; uppercase after normalize)");
  assert.ok(!fxNorm.includes("GOVERNMENT OF UKRAINE") && !fxNorm.includes("SHIPPING ADMINISTRATION"),
    "neither strong keyword survives — the hint tier is the only route");
  assert.equal(
    (normalizeForKeywords(FIXTURE).match(/\b\d{1,2}[.\-/]\d{1,2}[.\-/]2026\b/g) ?? []).length,
    0,
    "no synthetic dd.mm.2026 date (would fan out 71/70 and flip the fixture pin)"
  );
  ok("hint tier: fixture guard — one raw slash token, masked, mangled keywords verbatim, no 2026 date");

  // 1. Mangled strong strings → hint only.
  const MANGLED = "GOVEMMENT OF UKRAINE certifies that ... SHIPING ADVINISTATION";
  assert.deepEqual(keywordEvidence(MANGLED), { strong: [], hint: ["UA-MARAD"] });
  assert.deepEqual(keywordCountries(MANGLED), ["UA-MARAD"]);
  assert.deepEqual(keywordEvidence(""), { strong: [], hint: [] });
  ok("hint tier: OCR-mangled authority lines -> strong empty, hint UA-MARAD; keywordCountries falls to the hint");

  // 2. Word boundary on the normalized text.
  assert.deepEqual(keywordEvidence("NATIONALITY: UKRAINIAN"), { strong: [], hint: [] });
  assert.deepEqual(keywordEvidence("UKRAINE,").hint, ["UA-MARAD"]);
  assert.deepEqual(keywordEvidence("... of UKRAINE\n").hint, ["UA-MARAD"]);
  assert.deepEqual(keywordEvidence("holder nationality ukraine").hint, ["UA-MARAD"], "case-folded by normalize");
  ok("hint tier: word boundary — UKRAINIAN never hits, 'UKRAINE,' / 'of UKRAINE\\n' do");

  // 3. Any strong hit silences ALL hints.
  assert.deepEqual(keywordCountries("MARITIME AND COASTGUARD AGENCY nationality UKRAINE"), ["UK"]);
  assert.deepEqual(keywordEvidence("MARITIME AND COASTGUARD AGENCY nationality UKRAINE"),
    { strong: ["UK"], hint: ["UA-MARAD"] }, "evidence keeps both; consumers weigh them");
  assert.deepEqual(
    planBareCodeCandidates("MARITIME AND COASTGUARD AGENCY nationality UKRAINE CoC0089297"),
    [{ country: "UK", code: "COC0089297" }],
    "UK strong lock stands; the hint adds nothing"
  );
  ok("hint tier: strong beats hint — UK CoC naming UKRAINE as nationality stays a UK lock");

  // 4. A hint never locks: the DK shape candidate survives.
  assert.deepEqual(planBareCodeCandidates("UKRAINE certificate 87654321"),
    [{ country: "DK", code: "87654321" }]);
  ok("hint tier: hints never lock — DK 8-digit shape under a UKRAINE hint still routes to DK, no UA-MARAD");

  // 5. Raw gate: hint-only activation needs the printed slash form on the RAW token.
  const PANAMA = "REPUBLIC OF PANAMA certificate Nationality: UKRAINIAN No 123456-2026";
  assert.deepEqual(keywordEvidence(PANAMA).hint, []);
  assert.ok(!planBareCodeCandidates(PANAMA).some(isUA), "UKRAINIAN: no hint, no UA candidate");
  const noSlash = planBareCodeCandidates("UKRAINE certificate 1234562026");
  assert.ok(!noSlash.some(isUA), "slash-less 10-digit run: raw gate rejects UA");
  assert.deepEqual(noSlash, [{ country: "NO", code: "1234562026" }], "NO shape row stays (fan-out kept)");
  const slash = planBareCodeCandidates("UKRAINE certificate No 12345/2026");
  assert.deepEqual(slash, [
    { country: "UA-MARAD", code: "123452026" },
    { country: "UK", code: "123452026" },
  ], "slash form: UA-MARAD first (hint ranks), UK 9-digit shape follows");
  ok("hint tier: raw gate — UKRAINIAN/no-slash/10-digit never reach UA-MARAD; NNNNN/20YY does, ranked first");

  // 6. The incident fixture (pinned to the planner's ACTUAL output, first run 2026-09-07).
  assert.deepEqual(keywordEvidence(FIXTURE), { strong: [], hint: ["UA-MARAD"] });
  const fx = planBareCodeCandidates(FIXTURE);
  assert.deepEqual(fx, [
    { country: "UA-MARAD", code: "012342026" },
    { country: "UK", code: "012342026" },
    { country: "NO", code: "0123472026" },
  ], "exact emitted list: UA-MARAD (slash read) first, UK 9-digit, NO 10-digit (second read)");
  assert.ok(fx.length <= MAX_ANON_CANDIDATES);
  assert.equal(fx.filter(isUA).length, 1, "exactly one UA-MARAD row (no 71/70 fan-out: dates garbled)");
  assert.equal(fx[0].extraInputs, undefined, "no extraInputs — the honest needs-inputs path");
  assert.equal(fx.filter((c) => c.country === "DK").length, 0, "DK rows pinned: 0");
  assert.equal(vu.countryDetectedFrom(keywordEvidence(FIXTURE), fx), "UA-MARAD",
    "hint attributes the country because it produced a candidate");
  ok("hint tier: incident fixture -> [UA-MARAD 012342026, UK 012342026, NO 0123472026], UA first, no fan-out");

  // A1: noun-form nationality with a non-slash token → no attribution.
  const NOUN = "Nationality: UKRAINE No 123456789";
  assert.deepEqual(keywordCountries(NOUN), ["UA-MARAD"]);
  const nounPlan = planBareCodeCandidates(NOUN);
  assert.deepEqual(nounPlan, [{ country: "UK", code: "123456789" }], "UK shape only, no UA-MARAD");
  assert.equal(vu.countryDetectedFrom(keywordEvidence(NOUN), nounPlan), null,
    "a hint that produced no candidate attributes nothing (as before the hint tier)");
  assert.equal(vu.countryDetectedFrom({ strong: ["UK"], hint: ["UA-MARAD"] }, []), "UK",
    "strong attributes outright, candidates or not");
  assert.equal(vu.countryDetectedFrom({ strong: [], hint: [] }, [{ country: "DK", code: "87654321" }]), null);
  ok("hint tier: countryDetectedFrom — strong outright; hint only when it planned a candidate; noun-form -> null");

  // 7. Skip label.
  assert.equal(vu.dispatchSkipReasonFor("UKRAINE certificate of proficiency", 0), "hint-no-token");
  assert.equal(vu.dispatchSkipReasonFor("Latvijas Republika Izdevejiestade: Latvijas Jurnieku registrs", 0),
    "keyword-locked-manual", "strong non-auto lock label unchanged");
  assert.equal(vu.dispatchSkipReasonFor(FIXTURE, 3), null);
  assert.equal(vu.dispatchSkipReasonFor(NOUN, 1), null, "something planned -> no label");
  ok("hint tier: dispatchSkipReasonFor — hint-no-token / keyword-locked-manual / null");
}

console.log(`\nverify-upload-units.test: ${pass} assertions passed`);
