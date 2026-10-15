// tests/outreach-upload-route.test.mjs — EXECUTED endpoint tests for the
// board.json snapshot upload route (POST /api/admin/outreach), Increment 6:
//   * payload cap raised 2 MB → 10 MB — boundary pinned at the byte level;
//   * Content-Encoding: gzip accepted, the 10 MB cap enforced on the
//     DECOMPRESSED size (gzip-bomb fixture: ~11 MB of zeros in a ~11 KB body
//     must die with 400, never reach JSON.parse);
//   * invalid gzip → 400; unsupported encodings → 400;
//   * the sibling docs route KEEPS its 2 MB cap (shared-infra guard).
//
// Driven through the shared vm harness (tests/_route-harness.mjs) with the
// REAL machine-token / registry / snapshot logic; only @/lib/admin-session and
// @/lib/admin-audit are stubbed (docs-route precedent).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-upload-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-upload-route-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const UPLOAD_TOKEN = "b".repeat(64);
process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);

const { createRouteHarness, API } = await import("./_route-harness.mjs");
const { MAX_UPLOAD_BYTES } = await import("@/lib/outreach-snapshot");
const { MAX_DOC_UPLOAD_BYTES } = await import("@/lib/outreach-docs-store");

let auditLines = [];
const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/admin-session": { adminSession: async () => null },
    "@/lib/admin-audit": {
      recordAdminAction: async (opts) => {
        auditLines.push(opts);
      },
    },
  },
});

const boardRoute = loadTs(path.join(API, "admin", "outreach", "route.ts"));

let ipCounter = 0;
function mkReq({ body, gzip = false, encoding, contentLength } = {}) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${UPLOAD_TOKEN}`);
  headers.set(
    "x-real-ip",
    `10.11.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`
  );
  const raw = gzip ? body : Buffer.from(body == null ? "" : String(body), "utf8");
  if (encoding !== undefined) headers.set("content-encoding", encoding);
  else if (gzip) headers.set("content-encoding", "gzip");
  if (contentLength != null) headers.set("content-length", String(contentLength));
  return {
    headers,
    url: "http://localhost/api/admin/outreach",
    text: async () => raw.toString("utf8"),
    arrayBuffer: async () =>
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  };
}

const NOW_ISO = new Date().toISOString();
function boardJson(extraLeadBytes = 0) {
  const board = {
    schema_version: 3,
    generated_at: NOW_ISO,
    campaign: { sends_today: 1, daily_cap: 50, bounce_rate_pct: 0, halted: false },
    leads: [
      {
        send_key: "LD1",
        company: "Acme",
        country: "EE",
        angle: "A",
        stage: "signed_up",
        sentiment: "neutral",
        last_event: "signup",
        ...(extraLeadBytes > 0
          ? { events: [{ kind: "sent", ts: NOW_ISO, body_full: "x".repeat(Math.min(extraLeadBytes, 20000)) }] }
          : {}),
      },
    ],
  };
  return JSON.stringify(board);
}

test("(i6) plain upload under the 10 MB cap → 200; snapshot stored with events", async () => {
  auditLines = [];
  const res = await boardRoute.POST(mkReq({ body: boardJson(1000) }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const stored = JSON.parse(
    fs.readFileSync(path.join(TMP, "data", "outreach-snapshot.json"), "utf8")
  );
  assert.equal(stored.leads[0].events.length, 1);
  assert.equal(auditLines.length, 1);
});

test("(i6) 10 MB boundary: a body one byte OVER the cap → 400; padding inside the cap → 200", async () => {
  // Build a valid board padded with a filler key to hit exact sizes.
  const base = boardJson();
  const overPad = MAX_UPLOAD_BYTES - Buffer.byteLength(base, "utf8") + 1;
  const over = base.slice(0, -1) + `,"_pad":"${"x".repeat(overPad)}"}`;
  assert.ok(Buffer.byteLength(over, "utf8") > MAX_UPLOAD_BYTES);
  const rOver = await boardRoute.POST(mkReq({ body: over }));
  assert.equal(rOver.status, 400);
  assert.equal(rOver.body.error, "File too large (max 10 MB)");

  const underPad = MAX_UPLOAD_BYTES - Buffer.byteLength(base, "utf8") - 20;
  const under = base.slice(0, -1) + `,"_pad":"${"x".repeat(underPad)}"}`;
  assert.ok(Buffer.byteLength(under, "utf8") <= MAX_UPLOAD_BYTES);
  const rUnder = await boardRoute.POST(mkReq({ body: under }));
  assert.equal(rUnder.status, 200);
});

test("(i6) declared content-length over the cap → 400 before the body is read", async () => {
  const res = await boardRoute.POST(
    mkReq({ body: boardJson(), contentLength: MAX_UPLOAD_BYTES + 1 })
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "File too large (max 10 MB)");
});

test("(i6) gzip upload: valid compressed board inflates and stores → 200", async () => {
  auditLines = [];
  const res = await boardRoute.POST(
    mkReq({ body: zlib.gzipSync(Buffer.from(boardJson(5000), "utf8")), gzip: true })
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(auditLines.length, 1);
});

test("(i6) gzip-bomb: tiny body inflating past 10 MB → 400 too-large, inflation aborted", async () => {
  // ~11 MB of zeros compresses to ~11 KB — the cap must bind on the
  // DECOMPRESSED size and abort without materializing the bomb.
  const bomb = zlib.gzipSync(Buffer.alloc(11 * 1024 * 1024, 0));
  assert.ok(bomb.length < 64 * 1024, "fixture really is tiny on the wire");
  const res = await boardRoute.POST(mkReq({ body: bomb, gzip: true }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "File too large (max 10 MB)");
});

test("(i6) gzip upload exactly at the decompressed boundary: 10 MB OK, 10 MB+1 refused", async () => {
  const base = boardJson();
  const pad = MAX_UPLOAD_BYTES - Buffer.byteLength(base, "utf8") - 20;
  const atCap = base.slice(0, -1) + `,"_pad":"${"x".repeat(pad)}"}`;
  const okRes = await boardRoute.POST(
    mkReq({ body: zlib.gzipSync(Buffer.from(atCap, "utf8")), gzip: true })
  );
  assert.equal(okRes.status, 200);

  const overPad = MAX_UPLOAD_BYTES - Buffer.byteLength(base, "utf8") + 1;
  const overCap = base.slice(0, -1) + `,"_pad":"${"x".repeat(overPad)}"}`;
  const overRes = await boardRoute.POST(
    mkReq({ body: zlib.gzipSync(Buffer.from(overCap, "utf8")), gzip: true })
  );
  assert.equal(overRes.status, 400);
  assert.equal(overRes.body.error, "File too large (max 10 MB)");
});

test("(i6) invalid gzip bytes → 400 Not valid gzip; unsupported encoding → 400", async () => {
  const bad = await boardRoute.POST(
    mkReq({ body: Buffer.from("definitely not gzip"), gzip: true })
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "Not valid gzip");

  const br = await boardRoute.POST(mkReq({ body: boardJson(), encoding: "br" }));
  assert.equal(br.status, 400);
  assert.match(br.body.error, /Unsupported content-encoding/);

  // identity is a no-op alias for plain.
  const identity = await boardRoute.POST(mkReq({ body: boardJson(), encoding: "identity" }));
  assert.equal(identity.status, 200);
});

test("(i6) sibling guard: the docs route cap STAYS 2 MB while the board cap moved to 10 MB", () => {
  assert.equal(MAX_DOC_UPLOAD_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
});
