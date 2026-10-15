import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type SeaServiceEntry } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
  pruneSampleReferences,
} from "@/lib/sample-guard";
import { serviceDateKey, sortForDisplay, summarizeSeaService } from "@/lib/sea-service";

export const dynamic = "force-dynamic";

// Sea-service ledger API — the digital discharge book (T2.2). Records belong to the
// SEAMAN; a granted agent may maintain them (like /api/rest-hours). It serves BOTH
// trust models WITHOUT ever conflating them (the isolation guard forbids resolving a
// seaman AND an agent session in one module), mirroring /api/documents:
//   - AGENT context : a signed-in agent needs a LIVE grant to the seafarer
//     (checkAccess, TOCTOU-safe). A foreign / un-granted seafarerId 404s, no write.
//   - SEAMAN context : a `token` matching the seafarer's OWN share token (their
//     possession secret) authorises writes to their own book. A token for another
//     seafarer 404s. This route authorises the seaman purely by possession of their
//     rotatable share token (never a session), exactly like the seaman self-service
//     paths in /api/documents — so it resolves no seaman identity object at all.

const MAX_TEXT = 120;
const MAX_NOTE = 500;

// Resolve who the caller is allowed to act as for `seafarerId`. Returns the actor
// label to stamp on a record ("agent:<id>" / "seaman"), the "sample-denied" sentinel
// (a sample-token write -> the route answers 403), null when unauthorised, or a
// Response (402) when the AGENT's agency is past the billing tier for `intent`.
//
// billing-guard: session-branch — R2-9. The tier is applied ONLY on the resolved
// agent-session path. The seaman's own share-token path is deliberately untouched: a
// blocked agency must never cost its seafarers access to their own discharge book.
// Token path goes through the CHOKEPOINT pinned to the open token (PHASE0-CENSUS row 9);
// a sample subject is read-only through the token.
async function authorize(
  seafarerId: string,
  token: string | null,
  intent: "read" | "write"
): Promise<string | "sample-denied" | null | Response> {
  if (!seafarerId) return null;
  const session = await agentSession();
  // Owner-token resolution via the sample chokepoint (open token only). Resolved once and
  // shared by the seaman path AND the R2-9/finding-8 billing fall-through below.
  const tokenSubject = token ? resolveTokenSubject(readDB(), token, intent, ["open"]) : null;
  const ownerToken = (): boolean =>
    !!tokenSubject && tokenSubject !== SAMPLE_WRITE_DENIED && tokenSubject.seafarer.id === seafarerId;
  if (session?.user) {
    // CANONICAL ACTOR ORDER (F3, finding 19): `checkAccess` FIRST, so a blocked agent
    // gets the SAME 404 for a foreign id as for a nonexistent one — no existence
    // oracle. Only then the billing gate, and a denied gate falls through to the
    // OWNER token (finding 8 / decision 6) as the SEAMAN actor, never as the agency.
    if (!checkAccess(session.agentId, seafarerId).allowed) return null;
    const billingGate =
      intent === "write" ? requireBillingWritable(session) : requireBillingReadable(session);
    if (!billingGate.ok) return ownerToken() ? "seaman" : billingGate.response;
    return `agent:${session.agentId}`;
  }
  // Non-session (seaman) path: a sample subject's token is write-DENIED (403).
  if (tokenSubject === SAMPLE_WRITE_DENIED) return "sample-denied";
  return ownerToken() ? "seaman" : null;
}

// True when this seafarer is a sample subject (curated public demo data).
function isSampleSubject(seafarerId: string): boolean {
  return readDB().seafarers.find((s) => s.id === seafarerId)?.isSample === true;
}

function entriesFor(seafarerId: string): SeaServiceEntry[] {
  const rows = readDB().seaService.filter((e) => e.seafarerId === seafarerId);
  // Sample subjects expose CURATED (sample:true) ledger rows only.
  return isSampleSubject(seafarerId) ? rows.filter((e) => e.sample === true) : rows;
}

function ok(seafarerId: string, extra: Record<string, unknown> = {}) {
  const entries = sortForDisplay(entriesFor(seafarerId));
  return NextResponse.json({ ok: true, entries, summary: summarizeSeaService(entries), ...extra });
}

// A required date field (YYYY-MM-DD). Returns the normalised key or "" when invalid.
function reqDate(raw: unknown): string {
  return typeof raw === "string" ? serviceDateKey(raw) : "";
}

// An optional date field. "" / null / undefined -> null; anything else must parse or
// the sentinel "bad" is returned so the caller can 400.
function optDate(raw: unknown): string | null | "bad" {
  if (raw === undefined || raw === null || raw === "") return null;
  const key = typeof raw === "string" ? serviceDateKey(raw) : "";
  return key ? key : "bad";
}

function optText(raw: unknown, max: number): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
}

// GET /api/sea-service?seafarerId=...&token=...  -> the ledger + summary.
export async function GET(req: NextRequest) {
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim() || null;
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  const actor = await authorize(seafarerId, token, "read");
  if (actor instanceof Response) return actor;
  if (actor === "sample-denied" || !actor) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  return ok(seafarerId);
}

// POST /api/sea-service
//   { seafarerId, vessel, rank, signOn, signOff?, imo?, vesselType?, flagState?, note?, token? }
// Add one sea-service engagement. signOff omitted / null = still onboard.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const seafarerId = typeof body.seafarerId === "string" ? body.seafarerId.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : null;
  const actor = await authorize(seafarerId, token, "write");
  if (actor instanceof Response) return actor;
  if (actor === "sample-denied") return sampleReadOnlyResponse();
  if (!actor) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  const vessel = optText(body.vessel, MAX_TEXT);
  const rank = optText(body.rank, MAX_TEXT);
  if (!vessel || !rank) {
    return NextResponse.json({ ok: false, error: "Vessel and rank are required." }, { status: 400 });
  }
  const signOn = reqDate(body.signOn);
  if (!signOn) {
    return NextResponse.json({ ok: false, error: "Enter a valid sign-on date." }, { status: 400 });
  }
  const signOff = optDate(body.signOff);
  if (signOff === "bad") {
    return NextResponse.json({ ok: false, error: "Enter a valid sign-off date." }, { status: 400 });
  }
  if (signOff && signOff < signOn) {
    return NextResponse.json(
      { ok: false, error: "Sign-off cannot be before sign-on." },
      { status: 400 }
    );
  }

  const entry: SeaServiceEntry = {
    id: id(),
    seafarerId,
    vessel,
    rank,
    imo: optText(body.imo, MAX_TEXT),
    vesselType: optText(body.vesselType, MAX_TEXT),
    flagState: optText(body.flagState, MAX_TEXT),
    signOn,
    signOff,
    note: optText(body.note, MAX_NOTE),
    recordedBy: actor,
    createdAt: new Date().toISOString(),
  };

  await updateDB((db) => {
    if (!db.seafarers.some((s) => s.id === seafarerId)) return;
    db.seaService.push(entry);
    // Bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(db, seafarerId);
  });
  return ok(seafarerId, { created: entry.id });
}

// PATCH /api/sea-service  { id, ...fields, token? }
// Edit one engagement the caller may act on (its seafarer must be theirs).
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const entryId = typeof body.id === "string" ? body.id.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : null;
  if (!entryId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  const existing = readDB().seaService.find((e) => e.id === entryId) ?? null;
  const patchActor = existing ? await authorize(existing.seafarerId, token, "write") : null;
  if (patchActor instanceof Response) return patchActor;
  if (patchActor === "sample-denied") return sampleReadOnlyResponse();
  if (!existing || !patchActor) {
    return NextResponse.json({ ok: false, error: "Entry not found." }, { status: 404 });
  }
  // A CURATED sample ledger row is immutable for everyone (agents included).
  if (existing.sample === true) return sampleReadOnlyResponse();

  // Validate each supplied field up front so a bad value never partially writes.
  let vessel: string | undefined;
  if (body.vessel !== undefined) {
    const v = optText(body.vessel, MAX_TEXT);
    if (!v) return NextResponse.json({ ok: false, error: "Vessel cannot be empty." }, { status: 400 });
    vessel = v;
  }
  let rank: string | undefined;
  if (body.rank !== undefined) {
    const v = optText(body.rank, MAX_TEXT);
    if (!v) return NextResponse.json({ ok: false, error: "Rank cannot be empty." }, { status: 400 });
    rank = v;
  }
  let signOn: string | undefined;
  if (body.signOn !== undefined) {
    const v = reqDate(body.signOn);
    if (!v) return NextResponse.json({ ok: false, error: "Enter a valid sign-on date." }, { status: 400 });
    signOn = v;
  }
  let signOff: string | null | undefined;
  if (body.signOff !== undefined) {
    const v = optDate(body.signOff);
    if (v === "bad") return NextResponse.json({ ok: false, error: "Enter a valid sign-off date." }, { status: 400 });
    signOff = v;
  }
  // Cross-check the effective on/off pair (whichever side is changing).
  const effOn = signOn ?? existing.signOn;
  const effOff = signOff !== undefined ? signOff : existing.signOff;
  if (effOff && effOn && effOff < effOn) {
    return NextResponse.json({ ok: false, error: "Sign-off cannot be before sign-on." }, { status: 400 });
  }

  const result = await updateDB((db) => {
    const e = db.seaService.find((x) => x.id === entryId);
    if (!e) return null;
    if (vessel !== undefined) e.vessel = vessel;
    if (rank !== undefined) e.rank = rank;
    if (signOn !== undefined) e.signOn = signOn;
    if (signOff !== undefined) e.signOff = signOff;
    if (body.imo !== undefined) e.imo = optText(body.imo, MAX_TEXT);
    if (body.vesselType !== undefined) e.vesselType = optText(body.vesselType, MAX_TEXT);
    if (body.flagState !== undefined) e.flagState = optText(body.flagState, MAX_TEXT);
    if (body.note !== undefined) e.note = optText(body.note, MAX_NOTE);
    return e;
  });
  if (!result) {
    return NextResponse.json({ ok: false, error: "Entry not found." }, { status: 404 });
  }
  return ok(existing.seafarerId);
}

// DELETE /api/sea-service  { id, token? }
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const entryId = typeof body.id === "string" ? body.id.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : null;
  if (!entryId) {
    return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  const existing = readDB().seaService.find((e) => e.id === entryId) ?? null;
  const deleteActor = existing ? await authorize(existing.seafarerId, token, "write") : null;
  if (deleteActor instanceof Response) return deleteActor;
  if (deleteActor === "sample-denied") return sampleReadOnlyResponse();
  if (!existing || !deleteActor) {
    return NextResponse.json({ ok: false, error: "Entry not found." }, { status: 404 });
  }
  // A CURATED sample ledger row can never be deleted (agents included).
  if (existing.sample === true) return sampleReadOnlyResponse();
  await updateDB((db) => {
    db.seaService = db.seaService.filter((e) => e.id !== entryId);
  });
  return ok(existing.seafarerId);
}
