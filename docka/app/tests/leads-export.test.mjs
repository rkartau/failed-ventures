// Unit tests for the lead/campaign automation loop's server pieces:
//   lib/machine-token.ts       — Bearer machine-token auth (both scopes)
//   lib/leads-export.ts        — columnar -> §15 flat export + content_sha256
//   lib/leads-export-store.ts  — fs shell (missing/invalid/ok + mtime cache)
// plus the isolation guard's admin-API lock over BOTH automation routes
// (meta-test, outreach-snapshot.test.mjs pattern). The auth-gated routes are
// deliberately NEVER imported.
//
// The content_sha256 contract is pinned against the PIPELINE's reference
// implementation: EXPECTED_FIXTURE_SHA below was computed with Python's
//   hashlib.sha256(json.dumps(leads, sort_keys=True, separators=(",",":"),
//                             ensure_ascii=False).encode("utf-8"))
// over the exact leads this fixture flattens to — the same rule the binding
// fixture docka-outreach-pipeline/tests/fixtures/docka_leads_export.json obeys.
//
// Run: node --import ./tests/_register-alias.mjs --test tests/leads-export.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Throwaway cwd BEFORE any @/lib import — store paths are cwd-resolved.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docka-leads-export-"));
process.chdir(TMP);

const {
  SCOPE_ENV_KEYS,
  parseBearerToken,
  verifyMachineToken,
  MACHINE_TOKEN_BUCKET,
  MACHINE_TOKEN_BUDGET,
} = await import("@/lib/machine-token");
const {
  EXPORT_BOOL_FIELDS,
  EXPORT_STR_FIELDS,
  canonicalLeadsJson,
  contentSha256,
  flattenLeadsDoc,
  serializeExport,
  exportFailureResponse,
} = await import("@/lib/leads-export");
const { readLeadsExport, __clearLeadsExportCache } = await import("@/lib/leads-export-store");
const { validateBoard } = await import("@/lib/outreach-snapshot");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Machine tokens ------------------------------------------------------

const READ_TOKEN = "a".repeat(64);
const UPLOAD_TOKEN = "b".repeat(64);
const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const ENV = {
  LEADS_READ_TOKEN_HASH: sha256hex(READ_TOKEN),
  OUTREACH_UPLOAD_TOKEN_HASH: sha256hex(UPLOAD_TOKEN),
};

test("parseBearerToken: happy path + rejects", () => {
  assert.equal(parseBearerToken(`Bearer ${READ_TOKEN}`), READ_TOKEN);
  assert.equal(parseBearerToken(`  bearer ${READ_TOKEN}  `), READ_TOKEN); // case + trim
  for (const bad of [
    null,
    undefined,
    "",
    READ_TOKEN, // no scheme
    `Basic ${READ_TOKEN}`,
    "Bearer", // no token
    "Bearer  ", // whitespace token
    "Bearer short", // under min length
    `Bearer ${"x".repeat(600)}`, // over max length
    `Bearer ${READ_TOKEN} trailing`,
  ]) {
    assert.equal(parseBearerToken(bad), null, JSON.stringify(bad));
  }
});

test("verifyMachineToken: valid token per scope, with actor string", () => {
  const read = verifyMachineToken(`Bearer ${READ_TOKEN}`, "leads-read", ENV);
  assert.deepEqual(read, { ok: true, actor: "machine:leads-read" });
  const up = verifyMachineToken(`Bearer ${UPLOAD_TOKEN}`, "outreach-upload", ENV);
  assert.deepEqual(up, { ok: true, actor: "machine:outreach-upload" });
});

test("verifyMachineToken: missing header → no-bearer", () => {
  assert.deepEqual(verifyMachineToken(null, "leads-read", ENV), {
    ok: false,
    reason: "no-bearer",
  });
});

test("verifyMachineToken: wrong token → invalid", () => {
  const r = verifyMachineToken(`Bearer ${"c".repeat(64)}`, "leads-read", ENV);
  assert.deepEqual(r, { ok: false, reason: "invalid" });
});

test("verifyMachineToken: WRONG-SCOPE token rejected (upload token on read endpoint and vice versa)", () => {
  assert.deepEqual(verifyMachineToken(`Bearer ${UPLOAD_TOKEN}`, "leads-read", ENV), {
    ok: false,
    reason: "invalid",
  });
  assert.deepEqual(verifyMachineToken(`Bearer ${READ_TOKEN}`, "outreach-upload", ENV), {
    ok: false,
    reason: "invalid",
  });
});

test("verifyMachineToken: FAIL CLOSED when scope hash unset / empty / malformed", () => {
  for (const env of [
    {},
    { LEADS_READ_TOKEN_HASH: "" },
    { LEADS_READ_TOKEN_HASH: "not-hex" },
    { LEADS_READ_TOKEN_HASH: "abc123" }, // too short
    { LEADS_READ_TOKEN_HASH: READ_TOKEN + "00" }, // 66 chars
  ]) {
    const r = verifyMachineToken(`Bearer ${READ_TOKEN}`, "leads-read", env);
    assert.deepEqual(r, { ok: false, reason: "unconfigured" }, JSON.stringify(env));
  }
});

test("verifyMachineToken: configured hash is case/whitespace tolerant (env-file hygiene)", () => {
  const env = { LEADS_READ_TOKEN_HASH: ` ${sha256hex(READ_TOKEN).toUpperCase()} ` };
  assert.equal(verifyMachineToken(`Bearer ${READ_TOKEN}`, "leads-read", env).ok, true);
});

test("scope env keys are the documented .env.local lines", () => {
  assert.deepEqual(SCOPE_ENV_KEYS, {
    "outreach-upload": "OUTREACH_UPLOAD_TOKEN_HASH",
    "leads-read": "LEADS_READ_TOKEN_HASH",
  });
  assert.equal(MACHINE_TOKEN_BUCKET, "machine-token");
  assert.ok(MACHINE_TOKEN_BUDGET.capacity > 0 && MACHINE_TOKEN_BUDGET.refillPerMs > 0);
});

// ---- Upload-by-token path (route stays unimported; its two pure halves) --

test("upload-by-token path: token verdict + board validation compose", () => {
  const auth = verifyMachineToken(`Bearer ${UPLOAD_TOKEN}`, "outreach-upload", ENV);
  assert.equal(auth.ok, true);
  const board = {
    generated_at: new Date().toISOString(),
    campaign: { sends_today: 1, daily_cap: 50, bounce_rate_pct: 0, halted: false },
    leads: [{ send_key: "k", company: "Co", country: "EE", angle: "A", stage: "queued" }],
  };
  const v = validateBoard(board);
  assert.equal(v.ok, true);
  assert.equal(v.snapshot.leads.length, 1);
});

// ---- Flattening fixture --------------------------------------------------

// Python-computed over this fixture's flattened leads (see file header).
const EXPECTED_FIXTURE_SHA = "b20fd8943bb392daab33ad3eb2315a92065e11cbc77389a373aa357df21a015b";

function mkColumnar() {
  return {
    schema_version: 1,
    generated_at: "2026-08-18 15:37 UTC",
    source_version: "v4",
    layout: "columnar",
    columns: [
      "company_name", "country_iso2", "registry", "segment_guess", "contact_email",
      "crewing_email", "email_source_url", "source_url", "extracted_at", "is_sendable",
      "outreach_channel_effective", "do_not_mail", "sanctions_hit", "email_is_personal",
      "email_domain_undeliverable", "risky_role_mailbox",
    ],
    dictionary_columns: [
      "registry", "segment_guess", "outreach_channel_effective", "country_iso2", "extracted_at",
    ],
    dictionaries: {
      registry: ["ee_ariregister", "uk_companies_house"],
      segment_guess: ["manning_agency", "shipowner"],
      outreach_channel_effective: ["GREEN", "RED"],
      country_iso2: ["EE", "GB"],
      extracted_at: ["2026-08-17"],
    },
    rows: [
      // crewing beats contact; string "true"; null booleans; non-ASCII name
      ["Ålpha Läden OÜ", 0, 0, 0, "info@alpha.example", "crew@alpha.example",
        "https://alpha.example/contact", "https://ariregister.rik.ee/eng/company/1", 0, true, 0,
        "true", false, null, false, true],
      // no crewing → contact (trimmed); "TRUE" uppercase
      ["Beta Crewing Ltd", 1, 1, 1, "  info@beta.example  ", "",
        "", "https://registry.example/beta", 0, false, 1,
        false, true, false, "TRUE", false],
      // no email at all → ""; null dict indices → ""
      ["Gamma OÜ", 0, 0, null, null, null,
        null, null, 0, "false", null,
        null, null, null, null, null],
    ],
  };
}

test("flattenLeadsDoc: field mapping, email selection rule, dictionary decode", () => {
  const r = flattenLeadsDoc(mkColumnar());
  assert.equal(r.ok, true, r.error);
  const [a, b, c] = r.export.leads;
  assert.equal(r.export.schema_version, 1);
  assert.equal(r.export.generated_at, "2026-08-18 15:37 UTC");
  assert.equal(r.export.source_version, "v4");
  assert.deepEqual(a, {
    company_name: "Ålpha Läden OÜ",
    contact_email_primary: "crew@alpha.example", // crewing/desk wins
    country_iso2: "EE",
    registry: "ee_ariregister",
    segment_guess: "manning_agency",
    email_source_url: "https://alpha.example/contact",
    source_url: "https://ariregister.rik.ee/eng/company/1",
    extracted_at: "2026-08-17",
    is_sendable: true,
    outreach_channel_effective: "GREEN",
    do_not_mail: true, // string "true" → real boolean
    sanctions_hit: false,
    email_is_personal: false, // null → false
    email_domain_undeliverable: false,
    risky_role_mailbox: true,
  });
  assert.equal(b.contact_email_primary, "info@beta.example"); // fallback + trim
  assert.equal(b.email_domain_undeliverable, true); // "TRUE" → true
  assert.equal(c.contact_email_primary, ""); // no email carried honestly
  assert.equal(c.segment_guess, ""); // null dict index → ""
});

test("flattenLeadsDoc: every gate field is a REAL boolean, every string field a string, on every row", () => {
  const r = flattenLeadsDoc(mkColumnar());
  assert.equal(r.ok, true);
  for (const lead of r.export.leads) {
    for (const f of EXPORT_BOOL_FIELDS) {
      assert.equal(typeof lead[f], "boolean", `${f} of ${lead.company_name}`);
    }
    for (const f of EXPORT_STR_FIELDS) {
      assert.equal(typeof lead[f], "string", `${f} of ${lead.company_name}`);
    }
  }
});

test("content_sha256: matches the PYTHON reference hash (pipeline contract) and is self-consistent", () => {
  const r = flattenLeadsDoc(mkColumnar());
  assert.equal(r.ok, true);
  assert.equal(r.export.content_sha256, EXPECTED_FIXTURE_SHA);
  // Self-consistency: recomputing over the served leads reproduces the field.
  assert.equal(contentSha256(r.export.leads), r.export.content_sha256);
});

test("canonicalLeadsJson: sorted keys, compact separators, raw non-ASCII", () => {
  const canon = canonicalLeadsJson([
    { company_name: "Õ Co", is_sendable: true, contact_email_primary: "x@y.z" },
  ]);
  assert.equal(
    canon,
    '[{"company_name":"Õ Co","contact_email_primary":"x@y.z","is_sendable":true}]'
  );
});

test("flattenLeadsDoc: FAIL CLOSED envelope rejects", () => {
  for (const [mutate, want] of [
    [(d) => 42, "not a JSON object"],
    [(d) => ({ ...d, generated_at: "" }), "generated_at"],
    [(d) => ({ ...d, source_version: undefined }), "source_version"],
    [(d) => ({ ...d, columns: undefined }), "columns"],
    [(d) => ({ ...d, rows: {} }), "rows"],
    [(d) => ({ ...d, columns: d.columns.filter((c) => c !== "is_sendable") }), 'required column "is_sendable"'],
  ]) {
    const r = flattenLeadsDoc(mutate(mkColumnar()));
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(want), `${r.error} ⊅ ${want}`);
  }
});

test("flattenLeadsDoc: FAIL CLOSED row rejects (non-array row, dict index out of range)", () => {
  const badRow = mkColumnar();
  badRow.rows[1] = "not-a-row";
  const r1 = flattenLeadsDoc(badRow);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes("row 1"));

  const badIdx = mkColumnar();
  badIdx.rows[0][2] = 99; // registry dictionary has 2 entries
  const r2 = flattenLeadsDoc(badIdx);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes("out of range"));
});

test("serializeExport: round-trips through JSON.parse with booleans intact", () => {
  const r = flattenLeadsDoc(mkColumnar());
  const s = serializeExport(r.export);
  assert.equal(s.ok, true);
  const back = JSON.parse(s.body);
  assert.equal(back.content_sha256, EXPECTED_FIXTURE_SHA);
  assert.equal(back.leads.length, 3);
  assert.equal(back.leads[0].is_sendable, true);
  assert.equal(back.leads[0].do_not_mail, true);
});

// ---- 503 mapping ---------------------------------------------------------

test('exportFailureResponse: missing → 503 {ok:false, reason:"no lead snapshot"}; others honest', () => {
  assert.deepEqual(exportFailureResponse("missing"), {
    httpStatus: 503,
    body: { ok: false, reason: "no lead snapshot" },
  });
  assert.equal(exportFailureResponse("unreadable").httpStatus, 503);
  assert.equal(exportFailureResponse("unreadable").body.reason, "lead snapshot unreadable");
  assert.equal(exportFailureResponse("invalid").body.reason, "lead snapshot invalid");
});

// ---- Store (fs shell) ----------------------------------------------------

const CONTENT_DIR = path.join(TMP, "content");
const CONTENT_PATH = path.join(CONTENT_DIR, "docka-leads.json");

test("store: missing file → missing (the pre-first-publish state)", () => {
  __clearLeadsExportCache();
  assert.deepEqual(readLeadsExport(CONTENT_PATH), { status: "missing" });
});

test("store: garbage bytes → invalid; valid columnar file → ok with the flattened body", () => {
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  __clearLeadsExportCache();
  fs.writeFileSync(CONTENT_PATH, "not json {", "utf-8");
  assert.equal(readLeadsExport(CONTENT_PATH).status, "invalid");

  __clearLeadsExportCache();
  fs.writeFileSync(CONTENT_PATH, "﻿" + JSON.stringify(mkColumnar()), "utf-8"); // BOM tolerated
  const r = readLeadsExport(CONTENT_PATH);
  assert.equal(r.status, "ok");
  const body = JSON.parse(r.body);
  assert.equal(body.content_sha256, EXPECTED_FIXTURE_SHA);
  assert.equal(body.leads[0].contact_email_primary, "crew@alpha.example");
});

test("store: cache serves identical body, and a NEW publish (different size) invalidates it", () => {
  __clearLeadsExportCache();
  fs.writeFileSync(CONTENT_PATH, JSON.stringify(mkColumnar()), "utf-8");
  const first = readLeadsExport(CONTENT_PATH);
  const again = readLeadsExport(CONTENT_PATH);
  assert.equal(again.status, "ok");
  assert.equal(again.body, first.body);

  const changed = mkColumnar();
  changed.rows = changed.rows.slice(0, 1);
  changed.generated_at = "2026-08-19 09:00 UTC";
  fs.writeFileSync(CONTENT_PATH, JSON.stringify(changed), "utf-8");
  const r = readLeadsExport(CONTENT_PATH);
  assert.equal(r.status, "ok");
  const body = JSON.parse(r.body);
  assert.equal(body.leads.length, 1);
  assert.equal(body.generated_at, "2026-08-19 09:00 UTC");
});

// ---- Guard meta-test (outreach-snapshot.test.mjs pattern) ----------------

test("checkAdminApiRoutes: BOTH automation routes stay admin-gated and role-clean", async () => {
  const { checkAdminApiRoutes } = await import("../tests/isolation-static.mjs");
  const routes = [
    ["app/api/admin/outreach/route.ts", path.join(__dirname, "..", "app", "api", "admin", "outreach", "route.ts")],
    ["app/api/admin/leads/export/route.ts", path.join(__dirname, "..", "app", "api", "admin", "leads", "export", "route.ts")],
  ];
  const files = routes.map(([p, abs]) => ({ path: p, src: fs.readFileSync(abs, "utf8") }));
  assert.deepEqual(checkAdminApiRoutes(files), []);
  // And the lock still bites: stripping the gate must fail both.
  const stripped = files.map((f) => ({ ...f, src: f.src.replace(/adminSession/g, "x") }));
  assert.equal(checkAdminApiRoutes(stripped).length, 2);
});
