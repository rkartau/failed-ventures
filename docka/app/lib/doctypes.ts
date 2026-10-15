// Required document types a seafarer must have on file — client-safe (no Node
// built-ins) so both the browser review UI and the server can share them.
//
// Completeness ("3/5 — missing Medical") is computed by classifying each stored
// document into one of these buckets, best-effort, from its title / type /
// government category.

// The UNIVERSAL FLOOR: the five slots every seafarer is measured against,
// regardless of rank, vessel type or flag. This is the historical fixed set — the
// base "3/5" board indicator, the PSC dossier matrix, the CSV export and the
// no-config compliance default all key off THIS constant, so growing the full
// vocabulary below never silently re-scopes those base checks.
export const BASE_REQUIRED_DOC_TYPES = [
  "Basic Safety Training",
  "Medical",
  "Endorsement",
  "Seaman book",
  "Passport",
] as const;

// The FULL required-document vocabulary = the universal floor PLUS the vessel-type
// / trade add-on competency slots. Add-on slots are NEVER required of everyone;
// they only enter a seafarer's required set when a vessel-type add-on pack pulls
// them in (see lib/required-docs.ts `perVesselTypeRequired`). Appended AFTER the
// floor so the base ordering is preserved and add-ons sort last.
export const REQUIRED_DOC_TYPES = [
  ...BASE_REQUIRED_DOC_TYPES,
  "Advanced Fire Fighting",
  "Tanker Familiarisation",
  // #41 — MLC/SEA employment doc-set slots. Appended AFTER the add-ons so the base
  // ordering is untouched. Seeded into NO baseline layer (see lib/required-docs.ts)
  // so they add ZERO hard-block on deploy; an agency opts them in via config (Phase C).
  "SEA",
  "Wage Account",
  "Allotment",
  "Contract Addendum",
] as const;

export type RequiredDocType = (typeof REQUIRED_DOC_TYPES)[number];

// #41 — the employment doc-set subset (the four slots #41 surfaces + measures as an
// assignment-scoped set). Kept as its own const so #41's employmentCompleteness never
// re-derives it and the CV/board never accidentally fold it into the universal floor.
export const EMPLOYMENT_DOC_TYPES = [
  "SEA",
  "Wage Account",
  "Allotment",
  "Contract Addendum",
] as const satisfies readonly RequiredDocType[];

// Keyword table used to bucket a document into a required type. First match wins,
// evaluated in array order, so put the most specific patterns first.
const CLASSIFIERS: { type: RequiredDocType; patterns: RegExp[] }[] = [
  // #41 item 14 — employment doc-set classifiers. TIGHT by design (a false "have" is
  // worse than a "missing"): a random "agreement.pdf" must NOT match a SEA. Ordered
  // BEFORE the generic STCW/Endorsement/identity rows. `\bSEA\b` is case-SENSITIVE (no
  // /i) so the acronym matches but "Sea service" does not.
  {
    type: "SEA",
    patterns: [/seafarer'?s?\s*employment\s*agreement/i, /\bSEA\b(?!\w)/, /\bMLC\s*A?2\.1\b/i],
  },
  {
    type: "Wage Account",
    patterns: [/wage\s*account/i, /allotment\s*account/i, /salary\s*(bank\s*)?account/i],
  },
  {
    type: "Allotment",
    patterns: [/allotment\s*(form|note|authori[sz]ation)/i],
  },
  {
    type: "Contract Addendum",
    patterns: [/contract\s*addendum/i, /SEA\s*addendum/i, /employment\s*rider/i],
  },
  {
    type: "Medical",
    patterns: [/medical/i, /health/i, /fit\s*for\s*(sea|duty)/i, /tervis/i],
  },
  {
    // Advanced Fire Fighting (STCW A-VI/3) — a distinct, higher certificate than
    // the fire-fighting element of Basic Safety Training, so it is matched FIRST
    // (before the generic /fire\s*fighting/ pattern in Basic Safety Training).
    type: "Advanced Fire Fighting",
    patterns: [/advanced\s*fire/i, /\bAFF\b/i, /A[-\s]?VI\/3/i],
  },
  {
    // Tanker familiarisation / cargo-operations certificates (oil, chemical or
    // liquefied-gas). Matched before Basic Safety Training so a tanker course is
    // not swallowed by the generic STCW bucket.
    type: "Tanker Familiarisation",
    patterns: [
      /tanker/i,
      /oil\s*(and|&)?\s*chemical/i,
      /liquefied\s*gas/i,
      /\bIGF\b/i,
    ],
  },
  {
    type: "Basic Safety Training",
    patterns: [
      /basic\s*safety/i,
      /\bBST\b/i,
      /safety\s*training/i,
      /personal\s*survival/i,
      /fire\s*fighting/i,
      /first\s*aid/i,
      /\bSTCW\b/i,
    ],
  },
  {
    type: "Endorsement",
    patterns: [/endorsement/i, /flag\s*state/i, /recognition/i],
  },
  {
    type: "Seaman book",
    patterns: [/seaman'?s?\s*book/i, /seafarer'?s?\s*(identity|book)/i, /discharge\s*book/i, /\bSID\b/i],
  },
  {
    type: "Passport",
    patterns: [/passport/i, /travel\s*document/i, /\bpass\b/i],
  },
];

// docCategory (from the government registry) maps cleanly for a couple of kinds.
function fromCategory(docCategory: string | null | undefined): RequiredDocType | null {
  switch (docCategory) {
    case "medical":
      return "Medical";
    case "endorsement":
      return "Endorsement";
    // competency / qualification are training/skill certificates — most often
    // the Basic Safety Training bucket in this simplified model.
    case "competency":
    case "qualification":
      return "Basic Safety Training";
    default:
      return null;
  }
}

// Best-effort: classify a document into one of the required types, or null if we
// genuinely can't tell (it still counts as an uploaded document, just not one
// that fills a required slot).
export function classifyRequiredType(input: {
  title?: string | null;
  docType?: string | null;
  docCategory?: string | null;
}): RequiredDocType | null {
  const byCat = fromCategory(input.docCategory);
  if (byCat) return byCat;

  const hay = `${input.title ?? ""} ${input.docType ?? ""}`;
  for (const c of CLASSIFIERS) {
    if (c.patterns.some((re) => re.test(hay))) return c.type;
  }
  return null;
}

export type Completeness = {
  have: RequiredDocType[];
  missing: RequiredDocType[];
  count: number; // how many required types are covered
  total: number; // REQUIRED_DOC_TYPES.length
};

// Given the required-type tags of a seafarer's documents, work out what's
// covered and what's missing (against the fixed universal 5). The config-driven,
// per-rank required set is computed in lib/required-docs.ts, which reuses
// `missingFrom` below so the "which slot is missing" logic is never duplicated.
export function completeness(tags: (RequiredDocType | null | undefined)[]): Completeness {
  const missing = missingFrom(tags, BASE_REQUIRED_DOC_TYPES);
  const missingSet = new Set(missing);
  const have = BASE_REQUIRED_DOC_TYPES.filter((t) => !missingSet.has(t));
  return { have, missing, count: have.length, total: BASE_REQUIRED_DOC_TYPES.length };
}

// Which of `required` is NOT covered by the present tags. Single source of the
// "missing slot" computation, shared by completeness() (fixed 5) and the
// config-driven required-docs engine. Output preserves `required`'s order.
export function missingFrom(
  tags: (RequiredDocType | null | undefined)[],
  required: readonly RequiredDocType[]
): RequiredDocType[] {
  const present = new Set<RequiredDocType>();
  for (const t of tags) if (t) present.add(t);
  return required.filter((t) => !present.has(t));
}
