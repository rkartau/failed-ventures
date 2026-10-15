"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

// #42 — agent-side portal composer. Crew picker via the grant-scoped roster; a pre-send
// visibility preview + drop warning [R42.5]; a STABLE createKey per compose session for
// an idempotent submit [C11]. Lists existing portals with copyable links + revoke.

export type CrewOption = {
  id: string;
  name: string;
  rank: string;
  visible: boolean;
  reason: string | null;
};

export type PortalRow = {
  id: string;
  vessel: string;
  clientLabel: string;
  mode: "open" | "email";
  token: string;
  count: number;
  revokedAt: string | null;
  createdAt: string;
};

function reasonText(reason: string | null): string {
  if (reason === "no-grant") return "no live grant";
  if (reason === "not-consented") return "not marked client-visible";
  return "not visible";
}

export function PortalManager({
  options,
  portals,
}: {
  options: CrewOption[];
  portals: PortalRow[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vessel, setVessel] = useState("");
  const [clientLabel, setClientLabel] = useState("");
  const [mode, setMode] = useState<"open" | "email">("open");
  const [allowedEmails, setAllowedEmails] = useState("");
  const [rotationEnd, setRotationEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; keptCount: number } | null>(null);

  // Stable per-compose-session key => a double-click submit returns the SAME portal [C11].
  const createKey = useMemo(
    () => `pk-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    []
  );

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const droppedSelected = useMemo(
    () => Array.from(selected).map((id) => byId.get(id)).filter((o): o is CrewOption => !!o && !o.visible),
    [selected, byId]
  );

  function toggle(id: string) {
    // Hard-block ticking a crew who is not client-visible — the server filters them out
    // anyway, so a tickable-but-hidden checkbox is a misleading signal [B].
    if (!byId.get(id)?.visible) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!vessel.trim() || !clientLabel.trim() || selected.size === 0) return;
    // Pre-send exposure confirmation. Hidden crew can't be ticked (disabled), so the
    // count of hidden-included is always 0 — surfaced explicitly for reassurance [B].
    const visibleSelected = Array.from(selected).filter((sid) => byId.get(sid)?.visible).length;
    const confirmed = window.confirm(
      `Sending ${visibleSelected} crew · surnames masked · 0 hidden included.\n\n` +
        `The client will see rank, verification level and sea-readiness only — no ` +
        `documents, personal data or current-vessel assignment. Create this portal?`
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch("/api/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          vessel,
          clientLabel,
          seafarerIds: Array.from(selected),
          mode,
          allowedEmails: allowedEmails
            .split(/[,\s]+/)
            .map((e) => e.trim())
            .filter(Boolean),
          rotationEnd,
          createKey,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const kept = Array.isArray(data.visibility)
          ? data.visibility.filter((v: { visible: boolean }) => v.visible).length
          : 0;
        setCreated({ token: data.token, keptCount: kept });
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(portalId: string) {
    setBusy(true);
    try {
      await fetch("/api/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", portalId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="portal-manager" className="space-y-8">
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold text-slate-900">New client portal</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-slate-600">Vessel</span>
            <input
              value={vessel}
              onChange={(e) => setVessel(e.target.value)}
              maxLength={120}
              data-testid="portal-vessel-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Client label</span>
            <input
              value={clientLabel}
              onChange={(e) => setClientLabel(e.target.value)}
              maxLength={120}
              data-testid="portal-client-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Rotation end (voyage window)</span>
            <input
              type="date"
              value={rotationEnd}
              onChange={(e) => setRotationEnd(e.target.value)}
              data-testid="portal-rotation-input"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Access</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value === "email" ? "email" : "open")}
              data-testid="portal-mode-select"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="open">Open link (anyone with the link)</option>
              <option value="email">Email-restricted (named clients)</option>
            </select>
          </label>
          {mode === "email" && (
            <label className="text-sm sm:col-span-2">
              <span className="text-slate-600">Allowed client e-mails (comma / space separated)</span>
              <input
                value={allowedEmails}
                onChange={(e) => setAllowedEmails(e.target.value)}
                data-testid="portal-emails-input"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          )}
        </div>

        <p className="mt-4 text-sm font-medium text-slate-700">Choose crew</p>
        <ul className="mt-2 space-y-1.5" data-testid="portal-crew-picker">
          {options.map((o) => (
            <li key={o.id}>
              <label
                data-testid="portal-crew-option"
                data-visible={o.visible ? "true" : "false"}
                className={`flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 text-sm ${
                  o.visible ? "" : "cursor-not-allowed bg-slate-50 opacity-60"
                }`}
              >
                <span className="flex items-center gap-2">
                  {/* Hidden (not client-visible) crew CANNOT be ticked — the checkbox is
                      disabled so the UI never suggests they'd be exposed [B]. */}
                  <input
                    type="checkbox"
                    checked={selected.has(o.id)}
                    disabled={!o.visible}
                    onChange={() => toggle(o.id)}
                  />
                  <span className="font-medium text-slate-700">{o.name}</span>
                  <span className="text-slate-400">{o.rank}</span>
                </span>
                {o.visible ? (
                  <span className="text-xs font-semibold text-emerald-600">visible</span>
                ) : (
                  <span className="text-xs font-semibold text-amber-600">
                    hidden — {reasonText(o.reason)}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>

        {droppedSelected.length > 0 && (
          <p
            data-testid="portal-drop-warning"
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200"
          >
            {droppedSelected.length} selected crew will be DROPPED (not client-visible):{" "}
            {droppedSelected.map((o) => o.name).join(", ")}. Ask the seaman to mark you
            client-visible first.
          </p>
        )}

        <button
          type="button"
          disabled={busy || !vessel.trim() || !clientLabel.trim() || selected.size === 0}
          onClick={() => void submit()}
          data-testid="portal-create-submit"
          className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Create portal
        </button>

        {created && (
          <div
            data-testid="portal-created"
            className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200"
          >
            Portal created with {created.keptCount} visible crew. Share link:{" "}
            <code className="break-all">/portal/{created.token}</code>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-semibold text-slate-900">Your portals</h2>
        {portals.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">No portals yet.</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="portal-list">
            {portals.map((p) => (
              <li
                key={p.id}
                data-testid="portal-list-item"
                data-revoked={p.revokedAt ? "true" : "false"}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-medium text-slate-800">{p.vessel}</span>
                  <span className="text-slate-400"> · {p.clientLabel} · {p.count} crew · {p.mode}</span>
                  {p.revokedAt && <span className="ml-2 text-rose-600">revoked</span>}
                </span>
                {!p.revokedAt && (
                  <span className="flex items-center gap-2">
                    <code className="break-all text-xs text-slate-500">/portal/{p.token}</code>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void revoke(p.id)}
                      data-testid="portal-revoke"
                      className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Revoke
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
