"use client";

import { useState } from "react";

export type DemoAgent = { id: string; orgName: string; contact: string };

// Dev-only "sign in as agent" picker. Choosing an agent sets the dev session
// cookie to THAT tenant (POST /api/test-login { agentId }), so multi-tenant
// isolation is demonstrable locally without Google: each agent then sees only the
// seafarers who granted it access (grant-scoped reads, lib/agentData.ts). The
// server only renders this in dev; /api/test-login itself 403s in production.
export function DevAgentPicker({
  agents,
  current,
  compact = false,
}: {
  agents: DemoAgent[];
  /** The agentId currently signed in, if any (highlights it + labels the switcher). */
  current?: string;
  /** Compact = a small dropdown for the dashboard header; full = a stacked list. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signInAs(agentId: string) {
    setBusy(agentId);
    setError(null);
    try {
      const res = await fetch("/api/test-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (res.ok) {
        window.location.href = "/agent";
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Could not switch agent.");
        setBusy(null);
      }
    } catch {
      setError("Could not switch agent.");
      setBusy(null);
    }
  }

  if (agents.length === 0) return null;

  if (compact) {
    return (
      <div className="flex items-center gap-2" data-testid="dev-agent-switcher">
        <label className="text-xs font-medium text-slate-400">Dev: sign in as</label>
        <select
          value={current ?? ""}
          disabled={busy !== null}
          onChange={(e) => e.target.value && signInAs(e.target.value)}
          data-testid="dev-agent-select"
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 outline-none focus:border-brand-500"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.orgName}
            </option>
          ))}
        </select>
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-left" data-testid="dev-agent-picker">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Dev — sign in as a demo agent
      </p>
      <p className="mt-1 text-xs text-slate-400">
        Each agent only sees the seafarers who granted it access. Switch agents to
        see the isolation.
      </p>
      <div className="mt-3 space-y-2">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            data-testid={`dev-agent-${a.id}`}
            disabled={busy !== null}
            onClick={() => signInAs(a.id)}
            className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:opacity-60 ${
              current === a.id
                ? "border-brand-400 bg-brand-50 text-brand-800"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
            }`}
          >
            <span>{a.orgName}</span>
            <span className="text-xs font-normal text-slate-400">
              {busy === a.id ? "Signing in…" : a.contact}
            </span>
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
