// app/admin/access.tsx
//
// Admin access UI + the "sign-in vs 404" decision, factored out so every admin page
// handles a null gate identically. NOT a routable module (no page/layout/route
// filename) so it is not scanned by the inverted admin static guard — but it also
// never imports agentSession/seamanSession, keeping the admin surface clean.
//
// Decision (plan §3.3): adminSession() returns null for BOTH "not signed in" and
// "signed in but not allowlisted". To show the sign-in prompt ONLY when truly
// signed-out, we consult the underlying auth() once:
//   * no session at all         -> render the plain admin sign-in prompt
//   * a session exists, not admin -> notFound() (a 404 that never reveals /admin)
//
// The prompt starts Google OAuth via the app's existing signIn(), and — unlike
// components/SignInGate.tsx — stamps NO agent role cookie, so opening /admin never
// silently re-roles the owner's Google account (plan §3.5 / R10).

import { notFound } from "next/navigation";
import { auth, signIn, isGoogleConfigured } from "@/auth";

/**
 * What to render/throw when adminSession() is null. Returns the sign-in prompt when
 * there is no session; throws notFound() when a non-admin IS signed in. Callers do
 * `if (!session) return await adminDeniedResponse();`.
 */
export async function adminDeniedResponse(): Promise<JSX.Element> {
  const existing = await auth();
  if (existing?.user) {
    // Signed in but not on the allowlist — 404, do not reveal that /admin exists.
    notFound();
  }
  // Genuinely signed out — offer a Google sign-in that returns to /admin.
  return <AdminSignInPrompt />;
}

/**
 * Minimal admin-local sign-in surface. Server component; the button posts a server
 * action that kicks off the SAME Google OAuth the rest of the app uses, WITHOUT
 * stamping OAUTH_ROLE_COOKIE (admin identity is e-mail-only; role is irrelevant).
 */
export function AdminSignInPrompt(): JSX.Element {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-sm">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>

      <h1 className="mt-6 text-2xl font-bold text-slate-900">
        Sign in with Google to continue
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        The docka admin view is restricted to the platform owners.
      </p>

      <div className="mt-8 w-full">
        {isGoogleConfigured ? (
          <form
            action={async () => {
              "use server";
              // NOTE: deliberately do NOT set OAUTH_ROLE_COOKIE — admin is e-mail-only
              // and must never re-role the owner's Google account (plan §3.5).
              await signIn("google", { redirectTo: "/admin" });
            }}
          >
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
                />
              </svg>
              Sign in with Google
            </button>
          </form>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Google login is not configured yet. Set <code>AUTH_GOOGLE_ID</code> /{" "}
            <code>AUTH_GOOGLE_SECRET</code> before the admin view can be used.
          </div>
        )}
      </div>
    </div>
  );
}
