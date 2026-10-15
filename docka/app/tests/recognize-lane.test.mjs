// Lane-level units for the pdf-verify plan (A3): worker argv plumbing per
// lane (anon soft budget + page cap vs auth legacy argv-less semantics) and
// the parent-side RSS watchdog's platform gate / kill path.
//
// Uses the verify-upload-integration.test.mjs worker seam: recognize.ts
// resolves the worker script from process.cwd() at import time, so a FAKE
// deterministic worker in TMP/scripts stands in for tesseract.
//
// Run: node --import ./tests/_register-alias.mjs tests/recognize-lane.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.REGISTRY_MOCK = "1";
// Low RSS threshold so the Linux-only kill-path test balloons past it fast.
// (Clamped to a 64 MB floor in recognize.ts — set exactly that.)
process.env.WORKER_RSS_LIMIT_MB = "64";

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-recognize-lane-"));
fs.mkdirSync(path.join(TMP, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "scripts", "recognize-worker.mjs"),
  `import fs from "node:fs";
const argvRest = process.argv.slice(2);
const filePath = argvRest.find((a) => !a.startsWith("--")) ?? "";
let text = "";
try { text = fs.readFileSync(filePath).toString("latin1"); } catch {}
if (text.includes("WBALLOON;")) {
  // Memory-balloon mode (RSS-watchdog kill path): allocate ~300 MB TOUCHED
  // pages and stay alive far longer than the watchdog poll interval.
  const held = [];
  for (let i = 0; i < 30; i++) { const b = Buffer.alloc(10 * 1024 * 1024); b.fill(i); held.push(b); }
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ qrText: null, ocrText: "survived:" + held.length, ocrTextAll: "" }));
  }, 15000);
} else {
  process.stdout.write(JSON.stringify({ qrText: null, ocrText: "LANEOK", ocrTextAll: "LANEOK" }));
}
`,
  "utf-8"
);
process.chdir(TMP);

const { runWorkerAnon, runWorkerAuthPriority, ANON_WORKER_ARGS, __workerSpawnLog } =
  await import("@/lib/recognize");

const laneFile = (contents, name) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, contents);
  return p;
};

// ---- argv plumbing (assert via the mock-mode spawn-log seam) ----------------

{
  const before = __workerSpawnLog().length;

  const anon = runWorkerAnon(laneFile("plain", "anon.jpg"));
  assert.ok(anon, "anon lane accepts the job");
  const anonR = await anon;
  assert.equal(anonR.ocrText, "LANEOK");

  const authR = await runWorkerAuthPriority(laneFile("plain", "auth.jpg"));
  assert.equal(authR.ocrText, "LANEOK");

  const custom = runWorkerAnon(laneFile("plain", "anon2.jpg"), [
    "--ocr-budget-ms=1234",
    "--max-pages=4",
    "--force-ocr",
  ]);
  await custom;

  const spawns = __workerSpawnLog().slice(before);
  assert.equal(spawns.length, 3);
  assert.deepEqual(
    spawns[0].slice(1),
    [...ANON_WORKER_ARGS],
    "anon lane appends --ocr-budget-ms=28000 --max-pages=4"
  );
  assert.deepEqual(spawns[0].slice(1), ["--ocr-budget-ms=28000", "--max-pages=4"]);
  assert.deepEqual(spawns[1].slice(1), [], "auth lane appends NOTHING (legacy argv semantics)");
  assert.deepEqual(
    spawns[2].slice(1),
    ["--ocr-budget-ms=1234", "--max-pages=4", "--force-ocr"],
    "explicit caller args (escape-hatch retry) pass through verbatim"
  );
  ok("argv plumbing: anon budget+cap appended, auth argv-less, explicit args verbatim");
}

// ---- RSS watchdog: platform gate + (Linux-only) kill path -------------------

if (process.platform !== "linux") {
  // Non-Linux: the watchdog installs NO poll (no /proc) — a worker that would
  // balloon on Linux simply runs to its own completion under WORKER_TIMEOUT.
  // The kill-path assertion below is Linux-gated by design (prod-box guard,
  // not a dev feature).
  const r = await runWorkerAuthPriority(laneFile("plain", "no-watchdog.jpg"));
  assert.equal(r.skipReason ?? null, null, "no watchdog interference off-Linux");
  ok(`watchdog: platform-gated no-op on ${process.platform} (kill path exercised on Linux only)`);
} else {
  // Linux: the balloon worker crosses the 64 MB threshold; the watchdog flags
  // + SIGKILLs; resolution comes from the execFile callback on ACTUAL exit
  // with skipReason worker-crash — and the lane keeps pumping afterwards.
  const t0 = Date.now();
  const r = await runWorkerAuthPriority(laneFile("WBALLOON;", "balloon.jpg"));
  const ms = Date.now() - t0;
  assert.equal(r.skipReason, "worker-crash", "watchdog kill surfaces as worker-crash");
  assert.equal(r.ocrText, "", "the balloon worker never got to answer");
  assert.ok(ms < 15_000, `killed by the watchdog, not the worker's own 15s timer (${ms}ms)`);
  const after = await runWorkerAuthPriority(laneFile("plain", "after-balloon.jpg"));
  assert.equal(after.ocrText, "LANEOK", "lane pumps on after the kill (exit-gated resolve)");
  ok("watchdog (Linux): balloon SIGKILLed, resolve on real exit with worker-crash, lane not wedged");
}

console.log(`\nrecognize-lane.test: ${pass} assertions passed`);
