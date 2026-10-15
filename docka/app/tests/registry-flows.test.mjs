// Increment 6/7/8 server-contract flow tests (plan §4.3/§4.4/§5.3/§5.4) —
// drive the REAL HTTP API on the dev server (:3000, REGISTRY_MOCK=1 + mock
// registry on :4123). No browser: plain fetch with explicit cookie handling.
//
//   1. Role gate: a seafarer (owner share token) PATCHing checkedVia -> 403;
//      a signed-in, granted agent -> ok, checkedVia persists.
//   2. checkedVia validation: bad value -> 400; without reviewerChecked -> 400.
//   3. Manual-verification workflow over HTTP: seafarer paste of a manual-wave
//      (RO) URL stamps `requested` (increment-3 behavior, verified); the agent
//      "request" action is idempotent (requestedAt never overwritten);
//      confirm sets confirmedAt/By once; close only closes an OPEN request;
//      a seafarer attempting any manualAction -> 403.
//   4. Outward proof generalization (increment 8, §5.4): a DK-QR-verified doc
//      mints a proof naming the Danish Maritime Authority with a LIVE re-check
//      (via the mock); a UK doc re-checks live from its stored registryInputs
//      and renders the HONEST SNAPSHOT once the stored DOB is gone; BG / UA-TCCS
//      `source:"registry"` docs never mint a proof (§2.5 gate); the /verify
//      surface is rate-limited — over the limit it stays friendly and performs
//      ZERO outbound fetches (journal delta).
//
// Prereqs (the gate runner handles both): mock registry on :4123 and `next dev`
// with the mockEnv() env block.
//
// Run: node tests/registry-flows.test.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { MOCK_REGISTRY_PORT, MOCK_CODES } from "./mock-registry.mjs";

const BASE = process.env.DOCKA_BASE_URL ?? "http://localhost:3000";

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

// Extract a "name=value; name2=value2" Cookie header from a response's
// Set-Cookie headers.
function cookieFrom(res) {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

// NOTE: POST /api/documents is auth-gated (fail-closed, 174eabc) — every paste
// must carry the OWNER's share token (seaman-context trust model) or an agent
// session; a token-less paste answers the indistinguishable "Unknown seafarer."
async function pasteDoc(seafarerId, code, extra = {}) {
  const fd = new FormData();
  fd.append("seafarerId", seafarerId);
  fd.append("code", code);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
  return { status: res.status, body: await res.json() };
}

// ---- Increment-8 proof helpers (§5.4) -----------------------------------

// The dev server signs verify tokens with AUTH_SECRET from app/.env.local
// (same fallback as lib/verify-record.ts). Minting the token here lets us
// assert that even a WELL-FORMED token for a `source:"registry"` doc yields no
// proof — the §2.5 eligibility gate, not token secrecy, is what blocks it.
function verifySecret() {
  try {
    const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
    const m = /^AUTH_SECRET=(.+)$/m.exec(env);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    /* fall through to the dev default */
  }
  return "docka-dev-verify-secret";
}

function mintToken(documentId) {
  const sig = crypto
    .createHmac("sha256", verifySecret())
    .update(`verify:${documentId}`)
    .digest("hex")
    .slice(0, 24);
  return `${documentId}~${sig}`;
}

async function journalLen() {
  const j = await fetch(`${BASE}/api/registry-test`).then((r) => r.json());
  return j.journal.length;
}

// Per-scenario client IPs (the REGISTRY_MOCK-only test header, §2.4) keep each
// proof scenario in its own rate-limit bucket.
async function getProof(token, ip) {
  const res = await fetch(`${BASE}/api/verify/${token}`, {
    headers: ip ? { "x-registry-test-ip": ip } : {},
  });
  return { status: res.status, body: await res.json() };
}

async function getProofPage(token, ip) {
  const res = await fetch(`${BASE}/verify/${token}`, {
    headers: ip ? { "x-registry-test-ip": ip } : {},
  });
  return { status: res.status, html: await res.text() };
}

async function resetRegistryState() {
  await fetch(`${BASE}/api/registry-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });
}

async function patchDoc(body, cookie) {
  const res = await fetch(`${BASE}/api/documents`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ---- Reachability preflight (test:registry aggregator, 2026-08-24): this
  // suite needs a RUNNING `next dev` (mockEnv) + tests/mock-registry.mjs. In
  // a bare checkout (npm run test:registry without a server) SKIP loudly with
  // exit 0 instead of failing — a real failure with the server up still fails.
  try {
    await fetch(`${BASE}/api/registry-test`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(
      `registry-flows: SKIPPED — dev server not reachable at ${BASE}. ` +
        "Start `next dev` (REGISTRY_MOCK=1 + REGISTRY_BASE_* mockEnv) and node tests/mock-registry.mjs to run the flow suite."
    );
    process.exit(0);
  }

  // ---- Preflight (§6.2): server in mock mode, mock answering, state reset.
  const pre = await fetch(`${BASE}/api/registry-test`).then((r) => r.json());
  assert.equal(pre.ok && pre.mock, true, "dev server must run with REGISTRY_MOCK=1");
  const health = await fetch(`http://127.0.0.1:${MOCK_REGISTRY_PORT}/__health`).then((r) =>
    r.text()
  );
  assert.equal(health, "ok", "mock registry must answer on :4123");
  await fetch(`${BASE}/api/registry-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });
  ok("preflight — dev server in mock mode, mock registry healthy, state reset");

  // ---- Seaman: dev seaman session -> named profile + share token.
  const seamanLogin = await fetch(`${BASE}/api/seaman-test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(seamanLogin.ok, true, "seaman-test-login must succeed (non-prod dev server)");
  const seamanCookie = cookieFrom(seamanLogin);
  const selfRes = await fetch(`${BASE}/api/seafarers/self`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: seamanCookie },
    body: JSON.stringify({ name: "Flows Tester" }),
  });
  const self = await selfRes.json();
  assert.equal(self.ok, true, "seafarers/self must create the profile");
  const sid = self.seafarer.id;
  const token = self.seafarer.shareToken;
  assert.ok(sid && token, "seafarer id + share token required");
  ok("setup — seaman profile created via the dev door");

  // ---- GR (assisted) doc: stored unverified with registryCountry, no fetch.
  const gr = await pasteDoc(sid, "https://stcw.hcg.gr/verify-stcw/GRFLOW9001", { token });
  assert.equal(gr.body.ok, true, `GR paste should store: ${JSON.stringify(gr.body).slice(0, 200)}`);
  assert.equal(gr.body.outcome?.kind, "assist", "GR must resolve to the assist outcome");
  assert.equal(gr.body.document?.registryCountry, "GR", "GR doc labeled registryCountry GR");
  const grDocId = gr.body.document.id;
  const journal = await fetch(`${BASE}/api/registry-test`).then((r) => r.json());
  assert.equal(journal.journal.length, 0, "assisted GR paste must trigger ZERO registry fetches");
  ok("GR assisted paste — doc stored unverified, registryCountry GR, journal EMPTY");

  // ---- 1a. ROLE GATE: seafarer (owner token) setting checkedVia -> 403.
  let r = await patchDoc({
    documentId: grDocId,
    token,
    reviewerChecked: true,
    checkedVia: "registry-portal",
    checkedBy: "Seaman Forger",
  });
  assert.equal(r.status, 403, `seafarer checkedVia must 403, got ${r.status}`);
  assert.equal(r.body.ok, false);
  ok("role gate — seafarer PATCH setting checkedVia -> 403");

  // The doc is untouched (no forged audit fact).
  // ---- Agent session + grant (share-link open forms the consent grant).
  const agentLogin = await fetch(`${BASE}/api/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(agentLogin.ok, true, "test-login must succeed");
  const agentCookie = cookieFrom(agentLogin);
  const share = await fetch(`${BASE}/share/${token}`, { headers: { Cookie: agentCookie } });
  assert.equal(share.ok, true, "agent share open (grant formation) must succeed");
  ok("setup — agent signed in + granted via the share link");

  // Verify the seafarer's forge attempt left nothing behind.
  const docsAfterForge = await fetch(`${BASE}/api/documents?seafarerId=${sid}`, {
    headers: { Cookie: agentCookie },
  }).then((x) => x.json());
  const grBefore = docsAfterForge.documents.find((d) => d.id === grDocId);
  assert.equal(grBefore.reviewerChecked ?? false, false, "403 must leave reviewerChecked unset");
  assert.equal(grBefore.checkedVia ?? null, null, "403 must leave checkedVia unset");
  ok("role gate — the rejected seafarer attempt persisted NOTHING");

  // ---- 2. checkedVia validation.
  r = await patchDoc(
    { documentId: grDocId, reviewerChecked: true, checkedVia: "carrier-pigeon" },
    agentCookie
  );
  assert.equal(r.status, 400, "invalid checkedVia value must 400");
  r = await patchDoc({ documentId: grDocId, checkedVia: "registry-portal" }, agentCookie);
  assert.equal(r.status, 400, "checkedVia without reviewerChecked must 400");
  ok("validation — bad checkedVia value 400s; checkedVia without reviewerChecked 400s");

  // ---- 1b. Agent sets checkedVia:"registry-portal" -> ok + persists.
  r = await patchDoc(
    {
      documentId: grDocId,
      reviewerChecked: true,
      checkedVia: "registry-portal",
      checkedBy: "Flows Agent",
    },
    agentCookie
  );
  assert.equal(r.status, 200, `agent checkedVia must succeed, got ${r.status}`);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.document.reviewerChecked, true);
  assert.equal(r.body.document.checkedVia, "registry-portal");
  assert.equal(r.body.document.checkedBy, "Flows Agent");
  const persisted = await fetch(`${BASE}/api/documents?seafarerId=${sid}`, {
    headers: { Cookie: agentCookie },
  }).then((x) => x.json());
  const grAfter = persisted.documents.find((d) => d.id === grDocId);
  assert.equal(grAfter.checkedVia, "registry-portal", "checkedVia must persist in db.json");
  ok("agent — checkedVia:'registry-portal' accepted, recorded and persisted");

  // ---- 3. Manual workflow (RO). Seafarer paste stamps `requested` (§5.2).
  const ro1 = await pasteDoc(sid, "https://portal.rna.ro/verify/ROFLOW1", { token });
  assert.equal(ro1.body.ok, true, `RO paste should store: ${JSON.stringify(ro1.body).slice(0, 200)}`);
  assert.equal(ro1.body.outcome?.kind, "manual", "RO must resolve to the manual outcome");
  assert.equal(
    ro1.body.document?.manualVerification?.status,
    "requested",
    "seafarer RO paste must stamp manualVerification requested (increment-3 behavior)"
  );
  const ro1Id = ro1.body.document.id;
  const ro1RequestedAt = ro1.body.document.manualVerification.requestedAt;
  const ro1RequestedBy = ro1.body.document.manualVerification.requestedBy;
  ok("RO manual paste — doc stored with manualVerification 'requested'");

  // Seafarer attempting ANY manualAction -> 403.
  r = await patchDoc({ documentId: ro1Id, token, manualAction: "confirm" });
  assert.equal(r.status, 403, `seafarer manualAction must 403, got ${r.status}`);
  r = await patchDoc({ documentId: ro1Id, token, manualAction: "request" });
  assert.equal(r.status, 403);
  ok("role gate — seafarer manualAction (request/confirm) -> 403");

  // Invalid action value -> 400.
  r = await patchDoc({ documentId: ro1Id, manualAction: "frobnicate" }, agentCookie);
  assert.equal(r.status, 400, "invalid manualAction must 400");
  ok("validation — unknown manualAction 400s");

  // Agent re-request is IDEMPOTENT: requestedAt/By never overwritten (§4.4).
  r = await patchDoc(
    { documentId: ro1Id, manualAction: "request", checkedBy: "Flows Agent" },
    agentCookie
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.document.manualVerification.status, "requested");
  assert.equal(r.body.document.manualVerification.requestedAt, ro1RequestedAt);
  assert.equal(r.body.document.manualVerification.requestedBy, ro1RequestedBy);
  ok("agent — re-request (double-click / re-POST) never overwrites requestedAt/By");

  // F8 — a confirm WITHOUT an evidence note is refused (400): a bare click
  // can never mint "confirmed".
  r = await patchDoc(
    { documentId: ro1Id, manualAction: "confirm", checkedBy: "Flows Agent" },
    agentCookie
  );
  assert.equal(r.status, 400, "confirm without evidenceNote must 400");
  assert.match(r.body.error ?? "", /evidence/i);
  ok("F8 — 'Mark confirmed' without an evidence note -> 400");

  // Agent confirms once the authority replies — WITH the required evidence.
  r = await patchDoc(
    {
      documentId: ro1Id,
      manualAction: "confirm",
      checkedBy: "Flows Agent",
      evidenceNote: "authority reply 12 Jun, ref #42",
    },
    agentCookie
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.document.manualVerification.status, "confirmed");
  assert.equal(r.body.document.manualVerification.confirmedBy, "Flows Agent");
  assert.ok(r.body.document.manualVerification.confirmedAt);
  assert.equal(
    r.body.document.manualVerification.evidenceNote,
    "authority reply 12 Jun, ref #42"
  );
  const firstConfirmedAt = r.body.document.manualVerification.confirmedAt;
  ok("agent — 'Mark confirmed' sets confirmed + confirmedBy/At + evidenceNote (F8)");

  // A second confirm never re-stamps the original confirmation (or evidence).
  r = await patchDoc(
    {
      documentId: ro1Id,
      manualAction: "confirm",
      checkedBy: "Other Agent",
      evidenceNote: "a different note",
    },
    agentCookie
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.document.manualVerification.confirmedAt, firstConfirmedAt);
  assert.equal(r.body.document.manualVerification.confirmedBy, "Flows Agent");
  assert.equal(
    r.body.document.manualVerification.evidenceNote,
    "authority reply 12 Jun, ref #42"
  );
  ok("agent — repeated confirm is idempotent (original confirmation + evidence stand)");

  // Close-unavailable on a SECOND open request; then request/close no-ops.
  const ro2 = await pasteDoc(sid, "https://portal.rna.ro/verify/ROFLOW2", { token });
  assert.equal(ro2.body.ok, true);
  const ro2Id = ro2.body.document.id;
  const ro2RequestedAt = ro2.body.document.manualVerification.requestedAt;
  r = await patchDoc({ documentId: ro2Id, manualAction: "close" }, agentCookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.document.manualVerification.status, "closed_unavailable");
  r = await patchDoc({ documentId: ro2Id, manualAction: "request" }, agentCookie);
  assert.equal(r.status, 200);
  assert.equal(r.body.document.manualVerification.status, "closed_unavailable");
  assert.equal(r.body.document.manualVerification.requestedAt, ro2RequestedAt);
  ok("agent — 'Close — unavailable' closes an open request; later re-request never resurrects it");

  // =====================================================================
  // ---- 4. Outward proof generalization (increment 8, §5.4) ------------
  // =====================================================================

  // ---- 4a. DK QR-verified doc mints a proof with Danish naming + LIVE re-check.
  const dk = await pasteDoc(sid, `https://verify.dma.dk/validateqr/${MOCK_CODES.DK_VALID}`, { token });
  assert.equal(dk.body.ok, true, `DK QR paste should verify: ${JSON.stringify(dk.body).slice(0, 200)}`);
  assert.equal(dk.body.document.source, "government", "DK QR (capability token) doc must be government");
  assert.equal(dk.body.document.registryCountry, "DK");
  const dkDocId = dk.body.document.id;

  const dkLink = await fetch(`${BASE}/api/verify-link?documentId=${dkDocId}&token=${token}`).then(
    (r) => r.json()
  );
  assert.equal(dkLink.ok, true, "verify-link must mint for a DK government doc");
  assert.ok(dkLink.path.startsWith("/verify/"), `verify-link path looks wrong: ${dkLink.path}`);
  const dkToken = dkLink.path.slice("/verify/".length);
  assert.equal(dkToken, mintToken(dkDocId), "minted token must match the HMAC recipe");
  ok("DK — QR-verified doc mints a public verify link");

  // Clear the result cache so the proof re-check demonstrably hits the registry.
  await resetRegistryState();
  const dkLen0 = await journalLen();
  const dkProof = await getProof(dkToken, "10.9.9.1");
  assert.equal(dkProof.status, 200);
  assert.equal(dkProof.body.ok, true);
  assert.equal(dkProof.body.registryCountry, "DK");
  assert.equal(dkProof.body.recheckState, "live", "DK proof must re-check LIVE");
  assert.equal(dkProof.body.reVerified, true);
  assert.match(dkProof.body.verifiedAgainst, /Danish Maritime Authority/, "proof must name the Danish registry");
  assert.match(dkProof.body.issuedBy, /Danish Maritime Authority/, "issuer must be the Danish authority");
  assert.ok((await journalLen()) > dkLen0, "the live DK re-check must hit the (mock) registry");
  const dkPage = await getProofPage(dkToken, "10.9.9.1");
  assert.equal(dkPage.status, 200);
  assert.ok(dkPage.html.includes('data-testid="proof-registry"'), "page must carry proof-registry");
  assert.ok(dkPage.html.includes("Danish Maritime Authority"), "page must name the Danish authority");
  assert.ok(
    /data-testid="proof-recheck-state"[^>]*data-state="live"/.test(dkPage.html),
    "page must render the LIVE re-check state"
  );
  ok("DK — proof page names the Danish Maritime Authority, reVerified true via the mock");

  // ---- 4b. UK doc: live re-check from STORED registryInputs; honest
  //          snapshot once the stored DOB is gone (recheck impossible by design).
  const ukLogin = await fetch(`${BASE}/api/seaman-test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "John Smith" }),
  });
  const ukCookie = cookieFrom(ukLogin);
  const ukSelf = await fetch(`${BASE}/api/seafarers/self`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ukCookie },
    body: JSON.stringify({ name: "John Smith" }), // matches the uk-valid.html holder
  }).then((r) => r.json());
  assert.equal(ukSelf.ok, true, "UK seafarer profile must create");
  const ukSid = ukSelf.seafarer.id;
  const ukShare = ukSelf.seafarer.shareToken;

  const uk = await pasteDoc(ukSid, MOCK_CODES.UK_VALID, {
    token: ukShare,
    countryOverride: "UK",
    registryInputs: JSON.stringify({ dob: MOCK_CODES.UK_DOB }),
  });
  assert.equal(uk.body.ok, true, `UK paste should verify: ${JSON.stringify(uk.body).slice(0, 200)}`);
  assert.equal(uk.body.document.source, "government");
  assert.equal(uk.body.document.registryCountry, "UK");
  assert.deepEqual(
    uk.body.document.registryInputs,
    { dob: MOCK_CODES.UK_DOB },
    "non-sensitive lookup inputs must persist on the doc (§4.6)"
  );
  const ukDocId = uk.body.document.id;
  const ukLink = await fetch(
    `${BASE}/api/verify-link?documentId=${ukDocId}&token=${ukShare}`
  ).then((r) => r.json());
  assert.equal(ukLink.ok, true, "verify-link must mint for the UK government doc");
  const ukTok = ukLink.path.slice("/verify/".length);

  const ukProofLive = await getProof(ukTok, "10.9.9.2");
  assert.equal(ukProofLive.body.recheckState, "live", "stored documentId+DOB must re-check live");
  assert.equal(ukProofLive.body.reVerified, true);
  assert.match(ukProofLive.body.verifiedAgainst, /Maritime and Coastguard/, "proof must name the MCA");
  ok("UK — proof re-checks LIVE from the stored registryInputs (documentId + DOB)");

  // Strip the stored inputs (test-only) — the §5.4 UK-without-DOB case: the
  // lookup can no longer be re-run, so the proof is an HONEST SNAPSHOT, no fetch.
  const strip = await fetch(`${BASE}/api/registry-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "strip-doc-inputs", documentId: ukDocId }),
  });
  assert.equal(strip.status, 200, "strip-doc-inputs must succeed in mock mode");
  const ukLen0 = await journalLen();
  const ukProofSnap = await getProof(ukTok, "10.9.9.2");
  assert.equal(ukProofSnap.status, 200);
  assert.equal(ukProofSnap.body.recheckState, "snapshot", "DOB-less UK doc must render the snapshot state");
  assert.equal(ukProofSnap.body.reVerified, false);
  assert.ok(ukProofSnap.body.verifiedOn, "snapshot proof must carry the verifiedOn instant");
  assert.equal(await journalLen(), ukLen0, "the snapshot state must perform ZERO registry fetches");
  const ukPage = await getProofPage(ukTok, "10.9.9.2");
  assert.ok(
    /data-testid="proof-recheck-state"[^>]*data-state="snapshot"/.test(ukPage.html),
    "page must render the honest snapshot state"
  );
  assert.ok(
    /live re-check is not available/i.test(ukPage.html),
    "snapshot wording must say the re-check is unavailable by design"
  );
  ok("UK — without the stored DOB the proof is an HONEST SNAPSHOT (reVerified false, zero fetches)");

  // ---- 4b'. Persona B1/B5 — share page: per-country naming + proof
  //           affordance for a FILE-LESS government doc.
  const shareHtml = await fetch(`${BASE}/share/${ukShare}`).then((r) => r.text());
  assert.ok(
    !/Estonian registry/i.test(shareHtml),
    "B1 — a UK-only share page must not claim the Estonian registry anywhere"
  );
  assert.ok(
    shareHtml.includes("Government-verified"),
    "B1 — the government-verified doc pill must say 'Government-verified', not a bare 'Valid'"
  );
  assert.ok(
    shareHtml.includes("Maritime and Coastguard Agency"),
    "B1 — the share card must name the ACTUAL authority per doc"
  );
  assert.ok(
    shareHtml.includes('data-testid="proof-qr-toggle"'),
    "B5 — the proof link/QR affordance must be reachable on the row of a file-less government doc"
  );
  ok("B1/B5 — share page: per-doc authority naming + proof affordance for a file-less doc");

  // ---- 4c. §2.5 proof-eligibility gate: source:"registry" docs never mint.
  const bg = await pasteDoc(sid, MOCK_CODES.BG_DOC, {
    token,
    countryOverride: "BG",
    registryInputs: JSON.stringify({ egn: MOCK_CODES.BG_EGN }),
  });
  assert.equal(bg.body.ok, true, `BG paste should store: ${JSON.stringify(bg.body).slice(0, 200)}`);
  assert.equal(bg.body.document.source, "registry", "BG presence result must be source:registry");
  assert.ok(!bg.body.document.registryInputs, "sensitive EGN must never persist on the doc");
  const bgLink = await fetch(
    `${BASE}/api/verify-link?documentId=${bg.body.document.id}&token=${token}`
  );
  assert.equal(bgLink.status, 403, "a registry-source BG doc must never mint a proof link");
  const bgProof = await getProof(mintToken(bg.body.document.id), "10.9.9.3");
  assert.equal(bgProof.status, 404, "even a well-formed token for a BG registry doc yields NO proof");

  const ua = await pasteDoc(sid, MOCK_CODES.UA_VALID, {
    token,
    countryOverride: "UA",
    registryInputs: JSON.stringify({ surname: MOCK_CODES.UA_SURNAME }),
  });
  assert.equal(ua.body.ok, true, `UA paste should store: ${JSON.stringify(ua.body).slice(0, 200)}`);
  assert.equal(ua.body.document.source, "registry", "UA-TCCS (training center) must be source:registry");
  const uaLink = await fetch(
    `${BASE}/api/verify-link?documentId=${ua.body.document.id}&token=${token}`
  );
  assert.equal(uaLink.status, 403, "a training-center doc must never mint a proof link");
  const uaProof = await getProof(mintToken(ua.body.document.id), "10.9.9.3");
  assert.equal(uaProof.status, 404, "even a well-formed token for a TCCS doc yields NO proof");
  ok("gate — BG presence + UA-TCCS registry docs mint NO outward proof (link 403, proof 404)");

  // ---- 4d. §2.4 rate limit on the public /verify surface.
  const RL_IP = "10.9.9.99";
  for (let i = 0; i < 8; i++) await getProof(dkToken, RL_IP); // exhaust the per-IP bucket
  const rlLen0 = await journalLen();
  const over = await getProof(dkToken, RL_IP);
  assert.equal(over.status, 200, "over-limit proof must stay a friendly 200");
  assert.equal(over.body.recheckState, "rate-limited", "over-limit proof must say rate-limited");
  assert.equal(over.body.reVerified, false);
  assert.equal(await journalLen(), rlLen0, "over-limit proof must perform ZERO outbound fetches");
  const overPage = await getProofPage(dkToken, RL_IP);
  assert.equal(overPage.status, 200);
  assert.ok(
    /data-testid="proof-recheck-state"[^>]*data-state="rate-limited"/.test(overPage.html),
    "over-limit page must render the friendly rate-limited state"
  );
  assert.ok(
    /try again in a minute/i.test(overPage.html),
    "over-limit page must carry the friendly retry wording"
  );
  assert.equal(await journalLen(), rlLen0, "the over-limit page load must perform ZERO fetches too");
  // A DIFFERENT client is untouched by the exhausted bucket.
  const other = await getProof(dkToken, "10.9.9.42");
  assert.notEqual(other.body.recheckState, "rate-limited", "a distinct client IP must not be throttled");
  ok("rate limit — over-limit /verify stays friendly with ZERO fetches; other clients unaffected");

  console.log(`\nregistry-flows: ${pass} checks passed`);
}

main().catch((err) => {
  console.error("\n[registry-flows] FAIL:", err.message);
  process.exit(1);
});
