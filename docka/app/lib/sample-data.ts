// Public Sample Profiles — SERVER-ONLY curated projections for the two public
// demo pages (plan §D1/§D2/§D3, Phases 3+4).
//
// HARD RULES (a Phase-7 static rule will enforce them):
//   - server-only: reads `readDB()` directly, filtered to sample ids + curated
//     (`sample:true`) flags. NEVER `lib/agentData.ts`, NEVER `agentSession` /
//     `seamanSession` — the public pages carry no session and no tenant scope.
//   - Every seafarer leaves this module through the §D8 allowlist redaction
//     (`redactSampleSeafarer`) — the raw row (the private email token, auth seams, the
//     deprecated global `state` mirror, any FUTURE field) never reaches a page.
//   - Board/review stage comes from the sample-agency GRANT's `stage`, NEVER
//     `Seafarer.state` (plan R4 — agent stage moves dual-write the deprecated
//     global mirror; grant.stage is the source of truth).
//   - The duplicates (forged-cert) index is computed WITHIN the sample cohort
//     only — a real seafarer's name or doc metadata must never enter it.

import {
  readDB,
  type DB,
  type Circular,
  type Comment,
  type Doc,
  type DocRequest,
  type RestHourEntry,
  type Seafarer,
  type SeaServiceEntry,
} from "@/lib/db";
import {
  SAMPLE_AGENCY_ID,
  SAMPLE_FLAGSHIP_ID,
  isSampleId,
} from "@/lib/sample-ids";
import { redactSampleSeafarer } from "@/lib/sample-guard";
import { buildOwnerPayload, type OwnerPayload } from "@/lib/owner-payload";
import { circularNewestFirst, shapeReplyForSeaman, type InboxReplyView } from "@/lib/inbox";
import { duplicateNameIndex, type DuplicateNameIndex } from "@/lib/duplicates";
import { buildSearchRow, type RosterSearchRow } from "@/lib/roster-search";
import { getConfigForAgent } from "@/lib/required-docs-store";
import type { RequiredDocsConfig } from "@/lib/required-docs";
import type { SeafarerState } from "@/lib/pipeline";

// ---- Phase 3 — the flagship owner-view payload -------------------------------

/** One inbox message as the seaman-side <SeamanInbox> renders it (own view). */
export type SampleInboxItem = {
  id: string;
  subject: string;
  message: string;
  authorName: string;
  createdAt: string;
  allowReplies: boolean;
  unread: boolean;
  replies: InboxReplyView[];
};

export type SampleOwnerPayload = Omit<OwnerPayload, "seafarer"> & {
  seafarer: Seafarer;
  /** Curated inbox thread pre-shaped for the seaman view (SSR — no client fetch). */
  inbox: { items: SampleInboxItem[]; unreadCount: number };
};

/**
 * The public sample seafarer page's whole initial dataset: the §D8 curated owner
 * payload + the curated inbox thread shaped exactly as GET /api/inbox shapes it
 * for the AUTHENTICATED owner (own replies as "You", the peer "everyone" reply
 * anonymised to "A crew member" — the flagship's live sample-agency grant makes
 * peer chatter visible, mirroring lib/inbox semantics). Returns null when the
 * sample seed has not been run against this database.
 */
export function getSampleSeafarerPayload(): SampleOwnerPayload | null {
  const db = readDB();
  const row = db.seafarers.find((s) => s.id === SAMPLE_FLAGSHIP_ID && s.isSample === true);
  if (!row) return null;
  const base = buildOwnerPayload(db, SAMPLE_FLAGSHIP_ID, { curatedOnly: true });
  if (!base.seafarer) return null;
  return { ...base, seafarer: base.seafarer, inbox: buildSampleInbox(db, SAMPLE_FLAGSHIP_ID) };
}

function buildSampleInbox(
  db: DB,
  seafarerId: string
): { items: SampleInboxItem[]; unreadCount: number } {
  const mine = db.circulars.filter(
    (c) => c.sample === true && isSampleId(c.agentId) && c.recipientIds.includes(seafarerId)
  );
  mine.sort(circularNewestFirst);
  // Sample rows never carry inboxLastSeenAt (nobody can log in as them), so every
  // message reads as unread — which also demos the unread badge honestly.
  const lastSeen = db.seafarers.find((s) => s.id === seafarerId)?.inboxLastSeenAt ?? "";
  const items = mine.map((c) => {
    const allowReplies = c.allowReplies ?? false;
    let replies: InboxReplyView[] = [];
    if (allowReplies) {
      const all = db.circularReplies.filter(
        (r) => r.sample === true && r.circularId === c.id
      );
      // Owner view (authenticated-path semantics): own replies always; peers'
      // "everyone" replies anonymised via the same shaper the API uses.
      const own = all.filter((r) => r.seafarerId === seafarerId);
      const peers = all.filter((r) => r.seafarerId !== seafarerId && r.visibility === "all");
      replies = [...own, ...peers]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => shapeReplyForSeaman(r, seafarerId));
    }
    return {
      id: c.id,
      subject: c.subject,
      message: c.message,
      authorName: c.authorName,
      createdAt: c.createdAt,
      allowReplies,
      unread: c.createdAt > lastSeen,
      replies,
    };
  });
  return { items, unreadCount: items.filter((i) => i.unread).length };
}

// ---- Phase 5 — discovery: the flagship's talent-search row (plan §D10, R10) --

/**
 * The flagship's row for a REAL agent's /agent/search — the ONE deliberate,
 * documented bypass of grant scoping (plan R10), injected only while the viewing
 * agent holds NO grant for the flagship. Built ONLY from curated data:
 *   - the §D8-redacted flagship (never the raw row),
 *   - its curated (sample:true) documents,
 *   - the SAMPLE agency's required-docs config (never the viewing agent's) — so
 *     the row's sea-readiness is a property of the curated fixture, not of
 *     whoever happens to be looking.
 * Stage renders as "review": the un-granted viewer has no pipeline position for
 * it, and every real grant starts at Review anyway. Returns null before the
 * sample seed has run.
 */
export function getFlagshipSearchRow(): RosterSearchRow | null {
  const db = readDB();
  const s = db.seafarers.find((x) => x.id === SAMPLE_FLAGSHIP_ID && x.isSample === true);
  if (!s) return null;
  const docs = db.documents
    .filter((d) => d.sample === true && d.seafarerId === SAMPLE_FLAGSHIP_ID)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const row = buildSearchRow(
    { ...redactSampleSeafarer(s), state: "review" as SeafarerState },
    docs,
    getConfigForAgent(SAMPLE_AGENCY_ID)
  );
  return { ...row, isSample: true };
}

// ---- Phase 4 — the sample agency board ---------------------------------------

/** Board row: the redacted seafarer + the card data <AgentBoard> consumes. */
export type SampleBoardRow = Seafarer & {
  documents: Doc[];
  docRequests?: DocRequest[];
  assigned?: boolean;
};

export type SampleBoardData = {
  roster: SampleBoardRow[];
  /** Forged-cert duplicate index — SAMPLE COHORT ONLY (never a real name). */
  duplicates: DuplicateNameIndex;
  requiredConfig: RequiredDocsConfig;
};

/** Curated docs of the sample cohort only (the duplicates-index input). */
function sampleCohortDocs(db: DB): Doc[] {
  return db.documents.filter((d) => d.sample === true && isSampleId(d.seafarerId));
}

/**
 * The public sample agency board: one row per ACTIVE sample-agency grant, stage
 * from `grant.stage` (NEVER `Seafarer.state`). Returns null before the seed runs.
 */
export function getSampleBoardData(): SampleBoardData | null {
  const db = readDB();
  if (!db.agents.some((a) => a.id === SAMPLE_AGENCY_ID && a.isSample === true)) return null;

  const grants = db.accessGrants.filter(
    (g) => g.sample === true && g.agentId === SAMPLE_AGENCY_ID && g.status === "ACTIVE"
  );
  const liveAssignedIds = new Set(
    db.assignments
      .filter((a) => a.sample === true && a.agentId === SAMPLE_AGENCY_ID && a.returnedAt === null)
      .map((a) => a.seafarerId)
  );
  const roster: SampleBoardRow[] = [];
  for (const g of grants) {
    const s = db.seafarers.find((x) => x.id === g.seafarerId && x.isSample === true);
    if (!s) continue;
    roster.push({
      ...redactSampleSeafarer(s),
      // Per-grant pipeline stage is the ONLY stage source (plan R4). The redaction
      // dropped the deprecated global `state` mirror; re-attach the grant's truth.
      state: (g.stage ?? "review") as SeafarerState,
      documents: db.documents
        .filter((d) => d.sample === true && d.seafarerId === s.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      docRequests: db.docRequests.filter(
        (r) => r.sample === true && r.seafarerId === s.id && r.agentId === SAMPLE_AGENCY_ID
      ),
      assigned: liveAssignedIds.has(s.id),
    });
  }
  roster.sort((a, b) => a.name.localeCompare(b.name));

  // Duplicate/forgery index over the SAMPLE COHORT's curated docs only, resolving
  // names only within the cohort — a real seafarer sharing a cert number is
  // invisible here (cohort-scope unit test is adversarial on exactly this).
  const cohortNames = new Map(
    db.seafarers.filter((s) => s.isSample === true).map((s) => [s.id, s.name] as const)
  );
  const duplicates = duplicateNameIndex(sampleCohortDocs(db), (id) => cohortNames.get(id) ?? id);

  return { roster, duplicates, requiredConfig: getConfigForAgent(SAMPLE_AGENCY_ID) };
}

// ---- Phase 4 — the opened read-only review panel -----------------------------

export type SampleReviewData = {
  seafarer: Seafarer;
  documents: Doc[];
  notes: Comment[];
  restHours: RestHourEntry[];
  docRequests: DocRequest[];
  seaService: SeaServiceEntry[];
  duplicates: DuplicateNameIndex;
  requiredConfig: RequiredDocsConfig;
  assigned: boolean;
};

/**
 * Read-only review data for ONE curated sample crew member (the demo opens the
 * flagship — the only subject whose doc images are reachable through the one
 * PUBLISHED open token). Stage from the sample-agency grant; curated rows only.
 */
export function getSampleReviewData(seafarerId: string): SampleReviewData | null {
  const db = readDB();
  const s = db.seafarers.find((x) => x.id === seafarerId && x.isSample === true);
  if (!s) return null;
  const grant = db.accessGrants.find(
    (g) => g.sample === true && g.agentId === SAMPLE_AGENCY_ID && g.seafarerId === seafarerId
  );
  if (!grant) return null;
  const cohortNames = new Map(
    db.seafarers.filter((x) => x.isSample === true).map((x) => [x.id, x.name] as const)
  );
  return {
    seafarer: {
      ...redactSampleSeafarer(s),
      state: (grant.stage ?? "review") as SeafarerState,
    },
    documents: db.documents
      .filter((d) => d.sample === true && d.seafarerId === seafarerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    notes: db.comments
      .filter((c) => c.sample === true && c.seafarerId === seafarerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    restHours: db.restHours
      .filter((e) => e.sample === true && e.seafarerId === seafarerId)
      .sort((a, b) => a.date.localeCompare(b.date)),
    docRequests: db.docRequests
      .filter(
        (r) => r.sample === true && r.seafarerId === seafarerId && r.agentId === SAMPLE_AGENCY_ID
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    seaService: db.seaService
      .filter((e) => e.sample === true && e.seafarerId === seafarerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    duplicates: duplicateNameIndex(sampleCohortDocs(db), (id) => cohortNames.get(id) ?? id),
    requiredConfig: getConfigForAgent(SAMPLE_AGENCY_ID),
    assigned: false,
  };
}

// ---- Phase 4 — the circular thread (agent-side view) -------------------------

/** One reply as the AGENT-side circular list renders it: REAL author names. */
export type SampleAgentReply = {
  id: string;
  circularId: string;
  authorName: string;
  body: string;
  visibility: "agent" | "all";
  createdAt: string;
  stillOnRoster: boolean;
};

export type SampleCircularThread = {
  circulars: Circular[];
  repliesByCircular: Record<string, SampleAgentReply[]>;
};

/**
 * The sample agency's sent circulars + replies as the AGENT sees them (real
 * sample author names, both visibilities). Curated rows only.
 */
export function getSampleCircularThread(): SampleCircularThread | null {
  const db = readDB();
  const circulars = db.circulars
    .filter((c) => c.sample === true && c.agentId === SAMPLE_AGENCY_ID)
    .sort(circularNewestFirst);
  if (circulars.length === 0) return null;
  const repliesByCircular: Record<string, SampleAgentReply[]> = {};
  for (const c of circulars) {
    repliesByCircular[c.id] = db.circularReplies
      .filter((r) => r.sample === true && r.circularId === c.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({
        id: r.id,
        circularId: r.circularId,
        authorName: r.authorName,
        body: r.body,
        visibility: r.visibility,
        createdAt: r.createdAt,
        stillOnRoster: true, // all sample grants are seeded ACTIVE
      }));
  }
  return { circulars, repliesByCircular };
}
