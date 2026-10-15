// ONE-TIME raw-capture guard for the UA-MARAD hit-page parser fix
// (pdf-verify plan B2, 2026-08-24).
//
// The committed fixtures in tests/fixtures/registry/ua-marad/ are SCRUBBED
// copies of the live captures (session cookies deleted, per-request hash
// tokens replaced). This test proves the scrub did not alter the anchors the
// adapter guards depend on: it runs the fixed guard regexes (uaMaradPdfHrefs,
// the MISS_RE path via parseUAMARAD) against the RAW pre-scrub capture bytes
// and asserts hit/miss respectively.
//
// The raw captures contain live session tokens and are NEVER committed — they
// lived in the implementation session's scratchpad. Point UA_MARAD_RAW_DIR at
// a directory holding `post_response.html` (hit) + `post_negative.html`
// (miss), both saved curl-style WITH response headers; without the env var
// the test SKIPS (documented, kept for provenance).
//
// Executed once against the 2026-08-24 captures at fixture-creation time —
// result recorded in tests/fixtures/registry/ua-marad/README.md.
//
// Run: UA_MARAD_RAW_DIR=<dir> node --import ./tests/_register-alias.mjs --test tests/ua-marad-raw-capture-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { parseUAMARAD, uaMaradPdfHrefs } = await import("@/lib/registry/adapters/ua-marad");

const RAW_DIR = process.env.UA_MARAD_RAW_DIR;

/** Strip the curl-style HTTP header block — the adapter parses bodyText only. */
function bodyOf(file) {
  const raw = fs.readFileSync(file, "utf-8");
  const cut = raw.search(/\r?\n\r?\n/);
  const body = cut >= 0 ? raw.slice(cut).replace(/^\r?\n\r?\n/, "") : raw;
  // Header-less capture (starts straight at the doctype) passes through.
  return body.includes("<!DOCTYPE") || body.includes("<html") ? body : raw;
}

test("raw 2026-08-24 hit capture parses match-valid through the fixed guards", (t) => {
  if (!RAW_DIR) {
    t.skip("UA_MARAD_RAW_DIR unset — one-time gate already executed 2026-08-24 (see fixture README)");
    return;
  }
  const body = bodyOf(path.join(RAW_DIR, "post_response.html"));

  const hrefs = uaMaradPdfHrefs(body);
  assert.equal(hrefs.length, 2, "both bilingual result anchors accepted (EN + УКР)");
  for (const h of hrefs) {
    assert.match(
      h,
      /^https:\/\/vrf\.marad\.gov\.ua\/services\/documents\/pdf\/hash\/[A-Za-z0-9_-]{20,}$/,
      "evidence URL is the same-host hash-link form"
    );
  }
  assert.ok(
    !hrefs.some((h) => h.includes("/services/documents/add/")),
    "the 'Запит на верифікацію' distractor anchor is never evidence"
  );

  const out = parseUAMARAD(body, "12345/2024", "2024-10-25");
  assert.equal(out.kind, "match-valid", "the REAL hit page maps match-valid");
  assert.equal(out.cert.verifiedSource, "government");
  assert.equal(out.cert.hasName, false, "result page carries no holder fields");
});

test("raw 2026-08-24 miss capture parses no-match through MISS_RE", (t) => {
  if (!RAW_DIR) {
    t.skip("UA_MARAD_RAW_DIR unset — one-time gate already executed 2026-08-24 (see fixture README)");
    return;
  }
  const body = bodyOf(path.join(RAW_DIR, "post_negative.html"));
  assert.equal(uaMaradPdfHrefs(body).length, 0, "no result anchor on the miss page");
  const out = parseUAMARAD(body, "00000/2024", "2024-10-25");
  assert.equal(out.kind, "no-match", "2023+ miss is definitive");
});
