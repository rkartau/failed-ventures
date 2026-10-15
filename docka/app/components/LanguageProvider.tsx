"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t as translate, type Lang } from "@/lib/i18n";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<Ctx | null>(null);

// Root client provider. Seeded from `initialLang` (read server-side from the
// cookie so the first paint is already in the right language, no flash), and
// updates a cookie + localStorage on change so BOTH server components (via cookie
// on refresh) and client components (via context) stay in sync.
export function LanguageProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [lang, setLangState] = useState<Lang>(isLang(initialLang) ? initialLang : DEFAULT_LANG);

  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      try {
        document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
        localStorage.setItem(LANG_COOKIE, l);
        document.documentElement.lang = l;
      } catch {
        /* best-effort */
      }
      // Re-render server components (nav, footer, share intro) in the new language.
      router.refresh();
    },
    [router]
  );

  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);

  return <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>;
}

export function useT(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    // Safe fallback if used outside a provider (e.g. an isolated test render).
    return {
      lang: DEFAULT_LANG,
      setLang: () => {},
      t: (key, vars) => translate(DEFAULT_LANG, key, vars),
    };
  }
  return ctx;
}
