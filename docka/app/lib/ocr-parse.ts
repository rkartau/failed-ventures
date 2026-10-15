// Pure, dependency-free parsing of raw OCR text into best-effort fields:
// a document title, a holder name, and an expiry date. Kept separate from the
// OCR engine so it can be unit-reasoned and reused. Everything here is a guess —
// the caller marks the resulting document "read from photo, not government
// verified" (amber), never green.

export type OcrFields = {
  title: string | null;
  name: string | null;
  expiry: string | null; // ISO yyyy-mm-dd when we can pin one down
  certNumber: string | null; // certificate / registration number, best-effort
};

// Month names → number, for "12 June 2028" style dates.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

// Pull every date we can recognise out of a blob of text, as ISO strings.
export function extractDates(text: string): string[] {
  const out: string[] = [];
  const push = (s: string | null) => {
    if (s) out.push(s);
  };

  // yyyy-mm-dd or yyyy.mm.dd or yyyy/mm/dd
  for (const m of text.matchAll(/\b(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/g)) {
    push(iso(+m[1], +m[2], +m[3]));
  }
  // dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy (day-first, the Estonian/EU norm)
  for (const m of text.matchAll(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](20\d{2})\b/g)) {
    push(iso(+m[3], +m[2], +m[1]));
  }
  // dd Mon yyyy / dd Month yyyy
  for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/g)) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mm) push(iso(+m[3], mm, +m[1]));
  }
  return out;
}

// Choose the expiry from all dates found: prefer one that appears near an
// "expiry / valid until" cue, otherwise the latest date (issue dates are older
// than expiry dates on a certificate).
export function pickExpiry(text: string): string | null {
  const all = extractDates(text);
  if (all.length === 0) return null;

  const cue =
    /(valid\s*until|valid\s*till|date\s*of\s*expiry|expiry|expires?|expiration|until|valid\s*to|kehti[bv]\s*kuni)/i;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (cue.test(line)) {
      const d = extractDates(line);
      if (d.length) return d.sort().at(-1) ?? null;
    }
  }
  // Fall back to the latest date on the whole document.
  return all.sort().at(-1) ?? null;
}

// A plausible person name. IMPORTANT: a phone photo of an ornate paper
// certificate OCRs to dense fragmentary noise ("Ne So Er Nre", "Oo Cm"), and a
// blind "first 2–4 capitalised words" scan of that noise surfaces gibberish as a
// holder name — which reads as broken, fake data to the seaman. So we only ever
// return a name when it appears on an EXPLICITLY LABELLED line ("Name: …",
// "Holder: …") AND clears a strict realism check. Anything else returns null and
// the field is honestly left blank. Result: never a made-up name.
export function pickName(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const labelled = lines.find((l) => /\b(name|holder|surname|first\s*name)\b/i.test(l));
  if (labelled) {
    const after = labelled.replace(/.*\b(name|holder|surname)s?\b[:\-\s]*/i, "").trim();
    if (isNameLike(after)) return titleCase(after);
  }
  return null;
}

// Strict enough to reject OCR noise fragments. A real printed holder name is
// 2–4 words, each a proper word (≥3 letters, containing a vowel) — this rejects
// short two-letter shards like "Ne So Er Nre" / "Oo Cm" that OCR emits from
// certificate borders and seals.
function isNameLike(s: string): boolean {
  if (!s || /\d/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(
    (w) =>
      /^[A-ZÄÖÜÕ][A-Za-zÄÖÜÕäöüõ.'-]{2,}$/.test(w) && // starts upper, ≥3 chars
      /[aeiouäöüõAEIOUÄÖÜÕ]/.test(w) // contains a vowel — real words do
  );
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-zäöüõ])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

// Known certificate keywords → a clean, specific title. This is the ONLY source
// of an OCR-derived title: a phone photo of a paper certificate routinely OCRs to
// dense noise ("= 7 Lsua Fr", "Al Rr Rr Rrr Ober»"), and any "first substantial
// line" fallback would surface that noise as the document name. So we title a
// photo ONLY when we recognise real certificate vocabulary in the text; anything
// else returns null and the caller falls back to the filename or a clean generic
// ("Unrecognized certificate — photo attached"). Result: never gibberish.
//
// Both English and Estonian cues are matched (the registry is Estonian), and the
// English word in each title lets the required-type classifier bucket it.
const TITLE_CUES: { re: RegExp; title: string }[] = [
  { re: /advanced\s*fire/i, title: "Advanced Fire Fighting" },
  { re: /fire\s*(fighting|prevention)|tuletõrje/i, title: "Fire Prevention & Fire Fighting" },
  { re: /basic\s*safety\s*training|ohutus/i, title: "Basic Safety Training" },
  { re: /personal\s*survival/i, title: "Personal Survival Techniques" },
  // Medical CARE training (a first-aid-family STCW course, e.g. TalTech's
  // "Training in Medical Care" / "Meditsiiniabi koolitus") — matched BEFORE the
  // medical-fitness-certificate cue so a training course is never mislabelled as
  // the health certificate.
  { re: /medical\s*care|medical\s*first\s*aid|meditsiiniabi|proficiency\s*in\s*medical/i, title: "Medical Care Training" },
  { re: /(medical\s*)?first\s*aid|esmaabi/i, title: "Elementary First Aid" },
  { re: /proficiency\s*in\s*survival\s*craft|survival\s*craft|rescue\s*boat|päästepaat/i, title: "Proficiency in Survival Craft" },
  // ECDIS (electronic chart display) — a common bridge course; the Estonian certs
  // read "Elektronkaartide kuvamis- ja infosüsteem (ECDIS)".
  { re: /\becdis\b|electronic\s*chart\s*display|elektronkaart/i, title: "ECDIS" },
  { re: /\bradar\b|\barpa\b|radarnavigatsioon/i, title: "Radar / ARPA" },
  { re: /bridge\s*resource\s*management|\bBRM\b|engine\s*room\s*resource|\bERM\b/i, title: "Resource Management" },
  { re: /crowd\s*management|crisis\s*management/i, title: "Crowd & Crisis Management" },
  { re: /(ship\s*)?security\s*awareness/i, title: "Ship Security Awareness" },
  { re: /security\s*officer|\bSSO\b|designated\s*security/i, title: "Ship Security Officer" },
  { re: /dangerous\s*goods|\bIMDG\b/i, title: "Dangerous Goods (IMDG)" },
  { re: /(oil|chemical|gas|liquefied)\s*tanker|tanker\s*(familiar|training|cargo)/i, title: "Tanker Familiarization" },
  { re: /gmdss|radio\s*operator/i, title: "GMDSS Radio Operator" },
  // Safety-familiarisation / generic "Safety Training" certs (e.g. Reval's
  // bilingual "Safety Training / Ohutuskoolitus") that carry none of the more
  // specific course words above but are plainly a safety-training certificate.
  { re: /safety\s*(training|familiar)|ohutuskoolitus|ohutusalane/i, title: "Safety Training" },
  { re: /medical\s*(certificate|fitness|examination)|tervise(tõend|kontroll)|fit\s*for\s*sea/i, title: "Medical certificate" },
  { re: /certificate\s*of\s*competency|competency|pädevus/i, title: "Certificate of Competency" },
  { re: /flag\s*state\s*endorsement|endorsement|kinnitusleht/i, title: "Endorsement" },
  { re: /seaman'?s?\s*book|meremehe.*raamat|discharge\s*book/i, title: "Seaman book" },
  { re: /passport|reisidokument/i, title: "Passport" },
];

// The unmistakable fingerprint of a maritime STCW certificate: the standard
// convention boilerplate ("...Standards of Training, Certification and
// Watchkeeping for Seafarers...") or the "Certificate of Proficiency / Koolituse
// tunnistus" header. Present on essentially every real seafarer certificate
// (English or Estonian), absent from random / non-certificate photos.
const STCW_SIGNATURE =
  /certificate\s*of\s*proficiency|koolituse\s*tunnistus|standards\s*of\s*training|watchkeeping\s*for\s*seafarers|meremeeste\s*v[aä]lja[õo0]ppe|proficiency\s*is\s*issued/i;

// Derive a clean title from OCR text: a recognised certificate type, or null.
// Never returns a raw OCR line — see the note on TITLE_CUES above.
export function pickTitle(text: string): string | null {
  for (const c of TITLE_CUES) {
    if (c.re.test(text)) return c.title;
  }
  // Honest last resort: no specific course matched, but the text is plainly an
  // STCW certificate. Give it a real, accurate-if-generic name ("Certificate of
  // Proficiency") instead of silently dropping to a numbered "Certificate photo
  // N" that saddles the seaman with a hand-naming chore for every such photo —
  // the round-12 complaint that title reads were inconsistent across photos of
  // the same quality. It does NOT fill a required-document slot (classifier
  // returns null for this title), so completeness stays honest.
  if (STCW_SIGNATURE.test(text)) return "Certificate of Proficiency";
  return null;
}

// Best-effort certificate / registration NUMBER off the photo. This is the value
// the fleet-wide duplicate check compares, so the same forged number on two crew
// can be flagged. Kept strict — only an EXPLICITLY LABELLED number line ("Cert.
// No: …", "Registration number …", Estonian "nr …") whose token carries at least
// one digit and is 5–24 chars — so ordinary OCR noise never becomes a fake number.
const CERTNO_CUE =
  /\b(cert(?:ificate)?\.?\s*(?:no|number|nr|num)|reg(?:istration)?\.?\s*(?:no|number|nr)|document\s*(?:no|number)|no\.?|number|nr\.?|seeria|registri\s*nr)\b[.:#\-\s]*/i;

export function pickCertNumber(text: string): string | null {
  const lines = (text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(CERTNO_CUE);
    if (!m) continue;
    const after = line.slice((m.index ?? 0) + m[0].length).trim();
    // First whitespace-delimited token after the cue.
    const tok = after.split(/\s+/)[0]?.replace(/[.,;]+$/, "") ?? "";
    const compact = tok.replace(/[^A-Za-z0-9/\-]/g, "");
    const alnum = compact.replace(/[^A-Za-z0-9]/g, "");
    if (alnum.length >= 5 && alnum.length <= 24 && /\d/.test(alnum)) {
      return compact.toUpperCase();
    }
  }
  return null;
}

export function parseOcr(text: string): OcrFields {
  const clean = (text ?? "").replace(/ /g, " ");
  return {
    title: pickTitle(clean),
    name: pickName(clean),
    expiry: pickExpiry(clean),
    certNumber: pickCertNumber(clean),
  };
}
