"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";

// Seaman inbox. Shows the crew member's own in-app messages (circulars) newest-first
// with an unread badge, and — when a message allows replies — the reply thread as the
// seaman is allowed to see it (own replies as "You", peers' "everyone" replies
// anonymised to "A crew member", both served that way by the API) plus a reply COMPOSER.
//
// Identity: the API resolves the acting seaman from the Google seaman SESSION first,
// falling back to the OPEN share token this device holds — so the read card works for a
// signed-in seaman and an anonymous local-token seaman. The private email link never
// reaches the inbox API.
//
// Replies are AUTHENTICATED-ONLY (D1): the composer renders solely when the API reports
// `authenticated` (a live seaman session), never on the read-only token path — matching
// the server, which 403s any token-authorised write.

type ReplyView = {
  id: string;
  body: string;
  visibility: "agent" | "all";
  createdAt: string;
  mine: boolean;
  author: string;
};

export type InboxItem = {
  id: string;
  subject: string;
  message: string;
  authorName: string;
  createdAt: string;
  allowReplies: boolean;
  unread: boolean;
  replies: ReplyView[];
};

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function SeamanInbox({
  token,
  sample = false,
  initialItems,
}: {
  token?: string;
  /**
   * Public sample mode (plan D3/Phase 3): the thread arrives fully-shaped via
   * `initialItems` (SSR — the subject/replies are in the server HTML), every
   * fetch is skipped, and the reply composer is replaced by a static one-line
   * note (i18n `sample.composeNote`).
   */
  sample?: boolean;
  initialItems?: InboxItem[];
}) {
  const { t } = useT();
  // Sample mode opens pre-loaded so the server-rendered HTML contains the thread.
  const [open, setOpen] = useState(sample);
  const [items, setItems] = useState<InboxItem[]>(initialItems ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [newestCreatedAt, setNewestCreatedAt] = useState("");
  const [unread, setUnread] = useState(
    sample ? (initialItems ?? []).filter((i) => i.unread).length : 0
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(sample);
  // Whether the API resolved a live seaman SESSION (vs the read-only token path). Gates
  // the reply composer (D1) — the token path can read but never write.
  const [authenticated, setAuthenticated] = useState(false);
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenQ = token ? `token=${encodeURIComponent(token)}` : "";

  // Lightweight badge poll.
  const fetchUnread = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox/unread${tokenQ ? `?${tokenQ}` : ""}`);
      const data = await res.json().catch(() => ({}));
      if (data?.ok) setUnread(data.count ?? 0);
    } catch {
      /* transient — the next poll retries */
    }
  }, [tokenQ]);

  // Full inbox page (newest-first). `cursor` null = first page (replaces the list).
  const fetchInbox = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      try {
        const qs = [tokenQ, cursor ? `cursor=${encodeURIComponent(cursor)}` : ""]
          .filter(Boolean)
          .join("&");
        const res = await fetch(`/api/inbox${qs ? `?${qs}` : ""}`);
        const data = await res.json().catch(() => ({}));
        if (data?.ok) {
          setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
          setNextCursor(data.nextCursor ?? null);
          setNewestCreatedAt(data.newestCreatedAt ?? "");
          setAuthenticated(Boolean(data.authenticated));
          if (!cursor) setUnread(data.unreadCount ?? 0);
          setLoaded(true);
        }
      } catch {
        /* leave the current view on a transient error */
      } finally {
        setLoading(false);
      }
    },
    [tokenQ]
  );

  // Mark the inbox seen (debounced) with the highwater the last fetch reported. The
  // server takes max(old, seenAt) — never now() — so this can't skip a newer message.
  const markSeen = useCallback(
    (seenAt: string) => {
      if (seenTimer.current) clearTimeout(seenTimer.current);
      seenTimer.current = setTimeout(async () => {
        try {
          await fetch("/api/inbox/seen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seenAt, token }),
          });
          setUnread(0);
        } catch {
          /* the next open retries */
        }
      }, 700);
    },
    [token]
  );

  // Badge poll: ~60s with jitter, plus an immediate refresh whenever the tab regains
  // focus. Cleared on unmount. Sample mode never polls — the data is baked in.
  useEffect(() => {
    if (sample) return;
    let cancelled = false;
    const schedule = () => {
      const delay = 60_000 + Math.floor(Math.random() * 20_000);
      pollTimer.current = setTimeout(async () => {
        if (cancelled) return;
        await fetchUnread();
        schedule();
      }, delay);
    };
    void fetchUnread();
    schedule();
    const onFocus = () => {
      void fetchUnread();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchUnread, sample]);

  // Opening the card: load the first page (once), then debounce a "seen" so the badge
  // clears. Piggyback keeps the poll cheap while the card is open.
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !sample) void fetchInbox(null);
  }

  // Once a first page is loaded while open, advance the highwater. Sample mode
  // never marks seen (a public GET must perform zero writes — read purity).
  useEffect(() => {
    if (sample) return;
    if (open && loaded && newestCreatedAt) markSeen(newestCreatedAt);
  }, [open, loaded, newestCreatedAt, markSeen, sample]);

  // Splice a just-posted reply into its message (idempotent server → no dupes on retry).
  const onReplied = useCallback((circularId: string, reply: ReplyView) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === circularId && !it.replies.some((r) => r.id === reply.id)
          ? { ...it, replies: [...it.replies, reply] }
          : it
      )
    );
  }, []);

  return (
    <div className="mt-6" data-testid="inbox">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm hover:bg-slate-50"
      >
        <span className="flex items-center gap-2">
          <span className="font-semibold text-slate-900">Messages</span>
          {unread > 0 && (
            <span
              data-testid="inbox-unread"
              className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-xs font-semibold text-white"
            >
              {unread}
            </span>
          )}
        </span>
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="mt-2">
          {loading && items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-400">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-400">
              No messages yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  data-testid="inbox-item"
                  className="rounded-xl border border-slate-200 bg-white px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium text-slate-800">
                        {it.unread && (
                          <span
                            aria-label="Unread"
                            className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-brand-600"
                          />
                        )}
                        {it.subject}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {it.authorName} · {fmt(it.createdAt)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{it.message}</p>

                  {it.allowReplies && it.replies.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-2">
                      {it.replies.map((r) => (
                        <li key={r.id} className="text-sm">
                          <span
                            className={`font-medium ${r.mine ? "text-brand-700" : "text-slate-500"}`}
                          >
                            {r.author}
                          </span>
                          {r.visibility === "all" && (
                            <span className="ml-1 text-[11px] text-slate-400">· everyone</span>
                          )}
                          <span className="ml-1 whitespace-pre-wrap text-slate-600">{r.body}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Composer — authenticated session ONLY (D1); token path stays read-only.
                      Sample mode: a static one-line note replaces it (nobody answers). */}
                  {sample && it.allowReplies ? (
                    <p
                      data-testid="inbox-sample-compose-note"
                      className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400"
                    >
                      {t("sample.composeNote")}
                    </p>
                  ) : (
                    authenticated &&
                    it.allowReplies && <ReplyComposer circularId={it.id} onReplied={onReplied} />
                  )}
                </li>
              ))}
            </ul>
          )}

          {nextCursor && (
            <button
              type="button"
              onClick={() => void fetchInbox(nextCursor)}
              disabled={loading}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {loading ? "Loading…" : "Show older messages"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Per-message reply box. Authenticated seaman only (the parent gates rendering on the
// API's `authenticated` flag). Visibility is a REQUIRED choice, defaulting to the safe
// private option; picking "Everyone" shows the consent copy (D2). A fresh idempotency
// key per submit + a `sending` guard make a double-click post exactly one reply.
function ReplyComposer({
  circularId,
  onReplied,
}: {
  circularId: string;
  onReplied: (circularId: string, reply: ReplyView) => void;
}) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"agent" | "all">("agent");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (sending) return; // double-submit guard
    const text = body.trim();
    if (!text) {
      setError("Write a reply first.");
      return;
    }
    setError(null);
    setSending(true);
    // Per-submit key: the server dedups a retry carrying the same key (F2).
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${circularId}-${Date.now()}-${Math.random()}`;
    try {
      const res = await fetch("/api/inbox/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circularId, body: text, visibility, idempotencyKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.ok && data.reply) {
        onReplied(circularId, data.reply as ReplyView);
        setBody("");
        setVisibility("agent");
      } else {
        setError(data?.error ?? "Could not send your reply.");
      }
    } catch {
      setError("Could not send. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        rows={2}
        placeholder="Write a reply…"
        className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
      <div
        data-testid="inbox-reply-visibility"
        className="mt-2 flex flex-col gap-1 text-xs text-slate-600"
      >
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`vis-${circularId}`}
            checked={visibility === "agent"}
            onChange={() => setVisibility("agent")}
            className="h-3.5 w-3.5"
          />
          <span>Only the agency <span className="text-slate-400">(private)</span></span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`vis-${circularId}`}
            checked={visibility === "all"}
            onChange={() => setVisibility("all")}
            className="h-3.5 w-3.5"
          />
          <span>Everyone who got this message</span>
        </label>
      </div>
      {visibility === "all" && (
        <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          Other crew will see this reply, shown as “A crew member” — your name is hidden from
          them, but anything you write here could still identify you. The agency always sees
          your name.
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {error ? (
          <span className="text-[11px] text-rose-600">{error}</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          data-testid="inbox-reply-send"
          onClick={submit}
          disabled={sending || !body.trim()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </div>
    </div>
  );
}
