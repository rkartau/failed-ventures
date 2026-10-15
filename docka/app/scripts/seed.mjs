// Seed the JSON store with a realistic fleet so the agent dashboard looks real
// at scale: 80+ seafarers spread across all five pipeline states, each with a
// varied mix of documents whose expiry dates land across valid / expiring-soon
// (<60 days) / expired, AND whose REQUIRED-type coverage varies — some crew are
// fully complete, most are missing one or two required documents. That variation
// is what makes the agent's "Problems" and "Missing documents" filters narrow to
// a real shortlist instead of matching the whole fleet.
//
// Every seeded document carries an explicit `requiredType` (Basic Safety
// Training / Medical / Endorsement / Seaman book / Passport) so completeness is
// correct without re-classification. (lib/db.ts also classifies at read time as
// a safety net for legacy rows.)
//
// IMPORTANT: one seeded seafarer (Jaan Sample) carries the two REAL Estonian
// verification codes so live verification works in the demo:
//   - SAMPLE0SAFETY001  safety training (endpoint 1, competency)
//   - SAMPLE0MEDICAL01  medical         (endpoint 2, medical, valid until 2027-02-19)
//
// Run with: npm run seed

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "db.json");

const uuid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(9).toString("base64url");

const STATES = ["review", "accepted", "sent_to_sea", "returning", "finished"];

// A small fleet so the PSC/MLC inspection dossier groups crew per vessel.
const VESSELS = [
  "MV Baltic Trader",
  "MV Nordic Star",
  "MV Tallinn Express",
  "MV Gulf Pioneer",
  "MV Saaremaa",
  "MV Helios",
];

const RANKS = [
  "Master",
  "Chief Officer",
  "Second Officer",
  "Third Officer",
  "Chief Engineer",
  "Second Engineer",
  "Third Engineer",
  "Electro-Technical Officer",
  "Bosun",
  "Able Seaman",
  "Ordinary Seaman",
  "Motorman",
  "Oiler",
  "Fitter",
  "Pumpman",
  "Deck Cadet",
  "Ship's Cook",
];

const FIRST = [
  "Janis", "Marek", "Andres", "Priit", "Toomas", "Rui", "Mateo", "Jose", "Carlo",
  "Ramil", "Ranel", "Joel", "Nikolai", "Oleksandr", "Dmytro", "Viktor", "Sergei",
  "Arjun", "Rahul", "Vijay", "Suresh", "Deepak", "Nguyen", "Tran", "Wei", "Chen",
  "Lars", "Erik", "Mikael", "Olav", "Henrik", "Pavel", "Ivan", "Grigori", "Aleksei",
  "Miguel", "Antonio", "Diego", "Rico", "Emmanuel",
];

const LAST = [
  "Kuusk", "Tamm", "Saar", "Kask", "Magi", "Santos", "Cruz", "Reyes", "Garcia",
  "Dela Cruz", "Bautista", "Shevchenko", "Kovalenko", "Bondarenko", "Petrov",
  "Ivanov", "Sidorov", "Sharma", "Patel", "Kumar", "Singh", "Nair", "Pham", "Le",
  "Wang", "Li", "Nielsen", "Hansen", "Johansen", "Berg", "Lind", "Novak", "Popov",
  "Fernandez", "Torres", "Ramos", "Aquino", "Mendoza",
];

// One document blueprint per required type. `government` docs mimic a verified
// registry record (docCategory set); `manual` docs (seaman book, passport) are
// plain files with no registry category — their required-type is read from the
// title. Titles are chosen so lib/doctypes classifiers agree with the tag.
const BLUEPRINTS = {
  "Basic Safety Training": {
    category: "qualification",
    docType: "Qualification",
    source: "government",
    titles: [
      "Basic Safety Training",
      "Advanced Fire Fighting",
      "Proficiency in Survival Craft & Rescue Boats",
      "STCW Personal Survival Techniques",
    ],
  },
  Medical: {
    category: "medical",
    docType: "Medical certificate",
    source: "government",
    titles: ["Medical certificate", "Seafarer Medical Fitness Certificate"],
  },
  Endorsement: {
    category: "endorsement",
    docType: "Endorsement",
    source: "government",
    titles: [
      "Flag State Endorsement (Panama)",
      "Flag State Endorsement (Liberia)",
      "Flag State Endorsement (Marshall Islands)",
    ],
  },
  "Seaman book": {
    category: null,
    docType: "Seaman's book",
    source: "manual",
    titles: ["Seaman's Book", "Seafarer's Discharge Book"],
  },
  Passport: {
    category: null,
    docType: "Passport",
    source: "manual",
    titles: ["Passport"],
  },
};

const REQUIRED = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];
// Types we may drop to create "missing" variation. Medical + BST are always kept
// so every seafarer looks like a plausible active crew member.
const DROPPABLE = ["Endorsement", "Seaman book", "Passport"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Return an ISO date offset by `days` from now.
function dateFromNow(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// Expiry pickers.
const validDate = () => dateFromNow(randInt(120, 1500));
function issueDate() {
  // An actionable problem: expired or expiring-soon (<60 days).
  return Math.random() < 0.5 ? dateFromNow(-randInt(5, 400)) : dateFromNow(randInt(3, 58));
}
function mixedExpiry() {
  const r = Math.random();
  if (r < 0.22) return dateFromNow(-randInt(5, 400)); // expired
  if (r < 0.44) return dateFromNow(randInt(3, 58)); // expiring soon
  return dateFromNow(randInt(90, 1500)); // valid
}

function makeDoc(seafarerId, requiredType, createdAt, overrides = {}) {
  const bp = BLUEPRINTS[requiredType];
  const validUntil = overrides.validUntil ?? mixedExpiry();
  return {
    id: uuid(),
    seafarerId,
    title: overrides.title ?? pick(bp.titles),
    docType: bp.docType,
    docCategory: bp.category,
    estonianCode: overrides.estonianCode ?? null,
    // Certificate number for fleet-wide duplicate detection (the registry code
    // for verified docs; a printed number for photos).
    certNumber: overrides.certNumber ?? overrides.estonianCode ?? null,
    isValid: overrides.isValid ?? new Date(validUntil).getTime() > Date.now(),
    validUntil,
    // Seeded docs are curated demo records: their expiry is a known fact, not an
    // untrusted OCR guess, so the honest badge treats it as confirmed.
    expiryConfirmed: true,
    fileName: null,
    createdAt,
    source: overrides.source ?? bp.source,
    requiredType,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
  };
}

const seafarers = [];
const documents = [];

// ---- The real-code seafarer (must verify live in the demo) --------------
{
  const id = uuid();
  const created = dateFromNow(-30);
  seafarers.push({
    id,
    name: "Jaan Sample",
    rank: "Chief Officer",
    state: "accepted",
    shareToken: token(),
    createdAt: created,
    vessel: "MV Baltic Trader",
    rotationEnd: null,
  });
  // Safety training — real competency code, valid until 2027-03-28.
  documents.push(
    makeDoc(id, "Basic Safety Training", created, {
      title: "Ohutusalase koolituse tunnistus (Safety Training)",
      estonianCode: "SAMPLE0SAFETY001",
      isValid: true,
      validUntil: "2027-03-28T00:00:00.000Z",
      source: "government",
    })
  );
  // Medical — real minimal-model code, valid until 2027-02-19.
  documents.push(
    makeDoc(id, "Medical", created, {
      title: "Medical certificate",
      estonianCode: "SAMPLE0MEDICAL01",
      isValid: true,
      validUntil: "2027-02-19T00:00:00.000Z",
      source: "government",
    })
  );
  // Round out his file so he is fully complete (a clean reference card), with
  // one soon-expiring qualification so his card still shows a real "expiring" chip.
  documents.push(
    makeDoc(id, "Basic Safety Training", created, {
      title: "Advanced Fire Fighting",
      validUntil: dateFromNow(41),
      isValid: true,
    })
  );
  documents.push(makeDoc(id, "Endorsement", created, { validUntil: validDate(), isValid: true }));
  documents.push(makeDoc(id, "Seaman book", created, { validUntil: validDate(), isValid: true }));
  documents.push(makeDoc(id, "Passport", created, { validUntil: validDate(), isValid: true }));
}

// ---- Generated fleet -----------------------------------------------------
const TOTAL = 84; // > 80, plus the real one above => 85 total
const usedNames = new Set(["Jaan Sample"]);

for (let i = 0; i < TOTAL; i++) {
  let name;
  do {
    name = `${pick(FIRST)} ${pick(LAST)}`;
  } while (usedNames.has(name));
  usedNames.add(name);

  const id = uuid();
  const created = dateFromNow(-randInt(1, 120));
  // Spread evenly across states, with a little extra weight on Review.
  const state = i % 6 === 0 ? "review" : STATES[i % STATES.length];

  seafarers.push({
    id,
    name,
    rank: pick(RANKS),
    state,
    shareToken: token(),
    createdAt: created,
    vessel: VESSELS[i % VESSELS.length],
    rotationEnd: null,
  });

  // Completeness profile:
  //   ~32% clean     — all 5 required, all valid  (excluded from Problems)
  //   ~18% complete  — all 5 required, but ≥1 expired/expiring (a real problem)
  //   ~50% partial   — missing 1–3 of the droppable required types
  const roll = Math.random();
  let present;
  let clean = false;
  if (roll < 0.32) {
    present = [...REQUIRED];
    clean = true;
  } else if (roll < 0.5) {
    present = [...REQUIRED];
  } else {
    const dropCount = randInt(1, 3);
    const drop = new Set();
    while (drop.size < dropCount) drop.add(pick(DROPPABLE));
    present = REQUIRED.filter((t) => !drop.has(t));
  }

  // Build each present required type as a document.
  let forcedIssueUsed = false;
  for (const reqType of present) {
    let validUntil;
    if (clean) {
      validUntil = validDate();
    } else if (!clean && present.length === REQUIRED.length && !forcedIssueUsed && reqType === present[0]) {
      // "complete-but-problem" profile: guarantee at least one real issue.
      validUntil = issueDate();
      forcedIssueUsed = true;
    } else {
      validUntil = mixedExpiry();
    }
    documents.push(makeDoc(id, reqType, created, { validUntil }));
  }

  // A minority also carry an extra safety qualification (still a BST-type doc),
  // so document counts vary and worst-status has something to bite on.
  if (Math.random() < 0.3) {
    documents.push(
      makeDoc(id, "Basic Safety Training", created, {
        validUntil: clean ? validDate() : mixedExpiry(),
      })
    );
  }
}

// ---- Deliberate duplicate-certificate demo -------------------------------
// The SAME printed certificate number appearing on two DIFFERENT crew is a
// classic forged-STCW signal. Seed one such clash (a photo/OCR-path doc, not a
// registry-verified one) so the fleet-wide duplicate flag is demonstrable in the
// review + share views without needing a live upload.
{
  const DUP_NUMBER = "STCW-EE-2021-004537";
  const targets = seafarers.filter((s) => s.name !== "Jaan Sample").slice(0, 2);
  for (const s of targets) {
    const d = makeDoc(s.id, "Basic Safety Training", s.createdAt, {
      // Title deliberately outside the required-type classifiers so it lands as an
      // "Other document" — visible on the review page, the share page AND the CSV.
      title: "Dangerous Goods Handling",
      source: "photo",
      certNumber: DUP_NUMBER,
      validUntil: validDate(),
      isValid: true,
    });
    d.docType = "Photo — not verified";
    d.docCategory = null; // a photo/OCR doc has no registry category
    d.requiredType = null;
    documents.push(d);
  }
  console.log(
    `Duplicate-cert demo: number ${DUP_NUMBER} placed on ${targets.map((s) => s.name).join(" + ")}`
  );
}

// ---- End-of-rotation validity demo --------------------------------------
// A crew member who is fully documented and valid TODAY, but one cert lapses
// BEFORE the rotation ends — so sea-readiness must fail for that voyage even
// though nothing is expired right now (round-10 item 9).
{
  const id = uuid();
  const created = dateFromNow(-10);
  seafarers.push({
    id,
    name: "Otto Rotasson",
    rank: "Second Officer",
    state: "review",
    shareToken: token(),
    createdAt: created,
    vessel: "MV Nordic Star",
    // 6-month rotation; his medical (below) lapses in ~45 days, before it ends.
    rotationEnd: dateFromNow(180),
  });
  for (const rt of REQUIRED) {
    const validUntil = rt === "Medical" ? dateFromNow(45) : validDate();
    documents.push(makeDoc(id, rt, created, { validUntil, isValid: true }));
  }
}

// ---- STCW/MLC rest-hours demo -------------------------------------------
// Seed a rest-hours log so the inspection dossier + rest-hours report have real
// data on day one: Jaan Sample fully compliant; one crew member with clear ILO
// work/rest violations (an under-10h day and an under-77h week) to highlight.
const restHours = [];
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
{
  const jaanSample = seafarers.find((s) => s.name === "Jaan Sample");
  if (jaanSample) pushRest(jaanSample.id, 9, [11, 12, 11, 13, 12, 11, 12, 11, 12, 11]); // compliant
  // Give the first duplicate-cert crew member a violating week to demonstrate the
  // ILO highlight (day with 8h < 10h, and a 7-day sum under 77h).
  const violator = seafarers.find((s) => s.name !== "Jaan Sample");
  if (violator) pushRest(violator.id, 9, [9, 8, 10, 9, 8, 9, 10, 9, 8, 9]); // < 10h days + < 77h/7d
}

const db = { seafarers, documents, comments: [], restHours };

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");

// Quick summary.
const byState = STATES.reduce((acc, s) => {
  acc[s] = seafarers.filter((x) => x.state === s).length;
  return acc;
}, {});

const REQ = REQUIRED;
let fullyComplete = 0;
for (const s of seafarers) {
  const set = new Set(documents.filter((d) => d.seafarerId === s.id).map((d) => d.requiredType));
  if (REQ.every((t) => set.has(t))) fullyComplete++;
}

console.log(`Seeded ${seafarers.length} seafarers, ${documents.length} documents.`);
console.log("By state:", byState);
console.log(`Fully complete (all ${REQ.length} required types): ${fullyComplete}/${seafarers.length}`);
console.log("Real-code seafarer: Jaan Sample (SAMPLE0SAFETY001 + SAMPLE0MEDICAL01)");
