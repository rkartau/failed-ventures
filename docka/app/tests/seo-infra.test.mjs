// SEO implementation plan — WP-A (infra, headers, assets) regression contract.
//
// Locks, so later work cannot drift underneath it:
//   - next.config.js: poweredByHeader:false; static-asset cache rules for
//     /screenshots/:path* and /samples/:path* (AFTER the /:path* security group);
//     the bfcache allowlist gained /privacy, /sample/seafarer, /sample/agency and
//     still contains NO private/token route (/agent, /seafarer, /api, /o, /u, /share,
//     /portal, /verify/:path*, /book — /book carries a per-lead outreach token, R16);
//     no Content-Security-Policy-Report-Only anywhere (CSP is owner-gated, R1).
//   - app/favicon.ico is a real ICO container (00 00 01 00) with 16/32/48 px frames.
//   - public/apple-touch-icon.png is a byte copy of app/apple-icon.png (fixes the 404
//     at the default iOS path).
//   - Every scripts/sample-fixtures/*.jpg has a <=25 KB thumbnail under
//     public/samples/thumbs/ and is listed in lib/sample-thumbs-manifest.ts (S9).
//   - Every public/screenshots/*.webp has a -640 sibling.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/seo-infra.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SAMPLE_THUMB_BASENAMES, SAMPLE_THUMB_EXT } from "@/lib/sample-thumbs-manifest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const loadConfig = () => require(path.join(APP, "next.config.js"));

const STATIC_ASSET_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const MARKETING_CACHE = "private, max-age=0, must-revalidate";
const NEW_ALLOWLIST_ROUTES = ["/privacy", "/sample/seafarer", "/sample/agency"];
const FORBIDDEN_ALLOWLIST_PREFIXES = [
  "/agent",
  "/seafarer",
  "/api",
  "/o",
  "/u",
  "/share",
  "/portal",
  "/verify/:path*",
  "/book",
  "/admin",
];

// =====================================================================================
// (1) next.config.js
// =====================================================================================
test("config: poweredByHeader is false (no X-Powered-By: Next.js)", () => {
  const cfg = loadConfig();
  assert.equal(cfg.poweredByHeader, false);
});

test("headers: /screenshots/:path* and /samples/:path* get the public static-asset cache rule", async () => {
  const groups = await loadConfig().headers();
  for (const source of ["/screenshots/:path*", "/samples/:path*"]) {
    const g = groups.find((x) => x.source === source);
    assert.ok(g, `header group for ${source} must exist`);
    const cc = g.headers.find((h) => h.key === "Cache-Control");
    assert.ok(cc, `${source} must set Cache-Control`);
    assert.ok(cc.value.includes("max-age=86400"), `${source} Cache-Control must contain max-age=86400 (got ${cc.value})`);
    assert.equal(cc.value, STATIC_ASSET_CACHE);
    // Exactly one Cache-Control per group (no duplicate/contradicting values).
    assert.equal(g.headers.filter((h) => h.key === "Cache-Control").length, 1);
  }
});

test("headers: the static-asset groups come AFTER the /:path* security group (order matters in Next)", async () => {
  const groups = await loadConfig().headers();
  const idx = (s) => groups.findIndex((g) => g.source === s);
  assert.equal(idx("/:path*"), 0, "the /:path* security group must be first");
  assert.ok(idx("/screenshots/:path*") > idx("/:path*"));
  assert.ok(idx("/samples/:path*") > idx("/:path*"));
});

test("headers: bfcache allowlist includes /privacy, /sample/seafarer, /sample/agency", async () => {
  const groups = await loadConfig().headers();
  for (const source of NEW_ALLOWLIST_ROUTES) {
    const g = groups.find((x) => x.source === source);
    assert.ok(g, `allowlist group for ${source} must exist`);
    const cc = g.headers.find((h) => h.key === "Cache-Control");
    assert.equal(cc?.value, MARKETING_CACHE, `${source} must carry the marketing (bfcache) Cache-Control`);
  }
});

test("headers: allowlist never contains a private/token route (denylist stays absent)", async () => {
  const groups = await loadConfig().headers();
  const cacheSources = groups
    .filter((g) => g.source !== "/:path*" && g.headers.some((h) => h.key === "Cache-Control"))
    .map((g) => g.source);
  for (const forbidden of FORBIDDEN_ALLOWLIST_PREFIXES) {
    for (const src of cacheSources) {
      const hit =
        src === forbidden ||
        src === `${forbidden}/:path*` ||
        src.startsWith(`${forbidden}/`);
      assert.ok(!hit, `Cache-Control rule "${src}" must not cover private route ${forbidden}`);
    }
  }
  // /verify is allowlisted EXACTLY (tool landing) — never its /verify/[uuid] children.
  assert.ok(cacheSources.includes("/verify"), "/verify exact landing stays allowlisted");
  assert.ok(!cacheSources.includes("/verify/:path*"), "/verify/:path* must NOT be allowlisted");
  // Only the pinned Cache-Control values exist anywhere in the config.
  const values = new Set(
    groups.flatMap((g) => g.headers.filter((h) => h.key === "Cache-Control").map((h) => h.value)),
  );
  assert.deepEqual([...values].sort(), [MARKETING_CACHE, STATIC_ASSET_CACHE].sort());
});

test("headers: no Content-Security-Policy-Report-Only anywhere (CSP is owner-gated, plan R1)", async () => {
  const groups = await loadConfig().headers();
  for (const g of groups) {
    for (const h of g.headers) {
      assert.notEqual(
        h.key.toLowerCase(),
        "content-security-policy-report-only",
        `${g.source} must not emit Content-Security-Policy-Report-Only`,
      );
    }
  }
  const source = fs.readFileSync(path.join(APP, "next.config.js"), "utf8");
  assert.ok(!/Report-Only/i.test(source), "next.config.js source must not mention a Report-Only CSP");
  // The security group is still applied to every route (regression guard for the reorder).
  const all = groups.find((g) => g.source === "/:path*");
  assert.ok(all.headers.some((h) => h.key === "Content-Security-Policy"));
  assert.ok(all.headers.some((h) => h.key === "Strict-Transport-Security"));
});

// =====================================================================================
// (2) favicon.ico + apple-touch-icon.png
// =====================================================================================
test("assets: app/favicon.ico exists and is an ICO container with 16/32/48 px PNG frames", () => {
  const p = path.join(APP, "app", "favicon.ico");
  assert.ok(fs.existsSync(p), "app/favicon.ico must exist");
  const buf = fs.readFileSync(p);
  assert.ok(buf.length > 6 + 16, "ICO must have a header and at least one entry");
  assert.deepEqual([...buf.subarray(0, 4)], [0x00, 0x00, 0x01, 0x00], "ICONDIR must start with 00 00 01 00");
  const count = buf.readUInt16LE(4);
  assert.equal(count, 3, "expect exactly three frames");
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const w = buf.readUInt8(e);
    const h = buf.readUInt8(e + 1);
    const bytes = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    assert.equal(w, h, `frame ${i} must be square`);
    sizes.push(w);
    assert.ok(off + bytes <= buf.length, `frame ${i} must lie inside the file`);
    // Each frame is a PNG blob (\x89PNG\r\n\x1a\n).
    assert.deepEqual(
      [...buf.subarray(off, off + 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `frame ${i} must be a PNG blob`,
    );
    // The PNG IHDR width must match the directory entry.
    assert.equal(buf.readUInt32BE(off + 16), w, `frame ${i} PNG width must equal its ICO entry`);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
  assert.ok(buf.length < 64 * 1024, `favicon.ico should be small (got ${buf.length} bytes)`);
});

test("assets: public/apple-touch-icon.png is a byte copy of app/apple-icon.png", () => {
  const src = path.join(APP, "app", "apple-icon.png");
  const dst = path.join(APP, "public", "apple-touch-icon.png");
  assert.ok(fs.existsSync(src), "app/apple-icon.png (the Next file convention) must exist");
  assert.ok(fs.existsSync(dst), "public/apple-touch-icon.png must exist (default iOS path)");
  const a = fs.readFileSync(src);
  const b = fs.readFileSync(dst);
  assert.ok(a.length > 0);
  assert.ok(a.equals(b), "apple-touch-icon.png must be byte-identical to app/apple-icon.png");
});

// =====================================================================================
// (3) sample thumbnails + manifest (S9)
// =====================================================================================
test("assets: every sample fixture has a <=25 KB thumbnail and is in SAMPLE_THUMB_BASENAMES", () => {
  const fixturesDir = path.join(APP, "scripts", "sample-fixtures");
  const thumbsDir = path.join(APP, "public", "samples", "thumbs");
  const fixtures = fs
    .readdirSync(fixturesDir)
    .filter((f) => /\.jpe?g$/i.test(f))
    .map((f) => f.replace(/\.jpe?g$/i, ""))
    .sort();
  assert.equal(fixtures.length, 12, "plan: there are 12 sample fixtures");
  assert.equal(SAMPLE_THUMB_EXT, "webp");
  const listed = [...SAMPLE_THUMB_BASENAMES];
  assert.deepEqual(listed, [...listed].sort(), "manifest must be sorted");
  assert.deepEqual(listed, fixtures, "manifest must list exactly the fixture basenames");
  for (const base of fixtures) {
    assert.ok(/^[a-z0-9-]+$/.test(base), `basename ${base} must match /^[a-z0-9-]+$/`);
    const thumb = path.join(thumbsDir, `${base}.${SAMPLE_THUMB_EXT}`);
    assert.ok(fs.existsSync(thumb), `thumb missing: public/samples/thumbs/${base}.${SAMPLE_THUMB_EXT}`);
    const buf = fs.readFileSync(thumb);
    assert.ok(buf.length > 0 && buf.length <= 25 * 1024, `${base} thumb must be <=25 KB (got ${buf.length})`);
    // RIFF....WEBP container.
    assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(buf.subarray(8, 12).toString("ascii"), "WEBP");
  }
  // No orphan thumbs (a stale thumb would be served forever under the public cache rule).
  const onDisk = fs
    .readdirSync(thumbsDir)
    .filter((f) => f.endsWith(`.${SAMPLE_THUMB_EXT}`))
    .map((f) => f.replace(/\.[a-z]+$/, ""))
    .sort();
  assert.deepEqual(onDisk, fixtures, "public/samples/thumbs must contain exactly the fixture thumbs");
});

// =====================================================================================
// (4) 640 px screenshot variants
// =====================================================================================
test("assets: every public/screenshots/*.webp has a -640 sibling", () => {
  const dir = path.join(APP, "public", "screenshots");
  const originals = fs.readdirSync(dir).filter((f) => /\.webp$/i.test(f) && !/-640\.webp$/i.test(f));
  assert.ok(originals.length >= 2, "expect the two product screenshots to exist");
  for (const f of originals) {
    const sibling = path.join(dir, f.replace(/\.webp$/i, "-640.webp"));
    assert.ok(fs.existsSync(sibling), `missing 640px variant for ${f}`);
    const orig = fs.statSync(path.join(dir, f)).size;
    const small = fs.statSync(sibling).size;
    assert.ok(small > 0 && small < orig, `${f}: the -640 variant must be smaller than the original`);
    const buf = fs.readFileSync(sibling);
    assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(buf.subarray(8, 12).toString("ascii"), "WEBP");
  }
});
