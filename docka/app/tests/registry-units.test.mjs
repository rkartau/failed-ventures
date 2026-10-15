// Unit tests for increment 2 of the EU VerifierRegistry plan (§4 data model,
// §5.1 badge layer, §2.5 trust rules, §4.9 dedupe country-scoping, §4.4
// manual-request idempotency).
//
// Follows the admin-funnel.test.mjs pattern: plain node + the `@/*` alias hook,
// synthetic fixtures, deterministic. The readDB migration cases run against a
// REAL data/db.json in a throwaway temp dir — process.chdir happens BEFORE the
// dynamic imports because lib/db.ts resolves DATA_DIR from process.cwd() at
// module-evaluation time.
//
// Run: node --import ./tests/_register-alias.mjs tests/registry-units.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Increment-3 sections (F–H) exercise mock-mode-only surfaces (test adapter
// overrides, the dev client-IP override header). Set BEFORE any @/lib import.
process.env.REGISTRY_MOCK = "1";

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

// ---- Throwaway data dir + fixture db.json (BEFORE any @/lib import) -----

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-registry-units-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });

const FIXTURE_DB = {
  seafarers: [
    {
      id: "S1",
      name: "Jaan Tamm",
      rank: "Master",
      state: "review",
      shareToken: "tok-s1-units",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  documents: [
    // G1 — PRE-MIGRATION legacy EE government doc: no registryCountry, no
    // verifiedKeyTrust, but a captured holder snapshot (the backfill fast path).
    {
      id: "G1",
      seafarerId: "S1",
      title: "Certificate of competency",
      docType: "Certificate of competency",
      docCategory: "competency",
      estonianCode: "ABCDEF123456",
      certNumber: "ABCDEF123456",
      isValid: true,
      validUntil: "2027-03-28T00:00:00.000Z",
      fileName: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      source: "government",
      reviewStatus: "pending",
      verifiedFirstName: "JAAN",
      verifiedLastName: "TAMM",
      verifiedFullName: "JAAN TAMM",
      verifiedResolvedAt: "2026-01-02T00:00:00.000Z",
    },
    // M1 — manual row WITH an (unverified) estonianCode: the code was never
    // verified against any registry, so it must NOT be labeled EE (§4.1).
    {
      id: "M1",
      seafarerId: "S1",
      title: "Unverified document",
      docType: "Document",
      docCategory: null,
      estonianCode: "ZZZZ99999",
      isValid: null,
      validUntil: null,
      fileName: "m1.jpg",
      createdAt: "2026-01-03T00:00:00.000Z",
      source: "manual",
      reviewStatus: "pending",
    },
    // G2 — government row that ALREADY carries country + trust: preserved verbatim.
    {
      id: "G2",
      seafarerId: "S1",
      title: "DK certificate",
      docType: "Certificate of competency",
      docCategory: "competency",
      estonianCode: "DKCODE7777",
      isValid: true,
      validUntil: "2027-01-01T00:00:00.000Z",
      fileName: null,
      createdAt: "2026-01-04T00:00:00.000Z",
      source: "government",
      reviewStatus: "pending",
      registryCountry: "DK",
      verifiedKeyTrust: "public-identifier",
    },
    // P1 — plain photo doc: stays country-less (null).
    {
      id: "P1",
      seafarerId: "S1",
      title: "Certificate photo 1",
      docType: "Photo — not verified",
      docCategory: null,
      estonianCode: null,
      certNumber: "SHARED7777",
      isValid: null,
      validUntil: null,
      fileName: "p1.jpg",
      createdAt: "2026-01-05T00:00:00.000Z",
      source: "photo",
      reviewStatus: "pending",
    },
  ],
};
fs.writeFileSync(
  path.join(TMP, "data", "db.json"),
  JSON.stringify(FIXTURE_DB, null, 2),
  "utf-8"
);

const APP_CWD = process.cwd();
process.chdir(TMP); // MUST precede the imports below (DATA_DIR is cwd-resolved)

const {
  readDB,
  requestManualVerification,
  confirmManualVerification,
  closeManualVerification,
} = await import("@/lib/db");
const { docBadge, BADGE_LABELS } = await import("@/lib/cert");
const {
  applyVerifiedIdentity,
  applyVerifiedHolderToDoc,
  holderFromDoc,
} = await import("@/lib/verify");
const {
  buildDuplicateIndex,
  duplicateNameIndex,
  duplicateOthers,
  isSameSeafarerDuplicate,
} = await import("@/lib/duplicates");
const {
  bindHolder,
  clientIpFromHeaders,
  consumeRegistryBudget,
  registryJournal,
  resetRegistryAbuseState,
  resetRegistryJournal,
  resolveInput,
  __setTestAdapter,
} = await import("@/lib/registry");
const { countryEntry } = await import("@/lib/registry/countries");

// =========================================================================
// A. readDB read-migration (§4.1 / §4.10)
// =========================================================================
{
  const db = readDB();
  const byId = new Map(db.documents.map((d) => [d.id, d]));
  const g1 = byId.get("G1");
  const m1 = byId.get("M1");
  const g2 = byId.get("G2");
  const p1 = byId.get("P1");

  assert.equal(g1.registryCountry, "EE");
  ok("migration: legacy government doc labeled registryCountry EE");
  assert.equal(g1.verifiedKeyTrust, "capability-token");
  ok("migration: legacy government doc defaults keyTrust capability-token");

  assert.equal(m1.registryCountry, null);
  assert.equal(m1.verifiedKeyTrust, undefined);
  ok("migration: manual doc with (unverified) estonianCode NOT labeled EE");

  assert.equal(g2.registryCountry, "DK");
  assert.equal(g2.verifiedKeyTrust, "public-identifier");
  ok("migration: explicit registryCountry/verifiedKeyTrust preserved verbatim");

  assert.equal(p1.registryCountry, null);
  ok("migration: photo doc stays registryCountry null");

  // ---- §2.5 keyTrust round-trip: pre-migration EE snapshot still heals ----
  const holder = holderFromDoc(g1);
  assert.equal(holder.keyTrust, "capability-token");
  const sf = { id: "S1", identityVerified: false };
  assert.equal(applyVerifiedIdentity(sf, holder), true);
  assert.equal(sf.identityVerified, true);
  assert.equal(sf.verifiedName, "JAAN TAMM");
  ok("gate: rehydrated PRE-migration EE snapshot still heals identity (no EE regression)");

  // ---- rehydrated public-identifier snapshot: gate no-ops ----
  const dkHolder = holderFromDoc(g2);
  assert.equal(dkHolder.keyTrust, "public-identifier");
  const sf2 = { id: "S1", identityVerified: false };
  // G2 has no captured name, but the gate must reject BEFORE the name check;
  // give it a name to prove keyTrust (not the name) is what blocks it.
  dkHolder.hasName = true;
  dkHolder.fullName = "SOMEONE ELSE";
  assert.equal(applyVerifiedIdentity(sf2, dkHolder), false);
  assert.equal(sf2.identityVerified, false);
  assert.equal(sf2.verifiedName, undefined);
  ok("gate: rehydrated public-identifier snapshot never heals identity");
}

// =========================================================================
// B. docBadge — new states + precedence (§5.1)
// =========================================================================
{
  const FUTURE = new Date(Date.now() + 400 * 86_400_000).toISOString();
  const SOON = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const PAST = "2020-01-01T00:00:00.000Z";

  let b = docBadge({ verified: false, source: "registry", validUntil: FUTURE, expiryConfirmed: true });
  assert.deepEqual(b, {
    status: "registry-doc",
    label: "Registry-confirmed — holder not verified",
  });
  ok("badge: source registry + future expiry -> teal registry-doc");

  b = docBadge({ verified: false, source: "registry", validUntil: null });
  assert.equal(b.status, "registry-doc");
  ok("badge: source registry + no expiry -> teal registry-doc");

  b = docBadge({ verified: false, source: "registry", validUntil: PAST });
  assert.deepEqual(b, { status: "expired", label: "Registry-confirmed · expired" });
  ok("badge: EXPIRED outranks teal — 'Registry-confirmed · expired' with expiry visuals");

  b = docBadge({ verified: false, source: "registry", validUntil: SOON });
  assert.deepEqual(b, { status: "expiring", label: "Registry-confirmed · expiring soon" });
  ok("badge: EXPIRING outranks teal");

  b = docBadge({ verified: false, manualRequested: true });
  assert.deepEqual(b, { status: "requested", label: "Verification requested" });
  ok("badge: manual verification requested -> violet 'Verification requested'");

  b = docBadge({ verified: false, manualRequested: true, validUntil: PAST });
  assert.equal(b.status, "expired");
  ok("badge: expired outranks 'requested' (warning never under-asserts)");

  b = docBadge({ verified: false, checkedVia: "registry-portal" });
  assert.deepEqual(b, { status: "checked", label: "Checked against registry" });
  ok("badge: portal sign-off -> blue 'Checked against registry' (never emerald)");

  // Regressions: every legacy shape unchanged. #S3 (Batch-2) relabelled BADGE_LABELS.valid
  // to "In date" and docBadge's VERIFIED pill now returns BADGE_LABELS[s] (the validity
  // axis) — so a verified, in-date doc reads "In date" (the trust wording moved to the
  // VerificationLevelBadge). Assert the literal docBadge return.
  b = docBadge({ verified: true, validUntil: FUTURE });
  assert.deepEqual(b, { status: "valid", label: "In date" });
  b = docBadge({ verified: false, validUntil: FUTURE, expiryConfirmed: true });
  assert.equal(b.status, "unverified");
  b = docBadge({ verified: false, validUntil: FUTURE, expiryConfirmed: false });
  assert.equal(b.status, "unread");
  b = docBadge({ verified: false, validUntil: PAST });
  assert.deepEqual(b, { status: "expired", label: "Expired · not verified" });
  b = docBadge({ verified: false });
  assert.equal(b.status, "unverified");
  ok("badge: all legacy shapes (verified / unverified / unread / expired) unchanged");
}

// =========================================================================
// C. applyVerifiedIdentity gate + snapshot persistence (§2.5 rule 1 / §4.10)
// =========================================================================
{
  const namedCert = (keyTrust) => ({
    ok: true,
    code: "ABCDEF123456",
    docCategory: "competency",
    hasName: true,
    fullName: "JAAN TAMM",
    firstName: "JAAN",
    lastName: "TAMM",
    title: "CoC",
    personalCode: "39001010000",
    birthDate: "1990-01-01T00:00:00+00:00",
    status: "valid",
    isValid: true,
    issuedOn: "",
    validUntil: "2027-01-01T00:00:00+00:00",
    certificateType: "CoC",
    issuerCountry: "Eesti",
    institution: "",
    documentType: "",
    sourceUrl: "",
    registryCountry: "EE",
    keyTrust,
    verifiedSource: "government",
  });

  const sf = { id: "X", identityVerified: false };
  assert.equal(applyVerifiedIdentity(sf, namedCert("capability-token")), true);
  assert.equal(sf.identityVerified, true);
  assert.equal(sf.verifiedName, "JAAN TAMM");
  ok("gate: capability-token verification proceeds (identity self-heal)");

  const sf2 = { id: "X2", identityVerified: false };
  assert.equal(applyVerifiedIdentity(sf2, namedCert("public-identifier")), false);
  assert.equal(sf2.identityVerified, false);
  assert.equal(sf2.verifiedName, undefined);
  ok("gate: public-identifier verification is a strict no-op");

  const sf3 = { id: "X3", identityVerified: false };
  assert.equal(applyVerifiedIdentity(sf3, namedCert(undefined)), false);
  assert.equal(sf3.identityVerified, false);
  ok("gate: ABSENT keyTrust fails closed (undefined !== capability-token)");

  // ---- applyVerifiedHolderToDoc persists keyTrust; holderFromDoc rehydrates ----
  const doc = { id: "D", seafarerId: "X" };
  applyVerifiedHolderToDoc(doc, namedCert("public-identifier"));
  assert.equal(doc.verifiedKeyTrust, "public-identifier");
  assert.equal(holderFromDoc(doc).keyTrust, "public-identifier");
  ok("snapshot: named result persists verifiedKeyTrust; holderFromDoc rehydrates it");

  const nameless = { ...namedCert("capability-token"), hasName: false, fullName: "" };
  const doc2 = { id: "D2", seafarerId: "X" };
  applyVerifiedHolderToDoc(doc2, nameless);
  assert.equal(doc2.verifiedKeyTrust, "capability-token");
  assert.equal(doc2.verifiedFullName, undefined);
  ok("snapshot: NAME-LESS (medical) result still persists verifiedKeyTrust");
}

// =========================================================================
// D. Dedupe country-scoping (§4.9) — index shape + null-wildcard both ways
// =========================================================================
{
  const mkDoc = (id, seafarerId, certNumber, { source = "manual", registryCountry = null } = {}) => ({
    id,
    seafarerId,
    title: `Doc ${id}`,
    docType: "Document",
    docCategory: null,
    estonianCode: null,
    certNumber,
    isValid: null,
    validUntil: null,
    fileName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    source,
    requiredType: null,
    reviewStatus: "pending",
    registryCountry,
  });

  const nameOf = (id) => ({ A: "Anna", B: "Ben", C: "Cara" })[id] ?? id;

  // ---- new index value shape: {name, registryCountry}[], key = number alone ----
  const docsShape = [
    mkDoc("d1", "A", "SHARED-7777", { source: "photo", registryCountry: null }),
    mkDoc("d2", "B", "shared 7777", { registryCountry: "DK" }),
  ];
  const rawIdx = buildDuplicateIndex(docsShape);
  assert.deepEqual(
    [...rawIdx.keys()],
    ["SHARED7777"],
    "index key must stay the normalized number alone (never country-suffixed)"
  );
  assert.deepEqual(rawIdx.get("SHARED7777"), [
    { seafarerId: "A", registryCountry: null },
    { seafarerId: "B", registryCountry: "DK" },
  ]);
  const nameIdx = duplicateNameIndex(docsShape, nameOf);
  assert.deepEqual(nameIdx.SHARED7777, [
    { name: "Anna", registryCountry: null },
    { name: "Ben", registryCountry: "DK" },
  ]);
  ok("index: values are {name, registryCountry}[] keyed on the bare normalized number");

  // ---- null-wildcard BOTH directions: photo null:X vs DK:X still flags ----
  assert.deepEqual(duplicateOthers(docsShape[0], nameIdx, "Anna"), ["Ben"]);
  assert.deepEqual(duplicateOthers(docsShape[1], nameIdx, "Ben"), ["Anna"]);
  ok("wildcard: photo null:X vs DK:X flags BOTH directions through the new shape");

  // ---- two DIFFERENT non-null countries: NOT a duplicate ----
  const docsCross = [
    mkDoc("d3", "A", "SHARED7777", { registryCountry: "DK" }),
    mkDoc("d4", "B", "SHARED7777", { registryCountry: "EE" }),
  ];
  const crossIdx = duplicateNameIndex(docsCross, nameOf);
  assert.deepEqual(duplicateOthers(docsCross[0], crossIdx, "Anna"), []);
  assert.deepEqual(duplicateOthers(docsCross[1], crossIdx, "Ben"), []);
  ok("scoping: DK:X vs EE:X (different non-null countries) is NOT a duplicate");

  // ---- same non-null country still flags; government still suppressed ----
  const docsSame = [
    mkDoc("d5", "A", "SHARED7777", { registryCountry: "DK" }),
    mkDoc("d6", "B", "SHARED7777", { registryCountry: "DK" }),
    mkDoc("d7", "C", "SHARED7777", { source: "government", registryCountry: "EE" }),
  ];
  const sameIdx = duplicateNameIndex(docsSame, nameOf);
  assert.deepEqual(duplicateOthers(docsSame[0], sameIdx, "Anna"), ["Ben"]);
  assert.deepEqual(
    duplicateOthers(docsSame[2], sameIdx, "Cara"),
    [],
    "government doc must keep the forgery-banner suppression"
  );
  ok("scoping: same country flags; government suppression unchanged");

  // ---- isSameSeafarerDuplicate (§4.9 in-route surface) ----
  const ex = (country) => mkDoc("e1", "A", "NUM123456", { registryCountry: country });
  const inc = (country) => mkDoc("e2", "A", "NUM123456", { registryCountry: country });
  assert.equal(isSameSeafarerDuplicate(ex("DK"), inc("EE"), null), false);
  ok("same-seafarer: same number, DIFFERENT non-null countries -> NOT a duplicate");
  assert.equal(isSameSeafarerDuplicate(ex("DK"), inc(null), null), true);
  assert.equal(isSameSeafarerDuplicate(ex(null), inc("DK"), null), true);
  ok("same-seafarer: null-wildcard matches BOTH directions (DK:X vs null:X duplicate)");
  assert.equal(isSameSeafarerDuplicate(ex("DK"), inc("DK"), null), true);
  ok("same-seafarer: same number + same country still a duplicate");
  const exT = { ...ex("DK"), certNumber: null, title: "Yellow fever", validUntil: "2027-01-01" };
  const incT = { ...inc("EE"), certNumber: null, title: "yellow  fever", validUntil: "2027-01-01" };
  assert.equal(isSameSeafarerDuplicate(exT, incT, null), true);
  ok("same-seafarer: title+expiry signature stays country-agnostic (content match)");
}

// =========================================================================
// E. Manual-request idempotency (§4.4)
// =========================================================================
{
  const doc = { id: "MV1", seafarerId: "S1" };
  assert.equal(requestManualVerification(doc, "maria@agency.example"), true);
  assert.equal(doc.manualVerification.status, "requested");
  assert.equal(doc.manualVerification.requestedBy, "maria@agency.example");
  const firstRequestedAt = doc.manualVerification.requestedAt;
  assert.ok(firstRequestedAt);

  // Sentinel so an accidental overwrite is unmistakable even within the same ms.
  doc.manualVerification.requestedAt = "SENTINEL-FIRST-REQUEST";
  assert.equal(requestManualVerification(doc, "other@agency.example"), false);
  assert.equal(doc.manualVerification.requestedAt, "SENTINEL-FIRST-REQUEST");
  assert.equal(doc.manualVerification.requestedBy, "maria@agency.example");
  ok("manual request: second request (double-click / re-POST) never overwrites requestedAt");

  const confirmed = {
    id: "MV2",
    seafarerId: "S1",
    manualVerification: {
      status: "confirmed",
      requestedAt: "2026-01-01T00:00:00.000Z",
      requestedBy: "maria@agency.example",
      confirmedAt: "2026-02-01T00:00:00.000Z",
      confirmedBy: "authority@rna.ro",
    },
  };
  assert.equal(requestManualVerification(confirmed, "maria@agency.example"), false);
  assert.equal(confirmed.manualVerification.status, "confirmed");
  ok("manual request: a re-request can never clobber a CONFIRMED state");
}

// =========================================================================
// E2. Manual-verification confirm/close transitions (§4.4, increment 7)
// =========================================================================
{
  // No state at all: confirm/close are no-ops (nothing to act on).
  const bare = { id: "MV3", seafarerId: "S1" };
  assert.equal(confirmManualVerification(bare, "maria@agency.example"), false);
  assert.equal(closeManualVerification(bare), false);
  assert.equal(bare.manualVerification, undefined);
  ok("manual confirm/close: no-op on a doc with NO manualVerification state");

  // requested -> confirmed sets confirmedAt/confirmedBy and keeps the request audit.
  const doc = { id: "MV4", seafarerId: "S1" };
  requestManualVerification(doc, "seafarer");
  doc.manualVerification.requestedAt = "SENTINEL-REQUESTED-AT";
  assert.equal(confirmManualVerification(doc, "maria@agency.example"), true);
  assert.equal(doc.manualVerification.status, "confirmed");
  assert.equal(doc.manualVerification.confirmedBy, "maria@agency.example");
  assert.ok(doc.manualVerification.confirmedAt);
  assert.equal(doc.manualVerification.requestedAt, "SENTINEL-REQUESTED-AT");
  ok("manual confirm: requested -> confirmed with confirmedAt/By; request audit untouched");

  // Idempotency: a second confirm never re-stamps the original confirmation.
  doc.manualVerification.confirmedAt = "SENTINEL-FIRST-CONFIRM";
  assert.equal(confirmManualVerification(doc, "other@agency.example"), false);
  assert.equal(doc.manualVerification.confirmedAt, "SENTINEL-FIRST-CONFIRM");
  assert.equal(doc.manualVerification.confirmedBy, "maria@agency.example");
  ok("manual confirm: double-click / re-POST never overwrites the first confirmation");

  // Confirmed is terminal for close: never demoted to closed_unavailable.
  assert.equal(closeManualVerification(doc), false);
  assert.equal(doc.manualVerification.status, "confirmed");
  ok("manual close: a CONFIRMED state is never demoted");

  // requested -> closed_unavailable; re-close no-op; re-request no-op.
  const doc2 = { id: "MV5", seafarerId: "S1" };
  requestManualVerification(doc2, "seafarer");
  doc2.manualVerification.requestedAt = "SENTINEL-REQ2";
  assert.equal(closeManualVerification(doc2), true);
  assert.equal(doc2.manualVerification.status, "closed_unavailable");
  assert.equal(closeManualVerification(doc2), false);
  assert.equal(requestManualVerification(doc2, "other"), false);
  assert.equal(doc2.manualVerification.requestedAt, "SENTINEL-REQ2");
  ok("manual close: requested -> closed_unavailable; re-close + re-request are no-ops");

  // Late authority reply: closed_unavailable -> confirmed is allowed.
  assert.equal(confirmManualVerification(doc2, "maria@agency.example"), true);
  assert.equal(doc2.manualVerification.status, "confirmed");
  ok("manual confirm: late reply after close is accepted (closed -> confirmed)");

  // Badge honesty: violet ONLY while the request is OPEN ("requested").
  let b = docBadge({ verified: false, manualRequested: true });
  assert.equal(b.status, "requested");
  assert.equal(b.label, BADGE_LABELS.requested);
  b = docBadge({ verified: false, manualRequested: false });
  assert.notEqual(b.status, "requested");
  ok("badge: violet 'requested' only while the manual request is open");
}

// Shared factory for the increment-3 sections: a complete VerifiedCert shape.
const mkCert = (over = {}) => ({
  ok: true,
  code: "1234567890",
  docCategory: "competency",
  hasName: true,
  fullName: "JOHN SMITH",
  firstName: "JOHN",
  lastName: "SMITH",
  title: "Certificate of competency",
  personalCode: "",
  birthDate: "1990-01-01T00:00:00+00:00",
  status: "valid",
  isValid: true,
  issuedOn: "",
  validUntil: "2027-01-01T00:00:00+00:00",
  certificateType: "CoC",
  issuerCountry: "UK",
  institution: "",
  documentType: "",
  sourceUrl: "",
  registryCountry: "UK",
  keyTrust: "public-identifier",
  verifiedSource: "government",
  ...over,
});

// =========================================================================
// F. bindHolder (§2.5 rules 2–4) — THE public-identifier choke point
// =========================================================================
{
  const pend = (c) => ({ kind: "pending-binding", cert: c, country: countryEntry("UK") });

  // Token-set name compare: order-insensitive BOTH directions.
  let r = bindHolder(pend(mkCert()), { id: "s", name: "", verifiedName: "Smith John" });
  assert.equal(r.ok, true);
  r = bindHolder(pend(mkCert({ fullName: "SMITH JOHN" })), { id: "s", name: "John Smith" });
  assert.equal(r.ok, true);
  ok("bindHolder: token-set name compare is order-insensitive both directions");

  // Case + diacritic folding.
  r = bindHolder(pend(mkCert({ fullName: "JÜRI ÕUN" })), { id: "s", name: "juri oun" });
  assert.equal(r.ok, true);
  ok("bindHolder: case + diacritic folding matches");

  // Mismatch -> error + holderMismatch flag, never green.
  r = bindHolder(pend(mkCert()), { id: "s", name: "Someone Else" });
  assert.equal(r.ok, false);
  assert.equal(r.holderMismatch, true);
  ok("bindHolder: holder mismatch -> error + holderMismatch flag");

  // MATCH stores, but identity stays untouched (rule-1 gate no-ops inside
  // applyVerifiedIdentity for public-identifier certs).
  const sf = { id: "s", name: "John Smith", identityVerified: false };
  r = bindHolder(pend(mkCert()), sf);
  assert.equal(r.ok, true);
  assert.equal(applyVerifiedIdentity(sf, r.cert), false);
  assert.equal(sf.identityVerified, false);
  assert.equal(sf.verifiedName, undefined);
  ok("bindHolder: public-identifier MATCH binds the doc but NEVER heals identity");

  // DOB exact when both known (date-only compare, no timezone math).
  r = bindHolder(pend(mkCert()), {
    id: "s",
    name: "John Smith",
    birthDate: "1991-05-05T00:00:00.000Z",
  });
  assert.equal(r.ok, false);
  assert.equal(r.holderMismatch, true);
  r = bindHolder(pend(mkCert()), {
    id: "s",
    name: "John Smith",
    birthDate: "1990-01-01T12:00:00.000Z",
  });
  assert.equal(r.ok, true);
  ok("bindHolder: DOB compared date-only, exact when both known");

  // First-set (rule 3): a nameless profile is never silently named.
  r = bindHolder(pend(mkCert()), { id: "s", name: "" });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.holderName, "JOHN SMITH");
  r = bindHolder(pend(mkCert()), { id: "s", name: "" }, { confirmedByHolder: true });
  assert.equal(r.ok, true);
  ok("bindHolder: first-set requires explicit 'this is me'; confirmation binds");

  // Rule 4: name-less results can only ever yield source:'registry'.
  r = bindHolder(pend(mkCert({ hasName: false, fullName: "" })), { id: "s", name: "John Smith" });
  assert.equal(r.ok, true);
  assert.equal(r.cert.verifiedSource, "registry");
  r = bindHolder(
    pend(mkCert({ hasName: false, fullName: "", verifiedSource: "registry" })),
    { id: "s", name: "John Smith" }
  );
  assert.equal(r.ok, true);
  assert.equal(r.cert.verifiedSource, "registry");
  ok("bindHolder: name-less result forced to source 'registry' (never government)");
}

// =========================================================================
// G. §2.4 client-IP derivation + token buckets
// =========================================================================
{
  assert.equal(
    clientIpFromHeaders(new Headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
    "9.9.9.9"
  );
  assert.equal(
    clientIpFromHeaders(new Headers({ "x-forwarded-for": "fakeA, fakeB, 5.5.5.5" })),
    "5.5.5.5"
  );
  assert.equal(
    clientIpFromHeaders(new Headers({ "x-forwarded-for": "another-spoof, 5.5.5.5" })),
    "5.5.5.5"
  );
  ok("client IP: X-Real-IP preferred; otherwise RIGHTMOST XFF (left spoof ignored)");

  assert.equal(clientIpFromHeaders(new Headers({ "x-registry-test-ip": "77.1.2.3" })), "77.1.2.3");
  ok("client IP: dev/test override header honored (mock mode only)");

  resetRegistryAbuseState();
  let allowed = 0;
  for (let i = 0; i < 8; i++) if (consumeRegistryBudget("ip-A")) allowed++;
  assert.equal(allowed, 8);
  assert.equal(consumeRegistryBudget("ip-A"), false);
  ok("bucket: per-IP capacity enforced (next request denied)");
  assert.equal(consumeRegistryBudget("ip-B"), true);
  ok("bucket: a DISTINCT client IP is not throttled");

  // Spoof journey (unit): a fresh fake leftmost XFF entry per request still
  // derives the SAME rightmost IP -> same bucket -> still denied.
  resetRegistryAbuseState();
  const ipOf = (fake) =>
    clientIpFromHeaders(new Headers({ "x-forwarded-for": `${fake}, 8.8.4.4` }));
  for (let i = 0; i < 8; i++) assert.equal(consumeRegistryBudget(ipOf("spoof" + i)), true);
  assert.equal(consumeRegistryBudget(ipOf("spoof-final")), false);
  ok("bucket: fresh fake XFF per request lands in the SAME bucket -> still 429");
}

// =========================================================================
// H. resolveInput dispatch: cache position, certainty, rate limit (§2.3/§2.4)
// =========================================================================
{
  resetRegistryAbuseState();
  resetRegistryJournal();

  let dkCalls = 0;
  __setTestAdapter("DK", async () => {
    dkCalls++;
    return { kind: "match-invalid", cert: mkCert({ registryCountry: "DK", isValid: false, code: "12345678" }) };
  });
  let eeCalls = 0;
  __setTestAdapter("EE", async (inputs) => {
    eeCalls++;
    return {
      kind: "match-valid",
      cert: mkCert({
        registryCountry: "EE",
        keyTrust: "capability-token",
        code: inputs.code,
        fullName: "JAAN TAMM",
      }),
    };
  });

  let out = await resolveInput("12345678");
  assert.equal(out.kind, "verified");
  assert.equal(out.cert.registryCountry, "EE");
  assert.equal(dkCalls, 1);
  ok("dispatch: uncertain DK match-invalid CONTINUES as no-match -> EE verified, no rose verdict");

  out = await resolveInput("12345678");
  assert.equal(out.kind, "verified");
  assert.equal(out.cert.registryCountry, "EE");
  assert.equal(dkCalls, 1);
  ok("cache: cached DK match-invalid repaste still falls through to EE (adapter not re-hit)");

  out = await resolveInput("12345678", { countryOverride: "DK" });
  assert.equal(out.kind, "pending-binding");
  assert.equal(out.cert.isValid, false);
  assert.equal(dkCalls, 1);
  ok("countryOverride round-trip: CERTAIN DK candidate -> pending-binding, certainty logic downstream of the cache hit");

  // Indeterminate outcomes are NEVER cached.
  let dkIndeterminate = 0;
  __setTestAdapter("DK", async () => {
    dkIndeterminate++;
    return { kind: "indeterminate", reason: "registry" };
  });
  out = await resolveInput("87654321");
  assert.equal(out.kind, "verified"); // falls through to EE
  out = await resolveInput("87654321");
  assert.equal(out.kind, "verified");
  assert.equal(dkIndeterminate, 2);
  ok("cache: indeterminate is never cached (adapter re-hit); never treated as invalid");

  // capabilityTokenOnly (legacy verifyCode mode) skips public-identifier candidates.
  const dkBefore = dkIndeterminate;
  out = await resolveInput("87654321", { capabilityTokenOnly: true });
  assert.equal(out.kind, "verified");
  assert.equal(dkIndeterminate, dkBefore);
  ok("legacy mode: public-identifier candidates skipped entirely");

  // §2.4 rate limit: over-limit -> friendly error, rateLimited flag, ZERO dispatch.
  resetRegistryAbuseState();
  while (consumeRegistryBudget("ip-Z")) {
    /* exhaust the per-IP bucket */
  }
  const eeBefore = eeCalls;
  const dkBefore2 = dkIndeterminate;
  out = await resolveInput("12345678", { clientIp: "ip-Z" });
  assert.equal(out.kind, "error");
  assert.equal(out.rateLimited, true);
  assert.match(out.error, /wait a minute/i);
  assert.equal(eeCalls, eeBefore);
  assert.equal(dkIndeterminate, dkBefore2);
  ok("429-no-partial: rate-limited resolve -> error outcome, ZERO adapter dispatch, nothing storable");

  // Fake domain: refused with the fetch journal EMPTY (§6.2 — never fetched).
  const jBefore = registryJournal().length;
  out = await resolveInput("https://rnaro.com/verify/ABC12345");
  assert.equal(out.kind, "error");
  assert.equal(out.unpinnedDomain, "rnaro.com");
  assert.equal(registryJournal().length, jBefore);
  ok("fake domain: error outcome + fetchWithGuard journal EMPTY");

  // Ambiguous fan-out cap -> picker outcome, no dispatch. Since the UK pattern
  // moved to the REAL MCA id shapes (2026-08-12) no NATURAL numeric overlap is
  // left in the table, so the cap is drilled with a synthetic auto entry
  // overlapping NO's 10-digit range (removed again right after).
  {
    const { COUNTRIES: COUNTRY_TABLE } = await import("@/lib/registry/countries");
    const synthetic = {
      country: "XX",
      countryName: "Synthetic",
      authority: "Synthetic fan-out drill",
      capability: "auto",
      keyKind: "public-identifier",
      recheckable: false,
      domains: ["xx.example.invalid"],
      portalUrl: "https://xx.example.invalid",
      inputs: [{ key: "certNumber", label: "Certificate number", source: "paste" }],
      codePattern: /^\d{10}$/,
    };
    COUNTRY_TABLE.push(synthetic);
    try {
      const eeCallsBefore = eeCalls;
      out = await resolveInput("1234567890");
      assert.equal(out.kind, "ambiguous");
      assert.equal(eeCalls, eeCallsBefore, "picker outcome dispatches NO adapter");
    } finally {
      COUNTRY_TABLE.splice(COUNTRY_TABLE.indexOf(synthetic), 1);
    }
  }
  ok("ambiguous bare code (fan-out cap) -> country-picker outcome, no adapter dispatch");

  // Unknown countryOverride fails closed.
  out = await resolveInput("12345678", { countryOverride: "XX" });
  assert.equal(out.kind, "error");
  ok("unknown countryOverride -> invalid-input error");

  __setTestAdapter("DK", undefined);
  __setTestAdapter("EE", undefined);
}

// =========================================================================
// I. Persona round-1 fixes (B1 / B2 / B4 / B6 + F8 evidence note)
// =========================================================================
const {
  prefillFromDoc,
  codeish,
  nameFieldSemantics,
  profileNameFill,
  structuredProfileName,
  rescuedDocDisplay,
} = await import("@/lib/registry/prefill");
const { COUNTRIES } = await import("@/lib/registry/countries");

// ---- B1: docBadge names government verification -------------------------
{
  const future = new Date(Date.now() + 200 * 86_400_000).toISOString();
  // #S3 (Batch-2): docBadge's VERIFIED pill now expresses the VALIDITY axis only
  // (BADGE_LABELS[s] -> "In date"); the trust wording ("Government-verified") is
  // carried exactly once by the VerificationLevelBadge rendered beside it. So a
  // verified doc reads "In date", with or without source:"government".
  let b = docBadge({ verified: true, validUntil: future, source: "government" });
  assert.equal(b.status, "valid");
  assert.equal(b.label, "In date");
  // Legacy call sites (no source passed) get the same validity-axis label.
  b = docBadge({ verified: true, validUntil: future });
  assert.equal(b.label, "In date");
  // Expiry honesty ALWAYS outranks the label.
  b = docBadge({ verified: true, validUntil: "2020-01-01T00:00:00.000Z", source: "government" });
  assert.equal(b.status, "expired");
  assert.equal(b.label, "Expired");
  ok("B1: verified pill shows the validity axis ('In date'); expiry precedence unchanged");
}

// ---- B2: unmatched bare code -> all-country picker rescue ----------------
{
  resetRegistryAbuseState();
  __setTestAdapter("EE", async () => ({ kind: "no-match" }));

  let out = await resolveInput("XKQZWVYJRP"); // matches NO specific pattern; EE fallback only
  assert.equal(out.kind, "ambiguous");
  assert.equal(out.unmatched, true);
  assert.equal(out.candidates.length, COUNTRIES.length);
  ok("B2: unmatched bare code + EE-fallback miss -> full-country picker, not an EE error");

  // Picker round-trip to an assisted country routes to the assist flow with
  // the pasted code as the certificate number.
  out = await resolveInput("XKQZWVYJRP", { countryOverride: "LV" });
  assert.equal(out.kind, "assist");
  assert.equal(out.country.country, "LV");
  assert.equal(out.prefill.certNumber, "XKQZWVYJRP");
  ok("B2: assisted pick from the picker -> assist flow with the pasted code");

  // Picker round-trip to a manual country opens the manual workflow.
  out = await resolveInput("XKQZWVYJRP", { countryOverride: "RO" });
  assert.equal(out.kind, "manual");
  assert.equal(out.country.country, "RO");
  ok("B2: manual pick from the picker -> manual-request flow");

  // The legacy capability-token wrapper keeps the EE not-found error — its
  // context-less callers (recognize, backfill, proof) cannot show a picker.
  out = await resolveInput("XKQZWVYJRP", { capabilityTokenOnly: true });
  assert.equal(out.kind, "error");
  assert.match(out.error, /No certificate/i);
  ok("B2: legacy capability-token mode keeps the EE not-found error");

  __setTestAdapter("EE", undefined);
}

// ---- B6: honest per-country miss messages --------------------------------
{
  resetRegistryAbuseState();
  __setTestAdapter("DK", async () => ({ kind: "no-match" }));
  let out = await resolveInput("70099998", { countryOverride: "DK" });
  assert.equal(out.kind, "error");
  assert.match(out.error, /Danish Maritime Authority/);
  assert.match(out.error, /found no record/i);
  assert.doesNotMatch(out.error, /No certificate, medical/);
  ok("B6: a DK-only miss names the Danish authority, never the EE category list");

  __setTestAdapter("EE", async () => ({ kind: "no-match" }));
  out = await resolveInput("ABCDEF123456", { countryOverride: "EE" });
  assert.equal(out.kind, "error");
  assert.match(out.error, /No certificate, medical/);
  ok("B6: an EE miss keeps the legacy EE wording");

  // Indeterminate-only outcome (UA-TCCS "contact us") -> could-not-confirm,
  // never "found no record", never "invalid".
  __setTestAdapter("UA", async () => ({ kind: "indeterminate", reason: "ambiguous-miss" }));
  out = await resolveInput("20939999", {
    countryOverride: "UA",
    extraInputs: { surname: "PETRENKO" },
  });
  assert.equal(out.kind, "error");
  assert.match(out.error, /could not confirm/i);
  assert.doesNotMatch(out.error, /invalid/i);
  ok("B6: indeterminate-only lookup -> honest could-not-confirm wording");

  __setTestAdapter("DK", undefined);
  __setTestAdapter("EE", undefined);
  __setTestAdapter("UA", undefined);
}

// ---- B4: prefill never invents a code from a portal URL ------------------
{
  const mkDoc = (over = {}) => ({
    id: "d1",
    seafarerId: "S1",
    title: "t",
    docType: "Document",
    source: "manual",
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewStatus: "pending",
    ...over,
  });
  const lv = countryEntry("LV");
  // Stored PORTAL URL (matched only by hostname; path = route words) -> EMPTY.
  let p = prefillFromDoc(
    lv,
    mkDoc({
      certNumber:
        "https://www.lja.lv/en/seafarers/verification-of-authenticity/verification-of-certificates/",
    })
  );
  assert.equal(p.certNumber ?? "", "", "portal URL must never become a fake cert number");
  // A URL that actually CARRIES a code segment still prefils it.
  p = prefillFromDoc(countryEntry("GR"), mkDoc({ certNumber: "https://stcw.hcg.gr/verify-stcw/GR55501" }));
  assert.equal(p.cert_no, "GR55501");
  // Plain codes pass through normalized.
  p = prefillFromDoc(lv, mkDoc({ certNumber: "lv-2024-0001" }));
  assert.equal(p.certNumber, "LV20240001");
  // codeish edges: hostname-only URL and slug-path URLs -> empty.
  assert.equal(codeish("https://verify.dma.dk/"), "");
  assert.equal(codeish("www.lja.lv/verify"), "");
  ok("B4: URL-slug guard — 'VERIFICATIONOFCERTIFICATES' can never be a prefill again");
}

// ---- F8: manual confirmation requires + stores the evidence note ---------
{
  const d = { id: "F8DOC", seafarerId: "S1", title: "t" };
  assert.equal(requestManualVerification(d, "Agent A"), true);
  assert.equal(
    confirmManualVerification(d, "Agent A", "authority reply 12 Jun, ref #77"),
    true
  );
  assert.equal(d.manualVerification.status, "confirmed");
  assert.equal(d.manualVerification.evidenceNote, "authority reply 12 Jun, ref #77");
  // Idempotency preserved: a re-confirm never re-stamps who/when/evidence.
  assert.equal(confirmManualVerification(d, "Agent B", "a different note"), false);
  assert.equal(d.manualVerification.evidenceNote, "authority reply 12 Jun, ref #77");
  assert.equal(d.manualVerification.confirmedBy, "Agent A");
  ok("F8: evidence note stored with the confirmation; confirm idempotency intact");
}

// =========================================================================
// J. vr2 item 1 — DK definitive miss + EE-fallback miss names the Danish
//    authority (the EE fallback never steals the attribution)
// =========================================================================
{
  resetRegistryAbuseState();
  __setTestAdapter("DK", async () => ({ kind: "no-match" }));
  __setTestAdapter("EE", async () => ({ kind: "no-match" }));

  // Bare DK-pattern code (8 digits) -> candidates [DK, EE-fallback]; both miss.
  let out = await resolveInput("70099997");
  assert.equal(out.kind, "error");
  assert.match(out.error, /Danish Maritime Authority/);
  assert.match(out.error, /found no record/i);
  assert.doesNotMatch(out.error, /No certificate, medical/);
  ok("J: bare DK code, DK no-match + EE-fallback miss -> Danish-authority message");

  // An EE SPECIFIC candidate (16-char token pattern) that misses keeps the
  // legacy EE category-list wording.
  out = await resolveInput("ABCDEF1234567890");
  assert.equal(out.kind, "error");
  assert.match(out.error, /No certificate, medical/);
  ok("J: EE specific-pattern miss keeps the legacy EE wording");

  // Legacy capability-token mode never dispatches DK, so its dead end stays
  // the EE not-found error (context-less callers show no picker/attribution).
  out = await resolveInput("70099997", { capabilityTokenOnly: true });
  assert.equal(out.kind, "error");
  assert.match(out.error, /No certificate/i);
  assert.doesNotMatch(out.error, /Danish Maritime Authority/);
  ok("J: capability-token mode keeps the EE not-found error for a DK-shaped code");

  __setTestAdapter("DK", undefined);
  __setTestAdapter("EE", undefined);
}

// =========================================================================
// K. vr2 item 2 — "Use profile name" field semantics (never auto-split)
// =========================================================================
{
  const hr = countryEntry("HR");
  const gr = countryEntry("GR");
  const lt = countryEntry("LT");
  const lv = countryEntry("LV");
  const es = countryEntry("ES");
  const ua = countryEntry("UA");

  // Field classification.
  assert.equal(nameFieldSemantics(hr, "firstName"), "first");
  assert.equal(nameFieldSemantics(hr, "lastName"), "last");
  assert.equal(nameFieldSemantics(gr, "first_name"), "first");
  assert.equal(nameFieldSemantics(gr, "last_name"), "last");
  assert.equal(nameFieldSemantics(gr, "father_name"), "other"); // different person
  assert.equal(nameFieldSemantics(lt, "name"), "first"); // sibling surname field
  assert.equal(nameFieldSemantics(lt, "surname"), "last");
  assert.equal(nameFieldSemantics(lv, "name"), "full"); // lone whole-name field
  assert.equal(nameFieldSemantics(es, "name"), "first"); // sibling "surnames"
  assert.equal(nameFieldSemantics(es, "surnames"), "last");
  assert.equal(nameFieldSemantics(ua, "surname"), "last");
  assert.equal(nameFieldSemantics(ua, "certificateNumber"), "other");
  ok("K: name-field semantics classified per key + sibling fields");

  // Structured parts -> per-semantics fill; full-only -> NEVER split.
  const structured = { fullName: "JOHN SMITH", firstName: "JOHN", lastName: "SMITH" };
  assert.equal(profileNameFill("first", structured), "JOHN");
  assert.equal(profileNameFill("last", structured), "SMITH");
  assert.equal(profileNameFill("full", structured), "JOHN SMITH");
  const fullOnly = { fullName: "JOHN SMITH", firstName: "", lastName: "" };
  assert.equal(profileNameFill("first", fullOnly), null);
  assert.equal(profileNameFill("last", fullOnly), null);
  assert.equal(profileNameFill("full", fullOnly), "JOHN SMITH");
  assert.equal(profileNameFill("other", structured), null);
  ok("K: surname gets LAST, first-name gets FIRST; full-only never auto-splits");

  // structuredProfileName: split ONLY from a matching government snapshot.
  const sf = { id: "s", name: "John Smith", verifiedName: "JOHN SMITH" };
  const govDoc = {
    id: "g",
    seafarerId: "s",
    source: "government",
    verifiedFirstName: "JOHN",
    verifiedLastName: "SMITH",
    verifiedFullName: "JOHN SMITH",
  };
  let parts = structuredProfileName(sf, [govDoc]);
  assert.deepEqual(parts, { fullName: "JOHN SMITH", firstName: "JOHN", lastName: "SMITH" });
  // A NON-matching snapshot (different holder) must not donate its split.
  parts = structuredProfileName(sf, [{ ...govDoc, verifiedFullName: "SOMEONE ELSE" }]);
  assert.deepEqual(parts, { fullName: "JOHN SMITH", firstName: "", lastName: "" });
  // A non-government doc never donates structure.
  parts = structuredProfileName(sf, [{ ...govDoc, source: "manual" }]);
  assert.equal(parts.firstName, "");
  ok("K: structured split comes ONLY from a matching government holder snapshot");

  // prefillFromDoc end-to-end: LT name/surname pair with full-name-only profile
  // stays EMPTY (typed), LV whole-name field still prefills; with a structured
  // snapshot the LT pair fills first/last correctly.
  const baseDoc = {
    id: "d",
    seafarerId: "s",
    title: "t",
    docType: "Document",
    source: "manual",
    certNumber: "LT-2024-777",
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewStatus: "pending",
  };
  const sfFullOnly = { id: "s", name: "John Smith" };
  let p = prefillFromDoc(lt, baseDoc, sfFullOnly, [baseDoc]);
  assert.equal(p.name ?? "", "", "LT first-name field must not receive the full name");
  assert.equal(p.surname ?? "", "", "LT surname field must not receive the full name");
  p = prefillFromDoc(lv, baseDoc, sfFullOnly, [baseDoc]);
  assert.equal(p.name, "John Smith", "LV whole-name field keeps the full-name prefill");
  p = prefillFromDoc(lt, baseDoc, sf, [baseDoc, govDoc]);
  assert.equal(p.name, "JOHN");
  assert.equal(p.surname, "SMITH");
  ok("K: prefillFromDoc respects semantics — empty+typed without structure, split with it");
}

// =========================================================================
// L. vr2 item 5 — rescued-doc labeling (country + capability state)
// =========================================================================
{
  const mk = (over = {}) => ({
    id: "r1",
    seafarerId: "S1",
    title: "Unverified document",
    docType: "Document",
    source: "manual",
    certNumber: "LV-10245-2023",
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewStatus: "pending",
    registryCountry: "LV",
    ...over,
  });

  let r = rescuedDocDisplay(mk());
  assert.equal(r.title, "Latvia certificate");
  assert.equal(r.countryName, "Latvia");
  assert.equal(r.code, "LV102452023");
  assert.equal(r.state, "Check on registry pending");
  ok("L: LV rescued doc -> 'Latvia certificate · LV102452023 · Check on registry pending'");

  r = rescuedDocDisplay(
    mk({
      registryCountry: "RO",
      certNumber: "RO771230",
      manualVerification: {
        status: "requested",
        requestedAt: "2026-01-01T00:00:00.000Z",
        requestedBy: "x",
      },
    })
  );
  assert.equal(r.title, "Romania certificate");
  assert.equal(r.state, "Verification requested");
  ok("L: RO rescued doc -> 'Romania certificate · Verification requested'");

  // Checked/confirmed states reuse the badge vocabulary.
  r = rescuedDocDisplay(mk({ reviewerChecked: true, checkedVia: "registry-portal" }));
  assert.equal(r.state, "Checked against registry");
  r = rescuedDocDisplay(
    mk({
      registryCountry: "RO",
      manualVerification: {
        status: "confirmed",
        requestedAt: "2026-01-01T00:00:00.000Z",
        requestedBy: "x",
        confirmedAt: "2026-02-01T00:00:00.000Z",
        confirmedBy: "y",
      },
    })
  );
  assert.equal(r.state, "Confirmed by the authority");
  ok("L: checked/confirmed states mirror the badge vocabulary");

  // A real (typed) title is never replaced; the meta still applies.
  r = rescuedDocDisplay(mk({ title: "Latvian CoC" }));
  assert.equal(r.title, null);
  assert.equal(r.state, "Check on registry pending");
  ok("L: a typed title is kept — only generic titles fall back to the country");

  // Never applies to government / registry-confirmed / photo docs, or docs
  // without a registryCountry.
  assert.equal(rescuedDocDisplay(mk({ source: "government" })), null);
  assert.equal(rescuedDocDisplay(mk({ source: "registry" })), null);
  assert.equal(rescuedDocDisplay(mk({ source: "photo" })), null);
  assert.equal(rescuedDocDisplay(mk({ registryCountry: null })), null);
  ok("L: government / registry / photo / country-less docs are untouched");
}

// ---- LV in-app iframe: the embeddable flag (countries.ts derivation) -----
// The UI derives the "Verify here in the box" option purely from
// countries.ts `embeddable:true` — confirmed by a live header probe ONLY for
// Latvia. Lithuania frames but its session cookie breaks in a third-party
// context; every other assisted portal is XFO-blocked.
{
  const lv = countryEntry("LV");
  assert.equal(lv?.embeddable, true);
  // The iframe src base is the pinned lja.lv deep link — never user-supplied.
  assert.equal(new URL(lv.portalUrl).hostname, "www.lja.lv");
  assert.ok(lv.domains.includes("www.lja.lv"));
  ok("embeddable: LV is embeddable and its portalUrl is the pinned www.lja.lv page");

  assert.ok(!countryEntry("LT")?.embeddable, "LT must NOT be embeddable (PHPSESSID breaks cross-site)");
  assert.ok(!countryEntry("GR")?.embeddable, "GR must NOT be embeddable (XFO-blocked)");
  for (const c of COUNTRIES) {
    if (c.country !== "LV") assert.ok(!c.embeddable, `${c.country} must NOT be embeddable`);
  }
  ok("embeddable: NO country other than LV carries the flag (LT/GR keep popup+prefill)");

  // The /verify "About our registry connections" LV card derives from
  // EMBEDDABLE_REGISTRY_COUNTRIES — exactly [LV], and NEVER part of the
  // home-hero automatic list (that list claims machine verification).
  const {
    EMBEDDABLE_REGISTRY_COUNTRIES,
    AUTO_REGISTRY_COUNTRIES,
    HERO_AUTO_REGISTRY_COUNTRIES,
    isoRegion,
    countryDisplayName,
  } = await import("@/lib/registry/display");
  assert.deepEqual(
    EMBEDDABLE_REGISTRY_COUNTRIES.map((c) => c.country),
    ["LV"]
  );
  assert.ok(
    !AUTO_REGISTRY_COUNTRIES.some((c) => c.country === "LV"),
    "LV must NOT appear in the automatic (home-hero) list"
  );
  ok("embeddable card list: EMBEDDABLE_REGISTRY_COUNTRIES is exactly [LV] and stays out of the auto list");

  // ---- Hero dedupe by isoRegion (review fix 2026-08-13) -------------------
  // The FULL auto list (the /verify cards) keeps BOTH Ukrainian services;
  // the HERO badge list names Ukraine ONCE — never "Ukraine and Ukraine
  // (state registry)".
  assert.equal(isoRegion("UA-MARAD"), "UA", "service suffix strips to the bare region");
  assert.equal(isoRegion("UK"), "GB", "the UK->GB CLDR mapping survives");
  assert.deepEqual(
    AUTO_REGISTRY_COUNTRIES.filter((c) => isoRegion(c.country) === "UA").map((c) => c.country),
    ["UA", "UA-MARAD"],
    "/verify keeps BOTH Ukrainian service cards"
  );
  assert.deepEqual(
    HERO_AUTO_REGISTRY_COUNTRIES.filter((c) => isoRegion(c.country) === "UA").map((c) => c.country),
    ["UA"],
    "the hero list carries exactly ONE Ukraine entry"
  );
  // Honesty audit 2026-08-13: the hero claims VERIFICATION, so presence-only
  // (auto-presence, BG) entries stay OUT of the hero — but keep their honest
  // /verify card.
  assert.ok(
    AUTO_REGISTRY_COUNTRIES.some((c) => c.country === "BG"),
    "/verify keeps the BG (auto-presence) card"
  );
  assert.ok(
    !HERO_AUTO_REGISTRY_COUNTRIES.some((c) => c.capability !== "auto"),
    "the hero list carries full-auto entries only — no auto-presence (BG)"
  );
  // The dedupe removes ONLY same-region duplicates — every other full-auto
  // entry survives into the hero list.
  assert.equal(
    HERO_AUTO_REGISTRY_COUNTRIES.length,
    new Set(
      AUTO_REGISTRY_COUNTRIES.filter((c) => c.capability === "auto").map((c) =>
        isoRegion(c.country)
      )
    ).size
  );
  // Display names: the hero's surviving UA entry localizes to plain "Ukraine";
  // the /verify MARAD card keeps its distinct table name.
  assert.equal(countryDisplayName("UA", "en", "Ukraine (training center)"), "Ukraine");
  assert.equal(
    countryDisplayName("UA-MARAD", "en", "Ukraine (state registry)"),
    "Ukraine (state registry)",
    "suffixed service code keeps its distinct card name on /verify"
  );
  ok("hero dedupe: one Ukraine in the hero badge, both service cards kept on /verify");

  // ---- AZ in BOTH public listings (az-adapter plan B9, operator req) ------
  // The homepage hero sentence and the /verify country cards both derive
  // from these lists over countries.ts — the AZ auto entry must appear in
  // each, and the Intl.ListFormat join must name Azerbaijan grammatically.
  const { joinNames } = await import("@/lib/registry/display");
  assert.ok(
    AUTO_REGISTRY_COUNTRIES.some((c) => c.country === "AZ"),
    "/verify cards include the AZ registry card"
  );
  assert.ok(
    HERO_AUTO_REGISTRY_COUNTRIES.some((c) => c.country === "AZ"),
    "the hero badge list includes Azerbaijan (capability auto)"
  );
  const heroNames = HERO_AUTO_REGISTRY_COUNTRIES.map((c) =>
    countryDisplayName(c.country, "en", c.countryName)
  );
  const heroSentencePart = joinNames(heroNames, "en");
  assert.ok(heroNames.includes("Azerbaijan"), "display name resolves to plain 'Azerbaijan'");
  assert.match(
    heroSentencePart,
    /(and|,) Azerbaijan|Azerbaijan(,| and)/,
    `Azerbaijan joined grammatically (got: ${heroSentencePart})`
  );
  ok(`hero + /verify listings: AZ present; hero reads "…${heroSentencePart.slice(-40)}"`);

  // ---- Trust bar derivation (PSV frontpage plan §5) -----------------------
  // The homepage trust bar names AUTHORITIES, so it must carry flag states
  // only: TCCS (a training centre) is excluded and Ukraine is represented by
  // UA-MARAD instead; BG (auto-presence) stays out; every chip has a curated
  // short display name.
  const { TRUST_BAR_AUTHORITIES } = await import("@/lib/registry/display");
  assert.equal(TRUST_BAR_AUTHORITIES.length, 8, "trust bar carries exactly the 8 full-auto flag-state authorities");
  const trustCodes = TRUST_BAR_AUTHORITIES.map((c) => c.country);
  assert.ok(trustCodes.includes("UA-MARAD"), "Ukraine is represented by the MARAD state registry");
  assert.ok(!trustCodes.includes("UA"), "the TCCS training centre is NOT presented as a government authority");
  assert.ok(!trustCodes.includes("BG"), "BG (auto-presence) stays out of the trust bar");
  for (const c of TRUST_BAR_AUTHORITIES) {
    assert.equal(c.capability, "auto", `${c.country} in the trust bar must be full-auto`);
    assert.ok(
      typeof c.authorityShort === "string" && c.authorityShort.trim().length > 0,
      `${c.country} trust-bar entry must carry authorityShort`
    );
  }
  // One entry per ISO region (chips never name the same country twice).
  assert.equal(new Set(trustCodes.map((cc) => isoRegion(cc))).size, TRUST_BAR_AUTHORITIES.length);
  ok("trust bar: 8 flag-state chips, UA-MARAD not TCCS, no BG, all auto with authorityShort");

  // ---- Homepage polish wave (2026-08-31): displayRegion + AZ chip text ----
  // displayRegion is the USER-FACING region code (the audience says "UK");
  // isoRegion keeps the internal UK->GB CLDR mapping for Intl.DisplayNames.
  const { displayRegion } = await import("@/lib/registry/display");
  assert.equal(displayRegion("UK"), "UK", "user-facing region keeps the table's UK");
  assert.equal(displayRegion("UA-MARAD"), "UA", "service suffix strips for display too");
  assert.equal(isoRegion("UK"), "GB", "isoRegion still maps UK->GB for Intl");
  const azChip = TRUST_BAR_AUTHORITIES.find((c) => c.country === "AZ");
  assert.equal(
    azChip?.authorityShort,
    "Maritime and Port Agency (DDLA)",
    "AZ trust-bar chip spells out the authority (not the bare DDLA acronym)"
  );
  ok("polish wave: displayRegion UK/UA-MARAD, isoRegion UK->GB intact, AZ chip spelled out");
}

// ---- Cleanup + summary --------------------------------------------------

process.chdir(APP_CWD);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best-effort temp cleanup */
}

console.log(`\nregistry-units: ${pass} assertions passed`);
