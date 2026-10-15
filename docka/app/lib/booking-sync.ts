// "Book a call" — the bounded background calendar reconciler (CV5-6 / CV6-1…5).
//
// Recovers bookings whose Google Calendar push never completed (crash between record and
// stamp, a transient Google failure) and backstops the cancel path so no cancelled
// call's event is orphaned on Google. Runs from the CRON_SECRET-gated route
// (app/api/cron/booking-sync); the core is factored HERE so tests drive it with injected
// calendar fns + a db read/write seam and never touch the network.
//
// INVARIANTS:
//  - Google network calls happen OUTSIDE the `updateDB` mutex; only the stamp is inside.
//  - Process-level SINGLE-FLIGHT lock, released in a `finally` (CV6-4) so a mid-batch
//    throw can never wedge the route permanently.
//  - Selection is oldest-first by `createdAt` (CV6-2 FIFO — no newest-first starvation),
//    capped at BATCH. After ATTEMPT_CAP failed attempts a row goes terminal "abandoned"
//    and drops out of the selector (a manual admin Resync can still retry it).
//  - A cancelled booking is NEVER re-pushed (the selector filters status==="booked").

import type { Booking, DB } from "@/lib/db";
import { excludeBusySlots, getBookingSettings } from "@/lib/booking";
import type { BusyWallRange, DeleteResult, PushResult } from "@/lib/google-calendar";

/** Max bookings processed per cron tick (CV5-6 bounded batch). */
export const RECONCILE_BATCH = 25;
/** Failed-attempt cap before a row is parked "abandoned" (CV6-2). */
export const SYNC_ATTEMPT_CAP = 5;
/** Recency window for the tombstone re-delete sweep (CV6-1). */
export const TOMBSTONE_RECENCY_MS = 24 * 60 * 60 * 1000;

/**
 * Injectable seams. Wave-3's cron route passes the REAL readDB / updateDB /
 * pushBookingEvent / deleteBookingEvent / calendarConfigured; tests pass fakes.
 */
export type ReconcileDeps = {
  now: () => Date;
  read: () => DB;
  update: <T>(mutator: (db: DB) => T) => Promise<T>;
  push: (booking: Booking, slotMinutes: number, adminUrl: string) => Promise<PushResult>;
  del: (bookingId: string) => Promise<DeleteResult>;
  calendarConfigured: () => boolean;
  /** Deep link used in the event description, e.g. `${base}/admin/bookings`. */
  adminBaseUrl: string;
  /**
   * Two-way availability re-check (AV9-3). When provided, the reconciler re-runs a
   * FreeBusy check for bookings flagged `busyCheck:"skipped-outage"` (booked during a
   * Google outage). Omitted by legacy callers/tests -> the outage sweep is skipped.
   */
  busy?: (
    settings: ReturnType<typeof getBookingSettings>,
    now: Date
  ) => Promise<{ ok: true; ranges: BusyWallRange[] } | { ok: false }>;
};

export type ReconcileResult = {
  ok: true;
  /** True when a previous run was still in flight (single-flight guard). */
  skipped?: boolean;
  /** False when Google is not configured (nothing was attempted). */
  configured?: boolean;
  processed: number;
  pushed: number;
  failed: number;
  abandoned: number;
  tombstonesSwept: number;
  /** AV9-3: how many `skipped-outage` bookings were re-checked against FreeBusy. */
  outageRechecked: number;
  /** AV9-3: how many of those turned out clear and had their marker cleared to "ok". */
  outageCleared: number;
};

// Process-level single-flight lock, pinned on globalThis so HMR / module duplication
// cannot fork it.
function lockState(): { running: boolean } {
  const g = globalThis as typeof globalThis & { __dockaBookingSyncLock?: { running: boolean } };
  if (!g.__dockaBookingSyncLock) g.__dockaBookingSyncLock = { running: false };
  return g.__dockaBookingSyncLock;
}

/** Test-only: force-release the single-flight lock. */
export function __resetBookingSyncLock(): void {
  lockState().running = false;
}

function isPendingSyncState(s: Booking["calendarSync"]): boolean {
  return s === undefined || s === "pending" || s === "failed";
}

/**
 * One reconciler tick. Idempotent + safe to run on any schedule. Returns a summary;
 * NEVER holds the write mutex across a network call. Rethrows only if an injected dep
 * throws (real push/delete never throw) — and even then the lock is released.
 */
export async function reconcileBookingSync(deps: ReconcileDeps): Promise<ReconcileResult> {
  const lock = lockState();
  if (lock.running) {
    return {
      ok: true,
      skipped: true,
      processed: 0,
      pushed: 0,
      failed: 0,
      abandoned: 0,
      tombstonesSwept: 0,
      outageRechecked: 0,
      outageCleared: 0,
    };
  }
  lock.running = true;
  try {
    if (!deps.calendarConfigured()) {
      return {
        ok: true,
        configured: false,
        processed: 0,
        pushed: 0,
        failed: 0,
        abandoned: 0,
        tombstonesSwept: 0,
        outageRechecked: 0,
        outageCleared: 0,
      };
    }

    const now = deps.now();
    const db = deps.read();
    const settings = getBookingSettings(db);

    // ---- Push sweep: pending/failed booked rows, oldest-first, capped (CV6-2) --------
    const pendingBatch = db.bookings
      .filter((b) => b && b.status === "booked" && isPendingSyncState(b.calendarSync))
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, RECONCILE_BATCH);

    let pushed = 0;
    let failed = 0;
    let abandoned = 0;

    for (const b of pendingBatch) {
      // CV6-3 tz fallback for a tz-less ACTIVE booking — never send timeZone:undefined.
      const tz = b.tz || settings.timezone;
      const res = await deps.push({ ...b, tz }, settings.slotMinutes, deps.adminBaseUrl);

      // Stamp under the mutex, re-reading the live row (CV5-3): a booking cancelled
      // between our read and this stamp must not be resurrected as "synced".
      const outcome = await deps.update((store) => {
        const row = store.bookings.find((x) => x.id === b.id);
        if (!row || row.status === "cancelled") return "gone" as const;
        row.syncAttempts = (row.syncAttempts ?? 0) + 1;
        if (!row.tz && tz) row.tz = tz; // persist the fallback so later ticks agree
        if (res.ok) {
          row.googleEventId = res.googleEventId;
          row.calendarSync = "synced";
          return "synced" as const;
        }
        if ((row.syncAttempts ?? 0) >= SYNC_ATTEMPT_CAP) {
          row.calendarSync = "abandoned";
          return "abandoned" as const;
        }
        row.calendarSync = "failed";
        return "failed" as const;
      });

      if (outcome === "synced") pushed++;
      else if (outcome === "abandoned") abandoned++;
      else if (outcome === "failed") failed++;
      // "gone" (cancelled/deleted mid-flight): the tombstone sweep below handles delete.
    }

    // ---- Tombstone sweep (CV6-1): recently-cancelled rows -> re-delete (idempotent) --
    // Bounded by recency + batch. Booking has no cancel timestamp (db.ts unchanged), so
    // `createdAt` is the available recency proxy; compactBookings() also drops cancelled
    // rows on the next booking write, so this set stays small in practice.
    const cutoff = now.getTime() - TOMBSTONE_RECENCY_MS;
    const tombstones = db.bookings
      .filter((b) => {
        if (!b || b.calendarSync !== "cancelled") return false;
        const created = Date.parse(b.createdAt);
        return Number.isFinite(created) && created >= cutoff;
      })
      .slice(0, RECONCILE_BATCH);

    let tombstonesSwept = 0;
    for (const b of tombstones) {
      await deps.del(b.id); // idempotent; 404/410 = success (handled in the module)
      tombstonesSwept++;
    }

    // ---- Outage re-check sweep (AV9-3): re-check fail-open bookings ------------------
    // Bookings booked during a Google outage carry `busyCheck:"skipped-outage"`. Once
    // Google is reachable, re-run FreeBusy for each slot: if it is actually free, clear
    // the marker to "ok"; if it overlaps a real event, LEAVE the badge for manual
    // attention (idempotent, no paging). If Google is still unreachable, stop and leave
    // them for the next tick. Requires the `busy` dep; skipped when absent.
    let outageRechecked = 0;
    let outageCleared = 0;
    if (deps.busy) {
      const flagged = db.bookings
        .filter((b) => b && b.status === "booked" && b.busyCheck === "skipped-outage")
        .slice(0, RECONCILE_BATCH);
      for (const b of flagged) {
        const res = await deps.busy(settings, now);
        if (!res.ok) break; // Google still down -> retry these on a later tick
        const tz = b.tz || settings.timezone;
        const clear =
          excludeBusySlots([{ date: b.date, time: b.time, tz }], res.ranges, settings.slotMinutes)
            .length > 0;
        const cleared = await deps.update((store) => {
          const row = store.bookings.find((x) => x.id === b.id);
          if (!row || row.status !== "booked") return false;
          if (clear) {
            row.busyCheck = "ok";
            return true;
          }
          return false; // overlap -> leave the badge for manual attention
        });
        outageRechecked++;
        if (cleared) outageCleared++;
      }
    }

    return {
      ok: true,
      configured: true,
      processed: pendingBatch.length,
      pushed,
      failed,
      abandoned,
      tombstonesSwept,
      outageRechecked,
      outageCleared,
    };
  } finally {
    lock.running = false;
  }
}
