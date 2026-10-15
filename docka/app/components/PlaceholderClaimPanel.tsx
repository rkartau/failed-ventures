"use client";

// The claim panel shown IN PLACE of the voyage / sea-service / appraisal sections for
// an UNCLAIMED roster placeholder (ReviewPanel gates them behind isPlaceholder). It is
// the ONE relay surface for the profile link: copy it, refresh an idled-out link, add
// or edit the seafarer's e-mail, and send the invite by e-mail. Delivery is rendered
// HONESTLY from the route's own {delivered, delivery} — the "recorded, not e-mailed"
// state is a first-class outcome, so this looks right whether or not SMTP is live.
//
// SSR-safety: `origin` and the post-mount `stale` amber line are filled in effects, so
// the server HTML carries no `window` read and no clock-dependent text (no hydration
// mismatch). The link's path-only form ("/seafarer?token=…") is emitted by both SSR
// and the first client render; the absolute origin is swapped in after mount.

import { useEffect, useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { useCopyLink } from "@/components/useCopyLink";
import { claimLinkFor, claimOutcomeFrom, type ClaimOutcome } from "@/components/claim-link";
import { fmtDateUtc } from "@/lib/board-card";
import { isEmailish } from "@/lib/roster-parse";
import { SELF_ACCESS_TTL_MS, type ClaimState } from "@/lib/claim-state";

type PlaceholderVariant = Extract<ClaimState, { kind: "placeholder" }>;

export function PlaceholderClaimPanel({
  seafarerId,
  token,
  initialClaim,
  initialEmail,
  onChanged,
}: {
  seafarerId: string;
  token: string;
  initialClaim: PlaceholderVariant;
  initialEmail: string | null;
  onChanged: () => void;
}) {
  const { t } = useT();
  const { copiedId, copy } = useCopyLink(1500);

  // Local claim view — flips to "pending" after a successful refresh/send (the route
  // resets the idle stamp on every claim row it processes).
  const [opened, setOpened] = useState<boolean>(initialClaim.opened === true);
  const [openedAt, setOpenedAt] = useState<number | null>(
    initialClaim.opened === true ? initialClaim.openedAt : null
  );

  // SSR-safe origin + post-mount staleness (never in the server HTML).
  const [origin, setOrigin] = useState("");
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    setStale(openedAt !== null && Date.now() - openedAt > SELF_ACCESS_TTL_MS);
  }, [openedAt]);

  const [savedEmail, setSavedEmail] = useState<string | null>(initialEmail);
  const [emailDraft, setEmailDraft] = useState(initialEmail ?? "");
  const [emailMsg, setEmailMsg] = useState<{ tone: "ok" | "error"; key: string } | null>(null);
  const [refreshedMsg, setRefreshedMsg] = useState(false);
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const link = origin ? claimLinkFor(token, origin) : `/seafarer?token=${token}`;

  async function postClaim() {
    // Shared POST for both Send invite and Refresh link — the route resets the idle
    // window on every claim row it processes, so a no-e-mail POST IS the refresh action.
    return fetch("/api/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seafarerIds: [seafarerId], kind: "claim" }),
    });
  }

  async function onSend() {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    setRefreshedMsg(false);
    try {
      const res = await postClaim();
      const data = await res.json().catch(() => ({}));
      const result = claimOutcomeFrom(res, data);
      setOutcome(result);
      if (res.ok && result.tone !== "error") {
        // The route refreshed the idle window — reflect "pending" + re-enable copy.
        setOpened(false);
        setOpenedAt(null);
        setStale(false);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    setRefreshedMsg(false);
    try {
      const res = await postClaim();
      await res.json().catch(() => ({}));
      if (res.ok) {
        setOpened(false);
        setOpenedAt(null);
        setStale(false);
        setRefreshedMsg(true);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEmail() {
    if (busy) return;
    const raw = emailDraft.trim();
    // Blank clears; otherwise client-side isEmailish before the round-trip.
    if (raw.length > 0 && !isEmailish(raw)) {
      setEmailMsg({ tone: "error", key: "board.claim.emailInvalid" });
      return;
    }
    setBusy(true);
    setEmailMsg(null);
    try {
      const res = await fetch("/api/seafarers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: seafarerId, importedEmail: raw.length > 0 ? raw : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        const stored: string | null = data.seafarer?.importedEmail ?? null;
        setSavedEmail(stored);
        setEmailDraft(stored ?? "");
        setEmailMsg({ tone: "ok", key: "board.claim.emailSaved" });
        onChanged();
      } else {
        setEmailMsg({ tone: "error", key: "board.claim.emailInvalid" });
      }
    } finally {
      setBusy(false);
    }
  }

  const statusLine = opened
    ? t("board.claim.openedTip", { when: openedAt !== null ? fmtDateUtc(openedAt) : "" })
    : t("board.claim.pendingTip");
  const canSend = !!savedEmail && !busy;

  return (
    <div
      data-testid="placeholder-claim-panel"
      className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
        {t("board.claim.panelTitle")}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{statusLine}</p>
      {/* Post-mount only (never SSR): amber idled-out note. */}
      {stale && (
        <p data-testid="claim-stale-note" className="mt-1 text-xs font-medium text-amber-700">
          {t("board.claim.linkStaleTip")}
        </p>
      )}

      {/* Copy link row */}
      <div className="mt-4 flex items-center gap-2">
        <input
          data-testid="claim-link-input"
          value={link}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600"
        />
        <button
          type="button"
          data-testid="copy-claim-link"
          onClick={() => void copy(link, seafarerId)}
          className="flex-shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {copiedId === seafarerId ? t("board.claim.copied") : t("board.claim.copyLink")}
        </button>
      </div>

      {/* Refresh link — shown for an OPENED placeholder; enabled regardless of e-mail. */}
      {opened && (
        <div className="mt-2">
          <button
            type="button"
            data-testid="refresh-claim-link"
            disabled={busy}
            onClick={() => void onRefresh()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("board.claim.refresh")}
          </button>
        </div>
      )}
      {refreshedMsg && (
        <p data-testid="claim-refreshed" className="mt-1 text-xs font-medium text-emerald-700">
          {t("board.claim.refreshed")}
        </p>
      )}

      {/* Seafarer e-mail edit/save */}
      <div className="mt-4">
        <label className="text-xs font-medium text-slate-600">{t("board.claim.emailLabel")}</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="email"
            data-testid="claim-email-input"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            placeholder="seafarer@example.com"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            type="button"
            data-testid="claim-email-save"
            disabled={busy}
            onClick={() => void onSaveEmail()}
            className="flex-shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("board.claim.emailSave")}
          </button>
        </div>
        {emailMsg && (
          <p
            data-testid="claim-email-msg"
            className={`mt-1 text-xs font-medium ${
              emailMsg.tone === "ok" ? "text-emerald-700" : "text-rose-600"
            }`}
          >
            {t(emailMsg.key)}
          </p>
        )}
      </div>

      {/* Send invite — enabled only when a SAVED e-mail is on file (never the draft). */}
      <div className="mt-4">
        <button
          type="button"
          data-testid="send-claim-invite"
          disabled={!canSend}
          onClick={() => void onSend()}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
        >
          {t("board.claim.send")}
        </button>
        {!savedEmail && (
          <p className="mt-1 text-xs text-slate-500">{t("board.claim.sendNoEmail")}</p>
        )}
        {outcome && (
          <p
            data-testid="claim-send-outcome"
            className={`mt-1 text-xs font-medium ${
              outcome.tone === "ok"
                ? "text-emerald-700"
                : outcome.tone === "warn"
                  ? "text-amber-700"
                  : "text-rose-600"
            }`}
          >
            {outcome.key === "raw" ? outcome.vars.text : t(outcome.key, outcome.vars)}
          </p>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500">{t("board.claim.panelBody")}</p>
    </div>
  );
}
