// tests/product-fit-route.test.mjs — EXECUTED endpoint tests for the product-fit
// verdict upload route (POST /api/admin/outreach/product-fit).
//
// Driven through the shared vm harness (tests/_route-harness.mjs) with the REAL
// machine-token / registry / product-fit logic; only @/lib/admin-session and
// @/lib/admin-audit are stubbed (the sibling outreach-upload route's precedent).
// The point is the SECURITY shell: fail-closed when the token hash is unset,
// 404 on no credential (never reveal /admin), 401 on a presented-but-wrong or
// unconfigured Bearer, and a happy-path that actually writes the store.
//
// AUTH REUSE: this route authenticates with the EXISTING "outreach-upload"
// scope (OUTREACH_UPLOAD_TOKEN_HASH) — the same machine credential the sibling
// board upload uses — so no new secret is provisioned.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/product-fit-route.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-pf-route-"));
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
const UPLOAD_TOKEN = "c".repeat(64);

const { createRouteHarness, API } = await import("./_route-harness.mjs");

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

const pfRoute = loadTs(path.join(API, "admin", "outreach", "product-fit", "route.ts"));

let ipCounter = 0;
function mkReq({ body, bearer, encoding } = {}) {
  const headers = new Headers();
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer ?? UPLOAD_TOKEN}`);
  headers.set("x-real-ip", `10.13.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
  if (encoding !== undefined) headers.set("content-encoding", encoding);
  const raw = Buffer.from(body == null ? "" : String(body), "utf8");
  return {
    headers,
    url: "http://localhost/api/admin/outreach/product-fit",
    text: async () => raw.toString("utf8"),
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  };
}

const NOW = new Date().toISOString();
function pfJson(verdicts) {
  return JSON.stringify({
    schema_version: 1,
    generated_at: NOW,
    verdicts: verdicts ?? {
      "crew@alpha.example": { product_fit: "negative", enrich_status: "success", is_sendable_v2: false },
    },
  });
}

test("FAIL CLOSED: token hash unset + a Bearer presented → 401 (token path is OFF)", async () => {
  delete process.env.OUTREACH_UPLOAD_TOKEN_HASH;
  const res = await pfRoute.POST(mkReq({ body: pfJson() }));
  assert.equal(res.status, 401);
});

test("no credential at all → 404 (never reveal /admin exists)", async () => {
  process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);
  const res = await pfRoute.POST(mkReq({ body: pfJson(), bearer: null }));
  assert.equal(res.status, 404);
});

test("a presented-but-wrong Bearer → 401", async () => {
  process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);
  const res = await pfRoute.POST(mkReq({ body: pfJson(), bearer: "d".repeat(64) }));
  assert.equal(res.status, 401);
});

test("happy path: valid verdicts → 200, store written, one audit line", async () => {
  process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);
  auditLines = [];
  const res = await pfRoute.POST(mkReq({ body: pfJson() }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verdicts, 1);
  const stored = JSON.parse(
    fs.readFileSync(path.join(TMP, "data", "product-fit.json"), "utf8")
  );
  assert.equal(stored.verdicts["crew@alpha.example"].productFit, "negative");
  assert.equal(typeof stored.uploadedAt, "string");
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].action, "product-fit-upload");
});

test("bad payload: not JSON → 400; bad envelope → 400", async () => {
  process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);
  const notJson = await pfRoute.POST(mkReq({ body: "not json {" }));
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /Not valid JSON/);

  const badEnv = await pfRoute.POST(
    mkReq({ body: JSON.stringify({ generated_at: "nope", verdicts: {} }) })
  );
  assert.equal(badEnv.status, 400);
  assert.match(badEnv.body.error, /generated_at/);

  const unsupported = await pfRoute.POST(mkReq({ body: pfJson(), encoding: "br" }));
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.body.error, /Unsupported content-encoding/);
});
