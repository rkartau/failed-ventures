// #45 — SEA/contract rendering: blank-not-fabricated, DRAFT watermark, unsigned blocks,
// unverified banner (no silent verified-fill), XSS inert.
// Run: node --import ./tests/_register-alias.mjs tests/contract.test.mjs
import assert from "node:assert/strict";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const { buildContractModel, renderContractHtml, sanitizeContractTerms, emptyContractTerms } =
  await import("@/lib/contract");

const seafarer = (o = {}) => ({
  id: "s1",
  name: "typed name",
  rank: "Chief Officer",
  identityVerified: true,
  verifiedName: "VERIFIED Sample",
  personalCode: "38007200123",
  birthDate: "1980-07-20T00:00:00.000Z",
  issuerCountry: "Eesti",
  vessel: "MV Test",
  ...o,
});
const assignment = { id: "a1", seafarerId: "s1", agentId: "agent:A", vessel: "MV Voyage", sentToSeaAt: "2026-01-01T00:00:00.000Z", returnedAt: null };

// ---- Item 1 — unknown term renders BLANK, never fabricated -------------
{
  const model = buildContractModel({
    seafarer: seafarer(),
    assignment,
    terms: emptyContractTerms(),
    agencyOrg: "Org A",
  });
  const html = renderContractHtml(model);
  assert.match(html, /class="blank"/, "unknown terms render an explicit blank line");
  // No fabricated figures: there is no invented wage/currency in the output.
  assert.ok(!/USD|EUR|\$\d/.test(html), "no fabricated wage/currency for a blank term");
  ok("unknown term => explicit blank underline, no fabricated figure");
}

// ---- Item 2 — DRAFT watermark + unsigned both-party blocks + provenance -
{
  const html = renderContractHtml(
    buildContractModel({ seafarer: seafarer(), assignment, terms: emptyContractTerms(), agencyOrg: "Org A" })
  );
  assert.match(html, /DRAFT — NOT AN EXECUTED AGREEMENT/, "DRAFT watermark present");
  assert.match(html, /draft-watermark/);
  assert.match(html, /Seafarer — signature/, "seafarer signature block present + unsigned");
  assert.match(html, /For the employer \/ master — signature/, "employer signature block present + unsigned");
  assert.match(html, /Draft for review — not a signed instrument/, "provenance line present");
  ok("DRAFT watermark + unsigned both-party signature blocks + provenance line");
}

// ---- Item 3 — verified identity uses the VERIFIED name (no typed leak) --
{
  const html = renderContractHtml(
    buildContractModel({ seafarer: seafarer(), assignment, terms: emptyContractTerms(), agencyOrg: "Org A" })
  );
  assert.match(html, /VERIFIED Sample/, "verified name shown");
  assert.ok(!html.includes("typed name"), "typed name is NOT used when identity is verified");
  assert.ok(!/IDENTITY NOT GOVERNMENT-VERIFIED/.test(html), "no unverified banner when verified");
  ok("verified identity => verified name, no unverified banner");
}

// ---- Item 3 — unverified identity => red banner + bracketed, NO silent fill ----
{
  const html = renderContractHtml(
    buildContractModel({
      seafarer: seafarer({ identityVerified: false, verifiedName: "VERIFIED Sample", name: "Typed Applicant" }),
      assignment,
      terms: emptyContractTerms(),
      agencyOrg: "Org A",
    })
  );
  assert.match(html, /IDENTITY NOT GOVERNMENT-VERIFIED/, "red unverified banner present");
  assert.match(html, /\[unverified: Typed Applicant\]/, "typed name bracketed as unverified");
  assert.ok(!html.includes("VERIFIED Sample"), "verified name is NOT silently substituted when unverified");
  ok("unverified identity => banner + bracketed typed value, no silent verified-fill");
}

// ---- XSS inert: injected script is escaped -----------------------------
{
  const html = renderContractHtml(
    buildContractModel({
      seafarer: seafarer({ verifiedName: '<script>alert(1)</script>' }),
      assignment,
      terms: sanitizeContractTerms({ allotment: '<img src=x onerror=alert(1)>' }),
      agencyOrg: "Org A",
    })
  );
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), "injected <script> is escaped, not live");
  assert.match(html, /&lt;script&gt;/, "script tag rendered as escaped text");
  ok("injected markup is escaped inert in the rendered SEA");
}

console.log(`\ncontract.test: ${pass} assertions passed`);
