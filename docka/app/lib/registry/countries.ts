// Client-safe: THE registry table (plan §3) — metadata only, no fetch code.
//
// One entry per supported issuing authority: 26 EU/EEA flag states with any
// meaningful issuance, plus the UA-TCCS training-center validator. Capability
// levels and wire notes come from the 2026-07-20 live research dossiers; the
// waves (1–4) are the roadmap's rollout order. AT/CZ/SK/HU have NO entries
// (negligible issuance) — detection simply never yields them.
//
// SECURITY (plan §2.4): `domains` is the EXACT pinned hostname allowlist.
// Adapters build fetch URLs from their own pinned constants — a user-pasted URL
// is only ever parsed for host-match + code extraction, never fetched. Host
// comparison is exact string equality (never endsWith).

import type { CountryCode, CountryEntry } from "./types";

// Known FAKE "registry" domains that rank in search results and imitate real
// authorities. Detection must show an explicit warning and NEVER fetch them
// (they are simply absent from every pinned allowlist; this list powers the
// user-facing warning text).
export const KNOWN_FAKE_REGISTRY_DOMAINS: { domain: string; imitates: CountryCode }[] = [
  { domain: "rnaro.com", imitates: "RO" },
  { domain: "anr-ro.com", imitates: "RO" },
  { domain: "hcg-gov.gr", imitates: "GR" },
  { domain: "itados.org", imitates: "IS" },
];

export const COUNTRIES: CountryEntry[] = [
  // ---- Live -------------------------------------------------------------
  {
    country: "EE",
    countryName: "Estonia",
    authority: "Transpordiamet — Estonian Transport Administration",
    authorityShort: "Transpordiamet",
    // Anonymous-upload keyword map (§5): diacritics-stripped UPPERCASE
    // authority-name keywords, matched over OCR text (registry/keywords.ts).
    // Pre-2021 certificates (still circulating as endorsement backing) were
    // issued by the predecessor "Veeteede Amet — Estonian Maritime
    // Administration" — both printed forms kept (2026-08-12 gap sweep).
    keywords: [
      "TRANSPORDIAMET",
      "ESTONIAN TRANSPORT ADMINISTRATION",
      "VEETEEDE AMET",
      "ESTONIAN MARITIME ADMINISTRATION",
    ],
    capability: "auto",
    keyKind: "capability-token", // 16-char unguessable access token printed on the cert PDF/QR
    recheckable: true, // token is stored (estonianCode) and non-sensitive
    domains: ["meremees-api.transpordiamet.ee", "meremees.transpordiamet.ee"],
    portalUrl: "https://meremees.transpordiamet.ee",
    inputs: [{ key: "code", label: "Verification code", source: "paste" }],
    // Real EE access tokens are 16 uppercase alphanumerics. Detection ALSO
    // appends EE as the fallback candidate for ANY unmatched bare code ≥6 chars
    // (see detect.ts) — preserving legacy extractCode semantics exactly.
    codePattern: /^[A-Z0-9]{16}$/,
    notes:
      "Four public by-access-token endpoints (competency / medical / endorsement / qualification), tried in order. Medical results are name-less by design.",
  },

  // ---- Wave 1 -----------------------------------------------------------
  {
    country: "DK",
    countryName: "Denmark",
    authority: "Søfartsstyrelsen — Danish Maritime Authority",
    authorityShort: "Søfartsstyrelsen (DMA)",
    keywords: ["SOFARTSSTYRELSEN", "DANISH MARITIME AUTHORITY"],
    capability: "auto", // CONFIRMED: POST /api/validate JSON, no auth/CAPTCHA
    // Default mode: bare cert number = public identifier. The QR token path
    // (/validateqr/<code>) is a capability token — the adapter resolves the
    // class per input path and stamps VerifiedCert.keyTrust accordingly (§2.5).
    keyKind: "public-identifier",
    recheckable: true, // cert number is non-sensitive and stored
    domains: ["verify.dma.dk"],
    portalUrl: "https://verify.dma.dk",
    // Dossier-confirmed QR deep-link route (adapters/dk.ts): the code in a
    // /validateqr/<code> URL is a capability token — detection stamps the mode.
    qrPathPrefix: "/validateqr/",
    inputs: [{ key: "certNumber", label: "Certificate number", source: "paste" }],
    // FINAL (increment 4). The 2026-07-20 dossier CONFIRMS the wire format but
    // DMA publishes NO sample certificate numbers (dossier §3: "None found"),
    // so the bare-code pattern stays a deliberately narrow bounded heuristic:
    // 8-digit numeric, DISTINCT from UK/NO below so a DK-shaped paste yields
    // [DK, EE] (no picker) while the UK/NO 10-digit overlap exercises the §2.3
    // fan-out cap. The CERTAIN detection paths are the pinned verify.dma.dk
    // URLs — /validate/<code> deep links and /validateqr/<code> QR tokens.
    codePattern: /^\d{8}$/,
    notes:
      "JSON POST /api/validate with the certificate number; QR codes deep-link to /validateqr/<token>.",
  },
  {
    country: "CY",
    countryName: "Cyprus",
    authority: "Shipping Deputy Ministry — Department of Merchant Shipping (Cyprus)",
    authorityShort: "Shipping Deputy Ministry",
    // "MERCHANT SHIPPING" alone is generic cert boilerplate — keep the specific form.
    keywords: ["SHIPPING DEPUTY MINISTRY"],
    // FLIPPED 2026-08-12 per this entry's own flip condition: the probe from the
    // production box (EU egress) confirmed the wire format at the DEEP path
    // /emarcos/cert_ver/stcw/sea_auth_search_form.php (plain PHP form POST
    // sea_id + cert_no + search, PHPSESSID cookie, no CSRF/CAPTCHA; miss =
    // alert-danger "The Certificate was not found"). The /emarcos/ ROOT still
    // 403s — the deep path is the pinned one (adapters/cy.ts).
    capability: "auto",
    keyKind: "public-identifier",
    recheckable: true, // seafarerId + certNumber are non-sensitive stored inputs
    domains: ["eservices.dms.gov.cy"],
    portalUrl: "https://eservices.dms.gov.cy/emarcos/cert_ver/stcw/sea_auth_search_form.php",
    inputs: [
      { key: "seafarerId", label: "Seafarer ID", source: "prompt" },
      { key: "certNumber", label: "Certificate number", source: "paste" },
    ],
    notes:
      "Wire format CONFIRMED 2026-08-12 from the production box: POST sea_id + cert_no (+ search) to the deep sea_auth_search_form.php path — the /emarcos/ root 403s. Deterministic miss: 'The Certificate was not found'. Hit markup still unobserved live — unknown result wording maps to indeterminate, never invalid.",
  },
  {
    country: "UK",
    countryName: "United Kingdom",
    authority: "Maritime and Coastguard Agency (MCA)",
    authorityShort: "UK MCA",
    // "MCA" alone is too short for noisy OCR — full agency name only.
    keywords: ["MARITIME AND COASTGUARD AGENCY"],
    capability: "auto", // CONFIRMED: GET query → HTML verdict banner
    keyKind: "public-identifier", // document ID + DOB are printed/knowable
    recheckable: true, // documentId stored; DOB from the stored profile birthDate
    domains: ["coccec.mcga.gov.uk"],
    portalUrl: "https://coccec.mcga.gov.uk",
    inputs: [
      { key: "documentId", label: "Document ID", source: "paste" },
      { key: "dob", label: "Date of birth", source: "profile.birthDate" },
    ],
    // UPDATED 2026-08-12 (official specimen CoC0089297 + live checker): real MCA
    // document IDs are an alpha document-type prefix + 7 digits (CoC0089297,
    // CEC8104152) or the 9-digit legacy all-numeric form. This replaces the old
    // 10-digit placeholder heuristic (which existed only to overlap NO's range
    // for the fan-out-cap drill — the cap is now exercised with a synthetic
    // table entry in the detect tests).
    codePattern: /^(?:[A-Z]{2,4}\d{7}|\d{9})$/,
    notes:
      "GET /Certificate-Search-Results/?documentId=…&date=YYYY-MM-DD (DOB formatted by UTC string slice — no timezone math). The 2026-08 checker added a client-side Document Type select, but the server still answers the typeless GET (probed 2026-08-12).",
  },
  {
    country: "NO",
    countryName: "Norway",
    authority: "Sjøfartsdirektoratet — Norwegian Maritime Authority",
    authorityShort: "Sjøfartsdirektoratet",
    keywords: ["SJOFARTSDIREKTORATET", "NORWEGIAN MARITIME AUTHORITY"],
    capability: "auto", // CONFIRMED: Azure APIM JSON with a PUBLIC subscription key
    keyKind: "public-identifier", // cert number + DOB; QR token alternative = capability-token
    recheckable: true,
    domains: ["verify.certificate.sdir.no", "sdir-p-apim-common.azure-api.net"],
    portalUrl: "https://verify.certificate.sdir.no",
    inputs: [
      { key: "certNumber", label: "Certificate number", source: "paste" },
      { key: "dob", label: "Date of birth", source: "profile.birthDate" },
    ],
    // FINAL (increment 4). The dossier confirms the APIM wire format but NMA
    // publishes NO sample certificate numbers (dossier §3: "None found") — the
    // 10–11-digit bounded heuristic stands; the 10-digit overlap with UK is
    // the deliberate fan-out-cap case.
    codePattern: /^\d{10,11}$/,
    notes:
      "POST …/v3/verifycertificate/bynumberandidentity with the portal's public Ocp-Apim-Subscription-Key (a public constant, not a secret). The SSN lookup path is deliberately NOT built (sensitive).",
  },

  // ---- Wave 2 -----------------------------------------------------------
  {
    country: "FI",
    countryName: "Finland",
    authority: "Liikenne- ja viestintävirasto Traficom (Finland)",
    keywords: ["TRAFICOM", "VIESTINTAVIRASTO"],
    capability: "assisted", // reclassified: final call is CAPTCHA-gated
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["asiointi.traficom.fi"],
    portalUrl: "https://asiointi.traficom.fi",
    inputs: [
      { key: "dob", label: "Date of birth", source: "profile.birthDate" },
      { key: "certNumber", label: "Certificate number", source: "paste" },
    ],
    notes:
      "Endpoint known (POST …/do-validate-competency-certificate) but the final call is CAPTCHA-gated — deep link + prefill only, no automation (policy: CAPTCHA bypass never).",
  },
  {
    country: "MT",
    countryName: "Malta",
    authority: "Transport Malta — Merchant Shipping Directorate",
    keywords: ["TRANSPORT MALTA"],
    capability: "unverified-endpoint", // DOC-ONLY: QR URL pattern needs a physical cert
    keyKind: "capability-token", // per-cert QR token (ISO/IEC 20248 DigSig)
    recheckable: false,
    // 2026-08-12: Malta is migrating under transport.gov.mt — BOTH hostnames
    // resolve (same gov.mt cloudproxy), so both stay pinned for URL/QR detection.
    domains: ["seafarers.gov.mt", "seafarers.transport.gov.mt"],
    portalUrl: "https://seafarers.gov.mt",
    inputs: [{ key: "qrToken", label: "Certificate QR code", source: "paste" }],
    notes:
      "Portal is login-gated; the per-cert QR token pattern (ISO/IEC 20248 DigSig) needs a real Maltese cert sample. Behaves as assisted until then.",
  },
  {
    country: "HR",
    countryName: "Croatia",
    authority: "Ministarstvo mora, prometa i infrastrukture (Croatia)",
    keywords: ["MINISTARSTVO MORA"],
    // DEMOTED auto -> assisted 2026-08-12 (policy R10 tripwire, exactly the flip
    // this entry always documented): the COCV portal (APEX 24.2.10) now guards
    // the search with Google reCAPTCHA v3 — grecaptcha.execute() fills a
    // P10_TOKEN page item and P10_SCORE is a server-protected item; an honest
    // server-side replay (correct plumbing + p_request=SEARCH_1, empty token)
    // answers ORA-20999. CAPTCHA solving is never an option, so Croatia is
    // deep-link + prefill until the captcha gate goes away (adapters/hr.ts is
    // kept dormant for a future re-flip).
    capability: "assisted",
    keyKind: "public-identifier", // name + serial are printed on the cert
    recheckable: false, // lookup needs the holder name split, not reliably stored
    domains: ["cocv.pomorstvo.hr"],
    // The bare host serves a maintenance page — the working form lives under
    // /ords/ (page-10 deep link, probed 2026-08-12).
    portalUrl: "https://cocv.pomorstvo.hr/ords/f?p=300:10:0:::10::",
    inputs: [
      // ALWAYS prompt as two fields — never auto-split a stored fullName (§3).
      { key: "firstName", label: "First name (as on certificate)", source: "prompt" },
      { key: "lastName", label: "Surname (as on certificate)", source: "prompt" },
      { key: "serial", label: "Certificate serial number", source: "paste" },
    ],
    notes:
      "Oracle APEX app (fields P10_IME/P10_PREZIME/P10_BROJ). 2026-08-12: the portal added reCAPTCHA v3 (score) on the search submit — automated lookup would require captcha evasion, so the R10 auto-demote to assisted fired. Deep link + copy-ready fields only.",
  },
  {
    country: "BG",
    countryName: "Bulgaria",
    authority: "Изпълнителна агенция „Морска администрация“ — Bulgarian Maritime Administration",
    // The CYRILLIC authority name stays DEAD until non-eng traineddata ships
    // (eng-only OCR worker; verify-upload plan, known limit) — but BG STCW
    // documents are bilingual and print the official ENGLISH agency name,
    // which the eng OCR CAN read (2026-08-12 gap sweep).
    keywords: ["BULGARIAN MARITIME ADMINISTRATION"],
    capability: "auto-presence", // CONFIRMED: success returns the cert IMAGE (presence only)
    keyKind: "public-identifier",
    recheckable: false, // EGN is sensitive and never stored
    domains: ["online.marad.bg"],
    portalUrl: "https://online.marad.bg",
    inputs: [
      { key: "egn", label: "EGN (personal number)", source: "prompt", sensitive: true },
      { key: "docNumber", label: "Document number", source: "paste" },
    ],
    notes:
      "Covers 2017+ only. POST /seaman/validate (identifier, doc_number, culture); a hit returns a certificate image — presence ≠ validity, so results are registry-confirmed documents (teal), never a green Valid. EGN is sensitive: pass-through only, never persisted or logged. An inactive reCAPTCHA placeholder exists — if it activates, auto-demote to assisted.",
    userNotes: "Covers certificates issued 2017 and later. The personal number (EGN) is used only for the lookup — never stored.",
  },
  {
    country: "SE",
    countryName: "Sweden",
    authority: "Transportstyrelsen — Swedish Transport Agency",
    keywords: ["TRANSPORTSTYRELSEN", "SWEDISH TRANSPORT AGENCY"],
    capability: "assisted", // reclassified: gated behind a legal requester self-declaration
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["sjomansrapporter.transportstyrelsen.se"],
    portalUrl: "https://sjomansrapporter.transportstyrelsen.se",
    inputs: [{ key: "certNumber", label: "Certificate number", source: "paste" }],
    notes:
      "Verification runs via the \"Certificate confirmation\" report, gated behind a legal requester self-declaration (POST /Home/ConfirmUser + anti-forgery token). Automating it would machine-attest a legal declaration — never automated.",
  },
  {
    country: "BE",
    countryName: "Belgium",
    authority: "FOD Mobiliteit en Vervoer — FPS Mobility and Transport (Belgium)",
    keywords: ["FOD MOBILITEIT", "FPS MOBILITY AND TRANSPORT"],
    capability: "assisted", // reclassified: reCAPTCHA Enterprise on the verify widget
    keyKind: "public-identifier",
    recheckable: false,
    // NOTE: the roadmap's `…apps.mobilit…` host is NXDOMAIN — this is the real host.
    domains: ["crewcert.mobilit.fgov.be"],
    portalUrl: "https://crewcert.mobilit.fgov.be",
    contactEmail: "STCW95@mobilit.fgov.be",
    inputs: [
      { key: "certNumber", label: "Certificate number", source: "paste" },
      { key: "seafarerRegNumber", label: "Seafarer registration number", source: "prompt" },
      { key: "expiry", label: "Expiry date", source: "prompt" },
    ],
    notes:
      "Mendix SPA; verify widget gated by reCAPTCHA Enterprise, no stable field ids. Deep link + values shown for copy; fallback contact STCW95@mobilit.fgov.be.",
  },
  {
    country: "FR",
    countryName: "France",
    authority: "Direction des affaires maritimes (France)",
    authorityShort: "Affaires maritimes (DAM)",
    // Full form only — bare "AFFAIRES MARITIMES" would also hit Luxembourg's
    // "Commissariat aux affaires maritimes".
    keywords: ["DIRECTION DES AFFAIRES MARITIMES"],
    capability: "auto", // CONFIRMED: plain POST, no CAPTCHA/CSRF
    keyKind: "public-identifier",
    recheckable: true, // numeroTitre/numeroAdm are non-sensitive stored inputs
    domains: ["promete.din.developpement-durable.gouv.fr"],
    portalUrl: "https://promete.din.developpement-durable.gouv.fr",
    inputs: [
      { key: "numeroTitre", label: "Numéro de titre", source: "paste" },
      { key: "numeroAdm", label: "Numéro d'administration", source: "prompt" },
      // Required by the portal ONLY when the cert number exceeds 10,000,000
      // (the part after the "/" on the document) — optional, never gates the
      // prompt (§5.2): most lookups proceed without it.
      { key: "numeroVersion", label: "Numéro de version (if present)", source: "prompt", optional: true },
    ],
    notes: "POST /promete/ConsulterTitreOuVisa — server-rendered HTML parse.",
  },

  // ---- Ukraine: TWO verification services --------------------------------
  // Ukraine is the one country with two independent connectors, kept as two
  // separate table entries (the CountryCode type is deliberately open-ended):
  //   "UA"       — TCCS Odessa training-center validator (below, unchanged);
  //   "UA-MARAD" — the STATE registry vrf.marad.gov.ua (flag-state — the only
  //                UA entry that can yield verifiedSource:"government").
  // Each entry keeps its own inputs, so the §5.2 needs-inputs prompt stays
  // exact per service (surname for TCCS; issue date + doctype for MARAD) with
  // zero new dispatch plumbing.
  {
    country: "UA",
    countryName: "Ukraine (training center)",
    authority: "Training Centre for Certification of Seafarers (IPE) — Odessa Maritime Academy",
    keywords: ["TRAINING CENTRE FOR CERTIFICATION OF SEAFARERS"],
    issuerKind: "training-center",
    capability: "auto",
    keyKind: "public-identifier", // surname + certificate number are printed on the cert
    recheckable: true,
    domains: ["tccs.online"],
    portalUrl: "https://tccs.online",
    inputs: [
      // PROMPTED, never auto-filled: the profile holds a FULL name and TCCS
      // matches on the SURNAME alone — auto-splitting a stored fullName is
      // forbidden (§3, same rule as HR's two-field prompt).
      { key: "surname", label: "Surname (as on certificate)", source: "prompt" },
      { key: "certificateNumber", label: "Certificate number", source: "paste" },
    ],
    notes:
      "Training-center validator, NOT a flag state — results are registry-confirmed documents (teal), never government-verified. Its miss page is an ambiguous \"contact us\" → indeterminate, never invalid.",
  },
  {
    country: "UA-MARAD",
    countryName: "Ukraine (state registry)",
    authority:
      "Морська адміністрація — Maritime Administration of Ukraine (State Service of Maritime and Inland Waterway Transport)",
    authorityShort: "Maritime Administration of Ukraine",
    // Keywords frozen 2026-08-24 after the B3 pre-freeze gate against the
    // REAL incident scan's eng-tesseract OCR (see the ua-marad fixture
    // README): the English endorsement page prints "The Government of
    // Ukraine certifies …" and "Authorized official of the Shipping
    // Administration" — both survive real OCR at the worker's PDF raster.
    // Misfire analysis: "GOVERNMENT OF UKRAINE" is printed by no other
    // country's certificate; "SHIPPING ADMINISTRATION" is the Ukrainian
    // authority's English self-designation (no wired country uses the
    // wording — DK "Danish Maritime Authority", UK "Maritime and Coastguard
    // Agency", …), categorically unlike generic "CERTIFICATE OF COMPETENCY"
    // boilerplate. Neither co-occurs with UA-TCCS's keyword, so a
    // single-country hit keyword-locks to UA-MARAD (auto → candidates flow).
    // The dossier candidates "ADMINISTRATION OF UKRAINE"/"MARAD.GOV.UA" were
    // REJECTED at the gate: the former is not printed as a contiguous string
    // on the real document; the latter's dots OCR-mangle ("MARAD GOV.VAL").
    keywords: ["GOVERNMENT OF UKRAINE", "SHIPPING ADMINISTRATION"],
    // WEAK hint (2026-09-07, incident sidecar a533f540): the bare state name
    // survives eng-OCR of a PNG screenshot even when both authority lines
    // mangle ("GOVEMMENT OF UKRAINE", "SHIPING ADVINISTATION"). Word-bounded
    // ("UKRAINIAN" as a holder nationality never hits); ranks + activates
    // ocrCodePattern (with ocrCodeRawPattern) but NEVER locks. Deliberately
    // NOT added to UA-TCCS (would split the hint / prefill the
    // training-center entry).
    hintKeywords: ["UKRAINE"],
    capability: "auto", // CONFIRMED live 2026-08-13: GET (session) + form POST
    keyKind: "public-identifier", // doc number + issue date are printed on the document
    recheckable: true, // docNumber/issuedOn/doctype are non-sensitive stored inputs
    domains: ["vrf.marad.gov.ua"],
    portalUrl: "https://vrf.marad.gov.ua/check-document",
    inputs: [
      { key: "docNumber", label: "Document number (as printed)", source: "paste" },
      // The document prints its own issue date; prompt-only (no profile source).
      { key: "issuedOn", label: "Date of issue", source: "prompt" },
      // The portal's "quick search" doctype select. WIRE ONLY THESE FIVE
      // (dossier 2026-08-13): 76 "Свідоцтво НТЗ" (training-institution certs —
      // TCCS territory) and 849 (merchant ship master's certificate) are
      // deliberately NOT offered. `value` is the wire code the adapter posts.
      {
        key: "doctype",
        label: "Document type",
        source: "prompt",
        options: [
          { value: "70", label: "Certificate of Competency (Диплом)" },
          { value: "71", label: "Endorsement of the Certificate of Competency" },
          { value: "72", label: "GMDSS Certificate of Competency" },
          { value: "73", label: "Endorsement of the GMDSS Certificate of Competency" },
          { value: "74", label: "Certificate of Proficiency (Свідоцтво фахівця)" },
        ],
      },
    ],
    // NO codePattern DELIBERATELY: the printed number shape ("NNNNN/YYYY",
    // soft pattern /^\d{1,8}(\s*\/\s*\d{4})?$/ — see adapters/ua-marad.ts)
    // overlaps DK's 8-digit and the short-digit space, so a detection pattern
    // would trip the §2.3 fan-out cap on every DK-shaped paste. UA-MARAD is
    // reached by URL/QR (pinned domain), the country picker, or countryOverride
    // — where the needs-inputs prompt collects the issue date + doctype.
    //
    // ocrCodePattern (2026-08-24) is the planner-only companion, read
    // EXCLUSIVELY by planBareCodeCandidates; it fires when this entry's
    // `keywords` OR `hintKeywords` matched (hint-only additionally requires
    // `ocrCodeRawPattern` on the raw token) — detect.ts never sees it, so
    // the DK paste collision above stays structurally impossible. Matches
    // genericNormalize("12345/2024") = "123452024". The 9-digit minimum
    // (5+4) structurally rejects 8-digit normalized dd.mm.yyyy dates
    // ("25102024" is always 2+2+4 = 8 digits). Short numbers ("1/2024")
    // stay out of OCR-auto scope — guided fallback with Ukraine prefilled.
    ocrCodePattern: /^\d{5,8}20\d{2}$/,
    // Hint-only evidence must be the printed slash form ("NNNNN/20YY" as
    // the RAW token — the incident fixture's first read "01234/2026"); a
    // slash-less digit run (the fixture's second read "0123472026") is left
    // to the UK/NO shape lane. Ignored when a strong keyword matched.
    ocrCodeRawPattern: /^\d{5,8}\/20\d{2}$/,
    notes:
      "GET /check-document mints PHPSESSID + Cloudflare __cf_bm (browser User-Agent required), then form POST qualification_doctype + doc + qualification_gmzlb_date_day/_month/_year + submit. Deterministic miss marker: \"документ не знайдено\" (hardcoded Ukrainian even in the EN session — never anchor on the site's \"Нажаль\" typo). Hit page unobserved live: a result block with .pdf download link(s) is the only accepted positive signal; anything else → indeterminate. The quick index skews 2023+ — a miss for a pre-2023 issue date is inconclusive (date-gated in the adapter).",
    userNotes:
      "The state registry's quick search reliably covers documents issued 2023 and later — for older documents a \"not found\" answer is inconclusive, not a verdict.",
  },

  // ---- Azerbaijan (DDLA) — wired 2026-08-24 ------------------------------
  {
    country: "AZ",
    countryName: "Azerbaijan",
    authority: "Dövlət Dəniz və Liman Agentliyi — State Maritime and Port Agency (DDLA)",
    authorityShort: "Maritime and Port Agency (DDLA)",
    // Keywords frozen 2026-08-24 after the B2 pre-freeze gate against the
    // REAL operator sample's eng-tesseract OCR (rotated scan, read through
    // the worker's orientation fallback — gate output in the az fixture
    // README). Printed English text on the document; Latin-only (Azerbaijani
    // Ə never survives eng OCR — same documented limit as BG Cyrillic).
    // Misfire analysis: no other country's certificate prints either string;
    // neither co-occurs with existing keywords → single-country lock.
    // "ARDDA.GOV.AZ" was pre-demoted to backup only (UA dotted-domain gate
    // failure precedent: dots OCR-mangle).
    keywords: ["STATE MARITIME AND PORT AGENCY", "REPUBLIC OF AZERBAIJAN"],
    capability: "auto", // CONFIRMED live 2026-08-24: bare JSON POST, no CAPTCHA/session/CSRF
    keyKind: "public-identifier", // cert number + DOB are printed on the document
    recheckable: true, // certificateNumber + profile birthDate are non-sensitive stored inputs
    domains: ["publicservices.ddla.gov.az"], // NEVER ardda.gov.az (broken TLS)
    portalUrl: "https://publicservices.ddla.gov.az/seamencheck",
    inputs: [
      { key: "certificateNumber", label: "Certificate number (as printed, e.g. 000730/24)", source: "paste" },
      // DOB is printed on the certificate itself (public-identifier class) —
      // NOT sensitive (UK/NO/FI precedent-exact); keeps recheckable meaningful.
      { key: "dob", label: "Date of birth", source: "profile.birthDate" },
    ],
    // NO codePattern DELIBERATELY (paste stays OUT for v1): the normalized
    // "NNNNNNYY" form sits inside DK's 8-digit paste band, and detect.ts's
    // legacy slash-split would truncate a pasted "000730/24" to "24" before
    // any pattern runs — wiring AZ paste means touching legacy extractCode,
    // which is load-bearing everywhere. Paste users pick Azerbaijan in the
    // country select (countryOverride → needs-inputs DOB prompt works today).
    //
    // ocrCodePattern is the planner-only companion (read EXCLUSIVELY by
    // planBareCodeCandidates when THIS entry's keywords matched), anchored on
    // the RAW slash form: the raw token "000730/24" keeps its "/" under
    // TOKEN_RE, while printed dates use DOTS — so dates can never become AZ
    // candidates, structurally (the normalized 8-digit form would collide
    // with both dd.mm.yyyy dates and DK; see the raw-token seam in
    // keywords.ts).
    ocrCodePattern: /^\d{6}\/\d{2}$/,
    notes:
      "POST /seamencheck/check {type,code,birth}; type competency|training|dss|dqk (v1 wires competency ONLY — dss/dqk use different response columns with client-side expiry math, training is a distinct doc class; doctype extension is the documented v2 path). code keeps the /YY suffix; birth ISO YYYY-MM-DD (required). Unversioned Laravel app (check.js?v=da52505b8115) — contract pinned by fixture test. Response carries holder name + DOB + PHOTO: the photo is NEVER read/stored (adapters/az.ts hard rule).",
  },

  // ---- Wave 3 (assisted) -------------------------------------------------
  {
    country: "LV",
    countryName: "Latvia",
    authority: "Latvijas Jūras administrācija — Maritime Administration of Latvia",
    // 2026-08-12 keyword-gap fix from REAL specimen OCR (lv-coc/lv-cop/
    // lv-endorsement corpus items): actual LV certificates are issued by the
    // "Latvijas Jūrnieku reģistrs / Latvian Registry of Seamen" (a division of
    // the Maritime Administration) and NEVER print "Jūras administrācija" —
    // the reliable printed wordings are the state name (both languages, clean
    // in every specimen incl. the English-only endorsement) and the registry
    // name ("JURNIEKU REGISTR" stem covers reģistrs/reģistra inflections;
    // OCR mangled "Latvijas" itself, so the stems stand alone).
    keywords: [
      "JURAS ADMINISTRACIJA",
      "MARITIME ADMINISTRATION OF LATVIA",
      "LATVIJAS REPUBLIKA",
      "REPUBLIC OF LATVIA",
      "JURNIEKU REGISTR",
      "REGISTRY OF SEAMEN",
    ],
    capability: "assisted", // reCAPTCHA Enterprise v2
    keyKind: "public-identifier",
    recheckable: false,
    // Live header probe 2026-07-21: the verification page sends NO
    // X-Frame-Options and NO CSP, has no framebusting, its reCAPTCHA
    // Enterprise v2 checkbox is iframe-compatible, and the form AJAX-POSTs
    // same-origin with the token — the ONLY assisted portal confirmed safe to
    // show in an in-app iframe. (LT frames but its PHPSESSID breaks in a
    // third-party context; all other assisted portals are XFO-blocked.)
    embeddable: true,
    domains: ["www.lja.lv"],
    // The old /verify path 404s — this is the live form location.
    portalUrl: "https://www.lja.lv/en/seafarers/verification-of-authenticity/verification-of-certificates/",
    contactEmail: "verify@lja.lv",
    inputs: [
      { key: "certNumber", label: "Certificate / endorsement number", source: "paste" },
      { key: "name", label: "Holder name and surname", source: "profile.verifiedName" },
    ],
    notes:
      "Three tab-forms (CoC / CoP / Endorsement, field ids tabN-*), reCAPTCHA Enterprise v2 — deep link + copy-ready fields only.",
  },
  {
    country: "LT",
    countryName: "Lithuania",
    authority: "Lietuvos transporto saugos administracija (LTSA)",
    // Bilingual LT documents print the official English agency name too
    // (2026-08-12 gap sweep).
    keywords: ["TRANSPORTO SAUGOS ADMINISTRACIJA", "LITHUANIAN TRANSPORT SAFETY ADMINISTRATION"],
    capability: "assisted", // Yii image CAPTCHA
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["seaman.msa.lt"],
    // Deep link straight to the search form (verified live 2026-08-12).
    portalUrl: "https://seaman.msa.lt/documents/search",
    contactEmail: "mardep.paslaugos@ltsa.lt",
    inputs: [
      { key: "name", label: "First name", source: "profile.verifiedName" },
      { key: "surname", label: "Surname", source: "profile.verifiedName" },
      { key: "docType", label: "Document type", source: "prompt" },
      { key: "number", label: "Document number", source: "paste" },
    ],
    notes:
      "Yii form (SearchForm[name]/[lname]/[type]/[num]; doc-type select values 1–9 mapped in the dossier) behind an image CAPTCHA.",
  },
  {
    country: "GR",
    countryName: "Greece",
    authority: "Hellenic Coast Guard — Ministry of Maritime Affairs and Insular Policy",
    // English form only — the Greek-script authority name is DEAD until
    // non-eng traineddata ships (eng-only OCR worker).
    keywords: ["HELLENIC COAST GUARD"],
    capability: "assisted", // hCaptcha
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["stcw.hcg.gr"],
    portalUrl: "https://stcw.hcg.gr/verify-stcw/",
    inputs: [
      { key: "cert_no", label: "Certificate number", source: "paste" },
      { key: "last_name", label: "Surname (exact case)", source: "prompt" },
      { key: "first_name", label: "First name (exact case)", source: "prompt" },
      // Stored nowhere — always prompt. OPTIONAL since 2026-08-12: the live
      // form gained an "empty father's name" checkbox, so a blank value is a
      // legitimate submission, never a gate.
      { key: "father_name", label: "Father's name (exact case, if any)", source: "prompt", optional: true },
    ],
    notes:
      "Django POST + CSRF + hCaptcha — deep link + copy-ready fields only. WARNING: \"hcg-gov.gr\" is a FAKE registry domain imitating this authority; the only official host is stcw.hcg.gr.",
    userNotes:
      "WARNING: “hcg-gov.gr” is a FAKE registry website imitating this authority — the only official verification site is stcw.hcg.gr. Names must be entered exactly as printed on the certificate.",
  },
  {
    country: "ES",
    countryName: "Spain",
    authority: "Dirección General de la Marina Mercante (Spain)",
    keywords: ["MARINA MERCANTE"],
    capability: "assisted", // reCAPTCHA v2 invisible + WebForms ViewState
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["sede.transportes.gob.es"],
    // Deep link straight to the English ConsultaVTC form (verified live 2026-08-12).
    portalUrl:
      "https://sede.transportes.gob.es/MFOM.DGMM.CONSULTAVTC.WEB/ConsultaVTC.aspx?lang=en",
    inputs: [
      { key: "name", label: "First name", source: "prompt" },
      { key: "surnames", label: "Both surnames", source: "prompt" },
      { key: "nif", label: "NIF / NIE / passport number", source: "prompt", sensitive: true },
      { key: "titleNumber", label: "Title number", source: "paste" },
    ],
    notes:
      "ConsultaVTC.aspx (lang=en), ASP.NET WebForms (field names in the dossier), reCAPTCHA v2 invisible + ViewState — deep link + copy-ready fields only. NIF is sensitive: never persisted or logged.",
  },
  {
    country: "DE",
    countryName: "Germany",
    authority: "Bundesamt für Seeschifffahrt und Hydrographie (BSH)",
    // BSH documents are bilingual DE/EN — the official English agency name is
    // printed alongside (2026-08-12 gap sweep).
    keywords: ["BUNDESAMT FUR SEESCHIFFFAHRT", "FEDERAL MARITIME AND HYDROGRAPHIC AGENCY"],
    capability: "manual", // vetted-registration PROCESS, not a connector
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["login.bsh.de", "linwebapp62.bsh.de"],
    portalUrl: "https://login.bsh.de",
    contactEmail: "zeugnisse@bsh.de",
    inputs: [],
    notes:
      "SBVOV verification requires a vetted registered account (documented in the dossier) — a business process, not a connector. When such an account exists, credentials live in env on the box, never in the repo.",
  },
  {
    country: "IE",
    countryName: "Ireland",
    authority: "Marine Survey Office — Mercantile Marine Office (Ireland)",
    keywords: ["MARINE SURVEY OFFICE", "MERCANTILE MARINE OFFICE"],
    capability: "manual", // vetted-access process
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["www.seafarers.ie"],
    portalUrl: "https://www.seafarers.ie",
    contactEmail: "admin@seafarers.ie",
    inputs: [],
    notes: "ERegister/Elogin access is vetted — manual verification request by email.",
  },

  // ---- Wave 4 (manual) ---------------------------------------------------
  {
    country: "NL",
    countryName: "Netherlands",
    authority: "Kiwa Register (on behalf of ILT, Netherlands)",
    keywords: ["KIWA REGISTER"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["kiwaregister.com"],
    portalUrl: "https://kiwaregister.com",
    contactEmail: "NL.Elicense-support@kiwa.com",
    inputs: [],
    notes:
      "No public lookup tool. Future path: NL mdoc/eWallet pilot (ISO 18013-5, phase 2 since Apr 2025) — the EUDI wallet route (#54).",
  },
  {
    country: "IT",
    countryName: "Italy",
    authority: "Ministero delle Infrastrutture e dei Trasporti (Italy)",
    keywords: ["INFRASTRUTTURE E DEI TRASPORTI"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["lavoromarittimo.mit.gov.it"],
    portalUrl: "https://lavoromarittimo.mit.gov.it",
    contactEmail: "certmarittimi.dgvptm@mit.gov.it",
    inputs: [],
    notes:
      "The online tool covers 2019–2023 issuances only — 2024+ certificates are confirmed by email (certmarittimi.dgvptm@mit.gov.it).",
    userNotes:
      "The authority's online tool covers certificates issued 2019–2023 only — newer certificates are confirmed by email.",
  },
  {
    country: "PL",
    countryName: "Poland",
    authority: "Urząd Morski / maritime administration (Poland)",
    keywords: ["URZAD MORSKI"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["centrum.phics.gov.pl"],
    portalUrl: "https://centrum.phics.gov.pl",
    contactEmail: "certyfikaty@ums.gov.pl",
    inputs: [],
    notes: "PHICS /umverifi is vetted (administrations + shipowners only) — manual request by email.",
  },
  {
    country: "RO",
    countryName: "Romania",
    authority: "Autoritatea Navală Română (Romania)",
    // Bilingual RO documents print the official English authority name too
    // (2026-08-12 gap sweep).
    keywords: ["AUTORITATEA NAVALA ROMANA", "ROMANIAN NAVAL AUTHORITY"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["www.rna.ro", "portal.rna.ro"],
    portalUrl: "https://portal.rna.ro",
    contactEmail: "suport@rna.ro",
    inputs: [],
    notes:
      "WARNING: \"rnaro.com\" and \"anr-ro.com\" are FAKE registry domains imitating this authority (re-confirmed still ranking in search). The only official hosts are rna.ro / portal.rna.ro.",
    userNotes:
      "WARNING: “rnaro.com” and “anr-ro.com” are FAKE registry websites imitating this authority — the only official sites are rna.ro and portal.rna.ro.",
  },
  {
    country: "PT",
    countryName: "Portugal",
    authority: "Direção-Geral de Recursos Naturais, Segurança e Serviços Marítimos (DGRM)",
    keywords: ["SERVICOS MARITIMOS", "DGRM"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["dgrm.pt", "dgrm.mm.gov.pt"],
    portalUrl: "https://www.dgrm.mm.gov.pt",
    contactEmail: "dgrm@dgrm.mm.gov.pt",
    inputs: [],
    notes: "No online verification tool — manual request by email.",
  },
  {
    country: "LU",
    countryName: "Luxembourg",
    authority: "Commissariat aux affaires maritimes (Luxembourg)",
    keywords: ["COMMISSARIAT AUX AFFAIRES MARITIMES"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["maritime.public.lu"],
    portalUrl: "https://maritime.public.lu",
    contactEmail: "cam@cam.etat.lu",
    inputs: [],
    notes: "Web form → email reply.",
  },
  {
    country: "IS",
    countryName: "Iceland",
    authority: "Samgöngustofa — Icelandic Transport Authority",
    keywords: ["SAMGONGUSTOFA", "ICELANDIC TRANSPORT AUTHORITY"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["samgongustofa.is"],
    portalUrl: "https://samgongustofa.is",
    contactEmail: "sigling@samgongustofa.is",
    inputs: [],
    notes:
      "WARNING: \"itados.org\" is a NEW FAKE registry domain imitating this authority. The only official host is samgongustofa.is.",
    userNotes:
      "WARNING: “itados.org” is a FAKE registry website imitating this authority — the only official site is samgongustofa.is.",
  },
  {
    country: "SI",
    countryName: "Slovenia",
    authority: "Uprava Republike Slovenije za pomorstvo (Slovenian Maritime Administration)",
    // Official docs carry the English "Maritime Administration of X" form
    // (2026-08-12 gap sweep).
    keywords: ["SLOVENIJE ZA POMORSTVO", "SLOVENIAN MARITIME ADMINISTRATION"],
    capability: "manual",
    keyKind: "public-identifier",
    recheckable: false,
    domains: ["www.gov.si", "gov.si"],
    portalUrl: "https://www.gov.si",
    contactEmail: "ursp.box@gov.si",
    inputs: [],
    notes: "Manual verification request by email.",
  },
];

// ---- Lookup helpers ------------------------------------------------------

export function countryEntry(country: CountryCode): CountryEntry | undefined {
  return COUNTRIES.find((c) => c.country === country);
}

/** Union of every pinned hostname across all entries (lowercased). */
export function allPinnedDomains(): Set<string> {
  const out = new Set<string>();
  for (const c of COUNTRIES) for (const d of c.domains) out.add(d.toLowerCase());
  return out;
}

/** Exact-hostname match (§2.4 — never endsWith) against the pinned allowlists. */
export function entryForHostname(hostname: string): CountryEntry | undefined {
  const h = hostname.toLowerCase();
  return COUNTRIES.find((c) => c.domains.some((d) => d.toLowerCase() === h));
}

/**
 * Drop every `sensitive:true` input (BG EGN, ES NIF, …) before persisting
 * lookup inputs on a Doc (§4.6): sensitive fields are pass-through only —
 * never written to db.json, never logged. Unknown keys are kept (they can only
 * be non-sensitive by definition of the country's input spec — but if the
 * country is unknown, everything is dropped, fail-closed).
 */
export function stripSensitiveInputs(
  country: CountryCode,
  inputs: Record<string, string>
): Record<string, string> {
  const entry = countryEntry(country);
  if (!entry) return {};
  const sensitive = new Set(entry.inputs.filter((i) => i.sensitive).map((i) => i.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (!sensitive.has(k)) out[k] = v;
  }
  return out;
}
