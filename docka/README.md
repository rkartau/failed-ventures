# Docka (docka.me)

**Archived. Not maintained.** The service was shut down in October 2026. This is the source code as it stood on 2026-09-14, scrubbed for publication. No issues or pull requests will be answered.

Why it stopped and what we learned: [POSTMORTEM.md](POSTMORTEM.md).

## What it was

Docka was a web app for seafarer certificates.

- A **seafarer** uploads photos, PDFs or codes of their certificates. Docka keeps them in one place and shares them with the crewing agencies the seafarer picks.
- A **crewing agency** sees the seafarers who granted it access on a pipeline board (Review, Accepted, Sent to sea, Coming back, Finished). It reviews documents, sets required documents per rank, and gets blocked from sending someone to sea with an expired required certificate.
- Each certificate is checked against the official register of the flag state that issued it. The registry table in the code has 29 entries for 27 countries. 9 were checked automatically; the rest were "assisted" (Docka opens the official portal with the fields filled in) or manual.
- Each document carries a trust level from L0 (unverified) to L3 (verified against the government register).

The business model was a monthly licence for agencies (300 EUR per month plus 2 EUR per billable seafarer). Seafarers used it for free.

## Stack

- Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- Auth.js / next-auth v5: Google sign-in and username + password (scrypt, recovery codes)
- Storage: a single JSON file (`app/data/db.json`) behind a write mutex, plus hash-chained NDJSON audit logs. Uploads on local disk. No database.
- OCR and code reading: Tesseract (tesseract.js, English model), jsQR, pdf.js, in a separate worker process
- Stripe Billing (licence + metered per-seafarer usage), nodemailer (SMTP), Google Calendar API (call booking)
- Production ran on one Ubuntu VPS: nginx in front of `next start` under pm2.

## Repository layout

```
docka/
  PROJECT.md              internal project document (scrubbed; partly stale)
  01-market-research.md   market research from July 2026
  docs/                   analytics notes, writing style guide, SEO claim-source lists
  app/                    the Next.js application
    app/                  routes: public site, /seafarer, /agent, /admin, /api/*
    components/           React components
    lib/                  domain logic: db, access grants, compliance, billing,
                          registry adapters (lib/registry/adapters/*), OCR planner
    scripts/              seeding, sample/specimen generators, OCR worker
    tests/                node:test unit/route tests, Playwright journey scripts,
                          registry fixtures and mock registry
```

Places to start reading:

- `app/lib/registry/countries.ts` and `app/lib/registry/adapters/` for the flag-state integrations
- `app/lib/access.ts` and `app/lib/agentData.ts` for consent-based, grant-scoped multi-tenant access
- `app/lib/db.ts` for the JSON store and the hash-chained audit log
- `app/scripts/recognize-worker.mjs` and `app/lib/registry/keywords.ts` for upload recognition

## Running it locally

This should still work, but it is not tested beyond a build. Needs Node 20 or newer.

```bash
cd app
npm ci
cp .env.example .env.local      # fill in AUTH_SECRET at least (openssl rand -hex 32)
npm run seed:curated            # demo data into app/data/db.json
npm run dev                     # http://localhost:3000
```

Notes:

- In `next dev` you can sign in as a demo agent or seafarer without Google, through the dev-only routes `/api/test-login` and `/api/seaman-test-login`. Both return 403 in a production build.
- To use `/admin`, sign in with Google and put that address in `ADMIN_EMAILS`.
- OCR needs the Tesseract English model at `app/eng.traineddata`. It is not included (5 MB). Download `eng.traineddata` from the `tesseract-ocr/tessdata` repository on GitHub and put it there.
- Without changes, certificate checks go to the real government registers. To avoid that, run the fixture server in `app/tests/mock-registry.mjs` and set `REGISTRY_MOCK=1` plus the `REGISTRY_BASE_*` overrides listed at the top of that file (honoured only outside production).
- The homepage "use the sample certificate" button uses a placeholder code, so it finds nothing. The original pointed at a real person's certificate.
- Stripe, SMTP, SMS and Google Calendar are optional. The related features stay off or fail closed without their env vars.

Tests:

```bash
cd app
npm test                # unit and route tests (node:test), no network
npm run test:registry   # registry adapter tests against fixtures
```

The other `tests/*.mjs` files are Playwright scripts that need a running dev server. Some of them expected a folder of real certificate photos that is not part of this archive (`SAMPLES_DIR`).

## What was removed for publication

- Photos of real certificates, test screenshots and CSV exports that showed real data, and run logs
- The real certificate access codes used for the demo, replaced with `SAMPLE0SAFETY001` / `SAMPLE0MEDICAL01`
- Server addresses, deploy scripts, backup paths, mailbox setup and other operations notes
- Hard-coded admin e-mail addresses (now the `ADMIN_EMAILS` env var) and analytics ids
- Planning, hand-off and AI-agent working notes
- Code and data from an unrelated project that shared the admin area
- Lead lists and outreach data were never in the repository

## Status

Archived. The code is unmaintained, dependencies are not updated, and all Docka services (site, mail, billing) are shut down.

License: MIT, see [../LICENSE](../LICENSE).
