// ROUTER-DRIVEN static isolation guard (no server, no deps).
//
// Scans EVERY route module under app/api and EVERY page under app/agent and fails
// if an agent-facing module reads/writes tenant data without going through the
// fail-closed accessor / grant guard. The point is durability: a FUTURE new agent
// route that forgets the grant check breaks this test, not just the ones fixed today.
//
// "Agent-facing" = the module resolves the acting agent via `agentSession` (the only
// way to get a tenant identity). Such a module MUST also reference at least one
// guard symbol from the fail-closed layer (lib/access, lib/agentData) or the
// agent-partitioned config store (lib/required-docs-store, every fn keyed by agentId).
// A module with a genuine reason to be agent-gated yet touch no tenant data may opt
// out with an explicit `// isolation-guard: exempt` marker (visible in review).
//
// Run: node tests/isolation-static.mjs   (exit 0 = pass, 1 = fail)

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  BILLING_STORE_SYMBOLS,
  GUARD_SYMBOLS,
  RAW_STORE_SYMBOLS,
  classifyAgentModule,
  hasWord,
} from "./_isolation-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, ".."); // .../app
const API_DIR = path.join(APP_DIR, "app", "api");
const AGENT_DIR = path.join(APP_DIR, "app", "agent");
const ADMIN_DIR = path.join(APP_DIR, "app", "admin");

// D-C / FINDING 9 — the guard symbols and the two rules now live in
// tests/_isolation-rules.mjs so the CLASSIFIER ITSELF is unit-testable against fixture
// strings (tests/billing-routes.test.mjs pins the finding-9 attack shape). GUARD_SYMBOLS
// is back to tenant-data accessors ONLY; the billing-store symbols have their own,
// stricter rule.

// SEAMAN-scoped routes (the seaman self-owns exactly one profile). A module that
// resolves the acting SEAMAN via `seamanSession` (the ONLY seaman identity gate)
// MUST (a) scope every read/write to the SESSION's own `seafarerId` and (b) NOT also
// resolve an agent via `agentSession` — a seaman session must never gain agent scope.
// This is the seaman-side mirror of the agent guard above.
const SEAMAN_GATE = "seamanSession";
// Whole-word markers that prove the module scopes to the session's OWN seafarer.
const SEAMAN_SCOPE_SYMBOLS = ["seafarerId"];

// Seaman-scoped routes that must stay session-scoped forever (positive lock).
const MUST_BE_SEAMAN_SCOPED = [
  "api/seafarers/me/route.ts",
  // "My applications" flows for the signed-in seaman. Resolves the acting seaman via
  // seamanSession and scopes strictly to that seafarerId — never an agent.
  "api/seafarer/flows/route.ts",
  // In-app inbox (read side). Each resolves the acting seaman via seamanSession (with a
  // read-only OPEN-token fallback) and scopes strictly to that seafarerId — never an
  // agent.
  "api/inbox/route.ts",
  "api/inbox/seen/route.ts",
  "api/inbox/unread/route.ts",
  // In-app inbox WRITE (reply). Authenticated seamanSession ONLY (D1) — see the
  // dedicated token-resolver hard-fail below.
  "api/inbox/reply/route.ts",
];

// D1 HARD FAIL: the reply WRITE route must be authenticated-session ONLY. A token
// resolver anywhere in it would re-open the token-holder-impersonation path the plan
// forbids, so referencing it is a build-breaking error (not merely a warning). Keyed by
// route fragment → the symbol(s) that must NOT appear.
const MUST_NOT_REFERENCE = [
  { frag: "api/inbox/reply/route.ts", symbols: ["resolveOpenTokenSeafarerId", "shareToken"] },
];

// Routes that MUST stay grant-scoped forever (positive regression lock). Keyed by a
// path fragment; each must reference a guard symbol. Removing a guard here fails even
// if the agent-facing heuristic were ever weakened.
const MUST_BE_SCOPED = [
  "api/reminders/route.ts",
  "api/review/route.ts",
  "api/seafarers/route.ts",
  "api/rest-hours/route.ts",
  "api/files/[name]/route.ts",
  "api/profile-photo/[id]/route.ts",
  "api/comments/route.ts",
  "api/documents/route.ts",
  "api/export/route.ts",
  // Agent-side view of replies to the agent's own circulars (own-tenant filter on the
  // denormalised reply.agentId; references readableSeafarerIds as the guard symbol).
  "api/circulars/replies/route.ts",
  // NOTE: the agent PAGES moved into the app/agent/(enforced) route group (billing
  // plan P5 / R2-10b). Route groups do not change URLs — /agent, /agent/[id] and
  // /agent/inspection are byte-identical — so these fragments are re-pointed at the
  // moved files, NOT relaxed.
  "agent/(enforced)/page.tsx",
  "agent/(enforced)/[id]/page.tsx",
  "agent/(enforced)/inspection/page.tsx",
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// ADMIN-API positive lock (mirror of the app/admin inverted rule below): every
// route.ts/route.tsx under app/api/admin/** MUST resolve the acting admin via
// the whole word `adminSession` — OR carry an explicit `// admin-guard: exempt`
// marker — and must NOT resolve `agentSession`/`seamanSession`. Exported as a
// PURE function (files = [{path, src}]) so the outreach test suite can
// meta-test it without running the whole scan; the main flow below calls it
// over the real tree.
export function checkAdminApiRoutes(files) {
  const failures = [];
  for (const { path: p, src } of files) {
    const r = String(p).replace(/\\/g, "/");
    if (!/(^|\/)route\.tsx?$/.test(r)) continue;
    if (!/(^|\/)api\/admin\//.test(r)) continue;
    const adminExempt = /admin-guard:\s*exempt/.test(src);
    if (!hasWord(src, "adminSession") && !adminExempt) {
      failures.push(
        `${r} is an admin API route but references NO admin gate (adminSession) ` +
          `and has no "admin-guard: exempt" marker.`
      );
    }
    for (const foreign of ["agentSession", "seamanSession"]) {
      if (hasWord(src, foreign)) {
        failures.push(
          `${r} is under api/admin but resolves "${foreign}" — an admin surface must ` +
            `never gain agent/seaman tenant scope.`
        );
      }
    }
  }
  return failures;
}

function main() {
const files = [...walk(API_DIR), ...walk(AGENT_DIR)].sort();
const rel = (p) => path.relative(path.join(APP_DIR, "app"), p).replace(/\\/g, "/");

const rows = [];
const failures = [];

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const r = rel(file);

  // Agent identity gate. `agentSession` is the camelCase call; the module PATH
  // "agent-session" is hyphenated so it does NOT match \bagentSession\b.
  const agentFacing = hasWord(src, "agentSession");
  const exempt = /isolation-guard:\s*exempt/.test(src);
  const guarded = GUARD_SYMBOLS.some((g) => hasWord(src, g));
  const verdict = agentFacing ? classifyAgentModule(src) : null;

  // Seaman-facing = the module resolves the acting seaman via `seamanSession`.
  const seamanFacing = hasWord(src, SEAMAN_GATE);
  const seamanScoped = SEAMAN_SCOPE_SYMBOLS.some((s) => hasWord(src, s));

  let status;
  if (agentFacing && seamanFacing) {
    // A module must not resolve BOTH roles — that is exactly the conflation the
    // task forbids (a seaman session gaining agent scope).
    status = "ROLE CONFLATION";
    failures.push(
      `${r} resolves BOTH a seaman (seamanSession) and an agent (agentSession) — ` +
        `a seaman session must never gain agent scope.`
    );
  } else if (agentFacing) {
    status = verdict;
    if (verdict === "UNGUARDED LEAK") {
      failures.push(
        `${r} resolves an agent (agentSession) but references NO fail-closed guard ` +
          `symbol, is not billing-scoped (a per-agent billing accessor AND no ` +
          `${RAW_STORE_SYMBOLS.join("/")}), and has no "isolation-guard: exempt" marker.`
      );
    }
  } else if (seamanFacing) {
    if (seamanScoped || exempt) status = "SEAMAN-SCOPED";
    else {
      status = "UNSCOPED SEAMAN LEAK";
      failures.push(
        `${r} resolves a seaman (seamanSession) but does not scope reads to the ` +
          `session's own seafarerId and has no "isolation-guard: exempt" marker.`
      );
    }
  } else {
    status = "n/a (not agent-facing)";
  }
  rows.push({ route: r, agentFacing, guarded, exempt, status });
}

// Positive lock: each seaman-scoped route must exist, use the seaman gate, scope to
// the session's own seafarerId, and NOT resolve an agent.
for (const frag of MUST_BE_SEAMAN_SCOPED) {
  const match = files.find((f) => f.replace(/\\/g, "/").endsWith(frag));
  if (!match) {
    failures.push(`Expected seaman-scoped route "${frag}" not found (moved/renamed?).`);
    continue;
  }
  const src = fs.readFileSync(match, "utf8");
  if (!hasWord(src, SEAMAN_GATE)) {
    failures.push(`Seaman-scoped route "${frag}" no longer resolves the seaman via ${SEAMAN_GATE}.`);
  }
  if (!SEAMAN_SCOPE_SYMBOLS.some((s) => hasWord(src, s))) {
    failures.push(`Seaman-scoped route "${frag}" no longer scopes to the session's own seafarerId.`);
  }
  if (hasWord(src, "agentSession")) {
    failures.push(`Seaman-scoped route "${frag}" must NOT resolve an agent (agentSession).`);
  }
}

// Positive regression lock: each sensitive route must exist and be guarded.
for (const frag of MUST_BE_SCOPED) {
  const match = files.find((f) => f.replace(/\\/g, "/").endsWith(frag));
  if (!match) {
    failures.push(`Expected sensitive route "${frag}" not found (moved/renamed?).`);
    continue;
  }
  const src = fs.readFileSync(match, "utf8");
  if (!GUARD_SYMBOLS.some((g) => hasWord(src, g))) {
    failures.push(`Sensitive route "${frag}" no longer references any fail-closed guard symbol.`);
  }
}

// BILLING-SCOPED positive lock (D-C / FR1-5). These four modules are the reason the
// billing symbols exist as a rule at all, so each must KEEP qualifying: a per-agent
// billing accessor and NO raw store. If one ever needs `readDB`, that is a design change
// to argue for in review, not something to slip past by re-merging the two lists.
const MUST_BE_BILLING_SCOPED = [
  "api/billing/profile/route.ts",
  "api/billing/checkout/route.ts",
  "api/billing/portal/route.ts",
  "agent/settings/billing/page.tsx",
];

for (const frag of MUST_BE_BILLING_SCOPED) {
  const match = files.find((f) => f.replace(/\\/g, "/").endsWith(frag));
  if (!match) {
    failures.push(`Expected billing-scoped module "${frag}" not found (moved/renamed?).`);
    continue;
  }
  const src = fs.readFileSync(match, "utf8");
  if (!BILLING_STORE_SYMBOLS.some((g) => hasWord(src, g))) {
    failures.push(`Billing module "${frag}" no longer references any per-agent billing accessor.`);
  }
  for (const raw of RAW_STORE_SYMBOLS) {
    if (hasWord(src, raw)) {
      failures.push(
        `Billing module "${frag}" references the RAW store symbol "${raw}". A billing ` +
          `surface must reach its own profile/usage rows through lib/billing-store only — ` +
          `"billing symbol + raw store" is the exact shape finding 9 let through.`
      );
    }
  }
}

// D1 negative lock: a token-authorised WRITE is a hard fail. The reply route must
// resolve identity from the seaman SESSION only — never a share-token resolver.
for (const { frag, symbols } of MUST_NOT_REFERENCE) {
  const match = files.find((f) => f.replace(/\\/g, "/").endsWith(frag));
  if (!match) {
    failures.push(`Expected auth-only route "${frag}" not found (moved/renamed?).`);
    continue;
  }
  const src = fs.readFileSync(match, "utf8");
  for (const sym of symbols) {
    if (hasWord(src, sym)) {
      failures.push(
        `Auth-only route "${frag}" references forbidden token-resolver "${sym}" — a ` +
          `token-authorised write re-opens the impersonation path (D1). Session ONLY.`
      );
    }
  }
}

// ADMIN positive-lock (INVERTED rule): every routable module under app/admin/**
// (page.tsx, layout.tsx, route.ts/route.tsx) MUST resolve the acting admin via the
// whole word `adminSession` — OR carry an explicit `// admin-guard: exempt` marker.
// This turns "forgot the admin gate" into a build failure. NOTE: `admin-guard: exempt`
// is a DELIBERATE, greppable bypass — every occurrence must be scrutinised in review.
// Regression: no admin module may resolve `agentSession` or `seamanSession` (an admin
// surface must never pick up agent/seaman tenant scope). app/admin may not exist yet;
// walk() no-ops on a missing dir, so this stays exit-0 until admin pages land.
const ADMIN_GATE = "adminSession";
for (const file of walk(ADMIN_DIR)) {
  if (!/(^|[\\/])(page\.tsx|layout\.tsx|route\.tsx?)$/.test(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  const r = rel(file);
  const adminExempt = /admin-guard:\s*exempt/.test(src);
  if (!hasWord(src, ADMIN_GATE) && !adminExempt) {
    failures.push(
      `${r} is a routable admin module but references NO admin gate (${ADMIN_GATE}) ` +
        `and has no "admin-guard: exempt" marker.`
    );
  }
  for (const foreign of ["agentSession", SEAMAN_GATE]) {
    if (hasWord(src, foreign)) {
      failures.push(
        `${r} is under app/admin but resolves "${foreign}" — an admin surface must ` +
          `never gain agent/seaman tenant scope.`
      );
    }
  }
}

// ============================================================================
// BILLING ENFORCEMENT WALL (STRIPE-BILLING-PLAN.md P5 / R1-8 / R2-9)
// ============================================================================
//
// The paywall must hold for RAW API calls, not just for pages, and it must keep
// holding for routes written a year from now. Two rules make "forgot the billing
// guard" a BUILD FAILURE rather than a review hope:
//
//   (1) Every agent-facing API route module (it resolves `agentSession`) must
//       reference one of the two guards — GET/HEAD go through requireBillingReadable,
//       mutating verbs through requireBillingWritable (which implies readable) — OR
//       carry an explicit, greppable marker:
//         `// billing-guard: exempt`         the route must answer at EVERY tier
//                                            (the billing surface itself, auth, cron,
//                                            the Stripe webhook, public endpoints);
//         `// billing-guard: session-branch` a DUAL trust-model route (R2-9) that
//                                            serves both agent sessions and
//                                            possession-token viewers: the guard binds
//                                            to the agent-session branch ONLY, because
//                                            a blocked agency's seafarers must never
//                                            lose share/portal access.
//
//   (2) Every agent PAGE must live inside the app/agent/(enforced) route group, whose
//       layout renders the banner/paywall. The billing page is the single deliberate
//       exception — a blocked agency has to be able to reach the screen that lets it
//       pay. A new page added outside the group would silently escape the paywall, so
//       that is a failure too.
//
// Written to COEXIST with the sample-profiles plan's §D6 rules: both extend this file
// additively at the end, and neither reads the other's markers.

const BILLING_GUARD_SYMBOLS = ["requireBillingReadable", "requireBillingWritable"];
const BILLING_EXEMPT_RE = /billing-guard:\s*(exempt|session-branch)/;

// Agent pages allowed to live OUTSIDE app/agent/(enforced) — each one must be
// reachable at the `blocked` tier by design. Keep this list at exactly one entry
// unless there is a written decision to add another.
const BILLING_PAGE_OUTSIDE_GROUP_ALLOWED = [
  "agent/settings/billing/page.tsx",
  // WRITTEN DECISION (billing×password-signup reconcile, 2026-08-20): the credential
  // account page (change password / regenerate recovery codes) must be reachable at
  // EVERY tier — an agency that is past-due must still be able to secure its own login,
  // and this page is `isolation-guard: exempt` (it reads no tenant data, only the acting
  // session's own identity). Paywalling account security would be user-hostile and a
  // security anti-pattern, so it sits outside (enforced) exactly like the billing page.
  "agent/settings/account/page.tsx",
];

for (const file of walk(API_DIR)) {
  if (!/route\.tsx?$/.test(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  const r = rel(file);
  if (!hasWord(src, "agentSession")) continue;
  const billingGuarded = BILLING_GUARD_SYMBOLS.some((g) => hasWord(src, g));
  if (billingGuarded || BILLING_EXEMPT_RE.test(src)) continue;
  failures.push(
    `${r} resolves an agent (agentSession) but references NO billing guard ` +
      `(${BILLING_GUARD_SYMBOLS.join(" / ")}) and carries neither ` +
      `"billing-guard: exempt" nor "billing-guard: session-branch".`
  );
}

for (const file of walk(AGENT_DIR)) {
  if (!/(^|[\\/])page\.tsx$/.test(file)) continue;
  const r = rel(file);
  if (r.includes("agent/(enforced)/")) continue;
  if (BILLING_PAGE_OUTSIDE_GROUP_ALLOWED.some((f) => r.endsWith(f))) continue;
  failures.push(
    `${r} is an agent page OUTSIDE the app/agent/(enforced) route group, so the ` +
      `billing banner/paywall layout never wraps it. Move it into the group (route ` +
      `groups do not change URLs) or add it to BILLING_PAGE_OUTSIDE_GROUP_ALLOWED ` +
      `with a written reason.`
  );
}

// Positive lock: the enforcement seam itself must exist and must actually render the
// paywall. Deleting or gutting it would silently disable page-side enforcement.
//
// D-A / FINDING 6 — it must be a TEMPLATE, not a layout. App Router preserves layouts
// across <Link> navigations, so a gate in `layout.tsx` never re-runs on soft navigation
// and a mid-session `blocked` flip is invisible until a hard reload. Templates re-render
// on every navigation. The second check below makes "helpfully moving it back" a build
// failure rather than a silent regression.
{
  const template = path.join(AGENT_DIR, "(enforced)", "template.tsx");
  if (!fs.existsSync(template)) {
    failures.push(
      `app/agent/(enforced)/template.tsx is missing — the page-side billing seam is gone.`
    );
  } else {
    const src = fs.readFileSync(template, "utf8");
    for (const sym of ["agentSession", "BillingPaywall", "BillingBanner"]) {
      if (!hasWord(src, sym)) {
        failures.push(`app/agent/(enforced)/template.tsx no longer references ${sym}.`);
      }
    }
  }

  const layout = path.join(AGENT_DIR, "(enforced)", "layout.tsx");
  if (fs.existsSync(layout) && hasWord(fs.readFileSync(layout, "utf8"), "BillingPaywall")) {
    failures.push(
      `app/agent/(enforced)/layout.tsx renders BillingPaywall — the gate MUST live in ` +
        `template.tsx. A layout is preserved across <Link> navigations, so the paywall ` +
        `would not appear until a hard reload (finding 6).`
    );
  }
}

// ADMIN-API positive lock: every route module under app/api/admin/** must be
// adminSession-gated (or explicitly exempt) and role-clean. Pure function
// above; here it runs over the real tree.
failures.push(
  ...checkAdminApiRoutes(files.map((f) => ({ path: rel(f), src: fs.readFileSync(f, "utf8") })))
);
// ============================================================================
// Public Sample Profiles — §D6 v4 token/sample rules (plan Phase 7)
// ============================================================================
//
// The published SAMPLE_OPEN_TOKEN made the open share token a public secret, so
// every token-authorised path must run through the ONE chokepoint
// (lib/sample-guard.ts resolveTokenSubject) that enforces the per-route mode
// pinning + sample read-only/curated verdicts. These rules make "forgot the
// chokepoint" (or re-introducing an inline token compare, or a new lib that
// wraps token resolution, or a /sample page reaching for tenant scope) a BUILD
// FAILURE, not a review hope.

const LIB_DIR = path.join(APP_DIR, "lib");
const SAMPLE_DIR = path.join(APP_DIR, "app", "sample");
const CHOKEPOINT = "resolveTokenSubject";

// (1) The widened token-symbol surface: raw token fields OR the share-access
// resolver surface. Word-bounded, so `shareTokenLastUsedAt` does not match but
// `s.shareToken` does.
const TOKEN_REGEX =
  /\b(openShareToken|emailShareToken|shareToken|resolveSeafarerByShareToken|evaluateShareAccess|parseShareToken|priorShareTokens)\b/;

// (1b, v4-1) Zero-inline-compare: in any file that references the chokepoint, a
// stray `…ShareToken ===` can no longer be grandfathered by the chokepoint's
// presence elsewhere in the file.
const INLINE_COMPARE_REGEX = /\b\w*[sS]hareToken\s*===/;

// (1a) `// sample-token: exempt(<reason>)` — the marker is legal ONLY in the
// seeded census rows 23-26 (link-construction / grant-token-auth routes). Any
// other file carrying it fails until audited and listed here.
const SAMPLE_EXEMPT_RE = /sample-token:\s*exempt\(([^)]+)\)/;
const SAMPLE_TOKEN_EXEMPT_ALLOWED = [
  "api/reminders/route.ts", // row 23 — link construction only
  "api/doc-requests/route.ts", // row 24 — link construction only
  "api/bulk/route.ts", // row 25 — link construction only
  "api/invite/link/route.ts", // row 26 — grant-token auth; paste-parse on the resolver
];

for (const file of walk(API_DIR)) {
  const src = fs.readFileSync(file, "utf8");
  const r = rel(file);
  const touchesTokens = TOKEN_REGEX.test(src);
  const usesChokepoint = hasWord(src, CHOKEPOINT);
  const exemptMatch = SAMPLE_EXEMPT_RE.exec(src);
  const exemptAllowed = SAMPLE_TOKEN_EXEMPT_ALLOWED.some((f) =>
    file.replace(/\\/g, "/").endsWith(f)
  );

  if (touchesTokens && !usesChokepoint) {
    if (!exemptMatch) {
      failures.push(
        `${r} touches the share-token surface (${TOKEN_REGEX.source.slice(0, 40)}…) but ` +
          `neither resolves through ${CHOKEPOINT} nor carries "// sample-token: exempt(<reason>)".`
      );
    } else if (!exemptAllowed) {
      failures.push(
        `${r} carries a sample-token exempt marker but is NOT on the seeded exempt list ` +
          `(census rows 23-26). Audit the route and extend SAMPLE_TOKEN_EXEMPT_ALLOWED explicitly.`
      );
    }
  }
  if (exemptMatch && !exemptAllowed) {
    failures.push(
      `${r} carries a sample-token exempt marker outside the seeded exempt list — ` +
        `markers are census rows 23-26 ONLY.`
    );
  }
  if (usesChokepoint && INLINE_COMPARE_REGEX.test(src)) {
    failures.push(
      `${r} references ${CHOKEPOINT} but STILL contains an inline "…ShareToken ===" ` +
        `comparison — the chokepoint must be the only token resolution (D6 v4 zero-inline-compare).`
    );
  }
}

// (1c, v4-5c) app/lib cross-check: every lib module matching the token regex must
// be a KNOWN, individually audited resolver — a future lib that wraps token
// resolution (the seaman-account.ts evasion precedent) fails until listed.
const KNOWN_TOKEN_RESOLVER_LIBS = [
  "share-access.ts", // THE canonical resolver
  "sample-guard.ts", // the chokepoint itself (+ §D8 allowlist naming the fields)
  "seaman-account.ts", // Google adoption seam — isSample-refused (plan §D5)
  "credential-auth.ts", // password adoption seam — isSample-refused (plan §D5)
  "verify-record.ts", // proof mint: grant-token half; sample-curated filter inside
  "inbox.ts", // open-token read fallback (D1: replies stay session-only)
  "person-merge.ts", // priorShareTokens carry — sample-merge refused at 3 depths
  "db.ts", // token field owner: mint/rotation/lock-step of the deprecated alias
  "client-portal.ts", // portal-token resolver — visForDb carries the isSample skip
  // DEVIATION (documented, 2026-08-18): lib/access.ts matches the widened regex
  // solely through the GRANT-token namespace — AccessGrant.shareToken (per-grant
  // invite-link secret) and the shareToken() mint imported from db.ts. Audited:
  // it never resolves a Seafarer by a seafarer share token, and every read it
  // gates goes through the grant checks lib/agentData re-runs. Listed rather
  // than narrowing the regex, so the rule stays strict for future libs.
  "access.ts",
];
for (const file of walk(LIB_DIR)) {
  const src = fs.readFileSync(file, "utf8");
  const relLib = path.relative(LIB_DIR, file).replace(/\\/g, "/");
  if (TOKEN_REGEX.test(src) && !KNOWN_TOKEN_RESOLVER_LIBS.includes(relLib)) {
    failures.push(
      `lib/${relLib} touches the share-token surface but is not on the known-resolver ` +
        `allowlist — audit it (does it resolve/compare/mint tokens?) and list it explicitly.`
    );
  }
  if (hasWord(src, CHOKEPOINT) && INLINE_COMPARE_REGEX.test(src)) {
    failures.push(
      `lib/${relLib} references ${CHOKEPOINT} but still contains an inline ` +
        `"…ShareToken ===" comparison (D6 v4 zero-inline-compare).`
    );
  }
}

// (2) app/sample inverted rule: the PUBLIC demo segment must never touch tenant
// scope. Routable modules there may not resolve agentSession/seamanSession nor
// any lib/agentData surface, and MUST build from lib/sample-data projections.
const AGENTDATA_SYMBOLS = [
  "listSeafarersForAgent",
  "getSeafarerForAgent",
  "getDocumentsForAgent",
  "resolveDocumentForAgent",
  "recordReview",
  "accessLogForAgent",
];
const SAMPLE_DATA_SYMBOLS = [
  "getSampleSeafarerPayload",
  "getSampleBoardData",
  "getSampleReviewData",
  "getSampleCircularThread",
  "getFlagshipSearchRow",
];
for (const file of walk(SAMPLE_DIR)) {
  if (!/(^|[\\/])(page\.tsx|layout\.tsx|route\.tsx?)$/.test(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  const r = rel(file);
  for (const foreign of ["agentSession", SEAMAN_GATE]) {
    if (hasWord(src, foreign)) {
      failures.push(
        `${r} is a PUBLIC sample module but resolves "${foreign}" — the /sample segment ` +
          `must never gain agent/seaman tenant scope.`
      );
    }
  }
  if (/lib\/agentData/.test(src) || AGENTDATA_SYMBOLS.some((s) => hasWord(src, s))) {
    failures.push(
      `${r} is a PUBLIC sample module but references lib/agentData — sample pages read ` +
        `ONLY the curated lib/sample-data projections.`
    );
  }
  if (!/lib\/sample-data/.test(src) && !SAMPLE_DATA_SYMBOLS.some((s) => hasWord(src, s))) {
    failures.push(
      `${r} is a routable sample module but references NO lib/sample-data symbol — ` +
        `the curated projections are the only legal data source for /sample.`
    );
  }
}

// (3) Positive locks. Paths are relative to the app root (APP_DIR).
const MUST_USE_TOKEN_CHOKEPOINT = [
  "app/api/comments/route.ts",
  "app/api/calendar/route.ts",
  "app/api/cv/[id]/route.ts",
  "app/api/contract/[id]/route.ts",
  "app/api/verify-link/route.ts",
];
for (const frag of MUST_USE_TOKEN_CHOKEPOINT) {
  const p = path.join(APP_DIR, "app", frag.replace(/^app\//, ""));
  if (!fs.existsSync(p)) {
    failures.push(`Expected chokepoint route "${frag}" not found (moved/renamed?).`);
    continue;
  }
  if (!hasWord(fs.readFileSync(p, "utf8"), CHOKEPOINT)) {
    failures.push(`Chokepoint route "${frag}" no longer references ${CHOKEPOINT}.`);
  }
}

// The five password/claim seams + the no-token-symbol sample-critical seams
// (v3-A merge, v4-4 share/portal pages — both OUTSIDE the scan roots above and
// isolation-exempt, so nothing else statically locks them).
const MUST_REFERENCE_ISAMPLE = [
  "lib/seaman-account.ts",
  "lib/credential-auth.ts",
  "app/api/account/claim-report/route.ts",
  "app/api/admin/credential-rescue/route.ts",
  "app/api/seaman-test-login/route.ts",
  "app/api/test-login/route.ts",
  "app/api/seafarers/merge/route.ts",
  "lib/person-merge.ts",
  "lib/client-portal.ts",
  "app/api/circulars/route.ts",
  "app/api/doc-requests/route.ts",
  "app/share/[token]/page.tsx",
  "app/portal/[token]/page.tsx",
];
for (const frag of MUST_REFERENCE_ISAMPLE) {
  const p = path.join(APP_DIR, frag);
  if (!fs.existsSync(p)) {
    failures.push(`Expected isSample-guarded module "${frag}" not found (moved/renamed?).`);
    continue;
  }
  if (!hasWord(fs.readFileSync(p, "utf8"), "isSample")) {
    failures.push(
      `Sample-critical seam "${frag}" no longer references isSample — its sample ` +
        `refusal/filter has been removed (plan §D6 MUST_REFERENCE_ISAMPLE).`
    );
  }
}

// ---- Report ----
console.log("Router-driven isolation guard — route scan\n");
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("ROUTE", 40), pad("AGENT", 7), pad("GUARD", 7), "STATUS");
for (const x of rows) {
  console.log(
    pad(x.route, 40),
    pad(x.agentFacing ? "yes" : "-", 7),
    pad(x.guarded ? "yes" : "-", 7),
    x.status
  );
}

console.log("");
if (failures.length) {
  console.error(`FAIL — ${failures.length} isolation problem(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`PASS — every agent-facing route goes through the fail-closed guard (${rows.length} modules scanned).`);
}

// Run the scan only when executed directly (`node tests/isolation-static.mjs`) —
// importing this module (the outreach meta-test imports checkAdminApiRoutes)
// must stay side-effect-free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
