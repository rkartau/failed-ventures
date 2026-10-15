# SEO new pages (WP-E): claim to source table (fabrication-gate artifact)

Committed anti-fabrication artifact for the WP-E pages. Every factual or quantitative claim in
those page files carries an adjacent `[src:<id>:...]` code comment (not user-visible). The
committed tests fail if a claim line lacks one, and fail if a `[src:ID]` names a source id that
is not enumerated under the relevant section below. Sections are owned by different agents;
append under your own heading only.

## Guides

Owner: WP-E2 (the four `/resources` guides). Pages covered:

- `/resources/stcw-certificate-types` (`app/app/resources/stcw-certificate-types/page.tsx`)
- `/resources/required-stcw-documents-by-rank` (`app/app/resources/required-stcw-documents-by-rank/page.tsx`)
- `/resources/port-state-control-crew-certificate-deficiencies` (`app/app/resources/port-state-control-crew-certificate-deficiencies/page.tsx`)
- `/resources/stcw-revalidation-every-5-years` (`app/app/resources/stcw-revalidation-every-5-years/page.tsx`)

### Allowed source ids (machine-readable allowlist for the guides)

Every `[src:ID]` token in the four guide files MUST begin with one of these ids.

- `stcw-convention`: https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx (IMO, fetched 6 September 2026, HTTP 200). Supports: adopted 7 July 1978; entry into force 28 April 1984; 1995 amendments established the STCW Code with mandatory Part A and guidance Part B; 2010 Manila amendments (enhanced fraud prevention, medical standards, "refresher training module every five years for basic training on personal survival techniques and fire prevention and firefighting"); chapter structure (I general provisions incl. reg I/11 revalidation, II deck, III engine, IV radiocommunication, V special training for certain ship types, VI emergency / safety / security / medical care / survival, VII alternative certification, VIII watchkeeping). Used for every five-year / refresher statement (plan R7c).
- `paris-mou`: https://www.parismou.org (HTTP 200) and its published documents: PSCC instruction 57/2024/05 "Certification of Seafarers and Manning Requirements according to the STCW Convention, MLC and SOLAS" (https://parismou.org/download/pscc57-2024-05-certification-and-manning-according-stcw-convention-mlc-and-solas/, PDF, HTTP 200, listed on https://parismou.org/pscc-instructions/), and "List of Deficiency Codes including Statutory Certificates, 1 July 2026" (https://parismou.org/deficiency-codes/ to https://parismou.org/download/2556/, PDF, HTTP 200). Supports: initial-inspection scope (s2.1 para 1), fit to ship and position (para 3), Article VI / reg I/2 endorsement and reg I/10 recognition (paras 5-7, 11-12), unique number and expiry (paras 9-10), separate endorsement expiry ≤ 5 years and never beyond the CoC, endorsement expires with the certificate (para 10), CoP need not carry an expiry date (footnote 2), revalidation within six months to the fifth anniversary, STCW Code B-I/2 (footnote 3), suspicion of fraud on incorrect wording (para 13), capacity wording (para 14), originals on board incl. electronic (para 15), CRA and three months (para 16), rectify before departure or detention (para 17), medical reg I/9 and A-VI/1 (paras 19-21), MSMD and muster list (paras 22-26), hours of rest posting (paras 28-30), assessment only on clear grounds (s2.2), possible deficiencies (s3.2), deficiencies that may warrant detention and worked examples (s3.3), factors before detaining and fraud verification via IMO GISIS / EMSA STCW-IS (s3.4); deficiency-code category "Certificate & Documentation" and the crew-certificate item names ("Certificates for master and officers", "Endorsement by flagstate", "Evidence of Basic Training", "Medical certificate").
- `tokyo-mou`: https://www.tokyo-mou.org (HTTP 200): "consists of 22 member Authorities in the Asia-Pacific region"; deficiency codes page https://www.tokyo-mou.org/inspections-detentions/deficiency-codes/ (HTTP 200) to https://www.tokyo-mou.org/wp/wp-content/uploads/Tokyo-MOU-deficiency-codes-July-2026.pdf ("As of 25 December 2025"): 01 Certificate & Documentation; 012 Crew Certificates; 01201 Certificates for master and officers; 01202 Certificate for rating for watchkeeping; 01203 Certificates for radio personnel; 01204 Certificate for personnel on tankers; 01206 Certificate for advanced fire-fighting; 01210 Certificate for medical first aid; 01211 Cert for personnel on survival craft & rescue boat; 01213 Evidence of Basic Training; 01214 Endorsement by flag State; 01215 Application for Endorsement by flag State; 01217 Ship Security Officer Certificate; 01218 Medical certificate. Detention list published at https://www.tokyo-mou.org/inspections-detentions/detention-list/.
- `mca-eng1`: https://www.gov.uk/seafarer-medical-certificates (GOV.UK, HTTP 200; the plan's original URL https://www.gov.uk/guidance/seafarer-medical-certificates returned HTTP 404 on 6 September 2026, so the resolving GOV.UK guide URL is used instead). Supports: "You must have an ENG 1 or an ML5 seafarer medical fitness certificate to work at sea"; "The maximum fee for an ENG 1 medical examination is £115"; "An ENG 1 certificate must be issued by a doctor approved by the Maritime and Coastguard Agency (MCA)"; approved doctor lists updated monthly; expired during a voyage: work "until the next port of call where you're able to replace your certificate or for up to 3 months from the date your certificate expires, whichever is sooner" (https://www.gov.uk/seafarer-medical-certificates/suspended-cancelled-or-expired-certificates).
- `lib-doctypes`: the product's own rule engine, `app/lib/doctypes.ts` and `app/lib/required-docs.ts` (read at render time on the by-rank guide, never re-typed): `BASE_REQUIRED_DOC_TYPES` (5 slots: Basic Safety Training, Medical, Endorsement, Seaman book, Passport); `BASELINE_V1` catalogue names and `validityYears` (Passport / travel document 10; Seaman's book (SID / discharge book) 10; Medical fitness certificate (ENG1 / equiv.) 1; STCW Basic Safety Training 5; Flag-state endorsement of CoC 5; Advanced Fire Fighting (STCW A-VI/3) 5; Tanker familiarisation / cargo operations 5; employment set null); `universalRequired` = Passport, Seaman book, Medical, Basic Safety Training; `perRankRequired` officers = Endorsement, rating/cadet = none; `perVesselTypeRequired` (oil tanker to Tanker Familiarisation; chemical tanker and gas carrier to Tanker Familiarisation + Advanced Fire Fighting; passenger to Advanced Fire Fighting; general cargo / container / bulk / offshore to none); `perFlagRequired` seeded empty; `RANK_LABELS`; `EMPLOYMENT_DOC_TYPES` (SEA, Wage Account, Allotment, Contract Addendum; assignment-scoped, in no required layer).
- `real-features`: the repo-established feature set already allowlisted in `docs/seo-tier1-claims-sources.md`: eight flag-state live-auto registers (Estonia, Denmark, Cyprus, UK, Norway, France, Ukraine state, Azerbaijan) plus assisted portal deep-link for the rest; L0-L3 trust ladder; expiry reminders; hard-block on a lapsed required STCW certificate; free for seafarers; timestamped registry results and the printable inspection dossier.

### Deliberate omissions (claims NOT made, for lack of a read source)

- No detention or deficiency counts, rates or percentages from either MoU (the MoUs publish them; none were read at a cited URL, so none are quoted).
- No fraud or forgery rate.
- No Paris MoU member-state count (not read on the fetched page).
- No Paris MoU crew-certificate code numbers (the 1 July 2026 PDF's two-column layout does not pair codes and names reliably in text extraction; only the item names are quoted). Tokyo MoU numbers are quoted from the single-column PDF.
- No ENG 1 validity period (not stated on the GOV.UK guide pages fetched).
- No STCW reg I/11 month thresholds for sea service (not on the IMO page; the guide says so and points to the flag's notice).
- No regulation numbers beyond those in the cited documents (I/2, I/4, I/9, I/10, I/11, II/1, V/1-1, V/1-2, VI/1-VI/6, A-I/2, A-VI/1-A-VI/6, B-I/2, A-VIII/1).

## Registry pages

Owner: WP-E1 (six `/registries/<country>` pages, `/what-is-primary-source-verification`, `/terms` metadata). Files: `app/lib/registry-pages.ts` (all prose), `app/components/RegistryCountryPage.tsx` (shell), `app/app/registries/{estonia,denmark,cyprus,united-kingdom,norway,france}/page.tsx` (thin wrappers), `app/app/what-is-primary-source-verification/page.tsx`.

### Allowed source ids (machine-readable allowlist for the registry pages and the PSV page)

Every `[src:ID:...]` token in those files MUST begin with one of these ids (the test unions this list with the Guides list above; `real-features` is shared).

- `portal-EE`: https://meremees.transpordiamet.ee (Transpordiamet "Seafarers Information System"; the "Validity check" page at /documents/validity). Read in a browser on 6 September 2026 (JavaScript app; a scriptless fetch returns only the "JavaScript is disabled" notice).
- `portal-DK`: https://verify.dma.dk (Danish Maritime Authority "Online Verification Service"; the "STCW certificate" branch). Read in a browser on 6 September 2026 (JavaScript app).
- `portal-CY`: https://eservices.dms.gov.cy/emarcos/cert_ver/stcw/sea_auth_search_form.php (Shipping Deputy Ministry "Authentication of Seafarer Certificate" form). Read with curl on 6 September 2026 (plain HTML, HTTP 200).
- `portal-UK`: https://coccec.mcga.gov.uk (MCA "Online UK CoC/FSE checker" on GOV.UK). Read with curl on 6 September 2026 (HTTP 200; full HTML including the document-type list and the privacy notice).
- `portal-NO`: https://verify.certificate.sdir.no (Sjøfartsdirektoratet "Verification Service"). Read in a browser on 6 September 2026 (JavaScript app; Norwegian labels only).
- `portal-FR`: https://promete.din.developpement-durable.gouv.fr (PROMETE, Direction des affaires maritimes; pages /promete/, /promete/authentifierTitreOuVisa, /promete/ConsulterTitreOuVisa?language=fr). Read with curl and a browser on 6 September 2026 (HTTP 200).
- `lib-registry-countries`: the PUBLIC fields of `app/lib/registry/countries.ts` as projected by `app/lib/registry/public-rows.ts`: `authority`, `authorityShort`, `portalUrl`, `capability`, `inputs[].label`, `userNotes`. Never `notes` (plan R7; the notes-shingle test in `app/tests/seo-new-pages-e.test.mjs` proves it was not used).
- `home-faq`: `HOME_FAQ` in `app/app/page.tsx` (the home page FAQ; entry 0 is the PSV definition copied verbatim to the definition page, punctuation normalised by `plainPunct()`).
- `real-features`: as defined under Guides, plus: L0-L3 ladder names come from `lib/verification-level.ts` `LEVEL_META`; not-found is reported as not found, never rounded up to a verdict or down to "invalid"; the Ukraine training-centre validator is L2 not L3; the PSV / Platform Supply Vessel abbreviation collision; recycled certificate = a real number on another person's document.

No fraud/forgery rate, no detention or fine figure, no customer count and no testimonial is asserted on any registry page or on the PSV page. No registry coverage cut-off is stated for Estonia, Denmark, Cyprus, the United Kingdom, Norway or France, because none of those six portals states one and `countries.ts` carries no `userNotes` for them; each page says so.

### Portal readability (plan S10)

All six portals answered HTTP 200 on 6 September 2026. Three (EE, DK, NO) are JavaScript applications whose scriptless HTML is an "enable JavaScript" notice; their visible text was read in a real browser. CY, UK and FR rendered fully to curl. No portal blocked the fetch, so no screenshot evidence was needed; the quoted strings below are the portals' own wording.

### /registries/estonia (`portal-EE`, `lib-registry-countries`, `real-features`)

| # | Claim (as written) | Source id |
|---|---|---|
| 1 | Authority is Transpordiamet, Estonian Transport Administration; portal meremees.transpordiamet.ee; single input "Verification code"; capability auto. | lib-registry-countries |
| 2 | The portal is the "Seafarers Information System"; it has a "Validity check" page. | portal-EE (landing title; link /documents/validity) |
| 3 | The validity check covers "a certificate of competency, endorsement or medical certificate". | portal-EE (validity page) |
| 4 | Three query modes: document verification code; seafarer's personal identification code and document number; seafarer name and birthday. | portal-EE (validity page) |
| 5 | "Enter the verification code ... or scan the QR-code on the document." | portal-EE |
| 6 | The response shows "the status and content of the seafarer's endorsement or certificate of competency, or the status and start and end date of his/her medical certificate"; button "Submit query". | portal-EE |
| 7 | Without JavaScript the page says the Seafarers Information System cannot be displayed. | portal-EE (scriptless fetch) |
| 8 | The system lets seafarers apply for certificates and endorsements after logging in. | portal-EE (landing text, "Log in") |
| 9 | Landing notice: GOC/ROC revalidation requires refresher training per SOLAS Chapter IV, IMO resolution MSC.496(105). | portal-EE (landing notice) |
| 10 | Contact: info@transpordiamet.ee, phone 620 1200, Valge 4, 11413 Tallinn. | portal-EE (footer) |
| 11 | EST/English language switch. | portal-EE |
| 12 | No coverage caveat published; Docka has none (no `userNotes`). | portal-EE + lib-registry-countries |
| 13 | Docka reports not-found as not-found, time-stamps results, is not part of Transpordiamet. | real-features |

### /registries/denmark (`portal-DK`, `lib-registry-countries`, `real-features`)

| # | Claim | Source id |
|---|---|---|
| 1 | Authority Søfartsstyrelsen, Danish Maritime Authority; portal verify.dma.dk; single input "Certificate number"; capability auto. | lib-registry-countries |
| 2 | Landing page "Online Verification Service" with branches "STCW certificate", "Ship certificate", "Medical certificate". | portal-DK |
| 3 | "The STCW Convention requires that certificates and endorsements can be verified at the issuing administration. This online service offers verification, in order to prove validity of STCW certificates issued by the Danish Maritime Authority." | portal-DK (STCW page) |
| 4 | "Enter the certificate number below and press verify. The verification produces a result on validity and basic information from the certificate, furthermore a copy of the certificate can be opened for view of all details." | portal-DK |
| 5 | English default with a "DA" switch. | portal-DK |
| 6 | Norway and the UK take a date of birth; Denmark does not. | lib-registry-countries (inputs) |
| 7 | No cut-off published; no `userNotes`. | portal-DK + lib-registry-countries |

### /registries/cyprus (`portal-CY`, `lib-registry-countries`, `real-features`)

| # | Claim | Source id |
|---|---|---|
| 1 | Authority Shipping Deputy Ministry, Department of Merchant Shipping (Cyprus); portal eservices.dms.gov.cy/...; inputs "Seafarer ID", "Certificate number"; capability auto. | lib-registry-countries |
| 2 | Page title "SHIPPING DEPUTY MINISTRY: Authentication of Seafarer Certificate". | portal-CY |
| 3 | Fields "Seafarer ID No" and "Certificate No", both marked mandatory ("*Mandatory Fields"). | portal-CY |
| 4 | "Note: Seafarer ID No. is shown on the top left hand corner of the Certificate." | portal-CY |
| 5 | Buttons "Search" and "Reset". | portal-CY |
| 6 | Plain HTML form; renders without JavaScript. | portal-CY (curl fetch rendered the full form) |
| 7 | The Danish service shows a certificate copy; the Cyprus form does not. | portal-DK + portal-CY |
| 8 | Recycled certificate definition; L3 reserved for the government registry; not-found never shown as invalid. | real-features |
| 9 | No coverage caveat published; no `userNotes`. | portal-CY + lib-registry-countries |

### /registries/united-kingdom (`portal-UK`, `lib-registry-countries`, `real-features`)

| # | Claim | Source id |
|---|---|---|
| 1 | Authority Maritime and Coastguard Agency (MCA), short "UK MCA"; portal coccec.mcga.gov.uk; inputs "Document ID", "Date of birth"; capability auto. | lib-registry-countries |
| 2 | Title "Online UK CoC/FSE checker"; GOV.UK; header "Maritime and Coastguard Agency document verification service". | portal-UK |
| 3 | "Use this service to verify a MCA issued certificate, document or license of a UK registered Seafarer or Boatmaster, including FSE's." | portal-UK |
| 4 | Document Type options (14): Able Seafarer; ATO (Authority to Operate); CoC (Certificate of Competency); COP (Certificate of Proficiency); FSE (Flag State Endorsement); FSE Fishing; General Operator's Certificate; GOC Endorsement; LRC (Long Range Certificate); Rating; Restricted Operator's Certificate; ROC Endorsement; BML (Boat Master's Licence); Ships Cook Certificate of Competency. | portal-UK |
| 5 | Fields "Document ID" and "Seafarer's date of birth" (Day/Month/Year); buttons "Check", "Reset". | portal-UK |
| 6 | Privacy notice: data controller MCA; "will use the date of birth and certificate number to confirm the validity of UK issued seafarer certification as part of our public task"; "not retained once the validity check has been completed and is not shared outside of the MCA". | portal-UK |
| 7 | "All content is available under the Open Government Licence v3.0, except where otherwise stated". | portal-UK (footer) |
| 8 | No coverage cut-off published; no `userNotes`. | portal-UK + lib-registry-countries |

### /registries/norway (`portal-NO`, `lib-registry-countries`, `real-features`)

| # | Claim | Source id |
|---|---|---|
| 1 | Authority Sjøfartsdirektoratet, Norwegian Maritime Authority; portal verify.certificate.sdir.no; inputs "Certificate number", "Date of birth"; capability auto. | lib-registry-countries |
| 2 | Title "Verification Service"; form heading "Søk etter sertifikat"; fields "Fødselsdato", "Sertifikatnummer"; button "Søk". | portal-NO |
| 3 | Scriptless page: "You need to enable JavaScript to run this app." | portal-NO |
| 4 | Norwegian labels only on the search page on 6 September 2026; no login. | portal-NO |
| 5 | The eight live-automatic flag states; Ukraine state registry `userNotes` (documents issued 2023 and later). | lib-registry-countries |
| 6 | No coverage caveat published; no `userNotes` for NO. | portal-NO + lib-registry-countries |

### /registries/france (`portal-FR`, `lib-registry-countries`, `real-features`)

| # | Claim | Source id |
|---|---|---|
| 1 | Authority Direction des affaires maritimes (France), short "Affaires maritimes (DAM)"; portal promete.din.developpement-durable.gouv.fr; inputs "Numéro de titre", "Numéro d'administration", "Numéro de version (if present)"; capability auto. | lib-registry-countries |
| 2 | "Bienvenue sur PROMETE. Un outil de recherche de sessions de formation et d'authentification de documents professionnels maritimes, consultable de manière sécurisée depuis votre ordinateur, votre tablette ou votre smartphone." | portal-FR (/promete/) |
| 3 | Home page services (9): Rechercher une session de formation; Authentifier une attestation de suivi; Authentifier un titre ou un visa; Vérifier la validité d'un titre de sécurité; Authentifier un permis d'armement; Authentifier un certificat d'enregistrement professionnel; Vérifier la validité d'un Titre de plaisance; Consulter la fiche matricule d'un navire; Lister les SPRPGM établis en France. | portal-FR |
| 4 | "L'ensemble des brevets et certificats délivrés conformément à la Convention STCW ... sont enregistrés sur une base de données. Cette base de donnée est consultable en ligne, à tout moment."; link "Accéder à la base de gestion / Access to the database management". | portal-FR (/promete/authentifierTitreOuVisa) |
| 5 | Search form: "N° du titre * / N° de version (1)", "N° du titulaire *", button "Rechercher", link "Où trouver ces N° ?", footnote "(1) : Le numéro de version n'est obligatoire que pour les titres dont le numéro est > 10 000 000". | portal-FR (/promete/ConsulterTitreOuVisa?language=fr) |
| 6 | Footer "Promete version v1.6.7 production"; links "portail du marin", "portail de l'armateur". | portal-FR |
| 7 | Docka's "Numéro d'administration" is the form's "N° du titulaire" (the second mandatory field). | lib-registry-countries + portal-FR (Docka's three inputs map onto the form's title / version / holder fields) |
| 8 | No coverage cut-off published; no `userNotes`. | portal-FR + lib-registry-countries |

### /what-is-primary-source-verification (`home-faq`, `real-features`, `portal-*`, `lib-registry-countries`)

| # | Claim | Source id |
|---|---|---|
| 1 | Definition sentence (DefinedTerm description and visible definition). | home-faq (HOME_FAQ[0].a, verbatim, plainPunct) |
| 2 | A stamp, signature or QR code can be copied; a printed expiry date is a claim. | home-faq (HOME_FAQ[2].a) |
| 3 | Danish Maritime Authority: the STCW Convention requires verification at the issuing administration. | portal-DK |
| 4 | Estonia's validity check accepts a scan of the QR code on the document. | portal-EE |
| 5 | Public, login-free portals (DK, CY). | portal-DK, portal-CY |
| 6 | Lookup keys per authority (UK document ID + date of birth; CY seafarer ID + certificate number; DK certificate number). | lib-registry-countries |
| 7 | Eight live registers; Bulgaria existence-only; assisted elsewhere. | lib-registry-countries (capability auto / auto-presence / assisted / manual) |
| 8 | L0-L3 ladder; a training-centre result is one level below government; timestamped result; free for seafarers; PSV / Platform Supply Vessel collision. | real-features |

## Shared positioning components

The site-wide `<WhatDockaIs />` strip (`app/components/WhatDockaIs.tsx`) carries the CRM
identity on every long-tail marketing page. Its prose is deliberately digit-free and
number-word-free, so the fabrication scan has nothing to cite; the id below is what the
file's `[src:]` comment resolves to.

### Allowed source ids (machine-readable allowlist for the shared positioning strip)

- `crm-features`: the shipped agency CRM surface, read from code: 5-stage board (`app/lib/pipeline.ts:4-19`), required-document sets per rank (`app/lib/required-docs.ts:228,260,451`; STCW baseline in `app/lib/doctypes.ts:13-38`), sea-ready hard block (`app/lib/compliance.ts`), reminder schedule 1 month / 3 reminders / 14 days, seafarer-owned (`app/lib/reminders-calendar.ts:23-28,60`; email channel only per `app/app/api/cron/reminders/route.ts:46`), bulk import + claim links (`app/components/ImportCrew.tsx`, `app/lib/claim-state.ts`), draft MLC A2.1 SEA (`app/lib/contract.ts`), sea-service ledger (`app/lib/sea-service.ts`), appraisals (`app/lib/appraisals.ts`), vacancy matching within the own roster (`app/lib/vacancy.ts`), shipowner read-portal (`app/lib/client-portal.ts`), PSC dossier printed by the agency (`app/app/agent/(enforced)/inspection`, `app/components/PrintButton.tsx`), signed public verify link (`app/lib/verify-record.ts`), hash-chained audit log (`app/lib/db.ts:2430-2492`), CSV export (`app/app/api/export/route.ts`), per-seafarer printable CV (`app/app/api/cv/[id]/route.ts`), 6 languages (`app/lib/i18n.ts:10-21`), free for seafarers (`app/app/pricing/page.tsx`).
