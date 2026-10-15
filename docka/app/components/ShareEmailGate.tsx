import { cookies } from "next/headers";
import { signIn, isGoogleConfigured, OAUTH_ROLE_COOKIE } from "@/auth";

// Shown on /share/<token> when the seafarer has restricted the link to specific
// agent e-mails (shareMode === "email") and the current viewer is NOT allowed. It
// reveals NO documents — just a private-share notice and a Google sign-in button.
//
// The sign-in stamps the AGENT context cookie (overwriting any stale seaman intent),
// so the viewer becomes an ordinary agent session — we only need their verified
// Google e-mail to re-check the allow-list — and it is NOT turned into a seaman
// profile. After Google returns to this same /share/<token> URL, the server re-runs
// the allow-list check and shows the documents if the e-mail now matches.
export function ShareEmailGate({
  token,
  reason,
  viewerEmail,
}: {
  token: string;
  reason: "need-signin" | "not-allowed";
  /** The signed-in-but-not-allowed viewer's e-mail (only for reason "not-allowed"). */
  viewerEmail?: string | null;
}) {
  const backTo = `/share/${token}`;
  return (
    <div className="mx-auto max-w-md px-4 py-16" data-testid="share-email-gate">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
          <svg
            width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1 className="mt-5 text-xl font-bold text-slate-900">
          This profile is shared privately
        </h1>

        {reason === "not-allowed" ? (
          <p className="mt-2 text-sm text-slate-500" data-testid="share-gate-not-allowed">
            You are signed in{viewerEmail ? ` as ${viewerEmail}` : ""}, but this account is
            not on the seafarer&rsquo;s allowed list. Ask the seafarer to add your e-mail, or
            sign in with a different Google account.
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-500" data-testid="share-gate-need-signin">
            Sign in with Google to check access. Only the specific people the seafarer
            approved can open these documents.
          </p>
        )}

        <div className="mt-6">
          {isGoogleConfigured ? (
            <form
              action={async () => {
                "use server";
                cookies().set(OAUTH_ROLE_COOKIE, "agent", {
                  httpOnly: true,
                  sameSite: "lax",
                  path: "/",
                  maxAge: 300,
                });
                await signIn("google", { redirectTo: backTo });
              }}
            >
              <button
                type="submit"
                data-testid="share-gate-signin"
                className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
                </svg>
                {reason === "not-allowed" ? "Sign in with a different account" : "Sign in with Google"}
              </button>
            </form>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Google login is not configured on this deployment, so this private share
              cannot be opened yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
