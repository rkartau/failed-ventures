"use client";

import { useT } from "@/components/LanguageProvider";
import { OPEN_CONSENT_EVENT } from "@/lib/consent";

// Small footer control that re-opens the consent banner so a visitor can change
// their choice at any time. Rendered only when an analytics id is configured (else
// there is nothing to control).
export function CookieSettingsLink({ enabled }: { enabled: boolean }) {
  const { t } = useT();
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))}
      className="text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
    >
      {t("footer.cookieSettings")}
    </button>
  );
}
