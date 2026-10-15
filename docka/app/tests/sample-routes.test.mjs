// Public Sample Profiles — Phase 1 ROUTE acceptance. Drives the REAL migrated
// route handlers directly (tmp data dir + @/ alias + next/headers + @/auth test
// stubs — the account-mgmt precedent) and proves:
//
//   - read PURITY: a battery of sample-token GETs leaves db.json byte-identical
//   - FILTER verdicts: curated (sample:true) rows only + §D8 redaction + the
//     public Cache-Control on sample responses
//   - DENY verdicts: every sample-token write answers the 403 read-only response
//     and mutates nothing (byte-identical db across the whole DENY battery);
//     curated rows are immutable for AGENTS too
//   - cross-mode negative probes: the email token against every open-only route
//     and the alias token against every API route keep today's 404/401/403
//   - ALLOW verdicts: agent stage move + agent uploads still work on the sample
//     subject; §D7 notify-skips keep the notifications log clean; recipientIds
//     keep the sample id (agent-side threads intact); invite-link paste DENIES
//   - claim-report generic-negative; /me + inbox-reply belt-and-braces
//   - golden two-run stability for REAL subjects (volatile fields masked)
//
// Run: node --import ./tests/_register-sample.mjs --test tests/sample-routes.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.REGISTRY_MOCK = "1";

// ---- Throwaway data dir (BEFORE any @/lib import — DATA_DIR is cwd-resolved) --
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-sample-routes-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.mkdirSync(path.join(TMP, "uploads"), { recursive: true });
fs.writeFileSync(path.join(TMP, "uploads", "sample-file.txt"), "SAMPLE FILE");
fs.writeFileSync(path.join(TMP, "uploads", "real-file.txt"), "REAL FILE");
process.chdir(TMP);
globalThis.__TEST_COOKIES = {};
globalThis.__TEST_AUTH = null;

const { readDB, updateDB } = await import("@/lib/db");
const { SAMPLE_AGENCY_ID, SAMPLE_FLAGSHIP_ID, SAMPLE_OPEN_TOKEN } = await import("@/lib/sample-ids");
const { _resetSampleRateLimiter } = await import("@/lib/sample-guard");
const { __setTestAccountSession } = await import("@/lib/account-session");

const seafarersRoute = await import("../app/api/seafarers/route.ts");
const seafarersMeRoute = await import("../app/api/seafarers/me/route.ts");
const documentsRoute = await import("../app/api/documents/route.ts");
const filesRoute = await import("../app/api/files/[name]/route.ts");
const commentsRoute = await import("../app/api/comments/route.ts");
const calendarRoute = await import("../app/api/calendar/route.ts");
const cvRoute = await import("../app/api/cv/[id]/route.ts");
const contractRoute = await import("../app/api/contract/[id]/route.ts");
const verifyLinkRoute = await import("../app/api/verify-link/route.ts");
const seaServiceRoute = await import("../app/api/sea-service/route.ts");
const profilePhotoRoute = await import("../app/api/profile-photo/[id]/route.ts");
const inboxRoute = await import("../app/api/inbox/route.ts");
const inboxUnreadRoute = await import("../app/api/inbox/unread/route.ts");
const inboxSeenRoute = await import("../app/api/inbox/seen/route.ts");
const inboxReplyRoute = await import("../app/api/inbox/reply/route.ts");
const profileUpdatesRoute = await import("../app/api/profile-updates/route.ts");
const propagationRoute = await import("../app/api/access/propagation/route.ts");
const propagationRequestRoute = await import("../app/api/access/propagation/request/route.ts");
const appraisalsRoute = await import("../app/api/appraisals/route.ts");
const appraisalDeleteRoute = await import("../app/api/appraisals/delete-request/route.ts");
const clientVisibleRoute = await import("../app/api/seafarer/client-visible/route.ts");
const claimReportRoute = await import("../app/api/account/claim-report/route.ts");
const circularsRoute = await import("../app/api/circulars/route.ts");
const docRequestsRoute = await import("../app/api/doc-requests/route.ts");
const remindersRoute = await import("../app/api/reminders/route.ts");
const bulkRoute = await import("../app/api/bulk/route.ts");
const inviteLinkRoute = await import("../app/api/invite/link/route.ts");

const DB_PATH = path.join(TMP, "data", "db.json");
const FLAG = SAMPLE_FLAGSHIP_ID;
const iso = "2026-01-01T00:00:00.000Z";
const iso2 = "2026-01-02T00:00:00.000Z";

function req(url, { method = "GET", body, headers = {}, form } = {}) {
  return {
    method,
    nextUrl: new URL(url, "http://localhost"),
    headers: new Headers(headers),
    json: async () => body ?? {},
    formData: async () => form,
  };
}
const anon = () => {
  globalThis.__TEST_COOKIES = {};
  globalThis.__TEST_AUTH = null;
};
const asDevAgent = () => {
  globalThis.__TEST_COOKIES = { docka_dev_agent: "dev" };
  globalThis.__TEST_AUTH = null;
};
const asDevSeaman = (sid) => {
  globalThis.__TEST_COOKIES = { docka_dev_seaman: sid };
  globalThis.__TEST_AUTH = null;
};

function baseSeafarer(id, open, email, extra = {}) {
  return {
    id, name: `Seafarer ${id}`, rank: "Chief Officer", state: "review",
    shareToken: open, openShareToken: open, emailShareToken: email,
    allowedEmails: [], createdAt: iso, ...extra,
  };
}
const NULL_TERMS = {
  position: null, wageAmount: null, wageCurrency: null, wagePeriod: null,
  leaveDaysPerMonth: null, contractStart: null, durationMonths: null,
  noticeDays: null, allotment: null, repatriationBy: null,
};

await updateDB((db) => {
  db.agents.push(
    { id: "dev", orgName: "Dev Agent", contact: "", createdAt: iso },
    { id: SAMPLE_AGENCY_ID, orgName: "Sample Crewing OU", contact: "", createdAt: iso, isSample: true }
  );
  db.seafarers.push(
    baseSeafarer("r1", "open-r1", "email-r1", { identityVerified: true, verifiedName: "Real One" }),
    baseSeafarer("r2", "open-r2", "email-r2", {
      priorShareTokens: [{ token: "alias-r2", mode: "open" }],
    }),
    baseSeafarer(FLAG, SAMPLE_OPEN_TOKEN, "sample-email-tok", {
      name: "Sample Seafarer — SAMPLE", isSample: true,
      identityVerified: true, verifiedName: "Sample Seafarer",
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
    },
    {
      id: "g-dev-r1", seafarerId: "r1", agentId: "dev", status: "ACTIVE",
      legalBasis: "CONSENT", scope: ["profile", "documents", "log"], shareToken: "g-r1-tok",
      grantedAt: iso, revokedAt: null, expiresAt: null, createdAt: iso, stage: "review",
    }
  );
  db.documents.push(
    {
      id: "doc-cur", seafarerId: FLAG, title: "Curated Cert — SAMPLE", docType: "Document",
      docCategory: null, estonianCode: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z",
      fileName: "sample-file.txt", createdAt: iso, source: "government", registryCountry: "LV",
      registryInputs: { documentId: "SAMPLE-1" }, requiredType: null, reviewStatus: "approved",
      expiryConfirmed: true, sample: true,
    },
    {
      id: "doc-real-upload", seafarerId: FLAG, title: "REAL AGENT UPLOAD", docType: "Document",
      docCategory: null, estonianCode: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z",
      fileName: "real-file.txt", createdAt: iso2, source: "government", registryCountry: "LV",
      registryInputs: { documentId: "REAL-1" }, requiredType: null, reviewStatus: "pending",
      expiryConfirmed: true,
    },
    {
      id: "doc-r1", seafarerId: "r1", title: "R1 Cert", docType: "Document",
      docCategory: null, estonianCode: null, isValid: true, validUntil: "2030-01-01T00:00:00.000Z",
      fileName: null, createdAt: iso, source: "government", registryCountry: "LV",
      registryInputs: { documentId: "R-1" }, requiredType: null, reviewStatus: "approved",
      expiryConfirmed: true,
    }
  );
  db.circulars.push(
    {
      id: "circ-cur", agentId: SAMPLE_AGENCY_ID, authorName: "Sample Crewing", subject: "Welcome — SAMPLE",
      message: "curated hello", filter: null, channel: "email", recipientIds: [FLAG],
      delivered: 0, allowReplies: true, createdAt: iso, sample: true,
    },
    {
      id: "circ-real", agentId: "dev", authorName: "Dev Agent", subject: "REAL CIRCULAR SECRET",
      message: "real message", filter: null, channel: "email", recipientIds: [FLAG, "r1"],
      delivered: 0, allowReplies: false, createdAt: iso2,
    }
  );
  db.circularReplies.push({
    id: "rep-cur", circularId: "circ-cur", agentId: SAMPLE_AGENCY_ID, seafarerId: FLAG,
    authorName: "Sample Seafarer", body: "aye — SAMPLE", visibility: "all",
    idempotencyKey: "seed-rep", createdAt: iso, sample: true,
  });
  db.docRequests.push(
    {
      id: "dr-cur", seafarerId: FLAG, agentId: SAMPLE_AGENCY_ID, requestedBy: "Sample Crewing",
      requiredType: null, label: "Passport — SAMPLE", note: null, dueDate: null,
      status: "pending", createdAt: iso, resolvedAt: null, resolvedVia: null, sample: true,
    },
    {
      id: "dr-real", seafarerId: FLAG, agentId: "dev", requestedBy: "Dev Agent",
      requiredType: null, label: "REAL DOC REQUEST", note: null, dueDate: null,
      status: "pending", createdAt: iso2, resolvedAt: null, resolvedVia: null,
    }
  );
  db.comments.push(
    { id: "c-cur", documentId: null, seafarerId: FLAG, authorName: "Seed", text: "curated note — SAMPLE", createdAt: iso, sample: true },
    { id: "c-real", documentId: null, seafarerId: FLAG, authorName: "Dev Agent", text: "REAL NOTE", createdAt: iso2 }
  );
  db.seaService.push(
    {
      id: "ss-cur", seafarerId: FLAG, vessel: "MV Sample", rank: "Master", imo: null,
      vesselType: null, flagState: null, signOn: "2024-01-01", signOff: "2024-06-01",
      note: null, recordedBy: "seed", createdAt: iso, sample: true,
    },
    {
      id: "ss-real", seafarerId: FLAG, vessel: "MV RealShip", rank: "Master", imo: null,
      vesselType: null, flagState: null, signOn: "2025-01-01", signOff: null,
      note: null, recordedBy: "agent:dev", createdAt: iso2,
    }
  );
  db.assignments.push({
    id: "as-cur", seafarerId: FLAG, agentId: SAMPLE_AGENCY_ID, vessel: "MV Sample",
    sentToSeaAt: iso, returnedAt: iso2, createdAt: iso, sample: true,
  });
  db.issuedSeaTerms.push({
    id: "ist-cur", assignmentId: "as-cur", seafarerId: FLAG, agentId: SAMPLE_AGENCY_ID,
    terms: NULL_TERMS, identityVerifiedAtIssue: true, issuedBy: "Sample Crewing OU",
    generatedAt: iso, sample: true,
  });
  db.appraisals.push(
    {
      id: "ap-cur", seafarerId: FLAG, agentId: SAMPLE_AGENCY_ID, kind: "interview",
      competencySetVersion: "v1", authorName: "Sample", authorOrg: "Sample Crewing OU",
      vessel: null, voyageFrom: null, voyageTo: null, assignmentId: null, scores: [],
      overall: 5, recommend: "yes", rehireReason: null, comments: null,
      sharedComment: "good — SAMPLE", sharedWithSeamanAt: iso, hiddenFromAgentAt: null,
      fastPath: false, idempotencyKey: "", createdAt: iso, updatedAt: null, sample: true,
    },
    {
      id: "ap-real", seafarerId: FLAG, agentId: "dev", kind: "interview",
      competencySetVersion: "v1", authorName: "Dev", authorOrg: "Dev Agent",
      vessel: null, voyageFrom: null, voyageTo: null, assignmentId: null, scores: [],
      overall: 3, recommend: "yes", rehireReason: null, comments: "REAL PRIVATE",
      sharedComment: "REAL SHARED", sharedWithSeamanAt: iso2, hiddenFromAgentAt: null,
      fastPath: false, idempotencyKey: "", createdAt: iso2, updatedAt: null,
    }
  );
  db.profileShareRequests.push({
    id: "psr-1", seafarerId: FLAG, agentId: "dev", bucket: "contact",
    requestedBy: "Dev Agent", status: "pending", createdAt: iso, decidedAt: null,
  });
  db.appraisalDeleteRequests.push({
    id: "adr-1", appraisalId: "ap-real", seafarerId: FLAG, agentId: "dev",
    status: "pending", createdAt: iso, decidedAt: null,
  });
  db.profileChanges.push({
    id: "pcr-1", seafarerId: FLAG, field: "nationality", fieldLabel: "Nationality",
    previousValue: null, proposedValue: "EE", note: null, status: "pending",
    createdAt: iso, decidedBy: null, decidedByAgentId: null, decidedAt: null, decisionNote: null,
  });
});

// ---------------------------------------------------------------------------
// 1. READ PURITY — a battery of sample-token GETs leaves db.json byte-identical.
// ---------------------------------------------------------------------------
test("purity: N sample-token GETs across all FILTER routes -> zero byte diff in db.json", async () => {
  anon();
  _resetSampleRateLimiter();
  const before = fs.readFileSync(DB_PATH);
  for (let i = 0; i < 3; i++) {
    _resetSampleRateLimiter();
    const probes = [
      seafarersRoute.GET(req(`/api/seafarers?token=${SAMPLE_OPEN_TOKEN}`)),
      calendarRoute.GET(req(`/api/calendar?token=${SAMPLE_OPEN_TOKEN}`)),
      cvRoute.GET(req(`/api/cv/${FLAG}?token=${SAMPLE_OPEN_TOKEN}`), { params: { id: FLAG } }),
      filesRoute.GET(req(`/api/files/doc-cur?token=${SAMPLE_OPEN_TOKEN}`), { params: { name: "doc-cur" } }),
      contractRoute.GET(
        req(`/api/contract/${FLAG}?token=${SAMPLE_OPEN_TOKEN}&assignmentId=as-cur`),
        { params: { id: FLAG } }
      ),
      verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-cur&token=${SAMPLE_OPEN_TOKEN}`)),
      commentsRoute.GET(req(`/api/comments?seafarerId=${FLAG}&token=${SAMPLE_OPEN_TOKEN}`)),
      seaServiceRoute.GET(req(`/api/sea-service?seafarerId=${FLAG}&token=${SAMPLE_OPEN_TOKEN}`)),
      inboxRoute.GET(req(`/api/inbox?token=${SAMPLE_OPEN_TOKEN}`)),
      inboxUnreadRoute.GET(req(`/api/inbox/unread?token=${SAMPLE_OPEN_TOKEN}`)),
      appraisalsRoute.GET(req(`/api/appraisals?token=${SAMPLE_OPEN_TOKEN}`)),
      profilePhotoRoute.GET(req(`/api/profile-photo/${FLAG}?token=${SAMPLE_OPEN_TOKEN}`), { params: { id: FLAG } }),
    ];
    const results = await Promise.all(probes);
    for (const r of results) assert.ok(r.status < 500, `probe 500d: ${r.status}`);
  }
  const after = fs.readFileSync(DB_PATH);
  assert.ok(before.equals(after), "sample GETs must perform ZERO writes");
});

// ---------------------------------------------------------------------------
// 2. FILTER verdicts — curated rows only, redaction, public cache headers.
// ---------------------------------------------------------------------------
test("FILTER: seafarers GET serves the curated, redacted view with the public cache header", async () => {
  anon();
  _resetSampleRateLimiter();
  const res = await seafarersRoute.GET(req(`/api/seafarers?token=${SAMPLE_OPEN_TOKEN}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  const body = await res.json();
  assert.equal(body.seafarer.id, FLAG);
  assert.equal(body.seafarer.emailShareToken, undefined, "email token must be redacted");
  assert.equal(body.seafarer.isSample, true);
  assert.deepEqual(body.documents.map((d) => d.id), ["doc-cur"]);
  assert.deepEqual(body.docRequests.map((r) => r.id), ["dr-cur"]);
  assert.deepEqual(body.seaService.map((e) => e.id), ["ss-cur"]);
  assert.deepEqual(body.propagationRequests, []);
  assert.deepEqual(body.appraisalDeleteRequests, []);
  assert.equal(body.flows.length, 1);
  assert.equal(body.flows[0].agentId, SAMPLE_AGENCY_ID);
});

test("FILTER: files GET serves curated files only (real upload 404s on the sample token)", async () => {
  anon();
  _resetSampleRateLimiter();
  const ok = await filesRoute.GET(req(`/api/files/doc-cur?token=${SAMPLE_OPEN_TOKEN}`), { params: { name: "doc-cur" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "public, max-age=300");
  const leak = await filesRoute.GET(req(`/api/files/doc-real-upload?token=${SAMPLE_OPEN_TOKEN}`), { params: { name: "doc-real-upload" } });
  assert.equal(leak.status, 404);
  // The REAL open token still serves its own docs with no-store (behavior preserved).
  const real = await filesRoute.GET(req(`/api/files/doc-real-upload?token=${SAMPLE_OPEN_TOKEN}`), { params: { name: "doc-real-upload" } });
  assert.equal(real.status, 404);
});

test("FILTER: calendar + cv render curated docs only, publicly cacheable", async () => {
  anon();
  _resetSampleRateLimiter();
  const cal = await calendarRoute.GET(req(`/api/calendar?token=${SAMPLE_OPEN_TOKEN}`));
  assert.equal(cal.status, 200);
  assert.equal(cal.headers.get("cache-control"), "public, max-age=300");
  const ics = await cal.text();
  assert.ok(ics.includes("Curated Cert"), "curated doc in ICS");
  assert.ok(!ics.includes("REAL AGENT UPLOAD"), "real upload must not leak into ICS");
  const cv = await cvRoute.GET(req(`/api/cv/${FLAG}?token=${SAMPLE_OPEN_TOKEN}`), { params: { id: FLAG } });
  assert.equal(cv.status, 200);
  assert.equal(cv.headers.get("cache-control"), "public, max-age=300");
  const html = await cv.text();
  assert.ok(html.includes("Curated Cert"));
  assert.ok(!html.includes("REAL AGENT UPLOAD"));
});

test("FILTER: comments/sea-service/appraisals token GETs return curated rows only", async () => {
  anon();
  _resetSampleRateLimiter();
  const c = await (await commentsRoute.GET(req(`/api/comments?seafarerId=${FLAG}&token=${SAMPLE_OPEN_TOKEN}`))).json();
  assert.deepEqual(c.comments.map((x) => x.id), ["c-cur"]);
  const s = await (await seaServiceRoute.GET(req(`/api/sea-service?seafarerId=${FLAG}&token=${SAMPLE_OPEN_TOKEN}`))).json();
  assert.deepEqual(s.entries.map((x) => x.id), ["ss-cur"]);
  const a = await (await appraisalsRoute.GET(req(`/api/appraisals?token=${SAMPLE_OPEN_TOKEN}`))).json();
  assert.equal(a.appraisals.length, 1);
  assert.ok(!JSON.stringify(a).includes("REAL SHARED"), "real appraisal must not leak");
});

test("FILTER: inbox reads show curated circulars/replies only, cacheable", async () => {
  anon();
  _resetSampleRateLimiter();
  const res = await inboxRoute.GET(req(`/api/inbox?token=${SAMPLE_OPEN_TOKEN}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  const body = await res.json();
  assert.deepEqual(body.items.map((i) => i.subject), ["Welcome — SAMPLE"]);
  assert.ok(!JSON.stringify(body).includes("REAL CIRCULAR SECRET"));
  const unread = await (await inboxUnreadRoute.GET(req(`/api/inbox/unread?token=${SAMPLE_OPEN_TOKEN}`))).json();
  assert.equal(unread.count, 1); // only the curated circular counts
});

test("FILTER: verify-link mints proofs for curated docs only", async () => {
  anon();
  _resetSampleRateLimiter();
  const ok = await verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-cur&token=${SAMPLE_OPEN_TOKEN}`));
  assert.equal(ok.status, 200);
  const denied = await verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-real-upload&token=${SAMPLE_OPEN_TOKEN}`));
  assert.equal(denied.status, 403);
  // Real subject unaffected.
  const real = await verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-r1&token=open-r1`));
  assert.equal(real.status, 200);
});

test("FILTER: contract GET renders the curated assignment; sample photo GET is allowed (404 = no photo, not 403)", async () => {
  anon();
  _resetSampleRateLimiter();
  const ok = await contractRoute.GET(
    req(`/api/contract/${FLAG}?token=${SAMPLE_OPEN_TOKEN}&assignmentId=as-cur`),
    { params: { id: FLAG } }
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "public, max-age=300");
  const photo = await profilePhotoRoute.GET(req(`/api/profile-photo/${FLAG}?token=${SAMPLE_OPEN_TOKEN}`), { params: { id: FLAG } });
  assert.equal(photo.status, 404); // allowed, just no photo on file — NOT a 403
});

// ---------------------------------------------------------------------------
// 3. DENY matrix — every sample-token write answers 403 and mutates nothing.
// ---------------------------------------------------------------------------
test("DENY: every sample-token write 403s and leaves db.json byte-identical", async () => {
  anon();
  _resetSampleRateLimiter();
  const before = fs.readFileSync(DB_PATH);
  const expect403 = async (p, label) => {
    const res = await p;
    assert.equal(res.status, 403, `${label} must 403 (got ${res.status})`);
    const body = await res.json().catch(() => null);
    if (body) assert.match(body.error ?? "", /read-only/i);
  };

  // seafarers PATCH — all six token-serviceable segments (census row 1).
  for (const body of [
    { id: FLAG, rank: "Hacked", token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, availability: "open", token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, autoArchiveExpired: true, token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, allowedEmails: ["a@b.c"], token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, reminderSettings: { leadValue: 1 }, token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, clearVerifiedIdentity: true, token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, rotateToken: true, token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, resetOpenToken: true, token: SAMPLE_OPEN_TOKEN },
    { id: FLAG, resetEmailToken: true, token: SAMPLE_OPEN_TOKEN },
  ]) {
    await expect403(seafarersRoute.PATCH(req("/api/seafarers", { method: "PATCH", body })), `seafarers PATCH ${Object.keys(body)[1]}`);
  }

  // documents: token writes + curated-doc immutability.
  const fd = new FormData();
  fd.set("seafarerId", FLAG);
  fd.set("title", "Injected");
  fd.set("token", SAMPLE_OPEN_TOKEN);
  await expect403(documentsRoute.POST(req("/api/documents", { method: "POST", form: fd })), "documents POST token");
  await expect403(
    documentsRoute.PATCH(req("/api/documents", { method: "PATCH", body: { documentId: "doc-cur", title: "X", token: SAMPLE_OPEN_TOKEN } })),
    "documents PATCH token"
  );
  await expect403(
    documentsRoute.DELETE(req("/api/documents", { method: "DELETE", body: { documentId: "doc-cur", token: SAMPLE_OPEN_TOKEN } })),
    "documents DELETE token"
  );

  await expect403(
    commentsRoute.POST(req("/api/comments", { method: "POST", body: { seafarerId: FLAG, text: "spam", token: SAMPLE_OPEN_TOKEN } })),
    "comments POST token"
  );
  await expect403(
    seaServiceRoute.POST(req("/api/sea-service", { method: "POST", body: { seafarerId: FLAG, vessel: "X", rank: "Y", signOn: "2024-01-01", token: SAMPLE_OPEN_TOKEN } })),
    "sea-service POST token"
  );
  await expect403(
    seaServiceRoute.PATCH(req("/api/sea-service", { method: "PATCH", body: { id: "ss-cur", vessel: "X", token: SAMPLE_OPEN_TOKEN } })),
    "sea-service PATCH curated"
  );
  await expect403(
    seaServiceRoute.DELETE(req("/api/sea-service", { method: "DELETE", body: { id: "ss-cur", token: SAMPLE_OPEN_TOKEN } })),
    "sea-service DELETE curated"
  );

  const photoFd = new FormData();
  photoFd.set("token", SAMPLE_OPEN_TOKEN);
  await expect403(
    profilePhotoRoute.POST(req(`/api/profile-photo/${FLAG}`, { method: "POST", form: photoFd }), { params: { id: FLAG } }),
    "profile-photo POST"
  );
  await expect403(
    profilePhotoRoute.DELETE(req(`/api/profile-photo/${FLAG}`, { method: "DELETE", body: { token: SAMPLE_OPEN_TOKEN } }), { params: { id: FLAG } }),
    "profile-photo DELETE"
  );

  await expect403(
    profileUpdatesRoute.POST(req("/api/profile-updates", { method: "POST", body: { seafarerId: FLAG, token: SAMPLE_OPEN_TOKEN, field: "nationality", proposedValue: "XX" } })),
    "profile-updates POST"
  );
  await expect403(
    profileUpdatesRoute.PATCH(req("/api/profile-updates", { method: "PATCH", body: { id: "pcr-1", decision: "cancel", seafarerId: FLAG, token: SAMPLE_OPEN_TOKEN } })),
    "profile-updates PATCH cancel"
  );
  await expect403(
    propagationRoute.POST(req("/api/access/propagation", { method: "POST", body: { seafarerId: FLAG, agentId: "dev", bucket: "contact", on: true, token: SAMPLE_OPEN_TOKEN } })),
    "propagation POST"
  );
  await expect403(
    propagationRequestRoute.PATCH(req("/api/access/propagation/request", { method: "PATCH", body: { requestId: "psr-1", decision: "approved", token: SAMPLE_OPEN_TOKEN } })),
    "propagation request PATCH"
  );
  await expect403(
    appraisalDeleteRoute.PATCH(req("/api/appraisals/delete-request", { method: "PATCH", body: { requestId: "adr-1", decision: "delete", token: SAMPLE_OPEN_TOKEN } })),
    "appraisal delete-request PATCH"
  );
  await expect403(
    clientVisibleRoute.POST(req("/api/seafarer/client-visible", { method: "POST", body: { seafarerId: FLAG, agentId: "dev", on: true, token: SAMPLE_OPEN_TOKEN } })),
    "client-visible POST"
  );
  await expect403(
    inboxSeenRoute.POST(req("/api/inbox/seen", { method: "POST", body: { seenAt: iso2, token: SAMPLE_OPEN_TOKEN } })),
    "inbox seen POST"
  );

  // AGENT writes on the sample subject that must ALSO deny (census row 1 + 2).
  asDevAgent();
  await expect403(
    seafarersRoute.PATCH(req("/api/seafarers", { method: "PATCH", body: { id: FLAG, vessel: "MV Agent" } })),
    "agent vessel write"
  );
  await expect403(
    seafarersRoute.PATCH(req("/api/seafarers", { method: "PATCH", body: { id: FLAG, rank: "Agent Rank" } })),
    "agent rank write"
  );
  await expect403(
    documentsRoute.PATCH(req("/api/documents", { method: "PATCH", body: { documentId: "doc-cur", title: "Agent edit" } })),
    "agent PATCH curated doc"
  );
  await expect403(
    documentsRoute.DELETE(req("/api/documents", { method: "DELETE", body: { documentId: "doc-cur" } })),
    "agent DELETE curated doc"
  );
  anon();

  const after = fs.readFileSync(DB_PATH);
  assert.ok(before.equals(after), "the DENY battery must not change db.json");
});

// ---------------------------------------------------------------------------
// 4. Cross-mode negative probes (v4-2c).
// ---------------------------------------------------------------------------
test("cross-mode: the email token keeps today's 404/401 on every open-only route", async () => {
  anon();
  const probes = [
    [seafarersRoute.GET(req(`/api/seafarers?token=email-r1`)), 404],
    [commentsRoute.GET(req(`/api/comments?seafarerId=r1&token=email-r1`)), 404],
    [seaServiceRoute.GET(req(`/api/sea-service?seafarerId=r1&token=email-r1`)), 404],
    [inboxRoute.GET(req(`/api/inbox?token=email-r1`)), 401],
    [inboxUnreadRoute.GET(req(`/api/inbox/unread?token=email-r1`)), 401],
    [inboxSeenRoute.POST(req(`/api/inbox/seen`, { method: "POST", body: { seenAt: iso2, token: "email-r1" } })), 401],
    [documentsRoute.PATCH(req("/api/documents", { method: "PATCH", body: { documentId: "doc-r1", title: "X", token: "email-r1" } })), 404],
  ];
  for (const [p, want] of probes) {
    const res = await p;
    assert.equal(res.status, want);
  }
});

test("cross-mode: the alias token keeps today's 404/401/403 on EVERY API route", async () => {
  anon();
  const probes = [
    [seafarersRoute.GET(req(`/api/seafarers?token=alias-r2`)), 404],
    [seafarersRoute.PATCH(req("/api/seafarers", { method: "PATCH", body: { id: "r2", rank: "X", token: "alias-r2" } })), 404],
    [documentsRoute.PATCH(req("/api/documents", { method: "PATCH", body: { documentId: "doc-r1", title: "X", token: "alias-r2" } })), 404],
    [commentsRoute.GET(req(`/api/comments?seafarerId=r2&token=alias-r2`)), 404],
    [calendarRoute.GET(req(`/api/calendar?token=alias-r2`)), 404],
    [cvRoute.GET(req(`/api/cv/r2?token=alias-r2`), { params: { id: "r2" } }), 404],
    [contractRoute.GET(req(`/api/contract/r2?token=alias-r2&assignmentId=x`), { params: { id: "r2" } }), 404],
    [filesRoute.GET(req(`/api/files/doc-r1?token=alias-r2`), { params: { name: "doc-r1" } }), 404],
    [profilePhotoRoute.GET(req(`/api/profile-photo/r2?token=alias-r2`), { params: { id: "r2" } }), 404],
    [seaServiceRoute.GET(req(`/api/sea-service?seafarerId=r2&token=alias-r2`)), 404],
    [profileUpdatesRoute.POST(req("/api/profile-updates", { method: "POST", body: { seafarerId: "r2", token: "alias-r2", field: "nationality", proposedValue: "XX" } })), 404],
    [propagationRoute.POST(req("/api/access/propagation", { method: "POST", body: { seafarerId: "r2", agentId: "dev", bucket: "contact", on: true, token: "alias-r2" } })), 404],
    [propagationRequestRoute.PATCH(req("/api/access/propagation/request", { method: "PATCH", body: { requestId: "psr-1", decision: "approved", token: "alias-r2" } })), 404],
    [appraisalsRoute.GET(req(`/api/appraisals?token=alias-r2`)), 404],
    [appraisalDeleteRoute.PATCH(req("/api/appraisals/delete-request", { method: "PATCH", body: { requestId: "adr-1", decision: "keep", token: "alias-r2" } })), 404],
    [clientVisibleRoute.POST(req("/api/seafarer/client-visible", { method: "POST", body: { seafarerId: "r2", agentId: "dev", on: true, token: "alias-r2" } })), 404],
    [inboxRoute.GET(req(`/api/inbox?token=alias-r2`)), 401],
    [verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-r1&token=alias-r2`)), 403],
  ];
  for (const [p, want] of probes) {
    const res = await p;
    assert.equal(res.status, want);
  }
});

// ---------------------------------------------------------------------------
// 5. Golden two-run stability for REAL subjects (volatile fields masked).
// ---------------------------------------------------------------------------
test("golden: real-subject reads are byte-stable across two runs (masked)", async () => {
  anon();
  const mask = (obj) =>
    JSON.stringify(obj, (k, v) =>
      k === "shareTokenLastUsedAt" || k === "path" ? "<volatile>" : v
    );
  const capture = async () => {
    const out = [];
    const s = await seafarersRoute.GET(req(`/api/seafarers?token=open-r1`));
    out.push(mask(await s.json()));
    const cal = await calendarRoute.GET(req(`/api/calendar?token=open-r1`));
    out.push(await cal.text());
    const cv = await cvRoute.GET(req(`/api/cv/r1?token=open-r1`), { params: { id: "r1" } });
    out.push(await cv.text());
    const ap = await appraisalsRoute.GET(req(`/api/appraisals?token=open-r1`));
    out.push(mask(await ap.json()));
    const ss = await seaServiceRoute.GET(req(`/api/sea-service?seafarerId=r1&token=open-r1`));
    out.push(mask(await ss.json()));
    return out.join("\n---\n");
  };
  const run1 = await capture();
  const run2 = await capture();
  assert.equal(run1, run2, "normalized golden captures must be byte-stable");
  assert.ok(run1.includes("R1 Cert"), "golden capture renders the real doc");
});

// ---------------------------------------------------------------------------
// 6. ALLOW verdicts + §D7 notify-skips + invite-link DENY.
// ---------------------------------------------------------------------------
test("ALLOW: agent stage move on the sample subject still works (board demo intact)", async () => {
  asDevAgent();
  const res = await seafarersRoute.PATCH(
    req("/api/seafarers", { method: "PATCH", body: { id: FLAG, state: "returning" } })
  );
  assert.equal(res.status, 200);
  const g = readDB().accessGrants.find((x) => x.id === "g-dev-flag");
  assert.equal(g.stage, "returning");
  anon();
});

test("ALLOW: agent doc upload to the sample subject lands NON-curated (never public)", async () => {
  asDevAgent();
  const fd = new FormData();
  fd.set("seafarerId", FLAG);
  fd.set("title", "Agent fresh upload");
  fd.set("file", new File(["agent note"], "agent-note.txt", { type: "text/plain" }));
  const res = await documentsRoute.POST(req("/api/documents", { method: "POST", form: fd }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.ok);
  const doc = readDB().documents.find((d) => d.title === "Agent fresh upload");
  assert.ok(doc, "agent doc created");
  assert.notEqual(doc.sample, true, "route-created rows are never curated");
  anon();
  // …and the public sample GET must not show it.
  _resetSampleRateLimiter();
  const pub = await (await seafarersRoute.GET(req(`/api/seafarers?token=${SAMPLE_OPEN_TOKEN}`))).json();
  assert.ok(!pub.documents.some((d) => d.title === "Agent fresh upload"));
});

test("§D7: circulars POST keeps the sample id in recipientIds but SKIPS the send", async () => {
  asDevAgent();
  const notifBefore = readDB().notifications.length;
  const res = await circularsRoute.POST(
    req("/api/circulars", { method: "POST", body: { subject: "Fleet note", message: "hello all" } })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.circular.recipientIds.includes(FLAG), "sample stays a recipient");
  const flagRow = body.results.find((r) => r.seafarerId === FLAG);
  assert.match(flagRow.delivery, /sample/i);
  const notifAfter = readDB().notifications.length;
  // Exactly the real recipients produced notification-log rows (r1 only).
  assert.equal(notifAfter - notifBefore, 1);
  anon();
});

test("§D7: doc-requests POST to the sample subject skips notify; reminders/bulk skip sample rows", async () => {
  asDevAgent();
  const notifBefore = readDB().notifications.length;
  const dr = await docRequestsRoute.POST(
    req("/api/doc-requests", { method: "POST", body: { seafarerId: FLAG, items: [{ label: "Test ask" }], notify: true } })
  );
  assert.equal(dr.status, 200);
  const drBody = await dr.json();
  assert.equal(drBody.notified, null, "notify skipped for the sample subject");

  const rem = await remindersRoute.POST(
    req("/api/reminders", { method: "POST", body: { seafarerIds: [FLAG, "r1"], kind: "request" } })
  );
  assert.equal(rem.status, 200);
  const remBody = await rem.json();
  assert.ok(!remBody.reminders.some((r) => r.seafarerId === FLAG), "sample skipped from reminders");

  const bulk = await bulkRoute.POST(
    req("/api/bulk", { method: "POST", body: { action: "message", seafarerIds: [FLAG, "r1"], message: "bulk hello" } })
  );
  assert.equal(bulk.status, 200);
  const bulkBody = await bulk.json();
  assert.ok(!bulkBody.results.some((r) => r.seafarerId === FLAG), "sample skipped from bulk message");

  const tag = await bulkRoute.POST(
    req("/api/bulk", { method: "POST", body: { action: "tag", seafarerIds: [FLAG, "r1"], tag: "Hot" } })
  );
  assert.equal(tag.status, 200);
  const db = readDB();
  assert.ok(!(db.seafarers.find((s) => s.id === FLAG).tags ?? []).includes("Hot"), "tag DENIED on sample");
  assert.ok((db.seafarers.find((s) => s.id === "r1").tags ?? []).includes("Hot"), "tag applied to real row");

  const notifAfter = readDB().notifications.length;
  const flagNotifs = readDB().notifications.slice(notifBefore, notifAfter);
  assert.ok(
    !flagNotifs.some((n) => (n.to ?? "").includes(FLAG) || (n.subject ?? "").includes("SAMPLE")),
    "no notification row references the sample subject"
  );
  anon();
});

test("invite-link paste DENIES sample ids (share auto-grant seam is the only lane)", async () => {
  asDevAgent();
  const grantsBefore = readDB().accessGrants.length;
  const res = await inviteLinkRoute.POST(
    req("/api/invite/link", { method: "POST", body: { links: [`https://docka.me/share/${SAMPLE_OPEN_TOKEN}`] } })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added.length, 0);
  assert.equal(body.skipped[0]?.status, "not-found");
  assert.equal(readDB().accessGrants.length, grantsBefore, "no grant minted");
  anon();
});

// ---------------------------------------------------------------------------
// 7. Belt-and-braces + claim-report.
// ---------------------------------------------------------------------------
test("belt-and-braces: /me 404s and inbox-reply 403s even for a dev-door sample session", async () => {
  asDevSeaman(FLAG);
  const me = await seafarersMeRoute.GET();
  assert.equal(me.status, 404);
  const reply = await inboxReplyRoute.POST(
    req("/api/inbox/reply", { method: "POST", body: { circularId: "circ-cur", body: "hi", idempotencyKey: "k1" } })
  );
  assert.equal(reply.status, 403);
  const rb = await reply.json();
  assert.match(rb.error, /read-only/i);
  anon();
});

test("claim-report: sample token gets the SAME generic negative as an unknown token", async () => {
  __setTestAccountSession({ user: { email: "reporter@example.com" } });
  const mk = (token) =>
    new Request("http://localhost/api/account/claim-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  const sample = await claimReportRoute.POST(mk(SAMPLE_OPEN_TOKEN));
  const unknown = await claimReportRoute.POST(mk("totally-unknown-token"));
  assert.equal(sample.status, 400);
  assert.equal(unknown.status, 400);
  const sb = await sample.json();
  const ub = await unknown.json();
  assert.deepEqual(sb, ub, "no oracle: sample and unknown tokens are indistinguishable");
  const real = await claimReportRoute.POST(mk("open-r1"));
  assert.equal(real.status, 200);
  __setTestAccountSession(undefined);
});

// ---------------------------------------------------------------------------
// 9. Two-pass adversarial capture (plan Phase-7 / v4-4): every public sample
// output is BYTE-IDENTICAL before and after an agent piles real interactions
// onto the flagship — a doc whose cert number COLLIDES with a curated one, a
// sea-service row and an assignment. (The /share/<token> HTML half of this test
// runs in the Playwright driver, tests/sample-shots.mjs — the page is JSX and
// not importable under the node test loader.)
// ---------------------------------------------------------------------------
test("two-pass: adversarial agent writes leave every public sample output byte-identical", async () => {
  const capture = async () => {
    anon();
    _resetSampleRateLimiter();
    const out = [];
    out.push(await (await calendarRoute.GET(req(`/api/calendar?token=${SAMPLE_OPEN_TOKEN}`))).text());
    out.push(await (await cvRoute.GET(req(`/api/cv/${FLAG}?token=${SAMPLE_OPEN_TOKEN}`), { params: { id: FLAG } })).text());
    out.push(
      await (
        await contractRoute.GET(
          req(`/api/contract/${FLAG}?token=${SAMPLE_OPEN_TOKEN}&assignmentId=as-cur`),
          { params: { id: FLAG } }
        )
      ).text()
    );
    out.push(await (await verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-cur&token=${SAMPLE_OPEN_TOKEN}`))).text());
    // The colliding-number doc must ALSO never become proof-mintable.
    const adv = await verifyLinkRoute.GET(req(`/api/verify-link?documentId=doc-advers&token=${SAMPLE_OPEN_TOKEN}`));
    out.push(`advers:${adv.status}`);
    out.push(await (await seafarersRoute.GET(req(`/api/seafarers?token=${SAMPLE_OPEN_TOKEN}`))).text());
    out.push(await (await inboxRoute.GET(req(`/api/inbox?token=${SAMPLE_OPEN_TOKEN}`))).text());
    return out.join("\n---\n");
  };

  const pass1 = await capture();

  // Adversarial interactions: the doc lands through the REAL agent route, then
  // gets the colliding cert number + friends stamped in-store (state identical
  // to what the session-gated routes persist).
  asDevAgent();
  const fd = new FormData();
  fd.set("seafarerId", FLAG);
  fd.set("title", "Adversarial Collider");
  fd.set("file", new File(["collide"], "collider.txt", { type: "text/plain" }));
  const up = await documentsRoute.POST(req("/api/documents", { method: "POST", form: fd }));
  assert.equal(up.status, 200);
  await updateDB((db) => {
    const doc = db.documents.find((d) => d.title === "Adversarial Collider");
    doc.id = "doc-advers";
    doc.certNumber = "SAMPLE-1"; // collides with the curated registry number
    db.seaService.push({
      id: "ss-advers", seafarerId: FLAG, vessel: "MV Adversary", rank: "Master", imo: null,
      vesselType: null, flagState: null, signOn: "2026-01-01", signOff: null,
      note: null, recordedBy: "agent:dev", createdAt: iso2,
    });
    db.assignments.push({
      id: "as-advers", seafarerId: FLAG, agentId: "dev", vessel: "MV Adversary",
      sentToSeaAt: iso2, returnedAt: null, createdAt: iso2,
    });
  });

  const pass2 = await capture();
  assert.equal(pass1, pass2, "public sample outputs must not move under adversarial writes");
  assert.ok(pass1.includes("advers:403"), "colliding doc stays un-mintable in BOTH passes");

  // Cleanup so later suites see the fixture state they expect.
  await updateDB((db) => {
    db.documents = db.documents.filter((d) => d.id !== "doc-advers");
    db.seaService = db.seaService.filter((e) => e.id !== "ss-advers");
    db.assignments = db.assignments.filter((a) => a.id !== "as-advers");
  });
});
