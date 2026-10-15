// Batch 3 (#49) — REUSED registry limiter, namespaced per bucket [C2/V2].
//
// The directory anti-harvest limiter is NOT a fork: it spends tokens through the SAME
// lib/registry `consumeBudget(bucketName, ip, opts)` core the registry-verify path
// uses, deriving the client IP through the SAME spoof-hardened `clientIpFromHeaders`.
// Buckets are namespaced `bucketName::ip` [V2] so directory traffic and registry
// traffic hold SEPARATE per-IP budgets. This asserts:
//   - bucket isolation: exhausting the DIRECTORY bucket for an IP still lets
//     consumeRegistryBudget for the SAME IP through (separate named buckets);
//   - a rotating fake X-Forwarded-For still trips ONE directory bucket (rightmost IP);
//   - two distinct real IPs get independent directory buckets;
//   - a directory bucket refills over time;
//   - consumeRegistryBudget's own per-IP + globalBucket (cap 80) behaviour is
//     byte-unchanged after the consumeBudget extraction [V2].
//
// Pure (globalThis-pinned buckets) — no disk. REGISTRY_MOCK enables the test-ip header.
// Run: node --import ./tests/_register-alias.mjs tests/rate-limit.spec.mjs

import assert from "node:assert/strict";

process.env.REGISTRY_MOCK = "1";

const {
  consumeBudget,
  consumeRegistryBudget,
  clientIpFromHeaders,
  resetRegistryAbuseState,
} = await import("@/lib/registry");

let pass = 0;
const ok = (m) => { console.log("  ok  -", m); pass++; };

// The directory route's own bucket parameters (a named, non-global bucket). Capacity
// picked small + refill 0 so the exhaustion boundary is exact and deterministic.
const DIR = { capacity: 5, refillPerMs: 0 };
const spendDir = (ip) => consumeBudget("directory", ip, DIR);

// ---- bucket ISOLATION: directory exhaustion never burns the registry budget ----
{
  resetRegistryAbuseState();
  let allowed = 0;
  for (let i = 0; i < DIR.capacity; i++) if (spendDir("ip-iso")) allowed++;
  assert.equal(allowed, DIR.capacity, "directory bucket allows exactly its capacity");
  assert.equal(spendDir("ip-iso"), false, "directory bucket denies past capacity");
  // The SAME IP's registry-verify budget is a SEPARATE named bucket — still open.
  assert.equal(consumeRegistryBudget("ip-iso"), true, "same IP's registry bucket unaffected by directory exhaustion [V2]");
  ok("isolation: exhausting the directory bucket leaves the SAME IP's registry bucket intact");
}

// ---- rotating fake XFF still trips ONE directory bucket (rightmost IP) ----
{
  resetRegistryAbuseState();
  // The single trusted hop appended the RIGHTMOST entry; a fresh fake leftmost per
  // request must still land in the same bucket.
  const ipOf = (fake) => clientIpFromHeaders(new Headers({ "x-forwarded-for": `${fake}, 8.8.4.4` }));
  let allowed = 0;
  for (let i = 0; i < DIR.capacity; i++) if (spendDir(ipOf("spoof" + i))) allowed++;
  assert.equal(allowed, DIR.capacity, "each rotating-XFF request derives the SAME rightmost IP");
  assert.equal(spendDir(ipOf("spoof-final")), false, "rotating fake XFF still trips the one directory bucket -> 429");
  ok("spoof: rotating fake X-Forwarded-For lands in ONE directory bucket (leftmost never chosen)");
}

// ---- two distinct REAL IPs get independent directory buckets -------------
{
  resetRegistryAbuseState();
  const ipA = clientIpFromHeaders(new Headers({ "x-real-ip": "9.9.9.9" }));
  const ipB = clientIpFromHeaders(new Headers({ "x-real-ip": "7.7.7.7" }));
  for (let i = 0; i < DIR.capacity; i++) assert.equal(spendDir(ipA), true);
  assert.equal(spendDir(ipA), false, "ip-A directory bucket exhausted");
  assert.equal(spendDir(ipB), true, "a DISTINCT real IP has its own directory bucket");
  ok("isolation: two distinct real IPs (X-Real-IP) get independent directory buckets");
}

// ---- a directory bucket refills over time --------------------------------
{
  resetRegistryAbuseState();
  const FAST = { capacity: 2, refillPerMs: 1 }; // 1 token/ms — refills fast enough to test headlessly
  const spendFast = (ip) => consumeBudget("dir-fast", ip, FAST);
  assert.equal(spendFast("ip-refill"), true);
  assert.equal(spendFast("ip-refill"), true);
  assert.equal(spendFast("ip-refill"), false, "empty after capacity spent");
  await new Promise((r) => setTimeout(r, 25)); // >> the 1ms/token refill needs
  assert.equal(spendFast("ip-refill"), true, "bucket refilled over elapsed time");
  ok("refill: a directory bucket refills its tokens over elapsed wall-clock time");
}

// ---- registry two-bucket behaviour byte-unchanged after the extraction [V2] ----
{
  // (i) per-IP cap 8 still enforced; a distinct IP is independent (unchanged core).
  resetRegistryAbuseState();
  let allowed = 0;
  for (let i = 0; i < 8; i++) if (consumeRegistryBudget("ip-reg")) allowed++;
  assert.equal(allowed, 8, "registry per-IP capacity still 8");
  assert.equal(consumeRegistryBudget("ip-reg"), false, "registry per-IP over-limit denied");
  assert.equal(consumeRegistryBudget("ip-reg-2"), true, "a distinct IP is independent (registry)");

  // (ii) the shared globalBucket (cap 80) still caps TOTAL outbound registry pressure:
  // 80 distinct IPs each spend one per-IP token AND one global token; the 81st distinct
  // IP is denied by the EXHAUSTED global bucket even though its per-IP bucket is full.
  resetRegistryAbuseState();
  let globalAllowed = 0;
  for (let i = 0; i < 80; i++) if (consumeRegistryBudget("global-ip-" + i)) globalAllowed++;
  assert.equal(globalAllowed, 80, "global bucket admits its cap-80 across distinct IPs");
  assert.equal(consumeRegistryBudget("global-ip-fresh"), false, "81st distinct IP denied by the exhausted globalBucket");

  // (iii) the directory path takes NO global bucket — with the registry global drained,
  // a fresh directory IP is still served (directory flood can't burn the outbound budget).
  assert.equal(spendDir("dir-after-global-drain"), true, "directory bucket unaffected by a drained registry global bucket");
  ok("registry: per-IP + globalBucket(80) two-bucket behaviour byte-unchanged; directory takes no global [V2]");
}

console.log(`\nrate-limit.spec: ${pass} sections passed`);
