import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";
import { recordAdminAction } from "@/lib/admin-audit";
import { normalizeProbeCountry, probeCountry } from "@/lib/registry-health";

export const dynamic = "force-dynamic";

// POST — fire one country's documented negative-path registry probe (admin
// health panel). Thin HTTP shell over lib/registry-health.ts: adminSession()
// gate (same 404-not-json-error shape as the sibling routes — never reveal
// /admin exists), the 60 s per-country cooldown mapped to 429, one admin-audit
// line per EXECUTED probe. The probe itself goes through resolveInput with
// countryOverride as an internal caller — never a raw fetch.

export async function POST(_req: NextRequest, { params }: { params: { cc: string } }) {
  const admin = await adminSession();
  if (!admin) return NextResponse.json({ ok: false }, { status: 404 });
  const email = (admin.user.email ?? "").trim().toLowerCase();

  // Registry-TABLE lookup, never a shape regex (review fix 2026-08-13): the
  // table's codes are open-ended ("UA-MARAD" is legal), so /^[A-Z]{2}$/ would
  // 400 a real panel row. normalizeProbeCountry = countryEntry() membership.
  const cc = normalizeProbeCountry(params.cc ?? "");
  if (!cc) {
    return NextResponse.json({ ok: false, error: "Invalid country code." }, { status: 400 });
  }

  const res = await probeCountry(cc);

  if (res.status === "not-live" || res.status === "no-probe") {
    return NextResponse.json(
      { ok: false, error: "No probeable live adapter for this country." },
      { status: 404 }
    );
  }
  if (res.status === "cooldown") {
    return NextResponse.json(
      {
        ok: false,
        error: `Probed less than a minute ago — try again in ${Math.ceil(res.retryAfterMs / 1000)} s.`,
      },
      { status: 429 }
    );
  }

  // Loud-fail, never-throw (route convention): the probe already ran — an
  // audit-sink failure must not 500 it; recordAdminAction logs ADMIN-AUDIT-FAILURE.
  await recordAdminAction({
    adminEmail: email,
    action: "verify-uploads-health-probe",
    detail: { country: cc, verdict: res.result.verdict, outcome: res.result.outcome },
  });

  return NextResponse.json({ ok: true, result: res.result });
}
