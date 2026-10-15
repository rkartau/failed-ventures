// TSX loader hooks for the renderToString smoke tests (test-only — never
// imported by the app). Node's native type stripping handles .ts but NOT .tsx,
// so components are transpiled on the fly with the repo's own `typescript`
// devDependency. Registered AT RUNTIME by the test file (module.register), on
// top of the `--import ./tests/_register-alias.mjs` alias hooks.
//
//   - load():   *.tsx (and *.ts) → ts.transpileModule (ESNext modules, automatic
//               JSX runtime → react/jsx-runtime, which react properly exports).
//               *.ts is included because Node's native type-stripping (used for
//               plain .ts elsewhere in the suite) rejects some TS syntax it
//               doesn't support (e.g. constructor parameter properties, seen
//               transitively via lib/qr.ts when rendering a component tree) —
//               the full compiler handles it.
//   - resolve(): "next/link" → a minimal <a> stub (tests/_stub-next-link.mjs).
//               Plain-node ESM cannot resolve the extensionless subpath (next
//               14 ships no package.json `exports` map), and the real Link
//               brings app-router context requirements a bare renderToString
//               cannot satisfy. The smoke assertions never depend on Link
//               internals — only on the surrounding markup.
//               "next/navigation" → a no-op useRouter/usePathname stub
//               (tests/_stub-next-navigation.mjs). The REAL next/navigation
//               (resolved for other suites by _ts-alias-hooks.mjs's
//               NEXT_SUBPATHS map) throws when useRouter() is called outside a
//               mounted app router — ReviewPanel calls it unconditionally at
//               the top of the component, so a bare renderToString needs the
//               stub. Registered here (at runtime, per test file) so it takes
//               priority over the CLI-level real-module mapping.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_LINK = pathToFileURL(path.join(HERE, "_stub-next-link.mjs")).href;
const STUB_NAVIGATION = pathToFileURL(path.join(HERE, "_stub-next-navigation.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "next/link") {
    return { url: STUB_LINK, shortCircuit: true };
  }
  if (specifier === "next/navigation") {
    return { url: STUB_NAVIGATION, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
    const source = readFileSync(fileURLToPath(url), "utf-8");
    const out = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}
