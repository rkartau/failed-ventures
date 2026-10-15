"use client";

// feat/password-signup Steps 7/8 — the password create/sign-in form family.
// PasswordAuthCore is the ONE implementation; SeamanPasswordAuth (side:"seaman",
// adopt token + claim mode) and AgentPasswordAuth (side:"agent", no token) wrap it.
//
// Design constraints carried from the plan (v6):
//  - OLD-WEBVIEW SAFE (fold 5): client validation is ES5-safe — NO \p{...}
//    Unicode-property regex anywhere in this bundle (2016-era WebViews throw at
//    PARSE time). The client checks ONLY length / whitespace / `@`; the server
//    stays authoritative with the full D5 rules.
//  - iOS/password-manager conventions (fold 14): real <form> submit semantics,
//    autocomplete username/new-password/current-password/email, ONE form pair
//    in the DOM per tab state (inactive tabs UNMOUNT — never display:none),
//    tap targets ≥ 44px (min-h-[44px] on every actionable control).
//  - Slow-network safety (Wahyu): single-step forms, all state in component
//    state, disabled+busy while pending, a network failure renders pw.errNetwork
//    inline and leaves every field intact. No redirects on failure.
//  - Lost-response recovery (folds 6/7): a network-level signup failure persists
//    a commit marker in localStorage ({usernameLower, side, ts} ONLY — never a
//    secret; schema pinned by test). A later retry of the SAME username that
//    answers pw.errTaken auto-signs-in; success ⇒ the codes-lost screen; ANY
//    auto-sign-in failure ⇒ plain pw.errTaken + pw.errTakenHint (v4 collapse —
//    one arm, no 429 detection, no retry loop).
//  - Clipboard degrade (fold 5): copy-all failure is INVISIBLE — guidance is
//    write-down/screenshot-first.

import { useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useT } from "@/components/LanguageProvider";
import { track } from "@/lib/analytics-events";
import { getToken } from "@/lib/seamanToken";
import {
  buildSignupCommitMarker,
  markerMatches,
  parseSignupCommitMarker,
} from "@/lib/signup-marker";

type Side = "seaman" | "agent";

// localStorage key for the committed-signup marker (fold 6). Same storage the
// adopt token already uses; survives a webview kill between attempts.
const MARKER_KEY = "docka:pw-signup-marker";

function readMarkerRaw(): string | null {
  try {
    return localStorage.getItem(MARKER_KEY);
  } catch {
    return null;
  }
}
function saveMarker(marker: { usernameLower: string; side: Side; ts: number }): void {
  try {
    localStorage.setItem(MARKER_KEY, JSON.stringify(marker));
  } catch {
    /* storage unavailable — the retry simply won't detect the race (accepted) */
  }
}
function clearMarker(): void {
  try {
    localStorage.removeItem(MARKER_KEY);
  } catch {
    /* best-effort */
  }
}

// ES5-safe client-side username check (server authoritative — D5 full rules
// live in lib/credential-auth.ts). Length is JS code units here; the server
// counts code points — close enough for a hint, and the server always wins.
function clientValidateUsername(u: string): string | null {
  const v = u.trim();
  if (v.indexOf("@") >= 0) return "pw.errUserAt";
  if (v.length < 3 || v.length > 32) return "pw.errUserRules";
  if (/\s/.test(v)) return "pw.errUserRules";
  return null;
}

/** XXXXX-XXXXX display grouping for a 10-char recovery code. */
function groupCode(code: string): string {
  return code.length === 10 ? code.slice(0, 5) + "-" + code.slice(5) : code;
}

/**
 * The one-time recovery-codes ceremony screen (fold 2) — THE one
 * implementation, used by the signup flow below AND by Step 13's regeneration
 * (AccountSecurity.tsx) with pw.regenTitle/pw.regenWarn. Shows the USERNAME
 * prominently (a codes screenshot without it is useless months later), the 8
 * codes grouped XXXXX-XXXXX in selectable monospace with a tap-select-all
 * fallback, a copy-all button whose clipboard failure is INVISIBLE (fold 5 —
 * guidance is write-down/screenshot-first), and requires an explicit confirm
 * tap before continuing.
 */
export function RecoveryCodesScreen({
  username,
  codes,
  titleKey = "pw.recTitle",
  warnKey,
  confirmKey = "pw.recConfirm",
  onConfirm,
}: {
  username: string;
  codes: string[];
  /** pw.recTitle (signup) or pw.regenTitle (Step 13 regeneration). */
  titleKey?: string;
  /** Extra loud line — pw.regenWarn ("your old codes stop working now"). */
  warnKey?: string;
  confirmKey?: string;
  onConfirm: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const codesRef = useRef<HTMLDivElement>(null);

  // ---- copy-all with silent clipboard degradation (fold 5) ------------------
  function copyAllCodes() {
    const text = username + "\n" + codes.map(groupCode).join("\n");
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (clip && typeof clip.writeText === "function") {
        clip.writeText(text).then(
          () => setCopied(true),
          () => {
            /* WeChat-webview clipboard failure is INVISIBLE — screenshot-first guidance */
          }
        );
      }
    } catch {
      /* invisible degrade */
    }
  }

  function selectAllCodes() {
    // Select-all fallback for the codes block (fold 2) — tap selects everything
    // so long-press copy works where the clipboard API doesn't.
    try {
      const node = codesRef.current;
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (node && sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(node);
        sel.addRange(range);
      }
    } catch {
      /* best-effort */
    }
  }

  return (
    <div
      className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-left"
      data-testid="pw-codes-screen"
    >
      <p className="text-base font-bold text-slate-900">{t(titleKey)}</p>
      {warnKey && (
        <p className="mt-1 text-sm font-semibold text-rose-700" data-testid="pw-codes-warn">
          {t(warnKey)}
        </p>
      )}
      {/* The username belongs ON the codes artifact (fold 2): a screenshot
          without it is useless when the seafarer returns months later. */}
      <p
        className="mt-2 select-text break-all font-mono text-lg font-bold text-slate-900"
        data-testid="pw-codes-username"
      >
        {username}
      </p>
      <div
        ref={codesRef}
        onClick={selectAllCodes}
        className="mt-3 select-text rounded-xl border border-slate-200 bg-white p-3 font-mono text-base leading-7 text-slate-800"
        data-testid="pw-codes-list"
      >
        {codes.map((c) => (
          <div key={c}>{groupCode(c)}</div>
        ))}
      </div>
      <button
        type="button"
        onClick={copyAllCodes}
        className="mt-2 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
        data-testid="pw-copy-all"
      >
        {t("pw.copyAll")}
        {copied ? " ✓" : ""}
      </button>
      <p className="mt-3 text-sm text-slate-700">{t("pw.recBody")}</p>
      <p className="mt-2 text-sm text-slate-700">{t("pw.recSaved")}</p>
      <button
        type="button"
        onClick={() => void onConfirm()}
        className="mt-4 w-full min-h-[44px] rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
        data-testid="pw-codes-confirm"
      >
        {t(confirmKey)}
      </button>
    </div>
  );
}

async function signInCredentials(values: {
  identifier: string;
  password: string;
  side: Side;
  adoptToken?: string | null;
}): Promise<boolean> {
  try {
    const res = await signIn("credentials", {
      redirect: false,
      identifier: values.identifier,
      password: values.password,
      side: values.side,
      adoptToken: values.adoptToken ?? "",
    });
    // Wave-2 contract: failure detection is `error != null` (ok/status unreliable).
    return !!res && res.error == null;
  } catch {
    return false;
  }
}

type Screen =
  | { kind: "form" }
  | { kind: "codes"; username: string; codes: string[] }
  | { kind: "codesLost" }
  | { kind: "bindConfirm" }
  | { kind: "resetDone"; remainingCodes: number; signedInOk: boolean };

type Tab = "create" | "signin" | "forgot";

export function PasswordAuthCore({
  side,
  claimMode = false,
  onSignedIn,
  defaultTab,
  leadToken,
}: {
  side: Side;
  /** Seaman claim-link mode: NO silent fresh-create without a readable token (fold 7). */
  claimMode?: boolean;
  onSignedIn: () => void | Promise<void>;
  /** Explicit override of the initial tab. When omitted (2026-08-14): the
      default visible tab is Sign in — EXCEPT claim mode with a readable adopt
      token (agent-invited new user), where the create/adopt tab stays default. */
  defaultTab?: "create" | "signin";
  /** Outreach CTA attribution token (Increment 5) — the /signup landing passes
      it through AFTER a server-side verify; it rides the signup POST as a
      hidden field. The server RE-verifies (never trusts this prop); absent or
      invalid ⇒ the signup proceeds with attribution dropped. */
  leadToken?: string | null;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(() => {
    if (defaultTab) return defaultTab;
    // readAdoptToken (hoisted below) is null on the agent side and outside a
    // readable claim context; the toggle keeps both tabs reachable either way.
    return claimMode && readAdoptToken() ? "create" : "signin";
  });
  const [screen, setScreen] = useState<Screen>({ kind: "form" });

  // Shared across tabs so errTaken-steering ("Sign in" button) keeps typed values.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [showPw, setShowPw] = useState(false);
  // Forgot-password fields.
  const [recCode, setRecCode] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTakenHint, setShowTakenHint] = useState(false);
  const [steer, setSteer] = useState(false);

  // GA4 funnel (2026-09-07): `sign_up_start` on the FIRST focus/input inside the
  // agent CREATE form, once per mount; nothing on the sign-in tab. Agent-side only
  // (the seafarer form is mounted on /seafarer, a private path, where track() is a
  // no-op anyway). The event carries no field values — only step:"agent".
  const signUpStartSent = useRef(false);
  function markSignUpStart() {
    if (side !== "agent" || signUpStartSent.current) return;
    signUpStartSent.current = true;
    track("sign_up_start", { step: "agent" });
  }

  // Adopt token (seaman only): localStorage getToken() with the claim-URL
  // ?token= parameter as fallback (fold 6 — webview storage loss must not
  // silently fork profiles).
  function readAdoptToken(): string | null {
    if (side !== "seaman") return null;
    try {
      const stored = getToken();
      if (stored) return stored;
      const fromUrl = new URLSearchParams(window.location.search).get("token");
      return fromUrl || null;
    } catch {
      return null;
    }
  }

  function resetMessages() {
    setError(null);
    setShowTakenHint(false);
    setSteer(false);
  }

  function switchTab(next: Tab) {
    resetMessages();
    setTab(next);
    setScreen({ kind: "form" });
  }

  // ---- signup POST (also the bindConfirm resubmit) --------------------------
  async function postSignup(confirmBind: boolean) {
    resetMessages();
    setPending(true);
    const uname = username.trim();
    const adoptToken = readAdoptToken();
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          username: uname,
          password,
          email: email.trim() || undefined,
          adoptToken: adoptToken || undefined,
          ...(confirmBind ? { confirmBind: true } : {}),
          ...(leadToken ? { leadToken } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

      if (data && data.ok === true && Array.isArray(data.recoveryCodes)) {
        // Created. GA4 `sign_up` (agent password signups only; PII-free) fires here,
        // at the same moment the server wrote the first-party `signup` event and
        // BEFORE the sign-in leg. Never in the bound===true side-bind branch below
        // (an existing account), and never in the codesLost path (the server did
        // not confirm a creation in THAT response).
        if (side === "agent") track("sign_up", { method: "password" });
        // D10: immediately sign in with the same values (no retyping),
        // then hold on the one-time codes ceremony until the explicit confirm.
        clearMarker();
        await signInCredentials({ identifier: uname, password, side, adoptToken });
        setScreen({
          kind: "codes",
          username: typeof data.username === "string" ? data.username : uname,
          codes: data.recoveryCodes as string[],
        });
        return;
      }
      if (data && data.ok === true && data.bound === true) {
        // Explicit side-bind succeeded — existing account, NO new codes.
        const ok = await signInCredentials({ identifier: uname, password, side, adoptToken });
        if (ok) {
          await onSignedIn();
        } else {
          setScreen({ kind: "form" });
          setTab("signin");
          setError("pw.errGeneric");
        }
        return;
      }
      if (data && data.ok === false && data.needsBindConfirm === true) {
        setScreen({ kind: "bindConfirm" });
        return;
      }

      const key = data && typeof data.errorKey === "string" ? data.errorKey : "pw.errGeneric";
      setScreen({ kind: "form" });
      if (key === "pw.errTaken") {
        // Codes-lost race (folds 6/7): a marker from a network-failed submit of
        // the SAME username+side means the server may have committed that
        // signup. Try signing in with the values just typed.
        const marker = parseSignupCommitMarker(readMarkerRaw());
        if (markerMatches(marker, { username: uname, side })) {
          const ok = await signInCredentials({ identifier: uname, password, side, adoptToken });
          if (ok) {
            clearMarker();
            setScreen({ kind: "codesLost" });
            return;
          }
          // v4 collapse — ONE failure arm, no discrimination (wrong password,
          // 429, anything): plain errTaken + hint. NO codes-lost, NO retry loop.
          setError("pw.errTaken");
          setShowTakenHint(true);
          setSteer(true);
          return;
        }
        setError("pw.errTaken");
        setSteer(true); // fold 4 — "is it you?" steering to Sign in / Forgot
        return;
      }
      setError(key);
    } catch {
      // Network-level failure: the signup MAY have committed server-side while
      // the response (carrying the only plaintext codes) was lost. Persist the
      // marker so a later retry — even after a webview kill — lands on the
      // defined codes-lost path. Never a secret in the marker (fold 7).
      saveMarker(buildSignupCommitMarker({ username: uname, side }));
      setError("pw.errNetwork");
    } finally {
      setPending(false);
    }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    const uErr = clientValidateUsername(username);
    if (uErr) {
      setError(uErr);
      return;
    }
    if (password.length < 8 || password.length > 256) {
      setError("pw.errWeak");
      return;
    }
    // Claim-context guard (fold 7): in claim mode with NO readable token
    // (storage AND URL both empty) do NOT silently fresh-create.
    if (claimMode && !readAdoptToken()) {
      setError("pw.claimNoToken");
      return;
    }
    await postSignup(false);
  }

  async function submitSignIn(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    const uname = username.trim();
    if (!uname || !password) {
      setError("pw.errGeneric");
      return;
    }
    setPending(true);
    try {
      const ok = await signInCredentials({
        identifier: uname,
        password,
        side,
        adoptToken: readAdoptToken(),
      });
      if (ok) {
        await onSignedIn();
      } else {
        setError("pw.errGeneric"); // generic — never distinguishes which part failed
      }
    } catch {
      setError("pw.errNetwork");
    } finally {
      setPending(false);
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    const uname = username.trim();
    if (!uname || !recCode.trim()) {
      setError("pw.errRecovery");
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 256) {
      setError("pw.errWeak");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/recovery-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: uname, code: recCode, newPassword }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (data && data.ok === true) {
        const remaining = typeof data.remainingCodes === "number" ? data.remainingCodes : 0;
        // The reset committed. Sign in with the NEW password; if that leg fails
        // (network drop, side unbound on a dual-role account, …) the honest
        // outcome is pw.pwChangedSignIn — never an error or a retry loop.
        const ok = await signInCredentials({
          identifier: uname,
          password: newPassword,
          side,
          adoptToken: readAdoptToken(),
        });
        setPassword(newPassword); // convenience for the sign-in tab fallback
        setNewPassword("");
        setRecCode("");
        setScreen({ kind: "resetDone", remainingCodes: remaining, signedInOk: ok });
      } else {
        setError("pw.errRecovery"); // one generic key — no oracle for which part failed
      }
    } catch {
      setError("pw.errNetwork");
    } finally {
      setPending(false);
    }
  }

  // ---- shared bits ----------------------------------------------------------
  const inputCls =
    "mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
  const primaryBtnCls =
    "mt-4 w-full min-h-[44px] rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60";
  const secondaryBtnCls =
    "min-h-[44px] flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50";
  const labelCls = "block text-left text-sm font-medium text-slate-700";

  const errorBlock = (error || steer) && (
    <div className="mt-3 text-left" data-testid="pw-error">
      {error && <p className="text-sm font-medium text-rose-600">{t(error)}</p>}
      {showTakenHint && (
        <p className="mt-1 text-sm text-slate-600" data-testid="pw-taken-hint">
          {t("pw.errTakenHint")}
        </p>
      )}
      {steer && (
        <div className="mt-2" data-testid="pw-taken-steer">
          <p className="text-sm text-slate-700">{t("pw.errTakenSteer")}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => switchTab("signin")} className={secondaryBtnCls}>
              {t("pw.signIn")}
            </button>
            <button type="button" onClick={() => switchTab("forgot")} className={secondaryBtnCls}>
              {t("pw.forgot")}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const showToggle = (
    <label className="mt-1 flex min-h-[44px] items-center gap-2 text-sm text-slate-600">
      <input
        type="checkbox"
        checked={showPw}
        onChange={(e) => setShowPw(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
      {t("pw.showPassword")}
    </label>
  );

  // ---- screens --------------------------------------------------------------

  if (screen.kind === "codes") {
    return (
      <RecoveryCodesScreen
        username={screen.username}
        codes={screen.codes}
        onConfirm={() => void onSignedIn()}
      />
    );
  }

  if (screen.kind === "codesLost") {
    return (
      <div
        className="rounded-2xl border-2 border-rose-300 bg-rose-50 p-4 text-left"
        data-testid="pw-codeslost-screen"
      >
        <p className="text-base font-bold text-slate-900">{t("pw.codesLostTitle")}</p>
        <p className="mt-2 text-sm text-slate-700">{t("pw.codesLostBody")}</p>
        <button
          type="button"
          onClick={() => void onSignedIn()}
          className={primaryBtnCls}
          data-testid="pw-codeslost-continue"
        >
          {t("pw.continue")}
        </button>
      </div>
    );
  }

  if (screen.kind === "bindConfirm") {
    return (
      <div
        className="rounded-2xl border border-slate-300 bg-white p-4 text-left shadow-sm"
        data-testid="pw-bind-confirm"
      >
        <p className="text-base font-bold text-slate-900">{t("pw.bindSideTitle")}</p>
        <p className="mt-2 text-sm text-slate-700">{t("pw.bindSideBody")}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setScreen({ kind: "form" });
              resetMessages();
            }}
            disabled={pending}
            className={secondaryBtnCls}
          >
            {t("sd.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void postSignup(true)}
            disabled={pending}
            className="min-h-[44px] flex-1 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
            data-testid="pw-bind-confirm-yes"
          >
            {pending ? "…" : t("row.confirm")}
          </button>
        </div>
        {errorBlock}
      </div>
    );
  }

  if (screen.kind === "resetDone") {
    const low = screen.remainingCodes <= 2;
    return (
      <div
        className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-left"
        data-testid="pw-reset-done"
      >
        <p className="text-sm font-semibold text-slate-900">
          {t("pw.recRemaining", { n: screen.remainingCodes })}
        </p>
        {low && (
          <p
            className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800"
            data-testid="pw-low-codes"
          >
            {t("pw.lowCodes", { n: screen.remainingCodes })}
          </p>
        )}
        {screen.signedInOk ? (
          <button
            type="button"
            onClick={() => void onSignedIn()}
            className={primaryBtnCls}
            data-testid="pw-reset-continue"
          >
            {t("pw.continue")}
          </button>
        ) : (
          <>
            <p className="mt-2 text-sm text-slate-700" data-testid="pw-changed-signin">
              {t("pw.pwChangedSignIn")}
            </p>
            <button type="button" onClick={() => switchTab("signin")} className={primaryBtnCls}>
              {t("pw.signIn")}
            </button>
          </>
        )}
      </div>
    );
  }

  // ---- the tabbed form ------------------------------------------------------
  const tabBtn = (which: "create" | "signin", label: string) => (
    <button
      type="button"
      onClick={() => switchTab(which)}
      aria-selected={tab === which}
      data-testid={`pw-tab-${which}`}
      className={
        "min-h-[44px] flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition " +
        (tab === which
          ? "bg-white text-slate-900 shadow-sm"
          : "text-slate-500 hover:text-slate-700")
      }
    >
      {label}
    </button>
  );

  return (
    <div className="text-left" data-testid={`pw-auth-${side}`}>
      {tab !== "forgot" && (
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {tabBtn("create", t("pw.createTitle"))}
          {tabBtn("signin", t("pw.signInTitle"))}
        </div>
      )}

      {/* ONE username+password form pair in the DOM per tab state (fold 14):
          the inactive tabs are unmounted, never hidden with CSS. */}
      {tab === "create" && (
        <form
          onSubmit={submitCreate}
          onFocusCapture={markSignUpStart}
          onInput={markSignUpStart}
          className="mt-3"
          data-testid="pw-create-form"
        >
          <label className={labelCls}>
            {t("pw.username")}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className={inputCls}
              data-testid="pw-username"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">{t("pw.usernameHint")}</p>
          <label className={`${labelCls} mt-3`}>
            {t("pw.password")}
            <input
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              className={inputCls}
              data-testid="pw-password"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">{t("pw.passwordHint")}</p>
          {showToggle}
          <label className={`${labelCls} mt-3`}>
            {t("pw.email")}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={inputCls}
              data-testid="pw-email"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">{t("pw.emailOptionalNote")}</p>
          {side === "seaman" && (
            <p className="mt-2 text-xs text-slate-500">{t("pw.selfDeclaredNote")}</p>
          )}
          <p className="mt-2 text-xs text-slate-500">{t("pw.dualRoleNote")}</p>
          {errorBlock}
          <button type="submit" disabled={pending} className={primaryBtnCls} data-testid="pw-create-submit">
            {pending ? "…" : t("pw.create")}
          </button>
        </form>
      )}

      {tab === "signin" && (
        <form onSubmit={submitSignIn} className="mt-3" data-testid="pw-signin-form">
          <label className={labelCls}>
            {t("pw.username")}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className={inputCls}
              data-testid="pw-signin-username"
            />
          </label>
          <label className={`${labelCls} mt-3`}>
            {t("pw.password")}
            <input
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className={inputCls}
              data-testid="pw-signin-password"
            />
          </label>
          {showToggle}
          <p className="mt-2 text-xs text-slate-500">{t("pw.dualRoleNote")}</p>
          {errorBlock}
          <button type="submit" disabled={pending} className={primaryBtnCls} data-testid="pw-signin-submit">
            {pending ? "…" : t("pw.signIn")}
          </button>
          <button
            type="button"
            onClick={() => switchTab("forgot")}
            className="mt-2 w-full min-h-[44px] text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
            data-testid="pw-forgot-link"
          >
            {t("pw.forgot")}
          </button>
        </form>
      )}

      {tab === "forgot" && (
        <form onSubmit={submitForgot} className="mt-3" data-testid="pw-forgot-form">
          <p className="text-sm font-semibold text-slate-800">{t("pw.forgot")}</p>
          <label className={`${labelCls} mt-3`}>
            {t("pw.username")}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className={inputCls}
              data-testid="pw-forgot-identifier"
            />
          </label>
          <label className={`${labelCls} mt-3`}>
            {t("pw.recCode")}
            {/* Forgiving input — the SERVER normalizes case/spaces/dashes and
                the Crockford confusables (D7); the field just avoids mobile
                autocapitalize/autocorrect mangling. */}
            <input
              type="text"
              value={recCode}
              onChange={(e) => setRecCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className={`${inputCls} font-mono`}
              data-testid="pw-forgot-code"
            />
          </label>
          <label className={`${labelCls} mt-3`}>
            {t("pw.newPassword")}
            <input
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              className={inputCls}
              data-testid="pw-forgot-newpassword"
            />
          </label>
          {showToggle}
          {errorBlock}
          <button type="submit" disabled={pending} className={primaryBtnCls} data-testid="pw-forgot-submit">
            {pending ? "…" : t("pw.reset")}
          </button>
          <button
            type="button"
            onClick={() => switchTab("signin")}
            className="mt-2 w-full min-h-[44px] text-sm font-medium text-slate-500 underline-offset-2 hover:underline"
          >
            {t("pw.signInTitle")}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Seaman-side wrapper (Step 7): reads the adopt token from localStorage
 * (lib/seamanToken getToken()) with the claim-URL ?token= fallback inside the
 * core; claim mode guards against silent fresh-creates (pw.claimNoToken).
 */
export function SeamanPasswordAuth({
  claimMode = false,
  onSignedIn,
  defaultTab,
}: {
  claimMode?: boolean;
  onSignedIn: () => void | Promise<void>;
  defaultTab?: "create" | "signin";
}) {
  return (
    <PasswordAuthCore
      side="seaman"
      claimMode={claimMode}
      onSignedIn={onSignedIn}
      defaultTab={defaultTab}
    />
  );
}
