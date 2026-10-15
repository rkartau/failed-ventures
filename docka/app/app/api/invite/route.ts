import { NextRequest, NextResponse } from "next/server";
import { updateDB, id, newShareTokens, type Seafarer } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { impersonationStampFor } from "@/lib/impersonation";
import { grantAccess } from "@/lib/access";
import { coerceCell, isEmailish } from "@/lib/roster-parse";

export const dynamic = "force-dynamic";

// isolation-guard: exempt — this route only CREATES fresh placeholder seafarers for
// the acting agent's own invite flow and grants the ACTING agent access to each of
// them (grantAccess below). It reads NO other tenant's data — the grants it writes
// are scoped to its own session's agentId — so there is no cross-tenant read to
// grant-scope. It is still gated to a signed-in agent below so it cannot be driven
// anonymously.

// POST /api/invite
//   { crew: { name, rank?, dob?, passportNo?, seamanBookNo? }[] }  -> file-upload import
// Bulk-creates placeholder seafarers, each with its own self-upload share link, from an
// imported Excel/CSV roster (name + optional rank/identity per row), then watches who has
// uploaded. The old free-text `{ names }` branch was REMOVED (Bug3): adding crew is now
// FILE UPLOAD (here) or SHARE LINK (POST /api/invite/link) only — a body with no `crew`
// array is a 400. `components/ImportCrew.tsx` posts `{ crew: rows }`, so it is unaffected.
export async function POST(req: NextRequest) {
  // Agent-only: bulk-creating crew placeholders is an agent action, not a public
  // endpoint. An anonymous caller can no longer seed rows into the store.
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    crew?: {
      name?: string;
      rank?: string;
      dob?: string;
      passportNo?: string;
      seamanBookNo?: string;
      // Optional imported contact e-mail (captured per roster row). Stored in the
      // NON-auth `importedEmail` field only — never `ownerEmail` (A6, security).
      email?: string | null;
    }[];
  };

  // Bug3 — FILE-UPLOAD only. No `crew` array (e.g. a legacy `{ names }` body) is a 400:
  // free-text name-add was removed in favour of file upload + share-link add.
  if (!Array.isArray(body.crew)) {
    return NextResponse.json(
      { ok: false, error: "Import a crew file (or add crew by share link)." },
      { status: 400 }
    );
  }

  // #3(critic) input bounds — the SAME caps as /match: ≤200 rows, ≤128 chars per field.
  const MAX_ROWS = 200;
  const FIELD_CAP = 128;
  const cap = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, FIELD_CAP) : "");
  // #37.2 — the import row is widened to carry DOB / passport / seaman's-book so matching
  // at import time is strong (not name-only).
  type InRow = { name: string; rank: string; dob: string | null; passportNo: string | null; seamanBookNo: string | null; importedEmail: string | null };

  let rows: InRow[] = body.crew.map((c) => {
    // Coerce (never-throw) -> cap to FIELD_CAP -> validate; only a passing address is
    // stored, lower-cased. An invalid/absent email is null and NEVER blocks the import.
    const rawEmail = cap(coerceCell(c?.email));
    return {
      name: cap(c?.name),
      rank: cap(c?.rank),
      dob: cap(c?.dob).slice(0, 10) || null,
      passportNo: cap(c?.passportNo) || null,
      seamanBookNo: cap(c?.seamanBookNo) || null,
      importedEmail: isEmailish(rawEmail) ? rawEmail.toLowerCase() : null,
    };
  });

  rows = rows.filter((r) => r.name.length > 0);
  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Provide at least one crew row to invite." },
      { status: 400 }
    );
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `Too many rows (max ${MAX_ROWS}). Split the import.` },
      { status: 400 }
    );
  }

  const created: Seafarer[] = rows.map((r) => ({
    id: id(),
    name: r.name,
    rank: r.rank,
    state: "review",
    ...newShareTokens(),
    createdAt: new Date().toISOString(),
    invited: true,
    // Provenance — gates the hidden-crew hard delete (only the creator may erase).
    createdByAgentId: session.agentId,
    // #37.2 — persist import identity fields for later matching.
    birthDate: r.dob,
    passportNo: r.passportNo,
    seamanBookNo: r.seamanBookNo,
    // A6 — store the imported contact e-mail in the NON-auth field only. ownerEmail is
    // left unset so an imported address can never gate a seaman sign-in / takeover.
    importedEmail: r.importedEmail,
  }));

  await updateDB((db) => {
    db.seafarers.push(...created);
  });

  // Grant the INVITING agent access to the placeholders it just created, so its own
  // invited crew appears on its grant-scoped board immediately (agent-created rows —
  // the agent is the source of these, so the grant is not "arbitrary"). Each seafarer
  // is later ADOPTED by the real seaman on sign-in (lib/seaman-account.ts), which
  // keeps this same grant. Serial so each grant + its consent events chain cleanly.
  const onBehalf = impersonationStampFor(session);
  for (const s of created) {
    await grantAccess({ seafarerId: s.id, agentId: session.agentId }, onBehalf);
  }

  return NextResponse.json({ ok: true, seafarers: created });
}
