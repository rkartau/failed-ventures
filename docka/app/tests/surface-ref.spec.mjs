// Batch 3 (#42/#49) — HMAC per-surface ref [R42.7/C6/C9/V3].
//
// surfaceRef(id, surface) = HMAC(seafarerId, per-surface env salt), base64url, 16
// chars. Asserts: STABLE across calls for the same (seaman, surface) [C9]; DIFFERENT
// across portal vs directory salts (non-correlatable); non-reversible (not the raw
// id, fixed 16-char base64url shape); and FAIL-CLOSED LAZILY [V3] — surfaceRef throws
// SurfaceRefSaltMissing only WHEN INVOKED with an unset salt, NOT at module load (the
// module imported cleanly above with salts set, and un-setting a salt mid-run makes
// only that call throw while the rest of the process keeps working).
//
// Pure (crypto + env only) — no disk, no chdir.
// Run: node --import ./tests/_register-alias.mjs tests/surface-ref.spec.mjs

import assert from "node:assert/strict";

// Salts MUST be set before the first surfaceRef call. Set them before import so the
// module loads (proving load never depends on the salt) and the happy-path works.
process.env.PORTAL_REF_SALT = "portal-salt-unit-xyz";
process.env.DIRECTORY_REF_SALT = "directory-salt-unit-abc";

const { surfaceRef, SurfaceRefSaltMissing } = await import("@/lib/surface-ref");

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

const SID = "seafarer-uuid-1234";

// ---- (a) STABLE across calls for the same seaman + surface [C9] ----------
{
  const a = surfaceRef(SID, "portal");
  const b = surfaceRef(SID, "portal");
  assert.equal(a, b, "same (seaman, surface) -> identical ref across calls");
  ok("ref: stable across calls for the same seaman+surface [C9]");
}

// ---- (b) DIFFERENT across surfaces (non-correlatable) --------------------
{
  const p = surfaceRef(SID, "portal");
  const d = surfaceRef(SID, "directory");
  assert.notEqual(p, d, "portal vs directory refs must differ (different salts)");
  // A second seaman's portal ref differs from the first's (per-seaman).
  assert.notEqual(surfaceRef("other-seaman", "portal"), p, "different seamen -> different refs");
  ok("ref: portal vs directory differ (non-correlatable) + per-seaman distinct");
}

// ---- (c) non-reversible: not the raw id, fixed 16-char base64url shape ----
{
  const r = surfaceRef(SID, "portal");
  assert.notEqual(r, SID, "ref is never the raw seafarerId");
  assert.ok(!r.includes(SID), "ref does not embed the raw id");
  assert.equal(r.length, 16, "ref is truncated to 16 chars");
  assert.match(r, /^[A-Za-z0-9_-]{16}$/, "ref is base64url (URL-safe, no padding)");
  ok("ref: non-reversible, 16-char base64url, never the raw id");
}

// ---- (d) FAIL-CLOSED is LAZY, per-call — NOT a module-load throw [V3] -----
{
  // The module already imported cleanly with salts set (top of file). Now unset the
  // portal salt and prove the THROW happens on the CALL, and only for that surface —
  // the directory surface (salt still set) keeps working, i.e. the process stays up.
  const savedPortal = process.env.PORTAL_REF_SALT;
  delete process.env.PORTAL_REF_SALT;

  assert.throws(
    () => surfaceRef(SID, "portal"),
    (e) => e instanceof SurfaceRefSaltMissing && e.surface === "portal" && e.envKey === "PORTAL_REF_SALT",
    "unset PORTAL_REF_SALT -> SurfaceRefSaltMissing on CALL"
  );
  // The rest of the app stays up: the directory surface still emits a ref.
  assert.match(surfaceRef(SID, "directory"), /^[A-Za-z0-9_-]{16}$/, "directory ref still works while portal salt is unset");

  // Blank / whitespace-only salt is also treated as unset (fail-closed).
  process.env.PORTAL_REF_SALT = "   ";
  assert.throws(() => surfaceRef(SID, "portal"), SurfaceRefSaltMissing, "whitespace-only salt is unset");

  // Restore and prove the SAME call now succeeds again (per-call evaluation, no
  // module-load latch): the ref matches the original stable value.
  process.env.PORTAL_REF_SALT = savedPortal;
  assert.equal(surfaceRef(SID, "portal"), surfaceRef(SID, "portal"), "ref restored + stable after salt re-set");
  ok("ref: throws lazily per-CALL on unset salt (not module-load); rest of app unaffected [V3]");
}

console.log(`\nsurface-ref.spec: ${pass} sections passed`);
