import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { setPropagation } from "@/lib/propagation";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// POST /api/access/propagation  (SEAMAN-controlled — consent stays with the data subject)
//   { seafarerId, agentId, bucket:"contact"|"financial", on:boolean, token }
//
// AUTHZ: the OWNER share token (either link) must resolve to `seafarerId` — the exact
// ownerAuthorised() possession-trust pattern. A token for another seafarer => 404. An agent
// may NOT self-grant propagation (it can only use the async request lane); this route is
// seaman-only, so it takes no agent session. Writes go through propagation.setPropagation
// (transact + consent event).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    seafarerId?: string;
    agentId?: string;
    bucket?: string;
    on?: boolean;
    token?: string;
  };
  const seafarerId = (body.seafarerId ?? "").trim();
  const agentId = (body.agentId ?? "").trim();
  const bucket = body.bucket === "financial" ? "financial" : body.bucket === "contact" ? "contact" : null;
  const token = (body.token ?? "").trim();
  const on = body.on === true;

  if (!seafarerId || !agentId || !bucket) {
    return NextResponse.json(
      { ok: false, error: "seafarerId, agentId and a valid bucket are required." },
      { status: 400 }
    );
  }

  // Owner possession-trust via the CHOKEPOINT: open + email token, ungated
  // (PHASE0-CENSUS row 16 audit — plan R15, behavior preserved). Sample -> 403.
  const subject = token ? resolveTokenSubject(readDB(), token, "write", ["open", "email"]) : null;
  if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
  if (!subject || subject.seafarer.id !== seafarerId) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  const res = await setPropagation(seafarerId, agentId, bucket, on, `seafarer:${seafarerId}`);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.reason ?? "no grant" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, grant: res.grant });
}
