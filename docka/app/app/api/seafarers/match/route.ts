import { NextRequest, NextResponse } from "next/server";
import { readDB, type Doc } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { readableSeafarerIds } from "@/lib/access";
import {
  personIdentityOf,
  personMatchCandidates,
  PERSON_FIELD_CAP,
  type PersonIdentity,
} from "@/lib/duplicates";

export const dynamic = "force-dynamic";

// POST /api/seafarers/match  (agent-gated, per-tenant, PURE READ — no mutation)
//   { candidates: { id?, name?, dob?, personalCode?, passportNo?, seamanBookNo? }[] }
// Scores each candidate against the acting agent's OWN grant-scoped roster
// (readableSeafarerIds) and returns PersonMatch[] per row. This never returns another
// tenant's data — only ids the agent already has a live grant for.
//
// #3(critic) input bounds: reject > 200 candidates; cap every match field to 128 chars.
// #10(critic): build the roster's Doc slices ONCE (no per-member re-filter of all docs).

const MAX_CANDIDATES = 200;

type CandidateInput = {
  id?: string;
  name?: string;
  dob?: string | null;
  personalCode?: string | null;
  passportNo?: string | null;
  seamanBookNo?: string | null;
};

function cap(v: unknown): string {
  return typeof v === "string" ? v.slice(0, PERSON_FIELD_CAP) : "";
}

export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { candidates?: CandidateInput[] };
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (candidates.length > MAX_CANDIDATES) {
    return NextResponse.json(
      { ok: false, error: `Too many candidates (max ${MAX_CANDIDATES}).` },
      { status: 400 }
    );
  }

  const db = readDB();
  const allowed = readableSeafarerIds(session.agentId, db);

  // #10 — group documents by seafarer ONCE.
  const docsBySeafarer = new Map<string, Doc[]>();
  for (const d of db.documents) {
    if (!allowed.has(d.seafarerId)) continue;
    let slice = docsBySeafarer.get(d.seafarerId);
    if (!slice) docsBySeafarer.set(d.seafarerId, (slice = []));
    slice.push(d);
  }

  // Roster identities (per-tenant): only seafarers the agent may read.
  const roster: PersonIdentity[] = [];
  const rosterById = new Map<string, { name: string; rank: string }>();
  for (const s of db.seafarers) {
    if (!allowed.has(s.id)) continue;
    roster.push(personIdentityOf(s, docsBySeafarer.get(s.id) ?? []));
    rosterById.set(s.id, { name: s.verifiedName || s.name, rank: s.rank });
  }

  const results = candidates.map((c, rowIndex) => {
    let target: PersonIdentity;
    let candidateName = cap(c.name);
    if (c.id && allowed.has(c.id)) {
      const s = db.seafarers.find((x) => x.id === c.id)!;
      target = personIdentityOf(s, docsBySeafarer.get(s.id) ?? []);
      candidateName = s.verifiedName || s.name;
    } else {
      target = {
        seafarerId: c.id ?? `__row_${rowIndex}`,
        name: cap(c.name),
        dob: cap(c.dob).slice(0, 10) || null,
        personalCode: cap(c.personalCode).toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        passportNo: cap(c.passportNo).toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        seamanBookNo: cap(c.seamanBookNo).toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
      };
    }
    const matches = personMatchCandidates(target, roster).map((m) => ({
      ...m,
      name: rosterById.get(m.seafarerId)?.name ?? m.seafarerId,
      rank: rosterById.get(m.seafarerId)?.rank ?? "",
    }));
    return { rowIndex, candidateId: c.id ?? null, candidateName, matches };
  });

  return NextResponse.json({ ok: true, results });
}
