// lib/outreach-events.ts — the append-only web-tracking event sink (plan §2 C,
// §5). This is the SINGLE writer, BY CONCERN, of the outreach tracking events:
// the APP writes ONLY `open` / `unsub` / `booking` / `signup` /
// `signup_started` here. Pipeline-origin events
// (`sent` / `accepted` / `bounce` / `reply`) are NEVER written here — they live
// in the pipeline's own send_log / reply_log. The dashboard MERGES both sides
// (disjoint event types, deduped by event_key) downstream; this module owns only
// the app side.
//
// STORAGE MODEL:
//   * Numbered segments `outreach-events-NNNN.jsonl` (NNNN zero-padded, from 0),
//     on the box's LOCAL ext4 disk. NOT db.json, NOT atomic-json rewrite, NOT
//     SQLite. The active file is BORN as `-NNNN`; at the size ceiling a NEW,
//     higher-NNNN segment is O_EXCL-created and writes move to it. The active
//     file is NEVER renamed (renaming would make a sealed name sort below the
//     reader's cursor and get skipped).
//   * One `\n`-terminated JSON line per event, written with a single O_APPEND
//     write. Lines are held < 4000 bytes (< PIPE_BUF) so the append is atomic.
//   * Appends AND rollovers are serialized by the cross-process advisory lock in
//     lib/segment-lock.ts (shared with the Python reader). See that file for the
//     lock protocol and the plan-vs-code note about pm2 fork (not cluster) mode.
//
// The on-disk format below (segment naming + numeric ordering + byteOffset
// cursor + the byte-exact event_key contract) IS the pipeline reader's contract
// (§2 D1). A backend swap must update BOTH this writer and the Python reader.

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { withSegmentLock } from "@/lib/segment-lock";

// ---- Paths & tunables ------------------------------------------------------

/** cwd/data — same convention as lib/db.ts (tests chdir to isolate). */
export function outreachDataDir(): string {
  return process.env.OUTREACH_DATA_DIR
    ? path.resolve(process.env.OUTREACH_DATA_DIR)
    : path.join(process.cwd(), "data");
}

const SEGMENT_RE = /^outreach-events-(\d+)\.jsonl$/;

/** Segment rollover ceiling in bytes. Env-overridable (tests set it low). */
export function segmentMaxBytes(): number {
  const v = Number(process.env.OUTREACH_SEGMENT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 8_000_000; // ~8 MB default
}

/**
 * Hard per-line UTF-8 byte ceiling (< PIPE_BUF). The row is trimmed to fit by
 * truncating `meta` on a WHOLE-CODEPOINT boundary (never mid-emoji → the line
 * stays valid UTF-8 that both JSON.parse and Python json.loads accept, R5).
 */
export const MAX_LINE_BYTES = 4000;

/** Sanity ceiling on total segments — a disk-DoS backstop (env-overridable). */
function maxSegments(): number {
  const v = Number(process.env.OUTREACH_MAX_SEGMENTS);
  return Number.isFinite(v) && v > 0 ? v : 100_000;
}

export class OutreachEventsError extends Error {
  readonly code: "ceiling";
  constructor(code: "ceiling", message: string) {
    super(message);
    this.name = "OutreachEventsError";
    this.code = code;
  }
}

// ---- Event shapes ----------------------------------------------------------

// Increment 5 additions:
//   * `signup` — a signup completed with outreach attribution. The created
//     account id occupies the touch slot of the event_key (mirrors booking's
//     booking_id: two distinct accounts for one send_key hash differently, a
//     replay of one collapses); message_id is EMPTY.
//   * `signup_started` — the signup page was reached with a VALID CTA token
//     (server-side tokened-page-visit signal). message_id/touch come from the
//     token payload ("cta-signup"/0), so repeat visits collapse at fold time.
export type WebTrackingEvent = "open" | "unsub" | "booking" | "signup" | "signup_started";

/** Input to appendEvent. `meta` is an optional STRING (the truncation target). */
export type AppendInput =
  | {
      event: "open" | "unsub" | "signup_started";
      send_key: string;
      message_id: string;
      touch: number;
      meta?: string;
    }
  | { event: "booking"; send_key: string; booking_id: string; meta?: string }
  | {
      event: "signup";
      send_key: string;
      user_id: string;
      /**
       * The signup ACCOUNT's (unverified) email, when the account has one —
       * docka signups are username/password and MAY carry no email. ADDITIVE
       * row field ONLY: it never enters the event_key slots (the key stays
       * [send_key, "", "signup", user_id]). The pipeline fold reads it for the
       * [R2-7] wrong-person-signup email-match rule (accepted keys there:
       * email / account_email / signup_email — we write `email`); absence
       * keeps today's token-only attribution.
       */
      email?: string;
      meta?: string;
    };

/** A stored row (one JSONL line). */
export interface EventRow {
  event_key: string;
  at: string;
  event: WebTrackingEvent;
  send_key: string;
  message_id?: string;
  touch?: number;
  booking_id?: string;
  user_id?: string;
  /** signup only: the account's email, when present (never part of event_key). */
  email?: string;
  meta?: string;
}

// ---- event_key — the BYTE-EXACT, cross-language contract (§2 C3) ------------
//
// The Python reader MUST reproduce this digest byte-for-byte. The rules:
//   * Fields hashed, IN THIS ORDER:  send_key, message_id, event, touch-slot.
//   * Delimiter between fields: the single byte 0x1f (ASCII US) — appears in no
//     value.
//   * Each field is its raw UTF-8 byte sequence. NO unicode normalization, NO
//     locale, NO case-folding.
//   * touch-slot:
//       - a normal event's `touch` integer → its DECIMAL string ("3"), no
//         padding, no sign for non-negatives.
//       - absent / null touch → the EMPTY STRING (zero bytes).
//       - a `booking` event → the `booking_id` string occupies the touch slot
//         (so two genuine bookings for one send_key hash differently, while a
//         replay of one booking collapses).
//       - a `signup` event → the created account's `user_id` string occupies
//         the touch slot (same rationale as booking_id). `signup_started` uses
//         the NORMAL touch rule (decimal touch from the CTA token payload).
//   * MISSING message_id (e.g. booking, signup) → the EMPTY STRING, never
//     "None" / "null" / "undefined".
//   * digest = SHA-256( f0 ‖ 0x1f ‖ f1 ‖ 0x1f ‖ f2 ‖ 0x1f ‖ f3 ), lowercase hex.
//
// Python reference (must match):
//   US = b"\x1f"
//   raw = US.join(f.encode("utf-8") for f in (send_key, message_id, event, touch_slot))
//   event_key = hashlib.sha256(raw).hexdigest()

const US = Buffer.from([0x1f]);

/** The four ordered string slots that feed the digest. Exported for the golden test. */
export function eventKeySlots(input: {
  send_key: string;
  message_id?: string | null;
  event: string;
  touch?: number | null;
  booking_id?: string | null;
  user_id?: string | null;
}): [string, string, string, string] {
  const sendKey = input.send_key;
  const messageId = input.message_id == null ? "" : input.message_id;
  const event = input.event;
  let touchSlot: string;
  if (input.event === "booking") {
    touchSlot = input.booking_id == null ? "" : input.booking_id;
  } else if (input.event === "signup") {
    touchSlot = input.user_id == null ? "" : input.user_id;
  } else if (input.touch == null) {
    touchSlot = "";
  } else {
    touchSlot = String(input.touch); // decimal string of the integer
  }
  return [sendKey, messageId, event, touchSlot];
}

/** Compute the byte-exact event_key (lowercase hex SHA-256). */
export function eventKey(input: {
  send_key: string;
  message_id?: string | null;
  event: string;
  touch?: number | null;
  booking_id?: string | null;
  user_id?: string | null;
}): string {
  const [f0, f1, f2, f3] = eventKeySlots(input);
  const raw = Buffer.concat([
    Buffer.from(f0, "utf8"),
    US,
    Buffer.from(f1, "utf8"),
    US,
    Buffer.from(f2, "utf8"),
    US,
    Buffer.from(f3, "utf8"),
  ]);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ---- Line encoding + codepoint-safe byte guard (§2 C1, R5) -----------------

function encodedLen(row: EventRow): number {
  return Buffer.byteLength(JSON.stringify(row) + "\n", "utf8");
}

/**
 * Serialize a row to a single `\n`-terminated line whose UTF-8 byte length is
 * < MAX_LINE_BYTES. If the full row is over budget, `meta` is truncated to the
 * largest whole-codepoint prefix that fits; if even meta="" is over budget the
 * meta field is dropped entirely. The result always JSON.parses and is always
 * valid UTF-8 (truncation walks whole codepoints via Array.from, never a
 * surrogate-half or a mid-multibyte cut).
 */
export function encodeLine(row: EventRow, maxBytes: number = MAX_LINE_BYTES): string {
  if (encodedLen(row) < maxBytes) return JSON.stringify(row) + "\n";

  // Drop meta entirely as the floor; if that still overflows, accept it (the
  // non-meta fields are bounded by token sizes, so this is effectively never).
  const bare: EventRow = { ...row };
  delete bare.meta;
  if (typeof row.meta !== "string" || encodedLen(bare) >= maxBytes) {
    return JSON.stringify(bare) + "\n";
  }

  // Binary-search the largest whole-codepoint prefix of meta that keeps the line
  // under budget.
  const cps = Array.from(row.meta); // whole codepoints (surrogate pairs intact)
  let lo = 0;
  let hi = cps.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate: EventRow = { ...row, meta: cps.slice(0, mid).join("") };
    if (encodedLen(candidate) < maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const trimmed: EventRow = best === 0 ? bare : { ...row, meta: cps.slice(0, best).join("") };
  return JSON.stringify(trimmed) + "\n";
}

// ---- Segment discovery -----------------------------------------------------

interface Segment {
  n: number;
  file: string; // basename
  path: string; // absolute
}

/** All segments in the dir, sorted by NNNN NUMERICALLY (never lexically). */
function listSegments(dir: string): Segment[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const segs: Segment[] = [];
  for (const name of names) {
    const m = SEGMENT_RE.exec(name);
    if (m) segs.push({ n: Number(m[1]), file: name, path: path.join(dir, name) });
  }
  segs.sort((a, b) => a.n - b.n);
  return segs;
}

function segmentName(n: number): string {
  return `outreach-events-${String(n).padStart(4, "0")}.jsonl`;
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// ---- appendEvent (§2 C1) ---------------------------------------------------

export interface AppendResult {
  event_key: string;
  segment: number;
  bytes: number;
}

/**
 * Append one web-tracking event. Serialized through the segment lock: re-scan
 * the highest NNNN on disk, roll over (O_EXCL-create the next NNNN) if the
 * active segment is at the ceiling, then O_APPEND the `\n`-terminated line.
 *
 * Idempotency is a READ-side property: repeated appends of the same logical
 * event carry the same event_key and collapse at fold time (dedup). This
 * function never dedups on the hot path — an unsub POSTed twice writes two rows
 * with one event_key, folded to one suppression.
 */
export async function appendEvent(input: AppendInput): Promise<AppendResult> {
  const dir = outreachDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const key = eventKey(
    input.event === "booking"
      ? { send_key: input.send_key, event: "booking", booking_id: input.booking_id }
      : input.event === "signup"
        ? { send_key: input.send_key, event: "signup", user_id: input.user_id }
        : {
            send_key: input.send_key,
            message_id: input.message_id,
            event: input.event,
            touch: input.touch,
          }
  );

  const row: EventRow = {
    event_key: key,
    at: new Date().toISOString(),
    event: input.event,
    send_key: input.send_key,
    ...(input.event === "booking"
      ? { booking_id: input.booking_id }
      : input.event === "signup"
        ? { user_id: input.user_id, ...(input.email ? { email: input.email } : {}) }
        : { message_id: input.message_id, touch: input.touch }),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };

  const line = encodeLine(row);
  const ceiling = segmentMaxBytes();

  const segment = await withSegmentLock(dir, () => {
    // Re-scan the highest existing NNNN INSIDE the lock (never cache across the
    // ceiling). No segment yet → the active file is born as 0000.
    const segs = listSegments(dir);
    let active = segs.length === 0 ? 0 : segs[segs.length - 1].n;

    if (segs.length === 0) {
      fs.writeFileSync(path.join(dir, segmentName(0)), ""); // birth 0000
    } else if (sizeOf(segs[segs.length - 1].path) >= ceiling) {
      // Roll over: O_EXCL-create the next NNNN (exactly one winner under the lock).
      const next = active + 1;
      if (next >= maxSegments()) {
        throw new OutreachEventsError(
          "ceiling",
          `outreach event store reached the ${maxSegments()}-segment ceiling`
        );
      }
      const fd = fs.openSync(path.join(dir, segmentName(next)), "wx");
      fs.closeSync(fd);
      active = next;
    }

    fs.appendFileSync(path.join(dir, segmentName(active)), line); // single O_APPEND write
    return active;
  });

  return { event_key: key, segment, bytes: Buffer.byteLength(line, "utf8") };
}

// ---- Reader (§2 C1 / D1) ---------------------------------------------------

export interface EventCursor {
  segment: number;
  byteOffset: number;
}

export interface ReadResult {
  events: EventRow[];
  cursor: EventCursor;
  /** rows that failed JSON.parse (torn/corrupt) — skipped, counted for observability. */
  skipped: number;
}

/**
 * Read every fully-`\n`-terminated event at or after `cursor`. Opens every
 * segment with number ≥ cursor.segment (compared NUMERICALLY), reads
 * cursor.segment from cursor.byteOffset and all higher segments from byte 0.
 * A torn final line (no trailing `\n`) is left unconsumed for the next read.
 * The returned cursor points at the highest segment and the byte offset just
 * past the last fully-consumed line there — advancing to a higher segment is
 * safe because sealed lower segments are read to EOF.
 *
 * NOTE: this is the TS mirror of the Python pipeline reader (§2 D1). The Python
 * side additionally takes the segment lock to SNAPSHOT segment EOFs before
 * reading; the app-side reader here is used by tests and the (deferred) debug
 * route and reads without the lock, tolerating a concurrently-growing active
 * segment by consuming only whole lines.
 */
export function readEventsSince(cursor?: EventCursor): ReadResult {
  const dir = outreachDataDir();
  const segs = listSegments(dir);
  const from = cursor ?? { segment: 0, byteOffset: 0 };

  const events: EventRow[] = [];
  let skipped = 0;
  let lastSegment = from.segment;
  let lastOffset = from.byteOffset;

  const relevant = segs.filter((s) => s.n >= from.segment);
  if (relevant.length === 0) {
    return { events, cursor: { segment: lastSegment, byteOffset: lastOffset }, skipped };
  }

  for (const seg of relevant) {
    const startAt = seg.n === from.segment ? from.byteOffset : 0;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(seg.path);
    } catch {
      continue;
    }
    if (startAt >= buf.length) {
      lastSegment = seg.n;
      lastOffset = buf.length;
      continue;
    }
    const slice = buf.subarray(startAt);
    // Consume only up to the LAST newline — a trailing partial line is left.
    const lastNl = slice.lastIndexOf(0x0a);
    lastSegment = seg.n;
    if (lastNl < 0) {
      // No complete line in this segment's remainder — leave the offset put.
      lastOffset = startAt;
      continue;
    }
    const consumable = slice.subarray(0, lastNl + 1).toString("utf8");
    for (const rawLine of consumable.split("\n")) {
      if (rawLine.length === 0) continue;
      try {
        events.push(JSON.parse(rawLine) as EventRow);
      } catch {
        skipped += 1;
      }
    }
    lastOffset = startAt + lastNl + 1;
  }

  return { events, cursor: { segment: lastSegment, byteOffset: lastOffset }, skipped };
}

// ---- aggregateBySendKey (§2 C1) --------------------------------------------

export interface SendKeyAggregate {
  send_key: string;
  opened: boolean;
  unsubbed: boolean;
  booked: boolean;
  /** a `signup` event exists (Increment 5). */
  signedUp: boolean;
  /** a `signup_started` event exists (abandoned-signup signal feed). */
  signupStarted: boolean;
  /** distinct touches with an `open`. */
  openTouches: number[];
  /** distinct booking_ids. */
  bookingIds: string[];
  /** distinct signup user_ids. */
  signupUserIds: string[];
}

/**
 * Fold a set of event rows into per-send_key engagement, DEDUPED by event_key
 * (so replay / re-read / a re-rendered pixel never double-counts). Semantics are
 * boolean engagement-per-touch, not occurrence counts.
 */
export function aggregateBySendKey(events: EventRow[]): Map<string, SendKeyAggregate> {
  const seen = new Set<string>();
  const out = new Map<string, SendKeyAggregate>();

  for (const ev of events) {
    if (ev.event_key && seen.has(ev.event_key)) continue;
    if (ev.event_key) seen.add(ev.event_key);

    let agg = out.get(ev.send_key);
    if (!agg) {
      agg = {
        send_key: ev.send_key,
        opened: false,
        unsubbed: false,
        booked: false,
        signedUp: false,
        signupStarted: false,
        openTouches: [],
        bookingIds: [],
        signupUserIds: [],
      };
      out.set(ev.send_key, agg);
    }
    if (ev.event === "open") {
      agg.opened = true;
      if (typeof ev.touch === "number" && !agg.openTouches.includes(ev.touch)) {
        agg.openTouches.push(ev.touch);
      }
    } else if (ev.event === "unsub") {
      agg.unsubbed = true;
    } else if (ev.event === "booking") {
      agg.booked = true;
      if (ev.booking_id && !agg.bookingIds.includes(ev.booking_id)) {
        agg.bookingIds.push(ev.booking_id);
      }
    } else if (ev.event === "signup") {
      agg.signedUp = true;
      if (ev.user_id && !agg.signupUserIds.includes(ev.user_id)) {
        agg.signupUserIds.push(ev.user_id);
      }
    } else if (ev.event === "signup_started") {
      agg.signupStarted = true;
    }
  }
  return out;
}
