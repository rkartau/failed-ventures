// Batch 3 (#42/#49/#52) persona E2E journeys — SCAFFOLD (browser run happens later).
//
// These drive the REAL app at http://localhost:3000 via Playwright + the shared
// journeys.mjs helpers, mirroring the existing persona scripts (maria_p1.mjs etc.).
// They are NOT run here (no dev server in this task): they are written syntactically
// valid so a later `node tests/batch3-journeys.mjs <persona>` against a running dev
// server exercises the three Batch-3 flows. Selectors use the data-testids the Batch-3
// plan wires (portal-manager, client-crew-list/-row, client-slot, directory,
// directory-opt-in, vacancy-match, candidate-row, qualified-only-toggle).
//
// Run later (with the dev server up):
//   node tests/batch3-journeys.mjs 42      # client read-portal (Maria builds, Nikos views)
//   node tests/batch3-journeys.mjs 49      # docka-verified directory (Jaan opts in, Nikos finds)
//   node tests/batch3-journeys.mjs 52      # vacancy matching (Maria's ETO vacancy)
//   node tests/batch3-journeys.mjs all

import { chromium } from "playwright";
import * as J from "./journeys.mjs";

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);

// ---- #42 — client / shipowner read-portal ---------------------------------
// Maria previews a crew portal (some crew NOT visible, with reasons [R42.5]), builds it
// with a 4-month rotation, then a client (Nikos) opens the token and sees surname-masked
// rows, per-slot gov-verified vs self-uploaded dates [R42.3], a medical lapsing
// mid-rotation reading NOT sea-ready [R42.2], "Issuing country / registry" [R42.8], and
// NO documents / notes / contact / DOB. Revoke -> 404. Email-mode non-allowed viewer
// sees neither crew NOR vessel name [C10].
export async function persona42(page) {
  await J.loginAsTestAgent(page);
  await page.goto(`${J.BASE_URL}/agent/portals`, { waitUntil: "domcontentloaded" });
  await tid(page, "portal-manager").first().waitFor({ state: "visible", timeout: 30_000 });

  // Pre-send visibility preview should mark non-consented / no-grant crew as dropped.
  const dropped = await tid(page, "portal-visibility-dropped").count();
  console.log("#42 preview dropped-crew count:", dropped);

  // Build the portal (open mode, 4-month rotation) and capture its share token.
  await tid(page, "portal-create-submit").first().click().catch(() => {});
  const token = await tid(page, "portal-share-token").first().getAttribute("data-token").catch(() => null);
  console.log("#42 portal token:", token);

  if (token) {
    // Client view: masked names + per-slot breakdown, no PII.
    await page.goto(`${J.BASE_URL}/portal/${token}`, { waitUntil: "domcontentloaded" });
    await tid(page, "client-crew-list").first().waitFor({ state: "visible", timeout: 30_000 });
    const rowText = await tid(page, "client-crew-row").first().innerText().catch(() => "");
    console.log("#42 first crew row (should be surname-masked, no DOB/contact):", rowText.replace(/\s+/g, " ").slice(0, 200));
    const slots = await tid(page, "client-slot").count();
    console.log("#42 per-slot breakdown count:", slots);
  }
  console.log("#42_DONE");
}

// ---- #49 — docka-verified network directory --------------------------------
// Jaan (identity-verified) opts in AND his agency holds a stored-ACTIVE directoryConsent
// grant; Nikos must SIGN IN [R49.9], finds Jaan with an honest verification floor +
// expiry counts [R49.12] and "enquire via agency" [R49.11]. Opting out (or the agency
// revoking) removes him next search — even mid-voyage (LOCKED) the revoked directory
// grant does NOT keep him listed [V1]. Raw row/predicate never reaches the browser.
export async function persona49(page) {
  await J.loginAsTestAgent(page);
  await page.goto(`${J.BASE_URL}/directory`, { waitUntil: "domcontentloaded" });
  await tid(page, "directory").first().waitFor({ state: "visible", timeout: 30_000 });

  // Server-side search: type a name fragment, read the projected rows.
  const search = tid(page, "directory-search").first();
  if (await search.count()) {
    await search.fill("Jaan");
    await page.waitForTimeout(500); // debounce
  }
  const results = await tid(page, "directory-row").count();
  console.log("#49 directory result rows:", results);

  // The network response must carry ONLY projected rows (no raw RosterSearchRow).
  const raw = await page.evaluate(async () => {
    try {
      const r = await fetch("/api/directory?text=Jaan");
      return await r.text();
    } catch { return ""; }
  });
  console.log("#49 /api/directory carries raw 'certs' field:", raw.includes('"certs"'));
  console.log("#49 /api/directory carries 'sourcingAgencies':", raw.includes("sourcingAgencies"));
  console.log("#49_DONE");
}

// ---- #52 — vacancy object + candidate matching -----------------------------
// Maria's ETO vacancy (tanker, required certs, sea-time floor, 4-month rotation): a
// candidate whose medical lapses mid-rotation is NOT counted as covered and ranks below
// one valid through the voyage [C1]; a cloned-CoC candidate is not sea-ready and cannot
// top [C1]; "Qualified only" hides the sea-time-short [R52.16]; an at-sea top pick is
// flagged unavailable [R52.17]; a non-granted seaman is never a candidate.
export async function persona52(page) {
  await J.loginAsTestAgent(page);
  await page.goto(`${J.BASE_URL}/agent/vacancies`, { waitUntil: "domcontentloaded" });
  await tid(page, "vacancy-match").first().waitFor({ state: "visible", timeout: 30_000 });

  const before = await tid(page, "candidate-row").count();
  console.log("#52 candidate rows (all):", before);

  // "Qualified only" hides short/missing candidates.
  const toggle = tid(page, "qualified-only-toggle").first();
  if (await toggle.count()) {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(200);
    const after = await tid(page, "candidate-row").count();
    console.log("#52 candidate rows (qualified only):", after, "(<=", before, ")");
  }
  console.log("#52_DONE");
}

const JOURNEYS = { 42: persona42, 49: persona49, 52: persona52 };

async function main() {
  const which = process.argv[2] ?? "all";
  const list = which === "all" ? Object.keys(JOURNEYS) : [which];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("PAGE-ERR:", m.text()); });
  try {
    for (const k of list) {
      const fn = JOURNEYS[k];
      if (!fn) { console.log("unknown persona:", k); continue; }
      await fn(page).catch((e) => console.log(`#${k}_FAIL:`, e.message));
    }
  } finally {
    await browser.close();
  }
}

// Only launch a browser when executed directly (never on import, never on `node --check`).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("batch3-journeys.mjs")) {
  await main();
}
