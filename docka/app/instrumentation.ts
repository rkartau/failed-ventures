import { assertTrackingMatcher } from "@/lib/tracking-matcher";

// Next.js startup hook (runs once at boot, before any request). F2 enforced
// invariant: refuse to start a PRODUCTION process that has the demo-login door set.
//
// DOCKA_DEMO_LOGIN turns every seaman/agent gate into "anyone can be anyone" with no
// audit (see lib/seaman-session / lib/agent-session). It is a dev-only convenience and
// must NEVER be set in production. This makes that a hard boot failure rather than a
// runbook checklist line. A belt-and-braces copy of the same assertion lives at module
// scope in lib/impersonation.ts (loaded by the resolvers).
export function register(): void {
  if (process.env.DOCKA_DEMO_LOGIN && process.env.NODE_ENV === "production") {
    throw new Error(
      "DOCKA_DEMO_LOGIN must not be set in production (it makes anyone any agent/seaman " +
        "with no audit). Refusing to start. Unset DOCKA_DEMO_LOGIN."
    );
  }

  // Tracking-matcher self-test (plan §2 B6): FAIL BOOT if the middleware matcher
  // no longer covers /o/<token>.gif AND /u/<token>. Guards the dead-allowlist bug
  // class — a broken matcher would let the tracking endpoints skip the edge
  // abuse controls silently. Pure string/RegExp check; safe in every runtime.
  assertTrackingMatcher();
}
