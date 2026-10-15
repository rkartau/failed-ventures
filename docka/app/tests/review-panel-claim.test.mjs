// ReviewPanel placeholder-gating smoke (placeholder-card plan §3/§9D) — renderToString
// over the REAL component tree, same pattern as tests/home-dom.test.mjs:
//   - an UNCLAIMED placeholder gates Voyage/Sea-service/Appraisals behind
//     PlaceholderClaimPanel;
//   - a CLAIMED or LEGACY-UNOWNED profile renders the full surface, panel absent;
//   - the read-only sample review shows neither.
//
// Provider stubbing mirrors home-dom.test.mjs: LanguageProvider's useT() ships an
// explicit no-provider fallback (English), and next/link + next/navigation are
// stubbed by tests/_tsx-hooks.mjs (registered at runtime below) — ReviewPanel calls
// useRouter() unconditionally at the top of the component, which the REAL
// next/navigation module throws on outside a mounted app router.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/review-panel-claim.test.mjs

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register("./_tsx-hooks.mjs", import.meta.url);

const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { ReviewPanel } = await import("@/components/ReviewPanel");

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const SELF_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

function mkSeafarer(overrides = {}) {
  return {
    id: "s1",
    name: "Test Seafarer",
    rank: "AB",
    state: "review",
    shareToken: "tok-s1",
    openShareToken: "tok-s1",
    emailShareToken: "em-s1",
    importedEmail: null,
    invited: false,
    createdByAgentId: null,
    googleSub: null,
    ownerEmail: null,
    credentialUserId: null,
    isSample: false,
    shareTokenLastUsedAt: undefined,
    vessel: null,
    rotationEnd: null,
    vesselType: null,
    flagState: null,
    availability: null,
    availableFrom: null,
    birthDate: null,
    allowedEmails: [],
    selfProfile: {},
    ...overrides,
  };
}

function render(seafarer, extraProps = {}) {
  return renderToString(
    React.createElement(ReviewPanel, {
      seafarer,
      documents: [],
      agentName: "Agent A",
      initialNotes: [],
      ...extraProps,
    })
  );
}

test("unclaimed placeholder (not opened): panel present, voyage/sea-service/appraisals ABSENT", () => {
  const seafarer = mkSeafarer({ invited: true, createdByAgentId: "agent:A", importedEmail: null });
  const html = render(seafarer);
  assert.match(html, /data-testid="placeholder-claim-panel"/);
  assert.doesNotMatch(html, /data-testid="voyage-panel"/);
  assert.doesNotMatch(html, /data-testid="sea-service-ledger"/);
  assert.doesNotMatch(html, /data-testid="appraisal-panel"/);
});

test("unclaimed placeholder: claim-link-input carries /seafarer?token=<tok>", () => {
  const seafarer = mkSeafarer({ invited: true, createdByAgentId: "agent:A" });
  const html = render(seafarer);
  const m = html.match(/data-testid="claim-link-input"[^>]*value="([^"]*)"/);
  assert.ok(m, "claim-link-input rendered with a value attribute");
  assert.match(m[1], /\/seafarer\?token=tok-s1/);
});

test("unclaimed placeholder: claim-email-input prefilled with importedEmail; send-claim-invite disabled with no e-mail", () => {
  const withEmail = mkSeafarer({
    invited: true,
    createdByAgentId: "agent:A",
    importedEmail: "seaman@example.invalid",
  });
  const htmlWithEmail = render(withEmail);
  const emailMatch = htmlWithEmail.match(/data-testid="claim-email-input"[^>]*value="([^"]*)"/);
  assert.ok(emailMatch, "claim-email-input rendered");
  assert.equal(emailMatch[1], "seaman@example.invalid");
  // A saved e-mail is on file -> Send invite is enabled (no `disabled` attribute).
  const sendBlock = htmlWithEmail.match(/data-testid="send-claim-invite"[^>]*>/)[0];
  assert.doesNotMatch(sendBlock, /disabled=""/);

  const noEmail = mkSeafarer({ invited: true, createdByAgentId: "agent:A", importedEmail: null });
  const htmlNoEmail = render(noEmail);
  const sendBlockNoEmail = htmlNoEmail.match(/data-testid="send-claim-invite"[^>]*>/)[0];
  assert.match(sendBlockNoEmail, /disabled=""/, "no saved e-mail -> Send invite disabled");
});

test("opened placeholder: HTML contains '24 hours'; the post-mount stale line is ABSENT from SSR", () => {
  const openedFresh = mkSeafarer({
    invited: true,
    createdByAgentId: "agent:A",
    shareTokenLastUsedAt: T0,
  });
  const html = render(openedFresh);
  assert.match(html, /24 hours/, "the always-on expiry sentence is present for an opened row");
  assert.doesNotMatch(html, /idled out/i, "the post-mount amber stale note never renders in SSR HTML");

  const openedStale = mkSeafarer({
    invited: true,
    createdByAgentId: "agent:A",
    shareTokenLastUsedAt: T0 - SELF_ACCESS_TTL_MS - 1,
  });
  const htmlStale = render(openedStale);
  assert.doesNotMatch(htmlStale, /data-testid="claim-stale-note"/, "stale note is a useEffect-only render, never in SSR");
});

test("claimed profile: voyage present, panel absent", () => {
  const seafarer = mkSeafarer({ ownerEmail: "real@x.com" });
  const html = render(seafarer);
  assert.doesNotMatch(html, /data-testid="placeholder-claim-panel"/);
  assert.match(html, /data-testid="voyage-panel"/);
});

test("legacy-unowned profile (T1): voyage present, panel absent — never gated", () => {
  const seafarer = mkSeafarer({ invited: false, createdByAgentId: null });
  const html = render(seafarer);
  assert.doesNotMatch(html, /data-testid="placeholder-claim-panel"/);
  assert.match(html, /data-testid="voyage-panel"/);
});

test("readOnly sample review + placeholder shape: NEITHER voyage nor the claim panel render", () => {
  const seafarer = mkSeafarer({ invited: true, createdByAgentId: "agent:A", isSample: true });
  const html = render(seafarer, { readOnly: true });
  assert.doesNotMatch(html, /data-testid="placeholder-claim-panel"/, "readOnly is a sample-review concern, not gated");
  assert.doesNotMatch(html, /data-testid="voyage-panel"/, "readOnly hides the voyage editor regardless of claim state");
});
