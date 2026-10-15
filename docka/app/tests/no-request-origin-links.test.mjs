// REGRESSION GUARD — kill the "localhost-in-prod" link class of bug for good.
//
// WHY: behind the docka.me reverse proxy, `next start` sees the request origin as
// https://localhost:3000. Any externally-shared link (emailed upload cards, doc-request
// links, redirect Location headers) built from the REQUEST origin therefore leaks a
// localhost URL the recipient's browser cannot follow. The ONLY sanctioned way to build
// such a link is getPublicBaseUrl(req) (lib/base-url.ts: AUTH_URL -> x-forwarded-host ->
// request origin). This test scans every API route handler + the middleware and FAILS if
// any of them derives an origin from `.nextUrl.origin` or `new URL(req.url)` — forcing all
// future link-building through getPublicBaseUrl.
//
// Run: node --import ./tests/_register-alias.mjs tests/no-request-origin-links.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");          // app/ project root
const API = path.join(APP, "app", "api");           // route handlers
const MIDDLEWARE = path.join(APP, "middleware.ts");

// Files that are ALLOWED to reference the raw request origin. base-url.ts is the
// sanctioned fallback itself (step 3 of getPublicBaseUrl), so it legitimately reads
// req.nextUrl.origin — everyone else must go through it. Matched by path suffix.
const ALLOWLIST = [path.join("lib", "base-url.ts")];
const isAllowlisted = (file) => ALLOWLIST.some((suffix) => file.endsWith(suffix));

// Offending patterns (global, so we can report every hit with a line number):
//  1. `.nextUrl.origin`         — the request origin (localhost behind the proxy).
//  2. `new URL(req.url)` used to derive an origin. A bare/origin/host use is flagged;
//     `new URL(req.url).searchParams...` (reading a query param, NOT building a link)
//     is explicitly permitted via the negative lookahead — it never yields a host.
const PATTERNS = [
  { name: "nextUrl.origin", re: /\.nextUrl\.origin/g },
  { name: "new URL(req.url) origin", re: /new URL\(\s*req(?:uest)?\.url\s*\)(?!\s*\.searchParams)/g },
];

// Recursively collect every route.ts under app/api, plus the middleware.
function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const files = [...collectFiles(API), MIDDLEWARE];
assert.ok(files.length > 5, `sanity: expected to scan several route files, got ${files.length}`);

// Strip comments before scanning so PROSE that mentions a pattern (e.g. a comment
// explaining WHY req.nextUrl.origin is banned) does not trip the guard — only live
// CODE counts. Commented-out code is likewise not a live bug. We blank comments with
// same-length space runs (newlines preserved) so reported line numbers stay accurate.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // block comments
    .replace(/([^:])\/\/[^\n]*/g, (_m, p1) => p1 + " ".repeat(_m.length - 1)); // line comments (":" guard spares https://)
}

const offenders = [];
for (const file of files) {
  if (isAllowlisted(file)) continue;
  const src = stripComments(fs.readFileSync(file, "utf8"));
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${path.relative(APP, file)}:${line}  [${name}]  ${m[0]}`);
    }
  }
}

if (offenders.length) {
  console.error(
    `\nFORBIDDEN request-origin link usage — build these via getPublicBaseUrl(req) instead:\n` +
      offenders.map((o) => "  - " + o).join("\n") +
      `\n`
  );
  assert.fail(`${offenders.length} request-origin link usage(s) found (see above)`);
}

console.log(`no-request-origin-links.test.mjs — scanned ${files.length} files, 0 offenders — all links go through getPublicBaseUrl`);
