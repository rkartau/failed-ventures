import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { readDB, appendAudit, AUDIT_NO_IMPERSONATION } from "@/lib/db";
import {
  IMPERSONATION_ENABLED,
  resolveImpersonation,
  startImpersonation,
  stopImpersonation,
} from "@/lib/impersonation";

export const dynamic = "force-dynamic";

// Admin "act as any seaman or agent" control endpoint. Every verb is gated on
// adminSession() (real Google + allowlist only; NO dev door). The acting admin's
// e-mail is ALWAYS derived from the session, NEVER the request body. The target id
// is validated against the store (startImpersonation) — a client-supplied id is
// never trusted. This module references ONLY adminSession → the isolation static
// guard classifies it "n/a (not agent-facing)".

/** Resolve the display name for the current target (for the banner). */
function targetName(kind: "seaman" | "agent", targetId: string): string | null {
  const db = readDB();
  if (kind === "seaman") return db.seafarers.find((s) => s.id === targetId)?.name ?? null;
  return db.agents.find((a) => a.id === targetId)?.orgName ?? null;
}

// GET — current impersonation state for the signed-in admin (drives the banner).
export async function GET() {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();
  const res = resolveImpersonation(email);
  if (res.state === "active") {
    return NextResponse.json({
      ok: true,
      state: "active",
      targetKind: res.record.targetKind,
      targetId: res.record.targetId,
      targetName: targetName(res.record.targetKind, res.record.targetId),
      expiresAt: res.record.expiresAt,
    });
  }
  if (res.state === "suspended") {
    return NextResponse.json({ ok: true, state: "suspended" });
  }
  return NextResponse.json({ ok: true, state: "none" });
}

// PUT — start (or replace) impersonation. body { targetKind, targetId }.
export async function PUT(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  if (!IMPERSONATION_ENABLED) {
    return NextResponse.json(
      { ok: false, error: "Impersonation is disabled." },
      { status: 403 }
    );
  }
  const email = (admin.user.email ?? "").trim().toLowerCase();
  const body = (await req.json().catch(() => ({}))) as {
    targetKind?: string;
    targetId?: string;
  };
  const targetKind = body.targetKind;
  const targetId = (body.targetId ?? "").trim();
  if ((targetKind !== "seaman" && targetKind !== "agent") || !targetId) {
    return NextResponse.json(
      { ok: false, error: "targetKind ('seaman'|'agent') and targetId are required." },
      { status: 400 }
    );
  }

  let record;
  try {
    record = await startImpersonation({ adminEmail: email, targetKind, targetId });
  } catch {
    // startImpersonation throws only when the target does not exist.
    return NextResponse.json({ ok: false, error: "Target not found." }, { status: 404 });
  }

  await appendAudit(
    "admin-audit",
    {
      at: new Date().toISOString(),
      adminEmail: email,
      action: "impersonate-start",
      targetKind,
      targetId,
    },
    AUDIT_NO_IMPERSONATION
  );

  return NextResponse.json({
    ok: true,
    state: "active",
    targetKind: record.targetKind,
    targetId: record.targetId,
    targetName: targetName(record.targetKind, record.targetId),
    expiresAt: record.expiresAt,
  });
}

// DELETE — stop impersonation (Exit). Idempotent; also the expiry-recovery path.
export async function DELETE() {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();
  await stopImpersonation(email);
  await appendAudit(
    "admin-audit",
    {
      at: new Date().toISOString(),
      adminEmail: email,
      action: "impersonate-stop",
    },
    AUDIT_NO_IMPERSONATION
  );
  return NextResponse.json({ ok: true, state: "none" });
}
