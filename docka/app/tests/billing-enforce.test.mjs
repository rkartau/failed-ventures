// Unit tests for lib/billing-enforce.ts — the escalation ladder and the two route
// guards (STRIPE-BILLING-PLAN.md P5 / decision 6, with R1-8, R1-9 and R2-5 folded in).
//
// The tier function is pure over the db it is handed, so every rung of the ladder is
// exercised here without a session, a request or a running server.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-enforce.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-billing-enforce-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const enforce = await import("@/lib/billing-enforce");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const GO_LIVE = "2026-01-01T00:00:00.000Z";

/** A minimal db shaped exactly as billingTierForAgent reads it. */
function db(profiles, goLiveAt = GO_LIVE) {
  return { billingSettings: { goLiveAt }, billingProfiles: profiles };
}

/** A healthy, paying profile; `patch` breaks whichever part the case is about. */
function profile(patch = {}) {
  return {
    agentId: "agent:acme",
    exemptFromBilling: false,
    subscriptionStatus: "active",
    paymentMethodAttached: true,
    pastDueSince: null,
    canceledAt: null,
    billingRequiredSince: "2026-02-01T00:00:00.000Z",
    ...patch,
  };
}

const tier = (patch, now = NOW) =>
  enforce.billingTierForAgent(db([profile(patch)]), "agent:acme", now);

/** An instant `ms` before NOW, as an ISO string. */
const ago = (ms) => new Date(NOW - ms).toISOString();

// ===========================================================================
// The off-switches (fail-open by design)
// ===========================================================================

test("goLiveAt null: EVERY agent is exempt — deploying before launch changes nothing", () => {
  const state = enforce.billingTierForAgent(
    db([profile({ pastDueSince: ago(90 * DAY), subscriptionStatus: "past_due" })], null),
    "agent:acme",
    NOW
  );
  assert.equal(state.tier, "exempt");
  assert.equal(state.reason, "not-launched");
});

test("exemptFromBilling is an instant per-agent kill switch, even at 90 days past due", () => {
  const state = tier({ exemptFromBilling: true, pastDueSince: ago(90 * DAY), subscriptionStatus: "past_due" });
  assert.equal(state.tier, "exempt");
  assert.equal(state.reason, "exempt-agent");
});

test("R1-7: demo-class agent ids are exempt regardless of their profile row", () => {
  for (const agentId of ["dev", "sample-agency-crewing"]) {
    const state = enforce.billingTierForAgent(
      db([profile({ agentId, subscriptionStatus: "canceled", paymentMethodAttached: false })]),
      agentId,
      NOW
    );
    assert.equal(state.tier, "exempt", agentId);
    assert.equal(state.reason, "sample-agent");
  }
});

test("no profile row yet: fail OPEN — an un-onboarded agency is never locked out", () => {
  const state = enforce.billingTierForAgent(db([]), "agent:new", NOW);
  assert.equal(state.tier, "exempt");
  assert.equal(state.reason, "no-profile");
});

test("a pre-go-live agent (no billingRequiredSince) never escalates", () => {
  const state = tier({ billingRequiredSince: null, subscriptionStatus: "none", paymentMethodAttached: false });
  assert.equal(state.tier, "exempt");
});

test("a healthy paying agency is `ok` with no banner", () => {
  const state = tier({});
  assert.equal(state.tier, "ok");
  assert.equal(state.reason, "ok");
  assert.equal(state.since, null);
  assert.equal(enforce.shouldShowBillingBanner(state), false);
});

// ===========================================================================
// The ladder: warning -> readonly (14d) -> blocked (30d)
// ===========================================================================

test("past_due: warning IMMEDIATELY, and the banner shows", () => {
  const state = tier({ subscriptionStatus: "past_due", pastDueSince: ago(1 * HOUR) });
  assert.equal(state.tier, "warning");
  assert.equal(state.reason, "past_due");
  assert.equal(enforce.shouldShowBillingBanner(state), true);
});

test("BOUNDARY 13d23h past due is still `warning`", () => {
  const state = tier({ subscriptionStatus: "past_due", pastDueSince: ago(13 * DAY + 23 * HOUR) });
  assert.equal(state.tier, "warning");
});

test("BOUNDARY exactly 14d past due flips to `readonly`", () => {
  const state = tier({ subscriptionStatus: "past_due", pastDueSince: ago(14 * DAY) });
  assert.equal(state.tier, "readonly");
  assert.equal(enforce.shouldShowBillingBanner(state), true);
});

test("BOUNDARY 14d1h past due is `readonly`, 29d23h still `readonly`", () => {
  assert.equal(tier({ subscriptionStatus: "past_due", pastDueSince: ago(14 * DAY + HOUR) }).tier, "readonly");
  assert.equal(tier({ subscriptionStatus: "past_due", pastDueSince: ago(29 * DAY + 23 * HOUR) }).tier, "readonly");
});

test("BOUNDARY exactly 30d past due flips to `blocked`", () => {
  const state = tier({ subscriptionStatus: "past_due", pastDueSince: ago(30 * DAY) });
  assert.equal(state.tier, "blocked");
  assert.equal(enforce.shouldShowBillingBanner(state), false, "the paywall replaces the banner");
});

// ===========================================================================
// R1-9 — the no-payment-method clock runs from billingRequiredSince
// ===========================================================================

test("R1-9: no payment method escalates from billingRequiredSince, 13d23h vs 14d1h", () => {
  const base = { paymentMethodAttached: false, subscriptionStatus: "incomplete", pastDueSince: null };
  assert.equal(tier({ ...base, billingRequiredSince: ago(13 * DAY + 23 * HOUR) }).tier, "warning");
  assert.equal(tier({ ...base, billingRequiredSince: ago(14 * DAY + HOUR) }).tier, "readonly");
  assert.equal(tier({ ...base, billingRequiredSince: ago(31 * DAY) }).tier, "blocked");
  assert.equal(tier({ ...base, billingRequiredSince: ago(2 * DAY) }).reason, "no_payment_method");
});

// ===========================================================================
// R2-5 — canceled ageing closes the cancel-and-ride-free hole
// ===========================================================================

test("R2-5: a CANCELED subscription ages to readonly then blocked even WITH a payment method", () => {
  const base = {
    subscriptionStatus: "canceled",
    paymentMethodAttached: true, // the card is still on file — that must not save them
    pastDueSince: null,
  };
  assert.equal(tier({ ...base, canceledAt: ago(1 * DAY) }).tier, "warning");
  assert.equal(tier({ ...base, canceledAt: ago(1 * DAY) }).reason, "no_subscription");
  assert.equal(tier({ ...base, canceledAt: ago(14 * DAY) }).tier, "readonly");
  assert.equal(tier({ ...base, canceledAt: ago(30 * DAY) }).tier, "blocked");
});

test("R2-5: the canceled clock runs from max(billingRequiredSince, canceledAt)", () => {
  // Required since long ago, but only cancelled yesterday -> the clock starts at the
  // CANCEL, so a long-standing customer is not blocked the instant they cancel.
  const state = tier({
    subscriptionStatus: "canceled",
    canceledAt: ago(1 * DAY),
    billingRequiredSince: ago(400 * DAY),
  });
  assert.equal(state.tier, "warning");
  assert.equal(state.since, ago(1 * DAY));
});

test("status `none` after an expired incomplete escalates like a cancel", () => {
  const state = tier({
    subscriptionStatus: "none",
    paymentMethodAttached: true,
    billingRequiredSince: ago(20 * DAY),
  });
  assert.equal(state.tier, "readonly");
  assert.equal(state.reason, "no_subscription");
});

test("the clock starts at the LATEST signal: a fresh failure does not inherit an old date", () => {
  const state = tier({
    subscriptionStatus: "past_due",
    billingRequiredSince: ago(400 * DAY),
    pastDueSince: ago(2 * DAY),
  });
  assert.equal(state.tier, "warning", "a 400-day customer whose card just failed gets the banner, not the paywall");
  // MODIFIED (fix-plan §3 / C8): the redundant `state.pastDueSince` MIRROR is gone. It
  // was one of the inputs `since` is a max over, so the two disagreed whenever any other
  // signal was later; `since` IS the clock, and the raw Stripe stamp lives on the profile.
  assert.equal(state.since, ago(2 * DAY));
  assert.equal("pastDueSince" in state, false, "the mirror field is gone, not just unset");
});

// ===========================================================================
// F3 / FINDING 12 — un-comping an agency must not be an instant paywall
// ===========================================================================

test("F3 un-comp grace: exempt->non-exempt after 45 comped days lands at warning, readonly at +14d, blocked at +30d — never instantly blocked", () => {
  // FINDING 12: `setBillingRatesForAgent` stamps `billingActiveFrom` on the
  // exempt -> non-exempt transition but leaves the months-old `billingRequiredSince`
  // alone, and the tier clock did not look at `billingActiveFrom` at all. A 45-day
  // comped agency was therefore BLOCKED the instant the comp ended — no banner, no
  // read-only rung, no warning e-mail window. D-H puts the stamp in the clock.
  const uncomped = (agoMs) => ({
    exemptFromBilling: false,
    subscriptionStatus: "none",
    paymentMethodAttached: false,
    pastDueSince: null,
    canceledAt: null,
    billingRequiredSince: ago(45 * DAY), // signed up (and was comped) 45 days ago
    billingActiveFrom: ago(agoMs), // …and the comp ended `agoMs` ago
  });

  const justNow = tier(uncomped(1 * HOUR));
  assert.equal(justNow.tier, "warning", "an un-comp is a banner, never an instant paywall");
  assert.equal(justNow.reason, "no_subscription");
  assert.equal(justNow.since, ago(1 * HOUR), "the clock starts at the un-comp instant");

  assert.equal(tier(uncomped(13 * DAY + 23 * HOUR)).tier, "warning");
  assert.equal(tier(uncomped(14 * DAY)).tier, "readonly");
  assert.equal(tier(uncomped(29 * DAY + 23 * HOUR)).tier, "readonly");
  assert.equal(tier(uncomped(30 * DAY)).tier, "blocked", "the full ladder still ends at the paywall");
});

test("F3 D-H: billingActiveFrom in the clock cannot shorten a paying agency's ladder", () => {
  // The candidates are a `max`, and for a real customer any actual problem signal is
  // necessarily LATER than the checkout adoption that stamps billingActiveFrom.
  const state = tier({
    subscriptionStatus: "past_due",
    billingRequiredSince: ago(400 * DAY),
    billingActiveFrom: ago(300 * DAY), // adopted at checkout, long ago
    pastDueSince: ago(2 * DAY),
  });
  assert.equal(state.tier, "warning");
  assert.equal(state.since, ago(2 * DAY), "the LATEST signal still wins");
});

// ===========================================================================
// D-E / FINDING 7 — enforcement abstains rather than locking everyone out
// ===========================================================================

test("F3 session error fail-open: reason 'error' is exempt and passes both gates", () => {
  // FINDING 7: `agentSession()` bare-awaited a store WRITE with no try/catch anywhere,
  // so one transient write failure 500'd EVERY authenticated agent surface — the exact
  // opposite of the fail-open doctrine this module is built on.
  const failed = { billing: { ...enforce.EXEMPT_STATE, reason: "error" } };
  assert.equal(failed.billing.tier, "exempt", "abstain, not `ok` — no tier was computed");
  assert.equal(enforce.requireBillingReadable(failed).ok, true);
  assert.equal(enforce.requireBillingWritable(failed).ok, true);
  assert.equal(enforce.shouldShowBillingBanner(failed.billing), false);
});

test("R2 N4: the per-request fail-open alert is deduped and cannot flush the money alerts", async () => {
  // N4 — the fail-open path runs PER REQUEST. With an unbounded append, one transient
  // store failure wrote a line per page view and rolled every money-critical alert
  // (unconfirmedPush, duplicateSubscription) out of the 200-entry rolling window within
  // seconds. It is deduped on (kind, agentId, scope) exactly like the FR2-2 cron alert.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docka-n4-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    const health = await import("@/lib/billing-health");
    health.__resetBillingHealth();

    // A pre-existing money alert the flood must not be able to displace.
    health.recordBillingAlert("unconfirmedPush", "2026-09 attempted, never confirmed", {
      agentId: "agent:acme",
      period: "2026-09",
    });

    for (let i = 0; i < 500; i++) {
      health.recordBillingAlertOnce("error", `billing state could not be resolved (${i})`, {
        agentId: "agent:acme",
        scope: "agent-session",
      });
    }

    const alerts = health.readBillingHealth().alerts;
    const sessionAlerts = alerts.filter((a) => a.scope === "agent-session");
    assert.equal(sessionAlerts.length, 1, "500 failing requests produce ONE line");
    assert.ok(
      alerts.some((a) => a.kind === "unconfirmedPush"),
      "and the money alert survives the outage"
    );

    // A DIFFERENT producer's error for the same agency is still recorded — the scope
    // keeps the two apart, so a session failure cannot mute the reconciler.
    health.recordBillingAlertOnce("error", "reconcile failed for this agency", {
      agentId: "agent:acme",
    });
    assert.equal(
      health.readBillingHealth().alerts.filter((a) => a.kind === "error").length,
      2,
      "scope discriminates the two `error` producers"
    );
    // …and a different agency gets its own line.
    health.recordBillingAlertOnce("error", "other agency", {
      agentId: "agent:other",
      scope: "agent-session",
    });
    assert.equal(
      health.readBillingHealth().alerts.filter((a) => a.scope === "agent-session").length,
      2
    );
  } finally {
    process.chdir(cwd);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("R2 N4: agent-session uses the DEDUPED alert on its per-request fail-open path", () => {
  const src = fs.readFileSync(path.join(originalCwd, "lib", "agent-session.ts"), "utf8");
  assert.match(src, /recordBillingAlertOnce\(/, "the once-variant, not the unbounded append");
  assert.doesNotMatch(
    src,
    /\brecordBillingAlert\(/,
    "an unbounded append on a per-request path is the bug"
  );
  assert.match(src, /scope:\s*"agent-session"/, "…scoped so it cannot mute other producers");
});

test("F3 agent-session really wraps the billing resolve and abstains on failure", () => {
  const src = fs.readFileSync(path.join(originalCwd, "lib", "agent-session.ts"), "utf8");
  assert.match(src, /try\s*{[\s\S]*ensureBillingProfileForAgent\(agent\.id\)/, "the ensure is inside a try");
  assert.match(src, /BILLING-SESSION-FAILURE/, "the failure is logged loudly");
  assert.match(src, /reason:\s*"error"/, "and the session resolves exempt/error");
});

// ===========================================================================
// R1-8 — the two route guards
// ===========================================================================

const sessionAt = (t) => ({ billing: { tier: t, reason: "past_due", pastDueSince: null, since: ago(DAY) } });

test("R1-8: `ok`, `warning` and `exempt` sessions pass BOTH guards", () => {
  for (const t of ["exempt", "ok", "warning"]) {
    assert.equal(enforce.requireBillingReadable(sessionAt(t)).ok, true, `read ${t}`);
    assert.equal(enforce.requireBillingWritable(sessionAt(t)).ok, true, `write ${t}`);
  }
});

test("R1-8: `readonly` allows GETs but refuses mutations with 402", () => {
  assert.equal(enforce.requireBillingReadable(sessionAt("readonly")).ok, true);
  const gate = enforce.requireBillingWritable(sessionAt("readonly"));
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 402);
  assert.equal(gate.body.ok, false);
  assert.equal(gate.body.billing.tier, "readonly");
  assert.equal(gate.response.status, 402, "a real 402 NextResponse the route returns verbatim");
});

test("R1-8: `blocked` refuses BOTH — the paywall holds for raw API calls too", () => {
  const read = enforce.requireBillingReadable(sessionAt("blocked"));
  const write = enforce.requireBillingWritable(sessionAt("blocked"));
  assert.equal(read.ok, false);
  assert.equal(read.status, 402);
  assert.equal(write.ok, false);
  assert.equal(write.status, 402);
});

test("R2-9: a session-less caller (the possession-token branch) is NEVER gated", () => {
  // This is the mechanism that keeps a blocked agency's seafarers whole: the token
  // branches of the dual trust-model routes never carry a session, so both guards
  // fail open there and /share, /portal and the file/CV downloads keep serving.
  for (const s of [null, undefined, {}, { billing: undefined }]) {
    assert.equal(enforce.requireBillingReadable(s).ok, true);
    assert.equal(enforce.requireBillingWritable(s).ok, true);
  }
});

test("R2-9: every dual trust-model route carries the session-branch marker", () => {
  const appDir = path.join(originalCwd, "app", "api");
  const dual = [
    "files/[name]/route.ts",
    "comments/route.ts",
    "documents/route.ts",
    "profile-photo/[id]/route.ts",
    "contract/[id]/route.ts",
    "sea-service/route.ts",
  ];
  for (const rel of dual) {
    const file = path.join(appDir, ...rel.split("/"));
    assert.ok(fs.existsSync(file), `${rel} exists`);
    const src = fs.readFileSync(file, "utf8");
    assert.ok(
      /billing-guard:\s*session-branch/.test(src) || /requireBilling(Readable|Writable)/.test(src),
      `${rel} must bind the billing guard to the agent-session branch`
    );
  }
});

// ===========================================================================
// Impersonation + dev door bypass (the session-level exemptions)
// ===========================================================================

test("impersonation and the dev door carry an exempt state that passes both guards", () => {
  const impersonating = { billing: { ...enforce.EXEMPT_STATE, reason: "impersonation" } };
  const devDoor = { billing: { ...enforce.EXEMPT_STATE, reason: "dev-login" } };
  for (const s of [impersonating, devDoor]) {
    assert.equal(s.billing.tier, "exempt");
    assert.equal(enforce.requireBillingReadable(s).ok, true);
    assert.equal(enforce.requireBillingWritable(s).ok, true);
    assert.equal(enforce.shouldShowBillingBanner(s.billing), false);
  }
});

test("agent-session.ts really does stamp the exempt state on both bypass branches", () => {
  const src = fs.readFileSync(path.join(originalCwd, "lib", "agent-session.ts"), "utf8");
  assert.match(src, /reason:\s*"impersonation"/, "the impersonation branch is exempt");
  assert.match(src, /reason:\s*"dev-login"/, "the dev door is exempt");
  // FR1-9b — F6/finding 22 replaced the unconditional `billingStateForAgent(agent.id)`
  // (its own full db.json parse) with a SNAPSHOT the write check already needed. The
  // grep follows the seam it is meant to lock.
  assert.match(src, /billingTierForAgent\(db, agent\.id\)/, "the real Google branch computes a live tier from ONE snapshot");
  assert.match(src, /billingProfileNeedsWrite\(db, agent\.id\)/, "…and only writes when the snapshot says a write is needed");
  assert.match(src, /ensureBillingProfileForAgent\(agent\.id\)/, "R1-9 lazy profile creation on first session");
});

// ===========================================================================
// Payment restores access with no restart (decision 6)
// ===========================================================================

test("clearing pastDueSince returns a blocked agency straight to `ok`", () => {
  const blocked = tier({ subscriptionStatus: "past_due", pastDueSince: ago(45 * DAY) });
  assert.equal(blocked.tier, "blocked");
  // This is exactly what the `invoice.paid` webhook writes.
  const paid = tier({ subscriptionStatus: "active", pastDueSince: null, paymentMethodAttached: true });
  assert.equal(paid.tier, "ok");
});
