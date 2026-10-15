// lib/tracking-matcher.ts — the SINGLE source of truth for the middleware
// matcher, plus the boot-time self-test that guards the dead-allowlist bug
// class (plan §2 B6). Edge-safe: pure string/RegExp logic, NO fs / node imports,
// so it is importable by BOTH the edge middleware bundle and the Node
// instrumentation hook.
//
// THE BUG THIS GUARDS: if the middleware matcher silently stops covering /o or
// /u (a typo, a bad edit, a build that failed to statically extract an imported
// matcher), the tracking endpoints would fall THROUGH the rate-cap / size guard
// with no signal. instrumentation.register() calls assertTrackingMatcher() at
// boot and FAILS BOOT if the patterns don't match the two canonical sample
// paths — so a broken matcher can never ship silently.

/** Admin gate (pre-existing). */
export const ADMIN_MATCHER = "/admin/:path*";
/** Open-pixel endpoint. */
export const OPEN_MATCHER = "/o/:path*";
/** Unsubscribe endpoint. */
export const UNSUB_MATCHER = "/u/:path*";

/**
 * The exact array the middleware `config.matcher` literal MUST equal. The
 * literal is kept inline in middleware.ts (Next statically extracts it), and
 * assertMatcherLiteralInSync() below cross-checks the two so they cannot drift.
 */
export const MIDDLEWARE_MATCHER: readonly string[] = [ADMIN_MATCHER, OPEN_MATCHER, UNSUB_MATCHER];

/** Canonical sample paths the tracking matcher MUST match (boot self-test). */
export const SAMPLE_OPEN_PATH = "/o/deadbeef.gif";
export const SAMPLE_UNSUB_PATH = "/u/deadbeef";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a Next-style `/prefix/:path*` matcher to a RegExp. `:path*` is
 * zero-or-more segments, so `/o/:path*` matches `/o`, `/o/`, `/o/x`, `/o/x.gif`,
 * `/o/x/y`. Sufficient for the fixed set of patterns above.
 */
export function compileMatcher(pattern: string): RegExp {
  const base = pattern.replace(/\/:path\*$/, "");
  return new RegExp("^" + escapeRe(base) + "(?:/.*)?$");
}

/** Does any pattern in `matcher` match `path`? */
export function matcherMatches(matcher: readonly string[], path: string): boolean {
  return matcher.some((p) => compileMatcher(p).test(path));
}

/**
 * Boot self-test: assert the matcher actually matches BOTH a `/o/<token>.gif`
 * and a `/u/<token>` request. Throws (→ fail boot) otherwise.
 */
export function assertTrackingMatcher(matcher: readonly string[] = MIDDLEWARE_MATCHER): void {
  if (!matcherMatches(matcher, SAMPLE_OPEN_PATH)) {
    throw new Error(
      `tracking matcher self-test FAILED: no pattern matches ${SAMPLE_OPEN_PATH} ` +
        `(open-pixel endpoint would be unreachable by middleware). Matcher: ${JSON.stringify(matcher)}`
    );
  }
  if (!matcherMatches(matcher, SAMPLE_UNSUB_PATH)) {
    throw new Error(
      `tracking matcher self-test FAILED: no pattern matches ${SAMPLE_UNSUB_PATH} ` +
        `(unsubscribe endpoint would be unreachable by middleware). Matcher: ${JSON.stringify(matcher)}`
    );
  }
}

/**
 * Cross-check that the middleware's inline literal equals MIDDLEWARE_MATCHER.
 * Called at module scope in middleware.ts so a drift throws when middleware
 * loads (fail-closed), complementing the boot self-test above.
 */
export function assertMatcherLiteralInSync(literal: readonly string[]): void {
  const a = JSON.stringify(literal);
  const b = JSON.stringify(MIDDLEWARE_MATCHER);
  if (a !== b) {
    throw new Error(
      `middleware matcher literal is OUT OF SYNC with lib/tracking-matcher.ts. ` +
        `literal=${a} expected=${b}`
    );
  }
}

/** True for a path that is a tracking (/o or /u) request — used to branch middleware. */
export function isTrackingPath(pathname: string): boolean {
  return matcherMatches([OPEN_MATCHER, UNSUB_MATCHER], pathname);
}
