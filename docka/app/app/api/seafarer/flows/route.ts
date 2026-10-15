import { NextResponse } from "next/server";
import { seamanSession } from "@/lib/seaman-session";
import { flowsForSeafarer } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/seafarer/flows — the signed-in SEAMAN's "My applications" list.
//
// The canonical seaman-scoped API for the flows section + the live-refresh source
// after a revoke on the signed-in page. Fail-closed: the acting seaman is resolved
// ONLY from the seaman SESSION (seamanSession -> seafarerId), NEVER from any id or
// token in the request, so a seaman can only ever read THEIR OWN flows. It resolves
// no agent identity at all (never resolves an agent session), so a seaman session can
// never gain agent scope. In TOKEN mode there is no seamanSession, so this route 401s —
// the token-mode page uses the payload-embedded `flows` and refreshes via ?token=.
export async function GET() {
  const session = await seamanSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Not signed in as a seafarer." },
      { status: 401 }
    );
  }
  const flows = flowsForSeafarer(session.seafarerId);
  return NextResponse.json({ ok: true, flows });
}
