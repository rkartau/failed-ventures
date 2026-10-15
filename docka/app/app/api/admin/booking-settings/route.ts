// app/api/admin/booking-settings/route.ts — edit the singleton booking settings.
//
// adminSession()-guarded (also satisfies the static isolation build guard). POST a full
// settings object; it is validated (R1 validateSettings -> 400) and edit-locked (R6/CV:
// a timezone/slotMinutes change while any FUTURE booked slot exists -> 409). Weekly-hours
// and horizon edits are always allowed. The decision lives in lib/booking-admin.ts so it
// stays unit-testable without importing this auth-bound module.

import { NextRequest, NextResponse } from "next/server";
import { readDB, updateDB } from "@/lib/db";
import { adminSession } from "@/lib/admin-session";
import { getBookingSettings } from "@/lib/booking";
import { evaluateSettingsUpdate } from "@/lib/booking-admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // Accept either a bare settings object or `{ settings: {...} }`.
  const incoming = (body.settings ?? body) as unknown;

  const result = await updateDB((db) => {
    const decision = evaluateSettingsUpdate(db, incoming, new Date());
    if (!decision.ok) return decision;
    db.bookingSettings = decision.settings;
    return decision;
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, settings: result.settings });
}

// GET -> the current effective settings (stored, else defaults).
export async function GET(req: NextRequest) {
  const admin = await adminSession();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  return NextResponse.json({ ok: true, settings: getBookingSettings(readDB()) });
}
