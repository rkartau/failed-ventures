// B2 board-card states-matrix seed (plan Phase 4.3) — writes the full spec
// matrix as ZZB2-prefixed crew granted to the "dev" agent, straight into THIS
// worktree's app/data/db.json.
//
// RUN ONLY WHILE THE DEV SERVER IS DOWN (the db mutex is in-process — same rule
// as scripts/seed-samples.mjs). Idempotent: every prior ZZB2 row (seafarers,
// docs, grants, assignments, requests) is removed before re-inserting, and the
// "dev" / "agent-b" agent rows are ensured exactly once.
//
// Run: node tests/board-card-seed.mjs            seed/refresh the matrix crew
//      node tests/board-card-seed.mjs --remove   strip every ZZB2 row again
//
// NOTE: run --remove BEFORE tests/sample-shots.mjs — its "SILENT: db.notifications
// untouched" assertion assumes the flagship is the dev tenant's ONLY crew; a
// dev-tenant circular legitimately notifies the (real, non-sample) ZZB2 rows.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

const PREFIX = "zzb2-";
const NAME_PREFIX = "ZZB2 ";
const DAY = 86_400_000;
const nowIso = new Date().toISOString();
const day = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const rnd = () => crypto.randomBytes(9).toString("base64url");

const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
for (const key of [
  "seafarers",
  "documents",
  "agents",
  "accessGrants",
  "assignments",
  "docRequests",
]) {
  if (!Array.isArray(db[key])) db[key] = [];
}

// ---- Clean any prior matrix rows (idempotent re-run) ------------------------
const isMatrix = (v) => typeof v === "string" && v.startsWith(PREFIX);
const matrixIds = new Set(db.seafarers.filter((s) => isMatrix(s.id)).map((s) => s.id));
db.seafarers = db.seafarers.filter((s) => !isMatrix(s.id));
db.documents = db.documents.filter((d) => !isMatrix(d.seafarerId));
db.accessGrants = db.accessGrants.filter((g) => !isMatrix(g.seafarerId));
db.assignments = db.assignments.filter((a) => !isMatrix(a.seafarerId));
db.docRequests = db.docRequests.filter((r) => !isMatrix(r.seafarerId));
// Side-tables a dev-tenant action may have touched while the matrix was live.
for (const key of ["notifications", "remindersSent", "comments"]) {
  if (Array.isArray(db[key])) db[key] = db[key].filter((r) => !isMatrix(r?.seafarerId));
}
if (Array.isArray(db.circulars)) {
  for (const c of db.circulars) {
    if (Array.isArray(c.recipientIds)) c.recipientIds = c.recipientIds.filter((id) => !isMatrix(id));
  }
  db.circulars = db.circulars.filter((c) => !Array.isArray(c.recipientIds) || c.recipientIds.length > 0);
}

if (process.argv.includes("--remove")) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  console.log(`board-card seed: removed ${matrixIds.size} matrix crew (+their rows) from ${DB_PATH}`);
  process.exit(0);
}

// ---- Demo agent rows (dev door + tenant-isolation twin) ---------------------
for (const [id, orgName] of [
  ["dev", "Dev Crewing (test agent)"],
  ["agent-b", "Agent B Crewing (isolation twin)"],
]) {
  if (!db.agents.some((a) => a.id === id)) {
    db.agents.push({ id, orgName, contact: "", createdAt: nowIso });
  }
}

// ---- Factories --------------------------------------------------------------
let seq = 0;
const REQUIRED_FIVE = ["Basic Safety Training", "Medical", "Endorsement", "Seaman book", "Passport"];

function doc(seafarerId, requiredType, over = {}) {
  return {
    id: `${PREFIX}doc-${++seq}`,
    seafarerId,
    title: over.title ?? requiredType ?? "Extra Cert",
    docType: "document",
    docCategory: null,
    estonianCode: null,
    certNumber: null,
    isValid: true,
    validUntil: day(120),
    expiryConfirmed: true,
    fileName: null,
    createdAt: nowIso,
    source: "photo",
    requiredType: requiredType ?? null,
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    ...over,
  };
}
const covering = (sid, over = {}) => REQUIRED_FIVE.map((rt) => doc(sid, rt, { ...over }));

function seafarer(slug, name, stage, over = {}) {
  const id = `${PREFIX}${slug}`;
  db.seafarers.push({
    id,
    name: NAME_PREFIX + name,
    rank: "Chief Officer",
    state: stage,
    shareToken: rnd(),
    createdAt: nowIso,
    vessel: null,
    rotationEnd: null,
    ...over.seafarer,
  });
  db.accessGrants.push({
    id: `${PREFIX}grant-${slug}`,
    seafarerId: id,
    agentId: "dev",
    status: "ACTIVE",
    legalBasis: "CONSENT",
    scope: ["profile", "documents", "log"],
    shareToken: rnd(),
    grantedAt: nowIso,
    revokedAt: null,
    expiresAt: null,
    createdAt: nowIso,
    stage,
    stageUpdatedAt: Date.now(),
  });
  if (over.assigned) {
    db.assignments.push({
      id: `${PREFIX}asg-${slug}`,
      seafarerId: id,
      agentId: "dev",
      vessel: "MV ZZB2 Test",
      sentToSeaAt: nowIso,
      returnedAt: null,
      requiredSnapshot: null,
      createdAt: nowIso,
    });
  }
  return id;
}

function request(seafarerId, over = {}) {
  db.docRequests.push({
    id: `${PREFIX}req-${++seq}`,
    seafarerId,
    agentId: "dev",
    requestedBy: "dev",
    requiredType: null,
    label: over.label ?? "Requested item",
    note: null,
    dueDate: null,
    status: "pending",
    createdAt: nowIso,
    resolvedAt: null,
    resolvedVia: null,
    ...over,
  });
}

// ---- The states matrix ------------------------------------------------------

// 1. In-date clean + self-uploaded floor (also the benched employment case).
{
  const id = seafarer("clean-self", "Clean Self", "review");
  db.documents.push(...covering(id));
}

// 2. In-date clean + gov floor.
{
  const id = seafarer("clean-gov", "Clean Gov", "review");
  db.documents.push(
    ...covering(id, { source: "government", verifiedResolvedAt: nowIso })
  );
}

// 3. Package ready (sky strip).
{
  const id = seafarer("package", "Package Ready", "accepted");
  db.documents.push(...covering(id));
  request(id, { status: "received", resolvedAt: nowIso, resolvedVia: "upload" });
  request(id, { status: "received", resolvedAt: nowIso, resolvedVia: "agent" });
}

// 4. Expiring (amber, named + date).
{
  const id = seafarer("expiring", "Expiring Soon", "review");
  const docs = covering(id);
  docs[1].validUntil = day(30); // Medical
  db.documents.push(...docs);
}

// 5. Missing (amber, named, +N more overflow).
{
  const id = seafarer("missing", "Missing Docs", "review");
  db.documents.push(doc(id, "Passport"));
}

// 6. Unknown expiry (amber "need expiry confirmation").
{
  const id = seafarer("unknown", "Unknown Expiry", "review");
  db.documents.push(...covering(id), doc(id, null, { title: "Old Cert", validUntil: null, isValid: null }));
}

// 7. Expired (red, named + date).
{
  const id = seafarer("expired", "Expired Cert", "review");
  const docs = covering(id);
  docs[2].validUntil = day(-30); // Endorsement
  docs[2].isValid = false;
  db.documents.push(...docs);
}

// 8. Worst case (red + amber stacked, both with +N more).
{
  const id = seafarer("worst", "Worst Case", "review");
  db.documents.push(
    doc(id, "Passport", { validUntil: day(-30), isValid: false }),
    doc(id, "Medical", { validUntil: day(30) })
  );
  request(id, { dueDate: day(-5), label: "Overdue item" });
}

// 9. At sea locked (red employment 2/3 + gray locked strip; remove disabled).
{
  const id = seafarer("atsea", "At Sea Gap", "sent_to_sea", { assigned: true });
  db.documents.push(
    ...covering(id),
    doc(id, "Wage Account"),
    doc(id, "Allotment")
  );
}

// 10. SEA unknown-expiry reconfirm (amber employment gap, no false ✓).
{
  const id = seafarer("reconfirm", "Sea Reconfirm", "sent_to_sea", { assigned: true });
  db.documents.push(
    ...covering(id),
    doc(id, "SEA", { seaEndDate: null }),
    doc(id, "Wage Account"),
    doc(id, "Allotment")
  );
}

// 11. Verify pending (+N pend on a 0-gov cell).
{
  const id = seafarer("pending", "Verify Pending", "review");
  const docs = covering(id);
  docs[0].manualVerification = { status: "requested", requestedAt: nowIso };
  docs[1].holderMismatch = true;
  db.documents.push(...docs);
}

// 12. Tagged card (violet tags row) + checkbox-selected candidate.
{
  const id = seafarer("tagged", "Tagged Crew", "review", {
    seafarer: { tags: ["priority", "b2-demo"] },
  });
  db.documents.push(...covering(id));
}

// 13. Four-strip worst case (red + amber + sky + neutral on ONE card, R1-6).
{
  const id = seafarer("fourstrip", "Four Strip", "sent_to_sea", { assigned: true });
  const docs = covering(id);
  docs[1].validUntil = day(-30); // Medical expired -> red
  docs[1].isValid = false;
  db.documents.push(
    ...docs,
    doc(id, null, { title: "Extra Cert", validUntil: day(30) }), // expiring -> amber
    doc(id, "SEA", { seaEndDate: day(180) }),
    doc(id, "Wage Account"),
    doc(id, "Allotment")
  );
  request(id, { status: "received", resolvedAt: nowIso, resolvedVia: "upload" }); // sky
}

// 14. Zero docs (0-docs cell + missing strip).
{
  seafarer("zerodocs", "Zero Docs", "review");
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log(
  `board-card seed: ${db.seafarers.filter((s) => isMatrix(s.id)).length} matrix crew written to ${DB_PATH}`
);
