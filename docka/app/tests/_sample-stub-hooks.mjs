// Public Sample Profiles test harness — ESM resolve hook that redirects the two
// request-scope-only modules to plain-node stubs so the REAL route handlers can be
// driven directly (the account-mgmt / password-auth-routes precedent, but for the
// token-authorised routes, whose only untestable edges are `next/headers` and
// `@/auth`):
//   - "next/headers" -> tests/_stubs/next-headers-stub.mjs (cookies()/headers()
//     backed by globalThis.__TEST_COOKIES so a test can mint a dev agent/seaman
//     session or stay anonymous);
//   - "@/auth"       -> tests/_stubs/auth-stub.mjs (auth() returns
//     globalThis.__TEST_AUTH ?? null).
// Everything else falls through to the standard @/* alias hook registered before
// this one. Test-only — never imported by the app.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function resolve(specifier, context, next) {
  if (specifier === "next/headers") {
    return {
      url: pathToFileURL(path.join(HERE, "_stubs", "next-headers-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  if (specifier === "@/auth") {
    return {
      url: pathToFileURL(path.join(HERE, "_stubs", "auth-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
