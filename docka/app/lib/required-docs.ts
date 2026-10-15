// Required-document catalog + pure rule engine — client-safe (NO Node built-ins),
// so the browser board/review UI AND the server share ONE engine, exactly like
// lib/doctypes.ts and lib/pipeline.ts. This module is the single source of truth
// for "which documents does THIS seafarer need", and it EXTENDS the completeness
// logic in lib/doctypes.ts (it computes a required SET; doctypes.ts still owns the
// document->slot classification). The sea-readiness gate in lib/compliance.ts
// consumes the required set produced here — it is not forked.
//
// Design (owner decisions D4 + plan v2 #6 / v-final):
//   - VERSIONED + EFFECTIVE-DATED baseline: a document's required-ness is decided
//     against the baseline in force at a given instant, so re-dating the rules
//     never silently rewrites history. baselineAt(at) picks the version.
//   - LAYERED ADDITIVE BASELINE: required = universalRequired (everyone) +
//     perRankRequired[rank] + perVesselTypeRequired[vesselType] + perFlagRequired
//     [flag] (all additive / union — a layer only ever ADDS a requirement). The
//     vessel-type + flag dimensions (T1.8) let a chemical-tanker berth require the
//     tanker/advanced-fire certs a general-cargo berth does not, so a rank-only
//     green badge no longer lies per-berth. An unknown vessel type / flag adds
//     nothing (the rank floor applies); only an unknown RANK is a zero-state block.
//   - SINGLE RANK SOURCE OF TRUTH = the seafarer profile rank (normalizeRank maps
//     the free-text rank to a canonical RankKey).
//   - ZERO-STATE: a null rank, or a rank not in the versioned catalog, is a DEFINED
//     incomplete state (rankKnown=false, blockAssignment=true) — the required set
//     falls back to the universal floor and NEVER collapses to an empty set that
//     would pass as "compliant".
//   - Per-agent config: each agent may edit their own required set; it defaults to
//     the researched baseline. Pure functions here operate on a passed-in config;
//     the server store (lib/required-docs-store.ts) persists it + writes audit rows.

import {
  REQUIRED_DOC_TYPES,
  EMPLOYMENT_DOC_TYPES,
  missingFrom,
  type RequiredDocType,
} from "@/lib/doctypes";
import type { Doc, Seafarer } from "@/lib/db";

// ---- Canonical ranks ---------------------------------------------------

// The rank vocabulary the baseline is keyed by. The free-text `seafarer.rank`
// is normalised into one of these (or null = unknown => zero-state).
export const RANK_KEYS = [
  "master",
  "chief_officer",
  "deck_officer",
  "chief_engineer",
  "engineer_officer",
  "rating",
  "cadet",
] as const;

export type RankKey = (typeof RANK_KEYS)[number];

export const RANK_LABELS: Record<RankKey, string> = {
  master: "Master / Captain",
  chief_officer: "Chief Officer / Chief Mate",
  deck_officer: "Deck Officer (OOW / 2nd / 3rd Mate)",
  chief_engineer: "Chief Engineer",
  engineer_officer: "Engineer Officer / ETO",
  rating: "Rating (AB / OS / support)",
  cadet: "Cadet / Trainee",
};

// Ordered keyword table — FIRST match wins, most specific first, so "chief
// engineer" is not swallowed by the generic "engineer" rating patterns and
// "chief officer" is not swallowed by "officer".
// Estonian / abbreviation aliases are ADDITIVE here (docka is multi-language). They
// only ever pick a MORE ACCURATE required set when a rank is recognisable — an
// unrecognised rank is no longer a flag or a block (it just falls back to the
// universal floor), so an over-match is the only real risk. Every alias is a
// full-word (\b … \b) literal, and the senior compound is listed on the senior key
// which is checked FIRST (first-match-wins) so e.g. "vanemtüürimees" (chief officer)
// can never be swallowed by the deck "tüürimees". Non-ASCII letters (ü/ä/õ/ö) are
// matched literally; \b sits on the ASCII boundary letters at each end of the word.
const RANK_PATTERNS: { key: RankKey; patterns: RegExp[] }[] = [
  { key: "master", patterns: [/\bmaster\b/i, /\bcaptain\b/i, /\bmaster\s*mariner\b/i, /\bkapten\b/i] },
  { key: "chief_engineer", patterns: [/\bchief\s*engineer\b/i, /\bc\/?e\b/i, /\b2nd\s*engineer\b/i, /\bsecond\s*engineer\b/i, /\bthird\s*engineer\b/i, /\bvanemmehaanik\b/i] },
  { key: "chief_officer", patterns: [/\bchief\s*officer\b/i, /\bchief\s*mate\b/i, /\bc\/?o\b/i, /\bfirst\s*mate\b/i, /\bvanemtüürimees\b/i, /\bvanemtüürmees\b/i] },
  { key: "engineer_officer", patterns: [/\bengineer\b/i, /\beto\b/i, /electro[-\s]?technical/i, /\bmotorman\b/i, /\bmehaanik\b/i, /\bvahimehaanik\b/i, /\bmotorist\b/i] },
  { key: "deck_officer", patterns: [/\bofficer\b/i, /\bmate\b/i, /\boow\b/i, /watch\s*keeping/i, /\bnavigat/i, /\b2nd\s*mate\b/i, /\b3rd\s*mate\b/i, /\bsecond\s*mate\b/i, /\bthird\s*mate\b/i, /\btüürimees\b/i, /\btüürmees\b/i, /\bvahitüürimees\b/i, /\bvahttüürimees\b/i] },
  { key: "cadet", patterns: [/\bcadet\b/i, /\btrainee\b/i, /\bapprentice\b/i, /\bkadett\b/i, /\bpraktikant\b/i] },
  { key: "rating", patterns: [/\brating\b/i, /\bable\s*seaman\b/i, /\bab\b/i, /\bo\.?s\.?\b/i, /ordinary\s*seaman/i, /\bbosun\b/i, /\bboatswain\b/i, /\boiler\b/i, /\bwiper\b/i, /\bcook\b/i, /\bsteward\b/i, /\bfitter\b/i, /\bdeck\s*hand\b/i, /\bseaman\b/i, /\bmadrus\b/i, /\bpootsman\b/i, /\blaevakokk\b/i, /\bkokk\b/i] },
];

/**
 * Map the free-text profile rank to a canonical RankKey, or null when we cannot
 * confidently place it (null / blank / unrecognised) — the ZERO-STATE that the
 * engine treats as a defined incomplete, never as "no requirements".
 */
export function normalizeRank(raw: string | null | undefined): RankKey | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  for (const r of RANK_PATTERNS) {
    if (r.patterns.some((re) => re.test(s))) return r.key;
  }
  return null;
}

// ---- Vessel-type + flag-state dimensions (T1.8) ------------------------

// The required set no longer varies by RANK alone: a berth on a chemical tanker
// legitimately needs certificates a general-cargo berth does not (tanker
// familiarisation, advanced fire fighting), so a rank-only green badge lies
// per-vessel. These two dimensions add ADDITIVE requirement packs on top of the
// universal + per-rank floor — they never remove a requirement.
//
// A seafarer with an UNKNOWN / unset vessel type or flag simply gets NO add-on
// (the base rank set applies) — unlike an unknown RANK, it is NOT a zero-state
// block: a man not yet matched to a vessel is still measured against the floor.

export const VESSEL_TYPE_KEYS = [
  "general_cargo",
  "container",
  "bulk_carrier",
  "oil_tanker",
  "chemical_tanker",
  "gas_carrier",
  "passenger",
  "offshore",
  "other",
] as const;

export type VesselTypeKey = (typeof VESSEL_TYPE_KEYS)[number];

export const VESSEL_TYPE_LABELS: Record<VesselTypeKey, string> = {
  general_cargo: "General cargo",
  container: "Container",
  bulk_carrier: "Bulk carrier",
  oil_tanker: "Oil tanker",
  chemical_tanker: "Chemical tanker",
  gas_carrier: "Gas carrier (LNG / LPG)",
  passenger: "Passenger / Ro-Ro passenger",
  offshore: "Offshore / OSV",
  other: "Other / not set",
};

// Flag-state / registry the vessel flies. Kept a COARSE, representative set (the
// full per-flag Certificate-of-Endorsement recognition rule packs — White List,
// CoE validity — are a separate roadmap item, T3.2). This dimension exists so an
// agency can attach its own flag-specific add-ons today; the baseline seeds none.
export const FLAG_KEYS = [
  "estonia",
  "eu_other",
  "panama",
  "liberia",
  "marshall_islands",
  "other",
] as const;

export type FlagKey = (typeof FLAG_KEYS)[number];

export const FLAG_LABELS: Record<FlagKey, string> = {
  estonia: "Estonia (EE)",
  eu_other: "Other EU / EEA",
  panama: "Panama (PA)",
  liberia: "Liberia (LR)",
  marshall_islands: "Marshall Islands (MH)",
  other: "Other / not set",
};

const VESSEL_TYPE_PATTERNS: { key: VesselTypeKey; patterns: RegExp[] }[] = [
  { key: "chemical_tanker", patterns: [/chemical\s*tank/i, /\bchem\s*tank/i] },
  { key: "gas_carrier", patterns: [/gas\s*(carrier|tank)/i, /\bLNG\b/i, /\bLPG\b/i, /liquefied\s*gas/i] },
  { key: "oil_tanker", patterns: [/oil\s*tank/i, /crude/i, /product\s*tank/i, /\btanker\b/i] },
  { key: "container", patterns: [/container/i, /\bfeeder\b/i, /\bboxship\b/i] },
  { key: "bulk_carrier", patterns: [/bulk/i, /\bbulker\b/i, /\bcape\s*size/i, /\bpanamax\b/i] },
  { key: "passenger", patterns: [/passenger/i, /\bcruise\b/i, /ro[-\s]?ro/i, /\bferry\b/i, /\bropax\b/i] },
  { key: "offshore", patterns: [/offshore/i, /\bOSV\b/i, /\bPSV\b/i, /\bAHTS\b/i, /supply\s*vessel/i, /\brig\b/i] },
  { key: "general_cargo", patterns: [/general\s*cargo/i, /\bgeneral\b/i, /multi[-\s]?purpose/i, /\bMPP\b/i, /\bcargo\b/i] },
];

const FLAG_PATTERNS: { key: FlagKey; patterns: RegExp[] }[] = [
  { key: "estonia", patterns: [/\bestonia?n?\b/i, /\bEE\b/, /\beesti\b/i] },
  { key: "panama", patterns: [/\bpanama\b/i, /\bPA\b/] },
  { key: "liberia", patterns: [/\bliberia?n?\b/i, /\bLR\b/] },
  { key: "marshall_islands", patterns: [/\bmarshall\b/i, /\bMH\b/] },
  { key: "eu_other", patterns: [/\bEU\b/, /\bEEA\b/i, /malta/i, /cyprus/i, /\bgreece\b/i, /\bdenmark\b/i, /\bnetherland/i, /\bgermany\b/i, /\blatvia\b/i, /\blithuania\b/i, /\bfinland\b/i, /\bsweden\b/i] },
];

/** Map a free-text vessel type to a canonical key, or null when unknown/unset. */
export function normalizeVesselType(raw: string | null | undefined): VesselTypeKey | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // A stored canonical key round-trips directly.
  if ((VESSEL_TYPE_KEYS as readonly string[]).includes(s)) return s as VesselTypeKey;
  for (const v of VESSEL_TYPE_PATTERNS) {
    if (v.patterns.some((re) => re.test(s))) return v.key;
  }
  return null;
}

/** Map a free-text flag / registry to a canonical key, or null when unknown/unset. */
export function normalizeFlag(raw: string | null | undefined): FlagKey | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if ((FLAG_KEYS as readonly string[]).includes(s)) return s as FlagKey;
  for (const f of FLAG_PATTERNS) {
    if (f.patterns.some((re) => re.test(s))) return f.key;
  }
  return null;
}

// ---- Versioned, effective-dated baseline -------------------------------

export type CatalogEntry = {
  /** The required-slot this catalog entry corresponds to (doctypes.ts vocabulary). */
  slug: RequiredDocType;
  /** Human name shown in the settings UI. */
  name: string;
  /** Grouping for the settings UI. */
  category: "identity" | "safety" | "medical" | "competency" | "employment";
  /**
   * Typical validity in years (safety ~5y, medical ~1y). Informational — the
   * expiring/expired logic already lives in lib/cert.ts; this documents the norm.
   */
  validityYears: number | null;
};

export type RequiredDocsBaseline = {
  version: string;
  /** ISO date this baseline takes effect. Sorted ascending in BASELINES. */
  effectiveFrom: string;
  /** The master document-type catalog for this version. */
  catalog: CatalogEntry[];
  /** Required of EVERY seafarer regardless of rank. */
  universalRequired: RequiredDocType[];
  /** Additive per-rank requirements (union with universal). */
  perRankRequired: Record<RankKey, RequiredDocType[]>;
  /** Additive per-vessel-type requirements (union on top of universal + rank). */
  perVesselTypeRequired: Record<VesselTypeKey, RequiredDocType[]>;
  /** Additive per-flag-state requirements (union on top of the layers above). */
  perFlagRequired: Record<FlagKey, RequiredDocType[]>;
};

// The researched STCW/MLC baseline. Universal floor = travel + identity + medical
// fitness + basic safety training (every seafarer, MLC 2006 + STCW A-VI/1). A
// flag-state ENDORSEMENT of a Certificate of Competency applies to CERTIFICATED
// ranks (deck/engineer officers + master), NOT to ratings/cadets — so officers
// need all five slots, ratings/cadets need the four universal ones.
const BASELINE_V1: RequiredDocsBaseline = {
  version: "2024.1",
  effectiveFrom: "2024-01-01T00:00:00.000Z",
  catalog: [
    { slug: "Passport", name: "Passport / travel document", category: "identity", validityYears: 10 },
    { slug: "Seaman book", name: "Seaman's book (SID / discharge book)", category: "identity", validityYears: 10 },
    { slug: "Medical", name: "Medical fitness certificate (ENG1 / equiv.)", category: "medical", validityYears: 1 },
    { slug: "Basic Safety Training", name: "STCW Basic Safety Training", category: "safety", validityYears: 5 },
    { slug: "Endorsement", name: "Flag-state endorsement of CoC", category: "competency", validityYears: 5 },
    { slug: "Advanced Fire Fighting", name: "Advanced Fire Fighting (STCW A-VI/3)", category: "safety", validityYears: 5 },
    { slug: "Tanker Familiarisation", name: "Tanker familiarisation / cargo operations", category: "competency", validityYears: 5 },
    // #41 employment doc-set (MLC A2.1). validityYears null — currency is by seaEndDate,
    // not a fixed norm. In the catalog (so agencies can opt them in) but in NO required
    // layer below, so they add zero hard-block on deploy.
    { slug: "SEA", name: "Seafarer's Employment Agreement (SEA, MLC A2.1)", category: "employment", validityYears: null },
    { slug: "Wage Account", name: "Wage / salary account confirmation", category: "employment", validityYears: null },
    { slug: "Allotment", name: "Allotment authorisation", category: "employment", validityYears: null },
    { slug: "Contract Addendum", name: "Contract addendum / employment rider", category: "employment", validityYears: null },
  ],
  universalRequired: ["Passport", "Seaman book", "Medical", "Basic Safety Training"],
  perRankRequired: {
    master: ["Endorsement"],
    chief_officer: ["Endorsement"],
    deck_officer: ["Endorsement"],
    chief_engineer: ["Endorsement"],
    engineer_officer: ["Endorsement"],
    rating: [],
    cadet: [],
  },
  // Vessel-type add-on packs. Tanker/gas berths add tanker familiarisation; the
  // higher-hazard chemical/gas + passenger berths also add Advanced Fire Fighting.
  // Non-hazardous dry trades add nothing beyond the rank floor.
  perVesselTypeRequired: {
    general_cargo: [],
    container: [],
    bulk_carrier: [],
    oil_tanker: ["Tanker Familiarisation"],
    chemical_tanker: ["Tanker Familiarisation", "Advanced Fire Fighting"],
    gas_carrier: ["Tanker Familiarisation", "Advanced Fire Fighting"],
    passenger: ["Advanced Fire Fighting"],
    offshore: [],
    other: [],
  },
  // Flag-state add-on packs. Seeded EMPTY: the researched per-flag Certificate-of-
  // Endorsement recognition rules (White List / CoE validity) are a separate item
  // (T3.2). The dimension is wired + agent-configurable so an agency can add its
  // own flag-specific requirements today.
  perFlagRequired: {
    estonia: [],
    eu_other: [],
    panama: [],
    liberia: [],
    marshall_islands: [],
    other: [],
  },
};

// Effective-dated list, ascending by effectiveFrom. Add new versions by APPENDING
// a later-dated baseline — never mutate a shipped one (history must stay stable).
export const BASELINES: RequiredDocsBaseline[] = [BASELINE_V1];

/** The baseline in force at `at` (defaults to now). Falls back to the earliest. */
export function baselineAt(at: string | number | Date = Date.now()): RequiredDocsBaseline {
  const t = new Date(at).getTime();
  let chosen = BASELINES[0];
  for (const b of BASELINES) {
    if (new Date(b.effectiveFrom).getTime() <= t) chosen = b;
  }
  return chosen;
}

export function baselineByVersion(version: string): RequiredDocsBaseline | null {
  return BASELINES.find((b) => b.version === version) ?? null;
}

// ---- Per-agent config --------------------------------------------------

/**
 * An agent's editable required-docs configuration. Defaults to the researched
 * baseline; an edit applies to ALL that agent's seafarers. Keyed by the agent's
 * stable identity (see lib/agent-session.ts `agentId`). `baselineVersion` records
 * which catalog version the config was derived from, so the catalog metadata
 * (names/validity) is resolved against the right version.
 */
export type RequiredDocsConfig = {
  agentId: string;
  baselineVersion: string;
  universalRequired: RequiredDocType[];
  perRankRequired: Record<RankKey, RequiredDocType[]>;
  /** Additive per-vessel-type requirement packs (T1.8). */
  perVesselTypeRequired: Record<VesselTypeKey, RequiredDocType[]>;
  /** Additive per-flag-state requirement packs (T1.8). */
  perFlagRequired: Record<FlagKey, RequiredDocType[]>;
  updatedAt: string;
  /** Actor (agent name/email) who last saved — audit trail. */
  updatedBy: string | null;
};

/** A config seeded from the baseline in force at `at`, unedited. */
export function defaultConfigFor(
  agentId: string,
  at: string | number | Date = Date.now()
): RequiredDocsConfig {
  const b = baselineAt(at);
  return {
    agentId,
    baselineVersion: b.version,
    universalRequired: [...b.universalRequired],
    perRankRequired: cloneByKey(RANK_KEYS, b.perRankRequired),
    perVesselTypeRequired: cloneByKey(VESSEL_TYPE_KEYS, b.perVesselTypeRequired),
    perFlagRequired: cloneByKey(FLAG_KEYS, b.perFlagRequired),
    updatedAt: new Date(at).toISOString(),
    updatedBy: null,
  };
}

/** Deep-clone a keyed doc-type map, guaranteeing every key in `keys` is present. */
function cloneByKey<K extends string>(
  keys: readonly K[],
  src: Record<K, RequiredDocType[]>
): Record<K, RequiredDocType[]> {
  const out = {} as Record<K, RequiredDocType[]>;
  for (const k of keys) out[k] = [...(src?.[k] ?? [])];
  return out;
}

/** Sanitise an inbound config edit: keep only real doc types + all rank keys present. */
export function sanitizeConfig(
  agentId: string,
  input: Partial<RequiredDocsConfig>,
  updatedBy: string | null,
  at: string | number | Date = Date.now()
): RequiredDocsConfig {
  const valid = new Set<RequiredDocType>(REQUIRED_DOC_TYPES);
  const onlyValid = (arr: unknown): RequiredDocType[] => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set<RequiredDocType>();
    for (const v of arr) if (typeof v === "string" && valid.has(v as RequiredDocType)) seen.add(v as RequiredDocType);
    // Preserve catalog order for stable display/diffing.
    return REQUIRED_DOC_TYPES.filter((t) => seen.has(t));
  };
  const sanitizeMap = <K extends string>(
    keys: readonly K[],
    src: Partial<Record<K, unknown>> | undefined
  ): Record<K, RequiredDocType[]> => {
    const inMap = (src ?? {}) as Partial<Record<K, unknown>>;
    const out = {} as Record<K, RequiredDocType[]>;
    for (const k of keys) out[k] = onlyValid(inMap[k]);
    return out;
  };
  const version = baselineByVersion(input.baselineVersion ?? "")?.version ?? baselineAt(at).version;
  return {
    agentId,
    baselineVersion: version,
    universalRequired: onlyValid(input.universalRequired),
    perRankRequired: sanitizeMap(RANK_KEYS, input.perRankRequired),
    perVesselTypeRequired: sanitizeMap(VESSEL_TYPE_KEYS, input.perVesselTypeRequired),
    perFlagRequired: sanitizeMap(FLAG_KEYS, input.perFlagRequired),
    updatedAt: new Date(at).toISOString(),
    updatedBy,
  };
}

// ---- The pure rule engine ----------------------------------------------

export type RequiredSet = {
  /** The required slots for this seafarer, catalog-ordered, de-duplicated. */
  required: RequiredDocType[];
  /** Canonical rank, or null in the zero-state. */
  rankKey: RankKey | null;
  /** False => zero-state (null/unknown rank): a DEFINED incomplete, never compliant. */
  rankKnown: boolean;
  /** Canonical vessel type applied, or null when unknown/unset (no add-on). */
  vesselTypeKey: VesselTypeKey | null;
  /** Canonical flag applied, or null when unknown/unset (no add-on). */
  flagKey: FlagKey | null;
  /** Baseline/config version used. */
  version: string;
  /**
   * Whether the RANK alone should block assignment. Product decision (multi-language
   * portal): a rank is accepted as-is, so an unrecognised or absent rank NEVER blocks
   * — assignment blocking comes only from genuinely missing/expired REQUIRED documents
   * (see lib/compliance.ts). Kept as a field (always false now) for callers/back-compat.
   */
  blockAssignment: boolean;
};

/**
 * Compute the required document SET for a seafarer. Pure + deterministic: same
 * inputs => same output, no clock/IO except the `at` you pass for catalog dating.
 * `config` defaults to the baseline in force at `at` when omitted. The required set
 * is the UNION of four additive layers: universal + per-rank + per-vessel-type +
 * per-flag. `vesselType`/`flag` are free-text (normalised here); an unknown value
 * adds nothing and is NOT a block (only an unknown RANK is the zero-state block).
 */
export function requiredSetFor(input: {
  rank: string | null | undefined;
  config?: RequiredDocsConfig | null;
  at?: string | number | Date;
  /** Vessel type the berth is on — drives the per-vessel-type add-on pack. */
  vesselType?: string | null;
  /** Flag state / registry the vessel flies — drives the per-flag add-on pack. */
  flag?: string | null;
}): RequiredSet {
  const at = input.at ?? Date.now();
  const cfg = input.config ?? defaultConfigFor("__baseline__", at);
  const rankKey = normalizeRank(input.rank);
  const vesselTypeKey = normalizeVesselType(input.vesselType);
  const flagKey = normalizeFlag(input.flag);

  const acc = new Set<RequiredDocType>(cfg.universalRequired);
  if (rankKey) for (const t of cfg.perRankRequired[rankKey] ?? []) acc.add(t);
  if (vesselTypeKey) for (const t of cfg.perVesselTypeRequired?.[vesselTypeKey] ?? []) acc.add(t);
  if (flagKey) for (const t of cfg.perFlagRequired?.[flagKey] ?? []) acc.add(t);

  return {
    required: REQUIRED_DOC_TYPES.filter((t) => acc.has(t)),
    rankKey,
    rankKnown: rankKey !== null,
    vesselTypeKey,
    flagKey,
    version: cfg.baselineVersion,
    // Rank never blocks (multi-language: any/absent rank is accepted; only missing/
    // expired REQUIRED documents block, in lib/compliance.ts).
    blockAssignment: false,
  };
}

export type RequiredCompleteness = {
  have: RequiredDocType[];
  missing: RequiredDocType[];
  /** Covered required slots. */
  count: number;
  /** Size of the required set. */
  total: number;
  rankKnown: boolean;
  rankKey: RankKey | null;
  version: string;
};

/**
 * Completeness of a seafarer's document tags against a required SET — the
 * config-driven replacement for doctypes.completeness()'s fixed 5. Reuses
 * doctypes.missingFrom so the "which slot is missing" logic is not duplicated.
 */
export function requiredCompleteness(
  tags: (RequiredDocType | null | undefined)[],
  req: RequiredSet
): RequiredCompleteness {
  const missing = missingFrom(tags, req.required);
  const missingSet = new Set(missing);
  const have = req.required.filter((t) => !missingSet.has(t));
  return {
    have,
    missing,
    count: have.length,
    total: req.required.length,
    rankKnown: req.rankKnown,
    rankKey: req.rankKey,
    version: req.version,
  };
}

// ---- Assignment-start snapshot -----------------------------------------

/**
 * A FROZEN copy of the required set at the moment an assignment starts. Stored on
 * the Assignment so a mid-contract rank (or, later, vessel) change cannot silently
 * re-scope what the man was required to have when he was committed to the voyage.
 */
export type RequiredDocsSnapshot = {
  required: RequiredDocType[];
  rankKey: RankKey | null;
  rankKnown: boolean;
  /** Vessel type frozen at assignment start (optional on legacy snapshots). */
  vesselTypeKey?: VesselTypeKey | null;
  /** Flag frozen at assignment start (optional on legacy snapshots). */
  flagKey?: FlagKey | null;
  version: string;
  takenAt: string;
};

export function snapshotRequiredSet(
  req: RequiredSet,
  at: string | number | Date = Date.now()
): RequiredDocsSnapshot {
  return {
    required: [...req.required],
    rankKey: req.rankKey,
    rankKnown: req.rankKnown,
    vesselTypeKey: req.vesselTypeKey,
    flagKey: req.flagKey,
    version: req.version,
    takenAt: new Date(at).toISOString(),
  };
}

// ---- #41 Employment doc-set (MLC/SEA) read-model -----------------------
//
// A SINGLE read-model both the #41 surfacing (board column, banner, CSV, seaman
// checklist) and the #45 SEA fill derive from, so they cannot drift. It reuses
// normalizeVesselType / normalizeFlag and doctypes.missingFrom — no new missing logic.

export type EmploymentContext = {
  rank: string | null;
  vessel: string | null;
  vesselTypeKey: VesselTypeKey | null;
  flagKey: FlagKey | null;
  rotationEnd: string | null;
  /** #41 item 15 — SELF-DECLARED CBA cover (never "verified"). */
  cbaCovered: boolean;
  cbaRef: string | null;
};

/** Derive the employment context for a seafarer (client-safe; no IO). */
export function employmentContextFor(s: Seafarer): EmploymentContext {
  return {
    rank: s.rank || null,
    vessel: s.vessel ?? null,
    vesselTypeKey: normalizeVesselType(s.vesselType),
    flagKey: normalizeFlag(s.flagState),
    rotationEnd: s.rotationEnd ?? null,
    cbaCovered: s.cbaCovered ?? false,
    cbaRef: s.cbaRef ?? null,
  };
}

// The employment slots REQUIRED for an assigned (at-sea) seaman this voyage (item 12).
// Contract Addendum is TRACKED (EMPLOYMENT_DOC_TYPES) + displayed but never required.
export const EMPLOYMENT_REQUIRED_WHEN_ASSIGNED = [
  "SEA",
  "Wage Account",
  "Allotment",
] as const satisfies readonly RequiredDocType[];

export type EmploymentCompleteness = {
  /** False while benched — "SEA not required while benched"; nothing counted missing. */
  applicable: boolean;
  have: RequiredDocType[];
  /** Slots with no document on file at all. */
  missing: RequiredDocType[];
  /** SEA present but its end date has lapsed (before now / rotation end) — attention. */
  expired: RequiredDocType[];
  /**
   * SEA present but its end date is null — a RECONFIRM attention state, NOT satisfied
   * (item 13 / v3 item 6: a null date is never a silent forever-current SEA).
   */
  unknownExpiry: RequiredDocType[];
  /** Satisfied required slots. */
  count: number;
  /** Size of the required set (0 while benched). */
  total: number;
  cbaCovered: boolean;
  cbaRef: string | null;
};

/**
 * Assignment-scoped completeness of a seaman's employment doc-set. Benched
 * (`assigned===false`) => not applicable (never counted missing). Assigned => SEA +
 * wage account + allotment are required this voyage, and the SEA's currency is judged
 * by its `seaEndDate` (item 13): lapsed => `expired`; null => `unknownExpiry`; in-date
 * => satisfied. `expired`/`unknownExpiry` are NOT counted as satisfied.
 */
export function employmentCompleteness(
  tags: (RequiredDocType | null | undefined)[],
  docs: Pick<Doc, "requiredType" | "seaEndDate">[],
  ctx: EmploymentContext,
  scope: { assigned: boolean; now?: Date }
): EmploymentCompleteness {
  if (!scope.assigned) {
    return {
      applicable: false,
      have: [],
      missing: [],
      expired: [],
      unknownExpiry: [],
      count: 0,
      total: 0,
      cbaCovered: ctx.cbaCovered,
      cbaRef: ctx.cbaRef,
    };
  }

  const required = [...EMPLOYMENT_REQUIRED_WHEN_ASSIGNED];
  // Slots entirely absent (no matching document tag) — pure missing.
  const missing = missingFrom(tags, required);
  const missingSet = new Set(missing);

  // SEA currency, judged only when a SEA document is actually present.
  const now = scope.now ?? new Date();
  const cutoff = earliestCutoff(now, ctx.rotationEnd);
  const expired: RequiredDocType[] = [];
  const unknownExpiry: RequiredDocType[] = [];

  if (!missingSet.has("SEA")) {
    const seaDocs = docs.filter((d) => d.requiredType === "SEA");
    const verdict = seaCurrency(seaDocs, cutoff);
    if (verdict === "expired") expired.push("SEA");
    else if (verdict === "unknown") unknownExpiry.push("SEA");
    // "current" => stays satisfied (no flag).
  }

  const attention = new Set<RequiredDocType>([...expired, ...unknownExpiry]);
  const have = required.filter((t) => !missingSet.has(t) && !attention.has(t));

  return {
    applicable: true,
    have,
    missing,
    expired,
    unknownExpiry,
    count: have.length,
    total: required.length,
    cbaCovered: ctx.cbaCovered,
    cbaRef: ctx.cbaRef,
  };
}

// The lapse cutoff: a SEA must survive to the EARLIER of now and the rotation end (a
// SEA that expires mid-voyage is not current for that voyage — mirrors compliance.ts
// rotation-expiry). Actually the SEA must be valid THROUGH the rotation, so the cutoff
// it must outlast is the LATER of now / rotationEnd.
function earliestCutoff(now: Date, rotationEnd: string | null): number {
  const nowMs = now.getTime();
  if (!rotationEnd) return nowMs;
  const r = new Date(rotationEnd).getTime();
  return Number.isFinite(r) ? Math.max(nowMs, r) : nowMs;
}

// Reduce a seaman's SEA documents to a single currency verdict against the cutoff.
// A present SEA with a null end date is an explicit "unknown" (reconfirm), never a
// silent pass. If ANY SEA doc is in-date it wins; else a null-date SEA => unknown;
// else expired.
function seaCurrency(
  seaDocs: Pick<Doc, "seaEndDate">[],
  cutoffMs: number
): "current" | "unknown" | "expired" {
  if (seaDocs.length === 0) return "expired";
  let sawUnknown = false;
  for (const d of seaDocs) {
    const end = d.seaEndDate ?? null;
    if (end === null) {
      sawUnknown = true;
      continue;
    }
    const t = new Date(end).getTime();
    if (Number.isFinite(t) && t >= cutoffMs) return "current";
  }
  return sawUnknown ? "unknown" : "expired";
}
