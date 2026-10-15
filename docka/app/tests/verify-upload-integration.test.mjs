// Integration tests for wave 4 of the anonymous verify-upload plan (§8
// integration rows): the recognition LANE (auth-ahead-of-anon priority, anon
// pending cap 4 => 5th deferred), the startup orphan sweep (stale received =>
// deferred => re-run succeeds), mismatched original/derived pairs (sidecar
// records WHICH bytes verified), derived-only vs original-only posts, the
// specced NO-DEDUPE of identical bytes (two completed chain events), registry
// failures mid-recognition (rate-limited + network) settling as re-runnable
// "deferred", the foreign-certificate guarantee (ZERO registry calls for
// unknown-country OCR text), and the client xhrUpload proxy-HTML parse
// fallback (the 13 MB proxy-413 case, unit-level — no proxy exists locally).
//
// THE WORKER SEAM (no source change): lib/recognize.ts resolves the worker
// script as path.join(process.cwd(), "scripts", "recognize-worker.mjs") AT
// IMPORT TIME, and this file chdirs into a throwaway TMP dir BEFORE any @/lib
// import — so a FAKE deterministic worker written to TMP/scripts/ stands in
// for tesseract. The real lane, priority queue, cap and settle logic all run
// unchanged; only the slow native OCR is stubbed. The fake worker reads
// directives embedded in the input file bytes:
//     WDELAY:<ms>;   sleep before answering (makes queue order observable)
//     WQR:<text>;    emitted as qrText
//     WOCR:<text>;   emitted as ocrText/ocrTextAll
//
// Follows the verify-upload-units.test.mjs pattern: plain node + the `@/*`
// alias hook, synthetic fixtures, deterministic, REGISTRY_MOCK seam — NO live
// registry call is ever made (asserted via the journal at the end).
//
// Run: node --import ./tests/_register-alias.mjs tests/verify-upload-integration.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock mode + salt BEFORE any @/lib import.
process.env.REGISTRY_MOCK = "1";
process.env.VERIFY_IP_SALT = "integration-test-salt";

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Throwaway data dir + FAKE worker (BEFORE any @/lib import) --------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-verify-upload-integ-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.mkdirSync(path.join(TMP, "scripts"), { recursive: true });
// Directives (embedded in the input file bytes):
//   WDELAY:<ms>;   sleep before answering
//   WQR:<text>;    emitted as qrText
//   WOCR:<text>;   emitted as ocrText/ocrTextAll
//   WSKIP:<r>;     emit an extraction skipReason (empty result otherwise)
//   WJUNK:<text>;  pdf-verify escape hatch: WITHOUT --force-ocr the worker
//                  reports a text-layer-only result (textLayerChars=len,
//                  pagesOcred=0) carrying this text; WITH --force-ocr it
//                  reports the WOCR text with pagesOcred>0.
fs.writeFileSync(
  path.join(TMP, "scripts", "recognize-worker.mjs"),
  `import fs from "node:fs";
const argvRest = process.argv.slice(2);
const filePath = argvRest.find((a) => !a.startsWith("--")) ?? "";
const forceOcr = argvRest.includes("--force-ocr");
let text = "";
try { text = fs.readFileSync(filePath).toString("latin1"); } catch {}
const dir = (name) => {
  const m = text.match(new RegExp(name + ":([^;]*);"));
  return m ? m[1] : null;
};
const delay = Number(dir("WDELAY") ?? 0);
const ocr = dir("WOCR") ?? "";
const junk = dir("WJUNK");
const skip = dir("WSKIP");
setTimeout(() => {
  let out;
  if (skip) {
    out = { qrText: null, ocrText: "", ocrTextAll: "", pages: 4, pagesProcessed: 0, pagesOcred: 0, textLayerChars: 0, skipReason: skip };
  } else if (junk && !forceOcr) {
    out = { qrText: null, ocrText: junk, ocrTextAll: junk, pages: 2, pagesProcessed: 2, pagesOcred: 0, textLayerChars: junk.length, skipReason: null };
  } else if (junk && forceOcr) {
    out = { qrText: dir("WQR"), ocrText: ocr, ocrTextAll: ocr, pages: 2, pagesProcessed: 2, pagesOcred: 2, textLayerChars: junk.length, skipReason: null };
  } else {
    out = { qrText: dir("WQR"), ocrText: ocr, ocrTextAll: ocr };
  }
  process.stdout.write(JSON.stringify(out));
}, delay);
`,
  "utf-8"
);
process.chdir(TMP);

const {
  registryJournal,
  resetRegistryJournal,
  resetRegistryAbuseState,
  consumeRegistryBudget,
  __setTestAdapter,
} = await import("@/lib/registry");
const { runWorkerAnon, runWorkerAuthPriority, __workerSpawnLog } = await import("@/lib/recognize");
const { createMockRegistry, MOCK_CODES } = await import("./mock-registry.mjs");
const { verifyAuditChain } = await import("@/lib/db");
const vu = await import("@/lib/verify-upload");
const { POST } = await import("@/app/api/verify-upload/route");

const UPLOAD_DIR = path.join(TMP, "data", "verify-uploads");
const EVENTS_PATH = path.join(TMP, "data", "verify-upload-events.ndjson");
const journalBaseline = registryJournal().length;

// Every wired adapter — the foreign-cert test proves NONE of them is called.
// (CY joined 2026-08-12 when its capability flipped to auto; HR stays listed —
// demoted to assisted the same day, but the adapter remains registered.)
const WIRED = ["EE", "DK", "UK", "NO", "FR", "HR", "BG", "CY", "UA"];

// ---- Synthetic fixtures -------------------------------------------------------

function jpegWithSof(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

/** Valid-sniffing JPEG with fake-worker directives riding in the tail bytes. */
function jpegWithDirectives(directives) {
  return Buffer.concat([jpegWithSof(100, 100), Buffer.from(directives, "latin1")]);
}

const PLAIN_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n", "latin1");

function pdfWithEmbeddedCode(code) {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /URI (https://meremees.transpordiamet.ee/kompetents/${code}) >>\nendobj\ntrailer\n%%EOF\n`,
    "latin1"
  );
}

const mkCert = (over = {}) => ({
  ok: true,
  code: "SAMPLE0SAFETY001",
  docCategory: "competency",
  hasName: true,
  fullName: "JAAN TAMM",
  firstName: "JAAN",
  lastName: "TAMM",
  title: "Certificate of competency",
  personalCode: "",
  birthDate: "1990-01-01T00:00:00+00:00",
  status: "valid",
  isValid: true,
  issuedOn: "",
  validUntil: "2027-01-01T00:00:00+00:00",
  certificateType: "CoC",
  issuerCountry: "EE",
  institution: "",
  documentType: "",
  sourceUrl: "",
  registryCountry: "EE",
  keyTrust: "capability-token",
  verifiedSource: "government",
  ...over,
});

async function persist(buf, origName, derivedBuf = null, clientIp = "203.0.113.50") {
  const sniffed = vu.sniffMagic(buf);
  assert.ok(sniffed, `fixture must sniff (${origName})`);
  return vu.persistUpload({ originalBuf: buf, sniffedType: sniffed, origName, derivedBuf, clientIp });
}

function chainEvents() {
  return fs.readFileSync(EVENTS_PATH, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

function readSidecar(itemId) {
  return JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, `${itemId}.json`), "utf-8"));
}

function editSidecar(itemId, mutate) {
  const p = path.join(UPLOAD_DIR, `${itemId}.json`);
  const sc = JSON.parse(fs.readFileSync(p, "utf-8"));
  mutate(sc);
  fs.writeFileSync(p, JSON.stringify(sc, null, 2), "utf-8");
}

// Duck-typed request for the route (same shape as verify-upload-units).
function req({ ip, contentLength, form }) {
  const headers = new Headers({ "x-registry-test-ip": ip });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { headers, formData: async () => form };
}

function formWith(bytes, name, derived) {
  const fd = new FormData();
  if (bytes) fd.set("file", new File([bytes], name, { type: "application/octet-stream" }));
  if (derived) fd.set("derived", new File([derived], "derived.jpg", { type: "image/jpeg" }));
  return fd;
}

// Write a standalone file for direct-lane tests (they take a path, not bytes).
let laneN = 0;
function laneFile(directives) {
  const p = path.join(TMP, `lane-${laneN++}.jpg`);
  fs.writeFileSync(p, jpegWithDirectives(directives));
  return p;
}

// ---- §4 lane priority: concurrent anon + auth, auth jumps the queue -----------

{
  const order = [];
  // Occupies the lane first (WDELAY makes the window deterministic).
  const slow = runWorkerAnon(laneFile("WDELAY:250;WOCR:SLOWTEXT;"));
  assert.ok(slow, "lane must accept the first anonymous job");
  const slowP = slow.then((r) => (order.push("slow"), r));
  // Anonymous enqueued SECOND, auth enqueued THIRD — auth must still run first.
  const anon = runWorkerAnon(laneFile("WOCR:ANONTEXT;"));
  assert.ok(anon, "second anonymous job under the cap must enqueue");
  const anonP = anon.then((r) => (order.push("anon"), r));
  const authP = runWorkerAuthPriority(laneFile("WOCR:AUTHTEXT;")).then(
    (r) => (order.push("auth"), r)
  );

  const [slowR, anonR, authR] = await Promise.all([slowP, anonP, authP]);
  assert.deepEqual(order, ["slow", "auth", "anon"]);
  ok("lane: auth job enqueued after an anon job still completes BEFORE it (priority)");

  assert.equal(slowR.ocrText, "SLOWTEXT");
  assert.equal(anonR.ocrText, "ANONTEXT");
  assert.equal(authR.ocrText, "AUTHTEXT");
  ok("lane: concurrent anon + auth jobs ALL return non-empty OCR (no empty-race)");
}

// ---- §4 anon pending cap: 5th anonymous job => settle "deferred" ---------------

{
  resetRegistryAbuseState();
  // Fill the cap: 4 anonymous jobs queued-or-running.
  const four = [];
  for (let i = 0; i < 4; i++) {
    const run = runWorkerAnon(laneFile(`WDELAY:200;WOCR:CAP${i};`));
    assert.ok(run, `anon job ${i + 1}/4 must be accepted`);
    four.push(run);
  }
  // Direct lane probe: the 5th anon enqueue is refused outright.
  assert.equal(runWorkerAnon(laneFile("WOCR:OVERFLOW;")), null);
  ok("lane: 5th concurrent anonymous job is refused (ANON_PENDING_CAP 4)");

  // Full settle path: a worker-eligible upload arriving now converges to
  // "deferred" — bytes + sidecar persisted, chain event appended, re-runnable.
  const item = await persist(jpegWithDirectives("WOCR:NEVERRUNS;"), "burst5.jpg");
  const settle = await vu.runAnonymousRecognition(item);
  assert.equal(settle.phase, "deferred");
  assert.equal(settle.reason, "queue-full");
  const sc = readSidecar(item.itemId);
  assert.equal(sc.phase, "deferred");
  assert.equal(sc.deferredReason, "queue-full");
  assert.equal(sc.extraction.workerRanOn, null, "nothing was enqueued for the capped job");
  const ev = chainEvents().filter((e) => e.itemId === item.itemId);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].phase, "deferred");
  ok("settle: queue-cap upload => phase 'deferred' (queue-full), bytes + sidecar + chain kept");

  await Promise.all(four); // drain the lane before the next block
}

// ---- §2 startup orphan sweep: stale received => deferred, then re-run ----------

{
  resetRegistryAbuseState();
  const CODE = "SWEEPRERUN123456"; // 16-char EE token shape
  const stale = await persist(pdfWithEmbeddedCode(CODE), "stale.pdf");
  const fresh = await persist(PLAIN_PDF, "fresh.pdf");
  // Fake the sidecar timestamp: received 11 minutes ago (over the 10-min age).
  editSidecar(stale.itemId, (sc) => {
    sc.receivedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  });

  // The sweep runs once per process; reset the flag (mock-mode seam), fire it.
  vu.__resetVerifyUploadState();
  vu.ensureOrphanSweep();
  // Async fire-and-forget — poll the sidecar until the sweep lands.
  let swept = null;
  for (let i = 0; i < 60 && !swept; i++) {
    await sleep(50);
    const sc = readSidecar(stale.itemId);
    if (sc.phase !== "received") swept = sc;
  }
  assert.ok(swept, "sweep must settle the stale sidecar");
  assert.equal(swept.phase, "deferred");
  assert.equal(swept.outcome, "deferred");
  assert.equal(swept.deferredReason, "orphaned-restart");
  ok("sweep: stale phase='received' (>10 min) => 'deferred' (orphaned-restart)");

  const staleEv = chainEvents().filter((e) => e.itemId === stale.itemId);
  assert.equal(staleEv.at(-1).phase, "deferred");
  assert.equal(staleEv.at(-1).outcome, "deferred");
  ok("sweep: deferred chain event appended for the orphan");

  assert.equal(readSidecar(fresh.itemId).phase, "received");
  ok("sweep: a FRESH received item is left alone (age-gated)");

  // Second call in the same process is a no-op (once-per-boot semantics).
  vu.ensureOrphanSweep();
  await sleep(100);
  assert.equal(readSidecar(fresh.itemId).phase, "received");
  ok("sweep: runs at most once per process (flag respected)");

  // ...and the deferred orphan is exactly what the admin re-run recovers.
  let eeCalls = 0;
  __setTestAdapter("EE", async (inputs) => {
    eeCalls++;
    return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
  });
  const rerun = await vu.rerunRecognition(stale.itemId);
  assert.equal(rerun.status, "completed");
  assert.equal(rerun.outcome, "verified");
  assert.equal(eeCalls, 1);
  const after = readSidecar(stale.itemId);
  assert.equal(after.phase, "completed");
  assert.equal(after.retries.length, 1);
  ok("sweep => re-run: the swept orphan completes through the mock adapter");
  __setTestAdapter("EE", undefined);

  // Settle the fresh helper item so it can't leak into later sweep-ish asserts.
  editSidecar(fresh.itemId, (sc) => {
    sc.phase = "completed";
    sc.outcome = "no-candidates";
    sc.settledAt = new Date().toISOString();
  });
}

// ---- §2b mismatched original/derived: sidecar records WHICH bytes verified -----

{
  resetRegistryAbuseState();
  const CODE = "DERIVEDQRCODE456"; // 16-char EE token shape
  // Original: a plain PDF with NO embedded code. Derived: a (mismatched) JPEG
  // whose QR — via the fake worker — carries the registry URL. Only the
  // derived bytes can verify; the sidecar must say so.
  const derivedBuf = jpegWithDirectives(
    `WQR:https://meremees.transpordiamet.ee/certificates/${CODE};`
  );
  let eeCalls = 0;
  __setTestAdapter("EE", async (inputs) => {
    eeCalls++;
    return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
  });

  const item = await persist(PLAIN_PDF, "paper.pdf", derivedBuf);
  const settle = await vu.runAnonymousRecognition(item);
  assert.equal(settle.phase, "completed");
  assert.equal(settle.outcome.kind, "verified");
  assert.equal(eeCalls, 1);
  ok("mismatched pair: QR on the DERIVED bytes verifies through the dispatcher");

  const sc = readSidecar(item.itemId);
  assert.equal(sc.extraction.workerRanOn, "derived");
  assert.notEqual(sc.derived.sha256, sc.sha256Original);
  assert.equal(sc.extraction.embeddedCode, null, "original bytes held no code");
  assert.equal(sc.extraction.qrText, `https://meremees.transpordiamet.ee/certificates/${CODE}`);
  assert.deepEqual(
    sc.extraction.candidatesTried.map((c) => [c.via, c.outcome]),
    [["qr", "verified"]]
  );
  ok("mismatched pair: sidecar workerRanOn='derived' + both hashes => which-bytes-verified is reconstructable");
  __setTestAdapter("EE", undefined);

  // Control: an original-only raster runs the worker on the ORIGINAL bytes.
  const item2 = await persist(jpegWithDirectives("WOCR:JUST SOME WORDS;"), "photo.jpg");
  const settle2 = await vu.runAnonymousRecognition(item2);
  assert.equal(settle2.phase, "completed");
  const sc2 = readSidecar(item2.itemId);
  assert.equal(sc2.extraction.workerRanOn, "original");
  assert.equal(sc2.derived, null);
  ok("original-only: worker ran on the original, sidecar workerRanOn='original'");
}

// ---- §1 route contract: derived-only refused, original-only fine ---------------

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const before = fs.readdirSync(UPLOAD_DIR).length;

  // derived-only (no `file` part): 415 per the contract — `file` is REQUIRED —
  // and NOTHING persists.
  const rDerivedOnly = await POST(
    req({ ip: "ip-do", contentLength: 500, form: formWith(null, null, jpegWithSof(4, 4)) })
  );
  assert.equal(rDerivedOnly.status, 415);
  assert.equal(fs.readdirSync(UPLOAD_DIR).length, before);
  ok("route: derived-only post (no `file` part) => 415, nothing persisted");

  // original-only: perfectly fine — 200 with itemId/phase, no derived stored.
  const rOrigOnly = await POST(
    req({ ip: "ip-oo", contentLength: PLAIN_PDF.length, form: formWith(PLAIN_PDF, "solo.pdf") })
  );
  assert.equal(rOrigOnly.status, 200);
  const origOnlyBody = await rOrigOnly.json();
  assert.ok(origOnlyBody.itemId);
  assert.equal(origOnlyBody.phase, "completed");
  assert.equal(readSidecar(origOnlyBody.itemId).derived, null);
  ok("route: original-only post => 200 {itemId, phase}, sidecar.derived null");

  // Invalid derived (sniffs PNG, not JPEG) is discarded NON-fatally: the
  // original is still saved and settles; only the derived part is dropped.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(25),
  ]);
  const rBadDerived = await POST(
    req({
      ip: "ip-bd",
      contentLength: 4000,
      form: formWith(jpegWithDirectives("WOCR:NOTHING HERE;"), "cert.jpg", png),
    })
  );
  assert.equal(rBadDerived.status, 200);
  const badDerivedBody = await rBadDerived.json();
  const scBad = readSidecar(badDerivedBody.itemId);
  assert.equal(scBad.derived, null, "non-JPEG derived discarded");
  assert.equal(scBad.extraction.workerRanOn, "original", "worker fell back to the original");
  ok("route: non-JPEG derived part discarded non-fatally — original saved + recognized");
}

// ---- §2 no-dedupe: same sha256 twice, changed outcome => two completed events --

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const CODE = "SAMESHATWICE0007"; // 16-char EE token shape
  const bytes = pdfWithEmbeddedCode(CODE);

  let calls = 0;
  __setTestAdapter("EE", async (inputs) => {
    calls++;
    if (calls === 1) return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
    return { kind: "no-match" }; // the registry's answer CHANGED between uploads
  });

  const r1 = await POST(req({ ip: "ip-dup", contentLength: bytes.length, form: formWith(bytes, "dup.pdf") }));
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.phase, "completed");
  assert.equal(b1.ok, true);
  assert.equal(b1.outcome.kind, "verified");

  // Clear the 5-min result cache between uploads: this test targets the
  // NO-DEDUPE of uploads (specced), not the fetch-layer cache (separately
  // specced + tested); without the reset the second resolve would replay the
  // cached match-valid instead of asking the "changed" registry.
  resetRegistryAbuseState();

  const r2 = await POST(req({ ip: "ip-dup", contentLength: bytes.length, form: formWith(bytes, "dup.pdf") }));
  assert.equal(r2.status, 200);
  const b2 = await r2.json();
  assert.equal(b2.phase, "completed");
  assert.equal(b2.ok, false); // nothing verifiable the second time

  assert.notEqual(b1.itemId, b2.itemId);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const completed = chainEvents().filter(
    (e) => e.sha256Original === sha && e.phase === "completed"
  );
  assert.equal(completed.length, 2);
  assert.equal(completed[0].itemId, b1.itemId);
  assert.equal(completed[1].itemId, b2.itemId);
  assert.equal(completed[0].outcome, "verified");
  // The second upload DID try its embedded EE candidate (the registry said
  // no-match) — the honest label is "all-failed", not "no-candidates".
  assert.equal(completed[1].outcome, "all-failed");
  assert.equal(calls, 2, "both uploads reached the adapter — nothing was deduped");
  ok("no-dedupe: identical bytes uploaded twice => TWO distinct completed chain events with the changed outcomes");
  __setTestAdapter("EE", undefined);
}

// ---- §4 registry failure mid-recognition => deferred, re-run completes ---------

{
  // (a) transport/network failure: adapter fails ONCE (indeterminate network
  // => "Could not reach…"), then succeeds on the admin re-run.
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const CODE = "NETFAILONCE00009"; // 16-char EE token shape
  let calls = 0;
  __setTestAdapter("EE", async (inputs) => {
    calls++;
    if (calls === 1) return { kind: "indeterminate", reason: "network" };
    return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
  });

  const bytes = pdfWithEmbeddedCode(CODE);
  const rNet = await POST(req({ ip: "ip-net", contentLength: bytes.length, form: formWith(bytes, "net.pdf") }));
  assert.equal(rNet.status, 200);
  const bNet = await rNet.json();
  assert.equal(bNet.phase, "deferred");
  assert.equal(bNet.ok, false);
  const scNet = readSidecar(bNet.itemId);
  assert.equal(scNet.phase, "deferred");
  assert.equal(scNet.deferredReason, "registry-network");
  ok("registry network failure mid-recognition => outcome 'deferred' (registry-network), never completed-with-error");

  const rerunNet = await vu.rerunRecognition(bNet.itemId);
  assert.equal(rerunNet.status, "completed");
  assert.equal(rerunNet.outcome, "verified");
  assert.equal(calls, 2, "adapter failed once, then succeeded on re-run");
  assert.equal(readSidecar(bNet.itemId).phase, "completed");
  ok("re-run after the transient failure completes (fail-once-then-succeed)");
  __setTestAdapter("EE", undefined);

  // (b) registry rate-limit (429-equivalent): the per-IP registry budget is
  // exhausted BEFORE recognition; the upload persists and settles deferred.
  resetRegistryAbuseState();
  let calls2 = 0;
  __setTestAdapter("EE", async (inputs) => {
    calls2++;
    return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
  });
  const RL_IP = "ip-ratelimited";
  while (consumeRegistryBudget(RL_IP)) {
    /* burn the registry per-IP bucket (capacity 8) */
  }
  const CODE2 = "RATELIMITED00010";
  const bytes2 = pdfWithEmbeddedCode(CODE2);
  const rRl = await POST(req({ ip: RL_IP, contentLength: bytes2.length, form: formWith(bytes2, "rl.pdf") }));
  assert.equal(rRl.status, 200, "the UPLOAD budget is separate — the doc is still accepted");
  const bRl = await rRl.json();
  assert.equal(bRl.phase, "deferred");
  assert.equal(readSidecar(bRl.itemId).deferredReason, "registry-rate-limited");
  assert.equal(calls2, 0, "no adapter call went out while rate-limited");
  ok("registry 429 mid-recognition => deferred (registry-rate-limited), doc persisted");

  // Re-run is an INTERNAL caller (no per-IP budget) — it completes.
  const rerunRl = await vu.rerunRecognition(bRl.itemId);
  assert.equal(rerunRl.status, "completed");
  assert.equal(rerunRl.outcome, "verified");
  assert.equal(calls2, 1);
  ok("re-run after the rate-limit completes (internal caller, no per-IP budget)");
  __setTestAdapter("EE", undefined);
}

// ---- §5 foreign cert: unknown-country OCR text => ZERO registry calls ----------

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();

  // Philippine certificate wording: NO known country keyword, several ≥6-char
  // tokens — including a 13-char EE-fallback-SHAPED token (CROC1234567AB) that
  // MUST stay excluded without an independent EE keyword hit.
  const FOREIGN =
    "REPUBLIC OF THE PHILIPPINES MARITIME INDUSTRY AUTHORITY " +
    "CERTIFICATE OF COMPETENCY OFFICER IN CHARGE OF A NAVIGATIONAL WATCH " +
    "MANILA 1234567 OICNW2019 CROC1234567AB STCW REGULATION";

  const adapterCalls = Object.fromEntries(WIRED.map((c) => [c, 0]));
  for (const c of WIRED) {
    __setTestAdapter(c, async () => {
      adapterCalls[c]++;
      return { kind: "no-match" };
    });
  }
  const journalBefore = registryJournal().length;

  const bytes = jpegWithDirectives(`WOCR:${FOREIGN};`);
  const res = await POST(
    req({ ip: "ip-foreign", contentLength: bytes.length, form: formWith(bytes, "philippine-coc.jpg") })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.phase, "completed");
  assert.equal(body.ok, false); // guided fallback — saved, nothing verifiable
  assert.equal(body.countryDetected, null);

  const sc = readSidecar(body.itemId);
  assert.equal(sc.extraction.ocrTextAll, FOREIGN, "OCR text captured in the sidecar");
  assert.deepEqual(sc.extraction.candidatesTried, [], "no candidate was ever dispatched");

  for (const c of WIRED) assert.equal(adapterCalls[c], 0, `${c} adapter must not be called`);
  assert.equal(registryJournal().length, journalBefore);
  ok("foreign cert: PH wording + ≥6-char tokens (incl. EE-fallback-shaped) => ZERO registry calls, saved + fallback");

  for (const c of WIRED) __setTestAdapter(c, undefined);
}

// ---- §5 keyword lock: detected country never cross-fires foreign registries ----

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();

  // REAL header wording from the live lv-coc.jpg corpus item (2026-08-12
  // operator bug): pre-lock this document got countryDetected null and fired
  // its bare tokens at EE (STARPTAUTISKAJAI — 16-char shape) and DK
  // (13052019 — 8-digit date shape); both errored.
  const LV_OCR =
    "Latvijas Republika Sertifikats Nr. 1/19 izdots Latvijas Republikas " +
    "The Republic of Latvia valdibas varda. " +
    "1978. gada Starptautiskajai konvencijai par jurnieku " +
    "KOMPETENCES SERTIFIKATS CERTIFICATE OF COMPETENCY " +
    "Date of issue (d. m. y.) 13.05.2019 " +
    "Izdevejiestade: Latvijas Jurnieku registrs Issued by: Latvian Registry of Seamen";

  const adapterCalls = Object.fromEntries(WIRED.map((c) => [c, 0]));
  for (const c of WIRED) {
    __setTestAdapter(c, async () => {
      adapterCalls[c]++;
      return { kind: "no-match" };
    });
  }
  const journalBefore = registryJournal().length;

  // (a) LV = assisted, keyword-locked: countryDetected LV, ZERO registry
  // dispatch, guided fallback carrying the country for the UI prefill (the
  // manual round-trip then renders LV's assist panel — existing outcome shape).
  const lvBytes = jpegWithDirectives(`WOCR:${LV_OCR};`);
  const lvRes = await POST(
    req({ ip: "ip-lv-lock", contentLength: lvBytes.length, form: formWith(lvBytes, "lv-coc.jpg") })
  );
  assert.equal(lvRes.status, 200);
  const lvBody = await lvRes.json();
  assert.equal(lvBody.phase, "completed");
  assert.equal(lvBody.ok, false); // guided fallback
  assert.equal(lvBody.countryDetected, "LV");

  const lvSc = readSidecar(lvBody.itemId);
  assert.equal(lvSc.countryDetected, "LV");
  assert.deepEqual(lvSc.extraction.candidatesTried, [], "assisted-locked: nothing dispatched");
  assert.equal(lvSc.outcome, "no-candidates");
  for (const c of WIRED) assert.equal(adapterCalls[c], 0, `${c} adapter must not be called`);
  assert.equal(registryJournal().length, journalBefore);
  ok("keyword lock: REAL LV wording => countryDetected LV, ZERO registry calls, guided fallback");

  // (b) locked AUTO country: DK keywords + a DK-shaped code + an EE-16-shaped
  // token => ONLY DK is tried; DK misses => the honest label is "all-failed"
  // (tried-and-missed), never "no-candidates".
  resetRegistryAbuseState();
  const DK_OCR =
    "DANISH MARITIME AUTHORITY certificate 87654321 ref SAMPLE0SAFETY001";
  const dkBytes = jpegWithDirectives(`WOCR:${DK_OCR};`);
  const dkRes = await POST(
    req({ ip: "ip-dk-lock", contentLength: dkBytes.length, form: formWith(dkBytes, "dk-coc.jpg") })
  );
  assert.equal(dkRes.status, 200);
  const dkBody = await dkRes.json();
  assert.equal(dkBody.phase, "completed");
  assert.equal(dkBody.ok, false);
  assert.equal(dkBody.countryDetected, "DK");
  const dkSc = readSidecar(dkBody.itemId);
  assert.deepEqual(
    dkSc.extraction.candidatesTried.map((c) => [c.via, c.country]),
    [["ocr", "DK"]],
    "only the locked country's candidate was dispatched"
  );
  assert.equal(adapterCalls.DK, 1);
  assert.equal(adapterCalls.EE, 0, "the EE-16-shaped token was suppressed by the DK lock");
  assert.equal(dkSc.outcome, "all-failed");
  ok("keyword lock: locked auto country => only DK tried; tried-and-missed => outcome 'all-failed'");

  // (c) QR/URL candidates are NEVER suppressed: an LV-locked document whose QR
  // deep-links to the pinned EE registry still verifies through it.
  resetRegistryAbuseState();
  __setTestAdapter("EE", async (inputs) => {
    adapterCalls.EE++;
    return { kind: "match-valid", cert: mkCert({ code: inputs.code }) };
  });
  const QR_CODE = "QRSURVIVESLOCK16"; // 16-char EE token shape
  // Original: plain PDF (no embedded URL). Derived: JPEG whose QR carries the
  // pinned EE registry URL AND whose OCR reads the LV wording — the QR lane
  // (not the embedded-bytes scan) is what must survive the lock.
  const qrDerived = jpegWithDirectives(
    `WQR:https://meremees.transpordiamet.ee/kompetents/${QR_CODE};WOCR:${LV_OCR};`
  );
  const qrRes = await POST(
    req({
      ip: "ip-qr-lock",
      contentLength: PLAIN_PDF.length + qrDerived.length,
      form: formWith(PLAIN_PDF, "lv-with-ee-qr.pdf", qrDerived),
    })
  );
  assert.equal(qrRes.status, 200);
  const qrBody = await qrRes.json();
  assert.equal(qrBody.phase, "completed");
  assert.equal(qrBody.ok, true);
  assert.equal(qrBody.outcome.kind, "verified");
  assert.equal(qrBody.countryDetected, "LV", "keyword country still recorded alongside the QR verify");
  assert.equal(adapterCalls.EE, 1);
  const qrSc = readSidecar(qrBody.itemId);
  assert.deepEqual(
    qrSc.extraction.candidatesTried.map((c) => [c.via, c.outcome]),
    [["qr", "verified"]]
  );
  ok("keyword lock: QR candidate survives the LV lock (pinned-domain certainty beats keywords)");

  for (const c of WIRED) __setTestAdapter(c, undefined);
}

// ---- §6 client parse fallback: proxy HTML 413 (the 13 MB case, unit-level) -----

{
  // No proxy runs locally, so the 13 MB proxy-HTML shape is simulated at the
  // transport seam: xhrUpload must degrade an HTML error body to {} NON-fatally
  // and still surface the status — the UI then renders its own friendly 413.
  class FakeXHR {
    static next = { status: 200, body: "{}", headers: {} };
    upload = {};
    open() {}
    getResponseHeader(h) {
      return FakeXHR.next.headers[h.toLowerCase()] ?? null;
    }
    send() {
      setTimeout(() => {
        this.status = FakeXHR.next.status;
        this.responseText = FakeXHR.next.body;
        this.onload();
      }, 0);
    }
  }
  const saved = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  const { xhrUpload } = await import("@/lib/xhr-upload");

  FakeXHR.next = {
    status: 413,
    body: "<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413</h1></center><hr><center>nginx</center></body></html>",
    headers: {},
  };
  const r413 = await xhrUpload("/api/verify-upload", new FormData(), () => {});
  assert.equal(r413.ok, false);
  assert.equal(r413.status, 413);
  assert.deepEqual(r413.data, {}, "HTML body degraded to {} non-fatally");
  assert.equal(r413.retryAfter, undefined);
  ok("xhrUpload: proxy HTML 413 page => {ok:false, status:413, data:{}} (client parse fallback)");

  FakeXHR.next = {
    status: 429,
    body: JSON.stringify({ ok: false, error: "slow down" }),
    headers: { "retry-after": "20" },
  };
  const r429 = await xhrUpload("/api/verify-upload", new FormData(), () => {});
  assert.equal(r429.status, 429);
  assert.equal(r429.retryAfter, 20);
  assert.equal(r429.data.error, "slow down");
  ok("xhrUpload: 429 JSON + Retry-After parsed for the keep-and-retry countdown");

  if (saved === undefined) delete globalThis.XMLHttpRequest;
  else globalThis.XMLHttpRequest = saved;
}

// ---- review fix: admin delete racing the INITIAL anonymous settle --------------

{
  // The §7 re-run already had the tombstone guard; the INITIAL settle gained
  // the same one (review fix): a delete landing while the first anonymous
  // recognition holds the worker lane must NEVER resurrect the sidecar — the
  // settle records "deleted-during-run" in the chain instead.
  resetRegistryAbuseState();
  const { deleteVerifyUpload } = await import("@/lib/verify-upload-admin");

  const item = await persist(
    jpegWithDirectives("WDELAY:300;WOCR:NOTHING NOTABLE;"),
    "race-delete.jpg"
  );
  const settleP = vu.runAnonymousRecognition(item); // worker holds the lane 300 ms
  await sleep(80); // ...so this delete lands mid-run
  const del = await deleteVerifyUpload(item.itemId);
  assert.equal(del.ok, true);
  const settle = await settleP;
  assert.equal(settle.phase, "completed", "the anonymous caller's result is unchanged");

  // No resurrection: neither the sidecar nor the bytes reappear after settle.
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, `${item.itemId}.json`)), "sidecar stays deleted");
  assert.ok(!fs.existsSync(item.originalPath), "original bytes stay deleted");
  ok("delete racing the initial settle: sidecar + bytes are NOT resurrected");

  // Chain: received -> tombstone (the delete) -> deleted-during-run (the settle).
  const ev = chainEvents().filter((e) => e.itemId === item.itemId);
  assert.equal(ev[0].phase, "received");
  assert.ok(ev.some((e) => e.tombstone === true && e.phase === "deleted"));
  assert.equal(ev.at(-1).phase, "deleted-during-run");
  assert.equal(ev.at(-1).outcome, "deleted-during-run");
  assert.ok(!ev.some((e) => e.phase === "completed"), "no completed event for the deleted item");
  ok("delete racing the initial settle: chain shows tombstone then 'deleted-during-run'");
}

// ---- review fix: a rejecting worker spawn must not wedge THE ONE lane -----------

{
  // spawnWorker never rejects by contract, but pumpLane's rejection arm
  // (review fix) is what keeps laneBusy from sticking true forever if it ever
  // does. Force a REAL rejection through the one seam that throws
  // synchronously inside spawnWorker's executor: a NUL byte in the file path
  // makes execFile raise ERR_INVALID_ARG_VALUE before any process spawns.
  const rejected = await runWorkerAuthPriority("wedge\u0000probe.jpg");
  assert.deepEqual(rejected, { qrText: null, ocrText: "", ocrTextAll: "" });
  ok("lane: a rejecting worker spawn degrades to the empty result shape");

  // And the lane is NOT wedged: a normal job enqueued afterwards completes.
  const after = await runWorkerAuthPriority(laneFile("WOCR:AFTERWEDGE;"));
  assert.equal(after.ocrText, "AFTERWEDGE");
  ok("lane: pumping continues after the rejection (laneBusy freed, no wedge)");
}

// ---- pdf-verify plan: UA-MARAD end-to-end settle vs the mock registry ----------
// (also the B5 issue-date-divergence pin: doctype 71 misses on the mock —
// wrong doctype/date — and the loop continues to the 70 hit.)

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const mock = createMockRegistry();
  await mock.start();
  const savedBase = process.env.REGISTRY_BASE_UA_MARAD;
  process.env.REGISTRY_BASE_UA_MARAD = "http://127.0.0.1:4123/ua-marad";
  try {
    // OCR text shaped like the real incident scan's read (B3 gate), carrying
    // the MOCK registry's known-good doc "12345/2024" issued 2024-05-07.
    const UA_OCR =
      "UKRAINE ENDORSEMENT The Government of Ukraine certifies that Certificate " +
      "NE 12345/2024 has been issued Authorized official of the Shipping Administration " +
      "issued on 07.05.2024 valid until 06.05.2029";
    const item = await persist(jpegWithDirectives(`WOCR:${UA_OCR};`), "ua-endorsement.jpg");
    const settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    assert.equal(settle.outcome.kind, "pending-binding", "public identifier never auto-green");
    assert.equal(settle.outcome.cert.registryCountry, "UA-MARAD");
    assert.match(
      settle.outcome.cert.sourceUrl,
      /\/services\/documents\/pdf\/hash\/[A-Za-z0-9_-]{20,}$/,
      "evidence is the real-capture hash-link shape (served by the mock fixture)"
    );
    const sc = readSidecar(item.itemId);
    assert.equal(sc.countryDetected, "UA-MARAD");
    assert.equal(sc.phase, "completed");
    assert.equal(sc.outcome, "pending-binding");
    assert.deepEqual(
      sc.extraction.candidatesTried.map((c) => [c.via, c.country, c.doctype, c.outcome]),
      [
        // doctype 71 (endorsement) first: the mock only knows doctype 70 for
        // this doc → miss → no-match; the loop CONTINUES (divergence pin)...
        ["ocr", "UA-MARAD", "71", "error"],
        // ...and doctype 70 (CoC) lands.
        ["ocr", "UA-MARAD", "70", "pending-binding"],
      ],
      "both fan-out candidates tried in 71→70 order; 71 miss does not sink the 70 hit"
    );
    assert.equal(sc.extraction.dispatchSkipReason, null, "candidates were planned");
    ok("UA-MARAD e2e: scanned-doc OCR -> keyword lock -> 71 miss, 70 pending-binding via mock registry (divergence accepted-behavior pin)");
  } finally {
    process.env.REGISTRY_BASE_UA_MARAD = savedBase;
    await mock.stop();
    // The mock e2e above legitimately journals fetches to 127.0.0.1 — reset
    // so the whole-file "zero live registry calls" invariant stays meaningful.
    resetRegistryJournal();
  }
}

// ---- az-adapter plan (test plan item 4): AZ end-to-end settle vs the mock -----

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const mock = createMockRegistry();
  await mock.start();
  const savedBase = process.env.REGISTRY_BASE_AZ;
  process.env.REGISTRY_BASE_AZ = "http://127.0.0.1:4123/az";
  try {
    // (i) HAPPY PATH — OCR shaped like the B2-gate read carrying the mock's
    // known-good code + a single distinct qualifying DOB.
    const AZ_OCR =
      "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY " +
      "Certificate of Competency No 123456/24 Date of Birth 01.01.1990 issued 29.07.2024";
    let item = await persist(jpegWithDirectives(`WOCR:${AZ_OCR};`), "az-coc.jpg");
    let settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    assert.equal(settle.outcome.kind, "pending-binding", "public identifier never auto-green");
    assert.equal(settle.outcome.cert.registryCountry, "AZ");
    assert.equal(settle.outcome.cert.code, "123456/24", "wire form reconstructed");
    assert.equal(settle.outcome.cert.validUntil, "2029-01-15");
    let sc = readSidecar(item.itemId);
    assert.equal(sc.countryDetected, "AZ");
    assert.equal(sc.outcome, "pending-binding");
    assert.deepEqual(
      sc.extraction.candidatesTried.map((c) => [c.via, c.country, c.outcome]),
      [["ocr", "AZ", "pending-binding"]],
      "exactly ONE AZ candidate dispatched (no fan-out)"
    );
    assert.ok(
      !JSON.stringify(sc).includes("1990-01-01"),
      "the extracted DOB never lands in the sidecar (extraInputs are not persisted)"
    );
    ok("AZ e2e: keywords + raw token + DOB -> ONE candidate -> pending-binding via mock DDLA");

    // (ii) EXPIRED path (Decision-5 pin): first OCR-planner-reachable
    // match-invalid — completed pending-binding carrying isValid:false.
    vu.__resetVerifyUploadState();
    const AZ_EXPIRED_OCR =
      "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY " +
      "Certificate No 123457/24 Date of Birth 01.01.1990 issued 15.01.2019";
    item = await persist(jpegWithDirectives(`WOCR:${AZ_EXPIRED_OCR};`), "az-expired.jpg");
    settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    assert.equal(settle.outcome.kind, "pending-binding");
    assert.equal(settle.outcome.cert.isValid, false, "honest expired verdict rides through");
    assert.equal(settle.outcome.cert.status, "invalid");
    ok("AZ e2e expired: match-invalid -> completed pending-binding with isValid:false (zero new plumbing)");

    // (iii) MISSING-DOB honest path (2026-08-24 live-defect fix): keywords +
    // token, NO qualifying date -> the needs-inputs outcome COMPLETES the
    // settle carrying the EXTRACTED code + missing keys, so the UI renders
    // the §5.2 prompt with the code prefilled. (Old behavior settled
    // completed-with-nothing and the generic fallback discarded the read
    // code — the operator retyped what OCR already read.)
    vu.__resetVerifyUploadState();
    const AZ_NO_DOB =
      "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY Certificate No 123456/24 issued 29.07.2024";
    item = await persist(jpegWithDirectives(`WOCR:${AZ_NO_DOB};`), "az-nodob.jpg");
    settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    assert.equal(settle.outcome.kind, "needs-inputs", "the read code survives to the UI prompt");
    assert.equal(settle.outcome.code, "12345624", "normalized extracted code rides on the outcome");
    assert.equal(settle.outcome.country.country, "AZ");
    assert.deepEqual(
      settle.outcome.missing.map((f) => f.key),
      ["dob"],
      "exactly the missing DOB is prompted"
    );
    assert.equal(settle.countryDetected, "AZ");
    sc = readSidecar(item.itemId);
    assert.equal(sc.outcome, "needs-inputs", "sidecar settled label is the ResolveOutcome kind");
    assert.deepEqual(
      sc.extraction.candidatesTried.map((c) => [c.country, c.outcome]),
      [["AZ", "needs-inputs"]]
    );
    ok("AZ e2e missing-DOB: needs-inputs COMPLETES with code + missing keys (2026-08-24 defect fix)");

    // (iv) NO-MATCH RECOVERY (confirmation-9 pin, settle path :461): a
    // wrong-extracted DOB is calendar-valid, passes the year rule, and the
    // registry answers a definitive miss — which must settle as completed
    // "all-failed" + countryDetected AZ (guided fallback where the user
    // corrects the DOB), NEVER a terminal not-found and NEVER deferred.
    vu.__resetVerifyUploadState();
    const AZ_WRONG_DOB =
      "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY " +
      "Certificate No 123456/24 Date of Birth 05.05.1985 issued 29.07.2024";
    item = await persist(jpegWithDirectives(`WOCR:${AZ_WRONG_DOB};`), "az-wrongdob.jpg");
    settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed", "a definitive miss completes — not deferred");
    assert.equal(settle.outcome, null);
    assert.equal(settle.countryDetected, "AZ");
    sc = readSidecar(item.itemId);
    assert.equal(sc.outcome, "all-failed", "settledNothingLabel's settle-path production");
    assert.deepEqual(
      sc.extraction.candidatesTried.map((c) => [c.country, c.outcome]),
      [["AZ", "error"]],
      "the miss recorded; recovery = guided fallback with corrected DOB"
    );
    ok("AZ e2e no-match recovery: wrong DOB -> completed 'all-failed' + AZ guided fallback (settle-path pin)");

    // (vi — blank-failure audit row) AZ keywords but NO code token: planner
    // yields nothing, dispatchSkipReason says why, zero registry calls.
    vu.__resetVerifyUploadState();
    resetRegistryJournal();
    item = await persist(
      jpegWithDirectives("WOCR:REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY;"),
      "az-kw-only.jpg"
    );
    settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    assert.equal(settle.countryDetected, "AZ");
    sc = readSidecar(item.itemId);
    assert.equal(sc.outcome, "no-candidates");
    assert.equal(sc.extraction.dispatchSkipReason, "no-country-match");
    assert.equal(
      registryJournal().filter((e) => e.path.startsWith("/az/")).length,
      0,
      "keywords alone never reach the registry"
    );
    ok("AZ e2e keywords-only: no token -> no-candidates + no-country-match, ZERO DDLA calls");
  } finally {
    process.env.REGISTRY_BASE_AZ = savedBase;
    await mock.stop();
    resetRegistryJournal();
  }
}

// ---- az-adapter plan (4c): DDLA down -> indeterminate network -> deferred ------

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const savedBase = process.env.REGISTRY_BASE_AZ;
  // Closed port — connection refused, the transport-failure shape.
  process.env.REGISTRY_BASE_AZ = "http://127.0.0.1:4986/az";
  try {
    const AZ_OCR =
      "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY " +
      "Certificate No 123456/24 Date of Birth 01.01.1990 issued 29.07.2024";
    const item = await persist(jpegWithDirectives(`WOCR:${AZ_OCR};`), "az-down.jpg");
    const settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "deferred");
    assert.equal(settle.reason, "registry-network", "DDLA outage -> re-runnable deferral");
    assert.equal(settle.countryDetected, "AZ");
    const sc = readSidecar(item.itemId);
    assert.equal(sc.deferredReason, "registry-network");
    ok("AZ e2e DDLA-down: connection refused -> deferred 'registry-network' (admin re-run recovers)");
  } finally {
    process.env.REGISTRY_BASE_AZ = savedBase;
    resetRegistryJournal();
  }
}

// ---- 2026-08-24 live-defect fix: route payload for a needs-inputs settle ------
// The AZ incident shape: code READ by OCR, DOB not extractable -> the route
// must ship the needs-inputs outcome + the printed-form codeDisplay prefill,
// NOT the generic completed-with-nothing fallback that discarded the read
// code. needs-inputs is decided BEFORE any fetch, so no mock registry runs
// and the journal stays clean.

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  resetRegistryJournal();
  const AZ_NO_DOB =
    "REPUBLIC OF AZERBAIJAN STATE MARITIME AND PORT AGENCY Certificate No 123456/24 issued 29.07.2024";
  const bytes = jpegWithDirectives(`WOCR:${AZ_NO_DOB};`);
  const res = await POST(
    req({ ip: "ip-needs-inputs", contentLength: bytes.length, form: formWith(bytes, "az-nodob.jpg") })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.phase, "completed");
  assert.equal(body.ok, false, "legacy contract: needs-inputs is never an ok:true");
  assert.equal(body.countryDetected, "AZ");
  assert.equal(body.outcome.kind, "needs-inputs");
  assert.equal(body.outcome.code, "12345624", "normalized extracted code on the outcome");
  assert.equal(body.outcome.country.country, "AZ");
  assert.deepEqual(
    body.outcome.missing.map((f) => f.key),
    ["dob"]
  );
  assert.equal(body.codeDisplay, "123456/24", "printed-form prefill rides the payload");
  assert.ok(body.itemId, "the document is persisted exactly as before");
  assert.equal(registryJournal().length, 0, "needs-inputs is decided before any registry fetch");
  ok("route: needs-inputs settle ships outcome + codeDisplay '123456/24' (2026-08-24 defect fix)");
}

// ---- pdf-verify plan: worker skipReason surfaces in sidecar + chain -----------

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const item = await persist(jpegWithDirectives("WSKIP:pdf-encrypted;"), "locked.jpg");
  const settle = await vu.runAnonymousRecognition(item);
  assert.equal(settle.phase, "completed");
  const sc = readSidecar(item.itemId);
  assert.equal(sc.extraction.skipReason, "pdf-encrypted");
  assert.equal(sc.outcome, "no-candidates");
  const ev = chainEvents().filter((e) => e.itemId === item.itemId).at(-1);
  assert.equal(ev.skipReason, "pdf-encrypted", "chain event carries the skipReason");
  assert.equal(ev.pages, 4, "chain event carries the page counter");
  ok("skipReason: worker-reported reason lands in sidecar + chain — never a bare no-candidates without one");
}

// ---- pdf-verify plan: candidate-1 indeterminate -> candidate-2 still dispatched

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const uaCert = mkCert({
    code: "123452024",
    registryCountry: "UA-MARAD",
    keyTrust: "public-identifier",
    verifiedSource: "government",
    hasName: false,
    fullName: "",
  });
  let calls = 0;
  __setTestAdapter("UA-MARAD", async (inputs) => {
    calls++;
    if (inputs.doctype === "71") return { kind: "indeterminate", reason: "unrecognized-response" };
    return { kind: "match-valid", cert: uaCert };
  });
  const UA_OCR =
    "GOVERNMENT OF UKRAINE SHIPPING ADMINISTRATION Certificate NE 12345/2024 issued on 25.10.2024";
  const item = await persist(jpegWithDirectives(`WOCR:${UA_OCR};`), "ua-indet.jpg");
  const settle = await vu.runAnonymousRecognition(item);
  assert.equal(settle.phase, "completed");
  assert.equal(settle.outcome.kind, "pending-binding");
  assert.equal(calls, 2, "both doctypes reached the adapter");
  const sc = readSidecar(item.itemId);
  assert.deepEqual(
    sc.extraction.candidatesTried.map((c) => [c.doctype, c.outcome]),
    [
      ["71", "error"], // indeterminate surfaces as the dispatcher's error kind
      ["70", "pending-binding"],
    ],
    "indeterminate on 71 recorded, 70 still dispatched and landed"
  );
  ok("dispatch: candidate-1 indeterminate does NOT sink candidate-2 (deferred only when nothing later lands)");
  __setTestAdapter("UA-MARAD", undefined);
}

// ---- pdf-verify plan: deadline budget skip -> skipped-budget + deferred budget

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  const adapterCalls = { n: 0 };
  __setTestAdapter("UA-MARAD", async () => {
    adapterCalls.n++;
    return { kind: "no-match" };
  });
  // Settle clock 5s < CANDIDATE_MIN_MS 14s: the deadline guard trips before
  // ANY dispatch — every planned candidate records skipped-budget.
  vu.__setTestAnonSettleMs(5_000);
  try {
    const UA_OCR =
      "GOVERNMENT OF UKRAINE SHIPPING ADMINISTRATION Certificate NE 12345/2024 issued on 25.10.2024";
    const item = await persist(jpegWithDirectives(`WOCR:${UA_OCR};`), "ua-budget.jpg");
    const settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "deferred");
    assert.equal(settle.reason, "budget", "nothing landed -> deferred with the new budget reason");
    assert.equal(adapterCalls.n, 0, "no dispatch went out under the exhausted clock");
    const sc = readSidecar(item.itemId);
    assert.equal(sc.deferredReason, "budget");
    assert.deepEqual(
      sc.extraction.candidatesTried.map((c) => [c.doctype, c.outcome]),
      [
        ["71", "skipped-budget"],
        ["70", "skipped-budget"],
      ],
      "remaining candidates recorded with the synthetic skipped-budget marker"
    );
    ok("budget skip: exhausted settle clock -> skipped-budget markers + deferred 'budget' for the un-clocked re-run");
  } finally {
    vu.__setTestAnonSettleMs(null);
    __setTestAdapter("UA-MARAD", undefined);
  }
}

// ---- pdf-verify plan: text-layer no-signal escape hatch (shrunken budget) ------

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  // 30s test clock: retry budget = 30000 - elapsed - 14000 ≈ 15-16s — a value
  // that is UNMISTAKABLY not the fixed 28000.
  vu.__setTestAnonSettleMs(30_000);
  try {
    const junk = "junkwords ".repeat(26).trim(); // 259 chars, no keywords, no code shapes
    const OCR_AFTER = "GOVERNMENT OF UKRAINE Certificate NE 12345/2024 issued on 25.10.2024";
    let uaCalls = 0;
    __setTestAdapter("UA-MARAD", async () => {
      uaCalls++;
      return { kind: "no-match" };
    });
    const spawnsBefore = __workerSpawnLog().length;
    const item = await persist(
      jpegWithDirectives(`WJUNK:${junk};WOCR:${OCR_AFTER};`),
      "junk-layer.jpg"
    );
    const settle = await vu.runAnonymousRecognition(item);
    assert.equal(settle.phase, "completed");
    const sc = readSidecar(item.itemId);
    assert.ok(sc.extraction.notes?.includes("text-layer-no-signal"), "note recorded");
    assert.ok(sc.extraction.ocrTextAll.includes("GOVERNMENT OF UKRAINE"),
      "second (--force-ocr) result replaced the junk layer");
    assert.equal(sc.countryDetected, "UA-MARAD");
    assert.ok(uaCalls > 0, "the forced-OCR text was dispatched");

    const spawns = __workerSpawnLog().slice(spawnsBefore);
    assert.equal(spawns.length, 2, "exactly one retry");
    assert.deepEqual(
      spawns[0].slice(1),
      ["--ocr-budget-ms=28000", "--max-pages=4"],
      "first anon spawn carries the standard anon argv"
    );
    const retryArgs = spawns[1].slice(1);
    assert.ok(retryArgs.includes("--force-ocr"), "retry carries --force-ocr");
    const budgetArg = retryArgs.find((a) => a.startsWith("--ocr-budget-ms="));
    const budget = Number(budgetArg?.split("=")[1]);
    assert.ok(
      budget >= 6_000 && budget <= 16_000 && budget !== 28_000,
      `retry budget is the SHRUNKEN remaining clock, never the fixed 28000 (got ${budget})`
    );
    ok("escape hatch: junk text layer -> ONE --force-ocr retry with the shrunken remaining budget");
    __setTestAdapter("UA-MARAD", undefined);
  } finally {
    vu.__setTestAnonSettleMs(null);
  }
}

// ---- 2026-09-07 UA hint tier: OCR-degraded strong keywords (sidecar a533f540) ---
//
// The masked fixture excerpt below is ASCII-only and ';'-free (fake-worker
// directive contract). It carries the OCR-mangled authority lines, the
// slash-form first read and the slash-less second read of the number.

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();
  resetRegistryJournal();
  let uaCalls = 0;
  __setTestAdapter("UA-MARAD", async () => {
    uaCalls++;
    return { kind: "no-match" };
  });
  try {
    // (i) T1 (REQUIRED): a junk text layer that merely says "UKRAINE" is NOT
    // signal — textLayerNoSignal is STRONG-only, so the --force-ocr retry
    // still runs and the forced read (strong keywords) is what gets planned.
    vu.__setTestAnonSettleMs(30_000);
    const junkHint = ("junkwords ".repeat(22) + "holder nationality UKRAINE").trim();
    assert.ok(junkHint.length >= 200, "text-layer fast path needs >= 200 chars");
    const STRONG_AFTER =
      "GOVERNMENT OF UKRAINE SHIPPING ADMINISTRATION Certificate NE 01234/2026 issued on 05.03.2026";
    const spawnsBefore = __workerSpawnLog().length;
    const t1 = await persist(
      jpegWithDirectives(`WJUNK:${junkHint};WOCR:${STRONG_AFTER};`),
      "ua-junk-hint-layer.jpg"
    );
    const s1 = await vu.runAnonymousRecognition(t1);
    assert.equal(s1.phase, "completed");
    const sc1 = readSidecar(t1.itemId);
    assert.ok(sc1.extraction.notes?.includes("text-layer-no-signal"),
      "hint-only text layer still counts as NO signal");
    assert.ok(!sc1.extraction.notes?.includes("country-hint-only"),
      "the forced-OCR read carries STRONG keywords -> no hint note");
    assert.equal(__workerSpawnLog().length - spawnsBefore, 2, "exactly one --force-ocr retry");
    assert.equal(sc1.extraction.candidatesTried[0].country, "UA-MARAD");
    assert.equal(sc1.countryDetected, "UA-MARAD");
    assert.ok(uaCalls > 0, "the forced-OCR text was dispatched");
    vu.__setTestAnonSettleMs(null);
    ok("hint tier T1: junk text layer saying UKRAINE -> text-layer-no-signal retry; candidatesTried[0] UA-MARAD");

    // (ii) Hint-only excerpt of the incident fixture -> UA-MARAD FIRST,
    // needs-inputs (issuedOn + doctype), country attributed, note recorded,
    // ZERO adapter calls (needs-inputs returns before the budget spend).
    uaCalls = 0;
    vu.__resetVerifyUploadState();
    const journalBefore = registryJournal().length;
    const EXCERPT =
      "UKRAINE CERTIFICATE OF PROFICIENCY Ne 01234/2026 The Govemment of Ukraine certifies that " +
      "SPECIMEN SEAFARER uthored offical he Shiping Advinistation SPECIMEN OFFICIAL Ne 0123472026";
    assert.ok(/^[\x20-\x7e]*$/.test(EXCERPT) && !EXCERPT.includes(";"), "excerpt is ASCII and ;-free");
    const t2 = await persist(jpegWithDirectives(`WOCR:${EXCERPT};`), "ua-cop-hint-only.jpg");
    const s2 = await vu.runAnonymousRecognition(t2);
    assert.equal(s2.phase, "completed");
    assert.equal(s2.countryDetected, "UA-MARAD");
    assert.equal(s2.outcome?.kind, "needs-inputs");
    assert.equal(s2.outcome.country.country, "UA-MARAD");
    assert.deepEqual(s2.outcome.missing.map((f) => f.key), ["issuedOn", "doctype"]);
    const sc2 = readSidecar(t2.itemId);
    assert.equal(sc2.outcome, "needs-inputs");
    assert.equal(sc2.countryDetected, "UA-MARAD");
    assert.ok(sc2.extraction.notes?.includes("country-hint-only"), "honesty note recorded");
    assert.equal(sc2.extraction.dispatchSkipReason, null);
    assert.deepEqual(
      [sc2.extraction.candidatesTried[0].country, sc2.extraction.candidatesTried[0].code,
        sc2.extraction.candidatesTried[0].outcome],
      ["UA-MARAD", "012342026", "needs-inputs"]
    );
    assert.equal(uaCalls, 0, "needs-inputs never reaches the adapter");
    assert.equal(registryJournal().length, journalBefore, "zero outbound registry calls");
    ok("hint tier e2e: OCR-degraded CoP -> UA-MARAD needs-inputs [issuedOn, doctype], country-hint-only, 0 calls");

    // (iv) Admin re-run of the hint-only sidecar: the note is fresh per
    // attempt (delete notes precedes the settle) — never duplicated.
    const rr = await vu.rerunRecognition(t2.itemId);
    assert.equal(rr.status, "completed");
    assert.equal(rr.countryDetected, "UA-MARAD");
    const sc2b = readSidecar(t2.itemId);
    assert.deepEqual(sc2b.extraction.notes, ["country-hint-only"], "exactly one note after the re-run");
    assert.equal(sc2b.outcome, "needs-inputs");
    assert.equal(sc2b.countryDetected, "UA-MARAD");
    assert.equal(sc2b.retries.length, 1, "re-run recorded");
    assert.equal(uaCalls, 0);
    ok("hint tier rerun: notes deepEqual ['country-hint-only'] after admin re-run (fresh, not duplicated)");

    // (iii) Hint but no slash-form token -> no candidates, labelled
    // hint-no-token, NO country attribution, note still recorded.
    vu.__resetVerifyUploadState();
    const t3 = await persist(
      jpegWithDirectives("WOCR:UKRAINE certificate of proficiency;"),
      "ua-hint-no-token.jpg"
    );
    const s3 = await vu.runAnonymousRecognition(t3);
    assert.equal(s3.phase, "completed");
    assert.equal(s3.countryDetected, null, "a hint with no candidate attributes nothing");
    const sc3 = readSidecar(t3.itemId);
    assert.equal(sc3.outcome, "no-candidates");
    assert.equal(sc3.extraction.dispatchSkipReason, "hint-no-token");
    assert.equal(sc3.countryDetected, null);
    assert.ok(sc3.extraction.notes?.includes("country-hint-only"));
    assert.equal(uaCalls, 0);
    assert.equal(registryJournal().length, journalBefore, "still zero outbound registry calls");
    ok("hint tier e2e: UKRAINE + no token -> no-candidates, hint-no-token, countryDetected null, 0 calls");
  } finally {
    vu.__setTestAnonSettleMs(null);
    __setTestAdapter("UA-MARAD", undefined);
  }
}

// ---- pdf-verify plan: timeout-loser lateResult (read-merge-write + staleness) --

{
  resetRegistryAbuseState();
  vu.__resetVerifyUploadState();

  // (a) HAPPY PATH: timeout settles; no interim re-run; the loser's completion
  // is merged in as extraction.lateResult with the settle fields untouched.
  vu.__setTestAnonSettleMs(300);
  const slowItem = await persist(
    jpegWithDirectives("WDELAY:1200;WOCR:NOTHING REMARKABLE;"),
    "late-happy.jpg"
  );
  const settleA = await vu.runAnonymousRecognition(slowItem);
  assert.equal(settleA.phase, "deferred");
  assert.equal(settleA.reason, "timeout");
  vu.__setTestAnonSettleMs(null);
  await sleep(1_800); // let the loser pipeline finish + write
  const scA = readSidecar(slowItem.itemId);
  assert.equal(scA.phase, "deferred", "settle fields untouched by the late write");
  assert.equal(scA.deferredReason, "timeout");
  assert.ok(scA.extraction.lateResult, "lateResult persisted");
  assert.equal(scA.extraction.lateResult.outcome, "no-candidates");
  assert.ok(scA.extraction.lateResult.completedAt, "completion timestamp recorded");
  ok("lateResult: timeout-loser completion persisted read-merge-write, settle fields intact");

  // (b) STALENESS DROP: timeout settles -> an admin re-run completes (new
  // settle state on disk) -> the loser then finishes; per the staleness rule
  // its lateResult is DROPPED — the re-run's answer stays authoritative.
  vu.__setTestAnonSettleMs(300);
  const staleItem = await persist(
    jpegWithDirectives("WDELAY:1500;WOCR:NOTHING HERE EITHER;"),
    "late-stale.jpg"
  );
  const settleB = await vu.runAnonymousRecognition(staleItem);
  assert.equal(settleB.reason, "timeout");
  vu.__setTestAnonSettleMs(null);
  // Interim admin re-run (auth-priority lane: queues BEHIND the still-running
  // loser worker, completes after it exits but writes the sidecar first —
  // the loser still has its own registry-less tail to run).
  const rerun = await vu.rerunRecognition(staleItem.itemId);
  assert.equal(rerun.status, "completed");
  await sleep(1_000); // give the loser's write attempt time to fire + be dropped
  const scB = readSidecar(staleItem.itemId);
  assert.equal(scB.phase, "completed", "re-run's settle state intact");
  assert.equal(scB.outcome, "no-candidates");
  assert.equal(scB.retries.length, 1, "re-run recorded");
  assert.equal(scB.extraction.lateResult, undefined, "stale lateResult dropped, not merged");
  ok("lateResult: interim re-run wins — the stale loser write is dropped (staleness guard)");
}

// ---- Whole-file invariants ------------------------------------------------------

{
  assert.deepEqual(verifyAuditChain("verify-uploads"), { ok: true, brokenAt: null });
  ok("chain: verifyAuditChain green over every event this file appended");

  assert.equal(registryJournal().length, journalBaseline);
  ok("mock seam: ZERO live registry calls across every integration test");
}

console.log(`\nverify-upload-integration.test: ${pass} assertions passed`);
