// Public Sample Profiles — Phase 1 UNIT acceptance (plan §D4/§D8/§D9/v4-3).
//
//   - chokepoint DENY/FILTER/ALLOW matrix incl. alias-mode + per-route mode pinning
//   - §D8 allowlist redaction (fail-closed key subset)
//   - pruneSampleReferences: owned 200-cap oldest-first + shared strip-don't-delete
//   - bounded token limiter
//   - sample-ids literal integrity
//   - merge refused BOTH directions (previewMerge + mergePersons) with db.json
//     byte-identical; the late assert's throw mechanism proven via transact
//     (a throwing mutator persists nothing) + a source-order lock that the
//     sample-merge-assert THROW sits before the token-carry block
//   - no sample token in any real row's priorShareTokens after adversarial merges
//   - Google-adoption + password-adoption (signup adoptToken) refuse sample rows
//   - deleteFromBoard can never hard-delete a sample row
//   - client-portal visibility excludes sample subjects under an adversarial grant
//   - zero-inline-compare static scan across every migrated census file
//
// Run: node --import ./tests/_register-sample.mjs --test tests/sample-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-guard-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);
globalThis.__TEST_COOKIES = {};

const { readDB, updateDB, transact, AUDIT_NO_IMPERSONATION } = await import("@/lib/db");
const {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  SAMPLE_EXPOSED_SEAFARER_KEYS,
  redactSampleSeafarer,
  pruneSampleReferences,
  SAMPLE_PRUNE_CAP,
  sampleTokenRateLimited,
  _resetSampleRateLimiter,
} = await import("@/lib/sample-guard");
const { SAMPLE_PREFIX, SAMPLE_AGENCY_ID, SAMPLE_FLAGSHIP_ID, SAMPLE_CREW_IDS, SAMPLE_OPEN_TOKEN, isSampleId } =
  await import("@/lib/sample-ids");
const { previewMerge, mergePersons } = await import("@/lib/person-merge");
const { findOrCreateSeafarerByGoogle } = await import("@/lib/seaman-account");
const { findAdoptableProfileByToken } = await import("@/lib/credential-auth");
const { deleteFromBoard } = await import("@/lib/access");
const { previewPortalVisibility } = await import("@/lib/client-portal");
const { resolveSeafarerByShareToken } = await import("@/lib/share-access");

const DB_PATH = path.join(TMP, "data", "db.json");
const iso = "2026-01-01T00:00:00.000Z";
const FLAG = SAMPLE_FLAGSHIP_ID;

function baseSeafarer(id, open, email, extra = {}) {
  return {
    id,
    name: `Seafarer ${id}`,
    rank: "Chief Officer",
    state: "review",
    shareToken: open,
    openShareToken: open,
    emailShareToken: email,
    allowedEmails: [],
    createdAt: iso,
    ...extra,
  };
}

await updateDB((db) => {
  db.agents.push(
    { id: "agent:A", orgName: "Real Crewing", contact: "", createdAt: iso },
    { id: "dev", orgName: "Dev Agent", contact: "", createdAt: iso },
    { id: SAMPLE_AGENCY_ID, orgName: "Sample Crewing OU", contact: "", createdAt: iso, isSample: true }
  );
  db.seafarers.push(
    baseSeafarer("r1", "open-r1", "email-r1", {
      // Identity match with the flagship so a merge would pass corroboration if
      // the sample guard were missing (adversarial fixture).
      identityVerified: true,
      verifiedName: "Sample Seafarer",
      personalCode: "39001010000",
      birthDate: "1990-01-01",
    }),
    baseSeafarer("r2", "open-r2", "email-r2", {
      priorShareTokens: [
        { token: "alias-r2", mode: "open" },
        { token: "alias-r2e", mode: "email" },
      ],
      mergedFrom: ["r2-old"],
    }),
    baseSeafarer(FLAG, SAMPLE_OPEN_TOKEN, "sample-email-tok", {
      name: "Sample Seafarer — SAMPLE",
      isSample: true,
      identityVerified: true,
      verifiedName: "Sample Seafarer",
      personalCode: "39001010000",
      birthDate: "1990-01-01",
    })
  );
  db.accessGrants.push(
    {
      id: "g-sample", seafarerId: FLAG, agentId: SAMPLE_AGENCY_ID, status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-sample-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review", sample: true,
    },
    {
      id: "g-dev-flag", seafarerId: FLAG, agentId: "dev", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-dev-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review",
      // ADVERSARIAL: clientVisible true — the portal belt-and-braces must still exclude.
      clientVisible: true,
    },
    {
      id: "g-dev-r1", seafarerId: "r1", agentId: "dev", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-r1-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review",
    }
  );
  db.documents.push({
    id: "doc-cur", seafarerId: FLAG, title: "Curated Cert — SAMPLE", docType: "Document",
    docCategory: null, estonianCode: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z",
    fileName: null, createdAt: iso, source: "manual", requiredType: null,
    reviewStatus: "approved", expiryConfirmed: true, sample: true,
  });
});

// ---------------------------------------------------------------------------
test("sample-ids: literal integrity", () => {
  assert.equal(SAMPLE_PREFIX, "sample-");
  assert.ok(SAMPLE_AGENCY_ID.startsWith(SAMPLE_PREFIX));
  assert.ok(SAMPLE_FLAGSHIP_ID.startsWith(SAMPLE_PREFIX));
  for (const id of SAMPLE_CREW_IDS) assert.ok(id.startsWith(SAMPLE_PREFIX));
  assert.ok(SAMPLE_OPEN_TOKEN.length >= 8);
  assert.ok(isSampleId(SAMPLE_FLAGSHIP_ID));
  assert.ok(!isSampleId("r1"));
});

test("chokepoint: real open token — identity pass-through", () => {
  const db = readDB();
  const s = resolveTokenSubject(db, "open-r1", "read", ["open"]);
  assert.ok(s && s !== SAMPLE_WRITE_DENIED);
  assert.equal(s.mode, "open");
  assert.equal(s.isSample, false);
  assert.equal(s.seafarer.emailShareToken, "email-r1"); // raw row, no redaction
  const rows = [{ v: 1 }, { v: 2, sample: true }];
  assert.deepEqual(s.filterRows(rows), rows); // identity filter
});

test("chokepoint: per-route mode pinning rejects unpinned modes", () => {
  const db = readDB();
  assert.equal(resolveTokenSubject(db, "email-r1", "read", ["open"]), null);
  assert.equal(resolveTokenSubject(db, "alias-r2", "read", ["open", "email"]), null);
  assert.equal(resolveTokenSubject(db, "no-such-token", "read", ["open", "email", "alias"]), null);
  const email = resolveTokenSubject(db, "email-r1", "read", ["open", "email"]);
  assert.ok(email && email !== SAMPLE_WRITE_DENIED && email.mode === "email");
});

test("chokepoint: alias mode resolves the merged survivor where pinned (r2 fixture)", () => {
  const db = readDB();
  const a = resolveTokenSubject(db, "alias-r2", "read", ["open", "email", "alias"]);
  assert.ok(a && a !== SAMPLE_WRITE_DENIED);
  assert.equal(a.mode, "alias");
  assert.equal(a.aliasMode, "open");
  assert.equal(a.seafarer.id, "r2");
  const ae = resolveTokenSubject(db, "alias-r2e", "read", ["open", "email", "alias"]);
  assert.ok(ae && ae !== SAMPLE_WRITE_DENIED && ae.aliasMode === "email");
  // Canonical resolver agreement (delegation, not a parallel implementation).
  const canonical = resolveSeafarerByShareToken(db, "alias-r2");
  assert.equal(canonical?.seafarer.id, "r2");
  assert.equal(canonical?.mode, "alias");
});

test("chokepoint: sample subject — read FILTER + redaction, write DENIED", () => {
  const db = readDB();
  const rd = resolveTokenSubject(db, SAMPLE_OPEN_TOKEN, "read", ["open"]);
  assert.ok(rd && rd !== SAMPLE_WRITE_DENIED);
  assert.equal(rd.isSample, true);
  const rows = [{ v: 1 }, { v: 2, sample: true }];
  assert.deepEqual(rd.filterRows(rows), [{ v: 2, sample: true }]);
  // §D8 fail-closed allowlist: every exposed key must be on the list.
  const allow = new Set(SAMPLE_EXPOSED_SEAFARER_KEYS);
  for (const k of Object.keys(rd.seafarer)) {
    assert.ok(allow.has(k), `redacted seafarer leaked key: ${k}`);
  }
  assert.equal(rd.seafarer.emailShareToken, undefined);
  assert.equal(rd.seafarer.openShareToken, SAMPLE_OPEN_TOKEN);
  assert.equal(resolveTokenSubject(db, SAMPLE_OPEN_TOKEN, "write", ["open"]), SAMPLE_WRITE_DENIED);
  assert.equal(
    resolveTokenSubject(db, "sample-email-tok", "write", ["open", "email"]),
    SAMPLE_WRITE_DENIED
  );
});

test("redaction: future fields are dropped by default", () => {
  const s = readDB().seafarers.find((x) => x.id === FLAG);
  const withFuture = { ...s, superSecretNewField: "leak-me" };
  const red = redactSampleSeafarer(withFuture);
  assert.equal(Object.prototype.hasOwnProperty.call(red, "superSecretNewField"), false);
});

// ---------------------------------------------------------------------------
test("prune: owned rows capped oldest-first; curated + real subjects untouched", async () => {
  await updateDB((db) => {
    for (let i = 0; i < SAMPLE_PRUNE_CAP + 10; i++) {
      db.comments.push({
        id: `pc-${i}`, documentId: null, seafarerId: FLAG, authorName: "Agent",
        text: `note ${i}`, createdAt: new Date(Date.parse(iso) + i * 1000).toISOString(),
      });
    }
    db.comments.push({
      id: "pc-curated", documentId: null, seafarerId: FLAG, authorName: "Seed",
      text: "curated", createdAt: iso, sample: true,
    });
    db.comments.push({
      id: "pc-real-subject", documentId: null, seafarerId: "r1", authorName: "Agent",
      text: "real", createdAt: iso,
    });
    pruneSampleReferences(db, FLAG);
    pruneSampleReferences(db, "r1"); // must be a no-op for a real subject
  });
  const db = readDB();
  const owned = db.comments.filter((c) => c.seafarerId === FLAG && c.sample !== true);
  assert.equal(owned.length, SAMPLE_PRUNE_CAP);
  assert.ok(!owned.some((c) => c.id === "pc-0")); // oldest dropped
  assert.ok(owned.some((c) => c.id === `pc-${SAMPLE_PRUNE_CAP + 9}`)); // newest kept
  assert.ok(db.comments.some((c) => c.id === "pc-curated")); // curated never touched
  assert.ok(db.comments.some((c) => c.id === "pc-real-subject")); // real subject untouched
  // cleanup for later byte-diff tests
  await updateDB((d) => {
    d.comments = d.comments.filter((c) => !c.id.startsWith("pc-"));
  });
});

test("prune: shared circulars are STRIPPED, never deleted, while real recipients survive", async () => {
  await updateDB((db) => {
    for (let i = 0; i < SAMPLE_PRUNE_CAP + 5; i++) {
      db.circulars.push({
        id: `cx-${i}`, agentId: "dev", authorName: "A", subject: `s${i}`, message: "m",
        filter: null, channel: "email",
        recipientIds: i === 0 ? [FLAG, "r1"] : [FLAG],
        delivered: 0, allowReplies: false,
        createdAt: new Date(Date.parse(iso) + i * 1000).toISOString(),
      });
    }
    pruneSampleReferences(db, FLAG);
  });
  const db = readDB();
  const mixed = db.circulars.find((c) => c.id === "cx-0");
  // Oldest beyond the cap: the sample id is STRIPPED — but the MIXED circular
  // survives intact for its real recipient (strip-don't-delete).
  assert.ok(mixed, "mixed-recipient circular must survive prune");
  assert.deepEqual(mixed.recipientIds, ["r1"]);
  // Flagship-only oldest circulars beyond the cap emptied out and were dropped.
  const still = db.circulars.filter((c) => c.id.startsWith("cx-") && c.recipientIds.includes(FLAG));
  assert.equal(still.length, SAMPLE_PRUNE_CAP);
  await updateDB((d) => {
    d.circulars = d.circulars.filter((c) => !c.id.startsWith("cx-"));
  });
});

test("limiter: trips over the window cap and stays bounded", () => {
  _resetSampleRateLimiter();
  let tripped = false;
  for (let i = 0; i < 70; i++) tripped = sampleTokenRateLimited("tok-limit-test");
  assert.equal(tripped, true);
  // junk-token flood: never throws, map stays bounded (LRU evicts internally)
  for (let i = 0; i < 5000; i++) sampleTokenRateLimited(`junk-${i}`);
  _resetSampleRateLimiter();
});

// ---------------------------------------------------------------------------
test("merge: refused BOTH directions, db byte-identical, grants intact, no token carry", async () => {
  const before = fs.readFileSync(DB_PATH);

  const p1 = previewMerge("r1", FLAG);
  assert.deepEqual(p1, { error: "sample records cannot be merged" });
  const p2 = previewMerge(FLAG, "r1");
  assert.deepEqual(p2, { error: "sample records cannot be merged" });

  const m1 = await mergePersons("r1", FLAG, "test-admin");
  assert.equal(m1.ok, false);
  assert.equal(m1.reason, "sample records cannot be merged");
  const m2 = await mergePersons(FLAG, "r1", "test-admin");
  assert.equal(m2.ok, false);
  assert.equal(m2.reason, "sample records cannot be merged");

  const after = fs.readFileSync(DB_PATH);
  assert.ok(before.equals(after), "db.json must be byte-identical after refused merges");

  const db = readDB();
  assert.ok(db.seafarers.some((s) => s.id === FLAG), "flagship survives reverse merge");
  assert.ok(db.accessGrants.some((g) => g.id === "g-sample"), "sample grant intact");
  assert.ok(db.accessGrants.some((g) => g.id === "g-dev-flag"), "real grant intact");
  // No sample token in ANY real row's priorShareTokens.
  for (const s of db.seafarers) {
    if (s.isSample === true) continue;
    for (const p of s.priorShareTokens ?? []) {
      assert.notEqual(p.token, SAMPLE_OPEN_TOKEN, `sample token carried into ${s.id}`);
      assert.notEqual(p.token, "sample-email-tok", `sample email token carried into ${s.id}`);
    }
  }
});

test("merge: a THROWING mutator persists nothing (the late-assert mechanism)", async () => {
  const before = fs.readFileSync(DB_PATH);
  await assert.rejects(
    transact((db) => {
      // Mutate first — exactly what a half-merge would have done…
      db.seafarers.find((s) => s.id === "r1").name = "HALF-MERGED";
      db.seafarers = db.seafarers.filter((s) => s.id !== FLAG);
      // …then the assert fires. A throw MUST skip writeAtomic entirely.
      throw new Error("sample-merge-assert: test");
    }, AUDIT_NO_IMPERSONATION),
    /sample-merge-assert/
  );
  const after = fs.readFileSync(DB_PATH);
  assert.ok(before.equals(after), "a thrown transact must leave db.json byte-identical");
  assert.ok(readDB().seafarers.some((s) => s.id === FLAG));
});

test("merge: source-order lock — the throwing assert sits BEFORE the token-carry block", () => {
  const src = fs.readFileSync(path.join(APP, "lib", "person-merge.ts"), "utf-8");
  const mergeBody = src.slice(src.indexOf("export function mergePersons"));
  const assertAt = mergeBody.indexOf("sample-merge-assert");
  const carryAt = mergeBody.indexOf("const priorTokens");
  assert.ok(assertAt > 0, "late assert present in mergePersons");
  assert.ok(carryAt > 0, "token-carry block present");
  assert.ok(assertAt < carryAt, "late assert must precede the token carry");
  // And the early guard must precede the archive write (return-refusal safety).
  const earlyAt = mergeBody.indexOf("sample records cannot be merged");
  const archiveAt = mergeBody.indexOf("archiveBeforeDelete(");
  assert.ok(earlyAt > 0 && archiveAt > 0 && earlyAt < archiveAt);
});

// ---------------------------------------------------------------------------
test("adoption: Google sign-in never adopts a sample row (fresh profile instead)", async () => {
  const flagBefore = readDB().seafarers.find((s) => s.id === FLAG);
  const newId = await findOrCreateSeafarerByGoogle(
    { sub: "gsub-test-1", email: "adopter@example.com", name: "Adopter" },
    SAMPLE_OPEN_TOKEN
  );
  assert.notEqual(newId, FLAG);
  const flagAfter = readDB().seafarers.find((s) => s.id === FLAG);
  assert.equal(flagAfter.googleSub ?? null, null);
  assert.equal(flagAfter.ownerEmail ?? null, null);
  assert.equal(flagBefore.isSample, true);
  await updateDB((d) => {
    d.seafarers = d.seafarers.filter((s) => s.id !== newId);
  });
});

test("adoption: password signup's findAdoptableProfileByToken rejects sample rows", () => {
  assert.equal(findAdoptableProfileByToken(readDB(), SAMPLE_OPEN_TOKEN), null);
  // Sanity: a genuinely unowned real row IS adoptable (guard is sample-specific).
  const r = findAdoptableProfileByToken(readDB(), "open-r1");
  assert.equal(r?.id, "r1");
});

// ---------------------------------------------------------------------------
test("deleteFromBoard: a sample row is view-only removable, never hard-deleted", async () => {
  await updateDB((db) => {
    const g = db.accessGrants.find((x) => x.id === "g-dev-flag");
    g.hiddenByAgentAt = iso; // delete requires board-hidden
  });
  const result = await deleteFromBoard(FLAG, "dev");
  assert.ok(typeof result === "object" && result.mode === "view", `expected view-only, got ${JSON.stringify(result)}`);
  const db = readDB();
  assert.ok(db.seafarers.some((s) => s.id === FLAG), "flagship row survives");
  assert.ok(db.documents.some((d) => d.id === "doc-cur"), "curated doc survives");
  // restore the grant for later tests
  await updateDB((d) => {
    const g = d.accessGrants.find((x) => x.id === "g-dev-flag");
    g.status = "ACTIVE";
    g.revokedAt = null;
    g.hiddenByAgentAt = null;
  });
});

test("client portal: sample subject excluded even under an adversarial clientVisible grant", async () => {
  const vis = await previewPortalVisibility("dev", [FLAG, "r1"]);
  const flag = vis.find((v) => v.seafarerId === FLAG);
  assert.equal(flag.visible, false);
  const real = vis.find((v) => v.seafarerId === "r1");
  assert.equal(real.visible, false); // r1 has no clientVisible -> not-consented
  assert.equal(real.reason, "not-consented");
});

// ---------------------------------------------------------------------------
test("static: zero inline ShareToken === comparisons in every migrated census file", () => {
  const migrated = [
    "app/api/seafarers/route.ts",
    "app/api/documents/route.ts",
    "app/api/files/[name]/route.ts",
    "app/api/comments/route.ts",
    "app/api/calendar/route.ts",
    "app/api/cv/[id]/route.ts",
    "app/api/contract/[id]/route.ts",
    "app/api/verify-link/route.ts",
    "app/api/sea-service/route.ts",
    "app/api/profile-photo/[id]/route.ts",
    "app/api/inbox/route.ts",
    "app/api/inbox/unread/route.ts",
    "app/api/inbox/seen/route.ts",
    "app/api/inbox/reply/route.ts",
    "app/api/profile-updates/route.ts",
    "app/api/access/propagation/route.ts",
    "app/api/access/propagation/request/route.ts",
    "app/api/appraisals/route.ts",
    "app/api/appraisals/delete-request/route.ts",
    "app/api/seafarer/client-visible/route.ts",
    "app/api/account/claim-report/route.ts",
    "app/api/seafarers/me/route.ts",
  ];
  const re = /\b\w*[sS]hareToken\s*===/;
  for (const rel of migrated) {
    const src = fs.readFileSync(path.join(APP, rel), "utf-8");
    assert.ok(!re.test(src), `${rel} still contains an inline ShareToken === compare`);
  }
  // The four EXEMPT rows carry their marker.
  for (const rel of [
    "app/api/reminders/route.ts",
    "app/api/doc-requests/route.ts",
    "app/api/bulk/route.ts",
    "app/api/invite/link/route.ts",
  ]) {
    const src = fs.readFileSync(path.join(APP, rel), "utf-8");
    assert.ok(src.includes("sample-token: exempt("), `${rel} missing sample-token exempt marker`);
  }
});

// ---------------------------------------------------------------------------
// Directory exclusion (plan §D10 rev-7, Phase 7): even under ADVERSARIAL dual
// consent — directoryOptIn forced true on the flagship AND an ACTIVE grant
// carrying directoryConsent:true — the candidate builder's isSample skip keeps
// every sample subject out of the public /directory. A real seafarer with the
// SAME dual consent lists (control: the builder is not just returning empty).
// ---------------------------------------------------------------------------
const { directoryCandidates } = await import("@/lib/directory");

test("directory: sample subject excluded even under adversarial dual consent", async () => {
  await updateDB((db) => {
    const flag = db.seafarers.find((x) => x.id === FLAG);
    flag.directoryOptIn = true; // adversarial — the seed guarantees false
    db.accessGrants.push({
      id: "g-adv-dir", seafarerId: FLAG, agentId: "agent:A", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-adv-dir-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review",
      directoryConsent: true,
    });
    // Control: real r1 (identityVerified in the fixture) with the same consent.
    const r1 = db.seafarers.find((x) => x.id === "r1");
    r1.directoryOptIn = true;
    db.accessGrants.push({
      id: "g-dir-r1", seafarerId: "r1", agentId: "agent:A", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-dir-r1-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review",
      directoryConsent: true,
    });
  });

  const ids = directoryCandidates().map((c) => c.seafarer.id);
  assert.ok(ids.includes("r1"), "control real seafarer must list");
  assert.ok(!ids.some((id) => isSampleId(id)), "no sample id may ever enter the directory");
  assert.ok(!ids.includes(FLAG));

  // Cleanup — later assertions must see the seed-shaped state.
  await updateDB((db) => {
    db.seafarers.find((x) => x.id === FLAG).directoryOptIn = false;
    db.seafarers.find((x) => x.id === "r1").directoryOptIn = false;
    db.accessGrants = db.accessGrants.filter((g) => g.id !== "g-adv-dir" && g.id !== "g-dir-r1");
  });
});
