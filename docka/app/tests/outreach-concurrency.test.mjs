// Concurrency tests for the append-only event sink (plan §2 C4, tests o/p).
// These exercise the segment lock (lib/segment-lock) under load — in-process
// interleaving AND true cross-process workers straddling a rollover.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-concurrency.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-outreach-conc-"));
process.chdir(TMP);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On Windows, `--import` and the entry script must be file:// URLs, not `C:\…`
// paths (ERR_UNSUPPORTED_ESM_URL_SCHEME otherwise).
const REGISTER = pathToFileURL(path.join(__dirname, "_register-alias.mjs")).href;
// The entry script stays a plain absolute path (node resolves the main entry
// fine); only `--import` requires the file:// URL on Windows.
const WORKER = path.join(__dirname, "helpers", "append-worker.mjs");

const { appendEvent, readEventsSince, aggregateBySendKey, MAX_LINE_BYTES } = await import(
  "@/lib/outreach-events"
);

const DATA = path.join(TMP, "data");
function freshData() {
  fs.rmSync(DATA, { recursive: true, force: true });
}

function allLines() {
  const files = fs
    .readdirSync(DATA)
    .filter((f) => /^outreach-events-\d+\.jsonl$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const lines = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(DATA, f), "utf8");
    for (const l of txt.split("\n")) if (l.length) lines.push(l);
  }
  return lines;
}

/** Spawn a worker process; resolves on exit code 0. */
function runWorker(event, sendKeyPrefix, count, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", REGISTER, WORKER, event, sendKeyPrefix, String(count)],
      { cwd: TMP, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] }
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${err}`))
    );
  });
}

// ============================ (C4) 500 concurrent ===========================

test("(C4) 500 concurrent in-process appends → exactly 500 well-formed lines, zero torn", async () => {
  freshData();
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      appendEvent({ event: "unsub", send_key: "sk" + i, message_id: "m" + i, touch: i })
    )
  );
  const lines = allLines();
  assert.equal(lines.length, 500, "exactly 500 lines");
  let parsed = 0;
  const keys = new Set();
  for (const l of lines) {
    const row = JSON.parse(l); // throws if torn → test fails
    parsed++;
    keys.add(row.event_key);
  }
  assert.equal(parsed, 500);
  assert.equal(keys.size, 500, "all distinct event_keys — none lost or clobbered");
});

// ===================== (o) concurrent emoji byte-guard ======================

test("(o) concurrent appends of a 4090-emoji meta → every line < 4000 bytes, valid UTF-8", async () => {
  freshData();
  const meta = "🚀".repeat(4090);
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      appendEvent({ event: "open", send_key: "e" + i, message_id: "m" + i, touch: i, meta })
    )
  );
  const files = fs.readdirSync(DATA).filter((f) => /^outreach-events-\d+\.jsonl$/.test(f));
  let count = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DATA, f)); // bytes
    for (const lineBuf of splitKeepBytes(raw)) {
      if (lineBuf.length === 0) continue;
      assert.ok(lineBuf.length < MAX_LINE_BYTES, `line ${lineBuf.length} bytes < ${MAX_LINE_BYTES}`);
      const parsed = JSON.parse(lineBuf.toString("utf8")); // valid UTF-8 + JSON
      for (const cp of parsed.meta) assert.equal(cp, "🚀"); // whole codepoints only
      count++;
    }
  }
  assert.equal(count, 40);
});

function splitKeepBytes(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

// ================= (p) cross-process rollover + reader snapshot ==============

test("(p) TRUE concurrent worker processes across a low-ceiling rollover → zero loss", async () => {
  freshData();
  const LOW = { OUTREACH_SEGMENT_MAX_BYTES: "300" }; // force many rollovers under load

  // Two concurrent unsub workers straddling rollovers, plus open/booking load.
  await Promise.all([
    runWorker("unsub", "unsubA", 25, LOW),
    runWorker("unsub", "unsubB", 25, LOW),
    runWorker("open", "openW", 40, LOW),
    runWorker("booking", "bookW", 20, LOW),
  ]);

  const { events, skipped } = readEventsSince();
  assert.equal(skipped, 0, "no torn/corrupt lines across cross-process rollovers");
  assert.equal(events.length, 25 + 25 + 40 + 20, "every event from every process landed");

  // Assert the compliance-critical unsubs specifically survived (both send_keys).
  const agg = aggregateBySendKey(events);
  assert.equal(agg.get("unsubA")?.unsubbed, true, "unsubA suppression present");
  assert.equal(agg.get("unsubB")?.unsubbed, true, "unsubB suppression present");

  // Multiple segments were actually created (rollover really happened).
  const segs = fs.readdirSync(DATA).filter((f) => /^outreach-events-\d+\.jsonl$/.test(f));
  assert.ok(segs.length >= 2, `rollover occurred: ${segs.length} segments`);
});

test("(p) reader snapshots interleaved WITH cross-process writer rollovers → never torn, never lost", async () => {
  freshData();
  const LOW = { OUTREACH_SEGMENT_MAX_BYTES: "300" };

  // Start writer processes, and while they run, repeatedly read from the app side.
  const writers = Promise.all([
    runWorker("open", "rA", 60, LOW),
    runWorker("open", "rB", 60, LOW),
  ]);

  let reads = 0;
  let done = false;
  // .finally so a worker REJECTION also stops the loop (else it would spin to the
  // test timeout); the await below then surfaces the real error.
  writers.finally(() => (done = true));
  while (!done) {
    const r = readEventsSince(); // app-side reader (whole-line only)
    assert.equal(r.skipped, 0, "reader never observes a torn/half-rolled line");
    reads++;
    await new Promise((res) => setTimeout(res, 2));
  }
  await writers;

  const final = readEventsSince();
  assert.equal(final.skipped, 0);
  assert.equal(final.events.length, 120, "no event lost despite concurrent rollovers during reads");
  assert.ok(reads > 0);
});
