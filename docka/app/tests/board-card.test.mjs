// B2 board-card view-model — the full spec-matrix unit suite (plan Phase 1.4 +
// the R1-6 matrix additions). Pure model assertions: every card state the spec
// enumerates must derive the right cells + strips from boardCardModel alone.
//
// Clock stance (R1-3): per-doc expiry runs on the REAL clock inside
// docStatusForDoc, so all expiry fixtures use dates relative to now with >= 1 day
// of margin from the 60-day expiring boundary (+120 valid, +30 expiring, -30
// expired). `now` is passed only where it actually reaches (requests, employment).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/board-card.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { boardCardModel, fmtDate, worstStatusForDocs, worstDoc, freshestVerifiedAt, SEVERITY } =
  await import("@/lib/board-card");
const { t } = await import("@/lib/i18n");

const tr = (k, v) => t("en", k, v);
const DAY = 86_400_000;
/** yyyy-mm-dd `days` from real now (see clock stance above). */
const day = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let seq = 0;
const doc = (over = {}) => ({
  id: `d${++seq}`,
  seafarerId: "s1",
  title: "Some Cert",
  docType: "misc",
  docCategory: null,
  estonianCode: null,
  isValid: null,
  validUntil: day(120),
  fileName: null,
  createdAt: "2026-01-01T00:00:00Z",
  source: "photo",
  ...over,
});

// The five required slots for a Chief Officer (universal floor + Endorsement).
const REQUIRED_FIVE = [
  "Basic Safety Training",
  "Medical",
  "Endorsement",
  "Seaman book",
  "Passport",
];
const coveringDocs = (over = {}) =>
  REQUIRED_FIVE.map((rt) => doc({ title: rt, requiredType: rt, ...over }));

const man = (over = {}) => ({
  id: "s1",
  name: "Matrix Man",
  rank: "Chief Officer",
  state: "review",
  createdAt: "2026-01-01T00:00:00Z",
  documents: [],
  ...over,
});

const request = (over = {}) => ({
  id: `r${++seq}`,
  seafarerId: "s1",
  agentId: "dev",
  requestedBy: "dev",
  requiredType: null,
  label: "Requested item",
  dueDate: null,
  status: "pending",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const model = (s, requiredConfig = null) => boardCardModel({ s, requiredConfig }, { tr });
const stripBy = (m, sev) => m.strips.filter((x) => x.severity === sev);

// ---- spec matrix -----------------------------------------------------------

test("in-date clean + self-uploaded floor: quiet card, floor word verbatim", () => {
  const m = model(man({ documents: coveringDocs() }));
  assert.deepEqual(m.strips, []);
  assert.equal(m.floor, 0);
  assert.equal(m.floorWord, "Self-uploaded"); // R1-1: LEVEL_META.short verbatim
  assert.deepEqual(m.cells.docs, { count: 5, covered: 5, total: 5 });
  assert.equal(m.cells.gov.gov, 0);
  assert.equal(m.cells.req.open, 0);
  assert.equal(m.cells.employment.kind, "benched");
  assert.deepEqual(m.actionState, { atEnd: false, nextLabel: "Accepted", removeDisabled: false });
});

test("in-date clean + gov floor: emerald-word floor, gov count, freshness stamp", () => {
  const docs = coveringDocs({ source: "government" });
  docs[0].verifiedResolvedAt = "2026-08-01T10:00:00Z";
  const m = model(man({ documents: docs }));
  assert.deepEqual(m.strips, []);
  assert.equal(m.floor, 3);
  assert.equal(m.floorWord, "Gov-verified");
  assert.equal(m.cells.gov.gov, 5);
  assert.equal(m.floorVerifiedAt, "2026-08-01T10:00:00Z");
});

test("package ready: sky strip with received/active fraction", () => {
  const m = model(
    man({
      documents: coveringDocs(),
      docRequests: [request({ status: "received" }), request({ status: "received" })],
    })
  );
  assert.equal(m.strips.length, 1);
  assert.deepEqual(m.strips[0], {
    severity: "sky",
    text: "Package ready · 2/2",
    testid: "card-strip-sky",
  });
});

test("expiring: one amber strip naming the document + date", () => {
  const docs = coveringDocs();
  docs[1].validUntil = day(30); // Medical expiring
  const m = model(man({ documents: docs }));
  assert.equal(m.strips.length, 1);
  assert.equal(m.strips[0].severity, "amber");
  assert.equal(m.strips[0].testid, "card-strip-amber");
  assert.equal(m.strips[0].text, `1 expiring · Medical ${fmtDate(day(30))}`);
});

test("missing: amber names capped at 3 then +N more (overflow at 4+)", () => {
  const m = model(
    man({ documents: [doc({ title: "Passport", requiredType: "Passport" })] })
  );
  assert.equal(m.strips.length, 1);
  assert.equal(m.strips[0].severity, "amber");
  assert.equal(
    m.strips[0].text,
    "4 missing · Basic Safety Training, Medical, Endorsement +1 more"
  );
});

test("unknown-expiry: amber 'need expiry confirmation' (StatusBadge unknown absorbed)", () => {
  const docs = [...coveringDocs(), doc({ title: "Old Cert", validUntil: null })];
  const m = model(man({ documents: docs }));
  assert.equal(m.strips.length, 1);
  assert.equal(m.strips[0].severity, "amber");
  assert.equal(m.strips[0].text, "1 need expiry confirmation");
});

test("expired: one red strip naming the document + date", () => {
  const docs = coveringDocs();
  docs[2].validUntil = day(-30); // Endorsement expired
  const m = model(man({ documents: docs }));
  assert.equal(m.strips.length, 1);
  assert.equal(m.strips[0].severity, "red");
  assert.equal(m.strips[0].testid, "card-strip-red");
  assert.equal(m.strips[0].text, `1 expired · Endorsement ${fmtDate(day(-30))}`);
});

test("worst case: exactly ONE red + ONE amber, both aggregating with +N more", () => {
  const docs = [
    doc({ title: "Passport", requiredType: "Passport", validUntil: day(-30) }), // expired
    doc({ title: "Medical", requiredType: "Medical", validUntil: day(30) }), // expiring
  ];
  const m = model(
    man({
      documents: docs,
      docRequests: [request({ dueDate: day(-5) })], // pending + overdue
    })
  );
  const reds = stripBy(m, "red");
  const ambers = stripBy(m, "amber");
  assert.equal(reds.length, 1, "exactly one red strip");
  assert.equal(ambers.length, 1, "exactly one amber strip");
  // Red: 1 expired doc heads the bucket; the overdue request folds into +1 more.
  assert.equal(reds[0].text, `1 expired · Passport ${fmtDate(day(-30))} · +1 more`);
  // Amber: expiring heads; 3 missing slots fold into +3 more.
  assert.equal(ambers[0].text, `1 expiring · Medical ${fmtDate(day(30))} · +3 more`);
});

test("at-sea locked: red employment gap 2/3 coexists with the gray facts strip", () => {
  const docs = [
    ...coveringDocs(),
    doc({ title: "Wage Account", requiredType: "Wage Account" }),
    doc({ title: "Allotment", requiredType: "Allotment" }),
  ];
  const m = model(man({ documents: docs, assigned: true }));
  assert.deepEqual(m.cells.employment, {
    kind: "gap",
    count: 2,
    total: 3,
    seaBad: true,
    reconfirm: false,
  });
  assert.equal(m.strips.length, 2);
  assert.equal(m.strips[0].severity, "red"); // SEA missing => red (R1-8 split)
  assert.equal(m.strips[0].text, "Employment docs incomplete");
  assert.deepEqual(m.strips[1], {
    severity: "neutral",
    text: "At sea · profile locked",
    testid: "card-strip-neutral",
  });
  assert.equal(m.actionState.removeDisabled, true);
});

test("benched: employment not applicable — never a gap, never a strip", () => {
  const m = model(man({ documents: coveringDocs() }));
  assert.deepEqual(m.cells.employment, { kind: "benched" });
  assert.deepEqual(m.strips, []);
});

test("SEA unknownExpiry: gap 2/3 + reconfirm, amber (not red), no false all-clear", () => {
  const docs = [
    ...coveringDocs(),
    doc({ title: "SEA", requiredType: "SEA", seaEndDate: null }),
    doc({ title: "Wage Account", requiredType: "Wage Account" }),
    doc({ title: "Allotment", requiredType: "Allotment" }),
  ];
  const m = model(man({ documents: docs, assigned: true }));
  assert.deepEqual(m.cells.employment, {
    kind: "gap",
    count: 2,
    total: 3,
    seaBad: false,
    reconfirm: true,
  });
  assert.equal(stripBy(m, "red").length, 0);
  const ambers = stripBy(m, "amber");
  assert.equal(ambers.length, 1);
  assert.equal(ambers[0].text, "Employment docs incomplete");
});

test("verify-pending: pending count present when >0, zero when none", () => {
  const docs = [
    ...coveringDocs(),
    doc({ title: "P1", manualVerification: { status: "requested" } }),
    doc({ title: "P2", holderMismatch: true }),
  ];
  const m = model(man({ documents: docs }));
  assert.equal(m.cells.gov.pending, 2);
  const clean = model(man({ documents: coveringDocs() }));
  assert.equal(clean.cells.gov.pending, 0);
});

test("gov-only shield: registry-confirmed + checked stay OUT of the gov count", () => {
  const docs = [
    doc({ title: "Gov", source: "government" }),
    doc({ title: "Reg1", source: "registry" }),
    doc({ title: "Reg2", source: "registry" }),
    doc({ title: "Chk", reviewerChecked: true, checkedVia: "registry-portal" }),
  ];
  const m = model(man({ documents: docs }));
  assert.equal(m.cells.gov.gov, 1);
  assert.equal(m.cells.gov.registry, 2);
  assert.equal(m.cells.gov.checked, 1);
});

test("perpetual (noExpiry) docs stay clean regardless of any stray date", () => {
  const docs = coveringDocs({ noExpiry: true, validUntil: day(-100) });
  const m = model(man({ documents: docs }));
  assert.deepEqual(m.strips, []);
});

// ---- R1-6 matrix additions -------------------------------------------------

test("zero-docs seafarer: 0-docs cell + missing strip fires (never silently all clear)", () => {
  const m = model(man({ documents: [] }));
  assert.deepEqual(m.cells.docs, { count: 0, covered: 0, total: 5 });
  assert.equal(m.strips.length, 1);
  assert.equal(m.strips[0].severity, "amber");
  assert.equal(
    m.strips[0].text,
    "5 missing · Basic Safety Training, Medical, Endorsement +2 more"
  );
});

test("required-config total=0: 0/0 tooltip data, quiet card is correct", () => {
  const emptyConfig = {
    agentId: "dev",
    baselineVersion: "test-empty",
    universalRequired: [],
    perRankRequired: {},
    perVesselTypeRequired: {},
    perFlagRequired: {},
    updatedAt: "2026-01-01T00:00:00Z",
    updatedBy: null,
  };
  const m = model(man({ rank: "", documents: [] }), emptyConfig);
  assert.deepEqual(m.cells.docs, { count: 0, covered: 0, total: 0 });
  assert.deepEqual(m.strips, []);
});

test("gov=0 with pending>0: the +N pend suffix has data to render", () => {
  const docs = [
    ...coveringDocs(),
    doc({ title: "P1", manualVerification: { status: "requested" } }),
    doc({ title: "P2", manualVerification: { status: "requested" } }),
  ];
  const m = model(man({ documents: docs }));
  assert.equal(m.cells.gov.gov, 0);
  assert.equal(m.cells.gov.pending, 2);
});

test("all-waived packageReady: bare 'Package ready', never 0/N (R1-4)", () => {
  const m = model(
    man({
      documents: coveringDocs(),
      docRequests: [
        request({ status: "waived" }),
        request({ status: "waived" }),
        request({ status: "waived" }),
      ],
    })
  );
  const skies = stripBy(m, "sky");
  assert.equal(skies.length, 1);
  assert.equal(skies[0].text, "Package ready");
});

test("mixed received+waived: fraction over ACTIVE = total - closed (R1-4)", () => {
  const m = model(
    man({
      documents: coveringDocs(),
      docRequests: [
        request({ status: "received" }),
        request({ status: "received" }),
        request({ status: "waived" }),
      ],
    })
  );
  const skies = stripBy(m, "sky");
  assert.equal(skies.length, 1);
  assert.equal(skies[0].text, "Package ready · 2/2");
});

test("4-strip worst case: red + amber + sky + neutral, in that order", () => {
  const docs = coveringDocs();
  docs[1].validUntil = day(-30); // Medical expired -> red (slot still covered)
  const extra = doc({ title: "Extra Cert", validUntil: day(30) }); // expiring -> amber
  const employmentDocs = [
    doc({ title: "SEA", requiredType: "SEA", seaEndDate: day(120) }),
    doc({ title: "Wage Account", requiredType: "Wage Account" }),
    doc({ title: "Allotment", requiredType: "Allotment" }),
  ];
  const m = model(
    man({
      documents: [...docs, extra, ...employmentDocs],
      docRequests: [request({ status: "received" })],
      assigned: true,
    })
  );
  assert.deepEqual(
    m.strips.map((x) => x.severity),
    ["red", "amber", "sky", "neutral"]
  );
  assert.equal(m.cells.employment.kind, "complete");
});

// ---- moved-helper sanity (single definition, imported back by AgentBoard) ----

test("moved helpers: worstStatusForDocs / worstDoc / freshestVerifiedAt behave", () => {
  const expired = doc({ title: "A", validUntil: day(-30) });
  const expiring = doc({ title: "B", validUntil: day(30) });
  const perpetual = doc({ title: "C", noExpiry: true, validUntil: null });
  assert.equal(worstStatusForDocs([expiring, expired]), "expired");
  assert.equal(worstStatusForDocs([perpetual]), "none");
  assert.equal(worstDoc([expiring, expired]).doc.title, "A");
  assert.equal(worstDoc([perpetual]), null);
  assert.equal(SEVERITY.expired > SEVERITY.expiring, true);
  assert.equal(
    freshestVerifiedAt([
      doc({ checkedAt: "2026-01-01T00:00:00Z" }),
      doc({ verifiedResolvedAt: "2026-05-01T00:00:00Z" }),
    ]),
    "2026-05-01T00:00:00Z"
  );
});

test("finished state: atEnd, no next label", () => {
  const m = model(man({ state: "finished", documents: coveringDocs() }));
  assert.deepEqual(m.actionState, { atEnd: true, nextLabel: null, removeDisabled: false });
});

// ---- Claim-status chip matrix (unclaimed roster placeholders) --------------
const DAY_MS = 86_400_000;

test("claim chip: claimed => Claimed label + testid", () => {
  const m = model(man({ ownerEmail: "seaman@x.com", documents: coveringDocs() }));
  assert.equal(m.claim.kind, "claimed");
  assert.equal(m.claim.label, "Claimed");
  assert.equal(m.claim.testid, "claimed");
  assert.ok(!("linkStale" in m.claim), "the model exposes no linkStale boolean");
});

test("claim chip: placeholder not opened => Invite pending", () => {
  const m = model(man({ invited: true, documents: [] }));
  assert.equal(m.claim.kind, "placeholder");
  assert.equal(m.claim.label, "Invite pending");
  assert.equal(m.claim.testid, "pending");
});

test("claim chip: placeholder opened => Link opened, tip has date + 24 hours", () => {
  const openedAt = Date.parse("2026-08-15T10:00:00.000Z");
  const m = boardCardModel(
    { s: man({ invited: true, shareTokenLastUsedAt: openedAt, documents: [] }), requiredConfig: null },
    { tr, now: new Date(openedAt + DAY_MS / 2) }
  );
  assert.equal(m.claim.testid, "opened");
  assert.equal(m.claim.label, "Link opened");
  assert.ok(m.claim.tip.includes("24 hours"), "opened tip carries the 24h note");
  assert.ok(m.claim.tip.includes("15 Aug 2026"), "opened tip carries the UTC-formatted date");
});

test("claim chip: legacy-unowned => no chip", () => {
  const m = model(man({ documents: coveringDocs() }));
  assert.equal(m.claim.kind, "legacy-unowned");
  assert.equal(m.claim.label, null);
  assert.equal(m.claim.testid, null);
});

test("claim chip: sample => no chip (existing Sample chip stands)", () => {
  const m = model(man({ isSample: true, documents: [] }));
  assert.equal(m.claim.kind, "sample");
  assert.equal(m.claim.label, null);
});
