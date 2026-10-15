// app/admin/verify-uploads/actions.tsx — client islands on the corpus page.
//
// Per-row actions (plan §7): Download is a plain <a> to the audited download
// route; Delete (confirm-gated) and Re-run call the admin API and refresh the
// server-rendered table. ProbeButton (registry-health panel) fires one
// country's negative-path probe and refreshes; a 429 (60 s server-side
// cooldown) surfaces its friendly message inline. Copy is terse by operator
// rule (buttons ≤2 words); the explanations live in title tooltips.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BTN =
  "rounded border px-2 py-1 text-xs font-medium transition disabled:opacity-40";

export function RowActions({ itemId }: { itemId: string }): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<"delete" | "rerun" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function call(kind: "delete" | "rerun"): Promise<void> {
    setBusy(kind);
    setErr(null);
    try {
      const res =
        kind === "delete"
          ? await fetch(`/api/admin/verify-uploads/${itemId}`, { method: "DELETE" })
          : await fetch(`/api/admin/verify-uploads/${itemId}/rerun`, { method: "POST" });
      if (!res.ok) {
        setErr(`Failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setErr("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <a
        href={`/api/admin/verify-uploads/${itemId}/download`}
        title="Download the original uploaded file (audited)"
        className={`${BTN} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
      >
        Download
      </a>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void call("rerun")}
        title="Queue recognition again for this document (admin priority)"
        className={`${BTN} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100`}
      >
        {busy === "rerun" ? "Running…" : "Re-run"}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => {
          if (
            window.confirm(
              "Delete this upload? Bytes and sidecar are removed permanently; a tombstone stays in the audit chain."
            )
          ) {
            void call("delete");
          }
        }}
        title="Remove the file, derived image and sidecar permanently"
        className={`${BTN} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`}
      >
        {busy === "delete" ? "Deleting…" : "Delete"}
      </button>
      {err ? <span className="text-[11px] text-rose-600">{err}</span> : null}
    </div>
  );
}

export function ProbeButton({ country }: { country: string }): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function probe(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/verify-uploads/health/${country}`, { method: "POST" });
      if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg(body?.error ?? "Probed recently — wait a minute.");
      } else if (!res.ok) {
        setMsg(`Failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void probe()}
        title="Send this country's documented negative-path test lookup to the real registry (audited, 60 s cooldown)"
        className={`${BTN} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100`}
      >
        {busy ? "Probing…" : "Probe"}
      </button>
      {msg ? <span className="text-[11px] text-amber-600">{msg}</span> : null}
    </span>
  );
}
