// app/api/admin/outreach/signup-emails/route.ts — D5 import-time signup
// recheck source for the outreach pipeline (GET only; go-live readiness plan
// 2026-08-25, item 3 + D5).
//
// Before the pipeline lets a NEWLY imported lead enter the cold sequence, it
// asks this endpoint whether the lead's email already belongs to an existing
// product user. Privacy boundary: the response carries ONLY
// HMAC-SHA256(TRACKING_HMAC_SECRET, normalized_email) lowercase-hex digests —
// neither the raw user-email list nor the raw lead list ever crosses the
// app/pipeline boundary (lib/email-match.ts owns the shared normalization,
// pinned by tests/fixtures/email-normalize-golden.json in both repos).
//
// Auth mirrors /api/admin/leads/export exactly: admin session OR Bearer
// LEADS_READ_TOKEN (lib/machine-token.ts "leads-read" scope — the pipeline
// already holds this credential; no new secret surface), bearer attempts
// rate-limited BEFORE the hash compare. Deny shape 401 {ok:false} (machine
// endpoint, honest for operator debugging).
//
// With TRACKING_HMAC_SECRET unset the digests cannot be minted -> 503
// {ok:false, reason:"unconfigured"} (mirrors the /o and /u fail-closed
// stance). Email sources: credentialUsers.emailUnverified (password signups)
// + agents.googleEmail (Google-login agencies) — the accounts a cold send
// could wrongly target.

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import { readDB } from "@/lib/db";
import { normalizeEmailForMatch, hmacEmailHex } from "@/lib/email-match";
import { TRACKING_SECRET_ENV } from "@/lib/tracking-token";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  let actor: string | null = null;

  const admin = await adminSession();
  if (admin) {
    actor = (admin.user.email ?? "").trim().toLowerCase();
  } else {
    // Bearer path: rate-limit BEFORE the hash compare (leads/export pattern).
    if (!consumeBudget(MACHINE_TOKEN_BUCKET, clientIpFromHeaders(req.headers), MACHINE_TOKEN_BUDGET)) {
      return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
    }
    const machine = verifyMachineToken(req.headers.get("authorization"), "leads-read");
    if (!machine.ok) return NextResponse.json({ ok: false }, { status: 401 });
    actor = machine.actor;
  }

  const secret = (process.env[TRACKING_SECRET_ENV] ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, reason: "unconfigured" }, { status: 503 });
  }

  const db = readDB();
  const normalized = new Set<string>();
  for (const u of db.credentialUsers) {
    if (u.emailUnverified) normalized.add(normalizeEmailForMatch(u.emailUnverified));
  }
  for (const a of db.agents) {
    if (a.googleEmail) normalized.add(normalizeEmailForMatch(a.googleEmail));
  }
  normalized.delete("");
  // Sorted digests: a stable wire (and no insertion-order signal about the DB).
  const hmacs = [...normalized].map((e) => hmacEmailHex(e, secret)).sort();

  await recordAdminAction({
    adminEmail: actor,
    action: "signup-emails-export",
    detail: { count: hmacs.length },
  });

  return NextResponse.json(
    {
      ok: true,
      algo: "hmac-sha256",
      normalization: "trim-nfc-lower-idna",
      count: hmacs.length,
      hmacs,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
