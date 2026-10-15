// Geometry tests for the Lead Atlas world mesh — run against the REAL shipped
// TopoJSON (lib/atlas/countries-110m.json), not a mock (RV3/T7). Uses the pure
// buildAtlasGeometryFrom(topology) so no JSON-import machinery is involved.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/atlas-geo.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAtlasGeometryFrom } from "@/lib/atlas/geo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESH = path.resolve(__dirname, "..", "lib", "atlas", "countries-110m.json");
const world = JSON.parse(fs.readFileSync(MESH, "utf-8"));
const geo = buildAtlasGeometryFrom(world);

const polySet = new Set(geo.polygonIso2);
const markerSet = new Set(geo.markerIso2);
const polyByName = new Map(geo.polygons.map((p) => [p.name, p]));

// --- T6: every data ISO2 resolves to a fill or a marker (nothing dropped) ----

test("T6: representative data countries each resolve to a polygon or a marker", () => {
  // Large polygons + micro-state markers spanning the base's real footprint.
  const sample = [
    "GB", "NO", "FR", "DE", "IN", "US", "CN", "RU", "JP", "GR", "IT", "ES",
    "MC", "SG", "HK", "MT", "BM", "IM", "FO", "LU", "KW", "QA", "CY",
  ];
  for (const iso2 of sample) {
    assert.ok(
      polySet.has(iso2) || markerSet.has(iso2),
      `${iso2} resolves to neither a polygon nor a marker`
    );
  }
});

test("T6: a garbage code (ZZ) resolves to nothing (surfaced as unmapped, not mis-joined)", () => {
  assert.ok(!polySet.has("ZZ") && !markerSet.has("ZZ"));
});

// --- T7: id-less (-99 / undefined) features resolve correctly, never wrongly --

test("T7: the id-less features in the shipped mesh are enumerated + all named", () => {
  const idless = world.objects.countries.geometries.filter(
    (g) => !Number.isFinite(Number(g.id)) || String(g.id) === "-99"
  );
  const names = idless.map((g) => g.properties && g.properties.name).sort();
  // The shipped world-atlas 110m encodes exactly these three with no numeric id.
  assert.deepEqual(names, ["Kosovo", "N. Cyprus", "Somaliland"]);
  for (const g of world.objects.countries.geometries) {
    assert.ok(g.properties && typeof g.properties.name === "string", "every feature is named");
  }
});

test("T7: Kosovo -> XK via the name map; N. Cyprus / Somaliland -> no-data", () => {
  assert.equal(polyByName.get("Kosovo")?.iso2, "XK");
  assert.equal(polyByName.get("N. Cyprus")?.iso2, "");
  assert.equal(polyByName.get("Somaliland")?.iso2, "");
});

test("T7: France / Norway resolve by NUMERIC id (250/578) to FR/NO", () => {
  assert.equal(polyByName.get("France")?.iso2, "FR");
  assert.equal(polyByName.get("Norway")?.iso2, "NO");
});

test("T7: Cyprus (196) stays CY — N. Cyprus never steals a recognised code", () => {
  assert.equal(polyByName.get("Cyprus")?.iso2, "CY");
});

test("T7: no feature resolves an id-less territory to a wrong recognised country", () => {
  // Kosovo/N.Cyprus/Somaliland must map ONLY to XK or "" — never to FR/NO/CY/etc.
  for (const nm of ["Kosovo", "N. Cyprus", "Somaliland"]) {
    const iso2 = polyByName.get(nm)?.iso2;
    assert.ok(iso2 === "XK" || iso2 === "", `${nm} mis-joined to ${iso2}`);
  }
});

// --- structural sanity -------------------------------------------------------

test("Antarctica is excluded; sphere + polygons are present and serializable", () => {
  assert.ok(!geo.polygons.some((p) => p.name === "Antarctica"));
  assert.ok(geo.sphere.length > 0);
  assert.ok(geo.polygons.length > 150);
  for (const p of geo.polygons.slice(0, 5)) {
    assert.equal(typeof p.d, "string");
    assert.equal(typeof p.iso2, "string");
  }
});
