"use client";

import { useState } from "react";

// #49 — AGENCY-controlled per-seaman directory consent (the agency half of the dual
// consent). Posts to /api/directory-consent, which re-checks the agent holds a live
// grant before writing. The seaman still must have opted in AND be identity-verified
// for the listing to actually appear.
export function DirectoryConsentToggle({
  seafarerId,
  name,
  rank,
  initial,
}: {
  seafarerId: string;
  name: string;
  rank: string;
  initial: boolean;
}) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/directory-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId, on: next }),
      });
      const data = await res.json();
      if (data.ok) setOn(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label
      data-testid="directory-consent-toggle"
      data-seafarer={seafarerId}
      data-on={on ? "true" : "false"}
      className={`flex min-h-[44px] items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 text-sm ${
        busy ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <span>
        <span className="font-medium text-slate-700">{name}</span>{" "}
        <span className="text-slate-400">{rank}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={busy}
        onChange={(e) => void toggle(e.target.checked)}
      />
    </label>
  );
}
