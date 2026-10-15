// Cross-process append worker for the concurrency tests (plan §2 C4 / test p).
// Spawned as a REAL separate node process so the segment lock is exercised
// across true processes (not a serialized single-process harness).
//
// Usage: node --import <abs _register-alias.mjs> append-worker.mjs <event> <sendKeyPrefix> <count>
//   cwd MUST be the shared data-parent dir; OUTREACH_SEGMENT_MAX_BYTES inherited.

import { appendEvent } from "@/lib/outreach-events";

const [, , event, sendKeyPrefix, countStr] = process.argv;
const count = Number(countStr);

for (let i = 0; i < count; i++) {
  if (event === "unsub") {
    await appendEvent({ event: "unsub", send_key: sendKeyPrefix, message_id: "m" + i, touch: i });
  } else if (event === "booking") {
    await appendEvent({ event: "booking", send_key: sendKeyPrefix, booking_id: sendKeyPrefix + "-bk" + i });
  } else {
    await appendEvent({
      event: "open",
      send_key: sendKeyPrefix + "-" + i,
      message_id: "m" + i,
      touch: i,
    });
  }
}
