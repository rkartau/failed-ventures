"use client";

// Route-level error boundary. Catches any error thrown while rendering a page
// (e.g. the JSON store can't be read because the ship's disk filled) and, instead
// of Next's bare English "Internal Server Error", shows a calm, localised page
// with a one-tap "Try again", a way home, and the standing privacy promise — so a
// low-connectivity, low-English seafarer is never left staring at a dead screen.

import { useEffect } from "react";
import Link from "next/link";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";

function currentLang(): Lang {
  if (typeof document === "undefined") return DEFAULT_LANG;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([^;]+)`));
  const raw = m ? decodeURIComponent(m[1]) : undefined;
  return isLang(raw) ? raw : DEFAULT_LANG;
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for logs without leaking internals to the user.
    console.error(error);
  }, [error]);

  const lang = currentLang();

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <h1 className="mt-5 text-2xl font-bold text-slate-900">{t(lang, "err.title")}</h1>
      <p className="mt-3 text-base leading-relaxed text-slate-600">{t(lang, "err.body")}</p>

      <div className="mt-8 flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={() => reset()}
          data-testid="error-retry"
          className="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-brand-600 px-6 text-base font-semibold text-white shadow-sm hover:bg-brand-700"
        >
          {t(lang, "err.retry")}
        </button>
        <Link
          href="/"
          data-testid="error-home"
          className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white px-6 text-base font-semibold text-slate-700 hover:bg-slate-50"
        >
          {t(lang, "err.home")}
        </Link>
      </div>

      <p className="mt-8 max-w-sm text-xs leading-relaxed text-slate-400">{t(lang, "err.privacy")}</p>
    </div>
  );
}
