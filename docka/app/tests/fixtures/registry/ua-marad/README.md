# UA-MARAD fixtures (vrf.marad.gov.ua)

## Real-capture fixtures (2026-08-24)

`ua-marad-valid.html` (hit) and `ua-marad-miss.html` (miss) are **scrubbed-in-place
copies of live wire captures** taken 2026-08-24 against vrf.marad.gov.ua
(POST /check-document; hit = a real user-uploaded CoC; its number is replaced with 12345/2024 in the public archive; issued
2024-10-25, doctype 70; miss = a deliberate wrong-number query). Scrub method
(nothing was re-typed — Cyrillic re-typing invites homoglyph substitutions):

1. the curl-style HTTP header block was deleted (it carried live PHPSESSID /
   Cloudflare `__cf_bm` session cookies);
2. the two per-request evidence hash tokens (55 chars, `[A-Za-z0-9_-]`) were
   replaced with `FAKETOKEN_EN_…` / `FAKETOKEN_UK_…` strings of the same
   character class and length.

Everything else is the portal's own bytes. The hit page carries **no holder
PII** (the PII lives in the linked result PDFs, which are not committed).

**One-time raw-capture guard (B2 gate), executed 2026-08-24: PASS (2/2).**
`tests/ua-marad-raw-capture-guard.test.mjs` ran the fixed adapter guards
(`uaMaradPdfHrefs`, `parseUAMARAD`/MISS_RE) against the RAW pre-scrub capture
bytes: hit page → `match-valid` with both bilingual
`/services/documents/pdf/hash/{token}` anchors accepted and the
"Запит на верифікацію" distractor rejected; miss page → `no-match` (2023+
date). This proves the scrub did not alter the anchors the guards depend on.
The test skips without `UA_MARAD_RAW_DIR` (the raw captures are never
committed).

`ua-marad-valid-legacy.html` is the pre-capture synthetic hit page (`.pdf`
suffixed result links) — kept to pin back-compat of the legacy href guard.

`ua-marad-miss-en.html` is the 2026-08-13 EN-session miss capture (the miss
marker is hardcoded Ukrainian even there). `ua-marad-form.html` is the served
quick-search form.

## B3 keyword/token pre-freeze gate — executed 2026-08-24: PASS

The new worker ran on the incident PDF (itemId 75539fa4-…, 4-page scanned
UA CoC + endorsement, admin semantics `--max-pages=4`, no budget): 4/4 pages
OCRed in ~20s, `ocrTextAll` 4,992 chars. Then
`planBareCodeCandidates(real ocrTextAll)` against the frozen table entries:

1. **Keywords** — `keywordCountries` → exactly `["UA-MARAD"]` (single-country
   keyword-lock engaged). Both frozen keywords hit in the real OCR:
   `GOVERNMENT OF UKRAINE` (from "The Government of Ukraine certifies…") and
   `SHIPPING ADMINISTRATION` (from "Authorized official of the Shipping
   Administration"). The dossier candidates were rejected at this gate:
   "ADMINISTRATION OF UKRAINE" is not printed as a contiguous string on the
   real document, and "MARAD.GOV.UA" OCR-mangles ("MARAD GOV.VAL").
2. **Code token** — OCR rendered the printed number as `NE 12345/2024`
   (`№` → separate "NE" token; the slash survived). TOKEN_RE extracted
   `12345/2024`; `genericNormalize` → `123452024` → matched `ocrCodePattern`
   `/^\d{5,8}20\d{2}$/`. **No tokenization fix was needed** — the №-glue
   failure mode the gate was designed to catch did not materialize at the
   worker's PDF raster resolution (short-edge 1600 / ≤4MP; at the earlier
   long-edge-1600 raster the token mangled to "I2345I2024" and keywords were
   unreadable — that raster interpretation was corrected instead).
3. **Issue date** — `25.10.2024` survived OCR; year-anchored (token suffix
   "2024") calendar-validated extraction → `issuedOn: "2024-10-25"` on both
   fan-out candidates. The endorsement expiry `20.10.2029` also survived and
   was correctly excluded by the year anchor.

Planner output: exactly two UA-MARAD candidates, code `123452024`,
doctype `71` then `70`, both with `issuedOn: "2024-10-25"` — GATE PASS
(all three criteria).

## v2-A result-PDF fixtures (2026-08-24)

## OCR-degraded CoP fixture (2026-09-07) — the hint tier

`ocr-cop-degraded-2026-09-07.txt` is the **masked** `extraction.ocrTextAll` of
the incident sidecar `a533f540-…` (anonymous /verify upload of a Ukrainian
STCW Certificate of Proficiency as a PNG screenshot, eng-tesseract, 2026-09-07).
The live settle was `countryDetected: null`, candidates UK + NO from the two
reads of the number (both `needs-inputs` dob — in masked form `012342026` +
`0123472026`), zero registry calls — the generic fallback for a document that
names Ukraine twice.

### Gate output (Decision 11 preservation) — which strong strings survived

| Frozen strong keyword | Survived? | What OCR printed (verbatim in the fixture) |
|---|---|---|
| `GOVERNMENT OF UKRAINE` | **no** | `The Govemment of Ukraine certifies` (rn→m); 2nd read `he commer ican cots a` |
| `SHIPPING ADMINISTRATION` | **no** | `uthored offical he Shiping Advinistation`; 2nd read `hott fifth Soni eset` |
| "MARITIME ADMINISTRATION" | never printed | the CoP page carries no such line |
| "STATE SERVICE" | never printed | idem |

What did survive, on both upright reads: the bare state name `UKRAINE` (own
line, twice), `CERTIFICATE OF PROFICIENCY`, and the number — first read as the
printed slash form `Ne 01234/2026` (raw token `01234/2026`), second read
slash-less `Ne 0123472026`. The issue/expiry date lines are garbled
(`Daeottiti ozs s om 3`, `Dasolisswe:090t2028`) — no day-first date matches
`DAY_FIRST_DATE_RE`, so no `issuedOn` extraction is possible.

**Why a hint tier:** the strong keywords are substring-exact by design (stem
keywords elsewhere rely on it) and a fuzzy matcher is out of scope (roadmap).
The bare state name is the only stable signal on this document class, but it
is also printed as holder *nationality* on foreign certificates — hence a WEAK
tier (`hintKeywords`, word-bounded: `UKRAINIAN` never hits) that ranks and
activates `ocrCodePattern` only with the RAW slash form
(`ocrCodeRawPattern: /^\d{5,8}\/20\d{2}$/`), never locks, and is silenced by
any strong hit.

**Raw-token guard (v3 T3), executed 2026-09-07 before any code: PASS.**
`normalizeForKeywords(fixture)` + `TOKEN_RE` → 123 tokens; exactly one matches
`/^\d{5,8}\/20\d{2}$/` verbatim: `01234/2026`. The second read `0123472026`
is a slash-less digit run (left to the UK/NO shape lane by design).

**Planner output on the fixture** (pre-change: `[UK 012342026, NO
0123472026]`, `keywordCountries` `[]`; post-change, pinned in
`verify-upload-units.test.mjs`):
`keywordEvidence` → `{strong: [], hint: ["UA-MARAD"]}`;
`planBareCodeCandidates` → `[UA-MARAD 012342026, UK 012342026, NO 0123472026]`
— UA-MARAD first, exactly one UA row, no `extraInputs` (dates garbled → the
honest `needs-inputs` prompt for issue date + document type), UK/NO shape rows
kept (owner directive: fan-out stays wide), 0 DK rows, total ≤ 3. Settle-level
`countryDetected` → `UA-MARAD` (the hint produced a candidate), sidecar
`notes` gets `country-hint-only`.

**No specimen regeneration needed:** `scripts/generate-country-specimens.mjs`
injects only `keywords.slice(0, 2)` (`buildSpecimenText` line 125/131,
`buildSpecimenHtml` line 139) plus `countryName` (128) and `authority` (130) —
never `hintKeywords`. Both UA entries' `countryName` contains "UKRAINE", so the
specimens test sees the strong keyword AND the hint; strong silences the hint
(unchanged outcome).

### Masking rules applied (nothing else re-typed; OCR errors verbatim)

1. **Upright reads only.** The two upright OCR passes of the page are kept in
   document order. Everything after them was dropped: the pure-noise tail and
   the 180°-rotated garbage segment (identified by reversed/inverted glyph
   runs of the number, the holder name and the STCW boilerplate). Three
   trailing noise lines of the second read were cut with it.
2. Real 5-digit certificate number → `01234` in **every** read
   (`…/2026` slash form and the `…72026` slash-less form).
3. Holder name (every fragment/variant, both reads) → `SPECIMEN SEAFARER`.
4. Signatory name on the "…Shiping Advinistation …" line and its garbled
   second-read variant → `SPECIMEN OFFICIAL`.
5. No DOB / birthplace / ID / passport-like token was present on the upright
   reads (the date lines OCRed to non-numeric garble), so no same-shape
   synthetic was needed; rule kept: a synthetic token must never match the
   planner's day-first date regex with year 2026 (would fan out 71/70).
6. Post-build grep for the real digits, the real names (incl. the inverted
   glyph fragments), every 5+-digit run and every capitalised token pair:
   zero hits; the remaining pairs are STCW boilerplate, the two SPECIMEN
   placeholders, and OCR noise (`RITES Hie`, `ERSTE LEE`, `EFS GON`).
   The file is UTF-8 and contains `—`, `©`, `™` from the OCR; the
   integration test uses an ASCII, `;`-free excerpt instead.

## v2-A result-PDF fixtures (2026-08-24)

`result-coc-en.pdf` and `result-endorse-uk.pdf` are **synthesized** by
`scripts/generate-ua-marad-result-fixtures.mjs` (rerunnable, deterministic).
The real hash-link result PDFs captured 2026-08-24 (`result_en.pdf` = CoC hit,
`endorse_1.pdf` = endorsement hit) carry the holder's full name and DOB and
are never committed; the fixtures mirror their exact machine shape — one-page
FlateDecode content stream, every string literal UTF-16BE (the portal's
Unicode-CID composite font: `04 21` = С, `00 32` = "2", `21 16` = №), the
same printed labels ("Document status:"/"VALID"/"expire: Unlimited",
"Статус документу:"/"ДІЙСНИЙ"/"до: 20.10.2029", the
"№12345/2024 from|від 25.10.2024" number line, decoy dates: DOB +
verification timestamp) — with the holder fields replaced by
"SPECIMEN SEAFARER" / 01.01.1990.

**Parser validation against the RAW captures, executed 2026-08-24: PASS.**
`parseUAMARADResultPdf` on the pre-scrub originals:
`result_en.pdf` → `{status:"valid", unlimited:true, validUntil:null,
issuedOn:"2024-10-25"}`; `endorse_1.pdf` → `{status:"valid",
validUntil:"2029-10-20", issuedOn:"2024-10-25"}` — byte-identical results on
the committed fixtures (pinned in registry-adapters.test.mjs K2b).
