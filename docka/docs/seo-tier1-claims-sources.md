# SEO Tier 1 — Claim → Source table (fabrication-gate artifact)

This file is the committed anti-fabrication artifact for the two Tier-1 `/resources`
articles. Every factual/quantitative claim in those two article pages carries an adjacent
`[src:...]` code comment (not user-visible); the committed test
`app/tests/seo-tier1-articles.test.mjs` fails if a claim sentence lacks one, and fails if a
`[src:ID]` names a source family that is not on the allowlist below.

## Allowed source IDs (machine-readable allowlist)

Every `[src:ID]` token in the two article JSX files MUST begin with one of these source-family
ids. An unknown/invented id fails the fabrication test.

- `verifiable-registries-truth.md` — `scratchpad/docka.me-audit/findings/verifiable-registries-truth.md` (registry truth: 8 flag-state live-auto + Bulgaria presence-only; Cyprus / Ukraine-2023+ / Bulgaria-2017+ caveats).
- `real-features` — the repo-established feature set (L0–L3 ladder, cross-seafarer duplicate cert-number detection, hard-block on lapsed STCW, expiry reminders, pricing 300 EUR/mo + 2 EUR/billable seafarer, free-for-seafarers, PSV spell-out vs Platform Supply Vessel, Docka Development OÜ / registry code 17579582, "a forgery passes a human eye but not the issuing register").
- `pillar` — `scratchpad/docka-content-drafts/article-how-verification-works.md` (the already-shipped pillar article: primary-source verification checks the copy against the authority's register; an expiry date printed on a PDF is a claim, not a fact — check the live record).
- `stcw-convention` — https://www.imo.org/en/OurWork/HumanElement/Pages/STCW-Convention.aspx (IMO, fetched 7 September 2026, HTTP 200). Text read on the page and quoted or paraphrased in the guides: "The 1978 STCW Convention entered into force on 28 April 1984"; the 2010 Manila amendments (adopted 21 to 25 June 2010) "mainly introduced: Improved measures to prevent fraudulent practices associated with certificates of competency" and a "Refresher training module every five years for basic training on personal survival techniques and fire prevention and firefighting; advanced firefighting; and proficiency in survival craft, rescue boats and fast rescue boats"; the chapter list (I General provisions ... VIII Watchkeeping). The regulation I/11 statement ("revalidation at intervals not exceeding five years") is the Convention regulation itself (chapter I, general provisions, whose landing page this is); the IMO page names chapter I but does not reproduce the regulation text, and the guides say no more than the regulation says. Used for every five-year / refresher / fraud-measure statement (plan R7c).
- `lib-registry-countries` — the product's own registry table, `app/lib/registry/countries.ts`, read at render time through the public projection `app/lib/registry/public-rows.ts` (`REGISTRY_PUBLIC_ROWS`: `code, country, authority, authorityShort, portalUrl, capability, inputs[].label, userNotes` only; never `notes`). Supports: which registers are live automatic or existence-only, the exact input labels each portal takes (e.g. EE "Verification code"; UK "Document ID" + "Date of birth"; NO "Certificate number" + "Date of birth"), the pinned official portal URLs, and the user-facing caveats and fake-domain warnings. Nothing from this source is re-typed in prose: the tables render the projection directly.

No fraud/forgery rate or percentage, no detention/fine/penalty figure, no customer count, no
testimonial, and no "26 registries" figure is asserted anywhere (all deliberately omitted for
lack of a source). Only the 8 live-auto flag states + Bulgaria presence-only are stated.

---

## Article 1 — /resources/spot-forged-recycled-seafarer-certificate

| # | Claim (as written) | Source id |
|---|---|---|
| 1 | A forged CoC/STCW endorsement can carry the right stamp, layout, signature, QR code and pass a human eye. | real-features — a forgery passes a human eye but not the issuing registry |
| 2 | Forged = never issued by the named authority; recycled = a real cert number reused on a different person's document. | real-features — cross-seafarer duplicate certificate-number detection |
| 3 | A forged certificate was never entered in the register, so a register check finds no match. | real-features / pillar — forgery fails the issuing register |
| 4 | A recycled real number may return "valid" on a single lookup; the pairing is what is wrong. | real-features — cross-seafarer duplicate certificate-number detection |
| 5 | Docka flags when the same certificate number is attached to more than one person (cross-seafarer duplicate check). | real-features — cross-seafarer duplicate certificate-number detection |
| 6 | "PSV" = primary source verification, and also "platform supply vessel" in shipping — spelled out to avoid the collision. | real-features — PSV = primary source verification; collides with Platform Supply Vessel |
| 7 | Primary-source verification = check the copy against the issuing authority's own register. | pillar — primary-source verification checks the copy against the authority's register |
| 8 | Docka runs live automatic checks against 8 flag-state registries: Estonia, Denmark, Cyprus, UK, Norway, France, Ukraine state, Azerbaijan. | verifiable-registries-truth.md — SAFE CLAIMS / 8 flag-state live-auto |
| 9 | Bulgaria: automatic check confirms the document EXISTS (2017+) — presence, not validity. | verifiable-registries-truth.md — Bulgaria auto-presence, 2017+, existence not validity |
| 10 | Other countries: assisted — Docka deep-links + pre-fills the official portal; a person completes the check. | verifiable-registries-truth.md — assisted deep-link + prefill, user completes |
| 11 | Cyprus: treat as live registry connection, not a guaranteed green verdict. | verifiable-registries-truth.md — Cyprus soft caveat |
| 12 | Ukraine state registry: coverage reliable 2023+; "not found" on older doc is inconclusive. | verifiable-registries-truth.md — Ukraine (state) auto, 2023+ coverage caveat |
| 13 | Four-level ladder: L0 Unverified / L1 Self-added / L2 Registry-confirmed / L3 Government-verified. | real-features — L0→L1→L2→L3 ladder |
| 14 | L2 = document exists; L3 = authority confirms this document for this holder; forgery can't reach L2, recycled number can. | real-features — L0–L3 ladder + duplicate-cert detection |
| 15 | Azerbaijan (State Maritime and Port Agency) is one of the 8 live-auto flag states. | verifiable-registries-truth.md — Azerbaijan auto |
| 16 | Ukraine state registry live automatic; 2023+ coverage caveat (FAQ). | verifiable-registries-truth.md — Ukraine (state) auto, 2023+ |
| 17 | Docka built by Docka Development OÜ (Tallinn, Estonia; registry code 17579582). | real-features — Docka Development OÜ, Tallinn, registry code 17579582 |
| 18 | (WP-D) The 2010 Manila amendments introduced "improved measures to prevent fraudulent practices associated with certificates of competency"; the Convention has been in force since 28 April 1984. | stcw-convention — IMO STCW Convention page, quoted |
| 19 | (WP-D) The registers Docka queries automatically, the fields each one asks for and its official portal (rendered table). | lib-registry-countries — REGISTRY_PUBLIC_ROWS at render time |
| 20 | (WP-D) Worked example: a Norwegian check sends certificate number + date of birth to the Norwegian Maritime Authority's service; the duplicate-number check compares the number across the agency's seafarers (process only, no invented outcome). | lib-registry-countries — NO inputs; real-features — cross-seafarer duplicate detection, timestamped result |
| 21 | (WP-D) Some websites imitate maritime authorities; Docka talks only to pinned official domains and shows a warning for known impostor domains. | lib-registry-countries — userNotes fake-domain warnings, portalUrl pinned domains |
| 22 | (WP-D) The trust ladder (L0 to L3) rendered from TRUST_LADDER (LEVEL_META): L0 Self-uploaded, not yet verified; L1 Reviewed by staff; L2 Registry-confirmed; L3 Government-verified. | real-features — lib/verification-level.ts LEVEL_META (corrects the earlier "L1 Self-added" wording) |

## Article 2 — /resources/check-stcw-certificate-valid

| # | Claim (as written) | Source id |
|---|---|---|
| 1 | An expiry date on an STCW PDF is a claim, not proof; the reliable check is the live register. | pillar — an expiry date printed on a PDF is a claim, not a fact; check the live record |
| 2 | A certificate can be suspended/withdrawn before its printed expiry; the paper won't show it; only the register reflects current status. | pillar — check the live record (register = current status, not the PDF) |
| 3 | For 8 flag states the check is live automatic: Estonia, Denmark, Cyprus, UK, Norway, France, Ukraine state, Azerbaijan. | verifiable-registries-truth.md — SAFE CLAIMS (8 flag-state live-auto) |
| 4 | Bulgaria: automatic existence check, 2017+, presence not validity. | verifiable-registries-truth.md — Bulgaria auto-presence, 2017+ |
| 5 | Other countries: assisted — official portal, person completes. | verifiable-registries-truth.md — assisted deep-link + prefill |
| 6 | Docka sends expiry reminders ahead of the date. | real-features — expiry reminders |
| 7 | Docka hard-blocks a seafarer the moment a required STCW certificate has lapsed. | real-features — hard-block on lapsed STCW certificate |
| 8 | Four-level ladder L0–L3 (as above). | real-features — L0→L1→L2→L3 ladder |
| 9 | Cyprus: live registry connection, not a guaranteed green verdict. | verifiable-registries-truth.md — Cyprus soft caveat |
| 10 | Ukraine state registry: reliable 2023+; older "not found" inconclusive. | verifiable-registries-truth.md — Ukraine (state) 2023+ caveat |
| 11 | Docka is free for seafarers. | real-features — free for seafarers |
| 12 | For agencies: 300 EUR/month + 2 EUR per billable seafarer. | real-features — pricing 300 EUR/mo + 2 EUR/billable seafarer |
| 13 | Docka built by Docka Development OÜ (Tallinn, Estonia; registry code 17579582). | real-features — Docka Development OÜ, Tallinn, registry code 17579582 |
| 14 | (WP-D) STCW regulation I/11: a certificate of competency is revalidated at intervals not exceeding five years, by showing continued professional competence. | stcw-convention — Convention chapter I (regulation I/11); see the allowlist note |
| 15 | (WP-D) Under the 2010 Manila amendments, basic safety training (A-VI/1), survival craft and rescue boat (A-VI/2) and advanced fire fighting (A-VI/3) proficiencies need evidence of continued competence every five years (refresher). | stcw-convention — "Refresher training module every five years ..." quoted on the IMO page |
| 16 | (WP-D) Estonia's Transpordiamet keys its validity check on a single "Verification code"; a printed code is a shortcut to the register lookup, not proof by itself. | lib-registry-countries — EE input label "Verification code", portal meremees.transpordiamet.ee; pillar — the register is the proof |
| 17 | (WP-D) Worked example: a UK check sends the Document ID and date of birth to the MCA's verification service and records the answer with a timestamp; a not-found result is never rounded up (process only, no invented outcome). | lib-registry-countries — UK inputs "Document ID" + "Date of birth", portal coccec.mcga.gov.uk; real-features — timestamped result, L3 |
| 18 | (WP-D) The registers Docka queries automatically, the fields each one asks for and its official portal (rendered table). | lib-registry-countries — REGISTRY_PUBLIC_ROWS at render time |
| 19 | (WP-D) The trust ladder (L0 to L3) rendered from TRUST_LADDER (LEVEL_META). | real-features — lib/verification-level.ts LEVEL_META (corrects the earlier "L1 Self-added" wording) |
| 20 | (WP-D) Pricing FAQ reworded: free for the seafarer; agency licence 300 EUR a month plus 2 EUR per billable seafarer. | real-features — pricing 300 EUR/mo + 2 EUR/billable seafarer; free for seafarers |

---

## Deliberate omissions (claims NOT made, for lack of a source)

- No fraud/forgery rate or percentage of fake certificates.
- No detention/fine/penalty figures or claims of specific enforcement outcomes.
- No customer counts, named agencies, or testimonials.
- No "26 registries" figure (explicitly barred; only the 8 live-auto flag states + Bulgaria presence-only are stated).
- Ukraine training-centre (UA-TCCS) validator NOT presented as flag-state verification.
