// Unit tests for lib/docka-leads.ts — the /admin/leads page loader over the
// clean columnar snapshot (content/docka-leads.json), sharing its parser with
// lib/leads-export.ts (one flattener for the page AND the §15 export).
//
// The operator's top-priority property gets its own tests here: the lead list
// must be VISIBLE AT ALL TIMES — a broken (or vanished) daily refresh keeps
// serving the LAST-KNOWN-GOOD parse with an honest stale note; the empty state
// exists ONLY for a box that has never had a snapshot.
//
// Also the inverted-admin-guard meta-test for the page module (outreach
// pattern: the routable module is checked as SOURCE, never imported).
//
// Run: node --import ./tests/_register-alias.mjs --test tests/docka-leads.test.mjs

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEADS_JSON_REL_PATH,
  PAGE_REQUIRED_COLUMNS,
  loadLeadsPageData,
  __clearLeadsPageCache,
} from "@/lib/docka-leads";
import { normalizeEmail } from "@/lib/product-fit";
import { __clearProductFitCache } from "@/lib/product-fit-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-leads-page-"));
const CONTENT_PATH = path.join(TMP, "docka-leads.json");
// Product-fit verdict file, passed as loadLeadsPageData's 2nd arg (the join
// source). Removed in beforeEach so the base tests get an EMPTY lookup
// deterministically; the join tests below write it first.
const PF_PATH = path.join(TMP, "product-fit.json");

/** Write a stored-format product-fit file at PF_PATH and bump its mtime. */
function writePf(verdicts, mtimeSec) {
  const body = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-08-18T15:37:00.000Z",
    uploadedAt: "2026-08-18T15:38:00.000Z",
    verdicts,
  });
  fs.writeFileSync(PF_PATH, body, "utf-8");
  const t = mtimeSec ?? 1_700_000_500;
  fs.utimesSync(PF_PATH, t, t);
}

let mtimeSeq = 1_700_000_000; // seconds; monotonically increasing => distinct mtimes

/** Columnar fixture in the publisher's layout, page-column superset included. */
function mkColumnar() {
  return {
    schema_version: 1,
    generated_at: "2026-08-18 15:37 UTC",
    source_version: "v4",
    layout: "columnar",
    columns: [
      "company_name", "country_iso2", "registry", "segment_guess", "tier",
      "fit_score", "action", "working_set", "is_desk", "is_sendable",
      "contact_email", "crewing_email", "outreach_channel_effective",
    ],
    dictionary_columns: ["registry", "segment_guess", "outreach_channel_effective", "country_iso2", "tier", "action"],
    dictionaries: {
      registry: ["ee_ariregister", "uk_companies_house"],
      segment_guess: ["manning_agency", "shipowner"],
      outreach_channel_effective: ["GREEN", "RED"],
      country_iso2: ["EE", "GB"],
      tier: ["A", "B"],
      action: ["SEND_NOW", "HOLD"],
    },
    rows: [
      // working set + desk + sendable; crewing beats contact; non-ASCII intact
      ["Ålpha Läden OÜ", 0, 0, 0, 0, 85, 0, true, true, true,
        "info@alpha.example", "crew@alpha.example", 0],
      // working set only; no crewing → contact (trimmed); "true" string bool
      ["Beta Crewing Ltd", 1, 1, 1, 1, 60, 1, "true", false, false,
        "  info@beta.example  ", "", 1],
      // desk only (NOT in working set) — must appear in desks, not working set
      ["Gamma Desk OÜ", 0, 0, 0, 0, 40, 1, false, true, true,
        "", "desk@gamma.example", 0],
      // background research row: neither working set nor desk — never rendered
      ["Zeta Research AS", 0, 0, null, null, null, null, false, false, false,
        null, null, null],
    ],
  };
}

function write(doc, mtimeSec) {
  const body = typeof doc === "string" ? doc : JSON.stringify(doc);
  fs.writeFileSync(CONTENT_PATH, body, "utf-8");
  const t = mtimeSec ?? mtimeSeq++;
  fs.utimesSync(CONTENT_PATH, t, t);
  return t * 1000;
}

beforeEach(() => {
  __clearLeadsPageCache();
  __clearProductFitCache();
  fs.rmSync(CONTENT_PATH, { force: true });
  fs.rmSync(PF_PATH, { force: true });
});

// --- constants ---------------------------------------------------------------

test("the production path is the publisher's scp target", () => {
  assert.equal(LEADS_JSON_REL_PATH, path.join("content", "docka-leads.json"));
  assert.ok(PAGE_REQUIRED_COLUMNS.includes("working_set"));
  assert.ok(PAGE_REQUIRED_COLUMNS.includes("is_desk"));
});

// --- the missing arm: ONLY a box that never had a snapshot -------------------

test("no file, no history => ok:false reason:'missing', never throws", () => {
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.deepEqual(snap, { ok: false, reason: "missing" });
});

// --- the happy path ----------------------------------------------------------

test("valid snapshot => working set + desks projected, honest counts, escaped-ready scalars", () => {
  const t = write(mkColumnar());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  assert.equal(snap.stale, null);
  assert.equal(snap.data.generatedAt, "2026-08-18 15:37 UTC");
  assert.equal(snap.data.sourceVersion, "v4");
  assert.equal(snap.data.publishedAt, t);
  assert.equal(snap.data.totalRows, 4, "totals count the WHOLE base, not the shown subset");
  assert.equal(snap.data.sendableCount, 2);

  // Working set: rows 0 and 1 (working_set true / "true"); NOT the desk-only row.
  assert.deepEqual(snap.data.workingSet.map((r) => r.company), ["Ålpha Läden OÜ", "Beta Crewing Ltd"]);
  // Desks: rows 0 and 2 (is_desk true), overlapping row 0 listed in both.
  assert.deepEqual(snap.data.desks.map((r) => r.company), ["Ålpha Läden OÜ", "Gamma Desk OÜ"]);

  const [a, b] = snap.data.workingSet;
  assert.deepEqual(a, {
    company: "Ålpha Läden OÜ",
    countryIso2: "EE",
    registry: "ee_ariregister",
    segment: "manning_agency",
    tier: "A",
    fitScore: "85",
    action: "SEND_NOW",
    email: "crew@alpha.example", // crewing/desk mailbox wins (same rule as the §15 export)
    channel: "GREEN",
    sendable: true,
    desk: true,
  });
  assert.equal(b.email, "info@beta.example"); // fallback + trim
  assert.equal(b.sendable, false);
  // Every rendered field is a plain scalar (JSX escapes them; nothing raw).
  for (const row of [...snap.data.workingSet, ...snap.data.desks]) {
    for (const [k, v] of Object.entries(row)) {
      assert.ok(["string", "boolean"].includes(typeof v), `${k} is ${typeof v}`);
    }
  }
});

// --- OPERATOR TOP PRIORITY: broken newest snapshot => last-known-good --------

test("a broken daily refresh keeps the last-known-good list visible, with a stale note", () => {
  write(mkColumnar(), 1_700_000_100);
  const good = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(good.ok, true);

  // The publisher lands a corrupt file (new mtime).
  write("not json {", 1_700_000_200);
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true, "the page must NOT blank because the newest file is bad");
  assert.ok(snap.stale, "must carry the honest 'latest refresh failed' note");
  assert.match(snap.stale.error, /not valid JSON/);
  assert.equal(snap.data.generatedAt, "2026-08-18 15:37 UTC", "data is the last good parse");
  assert.equal(snap.data.workingSet.length, 2);

  // Structurally-invalid JSON (missing required column) → same property.
  const noCol = mkColumnar();
  noCol.columns = noCol.columns.filter((c) => c !== "working_set");
  write(noCol, 1_700_000_300);
  const snap2 = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap2.ok, true);
  assert.match(snap2.stale.error, /working_set/);
  assert.equal(snap2.data.workingSet.length, 2);
});

test("a vanished snapshot after a good parse also keeps the list visible", () => {
  write(mkColumnar());
  assert.equal(loadLeadsPageData(CONTENT_PATH, PF_PATH).ok, true);
  fs.rmSync(CONTENT_PATH);
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true, "empty state is ONLY for a box that never had a snapshot");
  assert.match(snap.stale.error, /missing/);
  assert.equal(snap.data.workingSet.length, 2);
});

test("recovery: the next good refresh replaces the stale data and clears the note", () => {
  write(mkColumnar(), 1_700_000_100);
  loadLeadsPageData(CONTENT_PATH, PF_PATH);
  write("garbage", 1_700_000_200);
  loadLeadsPageData(CONTENT_PATH, PF_PATH);

  const fixed = mkColumnar();
  fixed.generated_at = "2026-08-19 06:00 UTC";
  fixed.rows = fixed.rows.slice(0, 1);
  write(fixed, 1_700_000_300);
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  assert.equal(snap.stale, null);
  assert.equal(snap.data.generatedAt, "2026-08-19 06:00 UTC");
  assert.equal(snap.data.totalRows, 1);
});

test("broken file with NO prior good parse => honest invalid error state", () => {
  write("not json {");
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, "invalid");
  assert.match(snap.error, /not valid JSON/);
});

// --- the (mtimeMs, size) memo: daily replace needs NO restart ----------------

test("memo: unchanged file serves the SAME parsed object; a new publish invalidates", () => {
  write(mkColumnar(), 1_700_000_100);
  const first = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  const again = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(again.data, first.data, "identical (mtime,size) => memoized object, no re-parse");

  const next = mkColumnar();
  next.generated_at = "2026-08-19 06:00 UTC";
  write(next, 1_700_000_200);
  const fresh = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.notEqual(fresh.data, first.data);
  assert.equal(fresh.data.generatedAt, "2026-08-19 06:00 UTC", "fresh mtime => picked up without restart");
});

test("memo: a known-bad file is not re-parsed, and the verdict stays stable", () => {
  write(mkColumnar(), 1_700_000_100);
  loadLeadsPageData(CONTENT_PATH, PF_PATH);
  write("junk", 1_700_000_200);
  const s1 = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  const s2 = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(s2.ok, true);
  assert.deepEqual(s2.stale, s1.stale);
  assert.equal(s2.data, s1.data);
});

// --- Product-fit verdict JOIN (by normalized email) --------------------------

test("join: verdicts attach by normalized email; case/whitespace + IDN both match", () => {
  // A columnar snapshot with controlled emails to exercise the join key.
  const doc = mkColumnar();
  doc.dictionaries.country_iso2 = ["EE", "GB", "DE"];
  doc.rows = [
    // crewing email joins after uppercase/space normalization
    ["Alpha OÜ", 0, 0, 0, 0, 85, 0, true, false, true, "info@alpha.example", "crew@alpha.example", 0],
    // no crewing → contact email with an IDN domain, joins after punycode
    ["Beta GmbH", 2, 1, 1, 1, 70, 1, true, false, true, "ops@münchen.de", "", 1],
    // in the working set but has NO verdict → pending (undefined keys)
    ["Gamma Ltd", 1, 1, 1, 1, 60, 1, true, false, false, "nobody@gamma.example", "", 1],
  ];
  write(doc, 1_700_000_600);

  // Verdict keys given in RAW form (uppercase, unicode IDN) — the store
  // re-normalizes them, and the page normalizes the row email; both use the
  // SAME normalizeEmail, so the join lands.
  writePf(
    {
      "  CREW@Alpha.Example ": { productFit: "negative", enrichStatus: "success", sendableV2: false },
      "OPS@MÜNCHEN.de": { productFit: "positive", enrichStatus: "success", sendableV2: true },
    },
    1_700_000_600
  );

  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  const byCompany = Object.fromEntries(snap.data.workingSet.map((r) => [r.company, r]));

  // Alpha: crewing email joins (its is_sendable=true is STALE; product-fit says
  // negative → the divergence the page must surface).
  assert.equal(byCompany["Alpha OÜ"].sendable, true);
  assert.equal(byCompany["Alpha OÜ"].productFit, "negative");
  assert.equal(byCompany["Alpha OÜ"].enrichStatus, "success");
  assert.equal(byCompany["Alpha OÜ"].sendableV2, false);

  // Beta: contact IDN email punycode-joins.
  assert.equal(normalizeEmail("ops@münchen.de"), "ops@xn--mnchen-3ya.de");
  assert.equal(byCompany["Beta GmbH"].productFit, "positive");
  assert.equal(byCompany["Beta GmbH"].sendableV2, true);

  // Gamma: no verdict → the three keys stay UNDEFINED (page renders "pending",
  // never a negative). No phantom keys leak onto the row.
  assert.equal(byCompany["Gamma Ltd"].productFit, undefined);
  assert.equal(byCompany["Gamma Ltd"].enrichStatus, undefined);
  assert.equal(byCompany["Gamma Ltd"].sendableV2, undefined);
  assert.ok(!("productFit" in byCompany["Gamma Ltd"]), "absent verdict => no phantom key");
});

test("absent product-fit file => every row pending (no verdict keys), list still renders", () => {
  write(mkColumnar(), 1_700_000_700);
  // PF_PATH was removed in beforeEach → EMPTY lookup.
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  for (const r of [...snap.data.workingSet, ...snap.data.desks]) {
    assert.equal(r.productFit, undefined, `${r.company} must be pending without a verdict file`);
  }
});

test("a product-fit refresh alone invalidates the projected rows (memo folds pf version)", () => {
  write(mkColumnar(), 1_700_000_800); // leads file stays fixed across this test
  writePf(
    { "crew@alpha.example": { productFit: "negative", enrichStatus: "success", sendableV2: false } },
    1_700_000_800
  );
  const first = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(first.data.workingSet[0].productFit, "negative");

  // Same leads file, but the verdict flips to positive on a NEW pf mtime.
  __clearProductFitCache();
  writePf(
    { "crew@alpha.example": { productFit: "positive", enrichStatus: "success", sendableV2: true } },
    1_700_000_900
  );
  const second = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(
    second.data.workingSet[0].productFit,
    "positive",
    "a verdict refresh must re-project even when the leads file is unchanged"
  );
});

test("non-success enrichment still attaches the verdict (the view maps it to pending)", () => {
  write(mkColumnar(), 1_700_001_000);
  writePf(
    { "crew@alpha.example": { productFit: "positive", enrichStatus: "timeout", sendableV2: false } },
    1_700_001_000
  );
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  const alpha = snap.data.workingSet.find((r) => r.company === "Ålpha Läden OÜ");
  assert.equal(alpha.productFit, "positive");
  assert.equal(alpha.enrichStatus, "timeout", "enrichStatus flows through for the view's pending rule");
});

// --- Guard meta-test (outreach pattern): the page module stays admin-gated ---

test("app/admin/leads/page.tsx resolves adminSession (inverted admin lock holds)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "leads", "page.tsx"),
    "utf8"
  );
  assert.match(src, /\badminSession\b/, "the per-page Layer C gate must stay");
  assert.match(src, /adminDeniedResponse/);
  assert.ok(!/dangerouslySetInnerHTML/.test(src), "page must not inject raw HTML");
  const view = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "leads", "view.tsx"),
    "utf8"
  );
  assert.ok(!/dangerouslySetInnerHTML/.test(view), "view must not inject raw HTML");
});

// --- A1–A7: the per-registry lead-source aggregate (folded over the WHOLE base)

/**
 * Columnar fixture with `registry` as the ONLY dictionary column, so a row can
 * set `rawRegistry` (an out-of-range int / object / null) to exercise the fold's
 * fail-per-row bucket, `rawContact` for a non-scalar contact cell, and any of
 * ws/desk/sendable/contact/crewing/extracted directly.
 */
function mkAgg(rows, opts = {}) {
  const regDict = [];
  const cols = [
    "company_name", "country_iso2", "registry", "segment_guess", "tier",
    "fit_score", "action", "working_set", "is_desk", "is_sendable",
    "contact_email", "crewing_email", "outreach_channel_effective",
  ];
  if (opts.extracted) cols.push("extracted_at");
  const encoded = rows.map((r, i) => {
    let regCell;
    if ("rawRegistry" in r) regCell = r.rawRegistry;
    else if (r.registry === undefined) regCell = null;
    else {
      let k = regDict.indexOf(r.registry);
      if (k < 0) { k = regDict.length; regDict.push(r.registry); }
      regCell = k;
    }
    const contactCell = "rawContact" in r ? r.rawContact : "contact" in r ? r.contact : "";
    const base = [
      "Co" + i, "GB", regCell, "seg", "A", "50", "SEND_NOW",
      r.ws ?? false, r.desk ?? false, r.sendable ?? false,
      contactCell, "crewing" in r ? r.crewing : "", "GREEN",
    ];
    if (opts.extracted) base.push("extracted" in r ? r.extracted : "");
    return base;
  });
  return {
    schema_version: 1, generated_at: "2026-09-02 10:00 UTC", source_version: "v21",
    layout: "columnar", columns: cols,
    dictionary_columns: ["registry"], dictionaries: { registry: regDict }, rows: encoded,
  };
}

function byKey(sources, key) {
  return sources.find((s) => s.registry === key);
}

test("A1 whole-base aggregate incl. research rows; composite key verbatim; blank → (unknown)", () => {
  write(mkAgg([
    { registry: "ee_ariregister", ws: true, sendable: true, crewing: "c@x" },
    { registry: "ee_ariregister", sendable: false },              // research
    { registry: "uk_companies_house", contact: "i@x" },           // research
    { registry: "lv_a | lv_b" },                                  // composite, research
    { rawRegistry: null },                                        // blank → (unknown)
  ]));
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  assert.equal(snap.data.sourcesUnreadable, 0);
  assert.equal(snap.data.sourcesTruncated, false);
  assert.equal(snap.data.sources.length, 4);
  // sorted rows desc, registry asc
  assert.deepEqual(snap.data.sources[0], {
    registry: "ee_ariregister", rows: 2, withEmail: 1, sendable: 1, lastExtractedAt: null,
  });
  assert.ok(byKey(snap.data.sources, "lv_a | lv_b"), "composite key kept verbatim");
  assert.equal(byKey(snap.data.sources, "(unknown)").rows, 1);
  // research rows counted too: total rows across buckets == totalRows
  const summed = snap.data.sources.reduce((a, s) => a + s.rows, 0);
  assert.equal(summed, snap.data.totalRows);
});

test("A2 a new registry in a re-published file appears with NO code change", () => {
  write(mkAgg([{ registry: "reg_one" }]), 1_700_100_000);
  let snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.ok(byKey(snap.data.sources, "reg_one"));
  assert.ok(!byKey(snap.data.sources, "reg_two"));
  // publisher lands a fresh file (new mtime) that introduces reg_two
  write(mkAgg([{ registry: "reg_one" }, { registry: "reg_two" }]), 1_700_200_000);
  snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.ok(byKey(snap.data.sources, "reg_two"), "new registry surfaces with no code change");
});

test("A3 extracted_at optional; max normalised to 10 chars", () => {
  write(mkAgg([
    { registry: "r", extracted: "2026-08-01" },
    { registry: "r", extracted: "2026-08-15T10:00:00Z" },
    { registry: "r", extracted: "not-a-date" },
    { registry: "r" }, // extracted "" → ignored
  ], { extracted: true }));
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(byKey(snap.data.sources, "r").lastExtractedAt, "2026-08-15");

  // Same fixture WITHOUT the optional column → no throw, lastExtractedAt null.
  write(mkAgg([{ registry: "r2" }]), 1_700_300_000);
  const snap2 = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(byKey(snap2.data.sources, "r2").lastExtractedAt, null);
});

test("A4 bucket cap → (other) + sourcesTruncated", () => {
  const rows = [];
  for (let i = 0; i < 1005; i++) rows.push({ registry: `reg_${i}` });
  write(mkAgg(rows));
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.data.sourcesTruncated, true);
  const other = byKey(snap.data.sources, "(other)");
  assert.ok(other, "overflow folds into (other)");
  assert.equal(other.rows, 5);
  assert.equal(snap.data.sources.length, 1001, "1000 real buckets + (other)");
});

test("A5 withEmail = crewing || contact non-empty; sendable uses asBool", () => {
  write(mkAgg([
    { registry: "r", crewing: "c@x", contact: "" },   // withEmail via crewing
    { registry: "r", crewing: "", contact: "i@x" },   // withEmail via contact
    { registry: "r", crewing: "", contact: "" },      // neither
    { registry: "r", sendable: true },                // real bool
    { registry: "r", sendable: "true" },              // string bool → asBool true
    { registry: "r", sendable: false },
  ]));
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  const r = byKey(snap.data.sources, "r");
  assert.equal(r.rows, 6);
  assert.equal(r.withEmail, 2);
  assert.equal(r.sendable, 2);
});

test("A6 regression: existing projection unchanged; the aggregate is purely additive", () => {
  const t = write(mkColumnar());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  // The five load-bearing values the existing tests pin stay identical.
  assert.equal(snap.data.totalRows, 4);
  assert.equal(snap.data.sendableCount, 2);
  assert.deepEqual(snap.data.workingSet.map((r) => r.company), ["Ålpha Läden OÜ", "Beta Crewing Ltd"]);
  assert.deepEqual(snap.data.desks.map((r) => r.company), ["Ålpha Läden OÜ", "Gamma Desk OÜ"]);
  assert.equal(snap.data.publishedAt, t);
  // Additive fields are present and consistent.
  assert.equal(snap.data.sourcesUnreadable, 0);
  assert.ok(byKey(snap.data.sources, "ee_ariregister"));
  assert.ok(byKey(snap.data.sources, "uk_companies_house"));
});

test("A7 bad cell on a RESEARCH row → (unreadable) bucket, ok:true; on a PROJECTED row → fail closed", () => {
  // Two research rows with bad cells: out-of-range registry + non-scalar contact.
  write(mkAgg([
    { registry: "good_reg", ws: true, sendable: true, crewing: "c@x" }, // valid projected
    { rawRegistry: 99 },                                                // research, out-of-range
    { registry: "r2", rawContact: {} },                                 // research, object cell
  ]));
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true, "a bad research-row cell never fails the page");
  assert.equal(snap.data.sourcesUnreadable, 2);
  assert.equal(byKey(snap.data.sources, "(unreadable)").rows, 2);
  assert.deepEqual(snap.data.workingSet.map((r) => r.company), ["Co0"]);
  assert.deepEqual(snap.data.desks, []);

  // The SAME bad cell on a PROJECTED row still fails the whole file closed.
  __clearLeadsPageCache();
  write(mkAgg([{ rawRegistry: 99, ws: true }]), 1_700_400_000);
  const bad = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid");
});
