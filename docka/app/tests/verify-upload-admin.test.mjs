// Unit + integration tests for wave 3 of the anonymous verify-upload plan
// (§7 admin surface + its §8 rows): Content-Disposition sanitization matrix
// (CRLF / zero-width / RTL-override / path), polyglot bytes served with the
// SNIFFED Content-Type + nosniff, per-item delete (tombstone event + files
// gone), delete racing a queued re-run (no resurrection, "deleted-during-run"
// recorded), and re-run on a deferred item completing through the
// REGISTRY_MOCK adapter seam — NO live registry call is ever made (asserted
// via the journal).
//
// Follows the verify-upload-units.test.mjs pattern: plain node + the `@/*`
// alias hook, synthetic fixtures, deterministic. The auth-gated HTTP routes
// are deliberately NOT imported (they would pull the Next/auth runtime); every
// correctness rule they serve lives in lib/verify-upload-admin +
// lib/verify-upload and is exercised here directly.
//
// Run: node --import ./tests/_register-alias.mjs tests/verify-upload-admin.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode + salt BEFORE any @/lib import.
process.env.REGISTRY_MOCK = "1";
process.env.VERIFY_IP_SALT = "unit-test-salt";

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-verify-upload-admin-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { registryJournal, resetRegistryAbuseState, __setTestAdapter } = await import("@/lib/registry");
const { verifyAuditChain } = await import("@/lib/db");
const vu = await import("@/lib/verify-upload");
const admin = await import("@/lib/verify-upload-admin");

const UPLOAD_DIR = path.join(TMP, "data", "verify-uploads");
const EVENTS_PATH = path.join(TMP, "data", "verify-upload-events.ndjson");

const journalBaseline = registryJournal().length;

// ---- Fixtures ---------------------------------------------------------------

function gifWithDims(width, height) {
  const b = Buffer.alloc(20);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpegWithSof(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

/** PDF bytes with an embedded EE registry URL — detectCodeFromFile finds it. */
function pdfWithEmbeddedCode(code) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /URI (https://meremees.transpordiamet.ee/kompetents/${code}) >>\nendobj\ntrailer\n%%EOF\n`,
    "latin1"
  );
}

const PLAIN_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n", "latin1");

// Complete VerifiedCert shape (registry-units.test.mjs factory).
const mkCert = (over = {}) => ({
  ok: true,
  code: "1234567890",
  docCategory: "competency",
  hasName: true,
  fullName: "JOHN SMITH",
  firstName: "JOHN",
  lastName: "SMITH",
  title: "Certificate of competency",
  personalCode: "",
  birthDate: "1990-01-01T00:00:00+00:00",
  status: "valid",
  isValid: true,
  issuedOn: "",
  validUntil: "2027-01-01T00:00:00+00:00",
  certificateType: "CoC",
  issuerCountry: "UK",
  institution: "",
  documentType: "",
  sourceUrl: "",
  registryCountry: "UK",
  keyTrust: "public-identifier",
  verifiedSource: "government",
  ...over,
});

async function persist(buf, origName, derivedBuf = null) {
  const sniffed = vu.sniffMagic(buf);
  assert.ok(sniffed, `fixture must sniff (${origName})`);
  return vu.persistUpload({
    originalBuf: buf,
    sniffedType: sniffed,
    origName,
    derivedBuf,
    clientIp: "203.0.113.9",
  });
}

function chainEvents() {
  return fs
    .readFileSync(EVENTS_PATH, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function editSidecar(itemId, mutate) {
  const p = path.join(UPLOAD_DIR, `${itemId}.json`);
  const sc = JSON.parse(fs.readFileSync(p, "utf-8"));
  mutate(sc);
  fs.writeFileSync(p, JSON.stringify(sc, null, 2), "utf-8");
}

// ---- §7 item-id gate ---------------------------------------------------------

{
  assert.equal(admin.isSafeItemId("6f9619ff-8b86-4d01-b42d-00cf4fc964ff"), true);
  assert.equal(admin.isSafeItemId("../../etc/passwd"), false);
  assert.equal(admin.isSafeItemId("6f9619ff-8b86-4d01-b42d-00cf4fc964ff.json"), false);
  assert.equal(admin.isSafeItemId(""), false);
  assert.equal(admin.isSafeItemId("..%2f..%2fdb"), false);
  ok("isSafeItemId: UUIDs only — traversal shapes refused before any fs touch");
}

// ---- §8 Content-Disposition sanitization matrix -------------------------------

{
  const s = admin.sanitizeDownloadName;

  // CRLF header splitting.
  const crlf = s("cert\r\nSet-Cookie: pwned=1.pdf", "fb");
  assert.ok(!crlf.includes("\r") && !crlf.includes("\n"));
  ok("sanitize: CRLF stripped (no header splitting)");

  // Zero-width characters (U+200B/C/D, U+2060, U+FEFF) — built by code point
  // so no invisible literal hides in this source file.
  const ZW = String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
  assert.equal(s(`cv${ZW}.pdf`, "fb"), "cv.pdf");
  ok("sanitize: zero-width characters stripped");

  // RTL override (U+202E) + the rest of the bidi controls (U+202A-E, isolates).
  const RTL = String.fromCharCode(0x202e);
  const BIDI = String.fromCharCode(0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2069);
  assert.equal(s(`annex${RTL}gpj.exe`, "fb"), "annexgpj.exe");
  assert.equal(s(`a${BIDI}b.pdf`, "fb"), "ab.pdf");
  ok("sanitize: RTL-override / bidi controls stripped");

  // Path separators + leading dots.
  const p = s("..\\..\\windows/system32/cert.pdf", "fb");
  assert.ok(!p.includes("/") && !p.includes("\\") && !p.startsWith("."));
  ok("sanitize: path separators stripped, no leading-dot names");

  // Header-quote safety + non-ASCII fold.
  assert.equal(s('my "cert" ü.pdf', "fb"), "my 'cert' .pdf");
  ok("sanitize: double quotes neutralized, non-ASCII removed");

  // Nothing left → the itemId-based fallback.
  assert.equal(s(`${RTL}${ZW}\r\n`, "item-fallback.bin"), "item-fallback.bin");
  assert.equal(s("", "item-fallback.bin"), "item-fallback.bin");
  assert.equal(s(null, "item-fallback.bin"), "item-fallback.bin");
  ok("sanitize: hostile-only / empty names fall back to the itemId name");
}

// ---- §8 polyglot served with SNIFFED Content-Type + nosniff --------------------

{
  // GIF magic + trailing HTML, client-named .html — the classic polyglot.
  const polyglot = Buffer.concat([gifWithDims(2, 2), Buffer.from("<script>alert(1)</script>", "latin1")]);
  const item = await persist(polyglot, "cert.html");

  const dl = admin.readOriginalForDownload(item.itemId);
  assert.ok(dl);
  assert.equal(dl.headers["Content-Type"], "image/gif"); // sniffed, never .html
  assert.equal(dl.headers["X-Content-Type-Options"], "nosniff");
  assert.match(dl.headers["Content-Disposition"], /^attachment; filename="cert\.html"$/);
  assert.deepEqual(dl.buf, polyglot);
  ok("download: GIF+HTML polyglot => image/gif from magic + nosniff (attachment)");

  const th = admin.readThumbnailSource(item.itemId);
  assert.equal(th.headers["Content-Type"], "image/gif");
  assert.equal(th.headers["X-Content-Type-Options"], "nosniff");
  assert.match(th.headers["Content-Disposition"], new RegExp(`^inline; filename="${item.itemId}\\.gif"$`));
  ok("thumbnail: no derived => original served, sniffed type + nosniff, itemId name");

  // With a derived JPEG the thumbnail serves (and sniffs) the derived bytes.
  const withDerived = await persist(PLAIN_PDF, "scan.pdf", jpegWithSof(4, 4));
  const th2 = admin.readThumbnailSource(withDerived.itemId);
  assert.equal(th2.headers["Content-Type"], "image/jpeg");
  assert.equal(th2.headers["X-Content-Type-Options"], "nosniff");
  ok("thumbnail: derived JPEG preferred and sniffed as image/jpeg");
}

// ---- §7 listing: newest first + per-country demand (incl. no-adapter) ----------

{
  const a = await persist(PLAIN_PDF, "a.pdf");
  const b = await persist(PLAIN_PDF, "b.pdf");
  editSidecar(a.itemId, (sc) => {
    sc.receivedAt = "2020-01-01T00:00:00.000Z"; // force oldest
    sc.countryDetected = "FI"; // keyword-mapped country with NO adapter
  });
  editSidecar(b.itemId, (sc) => {
    sc.countryDetected = "EE"; // wired adapter
  });

  const listing = admin.listVerifyUploads(0, 100);
  assert.ok(listing.total >= 4);
  assert.equal(listing.items.at(-1).itemId, a.itemId, "forced-oldest item sorts last");
  const at = listing.items.map((r) => r.receivedAt);
  assert.deepEqual(at, [...at].sort().reverse(), "receivedAt descending");
  ok("list: newest first (receivedAt desc), oldest forced item lands last");

  const fi = listing.demand.find((d) => d.country === "FI");
  const ee = listing.demand.find((d) => d.country === "EE");
  assert.equal(fi.count, 1);
  assert.equal(fi.hasAdapter, false);
  assert.equal(fi.countryName, "Finland");
  assert.equal(ee.count, 1);
  assert.equal(ee.hasAdapter, true);
  assert.ok(listing.undetected >= 2);
  ok("demand: per-country counts across the corpus, no-adapter countries included");

  // Pagination window.
  const page = admin.listVerifyUploads(1, 2);
  assert.equal(page.items.length, 2);
  assert.equal(page.total, listing.total);
  assert.equal(page.items[0].itemId, listing.items[1].itemId);
  ok("list: offset/limit paginate the same corpus-wide ordering");
}

// ---- §8 delete => tombstone event appended + files gone ------------------------

{
  const item = await persist(PLAIN_PDF, "todelete.pdf", jpegWithSof(4, 4));
  const orig = path.join(UPLOAD_DIR, `${item.itemId}.pdf`);
  const derived = path.join(UPLOAD_DIR, `${item.itemId}.derived.jpg`);
  const sidecar = path.join(UPLOAD_DIR, `${item.itemId}.json`);
  assert.ok(fs.existsSync(orig) && fs.existsSync(derived) && fs.existsSync(sidecar));

  const res = await admin.deleteVerifyUpload(item.itemId);
  assert.deepEqual(res, { ok: true });
  assert.ok(!fs.existsSync(orig) && !fs.existsSync(derived) && !fs.existsSync(sidecar));
  ok("delete: original + derived + sidecar removed");

  const tomb = chainEvents().at(-1);
  assert.equal(tomb.itemId, item.itemId);
  assert.equal(tomb.outcome, "deleted");
  assert.equal(tomb.phase, "deleted");
  assert.equal(tomb.tombstone, true);
  assert.equal(tomb.sha256Original, item.sidecar.sha256Original);
  ok("delete: tombstone event appended to the verify-uploads chain");

  assert.deepEqual(await admin.deleteVerifyUpload(item.itemId), { ok: false, reason: "not-found" });
  assert.deepEqual(await admin.deleteVerifyUpload("6f9619ff-8b86-4d01-b42d-00cf4fc964ff"), {
    ok: false,
    reason: "not-found",
  });
  ok("delete: idempotent — a second delete / unknown id reports not-found");
}

// ---- §8 re-run on a DEFERRED item completes (mock adapter, zero live calls) ----

{
  resetRegistryAbuseState();
  const CODE = "SAMPLE0SAFETY001";
  const item = await persist(pdfWithEmbeddedCode(CODE), "deferred.pdf");
  // Simulate the orphan sweep having settled it deferred (pm2 restart path).
  editSidecar(item.itemId, (sc) => {
    sc.phase = "deferred";
    sc.outcome = "deferred";
    sc.deferredReason = "orphaned-restart";
    sc.settledAt = new Date().toISOString();
  });

  let eeCalls = 0;
  __setTestAdapter("EE", async (inputs) => {
    eeCalls++;
    return {
      kind: "match-valid",
      cert: mkCert({
        registryCountry: "EE",
        issuerCountry: "EE",
        keyTrust: "capability-token",
        code: inputs.code,
        fullName: "JAAN TAMM",
      }),
    };
  });

  const res = await vu.rerunRecognition(item.itemId);
  assert.equal(res.status, "completed");
  assert.equal(res.outcome, "verified");
  assert.equal(eeCalls, 1);
  ok("re-run: deferred item completes through the mock EE adapter");

  const sc = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${item.itemId}.json`), "utf-8"));
  assert.equal(sc.phase, "completed");
  assert.equal(sc.outcome, "verified");
  assert.equal(sc.deferredReason, null);
  assert.equal(sc.retries.length, 1);
  assert.equal(sc.retries[0].outcome, "verified");
  assert.equal(sc.extraction.embeddedCode, CODE);
  assert.equal(sc.extraction.candidatesTried.at(-1).outcome, "verified");
  ok("re-run: attempt recorded in sidecar retries[], extraction refreshed");

  const ev = chainEvents().at(-1);
  assert.equal(ev.itemId, item.itemId);
  assert.equal(ev.phase, "completed");
  assert.equal(ev.outcome, "verified");
  assert.equal(ev.rerun, true);
  ok("re-run: rerun-flagged completed event appended to the chain");

  assert.deepEqual(await vu.rerunRecognition("6f9619ff-8b86-4d01-b42d-00cf4fc964ff"), {
    status: "not-found",
  });
  ok("re-run: unknown item => not-found (no chain noise)");

  __setTestAdapter("EE", undefined);
}

// ---- §8 delete racing a queued re-run: no resurrection -------------------------

{
  resetRegistryAbuseState();
  const CODE = "SAMPLE0SAFETY002"; // distinct code — dodges the 5-min result cache
  const item = await persist(pdfWithEmbeddedCode(CODE), "raced.pdf");
  const orig = path.join(UPLOAD_DIR, `${item.itemId}.pdf`);
  const sidecar = path.join(UPLOAD_DIR, `${item.itemId}.json`);

  // The adapter IS the race window: the admin delete lands while the re-run's
  // registry lookup is in flight, then the lookup "succeeds".
  __setTestAdapter("EE", async (inputs) => {
    await admin.deleteVerifyUpload(item.itemId);
    return {
      kind: "match-valid",
      cert: mkCert({ registryCountry: "EE", keyTrust: "capability-token", code: inputs.code }),
    };
  });

  const res = await vu.rerunRecognition(item.itemId);
  assert.deepEqual(res, { status: "deleted-during-run" });
  ok("race: re-run settles as deleted-during-run, verified result discarded");

  assert.ok(!fs.existsSync(sidecar), "sidecar NOT resurrected");
  assert.ok(!fs.existsSync(orig), "bytes NOT resurrected");
  assert.equal(fs.readdirSync(UPLOAD_DIR).filter((f) => f.startsWith(item.itemId)).length, 0);
  ok("race: nothing resurrected — no sidecar, no bytes");

  const evs = chainEvents().filter((e) => e.itemId === item.itemId);
  assert.equal(evs.at(-2).outcome, "deleted"); // the tombstone from the delete
  assert.equal(evs.at(-1).outcome, "deleted-during-run");
  assert.equal(evs.at(-1).phase, "deleted-during-run");
  assert.equal(evs.at(-1).rerun, true);
  ok("race: chain shows tombstone THEN deleted-during-run — fully reconstructable");

  __setTestAdapter("EE", undefined);
}

// ---- Chain + no-live-calls invariants over the whole file ----------------------

{
  assert.deepEqual(verifyAuditChain("verify-uploads"), { ok: true, brokenAt: null });
  ok("chain: verifyAuditChain green over persists + tombstones + re-run events");

  assert.equal(registryJournal().length, journalBaseline);
  ok("mock seam: ZERO live registry calls across every admin test");
}

// ---- pdf-verify plan A5: skipReason / dispatchSkipReason / lateResult ----------

{
  // extractionSummary renders the skipReason instead of a naked "—".
  const skipped = await persist(PLAIN_PDF, "enc.pdf");
  editSidecar(skipped.itemId, (sc) => {
    sc.extraction.skipReason = "pdf-encrypted";
  });
  const scSkip = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${skipped.itemId}.json`), "utf-8"));
  assert.equal(admin.extractionSummary(scSkip), "skip: pdf-encrypted");
  ok("extractionSummary: empty extraction + skipReason => 'skip: <reason>', never '—'");

  // PDF page meta + text-layer chars render in the summary.
  const pdfMeta = await persist(PLAIN_PDF, "meta.pdf");
  editSidecar(pdfMeta.itemId, (sc) => {
    sc.extraction.pages = 4;
    sc.extraction.pagesProcessed = 4;
    sc.extraction.pagesOcred = 3;
    sc.extraction.textLayerChars = 42;
    sc.extraction.ocrTextAll = "x".repeat(500);
    sc.extraction.workerRanOn = "original";
  });
  const scMeta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${pdfMeta.itemId}.json`), "utf-8"));
  const summary = admin.extractionSummary(scMeta);
  assert.ok(summary.includes("PDF 3/4p"), `partial pages render (got: ${summary})`);
  assert.ok(summary.includes("text-layer 42 ch"), "text-layer chars render");
  ok("extractionSummary: PDF pagesOcred/pages + text-layer chars rendered");

  // dispatchSkipReason renders — EVERY vocabulary value (hint-no-token: 2026-09-07 UA hint tier).
  // keyword-locked-manual stays LAST: the listing-row pin below reads the loop's final write.
  for (const value of ["no-country-match", "hint-no-token", "keyword-locked-manual"]) {
    editSidecar(pdfMeta.itemId, (sc) => {
      sc.extraction.dispatchSkipReason = value;
    });
    const scD = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${pdfMeta.itemId}.json`), "utf-8"));
    assert.ok(
      admin.extractionSummary(scD).includes(`no dispatch: ${value}`),
      `dispatchSkipReason '${value}' rendered`
    );
  }
  ok("extractionSummary: dispatchSkipReason rendered for every vocabulary value");

  // Listing rows expose the new fields + the deferredReason for budget.
  editSidecar(pdfMeta.itemId, (sc) => {
    sc.phase = "deferred";
    sc.outcome = "deferred";
    sc.deferredReason = "budget";
    sc.extraction.lateResult = {
      outcome: "pending-binding",
      candidatesTried: [{ via: "ocr", country: "UA-MARAD", code: "123452024", outcome: "pending-binding", doctype: "70" }],
      completedAt: "2026-08-24T12:00:00.000Z",
    };
  });
  const listing2 = admin.listVerifyUploads(0, 100);
  const rowSkip = listing2.items.find((r) => r.itemId === skipped.itemId);
  assert.equal(rowSkip.skipReason, "pdf-encrypted", "listing row exposes skipReason");
  const rowMeta = listing2.items.find((r) => r.itemId === pdfMeta.itemId);
  assert.equal(rowMeta.dispatchSkipReason, "keyword-locked-manual");
  assert.equal(rowMeta.deferredReason, "budget", "deferred item carries its reason (not a bare 'deferred')");
  assert.deepEqual(rowMeta.lateResult, {
    outcome: "pending-binding",
    candidateCount: 1,
    completedAt: "2026-08-24T12:00:00.000Z",
  });
  ok("listing rows: skipReason / dispatchSkipReason / deferredReason budget / lateResult exposed");

  // OLD-SHAPE sidecar (pre-pdf-verify: none of the new fields) reads through
  // the new admin reader without error — summary falls back exactly as today.
  const legacy = await persist(PLAIN_PDF, "legacy.pdf");
  editSidecar(legacy.itemId, (sc) => {
    delete sc.extraction.skipReason;
    delete sc.extraction.dispatchSkipReason;
    delete sc.extraction.pages;
    delete sc.extraction.pagesProcessed;
    delete sc.extraction.pagesOcred;
    delete sc.extraction.textLayerChars;
    delete sc.extraction.notes;
    delete sc.extraction.lateResult;
  });
  const scLegacy = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${legacy.itemId}.json`), "utf-8"));
  assert.equal(admin.extractionSummary(scLegacy), "—", "field-less old sidecar keeps the legacy fallback");
  const rowLegacy = admin.listVerifyUploads(0, 100).items.find((r) => r.itemId === legacy.itemId);
  assert.equal(rowLegacy.skipReason, null);
  assert.equal(rowLegacy.dispatchSkipReason, null);
  assert.equal(rowLegacy.lateResult, null);
  ok("back-compat: old-shape sidecar renders without error, nullable new fields");
}

console.log(`\nverify-upload-admin.test: ${pass} assertions passed`);
