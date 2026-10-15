// Resolve hooks for tests/ga4-dom.test.mjs, registered AFTER _tsx-hooks.mjs (so they
// run FIRST): next/navigation → the mutable-pathname stub, next/script → the LoadCache
// stub. Everything else (TSX transpile, next/link) falls through to _tsx-hooks.mjs.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_NAVIGATION = pathToFileURL(path.join(HERE, "_stub-ga4-navigation.mjs")).href;
const STUB_SCRIPT = pathToFileURL(path.join(HERE, "_stub-ga4-script.mjs")).href;

export async function resolve(specifier, context, next) {
  if (specifier === "next/navigation") return { url: STUB_NAVIGATION, shortCircuit: true };
  if (specifier === "next/script") return { url: STUB_SCRIPT, shortCircuit: true };
  return next(specifier, context);
}
