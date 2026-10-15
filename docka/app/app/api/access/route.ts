import { NextRequest, NextResponse } from "next/server";
import { readDB } from "@/lib/db";
import { reviewsForSeafarer, revokeGrant, regrantGrant } from "@/lib/access";

export const dynamic = "force-dynamic";

// Seaman-side transparency + control API (the seaman's own "Access & reviews"
// view). Keyed by the seaman's own seafarerId (held in their browser, same trust
// model as the rest of the seaman self-service surface — the agent side is what is
// grant-scoped and audited).

// GET /api/access?seafarerId=...
//   -> per-agent transparency rows: who has access, their last REVIEW-level action
//      and when, the grant status (Active / Locked until return / Revoked), read
//      from the append-only access log + the grants. Doubles as GDPR Art.15.
export async function GET(req: NextRequest) {
  const seafarerId = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  const exists = readDB().seafarers.some((s) => s.id === seafarerId);
  if (!exists) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, reviews: reviewsForSeafarer(seafarerId) });
}

// POST /api/access  { action: "revoke" | "regrant", grantId, seafarerId }
//   revoke  -> the seaman withdraws an agent's access. An ACTIVE grant is revoked; a
//      LOCKED grant (at sea under that agent) OR one whose agency stage is
//      sent_to_sea/returning is BLOCKED (409) with a clear reason (HARD sea-lock +
//      #16 stage gate — see lib/access.ts).
//   regrant -> the seaman re-grants a previously REVOKED agent, reactivating the grant
//      in place (#15). A non-REVOKED grant is a 400 no-op reject.
//   In BOTH cases the grantId must belong to the given seafarerId, so one seaman can
//   only act on their OWN grants.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    grantId?: string;
    seafarerId?: string;
  };
  if (body.action !== "revoke" && body.action !== "regrant") {
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  }
  const grantId = (body.grantId ?? "").trim();
  const seafarerId = (body.seafarerId ?? "").trim();
  if (!grantId || !seafarerId) {
    return NextResponse.json(
      { ok: false, error: "grantId and seafarerId are required." },
      { status: 400 }
    );
  }

  // Ownership check (shared by revoke + regrant): the grant must belong to THIS
  // seafarer. A grantId owned by another seaman is rejected as not-found.
  const grant = readDB().accessGrants.find((g) => g.id === grantId);
  if (!grant || grant.seafarerId !== seafarerId) {
    return NextResponse.json({ ok: false, error: "Grant not found." }, { status: 404 });
  }

  if (body.action === "regrant") {
    const result = await regrantGrant(grantId, `seafarer:${seafarerId}`);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.reason ?? "Could not re-grant access." },
        { status: 400 }
      );
    }
    // Return the fresh transparency rows so the UI updates in one round-trip.
    return NextResponse.json({ ok: true, reviews: reviewsForSeafarer(seafarerId) });
  }

  const result = await revokeGrant(grantId, `seafarer:${seafarerId}`);
  if (result.blocked) {
    return NextResponse.json(
      { ok: false, blocked: true, error: result.reason },
      { status: 409 }
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.reason ?? "Could not revoke access." },
      { status: 400 }
    );
  }
  // Return the fresh transparency rows so the UI updates in one round-trip.
  return NextResponse.json({ ok: true, reviews: reviewsForSeafarer(seafarerId) });
}
