import Link from "next/link";
import { cookies } from "next/headers";
import { signIn, isGoogleConfigured, OAUTH_ROLE_COOKIE } from "@/auth";
import { isDevLoginEnabled } from "@/lib/agent-session";
import { TestLoginButton } from "@/components/TestLoginButton";
import { DevAgentPicker } from "@/components/DevAgentPicker";
import { AgentPasswordAuth } from "@/components/AgentPasswordAuth";
import { readDB } from "@/lib/db";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";

// Shown at /agent when nobody is signed in. Server component: the sign-in form
// posts a server action that kicks off the Google OAuth redirect.
export function SignInGate() {
  // Dev picker: list the seeded demo agents so multi-tenant isolation is
  // demonstrable locally without Google. Only read/rendered in dev.
  const demoAgents = isDevLoginEnabled
    ? readDB().agents.map((a) => ({ id: a.id, orgName: a.orgName, contact: a.contact }))
    : [];
  // Server-component i18n: read the language cookie directly (layout pattern).
  const rawLang = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(rawLang) ? rawLang : DEFAULT_LANG;
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-800 text-white shadow-sm">
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

      {/* feat/password-signup Step 8: the gate is no longer Google-only. */}
      <h1 className="mt-6 text-2xl font-bold text-slate-900">
        {t(lang, "pw.agentGateTitle")}
      </h1>
      <p className="mt-2 text-sm text-slate-500">
        The crewing pipeline is for authorised agents only. Seafarers do not need
        to sign in — they use their private share link.
      </p>
      {/* Public Sample Profiles (Phase 6): every signed-out agent surface that
          renders this gate offers the live fictional-data board demo. */}
      <p className="mt-2 text-sm">
        <Link
          href="/sample/agency"
          data-testid="gate-view-sample-board"
          className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
        >
          {t(lang, "sample.viewSampleBoard")} →
        </Link>
      </p>

      <div className="mt-8 w-full">
        {isGoogleConfigured ? (
          <form
            action={async () => {
              "use server";
              // Stamp the AGENT context so this sign-in becomes an agent session,
              // overwriting any stale seaman intent cookie from a prior seaman login.
              cookies().set(OAUTH_ROLE_COOKIE, "agent", {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                maxAge: 300,
              });
              await signIn("google", { redirectTo: "/agent" });
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
            Google login is not configured yet. The site owner needs to add
            Google OAuth credentials (<code>AUTH_GOOGLE_ID</code> /{" "}
            <code>AUTH_GOOGLE_SECRET</code>) before agents can sign in — the
            username + password option below works either way.
          </div>
        )}

        {/* Username + password — always available (D9): works where Google is
            blocked (WeChat webview / mainland China) and even when Google OAuth
            is not configured on this deployment. */}
        {isGoogleConfigured ? (
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            {t(lang, "pw.or")}
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        ) : (
          <div className="my-5" />
        )}
        <AgentPasswordAuth />

        {isDevLoginEnabled && (
          <>
            {demoAgents.length > 0 ? (
              <DevAgentPicker agents={demoAgents} />
            ) : (
              <TestLoginButton label="Continue as test agent (dev)" />
            )}
            <p className="mt-2 text-xs text-slate-400">
              Dev-only door — active in <code>next dev</code>, disabled in production.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
