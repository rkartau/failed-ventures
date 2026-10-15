// Impersonation security contract tests (plan §9 / §9a). Runs the REAL TypeScript
// sources (resolved via _ts-alias-hooks.mjs, type-stripped by Node 24) against a
// THROWAWAY temp data dir — the real repo's data/ is never touched (chdir before import,
// same pattern as tests/agent-account.test.mjs).
//
// Covers: F1 audit non-bleed, F3 expiry→suspended (+ stability), F5 2x2 matrix,
// chain-after-stamp, F8 fail-closed email, concurrent-PUT winner, anonymous path safety,
// and (F2) the DOCKA_DEMO_LOGIN production boot assertion (via child processes).
//
// Run: node --import ./tests/_register-alias.mjs tests/impersonation-security.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");

// --- Admin allowlist mirror, from the same ADMIN_EMAILS env var the app reads ----
// (the dev server under test must be started with the same ADMIN_EMAILS value).
const ADMIN = new Set(
  (process.env.ADMIN_EMAILS || "admin@example.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
assert.ok(ADMIN.size >= 1, "at least one admin email configured");
const ADMIN_EMAIL = [...ADMIN][0]; // e.g. admin@example.com

// --- Throwaway data dir + fixture -----------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imp-sec-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
const now = new Date().toISOString();
const fixture = {
  seafarers: [
    { id: "s1", name: "Alice", rank: "Master", state: "review", shareToken: "t1", createdAt: now },
    { id: "s2", name: "Bob", rank: "Rating", state: "review", shareToken: "t2", createdAt: now },
  ],
  agents: [
    { id: "agent:a", orgName: "Org A", contact: "", createdAt: now },
    { id: "agent:b", orgName: "Org B", contact: "", createdAt: now },
  ],
  impersonations: [],
};
fs.writeFileSync(path.join(tmp, "data", "db.json"), JSON.stringify(fixture, null, 2));
process.chdir(tmp); // BEFORE the imports — pins lib/db.ts DATA_DIR here.

const {
  readDB,
  updateDB,
  readAccessLog,
  verifyAuditChain,
  AUDIT_NO_IMPERSONATION,
} = await import("@/lib/db");
const {
  startImpersonation,
  stopImpersonation,
  resolveImpersonation,
  decideImpersonation,
  impersonationStampFor,
} = await import("@/lib/impersonation");
const { logAccess, grantAccess } = await import("@/lib/access");

let pass = 0;
const ok = (m) => {
  console.log("  ok  -", m);
  pass++;
};
const active = (kind, id) => ({
  state: "active",
  record: { adminEmail: ADMIN_EMAIL, targetKind: kind, targetId: id, startedAt: 0, expiresAt: Date.now() + 1e6 },
});

// ===============================================================================
// F1 — audit non-bleed: a stamped write carries the stamp; an interleaved PLAIN
// write carries NEITHER impersonator NOR onBehalfOf.
// ===============================================================================
{
  const stamp = { impersonator: `admin:${ADMIN_EMAIL}`, onBehalfOf: "agent:agent:a" };
  await Promise.all([
    logAccess("s1", "agent:a", null, "VIEWED", null, stamp), // impersonated
    logAccess("s2", "agent:b", null, "VIEWED", null), // plain (default sentinel)
  ]);
  const log = readAccessLog();
  const stamped = log.find((e) => e.agentId === "agent:a");
  const plain = log.find((e) => e.agentId === "agent:b");
  assert.ok(stamped && plain, "both lines written");
  assert.equal(stamped.impersonator, stamp.impersonator, "stamped line has impersonator");
  assert.equal(stamped.onBehalfOf, stamp.onBehalfOf, "stamped line has onBehalfOf");
  assert.equal(plain.impersonator, undefined, "plain line has NO impersonator");
  assert.equal(plain.onBehalfOf, undefined, "plain line has NO onBehalfOf");
  ok("F1 non-bleed: stamped line stamped, interleaved plain line clean");
}

// ===============================================================================
// F3 — expired/kill-switched row => "suspended", STABLE across requests, never the
// admin's own identity.
// ===============================================================================
{
  await updateDB((db) => {
    db.impersonations = [
      { adminEmail: ADMIN_EMAIL, targetKind: "seaman", targetId: "s1", startedAt: 0, expiresAt: Date.now() - 1000 },
    ];
  });
  const r1 = resolveImpersonation(ADMIN_EMAIL);
  const r2 = resolveImpersonation(ADMIN_EMAIL);
  assert.equal(r1.state, "suspended", "expired row resolves suspended");
  assert.equal(r2.state, "suspended", "STILL suspended on the 2nd request (tombstone, no mutate-on-read)");
  const d = decideImpersonation(ADMIN_EMAIL, r1, readDB(), "seaman", ADMIN);
  assert.equal(d.kind, "suspend", "suspended => resolver returns null (=> tenant route 403)");
  // A valid (future) row is active.
  await updateDB((db) => {
    db.impersonations = [
      { adminEmail: ADMIN_EMAIL, targetKind: "seaman", targetId: "s1", startedAt: 0, expiresAt: Date.now() + 1e6 },
    ];
  });
  assert.equal(resolveImpersonation(ADMIN_EMAIL).state, "active", "future row is active");
  await stopImpersonation(ADMIN_EMAIL);
  assert.equal(resolveImpersonation(ADMIN_EMAIL).state, "none", "stop clears the tombstone");
  ok("F3 expiry => suspended, stable across requests, never own-identity");
}

// ===============================================================================
// F5 — 2x2 matrix: matching resolver returns the target; the sibling returns null
// (suspend); the admin's own identity never leaks.
// ===============================================================================
{
  const db = readDB();
  for (const recKind of ["seaman", "agent"]) {
    const targetId = recKind === "seaman" ? "s1" : "agent:a";
    for (const wantKind of ["seaman", "agent"]) {
      const d = decideImpersonation(ADMIN_EMAIL, active(recKind, targetId), db, wantKind, ADMIN);
      if (recKind === wantKind) {
        assert.equal(d.kind, "target", `${recKind}->${wantKind}: matching resolver returns target`);
        assert.equal(d.targetId, targetId, `${recKind}->${wantKind}: correct targetId`);
      } else {
        assert.equal(d.kind, "suspend", `${recKind}->${wantKind}: sibling resolver returns null`);
      }
    }
  }
  // No row => fallthrough (admin's own JWT identity), never a leak of a target.
  const none = decideImpersonation(ADMIN_EMAIL, { state: "none" }, db, "agent", ADMIN);
  assert.equal(none.kind, "fallthrough", "no row => fallthrough to admin's own identity");
  ok("F5 2x2 matrix: match=target, sibling=null, no-row=fallthrough");
}

// ===============================================================================
// chain-after-stamp — verifyAuditChain stays OK after mixed stamped + unstamped
// writes across both chained sinks.
// ===============================================================================
{
  const stamp = { impersonator: `admin:${ADMIN_EMAIL}`, onBehalfOf: "agent:agent:a" };
  await logAccess("s1", "agent:a", null, "DOWNLOADED", "doc1", stamp); // stamped
  await logAccess("s2", "agent:b", null, "DOWNLOADED", "doc2"); // unstamped
  await grantAccess({ seafarerId: "s1", agentId: "agent:a" }, stamp); // stamped consent events
  await grantAccess({ seafarerId: "s2", agentId: "agent:b" }); // unstamped consent events
  const a = verifyAuditChain("access-log");
  const c = verifyAuditChain("consent-events");
  assert.ok(a.ok, `access-log chain valid (brokenAt=${a.brokenAt})`);
  assert.ok(c.ok, `consent-events chain valid (brokenAt=${c.brokenAt})`);
  ok("chain-after-stamp: both sinks verify after mixed stamped/unstamped writes");
}

// ===============================================================================
// F8 — fail-closed email: mixed-case admin matches; non-admin & <id>@localhost never
// match; no admin allowlist entry is a synthetic @localhost address.
// ===============================================================================
{
  const db = readDB();
  const mixed = decideImpersonation(`  ${ADMIN_EMAIL.toUpperCase()} `, active("seaman", "s1"), db, "seaman", ADMIN);
  assert.equal(mixed.kind, "target", "mixed-case + whitespace admin email still matches (normalised)");
  const mallory = decideImpersonation("mallory@evil.com", active("seaman", "s1"), db, "seaman", ADMIN);
  assert.equal(mallory.kind, "fallthrough", "non-admin email => fallthrough (never a target)");
  assert.ok(!ADMIN.has("s1@localhost"), "synthetic <id>@localhost is NOT on the admin allowlist");
  const synthetic = decideImpersonation("s1@localhost", active("seaman", "s1"), db, "seaman", ADMIN);
  assert.equal(synthetic.kind, "fallthrough", "<id>@localhost never reaches a target (never mints admin scope)");
  for (const e of ADMIN) assert.ok(!e.endsWith("@localhost"), "no admin allowlist entry is a synthetic @localhost");
  ok("F8 email: mixed-case admin ok; non-admin & @localhost fail closed");
}

// ===============================================================================
// concurrent-PUT winner — the record deterministically ends as the LAST write; the
// upsert (remove-then-push under the updateDB mutex) leaves exactly ONE row.
// ===============================================================================
{
  await stopImpersonation(ADMIN_EMAIL);
  // Sequential: last write wins.
  await startImpersonation({ adminEmail: ADMIN_EMAIL, targetKind: "seaman", targetId: "s1" });
  await startImpersonation({ adminEmail: ADMIN_EMAIL, targetKind: "seaman", targetId: "s2" });
  let rows = readDB().impersonations.filter((r) => r.adminEmail === ADMIN_EMAIL);
  assert.equal(rows.length, 1, "exactly one row for the admin after two sequential PUTs");
  assert.equal(rows[0].targetId, "s2", "the LAST write wins (targetB)");
  // Concurrent: still exactly one row (mutex + upsert).
  await stopImpersonation(ADMIN_EMAIL);
  await Promise.all([
    startImpersonation({ adminEmail: ADMIN_EMAIL, targetKind: "agent", targetId: "agent:a" }),
    startImpersonation({ adminEmail: ADMIN_EMAIL, targetKind: "agent", targetId: "agent:b" }),
  ]);
  rows = readDB().impersonations.filter((r) => r.adminEmail === ADMIN_EMAIL);
  assert.equal(rows.length, 1, "exactly one row after two concurrent PUTs");
  await stopImpersonation(ADMIN_EMAIL);
  ok("concurrent-PUT: last write wins, exactly one row (deterministic)");
}

// ===============================================================================
// anonymous / logged-out path safety — the checks the banner runs on EVERY page load
// must never throw or leak for an empty/anonymous identity.
// ===============================================================================
{
  assert.equal(resolveImpersonation("").state, "none", "empty email resolves 'none' cleanly");
  const d = decideImpersonation("", { state: "none" }, readDB(), "seaman", ADMIN);
  assert.equal(d.kind, "fallthrough", "empty email => fallthrough, no throw");
  assert.equal(impersonationStampFor({}), AUDIT_NO_IMPERSONATION, "no-session stamp is the sentinel");
  // Mirror of the adminSession gate: auth()->null yields null (banner then renders nothing).
  const adminGate = async (authFn) => {
    const s = await authFn();
    const email = (s?.user?.email ?? "").trim().toLowerCase();
    return s?.user && email && ADMIN.has(email) ? { user: s.user } : null;
  };
  assert.equal(await adminGate(async () => null), null, "logged-out adminSession() => null (banner safe)");
  assert.equal(
    await adminGate(async () => ({ user: { email: "mallory@evil.com" } })),
    null,
    "non-admin adminSession() => null (banner safe)"
  );
  ok("anonymous/non-admin path: resolvers + adminSession gate return cleanly, no throw/leak");
}

// ===============================================================================
// F2 — DOCKA_DEMO_LOGIN production boot assertion (child processes).
// ===============================================================================
{
  const hook = pathToFileURL(path.join(APP, "tests", "_register-alias.mjs")).href;
  const instrUrl = pathToFileURL(path.join(APP, "instrumentation.ts")).href;
  function child(env, code) {
    const f = path.join(tmp, `f2-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(f, code);
    const res = spawnSync(process.execPath, ["--import", hook, f], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return (res.stdout || "") + (res.stderr || "");
  }
  const importImp = `try { await import("@/lib/impersonation"); console.log("NO_THROW"); } catch (e) { console.log("THREW"); }`;
  const runRegister = `const { register } = await import(${JSON.stringify(instrUrl)}); try { register(); console.log("NO_THROW"); } catch (e) { console.log("THREW"); }`;

  const prodDemo = { NODE_ENV: "production", DOCKA_DEMO_LOGIN: "1" };
  const prodClean = { NODE_ENV: "production", DOCKA_DEMO_LOGIN: "" };
  const devDemo = { NODE_ENV: "development", DOCKA_DEMO_LOGIN: "1" };

  assert.match(child(prodDemo, importImp), /THREW/, "prod + DEMO => importing impersonation THROWS");
  assert.match(child(prodDemo, runRegister), /THREW/, "prod + DEMO => register() THROWS");
  assert.match(child(prodClean, importImp), /NO_THROW/, "prod + no DEMO => import OK");
  assert.match(child(prodClean, runRegister), /NO_THROW/, "prod + no DEMO => register() OK");
  assert.match(child(devDemo, importImp), /NO_THROW/, "dev + DEMO => import OK (dev door allowed in dev)");
  assert.match(child(devDemo, runRegister), /NO_THROW/, "dev + DEMO => register() OK");
  ok("F2 boot assertion: prod+DEMO hard-fails (import + register); otherwise starts");
}

console.log(`\nPASS — ${pass} impersonation security contract group(s) green.`);
