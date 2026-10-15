// Registers the @/* alias hook AND the sample-test stub hook (next/headers, @/auth).
// Registration order matters: the LAST registered hook runs FIRST, so the stub hook
// intercepts its two specifiers and defers everything else to the alias hook.
// Pass via `node --import ./tests/_register-sample.mjs`.
import { register } from "node:module";
register("./_ts-alias-hooks.mjs", import.meta.url);
register("./_sample-stub-hooks.mjs", import.meta.url);
