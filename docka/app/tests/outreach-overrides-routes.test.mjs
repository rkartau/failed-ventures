// tests/outreach-overrides-routes.test.mjs — EXECUTED endpoint tests for the
// manual-hold override routes, driven through the shared vm harness
// (tests/_route-harness.mjs) with the REAL machine-token / registry / override
// logic. Only the edges are stubbed: @/lib/db (in-memory), @/lib/admin-session,
// @/lib/admin-audit, @/lib/outreach-snapshot-store.
//
// Auth matrix pinned here (§5): GET = leads-read Bearer ONLY, 401 ALWAYS +
// machine-only (adminSession does NOT grant GET); POST = adminSession ONLY,
// 404-then-401; ack = outreach-upload Bearer, scopes DISTINCT; held-events =
// adminSession, side-effect-free + input validation [B4].
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-overrides-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-overrides-routes-"));
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
const READ_TOKEN = "a".repeat(64);
const UPLOAD_TOKEN = "b".repeat(64);
process.env.LEADS_READ_TOKEN_HASH = sha256hex(READ_TOKEN);
process.env.OUTREACH_UPLOAD_TOKEN_HASH = sha256hex(UPLOAD_TOKEN);

const { createRouteHarness, API, APP } = await import("./_route-harness.mjs");
const { emptyOverrides } = await import("@/lib/outreach-overrides");

// ---- In-memory edges -----------------------------------------------------

let db = { outreachOverrides: emptyOverrides("2026-08-24T00:00:00.000Z") };
let currentAdmin = null;
let snapshot = { status: "empty" };
/** Captured admin-audit rows — the wave-3 tests assert what does NOT reach them. */
let audits = [];

const dbStub = {
  readDB: () => db,
  updateDB: (fn) => Promise.resolve(fn(db)),
};
const reset = () => {
  db = { outreachOverrides: emptyOverrides("2026-08-24T00:00:00.000Z") };
  currentAdmin = null;
  snapshot = { status: "empty" };
  audits = [];
};

const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub,
    "@/lib/admin-session": { adminSession: async () => currentAdmin },
    "@/lib/admin-audit": {
      recordAdminAction: async (row) => {
        audits.push(row);
        return {};
      },
    },
    "@/lib/outreach-snapshot-store": { readOutreachSnapshot: () => snapshot },
  },
});

const overridesRoute = loadTs(path.join(API, "admin", "outreach", "overrides", "route.ts"));
const ackRoute = loadTs(path.join(API, "admin", "outreach", "overrides", "ack", "route.ts"));
const heldEventsRoute = loadTs(path.join(API, "admin", "outreach", "overrides", "held-events", "route.ts"));

// ---- Request helper ------------------------------------------------------

function mkReq({ auth, body, url, contentLength } = {}) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  if (contentLength != null) headers.set("content-length", String(contentLength));
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers,
    url: url ?? "http://localhost/api/admin/outreach/overrides",
    text: async () => text,
  };
}
const bearer = (t) => `Bearer ${t}`;
const asAdmin = () => {
  currentAdmin = { user: { email: "admin@example.com" } };
};

// ==========================================================================
// GET — leads-read Bearer ONLY, machine-only, 401 always
// ==========================================================================

test("GET: no Bearer → 401 (never 404); machine-only (admin session does NOT grant GET)", async () => {
  reset();
  assert.equal((await overridesRoute.GET(mkReq())).status, 401);
  asAdmin(); // a browser admin with no Bearer still 401s — GET is machine-only.
  assert.equal((await overridesRoute.GET(mkReq())).status, 401);
});

test("GET: wrong-scope token (upload on read) → 401; correct leads-read → 200 with wire", async () => {
  reset();
  assert.equal((await overridesRoute.GET(mkReq({ auth: bearer(UPLOAD_TOKEN) }))).status, 401);
  db.outreachOverrides.holds.leads.push("sk-1");
  db.outreachOverrides.version = 7;
  const res = await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 7);
  assert.deepEqual(res.body.holds.leads, ["sk-1"]);
});

// ==========================================================================
// POST — adminSession ONLY, 404-then-401, version bump, move rules
// ==========================================================================

test("POST: no admin session → 404 (mirror outreach POST no-credential shape)", async () => {
  reset();
  const res = await overridesRoute.POST(mkReq({ body: { op: "hold", scope: "lead", key: "sk-1" } }));
  assert.equal(res.status, 404);
});

test("POST: admin hold → 200 + version bump + store mutated", async () => {
  reset();
  asAdmin();
  const res = await overridesRoute.POST(mkReq({ body: { op: "hold", scope: "lead", key: "sk-1" } }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 1);
  assert.deepEqual(db.outreachOverrides.holds.leads, ["sk-1"]);
});

test("POST: bad body / unknown op → 400", async () => {
  reset();
  asAdmin();
  assert.equal((await overridesRoute.POST(mkReq({ body: "not json{" }))).status, 400);
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "nope" } }))).status, 400);
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "hold", scope: "x", key: "k" } }))).status, 400);
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "move", sendKey: "k" } }))).status, 400);
});

test("[R7] POST move-target rules: active→200, target suppressed→400, unknown→400, currently-suppressed lead→400", async () => {
  reset();
  asAdmin();
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "move", sendKey: "k", toStage: "conversation" } }))).status, 200);
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "move", sendKey: "k", toStage: "suppressed" } }))).status, 400);
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "move", sendKey: "k", toStage: "bogus" } }))).status, 400);

  // A lead whose CURRENT board stage is suppressed → 400 (resolved from the snapshot).
  snapshot = { status: "ok", snapshot: { leads: [{ sendKey: "sup", stage: "suppressed", company: "X" }] } };
  assert.equal((await overridesRoute.POST(mkReq({ body: { op: "move", sendKey: "sup", toStage: "conversation" } }))).status, 400);
});

// ==========================================================================
// ack — outreach-upload Bearer, scopes DISTINCT
// ==========================================================================

test("ack: no Bearer → 404; read-token (wrong scope) → 401; upload-token → 200", async () => {
  reset();
  assert.equal((await ackRoute.POST(mkReq({ body: { moveIds: [] } }))).status, 404);
  assert.equal((await ackRoute.POST(mkReq({ auth: bearer(READ_TOKEN), body: { moveIds: [] } }))).status, 401);
  const ok = await ackRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [] } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

test("ack: flips a pending move to applied + bumps version (upload scope)", async () => {
  reset();
  // Seed one pending move.
  db.outreachOverrides.moves.push({
    id: 1, sendKey: "a", toStage: "conversation", createdBy: "x",
    createdAt: "2026-08-24T00:00:00.000Z", status: "pending", appliedAt: null, rejectedReason: null,
  });
  db.outreachOverrides.moveSeq = 1;
  const before = db.outreachOverrides.version;
  const res = await ackRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [1] } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applied, [1]);
  assert.equal(db.outreachOverrides.moves[0].status, "applied");
  assert.ok(db.outreachOverrides.version > before);
});

// ==========================================================================
// held-events [V6][B4] — adminSession, side-effect-free, input validation
// ==========================================================================

test("held-events: non-admin → 404; admin + valid inputs → 200 (empty on this HEAD)", async () => {
  reset();
  const q = "http://localhost/x?sendKey=sk-1&since=2026-08-24T00:00:00.000Z";
  assert.equal((await heldEventsRoute.GET(mkReq({ url: q }))).status, 404);
  asAdmin();
  const res = await heldEventsRoute.GET(mkReq({ url: q }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.events, []);
});

test("[B4] held-events: validates sendKey + since (ISO-8601)", async () => {
  reset();
  asAdmin();
  assert.equal((await heldEventsRoute.GET(mkReq({ url: "http://localhost/x?since=2026-08-24T00:00:00.000Z" }))).status, 400, "missing sendKey");
  assert.equal((await heldEventsRoute.GET(mkReq({ url: "http://localhost/x?sendKey=sk-1" }))).status, 400, "missing since");
  assert.equal((await heldEventsRoute.GET(mkReq({ url: "http://localhost/x?sendKey=sk-1&since=not-a-date" }))).status, 400, "bad since");
});

test("held-events: read is SIDE-EFFECT-FREE (db byte-identical before/after)", async () => {
  reset();
  asAdmin();
  db.outreachOverrides.holds.leads.push("sk-1");
  const snap = JSON.stringify(db);
  await heldEventsRoute.GET(mkReq({ url: "http://localhost/x?sendKey=sk-1&since=2026-08-24T00:00:00.000Z" }));
  assert.equal(JSON.stringify(db), snap, "held-events must not mutate any state");
});

// ==========================================================================
// draft-action (wave 3 M2) — adminSession + CSRF + rate limit; SENDS NOTHING
// ==========================================================================

const draftActionRoute = loadTs(path.join(API, "admin", "outreach", "draft-action", "route.ts"));

/** A same-origin JSON request, which is what the CSRF stance requires. */
function mkPost({ body, origin = "http://localhost", host = "localhost", contentType = "application/json", contentLength } = {}) {
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);
  if (origin !== null) headers.set("origin", origin);
  headers.set("host", host);
  if (contentLength != null) headers.set("content-length", String(contentLength));
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers,
    url: "http://localhost/api/admin/outreach/draft-action",
    nextUrl: { origin: "http://localhost", host: "localhost" },
    text: async () => text,
  };
}

const APPROVE = { draftId: "box:42", action: "approve" };

test("(w3) draft-action: no admin session → 404 (never reveals /admin), nothing written", async () => {
  reset();
  const res = await draftActionRoute.POST(mkPost({ body: APPROVE }));
  assert.equal(res.status, 404);
  assert.deepEqual(db.outreachOverrides.draftActions, []);
});

test("(w3) draft-action: CSRF — cross-origin and non-JSON are refused", async () => {
  reset();
  asAdmin();
  const foreign = await draftActionRoute.POST(
    mkPost({ body: APPROVE, origin: "https://evil.example" })
  );
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /origin/i);
  const formish = await draftActionRoute.POST(
    mkPost({ body: APPROVE, contentType: "application/x-www-form-urlencoded" })
  );
  assert.equal(formish.status, 400);
  assert.deepEqual(db.outreachOverrides.draftActions, [], "no decision written by either");
});

test("(w3) draft-action: admin + same-origin JSON → 200, ONE pending decision", async () => {
  reset();
  asAdmin();
  const res = await draftActionRoute.POST(mkPost({ body: APPROVE }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, 1);
  const rows = db.outreachOverrides.draftActions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].draftId, "box:42");
  assert.equal(rows[0].action, "approve");
  assert.equal(rows[0].actor, "admin@example.com");
  assert.equal(rows[0].status, "pending");
  // the wire the pipeline pulls now carries it
  const wire = await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }));
  assert.equal(wire.body.draftActions.length, 1);
});

test("(w3) draft-action: input validation — bad draftId/action/body all 400 and write nothing", async () => {
  reset();
  asAdmin();
  for (const body of [
    {},
    { draftId: "", action: "approve" },
    { draftId: "box:42" },
    { draftId: "box:42", action: "send_now" },
    { draftId: "box:42", action: "approve_edit" },
    { draftId: "box:42", action: "approve", editedBody: "sneaky" },
    "not an object",
    ["array"],
  ]) {
    const res = await draftActionRoute.POST(mkPost({ body }));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const bad = await draftActionRoute.POST(mkPost({ body: "{not json" }));
  assert.equal(bad.status, 400);
  assert.deepEqual(db.outreachOverrides.draftActions, []);
});

test("(w3) draft-action: body caps — declared content-length AND measured bytes", async () => {
  reset();
  asAdmin();
  const declared = await draftActionRoute.POST(
    mkPost({ body: APPROVE, contentLength: 1024 * 1024 })
  );
  assert.equal(declared.status, 400);
  assert.match(declared.body.error, /too large/i);

  const huge = "x".repeat(30 * 1024);
  const measured = await draftActionRoute.POST(
    mkPost({ body: { draftId: "box:42", action: "approve_edit", editedBody: huge } })
  );
  assert.equal(measured.status, 400);
  assert.match(measured.body.error, /too large/i);

  // a body inside the route cap but over the 20 KB store cap is a store refusal
  const over20k = "y".repeat(21 * 1024);
  const storeCap = await draftActionRoute.POST(
    mkPost({ body: { draftId: "box:42", action: "approve_edit", editedBody: over20k } })
  );
  assert.equal(storeCap.status, 400);
  assert.deepEqual(db.outreachOverrides.draftActions, []);
});

test("(w3) draft-action: approve_edit round-trips the operator's text to the wire", async () => {
  reset();
  asAdmin();
  const edited = "Thursday 10:00 works - I'll send an invite.";
  const res = await draftActionRoute.POST(
    mkPost({ body: { draftId: "box:42", action: "approve_edit", editedBody: edited } })
  );
  assert.equal(res.status, 200);
  const wire = (await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body;
  assert.equal(wire.draftActions[0].action, "approve_edit");
  assert.equal(wire.draftActions[0].editedBody, edited);
});

test("(w3) draft-action: a later decision supersedes the earlier one for the same draft", async () => {
  reset();
  asAdmin();
  await draftActionRoute.POST(mkPost({ body: APPROVE }));
  const flip = await draftActionRoute.POST(
    mkPost({ body: { draftId: "box:42", action: "reject", reason: "calling instead" } })
  );
  assert.equal(flip.status, 200);
  const wire = (await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body;
  assert.equal(wire.draftActions.length, 1);
  assert.equal(wire.draftActions[0].action, "reject");
  assert.equal(wire.draftActions[0].reason, "calling instead");
});

test("(w3) draft-action: rate limited per IP (429), and CSRF is charged FIRST", async () => {
  reset();
  asAdmin();
  const ip = "203.0.113.77";
  const withIp = (extra = {}) => {
    const r = mkPost({ body: APPROVE, ...extra });
    r.headers.set("x-real-ip", ip);
    return r;
  };
  // cross-origin junk must NOT burn the victim IP's budget
  for (let i = 0; i < 40; i++) {
    const res = await draftActionRoute.POST(withIp({ origin: "https://evil.example" }));
    assert.equal(res.status, 400);
  }
  let ok = 0;
  let limited = 0;
  for (let i = 0; i < 40; i++) {
    const res = await draftActionRoute.POST(withIp());
    if (res.status === 200) ok++;
    else if (res.status === 429) limited++;
  }
  assert.ok(ok >= 20, `expected the full burst to pass, got ${ok}`);
  assert.ok(limited > 0, "the bucket must eventually refuse");
});

test("(w3) draft-action: audits the DECISION, never the reply text", async () => {
  reset();
  asAdmin();
  const secret = "Our price is 4900 EUR - do not log me.";
  await draftActionRoute.POST(
    mkPost({ body: { draftId: "box:42", action: "approve_edit", editedBody: secret } })
  );
  const blob = JSON.stringify(audits);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "outreach-draft-action");
  assert.equal(audits[0].detail.draftId, "box:42");
  assert.equal(audits[0].detail.decision, "approve_edit");
  assert.equal(audits[0].detail.editedBodyChars, secret.length);
  assert.ok(!blob.includes("4900"), "the reply body must never reach an audit/log row");
});

test("(w3) ack: draftActionIds fold the decisions off the wire; idempotent", async () => {
  reset();
  asAdmin();
  await draftActionRoute.POST(mkPost({ body: APPROVE }));
  await draftActionRoute.POST(mkPost({ body: { draftId: "box:43", action: "reject" } }));
  assert.equal((await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body.draftActions.length, 2);

  const res = await ackRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [], draftActionIds: [1] } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.draftActions, [1]);
  const wire = (await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body;
  assert.deepEqual(wire.draftActions.map((a) => a.id), [2]);
  // re-ack (a retried post) folds nothing more
  const again = await ackRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [], draftActionIds: [1] } })
  );
  assert.deepEqual(again.body.draftActions, []);
});

test("(w3) ack: a legacy ack body without draftActionIds still works", async () => {
  reset();
  asAdmin();
  await draftActionRoute.POST(mkPost({ body: APPROVE }));
  const res = await ackRoute.POST(mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [] } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.draftActions, []);
  assert.equal((await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body.draftActions.length, 1);
});

test("(w3) draft-action passes the admin-API positive lock", async () => {
  const { checkAdminApiRoutes } = await import("../tests/isolation-static.mjs");
  const src = fs.readFileSync(
    path.join(API, "admin", "outreach", "draft-action", "route.ts"),
    "utf8"
  );
  assert.deepEqual(
    checkAdminApiRoutes([{ path: "app/api/admin/outreach/draft-action/route.ts", src }]),
    []
  );
  // no GET surface at all: a decision endpoint is POST-only
  assert.equal(typeof draftActionRoute.GET, "undefined");
});

test("(w3) draft-detail render stance: escaped text, read-only footer, no send verbs", () => {
  const src = fs.readFileSync(
    path.join(APP, "app", "admin", "outreach", "actions.tsx"),
    "utf8"
  );
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  // the draft + inbound bodies render as escaped JSX text inside <pre>
  assert.match(src, /<pre[^>]*>\s*\{props\.inboundBody \?\? "\(not captured\)"\}\s*<\/pre>/);
  assert.match(src, /<pre[^>]*>\s*\{text\}\s*<\/pre>/);
  // the footer is rendered OUTSIDE any editable control
  assert.match(src, /not editable/);
  assert.doesNotMatch(src, /value=\{props\.footer\}/);
  // the island posts DECISIONS only — it never talks to a send endpoint
  assert.match(src, /"\/api\/admin\/outreach\/draft-action"/);
  for (const kind of ["approve", "approve_edit", "reject", "not_a_reply"]) {
    assert.ok(src.includes(`"${kind}"`), kind);
  }
  // no send verb anywhere in the island: the only fetch targets are the
  // upload, overrides and draft-action routes
  const urls = [...src.matchAll(/"\/api\/[^"]+"/g)].map((m) => m[0]);
  assert.ok(urls.length > 0);
  for (const u of urls) assert.doesNotMatch(u, /send|mail|deliver/i, u);
  assert.doesNotMatch(src, /\bsendMail\b|\bsendEmail\b|nodemailer/);
});

// ==========================================================================
// Auto-ack handling (2026-09-08) — `not_a_reply` through the route
// ==========================================================================

const NOT_A_REPLY = { draftId: "local:3bbe756e", action: "not_a_reply" };
/** Own client IP per test: the earlier suites drain the default-IP bucket. */
function mkPostFrom(ip, opts) {
  const r = mkPost(opts);
  r.headers.set("x-real-ip", ip);
  return r;
}

test("(aa) draft-action: not_a_reply → 200, ONE pending row with no body/reason; audited like a reject", async () => {
  reset();
  asAdmin();
  const res = await draftActionRoute.POST(mkPostFrom("198.51.100.11", { body: NOT_A_REPLY }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const rows = db.outreachOverrides.draftActions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].draftId, "local:3bbe756e");
  assert.equal(rows[0].action, "not_a_reply");
  assert.equal(rows[0].editedBody, null);
  assert.equal(rows[0].reason, null);
  assert.equal(rows[0].status, "pending");
  // the wire the pipeline pulls carries the action string verbatim
  const wire = (await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body;
  assert.deepEqual(
    wire.draftActions.map((a) => [a.draftId, a.action, a.editedBody]),
    [["local:3bbe756e", "not_a_reply", null]]
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.decision, "not_a_reply");
  assert.equal(audits[0].detail.editedBodyChars, 0);
  assert.equal(audits[0].detail.draftId, "local:3bbe756e");
});

test("(aa) draft-action: not_a_reply with an editedBody → 400, nothing written", async () => {
  reset();
  asAdmin();
  const res = await draftActionRoute.POST(
    mkPostFrom("198.51.100.12", { body: { ...NOT_A_REPLY, editedBody: "not allowed here" } })
  );
  assert.equal(res.status, 400);
  assert.match(res.body.error, /must not carry an edited body/);
  assert.deepEqual(db.outreachOverrides.draftActions, []);
  assert.equal(audits.length, 0);
});

test("(aa) draft-action: not_a_reply without an admin session → 404, nothing written", async () => {
  reset();
  const res = await draftActionRoute.POST(mkPostFrom("198.51.100.13", { body: NOT_A_REPLY }));
  assert.equal(res.status, 404);
  assert.deepEqual(db.outreachOverrides.draftActions, []);
});

test("(aa) ack: a folded not_a_reply leaves the wire (draftActionIds)", async () => {
  reset();
  asAdmin();
  assert.equal((await draftActionRoute.POST(mkPostFrom("198.51.100.14", { body: NOT_A_REPLY }))).status, 200);
  const res = await ackRoute.POST(
    mkReq({ auth: bearer(UPLOAD_TOKEN), body: { moveIds: [], draftActionIds: [1] } })
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.draftActions, [1]);
  assert.deepEqual((await overridesRoute.GET(mkReq({ auth: bearer(READ_TOKEN) }))).body.draftActions, []);
});
