# Docka — Project Document

*Seafarer credential platform, formerly live at https://docka.me. Last updated: 2026-08-04 (§1 updated 2026-09-07).*

> **Public archive note (2026-10):** this is the internal project document, scrubbed for publication. Server addresses, login details, deploy procedures, internal policies and the real demo certificate codes were removed. Parts of it were already stale when the project stopped. The service is shut down.

---

## 1. What Docka is

Docka is a CRM for crewing agencies: a seafarer keeps all their certificates in one place and shares them with the agencies they choose, and agents manage many seamen through a pipeline; certificates are checked live against the official flag-state registers of supported countries (auto for some, assisted or manual for others).

- **Live:** https://docka.me (HTTPS)
- **First customer:** crewing agents. Seamen seed the data.
- Separate venture. Market research is in `01-market-research.md`.

---

## 2. Where it ran

Self-hosted on a single Ubuntu VPS at Hetzner, running nginx (reverse proxy, Let's Encrypt TLS) in front of the Next.js app under pm2. We chose a VPS over serverless hosting because the app stores its data as files.

- **Store:** a JSON file (`data/db.json`) plus hash-chained NDJSON audit logs; uploaded documents on local disk (`uploads/`).
- **Deploys:** first a manual copy-and-build over SSH, later a small cron job on the server that pulled `main`, built in a staging directory, took a backup, swapped the release in and ran a smoke test (rolling back on failure). The scripts were server-specific and are not part of this archive.
- **Source control:** a private GitHub repository from 2026-08-04, with feature branches and pull requests into `main`. Runtime data, uploads and `.env*` files were never committed.
- **Seed demo data:** `npm run seed:curated` (15 curated seafarers + demo agents/grants).

---

## 3. Login (live)

- **Google sign-in** (Auth.js / next-auth) for **both agents and seamen**. On `/seafarer` Google is the primary option; anonymous quick-start is still available and is adopted into the account on later sign-in.
- **Demo login is DISABLED** — only real Google accounts get in (`/api/test-login` returns 403).
- Role is decided by which side you sign in from (a cookie set before the OAuth redirect), not by the Google account.
- Google OAuth redirect URI: `<site>/api/auth/callback/google`.
- **Server env vars** (values were kept only on the server; see `app/.env.example` for names): `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL=https://docka.me`, `AUTH_TRUST_HOST=true`, `NODE_ENV=production`.
- **HMAC ref salts (required since 2026-07-21):** `PORTAL_REF_SALT` and `DIRECTORY_REF_SALT` must both be set (non-empty). They salt the opaque HMAC references used by the shipowner read-portal and the docka-verified directory (`lib/surface-ref.ts`). **Fail-closed:** if either is unset, the corresponding route (`/portal/[token]`, `/directory`) returns **503**. Generate each with `openssl rand -hex 32`.
- **Username + password sign-in — LIVE, deployed to docka.me 2026-08-14** (built on `feat/password-signup`):
  - Password self-signup + sign-in for **both roles** beside Google (same "role comes from the entry side" model; one account can hold both sides, activated per sign-in). Built for the WeChat/mainland-China segment where Google OAuth is refused (#36 / Wei).
  - **Credential sessions never carry an e-mail** (invariant): the optional signup e-mail is stored as `emailUnverified` on the credential account only — it can never satisfy the admin allowlist, the agent e-mail-adoption path, or the private-link `allowedEmails` gate, and is shown nowhere except the owner's own view.
  - **Recovery codes** (8 one-time codes, shown exactly once at signup) are the lost-password path; signed-in **change-password** and **code regeneration** exist (current password required); a reset or change **kills every pre-reset session** (`pwdAt` claim checked by both session gates). Admin **"unbind credential + reissue claim link" rescue** covers lost-password-AND-codes for seafarer profiles (refused for Google-owned/co-owned rows).
  - **No new env vars** — the Credentials provider rides the existing `AUTH_SECRET`; no new packages (Node built-in scrypt). `/api/auth/providers` now lists `credentials` beside `google` (verified at the 2026-08-14 deploy).

---

## 4. Features (current, all live)

### Seaman side (`/seafarer`)
- **Verified identity** — when any uploaded document is government-verified (regardless of which email/account, or anonymous), the registry's real **name, personal code, date of birth, issuer, and photo** become the profile. Existing profiles self-heal on load. Shown as a green **"Verified identity"** header. Falls back to the typed/Google name if nothing is verified.
- **Verified photo** — downloaded from the registry and stored locally (the registry's photo link expires, so we keep our own copy). **Change photo** opens an adjuster (zoom, drag to reposition, rotate, crop to 512×512); **"use verified photo"** reverts.
- **Remove verified profile** — when no government-verified document remains, an option appears to clear the verified identity + photo.
- **One-button upload** — a single "Add certificate photos" button (camera + gallery, multi-file). Progress bar + per-file results stay visible after upload (no auto-hide).
- **Recognition** — QR/code → live government verification (green "Verified"); paper photo → best-effort OCR marked "from photo, needs your details" (never claims "Expired" until a date is confirmed).
- **Dedupe** — repeat uploads of the same document are skipped ("Already uploaded"), keyed by government code → cert number/title+date → file hash.
- **Verified docs rank first** in the list.
- **Archive / auto-archive / delete** — archive a doc (collapsible "Archived" section, still viewable), an opt-in "auto-archive once expired" toggle, and delete (with confirm; removes the file).
- **Document viewer** — click an image to see it full-size with zoom; **rotation** you set (owner) persists everywhere (share, agent view, thumbnails) and the rotated image auto-fits the frame.
- **Two share links, in one collapsible "Share my documents" box** (gated until ≥1 document):
  - **Open link** — anyone with the link, no login.
  - **Private link** — only listed agent emails, after Google sign-in as that email. Each link has its own URL, copy, and reset.
- **Expiry reminders module** (collapsible) — set the schedule dynamically: first reminder = your number + unit (months/weeks/days before), how many, repeat every N days. **Per document.** "Now is the time" rule: a document already inside its window is reminded today. Produces a calendar (.ics) file you import into Google Calendar, plus a subscribe link.
- **Access & reviews** — the seaman sees which agents reviewed their documents, when, and each grant's status; can revoke an agent while ashore.

### Agent side (`/agent`)
- Google login; **multi-tenant** — an agent only sees seamen who granted them access.
- **Pipeline board** — 5 states (Review → Accepted → Sent to sea → Coming back → Finished), **drag-and-drop** between columns (respects the expired hard-block), filters (problems/expiring/expired/missing), search, per-card validity + completeness.
- **Single-seaman review** — open one seaman, see each document, **approve/reject with a reason**, accept forward or send back; the view-only document popup (image + zoom) is available on the shared view too.
- **Attention table** — deduplicated list of expired/missing/duplicate items. A "possible forgery" duplicate warning is **suppressed on government-verified documents** (the registry already confirmed them).
- **Required documents** — each agency configures its required set (STCW rank baseline); completeness recomputes.
- **Compliance** — expired/missing required cert **hard-blocks** "Sent to sea" unless overridden with a logged reason. **CSV export** of the crew list.
- **Comments** — collapsed by default ("Comments (N)" toggle) on both the review and shared views.

### Multi-tenant consent access
- **Grant lifecycle:** PENDING → ACTIVE (ashore, revocable) → LOCKED (sent to sea — can't revoke, with the MLC reason, max-duration backstop) → back to ACTIVE on return → REVOKED/EXPIRED.
- **Isolation** enforced by a single fail-closed accessor (`lib/agentData`) — default-deny, grant-scoped — and a **router-driven guard test** that fails the build if any agent route skips it. Append-only, hash-chained access/consent logs.

### Shipped 2026-07-21 — 3 consolidated batches, 9 features (all LIVE)

**Batch 1 — identity & profile quality**
- **#30 Verification-level badges (L0–L3)** — each document/profile carries a graded trust level (unverified → government-verified). `lib/verification-level.ts` computes the level; `components/VerificationLevelBadge.tsx` renders it across seaman + agent views.
- **#37 Duplicate-person detect + merge** — fuzzy name matching (`lib/fuzzy-name.ts`) flags likely same-person records; `lib/person-merge.ts` merges their documents/history into one profile.
- **#38 Cross-agency opt-in profile propagation** — with the seaman's opt-in, a verified profile update propagates to other agencies that hold a grant (`lib/propagation.ts`).

**Batch 2 — employment lifecycle (agent side)**
- **#41 SEA/CBA employment doc-set tracking** — required-doc sets are now assignment-scoped (`lib/required-docs.ts` + `lib/compliance.ts`), a `Doc.seaEndDate` field tracks contract end, with a dedicated board column and CSV export.
- **#43 Appraisal scorecards** — per-seaman performance scorecards (`lib/appraisals.ts`, `app/api/appraisals`, `components/AppraisalPanel.tsx`).
- **#45 SEA / contract generation** — generates a Seafarer Employment Agreement / contract via `lib/contract.ts` and the shared HTML-print engine `lib/print-html.ts` (reused from the CV feature); served at `app/api/contract/[id]`.

**Batch 3 — external surfaces & matching**
- **#42 Shipowner read-portal** — a token-gated external read-only view for shipowners. A single external projection (`lib/client-view.ts`) plus `lib/client-portal.ts`; portal routes/pages under `app/portal` with `PortalManager` (agent-side setup) and `ClientCrewList` (external view). Ref tokens are HMAC-salted by `PORTAL_REF_SALT` (fail-closed 503 if unset).
- **#49 Docka-verified directory** — a searchable directory of verified seafarers (`lib/directory.ts`, `components/DirectorySearch.tsx`, `app/directory`). Dual consent + agency attribution, auth-gated and rate-limited. Ref tokens HMAC-salted by `DIRECTORY_REF_SALT` (fail-closed 503 if unset).
- **#52 Vacancy + candidate matching** — post a vacancy and match candidates against it (`lib/vacancy.ts` `matchCandidates`, `lib/vacancy-store.ts`, `components/VacancyMatch.tsx`, `app/api/vacancies`).

### Shipped 2026-07-22 — demo accounts + 4 bug fixes (all LIVE)

- **10 demo accounts + real activities merged to live docka.me** (27 → 37 seafarers) for customer demos / UI testing. Additive id-allowlist merge; existing production data preserved.
- **Assignment/voyage lifecycle wiring (DEF-1 / DEF-6)** — `startAssignment` is now wired to the `sent_to_sea` pipeline transition, so sending a seaman to sea creates an assignment row and LOCKS the grant; SEA/contract generation is now reachable (POST `/api/contract` returns 200 for verified + unverified).
- **DEF-11** — the raw assignment UUID is hidden; the Generate-SEA panel now shows a read-only "Voyage assignment: <vessel>" line.
- **DEF-12 + badge redesign** — agent-board card pill/badge overflow fixed; verification badge redesigned with short labels and moved flush-left with the sibling pills.

---

## 5. Data model (JSON `data/db.json`)

- `seafarers` — profile, rank, pipeline state, **openShareToken / emailShareToken / allowedEmails**, Google `googleSub`/`ownerEmail`, **verified identity fields** (`identityVerified`, `verifiedName`, `personalCode`, `birthDate`, `issuerCountry`, `verifiedPhotoFile`, `customPhotoFile`), **reminder settings** (`reminderLeadValue`/`reminderLeadUnit`/`reminderCount`/`reminderIntervalDays`), `autoArchiveExpired`.
- `documents` — title, docType, source (`government`/`photo`/`manual`), estonianCode, isValid, validUntil, `archived`, `rotation`, dedupe key, stored verified-holder snapshot.
- `agents` (tenant), `assignments` (drives sea-lock), `accessGrants`, `accessLog` (append-only, hash-chained), `consentEvents`, `requiredDocsConfigs`, `comments`.
- `credentialUsers` — **live since 2026-08-14 (`feat/password-signup` deployed):** username+password accounts (scrypt-hashed password + 8 one-time recovery codes, per-record params), optional `emailUnverified` (contact-only, never an auth key), role anchors `seafarerId`/`agentId` (either/both), `passwordChangedAt` (feeds the session-invalidation `pwdAt` claim). Seafarer rows gain an optional `credentialUserId` back-pointer; "unowned" checks are `!googleSub && !ownerEmail && !credentialUserId`. New hash-chained `auth-events` sink (ids + sha256 prefixes + date-rotated ipHash only — never PII).

Government verification API (public, no key): `meremees-api.transpordiamet.ee/{certificates|medical-certificates|endorsements|qualifications}/by-access-token/<code>`. The original demo codes belonged to a real certificate holder and were replaced with the placeholders `SAMPLE0SAFETY001` / `SAMPLE0MEDICAL01` in this archive.

---

## 6. Known limitations / carry-forwards

1. **Still a JSON file store, not a database.** Fine for this single-server pilot; a real database (Postgres) is the top next step for scale (150+ crew per agent), durability, and DB-level isolation. Deferred, not done.
2. **Board scale** — the agent board is client-rendered; 150+ crew will want pagination/server filtering (ties to the DB migration).
3. **Medical gating is OFF** (owner decision) — any granted agent can see health certificates. Deferred.
4. **OCR ceiling** — ornate/rotated paper certs can't be auto-read; only QR/digital certs auto-verify.
5. **Legal** — the sea-lock basis and GDPR handling of personal/medical/verified-identity data need professional review before real-world scale.
6. **Deploy not git-driven** (at the time of writing) — deploys were manual copies over SSH; a git-driven deploy with rollback was added later.

---

## 7. Roadmap (suggested order)

1. **Pilot with 1–2 real crewing agencies** (validate demand, gather feedback).
2. **Database migration** (Postgres) — scale + durability + DB-level multi-tenant isolation.
3. ✅ **git** set up (2026-08-04); next: wire git into the deploy flow for safe rollbacks.
4. Legal review (sea-lock basis, GDPR, medical + verified-identity data).
5. Optionally: push reminders straight into Google Calendar via the Calendar API (vs the import file); broaden verification beyond Estonia (Latvia/Lithuania/Nordics); proper health-data role handling; board pagination.
6. **SEO** — a second round of SEO work shipped on 2026-09-07: registry pages, guides, a primary-source-verification definition page, sitemap, llms.txt and schema markup. `docs/seo-new-pages-claims-sources.md` and `docs/seo-tier1-claims-sources.md` list the source behind each factual claim on those pages.

---
