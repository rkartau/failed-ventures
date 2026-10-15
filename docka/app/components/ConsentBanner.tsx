"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/LanguageProvider";
import {
  CONSENT_CHANGE_EVENT,
  OPEN_CONSENT_EVENT,
  readConsentCookie,
  writeConsentCookie,
  type ConsentChoice,
} from "@/lib/consent";

// On-brand, accessible cookie-consent bar (AP5 / CNIL). Shows only when an
// analytics id is configured AND no prior choice is stored; a footer "Cookie
// settings" control re-opens it. Accept and Reject have EQUAL prominence (same
// size/weight, one click each). Writing the choice fires CONSENT_CHANGE_EVENT so
// <Analytics> loads or stays blocked.
//
// SEO plan v3 (R4 / S3) — no-CLS, no-focus-steal version:
//   - `initialOpen` comes from the SERVER (the root layout reads the consent cookie),
//     so the bar is in the first HTML paint and hydration never flips it. The state
//     equals the server value on the first client render by construction.
//   - The layout also stamps `consent-open` on <html> server-side; globals.css reserves
//     the bar's height as body padding under that class, so nothing is measured and
//     nothing shifts. The client toggles the class only on Accept / Reject / Escape /
//     reopen (the same transitions that change `open`).
//   - No autofocus: focus stays where the visitor is. Escape closes the bar via a
//     window-level keydown listener while it is open.
//   - `aria-live="polite"` announces the bar once without interrupting.
//   - Cookie / event contract (lib/consent.ts) is unchanged.

// The <html> class that reserves the bar's space (see app/globals.css).
export const CONSENT_OPEN_CLASS = "consent-open";

function setConsentOpenClass(open: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(CONSENT_OPEN_CLASS, open);
}

export function ConsentBanner({
  enabled,
  initialOpen = false,
}: {
  enabled: boolean;
  /** Server-decided first-paint state (root layout: analytics on AND no stored choice). */
  initialOpen?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState<boolean>(enabled && initialOpen);

  // Every client-side open/close goes through here so the reserved-space class on
  // <html> and the React state can never disagree.
  const transition = useCallback((next: boolean) => {
    setOpen(next);
    setConsentOpenClass(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Sync to the stored choice (a no-op on a normal first visit: the server already
    // rendered the bar open and the cookie is still absent). Closes the SSR-open bar
    // only if a choice was stored between the server render and hydration.
    const stored = readConsentCookie();
    if (stored !== null) transition(false);
    const reopen = () => transition(true);
    window.addEventListener(OPEN_CONSENT_EVENT, reopen);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, reopen);
  }, [enabled, transition]);

  // Escape dismisses without choosing (re-openable from the footer). Window-level:
  // the bar no longer takes focus, so a key handler on the bar itself would never fire.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") transition(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, transition]);

  const choose = useCallback(
    (choice: ConsentChoice) => {
      writeConsentCookie(choice);
      window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
      transition(false);
    },
    [transition]
  );

  if (!enabled || !open) return null;

  const buttonBase =
    "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 sm:flex-none";

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-live="polite"
      aria-labelledby="docka-consent-title"
      aria-describedby="docka-consent-body"
      data-testid="consent-banner"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-brand-200 bg-white"
    >
      {/* One fixed bar of KNOWN height (globals.css reserves it): sentence on the left,
          the Accept / Reject pair on the right. On phones the pair stacks vertically
          beside the text so the bar height is set by the two 44px buttons, not by how
          many lines the longest translation wraps to. */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2 sm:gap-4 sm:px-4">
        <h2 id="docka-consent-title" className="sr-only">
          {t("consent.title")}
        </h2>
        <p id="docka-consent-body" className="min-w-0 flex-1 text-xs leading-snug text-slate-600">
          {t("consent.body")}{" "}
          <Link
            href="/privacy"
            className="font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800"
          >
            {t("consent.learnMore")}
          </Link>
        </p>
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row sm:gap-2">
          {/* Accept + Reject: identical size/weight, one click each (CNIL equal
              prominence). Accept is filled, Reject outlined; same box, same text. */}
          <button
            type="button"
            onClick={() => choose("granted")}
            data-testid="consent-accept"
            className={`${buttonBase} bg-brand-600 text-white hover:bg-brand-700`}
          >
            {t("consent.accept")}
          </button>
          <button
            type="button"
            onClick={() => choose("denied")}
            data-testid="consent-reject"
            className={`${buttonBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
          >
            {t("consent.reject")}
          </button>
        </div>
      </div>
    </div>
  );
}
