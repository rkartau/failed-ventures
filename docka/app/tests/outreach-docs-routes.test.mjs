// tests/outreach-docs-routes.test.mjs — EXECUTED endpoint tests for the
// campaign-doc upload route (POST /api/admin/outreach/docs/[name]), driven
// through the shared vm harness (tests/_route-harness.mjs) with the REAL
// machine-token / registry / docs-store logic. Only the edges are stubbed:
// @/lib/admin-session, @/lib/admin-audit.
//
// Auth matrix pinned here — IDENTICAL to the sibling board.json route (spec
// §13): admin session OR outreach-upload Bearer; no credential → 404
// {ok:false}; presented-but-wrong Bearer → 401; Bearer path rate-limited.
// Plus the docs-specific guards: strict name allowlist (traversal can never
// reach the fs), 2 MB size cap (pre-check + byte backstop), distinct-name cap.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-docs-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-docs-routes-"));
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
const READ_TOKEN = "a".repeat(64);
process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);
process.env.LEADS_READ_TOKEN_HASH = sha256hex(READ_TOKEN);

const { createRouteHarness, API } = await import("./_route-harness.mjs");

// ---- In-memory edges -----------------------------------------------------

let currentAdmin = null;
let auditLines = [];

const { loadTs, LIB } = createRouteHarness({
  stubs: {
    "@/lib/admin-session": { adminSession: async () => currentAdmin },
    "@/lib/admin-audit": {
      recordAdminAction: async (opts) => {
        auditLines.push(opts);
      },
    },
  },
});

const docsRoute = loadTs(path.join(API, "admin", "outreach", "docs", "[name]", "route.ts"));
const store = loadTs(path.join(LIB, "outreach-docs-store.ts"));

const DOCS_DIR = path.join(TMP, "data", "outreach-docs");

let ipCounter = 0;
const reset = () => {
  currentAdmin = null;
  auditLines = [];
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
};
const asAdmin = () => {
  currentAdmin = { user: { email: "admin@example.com" } };
};

// ---- Request helper ------------------------------------------------------

function mkReq({ auth, body, contentLength, ip } = {}) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  if (contentLength != null) headers.set("content-length", String(contentLength));
  // Distinct client IP per request unless pinned — the machine-token rate
  // bucket is per-IP and this suite makes more calls than one IP's capacity.
  headers.set("x-real-ip", ip ?? `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
  const text = body == null ? "" : String(body);
  return {
    headers,
    url: "http://localhost/api/admin/outreach/docs/X.md",
    text: async () => text,
  };
}
const bearer = (t) => `Bearer ${t}`;
const params = (name) => ({ params: { name } });
const MD = "# Campaign doc\n\nhello from the pipeline\n";

// ==========================================================================
// Auth — mirror of the sibling board.json route
// ==========================================================================

test("POST: no credential at all → 404 {ok:false} (sibling deny shape)", async () => {
  reset();
  const res = await docsRoute.POST(mkReq({ body: MD }), params("DOC.md"));
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(fs.existsSync(DOCS_DIR), false);
});

test("POST: presented-but-wrong Bearer → 401; wrong-scope (leads-read) token → 401", async () => {
  reset();
  const wrong = await docsRoute.POST(mkReq({ auth: bearer("c".repeat(64)), body: MD }), params("DOC.md"));
  assert.equal(wrong.status, 401);
  const crossScope = await docsRoute.POST(mkReq({ auth: bearer(READ_TOKEN), body: MD }), params("DOC.md"));
  assert.equal(crossScope.status, 401);
  assert.equal(fs.existsSync(DOCS_DIR), false);
});

test("POST: correct outreach-upload Bearer → 200, doc stored, one audit line", async () => {
  reset();
  const res = await docsRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD }),
    params("GATE3_EMAIL_PACKAGE.md")
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.name, "GATE3_EMAIL_PACKAGE.md");
  assert.equal(res.body.bytes, new TextEncoder().encode(MD).length);
  const read = store.readOutreachDoc("GATE3_EMAIL_PACKAGE.md");
  assert.equal(read.status, "ok");
  assert.equal(read.content, MD);
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].action, "outreach-docs-upload");
  assert.equal(auditLines[0].adminEmail, "machine:outreach-upload");
});

test("POST: admin session (no Bearer) → 200, audited as the admin", async () => {
  reset();
  asAdmin();
  const res = await docsRoute.POST(mkReq({ body: MD }), params("DOC.md"));
  assert.equal(res.status, 200);
  assert.equal(auditLines[0].adminEmail, "admin@example.com");
});

test("POST: Bearer path is rate-limited per client IP (shared machine bucket)", async () => {
  reset();
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const res = await docsRoute.POST(
      mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD, ip: "10.99.99.99" }),
      params("DOC.md")
    );
    if (res.status === 429) limited++;
  }
  assert.ok(limited > 0, "expected 429s once the per-IP budget is spent");
});

// ==========================================================================
// Name validation — BEFORE any disk access
// ==========================================================================

test("POST: unsafe names → 400, nothing written", async () => {
  reset();
  const bad = [
    "../secrets.md", // traversal
    "a/b.md", // separator
    "a\\b.md", // windows separator
    ".hidden.md", // dotfile
    "notes.txt", // not .md
    "DOC.md.tmp", // would collide with the atomic-write tmp suffix
    ".md", // empty stem
    "", // empty
    `${"x".repeat(130)}.md`, // over length bound
  ];
  for (const name of bad) {
    const res = await docsRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD }), params(name));
    assert.equal(res.status, 400, `name ${JSON.stringify(name)} must be rejected`);
    assert.equal(res.body.error, "Invalid doc name");
  }
  assert.equal(fs.existsSync(DOCS_DIR), false);
});

test("POST: real pipeline doc names all validate", async () => {
  reset();
  for (const name of ["PIPELINE_BUILD_SPEC.md", "GATE1_LEGAL_PACK.md", "DEPLOY.md", "a-b.c_d.md"]) {
    const res = await docsRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD }), params(name));
    assert.equal(res.status, 200, `name ${name} must be accepted`);
  }
  assert.deepEqual(store.listOutreachDocs(), [
    "DEPLOY.md",
    "GATE1_LEGAL_PACK.md",
    "PIPELINE_BUILD_SPEC.md",
    "a-b.c_d.md",
  ]);
});

// ==========================================================================
// Size caps — shared MAX_UPLOAD_BYTES pre-check + byte backstop
// ==========================================================================

test("POST: declared content-length over 2 MB → 400 before reading the body", async () => {
  reset();
  const res = await docsRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD, contentLength: 3 * 1024 * 1024 }),
    params("DOC.md")
  );
  assert.equal(res.status, 400);
});

test("POST: actual oversized body → 400 (byte-accurate backstop)", async () => {
  reset();
  const res = await docsRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: "x".repeat(2 * 1024 * 1024 + 1) }),
    params("DOC.md")
  );
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(DOCS_DIR), false);
});

// ==========================================================================
// Overwrite + distinct-name cap
// ==========================================================================

test("POST: overwriting an existing doc updates content (changed-hash push)", async () => {
  reset();
  await docsRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: "v1" }), params("DOC.md"));
  const res = await docsRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: "v2" }), params("DOC.md"));
  assert.equal(res.status, 200);
  assert.equal(store.readOutreachDoc("DOC.md").content, "v2");
  assert.deepEqual(store.listOutreachDocs(), ["DOC.md"]);
});

test("POST: distinct-name cap refuses a NEW name, still allows overwrites", async () => {
  reset();
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  for (let i = 0; i < store.MAX_DOC_COUNT; i++) {
    fs.writeFileSync(path.join(DOCS_DIR, `doc${i}.md`), "seed", "utf-8");
  }
  const refused = await docsRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: MD }),
    params("one-too-many.md")
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Too many docs/);
  const overwrite = await docsRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: "updated" }),
    params("doc0.md")
  );
  assert.equal(overwrite.status, 200);
  assert.equal(store.readOutreachDoc("doc0.md").content, "updated");
});

// ==========================================================================
// Store hygiene + admin-guard meta
// ==========================================================================

test("store: listOutreachDocs hides tmp/stray names; tolerant reads never throw", async () => {
  reset();
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, "good.md"), "ok", "utf-8");
  fs.writeFileSync(path.join(DOCS_DIR, "good.md.tmp"), "half-written", "utf-8");
  fs.writeFileSync(path.join(DOCS_DIR, "stray.txt"), "nope", "utf-8");
  assert.deepEqual(store.listOutreachDocs(), ["good.md"]);
  assert.equal(store.readOutreachDoc("missing.md").status, "empty");
  assert.equal(store.readOutreachDoc("../etc/passwd").status, "empty");
  assert.throws(() => store.writeOutreachDoc("../x.md", "evil"));
});

test("checkAdminApiRoutes: the docs route passes the admin-API positive lock", async () => {
  const { checkAdminApiRoutes } = await import("../tests/isolation-static.mjs");
  const routePath = path.join(API, "admin", "outreach", "docs", "[name]", "route.ts");
  const src = fs.readFileSync(routePath, "utf8");
  assert.deepEqual(
    checkAdminApiRoutes([{ path: "app/api/admin/outreach/docs/[name]/route.ts", src }]),
    []
  );
});
