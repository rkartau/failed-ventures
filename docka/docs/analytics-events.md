# Docka GA4 events

Last updated: 7 September 2026. GA4 property and web stream ids removed in the public archive. Code: `app/lib/consent.ts` (the path gate), `app/lib/analytics-events.ts` (event helper and the pure gtag reducers), `app/components/Analytics.tsx` (the loader), `app/components/TrackedLink.tsx` (the one tracked CTA link).

## What the property held on 7 September 2026 (live inspection, before this change)

GA4 is receiving data: 393 sessions from 80 users in the 47 days since 22 July 2026 (221 sessions in the last 28 days). The numbers are not clean, though:

- Enhanced Measurement "page changes" (history-change page views) was ON at property level. It fired its own page_views on private routes, so the property holds rows such as `/agent?q=<name>`, `/admin/seamen/<uuid>` and `/agent/<uuid>` (leak A, real, not hypothetical), and it double-counted the public pages the site already tracked manually: 1,741 page_views against 393 sessions.
- 350 of the 393 sessions come from Tallinn: owner and internal traffic, unfiltered.
- `accounts.google.com`, `checkout.stripe.com` and `billing.stripe.com` show up as Referral traffic (sign-in and billing round trips, not acquisitions).
- The only key event defined is `purchase`, which has never fired.
- Search Console is verified and healthy: the sitemap was read on 7 September 2026, 7 of 8 inspected URLs are indexed, and `/overview` is unknown to Google.

The GA4 Admin API was disabled in the Google Cloud project until 7 September 2026, so the property settings above were changed by hand. On 7 September 2026 we changed three of them in the GA4 Admin UI: Enhanced Measurement off, the unwanted-referral list, and event data retention (2 to 14 months). The internal-traffic filter remains with the owner. The owner enabled the Admin API the same day. API-confirmed on 7 September 2026 (read-only, service account, Admin API v1alpha and v1beta): enhanced measurement off at stream level (the seven sub-toggles are still stored as on underneath, so the master switch is the only thing holding them off), event retention 14 months with reset on new activity, key events: purchase, sign_up, sign_up_start and book_submit (the last three created through the Admin API at 12:30 UTC on 7 September 2026, during the audit and not by it, each counted once per session), five event-scoped custom dimensions (parameters location, target, step, persona, method; see the table below), Google signals off, no custom metrics, no Measurement Protocol secrets, one web stream, attribution data-driven with a 30-day acquisition and 90-day other lookback. The unwanted-referral list and the internal-traffic definition have no read endpoint in the Admin API, so those two stay UI-only checks. A quarterly recheck ran from a local script that is not part of this archive.

## What GA4 sees, and what it does not

GA4 counts consented visitors on the public pages only: every path in `app/lib/site-pages.ts` (the same list the sitemap is built from) plus /signup. Private surfaces (/agent, /seafarer, /share/<token>, /portal/<token>, /verify/<uuid>, /admin, /o/<token>, /u/<token>, /directory, /api) never load the tag. While a visitor is on one, `window["ga-disable-<GA_ID>"]` is true and the location is pinned to `https://docka.me/private`.

`/private` is a synthetic location for any residual auto-hit on private routes. It is not a real page. If it appears in a report, a property-level auto event fired on a private route with no path attached; the fix is at property level, and the site leaked nothing. Rows like `/agent?q=<name>` dated before this change went live are the old Enhanced Measurement leak, not the new code; they stop the day this ships. A data-deletion request for them was decided against on 7 September 2026: GA4 can only delete page parameters across all events, which would also erase public page history, so they age out with the 14-month retention.

Population: consented visitors on public pages; agent password signups only. Seafarer signups (the form is mounted on /seafarer, a private path) and Google-OAuth signups (they complete in `app/auth.ts` and land on a private page) are first-party only and never reach GA4.

First-party events are the truth for tokened outreach leads on all sides: `signup_started` (server-side, on a valid `/signup?t=` visit), `signup` (`app/app/api/signup/route.ts`) and `booking` (`app/app/api/book/route.ts`), all written through `lib/outreach-events`. GA4 never receives the `?t=` or `?lead=` token: on /signup and /book every hit sends the bare path.

Enhanced Measurement was turned off at property level on 7 September 2026 (before: all seven sub-toggles on, including history-change page views; after: page views only). Keep it off. Recheck it quarterly (next check due December 2026) in GA4 Admin, Data streams, the web stream, Enhanced measurement. The code pins `/private` and sets the disable flag regardless, so a slip at property level costs data quality, never a token.

Expect funnel steps 5 and 6 (`sign_up_start`, then `sign_up` or `book_submit`) to stay single-digit per month for months: they are consent-gated, count agent password signups only, and Docka's traffic is small. A zero there is not a bug.

## Event dictionary

| Event | Page | Trigger | Params | First-party counterpart |
|---|---|---|---|---|
| page_view | every public page | first load after Accept, and every route change to a public path | page_location, page_referrer | none |
| cta_click | /, /pricing, /contact, /verify, /overview/agencies, /overview/seafarers | click on a CTA | location (placement id, e.g. home_hero, pricing_plan, pricing_footer, contact, verify_portals, agencies_hero), target (bare path, or mailto, portal-link, verify-widget) | none |
| persona_select | /overview/agencies, /overview/seafarers | persona chooser | persona | none |
| sign_up_start | /signup | first focus or input inside the create-account form, once per mount; nothing on the sign-in tab | step: agent | signup_started (tokened visits only) |
| sign_up | /signup | POST /api/signup answered ok with recovery codes, fired before the sign-in leg; never for a side-bind of an existing account, never on the codes-lost path (that response confirms no creation) | method: password | signup |
| book_submit | /book | POST /api/book answered 2xx | none | booking |

Every event also carries `page_location` and `page_referrer: ""` (see the next section). Params are limited to the keys location, target, persona, method and step; a value must match `[A-Za-z0-9_./-]{1,64}`. Anything else is dropped together with its key. Event names outside the five above are rejected at runtime.

`page_location` is `https://docka.me` + the bare path + at most `utm_source`, `utm_medium` and `utm_campaign` (first occurrence, trimmed, spaces to `_`, `[A-Za-z0-9_.-]{1,64}`, lead-key shapes such as LD123 dropped). On /book and /signup the whole query is dropped. `page_referrer` is the referrer's origin only on first load (`https://www.google.com/`), empty for any docka.me host, and empty on every later hit.

## Custom dimensions (GA4 property, event-scoped)

Created through the Admin API at 12:30 UTC on 7 September 2026. Each one maps an event parameter to a dimension you can pick in reports and explorations.

| Parameter | Dimension name | Carried by |
|---|---|---|
| location | CTA location | cta_click |
| target | CTA target | cta_click |
| persona | Persona | persona_select |
| step | Signup step | sign_up_start |
| method | Signup method | sign_up |

A dimension fills only for events sent after it was created; older rows stay blank. A new dimension can take 24 to 48 hours to appear in the GA4 UI. In the funnel exploration they work as breakdowns, for example CTA location on the cta_click step shows which placement sends people on to /signup or /book.

## Why no per-lead data can reach GA4

gtag stamps every hit with `location.href` and `document.referrer` unless a hit overrides them. Two overrides run:

1. `gtag('set', {page_location, page_referrer})` on every route change, and inside the script's onLoad before `config` (the braces). On a private route the set value is `/private` with an empty referrer and the title "private".
2. Every `track()` call passes `page_location` and `page_referrer: ""` in the event params (the belt).

The 24 August 2026 rule "page_view only on /book and /signup, nothing else" is superseded by this document. Those two pages still send the bare path; now every other public page sends a page_view as well.

## Consent

Block-until-consent is unchanged: nothing loads before Accept, and Reject sets the ga-disable flag. Consent Mode "advanced" (cookieless pings while denied) is not built; that is the owner's decision. The privacy notice in six languages is unchanged.

Order of the consent calls (`app/components/Analytics.tsx`): the root layout's `beforeInteractive` snippet sends `consent default` with everything denied; once a stored choice exists, a `useEffect` sends `consent update` with `analytics_storage: granted` (or `denied` after Reject) and the three ad keys always `denied`; only then does the gtag script render, so `config` and the first `page_view` run after the update. Checked in a browser on 7 September 2026 with `GA_ID=G-TEST1234`: the first `collect` after Accept carries `gcs=G101` and the `_ga` cookie is set. GA4's tag-quality warning "0% consent rate detected" is computed from `ad_user_data` only, which Docka denies for everyone (no ads); it is expected and not a code defect.

## Funnel view (GA4 Explore)

Funnel exploration "Docka acquisition funnel" exists in the property since 7 September 2026, open funnel, breakdown by session default channel group: (1) page_view on any public page, (2) page_view where the path starts with /overview, /registries, /resources, /pricing or /what-is-primary-source-verification, (3) cta_click, (4) page_view on /signup or /book, (5) sign_up_start, (6) sign_up or book_submit. Counts on 7 September 2026: 76, 24, 6, 2, 0, 0. The date range is fixed to 22 July to 7 September 2026 (no earlier data); switch it to "Last 90 days" after 20 October 2026. Steps 5 and 6 only have data after this change went live. Key events `sign_up`, `sign_up_start` and `book_submit` exist since 12:30 UTC on 7 September 2026 (created by API, counted once per session), so the last two steps count as conversions from the first hit. The five custom dimensions above are the breakdowns to use on the cta_click and sign_up_start steps.

## Local proof

Run the dev server with `GA_ID=G-TEST1234` so nothing hits the production property, accept the cookie bar on a registry page and read the `collect` requests: `en=page_view` with `dl=https://docka.me/registries/estonia`; on `/signup?t=abc` a focus in the create form sends `en=sign_up_start` with `dl=https://docka.me/signup` and no `t=`; `/share/anything` sends no page_view and sets `window["ga-disable-G-TEST1234"]` to true.
