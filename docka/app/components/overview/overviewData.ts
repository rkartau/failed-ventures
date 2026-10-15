// ---------------------------------------------------------------------------
// Overview pages — ALL static, illustrative content in ONE place.
//
// HONESTY RULE: every feature string below maps to a SHIPPED feature in
// PROJECT.md §4 ("Features (current, all live)"). The `maps` field records that
// mapping so the honesty-map gate is self-documenting. Nothing here is a
// roadmap/future item, and NO number is a live measurement — the graph numbers
// are representative examples, always shown under the ILLUSTRATIVE caption.
//
// This module imports NOTHING from lib/db, lib/agentData, auth, or any /api —
// it is pure presentational data, so the public overview pages never touch a
// tenant's records. All positions/percentages are hardcoded constants (no
// `new Date()` anywhere) to avoid hydration mismatch (BI1).
// ---------------------------------------------------------------------------

export const ILLUSTRATIVE_CAPTION =
  "Illustrative — representative numbers, not live data.";

export type Tone = "slate" | "emerald" | "amber" | "rose" | "sky" | "teal" | "brand";

// A single key feature. `maps` = the PROJECT.md §4 feature it corresponds to.
export type Feature = {
  pill: string;
  pillTone: Tone;
  title: string;
  value: string;
  /** PROJECT.md §4 shipped feature this card corresponds to (honesty map). */
  maps: string;
  /** When true the card renders the real VerificationLevelBadge L0–L3 row. */
  badges?: boolean;
  /** Extra emphasised line, e.g. the Jaan anti-disintermediation moat (CV7). */
  note?: string;
};

export type FeatureSection = { heading: string; features: Feature[] };

export type Persona = {
  id: string;
  name: string;
  role: string;
  blurb: string;
  /** Graph ids this persona's chip highlights (may be more than one). */
  graphs: string[];
  /** Optional extra callout shown under the selector when chosen (Reyes). */
  callout?: string;
};

// ===========================================================================
// AGENCIES page
// ===========================================================================

export const AGENCY_SECTIONS: FeatureSection[] = [
  {
    heading: "Trust & verification",
    features: [
      {
        pill: "Verify",
        pillTone: "emerald",
        title: "Live government verification",
        value:
          "Certificates are checked straight against the official maritime registry wherever the registry supports it — no forged PDFs.",
        maps: "§4 Recognition (seaman) + Agent Compliance one-click verify",
      },
      {
        pill: "Trust levels",
        pillTone: "teal",
        title: "Verification levels L0–L3",
        value:
          "Every document carries a graded trust level, from self-uploaded to government-verified.",
        maps: "§4 Batch 1 #30 Verification-level badges (L0–L3)",
        badges: true,
      },
      {
        pill: "Data quality",
        pillTone: "sky",
        title: "Duplicate-person detect & merge",
        value:
          "Fuzzy name matching flags likely same-person records; merge their documents into one profile.",
        maps: "§4 Batch 1 #37 Duplicate-person detect + merge",
      },
      {
        pill: "Honest signal",
        pillTone: "amber",
        title: "Honest forgery signal",
        value:
          "A possible-forgery duplicate warning — suppressed on government-verified documents the registry already confirmed.",
        maps: "§4 Agent Attention table (forgery suppressed on gov-verified)",
      },
    ],
  },
  {
    heading: "Pipeline & throughput",
    features: [
      {
        pill: "Pipeline",
        pillTone: "brand",
        title: "5-stage pipeline board",
        value:
          "Review → Accepted → Sent to sea → Coming back → Finished, with drag-and-drop and filters.",
        maps: "§4 Agent Pipeline board",
      },
      {
        pill: "Review",
        pillTone: "slate",
        title: "Single-seaman review",
        value: "Open one seaman and approve or reject each document with a reason.",
        maps: "§4 Agent Single-seaman review",
      },
      {
        pill: "Attention",
        pillTone: "amber",
        title: "Attention table",
        value: "A deduplicated list of expired, missing and duplicate items to clear.",
        maps: "§4 Agent Attention table",
      },
      {
        pill: "Export",
        pillTone: "slate",
        title: "CSV export of the crew list",
        value: "Export your crew list to CSV for the tools you already use.",
        maps: "§4 Agent Compliance — CSV export",
      },
    ],
  },
  {
    heading: "Compliance & lifecycle",
    features: [
      {
        pill: "Required set",
        pillTone: "sky",
        title: "Required document sets",
        value:
          "Each agency configures its required set (STCW rank baseline); completeness recomputes automatically.",
        maps: "§4 Agent Required documents + Batch 2 #41",
      },
      {
        pill: "Hard block",
        pillTone: "rose",
        title: "Sea-ready hard-block",
        value:
          "An expired or missing required cert blocks 'Sent to sea' unless overridden with a logged reason.",
        maps: "§4 Agent Compliance hard-block (logged MLC override)",
      },
      {
        pill: "Employment",
        pillTone: "teal",
        title: "SEA/CBA tracking + contract generation",
        value:
          "Assignment-scoped doc sets, contract-end tracking, and Seafarer Employment Agreement generation.",
        maps: "§4 Batch 2 #41 SEA/CBA tracking + #45 SEA/contract generation",
      },
      {
        pill: "Appraisals",
        pillTone: "slate",
        title: "Appraisal scorecards",
        value: "Per-seaman performance scorecards you can keep alongside the profile.",
        maps: "§4 Batch 2 #43 Appraisal scorecards",
      },
    ],
  },
  {
    heading: "External surfaces",
    features: [
      {
        pill: "Shipowner",
        pillTone: "brand",
        title: "Shipowner read-portal",
        value: "A token-gated, read-only view for the shipowners you serve.",
        maps: "§4 Batch 3 #42 Shipowner read-portal",
      },
      {
        pill: "Directory",
        pillTone: "sky",
        title: "Docka-verified directory",
        value:
          "A searchable directory of verified seafarers — dual consent, auth-gated and rate-limited.",
        maps: "§4 Batch 3 #49 Docka-verified directory",
        note:
          "Your moat: clients see crew THROUGH your agency (attribution) — you are never cut out of the deal.",
      },
      {
        pill: "Matching",
        pillTone: "teal",
        title: "Vacancy + candidate matching",
        value: "Post a vacancy and match candidates against it.",
        maps: "§4 Batch 3 #52 Vacancy + candidate matching",
      },
      {
        pill: "Isolation",
        pillTone: "slate",
        title: "Consent & multi-tenant isolation",
        value:
          "Default-deny access — an agent only ever sees crew who granted them, with append-only consent logs.",
        maps: "§4 Multi-tenant consent access",
      },
    ],
  },
];

export const AGENCY_PERSONAS: Persona[] = [
  {
    id: "maria",
    name: "Maria",
    role: "High-volume crewing desk",
    blurb:
      "Maria moves hundreds of applications a week. She watches the pipeline funnel to see where crew get stuck between review and the ship.",
    graphs: ["G1"],
  },
  {
    id: "priya",
    name: "Priya",
    role: "Fleet superintendent",
    blurb:
      "Priya must know which certificates are government-verified before she signs off. The verification-level mix shows the split at a glance.",
    graphs: ["G3"],
  },
  {
    id: "nikos",
    name: "Nikos",
    role: "Compliance officer",
    blurb:
      "Nikos cares about one thing: how many crew are sea-ready versus hard-blocked. The compliance ring is his daily check.",
    graphs: ["G2"],
  },
  {
    id: "olena",
    name: "Olena",
    role: "Building a roster from scratch",
    blurb:
      "Olena enters each seaman once and never re-keys. The 'enter once' tile shows re-keying drop to zero as verified profiles propagate.",
    graphs: ["G4"],
  },
  {
    id: "jaan",
    name: "Jaan",
    role: "Agency owner",
    blurb:
      "Jaan looks at return and at his moat: clients see crew THROUGH his agency (directory attribution), so he is never disintermediated.",
    graphs: ["G4"],
  },
  {
    id: "reyes",
    name: "Reyes",
    role: "Shipowner / the agency's client",
    blurb:
      "Reyes is the agency's client. Through the shipowner read-portal he sees the same verified trust levels and compliance — read-only, and attributed to the agency.",
    graphs: ["G3", "G2"],
    callout:
      "Reyes never logs into your desk. The read-portal shows him the same L0–L3 trust mix and sea-ready compliance you see — read-only, and always credited to your agency.",
  },
];

// G1 — pipeline funnel. Monotonically decreasing (CV4).
export const AGENCY_FUNNEL: { label: string; count: number }[] = [
  { label: "Review", count: 132 },
  { label: "Accepted", count: 86 },
  { label: "Sent to sea", count: 58 },
  { label: "Coming back", count: 34 },
  { label: "Finished", count: 21 },
];

// G2 — compliance donut. Sea-ready pass is SKY (not emerald — emerald is L3 only, CV3).
export const AGENCY_COMPLIANCE = {
  seaReadyPct: 82,
  blockedPct: 18,
  seaReadyCount: 41,
  blockedCount: 9,
  total: 50,
};

// G3 — verification-level distribution of 100 documents. Tones come from LEVEL_META.
export const AGENCY_LEVELS: { level: 0 | 1 | 2 | 3; count: number }[] = [
  { level: 0, count: 22 },
  { level: 1, count: 14 },
  { level: 2, count: 9 },
  { level: 3, count: 55 },
];

// G4 — clean illustrative KPI tiles. NO benchmark / "down from" / "×" claims (CV2).
export const AGENCY_TILES: {
  label: string;
  target: string;
  tone: Tone;
  sub: string;
}[] = [
  {
    label: "Docs verified against source",
    target: "55%",
    tone: "emerald",
    sub: "illustrative example · government-verified (L3)",
  },
  {
    label: "Required-doc coverage",
    target: "82%",
    tone: "sky",
    sub: "illustrative example",
  },
  {
    label: "Re-keying on import",
    target: "0",
    tone: "slate",
    sub: "enter once — propagates to granted agencies",
  },
  {
    label: "Reminders queued per profile",
    target: "3.5",
    tone: "amber",
    sub: "illustrative example",
  },
];

// ===========================================================================
// SEAFARERS page
// ===========================================================================

export const SEAFARER_SECTIONS: FeatureSection[] = [
  {
    heading: "Get your documents in",
    features: [
      {
        pill: "Upload",
        pillTone: "brand",
        title: "One-button upload",
        value:
          "A single 'Add certificate photos' button — camera or gallery, many at once, with a progress bar.",
        maps: "§4 Seaman One-button upload",
      },
      {
        pill: "Recognition",
        pillTone: "sky",
        title: "Recognition & verification",
        value:
          "A QR/code verifies live; a paper photo is marked 'from photo — needs your details', never falsely 'Expired'.",
        maps: "§4 Seaman Recognition",
      },
      {
        pill: "Dedupe",
        pillTone: "slate",
        title: "Automatic dedupe",
        value: "Upload the same document twice and it is skipped ('Already uploaded').",
        maps: "§4 Seaman Dedupe",
      },
      {
        pill: "Viewer",
        pillTone: "slate",
        title: "Document viewer",
        value: "See any document full-size with zoom; the rotation you set sticks everywhere.",
        maps: "§4 Seaman Document viewer",
      },
    ],
  },
  {
    heading: "Your verified identity",
    features: [
      {
        pill: "Identity",
        pillTone: "emerald",
        title: "Verified identity",
        value:
          "A government-verified document sets your real name, personal code, date of birth, issuer and photo.",
        maps: "§4 Seaman Verified identity",
      },
      {
        pill: "Photo",
        pillTone: "teal",
        title: "Verified photo",
        value: "Your registry photo, stored locally and adjustable (zoom, reposition, rotate).",
        maps: "§4 Seaman Verified photo",
      },
      {
        pill: "Trust levels",
        pillTone: "sky",
        title: "Verification levels L0–L3",
        value: "Each document shows exactly how strongly it is verified — never colour alone.",
        maps: "§4 Batch 1 #30 Verification-level badges (L0–L3)",
        badges: true,
      },
    ],
  },
  {
    heading: "Sharing & control",
    features: [
      {
        pill: "Share",
        pillTone: "brand",
        title: "Two share links",
        value:
          "An open link for anyone you send it to, and a private link gated to listed agent emails.",
        maps: "§4 Seaman Two share links (open + private)",
      },
      {
        pill: "Control",
        pillTone: "sky",
        title: "Access, reviews & revoke",
        value: "See which agents reviewed your documents — and revoke an agent while ashore.",
        maps: "§4 Seaman Access & reviews",
      },
      {
        pill: "Propagation",
        pillTone: "teal",
        title: "Cross-agency propagation (opt-in)",
        value: "With your opt-in, a verified update reaches the agencies you have granted.",
        maps: "§4 Batch 1 #38 Cross-agency opt-in profile propagation",
      },
    ],
  },
  {
    heading: "Never miss a renewal",
    features: [
      {
        pill: "Reminders",
        pillTone: "amber",
        title: "Expiry reminders (.ics / subscribe)",
        value:
          "Set your own schedule; export a calendar (.ics) file you import into Google Calendar, or subscribe.",
        maps: "§4 Seaman Expiry reminders module",
      },
      {
        pill: "Archive",
        pillTone: "slate",
        title: "Archive & auto-archive",
        value: "Archive a document (still viewable) or auto-archive it once it expires.",
        maps: "§4 Seaman Archive / auto-archive",
      },
    ],
  },
];

// Wei foreign-cert reassurance (CV5) — shown on the seafarers page near the trust ladder.
export const FOREIGN_CERT_REASSURANCE =
  "Your certificates don't have to be Estonian. Digital or QR certificates from supported registries verify live — others are guided to the official portal; paper certificates simply show 'from photo — needs your details' — never a false 'Expired'. A non-Estonian certificate is never marked as failed.";

export const SEAFARER_PERSONAS: Persona[] = [
  {
    id: "arjun",
    name: "Arjun",
    role: "Not techy, on an iPhone",
    blurb:
      "Arjun just wants it simple. Take a photo, it verifies, share one link — the whole flow is a few taps.",
    graphs: ["S2"],
  },
  {
    id: "wei",
    name: "Wei",
    role: "English is my second language",
    blurb:
      "Wei's certificates aren't Estonian, and that's fine. The trust ladder explains each level in plain words; a foreign paper cert shows 'needs your details', never a false 'Expired'.",
    graphs: ["S1"],
  },
  {
    id: "benjie",
    name: "Benjie & Wahyu",
    role: "Older Android, patchy signal",
    blurb:
      "They upload with one button, even on a slow phone. Each photo saves as it arrives and resumes if the signal drops.",
    graphs: ["S2"],
  },
  {
    id: "mart",
    name: "Mart",
    role: "Wants to stay in control",
    blurb:
      "Mart decides who sees his profile. Consent stays with him — switch an agency off and it loses access immediately.",
    graphs: ["S4"],
  },
];

// S2 — credential flow nodes. "Hired" softened to "often within days" (CV8).
export const SEAFARER_FLOW: {
  id: string;
  title: string;
  caption: string;
  desc: string;
}[] = [
  {
    id: "upload",
    title: "Upload",
    caption: "~30 sec",
    desc: "Tap once and add certificate photos from your camera or gallery.",
  },
  {
    id: "verify",
    title: "Verify",
    caption: "instant when supported",
    desc:
      "QR/code certificates from supported registries verify live; others are guided to the official portal; paper is marked 'from photo — needs your details'.",
  },
  {
    id: "share",
    title: "Share",
    caption: "1 tap",
    desc: "Send one private link to a crewing agent — they need no login.",
  },
  {
    id: "hired",
    title: "Hired",
    caption: "often within days",
    desc: "The agent reviews your verified profile and moves you through their pipeline.",
  },
];

// S1 — trust ladder plain-language "what this means for you" lines (labels come
// from LEVEL_META in lib/verification-level.ts).
export const SEAFARER_LADDER: { level: 0 | 1 | 2 | 3; meaning: string }[] = [
  { level: 0, meaning: "On file, but not yet checked or verified by anyone." },
  { level: 1, meaning: "A person opened your actual document and confirmed it." },
  { level: 2, meaning: "Found in a registry — the document exists there." },
  {
    level: 3,
    meaning: "Checked against the government's maritime registry — the strongest level.",
  },
];

// S3 — reminders timeline. Positions are hardcoded percentages (BI1 — no new Date()).
// The certificate expires 90 days out; reminders fire ahead of it.
export const SEAFARER_REMINDERS: {
  daysBefore: number;
  pct: number;
  expiry?: boolean;
}[] = [
  { daysBefore: 60, pct: 33 },
  { daysBefore: 30, pct: 66 },
  { daysBefore: 14, pct: 84 },
  { daysBefore: 7, pct: 92 },
  { daysBefore: 0, pct: 100, expiry: true },
];

export const REMINDER_UNITS: { id: "months" | "weeks" | "days"; label: string }[] = [
  { id: "months", label: "Months" },
  { id: "weeks", label: "Weeks" },
  { id: "days", label: "Days" },
];

// S4 — propagation hub-and-spoke. Coordinates are hardcoded for the 320×220 viewBox
// (hub at 160,110). `granted` is the illustrative starting state.
export const HUB = { x: 160, y: 110 };
export const SEAFARER_AGENCIES: {
  id: string;
  name: string;
  x: number;
  y: number;
  granted: boolean;
}[] = [
  { id: "a1", name: "Baltic Crewing", x: 46, y: 40, granted: true },
  { id: "a2", name: "North Sea Marine", x: 274, y: 40, granted: true },
  { id: "a3", name: "Adriatic Ships", x: 46, y: 180, granted: false },
  { id: "a4", name: "Pacific Fleet", x: 274, y: 180, granted: true },
];
