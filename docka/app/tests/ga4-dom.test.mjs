// GA4 plan A10 — the REAL <Analytics> component mounted in jsdom with react-dom/client
// under act(): next/navigation is a mutable-pathname store, next/script fires onLoad
// once per src (Next 14 LoadCache), window.gtag is a recording stub. Pins:
//   - route sequence / → /share/x → /pricing: exactly 2 page_views; the /share/x step
//     emitted gtag('set', {page_location: ".../private"}) and set the hard-stop flag;
//     /pricing re-set the real location (stickiness) and cleared the flag;
//   - Reject → Accept on /pricing: exactly one page_view; nothing renders before Accept;
//   - a private landing never renders the tag and pins /private before any load.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/ga4-dom.test.mjs

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

// Order matters: the LAST registered hook resolves FIRST.
register("./_tsx-hooks.mjs", import.meta.url);
register("./_ga4-dom-hooks.mjs", import.meta.url);

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://docka.me/" });
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
for (const k of ["HTMLElement", "Node", "Element", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "DocumentFragment", "Text"]) {
  if (!(k in globalThis)) globalThis[k] = w[k];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { setPathname } = await import("./_stub-ga4-navigation.mjs");
const { CONSENT_CHANGE_EVENT } = await import("@/lib/consent");
const { Analytics } = await import("@/components/Analytics");

const SITE = "https://docka.me";
const pageViews = (calls) => calls.filter((c) => c[0] === "event" && c[1] === "page_view");
const sets = (calls) => calls.filter((c) => c[0] === "set");

/** Fresh page state: recording gtag, consent cookie, pathname, no hard-stop flag. */
function reset({ consent, pathname }) {
  const calls = [];
  w.gtag = (...args) => calls.push(args);
  w.dataLayer = [];
  w.document.cookie = `docka_consent=${consent}; Path=/`;
  if (consent === "") w.document.cookie = "docka_consent=; Path=/; Max-Age=0";
  dom.reconfigure({ url: `${SITE}${pathname}` });
  setPathname(pathname);
  return calls;
}

/** App Router navigation: usePathname() carries the bare path, window.location the query. */
async function navigate(pathname, search = "") {
  await act(async () => {
    dom.reconfigure({ url: `${SITE}${pathname}${search}` });
    setPathname(pathname);
  });
}

async function chooseConsent(choice) {
  await act(async () => {
    w.document.cookie = `docka_consent=${choice}; Path=/`;
    w.dispatchEvent(new w.CustomEvent(CONSENT_CHANGE_EVENT));
  });
}

async function mount(props) {
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Analytics, props));
  });
  return {
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("route sequence / → /share/x → /pricing: exactly 2 page_views, /private pin + flag on the private step, sticky real location after", async () => {
  const gaId = "G-SEQ";
  const calls = reset({ consent: "granted", pathname: "/" });
  const app = await mount({ gaId, gtmId: "" });

  // First load: the (stubbed) library loaded → set(real) BEFORE config → one page_view.
  assert.equal(pageViews(calls).length, 1, "one page_view after first load");
  const setIdx = calls.findIndex((c) => c[0] === "set" && c[1].page_location === `${SITE}/`);
  const configIdx = calls.findIndex((c) => c[0] === "config" && c[1] === gaId);
  const pvIdx = calls.findIndex((c) => c[0] === "event" && c[1] === "page_view");
  assert.ok(setIdx >= 0 && configIdx > setIdx && pvIdx > configIdx, "order: set → config → page_view");
  assert.equal(calls[pvIdx][2].page_location, `${SITE}/`);
  assert.equal(w[`ga-disable-${gaId}`], false);

  const beforeShare = calls.length;
  await navigate("/share/x");
  assert.equal(pageViews(calls).length, 1, "no page_view on the private route");
  const shareStep = calls.slice(beforeShare);
  assert.ok(
    shareStep.some((c) => c[0] === "set" && c[1].page_location === `${SITE}/private` && c[1].page_title === "private"),
    "the /share/x step emitted gtag('set', {page_location: .../private})"
  );
  assert.equal(w[`ga-disable-${gaId}`], true, "hard-stop flag set on the private route");
  assert.doesNotMatch(JSON.stringify(calls), /share\/x/, "the private path never reached gtag");

  const beforePricing = calls.length;
  await navigate("/pricing");
  assert.equal(pageViews(calls).length, 2, "second page_view on /pricing");
  const pricingStep = calls.slice(beforePricing);
  assert.deepEqual(sets(pricingStep)[0], ["set", { page_location: `${SITE}/pricing`, page_referrer: "" }], "real location re-set after the private pin");
  assert.equal(pageViews(pricingStep)[0][2].page_location, `${SITE}/pricing`);
  assert.equal(w[`ga-disable-${gaId}`], false);
  // The remounted <Script> did NOT re-fire onLoad (LoadCache): exactly one config call.
  assert.equal(calls.filter((c) => c[0] === "config").length, 1);

  await app.unmount();
});

test("Reject → Accept on /pricing: nothing before Accept, then exactly one page_view", async () => {
  const gaId = "G-CONSENT";
  const calls = reset({ consent: "denied", pathname: "/pricing" });
  const app = await mount({ gaId, gtmId: "" });

  assert.equal(pageViews(calls).length, 0, "no page_view while denied");
  assert.equal(calls.filter((c) => c[0] === "config").length, 0, "the tag never loaded while denied");
  assert.equal(w[`ga-disable-${gaId}`], true, "hard-stop flag while denied");
  assert.ok(calls.some((c) => c[0] === "consent" && c[1] === "update" && c[2].analytics_storage === "denied"));
  assert.ok(sets(calls).some((c) => c[1].page_location === `${SITE}/pricing`), "location pinned even before consent (queue stub)");

  await chooseConsent("granted");
  assert.equal(pageViews(calls).length, 1, "exactly one page_view after Accept");
  assert.equal(pageViews(calls)[0][2].page_location, `${SITE}/pricing`);
  assert.equal(w[`ga-disable-${gaId}`], false);
  assert.ok(calls.some((c) => c[0] === "consent" && c[1] === "update" && c[2].analytics_storage === "granted"));

  // A later Reject flips the flag and sends nothing more.
  const before = calls.length;
  await chooseConsent("denied");
  assert.equal(pageViews(calls).length, 1);
  assert.equal(w[`ga-disable-${gaId}`], true);
  assert.equal(calls.slice(before).filter((c) => c[0] === "event").length, 0);

  await app.unmount();
});

test("private landing (/agent/x, granted): tag never renders, /private pinned, flag set; /signup?t=abc sends the bare location", async () => {
  const gaId = "G-PRIVATE";
  const calls = reset({ consent: "granted", pathname: "/agent/x" });
  const app = await mount({ gaId, gtmId: "GTM-TEST" });
  assert.equal(calls.filter((c) => c[0] === "config").length, 0, "no load on a private landing");
  assert.equal(pageViews(calls).length, 0);
  assert.deepEqual(sets(calls)[0], ["set", { page_location: `${SITE}/private`, page_referrer: "", page_title: "private" }]);
  assert.equal(w[`ga-disable-${gaId}`], true);
  assert.equal(w.document.querySelectorAll("script").length, 0, "no script element rendered");

  // window.location carries ?t=abc (usePathname never does) — and it must not leak.
  await navigate("/signup", "?t=abc");
  assert.equal(pageViews(calls).length, 1, "first public route after load → one page_view (via onLoad)");
  assert.equal(pageViews(calls)[0][2].page_location, `${SITE}/signup`);
  assert.doesNotMatch(JSON.stringify(calls), /abc|t=/, "the outreach token never reached gtag");
  assert.equal(w[`ga-disable-${gaId}`], false);

  await app.unmount();
});
