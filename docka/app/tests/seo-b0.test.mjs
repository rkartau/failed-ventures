// SEO implementation plan — WP-B0 (the "seam" commit) unit contract. Locks the shared
// primitives every later WP (A–E) imports, so their shape cannot drift underneath them:
//   - lib/seo.ts: META_DESCRIPTION (<=160), breadcrumbList(trail, selfPath?) with the
//     slash-less home item + "#breadcrumb" @id, webPageJsonLd(...) shape, plainPunct().
//   - lib/registry/public-rows.ts: registryTableRows() / REGISTRY_PUBLIC_ROWS never emit
//     `notes` (persona F10c) and contain no typographic punctuation (style guide R8);
//     REGISTRY_PAGE_SLUGS has exactly the 8 live flag states and every code exists.
//   - components/RegistryPortalLink.tsx: server-safe (no "use client"), renders the
//     pinned portalUrl with rel="noopener noreferrer" + target="_blank".
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-b0.test.mjs

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TSX transpile hooks (for RegistryPortalLink) — registered BEFORE the component import.
register("./_tsx-hooks.mjs", import.meta.url);

const {
  SITE_URL,
  abs,
  META_DESCRIPTION,
  SITE_DESCRIPTION,
  breadcrumbList,
  webPageJsonLd,
  plainPunct,
} = await import("@/lib/seo");
const {
  REGISTRY_PUBLIC_ROWS,
  registryTableRows,
  registryRow,
  REGISTRY_PAGE_SLUGS,
  registryPagePath,
} = await import("@/lib/registry/public-rows");
const { COUNTRIES, countryEntry } = await import("@/lib/registry/countries");
const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { RegistryPortalLink, portalHostname } = await import("@/components/RegistryPortalLink");

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPOGRAPHIC = /[–—‘’“”]/;

/** Every string value reachable in an object graph, with its key path. */
function walkStrings(node, trail = "", out = []) {
  if (typeof node === "string") out.push([trail, node]);
  else if (Array.isArray(node)) node.forEach((n, i) => walkStrings(n, `${trail}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) walkStrings(v, trail ? `${trail}.${k}` : k, out);
  return out;
}

/** Every key reachable in an object graph. */
function walkKeys(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => walkKeys(n, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      walkKeys(v, out);
    }
  return out;
}

// =====================================================================================
// (1) META_DESCRIPTION
// =====================================================================================
test("META_DESCRIPTION: the exact plan text, <=160 chars, plain punctuation, distinct from SITE_DESCRIPTION", () => {
  assert.equal(
    META_DESCRIPTION,
    "Docka is a CRM for crewing agencies. Keep the crew roster, documents and expiry dates in one place, and check certificates against the issuing registry."
  );
  assert.ok(META_DESCRIPTION.length <= 160, `META_DESCRIPTION is ${META_DESCRIPTION.length} chars`);
  assert.ok(!TYPOGRAPHIC.test(META_DESCRIPTION), "no typographic punctuation");
  assert.notEqual(META_DESCRIPTION, SITE_DESCRIPTION, "entity sentence stays separate");
});

// =====================================================================================
// (2) plainPunct fixtures
// =====================================================================================
test("plainPunct: dashes -> ', ' with or without spaces; curly quotes -> straight; URLs untouched", () => {
  assert.equal(plainPunct("Transpordiamet — Estonian Transport Administration"), "Transpordiamet, Estonian Transport Administration");
  assert.equal(plainPunct("A—B"), "A, B");
  assert.equal(plainPunct("A – B"), "A, B");
  assert.equal(plainPunct("A–B"), "A, B");
  assert.equal(plainPunct("A  —  B"), "A, B", "multiple surrounding spaces collapse");
  assert.equal(plainPunct("it’s ‘quoted’"), "it's 'quoted'");
  assert.equal(plainPunct("“shown”"), '"shown"');
  assert.equal(plainPunct("„low“"), '"low"', "low-9 opener (BG authority) also straightened");
  // URL tokens keep every character, including a dash or quote inside them.
  const url = "https://example.test/a—b?q=’x";
  assert.equal(plainPunct(`See ${url} — then “go”`), `See ${url}, then "go"`);
  assert.equal(plainPunct(url), url);
  assert.equal(plainPunct(""), "");
  assert.equal(plainPunct("plain, text: unchanged"), "plain, text: unchanged");
});

// =====================================================================================
// (3) breadcrumbList(trail, selfPath?)
// =====================================================================================
test("breadcrumbList: item 1 is the slash-less SITE_URL; other items absolute; @id only with selfPath", () => {
  const trail = [
    { name: "Home", path: "/" },
    { name: "Pricing", path: "/pricing" },
  ];
  const plain = breadcrumbList(trail);
  assert.equal(plain["@type"], "BreadcrumbList");
  assert.equal(plain.itemListElement[0].item, SITE_URL);
  assert.ok(!SITE_URL.endsWith("/"), "SITE_URL must be slash-less");
  assert.equal(plain.itemListElement[1].item, abs("/pricing"));
  assert.equal(plain["@id"], undefined, "no @id without selfPath");
  plain.itemListElement.forEach((li, i) => assert.equal(li.position, i + 1));

  const withId = breadcrumbList(trail, "/pricing");
  assert.equal(withId["@id"], `${abs("/pricing")}#breadcrumb`);
  assert.deepEqual(withId.itemListElement, plain.itemListElement, "items identical either way");
});

// =====================================================================================
// (4) webPageJsonLd shape
// =====================================================================================
test("webPageJsonLd: #webpage @id, url (SITE_URL for /), isPartOf #website, breadcrumb ref by default", () => {
  const node = webPageJsonLd({
    path: "/pricing",
    name: "Pricing",
    description: "d",
    dateModified: "2026-09-04",
  });
  assert.deepEqual(node, {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${abs("/pricing")}#webpage`,
    url: abs("/pricing"),
    name: "Pricing",
    description: "d",
    dateModified: "2026-09-04",
    isPartOf: { "@id": abs("/#website") },
    breadcrumb: { "@id": `${abs("/pricing")}#breadcrumb` },
  });
  // The breadcrumb ref matches what breadcrumbList(trail, path) emits — no dangling @id.
  assert.equal(node.breadcrumb["@id"], breadcrumbList([{ name: "Home", path: "/" }], "/pricing")["@id"]);

  const home = webPageJsonLd({ path: "/", name: "Home", description: "d", dateModified: "2026-09-04", breadcrumbId: false });
  assert.equal(home.url, SITE_URL, "home url is the slash-less origin");
  assert.equal(home["@id"], `${SITE_URL}/#webpage`);
  assert.equal("breadcrumb" in home, false, "breadcrumbId:false omits the reference");

  const contact = webPageJsonLd({ path: "/contact", name: "Contact", description: "d", dateModified: "2026-09-04", type: "ContactPage" });
  assert.equal(contact["@type"], "ContactPage");
});

// =====================================================================================
// (5) registryTableRows() / REGISTRY_PUBLIC_ROWS
// =====================================================================================
const ALLOWED_KEYS = new Set(["code", "country", "authority", "authorityShort", "portalUrl", "capability", "inputs", "userNotes"]);
const PUBLIC_CAPS = new Set(["auto", "auto-presence", "assisted", "manual"]);

test("registryTableRows(): returns the module-level REGISTRY_PUBLIC_ROWS (same, frozen array)", () => {
  assert.equal(registryTableRows(), REGISTRY_PUBLIC_ROWS);
  assert.ok(Object.isFrozen(REGISTRY_PUBLIC_ROWS));
  assert.ok(REGISTRY_PUBLIC_ROWS.length > 0);
});

test("registryTableRows(): NEVER emits `notes` (deep) and only the whitelisted keys", () => {
  const keys = walkKeys(REGISTRY_PUBLIC_ROWS);
  assert.ok(!keys.has("notes"), "`notes` (wire/dev metadata, persona F10c) must never be projected");
  for (const banned of ["domains", "keywords", "codePattern", "ocrCodePattern", "contactEmail", "keyKind", "recheckable", "embeddable", "qrPathPrefix", "issuerKind", "key", "source", "sensitive"]) {
    assert.ok(!keys.has(banned), `${banned} must not be projected`);
  }
  for (const row of REGISTRY_PUBLIC_ROWS) {
    for (const k of Object.keys(row)) assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${k} on ${row.code}`);
    assert.ok(Array.isArray(row.inputs) && row.inputs.every((s) => typeof s === "string"), `${row.code} inputs are label strings`);
  }
});

test("registryTableRows(): no typographic punctuation (U+2013/2014/2018/2019/201C/201D) in any string", () => {
  for (const [where, s] of walkStrings(REGISTRY_PUBLIC_ROWS)) {
    assert.ok(!TYPOGRAPHIC.test(s), `${where}: ${JSON.stringify(s)}`);
  }
  // Sanity: the projection actually transformed something (EE authority has an em dash in the table).
  assert.equal(registryRow("EE").authority, "Transpordiamet, Estonian Transport Administration");
});

test("registryTableRows(): only auto|auto-presence|assisted|manual, every code exists, portalUrl byte-identical", () => {
  const expected = COUNTRIES.filter((c) => PUBLIC_CAPS.has(c.capability));
  assert.equal(REGISTRY_PUBLIC_ROWS.length, expected.length, "one row per public-capability entry");
  assert.deepEqual(REGISTRY_PUBLIC_ROWS.map((r) => r.code), expected.map((c) => c.country), "table order preserved");
  for (const row of REGISTRY_PUBLIC_ROWS) {
    const src = countryEntry(row.code);
    assert.ok(src, `${row.code} exists in COUNTRIES`);
    assert.ok(PUBLIC_CAPS.has(row.capability), `${row.code} capability ${row.capability}`);
    assert.equal(row.capability, src.capability);
    assert.equal(row.portalUrl, src.portalUrl, "portal URL never altered");
    assert.equal(row.inputs.length, src.inputs.length);
    assert.equal(row.country, plainPunct(src.countryName));
  }
  // The unverified-endpoint entries (adapter unconfirmed) are not public.
  for (const c of COUNTRIES.filter((c) => c.capability === "unverified-endpoint")) {
    assert.equal(registryRow(c.country), undefined, `${c.country} must not be listed`);
  }
});

// =====================================================================================
// (6) REGISTRY_PAGE_SLUGS
// =====================================================================================
test("REGISTRY_PAGE_SLUGS: exactly the 8 live flag states, every code in COUNTRIES, kebab slugs", () => {
  assert.deepEqual(REGISTRY_PAGE_SLUGS, {
    EE: "estonia",
    DK: "denmark",
    CY: "cyprus",
    UK: "united-kingdom",
    NO: "norway",
    FR: "france",
    "UA-MARAD": "ukraine",
    AZ: "azerbaijan",
  });
  assert.equal(Object.keys(REGISTRY_PAGE_SLUGS).length, 8);
  for (const [code, slug] of Object.entries(REGISTRY_PAGE_SLUGS)) {
    assert.ok(countryEntry(code), `${code} exists in COUNTRIES`);
    assert.ok(registryRow(code), `${code} is a public row`);
    assert.match(slug, /^[a-z]+(-[a-z]+)*$/);
    assert.equal(registryPagePath(code), `/registries/${slug}`);
  }
  assert.equal(countryEntry("UA-MARAD").domains[0], "vrf.marad.gov.ua", "ukraine page = the STATE registry entry");
  assert.equal(registryPagePath("LV"), undefined);
  // The two registry pages that already exist resolve to real route files.
  for (const slug of ["ukraine", "azerbaijan"]) {
    assert.ok(fs.existsSync(path.join(APP, "app", "registries", slug, "page.tsx")), `app/registries/${slug}/page.tsx`);
  }
});

// =====================================================================================
// (7) RegistryPortalLink
// =====================================================================================
test("RegistryPortalLink: server-safe, renders portalUrl with noopener noreferrer + _blank, hostname default label", () => {
  const src = fs.readFileSync(path.join(APP, "components", "RegistryPortalLink.tsx"), "utf-8");
  assert.ok(!/^\s*["']use client["'];?\s*$/m.test(src), "must stay a server-safe component (no use-client directive line)");
  assert.ok(src.includes('Pick<CountryEntry, "portalUrl">'), "typed on Pick<CountryEntry,\"portalUrl\">");

  const html = renderToStaticMarkup(React.createElement(RegistryPortalLink, { portalUrl: "https://meremees.transpordiamet.ee" }));
  assert.equal(
    html,
    '<a href="https://meremees.transpordiamet.ee" rel="noopener noreferrer" target="_blank">official portal (meremees.transpordiamet.ee)</a>'
  );
  const labelled = renderToStaticMarkup(
    React.createElement(RegistryPortalLink, { portalUrl: "https://vrf.marad.gov.ua/check-document", label: "Check on MARAD", className: "underline" })
  );
  assert.ok(labelled.includes(">Check on MARAD</a>"));
  assert.ok(labelled.includes('class="underline"'));
  assert.equal(portalHostname("https://vrf.marad.gov.ua/check-document"), "vrf.marad.gov.ua");
  assert.equal(portalHostname("not a url"), "not a url");
  // Every public row renders (a CountryEntry / RegistryPublicRow both satisfy the prop type).
  for (const row of REGISTRY_PUBLIC_ROWS) {
    const h = renderToStaticMarkup(React.createElement(RegistryPortalLink, row));
    assert.ok(h.includes(`href="${row.portalUrl}"`), row.code);
  }
});

test("RegistryInfo.tsx: rendering left byte-identical by B0 (extraction was standalone)", () => {
  const src = fs.readFileSync(path.join(APP, "components", "RegistryInfo.tsx"), "utf-8");
  assert.ok(src.includes('data-testid="registry-portal-link"'));
  assert.ok(!src.includes("RegistryPortalLink"), "RegistryInfo does not import the new primitive");
});
