// Pure unit suite for the claim-state model + the panel's pure client helpers.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/claim-state.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const {
  isClaimed,
  claimStateOf,
  hasPlaceholderProvenance,
  placeholderManagedBy,
  SELF_ACCESS_TTL_MS,
} = await import("@/lib/claim-state");
const { claimLinkFor, claimOutcomeFrom } = await import("@/components/claim-link");
const { fmtDateUtc } = await import("@/lib/board-card");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("SELF_ACCESS_TTL_MS is 24h", () => {
  assert.equal(SELF_ACCESS_TTL_MS, 86_400_000);
});

test("isClaimed: each pointer alone => true; blanks => false", () => {
  assert.equal(isClaimed({ googleSub: "g" }), true);
  assert.equal(isClaimed({ ownerEmail: "e@x.com" }), true);
  assert.equal(isClaimed({ credentialUserId: "cu1" }), true);
  assert.equal(isClaimed({}), false);
  assert.equal(isClaimed({ googleSub: null, ownerEmail: null, credentialUserId: null }), false);
  assert.equal(isClaimed({ ownerEmail: "" }), false);
  assert.equal(isClaimed({ ownerEmail: " " }), false, "whitespace-only is NOT ownership");
  assert.equal(isClaimed({ ownerEmail: "\t" }), false);
});

test("claimStateOf: sample wins over pointers", () => {
  assert.equal(claimStateOf({ isSample: true, ownerEmail: "e@x.com" }).kind, "sample");
});

test("claimStateOf: claimed", () => {
  assert.equal(claimStateOf({ credentialUserId: "cu1" }).kind, "claimed");
});

test("claimStateOf: legacy-unowned even with a stamp (T1)", () => {
  const st = claimStateOf({ shareTokenLastUsedAt: Date.now() });
  assert.equal(st.kind, "legacy-unowned");
});

test("claimStateOf: placeholder by invited alone / createdByAgentId alone", () => {
  assert.equal(claimStateOf({ invited: true }).kind, "placeholder");
  assert.equal(claimStateOf({ createdByAgentId: "agent:A" }).kind, "placeholder");
});

test("claimStateOf: not-opened / opened fresh / opened stale / after reset", () => {
  const now = 1_000_000_000_000;
  const notOpened = claimStateOf({ invited: true }, now);
  assert.deepEqual(notOpened, { kind: "placeholder", opened: false, linkStale: false });

  const fresh = claimStateOf({ invited: true, shareTokenLastUsedAt: now - SELF_ACCESS_TTL_MS }, now);
  assert.equal(fresh.opened, true);
  assert.equal(fresh.linkStale, false, "exactly TTL still serves (strict >)");

  const stale = claimStateOf(
    { invited: true, shareTokenLastUsedAt: now - SELF_ACCESS_TTL_MS - 1 },
    now
  );
  assert.equal(stale.linkStale, true);

  // After a reset the stamp is deleted -> back to not-opened.
  const afterReset = claimStateOf({ invited: true }, now);
  assert.equal(afterReset.opened, false);
});

test("hasPlaceholderProvenance + placeholderManagedBy", () => {
  assert.equal(hasPlaceholderProvenance({ invited: true }), true);
  assert.equal(hasPlaceholderProvenance({ createdByAgentId: "a" }), true);
  assert.equal(hasPlaceholderProvenance({}), false);
  // Unstamped => any agent may manage; stamped => creator only.
  assert.equal(placeholderManagedBy({}, "agent:A"), true);
  assert.equal(placeholderManagedBy({ createdByAgentId: "agent:A" }, "agent:A"), true);
  assert.equal(placeholderManagedBy({ createdByAgentId: "agent:B" }, "agent:A"), false);
});

test("claimLinkFor builds the /seafarer?token= form, never /share/", () => {
  const url = claimLinkFor("tok", "https://docka.me");
  assert.equal(url, "https://docka.me/seafarer?token=tok");
  assert.ok(!url.includes("/share/"));
});

test("claimOutcomeFrom: error / malformed / emailed / recorded (pure, no throw)", () => {
  // 409 already-claimed: error tone, server string, MUST NOT read reminders.
  const proxy = new Proxy(
    { ok: false, error: "This profile has already been claimed — no invite sent.", claimed: true },
    {
      get(target, prop) {
        if (prop === "reminders") throw new Error("must not read reminders");
        return target[prop];
      },
    }
  );
  const o409 = claimOutcomeFrom({ ok: false, status: 409 }, proxy);
  assert.equal(o409.tone, "error");
  assert.equal(o409.key, "raw");
  assert.ok(o409.vars.text.includes("already been claimed"));

  const o429 = claimOutcomeFrom(
    { ok: false, status: 429 },
    { ok: false, error: "Too many invites — wait a minute and try again." }
  );
  assert.equal(o429.tone, "error");
  assert.equal(o429.vars.text, "Too many invites — wait a minute and try again.");

  const o500 = claimOutcomeFrom({ ok: false, status: 500 }, {});
  assert.equal(o500.key, "board.claim.sendFailed");

  const emailed = claimOutcomeFrom(
    { ok: true, status: 200 },
    { ok: true, reminders: [{ delivered: true, delivery: "emailed to a@b.com" }] }
  );
  assert.equal(emailed.key, "board.claim.sentEmailed");
  assert.equal(emailed.vars.to, "a@b.com");

  const recorded = claimOutcomeFrom(
    { ok: true, status: 200 },
    { ok: true, reminders: [{ delivered: false, delivery: "email failed (ECONNREFUSED)" }] }
  );
  assert.equal(recorded.key, "board.claim.sentRecorded");
  assert.equal(recorded.vars.reason, "email failed (ECONNREFUSED)");

  // Malformed success (no reminders) => error tone, never a throw.
  const malformed = claimOutcomeFrom({ ok: true, status: 200 }, { ok: true });
  assert.equal(malformed.tone, "error");
});

test("fmtDateUtc is timezone-independent (child proc with TZ=+14)", () => {
  const iso = "2026-09-01T23:30:00.000Z";
  const parent = fmtDateUtc(iso);
  assert.match(parent, /Sep(t)? 2026/, "shape is DD Mon YYYY (UTC day, not local)");
  // A child node with TZ forced to +14 must format the SAME UTC day.
  const script =
    "import('@/lib/board-card').then(m=>{process.stdout.write(m.fmtDateUtc(process.argv[1]))})";
  const child = execFileSync(
    process.execPath,
    ["--import", "./tests/_register-alias.mjs", "--input-type=module", "-e", script, iso],
    { cwd: path.join(__dirname, ".."), env: { ...process.env, TZ: "Pacific/Kiritimati" } }
  )
    .toString()
    .trim();
  assert.equal(child, parent, "UTC formatting is identical regardless of process TZ");
});

test("lib/claim-state.ts source carries no bare share-token symbol (token lint)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "claim-state.ts"), "utf8");
  const TOKEN_REGEX =
    /\b(openShareToken|emailShareToken|shareToken|resolveSeafarerByShareToken|evaluateShareAccess|parseShareToken|priorShareTokens)\b/;
  assert.equal(TOKEN_REGEX.test(src), false, "only shareTokenLastUsedAt is allowed");
});
