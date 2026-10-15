// #41 — tightened employment classifiers + assignment-scoped employmentCompleteness.
// Run: node --import ./tests/_register-alias.mjs tests/employment-docs.test.mjs
import assert from "node:assert/strict";

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const { classifyRequiredType, EMPLOYMENT_DOC_TYPES } = await import("@/lib/doctypes");
const {
  employmentContextFor,
  employmentCompleteness,
  requiredSetFor,
} = await import("@/lib/required-docs");

const NOW = new Date("2026-07-21T00:00:00.000Z");
const doc = (o) => ({ requiredType: null, seaEndDate: null, ...o });
const ctx = (o = {}) =>
  employmentContextFor({ rank: "Chief Officer", vessel: "MV Test", rotationEnd: null, ...o });

// ---- Item 14 — tightened classifiers -----------------------------------
{
  assert.equal(classifyRequiredType({ title: "Seafarer's Employment Agreement" }), "SEA");
  assert.equal(classifyRequiredType({ title: "SEA" }), "SEA");
  assert.equal(classifyRequiredType({ title: "MLC A2.1 agreement" }), "SEA");
  assert.equal(classifyRequiredType({ title: "Wage account confirmation" }), "Wage Account");
  assert.equal(classifyRequiredType({ title: "Allotment form" }), "Allotment");
  assert.equal(classifyRequiredType({ title: "Contract addendum" }), "Contract Addendum");
  // A random "agreement.pdf" must NOT be a SEA (a false have is worse than a miss).
  assert.equal(classifyRequiredType({ title: "agreement.pdf" }), null);
  assert.equal(classifyRequiredType({ title: "some agreement" }), null);
  // "Sea service book" must NOT hit the case-sensitive \bSEA\b acronym rule.
  assert.notEqual(classifyRequiredType({ title: "Sea service testimonial" }), "SEA");
  ok("classifiers accept real SEA/wage/allotment/addendum, reject 'agreement.pdf' + 'Sea service'");
}

// ---- Item 12 — benched => not applicable, nothing counted missing -------
{
  const ec = employmentCompleteness([], [], ctx(), { assigned: false, now: NOW });
  assert.equal(ec.applicable, false);
  assert.deepEqual(ec.missing, []);
  assert.equal(ec.total, 0);
  ok("benched seaman => applicable:false, never counted missing");
}

// ---- Item 12 — assigned + none => SEA/wage/allotment required -----------
{
  const ec = employmentCompleteness([], [], ctx(), { assigned: true, now: NOW });
  assert.equal(ec.applicable, true);
  assert.equal(ec.total, 3);
  assert.deepEqual(ec.missing.sort(), ["Allotment", "SEA", "Wage Account"]);
  assert.equal(ec.count, 0);
  ok("assigned + nothing on file => 3 required, all missing");
}

// ---- Item 13 — assigned + present SEA + expired seaEndDate => expired ---
{
  const docs = [doc({ requiredType: "SEA", seaEndDate: "2020-01-01" })];
  const ec = employmentCompleteness(docs.map((d) => d.requiredType), docs, ctx(), { assigned: true, now: NOW });
  assert.deepEqual(ec.expired, ["SEA"]);
  assert.ok(!ec.have.includes("SEA"), "expired SEA is NOT satisfied");
  ok("assigned + present SEA + lapsed seaEndDate => expired, not satisfied");
}

// ---- v3 item 6 — present SEA + seaEndDate null => unknownExpiry (NOT satisfied) ----
{
  const docs = [doc({ requiredType: "SEA", seaEndDate: null })];
  const ec = employmentCompleteness(docs.map((d) => d.requiredType), docs, ctx(), { assigned: true, now: NOW });
  assert.deepEqual(ec.unknownExpiry, ["SEA"]);
  assert.deepEqual(ec.expired, []);
  assert.deepEqual(ec.missing, ["Wage Account", "Allotment"]);
  assert.ok(!ec.have.includes("SEA"), "null-date SEA is an attention state, never a silent have");
  ok("assigned + present SEA + seaEndDate null => unknownExpiry, NOT satisfied");
}

// ---- present + current SEA + wage + allotment => fully satisfied --------
{
  const docs = [
    doc({ requiredType: "SEA", seaEndDate: "2027-01-01" }),
    doc({ requiredType: "Wage Account" }),
    doc({ requiredType: "Allotment" }),
  ];
  const ec = employmentCompleteness(docs.map((d) => d.requiredType), docs, ctx(), { assigned: true, now: NOW });
  assert.equal(ec.count, 3);
  assert.deepEqual(ec.missing, []);
  assert.deepEqual(ec.expired, []);
  assert.deepEqual(ec.unknownExpiry, []);
  ok("current SEA + wage + allotment => 3/3 satisfied");
}

// ---- Item 16 Phase A — new slots seeded into NO layer => requiredSetFor unchanged ----
{
  for (const rank of ["Master", "Chief Officer", "Rating", "Cadet"]) {
    const req = requiredSetFor({ rank });
    for (const slot of EMPLOYMENT_DOC_TYPES) {
      assert.ok(!req.required.includes(slot), `${slot} must NOT be in the hard-block set for ${rank}`);
    }
  }
  ok("employment slots in NO baseline layer => requiredSetFor per rank unchanged (no deploy hard-block)");
}

// ---- CBA self-declared carried through ---------------------------------
{
  const ec = employmentCompleteness([], [], ctx({ cbaCovered: true, cbaRef: "ITF TCC" }), {
    assigned: false,
    now: NOW,
  });
  assert.equal(ec.cbaCovered, true);
  assert.equal(ec.cbaRef, "ITF TCC");
  ok("CBA self-declared flag + ref carried through the read-model");
}

// ---- #41 agent-surface UI-state derivations (board column/filter + SEA banner) ----
// These mirror EXACTLY the pure derivations the agent components drive off the shared
// read-model: ReviewPanel's `seaBannerState` and AgentBoard's "missing-employment"
// filter gap predicate + the benched "—/not required" cell. Kept here so a change to
// employmentCompleteness that would break the surfaces fails a fast logic test.
{
  const seaBannerState = (ec) =>
    ec.applicable
      ? ec.missing.includes("SEA")
        ? "missing"
        : ec.expired.includes("SEA")
          ? "expired"
          : ec.unknownExpiry.includes("SEA")
            ? "unknown"
            : null
      : null;
  const employmentGap = (ec) =>
    ec.applicable &&
    (ec.missing.length > 0 || ec.expired.length > 0 || ec.unknownExpiry.length > 0);

  const mk = (docs, scope) =>
    employmentCompleteness(docs.map((d) => d.requiredType), docs, ctx(), scope);

  // Benched => cell shows "not required": not applicable, no banner, not in the filter.
  const benched = mk([], { assigned: false, now: NOW });
  assert.equal(benched.applicable, false);
  assert.equal(seaBannerState(benched), null);
  assert.equal(employmentGap(benched), false);
  ok("benched => applicable:false, no SEA banner, excluded from missing-employment filter");

  // Assigned + missing SEA => rose "missing" banner + flagged by the filter.
  const missing = mk([], { assigned: true, now: NOW });
  assert.equal(seaBannerState(missing), "missing");
  assert.equal(employmentGap(missing), true);
  ok("assigned + missing SEA => banner 'missing' + flagged by missing-employment filter");

  // Assigned + present SEA with a NULL seaEndDate => amber "unknown" (reconfirm) banner.
  const unknown = mk([doc({ requiredType: "SEA", seaEndDate: null })], { assigned: true, now: NOW });
  assert.equal(seaBannerState(unknown), "unknown");
  assert.equal(employmentGap(unknown), true);
  ok("assigned + null-seaEndDate SEA => banner 'unknown' (reconfirm) surfaces + flagged");

  // Assigned + expired SEA => rose "expired" banner + flagged.
  const expired = mk([doc({ requiredType: "SEA", seaEndDate: "2020-01-01" })], { assigned: true, now: NOW });
  assert.equal(seaBannerState(expired), "expired");
  assert.equal(employmentGap(expired), true);
  ok("assigned + expired SEA => banner 'expired' + flagged");

  // Assigned + full current set => no banner, not in the filter (whole doc-set).
  const whole = mk(
    [
      doc({ requiredType: "SEA", seaEndDate: "2027-01-01" }),
      doc({ requiredType: "Wage Account" }),
      doc({ requiredType: "Allotment" }),
    ],
    { assigned: true, now: NOW }
  );
  assert.equal(seaBannerState(whole), null);
  assert.equal(employmentGap(whole), false);
  ok("assigned + current SEA + wage + allotment => no banner, excluded from filter");
}

console.log(`\nemployment-docs.test: ${pass} assertions passed`);
