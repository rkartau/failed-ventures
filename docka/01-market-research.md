# Seafarer Credential Platform — Market Research

*Compiled from 5 parallel web-research agents. This is the full record behind the roadmap.*

**Locked decisions (context):** MVP customer = crewing/manning agents · scope = EU/Baltic, Estonia first · product = seafarer-owned wallet feeding an agent workflow · trust = pragmatic gov-QR checks now, verifiable-credentials later · pricing = per-seat subscription.

---

## 1. The market need — by stakeholder

### 1a. Seamen (all countries)
A seafarer must keep a stack of documents valid at all times, across categories:
- **Competency** — Certificate of Competency (CoC): Master, Chief Mate, OICNW (deck); Chief/2nd Eng, OICEW, ETO (engine); ratings (Able Seafarer, ETR).
- **Flag-state recognition** — Endorsement / Certificate of Recognition (CoR/CRD): the flag the ship flies must recognise a foreign CoC before the seaman can serve.
- **Radio** — GMDSS operator certificate.
- **Safety training (STCW CoPs)** — Basic Safety Training, Advanced Fire Fighting, survival craft (PSCRB), medical first aid, security awareness, tanker familiarisation, etc.
- **Medical fitness** — e.g. UK ENG1 and flag equivalents (valid ~2 years).
- **Identity / sea service** — Seaman's Book / Continuous Discharge Certificate (CDC), passport, ILO-185 seafarer ID.
- **Travel / health** — visas (incl. US C1/D), vaccination certs per route.

**Today:** seamen email photos/PDFs of these docs. The same set gets re-collected for every new job. No portable, verified source of truth they own.

### 1b. Agents (the paying customer)
Manning/crewing agencies collect, check, and keep these docs valid, and match each seaman to a vessel's requirement matrix. Top pains, ranked:

| # | Pain | Who feels it |
|---|------|--------------|
| 1 | **Expiry surprises** — a cert/medical/endorsement lapses mid-planning or mid-voyage → last-minute swap, delay, port detention | Agency + operator |
| 2 | **Certificate fraud / forgery** — can't cheaply confirm a doc is genuine | Operator, flag state |
| 3 | **No single source of truth** — data across tabs, folders, email threads; conflicting spreadsheet versions | Agency admins |
| 4 | **Manual transcription** — re-keying cert numbers/dates/names from scans; hours per candidate; error-prone | Agency back office |
| 5 | **Re-verification every embarkation** — same seaman's docs re-collected/re-checked for each vessel and flag | Agency + operator |
| 6 | **Slow flag-state endorsement issuance** — recognising a foreign CoC takes time; blocks placement | Seafarer + operator |
| 7 | **Seafarers emailing photos** — low-quality, wrong/old versions, insecure | Both |
| 8 | **GDPR exposure** — passports/medicals in shared spreadsheets, no access control or audit trail | Agency (data controller) |

### 1c. Ships / operators
Under the **ISM Code** the shipowner/company is legally responsible for verifying the **authenticity and validity** of every seaman's documents — even though the flag state issues them. **Port State Control** (Paris MoU / Tokyo MoU) inspects crew certs against digital systems (THETIS, APCIS); expired/missing certs are recorded deficiencies and, in serious cases, **detainable**. Certificate-related deficiencies stayed in the top-10 detention causes in 2024–25. They need trust, not just storage.

### 1d. Governments (integration reality)
- **Estonia** — `meremees.transpordiamet.ee` (Meremeeste Infosüsteem). Two paths: a **restricted register** (vetted parties only) and a **public per-document link/QR** the holder generates (the `certificates/<code>` + kontrollkood pattern). Shows holder name, isikukood, validity dates, status (Kehtiv = valid), issuing country. **No public verification API.**
- **Almost every flag state** now has *some* online verification, but each is a **separate portal with a different lookup key** and **no public machine-readable API**:

| Authority | Online verify? | QR? | Public API? |
|-----------|----------------|-----|-------------|
| Estonia (Transpordiamet) | Yes (per-doc link/QR; register restricted) | Yes | No |
| UK MCA | Yes (cert no. + DOB) | Yes (new cards) | No |
| Norway (NMA) | Yes (app + My Page) | Yes (app) | Reporting only |
| Philippines MARINA | Yes (search COC/COP) | Yes | Not documented |
| Singapore MPA | Yes (e-service) | — | No |
| India DG Shipping | Yes (free, real-time) | — | Stakeholder only |
| Liberia LISCR | Yes (TID lookup) | via TID | No |
| Denmark DMA | Yes (`verify.dma.dk` + app) | Likely | No |
| Panama AMP | Weaker, agent-mediated | — | No |
| Netherlands (Kiwa) | Limited | No | No |

- **No global or EU-wide individual-certificate database.** IMO **GISIS** is only a *directory of where to verify* + the STCW "White List". EU **EMSA** holds aggregate stats only; an EU individual-cert database is parked at "feasibility".
- **Regulatory tailwind:** since **1 Jan 2025** the IMO mandates **electronic, QR-verifiable STCW certificates** (MSC.540(107)/MSC.541(107)) — PSC officers "scan a QR and instantly verify" via digital signatures (ECDSA SHA-256/384). The **EU Digital Identity (EUDI) Wallet** is mandated for all member states by end 2026.
- **Estonia advantage:** **X-Road** (secure gov data-exchange, once-only principle, fully logged) + **e-ID / Smart-ID / Mobiil-ID** give a real integration path the platform can join as a member.

**Takeaway:** the only broadly-available verification surface is **QR / public-URL resolution, one bespoke connector per flag state** — normalise them into one internal schema. The fragmentation *is* the market gap.

---

## 2. Competition — the landscape

Two camps that **don't meet**. Nobody owns the intersection.

| # | Player | Primary customer | Strengths | Weaknesses / gaps |
|---|--------|------------------|-----------|-------------------|
| 1 | **Adonis** (Veson) | Operator / large fleet | Deep, mature ERP | Legacy, clunky, expensive, enterprise-only, doc silo, no seafarer ownership |
| 2 | **COMPAS** (Ocean Technologies) | Operator + agent | Cloud, ship-shore sync, ~5,000 ships, ties to training | Company-owned data, not portable, no gov validation |
| 3 | **smartPAL** (MariApps) | Operator ERP | Full ERP, strong in Asia | Operator-siloed; seaman is a record, not an owner |
| 4 | **CrewInspector** (BachmannHR) | Agent + ship manager | Cloud, GDPR, 1M+ profiles, mid-market price | Docs = unverified uploads; agency-owned; no cross-company sharing |
| 5 | **DNV ShipManager / ABS / BASSnet** | Operator | Trusted vendor brands, integrated suites | Crewing is a bolt-on; heavy; no portability; no external validation |
| 6 | **Martide** | SME operator + seafarer | Two-sided (rare), free job board, mobile wallet | Wallet is self-uploaded/unverified; tied to its job ecosystem |
| 7 | **Crewdentials** | Seafarer (free) + business | Closest to us: crew-owned, free, connects to companies | **Self-asserted docs, no gov-verified validity** |
| 8 | **IDsure** + Bahamas registry | Flag state → seafarer | **Real gov issuance** (Bahamas live 1 Jun 2026), blockchain-signed, tamper-proof, €600k seed | Flag-by-flag rollout; only the docs the authority signs; no crewing/sharing workflow |
| 9 | **Maritime Passport** | Seafarer + gov + operator | Seafarer data control, offline-first, eIDAS/GDPR framing | Thin proof points; unclear which registries issue into it |
| 10 | **Credly / Accredible** | Any issuer | Massive scale, W3C/Open Badge standards, wallet | Not maritime-aware (no STCW/flag semantics, no crewing workflow) |

*(Excluded: Kaiko, Greywing — inspections, not certs.)*

### The white space
- **Enterprise crewing systems** own the workflow but treat the seaman as a record in one company's silo; docs are unverified uploads; every new employer re-checks from scratch.
- **Digital-ID / VC entrants** (IDsure, Maritime Passport) bring real gov-signed, verifiable credentials + seafarer ownership — but only the narrow slice one flag signs, with **no crewing/sharing/matching workflow** and single-flag rollout.

**Nobody combines:** verified-once-trusted-everywhere validity + seafarer ownership + the agent workflow, as a neutral network across flags. That is the wedge. **But IDsure and Crewdentials are funded and moving in 2026 — the clock is real.** Defence = own the agent workflow they lack.

---

## 3. Adjacent industries — patterns to steal

Same structure everywhere: mobile skilled workers → placed by agencies → onto sites/vehicles/vessels → under a government regulator.

| Industry | How it's solved today | What to steal |
|----------|----------------------|---------------|
| **Aviation** (pilots/crew) | Enterprise crew systems with per-authority **rule engines** (currency, expiry, grace periods) + personal e-logbooks (FLYLOG, capzlog) | The **rule engine**: per-authority/type currency + auto expiry warnings |
| **Healthcare** (travel nurses/locum) | **Primary-source verification (PSV)** via APIs to state boards/DEA; continuous monitoring; **exception-only review**; CAQH shared national data utility (Medallion, Verifiable, Propelus) | **PSV as the trust anchor** + **API-first** + a **shared data utility** so a worker enters data once |
| **Trucking** (CDL) | Cloud Driver Qualification File, mobile photo upload, expiry alerts, full lifecycle (Tenstreet, DriverReach) | **Worker-facing mobile app** + **two-sided lifecycle** console |
| **Construction / oil & gas** | Single trusted verified DB (OPITO **Vantage**) with **live workforce view** + site-access gating; cross-sector **skills passport** | **One trusted DB the industry gates access on** + live expiry → trigger refresher before it blocks mobilisation |
| **Cross-industry (VC/wallets)** | **EUDI Wallet**, mobile driving licence (mDL), W3C Verifiable Credentials, selective disclosure | **Worker-owned wallet + selective disclosure**; regulated sectors must accept EUDI by **Nov 2027** |

**Healthcare is furthest ahead** on verification rigor and architecture. **Maritime is the least mature** — it can copy healthcare's PSV + oil&gas's trusted-DB-with-access-gating + aviation's rule engine + trucking's two-sided app, delivered on an EUDI-ready wallet.

---

## 4. Technology backbone (build-to-standard)

- **Roles:** Issuer (authority signs a cert) → Holder (seaman's wallet) → Verifier (agent/ship/PSC checks signature + revocation, offline). Verifier does **not** need to phone the issuer.
- **Formats:** **SD-JWT VC** (RFC 9901) primary + **mdoc / ISO 18013-5** for in-person + EUDI parity — exactly what eIDAS 2.0 mandates.
- **Issue/present:** OpenID4VCI + OpenID4VP (HAIP profile).
- **Revocation:** **Bitstring Status List v1.0** — one bit per credential, herd-privacy, cacheable, checkable offline.
- **QR strategy — do both:** an **offline signed QR** (works on ships/ports with no internet) + an **online registry lookup** (Estonian code + kontrollkood) as authoritative fallback.
- **Estonia integration:** join **X-Road** to query the authoritative register; authenticate parties with **e-ID / Smart-ID / Mobiil-ID**; target the **EUDI Wallet** as holder app.
- **Legal trust:** eIDAS **Qualified Seal** (HSM) + **PAdES**-sealed PDFs for human/legacy flows; anchor to **EU Trusted Lists**.
- **GDPR by design:** selective disclosure (reveal "holds valid STCW II/1" without the medical history); consent + tamper-proof audit trail; **keep personal data OFF any shared list** — the status list holds only opaque bits.

**Headline tailwind:** the domain is uniquely favourable — IMO already mandates electronic QR-verifiable STCW certs, and eIDAS 2.0 mandates the exact formats the platform should adopt. We build *with* the regulation, not against it.

---

## 5. Key sources
- Estonia MIS: transpordiamet.ee/en/maritime-and-waterways/mariners/seafarers-information-system · meremees.transpordiamet.ee
- IMO: Certificate Verification, Fraudulent Certificates, GISIS; MSC.540(107)/MSC.541(107) e-STCW (from 1 Jan 2025)
- PSC: Paris MoU / Tokyo MoU detention guidance
- Competitors: adonishr.com · oceantg.com/compas · crewinspector.com · martide.com · crewdentials.com · idsure.io (+ Bahamas DSRB) · maritime-passport.com
- Fraud scale: Mona Lisa Project "Evidence of false seafarer certification"; IMO 12,635 forgeries study
- Adjacent: medallion.co · verifiable.com/primary-source-verification · tenstreet.com/software/dqf · OPITO Vantage / Energy Skills Passport · EUDI Wallet (eudi.dev ARF)
- Tech: W3C Bitstring Status List · SD-JWT VC (RFC 9901) · OpenID4VCI/VP · X-Road (e-estonia.com) · eIDAS Trusted Lists

*Full agent transcripts with every inline URL are preserved in this session.*
