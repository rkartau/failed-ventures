"use client";

import { useMemo, useState } from "react";
import type { ProfileChangeRequest, Seafarer } from "@/lib/db";
import {
  fieldGroups,
  type SelfServiceFieldDef,
  type SelfServiceFieldKey,
  type SeafarerProfile,
} from "@/lib/self-service";

// Seaman-side SELF-SERVICE profile editor (roadmap T1.7). The seaman keeps their own
// contact / next-of-kin / bank details up to date so agencies stop re-asking every
// contract. Crucially this NEVER writes the profile directly: each field change is
// PROPOSED and shown as "waiting for approval" until a granted agent approves it
// ashore. Only the fixed set of personal fields in lib/self-service.ts is editable —
// never rank, share links, or the government-verified identity.

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function ProfileSelfService({
  seafarerId,
  token,
  profile,
  changes,
  onChanges,
  directoryOptIn,
  identityVerified,
  onSeafarer,
}: {
  seafarerId: string;
  /** OWNER share token — the possession secret that authorises a proposal. */
  token: string;
  /** The seaman's approved personal profile currently on file. */
  profile: SeafarerProfile;
  /** This seaman's change queue (proposals + outcomes). */
  changes: ProfileChangeRequest[];
  /** Lift the refreshed change list to the parent after a proposal. */
  onChanges: (changes: ProfileChangeRequest[]) => void;
  /** #49 — current docka-verified directory opt-in state (undefined => hide the toggle). */
  directoryOptIn?: boolean;
  /** #49 — whether the seaman's identity is government-verified (a listing prerequisite). */
  identityVerified?: boolean;
  /** Lift the refreshed seafarer to the parent after a directory opt-in toggle. */
  onSeafarer?: (seafarer: Seafarer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SelfServiceFieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // #49 — docka-verified directory opt-in (default OFF, going-forward only).
  const [dirOptIn, setDirOptIn] = useState(directoryOptIn === true);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  async function toggleDirectory(next: boolean) {
    if (next && identityVerified !== true) {
      setDirError("Listing requires a government-verified identity first.");
      return;
    }
    setDirBusy(true);
    setDirError(null);
    try {
      const res = await fetch("/api/seafarers/self", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryOptIn: next }),
      });
      const data = await res.json();
      if (data.ok) {
        setDirOptIn(next);
        if (data.seafarer && onSeafarer) onSeafarer(data.seafarer as Seafarer);
      } else {
        setDirError(data.error ?? "Could not update. Sign in to change this.");
      }
    } catch {
      setDirError("Could not update. Check your connection and try again.");
    } finally {
      setDirBusy(false);
    }
  }

  // The latest PENDING proposal per field (so each field shows at most one "waiting").
  const pendingByField = useMemo(() => {
    const m = new Map<string, ProfileChangeRequest>();
    for (const c of changes) {
      if (c.status === "pending") m.set(c.field, c);
    }
    return m;
  }, [changes]);

  const pendingCount = pendingByField.size;

  function startEdit(f: SelfServiceFieldDef) {
    setEditing(f.key as SelfServiceFieldKey);
    setDraft(profile[f.key as SelfServiceFieldKey] ?? "");
    setNote("");
    setError(null);
    setBanner(null);
  }

  async function propose(field: SelfServiceFieldKey) {
    setBusy(true);
    setError(null);
    setBanner(null);
    try {
      const res = await fetch("/api/profile-updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId, token, field, proposedValue: draft, note: note.trim() || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        onChanges(data.changes as ProfileChangeRequest[]);
        setEditing(null);
        setDraft("");
        setNote("");
        setBanner("Sent to your agent for approval. It updates once they approve.");
      } else {
        setError(data.error ?? "Could not send the update.");
      }
    } catch {
      setError("Could not send the update. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile-updates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision: "cancel", seafarerId, token }),
      });
      const data = await res.json();
      if (data.ok) onChanges(data.changes as ProfileChangeRequest[]);
      else setError(data.error ?? "Could not withdraw the proposal.");
    } catch {
      setError("Could not withdraw. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // The most recent NON-pending outcome per field (to show "rejected — reason").
  const lastDecisionByField = useMemo(() => {
    const m = new Map<string, ProfileChangeRequest>();
    for (const c of changes) {
      if (c.status === "approved" || c.status === "rejected") {
        const prev = m.get(c.field);
        if (!prev || (c.decidedAt ?? c.createdAt) > (prev.decidedAt ?? prev.createdAt)) m.set(c.field, c);
      }
    }
    return m;
  }, [changes]);

  return (
    <section className="mt-8" data-testid="profile-self-service">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="profile-self-service-toggle"
        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-left hover:bg-slate-50"
      >
        <span className="flex items-center gap-2">
          <span className="font-semibold text-slate-900">Personal &amp; bank details</span>
          {pendingCount > 0 && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
              {pendingCount} awaiting approval
            </span>
          )}
        </span>
        <span className="text-sm text-slate-400">{open ? "Hide" : "Edit"}</span>
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-500">
            Keep your contact, next-of-kin and payroll details current so your agency
            never has to re-ask. Changes are sent to your agent and take effect once
            they approve them.
          </p>

          {banner && (
            <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800" data-testid="profile-self-service-banner">
              {banner}
            </p>
          )}
          {error && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" data-testid="profile-self-service-error">
              {error}
            </p>
          )}

          <div className="mt-4 space-y-5">
            {fieldGroups().map(({ group, fields }) => (
              <div key={group}>
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">{group}</h3>
                <ul className="mt-2 space-y-2">
                  {fields.map((f) => {
                    const key = f.key as SelfServiceFieldKey;
                    const current = profile[key] ?? null;
                    const pending = pendingByField.get(key) ?? null;
                    const decided = lastDecisionByField.get(key) ?? null;
                    const isEditing = editing === key;
                    return (
                      <li
                        key={key}
                        data-testid="profile-field-row"
                        data-field={key}
                        className="rounded-lg border border-slate-200 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-slate-500">{f.label}</p>
                            <p className="text-sm text-slate-800">
                              {current ? current : <span className="italic text-slate-400">Not set</span>}
                            </p>
                            {f.hint ? <p className="mt-0.5 text-[11px] text-slate-400">{f.hint}</p> : null}
                          </div>
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => startEdit(f)}
                              data-testid="profile-field-edit"
                              className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                            >
                              {current ? "Change" : "Add"}
                            </button>
                          )}
                        </div>

                        {pending && !isEditing && (
                          <div
                            data-testid="profile-field-pending"
                            className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800 ring-1 ring-amber-200"
                          >
                            <span>
                              Waiting for approval →{" "}
                              <span className="font-semibold">
                                {pending.proposedValue ? pending.proposedValue : "(clear this field)"}
                              </span>
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => cancel(pending.id)}
                              data-testid="profile-field-withdraw"
                              className="rounded px-2 py-0.5 font-semibold text-amber-800 underline hover:text-amber-900 disabled:opacity-50"
                            >
                              Withdraw
                            </button>
                          </div>
                        )}

                        {decided && !pending && !isEditing && decided.status === "rejected" && (
                          <p
                            data-testid="profile-field-rejected"
                            className="mt-2 rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700 ring-1 ring-rose-200"
                          >
                            Your last change was rejected{decided.decidedAt ? ` on ${fmtWhen(decided.decidedAt)}` : ""}
                            {decided.decisionNote ? ` — ${decided.decisionNote}` : ""}.
                          </p>
                        )}

                        {isEditing && (
                          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="profile-field-editor">
                            <label className="block text-xs font-medium text-slate-600">
                              New {f.label.toLowerCase()}
                              <input
                                type={f.kind === "tel" ? "tel" : "text"}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                data-testid="profile-field-input"
                                placeholder="Leave blank to clear this detail"
                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                              />
                            </label>
                            <label className="mt-2 block text-xs font-medium text-slate-600">
                              Note to your agent (optional)
                              <input
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                data-testid="profile-field-note"
                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                              />
                            </label>
                            <div className="mt-2 flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => { setEditing(null); setDraft(""); setNote(""); }}
                                className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => propose(key)}
                                data-testid="profile-field-propose"
                                className="rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                              >
                                {busy ? "Sending…" : "Send for approval"}
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {directoryOptIn !== undefined && (
        <div
          data-testid="directory-opt-in-section"
          className="mt-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <label
            data-testid="directory-opt-in"
            data-on={dirOptIn ? "true" : "false"}
            className={`flex min-h-[44px] items-center justify-between gap-3 ${
              dirBusy ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            }`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">
                List me in the docka-verified directory
              </span>
              {/* Current-state pill so the on/off status is unmistakable [F2]. */}
              <span
                data-testid="directory-opt-in-state"
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
                  dirOptIn
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                    : "bg-slate-100 text-slate-500 ring-slate-200"
                }`}
              >
                {dirOptIn ? "On — visible to clients" : "Off — hidden"}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={dirOptIn}
              disabled={dirBusy}
              onChange={(e) => void toggleDirectory(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="relative h-6 w-11 flex-shrink-0 rounded-full bg-slate-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-brand-600 peer-checked:after:translate-x-5"
            />
          </label>
          {/* Body leads with the consequence (no repeated "List me…" opener) [F3], is
              darker + larger for mobile [F4], and states the opt-in default plainly [F1]. */}
          <p className="mt-2 text-sm text-slate-700">
            Signed-in shipowner clients can find you by name and see your rank, issuing country
            and verification level — and can copy or save what they see. You are not listed
            unless you turn this on; it is off by default. Turning it off stops new views, but
            can&apos;t un-see what was already shown.
          </p>
          {/* Dual-consent note [F5]. */}
          <p className="mt-1.5 text-sm text-slate-700">
            You appear only after an agency you&apos;ve shared with also refers you to the
            directory.
          </p>
          {/* Directory vs a single client portal, in one line [F6]. */}
          <p className="mt-1.5 text-xs text-slate-500">
            The docka-verified directory is searchable by many signed-in clients — different from
            an agency&apos;s client portal, which is one link shown to one client.
          </p>
          {identityVerified !== true && (
            <p className="mt-2 text-xs text-amber-700" data-testid="directory-opt-in-blocked">
              You need a government-verified identity before you can be listed.
            </p>
          )}
          {dirError && <p className="mt-1 text-xs text-rose-600">{dirError}</p>}
        </div>
      )}
    </section>
  );
}
