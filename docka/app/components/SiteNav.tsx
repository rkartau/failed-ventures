"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/LanguageProvider";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

// Site header navigation (F-mobile-nav). Extracted from the server layout into a
// small client component so it can hold the mobile hamburger toggle state.
//
// - md+ (desktop): renders the inline links exactly as the header did before —
//   6 links + the language switcher, right-aligned. No visual change.
// - < md (phones): the inline links collapse behind a hamburger button; the
//   language switcher stays visible (as it always was) so a low-English seafarer
//   can still switch languages in one tap. The button toggles a full-width menu
//   that drops below the sticky header and closes on navigate / Escape / outside
//   click.
//
// Single source of truth for the link list so desktop + mobile never drift.
const NAV_LINKS: { href: string; key: string }[] = [
  { href: "/overview", key: "nav.overview" },
  // Positioning batch 2026-09-07: the agency product page earns a nav entry, because
  // the nav is the only chrome on every page. Label is the shortest agency-facing
  // string available ("Agency CRM"). /book stays the last entry.
  { href: "/overview/agencies", key: "nav.agencies" },
  // Nav menu "Seafarer" points at the INDEXABLE informational page, not the
  // noindex app auth shell at /seafarer (SEO A2 — nav trap fix). Functional
  // "enter the app" CTAs (home hero, overview CTAs) still link to /seafarer.
  { href: "/overview/seafarers", key: "nav.seafarer" },
  { href: "/agent", key: "nav.agent" },
  { href: "/verify", key: "nav.verify" },
  // SEO Phase 2c — surface the indexable content hubs in the header so they are
  // reachable in one click (previously only footer-linked). Registry coverage sits
  // next to Verify; Resources (guides) next to Pricing. The desktop header is
  // flex-wrap + min-w-0 (see the wrapper below) so 8 items wrap cleanly instead of
  // overflowing; the mobile menu is a vertical list, so more items are fine there.
  { href: "/registries", key: "nav.registries" },
  { href: "/pricing", key: "nav.pricing" },
  { href: "/resources", key: "nav.resources" },
  { href: "/book", key: "nav.book" },
];

export function SiteNav() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  // Close the mobile menu on Escape or on a pointer down outside the nav.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <nav ref={navRef} className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 text-sm">
      {/* Desktop (md+): inline links — identical to the pre-existing header. */}
      <div className="hidden min-w-0 flex-wrap items-center justify-end gap-0.5 md:flex">
        {NAV_LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="inline-flex min-h-[44px] items-center rounded-lg px-2 py-2 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            {t(l.key)}
          </Link>
        ))}
      </div>

      {/* Language switcher: visible at every width, exactly as before. */}
      <span className="ml-1">
        <LanguageSwitcher />
      </span>

      {/* Mobile (< md): hamburger toggle. Real <button> with aria-expanded +
          aria-controls + a translated aria-label (icon-only control). */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="site-mobile-nav"
        aria-label={t("nav.menu")}
        onClick={() => setOpen((v) => !v)}
        className="ml-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 md:hidden"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {open ? (
            <>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </>
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>

      {/* Mobile dropdown — absolutely positioned under the sticky header (the
          header is `relative`), full-width, hidden at md+. Each link closes the
          menu on navigate. */}
      {open ? (
        <div
          id="site-mobile-nav"
          className="absolute inset-x-0 top-full border-b border-slate-200 bg-white shadow-lg md:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-0.5 px-4 py-2">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="inline-flex min-h-[44px] items-center rounded-lg px-3 py-2.5 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                {t(l.key)}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  );
}
