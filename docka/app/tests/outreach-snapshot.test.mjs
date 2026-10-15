// Unit tests for lib/outreach-snapshot.ts — the outreach dashboard's entire
// logic layer: envelope validation (hard rejects), per-lead coercion (lenient,
// warn-not-reject), warnings cap, byte-accurate size check, BOM tolerance,
// atomic snapshot round-trip + tolerant read, stage counts, the inverted
// display sort under the render cap, freshness/overdue clocks, and the
// isolation guard's exported admin-API lock (meta-test). The auth-gated route
// and page are deliberately NEVER imported.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/outreach-snapshot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Throwaway data dir BEFORE any @/lib import — DATA_DIR is cwd-resolved.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-outreach-"));
process.chdir(TMP);

const lib = await import("@/lib/outreach-snapshot");
const { readOutreachSnapshot, writeOutreachSnapshot } = await import(
  "@/lib/outreach-snapshot-store"
);
const {
  MAX_UPLOAD_BYTES,
  MAX_LEADS,
  MAX_RENDER_ROWS,
  MAX_STORED_WARNINGS,
  STALE_AFTER_MS,
  FUTURE_SKEW_MS,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  stripBom,
  assertUploadSize,
  validateBoard,
  stageCounts,
  visibleLeads,
  freshness,
  isOverdue,
  repliedPlusCount,
} = lib;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(TMP, "data");

const NOW_ISO = new Date().toISOString();

function mkLead(over = {}) {
  return {
    send_key: "sk-1",
    company: "Acme Shipping",
    country: "EE",
    angle: "A",
    stage: "queued",
    sentiment: "neutral",
    last_event: "email sent",
    last_event_at: NOW_ISO,
    next_action: "follow up",
    next_action_due: NOW_ISO,
    ...over,
  };
}

function mkBoard(over = {}) {
  return {
    generated_at: NOW_ISO,
    campaign: { sends_today: 10, daily_cap: 50, bounce_rate_pct: 1.2, halted: false },
    leads: [mkLead()],
    ...over,
  };
}

// ---- validateBoard: happy path ------------------------------------------

test("validateBoard happy path — one lead per stage, mapped fields, zero warnings", () => {
  const stages = [...PIPELINE_STAGES, ...TERMINAL_STAGES];
  const leads = stages.map((stage, i) =>
    mkLead({ send_key: `sk-${i}`, company: `Co ${i}`, stage })
  );
  const res = validateBoard(mkBoard({ leads }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.warnings.length, 0);
  assert.equal(res.snapshot.generatedAt, NOW_ISO);
  assert.equal(res.snapshot.leads.length, stages.length);
  const first = res.snapshot.leads[0];
  assert.deepEqual(first, {
    sendKey: "sk-0",
    company: "Co 0",
    country: "EE",
    angle: "A",
    stage: "queued",
    sentiment: "neutral",
    lastEvent: "email sent",
    lastEventAt: NOW_ISO,
    nextAction: "follow up",
    nextActionDue: NOW_ISO,
    opens: null,
    bounced: null,
    booked: null,
  });
  assert.deepEqual(res.snapshot.campaign, {
    sendsToday: 10,
    dailyCap: 50,
    bounceRatePct: 1.2,
    haltRatePct: null,
    haltThresholdPct: null,
    deadAddressRatePct: null,
    undeliverableRatePct: null,
    halted: false,
  });
});

// ---- validateBoard: hard rejects ----------------------------------------

test("hard reject: non-object root", () => {
  for (const bad of [null, 42, "x", [1]]) {
    const res = validateBoard(bad);
    assert.equal(res.ok, false);
    assert.equal(res.error, "Not a board.json object");
  }
});

test("hard reject: missing or garbage generated_at", () => {
  for (const generated_at of [undefined, null, "garbage", 123]) {
    const res = validateBoard(mkBoard({ generated_at }));
    assert.equal(res.ok, false);
    assert.equal(res.error, "Missing or invalid generated_at");
  }
});

test("hard reject: leads not an array", () => {
  const res = validateBoard(mkBoard({ leads: { a: 1 } }));
  assert.equal(res.ok, false);
  assert.equal(res.error, "leads is not an array");
});

test("hard reject: 5001 raw leads rejected; exactly 5000 accepted", () => {
  const many = Array.from({ length: MAX_LEADS + 1 }, (_, i) => mkLead({ send_key: `k${i}` }));
  const rejected = validateBoard(mkBoard({ leads: many }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, `Too many leads (${MAX_LEADS + 1} > ${MAX_LEADS})`);

  const exact = validateBoard(mkBoard({ leads: many.slice(0, MAX_LEADS) }));
  assert.equal(exact.ok, true);
  assert.equal(exact.snapshot.leads.length, MAX_LEADS);
});

// ---- validateBoard: coercions -------------------------------------------

test("coercion: unknown stage → unknown + warning", () => {
  const res = validateBoard(mkBoard({ leads: [mkLead({ stage: "wat" })] }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].stage, "unknown");
  assert.ok(res.snapshot.warnings.some((w) => /unknown stage/.test(w)));
});

test("coercion: unknown sentiment → none", () => {
  const res = validateBoard(mkBoard({ leads: [mkLead({ sentiment: "elated" })] }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].sentiment, "none");
  assert.ok(res.snapshot.warnings.some((w) => /sentiment/.test(w)));
});

test('coercion: angle "Z" → "?"', () => {
  const res = validateBoard(mkBoard({ leads: [mkLead({ angle: "Z" })] }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].angle, "?");
  assert.ok(res.snapshot.warnings.some((w) => /angle/.test(w)));
});

test('coercion: whitespace company → "—" + warning, file still accepted', () => {
  const res = validateBoard(mkBoard({ leads: [mkLead({ company: "   " })] }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].company, "—");
  assert.ok(res.snapshot.warnings.some((w) => /company/.test(w)));
});

test("coercion: non-object lead among valid ones — skipped + warning, others kept", () => {
  const res = validateBoard(
    mkBoard({ leads: [mkLead({ company: "Keep A" }), 42, mkLead({ company: "Keep B" })] })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads.length, 2);
  assert.deepEqual(
    res.snapshot.leads.map((l) => l.company),
    ["Keep A", "Keep B"]
  );
  assert.ok(res.snapshot.warnings.some((w) => /leads\[1\] not an object/.test(w)));
});

test('coercion: halted:"true" (string) → false + warning', () => {
  const res = validateBoard(
    mkBoard({ campaign: { sends_today: 1, daily_cap: 2, bounce_rate_pct: 0, halted: "true" } })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.campaign.halted, false);
  assert.ok(res.snapshot.warnings.some((w) => /halted not a boolean/.test(w)));
});

test("coercion: bad next_action_due → null", () => {
  const res = validateBoard(mkBoard({ leads: [mkLead({ next_action_due: "not-a-date" })] }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].nextActionDue, null);
  assert.ok(res.snapshot.warnings.some((w) => /next_action_due/.test(w)));
});

test("coercion: missing campaign → all-null + halted false + warning", () => {
  const board = mkBoard();
  delete board.campaign;
  const res = validateBoard(board);
  assert.equal(res.ok, true);
  assert.deepEqual(res.snapshot.campaign, {
    sendsToday: null,
    dailyCap: null,
    bounceRatePct: null,
    haltRatePct: null,
    haltThresholdPct: null,
    deadAddressRatePct: null,
    undeliverableRatePct: null,
    halted: false,
  });
  assert.ok(res.snapshot.warnings.some((w) => /campaign missing/.test(w)));
});

// ---- manual_hold coercion (feat/manual-hold, [R10]) ----------------------

test("manual_hold wire key coerced to manualHold boolean; absent → key omitted", () => {
  const held = validateBoard(mkBoard({ leads: [mkLead({ manual_hold: true })] }));
  assert.equal(held.ok, true);
  assert.equal(held.snapshot.leads[0].manualHold, true);

  // Truthy-but-not-true (string "true") → strict false, never a phantom hold.
  const strung = validateBoard(mkBoard({ leads: [mkLead({ manual_hold: "true" })] }));
  assert.equal(strung.snapshot.leads[0].manualHold, false);

  // Absent → the key is not present at all (legacy leads re-read byte-identical).
  const absent = validateBoard(mkBoard({ leads: [mkLead()] }));
  assert.equal("manualHold" in absent.snapshot.leads[0], false);

  // Stored camelCase key is accepted on re-read too.
  const stored = validateBoard(mkBoard({ leads: [mkLead({ manualHold: true })] }));
  assert.equal(stored.snapshot.leads[0].manualHold, true);
});

// ---- Warnings cap --------------------------------------------------------

test('warnings cap: >50 coercions → 50 stored + final "+ N more warnings"', () => {
  const leads = Array.from({ length: 80 }, (_, i) => mkLead({ send_key: `k${i}`, stage: "bogus" }));
  const res = validateBoard(mkBoard({ leads }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.warnings.length, MAX_STORED_WARNINGS + 1);
  assert.equal(res.snapshot.warnings[MAX_STORED_WARNINGS], "+ 30 more warnings");
});

// ---- Size + BOM ----------------------------------------------------------

test("assertUploadSize: multibyte payload rejected by BYTE length, not char length", () => {
  // "€" is 1 char but 3 UTF-8 bytes → char count under the cap, byte count over.
  const text = "€".repeat(Math.floor(MAX_UPLOAD_BYTES / 3) + 10);
  assert.ok(text.length < MAX_UPLOAD_BYTES);
  assert.ok(Buffer.byteLength(text, "utf8") > MAX_UPLOAD_BYTES);
  const res = assertUploadSize(text);
  assert.equal(res.ok, false);
  assert.equal(res.error, "File too large (max 10 MB)");
  assert.deepEqual(assertUploadSize("small"), { ok: true });
});

test("stripBom: BOM-prefixed valid JSON parses end-to-end through validateBoard", () => {
  const text = "﻿" + JSON.stringify(mkBoard());
  assert.throws(() => JSON.parse(text)); // the BOM is why stripBom exists
  const res = validateBoard(JSON.parse(stripBom(text)));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads.length, 1);
});

// ---- Read / write --------------------------------------------------------

test("round-trip: write → read ok, uploadedAt stamped, payload equal", () => {
  const v = validateBoard(mkBoard());
  assert.equal(v.ok, true);
  const before = Date.now();
  writeOutreachSnapshot(v.snapshot);
  const r = readOutreachSnapshot();
  assert.equal(r.status, "ok");
  assert.equal(r.snapshot.generatedAt, v.snapshot.generatedAt);
  assert.deepEqual(r.snapshot.leads, v.snapshot.leads);
  assert.deepEqual(r.snapshot.campaign, v.snapshot.campaign);
  const up = Date.parse(r.snapshot.uploadedAt);
  assert.ok(Number.isFinite(up) && up >= before - 1000 && up <= Date.now() + 1000);
});

test("overwrite invariant: write A then B → read B only, no .tmp residue", () => {
  const a = validateBoard(mkBoard({ leads: [mkLead({ company: "Board A" })] }));
  const b = validateBoard(mkBoard({ leads: [mkLead({ company: "Board B" })] }));
  writeOutreachSnapshot(a.snapshot);
  writeOutreachSnapshot(b.snapshot);
  const r = readOutreachSnapshot();
  assert.equal(r.status, "ok");
  assert.equal(r.snapshot.leads.length, 1);
  assert.equal(r.snapshot.leads[0].company, "Board B");
  const residue = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("re-read of an already-coerced snapshot emits ZERO new warnings", () => {
  // Upload-time coercions: unknown stage AND out-of-range angle on one lead.
  const v = validateBoard(
    mkBoard({ leads: [mkLead({ stage: "wat", angle: "Z" }), mkLead({ company: "Clean Co" })] })
  );
  assert.equal(v.ok, true);
  assert.equal(v.snapshot.leads[0].stage, "unknown");
  assert.equal(v.snapshot.leads[0].angle, "?");
  assert.ok(v.snapshot.warnings.length > 0);
  writeOutreachSnapshot(v.snapshot);
  const r = readOutreachSnapshot();
  assert.equal(r.status, "ok");
  // Stored warnings stand alone — the sentinels ("unknown", "?") re-read
  // silently, so nothing is appended and the 50-cap math cannot compound.
  assert.deepEqual(r.snapshot.warnings, v.snapshot.warnings);
  assert.equal(r.snapshot.leads[0].stage, "unknown");
  assert.equal(r.snapshot.leads[0].angle, "?");
});

test("missing file → empty", () => {
  fs.rmSync(path.join(DATA_DIR, "outreach-snapshot.json"), { force: true });
  assert.deepEqual(readOutreachSnapshot(), { status: "empty" });
});

test("garbage bytes → corrupt", () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "outreach-snapshot.json"), "not json {", "utf-8");
  assert.deepEqual(readOutreachSnapshot(), { status: "corrupt" });
});

test('stored root with generatedAt:"garbage" → corrupt', () => {
  fs.writeFileSync(
    path.join(DATA_DIR, "outreach-snapshot.json"),
    JSON.stringify({ generatedAt: "garbage", uploadedAt: NOW_ISO, campaign: {}, leads: [] }),
    "utf-8"
  );
  assert.deepEqual(readOutreachSnapshot(), { status: "corrupt" });
});

test('stored leads:[42,"x"] → ok with those leads skipped + warnings, no throw', () => {
  fs.writeFileSync(
    path.join(DATA_DIR, "outreach-snapshot.json"),
    JSON.stringify({
      generatedAt: NOW_ISO,
      uploadedAt: NOW_ISO,
      campaign: { sendsToday: 1, dailyCap: 2, bounceRatePct: 0, halted: false },
      leads: [42, "x", mkLead({ company: "Survivor" })],
      warnings: [],
    }),
    "utf-8"
  );
  const r = readOutreachSnapshot();
  assert.equal(r.status, "ok");
  assert.equal(r.snapshot.leads.length, 1);
  assert.equal(r.snapshot.leads[0].company, "Survivor");
  assert.ok(r.snapshot.warnings.filter((w) => /not an object — skipped/.test(w)).length === 2);
});

// ---- Derived views -------------------------------------------------------

function lead(stage, company = "X") {
  const v = validateBoard(mkBoard({ leads: [mkLead({ stage, company })] }));
  return v.snapshot.leads[0];
}

test("stageCounts: zero-seeded for all stages; counts correct", () => {
  const empty = stageCounts([]);
  for (const s of [...PIPELINE_STAGES, ...TERMINAL_STAGES, "unknown"]) {
    assert.equal(empty.get(s), 0, `seed for ${s}`);
  }
  const counts = stageCounts([lead("queued"), lead("queued"), lead("trial_won"), lead("wat")]);
  assert.equal(counts.get("queued"), 2);
  assert.equal(counts.get("trial_won"), 1);
  assert.equal(counts.get("unknown"), 1);
  assert.equal(counts.get("email1"), 0);
});

test("visibleLeads: truncated flips only past MAX_RENDER_ROWS", () => {
  for (const [n, expectTrunc] of [
    [MAX_RENDER_ROWS - 1, false],
    [MAX_RENDER_ROWS, false],
    [MAX_RENDER_ROWS + 1, true],
  ]) {
    const leads = Array.from({ length: n }, (_, i) => lead("queued", `Co ${i}`));
    const { rows, total, truncated } = visibleLeads(leads);
    assert.equal(total, n);
    assert.equal(truncated, expectTrunc, `n=${n}`);
    assert.equal(rows.length, Math.min(n, MAX_RENDER_ROWS));
  }
});

test("visibleLeads: high-value rows survive the cap (4500 queued + 10 replied)", () => {
  const leads = [
    ...Array.from({ length: 4500 }, (_, i) => lead("queued", `Q ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => lead("replied", `R ${i}`)),
  ];
  const { rows, truncated } = visibleLeads(leads);
  assert.equal(truncated, true);
  const repliedIn = rows.filter((l) => l.stage === "replied").length;
  assert.equal(repliedIn, 10);
  // Replied ranks above queued in DISPLAY order.
  assert.equal(rows[0].stage, "replied");
});

test("visibleLeads: tie-break by company", () => {
  const { rows } = visibleLeads([lead("queued", "Bravo"), lead("queued", "Alpha")]);
  assert.deepEqual(
    rows.map((l) => l.company),
    ["Alpha", "Bravo"]
  );
});

// ---- Clocks --------------------------------------------------------------

test("freshness with injected now", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(freshness(iso(now - STALE_AFTER_MS + 60_000), now), "fresh"); // 24h − 1min
  assert.equal(freshness(iso(now - STALE_AFTER_MS - 60_000), now), "stale"); // 24h + 1min
  assert.equal(freshness(iso(now + FUTURE_SKEW_MS - 1000), now), "fresh"); // skew − 1s
  assert.equal(freshness(iso(now + FUTURE_SKEW_MS + 1000), now), "future"); // skew + 1s
});

test("isOverdue: null false, due==now false, past true", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  assert.equal(isOverdue(null, now), false);
  assert.equal(isOverdue(new Date(now).toISOString(), now), false);
  assert.equal(isOverdue(new Date(now - 1000).toISOString(), now), true);
});

test("repliedPlusCount over a mixed fixture", () => {
  const leads = [
    lead("queued"),
    lead("replied"),
    lead("conversation"),
    lead("trial_won"),
    lead("closed"),
    lead("suppressed"),
  ];
  assert.equal(repliedPlusCount(leads), 3);
});

// ---- Guard meta-test -----------------------------------------------------

test("checkAdminApiRoutes: flags an ungated synthetic admin API route; passes the real one", async () => {
  const { checkAdminApiRoutes } = await import("../tests/isolation-static.mjs");

  const bad = checkAdminApiRoutes([
    { path: "app/api/admin/outreach/route.ts", src: "export async function POST(){}" },
  ]);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].includes("app/api/admin/outreach/route.ts"));

  const realSrc = fs.readFileSync(
    path.join(__dirname, "..", "app", "api", "admin", "outreach", "route.ts"),
    "utf8"
  );
  const good = checkAdminApiRoutes([
    { path: "app/api/admin/outreach/route.ts", src: realSrc },
  ]);
  assert.deepEqual(good, []);
});

// ================= Increment 6: schema v3 — events[] + arms =================

const XSS_BODY = `Hi,</script><img src=x onerror=alert(1)><script>steal()</script> regards`;

function mkEvent(over = {}) {
  return {
    kind: "sent",
    ts: NOW_ISO,
    actor: "pipeline",
    template_id: "A2",
    classification: null,
    arm: "signup",
    body_full: "Hello — full rendered body.",
    thread: "th-1",
    ...over,
  };
}

test("(i6/w3) schema_version gate: absent/1/2/3/4 accepted, anything else rejected", () => {
  for (const sv of [undefined, 1, 2, 3, 4]) {
    const res = validateBoard(mkBoard(sv === undefined ? {} : { schema_version: sv }));
    assert.equal(res.ok, true, `schema_version=${sv}`);
  }
  for (const sv of [5, 0, "3", "v3", {}]) {
    const res = validateBoard(mkBoard({ schema_version: sv }));
    assert.equal(res.ok, false, `schema_version=${JSON.stringify(sv)}`);
    assert.match(res.error, /Unsupported schema_version/);
  }
});

test("(i6) v3 lead events: strict allowlist round-trip; unknown wire fields dropped", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 3,
      leads: [mkLead({ events: [mkEvent({ evil_extra: "x", onclick: "boom()" })] })],
    })
  );
  assert.equal(res.ok, true);
  const evs = res.snapshot.leads[0].events;
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], {
    kind: "sent",
    ts: NOW_ISO,
    actor: "pipeline",
    templateId: "A2",
    classification: null,
    arm: "signup",
    bodyFull: "Hello — full rendered body.",
    thread: "th-1",
  });
  // The allowlist is closed: nothing beyond the eight known fields survives.
  assert.deepEqual(
    Object.keys(evs[0]).sort(),
    ["actor", "arm", "bodyFull", "classification", "kind", "templateId", "thread", "ts"]
  );
});

test("(i6) v2 back-compat: leads without events get NO phantom events key (no flag-day)", () => {
  const res = validateBoard(mkBoard({ schema_version: 2 }));
  assert.equal(res.ok, true);
  assert.equal("events" in res.snapshot.leads[0], false);
  assert.equal("arms" in res.snapshot.campaign, false);
});

test("(i6) events[]: XSS payloads survive as EXACT data (escape-on-render, never sanitize-on-store)", () => {
  const res = validateBoard(
    mkBoard({ schema_version: 3, leads: [mkLead({ events: [mkEvent({ body_full: XSS_BODY })] })] })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.leads[0].events[0].bodyFull, XSS_BODY);
  assert.equal(res.snapshot.warnings.length, 0);
});

test("(i6) events[]: oversize body_full truncated at 20 KB on a codepoint boundary + warning", () => {
  const body = "🚢".repeat(6000); // 24000 bytes UTF-8 — over the 20 KB cap
  const res = validateBoard(
    mkBoard({ schema_version: 3, leads: [mkLead({ events: [mkEvent({ body_full: body })] })] })
  );
  assert.equal(res.ok, true);
  const got = res.snapshot.leads[0].events[0].bodyFull;
  const bytes = Buffer.byteLength(got, "utf8");
  assert.ok(bytes <= lib.MAX_EVENT_BODY_BYTES, `bytes=${bytes}`);
  assert.ok(bytes > lib.MAX_EVENT_BODY_BYTES - 4, "truncates near the cap, not far below");
  // Whole codepoints only — the string re-encodes cleanly (no lone surrogate).
  assert.equal(got, Buffer.from(got, "utf8").toString("utf8"));
  assert.ok(res.snapshot.warnings.some((w) => w.includes("body_full over 20 KB")));
});

test("(i6) events[]: unknown kind skipped + warning; bad ts degrades to null; non-array events dropped", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 3,
      leads: [
        mkLead({ events: [mkEvent({ kind: "exfiltrate" }), mkEvent({ ts: "yesterdayish" })] }),
        mkLead({ send_key: "sk-2", events: "not-an-array" }),
      ],
    })
  );
  assert.equal(res.ok, true);
  const evs = res.snapshot.leads[0].events;
  assert.equal(evs.length, 1);
  assert.equal(evs[0].ts, null);
  assert.equal("events" in res.snapshot.leads[1], false);
  assert.ok(res.snapshot.warnings.some((w) => w.includes('unknown kind "exfiltrate"')));
  assert.ok(res.snapshot.warnings.some((w) => w.includes("ts unparseable")));
  assert.ok(res.snapshot.warnings.some((w) => w.includes("events not an array")));
});

test("(i6) events[]: per-lead count capped, keeping the LAST rows", () => {
  const events = Array.from({ length: lib.MAX_EVENTS_PER_LEAD + 5 }, (_, i) =>
    mkEvent({ template_id: `T${i}` })
  );
  const res = validateBoard(mkBoard({ schema_version: 3, leads: [mkLead({ events })] }));
  assert.equal(res.ok, true);
  const evs = res.snapshot.leads[0].events;
  assert.equal(evs.length, lib.MAX_EVENTS_PER_LEAD);
  assert.equal(evs[evs.length - 1].templateId, `T${lib.MAX_EVENTS_PER_LEAD + 4}`);
  assert.ok(res.snapshot.warnings.some((w) => w.includes("keeping the last")));
});

test("(i6) campaign.arms: parsed when present (wire + stored keys), lenient numerics, absent stays absent", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 3,
      campaign: {
        sends_today: 1,
        arms: {
          signup: { sends: 40, replies: 5, positive_replies: 3, bookings: 1, signups: 2 },
          demo: { sends: 40, replies: 4, positive_replies: "junk", bookings: 2 },
        },
      },
    })
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.snapshot.campaign.arms.signup, {
    sends: 40,
    replies: 5,
    positiveReplies: 3,
    bookings: 1,
    signups: 2,
  });
  assert.equal(res.snapshot.campaign.arms.demo.positiveReplies, null);
  assert.equal(res.snapshot.campaign.arms.demo.signups, null);
  assert.ok(res.snapshot.warnings.some((w) => w.includes("arms.demo.positive_replies")));
});

// ---- Smart bounce-halt breakdown (pipeline commit 8b304f1) ----------------

test("smart-halt: 4 breakdown fields parsed (wire keys), raw bounce_rate_pct kept", () => {
  const res = validateBoard(
    mkBoard({
      campaign: {
        sends_today: 100,
        daily_cap: 200,
        bounce_rate_pct: 4.13,
        halt_rate_pct: 0.3,
        halt_threshold_pct: 2,
        dead_address_rate_pct: 3.8,
        undeliverable_rate_pct: 4.1,
        halted: false,
      },
    })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.campaign.bounceRatePct, 4.13);
  assert.equal(res.snapshot.campaign.haltRatePct, 0.3);
  assert.equal(res.snapshot.campaign.haltThresholdPct, 2);
  assert.equal(res.snapshot.campaign.deadAddressRatePct, 3.8);
  assert.equal(res.snapshot.campaign.undeliverableRatePct, 4.1);
});

test("smart-halt: camelCase stored keys also parse", () => {
  const res = validateBoard(
    mkBoard({
      campaign: {
        bounceRatePct: 4.13,
        haltRatePct: 0.3,
        haltThresholdPct: 2,
        deadAddressRatePct: 3.8,
        undeliverableRatePct: 4.1,
        halted: false,
      },
    })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.campaign.haltRatePct, 0.3);
  assert.equal(res.snapshot.campaign.haltThresholdPct, 2);
  assert.equal(res.snapshot.campaign.deadAddressRatePct, 3.8);
  assert.equal(res.snapshot.campaign.undeliverableRatePct, 4.1);
});

test("smart-halt: absent breakdown fields → null (old snapshot, no phantom values)", () => {
  const res = validateBoard(
    mkBoard({ campaign: { sends_today: 1, daily_cap: 2, bounce_rate_pct: 4.13, halted: false } })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.campaign.bounceRatePct, 4.13);
  assert.equal(res.snapshot.campaign.haltRatePct, null);
  assert.equal(res.snapshot.campaign.haltThresholdPct, null);
  assert.equal(res.snapshot.campaign.deadAddressRatePct, null);
  assert.equal(res.snapshot.campaign.undeliverableRatePct, null);
});

test("smart-halt: negative / non-numeric breakdown → null + warning (lenient contract)", () => {
  const res = validateBoard(
    mkBoard({
      campaign: { sends_today: 1, halt_rate_pct: -1, dead_address_rate_pct: "junk", halted: false },
    })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.campaign.haltRatePct, null);
  assert.equal(res.snapshot.campaign.deadAddressRatePct, null);
  assert.ok(res.snapshot.warnings.some((w) => w.includes("halt_rate_pct")));
  assert.ok(res.snapshot.warnings.some((w) => w.includes("dead_address_rate_pct")));
});

test("smart-halt: stored-snapshot round-trip preserves the breakdown", () => {
  const validated = validateBoard(
    mkBoard({
      campaign: {
        sends_today: 100,
        bounce_rate_pct: 4.13,
        halt_rate_pct: 0.3,
        halt_threshold_pct: 2,
        dead_address_rate_pct: 3.8,
        undeliverable_rate_pct: 4.1,
        halted: false,
      },
    })
  );
  assert.equal(validated.ok, true);
  writeOutreachSnapshot(validated.snapshot);
  const read = readOutreachSnapshot();
  assert.equal(read.status, "ok");
  assert.equal(read.snapshot.campaign.bounceRatePct, 4.13);
  assert.equal(read.snapshot.campaign.haltRatePct, 0.3);
  assert.equal(read.snapshot.campaign.haltThresholdPct, 2);
  assert.equal(read.snapshot.campaign.deadAddressRatePct, 3.8);
  assert.equal(read.snapshot.campaign.undeliverableRatePct, 4.1);
});

test("smart-halt: page headlines the halt rate with a raw-total fallback (static stance)", () => {
  // The admin page is an auth-gated .tsx server component (not importable under
  // node:test); pin its load-bearing bounce-stat stance statically, same
  // precedent as the timeline render-stance meta-test below.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "page.tsx"),
    "utf8"
  );
  // Headline prefers haltRatePct; falls back to the raw bounceRatePct.
  assert.ok(/campaign\.haltRatePct/.test(src), "reads campaign.haltRatePct");
  assert.ok(/bounceIsHalt/.test(src), "branches on halt-rate presence");
  assert.ok(/campaign\.bounceRatePct/.test(src), "keeps raw-total fallback");
  // Colour keys off the halt threshold, not the raw total, when in halt mode.
  assert.ok(/haltRatePct >= haltThresholdPct/.test(src), "tone keys off halt threshold");
  // Breakdown subtext wires up the three breakdown fields.
  assert.ok(/deadAddressRatePct/.test(src) && /undeliverableRatePct/.test(src));
});

test("(i6) extended stages recognised: v3 stages render as themselves, not unknown", () => {
  const leads = lib.EXTENDED_STAGES.map((stage, i) => mkLead({ send_key: `x-${i}`, stage }));
  const res = validateBoard(mkBoard({ schema_version: 3, leads }));
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.warnings.length, 0);
  const counts = stageCounts(res.snapshot.leads);
  for (const s of lib.EXTENDED_STAGES) assert.equal(counts.get(s), 1, s);
  assert.equal(counts.get("unknown"), 0);
  // Display sort: signed_up outranks the timers; undeliverable sinks to the bottom.
  const order = visibleLeads(res.snapshot.leads).rows.map((l) => l.stage);
  assert.ok(order.indexOf("signed_up") < order.indexOf("snoozed"));
  assert.ok(order.indexOf("closed_lost") < order.indexOf("undeliverable"));
});

test("(i6) stored-snapshot round-trip: v3 events + arms survive write → read re-normalization", () => {
  const validated = validateBoard(
    mkBoard({
      schema_version: 3,
      campaign: { sends_today: 2, arms: { signup: { sends: 1 }, demo: {} } },
      leads: [mkLead({ events: [mkEvent({ body_full: XSS_BODY })] })],
    })
  );
  assert.equal(validated.ok, true);
  writeOutreachSnapshot(validated.snapshot);
  const read = readOutreachSnapshot();
  assert.equal(read.status, "ok");
  assert.equal(read.snapshot.leads[0].events[0].bodyFull, XSS_BODY);
  assert.equal(read.snapshot.leads[0].events[0].templateId, "A2");
  assert.equal(read.snapshot.campaign.arms.signup.sends, 1);
  assert.equal(read.snapshot.campaign.arms.demo.sends, null);
});

test("(i6) timeline render stance: escaped JSX text only — no dangerouslySetInnerHTML, body inside <pre>", () => {
  // The timeline is a .tsx server component (JSX — not importable under
  // node:test); pin its load-bearing stance statically (isolation-guard
  // meta-test precedent).
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "timeline.tsx"),
    "utf8"
  );
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  assert.match(src, /<pre[^>]*>\s*\{ev\.bodyFull\}\s*<\/pre>/);
  const page = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "page.tsx"),
    "utf8"
  );
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(page, /LeadTimeline/);
});

test("(i6) truncateUtf8: exact-cap string untouched; multibyte cut lands on a codepoint boundary", () => {
  assert.equal(lib.truncateUtf8("abc", 3), "abc");
  assert.equal(lib.truncateUtf8("abcd", 3), "abc");
  // "é" = 2 bytes: cap 3 keeps "aé" (3 bytes), cap 2 keeps only "a".
  assert.equal(lib.truncateUtf8("aéb", 3), "aé");
  assert.equal(lib.truncateUtf8("aéb", 2), "a");
  // 4-byte emoji never split.
  assert.equal(lib.truncateUtf8("🚀🚀", 7), "🚀");
});

// ============ Wave 3 M1: schema v4 — the "Waiting for you" queue ============

function mkQueueRow(over = {}) {
  return {
    kind: "draft_pending",
    send_key: "sk-1",
    company: "Acme Shipping",
    ts: NOW_ISO,
    label: "Acme Shipping: drafted answer waiting for your approval",
    draft_id: "box:42",
    template_id: "reply_pricing",
    subject: "Re: pricing",
    inbound_id: "<in-1@acme.example.com>",
    body_full: "Happy to walk you through pricing. Tuesday or Wednesday?",
    body_truncated: false,
    footer: "Jaan Sample\n\nDocka Development OÜ,\nReg 17579582\nPrivacy: docka.me/privacy",
    thread: "th-1",
    inbound_body: "What does it cost?",
    inbound_body_truncated: false,
    inbound_ts: NOW_ISO,
    inbound_from_domain: "acme.example.com",
    inbound_subject: "pricing",
    review_kind: null,
    ...over,
  };
}

test("(w3) v4 runsheet: strict allowlist round-trip; unknown wire fields dropped", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [mkQueueRow({ evil_extra: "x", onclick: "boom()", recipient: "a@b.c" })],
    })
  );
  assert.equal(res.ok, true);
  const rows = res.snapshot.runsheet;
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "bodyFull",
    "bodyTruncated",
    "company",
    "draftId",
    "footer",
    "inboundBody",
    "inboundBodyTruncated",
    "inboundFromDomain",
    "inboundId",
    "inboundSubject",
    "inboundTs",
    "kind",
    "label",
    "note",
    "reviewKind",
    "sendKey",
    "subject",
    "templateId",
    "thread",
    "ts",
  ]);
  assert.equal(rows[0].draftId, "box:42");
  assert.equal(rows[0].bodyFull, "Happy to walk you through pricing. Tuesday or Wednesday?");
  // the footer travels SEPARATELY and is never inside the editable body
  assert.match(rows[0].footer, /docka\.me\/privacy/);
  assert.doesNotMatch(rows[0].bodyFull, /docka\.me\/privacy/);
});

test("(w3) v4 back-compat: a board WITHOUT runsheet gets no phantom key (no flag-day)", () => {
  const res = validateBoard(mkBoard({ schema_version: 3 }));
  assert.equal(res.ok, true);
  assert.equal("runsheet" in res.snapshot, false);
  const bad = validateBoard(mkBoard({ schema_version: 4, runsheet: "nope" }));
  assert.equal(bad.ok, true);
  assert.equal("runsheet" in bad.snapshot, false);
  assert.ok(bad.snapshot.warnings.some((w) => /runsheet not an array/.test(w)));
});

test("(w3) runsheet: unknown kind skipped, label-less row skipped, bad ts → null", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [
        mkQueueRow({ kind: "exfiltrate" }),
        mkQueueRow({ label: "   " }),
        mkQueueRow({ ts: "not-a-date" }),
        "not an object",
      ],
    })
  );
  assert.equal(res.ok, true);
  assert.equal(res.snapshot.runsheet.length, 1);
  assert.equal(res.snapshot.runsheet[0].ts, null);
  const w = res.snapshot.warnings.join(" | ");
  assert.match(w, /unknown kind "exfiltrate"/);
  assert.match(w, /has no label/);
  assert.match(w, /not an object/);
});

test("(w3) runsheet: oversize bodies truncated at 20 KB; row count capped", () => {
  const huge = "x".repeat(lib.MAX_EVENT_BODY_BYTES + 500);
  const res = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [mkQueueRow({ body_full: huge, inbound_body: huge })],
    })
  );
  const row = res.snapshot.runsheet[0];
  assert.equal(new TextEncoder().encode(row.bodyFull).length, lib.MAX_EVENT_BODY_BYTES);
  assert.equal(new TextEncoder().encode(row.inboundBody).length, lib.MAX_EVENT_BODY_BYTES);
  assert.ok(res.snapshot.warnings.some((x) => /body_full over 20 KB/.test(x)));
  assert.ok(res.snapshot.warnings.some((x) => /inbound_body over 20 KB/.test(x)));

  const many = Array.from({ length: lib.MAX_RUNSHEET_ITEMS + 7 }, (_, i) =>
    mkQueueRow({ draft_id: `d${i}` })
  );
  const capped = validateBoard(mkBoard({ schema_version: 4, runsheet: many }));
  assert.equal(capped.snapshot.runsheet.length, lib.MAX_RUNSHEET_ITEMS);
  assert.ok(capped.snapshot.warnings.some((x) => /keeping the first 500/.test(x)));
});

test("(w3) runsheet: XSS payloads survive as EXACT data (escape-on-render, never on store)", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [mkQueueRow({ body_full: XSS_BODY, label: XSS_BODY })],
    })
  );
  assert.equal(res.snapshot.runsheet[0].bodyFull, XSS_BODY);
  assert.equal(res.snapshot.runsheet[0].label, XSS_BODY);
});

test("(w3) queueOrder: blockers first, drafts next, newest-first inside a band", () => {
  const older = "2026-08-20T10:00:00.000Z";
  const newer = "2026-08-24T10:00:00.000Z";
  const rows = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [
        mkQueueRow({ kind: "next_action", draft_id: null, ts: newer, label: "todo" }),
        mkQueueRow({ draft_id: "d-old", ts: older, label: "old draft" }),
        mkQueueRow({ kind: "halt", draft_id: null, ts: older, label: "HALT: bounces" }),
        mkQueueRow({ draft_id: "d-new", ts: newer, label: "new draft" }),
      ],
    })
  ).snapshot.runsheet;
  const ordered = lib.queueOrder(rows);
  assert.deepEqual(
    ordered.map((r) => r.label),
    ["HALT: bounces", "new draft", "old draft", "todo"]
  );
  // pendingDrafts sees exactly the actionable rows (draft_pending WITH an id)
  assert.deepEqual(
    lib.pendingDrafts(rows).map((r) => r.draftId),
    ["d-old", "d-new"]
  );
  assert.deepEqual(lib.pendingDrafts(undefined), []);
});

test("(w3) stored-snapshot round-trip: the v4 runsheet survives write → read", () => {
  const res = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkQueueRow()] }));
  writeOutreachSnapshot(res.snapshot);
  const back = readOutreachSnapshot();
  assert.equal(back.status, "ok");
  assert.deepEqual(back.snapshot.runsheet, res.snapshot.runsheet);
});

test("(w3) queue render stance: authed page only, escaped text, anchors not links", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "page.tsx"),
    "utf8"
  );
  // the queue lives INSIDE the adminSession-gated page component
  assert.match(page, /WaitingForYou/);
  assert.match(page, /const session = await adminSession\(\);/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  // explicit empty state + the lead-row anchor targets the click-through uses
  assert.match(page, /outreach-queue-empty/);
  assert.match(page, /id=\{lead\.sendKey \? `lead-\$\{lead\.sendKey\}` : undefined\}/);
  assert.match(page, /href=\{`#lead-\$\{encodeURIComponent\(item\.sendKey\)\}`\}/);
});

// ============ Auto-ack handling (2026-09-08): runsheet kind needs_human ============

function mkNeedsHumanRow(over = {}) {
  return mkQueueRow({
    kind: "needs_human",
    draft_id: "local:3bbe756e",
    label: "Steam Packet: looks like an automated acknowledgement — needs a human look",
    note: "looks like an automated acknowledgement — weak signals (Precedence: bulk); sequence stopped",
    body_full: null,
    footer: null,
    template_id: null,
    inbound_body: "Thank you for contacting us. Your request has been logged as ticket #4821.",
    inbound_from_domain: "steam-packet.example",
    ...over,
  });
}

test("(aa) runsheet: needs_human is a known kind; note survives the allowlist with the draft_pending field set", () => {
  const res = validateBoard(
    mkBoard({ schema_version: 4, runsheet: [mkNeedsHumanRow({ evil_extra: "x", onclick: "boom()" })] })
  );
  assert.equal(res.ok, true);
  assert.ok(lib.RUNSHEET_KINDS.includes("needs_human"));
  assert.ok(lib.ACTIONABLE_RUNSHEET_KINDS.includes("needs_human"));
  assert.ok(lib.ACTIONABLE_RUNSHEET_KINDS.includes("draft_pending"));
  const rows = res.snapshot.runsheet;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "needs_human");
  assert.equal(row.draftId, "local:3bbe756e");
  assert.match(row.note, /automated acknowledgement/);
  assert.equal(row.inboundBody, "Thank you for contacting us. Your request has been logged as ticket #4821.");
  assert.equal(row.inboundFromDomain, "steam-packet.example");
  assert.equal(row.subject, "Re: pricing");
  assert.equal(row.inboundId, "<in-1@acme.example.com>");
  assert.equal(row.thread, "th-1");
  assert.equal(row.company, "Acme Shipping");
  assert.equal(row.sendKey, "sk-1");
  assert.equal("evil_extra" in row, false);
  assert.equal("onclick" in row, false);
  // a draft_pending row carries note: null — ONE row shape for the whole queue
  const draft = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkQueueRow()] })).snapshot.runsheet[0];
  assert.equal(draft.note, null);
  assert.deepEqual(Object.keys(draft).sort(), Object.keys(row).sort());
  // the queue counts it as actionable-but-not-a-draft
  assert.deepEqual(lib.pendingDrafts(rows), []);
});

test("(aa) runsheet: note is capped at 20 KB like the bodies; non-string note → null", () => {
  const huge = "n".repeat(lib.MAX_EVENT_BODY_BYTES + 300);
  const res = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkNeedsHumanRow({ note: huge })] }));
  const row = res.snapshot.runsheet[0];
  assert.equal(new TextEncoder().encode(row.note).length, lib.MAX_EVENT_BODY_BYTES);
  assert.ok(res.snapshot.warnings.some((w) => /note over 20 KB/.test(w)));
  const junk = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkNeedsHumanRow({ note: { a: 1 } })] }));
  assert.equal(junk.snapshot.runsheet[0].note, null);
  // XSS in a note survives as EXACT data (escape-on-render, never on store)
  const xss = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkNeedsHumanRow({ note: XSS_BODY })] }));
  assert.equal(xss.snapshot.runsheet[0].note, XSS_BODY);
});

test("(aa) runsheet: an unknown kind is dropped PER ROW — a needs_human row beside it survives (old-app forward-compat stance)", () => {
  const res = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [
        mkQueueRow({ kind: "needs_robot", draft_id: "x" }),
        mkNeedsHumanRow(),
        mkQueueRow(),
      ],
    })
  );
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.snapshot.runsheet.map((r) => r.kind),
    ["needs_human", "draft_pending"]
  );
  assert.ok(res.snapshot.warnings.some((w) => /unknown kind "needs_robot"/.test(w)));
});

test("(aa) queueOrder: needs_human sorts in the drafts band (top, under blockers), newest-first", () => {
  const older = "2026-09-01T10:00:00.000Z";
  const newer = "2026-09-08T10:00:00.000Z";
  const rows = validateBoard(
    mkBoard({
      schema_version: 4,
      runsheet: [
        mkQueueRow({ kind: "review", draft_id: null, ts: newer, label: "review me" }),
        mkQueueRow({ kind: "next_action", draft_id: null, ts: newer, label: "todo" }),
        mkNeedsHumanRow({ ts: older, label: "needs look (old)" }),
        mkQueueRow({ draft_id: "d-1", ts: older, label: "draft (old)" }),
        mkNeedsHumanRow({ draft_id: "local:0bb1ff59", ts: newer, label: "needs look (new)" }),
        mkQueueRow({ kind: "halt", draft_id: null, ts: older, label: "HALT" }),
      ],
    })
  ).snapshot.runsheet;
  assert.deepEqual(
    lib.queueOrder(rows).map((r) => r.label),
    ["HALT", "needs look (new)", "needs look (old)", "draft (old)", "review me", "todo"]
  );
});

test("(aa) stored-snapshot round-trip: a needs_human row (with note) survives write → read", () => {
  const res = validateBoard(mkBoard({ schema_version: 4, runsheet: [mkNeedsHumanRow(), mkQueueRow()] }));
  writeOutreachSnapshot(res.snapshot);
  const back = readOutreachSnapshot();
  assert.equal(back.status, "ok");
  assert.deepEqual(back.snapshot.runsheet, res.snapshot.runsheet);
  assert.match(back.snapshot.runsheet[0].note, /automated acknowledgement/);
});

test("(aa) needs_human render stance: the page routes the kind to NeedsHumanCard; the card offers exactly the two answers, sends nothing", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "page.tsx"),
    "utf8"
  );
  const island = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "outreach", "actions.tsx"),
    "utf8"
  );
  assert.match(page, /item\.kind === "needs_human" && item\.draftId !== null/);
  assert.match(page, /<NeedsHumanCard/);
  assert.match(page, /note=\{item\.note\}/);
  assert.match(page, /needs_human: "Needs a human look"/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(island, /export function NeedsHumanCard/);
  assert.match(island, /Not a real reply → continue sequence/);
  assert.match(island, /This is a real reply/);
  assert.match(island, /reply from Gmail/);
  // the note + inbound render as escaped JSX text inside <pre>
  assert.match(island, /<pre[^>]*>\s*\{props\.note \?\? "\(no note from the pipeline\)"\}\s*<\/pre>/);
  assert.doesNotMatch(island, /dangerouslySetInnerHTML/);
  // both buttons ride the draft-action channel; "real reply" = reject, never a send
  assert.match(island, /action: "not_a_reply" \}, "not_a_reply"\)/);
  assert.match(island, /action: "reject", reason: null \}, "reject"\)/);
  assert.doesNotMatch(island, /\/api\/[a-z/-]*send/);
});
