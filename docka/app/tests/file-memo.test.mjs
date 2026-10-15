// tests/file-memo.test.mjs — B8: the shared (mtimeMs, size) JSON memo.
//
// Pins the exact semantics the product-fit store used to hand-roll, now shared
// with lib/docka-sources.ts: missing drops the entry, invalid/unreadable are
// memoised, a hit returns the SAME object (identity), one entry per path.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { memoJsonFile, __clearFileMemo } from "@/lib/file-memo";
import { loadProductFitLookup, __clearProductFitCache } from "@/lib/product-fit-store";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "file-memo-"));

beforeEach(() => {
  __clearFileMemo();
  __clearProductFitCache();
});

test("missing file → {missing}; parse never runs", () => {
  const p = path.join(TMP, "missing.json");
  fs.rmSync(p, { force: true });
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: raw };
  };
  const r = memoJsonFile(p, parse);
  assert.equal(r.status, "missing");
  assert.equal(calls, 0);
});

test("ok → missing DROPS the entry → a reappearing file re-parses (no stale hit)", () => {
  const p = path.join(TMP, "reappear.json");
  fs.writeFileSync(p, JSON.stringify({ v: 1 }), "utf8");
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: raw };
  };
  const a = memoJsonFile(p, parse);
  assert.equal(a.status, "ok");
  assert.equal(calls, 1);
  fs.rmSync(p);
  const b = memoJsonFile(p, parse);
  assert.equal(b.status, "missing");
  // Recreate with identical content (possibly identical size) — must NOT be a
  // stale memo hit; the entry was dropped on the missing stat.
  fs.writeFileSync(p, JSON.stringify({ v: 1 }), "utf8");
  const c = memoJsonFile(p, parse);
  assert.equal(c.status, "ok");
  assert.equal(calls, 2);
});

test("invalid JSON → {invalid} carrying stat, memoised (parse never called)", () => {
  const p = path.join(TMP, "bad.json");
  fs.writeFileSync(p, "not json {", "utf8");
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: raw };
  };
  const a = memoJsonFile(p, parse);
  assert.equal(a.status, "invalid");
  assert.equal(calls, 0);
  assert.equal(typeof a.mtimeMs, "number");
  assert.equal(typeof a.size, "number");
  const b = memoJsonFile(p, parse);
  assert.equal(b, a); // memo hit — same object
});

test("size > maxBytes → {invalid} WITHOUT reading or parsing", () => {
  const p = path.join(TMP, "big.json");
  fs.writeFileSync(p, JSON.stringify({ big: "x".repeat(1000) }), "utf8");
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: raw };
  };
  const a = memoJsonFile(p, parse, { maxBytes: 10 });
  assert.equal(a.status, "invalid");
  assert.match(a.error, /too large/);
  assert.equal(calls, 0);
});

test("parse → {ok:false} maps to {invalid} carrying its error, memoised", () => {
  const p = path.join(TMP, "shape.json");
  fs.writeFileSync(p, JSON.stringify({ nope: true }), "utf8");
  let calls = 0;
  const parse = () => {
    calls++;
    return { ok: false, error: "bad shape" };
  };
  const a = memoJsonFile(p, parse);
  assert.equal(a.status, "invalid");
  assert.equal(a.error, "bad shape");
  assert.equal(calls, 1);
  const b = memoJsonFile(p, parse);
  assert.equal(b, a);
  assert.equal(calls, 1); // not re-parsed
});

test("stable (mtime,size) → SAME object identity; new mtime → fresh parse", () => {
  const p = path.join(TMP, "stable.json");
  fs.writeFileSync(p, JSON.stringify({ n: 1 }), "utf8");
  fs.utimesSync(p, 1_700_000_100, 1_700_000_100);
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: { ...raw } };
  };
  const a = memoJsonFile(p, parse);
  assert.equal(a.status, "ok");
  assert.equal(memoJsonFile(p, parse), a); // identity
  assert.equal(calls, 1);
  fs.utimesSync(p, 1_700_000_200, 1_700_000_200);
  const c = memoJsonFile(p, parse);
  assert.notEqual(c, a);
  assert.equal(calls, 2);
});

test("directory path → {unreadable} carrying stat, memoised; product-fit adapter → corrupt version", () => {
  const d = path.join(TMP, "adir");
  fs.mkdirSync(d, { recursive: true });
  let calls = 0;
  const parse = (raw) => {
    calls++;
    return { ok: true, value: raw };
  };
  const a = memoJsonFile(d, parse);
  assert.equal(a.status, "unreadable");
  assert.equal(typeof a.mtimeMs, "number");
  assert.equal(typeof a.size, "number");
  assert.equal(calls, 0);
  const b = memoJsonFile(d, parse);
  assert.equal(b, a); // memo hit — a second call does not re-read
  // The product-fit adapter degrades an unreadable file to a corrupt-tagged
  // empty lookup (identity held across calls).
  __clearFileMemo(d);
  const lk = loadProductFitLookup(d);
  assert.equal(lk.verdicts.size, 0);
  assert.equal(lk.generatedAt, null);
  assert.match(lk.version, /^corrupt:/);
  assert.equal(loadProductFitLookup(d), lk); // same object across calls
});

test("one entry per path; __clearFileMemo(path) clears one, __clearFileMemo() clears all", () => {
  const p1 = path.join(TMP, "e1.json");
  const p2 = path.join(TMP, "e2.json");
  fs.writeFileSync(p1, JSON.stringify({ a: 1 }), "utf8");
  fs.writeFileSync(p2, JSON.stringify({ b: 2 }), "utf8");
  let c1 = 0;
  let c2 = 0;
  const parse1 = (raw) => {
    c1++;
    return { ok: true, value: raw };
  };
  const parse2 = (raw) => {
    c2++;
    return { ok: true, value: raw };
  };
  const a1 = memoJsonFile(p1, parse1);
  const a2 = memoJsonFile(p2, parse2);
  assert.equal(memoJsonFile(p1, parse1), a1); // independent hits
  assert.equal(memoJsonFile(p2, parse2), a2);
  assert.equal(c1, 1);
  assert.equal(c2, 1);

  __clearFileMemo(p1); // clear ONLY p1
  assert.notEqual(memoJsonFile(p1, parse1), a1);
  assert.equal(memoJsonFile(p2, parse2), a2); // p2 untouched
  assert.equal(c1, 2);
  assert.equal(c2, 1);

  __clearFileMemo(); // clear all
  memoJsonFile(p2, parse2);
  assert.equal(c2, 2);
});
