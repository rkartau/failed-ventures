"use client";

// Public "Book a call" client island (Wave-4 §D). Server page computes the initial
// open slots and hands them in; the visitor picks a day on a month CALENDAR -> a time
// -> fills the form -> POST /api/book. All copy is i18n (useT); month/weekday NAMES come
// from Intl in the active language. Every slot time is shown with an explicit, DST-aware
// timezone MARK (e.g. "GMT+3") so there is zero ambiguity.
//
// Slot identity is the (date, time) STRING pair exactly as generated server-side — the
// calendar grid is built from those strings via plain UTC calendar arithmetic (never a
// tz-instant round-trip), so a weekday never slips a day. The tz offset mark is the only
// place an instant meets the zone, and it is display-only.
//
// Fail-soft: a 409 (slot just taken) re-fetches GET /api/book so the grid self-heals;
// 400/429/other map to clear localized messages. The Booking is constructed server-side,
// so this island only sends the seven allowed inputs + the honeypot.

import { useEffect, useMemo, useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { track } from "@/lib/analytics-events";

type Slot = { date: string; time: string; tz: string };

const CTA_PRIMARY =
  "rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50";
const CTA_SECONDARY =
  "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50";
const CHIP =
  "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-brand-400 hover:bg-brand-50";
const CHIP_ACTIVE =
  "rounded-xl border border-brand-500 bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm";
const FIELD =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const NAV_BTN =
  "flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-lg leading-none text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse "YYYY-MM-DD" into plain calendar parts (no tz). */
function parseDate(date: string): { y: number; mo: number; d: number } {
  const [y, mo, d] = date.split("-").map((x) => Number(x));
  return { y: y || 1970, mo: mo || 1, d: d || 1 };
}

/** Month index (year*12 + month0) for a calendar date string — for range math. */
function monthIndexOf(date: string): number {
  const { y, mo } = parseDate(date);
  return y * 12 + (mo - 1);
}

/** Group a flat, already-sorted slot list by calendar date, preserving order. */
function groupByDate(slots: Slot[]): Array<{ date: string; times: Slot[] }> {
  const map = new Map<string, Slot[]>();
  for (const s of slots) {
    const arr = map.get(s.date);
    if (arr) arr.push(s);
    else map.set(s.date, [s]);
  }
  return [...map.entries()].map(([date, times]) => ({ date, times }));
}

/** Readable weekday + date label from a YYYY-MM-DD string, in the active language and
 * built on UTC calendar parts (so the weekday never slips a day). */
function dayLabel(date: string, lang: string): string {
  const { y, mo, d } = parseDate(date);
  return new Intl.DateTimeFormat(lang, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/** Full accessible date label ("Monday, 18 August 2026") in the active language. */
function fullDateLabel(date: string, lang: string): string {
  const { y, mo, d } = parseDate(date);
  return new Intl.DateTimeFormat(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, mo - 1, d)));
}

/** DST-aware, compact timezone MARK for a slot (e.g. "GMT+3"). Display-only: the instant
 * is midday UTC of the slot's own date, so summer/winter offsets resolve automatically —
 * this never touches the slot's canonical (date,time) identity. Falls back gracefully. */
function tzMark(tz: string, date: string, lang: string): string {
  const { y, mo, d } = parseDate(date);
  const at = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const extract = (opt: "shortOffset" | "short"): string => {
    try {
      const parts = new Intl.DateTimeFormat(lang, {
        timeZone: tz,
        timeZoneName: opt,
      }).formatToParts(at);
      return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch {
      return "";
    }
  };
  return extract("shortOffset") || extract("short") || tz;
}

export function BookClient({
  slots: initialSlots,
  tz,
  today,
  stale: initialStale,
  leadKey,
}: {
  slots: Slot[];
  tz: string;
  today?: string;
  /** Two-way availability (AV9-2): true when the Google busy-check is stale/unavailable
   * and the slots shown are unfiltered — surface a soft "approximate" note. */
  stale?: boolean;
  /** Outreach attribution token (send_key) from /book?lead=. When present it is added
   * to the POST body so the booking is stamped source:"outreach". No visible UI. */
  leadKey?: string;
}): JSX.Element {
  const { t, lang } = useT();

  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [stale, setStale] = useState<boolean>(Boolean(initialStale));
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — kept empty by real users
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ date: string; time: string; tz: string } | null>(null);

  const days = useMemo(() => groupByDate(slots), [slots]);
  const timesForDay = useMemo(
    () => (day ? days.find((d) => d.date === day)?.times ?? [] : []),
    [days, day]
  );

  // date -> available-slot count, for highlighting/enabling calendar cells.
  const countByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of slots) m.set(s.date, (m.get(s.date) ?? 0) + 1);
    return m;
  }, [slots]);

  // Month range the calendar may show: [month of earliest slot, month of latest slot].
  // Purely slot-derived, so prev/next never wander into a month with zero availability
  // and "before the current month" is impossible (the earliest slot is >= today).
  const { minMonth, maxMonth } = useMemo(() => {
    if (slots.length === 0) return { minMonth: null as number | null, maxMonth: null as number | null };
    let lo = monthIndexOf(slots[0].date);
    let hi = lo;
    for (const s of slots) {
      const idx = monthIndexOf(s.date);
      if (idx < lo) lo = idx;
      if (idx > hi) hi = idx;
    }
    return { minMonth: lo, maxMonth: hi };
  }, [slots]);

  const [viewMonth, setViewMonth] = useState<number>(() =>
    initialSlots.length > 0 ? monthIndexOf(initialSlots[0].date) : 0
  );

  // Keep the shown month inside the (possibly changed) availability range after a refresh.
  useEffect(() => {
    if (minMonth == null || maxMonth == null) return;
    setViewMonth((v) => Math.min(Math.max(v, minMonth), maxMonth));
  }, [minMonth, maxMonth]);

  // Locale-aware weekday header (Monday-first). 2024-01-01 is a Monday.
  const weekdayNames = useMemo(() => {
    const base = Date.UTC(2024, 0, 1);
    const f = new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(base + i * MS_PER_DAY)));
  }, [lang]);

  // Cells for the shown month: leading blanks (Monday-first) then day numbers.
  const grid = useMemo(() => {
    const y = Math.floor(viewMonth / 12);
    const m0 = viewMonth % 12;
    const firstDow = new Date(Date.UTC(y, m0, 1)).getUTCDay(); // 0=Sun..6=Sat
    const lead = (firstDow + 6) % 7; // shift so Monday is column 0
    const daysInMonth = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    const cells: Array<{ date: string; d: number } | null> = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: `${y}-${pad2(m0 + 1)}-${pad2(d)}`, d });
    }
    while (cells.length % 7 !== 0) cells.push(null); // trailing blanks keep 7 columns
    const monthLabel = new Intl.DateTimeFormat(lang, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m0, 1)));
    return { cells, monthLabel };
  }, [viewMonth, lang]);

  async function refreshSlots(): Promise<void> {
    try {
      const res = await fetch("/api/book", { method: "GET" });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; slots?: Slot[]; stale?: boolean }
        | null;
      if (data?.ok && Array.isArray(data.slots)) {
        setSlots(data.slots);
        setStale(Boolean(data.stale));
        // Drop a selection that no longer exists.
        setTime(null);
        if (day && !data.slots.some((s) => s.date === day)) setDay(null);
      }
    } catch {
      /* keep the current grid; the visitor can retry */
    }
  }

  async function submit(): Promise<void> {
    if (!day || !time) return;
    if (!name.trim() || !email.trim()) {
      setError(t("book.errRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          company,
          phone,
          note,
          date: day,
          time,
          website,
          ...(leadKey ? { leadKey } : {}),
        }),
      });
      if (res.ok) {
        // GA4 `book_submit` (PII-free, no params) at the same moment the server wrote
        // the first-party `booking` event. /book sends the bare path: ?lead= never rides.
        track("book_submit");
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; booking?: { date: string; time: string; tz: string } | null }
          | null;
        setDone(data?.booking ?? { date: day, time, tz });
        return;
      }
      if (res.status === 409) {
        setError(t("book.errTaken"));
        await refreshSlots();
        return;
      }
      if (res.status === 429) {
        setError(t("book.errRate"));
        return;
      }
      if (res.status === 400) {
        setError(t("book.errInvalid"));
        await refreshSlots();
        return;
      }
      setError(t("book.errGeneric"));
    } catch {
      setError(t("book.errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  // ---- Confirmation state ----------------------------------------------
  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-lg font-semibold text-emerald-800">{t("book.confirmedTitle")}</h2>
        <p className="mt-2 text-sm text-emerald-900">
          {done
            ? t("book.confirmed", {
                time: done.time,
                tz: tzMark(done.tz, done.date, lang),
                date: dayLabel(done.date, lang),
              })
            : null}
        </p>
        <p className="mt-1 text-sm text-emerald-900">{t("book.confirmedNote")}</p>
        <button
          type="button"
          className={`${CTA_SECONDARY} mt-4`}
          onClick={() => {
            setDone(null);
            setDay(null);
            setTime(null);
            setName("");
            setEmail("");
            setCompany("");
            setPhone("");
            setNote("");
            void refreshSlots();
          }}
        >
          {t("book.bookAnother")}
        </button>
      </div>
    );
  }

  // ---- No availability (also the fail-soft render) ---------------------
  if (days.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-500">{t("book.noTimes")}</p>
      </div>
    );
  }

  const firstDate = slots[0]?.date ?? "";
  const atMinMonth = minMonth == null || viewMonth <= minMonth;
  const atMaxMonth = maxMonth == null || viewMonth >= maxMonth;

  return (
    <div className="space-y-6">
      {stale ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("book.approxNote")}
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        {t("book.timesIn", { tz: tzMark(tz, firstDate, lang) })}
      </p>

      {/* Step 1 — pick a day from the month calendar */}
      <section>
        <h2 className="text-sm font-semibold text-slate-700">{t("book.pickDay")}</h2>

        <div className="mt-3 max-w-sm rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {/* Month navigation */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              className={NAV_BTN}
              aria-label={t("book.prevMonth")}
              disabled={atMinMonth}
              onClick={() => setViewMonth((v) => v - 1)}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <div className="text-sm font-semibold capitalize text-slate-900">{grid.monthLabel}</div>
            <button
              type="button"
              className={NAV_BTN}
              aria-label={t("book.nextMonth")}
              disabled={atMaxMonth}
              onClick={() => setViewMonth((v) => v + 1)}
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>

          {/* Weekday header */}
          <div className="mt-3 grid grid-cols-7 gap-1">
            {weekdayNames.map((w, i) => (
              <div
                key={i}
                className="py-1 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400"
              >
                {w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="mt-1 grid grid-cols-7 gap-1">
            {grid.cells.map((cell, i) => {
              if (!cell) return <div key={`b${i}`} aria-hidden="true" />;
              const count = countByDate.get(cell.date) ?? 0;
              const enabled = count > 0;
              const selected = day === cell.date;
              const isToday = !!today && cell.date === today;

              let cls =
                "flex aspect-square min-h-[40px] w-full flex-col items-center justify-center rounded-lg text-sm transition";
              if (selected) {
                cls += " border border-brand-600 bg-brand-600 font-semibold text-white shadow-sm";
              } else if (enabled) {
                cls +=
                  " border border-brand-200 bg-brand-50 font-semibold text-brand-700 hover:border-brand-400 hover:bg-brand-100";
              } else {
                cls += " text-slate-300";
              }
              if (isToday && !selected) cls += " ring-1 ring-inset ring-brand-400";

              const ariaParts = [fullDateLabel(cell.date, lang)];
              if (isToday) ariaParts.push(t("book.today"));
              if (enabled) ariaParts.push(t("book.slotsAvailable", { n: count }));

              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={!enabled}
                  aria-pressed={selected}
                  aria-label={ariaParts.join(", ")}
                  className={cls}
                  onClick={() => {
                    setDay(cell.date);
                    setTime(null);
                    setError(null);
                  }}
                >
                  <span>{cell.d}</span>
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 h-1 w-1 rounded-full ${
                      enabled ? (selected ? "bg-white/80" : "bg-brand-500") : "bg-transparent"
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Step 2 — pick a time */}
      {day ? (
        <section>
          <h2 className="text-sm font-semibold text-slate-700">{t("book.pickTime")}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {timesForDay.map((s) => (
              <button
                key={`${s.date} ${s.time}`}
                type="button"
                aria-pressed={time === s.time}
                className={time === s.time ? CHIP_ACTIVE : CHIP}
                onClick={() => {
                  setTime(s.time);
                  setError(null);
                }}
              >
                {s.time} ({tzMark(s.tz, s.date, lang)})
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Step 3 — details + submit */}
      {day && time ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">{t("book.yourDetails")}</h2>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
              onClick={() => setTime(null)}
            >
              {t("book.changeTime")}
            </button>
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {t("book.selected", {
              date: dayLabel(day, lang),
              time,
              tz: tzMark(tz, day, lang),
            })}
          </p>

          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <label className="text-sm font-medium text-slate-700">{t("book.name")}</label>
              <input
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">{t("book.email")}</label>
              <input
                type="email"
                className={FIELD}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                required
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">
                {t("book.company")} <span className="text-slate-400">{t("book.optional")}</span>
              </label>
              <input
                className={FIELD}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={120}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">
                {t("book.phone")} <span className="text-slate-400">{t("book.optional")}</span>
              </label>
              <input
                className={FIELD}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={40}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">
                {t("book.note")} <span className="text-slate-400">{t("book.optional")}</span>
              </label>
              <textarea
                className={FIELD}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                rows={3}
              />
            </div>

            {/* Honeypot — hidden from humans; a filled value makes the API no-op. */}
            <div aria-hidden="true" className="hidden">
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </label>
            </div>

            {error ? <p className="text-sm text-rose-600">{error}</p> : null}

            <button type="submit" disabled={busy} className={CTA_PRIMARY}>
              {busy ? t("book.submitting") : t("book.submit")}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
