// Public Sample Profiles — Phase 3/4 acceptance units:
//
//   - STATIC: app/seafarer/page.tsx contains ZERO raw `fetch(` occurrences
//     outside the guardedFetch wrapper definition (word-boundary regex — it does
//     not match `guardedFetch(`), and every one of the page's network call sites
//     goes through the wrapper (>= the 21 sites counted in Phase 1).
//   - owner-payload: the two modes (real vs curatedOnly) return the SAME shape,
//     so the client component consumes both without branching.
//   - §D8 recursive allowlist: the public payload's seafarer keys ⊆ the
//     allowlist (fails CLOSED on adversarially-added new fields), and no
//     forbidden key name appears ANYWHERE in the public payload tree.
//   - board data uses grant.stage, NEVER Seafarer.state (adversarial global
//     mirror mismatch leaves the projection unaffected).
//   - duplicates index is SAMPLE-COHORT-scoped (an adversarial real seafarer
//     with a colliding cert number never enters it — no real name leaks).
//   - the SSR inbox thread: curated circular + 3 replies, peer anonymised.
//
// Run: node --import ./tests/_register-sample.mjs --test tests/sample-pages.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(TESTS_DIR, "..");

// ---- STATIC no-raw-fetch check (needs no db — run before the chdir) ----------

test("static: app/seafarer/page.tsx has no raw fetch( outside guardedFetch", () => {
  const src = fs.readFileSync(path.join(APP_DIR, "app", "seafarer", "page.tsx"), "utf-8");
  // Word boundary: does NOT match `guardedFetch(` (capital F breaks the word) —
  // exactly the plan's `\bfetch\(` rule (v3-6).
  const raw = [...src.matchAll(/\bfetch\(/g)];
  assert.equal(
    raw.length,
    1,
    `expected exactly ONE raw fetch( — the guardedFetch wrapper body — found ${raw.length}`
  );
  // The one allowed occurrence is the wrapper's delegation line.
  const line = src.slice(0, raw[0].index).split("\n").length;
  const lineText = src.split("\n")[line - 1];
  assert.match(lineText, /return fetch\(input, init\)/, "the raw fetch( must be the wrapper body");
  // Every converted call site goes through the wrapper (Phase 1 counted 21).
  const guarded = [...src.matchAll(/\bguardedFetch\(/g)];
  assert.ok(
    guarded.length >= 22, // 21 call sites + the wrapper definition itself
    `expected >= 22 guardedFetch occurrences (21 sites + definition), found ${guarded.length}`
  );
});

// ---- Seeded throwaway db (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-pages-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });

const seed = await import("../scripts/seed-samples.mjs");
{
  const db = {};
  seed.applySeed(db);
  fs.writeFileSync(path.join(TMP, "data", "db.json"), JSON.stringify(db, null, 2), "utf-8");
}
process.chdir(TMP);
globalThis.__TEST_COOKIES = {};
globalThis.__TEST_AUTH = null;

const { readDB, updateDB } = await import("@/lib/db");
const { SAMPLE_FLAGSHIP_ID, SAMPLE_CREW_IDS, SAMPLE_OPEN_TOKEN } = await import("@/lib/sample-ids");
const { SAMPLE_EXPOSED_SEAFARER_KEYS } = await import("@/lib/sample-guard");
const { buildOwnerPayload } = await import("@/lib/owner-payload");
const { getSampleSeafarerPayload, getSampleBoardData, getSampleReviewData, getSampleCircularThread } =
  await import("@/lib/sample-data");

// Keys that must NEVER appear anywhere in a public payload tree (plan §D8).
const FORBIDDEN_KEYS = new Set([
  "emailShareToken",
  "allowedEmails",
  "googleSub",
  "ownerEmail",
  "importedEmail",
  "credentialUserId",
  "personalCode",
  "selfProfile",
  "priorShareTokens",
  "shareTokenLastUsedAt",
]);

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

// ---- owner-payload two-mode shape compat -------------------------------------

test("buildOwnerPayload: real and curatedOnly modes return the same shape", () => {
  const db = readDB();
  const real = buildOwnerPayload(db, SAMPLE_FLAGSHIP_ID);
  const pub = buildOwnerPayload(db, SAMPLE_FLAGSHIP_ID, { curatedOnly: true });
  assert.ok(real.seafarer && pub.seafarer, "both modes resolve the flagship");
  assert.deepEqual(Object.keys(real).sort(), Object.keys(pub).sort());
  // Every collection is an array in both modes (the client maps them unconditionally).
  for (const k of Object.keys(real)) {
    if (k === "seafarer") continue;
    assert.ok(Array.isArray(real[k]) && Array.isArray(pub[k]), `${k} is an array in both modes`);
  }
  // Curated mode is strictly filtered + redacted.
  assert.ok(pub.documents.every((d) => d.sample === true), "curated docs only");
  assert.ok(pub.docRequests.every((r) => r.sample === true), "curated requests only");
  assert.equal(pub.propagationRequests.length, 0, "propagation requests never curated");
  assert.equal(pub.appraisalDeleteRequests.length, 0, "appraisal-delete requests never curated");
  assert.ok(
    pub.flows.every((f) => f.agentId.startsWith("sample-")),
    "only sample-agency flows render publicly"
  );
});

// ---- §D8 recursive allowlist (fails closed on new fields) --------------------

test("public payload: seafarer keys ⊆ allowlist, no forbidden key anywhere, fails closed", async () => {
  const payload = getSampleSeafarerPayload();
  assert.ok(payload, "seeded flagship resolves");
  const allow = new Set(SAMPLE_EXPOSED_SEAFARER_KEYS);
  for (const k of Object.keys(payload.seafarer)) {
    assert.ok(allow.has(k), `seafarer key "${k}" is not on the §D8 allowlist`);
  }
  // The alias invariant that justifies exposing shareToken at all.
  assert.equal(payload.seafarer.shareToken, payload.seafarer.openShareToken);
  assert.equal(payload.seafarer.openShareToken, SAMPLE_OPEN_TOKEN);
  // Recursive forbidden-key sweep over the WHOLE public tree (docs, requests,
  // flows, inbox — any nested collection).
  const seen = collectKeys(payload);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!seen.has(k), `forbidden key "${k}" leaked into the public payload`);
  }

  // FAILS CLOSED: an adversarial future field on the row must be dropped.
  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === SAMPLE_FLAGSHIP_ID);
    s.futureSecretField = "must-never-render";
  });
  const again = getSampleSeafarerPayload();
  assert.ok(!("futureSecretField" in again.seafarer), "unknown new field must be dropped");
  assert.ok(!JSON.stringify(again.seafarer).includes("must-never-render"));
  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === SAMPLE_FLAGSHIP_ID);
    delete s.futureSecretField;
  });
});

// ---- board: grant.stage is the ONLY stage source -----------------------------

test("board + review stage come from grant.stage, never Seafarer.state", async () => {
  // Adversarial: desync the deprecated global mirror from the grant.
  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === SAMPLE_FLAGSHIP_ID);
    s.state = "review"; // grant stage is "accepted"
  });
  const board = getSampleBoardData();
  assert.ok(board, "board resolves");
  const flag = board.roster.find((r) => r.id === SAMPLE_FLAGSHIP_ID);
  assert.equal(flag.state, "accepted", "board row projects the GRANT stage");
  const review = getSampleReviewData(SAMPLE_FLAGSHIP_ID);
  assert.equal(review.seafarer.state, "accepted", "review projects the GRANT stage");
  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === SAMPLE_FLAGSHIP_ID);
    s.state = "accepted";
  });

  // Full-coverage sanity: 8 rows (flagship + 7 crew) across all five stages.
  assert.equal(board.roster.length, 1 + SAMPLE_CREW_IDS.length);
  const stages = new Set(board.roster.map((r) => r.state));
  for (const st of ["review", "accepted", "sent_to_sea", "returning", "finished"]) {
    assert.ok(stages.has(st), `stage ${st} represented on the board`);
  }
  // Redaction holds on board rows too (allowlist + the explicit board extras).
  const extras = new Set(["state", "documents", "docRequests", "assigned"]);
  const allow = new Set(SAMPLE_EXPOSED_SEAFARER_KEYS);
  for (const k of Object.keys(flag)) {
    assert.ok(allow.has(k) || extras.has(k), `board row key "${k}" not allowlisted`);
  }
});

// ---- duplicates index: sample cohort ONLY ------------------------------------

test("duplicates index is cohort-scoped — a colliding REAL seafarer never enters it", async () => {
  await updateDB((d) => {
    d.seafarers.push({
      id: "real-collider",
      name: "Real Person",
      rank: "Bosun",
      state: "review",
      createdAt: new Date().toISOString(),
    });
    d.documents.push({
      id: "real-collider-doc",
      seafarerId: "real-collider",
      title: "Dangerous Goods Handling",
      docType: "Qualification",
      certNumber: "SAMPLE-DGH-4419", // collides with the seeded forged pair
      isValid: true,
      validUntil: null,
      createdAt: new Date().toISOString(),
      source: "manual",
      reviewStatus: "pending",
    });
  });
  const board = getSampleBoardData();
  const json = JSON.stringify(board.duplicates);
  assert.ok(!json.includes("Real Person"), "no real name in the sample duplicates index");
  assert.ok(!json.includes("real-collider"), "no real id in the sample duplicates index");
  // The seeded forged pair itself still fires within the cohort.
  const entries = Object.values(board.duplicates).flat();
  const dghNames = entries.map((e) => e.name);
  assert.ok(
    dghNames.some((n) => n.startsWith("Dainis")) && dghNames.some((n) => n.startsWith("Tonu")),
    "the seeded cohort duplicate pair is still flagged"
  );
  assert.ok(entries.every((e) => e.name.includes("SAMPLE")), "every entry is a sample persona");
  await updateDB((d) => {
    d.seafarers = d.seafarers.filter((s) => s.id !== "real-collider");
    d.documents = d.documents.filter((x) => x.id !== "real-collider-doc");
  });
});

// ---- SSR inbox thread --------------------------------------------------------

test("sample inbox: curated thread, own replies as You, peer anonymised", () => {
  const payload = getSampleSeafarerPayload();
  assert.equal(payload.inbox.items.length, 1);
  const item = payload.inbox.items[0];
  assert.match(item.subject, /Riga/);
  assert.equal(item.allowReplies, true);
  assert.equal(item.replies.length, 3);
  const own = item.replies.filter((r) => r.mine);
  const peers = item.replies.filter((r) => !r.mine);
  assert.equal(own.length, 2);
  assert.ok(own.every((r) => r.author === "You"));
  assert.equal(peers.length, 1);
  assert.equal(peers[0].author, "A crew member", "peer reply is anonymised");
  assert.equal(peers[0].visibility, "all");
  // No real author name leaks through the seaman-shaped reply objects.
  assert.ok(!JSON.stringify(item.replies).includes("Jankauskiene"));
  assert.ok(payload.inbox.unreadCount >= 1, "unread badge demoed");
});

// ---- circular thread (agent view) --------------------------------------------

test("sample circular thread: agent view carries real sample author names", () => {
  const thread = getSampleCircularThread();
  assert.ok(thread);
  assert.equal(thread.circulars.length, 1);
  const replies = thread.repliesByCircular[thread.circulars[0].id];
  assert.equal(replies.length, 3);
  assert.ok(replies.some((r) => r.authorName.startsWith("Ruta")));
  assert.ok(replies.every((r) => r.stillOnRoster === true));
});

// ---- Phase 6 — SEO: indexable /sample metadata + sitemap ---------------------

test("no inherited noindex on /sample/*: explicit robots index, no sample layout", () => {
  for (const rel of ["app/sample/seafarer/page.tsx", "app/sample/agency/page.tsx"]) {
    const src = fs.readFileSync(path.join(APP_DIR, rel), "utf-8");
    // Belt-and-braces explicit robots (locked indexable decision) …
    assert.match(src, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/, `${rel} robots`);
    // … and no CODE in the page may flip it (comments may explain the rule).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/noindex/i.test(code), `${rel} code must not mention noindex`);
  }
  // The /sample segment has NO layout module that could reintroduce an inherited
  // robots default (the /seafarer + /agent noindex layouts are not ancestors).
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const layouts = walk(path.join(APP_DIR, "app", "sample")).filter((p) =>
    /layout\.(ts|tsx)$/.test(p)
  );
  assert.deepEqual(layouts, [], "no layout may exist under app/sample");
});

test("sitemap lists both /sample URLs with static lastmod dates; robots untouched", async () => {
  const sitemap = (await import("@/app/sitemap")).default;
  const entries = sitemap();
  const byPath = (p) => entries.find((e) => e.url.endsWith(p));
  for (const p of ["/sample/seafarer", "/sample/agency"]) {
    const row = byPath(p);
    assert.ok(row, `sitemap missing ${p}`);
    // The file's static-date rule (TS6): a literal yyyy-mm-dd, never a Date
    // minted at build time.
    assert.equal(typeof row.lastModified, "string");
    assert.match(row.lastModified, /^\d{4}-\d{2}-\d{2}$/);
  }
  // The 4 marketing URLs stay listed — the addition is purely additive.
  for (const p of ["/overview/agencies", "/overview/seafarers"]) assert.ok(byPath(p));
  // robots.ts stays untouched: /sample must NOT be disallowed (a disallowed URL
  // can never be crawled to see its indexable metadata).
  const robotsSrc = fs.readFileSync(path.join(APP_DIR, "app", "robots.ts"), "utf-8");
  assert.ok(!robotsSrc.includes("/sample"), "robots.ts must not mention /sample");
});
