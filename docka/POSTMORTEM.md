# Docka: postmortem

Docka (docka.me) ran from July to October 2026. It is shut down. This page records what it was, what we built, and what we think went wrong.

The business parts are written from the founder's own answers. The dates come from the git history and project records, and the outreach numbers from the pipeline's send and reply logs. Nothing below is a guess presented as fact. Where we do not know, it says so.

## What it was

A seafarer certificate wallet with verification, plus a CRM for crewing agencies.

- Seafarers stored their certificates (STCW certificates, medicals, endorsements, seaman's book, passport) in one place and shared them with the agencies they chose. Free for seafarers.
- Each certificate was checked against the register of the flag state that issued it, not just read off a PDF. The code covers around 25 national registries: 9 automatic, the rest assisted or manual.
- Crewing agencies got a board of the seafarers who had granted them access, with document review, required-document sets per rank, expiry tracking and a hard block on sending someone to sea with a lapsed required certificate.
- Price for agencies: 300 EUR per month plus 2 EUR per billable seafarer per month.

Company: Docka Development OÜ, Estonia.

## Timeline

| Date | Event |
|---|---|
| July 2026 | Market research and first prototype (Estonian registry only, no login). |
| ~2026-07-18 | docka.me goes live. |
| 2026-07-21 | First feature batches: verification levels, duplicate-person merge, contract generation, shipowner read-only portal, verified-seafarer directory, vacancy matching. |
| 2026-08-04 | Source moved into a private Git repository. The history in this archive starts here. |
| 2026-08-14 | Username + password sign-in added next to Google, for users who cannot use Google sign-in. |
| 2026-08-18 | Lead list of crewing agencies built. Work starts on the separate cold-email pipeline. |
| 2026-08-19 | Docka Development OÜ registered in Estonia. |
| 2026-08-20 | Public "Book a call" page goes live. |
| 2026-08-21 | Stripe billing switched to live. |
| 2026-08-24 to 2026-09-08 | Outreach tooling (tracking, signup attribution, reply queue), more registries (Azerbaijan, Ukraine), upload recognition for PDFs and photos. |
| 2026-08-26 | First real outreach emails sent. |
| 2026-09-04 to 2026-09-07 | Two rounds of SEO work: registry pages, guides, FAQ and schema markup. Homepage repositioned as a CRM for crewing agencies. |
| 2026-09-09 to 2026-09-14 | The outreach campaign halts itself on bounce rate several times. A stale halt stops all sending from 2026-09-11 until it is cleared on 2026-09-14. The halt rule is reworked. |
| 2026-09-14 | Last commit (244 commits since 2026-08-04). |
| 2026-10-13 | Last outreach email sent. |
| 2026-10-14 | The campaign halts itself one last time. |
| 2026-10-15 | Outreach cron switched off. |
| October 2026 | Service shut down. Deletion notice for Docka Development OÜ published. |

There were no pilots and no demos with agencies.

## What we built (tech)

- **App:** Next.js 14 (App Router) with TypeScript and Tailwind, on a single Hetzner VPS (Ubuntu, nginx, pm2). Later a cron-based deploy on push to `main`, with backup, smoke test and rollback.
- **Auth:** NextAuth v5. Google sign-in plus username + password (scrypt hashes, one-time recovery codes). Role came from the side you signed in on, not from the account. Admins were an e-mail allowlist.
- **Storage:** one JSON file with a write mutex, plus append-only, hash-chained NDJSON logs for access, consent and admin actions. Uploads on local disk. No database. A move to Postgres stayed on the roadmap.
- **Multi-tenant access:** seafarer-granted, revocable access grants. Grants locked while a seafarer was at sea. Every agent route went through one grant-scoped data accessor, and a static test failed the build if a route skipped it.
- **Verification:** one adapter per registry (JSON APIs, HTML forms, PDF results), a country/code detector, and a mock registry server with recorded fixtures so tests made no live calls.
- **Upload recognition:** a separate worker process with Tesseract OCR (English model), QR decoding and PDF rendering. It read codes and issuing-authority keywords from photos and PDFs and proposed which registry to query.
- **Billing:** Stripe subscriptions with a metered per-seafarer charge, a reconciler cron and a paywall for agencies without a billing profile.
- **Outreach and admin:** an admin area for leads, outreach campaigns, open/click/signup tracking and a reply queue. The cold-email sending itself ran in a separate pipeline, not in this app.
- **SEO:** public registry pages, guides about STCW certificates and verification, structured data, sitemap, IndexNow.
- **How it was built:** mostly by one founder working with AI coding agents. The repository held agent instructions, plans and hand-off notes (removed from this archive).

## What worked

Evidence-based observations from the code and history:

- Live checks against government registers worked for the automatic registries, and the registry tests ran fully offline against recorded fixtures.
- The isolation model (grant-scoped accessor plus a build-breaking guard test) kept tenant access in one place.
- Shipping speed: the product, billing, outreach tooling and SEO pages went from first deploy to a full feature set in about eight weeks.

What worked from the business side: nothing, really.

- Agency feedback did not lead anywhere.
- The sign-up did not convert.
- Zero demos came from the website.
- The only real usage: some seafarers ran the free certificate check on their own documents.

## What didn't / why it failed

Why it failed: nobody needed the service.

The facts behind that:

- The roadmap's first item was "pilot with 1-2 real crewing agencies". No pilot happened.
- Billing went live on 2026-08-21. There was never a paying customer.
- Cold-email outreach to crewing agencies ran through a separate pipeline from 2026-08-26 to 2026-10-13: 1,877 emails to 421 agency contacts, in a sequence of up to five emails each. Six people wrote back. One said they were interested, one said no, two asked to be removed, and two replies were neither. No demo came out of it. The pipeline had an automatic halt on bounce rate; the last commit (2026-09-14) is about how that halt rate was shown. Sending stopped with the shutdown: the campaign halted itself on 2026-10-14 and the cron was switched off on 2026-10-15.
- Several roadmap items were never done: a real database, a legal review of the sea-lock rule and of GDPR handling for medical and identity data.
- In the end, most engineering went into building the outreach pipeline rather than the product. The git history supports this. The separate outreach pipeline took 87 commits from 2026-08-18 to 2026-08-31. Counting by commit subject from the start of billing work to the last commit, about 130 of some 245 commits across both repositories were outreach, lead and booking tooling. About 40 were SEO and positioning, about 30 billing, and about 20 registry and recognition work.

## Lessons

No grand lessons. It was something we had to try to see if it flies. It didn't.

One fact for the record: about 1,900 cold emails produced six replies, no demos and no customers.

## Status

- Archived. The code is unmaintained and its dependencies are not updated.
- The Docka product is shut down. The domain and server now host a different project.
- This archive was scrubbed before publication: real certificate photos and codes, personal data, server details and internal notes were removed. See [README.md](README.md).
