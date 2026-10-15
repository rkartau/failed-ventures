// Public Sample Profiles — the ADDITIVE + IDEMPOTENT sample seed (plan Phase 2).
//
// Plain, dependency-free .mjs: prod runs Node v20 with no TS stripping, so this
// file imports NOTHING from app/lib. The sample-identity literals below are
// DUPLICATED from app/lib/sample-ids.ts; tests/sample-seed.test.mjs locks the
// two copies equal so they can never drift.
//
// Behavior (plan §Phase-2, v4-5a):
//   node scripts/seed-samples.mjs            seed/refresh the curated sample set
//   node scripts/seed-samples.mjs --remove   cascading removal of ALL sample traces
//
// SEED is additive + idempotent: it deletes ONLY rows that are sample-owned
// (`sample:true` / `isSample:true` / `sample-`-prefixed ids / sample-agency-owned
// config rows), re-inserts the fixed-id curated set, and copies
// scripts/sample-fixtures/*.jpg into uploads/ under their fixed sample-*.jpg
// names. Real rows — including real agents' interactions with the flagship
// (grants, doc requests, uploads) — are NEVER touched by a plain seed; fixed ids
// keep those interactions pointing at the re-inserted rows.
//
// --REMOVE additionally cascades over every collection that can reference a
// sample id (accessGrants, assignments, docRequests, comments, appraisals,
// appraisalDeleteRequests, profileShareRequests, profileChanges, seaService,
// restHours, issuedSeaTerms, circularReplies, notifications, remindersSent,
// credentialUsers, impersonations, vacancies, requiredDocsConfigs/-Audit),
// strips sample ids from Circular.recipientIds and ClientPortal.seafarerIds
// (dropping a circular ONLY when its recipients become empty), and — BEFORE
// deleting Doc rows — collects `fileName` from EVERY doc whose seafarerId is a
// sample id (curated sample-*.jpg AND agent-uploaded files with arbitrary
// server-generated names) and deletes those files from uploads/. No dangling
// reference or orphaned file can ghost any real surface.
//
// HARD RULES (plan §D8 / seed constraints):
//   - NEVER the two real Estonian registry codes from scripts/seed.mjs; in fact
//     `estonianCode` is null on every seeded row (the L3 doc is a Latvian
//     snapshot-only verification: source:"government" + registryCountry:"LV" +
//     registryInputs — Latvia has NO adapter in lib/registry/adapters and
//     `recheckable:false`, so the /verify proof honestly renders as "snapshot").
//   - No email/phone anywhere; googleSub/ownerEmail/importedEmail/
//     credentialUserId all null; directoryOptIn:false on every sample seafarer;
//     clientVisible:false + directoryConsent:false on every sample grant.
//   - Every PII-shaped string carries a SAMPLE marker (names "— SAMPLE", cert
//     numbers "SAMPLE-", vessels "MV Sample …").
//
// PROD DISCIPLINE (DEPLOY-RUNBOOK): the db mutex is in-process — NEVER run this
// while pm2 `docka` is running. `pm2 stop docka && node scripts/seed-samples.mjs
// && pm2 start docka`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Literals duplicated from app/lib/sample-ids.ts (locked by unit test) ----

export const SAMPLE_PREFIX = "sample-";
export const SAMPLE_AGENCY_ID = "sample-agency-crewing";
export const SAMPLE_FLAGSHIP_ID = "sample-seafarer-flagship";
export const SAMPLE_CREW_IDS = [
  "sample-crew-review",
  "sample-crew-docs-pending",
  "sample-crew-approved",
  "sample-crew-accepted",
  "sample-crew-sent-to-sea",
  "sample-crew-returning",
  "sample-crew-finished",
];
export const SAMPLE_OPEN_TOKEN = "ys1pBYWeQrgo";

// ---- Paths -------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(SCRIPT_DIR, "..");
export const FIXTURES_DIR = path.join(SCRIPT_DIR, "sample-fixtures");

// ---- Relative dates (the iso(days) pattern from seed-curated.mjs) ------------

/** ISO instant offset by `days` from today (00:00 UTC) — deterministic per day. */
export function iso(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
/** YYYY-MM-DD offset by `days` from today (UTC). */
export function day(days) {
  return iso(days).slice(0, 10);
}

// ---- Curated fictional content ----------------------------------------------
//
// Personas (all fictional, Baltic-flavored, no collision with scripts/seed.mjs
// or scripts/seed-curated.mjs name pools):
//   Flagship  Marten Sarapuu — SAMPLE   Chief Officer (the public owner-view demo)
//   Agency    Sample Crewing OÜ         (staffer persona "Kai Lepik — SAMPLE")
//   Crew      Silver Kuusk / Liis Talvik / Aivar Rebane / Dainis Ozols /
//             Ruta Jankauskiene / Tonu Meriste / Urmas Aavik — all "— SAMPLE"
// Full reviewable content spec: SAMPLE-CONTENT.md (worktree root).

const AGENCY_NAME = "Sample Crewing OÜ";
const STAFFER = "Kai Lepik — SAMPLE";

/** Base fields shared by every sample seafarer (all auth seams null, no PII). */
function seafarerBase(id, open) {
  return {
    id,
    shareToken: open,
    openShareToken: open,
    emailShareToken: `${id}-email-token`,
    allowedEmails: [],
    googleSub: null,
    ownerEmail: null,
    credentialUserId: null,
    importedEmail: null,
    isSample: true,
    directoryOptIn: false,
    autoArchiveExpired: false,
  };
}

/** A government-verified (L3) doc — LV snapshot-only registry, never estonianCode. */
function gov(id, seafarerId, o) {
  return {
    id,
    sample: true,
    seafarerId,
    title: o.title,
    docType: o.docType,
    docCategory: o.docCategory ?? null,
    estonianCode: null,
    certNumber: o.certNumber,
    isValid: o.isValid ?? true,
    validUntil: o.validUntil ?? null,
    expiryConfirmed: true,
    fileName: o.fileName ?? null,
    createdAt: o.createdAt ?? iso(-60),
    source: "government",
    requiredType: o.requiredType ?? null,
    reviewStatus: o.reviewStatus ?? "pending",
    reviewedBy: o.reviewedBy ?? null,
    reviewedAt: o.reviewedAt ?? null,
    registryCountry: "LV",
    registryInputs: { certNumber: o.certNumber },
    verifiedKeyTrust: "public-identifier",
    verifiedFullName: o.verifiedFullName ?? null,
    verifiedFirstName: o.verifiedFirstName ?? null,
    verifiedLastName: o.verifiedLastName ?? null,
    verifiedIssuerCountry: "Latvia",
    verifiedResolvedAt: o.verifiedResolvedAt ?? iso(-60),
  };
}

/** A manually-typed (L0) doc. */
function manual(id, seafarerId, o) {
  return {
    id,
    sample: true,
    seafarerId,
    title: o.title,
    docType: o.docType,
    docCategory: o.docCategory ?? null,
    estonianCode: null,
    certNumber: o.certNumber ?? null,
    isValid: o.isValid ?? (o.validUntil ? true : null),
    validUntil: o.validUntil ?? null,
    noExpiry: o.noExpiry,
    expiryConfirmed: true,
    fileName: o.fileName ?? null,
    createdAt: o.createdAt ?? iso(-60),
    source: "manual",
    requiredType: o.requiredType ?? null,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    seaEndDate: o.seaEndDate,
    archived: o.archived,
    archivedAt: o.archivedAt,
  };
}

/** A photo-upload doc (L0 unless reviewerChecked → L1). */
function photo(id, seafarerId, o) {
  return {
    id,
    sample: true,
    seafarerId,
    title: o.title,
    docType: o.docType,
    docCategory: o.docCategory ?? null,
    estonianCode: null,
    certNumber: o.certNumber ?? null,
    isValid: o.isValid ?? (o.validUntil ? true : null),
    validUntil: o.validUntil ?? null,
    expiryConfirmed: o.expiryConfirmed ?? false,
    fileName: o.fileName ?? null,
    createdAt: o.createdAt ?? iso(-60),
    source: "photo",
    requiredType: o.requiredType ?? null,
    reviewStatus: o.reviewStatus ?? "pending",
    reviewedBy: o.reviewedBy ?? null,
    reviewedAt: o.reviewedAt ?? null,
    reviewerChecked: o.reviewerChecked,
    checkedBy: o.checkedBy,
    checkedAt: o.checkedAt,
    checkedVia: o.checkedVia,
    archived: o.archived,
    archivedAt: o.archivedAt,
  };
}

function grant(id, seafarerId, stage, o = {}) {
  const createdAt = o.createdAt ?? iso(-60);
  return {
    id,
    sample: true,
    seafarerId,
    agentId: SAMPLE_AGENCY_ID,
    status: "ACTIVE",
    legalBasis: o.legalBasis ?? "CONSENT",
    scope: ["profile", "documents", "log"],
    shareToken: `${id}-gtok`,
    grantedAt: createdAt,
    revokedAt: null,
    expiresAt: null,
    createdAt,
    stage,
    stageUpdatedAt: Date.parse(createdAt),
    propagateContact: false,
    propagateFinancial: false,
    clientVisible: false,
    directoryConsent: false,
  };
}

/** Build the full curated sample dataset (deterministic per calendar day). */
export function buildSampleData() {
  const F = SAMPLE_FLAGSHIP_ID;
  const [CR_REVIEW, CR_DOCS, CR_APPROVED, CR_ACCEPTED, CR_SEA, CR_RETURNING, CR_FINISHED] =
    SAMPLE_CREW_IDS;

  const agents = [
    {
      id: SAMPLE_AGENCY_ID,
      orgName: AGENCY_NAME,
      contact: "",
      createdAt: iso(-300),
      isSample: true,
    },
  ];

  const seafarers = [
    {
      ...seafarerBase(F, SAMPLE_OPEN_TOKEN),
      name: "Marten Sarapuu — SAMPLE",
      rank: "Chief Officer",
      state: "accepted",
      availability: "open_from",
      availableFrom: day(21),
      createdAt: iso(-240),
      vessel: "MV Sample Aurora",
      vesselType: "general_cargo",
      flagState: null,
      rotationEnd: null,
      identityVerified: true,
      identityVerifiedAt: iso(-120),
      verifiedName: "Marten Sarapuu — SAMPLE",
      personalCode: null,
      birthDate: "1988-03-14T00:00:00.000Z",
      photoUrl: null,
      issuerCountry: "Latvia",
      reminderLeadValue: 2,
      reminderLeadUnit: "months",
      reminderCount: 3,
      reminderIntervalDays: 14,
    },
    {
      ...seafarerBase(CR_REVIEW, "sample-open-review"),
      name: "Silver Kuusk — SAMPLE",
      rank: "Second Officer",
      state: "review",
      createdAt: iso(-90),
      vessel: "MV Sample Meridian",
    },
    {
      ...seafarerBase(CR_DOCS, "sample-open-docs-pending"),
      name: "Liis Talvik — SAMPLE",
      rank: "Third Engineer",
      state: "review",
      createdAt: iso(-45),
      vessel: "MV Sample Meridian",
    },
    {
      ...seafarerBase(CR_APPROVED, "sample-open-approved"),
      name: "Aivar Rebane — SAMPLE",
      rank: "Chief Engineer",
      state: "accepted",
      createdAt: iso(-150),
      vessel: "MV Sample Aurora",
    },
    {
      ...seafarerBase(CR_ACCEPTED, "sample-open-accepted"),
      name: "Dainis Ozols — SAMPLE",
      rank: "Bosun",
      state: "accepted",
      createdAt: iso(-120),
      vessel: "MV Sample Aurora",
    },
    {
      ...seafarerBase(CR_SEA, "sample-open-sent-to-sea"),
      name: "Ruta Jankauskiene — SAMPLE",
      rank: "Able Seaman",
      state: "sent_to_sea",
      createdAt: iso(-110),
      vessel: "MV Sample Aurora",
      rotationEnd: iso(180),
    },
    {
      ...seafarerBase(CR_RETURNING, "sample-open-returning"),
      name: "Tonu Meriste — SAMPLE",
      rank: "Motorman",
      state: "returning",
      createdAt: iso(-200),
      vessel: "MV Sample Horizon",
    },
    {
      ...seafarerBase(CR_FINISHED, "sample-open-finished"),
      name: "Urmas Aavik — SAMPLE",
      rank: "Ship's Cook",
      state: "finished",
      createdAt: iso(-260),
      vessel: "MV Sample Horizon",
    },
  ];

  const documents = [
    // ---- Flagship: L0/L1/L2/L3 + expiring + expired + archived + noExpiry ----
    // L3 government-verified (LV snapshot-only — honest "snapshot" /verify proof).
    gov("sample-doc-flag-coc", F, {
      title: "Certificate of Competency — Chief Mate",
      docType: "Certificate of competency",
      docCategory: "competency",
      certNumber: "SAMPLE-LV-88214",
      validUntil: iso(700),
      fileName: "sample-flagship-coc.jpg",
      verifiedFullName: "MARTEN SARAPUU — SAMPLE",
      verifiedFirstName: "MARTEN",
      verifiedLastName: "SARAPUU — SAMPLE",
      verifiedResolvedAt: iso(-120),
      createdAt: iso(-120),
    }),
    // L2 registry-confirmed (document exists, holder not verified) — EXPIRING ≤60d.
    {
      id: "sample-doc-flag-medical",
      sample: true,
      seafarerId: F,
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      estonianCode: null,
      certNumber: "SAMPLE-MED-3401",
      isValid: true,
      validUntil: iso(40),
      expiryConfirmed: true,
      fileName: "sample-flagship-medical.jpg",
      createdAt: iso(-30),
      source: "registry",
      requiredType: "Medical",
      reviewStatus: "pending",
      reviewedBy: null,
      reviewedAt: null,
      registryCountry: "LV",
      verifiedKeyTrust: "public-identifier",
      verifiedIssuerCountry: "Latvia",
      verifiedResolvedAt: iso(-30),
    },
    // L1 reviewed-by-staff (photo upload, reviewer checked + approved).
    photo("sample-doc-flag-bst", F, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-1207",
      validUntil: iso(500),
      expiryConfirmed: true,
      fileName: "sample-flagship-bst.jpg",
      requiredType: "Basic Safety Training",
      reviewerChecked: true,
      checkedBy: STAFFER,
      checkedAt: iso(-45),
      checkedVia: "document",
      reviewStatus: "approved",
      reviewedBy: STAFFER,
      reviewedAt: iso(-45),
      createdAt: iso(-50),
    }),
    // L0 manual — EXPIRED (drives the red badge + the reminder story).
    manual("sample-doc-flag-endorsement", F, {
      title: "Flag State Endorsement",
      docType: "Endorsement",
      docCategory: "endorsement",
      certNumber: "SAMPLE-END-5520",
      isValid: false,
      validUntil: iso(-30),
      fileName: "sample-flagship-endorsement.jpg",
      requiredType: "Endorsement",
      createdAt: iso(-200),
    }),
    // L0 manual — valid.
    manual("sample-doc-flag-passport", F, {
      title: "Passport",
      docType: "Passport",
      certNumber: "SAMPLE-PSP-7788",
      validUntil: iso(900),
      fileName: "sample-flagship-passport.jpg",
      requiredType: "Passport",
      createdAt: iso(-220),
    }),
    // L0 manual — NO-EXPIRY (perpetual document).
    manual("sample-doc-flag-seamanbook", F, {
      title: "Seaman's Discharge Book",
      docType: "Seaman's book",
      certNumber: "SAMPLE-SBK-2210",
      isValid: true,
      validUntil: null,
      noExpiry: true,
      fileName: "sample-flagship-seamanbook.jpg",
      requiredType: "Seaman book",
      createdAt: iso(-220),
    }),
    // ARCHIVED (superseded old cert, stays in the collapsible archive).
    photo("sample-doc-flag-tankerfam", F, {
      title: "Tanker Familiarisation (STCW A-V/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-TFM-0093",
      isValid: false,
      validUntil: iso(-400),
      expiryConfirmed: true,
      fileName: "sample-flagship-tankerfam.jpg",
      archived: true,
      archivedAt: iso(-90),
      createdAt: iso(-500),
    }),
    // Employment / SEA doc (MLC A2.1) — pairs with the issued-SEA record below.
    manual("sample-doc-flag-sea", F, {
      title: "Seafarer's Employment Agreement (SEA)",
      docType: "SEA",
      certNumber: "SAMPLE-SEA-2026-01",
      isValid: null,
      validUntil: null,
      seaEndDate: day(-20),
      fileName: "sample-flagship-sea.jpg",
      requiredType: "SEA",
      createdAt: iso(-200),
    }),

    // ---- Crew: sample-crew-review — EXPIRING-soon variety --------------------
    gov("sample-doc-cr1-bst", CR_REVIEW, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-6101",
      validUntil: iso(700),
      requiredType: "Basic Safety Training",
    }),
    gov("sample-doc-cr1-medical", CR_REVIEW, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      certNumber: "SAMPLE-MED-6102",
      validUntil: iso(40),
      requiredType: "Medical",
    }),
    manual("sample-doc-cr1-passport", CR_REVIEW, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(900),
      requiredType: "Passport",
    }),

    // ---- sample-crew-docs-pending — MISSING-docs + unconfirmed-photo variety --
    manual("sample-doc-cr2-passport", CR_DOCS, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(600),
      requiredType: "Passport",
    }),
    photo("sample-doc-cr2-endorsement", CR_DOCS, {
      title: "Flag State Endorsement",
      docType: "Endorsement",
      certNumber: "SAMPLE-END-8804",
      validUntil: iso(300),
      fileName: "sample-crew-photo.jpg",
      requiredType: "Endorsement",
    }),

    // ---- sample-crew-approved — fully-verified clean reference card ----------
    gov("sample-doc-cr3-coc", CR_APPROVED, {
      title: "Certificate of Competency — Chief Engineer Officer",
      docType: "Certificate of competency",
      docCategory: "competency",
      certNumber: "SAMPLE-LV-77120",
      validUntil: iso(800),
      fileName: "sample-crew-coc.jpg",
      verifiedFullName: "AIVAR REBANE — SAMPLE",
      verifiedFirstName: "AIVAR",
      verifiedLastName: "REBANE — SAMPLE",
      reviewStatus: "approved",
      reviewedBy: STAFFER,
      reviewedAt: iso(-50),
    }),
    gov("sample-doc-cr3-bst", CR_APPROVED, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-6301",
      validUntil: iso(700),
      requiredType: "Basic Safety Training",
    }),
    gov("sample-doc-cr3-medical", CR_APPROVED, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      certNumber: "SAMPLE-MED-6302",
      validUntil: iso(300),
      requiredType: "Medical",
    }),
    gov("sample-doc-cr3-endorsement", CR_APPROVED, {
      title: "Flag State Endorsement",
      docType: "Endorsement",
      docCategory: "endorsement",
      certNumber: "SAMPLE-END-6303",
      validUntil: iso(600),
      requiredType: "Endorsement",
    }),
    manual("sample-doc-cr3-seamanbook", CR_APPROVED, {
      title: "Seaman's Discharge Book",
      docType: "Seaman's book",
      validUntil: iso(1200),
      requiredType: "Seaman book",
    }),
    manual("sample-doc-cr3-passport", CR_APPROVED, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(1000),
      requiredType: "Passport",
    }),

    // ---- sample-crew-accepted — EXPIRED + forged-duplicate pair A ------------
    gov("sample-doc-cr4-bst", CR_ACCEPTED, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-6401",
      validUntil: iso(500),
      requiredType: "Basic Safety Training",
    }),
    gov("sample-doc-cr4-medical", CR_ACCEPTED, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      certNumber: "SAMPLE-MED-6402",
      validUntil: iso(200),
      requiredType: "Medical",
    }),
    gov("sample-doc-cr4-endorsement", CR_ACCEPTED, {
      title: "Flag State Endorsement",
      docType: "Endorsement",
      docCategory: "endorsement",
      certNumber: "SAMPLE-END-6403",
      isValid: false,
      validUntil: iso(-30),
      requiredType: "Endorsement",
    }),
    manual("sample-doc-cr4-passport", CR_ACCEPTED, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(700),
      requiredType: "Passport",
    }),
    photo("sample-doc-cr4-dgh", CR_ACCEPTED, {
      title: "Dangerous Goods Handling",
      docType: "Photo — not verified",
      certNumber: "SAMPLE-DGH-4419",
      validUntil: iso(400),
      fileName: "sample-crew-dgh-a.jpg",
    }),

    // ---- sample-crew-sent-to-sea — valid now, Medical lapses mid-rotation ----
    gov("sample-doc-cr5-bst", CR_SEA, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-6501",
      validUntil: iso(600),
      requiredType: "Basic Safety Training",
    }),
    gov("sample-doc-cr5-medical", CR_SEA, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      certNumber: "SAMPLE-MED-6502",
      validUntil: iso(45),
      requiredType: "Medical",
    }),
    manual("sample-doc-cr5-seamanbook", CR_SEA, {
      title: "Seaman's Discharge Book",
      docType: "Seaman's book",
      validUntil: iso(1100),
      requiredType: "Seaman book",
    }),
    manual("sample-doc-cr5-passport", CR_SEA, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(800),
      requiredType: "Passport",
    }),

    // ---- sample-crew-returning — neutral manual + forged-duplicate pair B ----
    manual("sample-doc-cr6-bst", CR_RETURNING, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      validUntil: iso(400),
      requiredType: "Basic Safety Training",
    }),
    manual("sample-doc-cr6-medical", CR_RETURNING, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      validUntil: iso(250),
      requiredType: "Medical",
    }),
    photo("sample-doc-cr6-dgh", CR_RETURNING, {
      title: "Dangerous Goods Handling",
      docType: "Photo — not verified",
      certNumber: "SAMPLE-DGH-4419",
      validUntil: iso(400),
      fileName: "sample-crew-dgh-b.jpg",
    }),

    // ---- sample-crew-finished — clean closed-out card ------------------------
    gov("sample-doc-cr7-bst", CR_FINISHED, {
      title: "Basic Safety Training (STCW A-VI/1)",
      docType: "Qualification",
      docCategory: "qualification",
      certNumber: "SAMPLE-BST-6701",
      validUntil: iso(450),
      requiredType: "Basic Safety Training",
    }),
    gov("sample-doc-cr7-medical", CR_FINISHED, {
      title: "Seafarer Medical Fitness Certificate",
      docType: "Medical certificate",
      docCategory: "medical",
      certNumber: "SAMPLE-MED-6702",
      validUntil: iso(180),
      requiredType: "Medical",
    }),
    manual("sample-doc-cr7-seamanbook", CR_FINISHED, {
      title: "Seaman's Discharge Book",
      docType: "Seaman's book",
      validUntil: iso(900),
      requiredType: "Seaman book",
    }),
    manual("sample-doc-cr7-passport", CR_FINISHED, {
      title: "Passport",
      docType: "Passport",
      validUntil: iso(600),
      requiredType: "Passport",
    }),
  ];

  const accessGrants = [
    grant("sample-grant-flagship", F, "accepted"),
    grant("sample-grant-review", CR_REVIEW, "review"),
    grant("sample-grant-docs-pending", CR_DOCS, "review"),
    grant("sample-grant-approved", CR_APPROVED, "accepted"),
    grant("sample-grant-accepted", CR_ACCEPTED, "accepted"),
    grant("sample-grant-sent-to-sea", CR_SEA, "sent_to_sea", {
      legalBasis: "CONTRACT_LEGAL_OBLIGATION",
    }),
    grant("sample-grant-returning", CR_RETURNING, "returning"),
    grant("sample-grant-finished", CR_FINISHED, "finished"),
  ];

  const assignments = [
    // Flagship's COMPLETED voyage (feeds employment/SEA + the appraisal).
    {
      id: "sample-assign-flagship",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      vessel: "MV Sample Aurora",
      sentToSeaAt: iso(-200),
      returnedAt: iso(-20),
      closedReason: "returned",
      requiredSnapshot: null,
      createdAt: iso(-200),
    },
    // LIVE assignment — forces the sent-to-sea grant into derived LOCKED.
    {
      id: "sample-assign-live",
      sample: true,
      seafarerId: CR_SEA,
      agentId: SAMPLE_AGENCY_ID,
      vessel: "MV Sample Aurora",
      sentToSeaAt: iso(-30),
      returnedAt: null,
      closedReason: null,
      requiredSnapshot: null,
      createdAt: iso(-30),
    },
  ];

  const issuedSeaTerms = [
    {
      id: "sample-searec-flagship",
      sample: true,
      assignmentId: "sample-assign-flagship",
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      terms: {
        position: "Chief Officer",
        wageAmount: "4200",
        wageCurrency: "EUR",
        wagePeriod: "month",
        leaveDaysPerMonth: "6",
        contractStart: day(-200),
        durationMonths: "6",
        noticeDays: "30",
        allotment: "40%",
        repatriationBy: "Employer",
      },
      identityVerifiedAtIssue: true,
      issuedBy: AGENCY_NAME,
      generatedAt: iso(-200),
    },
  ];

  const seaService = [
    {
      id: "sample-sea-1",
      sample: true,
      seafarerId: F,
      vessel: "MV Sample Horizon",
      imo: null,
      rank: "Third Officer",
      vesselType: "container",
      flagState: null,
      signOn: day(-1100),
      signOff: day(-920),
      note: null,
      recordedBy: "seaman",
      createdAt: iso(-900),
    },
    {
      id: "sample-sea-2",
      sample: true,
      seafarerId: F,
      vessel: "MV Sample Meridian",
      imo: null,
      rank: "Second Officer",
      vesselType: "general_cargo",
      flagState: null,
      signOn: day(-800),
      signOff: day(-620),
      note: null,
      recordedBy: "seaman",
      createdAt: iso(-600),
    },
    {
      id: "sample-sea-3",
      sample: true,
      seafarerId: F,
      vessel: "MV Sample Aurora",
      imo: null,
      rank: "Chief Officer",
      vesselType: "general_cargo",
      flagState: null,
      signOn: day(-200),
      signOff: day(-20),
      note: "Demonstration voyage — SAMPLE",
      recordedBy: "seaman",
      createdAt: iso(-18),
    },
  ];

  const appraisals = [
    {
      id: "sample-appr-flagship",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      kind: "post_voyage",
      competencySetVersion: "2024.1",
      authorName: STAFFER,
      authorOrg: AGENCY_NAME,
      vessel: "MV Sample Aurora",
      voyageFrom: day(-200),
      voyageTo: day(-20),
      assignmentId: "sample-assign-flagship",
      scores: [
        { competency: "Technical competence", rating: 5 },
        { competency: "Safety & compliance", rating: 5 },
        { competency: "Leadership", rating: 4 },
        { competency: "Teamwork", rating: 5 },
        { competency: "Reliability", rating: 5 },
        { competency: "Communication", rating: 4 },
      ],
      overall: 5,
      recommend: "yes",
      rehireReason: null,
      comments: "Agency-internal note: exemplary cargo-watch discipline. — SAMPLE",
      sharedComment:
        "Excellent voyage — cargo watch handovers were exemplary and the deck team spoke highly of your mentoring. Welcome back aboard any time. — SAMPLE",
      sharedWithSeamanAt: iso(-15),
      hiddenFromAgentAt: null,
      fastPath: false,
      idempotencyKey: "sample-appr-flagship-key",
      createdAt: iso(-15),
      updatedAt: null,
    },
  ];

  const circulars = [
    {
      id: "sample-circ-riga",
      sample: true,
      agentId: SAMPLE_AGENCY_ID,
      authorName: STAFFER,
      subject: "Crew change: Riga rotation schedule update — SAMPLE",
      message:
        "The Riga crew change moves forward by two days: joining crew sign on the 14th, " +
        "off-signers travel home the same evening. Agency transport leaves the seamen's " +
        "club at 06:00. Reply here if the new date is a problem for you. " +
        "(This is fictional demonstration content.)",
      filter: null,
      channel: "email",
      recipientIds: [F, CR_ACCEPTED, CR_SEA, CR_RETURNING],
      delivered: 0,
      allowReplies: true,
      createdAt: iso(-6),
    },
  ];

  const circularReplies = [
    {
      id: "sample-reply-1",
      sample: true,
      circularId: "sample-circ-riga",
      agentId: SAMPLE_AGENCY_ID,
      seafarerId: F,
      authorName: "Marten Sarapuu — SAMPLE",
      body:
        "Confirming I can join in Riga on the 14th — my medical renewal appointment is " +
        "already booked for the Tuesday before. — SAMPLE",
      visibility: "agent",
      idempotencyKey: "sample-reply-1-key",
      createdAt: iso(-5),
    },
    {
      // visibility:"all" — peers see this one ANONYMISED (the demo's peer-reply case).
      id: "sample-reply-2",
      sample: true,
      circularId: "sample-circ-riga",
      agentId: SAMPLE_AGENCY_ID,
      seafarerId: CR_SEA,
      authorName: "Ruta Jankauskiene — SAMPLE",
      body:
        "For anyone routing via Klaipeda: the 06:30 ferry connection works better for " +
        "the new date than the evening one. — SAMPLE",
      visibility: "all",
      idempotencyKey: "sample-reply-2-key",
      createdAt: iso(-4),
    },
    {
      id: "sample-reply-3",
      sample: true,
      circularId: "sample-circ-riga",
      agentId: SAMPLE_AGENCY_ID,
      seafarerId: F,
      authorName: "Marten Sarapuu — SAMPLE",
      body: "Received the updated joining instructions, thank you. — SAMPLE",
      visibility: "agent",
      idempotencyKey: "sample-reply-3-key",
      createdAt: iso(-3),
    },
  ];

  const docRequests = [
    // pending (due in the future)
    {
      id: "sample-dreq-pending",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      requestedBy: STAFFER,
      requiredType: null,
      label: "Yellow fever vaccination certificate",
      note: "Needed for the West Africa call on the next rotation. — SAMPLE",
      dueDate: day(14),
      status: "pending",
      createdAt: iso(-7),
      resolvedAt: null,
      resolvedVia: null,
    },
    // OVERDUE (still pending, dueDate in the past)
    {
      id: "sample-dreq-overdue",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      requestedBy: STAFFER,
      requiredType: "Wage Account",
      label: "Wage account confirmation",
      note: null,
      dueDate: day(-5),
      status: "pending",
      createdAt: iso(-25),
      resolvedAt: null,
      resolvedVia: null,
    },
    // received via UPLOAD auto-clear (the medical upload satisfied it)
    {
      id: "sample-dreq-upload",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      requestedBy: STAFFER,
      requiredType: "Medical",
      label: "Renewed medical fitness certificate",
      note: null,
      dueDate: day(-25),
      status: "received",
      createdAt: iso(-35),
      resolvedAt: iso(-30),
      resolvedVia: "upload",
    },
    // received via AGENT approve
    {
      id: "sample-dreq-agent",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      requestedBy: STAFFER,
      requiredType: null,
      label: "Signed pre-joining checklist",
      note: null,
      dueDate: null,
      status: "received",
      createdAt: iso(-18),
      resolvedAt: iso(-12),
      resolvedVia: "agent",
    },
    // waived
    {
      id: "sample-dreq-waived",
      sample: true,
      seafarerId: F,
      agentId: SAMPLE_AGENCY_ID,
      requestedBy: STAFFER,
      requiredType: "Tanker Familiarisation",
      label: "Tanker familiarisation refresher",
      note: "Not needed — next berth is general cargo. — SAMPLE",
      dueDate: null,
      status: "waived",
      createdAt: iso(-15),
      resolvedAt: iso(-10),
      resolvedVia: "agent",
    },
  ];

  const restHours = [11, 12, 11, 13, 12, 11, 12].map((h, i) => ({
    id: `sample-rest-${i + 1}`,
    sample: true,
    seafarerId: CR_SEA,
    date: day(-(7 - i)),
    hoursRest: h,
    createdAt: iso(-1),
  }));

  // Sample required-docs config for the agency (literal copy of the 2024.1
  // baseline defaults from lib/required-docs.ts — sanitizeConfig falls back
  // gracefully if the baseline ever moves).
  const requiredDocsConfigs = [
    {
      agentId: SAMPLE_AGENCY_ID,
      baselineVersion: "2024.1",
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
      perFlagRequired: {
        estonia: [],
        eu_other: [],
        panama: [],
        liberia: [],
        marshall_islands: [],
        other: [],
      },
      updatedAt: iso(-30),
      updatedBy: STAFFER,
    },
  ];

  return {
    agents,
    seafarers,
    documents,
    accessGrants,
    assignments,
    issuedSeaTerms,
    seaService,
    appraisals,
    circulars,
    circularReplies,
    docRequests,
    restHours,
    requiredDocsConfigs,
  };
}

// ---- Sample-row predicates ---------------------------------------------------

const isSamplePrefixed = (v) => typeof v === "string" && v.startsWith(SAMPLE_PREFIX);
/** A row the SEED itself owns (safe to delete on every run — plain seed scope). */
const isSeedOwnedRow = (r) =>
  r != null &&
  (r.sample === true || r.isSample === true || isSamplePrefixed(r.id));

/** Collections whose sample-agency-owned rows carry no id/sample flag. */
const AGENT_KEYED = ["requiredDocsConfigs", "requiredDocsAudit", "vacancies"];

/**
 * Plain-seed cleanup: remove ONLY seed-owned rows from every collection.
 * Real rows — including real interactions that reference sample ids — stay.
 */
export function removeSampleRows(db) {
  for (const key of Object.keys(db)) {
    if (!Array.isArray(db[key])) continue;
    db[key] = db[key].filter((r) => !isSeedOwnedRow(r));
  }
  for (const key of AGENT_KEYED) {
    if (!Array.isArray(db[key])) continue;
    db[key] = db[key].filter((r) => !isSamplePrefixed(r?.agentId));
  }
}

/** Ensure every collection the seed inserts into exists (older db shapes). */
function ensureCollections(db, data) {
  for (const key of Object.keys(data)) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
}

/** ADDITIVE + IDEMPOTENT seed: clean seed-owned rows, re-insert the curated set. */
export function applySeed(db) {
  const data = buildSampleData();
  ensureCollections(db, data);
  removeSampleRows(db);
  for (const key of Object.keys(data)) {
    for (const row of data[key]) db[key].push(row);
  }
  return data;
}

/**
 * --remove cascade (plan v4-5a): delete every sample-id row AND every real row
 * referencing a sample id; strip-don't-delete for shared rows. Returns the
 * uploads/ file names to delete (collected from EVERY doc row with a sample
 * seafarerId — including agent-uploaded arbitrary names — plus sample
 * seafarers' photo files) BEFORE their rows are dropped.
 */
export function applyRemove(db) {
  const sampleSeafarerIds = new Set([SAMPLE_FLAGSHIP_ID, ...SAMPLE_CREW_IDS]);
  const sampleAgentIds = new Set([SAMPLE_AGENCY_ID]);
  for (const s of db.seafarers ?? []) {
    if (s.isSample === true || isSamplePrefixed(s.id)) sampleSeafarerIds.add(s.id);
  }
  for (const a of db.agents ?? []) {
    if (a.isSample === true || isSamplePrefixed(a.id)) sampleAgentIds.add(a.id);
  }
  const S = (v) => sampleSeafarerIds.has(v);
  const A = (v) => sampleAgentIds.has(v);

  // Upload-file collection FIRST (v4-5a): every doc row on a sample subject,
  // whatever its fileName, plus sample seafarers' stored photo files.
  const uploadFileNames = new Set();
  const sampleDocIds = new Set();
  for (const d of db.documents ?? []) {
    if (isSeedOwnedRow(d) || S(d.seafarerId)) {
      sampleDocIds.add(d.id);
      if (d.fileName) uploadFileNames.add(d.fileName);
    }
  }
  for (const s of db.seafarers ?? []) {
    if (!S(s.id)) continue;
    if (s.verifiedPhotoFile) uploadFileNames.add(s.verifiedPhotoFile);
    if (s.customPhotoFile) uploadFileNames.add(s.customPhotoFile);
  }

  const drop = (key, refPred) => {
    if (!Array.isArray(db[key])) return;
    db[key] = db[key].filter((r) => !(isSeedOwnedRow(r) || refPred(r)));
  };

  drop("documents", (r) => S(r.seafarerId));
  drop("comments", (r) => S(r.seafarerId) || sampleDocIds.has(r.documentId));
  drop("restHours", (r) => S(r.seafarerId));
  drop("seaService", (r) => S(r.seafarerId));
  drop("profileChanges", (r) => S(r.seafarerId));
  drop("docRequests", (r) => S(r.seafarerId) || A(r.agentId));
  drop("appraisals", (r) => S(r.seafarerId) || A(r.agentId));
  drop("appraisalDeleteRequests", (r) => S(r.seafarerId) || A(r.agentId));
  drop("profileShareRequests", (r) => S(r.seafarerId) || A(r.agentId) || A(r.fromAgentId) || A(r.toAgentId));
  drop("assignments", (r) => S(r.seafarerId) || A(r.agentId));
  drop("accessGrants", (r) => S(r.seafarerId) || A(r.agentId));
  drop("issuedSeaTerms", (r) => S(r.seafarerId) || A(r.agentId));
  drop("circularReplies", (r) => S(r.seafarerId) || A(r.agentId));
  drop("notifications", (r) => S(r.seafarerId));
  drop("remindersSent", (r) => S(r.seafarerId) || sampleDocIds.has(r.docId));
  drop("vacancies", (r) => A(r.agentId));
  drop("requiredDocsConfigs", (r) => A(r.agentId));
  drop("requiredDocsAudit", (r) => A(r.agentId));
  drop("credentialUsers", (r) => S(r.seafarerId) || A(r.agentId));
  // Impersonations: belt-and-braces generic scan — any string field that names
  // a sample identity.
  drop("impersonations", (r) =>
    Object.values(r ?? {}).some((v) => typeof v === "string" && (S(v) || A(v)))
  );

  // Shared rows — STRIP, never delete (drop only when recipients become empty).
  if (Array.isArray(db.circulars)) {
    db.circulars = db.circulars
      .filter((c) => !(isSeedOwnedRow(c) || A(c.agentId)))
      .map((c) => {
        if (!Array.isArray(c.recipientIds) || !c.recipientIds.some(S)) return c;
        c.recipientIds = c.recipientIds.filter((id) => !S(id));
        return c;
      })
      .filter((c) => !Array.isArray(c.recipientIds) || c.recipientIds.length > 0);
  }
  if (Array.isArray(db.clientPortals)) {
    db.clientPortals = db.clientPortals.filter((p) => !(isSeedOwnedRow(p) || A(p.agentId)));
    for (const p of db.clientPortals) {
      if (Array.isArray(p.seafarerIds) && p.seafarerIds.some(S)) {
        p.seafarerIds = p.seafarerIds.filter((id) => !S(id));
      }
    }
  }

  // The sample rows themselves, last.
  db.seafarers = (db.seafarers ?? []).filter((s) => !(s.isSample === true || isSamplePrefixed(s.id)));
  db.agents = (db.agents ?? []).filter((a) => !(a.isSample === true || isSamplePrefixed(a.id)));

  return { uploadFileNames: [...uploadFileNames] };
}

// ---- File IO -----------------------------------------------------------------

function readDbFile(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `db.json not found at ${dbPath} — the sample seed is ADDITIVE and refuses to create a database.`
    );
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
}

function writeDbFile(dbPath, db) {
  const tmp = `${dbPath}.sample-seed.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tmp, dbPath);
}

/** Copy fixtures into uploads/ and delete stale sample-*.jpg no longer curated. */
function syncUploads(uploadsDir, seededFileNames) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const current = new Set(seededFileNames);
  for (const name of current) {
    const src = path.join(FIXTURES_DIR, name);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing fixture ${name} in ${FIXTURES_DIR} — run generate-sample-docs.mjs.`);
    }
    fs.copyFileSync(src, path.join(uploadsDir, name));
  }
  for (const name of fs.readdirSync(uploadsDir)) {
    if (name.startsWith(SAMPLE_PREFIX) && /\.jpg$/i.test(name) && !current.has(name)) {
      fs.unlinkSync(path.join(uploadsDir, name));
    }
  }
}

/**
 * Run the seed (or --remove) against `root` (defaults to the app dir this
 * script lives in — /opt/docka on the box). Exported for the test suite, which
 * always points it at a TEMP COPY, never a live db.
 */
export function runSeed({ root = DEFAULT_ROOT, remove = false } = {}) {
  const dbPath = path.join(root, "data", "db.json");
  const uploadsDir = path.join(root, "uploads");
  const db = readDbFile(dbPath);

  if (remove) {
    const { uploadFileNames } = applyRemove(db);
    let deleted = 0;
    for (const name of uploadFileNames) {
      // Uploads are stored flat; refuse anything path-shaped (defensive).
      if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) continue;
      const p = path.join(uploadsDir, name);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        deleted += 1;
      }
    }
    writeDbFile(dbPath, db);
    return { removed: true, deletedUploadFiles: deleted };
  }

  const data = applySeed(db);
  const seededFileNames = data.documents.map((d) => d.fileName).filter(Boolean);
  syncUploads(uploadsDir, seededFileNames);
  writeDbFile(dbPath, db);
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  return { removed: false, counts, copiedUploads: seededFileNames.length };
}

// ---- CLI ---------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const remove = process.argv.includes("--remove");
  const rootArg = process.argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? path.resolve(rootArg.slice("--root=".length)) : DEFAULT_ROOT;
  const result = runSeed({ root, remove });
  if (result.removed) {
    console.log(
      `Sample data removed (cascading). Deleted ${result.deletedUploadFiles} upload file(s).`
    );
  } else {
    console.log("Sample data seeded (additive + idempotent):");
    for (const [k, v] of Object.entries(result.counts)) console.log(`  ${k}: ${v}`);
    console.log(`  uploads copied: ${result.copiedUploads}`);
  }
}
