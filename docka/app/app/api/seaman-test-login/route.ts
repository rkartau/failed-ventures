import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { readDB, updateDB, id, newShareTokens, type Seafarer } from "@/lib/db";
import { DEV_SEAMAN_COOKIE, isDevSeamanLoginEnabled } from "@/lib/seaman-session";

export const dynamic = "force-dynamic";

// POST /api/seaman-test-login  { seafarerId?, name? } -> sets a DEV-ONLY seaman
// SESSION cookie for the persona harness / local development. This is the seaman-side
// mirror of /api/test-login (the agent dev door): active only when NODE_ENV !==
// "production"; hard-disabled (403) in a production build. Because self-signup is now
// GOOGLE-ONLY (the anonymous no-login create path is gone), the harness can no longer
// create seamen through an open endpoint — it authenticates here instead, then fills
// the profile via the authenticated POST /api/seafarers/self.
//
// With no seafarerId it CREATES a fresh owned profile the exact same way real Google
// sign-in would (findOrCreateSeafarerByGoogle case 4) and binds the session to it, so
// the harness gets a clean seaman per call. A supplied, existing seafarerId is adopted
// as-is (re-login to the same profile). The cookie NEVER grants agent scope — the
// agent dev door reads a DIFFERENT cookie (docka_dev_agent).
export async function POST(req: NextRequest) {
  if (!isDevSeamanLoginEnabled) {
    return NextResponse.json(
      { ok: false, error: "Seaman test login is disabled in production." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { seafarerId?: string; name?: string };
  let seafarerId = (body.seafarerId ?? "").trim();
  // Only honour a seafarerId that actually exists; otherwise fall through to create.
  // Public Sample Profiles: a sample id is treated as non-existent — even a dev
  // demo must never mint a seaman session for a public sample row.
  if (
    seafarerId &&
    !readDB().seafarers.some((s) => s.id === seafarerId && s.isSample !== true)
  ) {
    seafarerId = "";
  }
  if (!seafarerId) {
    const created: Seafarer = {
      id: id(),
      name: (body.name ?? "").trim() || "My profile",
      rank: "",
      state: "review",
      ...newShareTokens(),
      createdAt: new Date().toISOString(),
      googleSub: null,
      ownerEmail: null,
    };
    await updateDB((db) => {
      db.seafarers.push(created);
    });
    seafarerId = created.id;
  }

  cookies().set(DEV_SEAMAN_COOKIE, seafarerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return NextResponse.json({ ok: true, seafarerId });
}

// DELETE /api/seaman-test-login -> sign the dev seaman out again.
export async function DELETE() {
  cookies().delete(DEV_SEAMAN_COOKIE);
  return NextResponse.json({ ok: true });
}
