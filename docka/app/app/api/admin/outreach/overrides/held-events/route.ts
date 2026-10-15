// app/api/admin/outreach/overrides/held-events/route.ts — [V6] read-only
// surfacing of opt-out / unsub / bounce events that arrived for a lead DURING a
// manual-hold window (feat/manual-hold).
//
// GET — adminSession() ONLY. Query: ?sendKey=sk_3&since=<hold-start ISO-8601>.
// [B4] `since` MUST be the PIPELINE-authoritative freeze timestamp
// (manual_hold_since), passed by the un-hold confirm dialog, NOT the app click
// time — so an unsub in the gap between click and pipeline-observed freeze is
// not missed. The read is SIDE-EFFECT-FREE and DISTINCT from any fold consumer
// cursor: it advances no cursor and writes no suppression/state.
//
// DEPENDENCY NOTE: the durable "outreach-events" inbound log is part of an
// UNCOMMITTED tracking-events feature and is ABSENT on this clean HEAD. This
// endpoint therefore degrades GRACEFULLY — it validates inputs and returns an
// empty event list (never crashes). The confirm dialog then honestly states "no
// opt-out/bounce events during the hold window" instead of inventing a source.
//
// TODO(manual-hold V6): source held-window events (unsub/bounce/opt-out for
// `sendKey` where event.ts >= `since`) from the durable outreach-events log once
// the tracking-events subsystem merges. Wire it in HERE — the contract, auth,
// validation and the un-hold dialog call site do not change.

import { NextRequest, NextResponse } from "next/server";
import { adminSession } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

const MAX_SENDKEY_LEN = 512;

export type HeldEvent = { type: string; ts: string };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = await adminSession();
  if (!admin) {
    // Mirror the outreach admin deny posture (404 with no session; the browser
    // never presents a Bearer here).
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const url = new URL(req.url);
  const sendKey = url.searchParams.get("sendKey") ?? "";
  const since = url.searchParams.get("since") ?? "";

  if (sendKey === "" || sendKey.length > MAX_SENDKEY_LEN) {
    return NextResponse.json({ ok: false, error: "invalid sendKey" }, { status: 400 });
  }
  // ISO-8601 validation: a real, parseable instant.
  if (since === "" || !Number.isFinite(Date.parse(since))) {
    return NextResponse.json({ ok: false, error: "invalid since (expect ISO-8601)" }, { status: 400 });
  }

  // Graceful degrade: no durable outreach-events source on this HEAD. Read-only,
  // side-effect-free, always well-formed. Replace [] with the real query when the
  // tracking-events subsystem merges (see TODO above).
  const events: HeldEvent[] = [];

  return NextResponse.json({ ok: true, events }, { status: 200, headers: { "cache-control": "no-store" } });
}
