// app/admin/bookings/page.tsx — admin "Book a call" view (Wave-4 §E).
//
// Re-checks adminSession() (Layer C, per-page — also satisfies the static isolation
// build guard: the symbol MUST be referenced). force-dynamic: reads the store per request.
//
// The list is ALWAYS derived from RAW db.bookings (never re-derived from generated slots),
// so a booking orphaned by a later settings change still shows and is never silently
// dropped (R6). Shows the "{n} new" unseen badge (R7) and a degraded-mode banner (R12)
// when stored settings are invalid and defaults were substituted. name/note render as
// plain text (React default escaping — never dangerouslySetInnerHTML, R3).

import { cookies } from "next/headers";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "../access";
import { readDB, type Booking } from "@/lib/db";
import {
  ALLOWED_TIMEZONES,
  businessNowParts,
  getBookingSettings,
  validateSettings,
} from "@/lib/booking";
import { countUnseenBookings } from "@/lib/booking-admin";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";
import { Card } from "../ui";
import { CancelButton, MarkSeenButton, SettingsEditor } from "./actions";

export const dynamic = "force-dynamic";

const SYNC_KEY: Record<string, string> = {
  pending: "book.syncPending",
  synced: "book.syncSynced",
  failed: "book.syncFailed",
  cancelled: "book.syncCancelled",
  abandoned: "book.syncAbandoned",
};

function BookingsTable({
  lang,
  rows,
  emptyLabel,
}: {
  lang: Lang;
  rows: Booking[];
  emptyLabel: string;
}): JSX.Element {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-slate-400">{emptyLabel}</p>;
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColWhen")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColName")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColEmail")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColCompany")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColPhone")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColNote")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColSource")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColStatus")}</th>
            <th className="px-3 py-2 text-left font-medium">{t(lang, "book.adminColSync")}</th>
            <th className="px-3 py-2 text-right font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((b) => {
            const syncKey = b.calendarSync ? SYNC_KEY[b.calendarSync] : null;
            return (
              <tr key={b.id} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-800">
                  {b.date} {b.time}{" "}
                  <span className="text-xs text-slate-400">({b.tz})</span>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {b.name}
                  {b.busyCheck === "skipped-outage" ? (
                    <span className="mt-1 block rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-snug text-amber-800">
                      {t(lang, "book.outageBadge")}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-slate-600">{b.email}</td>
                <td className="px-3 py-2 text-slate-600">{b.company || "—"}</td>
                <td className="px-3 py-2 text-slate-600">{b.phone || "—"}</td>
                <td className="max-w-[220px] px-3 py-2 text-slate-600">{b.note || "—"}</td>
                <td className="px-3 py-2 text-slate-600">
                  {t(lang, b.source === "outreach" ? "book.srcOutreach" : "book.srcPublic")}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      b.status === "booked"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-100 text-slate-500"
                    }`}
                  >
                    {t(lang, b.status === "booked" ? "book.stBooked" : "book.stCancelled")}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {syncKey ? t(lang, syncKey) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  {b.status === "booked" ? <CancelButton id={b.id} /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminBookingsPage(): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) return await adminDeniedResponse();

  const raw = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(raw) ? raw : DEFAULT_LANG;

  const db = readDB();
  const settings = getBookingSettings(db);
  // Degraded mode (R12): a stored settings blob exists but fails validation, so the
  // public page + slot math are silently running on DEFAULT_BOOKING_SETTINGS.
  const stored = db.bookingSettings;
  const degraded = stored != null && !validateSettings(stored).ok;

  const now = new Date();
  const nowParts = businessNowParts(settings.timezone, now);
  const isPast = (b: Booking): boolean =>
    b.date < nowParts.date || (b.date === nowParts.date && b.time <= nowParts.time);

  const sorted = db.bookings
    .slice()
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));
  const upcoming = sorted.filter((b) => !isPast(b));
  const past = sorted.filter((b) => isPast(b)).reverse(); // most-recent first

  const unseen = countUnseenBookings(db.bookings);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">docka admin</p>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{t(lang, "book.adminTitle")}</h1>
            {unseen > 0 ? (
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-700">
                {t(lang, "book.adminNew", { n: unseen })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">{t(lang, "book.adminSubtitle")}</p>
        </div>
        {unseen > 0 ? <MarkSeenButton /> : null}
      </div>

      {degraded ? (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t(lang, "book.degraded")}
        </div>
      ) : null}

      <div className="mt-6">
        <Card title={t(lang, "book.adminUpcoming")}>
          <BookingsTable lang={lang} rows={upcoming} emptyLabel={t(lang, "book.adminNone")} />
        </Card>
      </div>

      <div className="mt-6">
        <Card title={t(lang, "book.adminPast")}>
          <BookingsTable lang={lang} rows={past} emptyLabel={t(lang, "book.adminNone")} />
        </Card>
      </div>

      <div className="mt-6">
        <SettingsEditor settings={settings} timezones={ALLOWED_TIMEZONES} />
      </div>
    </div>
  );
}
