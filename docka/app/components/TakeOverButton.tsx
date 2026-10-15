"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Admin "Take over / act as" control, rendered on the seaman + agent drill-downs.
// PUTs the impersonation record (admin e-mail is derived server-side, never sent),
// then navigates into the tenant surface and refreshes so the new identity + banner
// render. Only ever mounted inside an admin-gated page.
export function TakeOverButton({
  targetKind,
  targetId,
  label,
}: {
  targetKind: "seaman" | "agent";
  targetId: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/impersonation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetKind, targetId }),
      });
      if (res.ok) {
        router.push(targetKind === "seaman" ? "/seafarer" : "/agent");
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Could not start take-over.");
        setBusy(false);
      }
    } catch {
      setError("Could not start take-over.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-60"
      >
        {busy ? "Starting…" : label ?? `Take over as this ${targetKind}`}
      </button>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
