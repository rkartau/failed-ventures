// Test 2 at the ROUTE level, using the batch2 in-memory VM harness: the REAL /api/invite
// route handler and its REAL libs (access, agentData, roster-parse) run transpiled in
// memory; only the edges (next/server, @/lib/agent-session, @/auth, @/lib/notify,
// @/lib/db) are stubbed. The email-SENDING path (/api/invite/send-links + lib/card-link)
// was removed — import now hands the agent copy/paste links, so this file only asserts
// that /api/invite still stores importedEmail (dormant) and never ownerEmail.
//
// Run: node tests/invite-email-routes.test.mjs

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

let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-08-04T00:00:00.000Z");

function freshDB() {
  const now = iso(T0);
  return {
    agents: [
      { id: "agent:A", orgName: "Alpha Crewing", contact: "", createdAt: now },
      { id: "agent:Z", orgName: "Zeta", contact: "", createdAt: now },
    ],
    seafarers: [],
    documents: [], comments: [], restHours: [], assignments: [], accessGrants: [],
    requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
    circulars: [], circularReplies: [], docRequests: [], profileChanges: [], seaService: [],
    impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
    issuedSeaTerms: [], clientPortals: [], vacancies: [],
  };
}

let db = freshDB();
let currentAgent = null;
const notifySends = [];

const AUDIT_NO_IMPERSONATION = Symbol("no-impersonation");
const dbStub = {
  readDB: () => db,
  readAccessLog: () => [],
  readConsentEvents: () => [],
  readBoardEvents: () => [],
  appendAudit: () => Promise.resolve({}),
  transact: (fn) => Promise.resolve(fn(db, () => {})),
  updateDB: (fn) => Promise.resolve(fn(db)),
  serialize: (fn) => Promise.resolve(fn()),
  writeDB: (next) => { db = next; },
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
  newShareTokens: () => {
    const openShareToken = `open-${++seq}`;
    const emailShareToken = `email-${++seq}`;
    return { openShareToken, emailShareToken, shareToken: openShareToken };
  },
  AUDIT_NO_IMPERSONATION,
};
const agentSessionStub = { agentSession: async () => currentAgent, isDevLoginEnabled: true, DEV_COOKIE: "x" };
const authStub = { auth: async () => null };
const notifyStub = {
  send: async (input) => {
    notifySends.push(input);
    return { ok: true, channel: "email", delivered: true, status: "sent", logId: `n-${++seq}` };
  },
  channelConfigured: () => true,
};
class NextResponse {
  static json(body, init) { return { status: (init && init.status) || 200, body }; }
}
const nextServerStub = { NextRequest: class {}, NextResponse };
const nextHeadersStub = { cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }) };

const cache = new Map();
function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath);
  const source = fs.readFileSync(absPath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: absPath,
  }).outputText;
  const localRequire = (spec) => {
    if (spec === "next/server") return nextServerStub;
    if (spec === "next/headers") return nextHeadersStub;
    if (spec === "@/lib/db") return dbStub;
    if (spec === "@/lib/agent-session") return agentSessionStub;
    if (spec === "@/auth") return authStub;
    if (spec === "@/lib/notify") return notifyStub;
    if (spec.startsWith("@/lib/")) return loadTs(path.join(LIB, spec.slice(6) + ".ts"));
    if (spec.startsWith(".")) {
      const p = path.resolve(path.dirname(absPath), spec);
      return loadTs(p.endsWith(".ts") ? p : p + ".ts");
    }
    return require(spec);
  };
  const moduleObj = { exports: {} };
  const fn = vm.compileFunction(js, ["exports", "require", "module", "__filename", "__dirname"], { filename: absPath });
  fn(moduleObj.exports, localRequire, moduleObj, absPath, path.dirname(absPath));
  cache.set(absPath, moduleObj.exports);
  return moduleObj.exports;
}

const inviteRoute = loadTs(path.join(API, "invite", "route.ts"));

function req({ body = null, origin = "https://docka.me" } = {}) {
  return { nextUrl: { origin, searchParams: new URLSearchParams() }, json: async () => body ?? {} };
}
const asAgent = (agentId) => { currentAgent = { user: { name: `Alpha Crewing`, email: `${agentId}@x` }, agentId }; };
const grant = (seafarerId, agentId = "agent:A") => ({
  id: "g-" + seafarerId, seafarerId, agentId, status: "ACTIVE", legalBasis: "CONSENT",
  scope: ["profile", "documents", "log"], grantedAt: iso(T0), revokedAt: null, expiresAt: null, createdAt: iso(T0),
});

let passed = 0;
const failures = [];
const check = (label, cond) => { if (cond) { passed++; console.log("  ok   " + label); } else { failures.push(label); console.log("  FAIL " + label); } };

console.log("invite-email-routes — route-level integration\n");

// [2] Invite stores importedEmail (lower-cased), NEVER ownerEmail; bad email -> null.
{
  db = freshDB(); asAgent("agent:A");
  const r = await inviteRoute.POST(req({ body: { crew: [
    { name: "Maria Silva", rank: "Master", email: "MARIA@Ship.com" },
    { name: "Bad Row", email: "not an email" },
    { name: "No Email Row" },
  ] } }));
  check("[2] invite 200 ok", r.status === 200 && r.body.ok === true);
  const created = r.body.seafarers;
  const maria = created.find((s) => s.name === "Maria Silva");
  const bad = created.find((s) => s.name === "Bad Row");
  const none = created.find((s) => s.name === "No Email Row");
  check("[2] importedEmail stored lower-cased", maria.importedEmail === "maria@ship.com");
  check("[2] ownerEmail NEVER set on import", !maria.ownerEmail);
  check("[2] invalid email -> importedEmail null, row still created", bad && bad.importedEmail === null);
  check("[2] missing email -> importedEmail null, row created", none && none.importedEmail === null);
  check("[2] all three rows created", created.length === 3);
}

console.log("");
if (failures.length) { console.log(`FAILED (${failures.length}):`); for (const f of failures) console.log("  - " + f); process.exit(1); }
console.log(`invite-email-routes — ${passed} checks passed`);
