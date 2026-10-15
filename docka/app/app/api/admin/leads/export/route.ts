// app/api/admin/leads/export/route.ts — §15 lead export for the outreach
// pipeline (GET only).
//
// Thin HTTP shell: auth = admin session OR Bearer LEADS_READ_TOKEN (hash in
// .env.local, lib/machine-token.ts), rate limit on bearer attempts
// (directory-route pattern), then serve the flattened content/docka-leads.json
// via lib/leads-export-store.ts. The snapshot travels to the box by scp
// (gitignored, GDPR) — until the first publish the route answers the
// documented 503 {ok:false, reason:"no lead snapshot"}.
//
// Deny shape: 401 {ok:false} (NOT the admin pages' 404) — this is a machine
// endpoint whose consumer (import_leads.py) treats any non-200 as
// fail-closed "keep the current lead set"; an honest 401 aids operator
// debugging without disclosing anything else.
//
// NOTE: the spec's example path is /admin/api/leads/export, but middleware.ts
// edge-gates ALL of /admin/:path* to Google-session admins — a token client
// would be redirected to sign-in before reaching the handler. The repo's
// admin-API home (/api/admin/*, isolation-static's positive lock) is the
// correct, reachable location; the pipeline only sees the configured URL.

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import {
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
  verifyMachineToken,
} from "@/lib/machine-token";
import { exportFailureResponse } from "@/lib/leads-export";
import { readLeadsExport } from "@/lib/leads-export-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  let actor: string | null = null;

  const admin = await adminSession();
  if (admin) {
    actor = (admin.user.email ?? "").trim().toLowerCase();
  } else {
    // Bearer path: rate-limit BEFORE the hash compare so token guessing and
    // export hammering share one bounded budget per client IP.
    if (!consumeBudget(MACHINE_TOKEN_BUCKET, clientIpFromHeaders(req.headers), MACHINE_TOKEN_BUDGET)) {
      return NextResponse.json({ ok: false, error: "Rate limited" }, { status: 429 });
    }
    const machine = verifyMachineToken(req.headers.get("authorization"), "leads-read");
    if (!machine.ok) return NextResponse.json({ ok: false }, { status: 401 });
    actor = machine.actor;
  }

  const read = readLeadsExport();
  if (read.status !== "ok") {
    const fail = exportFailureResponse(read.status);
    return NextResponse.json(fail.body, { status: fail.httpStatus });
  }

  await recordAdminAction({
    adminEmail: actor,
    action: "leads-export",
    detail: { bytes: Buffer.byteLength(read.body, "utf8") },
  });

  return new NextResponse(read.body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
