"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The "Exit" control in the global impersonation banner. DELETE stops the record
// (idempotent — also the expiry/kill-switch recovery path), then router.refresh()
// re-runs the resolvers: the admin's own identity is restored and the banner clears.
export function ExitImpersonationButton({ label = "Exit" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      await fetch("/api/admin/impersonation", { method: "DELETE" });
    } finally {
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="ml-3 shrink-0 rounded-md bg-white/20 px-3 py-1 text-xs font-semibold text-white ring-1 ring-inset ring-white/40 transition hover:bg-white/30 disabled:opacity-60"
    >
      {busy ? "Exiting…" : label}
    </button>
  );
}
