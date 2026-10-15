import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB, id, type RestHourEntry } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import { restDateKey } from "@/lib/rest-hours";

export const dynamic = "force-dynamic";

// GET /api/rest-hours?seafarerId=...  -> that seafarer's rest-hour entries.
export async function GET(req: NextRequest) {
  const sid = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!sid) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  // Rest-hours are AGENT-facing (the PSC/MLC dossier), not a seaman self-service
  // read. FAIL-CLOSED: only a signed-in agent holding a LIVE grant for this seafarer
  // may read them; an unauthenticated or foreign-id replay 404s with no data. This
  // closes the id-oracle (v-final tester criterion #1) — a raw seafarerId can no
  // longer be replayed to pull another tenant's entries.
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user || !checkAccess(session.agentId, sid).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  const db = readDB();
  const entries = db.restHours
    .filter((e) => e.seafarerId === sid)
    .sort((a, b) => a.date.localeCompare(b.date));
  return NextResponse.json({ ok: true, entries });
}

// POST /api/rest-hours  { seafarerId, date, hoursRest }
//                    OR { seafarerId, entries: [{ date, hoursRest }] }
//
// Records a seafarer's total rest hours for a calendar day (the raw material of
// the STCW/MLC rest-hours report). One figure per day — logging the same date
// again overwrites it. Agent-authenticated, so the record is defensible at an
// inspection. Returns the seafarer's full, sorted entry list.
export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to log rest hours." },
      { status: 401 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    seafarerId?: string;
    date?: string;
    hoursRest?: number | string;
    entries?: { date?: string; hoursRest?: number | string }[];
  };
  const seafarerId = (body.seafarerId ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }

  // GRANT-SCOPE the write (fail-closed): an agent may only log rest hours for a
  // seafarer they hold a LIVE grant for — mirroring review/route.ts and the
  // seafarers PATCH. A foreign / un-granted seafarerId 404s with NO mutation, so a
  // signed-in agent can no longer write cross-tenant. checkAccess re-reads grant
  // state live (TOCTOU-safe), so a mid-session revoke blocks the next write too.
  if (!checkAccess(session.agentId, seafarerId).allowed) {
    return NextResponse.json({ ok: false, error: "Unknown seafarer." }, { status: 404 });
  }

  const incoming = body.entries ?? [{ date: body.date, hoursRest: body.hoursRest }];
  const normalized: { date: string; hoursRest: number }[] = [];
  for (const e of incoming) {
    const date = restDateKey((e.date ?? "").toString());
    const hoursRest = Number(e.hoursRest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(hoursRest)) {
      return NextResponse.json(
        { ok: false, error: "Each entry needs a valid date (YYYY-MM-DD) and rest hours." },
        { status: 400 }
      );
    }
    normalized.push({ date, hoursRest: Math.max(0, Math.min(24, hoursRest)) });
  }

  const entries = await updateDB((db) => {
    if (!db.seafarers.some((s) => s.id === seafarerId)) return null;
    for (const n of normalized) {
      // One figure per (seafarer, date): overwrite if the day already exists.
      const existing = db.restHours.find((r) => r.seafarerId === seafarerId && r.date === n.date);
      if (existing) {
        existing.hoursRest = n.hoursRest;
        existing.createdAt = new Date().toISOString();
      } else {
        const entry: RestHourEntry = {
          id: id(),
          seafarerId,
          date: n.date,
          hoursRest: n.hoursRest,
          createdAt: new Date().toISOString(),
        };
        db.restHours.push(entry);
      }
    }
    return db.restHours
      .filter((r) => r.seafarerId === seafarerId)
      .sort((a, b) => a.date.localeCompare(b.date));
  });

  if (entries === null) {
    return NextResponse.json({ ok: false, error: "Unknown seafarer." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, entries });
}
