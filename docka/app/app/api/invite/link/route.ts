import { NextRequest, NextResponse } from "next/server";
import { readDB, transact, id, type Seafarer } from "@/lib/db";
import { agentSession } from "@/lib/agent-session";
import { requireBillingWritable } from "@/lib/billing-enforce";
import { impersonationStampFor } from "@/lib/impersonation";
import { grantAccess, openGrantLink, findGrant } from "@/lib/access";
import {
  evaluateShareAccess,
  parseShareToken,
  resolveSeafarerByShareToken,
} from "@/lib/share-access";
import { send as notifySend } from "@/lib/notify";

export const dynamic = "force-dynamic";

// sample-token: exempt(grant-token auth + resolver paste-parse; grant creation on
// sample ids is DENIED below — sample crew join a board ONLY via the public /share
// auto-grant seam; alias acceptance stays exactly as today: view-only skip)
// isolation-guard: exempt — this endpoint mirrors the PUBLIC /share/<token> handshake
// (app/share/[token]/page.tsx:100-106): a signed-in agent who POSSESSES a seaman's share
// token forms the seaman-consented access grant, exactly as opening the link in a browser
// would. Token possession IS the capability. It reads no other tenant's data by agent
// identity — the grants it writes are scoped to its own session's agentId — and it is
// agent-gated below so it can never be driven anonymously.

// POST /api/invite/link
//   { links: string | string[] }   -> add crew by pasting docka share links or bare tokens
// Per pasted row: parse the token, resolve the seaman, and (mirroring /share EXACTLY):
//   - malformed token            -> skipped { status: "invalid" }
//   - no seaman for the token     -> skipped { status: "not-found" }
//   - a carried alias (post-merge)-> skipped { status: "view-only" } (never grants)
//   - private (email) link whose acting agent is NOT allow-listed -> skipped { status: "forbidden" }
//   - no grant yet                -> grantAccess (ACTIVE) + notify the seaman  -> added
//   - PENDING grant               -> openGrantLink (activate)                  -> added
//   - ACTIVE grant, board-hidden  -> clear hiddenByAgentAt + BOARD_RESTORED    -> already-added (no notify)
//   - ACTIVE grant, visible       -> already-added (no notify)
//   - REVOKED / EXPIRED grant     -> skipped { status: "withdrawn" } (NEVER reactivate)
const MAX_ROWS = 200;

export async function POST(req: NextRequest) {
  // Agent-only (401 mirror of app/api/invite/route.ts): only a signed-in agent can add crew.
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { links?: string | string[] };
  let links: string[] = [];
  if (Array.isArray(body.links)) links = body.links.filter((l): l is string => typeof l === "string");
  else if (typeof body.links === "string") links = body.links.split(/[\n,;]+/);
  links = links.map((l) => l.trim()).filter(Boolean);

  if (links.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Paste at least one docka share link or token." },
      { status: 400 }
    );
  }
  if (links.length > MAX_ROWS) {
    return NextResponse.json(
      { ok: false, error: `Too many rows (max ${MAX_ROWS}). Split the paste.` },
      { status: 400 }
    );
  }

  const onBehalf = impersonationStampFor(session);
  const agentId = session.agentId;
  const added: Seafarer[] = [];
  const skipped: { input: string; status: string }[] = [];

  for (const input of links) {
    const token = parseShareToken(input);
    if (!token) {
      skipped.push({ input, status: "invalid" });
      continue;
    }
    // Fresh read per row so a grant created earlier in this same batch is seen.
    const db = readDB();
    const resolved = resolveSeafarerByShareToken(db, token);
    if (!resolved) {
      skipped.push({ input, status: "not-found" });
      continue;
    }
    const { seafarer, mode } = resolved;

    // Census row 26 DENY: the paste lane never creates a grant on a sample id.
    // The flagship is added through the public /share/<token> auto-grant seam
    // instead; board-only sample crew are never reachable by real agents at all.
    if (seafarer.isSample === true) {
      skipped.push({ input, status: "not-found" });
      continue;
    }

    // A carried alias (from an absorbed record) is strictly VIEW-ONLY — never grants,
    // exactly as the /share page skips the handshake when `viaCarriedAlias`.
    if (mode === "alias") {
      skipped.push({ input, status: "view-only" });
      continue;
    }

    // Private (email) link: the token alone is NOT enough — the acting agent's Google
    // e-mail must be on the seaman's allow-list (same gate as the /share page).
    if (mode === "email") {
      const gate = await evaluateShareAccess(seafarer, "email");
      if (!gate.allowed) {
        skipped.push({ input, status: "forbidden" });
        continue;
      }
    }

    const existing = findGrant(db, seafarer.id, agentId);

    if (!existing) {
      // Brand-new (seaman, agent) pair -> ACTIVE grant + notify the seaman ONCE.
      await grantAccess({ seafarerId: seafarer.id, agentId }, onBehalf);
      // Honest notify: recipient = seaman ownerEmail when known, else null (notify.send
      // still records a durable "logged" notifications row — we never CLAIM an e-mail
      // was sent; the UI copy stays "we'll let them know").
      const orgName = session.user.name ?? "An agency";
      await notifySend({
        channel: "email",
        to: { name: seafarer.name, email: seafarer.ownerEmail ?? null },
        subject: "You've been added on docka",
        message:
          `${orgName} added you to their crew board on docka and can now see the ` +
          `documents you shared. You stay in control — you can review or withdraw ` +
          `this access from your docka profile at any time.`,
        kind: "invite:link-add",
      });
      added.push(seafarer);
      continue;
    }

    if (existing.status === "PENDING") {
      // Activate the pending grant, exactly as the /share page does. No re-notify.
      await openGrantLink(existing.shareToken, agentId, onBehalf);
      added.push(seafarer);
      continue;
    }

    if (existing.status === "REVOKED" || existing.status === "EXPIRED") {
      // The seaman withdrew / let it lapse — NEVER silently reactivate here (grantAccess
      // would flip it back to ACTIVE + restore withdrawn consent). Re-approval stays the
      // seaman's call, matching the /share handshake.
      skipped.push({ input, status: "withdrawn" });
      continue;
    }

    // ACTIVE grant already exists. If this agent had board-hidden the seaman, re-adding
    // by link un-hides them (clear hiddenByAgentAt + BOARD_RESTORED) in this route's OWN
    // transact — grantAccess does NOT touch fields on an active grant. No notify (anti-spam).
    if (existing.hiddenByAgentAt) {
      await transact((tdb, audit) => {
        const g = tdb.accessGrants.find((x) => x.id === existing.id);
        if (g && g.hiddenByAgentAt) {
          g.hiddenByAgentAt = null;
          audit("board-events", {
            id: id(),
            at: new Date().toISOString(),
            grantId: g.id,
            seafarerId: g.seafarerId,
            agentId: g.agentId,
            action: "BOARD_RESTORED",
          });
        }
      }, onBehalf);
    }
    skipped.push({ input, status: "already-added" });
  }

  return NextResponse.json({ ok: true, added, skipped });
}
