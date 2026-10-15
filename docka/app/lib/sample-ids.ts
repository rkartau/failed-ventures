// Public Sample Profiles — the SINGLE source of the sample-row identity literals.
//
// Every id of a seeded sample row starts with SAMPLE_PREFIX. The seed script
// (scripts/seed-samples.mjs, plain .mjs for prod Node) duplicates these literals;
// a unit test locks the two copies equal so they can never drift.
//
// SAMPLE_OPEN_TOKEN is the flagship's PUBLISHED open share token: it appears in
// indexable public pages by design. Everything reachable through it is guarded
// read-only + curated by lib/sample-guard.ts — publishing it must never expose a
// write or a non-curated row.

export const SAMPLE_PREFIX = "sample-";

/** The fictional sample crewing agency ("Sample Crewing OÜ"). */
export const SAMPLE_AGENCY_ID = "sample-agency-crewing";

/** The flagship public sample seafarer (the owner-view demo page's subject). */
export const SAMPLE_FLAGSHIP_ID = "sample-seafarer-flagship";

/**
 * Board-only sample crew (≥1 per pipeline stage; never on any real surface).
 * Stage mapping lives in scripts/seed-samples.mjs (grant.stage is the source of
 * truth): review ×2 (review, docs-pending), accepted ×2 (approved, accepted),
 * sent_to_sea, returning, finished — all five lib/pipeline.ts stages covered.
 */
export const SAMPLE_CREW_IDS = [
  "sample-crew-review",
  "sample-crew-docs-pending",
  "sample-crew-approved",
  "sample-crew-accepted",
  "sample-crew-sent-to-sea",
  "sample-crew-returning",
  "sample-crew-finished",
] as const;

/**
 * The flagship's published OPEN share token (a real, working token — seeded
 * verbatim by the seed script). Public by design; the sample guard makes it
 * strictly read-only + curated.
 */
export const SAMPLE_OPEN_TOKEN = "ys1pBYWeQrgo";

/** True when an id belongs to the seeded sample namespace. */
export function isSampleId(id: string): boolean {
  return typeof id === "string" && id.startsWith(SAMPLE_PREFIX);
}
