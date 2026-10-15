"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  CONSENT_CHANGE_EVENT,
  readConsentCookie,
  shouldRenderTag,
  type ConsentChoice,
} from "@/lib/consent";
import { onTagLoaded, routeReducer, type GtagArgs } from "@/lib/analytics-events";

// Consent-gated analytics loader (AP3/AP4): block-until-consent AND trackable-
// path-only. The GA4 gtag library and the GTM container are rendered ONLY when
// stored consent === "granted" AND the current path is on the public allowlist
// (lib/consent shouldRenderTag) — nothing loads, no Google request fires and no
// cookie is set otherwise. Private routes (/agent*, /share/<token>, /verify/<uuid>,
// /portal/<token>, …) are pinned to the synthetic location SITE_URL + "/private"
// via gtag('set') and the per-id hard-stop flag window["ga-disable-<id>"] is set,
// so a property-level auto event that still fires carries no path and no hit
// leaves the browser. The Consent Mode v2 default-DENIED snippet (root layout,
// beforeInteractive) runs first and defines window.gtag / window.dataLayer, so
// this component only ever loads the network scripts and sends SANITIZED manual
// page_views (bare path + bounded utm_, origin-only referrer on first load).
//
// The pure reducers live in lib/analytics-events.ts; this file only wires them to
// React state. Nothing renders when both ids are absent (dormant) or before consent.

function applyCalls(calls: GtagArgs[]): void {
  const gtag = window.gtag;
  if (typeof gtag !== "function") return;
  for (const args of calls) gtag(...args);
}

export function Analytics({ gaId, gtmId }: { gaId: string; gtmId: string }) {
  const pathname = usePathname();
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  // gtag('config') has run — only then is it safe to send page_view events.
  const configured = useRef(false);
  // Bare path of the last page_view sent (null after a private route), so the
  // onLoad page_view and the route effect can never double-count one page.
  const lastSentPath = useRef<string | null>(null);
  const granted = choice === "granted";

  // Sync the stored choice on mount and whenever the banner writes a new one.
  useEffect(() => {
    const sync = () => setChoice(readConsentCookie());
    sync();
    window.addEventListener(CONSENT_CHANGE_EVENT, sync);
    return () => window.removeEventListener(CONSENT_CHANGE_EVENT, sync);
  }, []);

  // Mirror the stored choice into Consent Mode once a choice actually exists. On a
  // returning "granted" visitor this re-grants (default was denied); a later Reject
  // via cookie settings pushes an explicit denied update.
  useEffect(() => {
    if (choice === null) return;
    const gtag = window.gtag;
    if (typeof gtag !== "function") return;
    gtag("consent", "update", {
      analytics_storage: granted ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }, [choice, granted]);

  // Route + consent reducer, UNCONDITIONALLY on every pathname/consent change:
  // hard-stop flag, private pin or real location, SPA page_view when allowed.
  useEffect(() => {
    if (!pathname) return;
    const next = routeReducer({
      pathname,
      search: window.location.search,
      granted,
      gaId,
      gtmId,
      configured: configured.current,
      lastSentPath: lastSentPath.current,
    });
    if (gaId) (window as unknown as Record<string, unknown>)[`ga-disable-${gaId}`] = next.disable;
    lastSentPath.current = next.lastSentPath;
    applyCalls(next.calls);
  }, [pathname, granted, gaId, gtmId]);

  if (!shouldRenderTag({ granted, pathname, gaId, gtmId })) return null;

  return (
    <>
      {gaId ? (
        <Script
          id="ga4-gtag"
          strategy="afterInteractive"
          src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
          onLoad={() => {
            const gtag = window.gtag;
            if (typeof gtag !== "function") return;
            gtag("js", new Date());
            // set(location) BEFORE config; send_page_view:false → our own SANITIZED
            // page_view (public path only). anonymize_ip is default in GA4.
            const loaded = onTagLoaded({
              gaId,
              pathname: window.location.pathname,
              search: window.location.search,
              referrer: document.referrer,
            });
            configured.current = true;
            lastSentPath.current = loaded.lastSentPath;
            applyCalls(loaded.calls);
          }}
        />
      ) : null}

      {gtmId ? (
        // Standard GTM bootstrap — pushes gtm.start to the SAME dataLayer and injects
        // gtm.js. The container is EMPTY (no GA4 tag inside), so it double-counts
        // nothing; it exists for the owner's future non-GA tags. Same render gate as the
        // gtag script: consent granted AND a public path.
        <Script
          id="gtm-loader"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId}');`,
          }}
        />
      ) : null}
    </>
  );
}
