"use client";

import Link from "next/link";
import { useT } from "@/components/LanguageProvider";

// Public Sample Profiles — the banner atop both /sample pages. Honest wording per
// the overview honesty rule: the DATA is fictional, the PRODUCT is real. Terse UI
// copy rule: buttons ≤2 words; the explanation lives in the one short line.
//
// i18n (Phase 6): a CLIENT component on useT — the root layout seeds
// LanguageProvider from the cookie server-side, so the SERVER-RENDERED HTML is
// already localised (the JS-disabled ru/zh renders stay honest) without this
// component adding its own cookies() dynamic opt-in to the /sample pages.
export function SampleBanner({
  cta,
}: {
  /** The signup call-to-action target for this surface (/seafarer or /agent). */
  cta: { href: string };
}) {
  const { t } = useT();
  return (
    <div
      data-testid="sample-banner"
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-bold text-amber-900">
          <span className="mr-2 inline-block rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
            {t("sample.badge")}
          </span>
          {t("sample.bannerTitle")}
        </p>
        <p className="mt-0.5 text-xs text-amber-800">{t("sample.bannerBody")}</p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Link
          href={cta.href}
          data-testid="sample-banner-cta"
          className="inline-flex min-h-[44px] items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          {t("sample.bannerCta")}
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
        >
          {t("sample.learnMore")}
        </Link>
      </div>
    </div>
  );
}
