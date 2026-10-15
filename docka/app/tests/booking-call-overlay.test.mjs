// Unit tests for the "Booking call" overlay (book-a-call-outreach-plan Wave B1/B2).
//
// PURE: annotateBookingCall joins live bookings onto board leads by EXACT
// leadKey===sendKey. No store/IO. Plus STATIC source guards on the admin page
// (the harness cannot render the JSX server component — same house pattern as
// tests/pricing-page.test.mjs), asserting the badge + KPI tile + honest tooltip +
// unmatched note are wired and PIPELINE_STAGES was NOT polluted with booking_call.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/booking-call-overlay.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateBookingCall,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  MAX_RENDER_ROWS,
  visibleLeads,
} from "@/lib/outreach-snapshot";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(TESTS_DIR, "..");

// A minimal lead — only sendKey (+ company, used for the no-company-read proof) matters.
function mkLead(sendKey, over = {}) {
  return {
    sendKey,
    company: `Co ${sendKey}`,
    country: "EE",
    angle: "A",
    stage: "queued",
    sentiment: "neutral",
    lastEvent: "",
    lastEventAt: null,
    nextAction: null,
    nextActionDue: null,
    ...over,
  };
}

// ---- exact match ------------------------------------------------------------

test("annotateBookingCall: exact leadKey===sendKey sets booked:true; non-match false", () => {
  const leads = [mkLead("LD00001"), mkLead("LD00002"), mkLead("LD00003")];
  const bookings = [{ leadKey: "LD00002", status: "booked" }];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(byKey.get("LD00001").booked, false);
  assert.equal(byKey.get("LD00002").booked, true);
  assert.equal(byKey.get("LD00003").booked, false);
  assert.equal(kpiCount, 1);
  assert.equal(unmatchedCount, 0);
});

test("annotateBookingCall: empty/absent leadKey never matches (and empty sendKey never matches)", () => {
  const leads = [mkLead(""), mkLead("LD00009")];
  const bookings = [
    { leadKey: "", status: "booked" },
    { status: "booked" }, // absent leadKey
    { leadKey: undefined, status: "booked" },
  ];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(byKey.get("").booked, false, "empty sendKey never matches an empty booking key");
  assert.equal(byKey.get("LD00009").booked, false);
  assert.equal(kpiCount, 0);
  assert.equal(unmatchedCount, 0, "empty/absent booking keys are ignored, not unmatched");
});

test("annotateBookingCall: kpiCount counts DISTINCT matched leads across the full snapshot", () => {
  const leads = [mkLead("LD1"), mkLead("LD2"), mkLead("LD3"), mkLead("LD4")];
  const bookings = [
    { leadKey: "LD1", status: "booked" },
    { leadKey: "LD1", status: "booked" }, // duplicate booking, same lead -> still 1
    { leadKey: "LD3", status: "booked" },
  ];
  const { kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(kpiCount, 2, "LD1 (deduped) + LD3");
  assert.equal(unmatchedCount, 0);
});

test("annotateBookingCall: unmatchedCount counts distinct booking keys absent from the whole snapshot (forged/guessed)", () => {
  const leads = [mkLead("LD1"), mkLead("LD2")];
  const bookings = [
    { leadKey: "LD1", status: "booked" }, // matches -> kpi
    { leadKey: "LD999", status: "booked" }, // forged/guessed -> unmatched
    { leadKey: "LD999", status: "booked" }, // same forged key -> still 1 distinct
    { leadKey: "LD888", status: "booked" }, // another off-snapshot -> unmatched
  ];
  const { kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(kpiCount, 1);
  assert.equal(unmatchedCount, 2, "LD999 (deduped) + LD888");
});

test("annotateBookingCall: no company field is ever read (company-fallback dropped)", () => {
  // Leads whose company EQUALS a booking's leadKey must NOT match — only sendKey joins.
  const leads = [mkLead("LD1", { company: "LD777" })];
  const bookings = [{ leadKey: "LD777", status: "booked" }];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(byKey.get("LD1").booked, false, "company must never be consulted for the join");
  assert.equal(kpiCount, 0);
  assert.equal(unmatchedCount, 1, "the booking key matches no sendKey -> unmatched");
});

// ---- status enum / lifecycle ------------------------------------------------

test("annotateBookingCall: only status==='booked' counts (cancelled excluded from badge + KPI + unmatched)", () => {
  const leads = [mkLead("LD1"), mkLead("LD2")];
  const bookings = [
    { leadKey: "LD1", status: "cancelled" }, // must not badge/count
    { leadKey: "LD-forged", status: "cancelled" }, // must not land in unmatched either
  ];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(byKey.get("LD1").booked, false, "a cancelled booking must not badge its lead");
  assert.equal(kpiCount, 0);
  assert.equal(unmatchedCount, 0, "cancelled forged key is not surfaced as unmatched");
});

test("annotateBookingCall: cancelled-then-rebooked same lead counts as exactly 1 distinct lead", () => {
  const leads = [mkLead("LD1")];
  const bookings = [
    { leadKey: "LD1", status: "cancelled" },
    { leadKey: "LD1", status: "booked" },
  ];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);
  assert.equal(byKey.get("LD1").booked, true);
  assert.equal(kpiCount, 1, "distinct-lead dedupe -> exactly 1");
  assert.equal(unmatchedCount, 0);
});

// ---- >1000-lead render-cap fixture ------------------------------------------

test("annotateBookingCall: a matched lead beyond the 1000-row display cap counts in kpiCount (not unmatched) and renders no row", () => {
  // Build >1000 leads. Give them a DISPLAY_RANK that sinks a specific target below row 1000.
  // The target is stage "queued" (rank 6) while the first 1000+ are "trial_won" (rank 0),
  // so visibleLeads sorts the target past MAX_RENDER_ROWS.
  const leads = [];
  const highPriorityCount = MAX_RENDER_ROWS + 50; // 1050 trial_won leads render first
  for (let i = 0; i < highPriorityCount; i++) {
    leads.push(mkLead(`HP${i}`, { stage: "trial_won" }));
  }
  const target = mkLead("LD-target", { stage: "queued" }); // sinks to the bottom
  leads.push(target);

  const bookings = [{ leadKey: "LD-target", status: "booked" }];
  const { byKey, kpiCount, unmatchedCount } = annotateBookingCall(leads, bookings);

  assert.equal(byKey.get("LD-target").booked, true, "matched even though it is past the cap");
  assert.equal(kpiCount, 1, "counted in the KPI");
  assert.equal(unmatchedCount, 0, "NOT mislabeled as forged/unmatched");

  // It renders NO row (past MAX_RENDER_ROWS), so kpiCount can exceed visible badges.
  const { rows } = visibleLeads(leads);
  assert.equal(rows.length, MAX_RENDER_ROWS, "table caps at 1000 rows");
  const rendered = rows.some((l) => l.sendKey === "LD-target");
  assert.equal(rendered, false, "the matched lead beyond the cap renders no row");
  const visibleBadges = rows.filter((l) => byKey.get(l.sendKey)?.booked).length;
  assert.ok(kpiCount > visibleBadges, "kpiCount may exceed visible emerald badges (v2 invariant dropped)");
});

test("annotateBookingCall: deterministic given the same inputs", () => {
  const leads = [mkLead("LD1"), mkLead("LD2"), mkLead("LD3")];
  const bookings = [{ leadKey: "LD2", status: "booked" }, { leadKey: "LDx", status: "booked" }];
  const a = annotateBookingCall(leads, bookings);
  const b = annotateBookingCall(leads, bookings);
  assert.equal(a.kpiCount, b.kpiCount);
  assert.equal(a.unmatchedCount, b.unmatchedCount);
  assert.deepEqual([...a.byKey.entries()], [...b.byKey.entries()]);
});

// ---- STATIC source guards on the admin page ---------------------------------

test("static: PIPELINE_STAGES / TERMINAL_STAGES vocabulary is NOT polluted with booking_call", () => {
  assert.equal(PIPELINE_STAGES.includes("booking_call"), false);
  assert.equal(TERMINAL_STAGES.includes("booking_call"), false);
});

test("static: admin/outreach page wires the overlay (single readDB, badge, KPI, honest tooltip, unmatched note)", () => {
  const src = fs.readFileSync(path.join(APP_DIR, "app", "admin", "outreach", "page.tsx"), "utf-8");

  // Single readDB() in this render path (the board comes from readOutreachSnapshot).
  const readDbCalls = (src.match(/readDB\(\)/g) ?? []).length;
  assert.equal(readDbCalls, 1, "exactly one readDB() call in the render path");
  assert.match(src, /status === "booked"/, "derives liveBookings from status:'booked'");
  assert.match(src, /annotateBookingCall\(activeLeads, liveBookings\)/, "injects active leads + live bookings");

  // The emerald "Booking call" badge, driven by the byKey boolean prop.
  assert.match(src, /Booking call/, "renders the 'Booking call' label");
  assert.match(src, /border-emerald-200/, "badge/KPI use the emerald tone");
  assert.match(src, /byKey\.get\(lead\.sendKey\)\?\.booked/, "per-row badge via byKey lookup");
  assert.match(src, /booked=\{/, "passes the boolean into presentational LeadRow");

  // Honest KPI tooltip wording (reported, not verified).
  assert.match(src, /reported, not verified/, "honest KPI/badge wording present");

  // Unmatched secondary note, guarded by >0.
  assert.match(src, /unmatchedCount > 0/, "unmatched note only renders when > 0");
  assert.match(src, /unmatched outreach bookings:/, "unmatched note text present");
});

test("static: /book page passes leadKey; BookClient forwards it in the POST body; route re-sanitizes", () => {
  const pageSrc = fs.readFileSync(path.join(APP_DIR, "app", "book", "page.tsx"), "utf-8");
  assert.match(pageSrc, /pickLeadKey\(searchParams/, "server page extracts ?lead via pickLeadKey");
  assert.match(pageSrc, /leadKey \? \{ leadKey \}/, "passes leadKey down only when present");

  const clientSrc = fs.readFileSync(path.join(APP_DIR, "app", "book", "BookClient.tsx"), "utf-8");
  assert.match(clientSrc, /\.\.\.\(leadKey \? \{ leadKey \} : \{\}\)/, "client adds leadKey to the POST body");

  const routeSrc = fs.readFileSync(path.join(APP_DIR, "app", "api", "book", "route.ts"), "utf-8");
  assert.match(routeSrc, /sanitizeLeadKey\(body\.leadKey\)/, "route RE-sanitizes body.leadKey");
});
