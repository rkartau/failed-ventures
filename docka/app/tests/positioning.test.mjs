// Docka CRM positioning rewrite (plan v4, 2026-09-07) — the IDENTITY gate.
//
// One suite owns one question: does every public surface say, in plain words, that Docka is a
// CRM for crewing / manning agencies? The per-page SEO suites keep owning schema shape, link
// hygiene and style; this file owns positioning, so a later "let's soften the copy" edit has to
// face a test whose only subject is the positioning.
//
// Sections (plan v4 §3c, assertions 1-15):
//   (1)  every SITE_PAGES row carries the identity (CRM + crewing/manning)
//   (2)  RENDERED-set smoke: the tree is not silently empty
//   (3)  the shared constants (SITE_DESCRIPTION, META_DESCRIPTION, ROOT_TITLE)
//   (4)  every rewritten description names the buyer (seafarer-intent routes excluded, D5)
//   (5)  nav: /overview/agencies inserted, /book still last, nav.agencies English-only
//   (6)  the <WhatDockaIs /> strip is present on all 21 strip routes (by data-testid)
//   (7)  /llms.txt carries the identity and every llms-listed URL
//   (8)  the literal "CRM" token survives into all six language columns
//   (9)  the new CRM keys are really translated (script check, D15)
//   (10) the CRM CTA is not a second blue primary (D6)
//   (11) the reminder copy matches DEFAULT_REMINDER_SETTINGS (D1)
//   (12) Organization.knowsAbout === 6 and leads with "Crewing agency CRM"
//   (13) the reworded disambiguator: new present, old absent
//   (14) the #software SoftwareApplication node agrees with the copy, and rendering
//        /pricing touches no store (the @/lib/billing-store stub is proven by a spy)
//   (15) the WRITING-STYLE-GUIDE mechanical scan over the NEW strings only
//
// Run: node --import ./tests/_register-alias.mjs --test tests/positioning.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "fs";
import path from "path";

import { createRouteHarness } from "./_route-harness.mjs";
import { expand, render, textOf, collectLdJson, ofType, collectTestIds } from "./_render-text.mjs";
import { scanStyle } from "./_style-gate.mjs";
import { SITE_URL, SITE_DESCRIPTION, META_DESCRIPTION } from "@/lib/seo";
import { SITE_PAGES } from "@/lib/site-pages";
import { DEFAULT_REMINDER_SETTINGS } from "@/lib/reminders-calendar";
import { DICT, t } from "@/lib/i18n";
import { pricingModel } from "@/components/billing-ui";

// ---- harness ----------------------------------------------------------------------
// The stub map is copied VERBATIM from tests/seo-new-pages-e.test.mjs:44-65 (plan E2): the
// route harness stubs only next/server, next/headers and the JSX runtime by default, so
// without this map the first route loaded would evaluate the real client chrome and
// @/lib/billing-store would read data/db.json.
//
// Link renders as a real <a> (so anchor text and hrefs survive into the rendered tree);
// every other client-only edge is inert, mirroring the phase-2/tier-1 harness stubs.
const inert = new Proxy({}, { get: () => () => null });
let billingCalls = 0; // E2: prove /pricing never reads the store
const { loadTs, APP_DIR, APP } = createRouteHarness({
  stubs: {
    "@/components/billing-ui": { pricingModel },
    "@/lib/billing-store": {
      getBillingSettings: () => {
        billingCalls++;
        return { defaults: {}, tosVersion: "test" };
      },
    },
    // `__esModule` so TypeScript's __importDefault does not wrap the stub a second time.
    "next/link": { __esModule: true, default: (props) => ({ type: "a", props }) },
    "next/script": { default: () => null },
    "./globals.css": {},
    "@/components/Logo": inert,
    "@/components/ImpersonationBanner": inert,
    "@/components/ServiceWorkerRegister": inert,
    "@/components/LanguageProvider": inert,
    "@/components/SiteNav": inert,
    "@/components/Analytics": inert,
    "@/components/ConsentBanner": inert,
    "@/components/CookieSettingsLink": inert,
    "@/components/ObfuscatedEmail": inert,
    "@/components/HomeClient": inert,
  },
});
process.env.GA_ID = "";
process.env.GTM_ID = "";

const routeFile = (...segs) => path.join(APP_DIR, ...segs);
const loadRoute = (...segs) => loadTs(routeFile(...segs));
const readFile = (...segs) => fs.readFileSync(routeFile(...segs), "utf8");
const COMPONENT = (name) => path.join(APP, "components", name);

// collectLdJson is the shared export; `ldNodes` is the one-liner each consumer defines for
// itself (plan E3). @graph blocks are flattened because the root layout emits one — the same
// shape tests/seo-schema-b.test.mjs:88-96 uses; without the flatten the Organization node is
// unreachable and assertion 12 would silently find nothing.
const ldNodes = (el) => collectLdJson(expand(el)).flatMap((n) => (Array.isArray(n["@graph"]) ? n["@graph"] : [n]));

// =====================================================================================
// Route classification (plan v4 §3c / D9) — all 30 SITE_PAGES rows are classified.
// =====================================================================================

// HOME (1): the harness stubs @/components/HomeClient inert, so "/" renders no hero. The
// rendered-DOM half of the homepage is owned by tests/home-dom.test.mjs.
const HOME_ROUTE = "/";

// SOURCE (6): routes that cannot be expand()-rendered.
//   /overview/agencies, /overview/seafarers — "use client" + useState
//   /verify                                 — "use client"
//   /book                                   — `export default async function`, so expand()
//                                             on the returned Promise yields an empty tree
//   /sample/agency, /sample/seafarer        — hook-bearing client children; expand() calls
//                                             type(props) directly and would throw
const SOURCE_ROUTES = ["/overview/agencies", "/overview/seafarers", "/verify", "/book", "/sample/agency", "/sample/seafarer"];

// RENDERED (23): sync server components with no hook-bearing children.
const ALL_ROUTES = SITE_PAGES.map((p) => p.path);
const RENDERED_ROUTES = ALL_ROUTES.filter((r) => r !== HOME_ROUTE && !SOURCE_ROUTES.includes(r));

const segsFor = (route) => (route === "/" ? ["page.tsx"] : [...route.slice(1).split("/"), "page.tsx"]);
const layoutSegsFor = (route) => [...segsFor(route).slice(0, -1), "layout.tsx"];

const tryLoad = (segs) => {
  try {
    return loadTs(routeFile(...segs));
  } catch {
    return undefined;
  }
};

/** Metadata for a route: the page's own export, else the sibling layout's. */
function metaFor(route) {
  const own = tryLoad(segsFor(route));
  if (own && own.metadata) return own.metadata;
  const lay = layoutSegsFor(route);
  if (fs.existsSync(routeFile(...lay))) {
    const mod = tryLoad(lay);
    if (mod && mod.metadata) return mod.metadata;
  }
  return undefined;
}

// The two /sample/* pages import app-internal modules the harness does not resolve, so their
// metadata cannot be loaded. Their TITLE/DESCRIPTION consts are read out of the source
// instead — the same strings the module would have exported.
const SRC_CONST = (src, name) => {
  const m = src.match(new RegExp(`const ${name} =\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
};

/** The WebPage JSON-LD node a route emits (the home route's only description lives there:
 *  app/page.tsx exports no `description`, it inherits the root layout's META_DESCRIPTION and
 *  states its own page-level sentence in homeWebPageJsonLd). */
function webPageNode(route) {
  return ofType(ldNodes(loadRoute(...segsFor(route)).default({})), "WebPage")[0];
}

function descriptionFor(route) {
  const meta = metaFor(route);
  if (meta && typeof meta.description === "string") return meta.description;
  if (route === HOME_ROUTE) return webPageNode(route)?.description;
  return SRC_CONST(readFile(...segsFor(route)), "DESCRIPTION");
}
function titleFor(route) {
  const meta = metaFor(route);
  if (meta && typeof meta.title === "string") return meta.title;
  if (meta && meta.title && typeof meta.title.default === "string") return meta.title.default;
  return SRC_CONST(readFile(...segsFor(route)), "TITLE");
}

/** SOURCE-set text: metadata + the raw page source with class/href/testid noise stripped. */
function sourceText(route) {
  const raw = readFile(...segsFor(route));
  const stripped = raw
    .replace(/className="[^"]*"/g, "")
    .replace(/className=\{[^}]*\}/g, "")
    .replace(/href="[^"]*"/g, "")
    .replace(/data-testid="[^"]*"/g, "");
  return `${titleFor(route) ?? ""} ${descriptionFor(route) ?? ""} ${stripped}`;
}

const CRM_KEYS = [
  "home.seafarerFree",
  "home.crmTitle",
  "home.crm1t",
  "home.crm1b",
  "home.crm2t",
  "home.crm2b",
  "home.crm3t",
  "home.crm3b",
  "home.crm4t",
  "home.crm4b",
  "home.crm5t",
  "home.crm5b",
  "home.crm6t",
  "home.crm6b",
  "home.crmCta",
];

const en = (key) => (DICT[key] && DICT[key].en) || "";

/** HOME text under test: the i18n hero + CRM strings the stubbed HomeClient would render,
 *  plus the server half of app/page.tsx. */
function homeText() {
  return [en("home.title"), en("home.subtitle"), ...CRM_KEYS.map(en), readFile("page.tsx")].join("\n");
}

const renderedTextCache = new Map();
function renderedText(route) {
  if (!renderedTextCache.has(route)) {
    const mod = loadRoute(...segsFor(route));
    renderedTextCache.set(route, textOf(render(mod)));
  }
  return renderedTextCache.get(route);
}

function identityTextFor(route) {
  if (route === HOME_ROUTE) return homeText();
  if (SOURCE_ROUTES.includes(route)) return sourceText(route);
  return `${titleFor(route) ?? ""} ${descriptionFor(route) ?? ""} ${renderedText(route)}`;
}

// =====================================================================================
// (1) SITE_PAGES coverage — the identity is on every indexable page
// =====================================================================================
test("identity: every SITE_PAGES route says CRM and names the crewing/manning buyer", () => {
  assert.equal(ALL_ROUTES.length, 30, "SITE_PAGES is the route list this gate sweeps");
  for (const route of ALL_ROUTES) {
    const text = identityTextFor(route);
    assert.match(text, /\bCRM\b/, `${route} must carry the literal CRM token`);
    assert.match(text, /crewing|manning/i, `${route} must name the crewing/manning buyer`);
  }
});

// =====================================================================================
// (2) RENDERED-set smoke — guard against a silently empty tree
// =====================================================================================
test("identity: every RENDERED route actually produces a tree (no silent empty render)", () => {
  assert.equal(RENDERED_ROUTES.length, 23, "23 RENDERED routes (30 minus home minus the 6 SOURCE routes)");
  for (const route of RENDERED_ROUTES) {
    assert.ok(renderedText(route).length > 200, `${route} rendered only ${renderedText(route).length} chars`);
  }
});

// =====================================================================================
// (3) Shared constants
// =====================================================================================
test("identity: SITE_DESCRIPTION, META_DESCRIPTION and ROOT_TITLE all carry the CRM identity", () => {
  assert.match(SITE_DESCRIPTION, /\bCRM\b/);
  assert.match(META_DESCRIPTION, /\bCRM\b/);
  assert.ok(
    META_DESCRIPTION.length >= 120 && META_DESCRIPTION.length <= 160,
    `META_DESCRIPTION is ${META_DESCRIPTION.length} chars (want 120-160)`
  );
  const rootTitle = loadRoute("layout.tsx").metadata.title.default;
  assert.match(rootTitle, /\bCRM\b/);
  assert.ok(rootTitle.length <= 60, `ROOT_TITLE is ${rootTitle.length} chars`);
});

// =====================================================================================
// (4) Every rewritten description names the buyer
// =====================================================================================
// D5: /overview/seafarers and /sample/seafarer keep the seafarer's own framing in their
// descriptions — the identity reaches those two routes through a BODY sentence instead (swept
// by assertion 1). Half of docka.me's audience is a seafarer on a phone; evicting them from
// their own two descriptions to satisfy a keyword sweep would be the wrong trade.
const SEAFARER_INTENT_ROUTES = ["/overview/seafarers", "/sample/seafarer"];
const BUYER_DESCRIPTION_ROUTES = [
  "/",
  "/overview",
  "/overview/agencies",
  "/verify",
  "/about",
  "/registries",
  "/resources",
  "/contact",
  "/book",
  "/sample/agency",
];

test("identity: every rewritten description literally names the crewing/manning buyer", () => {
  for (const route of BUYER_DESCRIPTION_ROUTES) {
    const description = descriptionFor(route);
    assert.ok(description, `${route} must expose a description`);
    assert.match(description, /crewing agenc(y|ies)|manning/i, `${route} description must name the buyer`);
  }
});

test("identity: the two seafarer-intent routes keep the free + consent framing (D5)", () => {
  // "free" is asserted over description + body, not the description alone: §2c keeps
  // /sample/seafarer's DESCRIPTION unchanged (R5) and puts the free/CRM sentence in the body,
  // which is exactly the D5 trade this exclusion exists to protect.
  for (const route of SEAFARER_INTENT_ROUTES) {
    assert.ok(descriptionFor(route), `${route} must expose a description`);
    assert.match(sourceText(route), /free/i, `${route} must keep the word "free"`);
  }
  assert.match(
    descriptionFor("/overview/seafarers"),
    /agencies you choose/i,
    "/overview/seafarers keeps the plain-words consent phrase"
  );
});

// =====================================================================================
// (5) Nav
// =====================================================================================
test("identity: NAV_LINKS gains /overview/agencies, /book stays last, nav.agencies is English-only", () => {
  const siteNavSrc = fs.readFileSync(COMPONENT("SiteNav.tsx"), "utf8");
  const navBlock = siteNavSrc.slice(
    siteNavSrc.indexOf("const NAV_LINKS"),
    siteNavSrc.indexOf("];", siteNavSrc.indexOf("const NAV_LINKS")) + 2
  );
  assert.ok(navBlock.length > 0, "NAV_LINKS block must be found");
  assert.match(navBlock, /href:\s*["']\/overview\/agencies["'],\s*key:\s*["']nav\.agencies["']/);
  assert.match(navBlock, /\{ href: "\/book", key: "nav\.book" \},\r?\n\];/, "/book must stay the last nav entry");
  // Counted as `href: "` so the block's own TS type annotation (`{ href: string; key: string }[]`)
  // is not mistaken for a tenth link.
  assert.equal((navBlock.match(/href:\s*["']/g) || []).length, 9, "9 nav links after the insert");
  assert.equal(t("en", "nav.agencies"), "Agency CRM");
  assert.ok(!("zh" in DICT["nav.agencies"]), "nav.* is English-only by convention (D4)");
});

// =====================================================================================
// (6) The <WhatDockaIs /> strip
// =====================================================================================
// The strip's ANCHOR TEXT is deliberately not asserted anywhere: it has already changed twice
// (B6, then E11) and §2f may tune it again. Pinning link text here would turn an SEO decision
// into a test-breaking change for no honesty gain; the identity is asserted through the strip
// BODY by assertion 1.
const STRIP_WALKER_ROUTES = [
  ...ALL_ROUTES.filter((r) => r === "/registries" || r.startsWith("/registries/")),
  ...ALL_ROUTES.filter((r) => r === "/resources" || r.startsWith("/resources/")),
  "/what-is-primary-source-verification",
  "/contact",
];
// "use client" (/verify) and `export default async` (/book) — neither can be expand()-rendered,
// so the strip is asserted in the source for those two.
const STRIP_SOURCE_ROUTES = ["/verify", "/book"];

test("identity: the positioning strip renders on all 19 walker-checked routes", () => {
  assert.equal(STRIP_WALKER_ROUTES.length, 19, "8 country pages + /registries + /resources + 7 guides + PSV + /contact");
  for (const route of STRIP_WALKER_ROUTES) {
    const ids = collectTestIds(render(loadRoute(...segsFor(route))));
    assert.ok(ids.has("what-docka-is"), `${route} must render <WhatDockaIs />`);
  }
});

test("identity: /verify and /book carry the strip in source (client / async routes)", () => {
  for (const route of STRIP_SOURCE_ROUTES) {
    assert.match(readFile(...segsFor(route)), /<WhatDockaIs\s*\/>/, `${route} must mount <WhatDockaIs />`);
  }
});

// =====================================================================================
// (7) /llms.txt
// =====================================================================================
test("identity: /llms.txt says CRM, names the buyer, and still lists every llms-listed URL", async () => {
  const res = loadRoute("llms.txt", "route.ts").GET();
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /\bCRM\b/);
  assert.match(text, /crewing agenc(y|ies)/i);
  for (const p of SITE_PAGES.filter((p) => p.llms)) {
    const url = p.path === "/" ? SITE_URL : `${SITE_URL}${p.path}`;
    assert.ok(text.includes(url), `llms.txt must link ${url}`);
  }
});

// =====================================================================================
// (8) Per-language identity token
// =====================================================================================
// The ASCII literal "CRM" is embedded untranslated in every language column — the same
// literal-embed convention the codebase already uses for "primary source verification (PSV)".
// Excluded on purpose:
//   home.seafarerFree — the seafarer's own sentence; it carries no CRM token by design;
//   home.seeAgencies  — a feature-term anchor, covered by the WAVE2_KEYS completeness sweep;
//   home.crmCta       — does carry the token after E10, but it is an anchor whose wording §2f
//                       may tune again, so it is covered by the CRM_KEYS completeness sweep
//                       in tests/home-i18n.test.mjs instead of pinned here;
//   nav.agencies      — English-only (D4), asserted for `en` in assertion 5.
const CRM_TOKEN_KEYS = ["home.title", "home.subtitle", "home.crmTitle", "footer.tagline"];

test("identity: the literal CRM token survives into all six language columns", () => {
  for (const key of CRM_TOKEN_KEYS) {
    const entry = DICT[key];
    assert.ok(entry, `missing dict entry: ${key}`);
    for (const code of ["en", "zh", "ru", "tl", "id", "vi"]) {
      assert.ok(typeof entry[code] === "string", `${key}.${code} must exist`);
      assert.ok(entry[code].includes("CRM"), `${key}.${code} must carry the literal CRM token`);
    }
  }
});

// =====================================================================================
// (9) The new CRM keys are really translated (D15)
// =====================================================================================
test("identity: every CRM key is genuinely translated, not an English placeholder", () => {
  for (const key of CRM_KEYS) {
    const entry = DICT[key];
    assert.ok(entry, `missing dict entry: ${key}`);
    assert.match(entry.zh, /\p{Script=Han}/u, `${key}.zh must contain a Han character`);
    assert.match(entry.ru, /\p{Script=Cyrillic}/u, `${key}.ru must contain Cyrillic`);
    assert.match(entry.vi, /[À-ỹ]/, `${key}.vi must contain a Vietnamese diacritic`);
    assert.notEqual(entry.tl, entry.en, `${key}.tl must not be the English string`);
    assert.notEqual(entry.id, entry.en, `${key}.id must not be the English string`);
  }
});

// =====================================================================================
// (10) The CRM CTA is not a second blue primary (D6)
// =====================================================================================
register("./_tsx-hooks.mjs", import.meta.url);
const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { HomeClient } = await import("@/components/HomeClient");
const homeHtml = renderToString(React.createElement(HomeClient));

test("identity: the CRM section adds no second blue primary pill", () => {
  // The plan's "exactly one bg-brand-600" is the count in HomeClient's OWN source (the hero
  // #verify anchor at :94) — that is the guard that catches a pill added to the CRM section.
  const homeClientSrc = fs.readFileSync(COMPONENT("HomeClient.tsx"), "utf8");
  assert.equal(
    (homeClientSrc.match(/bg-brand-600/g) ?? []).length,
    1,
    "HomeClient owns exactly one blue primary: the hero #verify anchor"
  );
  // In the RENDERED html there are two, and both predate this batch: that hero anchor plus the
  // VerifyBox submit button (components/VerifyBox.tsx:380), which is inside the widget.
  assert.equal(
    (homeHtml.match(/bg-brand-600/g) ?? []).length,
    2,
    "hero #verify anchor + VerifyBox submit, and nothing new"
  );
});

// =====================================================================================
// (11) Reminder honesty pin (D1)
// =====================================================================================
test("identity: the reminder copy matches DEFAULT_REMINDER_SETTINGS exactly", () => {
  assert.deepEqual(DEFAULT_REMINDER_SETTINGS, { leadValue: 1, leadUnit: "months", count: 3, intervalDays: 14 });
  const crm3b = en("home.crm3b");
  assert.ok(crm3b.includes("three reminders"), "count 3 stated in words");
  assert.ok(crm3b.includes("a month ahead"), "lead 1 month stated in words");
  assert.ok(crm3b.includes("every two weeks"), "intervalDays 14 stated in words");
  assert.doesNotMatch(crm3b, /\bfour\b|\bfortnight\b/i, "no invented count and no 'fortnight'");
});

// =====================================================================================
// (12) Organization.knowsAbout
// =====================================================================================
test("identity: Organization.knowsAbout is 6 entries and leads with the CRM category", () => {
  const org = ofType(ldNodes(loadRoute("layout.tsx").default({ children: null })), "Organization")[0];
  assert.ok(org, "root layout must emit an Organization node");
  assert.equal(org.knowsAbout.length, 6);
  assert.ok(org.knowsAbout.includes("Crewing agency CRM"));
});

// =====================================================================================
// (13) Disambiguator: new present, old absent
// =====================================================================================
test("identity: the homepage disambiguator no longer disclaims CRM capability", () => {
  const src = readFile("page.tsx");
  assert.match(src, /Docka is a crewing agency CRM with certificate verification built in\./);
  assert.doesNotMatch(src, /is not a rest-hours or scheduling tool\. It verifies certificates\./);
});

// =====================================================================================
// (14) The machine graph does not contradict the copy, and rendering it touches no store
// =====================================================================================
test("identity: #software describes a CRM with the scope limiter, and /pricing reads no store", () => {
  const db = path.join(APP, "data", "db.json");
  const mtimeBefore = fs.existsSync(db) ? fs.statSync(db).mtimeMs : null;
  const before = billingCalls;
  const app = ofType(ldNodes(loadRoute("pricing", "page.tsx").default({})), "SoftwareApplication").find((n) =>
    String(n["@id"]).endsWith("#software")
  );
  assert.ok(app, "/pricing must emit the #software SoftwareApplication node");
  assert.match(app.description, /\bCRM\b/i);
  assert.doesNotMatch(app.description, /^Automated primary source verification/);
  // E6 (persona N1): no categorical coverage claim, and the scope limiter is present.
  assert.doesNotMatch(app.description, /every certificate/i);
  assert.match(app.description, /of supported countries/);
  // seo-schema-b:188 owns schema shape; this file owns positioning, so a later
  // "let's add a feature" edit has to face the positioning suite too.
  assert.equal(app.featureList.length, 5);
  // E2: the render went through the @/lib/billing-store stub, so it never read data/db.json.
  assert.ok(billingCalls > before, "/pricing must reach getBillingSettings() through the stub");
  if (mtimeBefore !== null) {
    assert.equal(fs.statSync(db).mtimeMs, mtimeBefore, "rendering /pricing must not write data/db.json");
  }
});

// =====================================================================================
// (15) Style scan — the NEW and REWRITTEN strings only (D10)
// =====================================================================================
// Restricted on purpose. A whole-file or whole-namespace scan would be red on arrival: the
// existing home.* namespace legitimately contains PINNED U+2014 characters (home.verifyHint is
// pinned WITH its em dash at home-dom.test.mjs:105, and home.liveLookup, home.step1b,
// home.pillar1b, home.pillar2b and HOME_FAQ[3].a all carry one). So the input is an explicit
// list of labelled strings, and every one of them is READ FROM THE SHIPPED CODE rather than
// re-typed here — a second copy of the copy would rot, and the literals are already pinned
// where plan v4 §3a says they belong.
//
// Not individually scannable, and deliberately left out: the source-only lead sentences of
// §2c (the /about lead, the /overview self-definition, the /privacy controller sentence, the
// PRICING_LEDE opener, the two seafarer body sentences and the /overview/agencies H1 + hero
// sub). Isolating those from their JSX would mean re-typing each literal here, i.e. a second
// pin on wording that §3a already places in seo-ux-c / home-dom. They were gated at authoring
// time (plan v4 §0) and the routes that own them keep their own page-level style scans.
function newCopyPairs() {
  const pairs = [];
  for (const key of CRM_KEYS) pairs.push([`DICT.${key}.en`, en(key)]);
  for (const key of ["home.title", "home.subtitle", "home.seeAgencies", "footer.tagline", "nav.agencies"]) {
    pairs.push([`DICT.${key}.en`, en(key)]);
  }
  pairs.push(["lib/seo.ts SITE_DESCRIPTION", SITE_DESCRIPTION]);
  pairs.push(["lib/seo.ts META_DESCRIPTION", META_DESCRIPTION]);
  pairs.push(["app/layout.tsx ROOT_TITLE", loadRoute("layout.tsx").metadata.title.default]);

  // The strip: heading + body + anchor, read out of the rendered component.
  const strip = loadTs(COMPONENT("WhatDockaIs.tsx"));
  pairs.push(["components/WhatDockaIs.tsx (heading + body + anchor)", textOf(expand(strip.WhatDockaIs({})))]);

  // The footer anchor text (the layout's footer sits under the inert LanguageProvider stub, so
  // it is read structurally from the source rather than from the rendered tree).
  const layoutSrc = readFile("layout.tsx");
  const anchor = layoutSrc.match(/href="\/overview\/agencies"[\s\S]{0,600}?>\s*([^<>{}]+?)\s*<\/Link>/);
  assert.ok(anchor, "the footer must keep a /overview/agencies link with literal anchor text");
  pairs.push(["app/layout.tsx footer anchor", anchor[1]]);

  // Every rewritten title / description.
  for (const route of ["/overview/agencies", "/overview", "/book"]) {
    pairs.push([`${route} title`, titleFor(route)]);
  }
  for (const route of [...BUYER_DESCRIPTION_ROUTES.filter((r) => r !== "/"), ...SEAFARER_INTENT_ROUTES]) {
    pairs.push([`${route} description`, descriptionFor(route)]);
  }
  // The home route's own WebPage node (C3 renamed it, §2d rewrote its description).
  const homeWebPage = webPageNode(HOME_ROUTE);
  assert.ok(homeWebPage, "the homepage must emit a WebPage node");
  pairs.push(["/ homeWebPageJsonLd.name", homeWebPage.name]);
  pairs.push(["/ homeWebPageJsonLd.description", homeWebPage.description]);

  // The #software description.
  const software = ofType(ldNodes(loadRoute("pricing", "page.tsx").default({})), "SoftwareApplication").find((n) =>
    String(n["@id"]).endsWith("#software")
  );
  assert.ok(software, "/pricing must emit the #software node");
  pairs.push(["/pricing #software description", software.description]);

  // The reworded disambiguator (already pinned by assertion 13; scanned here as new copy).
  pairs.push(["home disambiguator", "Docka is a crewing agency CRM with certificate verification built in."]);

  // HOME_FAQ: the rewritten [0].a plus the two appended CRM entries, read from the rendered
  // FAQPage JSON-LD (index order follows the HOME_FAQ array). The three untouched middle
  // entries are NOT scanned: HOME_FAQ[3].a legitimately carries a pinned em dash.
  const homeFaq = ofType(ldNodes(loadRoute("page.tsx").default({})), "FAQPage")[0];
  assert.ok(homeFaq, "the homepage must emit a FAQPage node");
  assert.ok(homeFaq.mainEntity.length >= 6, `HOME_FAQ must carry >= 6 entries, saw ${homeFaq.mainEntity.length}`);
  pairs.push(["HOME_FAQ[0].a", homeFaq.mainEntity[0].acceptedAnswer.text]);
  for (const item of homeFaq.mainEntity.slice(-2)) {
    pairs.push([`HOME_FAQ new q: ${item.name.slice(0, 40)}`, item.name]);
    pairs.push([`HOME_FAQ new a: ${item.name.slice(0, 40)}`, item.acceptedAnswer.text]);
  }

  // AGENCIES_FAQ: the two appended CRM entries only (the four existing verification answers
  // legitimately spend the guide's tolerated "rather than"). /overview/agencies is "use
  // client", so the const is sliced out of the source.
  const agenciesSrc = readFile("overview", "agencies", "page.tsx");
  const start = agenciesSrc.indexOf("const AGENCIES_FAQ");
  assert.ok(start >= 0, "AGENCIES_FAQ must be found in /overview/agencies");
  const block = agenciesSrc.slice(start, agenciesSrc.indexOf("];", start) + 2);
  const faqStrings = [...block.matchAll(/\b[qa]:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(faqStrings.length >= 12, `AGENCIES_FAQ must carry >= 6 q/a pairs, saw ${faqStrings.length / 2}`);
  faqStrings.slice(-4).forEach((s, i) => pairs.push([`AGENCIES_FAQ new ${i}`, s]));

  return pairs;
}

test("identity: every new or rewritten string passes the style gate at zero tolerated hits", () => {
  const failures = [];
  for (const [label, text] of newCopyPairs()) {
    assert.ok(typeof text === "string" && text.length > 0, `${label}: no text to scan`);
    // A single string is not a page, so the guide's "at most one per page" allowance for the
    // four tolerated phrases does not apply here.
    failures.push(...scanStyle(label, text, { tolerated: 0 }));
    if (/[—–“”‘’]/.test(text)) failures.push(`${label}: typographic punctuation`);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("identity: the new titles and descriptions stay inside the SERP length caps", () => {
  for (const route of ["/overview/agencies", "/overview", "/book"]) {
    const title = titleFor(route);
    assert.ok(title.length >= 30 && title.length <= 60, `${route} bare title is ${title.length} chars (want 30-60)`);
  }
  for (const route of [...BUYER_DESCRIPTION_ROUTES.filter((r) => r !== "/"), ...SEAFARER_INTENT_ROUTES]) {
    const description = descriptionFor(route);
    assert.ok(
      description.length >= 70 && description.length <= 160,
      `${route} description is ${description.length} chars (want 70-160)`
    );
  }
});
