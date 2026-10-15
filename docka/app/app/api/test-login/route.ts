import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DEV_COOKIE, isDevLoginEnabled } from "@/lib/agent-session";
import { readDB } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/test-login  { agentId? } -> sets a dev agent session cookie for the
// CHOSEN demo agent (multi-tenant picker). Active only when NODE_ENV !==
// "production"; hard-disabled (403) in prod builds. There is no role concept
// (medical gating is off): the chosen agent sees exactly the seafarers who granted
// it access (grant-scoped, lib/agentData.ts). Omitting agentId keeps the legacy
// "dev" tenant.
export async function POST(req: NextRequest) {
  if (!isDevLoginEnabled) {
    return NextResponse.json(
      { ok: false, error: "Test login is disabled in production." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { agentId?: string };
  const requested = (body.agentId ?? "").trim();
  // Only allow a known seeded agent id, or the legacy "dev" tenant. Public Sample
  // Profiles: the sample agency is EXCLUDED — even a dev demo must never mint a
  // session for it (falls back to the "dev" tenant instead).
  const known = new Set(readDB().agents.filter((a) => a.isSample !== true).map((a) => a.id));
  const agentId = requested && (known.has(requested) || requested === "dev") ? requested : "dev";

  cookies().set(DEV_COOKIE, agentId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return NextResponse.json({ ok: true, agentId });
}

// DELETE /api/test-login -> sign the dev agent out again.
export async function DELETE() {
  cookies().delete(DEV_COOKIE);
  return NextResponse.json({ ok: true });
}
