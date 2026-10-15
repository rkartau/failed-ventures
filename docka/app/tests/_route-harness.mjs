// tests/_route-harness.mjs — the in-memory route harness, EXTRACTED from
// tests/batch2-routes.test.mjs (fix-plan FR1-10d: reuse-first, never a second copy).
//
// It loads REAL App Router route handlers and REAL libs, transpiled in memory with the
// TypeScript compiler and evaluated in this process — no server, no build, no disk.
// Only the un-testable edges are stubbed (next/server, next/headers, @/lib/db,
// @/lib/agent-session, @/auth, @/lib/notify, …); everything security-critical runs the
// ACTUAL shipped code, which is the entire point: a guard that is only asserted by
// grepping the source is not a guard, it is a hope.
//
// Two consumers today: tests/batch2-routes.test.mjs (appraisals/contract/invite/
// seafarers) and tests/billing-routes.test.mjs (the executed billing 402/200 pins).

import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP = path.resolve(__dirname, "..");
export const LIB = path.join(APP, "lib");
export const API = path.join(APP, "app", "api");
export const COMPONENTS = path.join(APP, "components");
export const APP_DIR = path.join(APP, "app");

/** The minimal NextResponse the handlers use: `{ status, body }`, plus `new`. */
export class NextResponse {
  constructor(body, init) {
    this.body = body;
    this.status = (init && init.status) || 200;
    this.headers = (init && init.headers) || {};
  }
  /**
   * Shape-compatible with the old inline stub (`{ status, body }`, which every
   * batch2 assertion reads directly) AND an `instanceof Response`, which the real
   * NextResponse also is. Several handlers branch on `x instanceof Response` to tell
   * "a denial to return verbatim" from "an authorised actor" — with a plain object
   * those branches silently fell through and the harness answered 200 for a request
   * the real app refuses. The prototype is borrowed rather than constructed so the
   * plain `.body` (an object, or a raw HTML string) survives untouched.
   */
  static json(body, init) {
    const status = (init && init.status) || 200;
    const res = Object.create(Response.prototype);
    Object.defineProperties(res, {
      status: { value: status, enumerable: true },
      body: { value: body, enumerable: true },
      headers: { value: (init && init.headers) || {}, enumerable: true },
      ok: { value: status < 400, enumerable: true },
    });
    return res;
  }
}

const nextServerStub = { NextRequest: class {}, NextResponse };
const nextHeadersStub = {
  cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
};

/**
 * The automatic JSX runtime, so a server COMPONENT (.tsx) can be invoked and its
 * returned element inspected structurally — `{ type, props }` — without React.
 */
export const JSX_FRAGMENT = Symbol("Fragment");
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: JSX_FRAGMENT,
};

/**
 * Build a loader. `stubs` maps a module specifier to the object the module under test
 * should receive for it; anything not stubbed is resolved for real (`@/lib/*`,
 * `@/components/*`, relative paths, node_modules).
 */
export function createRouteHarness({ stubs = {} } = {}) {
  const cache = new Map();

  function loadTs(absPath) {
    // Directory-module resolution ("@/lib/registry" -> lib/registry/index.ts).
    if (!fs.existsSync(absPath)) {
      const idx = absPath.replace(/\.tsx?$/, path.sep + "index.ts");
      if (fs.existsSync(idx)) absPath = idx;
      else if (fs.existsSync(absPath + "x")) absPath = absPath + "x"; // .ts -> .tsx
    }
    if (cache.has(absPath)) return cache.get(absPath);
    const source = fs.readFileSync(absPath, "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: absPath,
    }).outputText;

    const localRequire = (spec) => {
      if (Object.prototype.hasOwnProperty.call(stubs, spec)) return stubs[spec];
      if (spec === "next/server") return nextServerStub;
      if (spec === "next/headers") return nextHeadersStub;
      if (spec === "react/jsx-runtime" || spec === "react/jsx-dev-runtime") return jsxRuntimeStub;
      if (spec.startsWith("@/lib/")) return loadTs(path.join(LIB, spec.slice(6) + ".ts"));
      if (spec.startsWith("@/components/")) return loadTs(path.join(COMPONENTS, spec.slice(13) + ".tsx"));
      if (spec.startsWith(".")) {
        const p = path.resolve(path.dirname(absPath), spec);
        return loadTs(/\.tsx?$/.test(p) ? p : p + ".ts");
      }
      return require(spec);
    };

    const moduleObj = { exports: {} };
    // Pre-register BEFORE evaluating (Node CJS circular-import semantics): a cycle gets
    // the partially-populated exports object instead of recursing forever.
    cache.set(absPath, moduleObj.exports);
    const fn = vm.compileFunction(js, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: absPath,
    });
    fn(moduleObj.exports, localRequire, moduleObj, absPath, path.dirname(absPath));
    cache.set(absPath, moduleObj.exports);
    return moduleObj.exports;
  }

  return { loadTs, APP, LIB, API, APP_DIR, COMPONENTS, NextResponse };
}
