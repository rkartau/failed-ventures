// HomeClient render smoke (psv-frontpage plan §3, v3 — committed, no escape
// hatch): react-dom/server renderToString over the REAL component tree, string
// assertions on the produced HTML:
//   - the #verify anchor target exists (the hero CTA jumps to the live demo);
//   - the trust bar renders EXACTLY 8 authority chips (derived, flag states
//     only — no TCCS, no BG);
//   - the pillar-4 ladder renders levels 3→2→1→0 in order (and they are the
//     ONLY verification-level badges on the initial page);
//   - emerald appears exactly once on initial render — the L3 ladder chip
//     (VerifyBox's post-lookup success card legitimately uses emerald but does
//     not exist before a lookup).
//
// Provider stubbing (the plan's "one honest attempt"): LanguageProvider calls
// next/navigation's useRouter, which throws outside a mounted app router — but
// useT() ships an EXPLICIT no-provider fallback (LanguageProvider.tsx:52-59)
// that runs the same translate() path with DEFAULT_LANG. Rendering HomeClient
// bare exercises exactly that sanctioned branch, so the English render below
// is the provider-stubbed render. next/link is stubbed to a plain <a> by
// tests/_tsx-hooks.mjs (registered at runtime below) — plain node cannot
// resolve or mount the real app-router Link.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/home-dom.test.mjs

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

// TSX transpile + next/link stub hooks — must be registered BEFORE the
// component imports below.
register("./_tsx-hooks.mjs", import.meta.url);

const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { HomeClient } = await import("@/components/HomeClient");

const html = renderToString(React.createElement(HomeClient));

test("renders the #verify anchor target", () => {
  assert.ok(html.includes('id="verify"'), "the hero CTA's #verify target must exist");
});

test("renders the new hero copy (useT fallback = English)", () => {
  // CRM positioning batch 2026-09-07 (plan v4 §2d): the H1 states the page's own primary
  // keyword verbatim. Only the prefix is pinned, so the preposition tuning that produced the
  // final wording ("with" -> "against") cannot re-break this line.
  assert.ok(html.includes("A crewing agency CRM that checks each certificate"), "new H1 missing");
  assert.match(html, /\bCRM\b/, "the literal CRM token must reach the rendered homepage");
  assert.ok(html.includes("primary source verification (PSV)"), "spelled-out PSV subtitle missing");
});

test("renders the six-card CRM section and the seafarer line", () => {
  assert.equal(
    (html.match(/data-testid="home-crm-card"/g) ?? []).length,
    6,
    "the CRM section renders exactly six Pillar cards"
  );
  assert.ok(html.includes("Seafarers use Docka free"), "home.seafarerFree must render in the hero");
});

test("trust bar renders exactly 8 derived authority chips", () => {
  const chips = html.match(/data-testid="trust-bar-chip"/g) ?? [];
  assert.equal(chips.length, 8);
  assert.ok(html.includes("Maritime Administration of Ukraine"), "UA is represented by MARAD");
  assert.ok(!html.includes("Training Centre for Certification"), "TCCS never appears on the homepage");
  assert.ok(!html.includes("Bulgarian Maritime Administration"), "BG never appears in the trust bar");
});

test("pillar-4 ladder renders levels 3→0 in order and is the only badge set", () => {
  const levels = [...html.matchAll(/data-level="(\d)"/g)].map((m) => m[1]);
  assert.deepEqual(levels, ["3", "2", "1", "0"], "ladder must be top-down L3→L0, nothing else");
});

test("emerald is reserved for the L3 chip on initial render", () => {
  const emerald = html.match(/bg-emerald-/g) ?? [];
  assert.equal(emerald.length, 1, "exactly one emerald surface before any lookup (the L3 chip)");
});

// ---- Homepage polish wave (2026-08-31) -------------------------------------

test("trust bar renders the UK chip as user-facing UK, never internal GB", () => {
  // Positive: the code chip's element TEXT is "UK".
  assert.ok(html.includes(">UK<"), "the UK trust-bar chip must read UK (audience term)");
  // Negative, SCOPED to the trust-bar code-chip markup (min-w-[2rem] is that
  // span's distinctive class) — a whole-document sweep would overreach.
  assert.ok(
    !/min-w-\[2rem\][^>]*>GB</.test(html),
    "no trust-bar code chip may surface the internal UK->GB Intl mapping"
  );
});

test("the AZ chip spells out its authority as element text", () => {
  // Element-TEXT form: the substring alone also lives in the chip's title
  // attribute (full authority string), so only >…< can fail pre-change.
  assert.ok(
    html.includes(">Maritime and Port Agency (DDLA)<"),
    "AZ trust-bar chip must render the spelled-out authorityShort, not bare DDLA"
  );
});

test("the sample-certificate CTA is a tinted button, not a bare text link", () => {
  // Same-element co-occurrence: the bg-brand-50 styling must sit on the very
  // button that carries the label (independent includes() passes pre-change).
  assert.ok(
    /<button[^>]*bg-brand-50[^>]*>[^<]*Use the sample certificate/.test(html),
    "sample CTA must carry the bg-brand-50 button styling on its own element"
  );
});

test("the hero anchor CTA is primary on mobile AND demoted at lg", () => {
  const anchor = html.match(/<a\b[^>]*href="#verify"[^>]*>/)?.[0] ?? "";
  assert.ok(anchor.length > 0, "hero #verify anchor CTA must exist");
  assert.ok(anchor.includes("bg-brand-600"), "anchor must keep the mobile primary bg-brand-600");
  assert.ok(anchor.includes("lg:bg-white"), "anchor must carry the lg:bg-white desktop demotion");
});

test("the verify hint line renders beneath the VerifyBox (useT fallback = English)", () => {
  assert.ok(
    html.includes("No sign-up needed — paste a code or try the sample certificate."),
    "home.verifyHint (en) must actually render on the page"
  );
});

test("sitemap carries the /verify and /pricing marketing routes", async () => {
  const sitemap = (await import("@/app/sitemap")).default;
  const urls = sitemap().map((e) => e.url);
  assert.ok(urls.some((u) => u.endsWith("/verify")), "/verify missing from the sitemap");
  assert.ok(urls.some((u) => u.endsWith("/pricing")), "/pricing missing from the sitemap");
});
