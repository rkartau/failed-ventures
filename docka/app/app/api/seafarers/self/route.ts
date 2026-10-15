import { NextRequest, NextResponse } from "next/server";
import { updateDB } from "@/lib/db";
import { seamanSession } from "@/lib/seaman-session";
import { newVerifiedDoc, applyVerifiedIdentity } from "@/lib/verify";
import { legacyResultForOutcome, resolveInput } from "@/lib/registry";
import { setDirectoryOptIn } from "@/lib/directory";
import type { VerifiedCert } from "@/lib/cert";

export const dynamic = "force-dynamic";

// POST /api/seafarers/self — AUTHENTICATED seaman self-signup / profile fill-in.
//
// Seaman self-signup is GOOGLE-ONLY. A seaman signs in with Google first (which
// creates their owned profile via findOrCreateSeafarerByGoogle in auth.ts); this
// route lets them FILL that profile in — set the display name / rank, and optionally
// bootstrap the first verified document from a certificate code. Google supplies only
// identity; the seaman still enters the rest here AFTER signing in.
//
// Isolation: the acting seaman is resolved via `seamanSession` (the ONLY seaman
// identity gate) and every write is scoped to the SESSION's OWN `seafarerId` — never
// an id/token taken from the request — so a seaman can only ever create/fill THEIR
// OWN profile. No seaman session => 401. This route resolves NO agent identity, so a
// seaman session never gains agent scope. The anonymous (no-login) create path that
// used to live on POST /api/seafarers is removed (that endpoint now 401s).
//   { name?, rank?, code? }
export async function POST(req: NextRequest) {
  const session = await seamanSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Sign in with Google to create your seafarer profile." },
      { status: 401 }
    );
  }
  const seafarerId = session.seafarerId;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    rank?: string;
    code?: string;
  };
  const typedName = (body.name ?? "").trim();
  const rank = (body.rank ?? "").trim();
  const code = (body.code ?? "").trim();

  // Verify a bootstrap code up front (same contract as the legacy create path) so we
  // can borrow the registry-returned name and store the first verified document.
  // EE behavior is UNCHANGED (a capability-token `verified` outcome creates the doc
  // + identity exactly as before); every OTHER registry outcome is returned as an
  // additive `outcome` payload with the stable legacy error string, so onboarding
  // can still store an unverified doc / show the assist or manual state (§5.2).
  let verified: VerifiedCert | null = null;
  if (code) {
    const outcome = await resolveInput(code);
    if (outcome.kind !== "verified") {
      const legacy = legacyResultForOutcome(outcome);
      return NextResponse.json(
        { ok: false, error: legacy.ok ? "Could not verify that code." : legacy.error, outcome },
        { status: 422 }
      );
    }
    verified = outcome.cert;
  }
  const registryName = verified && verified.hasName ? verified.fullName : "";

  // Apply the fill-in to the session's OWN seafarer, all inside one critical section.
  const outcome = await updateDB((db) => {
    const s = db.seafarers.find((x) => x.id === seafarerId);
    if (!s) return null;
    const name = typedName || registryName || s.name;
    if (name) s.name = name;
    if (rank) s.rank = rank;
    let document = null as ReturnType<typeof newVerifiedDoc> | null;
    if (verified && verified.ok) {
      // The one paste that names the profile is a government verification — store it as
      // the first tracked credential and adopt the registry identity as authoritative.
      document = newVerifiedDoc(s.id, verified);
      applyVerifiedIdentity(s, verified);
      db.documents.push(document);
    }
    return { seafarer: s, document };
  });

  if (!outcome) {
    return NextResponse.json({ ok: false, error: "Profile not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, seafarer: outcome.seafarer, document: outcome.document });
}

// PATCH /api/seafarers/self — #49 seaman directory opt-in toggle (default OFF).
//   { directoryOptIn:boolean }
// Same isolation contract as POST: scoped to the SESSION's OWN seafarerId, no agent.
export async function PATCH(req: NextRequest) {
  const session = await seamanSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  }
  const seafarerId = session.seafarerId;
  const body = (await req.json().catch(() => ({}))) as { directoryOptIn?: boolean };
  const on = body.directoryOptIn === true;
  const res = await setDirectoryOptIn(seafarerId, on);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.reason ?? "Profile not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, seafarer: res.seafarer });
}
