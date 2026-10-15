"use client";

import { useEffect, useMemo, useState } from "react";
import { SEAFARER_STATES, STATE_LABELS, type SeafarerState } from "@/lib/pipeline";
import type { Circular } from "@/lib/db";

/** One reply as the AGENT sees it — REAL author name, both visibilities. */
export type AgentReply = {
  id: string;
  circularId: string;
  authorName: string;
  body: string;
  visibility: "agent" | "all";
  createdAt: string;
  stillOnRoster: boolean;
};

/** The grant-scoped roster slice the API hands the compose UI (no docs, no identity). */
export type CircularRosterEntry = {
  id: string;
  name: string;
  rank: string;
  state: SeafarerState;
  vessel: string | null;
  hasEmail: boolean;
};

type Props = {
  initialRoster: CircularRosterEntry[];
  initialCirculars: Circular[];
  /** Whether a live email transport is configured; when false, email is dark and
   *  crew only see the message inside docka. */
  emailLive: boolean;
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CircularBroadcast({ initialRoster, initialCirculars, emailLive }: Props) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [rank, setRank] = useState("");
  const [state, setState] = useState<"" | SeafarerState>("");
  const [vessel, setVessel] = useState("");
  const [allowReplies, setAllowReplies] = useState(false);
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [circulars, setCirculars] = useState<Circular[]>(initialCirculars);
  const [repliesByCircular, setRepliesByCircular] = useState<Record<string, AgentReply[]>>({});

  // Load replies to this agent's own circulars once (own-tenant filtered server-side).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/circulars/replies");
        const data = await res.json().catch(() => ({}));
        if (!cancelled && data?.ok && Array.isArray(data.replies)) {
          const grouped: Record<string, AgentReply[]> = {};
          for (const r of data.replies as AgentReply[]) {
            (grouped[r.circularId] ??= []).push(r);
          }
          setRepliesByCircular(grouped);
        }
      } catch {
        /* non-fatal — the disclosure just shows no replies */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Distinct rank/vessel options from the actual roster, so the agent filters on
  // values that really exist rather than typing free text.
  const rankOptions = useMemo(
    () =>
      Array.from(new Set(initialRoster.map((s) => s.rank.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [initialRoster]
  );
  const vesselOptions = useMemo(
    () =>
      Array.from(
        new Set(initialRoster.map((s) => (s.vessel ?? "").trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [initialRoster]
  );

  // Live client-side preview of reach, mirroring the server's filter semantics.
  const matched = useMemo(
    () =>
      initialRoster.filter((s) => {
        if (rank && s.rank.trim().toLowerCase() !== rank.trim().toLowerCase()) return false;
        if (state && s.state !== state) return false;
        if (vessel && (s.vessel ?? "").trim().toLowerCase() !== vessel.trim().toLowerCase()) {
          return false;
        }
        return true;
      }),
    [initialRoster, rank, state, vessel]
  );
  const reachable = matched.filter((s) => s.hasEmail).length;

  async function sendCircular() {
    setBanner(null);
    if (!subject.trim() || !message.trim()) {
      setBanner({ ok: false, text: "Add a subject and a message." });
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/circulars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          message: message.trim(),
          allowReplies,
          filter: { rank: rank || undefined, state: state || undefined, vessel: vessel || undefined },
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCirculars((prev) => [data.circular as Circular, ...prev]);
        setBanner({
          ok: true,
          text: `Circular sent to ${data.recipientCount} crew — ${data.delivered} e-mailed, ${
            data.recipientCount - data.delivered
          } recorded (no e-mail / channel off).`,
        });
        setSubject("");
        setMessage("");
      } else {
        setBanner({ ok: false, text: data.error ?? "Could not send the circular." });
      }
    } catch {
      setBanner({ ok: false, text: "Could not send. Check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  const input =
    "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">Write a message</h2>
        <p className="mt-1 text-xs text-slate-500">
          Send one notice to your whole crew or a filtered slice. They see it inside docka
          straight away; if email is switched on, they also get it by email.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-slate-500">Rank</label>
            <select value={rank} onChange={(e) => setRank(e.target.value)} className={input}>
              <option value="">All ranks</option>
              {rankOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Pipeline stage</label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as "" | SeafarerState)}
              className={input}
            >
              <option value="">All stages</option>
              {SEAFARER_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Vessel</label>
            <select value={vessel} onChange={(e) => setVessel(e.target.value)} className={input}>
              <option value="">All vessels</option>
              {vesselOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium text-slate-500">Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            placeholder="e.g. Fleet stand-down over New Year"
            className={input}
          />
        </div>
        <div className="mt-3">
          <label className="text-xs font-medium text-slate-500">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={5000}
            rows={5}
            placeholder="Write the notice to your crew…"
            className={`${input} resize-y`}
          />
        </div>

        <label className="mt-3 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            data-testid="circular-allow-replies"
            checked={allowReplies}
            onChange={(e) => setAllowReplies(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
          />
          <span className="text-xs text-slate-600">
            <span className="font-medium text-slate-700">Allow replies</span>
            <span className="block text-slate-500">
              Let crew reply to this message inside docka. Off by default.
            </span>
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Goes to <span className="font-semibold text-slate-700">{matched.length}</span> crew in docka
            {emailLive ? (
              matched.length > 0 &&
              reachable > 0 && (
                <>
                  {" "}
                  · <span className="font-semibold text-slate-700">{reachable}</span> also by email
                </>
              )
            ) : (
              <span className="block text-slate-400">
                Email is off right now — crew still see this inside docka.
              </span>
            )}
          </p>
          <button
            type="button"
            data-testid="circular-send"
            onClick={sendCircular}
            disabled={sending || matched.length === 0}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {sending ? "Sending…" : `Send to ${matched.length} crew`}
          </button>
        </div>

        {banner && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-xs font-medium ${
              banner.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            {banner.text}
          </p>
        )}
      </div>

      <SentCircularList circulars={circulars} repliesByCircular={repliesByCircular} />
    </div>
  );
}

// PRESENTATIONAL sent-circulars list + replies (extracted so the read-only public
// sample agency page can render the same markup props-fed, without the compose
// form or the replies fetch — plan Phase 4: never duplicate this markup).
export function SentCircularList({
  circulars,
  repliesByCircular,
}: {
  circulars: Circular[];
  repliesByCircular: Record<string, AgentReply[]>;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-800">Sent circulars</h2>
      {circulars.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">No circulars sent yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {circulars.map((c) => (
            <li key={c.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium text-slate-800">{c.subject}</p>
                <p className="text-xs text-slate-400">{fmt(c.createdAt)}</p>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{c.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                  {c.recipientIds.length} recipient{c.recipientIds.length === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                  {c.delivered} e-mailed
                </span>
                {c.filter?.rank && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                    rank: {c.filter.rank}
                  </span>
                )}
                {c.filter?.state && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                    stage: {STATE_LABELS[c.filter.state]}
                  </span>
                )}
                {c.filter?.vessel && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                    vessel: {c.filter.vessel}
                  </span>
                )}
                <span className="text-slate-400">by {c.authorName}</span>
              </div>
              {c.allowReplies && <RepliesDisclosure replies={repliesByCircular[c.id] ?? []} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Read-only "Replies (k)" disclosure under a sent circular. The agent sees REAL author
// names and BOTH visibilities, each badged so it's clear whether a reply was private to
// the agency or shared with the whole crew.
function RepliesDisclosure({ replies }: { replies: AgentReply[] }) {
  const [open, setOpen] = useState(false);
  const k = replies.length;
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <button
        type="button"
        data-testid="circular-replies-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={k === 0}
        className="text-xs font-medium text-slate-600 hover:text-slate-800 disabled:cursor-default disabled:text-slate-400"
      >
        {k === 0 ? "No replies yet" : `Replies (${k})`}
      </button>
      {open && k > 0 && (
        <ul className="mt-2 space-y-2">
          {replies.map((r) => (
            <li key={r.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-700">{r.authorName}</span>
                {!r.stillOnRoster && (
                  <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">
                    former crew
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    r.visibility === "all"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  {r.visibility === "all" ? "Shared with all crew" : "Private to you"}
                </span>
                <span className="text-[11px] text-slate-400">{fmt(r.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-slate-600">{r.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
