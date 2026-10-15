// CURATED demo seed — replaces the whole fleet with a small, hand-picked set
// where EVERY seafarer card demonstrates a DIFFERENT status / error variance, so
// the owner can see all of them at a glance. Spread evenly across all five
// pipeline states (review / accepted / sent_to_sea / returning / finished).
//
// This DELETES all existing seafarers/documents/rest-hours and writes ONLY the
// curated set. The big-scale scripts/seed.mjs is left untouched.
//
//   Run with:  npm run seed:curated
//
// How the model renders each variance (learned from lib/cert.ts docBadge,
// lib/compliance.ts assignmentBlockers, lib/doctypes completeness,
// lib/duplicates, lib/rest-hours):
//   - government + future(>60d)  -> emerald "Valid"
//   - government + <60d          -> amber  "Expiring soon"
//   - government + past          -> red    "Expired"
//   - photo + future (unconfirmed expiry) -> amber "Not verified · confirm expiry"
//   - manual + future (confirmed) -> neutral "Not verified"
//   - missing required type       -> completeness gap -> red "Missing" attention row
//   - same cert number on 2+ crew -> "Possible duplicate/forgery" (blocks sea-ready)
//   - doc valid today but lapses before rotationEnd -> "Expires early" (blocks)
//   - no rest-hour entries        -> "No rest hours logged"
//   - medical doc + crewing role  -> "Health data — restricted"
//
// IMPORTANT: every government document gets a UNIQUE registry code, because the
// code doubles as the fleet-wide duplicate-detection number. Only the ONE
// deliberate forged-cert number is shared across crew.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "db.json");

const uuid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(9).toString("base64url");

// ISO date offset by `days` from today (00:00 UTC).
function iso(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
const VALID = () => iso(700); // comfortably valid (> 60 days)
const EXPIRING = () => iso(40); // within the 60-day amber window
const EXPIRED = () => iso(-30); // lapsed
const ROT_LAPSE = () => iso(45); // valid today, lapses mid-rotation
const ROT_END = () => iso(180); // planned end of rotation

// Unique registry code generator (also the duplicate-detection number).
let codeSeq = 0;
const nextCode = () => `EEGOV${String(++codeSeq).padStart(4, "0")}`;

// The ONE deliberately-forged certificate number, shared across three crew.
const FORGED_NUMBER = "STCW-EE-2019-88231";

const seafarers = [];
const documents = [];
const restHours = [];

const META = {
  "Basic Safety Training": { docType: "Qualification", docCategory: "qualification", title: "Basic Safety Training" },
  Medical: { docType: "Medical certificate", docCategory: "medical", title: "Medical certificate" },
  Endorsement: { docType: "Endorsement", docCategory: "endorsement", title: "Flag State Endorsement (Panama)" },
  "Seaman book": { docType: "Seaman's book", docCategory: null, title: "Seaman's Book" },
  Passport: { docType: "Passport", docCategory: null, title: "Passport" },
};

function baseDoc(seafarerId, o) {
  const validUntil = o.validUntil ?? null;
  return {
    id: uuid(),
    seafarerId,
    title: o.title,
    docType: o.docType,
    docCategory: o.docCategory ?? null,
    estonianCode: o.estonianCode ?? null,
    certNumber: o.certNumber ?? o.estonianCode ?? null,
    isValid: o.isValid ?? (validUntil ? new Date(validUntil).getTime() > Date.now() : null),
    validUntil,
    expiryConfirmed: o.expiryConfirmed ?? (o.source === "photo" ? false : true),
    fileName: null,
    createdAt: o.createdAt ?? iso(-20),
    source: o.source,
    requiredType: o.requiredType ?? null,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
  };
}

// A government-registry-verified document for a required type (emerald when valid).
function gov(seafarerId, type, opts = {}) {
  const m = META[type];
  return baseDoc(seafarerId, {
    source: "government",
    requiredType: type,
    docType: m.docType,
    docCategory: m.docCategory,
    title: opts.title ?? m.title,
    estonianCode: opts.code ?? nextCode(),
    validUntil: opts.validUntil ?? VALID(),
    isValid: opts.isValid,
    expiryConfirmed: true,
  });
}

// A manually-typed document (neutral "Not verified", never green).
function manual(seafarerId, type, opts = {}) {
  const m = META[type];
  return baseDoc(seafarerId, {
    source: "manual",
    requiredType: type,
    docType: m.docType,
    docCategory: null,
    title: opts.title ?? m.title,
    estonianCode: null,
    certNumber: null,
    validUntil: opts.validUntil ?? VALID(),
    expiryConfirmed: true,
  });
}

// A photo upload with an OCR-guessed (unconfirmed) expiry -> amber "confirm expiry".
function photo(seafarerId, type, opts = {}) {
  const m = type ? META[type] : null;
  return baseDoc(seafarerId, {
    source: "photo",
    requiredType: type ?? null,
    docType: opts.docType ?? (m ? m.docType : "Photo — not verified"),
    docCategory: null,
    title: opts.title ?? (m ? m.title : "Uploaded photo"),
    estonianCode: null,
    certNumber: opts.certNumber ?? null,
    validUntil: opts.validUntil ?? VALID(),
    expiryConfirmed: false,
  });
}

const REQUIRED = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];

// Register a seafarer + its documents.
function add(sf, docs) {
  const id = uuid();
  seafarers.push({
    id,
    name: sf.name,
    rank: sf.rank,
    state: sf.state,
    shareToken: token(),
    createdAt: sf.createdAt ?? iso(-randInt(5, 90)),
    vessel: sf.vessel,
    rotationEnd: sf.rotationEnd ?? null,
  });
  for (const mk of docs) documents.push(mk(id));
  return id;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pushRest(seafarerId, startDaysAgo, hoursByDay) {
  hoursByDay.forEach((h, idx) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (startDaysAgo - idx));
    restHours.push({
      id: uuid(),
      seafarerId,
      date: d.toISOString().slice(0, 10),
      hoursRest: h,
      createdAt: new Date().toISOString(),
    });
  });
}

// ---- The curated set -----------------------------------------------------
// Each entry: one primary variance, spread across the five pipeline states.

// 1. Fully verified, complete 5/5, sea-ready YES — all green reference card.
const katrin = add(
  { name: "Katrin Meri", rank: "Master", state: "accepted", vessel: "MV Baltic Trader" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => gov(id, "Seaman book"), // curated best-case: registry-backed -> green
    (id) => gov(id, "Passport"),
  ]
);
pushRest(katrin, 9, [11, 12, 11, 13, 12, 11, 12, 11, 12, 11]); // compliant

// 2. Jaan Sample — the TWO REAL Estonian codes, each stored ONCE, verified, sea-ready.
const jaanSample = add(
  { name: "Jaan Sample", rank: "Chief Officer", state: "accepted", vessel: "MV Baltic Trader" },
  [
    (id) =>
      gov(id, "Basic Safety Training", {
        title: "Ohutusalase koolituse tunnistus (Safety Training)",
        code: "SAMPLE0SAFETY001",
        validUntil: "2027-03-28T00:00:00.000Z",
      }),
    (id) =>
      gov(id, "Medical", {
        code: "SAMPLE0MEDICAL01",
        validUntil: "2027-02-19T00:00:00.000Z",
      }),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);
pushRest(jaanSample, 9, [12, 11, 12, 12, 11, 12, 11, 12, 12, 11]); // compliant

// 3. One EXPIRED required document -> sea-ready NO.
const marek = add(
  { name: "Marek Tamm", rank: "Second Engineer", state: "review", vessel: "MV Nordic Star" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement", { validUntil: EXPIRED(), isValid: false }), // red "Expired"
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 4. One EXPIRING-SOON document (amber) — still sea-ready (a warning, not a block).
const priit = add(
  { name: "Priit Saar", rank: "Third Officer", state: "sent_to_sea", vessel: "MV Tallinn Express" },
  [
    (id) => gov(id, "Basic Safety Training", { title: "Advanced Fire Fighting", validUntil: EXPIRING() }), // amber
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 5. MISSING required documents (only 2 of 5 on file) -> sea-ready NO.
const toomas = add(
  { name: "Toomas Kask", rank: "Bosun", state: "review", vessel: "MV Gulf Pioneer" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => manual(id, "Passport"),
    // Missing: Medical, Endorsement, Seaman book.
  ]
);

// 6. PHOTO-ONLY unverified upload — amber "Not verified · confirm expiry".
const rui = add(
  { name: "Rui Santos", rank: "Able Seaman", state: "returning", vessel: "MV Saaremaa" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => photo(id, "Endorsement", { title: "Flag State Endorsement (Liberia)", certNumber: "RUI-END-2024-0091" }),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 7. MANUAL typed document — neutral "Not verified" (never green).
const andres = add(
  { name: "Andres Magi", rank: "Motorman", state: "sent_to_sea", vessel: "MV Helios" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => manual(id, "Endorsement", { title: "Flag State Endorsement (Marshall Islands)" }), // neutral
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 8. Has a MEDICAL document — shown in full (medical gating is OFF, owner D3).
const deepak = add(
  { name: "Deepak Nair", rank: "Chief Engineer", state: "finished", vessel: "MV Baltic Trader" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 9. DUPLICATE-CERTIFICATE pair A — shares FORGED_NUMBER -> "possible forgery".
const oleksandr = add(
  { name: "Oleksandr Kovalenko", rank: "Oiler", state: "finished", vessel: "MV Nordic Star" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
    (id) => photo(id, null, { title: "Dangerous Goods Handling", certNumber: FORGED_NUMBER }),
  ]
);

// 10. DUPLICATE-CERTIFICATE pair B — same FORGED_NUMBER on a different seafarer.
const viktor = add(
  { name: "Viktor Petrov", rank: "Fitter", state: "returning", vessel: "MV Gulf Pioneer" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
    (id) => photo(id, null, { title: "Dangerous Goods Handling", certNumber: FORGED_NUMBER }),
  ]
);

// 11. NO REST HOURS logged — otherwise clean & sea-ready.
const nikolai = add(
  { name: "Nikolai Sidorov", rank: "Pumpman", state: "sent_to_sea", vessel: "MV Tallinn Express" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
); // deliberately no pushRest -> "No rest hours logged"

// 12. ROTATION LAPSE — endorsement valid today but lapses before rotation ends.
const ranel = add(
  {
    name: "Ranel Berg",
    rank: "Second Officer",
    state: "accepted",
    vessel: "MV Saaremaa",
    rotationEnd: ROT_END(),
  },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement", { validUntil: ROT_LAPSE() }), // valid now, lapses mid-voyage
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 13. MESSY mixed case — one expired + two missing + a duplicate. sea-ready NO.
const sergei = add(
  { name: "Sergei Popov", rank: "Third Engineer", state: "review", vessel: "MV Helios" },
  [
    (id) => gov(id, "Basic Safety Training", { validUntil: EXPIRED(), isValid: false }), // expired
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    // Missing: Seaman book, Passport.
    (id) => photo(id, null, { title: "Dangerous Goods Handling", certNumber: FORGED_NUMBER }), // duplicate
  ]
);
pushRest(sergei, 9, [9, 8, 10, 9, 8, 9, 10, 9, 8, 9]); // ILO violations (<10h days, <77h/7d)

// 14. Clean FINISHED contract — all good.
const mikael = add(
  { name: "Mikael Lind", rank: "Ship's Cook", state: "finished", vessel: "MV Baltic Trader" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// 15. Clean COMING-BACK (returning) card — all good.
const erik = add(
  { name: "Erik Johansen", rank: "Electro-Technical Officer", state: "returning", vessel: "MV Nordic Star" },
  [
    (id) => gov(id, "Basic Safety Training"),
    (id) => gov(id, "Medical"),
    (id) => gov(id, "Endorsement"),
    (id) => manual(id, "Seaman book"),
    (id) => manual(id, "Passport"),
  ]
);

// ---- EU VerifierRegistry demo states (plan §7.9, increment 9) -----------------
// Four extra crew, one per NEW registry state, so the agent board demos them all
// at a glance. Field shapes mirror EXACTLY what the live paste/review routes
// write (captured from a real mock-mode run) — see lib/registry + docBadge:
//   - DK  source:"government" + registryCountry:"DK"  -> emerald (machine-verified)
//   - GR  manual + checkedVia:"registry-portal"       -> blue "Checked against registry"
//   - RO  manual + manualVerification.requested       -> violet "Verification requested"
//   - BG  source:"registry" (presence-only)           -> teal "Registry-confirmed — holder not verified"

// 16. DK machine-verified via the Danish Maritime Authority (QR capability token).
const lars = add(
  { name: "Lars Holm", rank: "Master", state: "accepted", vessel: "MV Nordic Star" },
  [
    (id) => ({
      ...gov(id, "Basic Safety Training", { code: "70019876", validUntil: VALID() }),
      title: "Certificate of Competency as Master",
      docType: "Certificate of competency",
      docCategory: "competency",
      registryCountry: "DK",
      verifiedResolvedAt: iso(-4),
      verifiedKeyTrust: "capability-token",
      verifiedFirstName: "LARS",
      verifiedLastName: "HOLM",
      verifiedFullName: "LARS HOLM",
      verifiedPersonalCode: null,
      verifiedBirthDate: null,
      verifiedPhotoUrl: null,
      verifiedIssuerCountry: "Denmark",
    }),
    (id) => manual(id, "Seaman book"),
  ]
);

// 17. GR assisted-checked — agent confirmed it on the pinned HCG portal (blue, never emerald).
const giorgos = add(
  { name: "Giorgos Papadopoulos", rank: "Chief Officer", state: "review", vessel: "MV Helios" },
  [
    (id) => ({
      ...manual(id, "Basic Safety Training", { title: "STCW Certificate (Hellenic Coast Guard)" }),
      certNumber: "https://stcw.hcg.gr/verify-stcw/GR20770045",
      registryCountry: "GR",
      reviewerChecked: true,
      checkedBy: "Dev Agent (demo)",
      checkedAt: iso(-3),
      checkedVia: "registry-portal",
    }),
    (id) => manual(id, "Passport"),
  ]
);

// 18. RO manual verification REQUESTED from the Romanian Naval Authority (violet outcome).
const andrei = add(
  { name: "Andrei Ionescu", rank: "Second Officer", state: "review", vessel: "MV Gulf Pioneer" },
  [
    (id) => ({
      ...manual(id, "Basic Safety Training", { title: "Certificat de competenta (RNA)" }),
      certNumber: "https://portal.rna.ro/verify/RO771230",
      registryCountry: "RO",
      manualVerification: {
        status: "requested",
        requestedAt: iso(-2),
        requestedBy: "Andrei Ionescu",
        confirmedAt: null,
        confirmedBy: null,
      },
    }),
    (id) => manual(id, "Passport"),
  ]
);

// 19. BG registry-presence doc — document confirmed in the registry, holder NOT verified (teal).
const stoyan = add(
  { name: "Stoyan Dimitrov", rank: "Able Seaman", state: "review", vessel: "MV Saaremaa" },
  [
    (id) => ({
      ...baseDoc(id, {
        source: "registry",
        requiredType: "Basic Safety Training",
        docType: "Certificate of competency",
        docCategory: "competency",
        title: "Bulgarian certificate — registry-confirmed (covers 2017+)",
        estonianCode: "551234",
        certNumber: "551234",
        isValid: true,
        validUntil: null,
        expiryConfirmed: true,
      }),
      registryCountry: "BG",
      verifiedResolvedAt: iso(-1),
      verifiedKeyTrust: "public-identifier",
      verifiedIssuerCountry: "Bulgaria",
    }),
    (id) => manual(id, "Seaman book"),
  ]
);

// ---- Multi-tenant consent layer (agents, grants, assignments, access log) ----
// Demonstrates: isolation (each agent sees only its granted seafarers), overlap (a
// seafarer granting two agents), a HARD sea-lock (LOCKED, derived from a live
// assignment), and REVOKED grants. Timestamps are UTC ISO-8601.

function isoAt(daysAgo, hour = 9) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

// Demo agents. `dev` keeps the legacy test door working (as a proper, but still
// grant-scoped, tenant). Each Google account would be its own agent in production.
const agents = [
  { id: "dev", orgName: "Dev Agent (demo)", contact: "dev@localhost", createdAt: iso(-120) },
  { id: "agent:maria", orgName: "Baltic Crewing OÜ", contact: "maria@baltic-crewing.example.com", createdAt: iso(-110) },
  { id: "agent:priya", orgName: "Oceanic Manning Ltd", contact: "priya@oceanic-manning.example.com", createdAt: iso(-100) },
  { id: "agent:jaan", orgName: "Nordic Marine Staffing", contact: "jaan@nordic-marine.example.com", createdAt: iso(-95) },
  { id: "agent:olena", orgName: "BlackSea Crew Co", contact: "olena@blacksea-crew.example.com", createdAt: iso(-80) },
  { id: "agent:nikos", orgName: "Aegean Maritime Agency", contact: "nikos@aegean-maritime.example.com", createdAt: iso(-70) },
];

// A grant. `status` is the STORED base status (PENDING/ACTIVE/REVOKED/EXPIRED);
// LOCKED is DERIVED at request time from a live assignment (never stored).
function grant(seafarerId, agentId, status = "ACTIVE", opts = {}) {
  return {
    id: uuid(),
    seafarerId,
    agentId,
    status,
    legalBasis: status === "REVOKED" ? "CONSENT" : (opts.legalBasis ?? "CONSENT"),
    scope: ["profile", "documents", "log"],
    shareToken: token(),
    grantedAt: opts.grantedAt ?? iso(-40),
    revokedAt: status === "REVOKED" ? (opts.revokedAt ?? iso(-5)) : null,
    expiresAt: opts.expiresAt ?? null,
    createdAt: opts.createdAt ?? iso(-40),
  };
}

const accessGrants = [
  // Maria — 4 active + Priit LOCKED (live assignment below).
  grant(katrin, "agent:maria"),
  grant(jaanSample, "agent:maria"),
  grant(marek, "agent:maria"),
  grant(deepak, "agent:maria"),
  grant(priit, "agent:maria", "ACTIVE", { legalBasis: "CONTRACT_LEGAL_OBLIGATION" }),
  // Priya — overlaps on Katrin (Katrin will see two agents).
  grant(rui, "agent:priya"),
  grant(andres, "agent:priya"),
  grant(toomas, "agent:priya"),
  grant(katrin, "agent:priya"),
  // Jaan — includes Nikolai LOCKED (live assignment) and a REVOKED grant (Jaan Sample).
  grant(sergei, "agent:jaan"),
  grant(nikolai, "agent:jaan", "ACTIVE", { legalBasis: "CONTRACT_LEGAL_OBLIGATION" }),
  grant(ranel, "agent:jaan"),
  grant(jaanSample, "agent:jaan", "REVOKED"),
  // Olena — EXCLUSIVE seafarers (isolation proof: no other agent sees these).
  grant(oleksandr, "agent:olena"),
  grant(viktor, "agent:olena"),
  grant(mikael, "agent:olena"),
  // Nikos — overlaps on Deepak, plus a REVOKED grant (Marek).
  grant(erik, "agent:nikos"),
  grant(deepak, "agent:nikos"),
  grant(marek, "agent:nikos", "REVOKED"),
  // dev tenant — a small scoped board so the legacy door still shows scoping,
  // plus the four EU VerifierRegistry demo states (§7.9) so the demo board
  // shows emerald(DK) / blue(GR) / violet(RO) / teal(BG) side by side.
  grant(katrin, "dev"),
  grant(jaanSample, "dev"),
  grant(marek, "dev"),
  grant(lars, "dev"),
  grant(giorgos, "dev"),
  grant(andrei, "dev"),
  grant(stoyan, "dev"),
];

// Live assignments (returnedAt=null) — each forces its (seafarer,agent) grant LOCKED.
const assignments = [
  {
    id: uuid(),
    seafarerId: priit,
    agentId: "agent:maria",
    vessel: "MV Tallinn Express",
    sentToSeaAt: iso(-30),
    returnedAt: null,
    closedReason: null,
    requiredSnapshot: null,
    createdAt: iso(-30),
  },
  {
    id: uuid(),
    seafarerId: nikolai,
    agentId: "agent:jaan",
    vessel: "MV Tallinn Express",
    sentToSeaAt: iso(-20),
    returnedAt: null,
    closedReason: null,
    requiredSnapshot: null,
    createdAt: iso(-20),
  },
];

const grantId = (seafarerId, agentId) =>
  accessGrants.find((g) => g.seafarerId === seafarerId && g.agentId === agentId)?.id ?? null;

// Seed a handful of access-log entries so the seaman's "Access & reviews" view has
// real, distinct REVIEW-level activity to show. VIEWED = a list/card view; the rest
// are REVIEW-level (opened profile / a document / exported).
const logCores = [
  { seafarerId: katrin, agentId: "agent:maria", action: "VIEWED", documentRef: null, at: isoAt(6, 8) },
  { seafarerId: katrin, agentId: "agent:maria", action: "REVIEWED", documentRef: null, at: isoAt(6, 9) },
  { seafarerId: katrin, agentId: "agent:priya", action: "VIEWED", documentRef: null, at: isoAt(4, 10) },
  { seafarerId: katrin, agentId: "agent:priya", action: "REVIEWED", documentRef: null, at: isoAt(3, 11) },
  { seafarerId: jaanSample, agentId: "agent:maria", action: "REVIEWED", documentRef: null, at: isoAt(5, 14) },
  { seafarerId: marek, agentId: "agent:maria", action: "REVIEWED", documentRef: null, at: isoAt(2, 9) },
  { seafarerId: priit, agentId: "agent:maria", action: "REVIEWED", documentRef: null, at: isoAt(1, 16) },
  { seafarerId: deepak, agentId: "agent:nikos", action: "EXPORTED", documentRef: null, at: isoAt(2, 12) },
  { seafarerId: deepak, agentId: "agent:maria", action: "VIEWED", documentRef: null, at: isoAt(7, 9) },
  { seafarerId: sergei, agentId: "agent:jaan", action: "REVIEWED", documentRef: null, at: isoAt(3, 15) },
  { seafarerId: nikolai, agentId: "agent:jaan", action: "REVIEWED", documentRef: null, at: isoAt(1, 10) },
  { seafarerId: oleksandr, agentId: "agent:olena", action: "REVIEWED", documentRef: null, at: isoAt(4, 13) },
].map((c) => ({
  id: uuid(),
  at: c.at,
  seafarerId: c.seafarerId,
  agentId: c.agentId,
  grantId: grantId(c.seafarerId, c.agentId),
  action: c.action,
  documentRef: c.documentRef,
}));

// ---- Hash-chained audit sink (must match lib/db.ts chainHash exactly) ---------
const GENESIS = "GENESIS";
function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}
function chainHash(prevHash, core) {
  return crypto.createHash("sha256").update(`${prevHash}|${stableStringify(core)}`).digest("hex");
}
function writeSink(file, cores) {
  let prev = GENESIS;
  const lines = cores.map((core) => {
    const hash = chainHash(prev, core);
    const entry = { ...core, prevHash: prev, hash };
    prev = hash;
    return JSON.stringify(entry);
  });
  fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
}

// ---- Attach real uploaded sample images ---------------------------------------
// A seeded document gets a fileName ONLY when a real file for it actually exists
// in uploads/. Documents without a real file keep fileName:null and render the
// neutral placeholder — never a dead /api/files link (which 404s as a broken
// thumbnail). Whatever image files are present in uploads/ are assigned, in a
// deterministic order, to the first documents — so the demo shows genuine
// certificate images where files exist and placeholders everywhere else. On a host
// with an empty uploads/ every document is file-less (all placeholders); nothing
// is ever pointed at a missing file.
const UPLOAD_DIR = path.join(ROOT, "uploads");
function availableUploadFiles() {
  try {
    return fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}
const uploadFiles = availableUploadFiles();
documents.forEach((doc, i) => {
  doc.fileName = i < uploadFiles.length ? uploadFiles[i] : null;
});
console.log(
  `Attached ${Math.min(uploadFiles.length, documents.length)} real upload(s); ` +
    `${documents.length - Math.min(uploadFiles.length, documents.length)} document(s) file-less (placeholder).`
);

// ---- Write (DELETES everything previous) ---------------------------------
const db = {
  seafarers,
  documents,
  comments: [],
  restHours,
  agents,
  assignments,
  accessGrants,
  requiredDocsConfigs: [],
  requiredDocsAudit: [],
};
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");

// Audit sinks live alongside db.json. Seed the access log; start consent-events
// empty (the app appends to it as grants/assignments change).
writeSink(path.join(ROOT, "data", "access-log.ndjson"), logCores);
writeSink(path.join(ROOT, "data", "consent-events.ndjson"), []);

// ---- Summary -------------------------------------------------------------
const STATES = ["review", "accepted", "sent_to_sea", "returning", "finished"];
const byState = STATES.reduce((acc, s) => {
  acc[s] = seafarers.filter((x) => x.state === s).length;
  return acc;
}, {});
console.log(`Curated seed written: ${seafarers.length} seafarers, ${documents.length} documents.`);
console.log("By state:", byState);
console.log(`Forged cert number ${FORGED_NUMBER} shared across 3 crew (dup demo).`);
console.log(
  `Multi-tenant: ${agents.length} agents, ${accessGrants.length} grants, ` +
    `${assignments.length} live assignments (LOCKED), ${logCores.length} access-log entries.`
);
