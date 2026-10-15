// lib/atlas/geo.ts — SERVER-ONLY Lead Atlas geometry (precomputed once, memoized).
//
// The map geometry is STATIC: the world mesh never changes between requests, only
// the per-country colour mapping does (and that is done on the client from the live
// stats). So we run topojson-client + d3-geo ONCE at module scope and emit a fully
// serializable AtlasGeometry (plain arrays of strings/numbers) for the client — NO
// d3 or topojson ships to the browser.
//
// Projection + thresholds are lifted verbatim from the reviewed artifact
// (scratchpad/lead-atlas.html): geoEqualEarth fit to a 960×494 sphere, polygon-vs-
// marker area threshold 9, base marker radius 3.2.
//
// JOIN RULES (RV3):
//  * A feature with a FINITE numeric id joins by ISO-numeric → ISO2 (numericToIso2).
//  * A feature whose id is NON-finite (undefined / "-99" / non-numeric) NEVER
//    numeric-joins — it resolves ONLY through an explicit name map (France→FR,
//    Norway→NO, Kosovo→XK; everything else → no-data). This prevents mis-attributing
//    Kosovo / N. Cyprus / Somaliland (all id-less in the shipped 110m file) to a
//    wrong country. NOTE: the shipped world-atlas 110m file encodes these three as
//    `id: undefined` (NOT the `-99` the artifact/plan assumed); the finite-id guard
//    below covers both encodings.

import { readFileSync } from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";
import { geoEqualEarth, geoPath } from "d3-geo";
import type { Feature, Geometry } from "geojson";
import { ISO2_NUMERIC, MICRO_COORDS } from "./reference";

/**
 * Where the bundled world mesh lives, relative to the app root (process.cwd()).
 * Read via fs (the SAME cwd-relative pattern loadLeadsPageData uses for the base)
 * rather than an ESM JSON import — that keeps this module loadable by the plain
 * node test runtime and consistent with the app's `next start` deployment (cwd =
 * app dir, source files present on disk).
 */
export const MESH_REL_PATH = path.join("lib", "atlas", "countries-110m.json");

export const ATLAS_WIDTH = 960;
export const ATLAS_HEIGHT = 500;
/** d3 projected-area (px²) below which a country is a marker, not a polygon. */
const AREA_THRESHOLD = 9;
/** Marker radius at scale k=1 (client shrinks it with zoom). */
export const BASE_MARKER_RADIUS = 3.2;

/** One rendered country polygon; `iso2` is "" when the feature has no data join. */
export type AtlasPolygon = { id: string; iso2: string; name: string; d: string };
/** A projected marker dot for a micro-state / tiny territory (screen px). */
export type AtlasMarker = { iso2: string; x: number; y: number };

/** Fully serializable geometry payload for the client choropleth. */
export type AtlasGeometry = {
  width: number;
  height: number;
  /** Sphere outline path (the sea frame). */
  sphere: string;
  /** Every rendered land polygon (Antarctica excluded). */
  polygons: AtlasPolygon[];
  /** Marker dots for tiny/absent territories, keyed to their ISO2. */
  markers: AtlasMarker[];
  /** Distinct ISO2 that own at least one polygon (any size). */
  polygonIso2: string[];
  /** Distinct ISO2 that own a marker. */
  markerIso2: string[];
  baseMarkerRadius: number;
};

/** numeric ISO id → ISO2 (inverted from the reference table). */
const numericToIso2 = new Map<number, string>();
for (const [iso2, num] of Object.entries(ISO2_NUMERIC)) numericToIso2.set(num, iso2);

/** Natural-Earth display name → ISO2, for id-less (`-99`/undefined) features only. */
const NAME_TO_ISO2: Record<string, string> = {
  france: "FR", // present as numeric 250 in the shipped file; kept as a defensive fallback
  norway: "NO", // present as numeric 578 in the shipped file; kept as a defensive fallback
  kosovo: "XK", // id-less in the 110m mesh → resolves here, never by numeric-join
  // "N. Cyprus" and "Somaliland" are DELIBERATELY absent → they render as no-data,
  // never mis-attributed to a recognised state.
};

/** Same normalisation as the artifact's `norm()` (diacritics + punctuation folded). */
function normName(s: unknown): string {
  return (s == null ? "" : String(s))
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'’]/g, "")
    .replace(/&/g, "and")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve one feature's ISO2, honouring the finite-id vs name-map rule (RV3). */
function resolveIso2(id: unknown, name: unknown): string {
  const idStr = id == null ? "" : String(id).trim();
  const n = Number(id);
  // A finite numeric id (and NOT the sentinel -99) joins by ISO-numeric.
  if (idStr !== "" && idStr !== "-99" && Number.isFinite(n)) {
    return numericToIso2.get(n) ?? "";
  }
  // Non-finite / sentinel id → name map ONLY (never numeric-join).
  return NAME_TO_ISO2[normName(name)] ?? "";
}

/**
 * PURE geometry builder over an already-parsed TopoJSON topology (the `countries`
 * object). Separated from file IO so it is testable against the REAL shipped mesh
 * without any JSON-import machinery (T6/T7). Never throws for a well-formed mesh.
 */
export function buildAtlasGeometryFrom(world: unknown): AtlasGeometry {
  const topo = world as { objects: { countries: unknown } };
  // topojson → GeoJSON features, minus Antarctica (name + numeric id 10).
  const fc = feature(topo as never, topo.objects.countries as never) as unknown as {
    features: Feature<Geometry, { name?: string }>[];
  };
  const feats = fc.features.filter(
    (f) => normName(f.properties?.name) !== "antarctica" && Number(f.id) !== 10
  );

  const proj = geoEqualEarth().fitSize([ATLAS_WIDTH, ATLAS_HEIGHT - 6], { type: "Sphere" });
  const path = geoPath(proj);

  const polygons: AtlasPolygon[] = [];
  const polygonIso2 = new Set<string>();
  const largePolygonIso2 = new Set<string>();
  const smallCentroid = new Map<string, [number, number]>();

  for (const f of feats) {
    const d = path(f);
    if (!d) continue; // unprojectable geometry — skip (defensive)
    const iso2 = resolveIso2(f.id, f.properties?.name);
    const name = f.properties?.name ?? (iso2 || "");
    polygons.push({ id: f.id == null ? "" : String(f.id), iso2, name, d });
    if (iso2 !== "") {
      polygonIso2.add(iso2);
      const area = path.area(f);
      if (area >= AREA_THRESHOLD) {
        largePolygonIso2.add(iso2);
      } else if (!smallCentroid.has(iso2)) {
        const c = path.centroid(f);
        if (c && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          smallCentroid.set(iso2, [c[0], c[1]]);
        }
      }
    }
  }

  // Markers: a country needs one when it has NO large polygon. Prefer its own small
  // feature centroid; else fall back to the micro-state lon/lat, projected.
  const markers: AtlasMarker[] = [];
  const markerIso2 = new Set<string>();
  for (const [iso2, c] of smallCentroid) {
    if (largePolygonIso2.has(iso2)) continue;
    markers.push({ iso2, x: c[0], y: c[1] });
    markerIso2.add(iso2);
  }
  for (const [iso2, lonlat] of Object.entries(MICRO_COORDS)) {
    if (largePolygonIso2.has(iso2) || markerIso2.has(iso2)) continue;
    const pt = proj(lonlat);
    if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      markers.push({ iso2, x: pt[0], y: pt[1] });
      markerIso2.add(iso2);
    }
  }

  return {
    width: ATLAS_WIDTH,
    height: ATLAS_HEIGHT,
    sphere: path({ type: "Sphere" }) ?? "",
    polygons,
    markers,
    polygonIso2: Array.from(polygonIso2).sort(),
    markerIso2: Array.from(markerIso2).sort(),
    baseMarkerRadius: BASE_MARKER_RADIUS,
  };
}

let cached: AtlasGeometry | null = null;

/**
 * Read the bundled world mesh (cwd-relative) and build the serializable geometry,
 * memoized at module scope — the mesh is identical for every request/admin, so this
 * parses + projects a single time per process.
 */
export function buildAtlasGeometry(): AtlasGeometry {
  if (cached) return cached;
  const world = JSON.parse(readFileSync(path.join(process.cwd(), MESH_REL_PATH), "utf-8"));
  cached = buildAtlasGeometryFrom(world);
  return cached;
}

/** Test hook: drop the module-scope memo. */
export function __clearAtlasGeometryCache(): void {
  cached = null;
}
