// Registers the `@/*` alias resolve hook (test-only). Pass via `node --import`.
import { register } from "node:module";
register("./_ts-alias-hooks.mjs", import.meta.url);
