import { chromium } from "playwright";
import fs from "fs";

const OUT = "tests/shots/docviewer";
fs.mkdirSync(OUT, { recursive: true });

const SEAFARER = "412d84af-3181-43a9-8f30-3d95a52aad72"; // a demo seafarer with many photo docs
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();

// Dev login as an admin agent (may view medical) so no doc row is gated.
const login = await ctx.request.post("http://localhost:3000/api/test-login?role=admin");
console.log("login", login.status());

await p.goto(`http://localhost:3000/agent/${SEAFARER}`, { waitUntil: "networkidle" });
await p.waitForSelector('[data-testid="review-panel"]');

// Click the first document thumbnail that opens the viewer.
const opener = await p.waitForSelector('[data-testid="doc-open-viewer"]', { timeout: 10000 });
await opener.click();

// Viewer should appear with the full image + a details panel (name + date).
await p.waitForSelector('[data-testid="doc-viewer"]', { timeout: 10000 });
await p.waitForTimeout(700); // let the full-size image paint

const name = await p.getAttribute('[data-testid="doc-viewer-name-input"]', "value").catch(() => null);
const date = await p.getAttribute('[data-testid="doc-viewer-date-input"]', "value").catch(() => null);
const hasImage = await p.$('[data-testid="doc-viewer-image"]');
const hasConfirm = await p.$('[data-testid="doc-viewer-confirm"]');
console.log("viewer name field:", name);
console.log("viewer date field:", date);
console.log("full image present:", !!hasImage, "| confirm button present:", !!hasConfirm);

await p.screenshot({ path: `${OUT}/viewer-open.png` });

// Exercise the confirm action end-to-end.
if (hasConfirm) {
  await p.click('[data-testid="doc-viewer-confirm"]');
  await p.waitForSelector('[data-testid="doc-viewer-saved"]', { timeout: 8000 });
  const saved = await p.textContent('[data-testid="doc-viewer-saved"]');
  const checkedNote = await p.$('[data-testid="doc-viewer-checked-note"]');
  console.log("confirm saved note:", saved, "| checked badge shown:", !!checkedNote);
  await p.screenshot({ path: `${OUT}/viewer-confirmed.png` });
}

// Esc closes.
await p.keyboard.press("Escape");
const closed = await p.$('[data-testid="doc-viewer"]');
console.log("closed on Esc:", !closed);

await b.close();
console.log("DONE");
