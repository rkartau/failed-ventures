// Minimal ESM resolve hook so `node` can run the app's TypeScript sources directly
// in a test: it rewrites the `@/*` path alias (see tsconfig.json paths) to real
// file URLs under the app root. Node 24 strips the types natively; this only fixes
// specifier resolution. Test-only — never imported by the app.
import { statSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function tryCandidates(base) {
  // A bare directory match (e.g. `@/lib/registry`) must resolve to its
  // index.ts, never the directory itself — hence the isFile check.
  const candidates = [base, base + ".ts", base + ".tsx", path.join(base, "index.ts")];
  for (const cand of candidates) {
    if (isFile(cand)) {
      return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
  }
  return null;
}

// Bare extensionless `next/*` subpaths: next 14 ships NO package.json `exports`
// map, so plain-node ESM cannot resolve e.g. "next/server" — which next-auth
// (lib/env.js) and the app's API routes import. Inside Next's bundler this is
// fine; for tests we map the handful of used subpaths to their real .js files.
const NEXT_SUBPATHS = new Map([
  ["next/server", "node_modules/next/server.js"],
  ["next/headers", "node_modules/next/headers.js"],
  ["next/navigation", "node_modules/next/navigation.js"],
]);

export async function resolve(specifier, context, next) {
  const nextSub = NEXT_SUBPATHS.get(specifier);
  if (nextSub) {
    const p = path.join(APP_ROOT, nextSub);
    // realpath: when the suite runs from a git WORKTREE whose node_modules is
    // a junction/symlink into the main checkout, the un-resolved URL makes the
    // ESM CJS-interop wire named exports to a second module instance (every
    // `NextResponse` import comes back undefined). Resolving to the real path
    // is a no-op in the main checkout and fixes worktree runs.
    if (isFile(p)) return { url: pathToFileURL(realpathSync(p)).href, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const hit = tryCandidates(path.join(APP_ROOT, specifier.slice(2)));
    if (hit) return hit;
  }
  // Relative EXTENSIONLESS TypeScript imports (e.g. `../index` inside
  // lib/registry/adapters) — tsc resolves these, plain node ESM does not.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !path.extname(specifier) &&
    context.parentURL?.startsWith("file:")
  ) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    const hit = tryCandidates(base);
    if (hit) return hit;
  }
  return next(specifier, context);
}
