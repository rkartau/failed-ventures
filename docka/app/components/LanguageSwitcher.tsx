"use client";

import { LANGS, isLang } from "@/lib/i18n";
import { useT } from "@/components/LanguageProvider";

// Global language picker, shown in the header on every page so a low-English
// seafarer can switch the whole UI to his own language from anywhere.
export function LanguageSwitcher() {
  const { lang, setLang, t } = useT();
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{t("lang.language")}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <select
        value={lang}
        data-testid="lang-switcher"
        onChange={(e) => {
          if (isLang(e.target.value)) setLang(e.target.value);
        }}
        aria-label={t("lang.language")}
        className="min-h-[44px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-medium text-slate-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
