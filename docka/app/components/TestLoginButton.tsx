"use client";

import { useState } from "react";

// Dev-only shortcut into the agent dashboard without Google. The server only
// renders this when NODE_ENV !== "production", and /api/test-login itself 403s
// in prod, so there is no way to reach it from a production build.
export function TestLoginButton({
  label = "Continue as test agent (dev)",
  testId = "test-login-btn",
  agentId,
}: {
  label?: string;
  testId?: string;
  /** Sign in as a specific demo agent (multi-tenant picker); omit for the "dev" tenant. */
  agentId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/test-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentId ? { agentId } : {}),
      });
      if (res.ok) {
        window.location.href = "/agent";
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Test login failed.");
        setBusy(false);
      }
    } catch {
      setError("Test login failed.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        data-testid={testId}
        onClick={go}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-400 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
      >
        {busy ? "Signing in…" : label}
      </button>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
