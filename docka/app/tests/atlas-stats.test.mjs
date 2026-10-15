// Unit tests for the Lead Atlas per-country aggregation (folded into the SAME
// memoized buildPageData pass, RV1) + the pure colour/perM maths (lib/atlas/scale).
//
// The aggregation is exercised THROUGH loadLeadsPageData (the one memoized loader)
// against a hand-built columnar fixture — no second reader exists by design.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/atlas-stats.test.mjs

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadLeadsPageData,
  normIso2,
  __clearLeadsPageCache,
} from "@/lib/docka-leads";
import { __clearProductFitCache } from "@/lib/product-fit-store";
import { buildScale, perMillion, ATLAS_ZERO, ATLAS_COLORS } from "@/lib/atlas/scale";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-atlas-"));
const CONTENT_PATH = path.join(TMP, "docka-leads.json");
const PF_PATH = path.join(TMP, "product-fit.json"); // never written → empty lookup

let mtimeSeq = 1_800_000_000;
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
});

const COLUMNS = [
  "company_name", "country_iso2", "registry", "segment_guess", "tier",
  "fit_score", "action", "working_set", "is_desk", "is_sendable",
  "contact_email", "crewing_email", "outreach_channel_effective",
];
// country_iso2 is a DICTIONARY column (as the real publisher emits it).
const CC_DICT = ["FR", "NO", "XK", "MC", "gb", "GB", "UK", "ZZ", "", "AT", "NR"];

/** One research row (never in working set / desk): only ccIdx + sendable vary. */
function row(company, ccIdx, sendable) {
  return [
    company, ccIdx, "reg", "seg", "A", "50", "HOLD",
    false, false, sendable, "redacted@example.test", "", "GREEN",
  ];
}

/**
 * RV9 fixture: FR×2, NO, XK (id-less set), MC (micro-state), gb/GB/UK (all fold to
 * GB), ZZ (unmapped), blank (→noCountry), AT, NR (valid but absent from POPULATION),
 * and a corrupt row (country_iso2 index out of range → skipped, counted noCountry).
 */
function mkFixture() {
  return {
    schema_version: 1,
    generated_at: "2026-09-03 10:00 UTC",
    source_version: "v21",
    layout: "columnar",
    columns: COLUMNS,
    dictionary_columns: ["country_iso2"],
    dictionaries: { country_iso2: CC_DICT },
    rows: [
      row("Alpha", 0, true),   // FR sendable
      row("Beta", 0, false),   // FR not
      row("Gamma", 1, false),  // NO
      row("Delta", 2, true),   // XK sendable
      row("Epsilon", 3, false),// MC
      row("Zeta", 4, true),    // gb  -> GB sendable
      row("Eta", 5, false),    // GB  -> GB not
      row("Theta", 6, true),   // UK  -> GB sendable
      row("Iota", 7, false),   // ZZ  (unmapped)
      row("Kappa", 8, false),  // ""  -> noCountry
      row("Lambda", 9, false), // AT
      row("Mu", 10, false),    // NR  (absent from POPULATION)
      row("Corrupt", 99, false), // out-of-range dict index -> unreadable -> noCountry
    ],
  };
}

function stat(snap, iso2) {
  return snap.data.countryStats.find((s) => s.iso2 === iso2);
}

// --- normIso2 direct (RV2) ---------------------------------------------------

test("T2: normIso2 folds gb/GB/UK to GB and blanks to empty", () => {
  assert.equal(normIso2("gb"), "GB");
  assert.equal(normIso2("GB"), "GB");
  assert.equal(normIso2("UK"), "GB");
  assert.equal(normIso2("  uk  "), "GB");
  assert.equal(normIso2(""), "");
  assert.equal(normIso2("   "), "");
  assert.equal(normIso2("zz"), "ZZ");
  assert.equal(normIso2("UA-MARAD"), "UA"); // service suffix stripped
});

// --- T1 counts / T3 sendable / T2 accumulation-path fold / T5 conservation ---

test("T1+T3: per-country totals and sendable are summed correctly", () => {
  write(mkFixture());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);

  assert.deepEqual(stat(snap, "FR"), { iso2: "FR", total: 2, sendable: 1 });
  assert.deepEqual(stat(snap, "NO"), { iso2: "NO", total: 1, sendable: 0 });
  assert.deepEqual(stat(snap, "XK"), { iso2: "XK", total: 1, sendable: 1 });
  assert.deepEqual(stat(snap, "MC"), { iso2: "MC", total: 1, sendable: 0 });
  assert.deepEqual(stat(snap, "AT"), { iso2: "AT", total: 1, sendable: 0 });
  assert.deepEqual(stat(snap, "NR"), { iso2: "NR", total: 1, sendable: 0 });
  assert.deepEqual(stat(snap, "ZZ"), { iso2: "ZZ", total: 1, sendable: 0 });
});

test("T2: gb, GB and UK fold into ONE GB bucket on the accumulation path", () => {
  write(mkFixture());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.deepEqual(stat(snap, "GB"), { iso2: "GB", total: 3, sendable: 2 });
  // no split buckets survive
  assert.equal(stat(snap, "gb"), undefined);
  assert.equal(stat(snap, "UK"), undefined);
});

test("T3: sendable is summed independently of total", () => {
  write(mkFixture());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  // FR: 2 rows, only 1 sendable — proves sendable != total.
  const fr = stat(snap, "FR");
  assert.equal(fr.total, 2);
  assert.equal(fr.sendable, 1);
});

test("T5: totalRows === withCountry + noCountry; blank + corrupt land in noCountry", () => {
  write(mkFixture());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.data.totalRows, 13);
  assert.equal(snap.data.withCountry, 11);
  assert.equal(snap.data.noCountry, 2); // blank row + corrupt row
  assert.equal(snap.data.totalRows, snap.data.withCountry + snap.data.noCountry);
  // 8 distinct countries (gb/GB/UK merged), sorted total desc then iso2 asc.
  assert.equal(snap.data.countryStats.length, 8);
  assert.deepEqual(
    snap.data.countryStats.map((s) => s.iso2),
    ["GB", "FR", "AT", "MC", "NO", "NR", "XK", "ZZ"]
  );
});

// --- T4 failure contract + corrupt-row-not-thrown ----------------------------

test("T4: missing file with no history => {ok:false, reason:'missing'}", () => {
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.deepEqual(snap, { ok: false, reason: "missing" });
});

test("T4: malformed envelope => {ok:false, reason:'invalid'} (never throws)", () => {
  write({ columns: COLUMNS, rows: [] }); // no generated_at/source_version
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, "invalid");
});

test("T4: a corrupt country cell is SKIPPED (counted noCountry), build stays ok", () => {
  write(mkFixture());
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  // The out-of-range dict index did not throw the whole build.
  assert.equal(snap.ok, true);
  // Its row is not in any stats bucket; it is one of the two noCountry rows.
  assert.ok(!snap.data.countryStats.some((s) => s.total > 3));
});

// --- withCountry === 0 edge (RV8) --------------------------------------------

test("present file with only blank countries => withCountry 0, empty stats, ok:true", () => {
  const doc = mkFixture();
  doc.rows = [row("OnlyBlank", 8, false), row("AlsoBlank", 8, true)];
  write(doc);
  const snap = loadLeadsPageData(CONTENT_PATH, PF_PATH);
  assert.equal(snap.ok, true);
  assert.equal(snap.data.withCountry, 0);
  assert.equal(snap.data.noCountry, 2);
  assert.deepEqual(snap.data.countryStats, []);
});

// --- scale + perM pure maths (RV4/RV5) ---------------------------------------

test("RV4: perMillion returns null (never NaN/Infinity) for missing/zero population", () => {
  assert.equal(perMillion(100, undefined), null);
  assert.equal(perMillion(100, null), null);
  assert.equal(perMillion(100, 0), null);
  assert.equal(perMillion(1_000_000, 1_000_000), 1_000_000);
  assert.equal(perMillion(50, 5_000_000), 10);
});

test("RV5: single positive country => single-bin scale, no throw", () => {
  const s = buildScale([null, 0, 42]);
  assert.equal(s.single, true);
  assert.equal(s.positiveCount, 1);
  assert.equal(s.color(42), ATLAS_COLORS[ATLAS_COLORS.length - 1]);
  assert.equal(s.color(0), ATLAS_ZERO);
});

test("RV5: all-equal positive values => single-bin scale, no throw", () => {
  const s = buildScale([7, 7, 7, 7, 7, 7, 7]);
  assert.equal(s.single, true);
  assert.equal(s.color(7), ATLAS_COLORS[ATLAS_COLORS.length - 1]);
});

test("RV5: empty metric (all null) => single-bin, positiveCount 0, no throw", () => {
  const s = buildScale([null, null]);
  assert.equal(s.single, true);
  assert.equal(s.positiveCount, 0);
});

test("a well-spread metric builds a 6-bin quantile scale with 5 monotonic breaks", () => {
  const s = buildScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 40]);
  assert.equal(s.single, false);
  assert.equal(s.thresholds.length, ATLAS_COLORS.length - 1);
  for (let i = 1; i < s.thresholds.length; i++) {
    assert.ok(s.thresholds[i] >= s.thresholds[i - 1], "thresholds ascending");
  }
  // extremes land in the first / last colour bin
  assert.equal(s.color(1), ATLAS_COLORS[0]);
  assert.equal(s.color(40), ATLAS_COLORS[ATLAS_COLORS.length - 1]);
  assert.equal(s.color(0), ATLAS_ZERO);
});
