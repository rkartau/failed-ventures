// Proves lib/agent-account.ts findOrCreateAgentByGoogle is (a) idempotent — the
// same Google e-mail twice yields ONE row with the SAME id — and (b) adopts a
// seed/legacy Agent row whose `contact` IS the login e-mail instead of duplicating
// the tenant.
//
// Runs the REAL TypeScript source (resolved via _ts-alias-hooks.mjs, type-stripped
// by Node 24) against a THROWAWAY temp data/db.json fixture. It chdir()s into the
// temp dir BEFORE importing the module, because lib/db.ts fixes DATA_DIR from
// process.cwd() at import time — so the real repo's data/db.json is never touched.
//
// Run: node --import ./tests/_register-alias.mjs tests/agent-account.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-account-test-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });

const now = new Date().toISOString();
const fixture = {
  agents: [
    { id: "dev", orgName: "Test agent (dev)", contact: "dev@localhost", createdAt: now },
    // Seed org whose contact IS an e-mail → adoptable by its real Google login.
    { id: "agent:maria", orgName: "Oceanic Crewing", contact: "maria@oceanic.example", createdAt: now },
    // Seed org whose contact is NOT an e-mail → must never be adopted by e-mail.
    { id: "agent:nikos", orgName: "Nikos Manning", contact: "+30 555 1234", createdAt: now },
  ],
};
fs.writeFileSync(path.join(tmp, "data", "db.json"), JSON.stringify(fixture, null, 2));

process.chdir(tmp); // BEFORE the import — pins lib/db.ts DATA_DIR to the temp dir.

const { findOrCreateAgentByGoogle } = await import("@/lib/agent-account");
const { readDB } = await import("@/lib/db");

const agentCount = () => readDB().agents.length;
let pass = 0;
const ok = (msg) => { console.log("  ok  -", msg); pass++; };

// --- Test 1: idempotency (brand-new Google e-mail, no seed match) --------------
{
  const before = agentCount();
  // Same identity, only CASE + WHITESPACE differ → must normalise to one row.
  const a1 = await findOrCreateAgentByGoogle({ email: "New.Captain@Fleet.Example", name: "Fleet Co" });
  const afterFirst = agentCount();
  const a2 = await findOrCreateAgentByGoogle({ email: "  new.captain@fleet.example  ", name: "Fleet Co" });
  const afterSecond = agentCount();

  assert.equal(a1.id, a2.id, "two calls for the same e-mail must return the SAME id");
  assert.match(a1.id, /^agent:g-[0-9a-f]{16}$/, "provisioned id must be a stable agent:g-<hash> key");
  assert.equal(afterFirst, before + 1, "first call must create exactly ONE row");
  assert.equal(afterSecond, afterFirst, "second call must create NOTHING (idempotent)");
  assert.equal(a1.googleEmail, "new.captain@fleet.example", "googleEmail stored normalised (trim+lowercase)");
  ok(`idempotent: same e-mail twice → one row, id ${a1.id}`);
}

// --- Test 2: adoption of a seed row whose contact IS the login e-mail ----------
{
  const before = agentCount();
  const adopted = await findOrCreateAgentByGoogle({ email: "Maria@Oceanic.Example", sub: "sub-maria-123", name: "ignored" });
  const after = agentCount();

  assert.equal(adopted.id, "agent:maria", "must ADOPT the existing seed row, not mint agent:g-*");
  assert.equal(after, before, "adoption must create NO new row");
  assert.equal(adopted.googleEmail, "maria@oceanic.example", "adoption back-fills googleEmail on the seed row");
  assert.equal(adopted.googleSub, "sub-maria-123", "adoption back-fills googleSub on the seed row");
  assert.equal(adopted.orgName, "Oceanic Crewing", "adoption preserves the seed org's existing orgName");

  // Idempotent re-adoption: same login again returns the same seed row, no dup.
  const again = await findOrCreateAgentByGoogle({ email: "maria@oceanic.example" });
  assert.equal(again.id, "agent:maria", "re-login resolves the same adopted row");
  assert.equal(agentCount(), after, "re-login creates nothing");
  ok("adoption: contact-matched seed row claimed (agent:maria), no duplicate");
}

// --- Test 3: conservative — a non-e-mail contact is NOT adopted ----------------
{
  // A login whose e-mail does not equal any e-mail-shaped contact must provision a
  // fresh row, never latch onto agent:nikos (whose contact is a phone number).
  const before = agentCount();
  const created = await findOrCreateAgentByGoogle({ email: "nikos@manning.example" });
  const after = agentCount();
  assert.notEqual(created.id, "agent:nikos", "must NOT adopt a row whose contact is not an e-mail");
  assert.match(created.id, /^agent:g-[0-9a-f]{16}$/, "provisions a fresh stable id instead");
  assert.equal(after, before + 1, "exactly one fresh row created");
  ok("conservative: phone-contact seed row left untouched, fresh row minted");
}

console.log(`\nPASS — ${pass}/3 groups. Final agent rows: ${readDB().agents.map((a) => a.id).join(", ")}`);
