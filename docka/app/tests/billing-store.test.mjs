// Unit tests for lib/billing-store.ts (STRIPE-BILLING-PLAN.md P1) — the per-agent
// billing persistence layer: settings singleton, profile create-if-absent (R2-8
// write-once under parallel first-sessions), business-info round-trip, the admin
// rate/exempt knobs incl. the R1-6 exempt->non-exempt clock reset, the usage ledger
// with its frozen-after-push rule and the R1-1 claim protocol, and the R2-2 webhook
// ledger (claim / finish / dedupe-on-processed / crashed-claim reprocess).
//
// Runs the REAL modules (Node strips the types; tests/_register-alias.mjs resolves the
// `@/` alias). NO Stripe call is ever made here — this file never imports lib/stripe.
//
// FIXTURE STRATEGY: lib/db.ts resolves DATA_DIR from process.cwd() at MODULE LOAD, so
// the temp tree is created and chdir'd into BEFORE the first `@/lib` import.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-store.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-billing-store-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const DB_PATH = path.join(TMP, "data", "db.json");

const db = await import("@/lib/db");
const store = await import("@/lib/billing-store");
// R3-5 — the SINGLE liveness table both stripe.ts and billing-store.ts now source from.
const { isLiveStripeStatus } = await import("@/lib/billing-status");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Write a db.json from scratch. `extra` is merged over the legacy-shaped base. */
function writeDb(extra = {}) {
  const base = {
    seafarers: [],
    documents: [],
    comments: [],
    restHours: [],
    agents: [],
    assignments: [],
    accessGrants: [],
    requiredDocsConfigs: [],
    requiredDocsAudit: [],
    notifications: [],
    remindersSent: [],
    circulars: [],
    circularReplies: [],
    docRequests: [],
    profileChanges: [],
    seaService: [],
    impersonations: [],
    profileShareRequests: [],
    appraisals: [],
    appraisalDeleteRequests: [],
    issuedSeaTerms: [],
    clientPortals: [],
    vacancies: [],
  };
  fs.writeFileSync(DB_PATH, JSON.stringify({ ...base, ...extra }, null, 2), "utf8");
}

// ---------------------------------------------------------------------------

test("read-migration: a db.json with NO billing keys at all still loads", () => {
  writeDb();
  const loaded = db.readDB();
  assert.deepEqual(loaded.billingProfiles, []);
  assert.deepEqual(loaded.billingUsage, []);
  assert.deepEqual(loaded.stripeEvents, []);
  assert.deepEqual(loaded.billingBaseline, []);
  assert.equal(loaded.billingSettings.goLiveAt, null);
  assert.equal(loaded.billingSettings.defaults.baseEurMonthly, 300);
  assert.equal(loaded.billingSettings.defaults.perSeafarerEur, 2);
  assert.equal(typeof loaded.billingSettings.tosVersion, "string");
});

test("read-migration: R1/R2/R3 field deltas default on rows written by an older build", () => {
  writeDb({
    billingProfiles: [{ agentId: "agent:a", subscriptionStatus: "active" }],
    billingUsage: [
      { id: "u1", agentId: "agent:a", period: "2026-01", quantity: 3, pushedToStripeAt: "2026-02-01T00:20:00.000Z" },
      { id: "u2", agentId: "agent:a", period: "2026-02", quantity: 1 },
    ],
  });
  const loaded = db.readDB();
  const p = loaded.billingProfiles[0];
  assert.equal(p.canceledAt, null);
  assert.equal(p.billingActiveFrom, null);
  assert.equal(p.lastInvoiceEventCreated, null);
  assert.equal(p.lastSubscriptionEventCreated, null);
  // An already-pushed legacy row was, by construction, also attempted.
  assert.equal(loaded.billingUsage[0].pushAttemptedAt, "2026-02-01T00:20:00.000Z");
  assert.equal(loaded.billingUsage[1].pushAttemptedAt, null);
});

// MODIFIED (fix-plan §3 / C4): the two `isBillingLive()` assertions are gone with the
// dead helper itself (its only consumer was this test). The settings round-trip — the
// part that actually pins behaviour — is untouched.
test("settings singleton: defaults and patch round-trip", async () => {
  writeDb();
  await store.saveBillingSettings({ goLiveAt: "2026-09-01T00:00:00.000Z", stripeMeterId: "mtr_1" });
  const s = store.getBillingSettings();
  assert.equal(s.goLiveAt, "2026-09-01T00:00:00.000Z");
  assert.equal(s.stripeMeterId, "mtr_1");
  // Untouched fields keep their defaults.
  assert.equal(s.defaults.baseEurMonthly, 300);
  assert.equal(s.stripePortalConfigId, null);
});

test("ensureBillingProfileForAgent: creates once, pre-go-live leaves the clock unset", async () => {
  writeDb();
  const p = await store.ensureBillingProfileForAgent("agent:acme", "2026-09-02T10:00:00.000Z");
  assert.equal(p.agentId, "agent:acme");
  assert.equal(p.subscriptionStatus, "none");
  assert.equal(p.exemptFromBilling, false);
  assert.equal(p.baseEurMonthly, 300);
  assert.equal(p.perSeafarerEur, 2);
  // goLiveAt is null -> billing is dormant -> NO escalation clock (plan §4).
  assert.equal(p.billingRequiredSince, null);
  assert.equal(db.readDB().billingProfiles.length, 1);
});

test("ensureBillingProfileForAgent: post-go-live stamps billingRequiredSince (R1-9)", async () => {
  writeDb({ billingSettings: { goLiveAt: "2026-09-01T00:00:00.000Z" } });
  const p = await store.ensureBillingProfileForAgent("agent:acme", "2026-09-05T08:00:00.000Z");
  assert.equal(p.billingRequiredSince, "2026-09-05T08:00:00.000Z");
  assert.equal(p.createdAt, "2026-09-05T08:00:00.000Z");
});

test("ensureBillingProfileForAgent: demo-class agents are structurally exempt (R1-7)", async () => {
  writeDb({ billingSettings: { goLiveAt: "2026-09-01T00:00:00.000Z" } });
  const dev = await store.ensureBillingProfileForAgent("dev", "2026-09-05T08:00:00.000Z");
  const sample = await store.ensureBillingProfileForAgent("sample-agency-crewing", "2026-09-05T08:00:00.000Z");
  for (const p of [dev, sample]) {
    assert.equal(p.exemptFromBilling, true);
    assert.equal(p.billingRequiredSince, null, `${p.agentId} must never get a billing clock`);
  }
});

test("R2-8: N parallel first-session resolutions produce exactly ONE profile row", async () => {
  writeDb({ billingSettings: { goLiveAt: "2026-09-01T00:00:00.000Z" } });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.ensureBillingProfileForAgent("agent:race", `2026-09-0${(i % 8) + 1}T00:00:00.000Z`)
    )
  );
  const rows = db.readDB().billingProfiles.filter((p) => p.agentId === "agent:race");
  assert.equal(rows.length, 1, "exactly one profile row");
  const stamps = new Set(results.map((r) => r.billingRequiredSince));
  assert.equal(stamps.size, 1, "exactly one billingRequiredSince value observed");
  assert.equal(rows[0].billingRequiredSince, [...stamps][0]);
});

test("ensureBillingProfileForAgent: steady state performs ZERO writes (R2-8)", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("agent:quiet", "2026-09-02T10:00:00.000Z");
  const before = fs.statSync(DB_PATH).mtimeMs;
  const bytesBefore = fs.readFileSync(DB_PATH, "utf8");
  const entriesBefore = db._serializeEntryCount();
  const again = await store.ensureBillingProfileForAgent("agent:quiet", "2026-09-09T10:00:00.000Z");
  assert.equal(again.createdAt, "2026-09-02T10:00:00.000Z", "existing row is returned unchanged");
  assert.equal(db._serializeEntryCount(), entriesBefore, "no critical section was entered");
  assert.equal(fs.readFileSync(DB_PATH, "utf8"), bytesBefore, "db.json bytes unchanged");
  assert.equal(fs.statSync(DB_PATH).mtimeMs, before);
});

test("F3 free-rider: a profile created by a pre-go-live sign-in is exempted by applyGoLive; and a post-golive non-exempt stampless profile is healed by ensureBillingProfileForAgent", async () => {
  // FINDING 2: `agent-session` lazily creates a profile on first sign-in. Before
  // go-live that profile is `exempt: false, billingRequiredSince: null`. The go-live
  // sweep only ever CREATED-and-exempted profiles for agents that had NONE, so this one
  // was skipped; `billingTierForAgent` then read it as exempt/"not-launched" FOREVER and
  // no code path anywhere re-stamped it. A permanent free rider, invisible everywhere.
  writeDb({
    agents: [
      { id: "agent:early", orgName: "Signed in before go-live", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "agent:fresh", orgName: "Never signed in", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "agent:paying", orgName: "Subscribed in the dormant window", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "sample-demo", orgName: "Demo", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  });
  await store.ensureBillingProfileForAgent("agent:early", "2026-08-02T09:00:00.000Z");
  await store.ensureBillingProfileForAgent("agent:paying", "2026-08-02T09:00:00.000Z");
  await store.setBillingStripeRefs("agent:paying", { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  await store.setSubscriptionStatusForAgent("agent:paying", { subscriptionStatus: "active" });
  assert.equal(store.getBillingProfileForAgent("agent:early").exemptFromBilling, false);

  const T0 = "2026-09-01T00:00:00.000Z";
  const result = await db.updateDB((d) => store.applyGoLive(d, T0));
  assert.equal(result.ok, true);
  assert.equal(result.profilesCreated, 2, "agent:fresh and sample-demo get fresh comped profiles");
  assert.equal(result.profilesExempted, 1, "and the PRE-EXISTING one is exempted too (decision 7)");
  assert.equal(
    store.getBillingProfileForAgent("agent:early").exemptFromBilling,
    true,
    "the free rider is grandfathered like everyone else"
  );

  // FR1-3 — an agency Stripe is ALREADY invoicing is never blanket-comped.
  assert.deepEqual(result.subscribedSkipped, ["agent:paying"]);
  assert.equal(store.getBillingProfileForAgent("agent:paying").exemptFromBilling, false);

  // A second call refuses (T0 must not move).
  const again = await db.updateDB((d) => store.applyGoLive(d, "2026-10-01T00:00:00.000Z"));
  assert.equal(again.ok, false);
  assert.equal(again.alreadyLiveAt, T0);

  // ---- The D-D self-heal, for a profile that slipped through anyway -------------
  const enforce = await import("@/lib/billing-enforce");
  await store.setBillingRatesForAgent("agent:early", { exemptFromBilling: false }, "2026-09-02T00:00:00.000Z");
  await db.updateDB((d) => {
    const idx = d.billingProfiles.findIndex((p) => p.agentId === "agent:early");
    d.billingProfiles[idx] = { ...d.billingProfiles[idx], billingRequiredSince: null };
    return null;
  });
  assert.equal(
    enforce.billingTierForAgent(db.readDB(), "agent:early", Date.parse("2026-12-01T00:00:00.000Z")).reason,
    "not-launched",
    "the anomalous state really does read as a permanent exemption"
  );

  const healed = await store.ensureBillingProfileForAgent("agent:early", "2026-09-03T10:00:00.000Z");
  assert.equal(healed.billingRequiredSince, "2026-09-03T10:00:00.000Z", "one write starts the clock");
  assert.notEqual(
    enforce.billingTierForAgent(db.readDB(), "agent:early", Date.parse("2026-12-01T00:00:00.000Z")).reason,
    "not-launched"
  );

  // …and the heal is WRITE-ONCE: the steady state stays a pure read (R2-8).
  const entriesBefore = db._serializeEntryCount();
  await store.ensureBillingProfileForAgent("agent:early", "2026-09-04T10:00:00.000Z");
  assert.equal(db._serializeEntryCount(), entriesBefore, "no second write");
  assert.equal(
    store.getBillingProfileForAgent("agent:early").billingRequiredSince,
    "2026-09-03T10:00:00.000Z"
  );
});

test("F3 applyGoLive: exempt agents and demo-class agents are untouched; baseline rows still land", async () => {
  writeDb({
    agents: [
      { id: "agent:a", orgName: "A", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "sample-demo", orgName: "Demo", contact: "", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
    seafarers: [{ id: "sf1", name: "sf1", rank: "", state: "review", mergedFrom: [] }],
    accessGrants: [
      {
        id: "g1", seafarerId: "sf1", agentId: "agent:a", status: "ACTIVE", legalBasis: "CONSENT",
        scope: [], shareToken: "t1", grantedAt: "2026-08-01T00:00:00.000Z", revokedAt: null,
        expiresAt: null, createdAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  });
  const result = await db.updateDB((d) => store.applyGoLive(d, "2026-09-01T00:00:00.000Z"));
  assert.equal(result.ok, true);
  assert.equal(result.baselineRows, 1);
  assert.equal(db.readDB().billingBaseline[0].seafarerId, "sf1");
  // R1-7 — the demo class never gets baseline rows.
  assert.deepEqual(result.perAgent.find((r) => r.agentId === "sample-demo"), { agentId: "sample-demo", pairs: 0 });
  assert.equal(db.readDB().billingSettings.goLiveAt, "2026-09-01T00:00:00.000Z");
});

test("R3-5 one liveness table: applyGoLive skips exactly the statuses isLiveStripeStatus marks live", async () => {
  // FINDING R3-5: applyGoLive used a THIRD hardcoded live-status set (LIVE_STORED_STATUSES)
  // independent of stripe.ts's isLiveStripeStatus. Now both source the one predicate in
  // billing-status.ts. Lock the store and the predicate together for every stored status.
  const statuses = ["active", "past_due", "incomplete", "canceled", "none"];
  writeDb({
    agents: statuses.map((s) => ({
      id: `agent:${s}`,
      orgName: s,
      contact: "",
      createdAt: "2026-08-01T00:00:00.000Z",
    })),
  });
  for (const s of statuses) {
    const agentId = `agent:${s}`;
    await store.ensureBillingProfileForAgent(agentId, "2026-08-02T09:00:00.000Z");
    await store.setBillingStripeRefs(agentId, { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    await store.setSubscriptionStatusForAgent(agentId, { subscriptionStatus: s });
  }

  const result = await db.updateDB((d) => store.applyGoLive(d, "2026-09-01T00:00:00.000Z"));
  assert.equal(result.ok, true);

  for (const s of statuses) {
    const agentId = `agent:${s}`;
    assert.equal(
      result.subscribedSkipped.includes(agentId),
      isLiveStripeStatus(s),
      `${s}: the go-live skip must equal the single liveness predicate`
    );
    // A skipped (live) agency is never comped; a dead-status one IS grandfathered exempt.
    assert.equal(
      store.getBillingProfileForAgent(agentId).exemptFromBilling,
      !isLiveStripeStatus(s),
      `${s}: exemption is the inverse of liveness`
    );
  }
});

test("R3-refuted: un-comping a sample agent never stamps billingRequiredSince", async () => {
  // D-9 hygiene: a demo-class agent is structurally billing-exempt (billing-enforce
  // short-circuits it before tierFromProfile), so even an explicit exempt->non-exempt
  // flip must not stamp a billing clock, matching the other write sites.
  writeDb({
    agents: [{ id: "sample-agency-x", orgName: "Sample", contact: "", createdAt: "2026-08-01T00:00:00.000Z" }],
    billingSettings: {
      goLiveAt: "2026-01-01T00:00:00.000Z",
      tosVersion: "2026-08-draft-1",
      stripeBaseProductId: null,
      stripeUsageProductId: null,
      stripeMeterId: null,
      stripePortalConfigId: null,
      defaults: { baseEurMonthly: 300, perSeafarerEur: 2 },
    },
  });
  // A sample agent's profile starts exempt (defaultBillingProfile). Flip it to non-exempt.
  await store.ensureBillingProfileForAgent("sample-agency-x", "2026-08-02T09:00:00.000Z");
  assert.equal(store.getBillingProfileForAgent("sample-agency-x").exemptFromBilling, true);
  await store.setBillingRatesForAgent("sample-agency-x", { exemptFromBilling: false }, "2026-09-02T00:00:00.000Z");

  const p = store.getBillingProfileForAgent("sample-agency-x");
  assert.equal(p.exemptFromBilling, false, "the flip took");
  assert.equal(p.billingRequiredSince, null, "but a demo-class agent is never given a billing clock");
});

test("saveBillingProfileForAgent: business info round-trip, rates NOT writable here", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("agent:acme", "2026-09-02T10:00:00.000Z");
  const saved = await store.saveBillingProfileForAgent(
    "agent:acme",
    {
      legalName: "Acme Crewing OÜ",
      regCode: "12345678",
      vatNumber: "EE101234567",
      billingEmail: "billing@acme.example",
      address: { line1: "Sadama 1", city: "Tallinn", postal: "10111", country: "EE" },
      tosAcceptedAt: "2026-09-02T10:05:00.000Z",
      tosVersion: "2026-08-draft-1",
    },
    "2026-09-02T10:05:00.000Z"
  );
  assert.equal(saved.legalName, "Acme Crewing OÜ");
  assert.equal(saved.address.country, "EE");
  assert.equal(saved.updatedAt, "2026-09-02T10:05:00.000Z");
  assert.equal(saved.baseEurMonthly, 300, "rates untouched by the agent-facing save");
  assert.equal(saved.exemptFromBilling, false);
  const reread = store.getBillingProfileForAgent("agent:acme");
  assert.equal(reread.legalName, "Acme Crewing OÜ");
  assert.equal(store.getBillingProfileForAgent("agent:nobody"), null);
});

test("setBillingRatesForAgent: exempt -> non-exempt resets the billing clock (R1-6)", async () => {
  writeDb({ billingSettings: { goLiveAt: "2026-09-01T00:00:00.000Z" } });
  await store.ensureBillingProfileForAgent("agent:comped", "2026-09-02T10:00:00.000Z");
  await store.setBillingRatesForAgent("agent:comped", { exemptFromBilling: true }, "2026-09-03T00:00:00.000Z");
  const back = await store.setBillingRatesForAgent(
    "agent:comped",
    { exemptFromBilling: false, baseEurMonthly: 450, perSeafarerEur: 3 },
    "2026-09-20T12:00:00.000Z"
  );
  assert.equal(back.exemptFromBilling, false);
  assert.equal(back.baseEurMonthly, 450);
  assert.equal(back.perSeafarerEur, 3);
  assert.equal(back.billingActiveFrom, "2026-09-20T12:00:00.000Z", "clock re-set at the transition");
  assert.equal(await store.setBillingRatesForAgent("agent:ghost", { baseEurMonthly: 1 }), null);
});

test("usage ledger: upsert, then FROZEN once pushed", async () => {
  writeDb();
  const row = await store.recordUsageForPeriod(
    "agent:acme",
    "2026-09",
    { quantity: 4, billableSeafarerIds: ["s1", "s2", "s3", "s4"], detail: { warnings: [] } },
    "2026-10-01T00:20:00.000Z"
  );
  assert.equal(row.quantity, 4);
  assert.equal(row.pushAttemptedAt, null);
  assert.equal(row.pushedToStripeAt, null);

  // Recompute before the push -> the row is updated in place.
  const recomputed = await store.recordUsageForPeriod(
    "agent:acme",
    "2026-09",
    { quantity: 5, billableSeafarerIds: ["s1", "s2", "s3", "s4", "s5"] },
    "2026-10-01T00:50:00.000Z"
  );
  assert.equal(recomputed.quantity, 5);
  assert.equal(recomputed.id, row.id, "same row, not a duplicate");

  await store.claimUsagePush("agent:acme", "2026-09", Date.parse("2026-10-01T00:55:00.000Z"));
  await store.markUsagePushed("agent:acme", "2026-09", "mev_1", "2026-10-01T00:56:00.000Z");

  // After the push the quantity is frozen — the meter aggregates by SUM, so a
  // rewritten quantity would desynchronise the ledger from Stripe's totals.
  const afterPush = await store.recordUsageForPeriod(
    "agent:acme",
    "2026-09",
    { quantity: 99, billableSeafarerIds: [] },
    "2026-10-02T00:00:00.000Z"
  );
  assert.equal(afterPush.quantity, 5);
  assert.equal(afterPush.stripeMeterEventId, "mev_1");
  assert.equal(db.readDB().billingUsage.filter((r) => r.period === "2026-09").length, 1);
});

test("F1 ledger freeze: recordUsageForPeriod refuses to rewrite a CLAIMED (pushAttemptedAt) row", async () => {
  writeDb();
  await store.recordUsageForPeriod(
    "agent:frozen",
    "2026-09",
    { quantity: 4, billableSeafarerIds: ["a", "b", "c", "d"] },
    "2026-10-01T00:20:00.000Z"
  );
  await store.claimUsagePush("agent:frozen", "2026-09", Date.parse("2026-10-01T00:25:00.000Z"));

  // FINDING 3: the freeze used to trip on `pushedToStripeAt` ONLY, so a row Stripe may
  // already hold (claimed, unconfirmed) had its quantity rewritten by the next
  // recompute — desynchronising a SUM-aggregated meter from the ledger.
  const after = await store.recordUsageForPeriod(
    "agent:frozen",
    "2026-09",
    { quantity: 0, billableSeafarerIds: [] },
    "2026-10-01T00:55:00.000Z"
  );
  assert.equal(after.quantity, 4, "a claimed row is immutable");
  assert.equal(store.getUsageRow("agent:frozen", "2026-09").quantity, 4);

  // The ADMIN's clear-attempt (R2-10a) is the only way back — never an automatic path.
  await store.resolveUnconfirmedPush("agent:frozen", "2026-09", "clear-attempt");
  const reopened = await store.recordUsageForPeriod("agent:frozen", "2026-09", {
    quantity: 1,
    billableSeafarerIds: ["a"],
  });
  assert.equal(reopened.quantity, 1);
});

test("F1 closedAs: a closed row REOPENS when a later recompute finds usage", async () => {
  writeDb();
  await store.recordUsageForPeriod("agent:closed", "2026-09", { quantity: 0, billableSeafarerIds: [] });
  const closed = await store.closeUsageRow(
    "agent:closed",
    "2026-09",
    "no-usage",
    "no billable seafarers in the period"
  );
  assert.equal(closed.closedAs, "no-usage");
  assert.equal(closed.pushedToStripeAt, null, "closing a month is NOT a Stripe push (D-G)");
  assert.equal(closed.stripeMeterEventId, null);
  assert.equal(store.isUsageRowDone(closed), true, "…but the cron treats it as done");

  // This is the zero-freeze fix: a close is only as good as the last compute.
  const reopened = await store.recordUsageForPeriod("agent:closed", "2026-09", {
    quantity: 2,
    billableSeafarerIds: ["x", "y"],
  });
  assert.equal(reopened.quantity, 2);
  assert.equal(reopened.closedAs, null);
  assert.equal(reopened.closedReason, null);
  assert.equal(store.isUsageRowDone(reopened), false);

  // closeUsageRow refuses a CLAIMED row — that is the R1-1 manual-resolution path.
  await store.claimUsagePush("agent:closed", "2026-09", Date.parse("2026-10-01T00:20:00.000Z"));
  const refused = await store.closeUsageRow("agent:closed", "2026-09", "no-usage", "x");
  assert.equal(refused.closedAs, null, "a claimed row is never auto-closed");
});

test("F1 no-op recompute performs ZERO writes (finding 23b)", async () => {
  writeDb();
  const input = { quantity: 3, billableSeafarerIds: ["a", "b", "c"], detail: { warnings: [] } };
  await store.recordUsageForPeriod("agent:quiet2", "2026-09", input, "2026-10-01T00:20:00.000Z");
  const entriesBefore = db._serializeEntryCount();
  const bytesBefore = fs.readFileSync(DB_PATH, "utf8");
  const again = await store.recordUsageForPeriod(
    "agent:quiet2",
    "2026-09",
    { ...input },
    "2026-10-01T00:50:00.000Z"
  );
  assert.equal(again.computedAt, "2026-10-01T00:20:00.000Z", "computedAt means last CHANGE");
  assert.equal(db._serializeEntryCount(), entriesBefore, "no critical section was entered");
  assert.equal(fs.readFileSync(DB_PATH, "utf8"), bytesBefore, "db.json bytes unchanged");
});

test("F1 read-migration: a legacy no-usage close reads as closedAs, not as a Stripe push", () => {
  writeDb({
    billingUsage: [
      {
        id: "u-legacy",
        agentId: "agent:legacy",
        period: "2026-08",
        quantity: 0,
        billableSeafarerIds: [],
        computedAt: "2026-09-01T00:20:00.000Z",
        pushedToStripeAt: "2026-09-01T00:20:00.000Z",
        stripeMeterEventId: "no-usage",
      },
    ],
  });
  const row = db.readDB().billingUsage[0];
  assert.equal(row.closedAs, "no-usage", "the pre-D-G close shape is recognised");
  assert.equal(store.isUsageRowDone(row), true);
});

test("R2 N3: a legacy no-usage row migrates to a REOPENABLE closedAs row, not a frozen one", async () => {
  // N3 — the migration recognised the legacy shape but CARRIED THE STAMPS OVER, and
  // `recordUsageForPeriod` freezes on pushAttemptedAt/pushedToStripeAt. So the D-G
  // reopen path could never fire on a legacy row: a zero month written by the old build
  // stayed at 0 forever — the exact fossilisation finding 1 exists to undo.
  // "no-usage" was a SENTINEL, not a meter-event id; Stripe was never called for it.
  writeDb({
    billingUsage: [
      {
        id: "u-legacy2",
        agentId: "agent:legacy2",
        period: "2026-08",
        quantity: 0,
        billableSeafarerIds: [],
        computedAt: "2026-09-01T00:20:00.000Z",
        pushedToStripeAt: "2026-09-01T00:20:00.000Z",
        stripeMeterEventId: "no-usage",
      },
    ],
  });
  const migrated = db.readDB().billingUsage[0];
  assert.equal(migrated.closedAs, "no-usage");
  assert.equal(migrated.pushedToStripeAt, null, "the sentinel stamp is CLEARED");
  assert.equal(migrated.pushAttemptedAt, null, "…and never derived from it");
  assert.equal(migrated.stripeMeterEventId, null);

  // …so a later recompute that finds real usage REOPENS it, exactly as a row written by
  // this build would.
  const reopened = await store.recordUsageForPeriod("agent:legacy2", "2026-08", {
    quantity: 4,
    billableSeafarerIds: ["a", "b", "c", "d"],
  });
  assert.equal(reopened.quantity, 4, "the legacy zero month is recoverable");
  assert.equal(reopened.closedAs, null);
  assert.equal(store.isUsageRowDone(reopened), false);
});

test("R2 N3: a genuinely PUSHED legacy row is still frozen (the migration is narrow)", async () => {
  writeDb({
    billingUsage: [
      {
        id: "u-real",
        agentId: "agent:real",
        period: "2026-08",
        quantity: 7,
        billableSeafarerIds: [],
        computedAt: "2026-09-01T00:20:00.000Z",
        pushedToStripeAt: "2026-09-01T00:20:00.000Z",
        stripeMeterEventId: "mev_real",
      },
    ],
  });
  const row = db.readDB().billingUsage[0];
  assert.equal(row.pushedToStripeAt, "2026-09-01T00:20:00.000Z", "a REAL meter event keeps its stamp");
  assert.equal(row.closedAs, null);
  const after = await store.recordUsageForPeriod("agent:real", "2026-08", {
    quantity: 1,
    billableSeafarerIds: [],
  });
  assert.equal(after.quantity, 7, "still frozen — Stripe holds this quantity");
});

test("R2 N5: canReopen=false keeps a never-billed close shut; a no-usage close always reopens", async () => {
  writeDb();
  // (a) `never-billed` + the agency still is => NO reopen, and therefore NO write.
  await store.recordUsageForPeriod("agent:nb", "2026-09", { quantity: 3, billableSeafarerIds: ["a", "b", "c"] });
  await store.closeUsageRow("agent:nb", "2026-09", "never-billed", "agency is exempt from billing");
  const entriesBefore = db._serializeEntryCount();
  const held = await store.recordUsageForPeriod("agent:nb", "2026-09", {
    quantity: 3,
    billableSeafarerIds: ["a", "b", "c"],
    canReopen: false,
  });
  assert.equal(held.closedAs, "never-billed", "a never-billed close is about the AGENCY, not the number");
  assert.equal(db._serializeEntryCount(), entriesBefore, "and no write was performed");

  // (b) the agency becomes billable => the SAME row reopens.
  const reopened = await store.recordUsageForPeriod("agent:nb", "2026-09", {
    quantity: 3,
    billableSeafarerIds: ["a", "b", "c"],
    canReopen: true,
  });
  assert.equal(reopened.closedAs, null);
  assert.equal(reopened.quantity, 3);

  // (c) canReopen never suppresses a `no-usage` close — that one IS about the number.
  await store.recordUsageForPeriod("agent:nu", "2026-09", { quantity: 0, billableSeafarerIds: [] });
  await store.closeUsageRow("agent:nu", "2026-09", "no-usage", "no billable seafarers in the period");
  const zeroReopened = await store.recordUsageForPeriod("agent:nu", "2026-09", {
    quantity: 2,
    billableSeafarerIds: ["x", "y"],
    canReopen: false,
  });
  assert.equal(zeroReopened.closedAs, null, "the zero-freeze fix is untouched");
  assert.equal(zeroReopened.quantity, 2);
});

test("R1-1 claimUsagePush: fresh claims, in-window retry, stale unconfirmed, already pushed", async () => {
  writeDb();
  const t0 = Date.parse("2026-10-01T00:20:00.000Z");
  await store.recordUsageForPeriod("agent:a", "2026-09", { quantity: 2, billableSeafarerIds: ["x", "y"] }, new Date(t0).toISOString());

  const first = await store.claimUsagePush("agent:a", "2026-09", t0);
  assert.equal(first.claimed, true);
  assert.equal(store.getUsageRow("agent:a", "2026-09").pushAttemptedAt, new Date(t0).toISOString());

  // Within Stripe's ~24h idempotency-key dedupe window a retry is SAFE.
  const retry = await store.claimUsagePush("agent:a", "2026-09", t0 + 6 * 3600_000);
  assert.equal(retry.claimed, true);

  // Past the window an unconfirmed attempt is a MANUAL reconciliation case — never
  // auto-retried, because the key no longer dedupes and the meter sums.
  const stale = await store.claimUsagePush("agent:a", "2026-09", t0 + 25 * 3600_000);
  assert.equal(stale.claimed, false);
  assert.equal(stale.reason, "unconfirmed-stale");

  await store.markUsagePushed("agent:a", "2026-09", "mev_x", new Date(t0 + 26 * 3600_000).toISOString());
  const done = await store.claimUsagePush("agent:a", "2026-09", t0 + 27 * 3600_000);
  assert.equal(done.claimed, false);
  assert.equal(done.reason, "already-pushed");

  const missing = await store.claimUsagePush("agent:a", "2026-12", t0);
  assert.equal(missing.claimed, false);
  assert.equal(missing.reason, "no-row");
});

test("R2-10a resolveUnconfirmedPush: admin marks pushed / clears the attempt", async () => {
  writeDb();
  const t0 = Date.parse("2026-10-01T00:20:00.000Z");
  await store.recordUsageForPeriod("agent:a", "2026-09", { quantity: 1, billableSeafarerIds: ["x"] });
  await store.claimUsagePush("agent:a", "2026-09", t0);
  const cleared = await store.resolveUnconfirmedPush("agent:a", "2026-09", "clear-attempt", "2026-10-03T00:00:00.000Z");
  assert.equal(cleared.pushAttemptedAt, null);
  assert.equal(cleared.pushedToStripeAt, null);
  // ...and after clearing, the normal path can claim again.
  assert.equal((await store.claimUsagePush("agent:a", "2026-09", t0 + 48 * 3600_000)).claimed, true);

  const marked = await store.resolveUnconfirmedPush("agent:a", "2026-09", "mark-pushed", "2026-10-03T01:00:00.000Z");
  assert.equal(marked.pushedToStripeAt, "2026-10-03T01:00:00.000Z");
  assert.equal(marked.stripeMeterEventId, "admin-resolved");
  assert.equal(await store.resolveUnconfirmedPush("agent:a", "2099-01", "mark-pushed"), null);
});

test("usageForAgent: own-tenant only, newest period first", async () => {
  writeDb();
  await store.recordUsageForPeriod("agent:a", "2026-07", { quantity: 1, billableSeafarerIds: [] });
  await store.recordUsageForPeriod("agent:a", "2026-09", { quantity: 3, billableSeafarerIds: [] });
  await store.recordUsageForPeriod("agent:b", "2026-09", { quantity: 7, billableSeafarerIds: [] });
  const rows = store.usageForAgent("agent:a");
  assert.deepEqual(rows.map((r) => r.period), ["2026-09", "2026-07"]);
  assert.ok(rows.every((r) => r.agentId === "agent:a"), "no cross-tenant leak");
});

test("R2-2 webhook ledger: claim, finish, dedupe-on-processed, crashed-claim reprocess", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("agent:acme", "2026-09-02T10:00:00.000Z");

  const first = await store.claimStripeEvent("evt_1", "invoice.paid", "2026-09-10T00:00:00.000Z");
  assert.equal(first.process, true);
  assert.equal(first.replayOfProcessed, false);
  assert.equal(store.wasStripeEventProcessed("evt_1"), false, "claimed but not yet processed");

  // A redelivery BEFORE phase 3 lands is a CRASHED claim -> reprocess (never skip).
  const crashedReplay = await store.claimStripeEvent("evt_1", "invoice.paid", "2026-09-10T00:00:05.000Z");
  assert.equal(crashedReplay.process, true);
  assert.equal(crashedReplay.replayOfProcessed, false);

  const profile = await store.finishStripeEvent("evt_1", "agent:acme", () => ({
    subscriptionStatus: "active",
    pastDueSince: null,
  }), "2026-09-10T00:00:10.000Z");
  assert.equal(profile.subscriptionStatus, "active");
  assert.equal(store.wasStripeEventProcessed("evt_1"), true);

  // Now a redelivery is a true replay of a PROCESSED event -> skip.
  const replay = await store.claimStripeEvent("evt_1", "invoice.paid", "2026-09-11T00:00:00.000Z");
  assert.equal(replay.process, false);
  assert.equal(replay.replayOfProcessed, true);
  assert.equal(db.readDB().stripeEvents.filter((e) => e.stripeEventId === "evt_1").length, 1);
});

test("webhook ledger: finishStripeEvent with an unknown agent still stamps processedAt", async () => {
  writeDb();
  await store.claimStripeEvent("evt_orphan", "invoice.paid");
  const res = await store.finishStripeEvent("evt_orphan", null, () => null);
  assert.equal(res, null);
  assert.equal(store.wasStripeEventProcessed("evt_orphan"), true);
});

test("pruneStripeEvents drops rows past the retention window only", async () => {
  writeDb();
  const now = Date.parse("2026-12-01T00:00:00.000Z");
  await store.claimStripeEvent("evt_old", "invoice.paid", "2026-01-01T00:00:00.000Z");
  await store.claimStripeEvent("evt_new", "invoice.paid", "2026-11-30T00:00:00.000Z");
  const removed = await store.pruneStripeEvents(90 * 24 * 3600_000, now);
  assert.equal(removed, 1);
  const ids = db.readDB().stripeEvents.map((e) => e.stripeEventId);
  assert.deepEqual(ids, ["evt_new"]);
});

test("customer/subscription -> agent joins are own-row lookups", async () => {
  writeDb();
  await store.ensureBillingProfileForAgent("agent:acme", "2026-09-02T10:00:00.000Z");
  await store.setBillingStripeRefs("agent:acme", { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  assert.equal(store.agentIdForStripeCustomer("cus_1"), "agent:acme");
  assert.equal(store.agentIdForStripeSubscription("sub_1"), "agent:acme");
  assert.equal(store.agentIdForStripeCustomer("cus_nope"), null);
  assert.equal(store.agentIdForStripeSubscription("sub_nope"), null);
  assert.equal(await store.setBillingStripeRefs("agent:ghost", { stripeCustomerId: "x" }), null);
});
