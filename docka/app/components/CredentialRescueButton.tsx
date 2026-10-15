"use client";

// feat/password-signup Step 14 — the admin "unbind credential + reissue claim
// link" control on the per-seaman drill-down. Rendered ONLY for a purely
// password-owned profile (credentialUserId set, neither googleSub nor
// ownerEmail — the co-owned shape shows "Google-owned; recover via Google
// sign-in" instead, v6 fold 2). Explicit confirm before firing: this cuts off
// the old password for good. Admin surface — English-only, matching the
// existing admin pages.

import { useState } from "react";

export function CredentialRescueButton({ seafarerId }: { seafarerId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    claimLink: string;
    orphanDeleted: boolean;
    freedUsername: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  async function runRescue() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/credential-rescue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seafarerId }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (data && data.ok === true && typeof data.claimLink === "string") {
        setDone({
          claimLink: data.claimLink,
          orphanDeleted: data.orphanDeleted === true,
          freedUsername: typeof data.freedUsername === "string" ? data.freedUsername : null,
        });
      } else {
        setError("Rescue failed — the profile may not be rescuable.");
      }
    } catch {
      setError("Network error — nothing was changed unless a link is shown.");
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  function copyLink(link: string) {
    try {
      void navigator.clipboard?.writeText(link).then(
        () => setCopied(true),
        () => {}
      );
    } catch {
      /* selectable text below is the fallback */
    }
  }

  if (done) {
    return (
      <div
        className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"
        data-testid="rescue-done"
      >
        <p className="font-semibold text-emerald-800">Credential unbound — new claim link:</p>
        <p className="mt-1 select-all break-all font-mono text-xs text-slate-800" data-testid="rescue-link">
          {done.claimLink}
        </p>
        <button
          type="button"
          onClick={() => copyLink(done.claimLink)}
          className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {copied ? "Copied ✓" : "Copy link"}
        </button>
        <p className="mt-2 text-xs text-emerald-800">
          Every old claim link and the old password are dead. Hand this link to the
          seafarer (or their agent) — opening it and signing up binds this same profile
          with all its documents.
          {done.orphanDeleted && (
            <>
              {" "}
              The old account was deleted
              {done.freedUsername ? (
                <>
                  {" "}
                  — the username <span className="font-mono">{done.freedUsername}</span> is free to
                  re-register.
                </>
              ) : (
                "."
              )}
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="rescue-control">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
          data-testid="rescue-open"
        >
          Reissue claim link
        </button>
      ) : (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
          <p className="font-medium text-rose-800">
            Unbind this password account and mint a fresh claim link? The old password and
            all old claim links stop working immediately.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void runRescue()}
              disabled={pending}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
              data-testid="rescue-confirm"
            >
              {pending ? "Working…" : "Unbind + reissue"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
