"use client";

// feat/password-signup Step 13 — signed-in account management for PASSWORD
// accounts only (Google users have nothing to manage here): change password
// (13a) and regenerate recovery codes (13b). Rendered on the seaman profile
// page (among the signedIn-gated sections) and on /agent/settings/account.
//
// Design rules carried from the form family (Steps 7/8): real <form> submit
// semantics + autocomplete current-password/new-password (fold 14), ONE form
// pair in the DOM at a time (inactive modes unmount), 44px tap targets,
// pending+disabled while in flight, network failure keeps typed state.
//
// Change-password flow (plan Step 13a): the server stamps passwordChangedAt —
// every OTHER outstanding JWT goes stale at the Step 5 gates; the CURRENT
// client immediately re-signIns with the new password to re-mint its own
// token. Failure arm (v6 fold 8a): if that re-signIn leg fails (2G drop,
// anything) the change has still committed — render pw.pwChangedSignIn, never
// an error or a retry loop.
//
// Regeneration (13b) re-runs the SAME one-time ceremony screen as signup
// (RecoveryCodesScreen — fold 2, incl. the username) with pw.regenTitle /
// pw.regenWarn. This is the landing target of the codes-lost steer and the
// pw.lowCodes warning.

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useT } from "@/components/LanguageProvider";
import { RecoveryCodesScreen } from "@/components/SeamanPasswordAuth";

type Side = "seaman" | "agent";
type Mode = "idle" | "change" | "regen";

export function AccountSecurity({ username, side }: { username: string; side: Side }) {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>("idle");
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<{ username: string; codes: string[] } | null>(null);

  const inputCls =
    "mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
  const labelCls = "block text-left text-sm font-medium text-slate-700";
  const primaryBtnCls =
    "mt-4 w-full min-h-[44px] rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60";
  const openerBtnCls =
    "min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setCurrentPw("");
    setNewPw("");
  }

  async function reSignIn(password: string): Promise<boolean> {
    try {
      const res = await signIn("credentials", {
        redirect: false,
        identifier: username,
        password,
        side,
        adoptToken: "",
      });
      return !!res && res.error == null; // wave-2 contract: error != null = failure
    } catch {
      return false;
    }
  }

  async function submitChange(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (newPw.length < 8 || newPw.length > 256) {
      setError("pw.errWeak");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/account/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (data && data.ok === true) {
        // Committed — every OTHER session is now stale. Re-mint OUR token; the
        // failure arm is the honest pw.pwChangedSignIn (v6 fold 8a).
        const ok = await reSignIn(newPw);
        switchMode("idle");
        setNotice(ok ? "pw.pwChangedOk" : "pw.pwChangedSignIn");
        return;
      }
      const key = data && typeof data.errorKey === "string" ? data.errorKey : "pw.errGeneric";
      setError(key);
    } catch {
      setError("pw.errNetwork");
    } finally {
      setPending(false);
    }
  }

  async function submitRegen(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const res = await fetch("/api/account/regenerate-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPw }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (data && data.ok === true && Array.isArray(data.recoveryCodes)) {
        setCurrentPw("");
        setCeremony({
          username: typeof data.username === "string" ? data.username : username,
          codes: data.recoveryCodes as string[],
        });
        return;
      }
      const key = data && typeof data.errorKey === "string" ? data.errorKey : "pw.errGeneric";
      setError(key);
    } catch {
      setError("pw.errNetwork");
    } finally {
      setPending(false);
    }
  }

  if (ceremony) {
    // The identical one-time ceremony screen (fold 2) — old codes are already
    // void (pw.regenWarn says so, loudly).
    return (
      <RecoveryCodesScreen
        username={ceremony.username}
        codes={ceremony.codes}
        titleKey="pw.regenTitle"
        warnKey="pw.regenWarn"
        onConfirm={() => {
          setCeremony(null);
          switchMode("idle");
        }}
      />
    );
  }

  return (
    <div className="text-left" data-testid="account-security">
      <p className="text-sm font-semibold text-slate-800">{t("pw.accountTitle")}</p>

      {notice && (
        <p
          className="mt-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800"
          data-testid="account-notice"
        >
          {t(notice)}
        </p>
      )}

      {mode === "idle" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => switchMode("change")}
            className={openerBtnCls}
            data-testid="account-open-change"
          >
            {t("pw.changePw")}
          </button>
          <button
            type="button"
            onClick={() => switchMode("regen")}
            className={openerBtnCls}
            data-testid="account-open-regen"
          >
            {t("pw.regenTitle")}
          </button>
        </div>
      )}

      {/* ONE form pair in the DOM at a time (fold 14): inactive modes unmount. */}
      {mode === "change" && (
        <form onSubmit={submitChange} className="mt-3" data-testid="account-change-form">
          <label className={labelCls}>
            {t("pw.currentPw")}
            <input
              type={showPw ? "text" : "password"}
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              autoComplete="current-password"
              required
              className={inputCls}
              data-testid="account-current-pw"
            />
          </label>
          <label className={`${labelCls} mt-3`}>
            {t("pw.newPassword")}
            <input
              type={showPw ? "text" : "password"}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              autoComplete="new-password"
              required
              className={inputCls}
              data-testid="account-new-pw"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">{t("pw.passwordHint")}</p>
          <label className="mt-1 flex min-h-[44px] items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showPw}
              onChange={(e) => setShowPw(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            {t("pw.showPassword")}
          </label>
          {error && (
            <p className="mt-2 text-sm font-medium text-rose-600" data-testid="account-error">
              {t(error)}
            </p>
          )}
          <button type="submit" disabled={pending} className={primaryBtnCls} data-testid="account-change-submit">
            {pending ? "…" : t("pw.changePw")}
          </button>
          <button
            type="button"
            onClick={() => switchMode("idle")}
            disabled={pending}
            className="mt-2 w-full min-h-[44px] text-sm font-medium text-slate-500 underline-offset-2 hover:underline"
          >
            {t("sd.cancel")}
          </button>
        </form>
      )}

      {mode === "regen" && (
        <form onSubmit={submitRegen} className="mt-3" data-testid="account-regen-form">
          {/* The warning BEFORE the act too: old codes die on success. */}
          <p className="text-sm text-slate-700">{t("pw.regenWarn")}</p>
          <label className={`${labelCls} mt-3`}>
            {t("pw.currentPw")}
            <input
              type={showPw ? "text" : "password"}
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              autoComplete="current-password"
              required
              className={inputCls}
              data-testid="account-regen-pw"
            />
          </label>
          <label className="mt-1 flex min-h-[44px] items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showPw}
              onChange={(e) => setShowPw(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            {t("pw.showPassword")}
          </label>
          {error && (
            <p className="mt-2 text-sm font-medium text-rose-600" data-testid="account-error">
              {t(error)}
            </p>
          )}
          <button type="submit" disabled={pending} className={primaryBtnCls} data-testid="account-regen-submit">
            {pending ? "…" : t("pw.regenTitle")}
          </button>
          <button
            type="button"
            onClick={() => switchMode("idle")}
            disabled={pending}
            className="mt-2 w-full min-h-[44px] text-sm font-medium text-slate-500 underline-offset-2 hover:underline"
          >
            {t("sd.cancel")}
          </button>
        </form>
      )}
    </div>
  );
}
