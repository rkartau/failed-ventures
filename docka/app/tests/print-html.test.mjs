// §0a — shared print shell + CV byte-parity (v3 item 5).
// Run: node --import ./tests/_register-alias.mjs tests/print-html.test.mjs
//
// The golden (tests/fixtures/cv-golden.html) was captured from renderCvHtml BEFORE the
// print-html.ts extraction. This asserts the refactor did NOT change one byte of CV
// output, over a hand-built CvModel with a FROZEN generatedAt (no new Date() on the
// compared path).
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const { esc, printPage } = await import("@/lib/print-html");
const { renderCvHtml } = await import("@/lib/cv");
const { cvFixtureModel } = await import("./fixtures/cv-fixture.mjs");

// ---- esc escapes the five HTML-significant characters --------------------
{
  assert.equal(esc(`& < > " '`), "&amp; &lt; &gt; &quot; &#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  ok("esc() escapes & < > \" ' and null/undefined -> ''");
}

// ---- CV byte-parity: renderCvHtml is byte-identical to the pre-extraction golden ----
{
  const golden = fs.readFileSync(
    fileURLToPath(new URL("./fixtures/cv-golden.html", import.meta.url)),
    "utf-8"
  );
  const got = renderCvHtml(cvFixtureModel);
  assert.equal(got, golden, "renderCvHtml output changed vs the pre-extraction golden");
  ok(`CV byte-parity: renderCvHtml === golden (${Buffer.byteLength(got)} bytes, frozen generatedAt)`);
}

// ---- watermark layer present ONLY when passed ---------------------------
{
  const withMark = printPage({ title: "T", bodyHtml: "<p>x</p>", watermark: "DRAFT — X" });
  assert.match(withMark, /draft-watermark/);
  assert.match(withMark, /DRAFT — X/);
  const withoutMark = printPage({ title: "T", bodyHtml: "<p>x</p>" });
  assert.ok(!withoutMark.includes("draft-watermark"), "no watermark layer when omitted");
  // The CV (no watermark) must therefore never contain the watermark class.
  assert.ok(!renderCvHtml(cvFixtureModel).includes("draft-watermark"));
  ok("printPage watermark layer emitted only when watermark passed (CV has none)");
}

console.log(`\nprint-html.test: ${pass} assertions passed`);
