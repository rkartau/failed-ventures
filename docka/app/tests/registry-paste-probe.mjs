// Increment-4 paste-journey probe (plan §7.4 gate) — drives the REAL UI on the
// dev server (:3000, REGISTRY_MOCK=1) against the §6.2 mock registry server:
//
//   1. VerifyBox (landing page): DK QR deep link  -> GREEN verified card
//   2. VerifyBox: UK bare docId -> country picker -> needs-inputs (dob) prompt
//      -> holder-confirm / pending-binding UI (never a silent green)
//   3. Seafarer paste flow: UK docId + dob prompt -> holder-matched doc stored
//      source:"government" (bindHolder choke point, §2.5)
//   4. API probe: same UK cert against a DIFFERENT holder -> stored unverified
//      + holderMismatch flag (never green)
//   Increment-5 (Wave 2) steps:
//   5. FR paste -> needs-inputs prompt -> re-POST -> bindHolder match -> GREEN
//   6. BG -> sensitive EGN prompt -> TEAL registry-doc (never green), EGN
//      never stored/echoed; teal label asserted on the share (badge-layer) view
//   7. UA-TCCS -> training-center hit -> registry doc (never government)
//   8. MT paste -> assist outcome + fetchWithGuard journal EMPTY (never fetched)
//
// Prereqs (the runner handles both): `node tests/mock-registry.mjs` on :4123,
// and `next dev` started with REGISTRY_MOCK=1 + the REGISTRY_BASE_* mock URLs.
//
// Run: node tests/registry-paste-probe.mjs

import { chromium } from "playwright";
import * as J from "./journeys.mjs";
import { MOCK_CODES, MOCK_REGISTRY_PORT } from "./mock-registry.mjs";

const BASE = J.BASE_URL;
const results = [];
function record(step, passed, note) {
  results.push({ step, passed });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${step}${note ? " — " + note : ""}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  // ---- Preflight (§6.2): the SERVER must be in mock mode, mock must answer.
  const pre = await fetch(`${BASE}/api/registry-test`).then((r) => r.json());
  assert(pre.ok && pre.mock, "dev server is NOT in REGISTRY_MOCK=1 mode — start it with the mock env");
  const health = await fetch(`http://127.0.0.1:${MOCK_REGISTRY_PORT}/__health`).then((r) => r.text());
  assert(health === "ok", "mock registry server is not answering on :4123");
  await fetch(`${BASE}/api/registry-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reset" }),
  });
  record("preflight — dev server in mock mode + mock registry healthy", true);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ================================================================ STEP 1
    // VerifyBox: DK QR deep link -> verified green card (capability token).
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const box = page.locator('input[placeholder*="certificate URL"]').first();
    // Hydration-safe fill: a controlled React input filled BEFORE hydration is
    // reset to state "" when React attaches — retry until the value sticks.
    const dkUrl = `https://verify.dma.dk/validateqr/${MOCK_CODES.DK_VALID}`;
    for (let i = 0; i < 20; i++) {
      await box.fill(dkUrl);
      await page.waitForTimeout(300);
      if ((await box.inputValue()) === dkUrl) break;
    }
    assert((await box.inputValue()) === dkUrl, "VerifyBox input must hold the pasted DK QR URL");
    await page.getByRole("button", { name: "Verify" }).first().click();
    // NOTE: the landing hero already contains the static phrase "Verified
    // against the Estonian maritime registry" — wait on the RESULT card's
    // holder name, never on a generic "Verified against" match.
    await page.waitForFunction(
      () => /METTE JENSEN/i.test(document.body.innerText),
      undefined,
      { timeout: 20_000 }
    );
    const step1 = await page.evaluate(() => document.body.innerText);
    assert(/Søfartsstyrelsen/.test(step1), "authority line must name Søfartsstyrelsen");
    record("STEP 1 — VerifyBox DK QR -> green verified card", true, "METTE JENSEN, Søfartsstyrelsen");

    // ================================================================ STEP 2
    // VerifyBox: UK bare docId -> ambiguous picker -> needs-inputs -> pending UI.
    for (let i = 0; i < 20; i++) {
      await box.fill(MOCK_CODES.UK_VALID);
      await page.waitForTimeout(200);
      if ((await box.inputValue()) === MOCK_CODES.UK_VALID) break;
    }
    await page.getByRole("button", { name: "Verify" }).first().click();
    await page.locator('[data-testid="country-picker"]').waitFor({ timeout: 15_000 });
    // Persona B3 — the fan-out-cap picker lists ONLY the detected candidates
    // (UK + NO here), never the whole country table.
    const pickerOpts = await page
      .locator('[data-testid="country-picker"] option:not([disabled])')
      .allTextContents();
    assert(
      pickerOpts.length === 2 &&
        pickerOpts.includes("United Kingdom") &&
        pickerOpts.includes("Norway"),
      `fan-out picker must list exactly the UK+NO candidates, got: ${pickerOpts.join(", ")}`
    );
    assert(
      (await page.locator('[data-testid="country-picker"]').getAttribute("data-unmatched")) ===
        "false",
      "fan-out picker is a candidates picker, not the unmatched rescue"
    );
    record("STEP 2a — 10-digit code -> candidates-only picker (UK/NO fan-out cap, B3)", true);

    await page.locator('[data-testid="country-picker"]').selectOption("UK");
    await page.locator('[data-testid="needs-inputs-panel"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="needs-input-dob"]').fill(MOCK_CODES.UK_DOB);
    await page.locator('[data-testid="needs-inputs-submit"]').click();
    await page.locator('[data-testid="holder-confirm"]').waitFor({ timeout: 15_000 });
    const step2 = await page.evaluate(() => document.body.innerText);
    assert(/JOHN SMITH/.test(step2), "pending-binding panel must show the registry holder JOHN SMITH");
    assert(
      /confirm the holder/i.test(step2),
      "pending-binding panel must explain the holder-confirm requirement"
    );
    record("STEP 2b — UK -> needs-inputs (dob) -> holder-confirm pending UI", true, "JOHN SMITH shown, no silent green");

    await page.locator('[data-testid="holder-confirm"]').click();
    await page.waitForFunction(
      () => /Holder per registry: JOHN SMITH/i.test(document.body.innerText),
      undefined,
      { timeout: 15_000 }
    );
    record("STEP 2c — explicit confirm reveals the card with the honesty subtext", true);

    // ================================================================ STEP 3
    // Seafarer paste flow: matching holder -> stored source:"government".
    const seaman = await J.createSeaman(page, "John Smith");
    assert(seaman.shareToken, "created seaman must have a share token");
    const me = await fetch(`${BASE}/api/seafarers?token=${seaman.shareToken}`).then((r) => r.json());
    assert(me.ok && me.seafarer?.id, "must resolve the created seafarer id");
    const sid = me.seafarer.id;

    await page.locator('[data-testid="code-input"]').first().fill(MOCK_CODES.UK_VALID);
    await page.locator('[data-testid="add-doc-submit"]').first().click();
    await page.locator('[data-testid="doc-country-picker"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="doc-country-picker"]').selectOption("UK");
    await page.locator('[data-testid="doc-needs-inputs"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="doc-registry-input-dob"]').fill(MOCK_CODES.UK_DOB);
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/documents") && r.request().method() === "POST",
        { timeout: 30_000 }
      ),
      page.locator('[data-testid="doc-registry-inputs-submit"]').click(),
    ]);
    const body = await resp.json();
    assert(body.ok, `UK paste with dob should store: ${JSON.stringify(body).slice(0, 200)}`);
    assert(body.document?.source === "government", `expected source government, got ${body.document?.source}`);
    assert(body.document?.registryCountry === "UK", "doc must be labeled registryCountry UK");
    assert(body.document?.registryInputs?.dob === MOCK_CODES.UK_DOB, "non-sensitive lookup inputs must persist");
    await page.waitForFunction(
      () => /Added & verified/i.test(document.body.innerText),
      undefined,
      { timeout: 15_000 }
    );
    record("STEP 3 — seafarer UK paste: prompt -> bindHolder match -> government doc stored", true,
      `source=${body.document.source}, registryInputs.dob persisted`);

    // ================================================================ STEP 4
    // API probe: same UK cert against a NON-matching holder -> flagged, never green.
    const other = await J.createSeaman(page, "Somebody Different");
    const otherMe = await fetch(`${BASE}/api/seafarers?token=${other.shareToken}`).then((r) => r.json());
    const fd = new FormData();
    fd.append("seafarerId", otherMe.seafarer.id);
    fd.append("code", MOCK_CODES.UK_VALID);
    fd.append("countryOverride", "UK");
    fd.append("registryInputs", JSON.stringify({ dob: MOCK_CODES.UK_DOB }));
    const mm = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd }).then((r) => r.json());
    assert(mm.ok, "mismatch paste still stores an (unverified) doc");
    assert(mm.holderMismatch === true, "response must flag holderMismatch");
    assert(mm.document?.holderMismatch === true, "stored doc must carry holderMismatch:true");
    assert(mm.document?.source !== "government", `mismatch must NEVER be government, got ${mm.document?.source}`);
    record("STEP 4 — holder mismatch: stored unverified + flagged, never green", true,
      `source=${mm.document?.source}, holderMismatch=true`);

    // Fresh §2.4 budget for the Wave-2 steps (the probe is one client IP).
    await fetch(`${BASE}/api/registry-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });

    // ================================================================ STEP 5
    // FR (increment 5): paste -> needs-inputs prompt -> re-POST with the
    // required key -> bindHolder match -> GREEN government doc. (Country is
    // targeted via countryOverride — the exact round-trip the UI picker and
    // needs-inputs panel perform; STEP 2/3 already exercise those panels.)
    const frSeaman = await J.createSeaman(page, "Camille Martin"); // matches the FR fixture holder
    const frMe = await fetch(`${BASE}/api/seafarers?token=${frSeaman.shareToken}`).then((r) => r.json());
    const frSid = frMe.seafarer.id;
    let fd5 = new FormData();
    fd5.append("seafarerId", frSid);
    fd5.append("code", MOCK_CODES.FR_TITRE);
    fd5.append("countryOverride", "FR");
    const fr1 = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd5 });
    const fr1Body = await fr1.json();
    assert(fr1.status === 422 && fr1Body.outcome?.kind === "needs-inputs", "FR paste must prompt for more keys");
    const frMissing = fr1Body.outcome.missing.map((f) => f.key);
    assert(frMissing.includes("numeroAdm"), "FR prompt must ask for numeroAdm");
    fd5 = new FormData();
    fd5.append("seafarerId", frSid);
    fd5.append("code", MOCK_CODES.FR_TITRE);
    fd5.append("countryOverride", "FR");
    fd5.append("registryInputs", JSON.stringify({ numeroAdm: MOCK_CODES.FR_ADM }));
    const fr2 = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd5 }).then((r) => r.json());
    assert(fr2.ok, `FR re-POST should store: ${JSON.stringify(fr2).slice(0, 200)}`);
    assert(fr2.document?.source === "government", `FR doc must be government, got ${fr2.document?.source}`);
    assert(fr2.document?.registryCountry === "FR", "FR doc labeled registryCountry FR");
    assert(fr2.document?.registryInputs?.numeroAdm === MOCK_CODES.FR_ADM, "non-sensitive numeroAdm persisted");
    record("STEP 5 — FR paste: needs-inputs prompt -> bindHolder match -> green government doc", true,
      "source=government, registryInputs.numeroAdm persisted");

    // ================================================================ STEP 6
    // BG (increment 5): EGN prompt -> presence -> TEAL registry-doc (never
    // green), EGN stripped from everything stored or echoed.
    const bgSeaman = await J.createSeaman(page, "Boris Petrov");
    const bgMe = await fetch(`${BASE}/api/seafarers?token=${bgSeaman.shareToken}`).then((r) => r.json());
    const bgSid = bgMe.seafarer.id;
    let fd6 = new FormData();
    fd6.append("seafarerId", bgSid);
    fd6.append("code", MOCK_CODES.BG_DOC);
    fd6.append("countryOverride", "BG");
    const bg1 = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd6 });
    const bg1Body = await bg1.json();
    assert(bg1.status === 422 && bg1Body.outcome?.kind === "needs-inputs", "BG paste must prompt");
    assert(bg1Body.outcome.missing.some((f) => f.key === "egn" && f.sensitive), "BG prompt asks for the SENSITIVE EGN");
    fd6 = new FormData();
    fd6.append("seafarerId", bgSid);
    fd6.append("code", MOCK_CODES.BG_DOC);
    fd6.append("countryOverride", "BG");
    fd6.append("registryInputs", JSON.stringify({ egn: MOCK_CODES.BG_EGN }));
    const bg2 = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd6 }).then((r) => r.json());
    assert(bg2.ok, `BG re-POST should store: ${JSON.stringify(bg2).slice(0, 200)}`);
    assert(bg2.document?.source === "registry", `BG doc must be 'registry' (teal), got ${bg2.document?.source}`);
    assert(bg2.document?.source !== "government", "BG presence must NEVER be government/green");
    assert(!JSON.stringify(bg2).includes(MOCK_CODES.BG_EGN), "the EGN must never be echoed in the response");
    assert(bg2.document?.registryInputs?.egn === undefined, "the sensitive EGN is stripped before store");
    // The badge layer (share view / AgentDocList -> docBadge) shows the TEAL
    // "Registry-confirmed — holder not verified" card, never a green Valid.
    await J.openShare(page, bgSeaman.shareToken);
    await page.waitForFunction(
      () => /Registry-confirmed/i.test(document.body.innerText),
      undefined,
      { timeout: 20_000 }
    );
    const bgText = await page.evaluate(() => document.body.innerText);
    assert(/Registry-confirmed — holder not verified/i.test(bgText), "teal registry-doc label must render");
    record("STEP 6 — BG: EGN prompt -> teal registry-doc card (NOT green), EGN never stored/echoed", true,
      "source=registry, teal label rendered");

    // ================================================================ STEP 7
    // UA-TCCS (increment 5): training-center hit -> registry doc (teal).
    let fd7 = new FormData();
    fd7.append("seafarerId", bgSid);
    fd7.append("code", MOCK_CODES.UA_VALID);
    fd7.append("countryOverride", "UA");
    fd7.append("registryInputs", JSON.stringify({ surname: MOCK_CODES.UA_SURNAME }));
    const ua = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd7 }).then((r) => r.json());
    assert(ua.ok, `UA paste should store: ${JSON.stringify(ua).slice(0, 200)}`);
    assert(ua.document?.source === "registry", `UA-TCCS doc must be 'registry', got ${ua.document?.source}`);
    assert(ua.document?.registryCountry === "UA", "UA doc labeled registryCountry UA");
    record("STEP 7 — UA-TCCS: training-center hit -> registry doc (never government)", true,
      "source=registry");

    // ================================================================ STEP 8
    // MT (increment 5): unverified-endpoint -> assist panel outcome + the
    // fetchWithGuard journal stays EMPTY (never fetched — §6.2 assertion).
    await fetch(`${BASE}/api/registry-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    let fd8 = new FormData();
    fd8.append("seafarerId", bgSid);
    fd8.append("code", "MTQRTOKEN9999");
    fd8.append("countryOverride", "MT");
    const mt = await fetch(`${BASE}/api/documents`, { method: "POST", body: fd8 }).then((r) => r.json());
    assert(mt.ok, "MT paste stores an unverified doc with the assist outcome");
    assert(mt.outcome?.kind === "assist", `MT must resolve to assist, got ${mt.outcome?.kind}`);
    assert(mt.document?.source !== "government" && mt.document?.source !== "registry",
      "MT doc stays unverified");
    const mtJournal = await fetch(`${BASE}/api/registry-test`).then((r) => r.json());
    assert(Array.isArray(mtJournal.journal) && mtJournal.journal.length === 0,
      `MT must trigger ZERO registry fetches, journal has ${mtJournal.journal?.length}`);
    record("STEP 8 — MT: assist panel outcome + fetchWithGuard journal EMPTY", true,
      "unverified-endpoint never fetched");

    // ================================================================ STEP 9
    // Persona B2 — unmatched bare code (no auto candidate, EE fallback miss)
    // is NOT a dead end: the FULL country picker appears, and an assisted
    // pick routes to the assist flow with the pasted code.
    await page.goto(BASE);
    const box9 = page.locator('input[placeholder*="certificate URL"]').first();
    for (let i = 0; i < 20; i++) {
      await box9.fill("XKQZWVYJRP");
      await page.waitForTimeout(200);
      if ((await box9.inputValue()) === "XKQZWVYJRP") break;
    }
    await page.getByRole("button", { name: "Verify" }).first().click();
    await page.locator('[data-testid="country-picker"]').waitFor({ timeout: 15_000 });
    assert(
      (await page.locator('[data-testid="country-picker"]').getAttribute("data-unmatched")) ===
        "true",
      "unmatched code must produce the B2 rescue picker"
    );
    const allOpts = await page
      .locator('[data-testid="country-picker"] option:not([disabled])')
      .count();
    assert(allOpts > 20, `B2 rescue picker must list ALL countries, got ${allOpts}`);
    await page.locator('[data-testid="country-picker"]').selectOption("LV");
    await page.locator('[data-testid="assist-panel"]').waitFor({ timeout: 15_000 });
    const lvPanel = await page.locator('[data-testid="assist-panel"]').innerText();
    assert(/Maritime Administration of Latvia/i.test(lvPanel), "assist panel names the LV authority");
    record("STEP 9 — B2: unmatched code -> full-country picker -> LV assist flow (no dead end)", true);

    // =============================================================== STEP 10
    // Persona B5 + F9 — share view of the UK seaman (file-less government
    // doc): the proof link/QR is reachable from the ROW; then the share +
    // proof pages fit 360/390px-wide phones with NO horizontal scroll.
    await J.openShare(page, seaman.shareToken);
    const qrToggle = page.locator('[data-testid="proof-qr-toggle"]').first();
    await qrToggle.waitFor({ timeout: 20_000 });
    // Hydration-safe click: the SSR button exists before React attaches its
    // handler — retry until the toggle actually expands.
    for (let i = 0; i < 20; i++) {
      await qrToggle.click();
      await page.waitForTimeout(300);
      if ((await qrToggle.getAttribute("aria-expanded")) === "true") break;
    }
    const qrLink = page.locator('[data-testid="verify-qr-link"]').first();
    await qrLink.waitFor({ timeout: 20_000 });
    const proofHref = await qrLink.getAttribute("href");
    assert(proofHref && proofHref.includes("/verify/"), `proof link must exist, got ${proofHref}`);
    record("STEP 10a — B5: proof link/QR reachable from the row of a file-less government doc", true);

    const noHScroll = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      );
    for (const vp of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(vp);
      await page.goto(`${BASE}/share/${seaman.shareToken}`, { waitUntil: "networkidle" });
      assert(await noHScroll(), `share page must not scroll horizontally at ${vp.width}px`);
      await page.goto(proofHref.startsWith("http") ? proofHref : `${BASE}${new URL(proofHref, BASE).pathname}`, { waitUntil: "networkidle" });
      assert(await noHScroll(), `proof page must not scroll horizontally at ${vp.width}px`);
    }
    record("STEP 10b — F9: share + proof pages fit 360x800 and 390x844 (no horizontal scroll)", true);

    console.log("\n================ PROBE SUMMARY ================");
    for (const r of results) console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.step}`);
    const all = results.every((r) => r.passed);
    console.log(`\nOVERALL: ${all ? "PASS" : "FAIL"}`);
    await browser.close();
    process.exit(all ? 0 : 1);
  } catch (err) {
    console.error("\n[probe] HARD FAILURE:", err.message);
    try {
      await page.screenshot({ path: "tests/shots/registry-probe-failure.png", fullPage: true });
      console.error("[probe] screenshot: tests/shots/registry-probe-failure.png");
    } catch {}
    await browser.close();
    process.exit(1);
  }
}

main();
