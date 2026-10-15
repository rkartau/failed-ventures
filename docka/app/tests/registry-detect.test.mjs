// Detection table test (plan §6.1) for the increment-3 resolve pipeline:
// URL/QR host pinning (exact match, never endsWith), bare-code candidate
// ranking with the §2.3 fan-out cap (EE fallback EXEMPT, appended last),
// fake-domain refusal, and Cyrillic/Greek normalization.
//
// Pure detection — no network, no adapters, runs always.
//
// Run: node --import ./tests/_register-alias.mjs tests/registry-detect.test.mjs

import assert from "node:assert/strict";

const { detectRegistry, eeNormalize, genericNormalize } = await import("@/lib/registry/detect");
const { COUNTRIES, KNOWN_FAKE_REGISTRY_DOMAINS, entryForHostname } = await import(
  "@/lib/registry/countries"
);

let pass = 0;
const ok = (msg) => {
  console.log("  ok  -", msg);
  pass++;
};

const countriesOf = (r) => (r.kind === "candidates" ? r.candidates.map((c) => c.country) : null);

// =========================================================================
// A. Estonia zero-regression (legacy extractCode semantics preserved EXACTLY)
// =========================================================================
{
  // 16-char real-token shape -> EE specific match, uncertain, appended once.
  let r = detectRegistry("SAMPLE0SAFETY001");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "SAMPLE0SAFETY001");
  assert.equal(r.candidates[0].certain, false);
  ok("EE 16-char token -> single uncertain EE candidate");

  // 12-char bare code (NOT 16) -> still reaches EE via the >=6 fallback.
  r = detectRegistry("ABCD1234EFGH");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "ABCD1234EFGH");
  ok("EE fallback: 12-char bare code still reaches EE (zero regression)");

  // Dash-separated code -> separators stripped exactly like extractCode.
  r = detectRegistry("ABCD-1234-EFGH");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "ABCD1234EFGH");
  ok("EE fallback: ABCD-1234-EFGH separator style normalizes and reaches EE");

  // Lowercase + surrounding spaces.
  r = detectRegistry("  sample0safety001  ");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "SAMPLE0SAFETY001");
  ok("EE: lowercase + whitespace input normalizes");

  // Slash-containing non-URL input: last segment wins (legacy extractCode rule).
  r = detectRegistry("certificates/SAMPLE0SAFETY001");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "SAMPLE0SAFETY001");
  ok("EE: slash-containing input keeps the last segment");

  // Full EE URL -> CERTAIN candidate.
  r = detectRegistry("https://meremees.transpordiamet.ee/certificates/SAMPLE0SAFETY001");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].certain, true);
  ok("EE URL paste -> certain EE candidate");

  // Scheme-less EE URL.
  r = detectRegistry("meremees.transpordiamet.ee/certificates/SAMPLE0SAFETY001");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].certain, true);
  ok("EE scheme-less URL paste -> certain EE candidate");

  // Query/hash stripped by URL parsing.
  r = detectRegistry("https://meremees.transpordiamet.ee/certificates/CODE123ABC?utm=x#y");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "CODE123ABC");
  ok("EE URL with query/hash -> code from the path only");
}

// =========================================================================
// B. Every pinned domain routes to its own country (URL certainty)
// =========================================================================
{
  for (const c of COUNTRIES) {
    const domain = c.domains[0];
    const r = detectRegistry(`https://${domain}/lookup/TESTCODE123`);
    assert.equal(r.kind, "candidates", `${domain} must resolve to candidates`);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].country, c.country, `${domain} must map to ${c.country}`);
    assert.equal(r.candidates[0].certain, true);
    ok(`pinned domain ${domain} -> certain ${c.country} candidate`);
  }
}

// =========================================================================
// C. Fake / unpinned domains: warned, NEVER candidates (§2.4)
// =========================================================================
{
  for (const fake of KNOWN_FAKE_REGISTRY_DOMAINS) {
    const r = detectRegistry(`https://${fake.domain}/verify/ABC12345`);
    assert.equal(r.kind, "unpinned-domain", `${fake.domain} must be refused`);
    assert.equal(r.hostname, fake.domain);
    assert.equal(entryForHostname(fake.domain), undefined);
    ok(`fake registry ${fake.domain} (imitates ${fake.imitates}) -> unpinned-domain warning`);
  }

  // Generic unpinned host.
  let r = detectRegistry("https://evil.example.com/certificates/SAMPLE0SAFETY001");
  assert.equal(r.kind, "unpinned-domain");
  assert.equal(r.hostname, "evil.example.com");
  ok("unknown host -> unpinned-domain (never fetched)");

  // Suffix attack: exact hostname equality, never endsWith.
  r = detectRegistry("https://verify.dma.dk.evil.com/validateqr/12345678");
  assert.equal(r.kind, "unpinned-domain");
  assert.equal(r.hostname, "verify.dma.dk.evil.com");
  ok("suffix attack verify.dma.dk.evil.com -> refused (exact match only)");

  // Case-insensitive host matching still pins correctly.
  r = detectRegistry("https://VERIFY.DMA.DK/validateqr/12345678");
  assert.equal(r.kind, "candidates");
  assert.equal(r.candidates[0].country, "DK");
  ok("uppercase pinned host still matches its country");
}

// =========================================================================
// D. Bare-code ranking: DK+EE overlap, fan-out cap, EE-fallback exemption
// =========================================================================
{
  // DK provisional pattern (8 digits) + EE >=6 fallback -> [DK, EE] rank order,
  // NO picker (EE fallback is EXEMPT from the cap and appended LAST).
  let r = detectRegistry("12345678");
  assert.deepEqual(countriesOf(r), ["DK", "EE"]);
  assert.equal(r.candidates[0].certain, false);
  assert.equal(r.candidates[1].country, "EE");
  ok("DK-pattern bare code -> candidates [DK, EE] in rank order, no picker");

  // Dash-separated DK-shaped number normalizes then matches the same way.
  r = detectRegistry("1234-5678");
  assert.deepEqual(countriesOf(r), ["DK", "EE"]);
  ok("dash-separated 8-digit code -> [DK, EE]");

  // UK pattern (UPDATED 2026-08-12 to the REAL MCA id shapes): alpha
  // document-type prefix + 7 digits — official specimen CoC0089297 — plus the
  // 9-digit legacy all-numeric form. Case + separators normalize away.
  r = detectRegistry("CoC0089297");
  assert.deepEqual(countriesOf(r), ["UK", "EE"]);
  assert.equal(r.candidates[0].code, "COC0089297");
  r = detectRegistry("CEC8104152");
  assert.deepEqual(countriesOf(r), ["UK", "EE"]);
  r = detectRegistry("coc 0089297");
  assert.deepEqual(countriesOf(r), ["UK", "EE"]);
  ok("UK alpha-prefix ids (CoC0089297 / CEC8104152) -> [UK, EE] in rank order");

  r = detectRegistry("123456789");
  assert.deepEqual(countriesOf(r), ["UK", "EE"]);
  ok("UK 9-digit legacy id -> [UK, EE]");

  // A 10-digit code no longer matches UK (the old 10-digit placeholder is
  // gone) — it is Norway's alone, with the EE fallback appended.
  r = detectRegistry("1234567890");
  assert.deepEqual(countriesOf(r), ["NO", "EE"]);
  ok("10-digit code -> [NO, EE] (UK placeholder pattern retired 2026-08-12)");

  // 11 digits -> NO only + EE fallback (cap counts SPECIFIC matches only).
  r = detectRegistry("12345678901");
  assert.deepEqual(countriesOf(r), ["NO", "EE"]);
  ok("11-digit code -> [NO, EE]; EE fallback exempt from the cap");

  // Fan-out cap (§2.3): with the real UK ids there is no NATURAL numeric
  // overlap left in the table, so the cap is drilled with a synthetic auto
  // entry overlapping NO's 10-digit range (removed again right after).
  const synthetic = {
    country: "XX",
    countryName: "Synthetic",
    authority: "Synthetic fan-out drill",
    capability: "auto",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["xx.example.invalid"],
    portalUrl: "https://xx.example.invalid",
    inputs: [{ key: "certNumber", label: "Certificate number", source: "paste" }],
    codePattern: /^\d{10}$/,
  };
  COUNTRIES.push(synthetic);
  try {
    r = detectRegistry("1234567890");
    assert.equal(r.kind, "ambiguous");
    assert.deepEqual([...r.candidates].sort(), ["NO", "XX"]);
    assert.equal(r.code, "1234567890");
  } finally {
    COUNTRIES.splice(COUNTRIES.indexOf(synthetic), 1);
  }
  ok("fan-out cap: >=2 auto matches (NO + synthetic) -> ambiguous country picker");

  // EE 16-char token must NOT be claimed by any numeric pattern... and the
  // UK alpha pattern must not claim it either (16 chars > prefix+7).
  r = detectRegistry("SAMPLE0SAFETY001");
  assert.deepEqual(countriesOf(r), ["EE"]);
  ok("EE token never collides with the UK/numeric patterns");
}

// =========================================================================
// E. Cyrillic / Greek normalization (§2.3)
// =========================================================================
{
  // genericNormalize KEEPS non-Latin letters (BG/UA Cyrillic, GR Greek).
  assert.equal(genericNormalize("бг 123-456"), "БГ123456");
  assert.equal(genericNormalize("αβγ-123 456"), "ΑΒΓ123456");
  ok("genericNormalize preserves Cyrillic and Greek letters (uppercased)");

  // Legacy EE normalization strips them (A-Z0-9 only) — documented split.
  assert.equal(eeNormalize("бг 123-456"), "123456");
  ok("eeNormalize strips non-Latin (legacy extractCode rule)");

  // A Cyrillic-lettered code with >=6 surviving alphanumerics still reaches the
  // EE fallback with the STRIPPED code (exact legacy behavior, no crash).
  let r = detectRegistry("БГ-123456");
  assert.deepEqual(countriesOf(r), ["EE"]);
  assert.equal(r.candidates[0].code, "123456");
  ok("Cyrillic input with >=6 residual chars -> EE fallback on the stripped code");

  // Too short after stripping -> invalid, gracefully.
  r = detectRegistry("МОРЕ-12");
  assert.equal(r.kind, "invalid");
  ok("short Cyrillic input -> invalid (no crash, no bogus candidate)");

  const g = detectRegistry("ΑΒ-123456");
  assert.deepEqual(countriesOf(g), ["EE"]);
  assert.equal(g.candidates[0].code, "123456");
  ok("Greek input with >=6 residual chars -> EE fallback on the stripped code");
}

// =========================================================================
// F. Degenerate inputs
// =========================================================================
{
  assert.equal(detectRegistry("").kind, "invalid");
  assert.equal(detectRegistry("   ").kind, "invalid");
  assert.equal(detectRegistry("AB12").kind, "invalid");
  ok("empty / whitespace / short inputs -> invalid");

  // A pinned-domain URL with no usable code segment.
  assert.equal(detectRegistry("https://meremees.transpordiamet.ee/").kind, "invalid");
  ok("pinned URL without a code segment -> invalid");
}

console.log(`\nregistry-detect: ${pass} assertions passed`);
