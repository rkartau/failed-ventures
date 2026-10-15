// Impersonation guard-in-spirit (plan §7a / F7) + audit-funnel required-stamp guard
// (tester hardening item 2). Static, no server, no deps.
//
// The static isolation guard (tests/isolation-static.mjs) is BLIND to the resolver
// preamble and the audit funnel (both live under lib/, which it never scans). This
// test PINS three things so a future edit cannot silently regress them:
//
//   (A) The audit funnel (appendAuditRaw / appendAudit / transact in lib/db.ts) MUST
//       keep a REQUIRED `onBehalf: AuditOnBehalf` parameter (no `?`, no default). This
//       is what makes under-attribution impossible-by-construction: a NEW writer added
//       later will not compile without passing the stamp/sentinel. And every file that
//       CALLS the funnel must also name a stamp token, so no call omits the arg.
//   (B) §7a(a): the scope-widening primitive `impersonatorAdminEmail` (the marker of a
//       resolver RETURNING a target tenant identity) appears in ONLY the two resolvers
//       and lib/impersonation.ts. Any other file returning a target identity → FAIL.
//   (C) §7a(b): BOTH resolvers gate on `ADMIN_EMAILS.has(...)` textually BEFORE any
//       call to resolveImpersonation — the fail-closed admin re-check per request.
//
// Run: node tests/impersonation-guard.mjs   (exit 0 = pass, 1 = fail)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, ".."); // .../app
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");

const failures = [];
const fail = (m) => failures.push(m);

// ---------------------------------------------------------------------------
// (A) Funnel required-stamp signature + call-site coverage.
// ---------------------------------------------------------------------------
const dbSrc = read("lib/db.ts");

/** Extract a `function NAME<...>(...params...)` signature (params to the closing `)`
 *  that precedes the return type). Returns the param-list text or null. */
function paramsOf(src, name) {
  const at = src.indexOf(`function ${name}`);
  if (at < 0) return null;
  // Find the first "(" after the name, then match to its balanced ")".
  const open = src.indexOf("(", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

for (const fn of ["appendAuditRaw", "appendAudit", "transact"]) {
  const params = paramsOf(dbSrc, fn);
  if (!params) {
    fail(`lib/db.ts: could not locate the ${fn}(...) signature.`);
    continue;
  }
  if (!/\bonBehalf:\s*AuditOnBehalf\b/.test(params)) {
    fail(`lib/db.ts: ${fn}() must declare a REQUIRED \`onBehalf: AuditOnBehalf\` param.`);
  }
  if (/\bonBehalf\?\s*:/.test(params)) {
    fail(`lib/db.ts: ${fn}() onBehalf must NOT be optional (\`?\`) — it must be required.`);
  }
  if (/\bonBehalf:\s*AuditOnBehalf\s*=/.test(params)) {
    fail(`lib/db.ts: ${fn}() onBehalf must NOT have a default value — it must be passed explicitly.`);
  }
}

// Every source file that CALLS the funnel must also name a stamp token, so a call
// cannot omit the required arg. (tsc enforces at compile time; this pins it statically.)
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const CALL_RE = /\b(appendAudit|appendAuditRaw|transact)\s*\(/;
const STAMP_RE = /\bonBehalf\b|\bAUDIT_NO_IMPERSONATION\b|impersonationStampFor/;
for (const f of [...walk(path.join(APP, "app")), ...walk(path.join(APP, "lib"))]) {
  const src = fs.readFileSync(f, "utf8");
  if (CALL_RE.test(src) && !STAMP_RE.test(src)) {
    fail(
      `${path.relative(APP, f).replace(/\\/g, "/")} calls the audit funnel but names NO ` +
        `stamp token (onBehalf / AUDIT_NO_IMPERSONATION) — a call may be omitting the required arg.`
    );
  }
}

// ---------------------------------------------------------------------------
// (B) §7a(a) — scope-widening primitive is confined to the two resolvers + the store.
// ---------------------------------------------------------------------------
const SCOPE_MARKER = "impersonatorAdminEmail";
const ALLOWED = new Set([
  "lib/seaman-session.ts",
  "lib/agent-session.ts",
  "lib/impersonation.ts",
]);
const holders = [];
for (const f of [...walk(path.join(APP, "app")), ...walk(path.join(APP, "lib"))]) {
  const src = fs.readFileSync(f, "utf8");
  if (src.includes(SCOPE_MARKER)) holders.push(path.relative(APP, f).replace(/\\/g, "/"));
}
for (const h of holders) {
  if (!ALLOWED.has(h)) {
    fail(
      `${h} references the scope-widening marker "${SCOPE_MARKER}" — only the two resolvers ` +
        `and lib/impersonation.ts may return/build a target tenant identity.`
    );
  }
}
for (const a of ALLOWED) {
  if (!holders.includes(a)) {
    fail(`${a} was expected to reference "${SCOPE_MARKER}" (moved/renamed?).`);
  }
}

// ---------------------------------------------------------------------------
// (C) §7a(b) — both resolvers re-check ADMIN_EMAILS BEFORE resolveImpersonation.
// ---------------------------------------------------------------------------
for (const rel of ["lib/seaman-session.ts", "lib/agent-session.ts"]) {
  const src = read(rel);
  const gateAt = src.indexOf("ADMIN_EMAILS.has(");
  const resolveAt = src.indexOf("resolveImpersonation(");
  if (gateAt < 0) {
    fail(`${rel}: missing the ADMIN_EMAILS.has(...) per-request re-check.`);
  } else if (resolveAt < 0) {
    fail(`${rel}: missing resolveImpersonation(...) call.`);
  } else if (gateAt > resolveAt) {
    fail(`${rel}: ADMIN_EMAILS.has(...) must appear BEFORE resolveImpersonation(...) (fail-closed order).`);
  }
}

// ---- Report ----
if (failures.length) {
  console.error(`FAIL — ${failures.length} impersonation-guard problem(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("PASS — audit funnel requires the stamp, scope-widening is confined, and both");
console.log("       resolvers re-gate on ADMIN_EMAILS before honouring any impersonation.");
