// Unit tests for lib/email-template.ts — the branded claim-invite composer.
//
// Runs the REAL module (Node strips the types; tests/_register-alias.mjs resolves the
// `@/` alias). The module is PURE (no db / no fs), so no temp cwd fixture is needed.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/email-template.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { composeClaimInvite, cleanGreetingName, escapeHtml } = await import(
  "@/lib/email-template"
);

test("composeClaimInvite: html carries agency name, claim URL, and CTA label", () => {
  const { subject, html, text } = composeClaimInvite({
    seafarerName: "Mart Example",
    agencyName: "Docka Development OÜ",
    claimUrl: "https://docka.me/seafarer?token=SAMPLE-TOKEN",
  });
  assert.ok(html.includes("Docka Development OÜ"), "html has the agency name");
  assert.ok(
    html.includes("https://docka.me/seafarer?token=SAMPLE-TOKEN"),
    "html has the claim URL"
  );
  assert.ok(html.includes("Claim your profile"), "html has the CTA label");
  // subject + plain-text fallback are present and meaningful.
  assert.ok(subject.includes("Docka Development OÜ"), "subject names the agency");
  assert.ok(text.length > 0 && text.includes("SAMPLE-TOKEN"), "text fallback present with link");
});

test("greeting strips an email-shaped token from a polluted name (no '@' in greeting)", () => {
  const { html, text } = composeClaimInvite({
    seafarerName: "Mart Example mart@example.com",
    agencyName: "Acme Crewing",
    claimUrl: "https://docka.me/seafarer?token=T",
  });
  // The greeting line must not leak the email address.
  assert.ok(html.includes("Hello Mart Example"), "greeting uses the cleaned human name");
  assert.ok(!html.includes("mart@example.com"), "html greeting has no email address");
  assert.ok(!text.includes("mart@example.com"), "text greeting has no email address");
});

test("cleanGreetingName falls back to 'there' when nothing human remains", () => {
  assert.equal(cleanGreetingName("only@email.com"), "there");
  assert.equal(cleanGreetingName(""), "there");
  assert.equal(cleanGreetingName(null), "there");
  assert.equal(cleanGreetingName("  Maria  Silva  "), "Maria Silva");
});

test("agency name with '<' is HTML-escaped in the rendered email", () => {
  const { html } = composeClaimInvite({
    seafarerName: "Jan",
    agencyName: "<script>alert(1)</script> Crewing",
    claimUrl: "https://docka.me/seafarer?token=T",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag is not present");
  assert.ok(html.includes("&lt;script&gt;"), "the '<' was escaped to &lt;");
});

test("escapeHtml escapes the dangerous set", () => {
  assert.equal(escapeHtml(`<a href="x" & 'y'>`), "&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;");
});
