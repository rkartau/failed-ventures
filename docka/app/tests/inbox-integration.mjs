// In-app messaging — route-level integration test (no server, no build, no disk).
//
// Loads the REAL inbox + agent-replies route HANDLERS (app/api/inbox/*/route.ts and
// app/api/circulars/replies/route.ts) and the REAL lib/inbox.ts + lib/access.ts,
// transpiled IN MEMORY with the installed `typescript` package. Only the un-testable
// edges are stubbed: `next/server` (NextResponse.json → a plain {status,body}),
// `@/lib/seaman-session` / `@/lib/agent-session` (a mutable current-identity we flip per
// scenario) and `@/lib/db` (a synthetic in-memory DB whose updateDB mutates in place).
// Everything security-critical — the D1 auth-only reply gate, the single-mutator
// idempotency, the D3 live-grant re-derivation + read-forward, the peer anonymisation,
// the visibility whitelist and the compound-cursor pager — runs the ACTUAL shipped code.
//
// This covers the parts of plan §7 that a browser persona cannot: every reply/anonymise/
// revoke/idempotency assertion needs an AUTHENTICATED seaman session, and there is no dev
// seaman-auth door (only the agent one), so those paths are unreachable via Playwright.
//
// Run: node tests/inbox-integration.mjs   (exit 0 = pass, 1 = fail)

import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");
const LIB = path.join(APP, "lib");
const API = path.join(APP, "app", "api");

// ---- Synthetic in-memory DB ------------------------------------------------------
// Two tenants (agent:A owns everything under test; agent:Z is the foreign tenant).
// Two crew: s1 + s2 both recipients of circular c1; s3 is a stranger (no circulars).
let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

function freshDB() {
  const now = iso(T0);
  return {
    agents: [
      { id: "agent:A", orgName: "Org A", contact: "", createdAt: now },
      { id: "agent:Z", orgName: "Org Z", contact: "", createdAt: now },
    ],
    seafarers: [
      { id: "s1", name: "Wei Chen", rank: "Master", state: "review", shareToken: "open-s1", createdAt: now },
      { id: "s2", name: "Bo Lang", rank: "Bosun", state: "review", shareToken: "open-s2", createdAt: now },
      { id: "s3", name: "Stranger", rank: "Rating", state: "review", shareToken: "open-s3", createdAt: now },
    ],
    documents: [],
    comments: [],
    restHours: [],
    assignments: [],
    accessGrants: [
      { id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g1", grantedAt: now, revokedAt: null,
        expiresAt: null, createdAt: now },
      { id: "g2", seafarerId: "s2", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g2", grantedAt: now, revokedAt: null,
        expiresAt: null, createdAt: now },
    ],
    circulars: [
      { id: "c1", agentId: "agent:A", authorName: "Org A", subject: "Fleet stand-down",
        message: "Crew notice.", filter: null, channel: "email", recipientIds: ["s1", "s2"],
        delivered: 0, allowReplies: true, createdAt: iso(T0 + 1000) },
      // Legacy read-only circular (allowReplies false) — replies must be server-rejected.
      { id: "c-legacy", agentId: "agent:A", authorName: "Org A", subject: "Old notice",
        message: "No replies.", filter: null, channel: "email", recipientIds: ["s1"],
        delivered: 0, allowReplies: false, createdAt: iso(T0 + 500) },
    ],
    circularReplies: [],
    requiredDocsConfigs: [],
    requiredDocsAudit: [],
  };
}

let db = freshDB();

// ---- Mutable identity (flipped per scenario) -------------------------------------
let currentSeaman = null; // { seafarerId, user } | null
let currentAgent = null; // { user, agentId } | null

// ---- Stubs ----------------------------------------------------------------------
const dbStub = {
  readDB: () => db,
  readAccessLog: () => [],
  readConsentEvents: () => [],
  appendAudit: () => Promise.resolve({}),
  transact: (fn) => Promise.resolve(fn(db, () => {})),
  updateDB: (fn) => Promise.resolve(fn(db)),
  serialize: (fn) => Promise.resolve(fn()),
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
};
const requiredDocsStub = {
  requiredSetFor: () => ({ required: [], rankKnown: true }),
  snapshotRequiredSet: () => ({}),
  defaultConfigFor: () => ({}),
};
const seamanSessionStub = { seamanSession: async () => currentSeaman };
const agentSessionStub = { agentSession: async () => currentAgent };
const nextServerStub = {
  NextRequest: class {},
  NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) },
};
const nextHeadersStub = { cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }) };

// ---- In-memory TS module loader --------------------------------------------------
const cache = new Map();
function loadTs(absPath, extraStubs = {}) {
  const key = absPath + JSON.stringify(Object.keys(extraStubs));
  if (cache.has(key)) return cache.get(key);
  const source = fs.readFileSync(absPath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: absPath,
  }).outputText;

  const localRequire = (spec) => {
    if (spec in extraStubs) return extraStubs[spec];
    if (spec === "next/server") return nextServerStub;
    if (spec === "next/headers") return nextHeadersStub;
    if (spec === "@/lib/db") return dbStub;
    if (spec === "@/lib/required-docs") return requiredDocsStub;
    if (spec === "@/lib/seaman-session") return seamanSessionStub;
    if (spec === "@/lib/agent-session") return agentSessionStub;
    if (spec === "@/lib/access") return loadTs(path.join(LIB, "access.ts"));
    if (spec === "@/lib/inbox") return loadTs(path.join(LIB, "inbox.ts"));
    if (spec.startsWith(".")) {
      const p = path.resolve(path.dirname(absPath), spec);
      return loadTs(p.endsWith(".ts") ? p : p + ".ts", extraStubs);
    }
    return require(spec);
  };

  const moduleObj = { exports: {} };
  const fn = vm.compileFunction(
    js,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: absPath }
  );
  fn(moduleObj.exports, localRequire, moduleObj, absPath, path.dirname(absPath));
  cache.set(key, moduleObj.exports);
  return moduleObj.exports;
}

const inboxRoute = loadTs(path.join(API, "inbox", "route.ts"));
const seenRoute = loadTs(path.join(API, "inbox", "seen", "route.ts"));
const replyRoute = loadTs(path.join(API, "inbox", "reply", "route.ts"));
const unreadRoute = loadTs(path.join(API, "inbox", "unread", "route.ts"));
const agentRepliesRoute = loadTs(path.join(API, "circulars", "replies", "route.ts"));

// ---- Request helpers -------------------------------------------------------------
function req({ query = {}, body = null } = {}) {
  const sp = new URLSearchParams(query);
  return { nextUrl: { searchParams: sp }, json: async () => body ?? {} };
}
const asSeaman = (id) => {
  currentSeaman = { seafarerId: id, user: { name: id, email: `${id}@x` } };
  currentAgent = null;
};
const asToken = () => {
  currentSeaman = null;
  currentAgent = null;
};
const asAgent = (agentId) => {
  currentAgent = { user: { name: agentId, email: `${agentId}@x` }, agentId };
  currentSeaman = null;
};

// ---- Assertions ------------------------------------------------------------------
let passed = 0;
const failures = [];
function check(label, cond) {
  if (cond) {
    passed++;
    console.log("  ok   " + label);
  } else {
    failures.push(label);
    console.log("  FAIL " + label);
  }
}

console.log("In-app messaging — route-level integration\n");

// [2] Seaman s1 inbox: sees c1, unread=1 (never seen). (open-token path.)
{
  asToken();
  const res = await inboxRoute.GET(req({ query: { token: "open-s1" } }));
  const b = res.body;
  check("[2] token s1 inbox lists the allow-replies circular c1", b.ok && b.items.some((i) => i.id === "c1"));
  check("[2] token s1 unreadCount = 2 (c1 + c-legacy, never seen)", b.unreadCount === 2);
  check("[2] token path is NOT authenticated", b.authenticated === false);
  check("[2] newestCreatedAt is a real createdAt, never now()", b.newestCreatedAt === iso(T0 + 1000));
  check("[2] inbox never leaks recipientIds", b.items.every((i) => !("recipientIds" in i)));
}

// [F1] A circular created AFTER the GET stays unread: /seen advances to the GET's
// highwater (max(old, seenAt)), NOT server now(), so the newer row is still unread.
{
  asToken();
  const g = (await inboxRoute.GET(req({ query: { token: "open-s1" } }))).body;
  // A new circular lands after the read, before /seen.
  db.circulars.push({
    id: "c2", agentId: "agent:A", authorName: "Org A", subject: "Later notice",
    message: "After the read.", filter: null, channel: "email", recipientIds: ["s1"],
    delivered: 0, allowReplies: false, createdAt: iso(T0 + 5000),
  });
  const seen = await seenRoute.POST(req({ body: { seenAt: g.newestCreatedAt, token: "open-s1" } }));
  check("[F1] /seen accepts the GET highwater", seen.body.ok && seen.body.inboxLastSeenAt === iso(T0 + 1000));
  const after = (await unreadRoute.GET(req({ query: { token: "open-s1" } }))).body;
  check("[F1] the circular created between GET and /seen is still unread (count=1)", after.count === 1);
}

// [3] Open inbox → seen → badge 0 for what existed at read time. Re-seen is idempotent.
{
  asToken();
  const g = (await inboxRoute.GET(req({ query: { token: "open-s1" } }))).body; // highwater now T0+5000
  await seenRoute.POST(req({ body: { seenAt: g.newestCreatedAt, token: "open-s1" } }));
  const u = (await unreadRoute.GET(req({ query: { token: "open-s1" } }))).body;
  check("[3] after opening + seen, unread badge = 0", u.count === 0);
  // Monotonic max: a stale (older) seenAt never regresses the highwater.
  const s2 = await seenRoute.POST(req({ body: { seenAt: iso(T0), token: "open-s1" } }));
  check("[3] /seen is monotonic (a stale seenAt cannot regress it)", s2.body.inboxLastSeenAt === iso(T0 + 5000));
}

// [D1] Open-token holder POSTs a reply → 403, ZERO rows written.
{
  asToken();
  const before = db.circularReplies.length;
  const res = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "sneaky", visibility: "agent", idempotencyKey: "k-token" } })
  );
  check("[D1] token reply is 403 (authenticated session ONLY)", res.status === 403);
  check("[D1] token reply wrote ZERO rows", db.circularReplies.length === before);
}

// [4] Authenticated s1 replies agent-only → exactly one row, visibility "agent".
{
  asSeaman("s1");
  const res = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "Noted, thanks.", visibility: "agent", idempotencyKey: "k-agent-1" } })
  );
  check("[4] agent-only reply created (201)", res.status === 201);
  const rows = db.circularReplies.filter((r) => r.circularId === "c1" && r.seafarerId === "s1");
  check("[4] exactly one s1 reply row on c1", rows.length === 1 && rows[0].visibility === "agent");
  check("[4] stored authorName is the REAL name", rows[0].authorName === "Wei Chen");
  check("[4] denormalised agentId = circular tenant", rows[0].agentId === "agent:A");
}

// [5] Authenticated s1 replies everyone → one row visibility "all".
{
  asSeaman("s1");
  const res = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "See you all soon", visibility: "all", idempotencyKey: "k-all-1" } })
  );
  check("[5] everyone reply created (201)", res.status === 201);
  const all = db.circularReplies.filter((r) => r.circularId === "c1" && r.visibility === "all");
  check("[5] exactly one visibility=all row", all.length === 1);
}

// [F6] visibility whitelist: a bogus value collapses to the safe default "agent".
{
  asSeaman("s2");
  await replyRoute.POST(
    req({ body: { circularId: "c1", body: "s2 private note", visibility: "everybody-hax", idempotencyKey: "k-bogus" } })
  );
  const r = db.circularReplies.find((x) => x.idempotencyKey === "k-bogus");
  check("[F6] non-whitelisted visibility collapses to 'agent'", r && r.visibility === "agent");
}

// [F2] Idempotency. Same key twice → one row. Same body, no window (hours apart) → two rows.
{
  asSeaman("s2");
  const key = "k-dup";
  const a = await replyRoute.POST(req({ body: { circularId: "c1", body: "ok", visibility: "agent", idempotencyKey: key } }));
  const b = await replyRoute.POST(req({ body: { circularId: "c1", body: "ok", visibility: "agent", idempotencyKey: key } }));
  const same = db.circularReplies.filter((r) => r.idempotencyKey === key);
  check("[F2] double-submit with SAME key → one row", same.length === 1);
  check("[F2] first is 201-created, retry is 200-duplicate", a.status === 201 && b.status === 200);
  check("[F2] both responses return the same stored reply id", a.body.reply.id === b.body.reply.id);

  // Honest repeat "ok" replies with DIFFERENT keys, outside the ~10s window, both persist.
  // Age the first identical-body row far into the past so the fallback window misses it.
  same[0].createdAt = iso(Date.now() - 3_600_000);
  const c = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "ok", visibility: "agent", idempotencyKey: "k-dup-2" } })
  );
  const okRows = db.circularReplies.filter((r) => r.circularId === "c1" && r.seafarerId === "s2" && r.body === "ok");
  check("[F2] same body hours apart with a new key → a SECOND row persists", c.status === 201 && okRows.length === 2);

  // Missing idempotencyKey is a hard 400.
  const noKey = await replyRoute.POST(req({ body: { circularId: "c1", body: "no key", visibility: "agent" } }));
  check("[F2] missing idempotencyKey → 400", noKey.status === 400);
}

// [legacy] Direct reply to a circular with allowReplies:false → 403, server-enforced.
{
  asSeaman("s1");
  const before = db.circularReplies.length;
  const res = await replyRoute.POST(
    req({ body: { circularId: "c-legacy", body: "hi", visibility: "agent", idempotencyKey: "k-legacy" } })
  );
  check("[legacy] reply to a no-allowReplies circular → 403", res.status === 403);
  check("[legacy] legacy reply wrote zero rows", db.circularReplies.length === before);
}

// [6] Agent sees ALL replies on their tenant with REAL names.
{
  asAgent("agent:A");
  const res = await agentRepliesRoute.GET();
  const b = res.body;
  const c1 = b.replies.filter((r) => r.circularId === "c1");
  check("[6] agent sees both visibilities on c1", c1.some((r) => r.visibility === "agent") && c1.some((r) => r.visibility === "all"));
  check("[6] agent sees REAL author names (never 'A crew member')", c1.every((r) => r.authorName !== "A crew member"));
  check("[6] agent view carries the real 'Wei Chen' name", c1.some((r) => r.authorName === "Wei Chen"));
}

// [7] Second recipient s2 (authenticated) sees the "everyone" reply ANON, NOT the agent-only one.
{
  asSeaman("s2");
  const b = (await inboxRoute.GET(req())).body;
  const item = b.items.find((i) => i.id === "c1");
  const peerViews = item.replies.filter((r) => !r.mine);
  check("[7] s2 sees a peer 'everyone' reply", peerViews.length >= 1);
  check("[7] every peer reply is anonymised to 'A crew member'", peerViews.every((r) => r.author === "A crew member"));
  check("[7] s2 never sees a peer AGENT-only reply", item.replies.every((r) => r.mine || r.visibility === "all"));
  check("[7] s2 never sees a real peer name", item.replies.every((r) => r.author === "You" || r.author === "A crew member"));
}

// [D3] Revoke s2's grant, s1 posts a NEW 'everyone' reply → departed s2 does NOT see it,
// and s2's own new reply attempt is 403.
{
  // Revoke s2 at T_revoke; the new peer reply is timestamped AFTER the revoke.
  const revokeAt = iso(T0 + 9000);
  const g2 = db.accessGrants.find((g) => g.id === "g2");
  g2.status = "REVOKED";
  g2.revokedAt = revokeAt;

  // s1 (still live) posts a fresh everyone reply that lands after the revoke instant.
  asSeaman("s1");
  const newPeer = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "post-revoke chatter", visibility: "all", idempotencyKey: "k-postrevoke" } })
  );
  const newRow = db.circularReplies.find((r) => r.idempotencyKey === "k-postrevoke");
  newRow.createdAt = iso(T0 + 10000); // strictly after revokeAt

  // Departed s2 reads: sees peer replies only up to their revoke cutoff, not the new one.
  asSeaman("s2");
  const b = (await inboxRoute.GET(req())).body;
  const item = b.items.find((i) => i.id === "c1");
  const seesNew = item.replies.some((r) => r.body === "post-revoke chatter");
  check("[D3] departed s2 does NOT see the post-revoke peer reply", newPeer.status === 201 && !seesNew);

  // Departed s2 cannot POST a new reply.
  const denied = await replyRoute.POST(
    req({ body: { circularId: "c1", body: "am I still here?", visibility: "agent", idempotencyKey: "k-departed" } })
  );
  check("[D3] departed s2 reply attempt → 403", denied.status === 403);
  check("[D3] departed s2 wrote no reply row", !db.circularReplies.some((r) => r.idempotencyKey === "k-departed"));

  // restore for later tenant checks (not strictly needed — later blocks reseed)
}

// [D2/token] emailShareToken-style value (not an OPEN shareToken, no session) → denied.
{
  asToken();
  const res = await inboxRoute.GET(req({ query: { token: "email-share-xyz" } }));
  check("[D2/token] a non-open token with no session → 401 inbox denied", res.status === 401);
}

// [F4] 60 same-millisecond circulars paginate exactly once each (compound cursor).
{
  db = freshDB();
  currentSeaman = null;
  const ms = T0 + 20000;
  for (let i = 0; i < 60; i++) {
    db.circulars.push({
      id: `bulk-${String(i).padStart(2, "0")}`, agentId: "agent:A", authorName: "Org A",
      subject: `Bulk ${i}`, message: "x", filter: null, channel: "email",
      recipientIds: ["s1"], delivered: 0, allowReplies: false, createdAt: iso(ms),
    });
  }
  asToken();
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const q = { token: "open-s1" };
    if (cursor) q.cursor = cursor;
    const b = (await inboxRoute.GET(req({ query: q }))).body;
    for (const it of b.items) seen.add(it.id);
    cursor = b.nextCursor;
    pages++;
    if (pages > 10) break; // safety
  } while (cursor);
  // 60 bulk + c1 + c-legacy = 62 recipient rows for s1.
  check("[F4] every one of the 62 s1 circulars appears exactly once across pages", seen.size === 62);
  check("[F4] page cap 50 forces at least 2 pages", pages >= 2);
}

// [isolation] Foreign agent:Z sees NONE of agent:A's replies; foreign seaman s3 empty inbox.
{
  db = freshDB();
  db.circularReplies.push({
    id: "rep-A", circularId: "c1", agentId: "agent:A", seafarerId: "s1",
    authorName: "Wei Chen", body: "tenant A only", visibility: "all",
    idempotencyKey: "k-iso", createdAt: iso(T0 + 3000),
  });
  asAgent("agent:Z");
  const z = (await agentRepliesRoute.GET()).body;
  check("[isolation] foreign agent:Z sees ZERO replies from tenant A", z.ok && z.replies.length === 0);

  asAgent("agent:A");
  const a = (await agentRepliesRoute.GET()).body;
  check("[isolation] own agent:A sees its own reply", a.replies.some((r) => r.id === "rep-A"));

  asToken();
  const s3 = (await inboxRoute.GET(req({ query: { token: "open-s3" } }))).body;
  check("[isolation] stranger s3 (no circulars) has an empty inbox", s3.ok && s3.items.length === 0);
}

// ---- Report ---------------------------------------------------------------------
console.log("");
if (failures.length) {
  console.error(`FAIL — ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`PASS — ${passed} assertions across the real inbox/reply/agent-replies handlers.`);
