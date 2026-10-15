// EXECUTED billing-enforcement tests — the real route handlers, driven end to end.
//
// The plan's R1-8 ("a blocked agent's raw API calls 402") and R2-9 ("a blocked agency's
// seafarers are NEVER blocked") were previously asserted by GREPPING the source for a
// guard symbol. That is test theater: it proves an import exists, not that a request is
// answered correctly — and findings 8 and 19 are exactly the bugs a grep cannot see
// (the guard WAS imported and called; it was called in the wrong ORDER).
//
// Everything here runs the ACTUAL shipped handlers through the shared vm harness
// (tests/_route-harness.mjs, extracted from batch2-routes per FR1-10d) with the REAL
// lib/billing-enforce, lib/access and lib/billing-store. Only the edges are stubbed:
// next/server, @/lib/db (a synthetic in-memory store) and @/lib/agent-session.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/billing-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Route modules resolve upload/data dirs from cwd at LOAD time — keep them in a temp
// tree so a test run never writes into the working copy.
const originalCwd = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-billing-routes-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
process.chdir(TMP);

const { createRouteHarness, API, APP_DIR, JSX_FRAGMENT } = await import("./_route-harness.mjs");

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---- Fixture ---------------------------------------------------------------

const T0 = "2026-07-01T00:00:00.000Z";
let seq = 0;

/**
 * agent:A holds a live grant on s1 (whose owner share token is `own-s1`).
 * agent:Z holds a live grant on s9 — a FOREIGN tenant, for the oracle probe.
 */
function freshDB() {
  return {
    agents: [
      { id: "agent:A", orgName: "Org A Crewing", contact: "", createdAt: T0 },
      { id: "agent:Z", orgName: "Org Z Crewing", contact: "", createdAt: T0 },
    ],
    seafarers: [
      {
        id: "s1", name: "Own Seaman", rank: "AB", state: "review",
        shareToken: "own-s1", openShareToken: "own-s1", emailShareToken: "em-s1",
        selfProfile: {}, allowedEmails: [], createdAt: T0,
      },
      {
        id: "s9", name: "Foreign Seaman", rank: "AB", state: "review",
        shareToken: "own-s9", openShareToken: "own-s9", emailShareToken: "em-s9",
        selfProfile: {}, allowedEmails: [], createdAt: T0,
      },
    ],
    documents: [
      {
        id: "d1", seafarerId: "s1", title: "Passport", docType: "Passport",
        docCategory: null, estonianCode: null, fileName: null, createdAt: T0,
      },
      {
        id: "d9", seafarerId: "s9", title: "Foreign Passport", docType: "Passport",
        docCategory: null, estonianCode: null, fileName: null, createdAt: T0,
      },
    ],
    comments: [], restHours: [], seaService: [], assignments: [],
    accessGrants: [
      {
        id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g1", grantedAt: T0,
        revokedAt: null, expiresAt: null, createdAt: T0,
      },
      {
        id: "g9", seafarerId: "s9", agentId: "agent:Z", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g9", grantedAt: T0,
        revokedAt: null, expiresAt: null, createdAt: T0,
      },
    ],
    requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
    circulars: [], circularReplies: [], docRequests: [], profileChanges: [],
    impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
    issuedSeaTerms: [], clientPortals: [], vacancies: [],
    billingProfiles: [], billingUsage: [], stripeEvents: [], billingBaseline: [],
    billingSettings: {
      goLiveAt: "2026-01-01T00:00:00.000Z",
      tosVersion: "2026-08-draft-1",
      stripeBaseProductId: null, stripeUsageProductId: null, stripeMeterId: null,
      stripePortalConfigId: null,
      defaults: { baseEurMonthly: 300, perSeafarerEur: 2 },
    },
  };
}

let db = freshDB();
let currentSession = null;

const dbStub = {
  readDB: () => db,
  updateDB: (fn) => Promise.resolve(fn(db)),
  transact: (fn) => Promise.resolve(fn(db, () => {})),
  serialize: (fn) => Promise.resolve(fn()),
  appendAudit: () => Promise.resolve({}),
  readAccessLog: () => [],
  readConsentEvents: () => [],
  readBoardEvents: () => [],
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
  newShareTokens: () => ({ openShareToken: `tok-${++seq}`, emailShareToken: `tok-${++seq}`, shareToken: `tok-${++seq}` }),
  requestManualVerification: () => Promise.resolve(null),
  confirmManualVerification: () => Promise.resolve(null),
  closeManualVerification: () => Promise.resolve(null),
  EMPTY_BILLING_SETTINGS: {
    goLiveAt: null, tosVersion: "2026-08-draft-1",
    stripeBaseProductId: null, stripeUsageProductId: null, stripeMeterId: null,
    stripePortalConfigId: null,
    defaults: { baseEurMonthly: 300, perSeafarerEur: 2 },
  },
  AUDIT_NO_IMPERSONATION: Symbol("no-impersonation"),
};

/** Marker components — the paywall test asserts on the returned element's TYPE. */
function BillingPaywall() {}
function BillingBanner() {}

const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub,
    "@/lib/agent-session": { agentSession: async () => currentSession, isDevLoginEnabled: false, DEV_COOKIE: "x" },
    "@/auth": { auth: async () => null },
    "@/lib/notify": { send: async () => ({ ok: true }) },
    "@/components/BillingPaywall": { BillingPaywall },
    "@/components/BillingBanner": { BillingBanner },
  },
});

const commentsRoute = loadTs(path.join(API, "comments", "route.ts"));
const documentsRoute = loadTs(path.join(API, "documents", "route.ts"));
const seaServiceRoute = loadTs(path.join(API, "sea-service", "route.ts"));
const enforcedTemplate = loadTs(path.join(APP_DIR, "agent", "(enforced)", "template.tsx"));
const billingProfileRoute = loadTs(path.join(API, "billing", "profile", "route.ts"));

// ---- Request/session helpers ------------------------------------------------

const req = ({ query = {}, body = null } = {}) => ({
  nextUrl: { searchParams: new URLSearchParams(query) },
  json: async () => body ?? {},
});

/** A signed-in agent session carrying a billing state at the given tier. */
function sessionAt(tier, agentId = "agent:A") {
  return {
    user: { name: `${agentId}-user`, email: `${agentId}@example.com` },
    agentId,
    billing: {
      tier,
      reason: tier === "exempt" ? "exempt-agent" : "past_due",
      pastDueSince: null,
      since: "2026-08-01T00:00:00.000Z",
    },
  };
}

const asBlockedAgent = (agentId = "agent:A") => { currentSession = sessionAt("blocked", agentId); };
const asOkAgent = (agentId = "agent:A") => { currentSession = sessionAt("ok", agentId); };
const anonymous = () => { currentSession = null; };
const reset = () => { db = freshDB(); currentSession = null; };

/** Every route answer carries `.status`, whether it is a real Response or the
 *  NextResponse-shaped object the harness returns. */
const statusOf = (res) => res.status;

// ===========================================================================
// R1-8 — the paywall really does hold for raw API calls (EXECUTED, not grepped)
// ===========================================================================

test("F3 blocked-402 executed: a blocked agent session gets a real 402 Response from a data route handler", async () => {
  reset();
  asBlockedAgent();

  const commentsGet = await commentsRoute.GET(req({ query: { seafarerId: "s1" } }));
  assert.equal(statusOf(commentsGet), 402, "comments GET denies a blocked agent");
  assert.ok(commentsGet instanceof Response, "a real Response the route returns verbatim");
  const commentsBody = JSON.parse(await commentsGet.clone().text());
  assert.equal(commentsBody.billing.tier, "blocked");

  const docsPatch = await documentsRoute.PATCH(req({ body: { documentId: "d1", title: "Renamed" } }));
  assert.equal(statusOf(docsPatch), 402, "documents PATCH denies a blocked agent");
  assert.equal(db.documents.find((d) => d.id === "d1").title, "Passport", "and wrote nothing");

  const seaPost = await seaServiceRoute.POST(
    req({ body: { seafarerId: "s1", vessel: "MV X", rank: "AB", signOn: "2026-01-01", signOff: "2026-02-01" } })
  );
  assert.equal(statusOf(seaPost), 402, "sea-service POST denies a blocked agent");
  assert.equal(db.seaService.length, 0);

  // `readonly` still serves GETs; only mutations are refused (decision 6's middle rung).
  currentSession = sessionAt("readonly");
  assert.equal(statusOf(await commentsRoute.GET(req({ query: { seafarerId: "s1" } }))), 200);
  assert.equal(statusOf(await documentsRoute.PATCH(req({ body: { documentId: "d1", title: "Renamed" } }))), 402);
});

// ===========================================================================
// R2-9 / decision 6 — the seafarer is NEVER blocked (finding 8)
// ===========================================================================

test("F3 token-402: a valid owner share token gets 200 from documents PATCH even when the browser also carries a blocked-agency session", async () => {
  reset();
  asBlockedAgent();
  // FINDING 8: `requireBillingWritable` ran BEFORE the token branch, so a seafarer
  // working in their own /share link 402'd the moment the shared browser also carried a
  // blocked agency's cookie — the exact "seafarers are never blocked" promise (R2-9,
  // decision 6) broken by ordering alone.
  const res = await documentsRoute.PATCH(
    req({ body: { documentId: "d1", token: "own-s1", title: "My passport" } })
  );

  assert.equal(statusOf(res), 200, "the OWNER's token authorises regardless of the agency's tier");
  assert.equal(db.documents.find((d) => d.id === "d1").title, "My passport");

  // A token for ANOTHER seafarer is not a bypass — it authorises nothing.
  const foreign = await documentsRoute.PATCH(
    req({ body: { documentId: "d9", token: "own-s1", title: "Not mine" } })
  );
  assert.equal(statusOf(foreign), 404);
  assert.equal(db.documents.find((d) => d.id === "d9").title, "Foreign Passport");
});

test("F3 FR1-7: the token fall-through acts as the OWNER — it cannot exercise agent powers", async () => {
  reset();
  asBlockedAgent();
  // A blocked agency must not reach agent-only audit facts by riding a seafarer's token.
  const forged = await documentsRoute.PATCH(
    req({
      body: {
        documentId: "d1", token: "own-s1",
        reviewerChecked: true, checkedVia: "registry-portal", checkedBy: "Agency Reviewer",
      },
    })
  );
  assert.equal(statusOf(forged), 403, "registry-check sign-off is AGENT-only");
  const doc = db.documents.find((d) => d.id === "d1");
  assert.ok(!doc.reviewerChecked, "no reviewer sign-off was recorded");

  // reviewerChecked alone is silently IGNORED for an owner actor (it is not an error),
  // and the ordinary owner edit still lands.
  const owner = await documentsRoute.PATCH(
    req({ body: { documentId: "d1", token: "own-s1", reviewerChecked: true, title: "Owner edit" } })
  );
  assert.equal(statusOf(owner), 200);
  const after = db.documents.find((d) => d.id === "d1");
  assert.equal(after.title, "Owner edit");
  assert.ok(!after.reviewerChecked, "an owner can never stamp their own document as reviewer-checked");

  // Sanity: the SAME body from a healthy agent DOES record the sign-off, so the test
  // above is pinning the actor demotion, not a broken feature.
  reset();
  asOkAgent();
  const agent = await documentsRoute.PATCH(
    req({ body: { documentId: "d1", reviewerChecked: true, checkedVia: "registry-portal" } })
  );
  assert.equal(statusOf(agent), 200);
  assert.equal(db.documents.find((d) => d.id === "d1").reviewerChecked, true);
});

test("F3 sea-service: an owner token still writes the seaman's own discharge book while the agency is blocked", async () => {
  reset();
  asBlockedAgent();
  const res = await seaServiceRoute.POST(
    req({
      body: {
        seafarerId: "s1", token: "own-s1", vessel: "MV Own", rank: "AB",
        signOn: "2026-01-01", signOff: "2026-02-01",
      },
    })
  );
  assert.equal(statusOf(res), 200);
  assert.equal(db.seaService.length, 1);
  assert.equal(db.seaService[0].recordedBy, "seaman", "recorded as the SEAMAN, never as the blocked agency");
});

// ===========================================================================
// FINDING 19 — the cross-tenant existence oracle
// ===========================================================================

test("F3 no oracle: a blocked agent probing a foreign-tenant id and a nonexistent id both get 404, never 402", async () => {
  reset();
  asBlockedAgent();
  // FINDING 19: 404-for-unknown was resolved BEFORE the billing 402, which fired before
  // `checkAccess` — so a blocked agent could tell "this id exists in SOME tenant" (402)
  // from "no such id" (404), enumerating other agencies' rosters for free.
  const foreign = await commentsRoute.GET(req({ query: { seafarerId: "s9" } }));
  const missing = await commentsRoute.GET(req({ query: { seafarerId: "does-not-exist" } }));
  assert.equal(statusOf(foreign), 404, "a foreign-tenant id is indistinguishable…");
  assert.equal(statusOf(missing), 404, "…from an id that does not exist at all");

  const foreignDoc = await documentsRoute.PATCH(req({ body: { documentId: "d9", title: "x" } }));
  const missingDoc = await documentsRoute.PATCH(req({ body: { documentId: "nope", title: "x" } }));
  assert.equal(statusOf(foreignDoc), 404);
  assert.equal(statusOf(missingDoc), 404);

  const foreignSea = await seaServiceRoute.GET(req({ query: { seafarerId: "s9" } }));
  const missingSea = await seaServiceRoute.GET(req({ query: { seafarerId: "nope" } }));
  assert.equal(statusOf(foreignSea), 404);
  assert.equal(statusOf(missingSea), 404);

  // An OK agent sees the same 404 pair — the fix changes the blocked tier's answers to
  // match the healthy tier's, not the other way round.
  asOkAgent();
  assert.equal(statusOf(await commentsRoute.GET(req({ query: { seafarerId: "s9" } }))), 404);
  assert.equal(statusOf(await commentsRoute.GET(req({ query: { seafarerId: "nope" } }))), 404);
});

test("F3 FR1-8: the pre-existing ANONYMOUS 404/401 asymmetry is unchanged — no NEW oracle is introduced", async () => {
  reset();
  anonymous();
  // Recorded as an ACCEPTED RESIDUAL, not claimed fixed: it predates this branch (an
  // unknown id 404s before auth; a known id with no credentials 401s). The agent-side
  // 402/404 oracle above is the fix target; this pair simply must not get worse.
  const known = await commentsRoute.GET(req({ query: { seafarerId: "s1" } }));
  const unknown = await commentsRoute.GET(req({ query: { seafarerId: "nope" } }));
  assert.equal(statusOf(known), 401);
  assert.equal(statusOf(unknown), 404);
});

// ===========================================================================
// FINDING 6 — the paywall must re-evaluate on soft navigation
// ===========================================================================

test("F3 soft-nav paywall: the (enforced) gate lives in template.tsx (re-rendered per navigation) and returns BillingPaywall for a blocked session", async () => {
  reset();
  // FINDING 6: App Router PRESERVES layouts across <Link> navigations. With the gate in
  // `layout.tsx` an agency whose tier flipped to `blocked` mid-session kept browsing its
  // board — fresh tenant data, page after page — until a hard reload. A template
  // re-renders on EVERY navigation.
  asBlockedAgent();
  const blocked = await enforcedTemplate.default({ children: "BOARD" });
  assert.equal(blocked.type, BillingPaywall, "the paywall REPLACES the children entirely");
  assert.equal(blocked.props.state.tier, "blocked");

  // A warning tier renders the banner ABOVE the children, never instead of them.
  currentSession = sessionAt("warning");
  const warning = await enforcedTemplate.default({ children: "BOARD" });
  assert.equal(warning.type, JSX_FRAGMENT);
  assert.ok(
    JSON.stringify(warning.props.children).includes("BOARD"),
    "the page still renders under the banner"
  );

  // Signed out: the template gets out of the way so each page shows its own SignInGate.
  anonymous();
  const signedOut = await enforcedTemplate.default({ children: "SIGN-IN GATE" });
  assert.equal(signedOut.type, JSX_FRAGMENT);
  assert.equal(signedOut.props.children, "SIGN-IN GATE");
});

test("F3 structural lock: the gate file is template.tsx and no gating layout.tsx remains", () => {
  const dir = path.join(APP_DIR, "agent", "(enforced)");
  assert.ok(fs.existsSync(path.join(dir, "template.tsx")), "template.tsx is the seam");
  const layout = path.join(dir, "layout.tsx");
  if (fs.existsSync(layout)) {
    assert.ok(
      !/\bBillingPaywall\b/.test(fs.readFileSync(layout, "utf8")),
      "a layout must never carry the paywall again — it would not re-run on soft navigation"
    );
  }
});

// ===========================================================================
// F4 / FINDING 13 — the profile PUT was a silent FULL REPLACE
// ===========================================================================

/** The stored business details a partial PUT must never touch. */
const BUSINESS = {
  legalName: "Acme Crewing OÜ",
  regCode: "12345678",
  vatNumber: "EE101234567",
  billingEmail: "billing@acme.example",
  address: { line1: "Sadama 1", line2: "Floor 3", city: "Tallinn", postal: "10111", country: "EE" },
};

async function seedBusinessProfile() {
  reset();
  asOkAgent();
  const res = await billingProfileRoute.PUT(req({ body: BUSINESS }));
  assert.equal(statusOf(res), 200, "the full save works");
  return res.body.profile;
}

test("F4 partial PUT: {acceptTos:true} preserves every stored business field and records tosAcceptedAt once", async () => {
  await seedBusinessProfile();
  // FINDING 13: `clean(undefined)` returns "", and there was no merge-with-existing, so
  // the ToS checkbox — which posts `{"acceptTos": true}` on its own — blanked the legal
  // name, reg code, VAT number, billing e-mail and the entire address, with a 200.
  const res = await billingProfileRoute.PUT(req({ body: { acceptTos: true } }));
  assert.equal(statusOf(res), 200);
  const p = res.body.profile;

  assert.equal(p.legalName, BUSINESS.legalName);
  assert.equal(p.regCode, BUSINESS.regCode);
  assert.equal(p.vatNumber, BUSINESS.vatNumber);
  assert.equal(p.billingEmail, BUSINESS.billingEmail);
  assert.deepEqual(p.address, BUSINESS.address);
  assert.ok(p.tosAcceptedAt, "…and the acceptance IS recorded");
  assert.equal(p.tosVersion, "2026-08-draft-1");

  // Acceptance is append-only: a later save never re-stamps or un-accepts it.
  const firstAccepted = p.tosAcceptedAt;
  const again = await billingProfileRoute.PUT(req({ body: { acceptTos: true } }));
  assert.equal(again.body.profile.tosAcceptedAt, firstAccepted, "recorded ONCE");
});

test("F4 PUT merge: updating only billingEmail leaves the address intact, and the address merges per subfield", async () => {
  await seedBusinessProfile();

  const emailOnly = await billingProfileRoute.PUT(req({ body: { billingEmail: "new@acme.example" } }));
  assert.equal(statusOf(emailOnly), 200);
  assert.equal(emailOnly.body.profile.billingEmail, "new@acme.example");
  assert.equal(emailOnly.body.profile.legalName, BUSINESS.legalName);
  assert.deepEqual(emailOnly.body.profile.address, BUSINESS.address);

  const cityOnly = await billingProfileRoute.PUT(req({ body: { address: { city: "Tartu" } } }));
  assert.equal(statusOf(cityOnly), 200);
  const addr = cityOnly.body.profile.address;
  assert.equal(addr.city, "Tartu");
  assert.equal(addr.line1, BUSINESS.address.line1, "the street survives a city-only edit");
  assert.equal(addr.postal, BUSINESS.address.postal);
  assert.equal(addr.country, BUSINESS.address.country);

  // An EXPLICIT empty string is still a real edit — merging is not "never clear".
  const cleared = await billingProfileRoute.PUT(req({ body: { vatNumber: "" } }));
  assert.equal(cleared.body.profile.vatNumber, null, "an explicit clear is honoured");
  assert.equal(cleared.body.profile.legalName, BUSINESS.legalName);
});

test("F4 PUT validation runs on the MERGED result, not on the fragment", async () => {
  await seedBusinessProfile();
  const bad = await billingProfileRoute.PUT(req({ body: { billingEmail: "not-an-email" } }));
  assert.equal(statusOf(bad), 400);
  assert.match(bad.body.error, /e-mail/);
  assert.equal(
    (await billingProfileRoute.GET()).body.profile.billingEmail,
    BUSINESS.billingEmail,
    "a rejected PUT changes nothing"
  );

  const badCountry = await billingProfileRoute.PUT(req({ body: { address: { country: "ZZ" } } }));
  assert.equal(statusOf(badCountry), 400);
  assert.match(badCountry.body.error, /ISO-3166/);
});

test("F4 C5: GET creates the profile through the ensure RETURN value (no unreachable 500 branch)", async () => {
  reset();
  asOkAgent();
  assert.equal(db.billingProfiles.length, 0);
  const res = await billingProfileRoute.GET();
  assert.equal(statusOf(res), 200);
  assert.equal(res.body.profile.agentId, "agent:A");
  assert.equal(db.billingProfiles.length, 1, "create-if-absent ran exactly once");
});

// ===========================================================================
// F5 / FINDING 9 — the tenant-isolation rule, unit-tested against fixtures
// ===========================================================================

const { classifyAgentModule, GUARD_SYMBOLS, BILLING_STORE_SYMBOLS } = await import("./_isolation-rules.mjs");

test("F5 rule self-test: an agent route with a billing symbol AND a raw readDB is an UNGUARDED LEAK", () => {
  // FINDING 9: eight lib/billing-store symbols were APPENDED to GUARD_SYMBOLS, which is
  // an ANY-match list. This exact module — resolve the agent, call a billing accessor,
  // then read tenant data straight off the store — therefore PASSED a scan that would
  // have flagged it before billing landed. The tenant guard had been diluted by an
  // unrelated feature, and nothing tested the guard itself.
  const attack = `
    import { agentSession } from "@/lib/agent-session";
    import { recordUsageForPeriod } from "@/lib/billing-store";
    import { readDB } from "@/lib/db";
    export async function GET() {
      const session = await agentSession();
      await recordUsageForPeriod(session.agentId, "2026-09", { quantity: 1, billableSeafarerIds: [] });
      return Response.json({ seafarers: readDB().seafarers });
    }
  `;
  assert.equal(classifyAgentModule(attack), "UNGUARDED LEAK");

  // The two halves on their own are each legitimate.
  const billingOnly = `
    import { agentSession } from "@/lib/agent-session";
    import { usageForAgent } from "@/lib/billing-store";
    export async function GET() {
      const session = await agentSession();
      return Response.json({ usage: usageForAgent(session.agentId) });
    }
  `;
  assert.equal(classifyAgentModule(billingOnly), "BILLING-SCOPED");

  const tenantGuarded = `
    import { agentSession } from "@/lib/agent-session";
    import { checkAccess } from "@/lib/access";
    import { readDB } from "@/lib/db";
    export async function GET() {
      const session = await agentSession();
      if (!checkAccess(session.agentId, "s1").allowed) return new Response(null, { status: 404 });
      return Response.json({ db: readDB().documents });
    }
  `;
  assert.equal(classifyAgentModule(tenantGuarded), "GUARDED");

  // updateDB and transact are raw-store indicators too, not just readDB.
  for (const raw of ["updateDB", "transact"]) {
    const src = `
      import { agentSession } from "@/lib/agent-session";
      import { setBillingStripeRefs } from "@/lib/billing-store";
      import { ${raw} } from "@/lib/db";
      export async function POST() { await ${raw}((db) => db); }
    `;
    assert.equal(classifyAgentModule(src), "UNGUARDED LEAK", raw);
  }

  // An explicit, greppable marker is still the only other way out.
  assert.equal(
    classifyAgentModule(`// isolation-guard: exempt
import { agentSession } from "@/lib/agent-session";`),
    "exempt"
  );
});

test("F5 the two symbol lists are DISJOINT — the billing symbols never re-dilute the tenant guard", () => {
  const overlap = BILLING_STORE_SYMBOLS.filter((s) => GUARD_SYMBOLS.includes(s));
  assert.deepEqual(overlap, [], "re-merging the lists would restore finding 9 exactly");
  // And the tenant list is the pre-billing one: accessors from lib/access, lib/agentData
  // and lib/required-docs-store only — nothing named "Billing".
  assert.ok(!GUARD_SYMBOLS.some((s) => /Billing/i.test(s)));
});

// ===========================================================================
// R3-4 / R3-FR1-2 (OWNER DECISION 2026-08-20) — the admin rate route rejects an
// accidental €0 base AND enforces a €0.10 per-seafarer FLOOR: flat-fee / €0 per-seafarer
// is DISALLOWED. Blank fields never reach the server (the client omits them), so the
// server floor is the load-bearing backstop.
// ===========================================================================

let currentAdmin = { user: { email: "admin@docka.me" } };
const adminHarness = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub, // the SAME live in-memory db as the routes above
    "@/lib/admin-session": { adminSession: async () => currentAdmin },
    "@/lib/admin-audit": { recordAdminAction: async () => ({}) },
    // No Stripe propagation in-test: stripeConfigured() false short-circuits applyRateChange.
    "@/lib/stripe": { applyRateChange: async () => null, stripeConfigured: () => false },
  },
});
const adminBillingRoute = adminHarness.loadTs(path.join(API, "admin", "billing", "route.ts"));
const putRates = (body) => adminBillingRoute.PUT({ json: async () => body });

test("R3-4 / R3-FR1-2 server rejects a zero/negative BASE and any per-seafarer below the €0.10 floor (0 and 0.05 included), but ACCEPTS exactly €0.10", async () => {
  reset();
  currentAdmin = { user: { email: "admin@docka.me" } };

  assert.equal(statusOf(await putRates({ agentId: "agent:A", baseEurMonthly: 0 })), 400, "€0 base is the accidental-clear footgun");
  assert.equal(statusOf(await putRates({ agentId: "agent:A", baseEurMonthly: -5 })), 400, "a negative base is rejected");
  assert.equal(statusOf(await putRates({ agentId: "agent:A", perSeafarerEur: -1 })), 400, "a negative per-seafarer is rejected");

  // OWNER DECISION 2026-08-20 — flat-fee / €0 per-seafarer is DISALLOWED; anything below
  // the €0.10 floor is a 400.
  assert.equal(statusOf(await putRates({ agentId: "agent:A", perSeafarerEur: 0 })), 400, "€0 per-seafarer is no longer allowed");
  assert.equal(statusOf(await putRates({ agentId: "agent:A", perSeafarerEur: 0.05 })), 400, "below the €0.10 floor is rejected");

  // base>0 + per-seafarer EXACTLY €0.10 is the minimum legal deal — ACCEPTED.
  const floor = await putRates({ agentId: "agent:A", baseEurMonthly: 275, perSeafarerEur: 0.1 });
  assert.equal(statusOf(floor), 200, "exactly €0.10 per-seafarer is accepted (R3-FR1-2 floor)");
  const profA = () => db.billingProfiles.find((p) => p.agentId === "agent:A");
  assert.equal(profA().baseEurMonthly, 275);
  assert.equal(profA().perSeafarerEur, 0.1);

  // An in-range base really updates the stored rate.
  assert.equal(statusOf(await putRates({ agentId: "agent:A", baseEurMonthly: 320 })), 200);
  assert.equal(profA().baseEurMonthly, 320);
});

// ===========================================================================
// R3-8 — the terms page shows the LIVE tosVersion (getBillingSettings), not the
// compile-time EMPTY_BILLING_SETTINGS constant. Pinned on the server component
// (no hooks — invocable, matching the F3 pattern).
// ===========================================================================

const termsHarness = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub, // the SAME live in-memory db; getBillingSettings reads it for real
    "next/link": { __esModule: true, default: (props) => ({ type: "a", props }) },
  },
});
const termsPage = termsHarness.loadTs(path.join(APP_DIR, "terms", "page.tsx"));

/** Flatten a jsx-runtime element tree ({type, props}) into its rendered text. */
function collectText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && node.props) return collectText(node.props.children);
  return "";
}

test("R3-8 terms page shows the live tosVersion, not the compile-time default", async () => {
  reset();
  db.billingSettings.tosVersion = "2026-09-LIVE-7";
  const text = collectText(termsPage.default());
  assert.ok(text.includes("Version 2026-09-LIVE-7"), "renders the live billingSettings.tosVersion");
  assert.ok(!text.includes("2026-08-draft-1"), "not the seeded/default version");
});
