// Server-side ADMIN impersonation ("act as any seaman or agent").
//
// The mechanism is a PERSISTED RECORD keyed by the admin's verified e-mail — NOT a
// token/JWT/cookie. The admin keeps their own signed Google JWT (what adminSession()
// trusts); this row says who they are currently acting as. Two identity gates
// (lib/seaman-session, lib/agent-session) consult it via decideImpersonation() so the
// whole app acts as the target with no per-route change. See admin-impersonation-plan.
//
// Correctness invariants baked in here:
//   * NON-mutating on read (F3): resolveImpersonation NEVER lazily deletes. An expired
//     or kill-switched row is a TOMBSTONE ("suspended") — stable across every request,
//     so post-expiry behaviour is always 403, never a silent flip to the admin's own
//     identity on the 2nd request. Only stop/start mutate the row.
//   * Client-supplied ids are never trusted: the target is re-resolved from the SERVER
//     record against readDB() by the resolvers.

import {
  readDB,
  updateDB,
  AUDIT_NO_IMPERSONATION,
  type DB,
  type Impersonation,
  type ImpersonationTargetKind,
  type AuditOnBehalf,
} from "@/lib/db";

// NOTE: this module deliberately does NOT import @/lib/admin-session (which pulls in
// @/auth → next-auth, un-importable in plain-node contract tests). The admin-email
// allowlist is passed INTO decideImpersonation by the caller — the resolvers pass the
// real ADMIN_EMAILS; contract tests pass a mirror set. The pure logic stays node-testable.

// ---- F2 boot assertion (belt-and-braces) ------------------------------
// Any production process that loads impersonation code (via the resolvers) hard-fails
// if the demo login door is set. The primary enforcement is instrumentation.ts; this
// is the defense-in-depth backstop the plan (§6a) requires.
if (process.env.DOCKA_DEMO_LOGIN && process.env.NODE_ENV === "production") {
  throw new Error(
    "DOCKA_DEMO_LOGIN must not be set in production (it makes anyone any agent/seaman " +
      "with no audit). Refusing to load impersonation. Unset DOCKA_DEMO_LOGIN."
  );
}

/** Global kill-switch (env). Off => every admin WITH a row resolves "suspended". */
export const IMPERSONATION_ENABLED = process.env.IMPERSONATION_ENABLED !== "0";
/** Time-to-live for an impersonation session (default 60 min). */
export const IMPERSONATION_TTL_MS = Number(
  process.env.IMPERSONATION_TTL_MS ?? 60 * 60 * 1000
);

// ---- Tri-state resolution (F3) ----------------------------------------
export type ImpResolution =
  | { state: "active"; record: Impersonation }
  | { state: "suspended" } // a row EXISTS but is expired OR the kill-switch is off
  | { state: "none" }; // no row at all

/**
 * Resolve the current impersonation state for an admin WITHOUT mutating storage.
 * Expired / kill-switched rows stay as tombstones ("suspended") until an explicit
 * stop/start, so the state is STABLE across requests.
 */
export function resolveImpersonation(adminEmail: string): ImpResolution {
  const key = (adminEmail ?? "").trim().toLowerCase();
  const row = readDB().impersonations.find((r) => r.adminEmail === key);
  if (!row) return { state: "none" };
  if (!IMPERSONATION_ENABLED) return { state: "suspended" };
  if (Date.now() > row.expiresAt) return { state: "suspended" };
  return { state: "active", record: row };
}

/**
 * Start (or replace) impersonation for an admin. Validates the target EXISTS against
 * readDB() (client-supplied id is never trusted). Persisted via the mutex-safe
 * updateDB with a remove-then-push upsert, so a concurrent PUT winner is deterministic
 * (the last write wins — exactly one row per admin).
 */
export function startImpersonation(input: {
  adminEmail: string;
  targetKind: ImpersonationTargetKind;
  targetId: string;
}): Promise<Impersonation> {
  const adminEmail = (input.adminEmail ?? "").trim().toLowerCase();
  return updateDB((db) => {
    const exists =
      input.targetKind === "seaman"
        ? db.seafarers.some((s) => s.id === input.targetId)
        : db.agents.some((a) => a.id === input.targetId);
    if (!exists) {
      throw new Error(
        `Impersonation target not found: ${input.targetKind} ${input.targetId}`
      );
    }
    const now = Date.now();
    const record: Impersonation = {
      adminEmail,
      targetKind: input.targetKind,
      targetId: input.targetId,
      startedAt: now,
      expiresAt: now + IMPERSONATION_TTL_MS,
    };
    // Upsert: remove any existing row for this admin, then push the fresh one.
    db.impersonations = db.impersonations.filter((r) => r.adminEmail !== adminEmail);
    db.impersonations.push(record);
    return record;
  });
}

/** Stop impersonation for an admin. Idempotent — always resolves. */
export function stopImpersonation(adminEmail: string): Promise<void> {
  const key = (adminEmail ?? "").trim().toLowerCase();
  return updateDB((db) => {
    db.impersonations = db.impersonations.filter((r) => r.adminEmail !== key);
  });
}

// ---- Pure decision function (F6 testability seam) ---------------------
export type ImpDecision =
  | { kind: "target"; targetKind: ImpersonationTargetKind; targetId: string }
  | { kind: "suspend" } // expired / kill-switched / other-kind / vanished target => null
  | { kind: "fallthrough" }; // no row / not an admin => use the admin's own JWT identity

/**
 * PURE branch decision for a resolver preamble. No IO — the caller passes the resolved
 * state + a db snapshot. Re-checks ADMIN_EMAILS (fail-closed on a non-admin email) and
 * re-validates the target's existence against `db`. `wantKind` is the resolver's own
 * kind ("seaman" for seaman-session, "agent" for agent-session); an active session of
 * the OTHER kind yields "suspend" so the sibling resolver suppresses its own scope.
 */
export function decideImpersonation(
  email: string,
  res: ImpResolution,
  db: DB,
  wantKind: ImpersonationTargetKind,
  adminEmails: ReadonlySet<string>
): ImpDecision {
  const norm = (email ?? "").trim().toLowerCase();
  if (!norm || !adminEmails.has(norm)) return { kind: "fallthrough" };
  if (res.state === "none") return { kind: "fallthrough" };
  if (res.state === "suspended") return { kind: "suspend" };
  const rec = res.record;
  if (rec.targetKind !== wantKind) return { kind: "suspend" };
  const exists =
    wantKind === "seaman"
      ? db.seafarers.some((s) => s.id === rec.targetId)
      : db.agents.some((a) => a.id === rec.targetId);
  if (!exists) return { kind: "suspend" }; // record points at a vanished target — fail closed
  return { kind: "target", targetKind: rec.targetKind, targetId: rec.targetId };
}

/**
 * F1 helper — build the audit stamp from a resolved session. Returns the
 * AUDIT_NO_IMPERSONATION sentinel for a normal (non-impersonated) request, so route
 * handlers can pass the result straight into any stamp-aware writer.
 */
export function impersonationStampFor(session: {
  impersonatorAdminEmail?: string;
  seafarerId?: string;
  agentId?: string;
}): AuditOnBehalf {
  const email = session?.impersonatorAdminEmail;
  if (!email) return AUDIT_NO_IMPERSONATION;
  if (session.seafarerId) {
    return { impersonator: `admin:${email}`, onBehalfOf: `seaman:${session.seafarerId}` };
  }
  if (session.agentId) {
    return { impersonator: `admin:${email}`, onBehalfOf: `agent:${session.agentId}` };
  }
  return AUDIT_NO_IMPERSONATION;
}
