// tests/_isolation-rules.mjs — the CLASSIFIER behind tests/isolation-static.mjs.
//
// Extracted so the rule itself is unit-testable against fixture strings (fix-plan F5 /
// D-C): a static guard nobody tests is a guard that can be silently weakened, which is
// exactly what finding 9 was.
//
// FINDING 9 — eight lib/billing-store symbols had been APPENDED to `GUARD_SYMBOLS`, and
// that list is ANY-match. A future route resolving `agentSession`, calling
// `recordUsageForPeriod` and then reading `readDB().seafarers` unscoped therefore PASSED
// a scan that would have flagged it before billing landed: the tenant-isolation guard
// had been diluted by an unrelated feature.
//
// The fix is two lists and two rules:
//
//   GUARD_SYMBOLS         tenant-data accessors ONLY (lib/access, lib/agentData,
//                         lib/required-docs-store). Restored to what it was.
//
//   BILLING_STORE_SYMBOLS the per-agent billing accessors. They make a module
//                         BILLING-SCOPED — but ONLY when it touches no raw store at all
//                         (`readDB` / `updateDB` / `transact`). A billing surface has no
//                         business reading tenant collections directly, so "billing
//                         symbol + raw store" is precisely the attack shape above and
//                         still FAILS.

/** Whole-identifier match (every symbol here is [A-Za-z]). */
export function hasWord(src, word) {
  return new RegExp(`\\b${word}\\b`).test(src);
}

/** Whole-word guard symbols that constitute "went through the fail-closed accessor". */
export const GUARD_SYMBOLS = [
  // lib/access.ts — live, per-request grant checks (default-deny).
  "checkAccess",
  "readableSeafarerIds",
  // lib/agentData.ts — the ONLY exported seafarer/document/log reads for an agent.
  "listSeafarersForAgent",
  "getSeafarerForAgent",
  "getDocumentsForAgent",
  "resolveDocumentForAgent",
  "recordReview",
  "accessLogForAgent",
  // lib/required-docs-store.ts — every fn is partitioned by agentId (own-tenant only).
  "getConfigForAgent",
  "governedSeafarerIds",
  "auditForAgent",
  "saveConfigForAgent",
  "hasCustomConfig",
];

/**
 * lib/billing-store.ts — same construction (every fn is partitioned by agentId), but a
 * DIFFERENT rule: see the header. These are deliberately NOT in GUARD_SYMBOLS.
 */
export const BILLING_STORE_SYMBOLS = [
  "getBillingProfileForAgent",
  "ensureBillingProfileForAgent",
  "saveBillingProfileForAgent",
  "setBillingStripeRefs",
  "setSubscriptionStatusForAgent",
  "setBillingRatesForAgent",
  "recordUsageForPeriod",
  "markUsagePushed",
  "closeUsageRow",
  "usageForAgent",
  "usagePreviewForAgent",
];

/** Raw-store indicators: a BILLING-SCOPED module must contain NONE of these. */
export const RAW_STORE_SYMBOLS = ["readDB", "updateDB", "transact"];

/**
 * Classify one agent-facing module's tenant-isolation posture.
 *
 *   GUARDED        it references a fail-closed tenant accessor;
 *   BILLING-SCOPED it references a per-agent billing accessor and NO raw store;
 *   exempt         it carries an explicit `// isolation-guard: exempt` marker;
 *   UNGUARDED LEAK anything else.
 */
export function classifyAgentModule(src) {
  if (GUARD_SYMBOLS.some((g) => hasWord(src, g))) return "GUARDED";
  const billing = BILLING_STORE_SYMBOLS.some((g) => hasWord(src, g));
  const rawStore = RAW_STORE_SYMBOLS.some((g) => hasWord(src, g));
  if (billing && !rawStore) return "BILLING-SCOPED";
  if (/isolation-guard:\s*exempt/.test(src)) return "exempt";
  return "UNGUARDED LEAK";
}
