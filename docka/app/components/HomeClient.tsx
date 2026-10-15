"use client";

import Link from "next/link";
import { TrackedLink } from "@/components/TrackedLink";
import { VerifyBox } from "@/components/VerifyBox";
import { VerificationLevelBadge } from "@/components/VerificationLevelBadge";
import { useT } from "@/components/LanguageProvider";
// Hero country list derived from countries.ts at render time (shared helpers
// with the /verify page — see lib/registry/display.ts). Includes the UA TCCS
// connector as Ukraine (owner 2026-07-21), no separate TCCS sentence; the
// HERO list is deduped by isoRegion so Ukraine's TWO connectors (TCCS +
// MARAD) name the country ONCE (review fix 2026-08-13 — /verify keeps both).
// The trust bar uses its OWN derivation (TRUST_BAR_AUTHORITIES): flag-state
// authorities only — TCCS is a training centre, never presented as government.
import {
  HERO_AUTO_REGISTRY_COUNTRIES,
  TRUST_BAR_AUTHORITIES,
  countryDisplayName,
  displayRegion,
  isoRegion,
  joinNames,
} from "@/lib/registry/display";

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 text-sm font-bold text-brand-700">
        {n}
      </div>
      <h3 className="mt-3 font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
    </div>
  );
}

function Pillar({
  title,
  body,
  testid,
  children,
}: {
  title: string;
  body: string;
  testid?: string;
  children?: React.ReactNode;
}) {
  return (
    <div data-testid={testid} className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
      {children}
    </div>
  );
}

// One row of the pillar-4 trust ladder: the REUSED in-app level chip (exact
// product colors — the homepage can never drift from the real badges) + the
// localized plain-language line.
function LadderRow({ level, text }: { level: 0 | 1 | 2 | 3; text: string }) {
  return (
    <li className="flex items-start gap-2">
      <VerificationLevelBadge level={level} tooltip={text} size="sm" />
      <span className="text-xs leading-5 text-slate-500">{text}</span>
    </li>
  );
}

// Client hero for the home page. Split out of app/page.tsx so that route can be a
// SERVER component exporting `metadata`; this stays a client child (useT + VerifyBox
// need it) and is still rendered inside LanguageProvider by the root layout.
export function HomeClient() {
  const { t, lang } = useT();
  const autoNames = HERO_AUTO_REGISTRY_COUNTRIES.map((c) =>
    countryDisplayName(c.country, lang, c.countryName)
  );
  return (
    <div className="hero-bg">
      <section className="mx-auto max-w-6xl px-4 pb-4 pt-14 sm:pt-20">
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <div>
            {/* Honest capability statement (owner 2026-07-21): name ONLY the
                countries that verify automatically. The list is derived from
                countries.ts capabilities at render time — never hardcoded. */}
            <p className="inline-block max-w-xl rounded-2xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-semibold leading-snug text-brand-700">
              {t("home.badge", { countries: joinNames(autoNames, lang) })}
            </p>
            <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-5xl">
              {t("home.title")}
            </h1>
            <p className="mt-4 max-w-xl text-lg text-slate-600">{t("home.subtitle")}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              {/* Primary CTA on MOBILE (the VerifyBox stacks below the fold —
                  this anchor jumps straight to the live demo); demoted to a
                  secondary outline at lg:, where the widget is already visible
                  in the adjacent column — one blue primary per viewport.
                  border-transparent at base so the lg: border doesn't shift
                  layout. */}
              {/* GA4 funnel: the four hero CTAs fire cta_click {location:"home_hero"}
                  via the ONE TrackedLink (bare-path targets only, PII-free). */}
              <TrackedLink
                href="#verify"
                location="home_hero"
                cta="verify-widget"
                className="rounded-xl border border-transparent bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 lg:border-brand-300 lg:bg-white lg:text-brand-700 lg:hover:bg-brand-50"
              >
                {t("home.verifyCta")}
              </TrackedLink>
              <TrackedLink
                href="/seafarer"
                location="home_hero"
                className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                {t("home.imSeafarer")}
              </TrackedLink>
              <TrackedLink
                href="/agent"
                location="home_hero"
                className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                {t("home.imAgent")}
              </TrackedLink>
              <TrackedLink
                href="/book"
                location="home_hero"
                className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                {t("home.book")}
              </TrackedLink>
            </div>
            {/* R6: half of docka.me's audience is a seafarer on a phone. One sentence,
                right under the CTA row, so the CRM section below never reads as an
                eviction notice. It also states the grant model in plain words. */}
            <p className="mt-3 max-w-xl text-sm text-slate-600">{t("home.seafarerFree")}</p>
            {/* Public Sample Profiles (Phase 6) — terse demo entry links directly
                under the two role CTAs: see the product live before signing up. */}
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <Link
                href="/sample/seafarer"
                data-testid="home-sample-seafarer"
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                {t("home.sampleProfile")} →
              </Link>
              <Link
                href="/sample/agency"
                data-testid="home-sample-agency"
                className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                {t("home.sampleBoard")} →
              </Link>
            </div>
            {/* OC3 — descriptive internal links to the marketing overview pages
                (strong on-page signal; keyword-rich anchors, crawlable). */}
            <div className="mt-5 flex flex-col gap-1 text-sm">
              <Link
                href="/overview/agencies"
                className="w-fit font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                {t("home.seeAgencies")} →
              </Link>
              <Link
                href="/overview/seafarers"
                className="w-fit font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
              >
                {t("home.seeSeafarers")} →
              </Link>
            </div>
          </div>

          {/* lg:self-start (SEO plan v3 C10): at the 2-column breakpoint (parent
              grid is items-start lg:grid-cols-2) the widget top-aligns with the
              hero copy so the verifier is above the fold on desktop. Mobile
              stacking is unchanged. */}
          <div id="verify" className="scroll-mt-24 lg:self-start">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-bold text-slate-900">{t("home.tryTitle")}</h2>
              <span className="text-xs text-slate-500">{t("home.liveLookup")}</span>
            </div>
            <VerifyBox />
            <p className="mt-2 text-center text-xs text-slate-500">{t("home.verifyHint")}</p>
          </div>
        </div>
      </section>

      {/* The shipped agency CRM (positioning batch 2026-09-07, plan v4 §2d). Six cards on
          the EXISTING Pillar component (no new card component), each tagged
          data-testid="home-crm-card". The closing link is a tinted TEXT link, never a
          second blue primary: the hero #verify anchor stays the only one on the page. */}
      <section className="mx-auto max-w-6xl px-4 py-10" data-testid="home-crm">
        <h2 className="text-xl font-bold text-slate-900">{t("home.crmTitle")}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Pillar testid="home-crm-card" title={t("home.crm1t")} body={t("home.crm1b")} />
          <Pillar testid="home-crm-card" title={t("home.crm2t")} body={t("home.crm2b")} />
          <Pillar testid="home-crm-card" title={t("home.crm3t")} body={t("home.crm3b")} />
          <Pillar testid="home-crm-card" title={t("home.crm4t")} body={t("home.crm4b")} />
          <Pillar testid="home-crm-card" title={t("home.crm5t")} body={t("home.crm5b")} />
          <Pillar testid="home-crm-card" title={t("home.crm6t")} body={t("home.crm6b")} />
        </div>
        <p className="mt-4 text-sm">
          <Link
            href="/overview/agencies"
            className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500"
          >
            {t("home.crmCta")} →
          </Link>
        </p>
      </section>

      {/* Trust bar — authority chips DERIVED from countries.ts (flag-state
          full-auto entries only; membership can never drift from what the code
          actually verifies against). No flags, no logos, no counts. */}
      <section className="mx-auto max-w-6xl px-4 py-6">
        <h2 className="text-sm font-semibold text-slate-700">{t("home.trustTitle")}</h2>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          {TRUST_BAR_AUTHORITIES.map((c) => (
            <li
              key={c.country}
              data-testid="trust-bar-chip"
              title={`${countryDisplayName(isoRegion(c.country), lang, c.countryName)} — ${c.authority}`}
              className="flex items-center gap-2 text-sm text-slate-600"
            >
              <span className="inline-flex h-6 min-w-[2rem] items-center justify-center rounded-md bg-brand-100 px-1.5 text-xs font-bold text-brand-700">
                {displayRegion(c.country)}
              </span>
              <span>{c.authorityShort ?? c.authority}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Value pillars — the PSV pitch for the buying audience. Pillar 4
          embeds the L0–L3 ladder (reused product badges, emerald = L3 only). */}
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h2 className="text-xl font-bold text-slate-900">{t("home.pillarsTitle")}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Pillar title={t("home.pillar1t")} body={t("home.pillar1b")} />
          <Pillar title={t("home.pillar2t")} body={t("home.pillar2b")} />
          <Pillar title={t("home.pillar3t")} body={t("home.pillar3b")} />
          <Pillar title={t("home.pillar4t")} body={t("home.pillar4b")}>
            <ul className="mt-3 space-y-2">
              <LadderRow level={3} text={t("home.lvl3")} />
              <LadderRow level={2} text={t("home.lvl2")} />
              <LadderRow level={1} text={t("home.lvl1")} />
              <LadderRow level={0} text={t("home.lvl0")} />
            </ul>
          </Pillar>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-12">
        <h2 className="text-xl font-bold text-slate-900">{t("home.howTitle")}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Step n={1} title={t("home.step1t")} body={t("home.step1b")} />
          <Step n={2} title={t("home.step2t")} body={t("home.step2b")} />
          <Step n={3} title={t("home.step3t")} body={t("home.step3b")} />
        </div>
      </section>
    </div>
  );
}
