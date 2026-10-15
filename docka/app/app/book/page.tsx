import type { Metadata } from "next";
import { cookies } from "next/headers";
import { readDB } from "@/lib/db";
import {
  businessNowParts,
  excludeBusySlots,
  generateSlots,
  getBookingSettings,
  pickLeadKey,
} from "@/lib/booking";
import { calendarConfigured, getBusyWallRangesForRender } from "@/lib/google-calendar";
import { DEFAULT_LANG, LANG_COOKIE, isLang, t, type Lang } from "@/lib/i18n";
import { CONTENT_LAST_UPDATED_ISO, breadcrumbList, jsonLd, webPageJsonLd } from "@/lib/seo";
import { WhatDockaIs } from "@/components/WhatDockaIs";
import { BookClient } from "./BookClient";

// PUBLIC, unauthenticated "Book a call" page (Wave-4 §D). force-dynamic: availability
// must be fresh per request (a slot booked seconds ago must disappear), and this page
// reads the JSON store. It is NOT under the admin static-isolation guard.
//
// R1 fail-soft: slot computation is wrapped in try/catch so a corrupt settings/bookings
// state renders the "no times" empty state instead of a 500 — a bad admin state can never
// brick the customer-facing page. getBookingSettings already falls back to defaults.
export const dynamic = "force-dynamic";

// WP-B: SERP-length title/description (onpage §3), brand capitalised, plain punctuation.
// The visible H1/intro stay on the i18n keys (book.title / book.intro).
const TITLE = "Book a Demo of the Crewing Agency CRM";
const DESCRIPTION =
  "Pick an open slot and see the Docka crewing agency CRM on a live call. We open the crew board and check a real certificate against its registry.";
const OG_IMAGE_ALT = "Docka: live seafarer certificate verification against flag-state registries";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/book" },
  openGraph: {
    type: "website",
    url: "/book",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image.jpg", width: 1200, height: 630, alt: OG_IMAGE_ALT }],
  },
  twitter: {
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/twitter-image.jpg", alt: OG_IMAGE_ALT }],
  },
};

// Home › Book a call (selfPath gives the "#breadcrumb" @id the WebPage node references).
const BREADCRUMB_JSONLD = breadcrumbList(
  [
    { name: "Home", path: "/" },
    { name: "Book a call", path: "/book" },
  ],
  "/book"
);

const WEBPAGE_JSONLD = webPageJsonLd({
  path: "/book",
  name: TITLE,
  description: DESCRIPTION,
  dateModified: CONTENT_LAST_UPDATED_ISO,
});

export default async function BookPage({
  searchParams,
}: {
  searchParams: { lead?: string | string[] };
}): Promise<JSX.Element> {
  const raw = cookies().get(LANG_COOKIE)?.value;
  const lang: Lang = isLang(raw) ? raw : DEFAULT_LANG;

  // Outreach attribution: the per-lead ?lead=<send_key> token, sanitized here and
  // re-sanitized server-side in /api/book. Absent/malformed -> undefined (booking
  // still records as source:"public"). Passed down to the client island only.
  const leadKey = pickLeadKey(searchParams?.lead);

  const now = new Date();
  const db = readDB();
  const settings = getBookingSettings(db);
  let slots: Array<{ date: string; time: string; tz: string }> = [];
  try {
    slots = generateSlots(settings, db.bookings, now);
  } catch {
    slots = []; // fail-soft — never 500 the public page
  }

  // Two-way availability (PLAN v8): hide slots overlapping the shared calendar's busy
  // times. Fail-soft — any Google error leaves the docka-only slots; `stale` shows the
  // soft "availability may be approximate" note (AV9-2). POST is the authoritative gate.
  let stale = false;
  if (calendarConfigured()) {
    try {
      const busy = await getBusyWallRangesForRender(settings, now);
      slots = excludeBusySlots(slots, busy.ranges, settings.slotMinutes);
      stale = busy.stale;
    } catch {
      /* fail-soft */
    }
  }

  // Business-tz "today" (YYYY-MM-DD) as a derived prop so the calendar can mark
  // today correctly regardless of the visitor's own device timezone. Reuses the
  // single clock primitive; never throws.
  let today = "";
  try {
    today = businessNowParts(settings.timezone, new Date()).date;
  } catch {
    today = "";
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(BREADCRUMB_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(WEBPAGE_JSONLD) }}
      />
      <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
        {t(lang, "book.title")}
      </h1>
      <p className="mt-4 max-w-xl text-lg text-slate-600">{t(lang, "book.intro")}</p>

      <WhatDockaIs />

      <div className="mt-8">
        <BookClient
          slots={slots}
          tz={settings.timezone}
          today={today}
          stale={stale}
          {...(leadKey ? { leadKey } : {})}
        />
      </div>
    </div>
  );
}
