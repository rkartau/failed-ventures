import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";

// Own title (plain string → root "%s · Docka" template renders "Page not found · Docka";
// never title.absolute) + noindex so 404s stay out of the index.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

// Friendly, localised 404 instead of a bare framework page — a mistyped or expired
// URL should still explain itself and offer a way home.
export default function NotFound() {
  const raw = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(raw) ? raw : DEFAULT_LANG;

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-20 text-center">
      <h1 className="text-2xl font-bold text-slate-900">{t(lang, "nf.title")}</h1>
      <p className="mt-3 text-base leading-relaxed text-slate-600">{t(lang, "nf.body")}</p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-[48px] items-center justify-center rounded-xl bg-brand-600 px-6 text-base font-semibold text-white shadow-sm hover:bg-brand-700"
      >
        {t(lang, "err.home")}
      </Link>
      <p className="mt-8 max-w-sm text-xs leading-relaxed text-slate-400">{t(lang, "err.privacy")}</p>
    </div>
  );
}
