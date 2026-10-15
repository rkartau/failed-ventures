# Azerbaijan (DDLA) registry fixtures

Source: live capture of `POST https://publicservices.ddla.gov.az/seamencheck/check`
on **2026-08-24** (operator-verified genuine document lookup). Portal wire
contract from the page's `check.js?v=da52505b8115` (unversioned Laravel app —
the contract-drift pin in tests/registry-adapters.test.mjs guards the exact
field names below).

ALL VALUES HERE ARE FULLY SYNTHETIC — re-synthesized from scratch, not
scrubbed-in-place. The real holder's name, DOB, photo and certificate number
NEVER entered the repo. Field-name fidelity (structure, casing) is exact to
the live capture; that is what the tests guard.

Wire contract (type "competency"):

- Request: `{"type":"competency","code":"NNNNNN/YY","birth":"YYYY-MM-DD"}`
  (Content-Type: application/json; no CAPTCHA/session/CSRF — bare POST works).
- Hit: HTTP 200 `{"status":"success","person":{ADI,SOYADI,DOG_IL,image_url},`
  `"data":[{kod,certkod,DV,DO,D_BADI,VZF_BADI,status}]}` — status computed
  server-side as "Valid"/"Expired".
- Miss: `status != "success"` + `message` (per check.js).

Glossary: ADI=first name, SOYADI=surname, DOG_IL=DOB, kod=holder ID,
certkod=cert number (keeps the "/YY" suffix), DV=issued, DO=valid-until,
D_BADI=certificate name, VZF_BADI=position.

PII rules: `person.image_url` (holder photo) is NEVER read/logged/persisted by
the adapter — the fixture stub is a same-shaped ~20-char base64 placeholder;
registry `kod` is NOT mapped into VerifiedCert.

Files:
- `az-valid.json`   — hit, row status "Valid" (synthetic 123456/24).
- `az-expired.json` — hit, row status "Expired", past DO (synthetic 123457/24).
- `az-miss.json`    — miss shape per check.js.

## B2 pre-freeze gate output (real-OCR keyword/token/DOB gate)

Run 2026-08-24 against the operator's genuine sample (local only — PII, never
committed): single-page PDF, one 2764x3971 JPEG carrying BOTH cert sides,
no text layer, sideways. Worker invoked with the anon lane's flags
(`--ocr-budget-ms=28000 --max-pages=4`), orientation fallback active.

Worker result: `pages=1 pagesOcred=1 orientFallbackPages=1 textLayerChars=0
skipReason=null`, stderr `orientation fallback: probes=3 winner=270`,
elapsed ~34s (28s budget check + in-flight re-OCR tail — inside the ~36s
worst bound; the 45s settle holds).

1. KEYWORDS — PASS. Both frozen keywords survive the real OCR verbatim:
   "STATE MARITIME AND PORT AGENCY" and "REPUBLIC OF AZERBAIJAN"
   (keywordCountries -> ["AZ"], single-country keyword lock).
2. CODE TOKEN — PASS. The raw token surviving OCR reads exactly "000730/24"
   (twice — both prints), slash intact; planBareCodeCandidates yields exactly
   one AZ candidate, code "00073024" (normalized). No Ne/No/# prefix gluing,
   no slash mangling AT THE SHIPPED RASTER (1600 short-edge). NOTE pinning
   the raster constants: at 2400 short-edge the SAME token degrades to
   "000730124" (slash reads as "1") — higher resolution demonstrably HURTS
   this doc class; PDF_RASTER_MAX_DIM stays 1600.
3. DOB — FAIL (honestly unsatisfiable on this sample; plan's needs-inputs
   path takes over). The printed 18.05.1992 misreads at EVERY tested
   resolution and orientation: winner-270 @1600 -> "18:05.3992" (leading "1"
   of the year reads as "3"); @2400 -> "18053992"; full-res 11MP -> garbage
   ("EA LISS 9"); 90-rotation reads -> nothing date-shaped. Recovering
   "3992" -> 1992 would be digit-substitution GUESSING, which Decision 2
   explicitly rejects (a wrong guessed DOB is a false registry miss). The
   licensed tokenization fix applied: ":" joined the AZ date-separator class
   (the observed "18:05" form), pinned by unit test. Pipeline consequence
   for this document: AZ candidate without extraInputs -> needs-inputs ->
   completed with countryDetected "AZ" -> guided fallback with Azerbaijan
   preselected + DOB prompt (the plan's designed honest degraded path,
   Hazard 2 / Confirmation 3). One user-entered field away from the full
   registry confirmation.
4. ORIENTATION FALLBACK — PASS. orientFallbackPages=1 (probes=3,
   winner=270); without the fallback the upright read is noise.

Keywords FROZEN as proposed — no gate adjustments needed beyond the ":"
separator tolerance.
