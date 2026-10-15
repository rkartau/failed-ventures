// lib/admin-audit.ts
//
// The ONE justified write in the otherwise read-only admin surface (plan §4.4 / F1):
// a mandatory, append-only ADMIN-ACCESS audit line, written whenever an allowlisted
// admin actually opens a per-user drill-down. On a consent-tracking maritime platform
// that already hash-chains access-log / consent for exactly this reason, an admin
// viewing every seafarer's PII must itself be auditable.
//
// Hard rules baked in here:
//   * Callers MUST invoke this ONLY after (1) adminSession() has passed AND (2) the
//     subjectId has been resolved to a REAL existing record — never for a denied,
//     404, or bad-id request. This helper does not re-check either; it trusts the
//     caller's ordering (the two drill-down pages).
//   * PREFETCH GUARD: Next.js <Link> hover/viewport prefetch and React re-render can
//     fire the render path more than once. We read headers() and SKIP the append for
//     any prefetch request, so a real view writes EXACTLY ONE line and a prefetch
//     writes ZERO.
//   * LOUD-FAIL, NOT SWALLOW: a failed compliance append emits a DISTINCT
//     high-severity `ADMIN-AUDIT-FAILURE` console.error so a broken/failed write is
//     DETECTABLE — but we never throw (a broken audit sink must not hard-fail the
//     page render). This deliberately does not mask a broken hash chain: the failure
//     is surfaced, not hidden.

import { headers } from "next/headers";
import { appendAudit, appendAuditOnce, AUDIT_NO_IMPERSONATION } from "@/lib/db";

export type AdminAccessOpts = {
  /** The acting admin's verified Google e-mail (from adminSession()). */
  adminEmail: string;
  /** The view identifier, e.g. "seaman-drilldown" / "agent-drilldown". */
  view: string;
  subjectKind: "seaman" | "agent";
  /** The RESOLVED, existing subject id. */
  subjectId: string;
};

/**
 * True when the current request is a prefetch (Next.js router prefetch or a browser
 * speculative prefetch). Header names are lower-cased by the Headers API.
 */
function isPrefetchRequest(): boolean {
  const h = headers();
  const nextPrefetch = h.get("next-router-prefetch"); // "1" on <Link> prefetch
  if (nextPrefetch === "1") return true;
  const purpose = (h.get("purpose") ?? "").toLowerCase();
  const xPurpose = (h.get("x-purpose") ?? "").toLowerCase();
  const xMoz = (h.get("x-moz") ?? "").toLowerCase();
  return purpose === "prefetch" || xPurpose === "prefetch" || xMoz === "prefetch";
}

/**
 * Append one admin-access audit line for a REAL drill-down view. Prefetch-guarded
 * and non-throwing (see file header). Call ONLY after the gate passes and the
 * subject resolves to an existing record.
 */
export type AdminActionOpts = {
  /** The acting admin's verified Google e-mail (from adminSession()). */
  adminEmail: string;
  /** e.g. "verify-uploads-list" — one stable string per admin surface action. */
  action: string;
  /** Small PII-free detail payload (itemId, page offset, result status). */
  detail?: Record<string, string | number | boolean | null>;
};

/**
 * Append one generic admin-action audit line (verify-upload plan §7 admin
 * surface). Same contract as recordAdminAccess: call ONLY after adminSession()
 * passed; prefetch-guarded; LOUD-FAIL, never throws.
 */
export async function recordAdminAction(opts: AdminActionOpts): Promise<void> {
  if (isPrefetchRequest()) return;

  try {
    await appendAudit(
      "admin-audit",
      {
        at: new Date().toISOString(),
        adminEmail: opts.adminEmail,
        action: opts.action,
        ...(opts.detail ?? {}),
      },
      // An admin operating their own surface is never an impersonated write.
      AUDIT_NO_IMPERSONATION
    );
  } catch (err) {
    console.error(
      `ADMIN-AUDIT-FAILURE: failed to append admin action audit line ` +
        `(action=${opts.action} admin=${opts.adminEmail}). The compliance record ` +
        `for this action may be MISSING.`,
      err
    );
  }
}

/**
 * Idempotent admin-action audit. Same LOUD-FAIL,
 * never-throws, prefetch-guarded contract as `recordAdminAction`, but appends AT
 * MOST ONCE for a given `(action, runId, phase)` tuple — the completion of one
 * long-running job must be recorded exactly once even though many GET-status
 * pollers observe the SAME terminal state. Idempotency is
 * the mutex-guarded scan-before-append in `appendAuditOnce` (db.ts), inside the
 * store's existing hash-chain critical section — no unique index exists on a
 * JSONL file. Returns true iff THIS call wrote the line (useful for tests / logs).
 */
export type AdminActionOnceOpts = AdminActionOpts & {
  /** The business key: e.g. a job runId (a server-minted UUID). */
  runId: string;
  /** The at-most-once phase, e.g. "completion". */
  phase: string;
};

export async function recordAdminActionOnce(opts: AdminActionOnceOpts): Promise<boolean> {
  if (isPrefetchRequest()) return false;

  try {
    const res = await appendAuditOnce(
      "admin-audit",
      (e) =>
        e.action === opts.action && e.runId === opts.runId && e.phase === opts.phase,
      {
        at: new Date().toISOString(),
        adminEmail: opts.adminEmail,
        action: opts.action,
        runId: opts.runId,
        phase: opts.phase,
        ...(opts.detail ?? {}),
      },
      AUDIT_NO_IMPERSONATION
    );
    return res.appended;
  } catch (err) {
    console.error(
      `ADMIN-AUDIT-FAILURE: failed to append idempotent admin action audit line ` +
        `(action=${opts.action} runId=${opts.runId} phase=${opts.phase} admin=${opts.adminEmail}). ` +
        `The compliance record for this action may be MISSING.`,
      err
    );
    return false;
  }
}

export async function recordAdminAccess(opts: AdminAccessOpts): Promise<void> {
  // Zero lines on hover/viewport prefetch or speculative browser prefetch.
  if (isPrefetchRequest()) return;

  try {
    await appendAudit(
      "admin-audit",
      {
        at: new Date().toISOString(),
        adminEmail: opts.adminEmail,
        view: opts.view,
        subjectKind: opts.subjectKind,
        subjectId: opts.subjectId,
      },
      // An admin VIEWING a drill-down is not itself an impersonated tenant write.
      AUDIT_NO_IMPERSONATION
    );
  } catch (err) {
    // DISTINCT, greppable, high-severity marker — a failed compliance write must be
    // detectable in the logs. We do NOT re-throw: the page must still render.
    console.error(
      `ADMIN-AUDIT-FAILURE: failed to append admin-access audit line ` +
        `(view=${opts.view} subjectKind=${opts.subjectKind} subjectId=${opts.subjectId} ` +
        `admin=${opts.adminEmail}). The compliance record for this view may be MISSING.`,
      err
    );
  }
}
