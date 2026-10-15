// tests/docka-sources.test.mjs — B10–B28: the lead-source ledger loader,
// reconciliation, filters, and the /admin/sources view + page.
//
// Pure logic (parse/reconcile/filter/sort) runs against @/lib/docka-sources
// directly; the .tsx view + page are rendered through the in-memory route
// harness (JSX runtime stub → {type,props}) and walked structurally.

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSourcesDoc,
  loadSourcesDoc,
  reconcileSources,
  parseSourceFilters,
  applySourceFilters,
  sortSectionA,
  sortSectionB,
  ledgerBadge,
  hostOf,
  parseUtcStamp,
  splitCountries,
  validSourceUrl,
  filterParams,
  SOURCE_STATUSES,
} from "@/lib/docka-sources";
import { __clearFileMemo } from "@/lib/file-memo";
import { createRouteHarness, APP_DIR, JSX_FRAGMENT } from "./_route-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAT = { mtimeMs: 100, size: 200 };

beforeEach(() => {
  __clearFileMemo();
});

// ---- fixture builders ------------------------------------------------------

function srcEntry(o = {}) {
  return {
    row: 1,
    section: "A",
    name: "Some Source",
    country: "GB",
    category: "Licence & approval register",
    url: "https://example.gov/reg",
    url_note: null,
    url_recorded_in: "PIPELINE_STATE.md#1",
    access_method: "the site's own data endpoint",
    access_method_truncated: false,
    rows_extracted: "10",
    licence_terms: "OGL v3",
    licence_terms_truncated: false,
    verdict: "USABLE",
    in_the_list: "YES|10",
    in_list_flag: "YES",
    in_list_rows: 10,
    notes: "notes",
    notes_truncated: false,
    registry_keys: ["some_reg"],
    enrichment: false,
    assessed_at: "2026-08-17",
    assessed_at_basis: "url_recorded_in",
    ...o,
  };
}

function mkDoc(sources, warnings = [], envelope = {}) {
  return {
    schema_version: 1,
    kind: "docka-sources",
    generated_at: "2026-09-02 13:40 UTC",
    generated_at_epoch_ms: 1788356400000,
    source_version: "v21",
    ledger: {
      file: "SOURCE_INDEX.csv",
      sha256: "a".repeat(64),
      mtime: "2026-09-02 07:06 UTC",
      mtime_epoch_ms: 1788332760000,
      rows: sources.length,
      has_registry_column: true,
      has_assessed_at_column: true,
    },
    sources,
    warnings,
    ...envelope,
  };
}

function parseOk(sources, warnings = []) {
  const r = parseSourcesDoc(mkDoc(sources, warnings), STAT);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.value;
}

function reconcile(sources, aggs, opts = {}) {
  const v = parseOk(sources, opts.warnings || []);
  return reconcileSources({
    sources: v.sources,
    wireWarnings: v.warnings,
    parseWarnings: v.parseWarnings,
    aggs,
    totalRows: "totalRows" in opts ? opts.totalRows : 1000,
    sourcesTruncated: opts.sourcesTruncated ?? false,
    sourcesUnreadable: opts.sourcesUnreadable ?? 0,
    baseSourceVersion: "baseSourceVersion" in opts ? opts.baseSourceVersion : "v21",
    basePublishedAt: "basePublishedAt" in opts ? opts.basePublishedAt : 1788332760000,
    ledgerSourceVersion: "ledgerSourceVersion" in opts ? opts.ledgerSourceVersion : v.sourceVersion,
    ledgerMtimeMs: "ledgerMtimeMs" in opts ? opts.ledgerMtimeMs : v.ledger.mtimeEpochMs,
  });
}

function agg(registry, rows, withEmail = 0, sendable = 0, lastExtractedAt = null) {
  return { registry, rows, withEmail, sendable, lastExtractedAt };
}

// Recursively invoke function components and collect testids / anchors / text.
const LINK_STUB = { __esModule: true, default: (p) => ({ type: "a", props: p }) };
function collect(node, out = { text: [], testids: new Set(), anchors: [] }) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collect(c, out);
    return out;
  }
  if (typeof node === "object" && "type" in node) {
    const { type, props } = node;
    const p = props || {};
    if (typeof type === "function") return collect(type(p), out);
    if (type === JSX_FRAGMENT) return collect(p.children, out);
    if (typeof p["data-testid"] === "string") out.testids.add(p["data-testid"]);
    if (type === "a" && typeof p.href === "string") {
      out.anchors.push({ href: p.href, target: p.target, rel: p.rel });
    }
    return collect(p.children, out);
  }
  return out;
}

function loadView() {
  const h = createRouteHarness({ stubs: { "next/link": LINK_STUB } });
  return h.loadTs(path.join(APP_DIR, "admin", "sources", "view.tsx")).SourcesView;
}

function okLeads(aggs, extra = {}) {
  return {
    ok: true,
    stale: extra.stale ?? null,
    data: {
      generatedAt: "2026-09-02 10:00 UTC",
      sourceVersion: extra.sourceVersion ?? "v21",
      publishedAt: extra.publishedAt ?? 1788332760000,
      totalRows: extra.totalRows ?? 1000,
      sendableCount: 0,
      workingSet: [],
      desks: [],
      sources: aggs,
      sourcesTruncated: extra.sourcesTruncated ?? false,
      sourcesUnreadable: extra.sourcesUnreadable ?? 0,
    },
  };
}
function okSources(sources, warnings = []) {
  return { status: "ok", doc: parseOk(sources, warnings), publishedAt: 1788332760000 };
}

// ---- B10: envelope + loadSourcesDoc ---------------------------------------

test("B10 loadSourcesDoc: bad envelope → invalid; too many entries → invalid; ok/missing", () => {
  assert.equal(parseSourcesDoc({ schema_version: 2, kind: "docka-sources", sources: [] }, STAT).ok, false);
  assert.equal(parseSourcesDoc({ schema_version: 1, kind: "nope", sources: [] }, STAT).ok, false);
  assert.equal(parseSourcesDoc({ schema_version: 1, kind: "docka-sources", sources: {} }, STAT).ok, false);
  const many = Array.from({ length: 2001 }, (_, i) => srcEntry({ row: i + 1 }));
  assert.equal(parseSourcesDoc(mkDoc(many), STAT).ok, false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sources-load-"));
  const p = path.join(tmp, "docka-sources.json");
  assert.equal(loadSourcesDoc(p).status, "missing");
  fs.writeFileSync(p, JSON.stringify(mkDoc([srcEntry()])), "utf8");
  const ok = loadSourcesDoc(p);
  assert.equal(ok.status, "ok");
  assert.equal(ok.doc.sources.length, 1);
  fs.writeFileSync(p, "not json {", "utf8");
  __clearFileMemo();
  assert.equal(loadSourcesDoc(p).status, "invalid");
});

// ---- B11: entry leniency ---------------------------------------------------

test("B11 entry leniency: missing name/section/verdict dropped + parseWarnings; strings re-capped", () => {
  const v = parseOk([
    srcEntry({ row: 1 }),
    srcEntry({ row: 2, name: "" }), // dropped
    srcEntry({ row: 3, section: "" }), // dropped
    srcEntry({ row: 4, verdict: "" }), // dropped
    srcEntry({ row: 5, name: "X".repeat(900) }), // re-capped to 500
  ]);
  assert.equal(v.sources.length, 2);
  assert.ok(v.parseWarnings.length >= 3);
  const long = v.sources.find((s) => s.row === 5);
  assert.equal(long.name.length, 500);
});

// ---- B12: url rules at read ------------------------------------------------

test("B12 url rules at read: javascript/ftp/whitespace/@ → null; url_note never contains @", () => {
  assert.equal(validSourceUrl("javascript:alert(1)"), null);
  assert.equal(validSourceUrl("ftp://x/y"), null);
  assert.equal(validSourceUrl("https://a b/c"), null);
  assert.equal(validSourceUrl("https://user@host/x"), null);
  assert.equal(validSourceUrl("https://ok.example/x"), "https://ok.example/x");

  const v = parseOk([
    srcEntry({ row: 1, url: "mailto:ops@x.com", url_note: "contact ops@x.com if stuck" }),
  ]);
  assert.equal(v.sources[0].url, null);
  assert.ok(!(v.sources[0].urlNote || "").includes("@"), "url_note redacted");
});

// ---- B13: read-side @ redaction -------------------------------------------

test("B13 read-side @ redaction in any string field + a parseWarning", () => {
  const v = parseOk([
    srcEntry({ row: 1, notes: "write to crew@acme.example please", licence_terms: "see legal@x.io" }),
  ]);
  assert.ok(!v.sources[0].notes.includes("@"));
  assert.ok(!v.sources[0].licenceTerms.includes("@"));
  assert.ok(v.parseWarnings.some((w) => /redacted/.test(w)));
});

// ---- B14: registry_keys sanitise + strict in_list_rows --------------------

test("B14 registry_keys sanitised (composite kept, >20 truncated); strict in_list_rows re-check", () => {
  const keys = ["a_b", "lv_x | lv_y", "bad key", "has@at", ...Array.from({ length: 25 }, (_, i) => `k${i}`)];
  const v = parseOk([
    srcEntry({ row: 1, registry_keys: keys }),
    srcEntry({ row: 2, in_list_rows: -5 }),
    srcEntry({ row: 3, in_list_rows: 3.5 }),
    srcEntry({ row: 4, in_list_rows: 526 }),
  ]);
  const r1 = v.sources.find((s) => s.row === 1);
  assert.equal(r1.registryKeys.length, 20, "array capped at 20 valid keys");
  assert.ok(r1.registryKeys.includes("lv_x | lv_y"), "composite form kept");
  assert.ok(!r1.registryKeys.includes("bad key"));
  assert.ok(!r1.registryKeys.some((k) => k.includes("@")));
  assert.equal(v.sources.find((s) => s.row === 2).inListRows, null);
  assert.equal(v.sources.find((s) => s.row === 3).inListRows, null);
  assert.equal(v.sources.find((s) => s.row === 4).inListRows, 526);
});

// ---- B15: row validation ---------------------------------------------------

test("B15 row validation: non-integer / duplicate / ≤0 → index fallback + warning", () => {
  const v = parseOk([
    srcEntry({ row: 5 }),
    srcEntry({ row: 5 }), // duplicate → fallback
    srcEntry({ row: 0 }), // ≤0 → fallback
    srcEntry({ row: "x" }), // non-integer → fallback
  ]);
  const rows = v.sources.map((s) => s.row);
  assert.equal(new Set(rows).size, rows.length, "row numbers are unique after fallback");
  assert.ok(v.parseWarnings.some((w) => /row number/.test(w)));
});

// ---- B16: reconcile data-first + badges ------------------------------------

test("B16 reconcile data-first: badges + claimOnly + verdict-ignored-when-data", () => {
  const rec = reconcile(
    [
      srcEntry({ row: 1, name: "British Marine", registry_keys: ["british_marine_members"], in_the_list: "NO-NOT-MERGED|1033", in_list_flag: "NO-NOT-MERGED", in_list_rows: 1033, verdict: "USABLE" }),
      srcEntry({ row: 2, name: "utdanning.no", registry_keys: ["no_utd"], in_the_list: "YES|2", in_list_flag: "YES", in_list_rows: 2, verdict: "USABLE" }),
      srcEntry({ row: 3, name: "Claim only", registry_keys: ["nowhere"], in_the_list: "YES|0", in_list_flag: "YES", in_list_rows: 0, verdict: "USABLE" }),
      srcEntry({ row: 4, name: "Forbidden with data", registry_keys: ["kf"], in_the_list: "NO-FORBIDDEN|0", in_list_flag: "NO-FORBIDDEN", in_list_rows: 0, verdict: "FORBIDDEN" }),
      srcEntry({ row: 5, name: "Brreg roles", registry_keys: [], enrichment: true, in_the_list: "NO-NOT-MERGED|0", in_list_flag: "NO-NOT-MERGED", in_list_rows: 0, verdict: "USABLE" }),
    ],
    [agg("british_marine_members", 958), agg("no_utd", 464), agg("kf", 5)]
  );
  const A = new Map(rec.inBase.map((r) => [r.name, r]));
  assert.equal(A.get("British Marine").status, "in_base");
  assert.equal(ledgerBadge(A.get("British Marine")), null, "1033 vs 958 → no badge");
  assert.equal(ledgerBadge(A.get("utdanning.no")), "base_exceeds", "YES|2 vs 464 → base exceeds");
  assert.equal(A.get("Claim only").claimOnly, true);
  assert.equal(ledgerBadge(A.get("Claim only")), "claimed_not_found");
  assert.equal(A.get("Forbidden with data").status, "in_base", "data-first beats the FORBIDDEN verdict");
  assert.equal(A.get("Brreg roles").status, "enrichment");
  assert.equal(ledgerBadge(A.get("Brreg roles")), null);
});

// ---- B17: ledger-only statuses --------------------------------------------

test("B17 ledger-only statuses + other for an unknown verdict", () => {
  const rows = [
    ["USABLE", "usable_not_merged"],
    ["NOT-YET-WORKED", "not_yet"],
    ["GATED", "gated"],
    ["FORBIDDEN", "forbidden"],
    ["DEAD", "dead"],
    ["SUPERSEDED", "superseded"],
    ["MYSTERY-VERDICT", "other"],
  ].map(([verdict], i) =>
    srcEntry({ row: i + 1, name: `v${i}`, registry_keys: [`k${i}`], verdict, in_the_list: "NO|0", in_list_flag: "NO", in_list_rows: 0 })
  );
  const rec = reconcile(rows, []);
  const byName = new Map(rec.notInBase.map((r) => [r.name, r.status]));
  assert.equal(byName.get("v0"), "usable_not_merged");
  assert.equal(byName.get("v1"), "not_yet");
  assert.equal(byName.get("v2"), "gated");
  assert.equal(byName.get("v3"), "forbidden");
  assert.equal(byName.get("v4"), "dead");
  assert.equal(byName.get("v5"), "superseded");
  assert.equal(byName.get("v6"), "other");
});

// ---- B18: duplicate-key contract fixture ----------------------------------

test("B18 duplicate-key contract: keys verbatim on both rows, warning names both, key counted once", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "docka-sources-dupkey.json"), "utf8"));
  const parsed = parseSourcesDoc(raw, STAT);
  assert.equal(parsed.ok, true);
  const v = parsed.value;
  assert.equal(v.sources.length, 2);
  assert.deepEqual(v.sources[0].registryKeys, ["cymepa_members"]);
  assert.deepEqual(v.sources[1].registryKeys, ["cymepa_members"]);
  assert.deepEqual(v.warnings, [{ kind: "duplicate_key", key: "cymepa_members", rows: [38, 300] }]);

  const rec = reconcileSources({
    sources: v.sources,
    wireWarnings: v.warnings,
    parseWarnings: v.parseWarnings,
    aggs: [agg("cymepa_members", 143, 11, 0, "2026-08-01")],
    totalRows: 1000,
    sourcesTruncated: false,
    sourcesUnreadable: 0,
    baseSourceVersion: "vTEST",
    basePublishedAt: 1767312000000,
    ledgerSourceVersion: v.sourceVersion,
    ledgerMtimeMs: v.ledger.mtimeEpochMs,
  });
  assert.equal(rec.inBase.length, 2, "both rows land in Section A");
  assert.equal(rec.kpis.coverageRows, 143, "the shared key counts ONCE in coverage");
  const r38 = rec.inBase.find((r) => r.row === 38);
  const r300 = rec.inBase.find((r) => r.row === 300);
  assert.deepEqual(r38.alsoRows, [300]);
  assert.deepEqual(r300.alsoRows, [38]);
});

// ---- B19: registry-only never dropped + coverage over distinct -------------

test("B19 registry-only never dropped ((unknown)/(unreadable)/(other)); coverage over distinct; 0 → 0%", () => {
  const rec = reconcile(
    [srcEntry({ row: 1, registry_keys: ["claimed"] })],
    [
      agg("claimed", 10, 2, 1),
      agg("real_unclaimed", 7),
      agg("(unknown)", 2),
      agg("(unreadable)", 1),
      agg("(other)", 3),
    ]
  );
  const keys = new Set(rec.registryOnly.map((r) => r.key));
  assert.ok(keys.has("(unknown)") && keys.has("(unreadable)") && keys.has("(other)") && keys.has("real_unclaimed"));
  assert.ok(!keys.has("claimed"), "claimed key is covered, not registry-only");
  assert.equal(rec.kpis.coverageRows, 10, "coverage counts only the claimed key");
  assert.equal(rec.kpis.registryOnlyCount, 4);

  const empty = reconcile([srcEntry({ row: 1, registry_keys: ["x"] })], [], { totalRows: 0 });
  assert.equal(empty.kpis.coveragePct, 0);
  assert.ok(!Number.isNaN(empty.kpis.coveragePct));
});

// ---- B20: near_miss --------------------------------------------------------

test("B20 near_miss warning (Europort_Exhibitors vs europort_exhibitors)", () => {
  const rec = reconcile(
    [srcEntry({ row: 1, registry_keys: ["Europort_Exhibitors"] })],
    [agg("europort_exhibitors", 1064)]
  );
  assert.ok(
    rec.nearMisses.some((w) => w.key === "Europort_Exhibitors" && w.dataKey === "europort_exhibitors"),
    "case-only mismatch flagged as near_miss"
  );
});

// ---- B21: filters ----------------------------------------------------------

test("B21 parseSourceFilters: allowlists; arrays invalid; q normalisation; country split", () => {
  // arrays for every param → ignored
  const arr = parseSourceFilters({ q: ["a", "b"], status: ["x", "y"], sort: ["rows"] });
  assert.deepEqual(arr, { status: null, verdict: null, country: null, section: null, q: null, sort: null });

  assert.equal(parseSourceFilters({ status: "in_base" }).status, "in_base");
  assert.equal(parseSourceFilters({ status: "bogus" }).status, null);
  assert.equal(parseSourceFilters({ verdict: "USABLE-LOW-YIELD" }).verdict, "USABLE-LOW-YIELD");
  assert.equal(parseSourceFilters({ verdict: "lowercase" }).verdict, null);
  assert.equal(parseSourceFilters({ country: "HR" }).country, "HR");
  assert.equal(parseSourceFilters({ country: "GLOBAL" }).country, "GLOBAL");
  assert.equal(parseSourceFilters({ country: "zz" }).country, null);
  assert.equal(parseSourceFilters({ section: "S" }).section, "S");
  assert.equal(parseSourceFilters({ section: "ab" }).section, null);
  assert.equal(parseSourceFilters({ sort: "name" }).sort, "name");
  assert.equal(parseSourceFilters({ sort: "bogus" }).sort, null);

  // q: allowlist + NFC; <script> rejected; accented + non-Latin accepted
  assert.equal(parseSourceFilters({ q: "pole mer" }).q, "pole mer");
  assert.equal(parseSourceFilters({ q: "<script>" }).q, null);
  assert.equal(parseSourceFilters({ q: "Uzņēmumu" }).q, "Uzņēmumu");
  assert.equal(parseSourceFilters({ q: "Færgesekretariatet" }).q, "Færgesekretariatet");
  assert.equal(parseSourceFilters({ q: "НАПОО" }).q, "НАПОО");

  // country on the split set (17-code row matches HR)
  assert.ok(splitCountries("GB;HR;UA;GLOBAL").includes("HR"));
});

test("B21 applySourceFilters: accent-insensitive name match (pole mer / pôle / combining ^)", () => {
  const rows = [
    { name: "Pôle Mer Méditerranée", status: "in_base", verdict: "USABLE", section: "C", country: "FR", row: 1 },
    { name: "Something Else", status: "in_base", verdict: "USABLE", section: "C", country: "FR", row: 2 },
  ];
  for (const q of ["pole mer", "pôle", "Pôle"]) {
    const out = applySourceFilters(rows, parseSourceFilters({ q }));
    assert.equal(out.length, 1, `q=${q} matches`);
    assert.equal(out[0].name, "Pôle Mer Méditerranée");
  }
  // country filter uses the split set
  assert.equal(
    applySourceFilters(
      [{ name: "Multi", status: "in_base", verdict: "USABLE", section: "C", country: "GB;HR;UA", row: 1 }],
      parseSourceFilters({ country: "HR" })
    ).length,
    1
  );
});

test("B21 toggleParamHref (via ui.tsx) keeps other validated params incl. q; hidden inputs validated only", () => {
  const h = createRouteHarness({ stubs: {} });
  const { toggleParamHref } = h.loadTs(path.join(APP_DIR, "admin", "ui.tsx"));
  const validated = filterParams(parseSourceFilters({ q: "pole mer", status: "in_base" }));
  // a status chip href built while q is active keeps q
  const href = toggleParamHref("/admin/sources", validated, "status", "gated");
  assert.ok(href.includes("q=pole%20mer"), "q preserved");
  assert.ok(href.includes("status=gated"), "status set");
  // clicking the ACTIVE status clears it (but keeps q)
  const cleared = toggleParamHref("/admin/sources", validated, "status", "in_base");
  assert.ok(!/status=/.test(cleared));
  assert.ok(cleared.includes("q=pole%20mer"));
  // a sort link keeps every active filter
  const sortHref = toggleParamHref("/admin/sources", validated, "sort", "name");
  assert.ok(sortHref.includes("q=pole%20mer") && sortHref.includes("status=in_base") && sortHref.includes("sort=name"));
  // an invalid param never survives parseSourceFilters, so it can never be re-emitted
  const invalid = filterParams(parseSourceFilters({ status: "bogus", q: "ok" }));
  assert.equal(invalid.status, null);
});

// ---- B22: sorts and tie-breaks --------------------------------------------

test("B22 sortSectionA (rows desc, name lower, row) / sortSectionB (assessed desc, nulls last)", () => {
  const A = sortSectionA(
    [
      { name: "b", row: 2, baseRows: 5 },
      { name: "A", row: 1, baseRows: 5 },
      { name: "c", row: 3, baseRows: 9 },
    ],
    "rows"
  );
  assert.deepEqual(A.map((r) => r.name), ["c", "A", "b"]);
  const byName = sortSectionA(
    [
      { name: "b", row: 2, baseRows: 1 },
      { name: "A", row: 5, baseRows: 9 },
    ],
    "name"
  );
  assert.deepEqual(byName.map((r) => r.name), ["A", "b"]);

  const B = sortSectionB([
    { name: "x", row: 1, assessedAt: "2026-01-01" },
    { name: "y", row: 2, assessedAt: null },
    { name: "z", row: 3, assessedAt: "2026-05-01" },
  ]);
  assert.deepEqual(B.map((r) => r.name), ["z", "x", "y"]);
});

// ---- B23: all-9-status partition ------------------------------------------

test("B23 KPI partition Σ = ledgerRows on an all-9-status fixture; 9 statuses exist", () => {
  assert.equal(SOURCE_STATUSES.length, 9);
  const rec = reconcile(
    [
      srcEntry({ row: 1, registry_keys: ["k_in"], verdict: "USABLE", in_list_flag: "NO-NOT-MERGED", in_the_list: "NO-NOT-MERGED|0", in_list_rows: 0 }),
      srcEntry({ row: 2, registry_keys: [], enrichment: true, in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 3, registry_keys: ["k_u"], verdict: "USABLE", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 4, registry_keys: ["k_ny"], verdict: "NOT-YET-WORKED", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 5, registry_keys: ["k_g"], verdict: "GATED", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 6, registry_keys: ["k_f"], verdict: "FORBIDDEN", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 7, registry_keys: ["k_d"], verdict: "DEAD", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 8, registry_keys: ["k_s"], verdict: "SUPERSEDED", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
      srcEntry({ row: 9, registry_keys: ["k_o"], verdict: "WHATEVER", in_list_flag: "NO", in_the_list: "NO|0", in_list_rows: 0 }),
    ],
    [agg("k_in", 5)]
  );
  const k = rec.kpis;
  assert.equal(k.ledgerRows, 9);
  const partition = k.feedingBase + k.usableNotMerged + k.gated + k.forbidden + k.deadNotYetSupersededOther;
  assert.equal(partition, k.ledgerRows, "every ledger row lands in exactly one KPI bucket");
  assert.equal(k.feedingBase, 2, "in_base + enrichment");
  assert.equal(k.deadNotYetSupersededOther, 4, "dead + not_yet + superseded + other");
});

// ---- B24: versionSkew + ledgerAgeDays -------------------------------------

test("B24 versionSkew + ledgerAgeDays (UTC parse; unparsable → null)", () => {
  assert.equal(parseUtcStamp("2026-09-02 07:06 UTC"), Date.UTC(2026, 8, 2, 7, 6));
  assert.equal(parseUtcStamp("not a date"), null);

  const skew = reconcile([srcEntry({ row: 1 })], [], {
    baseSourceVersion: "v21",
    ledgerSourceVersion: "v20",
    basePublishedAt: Date.UTC(2026, 8, 2, 0, 0),
    ledgerMtimeMs: Date.UTC(2026, 8, 12, 0, 0),
  });
  assert.deepEqual(skew.versionSkew, { ledgerVersion: "v20", baseVersion: "v21" });
  assert.equal(skew.ledgerAgeDays, 10, "ledger 10 days newer than the base");

  const noAge = reconcile([srcEntry({ row: 1 })], [], { basePublishedAt: null, ledgerMtimeMs: null });
  assert.equal(noAge.ledgerAgeDays, null);
  assert.equal(noAge.versionSkew, null);
});

// ---- B25: view render ------------------------------------------------------

test("B25 view: sections/testids, external links http-only + rel/target + derived host, no @, (trimmed)", () => {
  const SourcesView = loadView();
  const aggs = [agg("reg_a", 100, 80, 5, "2026-08-01")];
  const sources = okSources([
    srcEntry({ row: 1, name: "Alpha Reg", registry_keys: ["reg_a"], url: "https://reg.example.gov/x", in_list_flag: "YES", in_list_rows: 50, verdict: "USABLE", licence_terms: "L".repeat(300), licence_terms_truncated: true }),
    srcEntry({ row: 2, name: "Bad URL Src", registry_keys: ["reg_b"], url: "https://%zz", verdict: "FORBIDDEN", in_the_list: "NO-FORBIDDEN|0", in_list_flag: "NO-FORBIDDEN", in_list_rows: 0 }),
    srcEntry({ row: 3, name: "Bracket Src", registry_keys: ["reg_c"], url: "https://[::1", verdict: "DEAD", in_the_list: "NO-DEAD|0", in_list_flag: "NO-DEAD", in_list_rows: 0 }),
  ]);
  const out = collect(SourcesView({ leads: okLeads(aggs), sources, searchParams: {} }));

  for (const id of ["sources-freshness", "sources-in-base", "sources-not-in-base", "sources-registry-only", "sources-legend", "sources-verdict-caption"]) {
    assert.ok(out.testids.has(id), `testid ${id} present`);
  }
  const ext = out.anchors.filter((a) => a.target === "_blank");
  assert.ok(ext.length >= 1, "at least one external link");
  for (const a of ext) {
    assert.match(a.href, /^https?:\/\//, "external links are http(s) only");
    assert.equal(a.rel, "noopener noreferrer");
  }
  const text = out.text.join(" ");
  assert.ok(text.includes("reg.example.gov"), "derived host rendered");
  assert.ok(!ext.some((a) => a.href.includes("%zz") || a.href.includes("[::1")), "unparseable URLs never become links");
  assert.ok(!out.text.join("").includes("@"), "no email token in the HTML");
  assert.ok(text.includes("(trimmed)"), "truncated field flagged");
});

// ---- B26: view states ------------------------------------------------------

test("B26 view states: buckets-truncated, unreadable, filter indicator + show all, 9 status chips", () => {
  const SourcesView = loadView();
  const aggs = [agg("(other)", 5), agg("real", 10, 2, 1)];
  const leads = okLeads(aggs, { sourcesTruncated: true, sourcesUnreadable: 3 });
  const out = collect(SourcesView({ leads, sources: okSources([]), searchParams: { status: "forbidden" } }));
  assert.ok(out.testids.has("sources-buckets-truncated"));
  assert.ok(out.testids.has("sources-unreadable"));
  assert.ok(out.testids.has("sources-filter"));
  const text = out.text.join(" ");
  assert.ok(text.includes("show all"));
  for (const label of ["in base", "enrichment", "usable, not merged", "not yet", "gated", "forbidden", "dead", "superseded", "other verdict"]) {
    assert.ok(text.includes(label), `status chip "${label}" present`);
  }
});

// ---- B27: page harness -----------------------------------------------------

test("B27 page harness: chdir(tmp) before loadTs → both captions; null session → denial; array params; never throws", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sources-page-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true }); // empty data/, no content/
  const prev = process.cwd();
  process.chdir(tmp);
  try {
    const session = { adminSession: async () => ({ user: { email: "admin@x" } }) };
    const denied = { adminDeniedResponse: async () => ({ __denied: true }) };
    const h = createRouteHarness({
      stubs: { "next/link": LINK_STUB, "@/lib/admin-session": session, "../access": denied },
    });
    const page = h.loadTs(path.join(APP_DIR, "admin", "sources", "page.tsx")).default;
    const el = await page({ searchParams: { q: ["a", "b"], status: ["x", "y"] } });
    const out = collect(el);
    assert.ok(out.testids.has("sources-ledger-missing"), "ledger missing caption (loaders resolved to tmp)");
    assert.ok(out.testids.has("sources-counts-unavailable"), "counts unavailable caption");

    const h2 = createRouteHarness({
      stubs: { "next/link": LINK_STUB, "@/lib/admin-session": { adminSession: async () => null }, "../access": denied },
    });
    const page2 = h2.loadTs(path.join(APP_DIR, "admin", "sources", "page.tsx")).default;
    assert.deepEqual(await page2({ searchParams: {} }), { __denied: true }, "null session takes the denial path");
  } finally {
    process.chdir(prev);
  }
});

// ---- B28: meta-tests -------------------------------------------------------

test("B28 meta-tests: gate shape, nav, gitignore, package.json, ui exports, no leftover consts", () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

  const page = read("app", "admin", "sources", "page.tsx");
  assert.match(page, /\badminSession\b/);
  assert.match(page, /adminDeniedResponse/);
  assert.ok(!/dangerouslySetInnerHTML/.test(page));

  const view = read("app", "admin", "sources", "view.tsx");
  assert.ok(!/dangerouslySetInnerHTML/.test(view));

  // The admin nav is now DATA in app/admin/nav.ts (rendered by layout.tsx); the
  // Sources link lives there. layout.tsx must still wire that nav in.
  assert.match(read("app", "admin", "nav.ts"), /\/admin\/sources/);
  assert.match(read("app", "admin", "layout.tsx"), /NAV_GROUPS/);
  assert.match(read(".gitignore"), /content\/docka-sources\.json/);

  const pkg = read("package.json");
  assert.match(pkg, /tests\/docka-sources\.test\.mjs/);
  assert.match(pkg, /tests\/file-memo\.test\.mjs/);

  const ui = read("app", "admin", "ui.tsx");
  assert.match(ui, /export const BADGE/);
  assert.match(ui, /export const TH/);
  assert.match(ui, /export const TD/);
  assert.match(ui, /export function toggleParamHref/);

  for (const f of [["app", "admin", "leads", "view.tsx"], ["app", "admin", "outreach", "page.tsx"], ["app", "admin", "outreach", "timeline.tsx"]]) {
    assert.ok(!/const BADGE\s*=/.test(read(...f)), `${f.join("/")} no longer declares BADGE`);
  }
  assert.ok(!/stageHref/.test(read("app", "admin", "outreach", "page.tsx")), "outreach page has no stageHref");
});
