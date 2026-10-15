"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { getToken } from "@/lib/seamanToken";

// "Sign in with Google" for a SEAMAN. Before redirecting to Google it records the
// seaman sign-in context AND passes any anonymous local profile's share token as the
// ADOPT token, so a profile started on this device is linked to the Google identity
// instead of being orphaned. The role becomes "seaman" (see auth.ts), landing the
// user on THEIR own profile via /api/seafarers/me.
export function SeamanGoogleSignIn({
  label = "Sign in with Google",
  testId = "seaman-google-signin",
  prominent = false,
}: {
  label?: string;
  testId?: string;
  /** Primary call-to-action styling: bigger, ring-highlighted. */
  prominent?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const adoptToken = getToken();
      await fetch("/api/seaman/login-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adoptToken: adoptToken ?? "" }),
      });
      // next-auth/react handles the CSRF + redirect to Google; the callback returns
      // to /seafarer, where the page loads the now-owned profile from the session.
      await signIn("google", { callbackUrl: "/seafarer" });
    } catch {
      setError("Could not start Google sign-in. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        data-testid={testId}
        onClick={go}
        disabled={busy}
        className={
          prominent
            ? "flex w-full items-center justify-center gap-3 rounded-xl border-2 border-brand-500 bg-white px-4 py-4 text-base font-bold text-slate-800 shadow-md ring-2 ring-brand-100 transition hover:bg-brand-50 disabled:opacity-60"
            : "flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        }
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
        {busy ? "Opening Google…" : label}
      </button>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
