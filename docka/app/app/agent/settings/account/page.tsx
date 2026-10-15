// /agent/settings/account — feat/password-signup Step 13 (agent side).
// Follows the settings/circulars pattern: server component, agentSession()
// gate with the SignInGate fallback, linked as one more card from /agent.
// Renders the SAME AccountSecurity client component as the seaman page.
// PASSWORD accounts only: a Google agent has no password or recovery codes to
// manage, so they get a plain explanatory note instead (English — admin/agent
// chrome matches the existing English-only agent pages; the AccountSecurity
// form itself is localized via the pw.* keys like the rest of the family).

// isolation-guard: exempt — session-gated settings card that renders ONLY the
// acting session's own identity (name/email/authMethod) and the AccountSecurity
// form; it reads no tenant data (no seafarers, documents, grants), so there is no
// guard symbol to reference. (Pre-existing base failure fixed on this branch.)
import Link from "next/link";
import { agentSession } from "@/lib/agent-session";
import { SignInGate } from "@/components/SignInGate";
import { AccountSecurity } from "@/components/AccountSecurity";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const session = await agentSession();
  if (!session?.user) {
    return <SignInGate />;
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Crewing agent · {session.user.name ?? session.user.email}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">Account</h1>
        </div>
        <Link
          href="/agent"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to pipeline
        </Link>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        {session.authMethod === "password" ? (
          <AccountSecurity username={session.user.name ?? ""} side="agent" />
        ) : (
          <p className="text-sm text-slate-600">
            You are signed in with Google — there is no password or recovery codes to
            manage here. Password and account recovery are handled by your Google
            account.
          </p>
        )}
      </div>
    </div>
  );
}
