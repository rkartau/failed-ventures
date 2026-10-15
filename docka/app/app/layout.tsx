import type { Metadata, Viewport } from "next";
import Link from "next/link";
import Script from "next/script";
import { cookies } from "next/headers";
import "./globals.css";
import { Logo } from "@/components/Logo";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { LanguageProvider } from "@/components/LanguageProvider";
import { SiteNav } from "@/components/SiteNav";
import { Analytics } from "@/components/Analytics";
import { ConsentBanner } from "@/components/ConsentBanner";
import { CookieSettingsLink } from "@/components/CookieSettingsLink";
import { CONSENT_COOKIE, isConsentChoice } from "@/lib/consent";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";
import { SITE_URL, SITE_DESCRIPTION, META_DESCRIPTION, abs, jsonLd } from "@/lib/seo";

// Two single-sourced sentences in @/lib/seo: META_DESCRIPTION (<=160, the SERP snippet:
// <meta description> + OG/twitter) and SITE_DESCRIPTION (the longer entity sentence for
// the Organization JSON-LD and /llms.txt).
const ROOT_DESCRIPTION = META_DESCRIPTION;
const ROOT_TITLE = "Crewing Agency CRM with Seafarer Certificate Checks · Docka";
// The social image is the file-convention app/opengraph-image.jpg (1200x630); explicit
// dimensions + alt everywhere it is referenced (the hashed URL is accepted as-is).
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: ROOT_TITLE,
    template: "%s · Docka",
  },
  description: ROOT_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  // NOTE: no root-level alternates.canonical — a canonical set here cascades to every
  // non-overriding route (e.g. bare /verify) and would wrongly point them at "/".
  // Each marketing page sets its own canonical instead.
  openGraph: {
    type: "website",
    siteName: "Docka",
    locale: "en",
    url: SITE_URL,
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    images: [{ url: "/opengraph-image.jpg", width: 1200, height: 630, alt: OG_IMAGE_ALT }],
  },
  twitter: {
    card: "summary_large_image",
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    images: [{ url: "/twitter-image.jpg", alt: OG_IMAGE_ALT }],
  },
};

// Browser-chrome colour (matches manifest.webmanifest theme_color). Next 14 wants this in
// the dedicated `viewport` export, not inside `metadata`.
export const viewport: Viewport = { themeColor: "#0f172a" };

// Organization + WebSite structured data — emitted ONCE, site-wide (TS4). Static,
// no PII, absolute URLs. logo points at the file-convention favicon.
// WP-B (schema.md Fix A, trimmed by plan R9): registry identifier, public email,
// knowsAbout, and ONLY verified sameAs URLs. No founder/foundingDate/street/postal/vatID.
const ORG_WEBSITE_JSONLD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": abs("/#organization"),
      name: "Docka",
      legalName: "Docka Development OÜ",
      alternateName: "docka.me",
      url: SITE_URL,
      // ImageObject (not a bare URL) so the logo carries explicit dimensions — the
      // file-convention favicon app/icon.png is 512×512. Kept INLINE (seo-phase2a reads
      // org.logo.width) and given an @id so `image` can reference the same node.
      logo: {
        "@type": "ImageObject",
        "@id": abs("/#logo"),
        url: abs("/icon.png"),
        contentUrl: abs("/icon.png"),
        width: 512,
        height: 512,
        caption: "Docka logo",
      },
      image: { "@id": abs("/#logo") },
      description: SITE_DESCRIPTION,
      email: "info@docka.me",
      identifier: {
        "@type": "PropertyValue",
        propertyID: "Estonian commercial registry code",
        value: "17579582",
      },
      address: {
        "@type": "PostalAddress",
        addressLocality: "Tallinn",
        addressRegion: "Harju County",
        addressCountry: "EE",
      },
      areaServed: "Worldwide",
      knowsAbout: [
        "Crewing agency CRM",
        "Crew management software",
        "Seafarer document management",
        "STCW certificate verification",
        "Primary source verification",
        "Port State Control compliance",
      ],
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: "info@docka.me",
          url: abs("/contact"),
          availableLanguage: ["en"],
          areaServed: "Worldwide",
        },
      ],
      // sameAs: ONLY URLs verified to resolve (plan R9). The Estonian e-Business Register
      // card for registry code 17579582 returns 200 and names "Docka Development OÜ"
      // (checked 6 September 2026). The LinkedIn company page /company/docka-me/ was
      // created by the owner and confirmed live in a browser on 7 September 2026 (curl
      // with a browser UA also returned 200 with "Docka" in the body). GitHub org /
      // directory listings are added once they exist and are browser-verified.
      sameAs: [
        "https://ariregister.rik.ee/eng/company/17579582",
        "https://www.linkedin.com/company/docka-me/",
      ],
    },
    {
      "@type": "WebSite",
      "@id": abs("/#website"),
      name: "Docka",
      url: SITE_URL,
      publisher: { "@id": abs("/#organization") },
      inLanguage: "en",
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Language comes from a cookie so the first server render is already localised
  // (no flash), and both server + client stay in sync when the user switches.
  const raw = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(raw) ? raw : DEFAULT_LANG;

  // RUNTIME analytics config (AP4) — read server-side so the box can set/override
  // without a rebuild. The measurement id / container id are PUBLIC (they appear in
  // page source by design). In the public archive the original ids were removed, so
  // analytics stays dormant unless GA_ID / GTM_ID are set.
  const gaId = process.env.GA_ID ?? "";
  const gtmId = process.env.GTM_ID ?? "";
  const analyticsEnabled = Boolean(gaId || gtmId);

  // Consent bar first-paint state (SEO plan v3 R4/S3): open only when analytics is on
  // AND no choice is stored. The SAME value drives the reserved-space class on <html>
  // (globals.css `.consent-open body { padding-bottom }`) and the bar's `initialOpen`,
  // so the server HTML already contains the bar and its space: no measure, no shift.
  const consentOpen = analyticsEnabled && !isConsentChoice(cookies().get(CONSENT_COOKIE)?.value);

  return (
    <html lang={lang} className={consentOpen ? "consent-open" : undefined}>
      <body>
        {/* Site-wide Organization + WebSite JSON-LD (TS4) — server-rendered once. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(ORG_WEBSITE_JSONLD) }}
        />
        {/* Consent Mode v2 default-DENIED (AP3) — MUST run before any GA/GTM tag.
            Defines window.dataLayer + gtag and denies all storage until the visitor
            grants it. beforeInteractive => hoisted ahead of the afterInteractive GA
            scripts. Only emitted when an analytics id is configured (else dormant). */}
        {analyticsEnabled ? (
          <Script id="consent-default" strategy="beforeInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});`}
          </Script>
        ) : null}
        {analyticsEnabled ? <Analytics gaId={gaId} gtmId={gtmId} /> : null}
        <LanguageProvider initialLang={lang}>
          <ServiceWorkerRegister />
          {analyticsEnabled ? <ConsentBanner enabled initialOpen={consentOpen} /> : null}
          {/* Global impersonation banner (tri-state) — shows on every page while an
              admin is acting as a seaman/agent, or while a session is suspended. */}
          <ImpersonationBanner />
          <div className="min-h-screen flex flex-col">
            <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur relative">
              {/* F9: flex-wrap + min-w-0 so the nav WRAPS on narrow phones
                  instead of forcing the whole page to scroll sideways. The nav
                  itself is a client component (SiteNav) so it can collapse the
                  links behind a hamburger below `md` (F-mobile-nav); `relative`
                  on the header anchors that dropdown panel. */}
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                <Link href="/" className="flex items-center gap-2">
                  <Logo />
                </Link>
                <SiteNav />
              </div>
            </header>

            <main className="flex-1">{children}</main>

            <footer className="border-t border-slate-200 bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-slate-500">
                <p>{t(lang, "footer.tagline")}</p>
                <p className="mt-1 text-xs text-slate-400">{t(lang, "footer.privacy")}</p>
                {/* SEO Phase 2b — "Resources" footer link group. Lower-risk than a top-nav
                    change; makes the new marketing pages crawlable from every page. English
                    labels (these pages are English-only content). */}
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Resources
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link
                    href="/about"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    About
                  </Link>
                  <Link
                    href="/registries"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    Registries we verify
                  </Link>
                  <Link
                    href="/resources"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    Guides
                  </Link>
                </p>
                <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {/* The agency product page. The header nav links it too (nav.agencies,
                      positioning batch 2026-09-07); the footer keeps a second, differently
                      worded entry point on every page, so the anchor text is not repeated. */}
                  <Link
                    href="/overview/agencies"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    Crew compliance for agencies
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    {t(lang, "nav.pricing")}
                  </Link>
                  <Link
                    href="/privacy"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    {t(lang, "footer.privacyLink")}
                  </Link>
                  <Link
                    href="/contact"
                    className="inline-block py-2 text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    {t(lang, "footer.contactLink")}
                  </Link>
                  {analyticsEnabled ? <CookieSettingsLink enabled={analyticsEnabled} /> : null}
                </p>
              </div>
            </footer>
          </div>
        </LanguageProvider>
      </body>
    </html>
  );
}
