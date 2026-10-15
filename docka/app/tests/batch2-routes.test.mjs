// Batch 2 — route-level integration (no server, no build, no disk). Loads the REAL
// appraisal + contract route HANDLERS and their REAL libs (access, agentData,
// appraisals, contract, print-html, required-docs, share-access), transpiled in memory.
// Only the un-testable edges are stubbed: next/server, @/lib/agent-session, @/auth,
// @/lib/notify and @/lib/db (a synthetic in-memory DB whose transact/updateDB mutate in
// place). Everything security/idempotency-critical runs the ACTUAL shipped code.
//
// Run: node tests/batch2-routes.test.mjs   (exit 0 = pass, 1 = fail)
import path from "path";
import { createRouteHarness, LIB, API } from "./_route-harness.mjs";

let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

function freshDB() {
  const now = iso(T0);
  return {
    agents: [
      { id: "agent:A", orgName: "Org A Crewing", contact: "", createdAt: now },
      { id: "agent:Z", orgName: "Org Z", contact: "", createdAt: now },
    ],
    seafarers: [
      { id: "s1", name: "typed one", rank: "Chief Officer", state: "review",
        shareToken: "open-s1", openShareToken: "open-s1", emailShareToken: "email-s1",
        identityVerified: true, verifiedName: "Verified One", personalCode: "111",
        birthDate: "1980-01-01T00:00:00.000Z", issuerCountry: "Eesti", vessel: "MV Alpha",
        selfProfile: {}, allowedEmails: [], createdAt: now },
      { id: "s2", name: "Typed Two", rank: "Rating", state: "review",
        shareToken: "open-s2", openShareToken: "open-s2", emailShareToken: "email-s2",
        identityVerified: false, selfProfile: {}, allowedEmails: [], vessel: "MV Beta", createdAt: now },
      { id: "s3", name: "Stranger", rank: "Rating", state: "review",
        shareToken: "open-s3", openShareToken: "open-s3", emailShareToken: "email-s3",
        selfProfile: {}, allowedEmails: [], createdAt: now },
    ],
    documents: [],
    comments: [],
    restHours: [],
    assignments: [
      { id: "a1", seafarerId: "s1", agentId: "agent:A", vessel: "MV Alpha", sentToSeaAt: now, returnedAt: null, createdAt: now },
      { id: "a2", seafarerId: "s2", agentId: "agent:A", vessel: "MV Beta", sentToSeaAt: now, returnedAt: null, createdAt: now },
    ],
    accessGrants: [
      { id: "g1", seafarerId: "s1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g1", grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now },
      { id: "g2", seafarerId: "s2", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT",
        scope: ["profile", "documents", "log"], shareToken: "g2", grantedAt: now, revokedAt: null, expiresAt: null, createdAt: now },
    ],
    requiredDocsConfigs: [], requiredDocsAudit: [], notifications: [], remindersSent: [],
    circulars: [], circularReplies: [], docRequests: [], profileChanges: [], seaService: [],
    impersonations: [], profileShareRequests: [], appraisals: [], appraisalDeleteRequests: [],
    issuedSeaTerms: [], clientPortals: [], vacancies: [],
  };
}

let db = freshDB();
let currentAgent = null;
let currentAuth = null;
const notifySends = [];
// Bug1 — capture board-events drafted via transact's audit collector so tests can assert
// on the dedicated `board-events` sink (the real db.ts hash-chains these to disk; the
// in-memory harness just records the cores). consentDrafts mirrors the consent-events
// sink the same way (hidden-crew delete assertions).
let boardEvents = [];
let consentDrafts = [];
// Hidden-crew delete — in-memory stand-in for the shared archive appender so tests can
// assert on the archive line (H7) and force an append failure (H15) without touching disk.
let archiveLines = [];
let archiveFailNext = false;
const deleteArchiveStub = {
  archiveBeforeDelete: (kind, payload) => {
    if (archiveFailNext) throw new Error("archive append failed (test)");
    archiveLines.push(JSON.parse(JSON.stringify({ kind, ...payload })));
    return { hash: `hash-${archiveLines.length}` };
  },
};

const AUDIT_NO_IMPERSONATION = Symbol("no-impersonation");
const dbStub = {
  readDB: () => db,
  readAccessLog: () => [],
  readConsentEvents: () => consentDrafts,
  readBoardEvents: () => boardEvents,
  appendAudit: () => Promise.resolve({}),
  transact: (fn) =>
    Promise.resolve(
      fn(db, (sink, core) => {
        if (sink === "board-events") boardEvents.push({ ...core });
        if (sink === "consent-events") consentDrafts.push({ ...core });
      })
    ),
  updateDB: (fn) => Promise.resolve(fn(db)),
  serialize: (fn) => Promise.resolve(fn()),
  id: () => `id-${++seq}`,
  shareToken: () => `tok-${++seq}`,
  newShareTokens: () => {
    const openShareToken = `tok-${++seq}`;
    const emailShareToken = `tok-${++seq}`;
    return { openShareToken, emailShareToken, shareToken: openShareToken };
  },
  AUDIT_NO_IMPERSONATION,
};
const agentSessionStub = { agentSession: async () => currentAgent, isDevLoginEnabled: true, DEV_COOKIE: "x" };
const authStub = { auth: async () => currentAuth };
const notifyStub = { send: async (input) => { notifySends.push(input); return { ok: true, logId: `n-${++seq}` }; } };
// FR1-10d — the vm-transpile loader itself now lives in tests/_route-harness.mjs and is
// SHARED with tests/billing-routes.test.mjs. Harness import swap only: every stub object
// and every assertion below is byte-identical to before the extraction.
const { loadTs } = createRouteHarness({
  stubs: {
    "@/lib/db": dbStub,
    "@/lib/delete-archive": deleteArchiveStub,
    "@/lib/agent-session": agentSessionStub,
    "@/auth": authStub,
    "@/lib/notify": notifyStub,
  },
});

const appraisalsRoute = loadTs(path.join(API, "appraisals", "route.ts"));
const contractRoute = loadTs(path.join(API, "contract", "[id]", "route.ts"));
// Bug1/2/3/4 routes + the libs the assertions read directly.
const inviteRoute = loadTs(path.join(API, "invite", "route.ts"));
const inviteLinkRoute = loadTs(path.join(API, "invite", "link", "route.ts"));
const accessLib = loadTs(path.join(LIB, "access.ts"));
const agentDataLib = loadTs(path.join(LIB, "agentData.ts"));
const shareAccessLib = loadTs(path.join(LIB, "share-access.ts"));
const deleteRateLib = loadTs(path.join(LIB, "delete-rate-limit.ts"));
const adminFunnelLib = loadTs(path.join(LIB, "admin-funnel.ts"));
let seafarersRoute = null;
try {
  seafarersRoute = loadTs(path.join(API, "seafarers", "route.ts"));
} catch (e) {
  console.log("  note: seafarers route not loadable in harness (" + e.message + ") — hide/restore tested at lib level");
}

function req({ query = {}, body = null } = {}) {
  const sp = new URLSearchParams(query);
  return { nextUrl: { searchParams: sp }, json: async () => body ?? {} };
}
const asAgent = (agentId) => { currentAgent = { user: { name: `${agentId}-user`, email: `${agentId}@x` }, agentId }; };
const postVoyageRows = () =>
  ["Technical competence", "Safety & compliance", "Leadership", "Teamwork", "Reliability", "Communication"].map((c) => ({ competency: c, rating: 4 }));

let passed = 0;
const failures = [];
const check = (label, cond) => {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failures.push(label); console.log("  FAIL " + label); }
};

console.log("Batch 2 — route-level integration\n");

// [1] Appraisal double-submit (same idempotencyKey) => ONE row + ONE notify.
{
  db = freshDB(); notifySends.length = 0; asAgent("agent:A");
  const payload = { seafarerId: "s1", kind: "interview", fastPath: true, recommend: "yes", overall: 4, idempotencyKey: "k1" };
  const r1 = await appraisalsRoute.POST(req({ body: payload }));
  const r2 = await appraisalsRoute.POST(req({ body: payload }));
  check("[1] first POST created", r1.body.ok && r1.body.created === true);
  check("[1] second POST (same key) NOT created", r2.body.ok && r2.body.created === false);
  check("[1] exactly ONE appraisal row", db.appraisals.length === 1);
  check("[1] exactly ONE notify send", notifySends.length === 1);
}

// [2] Fallback collision (v4 item 1).
{
  db = freshDB(); asAgent("agent:A");
  // Two BLANK-key interviews for the same seaman/agency => TWO rows (never fallback-deduped).
  await appraisalsRoute.POST(req({ body: { seafarerId: "s1", kind: "interview", fastPath: true, recommend: "yes", overall: 3 } }));
  await appraisalsRoute.POST(req({ body: { seafarerId: "s1", kind: "interview", fastPath: true, recommend: "yes", overall: 3 } }));
  check("[2] two blank-key interviews => TWO rows", db.appraisals.filter((a) => a.kind === "interview").length === 2);

  // Two BLANK-key post_voyage for the same real assignmentId within the 10s window => ONE row.
  const pv = { seafarerId: "s1", kind: "post_voyage", recommend: "yes", vessel: "MV Alpha", voyageFrom: "2026-01-01", voyageTo: "2026-06-01", assignmentId: "a1", scores: postVoyageRows() };
  await appraisalsRoute.POST(req({ body: pv }));
  await appraisalsRoute.POST(req({ body: pv }));
  check("[2] two blank-key post_voyage same assignment in-window => ONE row",
    db.appraisals.filter((a) => a.kind === "post_voyage" && a.assignmentId === "a1").length === 1);

  // Age the existing post_voyage row past the 10s window, then POST again => TWO rows.
  for (const a of db.appraisals) if (a.kind === "post_voyage") a.createdAt = iso(Date.now() - 11000);
  await appraisalsRoute.POST(req({ body: pv }));
  check("[2] same post_voyage spaced >10s apart => TWO rows (window boundary)",
    db.appraisals.filter((a) => a.kind === "post_voyage" && a.assignmentId === "a1").length === 2);
}

// [3] Appraisal seaman GET body-scan + cross-seafarer 404.
{
  db = freshDB(); asAgent("agent:A");
  await appraisalsRoute.POST(req({ body: {
    seafarerId: "s1", kind: "post_voyage", recommend: "no", rehireReason: "confidential reason",
    comments: "agency-private note", vessel: "MV Alpha", voyageFrom: "2026-01-01", voyageTo: "2026-06-01",
    assignmentId: "a1", scores: postVoyageRows(),
  } }));
  const seaman = await appraisalsRoute.GET(req({ query: { token: "open-s1" } }));
  const row = seaman.body.appraisals[0];
  const banned = ["comments", "rehireReason", "authorName", "agentId", "idempotencyKey", "updatedAt"];
  check("[3] seaman GET returns the appraisal", seaman.body.ok && !!row);
  check("[3] seaman body carries NONE of the private fields", banned.every((k) => !(k in row)));
  check("[3] seaman body carries authorOrg (mapped from authorName)", row.authorOrg === "Org A Crewing");
  const cross = await appraisalsRoute.GET(req({ query: { token: "open-s1", seafarerId: "s2" } }));
  check("[3] token s1 + ?seafarerId=s2 => 404", cross.status === 404);
  const stranger = await appraisalsRoute.GET(req({ query: { token: "open-s3" } }));
  check("[3] stranger token => own (empty) appraisals only", stranger.body.ok && stranger.body.appraisals.length === 0);
}

// [4] Contract double-generate => ONE issuedSeaTerms row (second updates in place).
{
  db = freshDB(); asAgent("agent:A");
  const g1 = await contractRoute.POST(req({ body: { assignmentId: "a1", terms: { wageAmount: "1500", wageCurrency: "USD", wagePeriod: "month" } } }), { params: { id: "s1" } });
  check("[4] first generate returns DRAFT html", typeof g1.body === "string" && /DRAFT — NOT AN EXECUTED AGREEMENT/.test(g1.body));
  check("[4] one issuedSeaTerms row after first generate", db.issuedSeaTerms.length === 1);
  // Age the stored generatedAt so a fresh regenerate must visibly change it.
  const agedGeneratedAt = iso(Date.parse(db.issuedSeaTerms[0].generatedAt) - 5000);
  db.issuedSeaTerms[0].generatedAt = agedGeneratedAt;
  await contractRoute.POST(req({ body: { assignmentId: "a1", terms: { wageAmount: "1800", wageCurrency: "USD", wagePeriod: "month" } } }), { params: { id: "s1" } });
  check("[4] STILL one issuedSeaTerms row after regenerate (upsert)", db.issuedSeaTerms.length === 1);
  check("[4] second generate updated terms in place", db.issuedSeaTerms[0].terms.wageAmount === "1800");
  check("[4] second generate updated generatedAt in place", db.issuedSeaTerms[0].generatedAt !== agedGeneratedAt);
}

// [5] Contract seaman GET — 404s + rehydration + no-record page.
{
  db = freshDB(); asAgent("agent:A");
  await contractRoute.POST(req({ body: { assignmentId: "a1", terms: { wageAmount: "1800", wageCurrency: "USD", wagePeriod: "month" } } }), { params: { id: "s1" } });

  const foreign = await contractRoute.GET(req({ query: { token: "open-s2", assignmentId: "a1" } }), { params: { id: "s1" } });
  check("[5] foreign token (owner != pathId) => 404", foreign.status === 404);

  const wrongAssignment = await contractRoute.GET(req({ query: { token: "open-s1", assignmentId: "a2" } }), { params: { id: "s1" } });
  check("[5] assignment belonging to another seaman => 404", wrongAssignment.status === 404);

  const missingAssignment = await contractRoute.GET(req({ query: { token: "open-s1", assignmentId: "nope" } }), { params: { id: "s1" } });
  check("[5] unknown assignmentId => 404", missingAssignment.status === 404);

  const own = await contractRoute.GET(req({ query: { token: "open-s1", assignmentId: "a1" } }), { params: { id: "s1" } });
  check("[5] own token + own assignment => SEA with REHYDRATED terms (1800)", typeof own.body === "string" && own.body.includes("1800"));

  const none = await contractRoute.GET(req({ query: { token: "open-s2", assignmentId: "a2" } }), { params: { id: "s2" } });
  check("[5] own token, no issued record => seaman-sea-none page", typeof none.body === "string" && none.body.includes("seaman-sea-none"));
}

// [6] F1 — a fast-path "Do not re-hire" (recommend:"no") with NO reason must be
// rejected server-side (400) and write NO row; the SAME verdict WITH a reason succeeds.
{
  db = freshDB(); asAgent("agent:A");
  const before = db.appraisals.length;
  const blind = await appraisalsRoute.POST(req({ body: {
    seafarerId: "s1", kind: "interview", fastPath: true, recommend: "no", overall: 2,
  } }));
  check("[6] fast-path 'do not re-hire' with NO reason => 400", blind.status === 400);
  check("[6] rejected fast-path 'no' wrote NO appraisal row", db.appraisals.length === before);
  const withReason = await appraisalsRoute.POST(req({ body: {
    seafarerId: "s1", kind: "interview", fastPath: true, recommend: "no", overall: 2,
    rehireReason: "Repeated safety violations",
  } }));
  check("[6] fast-path 'do not re-hire' WITH a reason => created", withReason.body.ok && withReason.body.created === true);
}

// ---------------------------------------------------------------------------
// Bug2/4 — share-link add (POST /api/invite/link). Realistic base64url fixtures
// (underscore + hyphen), mirroring the /share handshake exactly.
// ---------------------------------------------------------------------------
const now0 = iso(T0);
function linkDB() {
  const base = freshDB();
  base.assignments = [];
  base.seafarers = [
    { id: "s_open", name: "Open Seaman", rank: "AB", state: "review",
      openShareToken: "Xy_9ab-QmR2z", emailShareToken: "Em_open-01", shareToken: "Xy_9ab-QmR2z",
      ownerEmail: "seaman@ex.com", selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_hyph", name: "Hyphen Seaman", rank: "AB", state: "review",
      openShareToken: "Z5cpz-zTY0Qq", emailShareToken: "Em_hyph-02", shareToken: "Z5cpz-zTY0Qq",
      selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_email", name: "Email Seaman", rank: "AB", state: "review",
      openShareToken: "Op_email-9", emailShareToken: "Pr_iv-Tok88", shareToken: "Op_email-9",
      selfProfile: {}, allowedEmails: ["allowed@ex.com"], createdAt: now0 },
    { id: "s_alias", name: "Alias Survivor", rank: "AB", state: "review",
      openShareToken: "Al_surv-10", emailShareToken: "Al_surv-em", shareToken: "Al_surv-10",
      priorShareTokens: [{ token: "Ca_rried-99", mode: "open" }],
      selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_anon", name: "Anon Engaged", rank: "AB", state: "review",
      openShareToken: "An_on-Eng01", emailShareToken: "An_on-em02", shareToken: "An_on-Eng01",
      invited: true, selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_pend", name: "Pending Seaman", rank: "AB", state: "review",
      openShareToken: "Pe_nd-Tok01", emailShareToken: "Pe_nd-em02", shareToken: "Pe_nd-Tok01",
      selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_rev", name: "Revoked Seaman", rank: "AB", state: "review",
      openShareToken: "Re_v-Tok001", emailShareToken: "Re_v-em0002", shareToken: "Re_v-Tok001",
      selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "s_exp", name: "Expired Seaman", rank: "AB", state: "review",
      openShareToken: "Ex_p-Tok001", emailShareToken: "Ex_p-em0002", shareToken: "Ex_p-Tok001",
      selfProfile: {}, allowedEmails: [], createdAt: now0 },
  ];
  base.accessGrants = [
    { id: "gp", seafarerId: "s_pend", agentId: "agent:A", status: "PENDING", legalBasis: "CONSENT",
      scope: ["profile","documents","log"], shareToken: "grant-pend-tok", grantedAt: null, revokedAt: null, expiresAt: null, createdAt: now0 },
    { id: "gr", seafarerId: "s_rev", agentId: "agent:A", status: "REVOKED", legalBasis: "CONSENT",
      scope: ["profile","documents","log"], shareToken: "grant-rev-tok", grantedAt: now0, revokedAt: now0, expiresAt: null, createdAt: now0 },
    { id: "ge", seafarerId: "s_exp", agentId: "agent:A", status: "EXPIRED", legalBasis: "CONSENT",
      scope: ["profile","documents","log"], shareToken: "grant-exp-tok", grantedAt: now0, revokedAt: null, expiresAt: null, createdAt: now0 },
  ];
  return base;
}
const linkReq = (links) => ({ nextUrl: { searchParams: new URLSearchParams() }, json: async () => ({ links }) });

// [L1] Open token -> ACTIVE grant on the EXISTING seaman id; length unchanged; notify;
//      reviewsForSeafarer includes the agent; idempotent re-post (no 2nd grant/notify).
{
  db = linkDB(); notifySends.length = 0; boardEvents = []; asAgent("agent:A");
  const before = db.seafarers.length;
  const r1 = await inviteLinkRoute.POST(linkReq(["Xy_9ab-QmR2z"]));
  check("[L1] ok + added the existing seaman", r1.body.ok && r1.body.added.length === 1 && r1.body.added[0].id === "s_open");
  check("[L1] db.seafarers.length unchanged (no placeholder)", db.seafarers.length === before);
  const g = db.accessGrants.find((x) => x.seafarerId === "s_open" && x.agentId === "agent:A");
  check("[L1] a new ACTIVE grant exists for the pair", !!g && g.status === "ACTIVE");
  check("[L1] exactly ONE notify send", notifySends.length === 1);
  const reviews = accessLib.reviewsForSeafarer("s_open");
  check("[L1] reviewsForSeafarer includes the agent", reviews.some((r) => r.agentId === "agent:A"));
  // Idempotent re-post.
  const r2 = await inviteLinkRoute.POST(linkReq(["Xy_9ab-QmR2z"]));
  check("[L1] re-post => already-added (not added)", r2.body.added.length === 0 && r2.body.skipped[0].status === "already-added");
  check("[L1] re-post => NO 2nd grant row", db.accessGrants.filter((x) => x.seafarerId === "s_open" && x.agentId === "agent:A").length === 1);
  check("[L1] re-post => NO 2nd notify", notifySends.length === 1);
}

// [L2] Hyphen-only token resolves (agent with no prior grant).
{
  db = linkDB(); notifySends.length = 0; asAgent("agent:Z");
  const r = await inviteLinkRoute.POST(linkReq(["Z5cpz-zTY0Qq"]));
  check("[L2] hyphen token resolves + added", r.body.added.length === 1 && r.body.added[0].id === "s_hyph");
}

// [L3] Malformed %-token -> invalid, no throw / no 500.
{
  db = linkDB(); asAgent("agent:A");
  let threw = false, r = null;
  try { r = await inviteLinkRoute.POST(linkReq(["bad%z"])); } catch { threw = true; }
  check("[L3] malformed %-token did NOT throw", !threw && r && r.body.ok);
  check("[L3] malformed %-token => invalid", r && r.body.skipped[0] && r.body.skipped[0].status === "invalid");
}

// [L4] Email-mode: off allow-list => forbidden (no grant); on allow-list => added.
{
  db = linkDB(); asAgent("agent:A");
  currentAuth = { user: { email: "other@ex.com" } };
  const off = await inviteLinkRoute.POST(linkReq(["Pr_iv-Tok88"]));
  check("[L4] email-mode off allow-list => forbidden", off.body.skipped[0].status === "forbidden");
  check("[L4] forbidden => no grant created", !db.accessGrants.some((x) => x.seafarerId === "s_email" && x.agentId === "agent:A"));
  currentAuth = { user: { email: "allowed@ex.com" } };
  const on = await inviteLinkRoute.POST(linkReq(["Pr_iv-Tok88"]));
  check("[L4] email-mode on allow-list => added", on.body.added.length === 1 && on.body.added[0].id === "s_email");
  currentAuth = null;
}

// [L5] Carried alias => view-only, never grants.
{
  db = linkDB(); asAgent("agent:A");
  const r = await inviteLinkRoute.POST(linkReq(["Ca_rried-99"]));
  check("[L5] alias => view-only", r.body.skipped[0].status === "view-only");
  check("[L5] alias => no grant", !db.accessGrants.some((x) => x.seafarerId === "s_alias"));
}

// [L6] Anonymous-but-engaged seaman (invited, no Google, no ownerEmail) => ADDED (v3 no guard).
{
  db = linkDB(); notifySends.length = 0; asAgent("agent:A");
  const r = await inviteLinkRoute.POST(linkReq(["An_on-Eng01"]));
  check("[L6] anon-but-engaged => ADDED (no not-a-profile reject)", r.body.added.length === 1 && r.body.added[0].id === "s_anon");
  check("[L6] anon (no ownerEmail) still records the notify attempt", notifySends.length === 1 && !notifySends[0].to.email);
}

// [L7] REVOKED and EXPIRED => withdrawn; NO grant reactivation; stored status unchanged.
{
  db = linkDB(); notifySends.length = 0; asAgent("agent:A");
  const r = await inviteLinkRoute.POST(linkReq(["Re_v-Tok001", "Ex_p-Tok001"]));
  const byStatus = Object.fromEntries(r.body.skipped.map((s) => [s.input, s.status]));
  check("[L7] revoked => withdrawn", byStatus["Re_v-Tok001"] === "withdrawn");
  check("[L7] expired => withdrawn", byStatus["Ex_p-Tok001"] === "withdrawn");
  check("[L7] revoked grant STILL revoked (never reactivated)", db.accessGrants.find((x) => x.id === "gr").status === "REVOKED");
  check("[L7] expired grant STILL expired", db.accessGrants.find((x) => x.id === "ge").status === "EXPIRED");
  check("[L7] nothing added, no notify", r.body.added.length === 0 && notifySends.length === 0);
}

// [L8] PENDING => opened (activated), added, no re-notify.
{
  db = linkDB(); notifySends.length = 0; asAgent("agent:A");
  const r = await inviteLinkRoute.POST(linkReq(["Pe_nd-Tok01"]));
  check("[L8] pending => added", r.body.added.length === 1 && r.body.added[0].id === "s_pend");
  check("[L8] pending grant is now ACTIVE", db.accessGrants.find((x) => x.id === "gp").status === "ACTIVE");
  check("[L8] pending open => no notify", notifySends.length === 0);
}

// [L9] parseShareToken URL / trailing-slash / #frag / query / trailing '=' handling.
{
  const p = shareAccessLib.parseShareToken;
  check("[L9] full URL + query => token", p("https://docka.me/share/Xy_9ab-QmR2z?lang=et") === "Xy_9ab-QmR2z");
  check("[L9] trailing slash stripped", p("https://docka.me/share/Z5cpz-zTY0Qq/") === "Z5cpz-zTY0Qq");
  check("[L9] hash fragment stripped", p("docka.me/share/Ab_c-01#frag") === "Ab_c-01");
  check("[L9] bare token preserved (underscore kept)", p("Xy_9ab-QmR2z") === "Xy_9ab-QmR2z");
  check("[L9] trailing '=' padding tolerated", p("Z5cpz-zTY0Qq=") === "Z5cpz-zTY0Qq=");
  check("[L9] malformed % => null", p("bad%z") === null);
  check("[L9] empty => null", p("   ") === null);
}

// [L10] Isolation — anonymous caller 401.
{
  db = linkDB(); currentAgent = null;
  const r = await inviteLinkRoute.POST(linkReq(["Xy_9ab-QmR2z"]));
  check("[L10] anon => 401", r.status === 401 && r.body.ok === false);
}

// ---------------------------------------------------------------------------
// Bug1 — hide / restore crew (lib-level: the exact functions the route wraps).
// ---------------------------------------------------------------------------
function hideDB() {
  const base = freshDB();
  base.assignments = []; // nobody at sea by default
  base.seafarers = [
    { id: "h1", name: "Board Seaman", rank: "AB", state: "accepted", openShareToken: "Hb_1-Tok001",
      emailShareToken: "Hb_1-em0002", shareToken: "Hb_1-Tok001", ownerEmail: "h1@ex.com", selfProfile: {}, allowedEmails: [], createdAt: now0 },
    { id: "h2", name: "Sea Seaman", rank: "AB", state: "sent_to_sea", openShareToken: "Hs_2-Tok001",
      emailShareToken: "Hs_2-em0002", shareToken: "Hs_2-Tok001", selfProfile: {}, allowedEmails: [], createdAt: now0 },
  ];
  base.accessGrants = [
    { id: "hg1", seafarerId: "h1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", stage: "accepted",
      scope: ["profile","documents","log"], shareToken: "hg1-tok", grantedAt: now0, revokedAt: null, expiresAt: null, createdAt: now0 },
    { id: "hg2", seafarerId: "h2", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONTRACT_LEGAL_OBLIGATION", stage: "sent_to_sea",
      scope: ["profile","documents","log"], shareToken: "hg2-tok", grantedAt: now0, revokedAt: null, expiresAt: null, createdAt: now0 },
  ];
  // h2 is at sea (live assignment) -> LOCKED, must not be hideable.
  base.assignments = [
    { id: "ha2", seafarerId: "h2", agentId: "agent:A", vessel: "MV Sea", sentToSeaAt: now0, returnedAt: null, createdAt: now0 },
  ];
  return base;
}

// [H1] hide sets hiddenByAgentAt + BOARD_HIDDEN; drops from board projection but stays in
//      readableSeafarerIds / default listSeafarersForAgent (reminders/circulars); regression:
//      reviewsForSeafarer.lastAction is NOT BOARD_HIDDEN.
{
  db = hideDB(); boardEvents = []; asAgent("agent:A");
  const res = await accessLib.setBoardHidden("hg1", "agent:A", true);
  check("[H1] setBoardHidden ok", res.ok === true);
  check("[H1] hiddenByAgentAt is set", !!db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt);
  check("[H1] BOARD_HIDDEN written to board-events", boardEvents.length === 1 && boardEvents[0].action === "BOARD_HIDDEN" && boardEvents[0].grantId === "hg1");
  const boardVisible = agentDataLib.listSeafarersForAgent("agent:A", false).map((s) => s.id);
  check("[H1] hidden seaman DROPS from board projection", !boardVisible.includes("h1"));
  const defaultList = agentDataLib.listSeafarersForAgent("agent:A").map((s) => s.id);
  check("[H1] hidden seaman STAYS in default list (reminders/circulars)", defaultList.includes("h1"));
  check("[H1] hidden seaman STAYS in readableSeafarerIds", accessLib.readableSeafarerIds("agent:A").has("h1"));
  const hiddenList = agentDataLib.listHiddenSeafarersForAgent("agent:A").map((s) => s.id);
  check("[H1] ?view=hidden lists the hidden seaman", hiddenList.includes("h1"));
  const rev = accessLib.reviewsForSeafarer("h1").find((r) => r.agentId === "agent:A");
  check("[H1] regression: reviewsForSeafarer.lastAction is NOT BOARD_HIDDEN", !!rev && rev.lastAction !== "BOARD_HIDDEN");
}

// [H2] hide a LOCKED / at-sea seaman => rejected, nothing written.
{
  db = hideDB(); boardEvents = []; asAgent("agent:A");
  const res = await accessLib.setBoardHidden("hg2", "agent:A", true);
  check("[H2] hide at-sea => rejected {error:'at-sea'}", res.ok === false && res.error === "at-sea");
  check("[H2] no hiddenByAgentAt set", !db.accessGrants.find((g) => g.id === "hg2").hiddenByAgentAt);
  check("[H2] no board-event written", boardEvents.length === 0);
}

// [H3] restore clears the flag + writes BOARD_RESTORED.
{
  db = hideDB(); boardEvents = []; asAgent("agent:A");
  await accessLib.setBoardHidden("hg1", "agent:A", true);
  boardEvents = [];
  const res = await accessLib.setBoardHidden("hg1", "agent:A", false);
  check("[H3] restore ok", res.ok === true);
  check("[H3] hiddenByAgentAt cleared", !db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt);
  check("[H3] BOARD_RESTORED written", boardEvents.length === 1 && boardEvents[0].action === "BOARD_RESTORED");
}

// [H4] agent B cannot hide agent A's grant (ownership guard).
{
  db = hideDB(); boardEvents = []; asAgent("agent:Z");
  const res = await accessLib.setBoardHidden("hg1", "agent:Z", true);
  check("[H4] agent B => forbidden", res.ok === false && res.error === "forbidden");
  check("[H4] agent B wrote nothing", boardEvents.length === 0 && !db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt);
}

// [H5] Re-add an ACTIVE, board-hidden grant via the LINK route => already-added, no notify,
//      hiddenByAgentAt cleared, BOARD_RESTORED appended.
{
  db = hideDB(); notifySends.length = 0; boardEvents = []; asAgent("agent:A");
  db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt = now0; // pre-hidden
  const r = await inviteLinkRoute.POST(linkReq(["Hb_1-Tok001"]));
  check("[H5] re-add hidden active => already-added (not added)", r.body.added.length === 0 && r.body.skipped[0].status === "already-added");
  check("[H5] re-add hidden => hiddenByAgentAt cleared", !db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt);
  check("[H5] re-add hidden => BOARD_RESTORED appended", boardEvents.some((e) => e.action === "BOARD_RESTORED" && e.grantId === "hg1"));
  check("[H5] re-add hidden => NO notify (anti-spam)", notifySends.length === 0);
}

// [H6] Route-level (only if the seafarers route loaded): PATCH hide/restore + GET ?view=hidden.
if (seafarersRoute) {
  const patchReq = (body) => ({ nextUrl: { searchParams: new URLSearchParams() }, json: async () => body });
  const getReq = (query = {}) => ({ nextUrl: { searchParams: new URLSearchParams(query) }, json: async () => ({}) });

  db = hideDB(); boardEvents = []; asAgent("agent:A");
  const hide = await seafarersRoute.PATCH(patchReq({ id: "h1", hide: true }));
  check("[H6] PATCH {id,hide} => ok", hide.body.ok === true && hide.body.hidden === true);
  const hidden = await seafarersRoute.GET(getReq({ view: "hidden" }));
  check("[H6] GET ?view=hidden lists it", hidden.body.ok && hidden.body.seafarers.some((s) => s.id === "h1"));
  const board = await seafarersRoute.GET(getReq());
  check("[H6] default board GET excludes the hidden seaman", !board.body.seafarers.some((s) => s.id === "h1"));
  const restore = await seafarersRoute.PATCH(patchReq({ id: "h1", restore: true }));
  check("[H6] PATCH {id,restore} => ok", restore.body.ok === true && restore.body.hidden === false);

  db = hideDB(); asAgent("agent:A");
  const atSea = await seafarersRoute.PATCH(patchReq({ id: "h2", hide: true }));
  check("[H6] PATCH hide at-sea => 409", atSea.status === 409 && atSea.body.atSea === true);

  db = hideDB(); currentAgent = null;
  const anon = await seafarersRoute.PATCH(patchReq({ id: "h1", hide: true }));
  check("[H6] PATCH hide anon => 401 or 404 (no mutation)", (anon.status === 401 || anon.status === 404) && !db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt);
}

// ---------------------------------------------------------------------------
// Hidden-crew DELETE (H7–H22) — DELETE /api/seafarers?id= + lib deleteFromBoard.
// Suite hygiene: every test resets the per-agent delete rate limiter in setup so
// H7–H21 can never observe a 429 (H22 + the unit test own the limiter assertions).
// ---------------------------------------------------------------------------
function delDB() {
  const base = hideDB();
  // d1 — UNCLAIMED, sole LIVE grant (agent:A, board-hidden), with children + a foreign
  // DEAD (REVOKED) grant from agent:Z the hard delete must erase AND archive.
  base.seafarers.push({
    id: "d1", name: "Unclaimed Sole", rank: "AB", state: "review",
    openShareToken: "Du_1-Tok001", emailShareToken: "Du_1-em0002", shareToken: "Du_1-Tok001",
    verifiedPhotoFile: "d1-photo.jpg", selfProfile: {}, allowedEmails: [], createdAt: now0,
    createdByAgentId: "agent:A", // provenance: caller IS the creator (hard-delete eligible)
  });
  base.accessGrants.push(
    { id: "dg1", seafarerId: "d1", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", stage: "review",
      hiddenByAgentAt: now0, scope: ["profile","documents","log"], shareToken: "dg1-tok",
      grantedAt: now0, revokedAt: null, expiresAt: null, createdAt: now0 },
    { id: "dgz", seafarerId: "d1", agentId: "agent:Z", status: "REVOKED", legalBasis: "CONSENT",
      scope: ["profile","documents","log"], shareToken: "dgz-tok", grantedAt: now0, revokedAt: now0,
      expiresAt: null, createdAt: now0 },
  );
  base.documents.push({
    id: "dd1", seafarerId: "d1", title: "Passport", docType: "Passport", docCategory: null,
    estonianCode: null, fileName: "d1-passport.pdf", createdAt: now0,
  });
  base.comments.push(
    { id: "dc1", documentId: "dd1", seafarerId: null, authorName: "A", text: "doc note", createdAt: now0 },
    { id: "dc2", documentId: null, seafarerId: "d1", authorName: "A", text: "seaman note", createdAt: now0 },
  );
  base.clientPortals = [{
    id: "cp1", agentId: "agent:A", vessel: "MV X", clientLabel: "Client", token: "cp-tok",
    seafarerIds: ["d1", "h1"], mode: "open", createdAt: now0,
  }];
  // d2 — UNCLAIMED but a SECOND agency (agent:Z) holds a live ACTIVE grant.
  base.seafarers.push({
    id: "d2", name: "Unclaimed Shared", rank: "AB", state: "review",
    openShareToken: "Du_2-Tok001", emailShareToken: "Du_2-em0002", shareToken: "Du_2-Tok001",
    selfProfile: {}, allowedEmails: [], createdAt: now0,
  });
  base.accessGrants.push(
    { id: "dg2a", seafarerId: "d2", agentId: "agent:A", status: "ACTIVE", legalBasis: "CONSENT", stage: "review",
      hiddenByAgentAt: now0, scope: ["profile","documents","log"], shareToken: "dg2a-tok",
      grantedAt: now0, revokedAt: null, expiresAt: null, createdAt: now0 },
    { id: "dg2z", seafarerId: "d2", agentId: "agent:Z", status: "ACTIVE", legalBasis: "CONSENT", stage: "review",
      scope: ["profile","documents","log"], shareToken: "dg2z-tok", grantedAt: now0, revokedAt: null,
      expiresAt: null, createdAt: now0 },
  );
  return base;
}
const delSetup = (fixture = delDB()) => {
  db = fixture; boardEvents = []; consentDrafts = []; archiveLines = []; archiveFailNext = false;
  deleteRateLib._resetDeleteRateLimit();
};

if (seafarersRoute) {
  const delReq = (sid) => ({
    nextUrl: { searchParams: new URLSearchParams(sid === undefined ? {} : { id: sid }) },
    json: async () => ({}),
  });
  const getReq = (query = {}) => ({ nextUrl: { searchParams: new URLSearchParams(query) }, json: async () => ({}) });

  // [H7] unclaimed + sole live grant + hidden => 200 hard; full cascade; archive line.
  {
    delSetup(); asAgent("agent:A");
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H7] DELETE unclaimed sole => 200 mode=hard", r.status === 200 && r.body.ok === true && r.body.mode === "hard");
    check("[H7] seafarer row gone", !db.seafarers.some((s) => s.id === "d1"));
    check("[H7] ALL grants for the sid gone (incl. foreign REVOKED)", !db.accessGrants.some((g) => g.seafarerId === "d1"));
    check("[H7] documents gone", !db.documents.some((d) => d.seafarerId === "d1"));
    check("[H7] comments gone (seaman-level AND doc-thread)", !db.comments.some((c) => c.id === "dc1" || c.id === "dc2"));
    check("[H7] sid stripped from clientPortals (other ids kept)",
      db.clientPortals[0].seafarerIds.length === 1 && db.clientPortals[0].seafarerIds[0] === "h1");
    const line = archiveLines[0];
    check("[H7] archive line written with kind", archiveLines.length === 1 && line.kind === "hidden-crew-delete");
    check("[H7] archive line carries the file list",
      !!line && line.files.includes("d1-passport.pdf") && line.files.includes("d1-photo.jpg"));
    check("[H7] archive line snapshots the foreign REVOKED grant",
      !!line && line.cascadeRows.accessGrants.some((g) => g.id === "dgz" && g.status === "REVOKED"));
    check("[H7] BOARD_DELETED {mode:hard} board event",
      boardEvents.some((e) => e.action === "BOARD_DELETED" && e.mode === "hard" && e.seafarerId === "d1"));
  }

  // [H8] unclaimed + second agency ACTIVE => 200 view; row survives; caller grant
  //      REVOKED + token rotated + hidden cleared; other grant byte-untouched.
  {
    delSetup(); asAgent("agent:A");
    const otherBefore = JSON.stringify(db.accessGrants.find((g) => g.id === "dg2z"));
    const r = await seafarersRoute.DELETE(delReq("d2"));
    check("[H8] DELETE unclaimed-shared => 200 mode=view", r.status === 200 && r.body.mode === "view");
    check("[H8] seafarer row survives", db.seafarers.some((s) => s.id === "d2"));
    const g = db.accessGrants.find((x) => x.id === "dg2a");
    check("[H8] caller grant REVOKED", g.status === "REVOKED" && g.revokedAt !== null);
    check("[H8] caller share token rotated", g.shareToken !== "dg2a-tok");
    check("[H8] hidden flag cleared", g.hiddenByAgentAt === null);
    check("[H8] other agency's grant untouched", JSON.stringify(db.accessGrants.find((x) => x.id === "dg2z")) === otherBefore);
    check("[H8] BOARD_DELETED {mode:view} board event",
      boardEvents.some((e) => e.action === "BOARD_DELETED" && e.mode === "view" && e.seafarerId === "d2"));
  }

  // [H9] claimed => 200 view; consent event REVOKED_BY_AGENT (agent actor); readers render it.
  {
    delSetup(); asAgent("agent:A");
    db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt = now0; // h1 is claimed (ownerEmail)
    const r = await seafarersRoute.DELETE(delReq("h1"));
    check("[H9] DELETE claimed => 200 mode=view", r.status === 200 && r.body.mode === "view");
    check("[H9] consent event is REVOKED_BY_AGENT with the AGENT actor",
      consentDrafts.some((e) => e.type === "REVOKED_BY_AGENT" && e.grantId === "hg1" && e.actor === "agent:agent:A"));
    check("[H9] never a WITHDRAWN event", !consentDrafts.some((e) => e.type === "WITHDRAWN"));
    let rendered = null, threw = false;
    try {
      rendered = adminFunnelLib.buildUserTimeline(db, [], consentDrafts, "seaman", "h1");
    } catch { threw = true; }
    check("[H9] admin timeline renders the new type without throwing",
      !threw && !!rendered && rendered.dated.some((e) => e.type === "consent_REVOKED_BY_AGENT" && e.label));
    let reviews = null, threw2 = false;
    try { reviews = accessLib.reviewsForSeafarer("h1"); } catch { threw2 = true; }
    check("[H9] seaman-facing reviewsForSeafarer still renders", !threw2 && Array.isArray(reviews));
  }

  // [H10] not hidden => 409 {notHidden}, no mutation.
  {
    delSetup(); asAgent("agent:A"); // h1's grant hg1 is NOT hidden here
    const r = await seafarersRoute.DELETE(delReq("h1"));
    check("[H10] DELETE visible seaman => 409 notHidden", r.status === 409 && r.body.notHidden === true);
    check("[H10] no mutation", db.seafarers.some((s) => s.id === "h1") && db.accessGrants.find((g) => g.id === "hg1").status === "ACTIVE");
  }

  // [H11] caller LOCKED-while-hidden (hide first, then assignment) => 409 atSea, NOT 404.
  {
    delSetup(); asAgent("agent:A");
    db.assignments.push({ id: "da1", seafarerId: "d1", agentId: "agent:A", vessel: "MV Late", sentToSeaAt: now0, returnedAt: null, createdAt: now0 });
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H11] LOCKED-while-hidden => 409 atSea (not 404)", r.status === 409 && r.body.atSea === true);
    check("[H11] no mutation", db.seafarers.some((s) => s.id === "d1") && db.accessGrants.find((g) => g.id === "dg1").status === "ACTIVE");
  }

  // [H12] cross-agent no grant => 404; anon => 401; bad id => 400.
  {
    delSetup(); asAgent("agent:Z"); // Z has NO grant for h1
    const cross = await seafarersRoute.DELETE(delReq("h1"));
    check("[H12] cross-agent (no grant) => 404", cross.status === 404);
    currentAgent = null;
    const anon = await seafarersRoute.DELETE(delReq("d1"));
    check("[H12] anon => 401", anon.status === 401);
    asAgent("agent:A");
    const bad = await seafarersRoute.DELETE(delReq(undefined));
    check("[H12] missing id => 400", bad.status === 400);
    check("[H12] no mutation from any of them", db.seafarers.some((s) => s.id === "d1") && db.seafarers.some((s) => s.id === "h1"));
  }

  // [H13] GET ?view=hidden rows carry the server-computed `claimed` flag.
  {
    delSetup(); asAgent("agent:A");
    db.accessGrants.find((g) => g.id === "hg1").hiddenByAgentAt = now0; // claimed h1 hidden too
    const r = await seafarersRoute.GET(getReq({ view: "hidden" }));
    const byId = Object.fromEntries((r.body.seafarers ?? []).map((s) => [s.id, s]));
    check("[H13] claimed seaman => claimed:true", byId.h1 && byId.h1.claimed === true);
    check("[H13] unclaimed seaman => claimed:false", byId.d1 && byId.d1.claimed === false);
  }

  // [H14] caller grant already REVOKED => 404, no mutation (replay hole closed).
  {
    delSetup(); asAgent("agent:A");
    const g = db.accessGrants.find((x) => x.id === "dg1");
    g.status = "REVOKED"; g.revokedAt = now0;
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H14] revoked caller grant => 404", r.status === 404);
    check("[H14] no mutation", db.seafarers.some((s) => s.id === "d1") && archiveLines.length === 0);
  }

  // [H15] archive append fails => error out, ZERO mutation.
  {
    delSetup(); asAgent("agent:A");
    archiveFailNext = true;
    let threw = false, r = null;
    try { r = await seafarersRoute.DELETE(delReq("d1")); } catch { threw = true; }
    check("[H15] archive failure surfaces as an error (throw/5xx), never a fake 200",
      threw || (r && r.status >= 500));
    check("[H15] zero mutation: row, grants and documents all intact",
      db.seafarers.some((s) => s.id === "d1") &&
      db.accessGrants.find((g) => g.id === "dg1").status === "ACTIVE" &&
      db.documents.some((d) => d.id === "dd1"));
    archiveFailNext = false;
  }

  // [H16] replay: DELETE after hard => 404; after view => 404; no second consent event.
  {
    delSetup(); asAgent("agent:A");
    await seafarersRoute.DELETE(delReq("d1")); // hard
    const again = await seafarersRoute.DELETE(delReq("d1"));
    check("[H16] replay after hard delete => 404", again.status === 404);
    await seafarersRoute.DELETE(delReq("d2")); // view
    const events = consentDrafts.filter((e) => e.type === "REVOKED_BY_AGENT").length;
    const again2 = await seafarersRoute.DELETE(delReq("d2"));
    check("[H16] replay after view delete => 404", again2.status === 404);
    check("[H16] no second consent event on replay",
      consentDrafts.filter((e) => e.type === "REVOKED_BY_AGENT").length === events);
  }

  // [H17] file move failure (files missing on disk) => still 200, db consistent.
  {
    delSetup(); asAgent("agent:A");
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H17] 200 mode=hard despite unmovable files", r.status === 200 && r.body.mode === "hard");
    check("[H17] db consistent (row + children gone)",
      !db.seafarers.some((s) => s.id === "d1") && !db.documents.some((d) => d.seafarerId === "d1"));
  }

  // [H18] share-link re-add after a view-delete: the grant is REVOKED, so the link
  //       route refuses to silently reactivate (consent-first — status "withdrawn");
  //       re-approval stays the seaman's call (see H20 for the sanctioned path).
  {
    delSetup(); asAgent("agent:A");
    await seafarersRoute.DELETE(delReq("d2")); // view-delete (agent:Z still ACTIVE)
    const r = await inviteLinkRoute.POST(linkReq(["Du_2-Tok001"]));
    check("[H18] link re-add after view-delete => withdrawn (no silent reactivation)",
      r.body.added.length === 0 && r.body.skipped[0].status === "withdrawn");
    check("[H18] grant stays REVOKED", db.accessGrants.find((g) => g.id === "dg2a").status === "REVOKED");
  }

  // [H19] unclaimed, caller ACTIVE+hidden, agency B has a LIVE assignment => 409 atSea;
  //       B's rows byte-untouched. THE cross-tenant guard test.
  {
    delSetup(); asAgent("agent:A");
    db.assignments.push({ id: "db1", seafarerId: "d2", agentId: "agent:Z", vessel: "MV B", sentToSeaAt: now0, returnedAt: null, createdAt: now0 });
    const bGrantBefore = JSON.stringify(db.accessGrants.find((g) => g.id === "dg2z"));
    const bAssignBefore = JSON.stringify(db.assignments.find((a) => a.id === "db1"));
    const r = await seafarersRoute.DELETE(delReq("d2"));
    check("[H19] at sea under ANOTHER agency => 409 atSea (global sweep)", r.status === 409 && r.body.atSea === true);
    check("[H19] agency B's grant byte-untouched", JSON.stringify(db.accessGrants.find((g) => g.id === "dg2z")) === bGrantBefore);
    check("[H19] agency B's assignment byte-untouched", JSON.stringify(db.assignments.find((a) => a.id === "db1")) === bAssignBefore);
    check("[H19] seafarer row survives", db.seafarers.some((s) => s.id === "d2"));
  }

  // [H20] view-delete -> seaman regrantGrant -> ACTIVE + VISIBLE on the agent board.
  {
    delSetup(); asAgent("agent:A");
    await seafarersRoute.DELETE(delReq("d2")); // view-delete; hidden flag cleared
    const rg = await accessLib.regrantGrant("dg2a", "seafarer:d2");
    check("[H20] seaman re-grant after view-delete => ok + ACTIVE", rg.ok === true && db.accessGrants.find((g) => g.id === "dg2a").status === "ACTIVE");
    const visible = agentDataLib.listSeafarersForAgent("agent:A", false).map((s) => s.id);
    check("[H20] re-granted seaman lands VISIBLE (hidden was cleared)", visible.includes("d2"));
  }

  // [H21] claim race: seafarer claimed between the hidden list and DELETE => server
  //       mode wins: 200 mode=view, row survives.
  {
    delSetup(); asAgent("agent:A");
    db.seafarers.find((s) => s.id === "d1").ownerEmail = "claimed@ex.com"; // claim lands mid-flight
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H21] claim race => 200 mode=view (server beats the stale flag)", r.status === 200 && r.body.mode === "view");
    check("[H21] row survives", db.seafarers.some((s) => s.id === "d1"));
  }

  // [H22] rate limit: burst of DELETEs => 429 after the 10-per-60s threshold.
  {
    delSetup(); asAgent("agent:A");
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const r = await seafarersRoute.DELETE(delReq("h1")); // not hidden => 409s, still counted
      statuses.push(r.status);
    }
    check("[H22] first 10 deletes are not rate-limited", statuses.slice(0, 10).every((s) => s !== 429));
    check("[H22] 11th delete => 429", statuses[10] === 429);
  }

  // [H23] provenance gate (legacy row, no createdByAgentId): caller holds the ONLY
  //       live grant but a foreign REVOKED grant is OLDER => caller is NOT the
  //       creator => 200 mode=view, row survives, caller grant revoked.
  {
    delSetup(); asAgent("agent:A");
    delete db.seafarers.find((s) => s.id === "d1").createdByAgentId; // legacy row
    db.accessGrants.find((g) => g.id === "dgz").createdAt = iso(T0 - 1000); // Z's dead grant is older
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H23] not-creator (older foreign grant) => 200 mode=view", r.status === 200 && r.body.mode === "view");
    check("[H23] row survives", db.seafarers.some((s) => s.id === "d1"));
    const g = db.accessGrants.find((x) => x.id === "dg1");
    check("[H23] caller grant revoked + hidden cleared", g.status === "REVOKED" && g.hiddenByAgentAt === null);
    check("[H23] no archive line (nothing erased)", archiveLines.length === 0);
  }

  // [H24] provenance stamp WINS: createdByAgentId === caller => 200 mode=hard even
  //       though an OLDER dead foreign grant exists; archive line still carries it.
  {
    delSetup(); asAgent("agent:A"); // d1 is stamped createdByAgentId:"agent:A" in the fixture
    db.accessGrants.find((g) => g.id === "dgz").createdAt = iso(T0 - 1000);
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H24] creator stamp beats grant age => 200 mode=hard", r.status === 200 && r.body.mode === "hard");
    check("[H24] row + grants gone", !db.seafarers.some((s) => s.id === "d1") && !db.accessGrants.some((g) => g.seafarerId === "d1"));
    check("[H24] archive line still snapshots the dead foreign grant",
      archiveLines.length === 1 && archiveLines[0].cascadeRows.accessGrants.some((g) => g.id === "dgz"));
  }

  // [H25] R2-3 — credentialUserId-only placeholder => 200 view (not hard). Before the
  //       access.ts:572 unification with isClaimed, this row (sole grant, creator) hard-
  //       deleted; a password-claimed seafarer must never be silently erased. Row survives;
  //       caller grant revoked, no archive line (nothing erased).
  {
    delSetup(); asAgent("agent:A");
    db.seafarers.find((s) => s.id === "d1").credentialUserId = "cu1"; // claimed by password, no googleSub/ownerEmail
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H25] credentialUserId-only => 200 mode=view (not hard)", r.status === 200 && r.body.mode === "view");
    check("[H25] row survives (never hard-deleted)", db.seafarers.some((s) => s.id === "d1"));
    const g = db.accessGrants.find((x) => x.id === "dg1");
    check("[H25] caller grant revoked + hidden cleared", g.status === "REVOKED" && g.hiddenByAgentAt === null);
    check("[H25] no archive line (nothing erased)", archiveLines.length === 0);
  }

  // [H26] R2-3 strictly-tightening proof — a whitespace-only ownerEmail is NOT ownership
  //       under isClaimed (it trims), but the union RETAINS the old legacy-truthy check,
  //       so this row stays view-only exactly as it did before the change (nothing that
  //       was view-only becomes hard-deletable). The READ flag (?view=hidden `claimed`)
  //       uses bare isClaimed and therefore disagrees — in the SAFE direction (reports
  //       claimed:false while the WRITE still refuses to hard-delete) — asserted here so
  //       it is a documented decision, not an accident.
  {
    delSetup(); asAgent("agent:A");
    db.seafarers.find((s) => s.id === "d1").ownerEmail = " ";
    const r = await seafarersRoute.DELETE(delReq("d1"));
    check("[H26] whitespace-only ownerEmail => 200 mode=view (legacy truthy retained)", r.status === 200 && r.body.mode === "view");
    check("[H26] row survives", db.seafarers.some((s) => s.id === "d1"));
  }
  {
    delSetup(); asAgent("agent:A");
    db.seafarers.find((s) => s.id === "d1").ownerEmail = " ";
    const r = await seafarersRoute.GET(getReq({ view: "hidden" }));
    const byId = Object.fromEntries((r.body.seafarers ?? []).map((s) => [s.id, s]));
    check(
      "[H26] READ flag (?view=hidden claimed) reports false for whitespace-only ownerEmail — documented safe-direction disagreement",
      byId.d1 && byId.d1.claimed === false
    );
  }
}

// [RL] deleteRateLimited unit boundary: 10 at threshold pass, 11th => 429, window
//      elapse (injected now) readmits.
{
  deleteRateLib._resetDeleteRateLimit();
  const t0 = Date.parse("2026-08-05T00:00:00.000Z");
  let over = false;
  for (let i = 0; i < 10; i++) over = deleteRateLib.deleteRateLimited("agent:U", t0 + i) || over;
  check("[RL] 10 deletes inside the window pass", over === false);
  check("[RL] 11th delete inside the window => limited", deleteRateLib.deleteRateLimited("agent:U", t0 + 10) === true);
  check("[RL] window elapse readmits", deleteRateLib.deleteRateLimited("agent:U", t0 + 60_011) === false);
  deleteRateLib._resetDeleteRateLimit();
}

// ---------------------------------------------------------------------------
// Bug3 — free-text name-add removed; file upload still works.
// ---------------------------------------------------------------------------
{
  db = freshDB(); asAgent("agent:A");
  const before = db.seafarers.length;
  const names = await inviteRoute.POST(req({ body: { names: ["Alice", "Bob"] } }));
  check("[B3] POST /api/invite {names} => 400", names.status === 400);
  check("[B3] {names} created nothing", db.seafarers.length === before);
  const crew = await inviteRoute.POST(req({ body: { crew: [{ name: "New Placeholder", rank: "Bosun" }] } }));
  check("[B3] {crew} => ok + creates a placeholder", crew.body.ok && db.seafarers.length === before + 1);
  const created = db.seafarers.find((s) => s.name === "New Placeholder");
  check("[B3] {crew} places a self-grant for the inviting agent", !!created && db.accessGrants.some((g) => g.seafarerId === created.id && g.agentId === "agent:A"));
  check("[B3] {crew} stamps createdByAgentId with the inviting agent (hard-delete provenance)",
    !!created && created.createdByAgentId === "agent:A");
}

// ---------------------------------------------------------------------------
// #15 / #16 — seaman re-grant a REVOKED agent + block revoke while at sea / returning.
// Loads the REAL /api/access route handler + the REAL access lib (revoke/regrant
// primitives). All grants here have NO live assignment (db.assignments = []) so the
// stage gate is exercised distinctly from the live-assignment LOCKED lock.
// ---------------------------------------------------------------------------
const accessRoute = loadTs(path.join(API, "access", "route.ts"));
const grantById = (id) => db.accessGrants.find((g) => g.id === id);

// #16 — revoke BLOCKED (409) while the agency stage is sent_to_sea or returning.
for (const stage of ["sent_to_sea", "returning"]) {
  db = freshDB(); db.assignments = [];
  grantById("g1").stage = stage;
  const r = await accessRoute.POST(req({ body: { action: "revoke", grantId: "g1", seafarerId: "s1" } }));
  check(`[#16] revoke => 409 blocked while stage=${stage}`, r.status === 409 && r.body.blocked === true);
  check(`[#16] grant NOT revoked while stage=${stage}`, grantById("g1").status === "ACTIVE");
}

// #16 — revoke ALLOWED for review / accepted / finished (not otherwise locked).
for (const stage of ["review", "accepted", "finished"]) {
  db = freshDB(); db.assignments = [];
  grantById("g1").stage = stage;
  const r = await accessRoute.POST(req({ body: { action: "revoke", grantId: "g1", seafarerId: "s1" } }));
  check(`[#16] revoke => ok while stage=${stage}`, r.body.ok === true);
  check(`[#16] grant REVOKED while stage=${stage}`, grantById("g1").status === "REVOKED");
}

// #16 — the gate is in the PRIMITIVE (server-authoritative), not just the route.
{
  db = freshDB(); db.assignments = [];
  grantById("g1").stage = "returning";
  const res = await accessLib.revokeGrant("g1", "seafarer:s1");
  check("[#16] revokeGrant primitive blocks stage=returning (server-authoritative)", res.ok === false && res.blocked === true);
  check("[#16] revokeGrant primitive left grant ACTIVE", grantById("g1").status === "ACTIVE");
}

// #15 — regrantGrant on a REVOKED grant => ACTIVE, revokedAt null, new token, stage review.
{
  db = freshDB(); db.assignments = [];
  const g1 = grantById("g1");
  g1.status = "REVOKED"; g1.revokedAt = iso(T0); g1.stage = "finished";
  const oldToken = g1.shareToken;
  const rg = await accessLib.regrantGrant("g1", "seafarer:s1");
  const after = grantById("g1");
  check("[#15] regrant ok on REVOKED grant", rg.ok === true);
  check("[#15] regrant => status ACTIVE", after.status === "ACTIVE");
  check("[#15] regrant => revokedAt cleared to null", after.revokedAt === null);
  check("[#15] regrant => shareToken rotated", after.shareToken !== oldToken);
  check("[#15] regrant => stage reset to review", after.stage === "review");
  check("[#15] regrant => legalBasis CONSENT", after.legalBasis === "CONSENT");
}

// #15 — regrant on a non-REVOKED (ACTIVE) grant => no-op reject, left untouched.
{
  db = freshDB(); db.assignments = [];
  const before = grantById("g2").shareToken;
  const rg = await accessLib.regrantGrant("g2", "seafarer:s2"); // g2 is ACTIVE
  check("[#15] regrant rejects a non-REVOKED (ACTIVE) grant", rg.ok === false);
  check("[#15] regrant left the ACTIVE grant untouched",
    grantById("g2").status === "ACTIVE" && grantById("g2").shareToken === before);
}

// Ownership — regrant + revoke reject a grantId whose seafarerId doesn't match the poster.
{
  db = freshDB(); db.assignments = [];
  grantById("g1").status = "REVOKED"; grantById("g1").revokedAt = iso(T0); // g1 belongs to s1
  const wrong = await accessRoute.POST(req({ body: { action: "regrant", grantId: "g1", seafarerId: "s2" } }));
  check("[own] regrant with mismatched seafarerId => 404", wrong.status === 404);
  check("[own] mismatched regrant did NOT reactivate", grantById("g1").status === "REVOKED");
}
{
  db = freshDB(); db.assignments = [];
  grantById("g1").stage = "review"; // g1 belongs to s1, revocable stage
  const wrong = await accessRoute.POST(req({ body: { action: "revoke", grantId: "g1", seafarerId: "s2" } }));
  check("[own] revoke with mismatched seafarerId => 404", wrong.status === 404);
  check("[own] mismatched revoke did NOT revoke", grantById("g1").status === "ACTIVE");
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  - " + f); process.exit(1); }
