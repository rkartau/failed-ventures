// app/admin/deploy-skew.tsx — one-line "New version deployed" hint (admin only).
//
// The admin layout (server component) passes the SHA it rendered with; this
// island polls /api/version every 5 minutes and, when the live SHA differs,
// shows a single reload bar. Either side reporting "unknown" (local dev, no
// deploy marker) renders nothing — no false alarms.

"use client";

import { useEffect, useState } from "react";

const POLL_MS = 5 * 60 * 1000;

export function DeploySkewBar({ renderedSha }: { renderedSha: string }): JSX.Element | null {
  const [liveSha, setLiveSha] = useState<string | null>(null);

  useEffect(() => {
    if (renderedSha === "unknown") return; // nothing to compare against
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const body: unknown = await res.json();
        const sha = (body as { sha?: unknown }).sha;
        if (!cancelled && typeof sha === "string") setLiveSha(sha);
      } catch {
        // transient network failure — try again next tick
      }
    }
    const id = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [renderedSha]);

  if (!liveSha || liveSha === "unknown" || liveSha === renderedSha) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
      <span>New version deployed — reload to get it.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium hover:bg-amber-100"
      >
        Reload
      </button>
    </div>
  );
}
