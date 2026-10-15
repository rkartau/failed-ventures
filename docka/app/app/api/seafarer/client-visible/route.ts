import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { setClientVisible } from "@/lib/propagation";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// #42 — SEAMAN-controlled per-agency client-portal visibility toggle.
//   { seafarerId, agentId, on:boolean, token }
//
// AUTHZ mirrors /api/access/propagation exactly: the OWNER share token (either link)
// must resolve to `seafarerId` (possession-trust). A token for another seafarer => 404.
// This route takes NO agent session — an agent can never self-grant client visibility.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    seafarerId?: string;
    agentId?: string;
    on?: boolean;
    token?: string;
  };
  const seafarerId = (body.seafarerId ?? "").trim();
  const agentId = (body.agentId ?? "").trim();
  const token = (body.token ?? "").trim();
  const on = body.on === true;

  if (!seafarerId || !agentId) {
    return NextResponse.json(
      { ok: false, error: "seafarerId and agentId are required." },
      { status: 400 }
    );
  }

  // Owner possession-trust via the CHOKEPOINT: open + email token, ungated
  // (PHASE0-CENSUS row 20 audit — plan R15, behavior preserved). Sample -> 403,
  // so `clientVisible` can never be set for a sample subject (portal exclusion).
  const subject = token ? resolveTokenSubject(readDB(), token, "write", ["open", "email"]) : null;
  if (subject === SAMPLE_WRITE_DENIED) return sampleReadOnlyResponse();
  if (!subject || subject.seafarer.id !== seafarerId) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }

  const res = await setClientVisible(seafarerId, agentId, on, `seafarer:${seafarerId}`);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.reason ?? "no grant" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, grant: res.grant });
}
