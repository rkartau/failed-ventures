// Reusable Playwright journey helpers for the Docka seafarer/agent app.
//
// Every helper takes a live Playwright `page` and drives the REAL app at
// http://localhost:3000 (the dev server the owner already runs). Import these
// from any script — see smoke.mjs for a full end-to-end example.
//
//   import { chromium } from "playwright";
//   import * as J from "./journeys.mjs";
//   const page = await (await (await chromium.launch()).newContext()).newPage();
//   await J.loginAsTestAgent(page);
//
// Selectors are data-testid based, so they survive styling changes.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_URL = process.env.DOCKA_BASE_URL ?? "http://localhost:3000";
export const SHOTS_DIR = path.join(__dirname, "shots");

const UPLOAD_TIMEOUT = 240_000; // OCR on several photos can be slow.

function tid(page, testId) {
  return page.locator(`[data-testid="${testId}"]`);
}

// Wait until a client component has hydrated (its React handlers are attached),
// so clicks/typing aren't dropped on a not-yet-interactive DOM.
async function waitHydrated(page, testId, timeout = 30_000) {
  await page
    .locator(`[data-testid="${testId}"][data-hydrated="true"]`)
    .first()
    .waitFor({ state: "attached", timeout });
}

// --- Agent auth ---------------------------------------------------------

// Sign in to the agent dashboard using the dev-only test door (no Google).
export async function loginAsTestAgent(page) {
  await page.goto(`${BASE_URL}/agent`, { waitUntil: "domcontentloaded" });
  const btn = tid(page, "test-login-btn");
  if (await btn.count()) {
    // Exercise the real visible dev button (best-effort; may race hydration).
    await btn.first().click().catch(() => {});
  }
  // Guarantee the session via the same endpoint the button calls. page.request
  // shares the browser context's cookie jar, so the dashboard now authorises us
  // regardless of client-hydration timing.
  await page.request.post(`${BASE_URL}/api/test-login`);
  await page.goto(`${BASE_URL}/agent`, { waitUntil: "domcontentloaded" });
  await tid(page, "filter-all").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitHydrated(page, "agent-board");
}

// Onboarding handshake: a signed-in agent OPENS the seaman's shared link, which is
// what forms the seafarer-consented access grant (see app/share/[token]/page.tsx), so
// the seaman then appears on that agent's grant-scoped board. Without this step a
// self-registered seaman is never connected to any agent, so the agent board — being
// correctly fail-closed / default-deny — shows nothing to review. Uses the browser
// context's cookie jar (same jar loginAsTestAgent authenticates in), so the dev-agent
// cookie authorises the grant. Idempotent: re-opening an already-granted link is a
// no-op. Call AFTER loginAsTestAgent, BEFORE reviewSeaman.
export async function agentOpenSeamanShare(page, token) {
  // Form the grant: the share page creates it on GET for the signed-in agent.
  const res = await page.request.get(`${BASE_URL}/share/${token}`);
  // Re-render the agent board. AgentBoard is initialised from the SERVER render of
  // /agent (dynamic = force-dynamic), so a grant formed by a background request is
  // only reflected once the board is fetched again — exactly what a real agent does
  // by navigating back to /agent after opening the seaman's link. Without this the
  // already-loaded (pre-grant) roster would omit the just-granted seaman.
  await page.goto(`${BASE_URL}/agent`, { waitUntil: "domcontentloaded" });
  await tid(page, "filter-all").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitHydrated(page, "agent-board");
  return res.ok();
}

// --- Seaman side --------------------------------------------------------

// Create a brand-new seaman profile by name. Returns { name, shareToken, shareUrl }.
//
// Self-signup is now GOOGLE-ONLY: the anonymous no-login create path has been removed
// (POST /api/seafarers 401s; the /seafarer create screen only offers Google sign-in).
// The harness therefore authenticates as a seaman through the DEV-ONLY backdoor
// (POST /api/seaman-test-login — the seaman-side mirror of /api/test-login, hard-off
// in prod), which creates a fresh owned profile and establishes a seaman SESSION for
// it. page.request shares the browser context's cookie jar (same as loginAsTestAgent),
// so that session then authorises the seaman UI + APIs. The profile is filled in via
// the now-AUTHENTICATED, session-scoped route POST /api/seafarers/self, preserving the
// historical { name, shareUrl, shareToken } contract every persona relies on.
export async function createSeaman(page, name) {
  // 1) Authenticate as a fresh seaman (dev session for a newly-created owned profile).
  const login = await page.request.post(`${BASE_URL}/api/seaman-test-login`, { data: {} });
  if (!login.ok()) {
    throw new Error(`seaman-test-login failed (${login.status()}) — is the dev server in non-prod mode?`);
  }

  // 2) Fill the profile (set the display name) through the authenticated self-signup
  //    route. Returns the seafarer incl. its share token (shareToken === openShareToken).
  const res = await page.request.post(`${BASE_URL}/api/seafarers/self`, { data: { name } });
  if (!res.ok()) {
    throw new Error(`seafarers/self failed (${res.status()}) — authenticated self-signup route`);
  }
  const data = await res.json();
  const shareToken = data.seafarer?.shareToken ?? "";

  // 3) Land the browser on the profile dashboard, loaded via the seaman SESSION (boot()
  //    -> loadMe() resolves the owned profile from the dev session cookie and persists
  //    the share token to localStorage), so the UI helpers below work exactly as before.
  await page.goto(`${BASE_URL}/seafarer`, { waitUntil: "domcontentloaded" });
  await tid(page, "mass-upload-dropzone").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitHydrated(page, "seafarer-profile");

  const shareUrl = shareToken ? `${BASE_URL}/share/${shareToken}` : "";
  return { name, shareUrl, shareToken };
}

// Mass-upload many files at once; waits until every row reaches a terminal state.
export async function uploadFiles(page, filePaths) {
  await waitHydrated(page, "seafarer-profile");
  const abs = filePaths.map((p) => path.resolve(p));
  await tid(page, "mass-upload-input").first().setInputFiles(abs);
  // Wait until no row is still queued/uploading.
  await page.waitForFunction(
    (expected) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="upload-row"]'));
      if (rows.length < expected) return false;
      return rows.every((r) => {
        const s = r.getAttribute("data-status");
        return s && s !== "queued" && s !== "uploading";
      });
    },
    abs.length,
    { timeout: UPLOAD_TIMEOUT }
  );
  const rows = await tid(page, "upload-row").all();
  const results = [];
  for (const r of rows) results.push(await r.getAttribute("data-status"));
  return results;
}

// Add a single document by pasting a verification code/URL (the code-first path).
export async function pasteCode(page, code) {
  await waitHydrated(page, "seafarer-profile");
  await tid(page, "code-input").first().fill(code);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/documents") && r.request().method() === "POST", {
      timeout: 60_000,
    }),
    tid(page, "add-doc-submit").first().click(),
  ]);
  return res.ok();
}

// --- Agent dashboard ----------------------------------------------------

// Apply a quick filter: "all" | "problems" | "expired" | "expiring" | "missing".
export async function applyFilter(page, kind) {
  await waitHydrated(page, "agent-board");
  await tid(page, `filter-${kind}`).first().click();
  await page.waitForFunction(
    (k) => {
      const u = new URL(window.location.href);
      return k === "all" ? !u.searchParams.get("filter") : u.searchParams.get("filter") === k;
    },
    kind,
    { timeout: 10_000 }
  );
  const shown = await tid(page, "shown-count").first().innerText();
  return shown;
}

function cardByName(page, name) {
  return page.locator(`[data-testid="seafarer-card"][data-name="${name}"]`).first();
}

// Pipeline order (mirrors lib/pipeline.ts SEAFARER_STATES). The board groups cards
// into `column-<state>` kanban columns, so a card's current state is the state of
// the column it currently sits in.
const SEAFARER_STATE_ORDER = ["review", "accepted", "sent_to_sea", "returning", "finished"];

async function seamanCardState(page, name) {
  return page.evaluate((nm) => {
    const c = document.querySelector(`[data-testid="seafarer-card"][data-name="${nm}"]`);
    if (!c) return null;
    const col = c.closest('[data-testid^="column-"]');
    return col ? (col.getAttribute("data-testid") || "").replace(/^column-/, "") : null;
  }, name);
}

// Move a seafarer FORWARD through the pipeline to a target state. The board was
// redesigned from a per-state "move menu" (move-menu + move-to-<state>) to a single
// "→ next stage" button (data-testid="move-next") plus drag-between-columns; the old
// testids are gone. We therefore advance ONE stage at a time
// (review → accepted → sent_to_sea → returning → finished) until the card is in the
// target column. If the compliance hard-block modal (sea-block) appears — advancing a
// non-sea-ready man into a gated state (accepted / sent_to_sea) — we dismiss it and
// stop, leaving the man where he is; the caller can observe the unchanged state via
// the API, exactly as the journeys already do.
export async function moveSeaman(page, name, toState) {
  await waitHydrated(page, "agent-board");
  for (let step = 0; step < SEAFARER_STATE_ORDER.length; step++) {
    const cur = await seamanCardState(page, name);
    if (cur === null || cur === toState) return;
    const card = cardByName(page, name);
    await card.scrollIntoViewIfNeeded();
    const btn = card.locator('[data-testid="move-next"]');
    if ((await btn.count()) === 0) return; // already at the final stage
    await btn.click();
    // Either the card moves to a new column (PATCH accepted) or the hard-block
    // modal appears — whichever comes first.
    const outcome = await Promise.race([
      page
        .waitForFunction(
          ({ nm, from }) => {
            const c = document.querySelector(`[data-testid="seafarer-card"][data-name="${nm}"]`);
            const col = c && c.closest('[data-testid^="column-"]');
            const st = col ? (col.getAttribute("data-testid") || "").replace(/^column-/, "") : null;
            return st && st !== from ? st : false;
          },
          { nm: name, from: cur },
          { timeout: 15_000 }
        )
        .then(() => "moved")
        .catch(() => "timeout"),
      tid(page, "sea-block")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => "blocked")
        .catch(() => "timeout"),
    ]);
    if (outcome === "blocked") {
      await tid(page, "sea-block-ok").first().click().catch(() => {});
      return;
    }
    if (outcome === "timeout") return;
  }
}

// Try to advance a seafarer one stage forward. A non-sea-ready man moving into a
// gated state ("accepted" / "sent_to_sea") is HARD-BLOCKED: the assignment modal
// opens and NO state change persists. Returns true if the move was blocked (modal
// shown), false if it went straight through. (`toState` is accepted for signature
// compatibility; the redesigned board only advances to the next stage.)
export async function moveSeamanExpectBlock(page, name, toState) {
  await waitHydrated(page, "agent-board");
  const card = cardByName(page, name);
  await card.scrollIntoViewIfNeeded();
  const btn = card.locator('[data-testid="move-next"]');
  if ((await btn.count()) === 0) return false;
  await btn.click();
  // Either the block modal appears (blocked) or the move persists (allowed).
  const modal = tid(page, "sea-block");
  try {
    await modal.first().waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Override a shown assignment block with a documented reason and confirm the
// forward move. The reason is recorded to the audit trail by the server.
export async function overrideAssignment(page, reason) {
  await tid(page, "sea-block").first().waitFor({ state: "visible", timeout: 10_000 });
  await tid(page, "sea-override-open").first().click();
  await tid(page, "sea-override-reason").first().fill(reason);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/seafarers") && r.request().method() === "PATCH",
      { timeout: 30_000 }
    ),
    tid(page, "sea-override-confirm").first().click(),
  ]);
}

// Open the single-seaman agent review page from that seafarer's card.
export async function reviewSeaman(page, name) {
  const card = cardByName(page, name);
  await card.scrollIntoViewIfNeeded();
  await Promise.all([
    page.waitForNavigation({ timeout: 30_000 }),
    card.locator('[data-testid="review-link"]').click(),
  ]);
  await tid(page, "completeness").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitHydrated(page, "review-panel");
}

function docRow(page, docTitle) {
  return page.locator(`[data-testid="doc-row"][data-title="${docTitle}"]`).first();
}

// Approve a document on the review page.
export async function approveDoc(page, docTitle) {
  const row = docRow(page, docTitle);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/review"), { timeout: 30_000 }),
    row.locator('[data-testid="doc-approve"]').click(),
  ]);
  // data-review lives on the row element itself; wait for it to flip.
  await page
    .locator(`[data-testid="doc-row"][data-title="${docTitle}"][data-review="approved"]`)
    .first()
    .waitFor({ timeout: 10_000 });
}

// Reject a document with a reason on the review page.
export async function rejectDoc(page, docTitle, reason) {
  const row = docRow(page, docTitle);
  await row.locator('[data-testid="doc-reject"]').click();
  await row.locator('[data-testid="reject-reason"]').fill(reason);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/review"), { timeout: 30_000 }),
    row.locator('[data-testid="reject-confirm"]').click(),
  ]);
  await page
    .locator(`[data-testid="doc-row"][data-title="${docTitle}"][data-review="rejected"]`)
    .first()
    .waitFor({ timeout: 10_000 });
}

// Open the public share view for a token.
export async function openShare(page, token) {
  await page.goto(`${BASE_URL}/share/${token}`, { waitUntil: "domcontentloaded" });
}

// Export the crew CSV; saves it under tests/shots/ and returns its path.
export async function exportCrew(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    tid(page, "export-crew").first().click(),
  ]);
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const out = path.join(SHOTS_DIR, download.suggestedFilename());
  await download.saveAs(out);
  return out;
}

// Save a full-page screenshot to tests/shots/<name>.png and return its path.
export async function screenshot(page, name) {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const out = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  return out;
}
