"use client";

// Client islands for the admin bookings view (Wave-4 §E). Small, terse controls that
// POST to the adminSession()-guarded routes and then router.refresh() the server page:
//   - CancelButton   : POST /api/admin/bookings { action:"cancel", id }
//   - MarkSeenButton : POST /api/admin/bookings { action:"mark-seen" }
//   - SettingsEditor : POST /api/admin/booking-settings (full BookingSettings)
// Copy is i18n (useT). Button style mirrors outreach/actions.tsx (BTN).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/LanguageProvider";
import type { BookingSettings } from "@/lib/db";

const BTN = "rounded border px-2 py-1 text-xs font-medium transition disabled:opacity-40";
const BTN_ROSE = `${BTN} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100`;
const BTN_SKY = `${BTN} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100`;
const FIELD =
  "rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

// Weekday display order: Monday-first (keys are 0=Sun..6=Sat).
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function CancelButton({ id }: { id: string }): JSX.Element {
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  async function cancel(): Promise<void> {
    if (!window.confirm(t("book.adminCancelConfirm"))) return;
    setBusy(true);
    try {
      await fetch("/api/admin/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", id }),
      });
      router.refresh();
    } catch {
      /* leave the row; the operator can retry */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" disabled={busy} className={BTN_ROSE} onClick={() => void cancel()}>
      {busy ? t("book.adminCancelling") : t("book.adminCancel")}
    </button>
  );
}

export function MarkSeenButton(): JSX.Element {
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  async function markSeen(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/admin/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-seen" }),
      });
      router.refresh();
    } catch {
      /* no-op */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" disabled={busy} className={BTN_SKY} onClick={() => void markSeen()}>
      {busy ? t("book.adminMarking") : t("book.adminMarkSeen")}
    </button>
  );
}

type DayState = { enabled: boolean; start: string; end: string };

export function SettingsEditor({
  settings,
  timezones,
}: {
  settings: BookingSettings;
  timezones: readonly string[];
}): JSX.Element {
  const router = useRouter();
  const { t } = useT();

  const [timezone, setTimezone] = useState(settings.timezone);
  const [slotMinutes, setSlotMinutes] = useState<number>(settings.slotMinutes);
  const [horizonDays, setHorizonDays] = useState<number>(settings.horizonDays);
  const [week, setWeek] = useState<Record<number, DayState>>(() => {
    const w: Record<number, DayState> = {};
    for (let d = 0; d <= 6; d++) {
      const entry = settings.weekly?.[d] ?? null;
      w[d] = entry
        ? { enabled: true, start: entry.start, end: entry.end }
        : { enabled: false, start: "09:00", end: "17:00" };
    }
    return w;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function setDay(d: number, patch: Partial<DayState>): void {
    setWeek((prev) => ({ ...prev, [d]: { ...prev[d], ...patch } }));
    setSaved(false);
    setError(null);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    const weekly: BookingSettings["weekly"] = {};
    for (let d = 0; d <= 6; d++) {
      const s = week[d];
      weekly[d] = s.enabled ? { start: s.start, end: s.end } : null;
    }
    const payload: BookingSettings = { timezone, slotMinutes, horizonDays, weekly };
    try {
      const res = await fetch("/api/admin/booking-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      // 400 = invalid field; 409 = edit-locked (timezone/slot change with future bookings).
      setError(data?.error ?? t("book.errGeneric"));
    } catch {
      setError(t("book.errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">{t("book.setTitle")}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{t("book.setSubtitle")}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">{t("book.setTimezone")}</span>
          <select
            className={`${FIELD} mt-1 w-full`}
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setSaved(false);
              setError(null);
            }}
          >
            {timezones.map((tzName) => (
              <option key={tzName} value={tzName}>
                {tzName}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">{t("book.setSlot")}</span>
          <select
            className={`${FIELD} mt-1 w-full`}
            value={slotMinutes}
            onChange={(e) => {
              setSlotMinutes(Number(e.target.value));
              setSaved(false);
              setError(null);
            }}
          >
            {[15, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} {t("book.minShort")}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium text-slate-700">{t("book.setHorizon")}</span>
          <input
            type="number"
            min={1}
            max={60}
            className={`${FIELD} mt-1 w-full`}
            value={horizonDays}
            onChange={(e) => {
              setHorizonDays(Number(e.target.value));
              setSaved(false);
              setError(null);
            }}
          />
        </label>
      </div>

      <div className="mt-5">
        <p className="text-sm font-medium text-slate-700">{t("book.setWeekly")}</p>
        <div className="mt-2 space-y-2">
          {DOW_ORDER.map((d) => {
            const s = week[d];
            return (
              <div key={d} className="flex flex-wrap items-center gap-3">
                <label className="flex w-40 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => setDay(d, { enabled: e.target.checked })}
                  />
                  <span className="text-sm text-slate-700">{t(`book.dow${d}`)}</span>
                  <span className="text-xs text-slate-400">{t("book.setOpen")}</span>
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  {t("book.setStart")}
                  <input
                    type="time"
                    step={900}
                    min="06:00"
                    max="20:00"
                    disabled={!s.enabled}
                    className={`${FIELD} disabled:opacity-40`}
                    value={s.start}
                    onChange={(e) => setDay(d, { start: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  {t("book.setEnd")}
                  <input
                    type="time"
                    step={900}
                    min="06:00"
                    max="20:00"
                    disabled={!s.enabled}
                    className={`${FIELD} disabled:opacity-40`}
                    value={s.end}
                    onChange={(e) => setDay(d, { end: e.target.value })}
                  />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-xs text-amber-700">{t("book.setLockHint")}</p>

      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
      {saved ? <p className="mt-2 text-sm text-emerald-700">{t("book.setSaved")}</p> : null}

      <button
        type="button"
        disabled={busy}
        className={`${BTN_SKY} mt-3`}
        onClick={() => void save()}
      >
        {busy ? t("book.setSaving") : t("book.setSave")}
      </button>
    </section>
  );
}
