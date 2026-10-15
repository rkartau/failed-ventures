// Agent pipeline states — client-safe (no Node built-ins), so both the browser
// board and the server db layer can share them. lib/db.ts re-exports these.

export const SEAFARER_STATES = [
  "review",
  "accepted",
  "sent_to_sea",
  "returning",
  "finished",
] as const;

export type SeafarerState = (typeof SEAFARER_STATES)[number];

export const STATE_LABELS: Record<SeafarerState, string> = {
  review: "Review",
  accepted: "Accepted",
  sent_to_sea: "Sent to sea",
  returning: "Coming back",
  finished: "Finished",
};

export function isSeafarerState(v: unknown): v is SeafarerState {
  return typeof v === "string" && (SEAFARER_STATES as readonly string[]).includes(v);
}

// The next state in the pipeline (finished is terminal).
export function nextState(s: SeafarerState): SeafarerState {
  const i = SEAFARER_STATES.indexOf(s);
  return SEAFARER_STATES[Math.min(i + 1, SEAFARER_STATES.length - 1)];
}
