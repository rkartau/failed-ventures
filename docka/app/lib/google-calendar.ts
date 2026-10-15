// "Book a call" — the self-contained Google Calendar sync module.
//
// Wave-2 of the booking feature (docka-booking-plan.md PLAN v4/v5/v6, CV5-1…9 +
// CV6-1…5). This module owns EVERYTHING about talking to Google Calendar and NOTHING
// about the JSON store: the booking API + admin routes + cron reconciler (later waves)
// call the exported functions, decide when, and stamp the result under their own
// `updateDB` mutex. No `fs`, no `readDB` here.
//
// AUTH (CV5-1): access tokens are minted by `google-auth-library`'s JWT client (it
// handles PEM parsing, token caching, an expiry margin, and clock skew). We keep ONLY
// a thin `fetch` wrapper for the REST v3 calls so tests can mock the network while the
// token/key builder stays real (unmocked).
//
// TIMEZONE (CV5-4 / v4 C4): the event carries the booking's wall-clock + IANA
// `timeZone`; Google resolves the exact UTC instant DST-correctly. We NEVER compute
// the instant ourselves and NEVER emit `timeZone: undefined`.
//
// IDEMPOTENCY (CV5-2): the event id is DERIVED from `booking.id` (`eventIdFor`) at
// every create/delete — the stored `googleEventId` is pure telemetry. A retry re-POSTs
// the same id (Google 409 = success); a cancel can delete a ghost event whose id was
// never persisted (Google 404/410 = success).
//
// SECRETS: `GOOGLE_SA_PRIVATE_KEY` is a high-value secret — never logged, never echoed.
// `redact()` scrubs it from any error string before it leaves this module.

import { JWT } from "google-auth-library";
import type { Booking, BookingSettings } from "@/lib/db";
import { businessNowParts } from "@/lib/booking";

// ---- Config / secrets -------------------------------------------------

/** The single OAuth scope the service account needs to write calendar events. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

/** Google Calendar REST v3 base. */
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/** Retry policy (CV5-7): capped attempts for 5xx / 429, exponential backoff + jitter. */
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;

/**
 * True iff all three service-account / calendar secrets are present. Mirrors
 * `emailConfigured()` in lib/notify.ts. When false the caller (booking API / cron)
 * skips the push and leaves the booking `calendarSync: "pending"` — the feature
 * activates automatically once the owner sets the env vars on the box.
 */
export function calendarConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SA_CLIENT_EMAIL &&
      process.env.GOOGLE_SA_PRIVATE_KEY &&
      process.env.GOOGLE_CALENDAR_ID
  );
}

/**
 * Env vars deliver a PEM's newlines as the literal two-character sequence `\n`.
 * Restore real newlines before handing the key to the JWT client (CV5-1). Pure —
 * unit-tested UNMOCKED.
 */
export function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

/** Strip the private key out of any string before it can be logged / returned. */
function redact(msg: unknown): string {
  let s = msg instanceof Error ? msg.message : String(msg ?? "");
  const key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (key) {
    // Guard against both the raw (escaped-\n) and normalized (real newline) forms.
    if (s.includes(key)) s = s.split(key).join("[REDACTED_PRIVATE_KEY]");
    const norm = normalizePrivateKey(key);
    if (norm !== key && s.includes(norm)) s = s.split(norm).join("[REDACTED_PRIVATE_KEY]");
  }
  return s;
}

// ---- Access token (unmocked builder, cached by the library) -----------

/**
 * Construct a `google-auth-library` JWT client for the given service-account
 * identity. The key MUST already be newline-normalized (`normalizePrivateKey`).
 * Exported so the unmocked token-builder test can assert construction never throws
 * and the config is one the JWT client accepts — WITHOUT hitting the network.
 */
export function buildJwtClient(clientEmail: string, privateKey: string): JWT {
  return new JWT({ email: clientEmail, key: privateKey, scopes: [CALENDAR_SCOPE] });
}

// Cached client for the process lifetime; the library caches the token itself and
// refreshes with an expiry margin. `null` = not built yet.
let cachedJwt: JWT | null = null;

function getJwtClient(): JWT {
  if (cachedJwt) return cachedJwt;
  const email = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("Google Calendar not configured (service-account env vars unset)");
  }
  cachedJwt = buildJwtClient(email, normalizePrivateKey(rawKey));
  return cachedJwt;
}

/**
 * Return a bearer access token for the Calendar API. The library caches the token
 * until ~expiry, so most calls are cheap. Pass `forceRefresh` after a 401 to drop
 * the cached client and mint a fresh token exactly once (see the single-retry loop
 * in `requestWithRetry`).
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) cachedJwt = null;
  const client = getJwtClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res?.token;
  if (!token) throw new Error("failed to obtain Google access token");
  return token;
}

// ---- Pure wall-clock + id helpers -------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" + whole days -> "YYYY-MM-DD" (UTC calendar arithmetic; DST-free). */
function addDays(dateStr: string, days: number): string {
  const [y, mo, d] = dateStr.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * Deterministic, collision-free Google event id for a booking (CV5-2 / CV6-5).
 * Google event ids allow base32hex chars — lowercase `a–v` and digits `0–9`, 5–1024
 * chars. A UUID's hex (0-9a-f, hyphens stripped) is a valid subset. We lowercase and
 * drop any out-of-charset char, so an UPPERCASE uuid maps to the SAME id as its
 * lowercase form (create id == delete id parity). Idempotent.
 */
export function eventIdFor(bookingId: string): string {
  return String(bookingId).toLowerCase().replace(/[^a-v0-9]/g, "");
}

/**
 * Add `minutes` to a wall-clock `{date,time}` with proper minute -> hour -> day carry
 * (CV5-5). Never emits `24:30` or `16:90`. The 06:00–20:00 booking window means the
 * day carry is unreachable in practice, but it is handled + tested for safety.
 * Pure — no timezone, no Date epoch of the wall-clock (only date-only calendar math).
 */
export function addMinutesToWallClock(
  date: string,
  time: string,
  minutes: number
): { date: string; time: string } {
  const [h, m] = time.split(":").map((x) => Number(x));
  const total = h * 60 + m + minutes;
  const dayCarry = Math.floor(total / 1440);
  const minsInDay = ((total % 1440) + 1440) % 1440;
  const outTime = `${pad2(Math.floor(minsInDay / 60))}:${pad2(minsInDay % 60)}`;
  const outDate = dayCarry === 0 ? date : addDays(date, dayCarry);
  return { date: outDate, time: outTime };
}

// ---- Event payload (CV5-8 PII minimization) ---------------------------

/** The subset of a Google Calendar v3 event we send. Client-set `id` = idempotency. */
export type GoogleEvent = {
  /** Client-set deterministic id (`eventIdFor`). Present => idempotent create. */
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
};

/**
 * Thrown by `buildEventPayload` when a booking carries no `tz`. Callers catch this
 * and flag the booking `failed` (NEVER send an event with `timeZone: undefined`,
 * which would silently land it in the calendar's default zone — CV5-4).
 */
export class MissingTimezoneError extends Error {
  constructor(bookingId: string) {
    super(`booking ${bookingId} has no tz; refusing to send event without a timeZone`);
    this.name = "MissingTimezoneError";
  }
}

/**
 * Build the PII-minimized event payload for a booking (CV5-8):
 *  - `summary`: `Call: {name}` (+ ` — {company}` when present).
 *  - `description`: booker email + a deep link back to the docka admin booking +
 *    the source. NO phone, NO free-text note (those stay in db.json only).
 *  - `start`/`end`: the booking wall-clock + the booking's OWN `timeZone` (never
 *    re-read from settings), end = start + `slotMinutes` via wall-clock carry.
 * Throws `MissingTimezoneError` if `booking.tz` is falsy.
 */
export function buildEventPayload(
  booking: Booking,
  slotMinutes: number,
  adminUrl: string
): GoogleEvent {
  if (!booking.tz) throw new MissingTimezoneError(booking.id);

  const summary = booking.company
    ? `Call: ${booking.name} — ${booking.company}`
    : `Call: ${booking.name}`;

  const description = [
    booking.email,
    `Full details in docka: ${adminUrl}`,
    `Source: ${booking.source}`,
  ].join("\n");

  const end = addMinutesToWallClock(booking.date, booking.time, slotMinutes);

  return {
    id: eventIdFor(booking.id),
    summary,
    description,
    start: { dateTime: `${booking.date}T${booking.time}:00`, timeZone: booking.tz },
    end: { dateTime: `${end.date}T${end.time}:00`, timeZone: booking.tz },
  };
}

// ---- Injectable deps + retry/backoff (testable) -----------------------

/**
 * Injectable seams so tests can mock the network + token + sleep while leaving the
 * real key/token builder unmocked. Wave 3 calls the push/delete functions with NO
 * deps arg — the defaults use the real `fetch`, `getAccessToken`, and a real sleep.
 */
export type CalendarDeps = {
  fetchImpl: (url: string, init: RequestInit) => Promise<CalendarResponse>;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
};

/** The minimal shape `requestWithRetry` reads off a fetch Response (mock-friendly). */
export type CalendarResponse = {
  status: number;
  headers: { get(name: string): string | null };
};

function defaultDeps(): CalendarDeps {
  return {
    fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<CalendarResponse>,
    getToken: (forceRefresh) => getAccessToken(forceRefresh),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Parse a `Retry-After` header (delta-seconds only) to ms; 0 if absent/invalid. */
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const secs = Number(header.trim());
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

/**
 * Delay before the next retry (CV5-7 / CV6-5). `Retry-After` wins when present;
 * otherwise exponential backoff (500ms, 1s, 2s, …) plus a DETERMINISTIC jitter
 * derived from the attempt index — no `Math.random`, so tests are reproducible.
 * Exported for direct unit testing.
 */
export function backoffDelayMs(attempt: number, retryAfterHeaderMs = 0): number {
  if (retryAfterHeaderMs > 0) return retryAfterHeaderMs;
  const base = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = (attempt * 137) % 250; // deterministic, no rng
  return base + jitter;
}

/**
 * Issue one authorized Calendar request, retrying 5xx/429 with capped attempts +
 * backoff (honoring `Retry-After`), and refreshing the token exactly once on a 401.
 * Never loops unboundedly. Returns the final response; the caller maps status codes
 * to a result (409/404/410 success cases live in push/delete).
 */
async function requestWithRetry(
  deps: CalendarDeps,
  url: string,
  init: RequestInit
): Promise<CalendarResponse> {
  let authRetried = false;
  for (let attempt = 1; ; attempt++) {
    const token = await deps.getToken();
    const res = await deps.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });

    // 401: refresh the token once, retry once (no loop).
    if (res.status === 401 && !authRetried) {
      authRetried = true;
      await deps.getToken(true);
      continue;
    }

    // Retryable transient failures: backoff while attempts remain.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await deps.sleep(backoffDelayMs(attempt, retryAfterMs(res.headers.get("retry-after"))));
      continue;
    }

    return res;
  }
}

/** URL of the events collection on the configured shared calendar. */
function eventsUrl(): string {
  const calId = process.env.GOOGLE_CALENDAR_ID ?? "";
  return `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calId)}/events`;
}

// ---- Public sync operations (Wave 3 calls these) ----------------------

/** Result of a create/upsert push. Never thrown — always returned. */
export type PushResult =
  | { ok: true; googleEventId: string }
  | { ok: false; error: string; terminal?: boolean };

/**
 * Create (idempotent upsert) the calendar event for a booking (CV5-2). Uses the
 * derived event id, so a retry re-POSTs the SAME id and Google 409 (duplicate) is
 * treated as SUCCESS. Retries 5xx/429 with capped backoff. A non-retryable 4xx
 * returns `{ ok:false, terminal:true }`; an exhausted-retry 5xx/429 returns
 * `{ ok:false, terminal:false }` (the reconciler may try again later). A missing
 * `booking.tz` is `{ ok:false, terminal:false }` (never sends an undefined tz).
 * NEVER throws across the caller boundary.
 */
export async function pushBookingEvent(
  booking: Booking,
  slotMinutes: number,
  adminUrl: string,
  deps: CalendarDeps = defaultDeps()
): Promise<PushResult> {
  let payload: GoogleEvent;
  try {
    payload = buildEventPayload(booking, slotMinutes, adminUrl);
  } catch (e) {
    // Missing tz (or any payload defect): flag failed, do not send. Not terminal —
    // Wave 3's CV6-3 tz-fallback may repair an active booking on a later tick.
    return { ok: false, error: redact(e), terminal: false };
  }

  try {
    const res = await requestWithRetry(deps, eventsUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (isOk(res.status) || res.status === 409) {
      return { ok: true, googleEventId: payload.id };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, error: `Google Calendar insert failed: ${res.status}`, terminal: false };
    }
    return { ok: false, error: `Google Calendar insert failed: ${res.status}`, terminal: true };
  } catch (e) {
    return { ok: false, error: redact(e), terminal: false };
  }
}

/** Result of a delete. Never thrown — always returned. */
export type DeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Delete a booking's calendar event by its DERIVED id (CV5-2 / CV5-3) — NEVER by any
 * stored `googleEventId`, so a ghost event (created but never stamped) is still
 * removable. Google 404 AND 410 (already gone) are treated as SUCCESS. Retries
 * 5xx/429 with the same capped backoff. NEVER throws across the caller boundary.
 */
export async function deleteBookingEvent(
  bookingId: string,
  deps: CalendarDeps = defaultDeps()
): Promise<DeleteResult> {
  const url = `${eventsUrl()}/${eventIdFor(bookingId)}`;
  try {
    const res = await requestWithRetry(deps, url, { method: "DELETE" });
    if (isOk(res.status) || res.status === 404 || res.status === 410) return { ok: true };
    return { ok: false, error: `Google Calendar delete failed: ${res.status}` };
  } catch (e) {
    return { ok: false, error: redact(e) };
  }
}

// =====================================================================
// TWO-WAY AVAILABILITY — FreeBusy read + busy cache (PLAN v7/v8/v9)
// =====================================================================
//
// Reads busy intervals from the ONE shared calendar (GOOGLE_CALENDAR_ID) via the
// FreeBusy API and converts them to business-tz wall-clock ranges the /book slot
// filter compares against. Google is the source of truth for "busy"; docka for
// creating new bookings.
//
// SINGLE-PROCESS NOTE (AV9-6): the busy cache + single-flight below AND the booking
// write-mutex ALL assume ONE Node process (docka's single Hetzner box + boot guard).
// Horizontal scaling / PM2 cluster would break the cache bound AND slot uniqueness —
// a deliberate revisit trigger, called out so nobody scales out without a redesign.

/** FreeBusy REST v3 endpoint. */
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

/** Render/GET path FreeBusy hard timeout (AV8-2). */
const FREEBUSY_RENDER_TIMEOUT_MS = 5_000;
/** POST hot-path FreeBusy hard deadline (AV9-1): one attempt, no multi-retry. */
const FREEBUSY_POST_TIMEOUT_MS = 3_000;

/** Busy cache TTL (v7): N public visitors trigger <=1 Google call/min. */
const BUSY_TTL_MS = 60_000;
/** Max staleness for serve-stale-on-error (AV9-2): past this, stop trusting last-good. */
const BUSY_MAX_STALE_MS = 15 * 60_000;

/** A busy interval as returned by FreeBusy (RFC3339 UTC instants). */
export type BusyIntervalUtc = { startUtc: string; endUtc: string };

/** A busy interval mapped to business-tz wall-clock, as sortable `YYYY-MM-DDTHH:MM`. */
export type BusyWallRange = { startWall: string; endWall: string };

/** The minimal Response shape the FreeBusy reader needs (mock-friendly: adds json()). */
export type FreeBusyResponse = {
  status: number;
  json: () => Promise<unknown>;
};

/**
 * Injectable seams for the FreeBusy read (tests mock the network + token while the
 * real key/token builder stays unmocked). `timeoutMs` overrides the hard fetch
 * deadline (render 5s vs POST 3s vs a tiny value in tests).
 */
export type FreeBusyDeps = {
  fetchImpl: (url: string, init: RequestInit) => Promise<FreeBusyResponse>;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  timeoutMs?: number;
};

function defaultFreeBusyDeps(): FreeBusyDeps {
  return {
    fetchImpl: (url, init) => fetch(url, init) as unknown as Promise<FreeBusyResponse>,
    getToken: (forceRefresh) => getAccessToken(forceRefresh),
  };
}

// Test-only override of the deps the cache functions use when their caller passes none
// (the production routes call getBusyWallRangesFor*() with no deps). Pinned on
// globalThis so a test can drive the REAL route handlers with a mocked FreeBusy +
// token, deterministically and without a network. `null` = use the real deps.
function depsOverrideState(): { deps: FreeBusyDeps | null } {
  const g = globalThis as typeof globalThis & { __dockaBusyDeps?: { deps: FreeBusyDeps | null } };
  if (!g.__dockaBusyDeps) g.__dockaBusyDeps = { deps: null };
  return g.__dockaBusyDeps;
}

/** Test-only: force the FreeBusy deps every no-deps caller resolves to (null = real). */
export function __setBusyDeps(deps: FreeBusyDeps | null): void {
  depsOverrideState().deps = deps;
}

function resolveFreeBusyDeps(deps?: FreeBusyDeps): FreeBusyDeps {
  return deps ?? depsOverrideState().deps ?? defaultFreeBusyDeps();
}

/**
 * Race a promise against a hard timeout, aborting the underlying fetch (AbortController)
 * when the timer wins. Crucially the timeout rejects even if the fetch NEVER resolves
 * (a socket that opens but never answers) — so /book render / POST never hang.
 */
function withHardTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("FreeBusy request timed out"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * ONE FreeBusy read over the shared calendar (AV8-3 STRICT parse). Authoritative
 * ONLY when: HTTP 2xx AND `calendars[id].busy` is an array AND `calendars[id].errors`
 * is absent — an explicit empty `busy:[]` (no errors) legitimately means "nothing
 * busy". ANY other shape (non-2xx, missing busy, present errors, missing calendar
 * key) THROWS so the caller fail-softs to last-good instead of hiding nothing forever.
 * A hard AbortController timeout guards a never-responding socket. Single attempt —
 * no multi-retry (the serve-stale cache and the POST deadline bound transient blips).
 */
export async function getBusyIntervals(
  timeMinISO: string,
  timeMaxISO: string,
  deps: FreeBusyDeps = defaultFreeBusyDeps()
): Promise<BusyIntervalUtc[]> {
  const calId = process.env.GOOGLE_CALENDAR_ID ?? "";
  const token = await deps.getToken();
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? FREEBUSY_RENDER_TIMEOUT_MS;

  const res = await withHardTimeout(
    deps.fetchImpl(FREEBUSY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: calId }] }),
      signal: controller.signal,
    }),
    timeoutMs,
    controller
  );

  if (!isOk(res.status)) {
    throw new Error(`FreeBusy failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: unknown; errors?: unknown }>;
  };
  const cal = data?.calendars?.[calId];
  // AV8-3: 200-with-errors (or missing busy / missing calendar) != "nothing busy".
  if (!cal || cal.errors !== undefined || !Array.isArray(cal.busy)) {
    throw new Error("FreeBusy response not authoritative (errors present or busy missing)");
  }
  const out: BusyIntervalUtc[] = [];
  for (const b of cal.busy as Array<{ start?: unknown; end?: unknown }>) {
    if (b && typeof b.start === "string" && typeof b.end === "string") {
      out.push({ startUtc: b.start, endUtc: b.end });
    }
  }
  return out;
}

// ---- UTC<->business-tz-wall helpers (window build + interval mapping) ----

/** Minutes to ADD to UTC to reach `tz` wall time at instant `at` (DST-correct). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  let hh = m.hour;
  if (hh === "24") hh = "00";
  const localAsUtc = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(hh),
    Number(m.minute),
    Number(m.second)
  );
  return Math.round((localAsUtc - at.getTime()) / 60_000);
}

/** A business-tz wall-clock midnight (`dateStr` 00:00) as a UTC RFC3339 instant. */
function wallMidnightToUtcISO(tz: string, dateStr: string): string {
  const [y, mo, d] = dateStr.split("-").map((x) => Number(x));
  const asUtc = Date.UTC(y, mo - 1, d, 0, 0, 0); // treat the wall time as if it were UTC
  const off = tzOffsetMinutes(tz, new Date(asUtc)); // offset near that instant
  return new Date(asUtc - off * 60_000).toISOString();
}

/** Map a busy UTC instant to a sortable business-tz wall timestamp `YYYY-MM-DDTHH:MM`. */
function utcToWallTimestamp(tz: string, iso: string): string {
  const p = businessNowParts(tz, new Date(iso));
  return `${p.date}T${p.time}`;
}

/**
 * FreeBusy query window (AV8-4): timeMin = start-of-today (business tz) -> UTC;
 * timeMax = start-of-day of (today + horizonDays + 1) (business tz) -> UTC, so a busy
 * event late on the LAST horizon day is returned and its slot excluded.
 */
function busyWindow(settings: BookingSettings, now: Date): { timeMin: string; timeMax: string } {
  const tz = settings.timezone;
  const today = businessNowParts(tz, now).date; // YYYY-MM-DD in business tz
  const endDate = addDays(today, (settings.horizonDays ?? 0) + 1);
  return {
    timeMin: wallMidnightToUtcISO(tz, today),
    timeMax: wallMidnightToUtcISO(tz, endDate),
  };
}

function toWallRanges(settings: BookingSettings, intervals: BusyIntervalUtc[]): BusyWallRange[] {
  return intervals.map((iv) => ({
    startWall: utcToWallTimestamp(settings.timezone, iv.startUtc),
    endWall: utcToWallTimestamp(settings.timezone, iv.endUtc),
  }));
}

// ---- globalThis-pinned busy cache + single-flight (AV8-2) ----

type BusyCache = { fetchedAt: number; ranges: BusyWallRange[] };

type BusyCacheState = {
  cache: BusyCache | null;
  inflight: Promise<BusyWallRange[]> | null;
};

function busyCacheState(): BusyCacheState {
  const g = globalThis as typeof globalThis & { __dockaBusyCache?: BusyCacheState };
  if (!g.__dockaBusyCache) g.__dockaBusyCache = { cache: null, inflight: null };
  return g.__dockaBusyCache;
}

/** Test-only: clear the busy cache + any in-flight refresh. */
export function __resetBusyCache(): void {
  const s = busyCacheState();
  s.cache = null;
  s.inflight = null;
}

/**
 * Single-flight refresh: N concurrent callers dedupe onto ONE FreeBusy fetch. The cache
 * is written ONLY on success; `inflight` is always cleared in `.finally()` so a rejected
 * fetch can NEVER poison later reads (reject-then-success re-fetches, no wedge, AV8-2).
 */
function refreshBusy(settings: BookingSettings, now: Date, deps?: FreeBusyDeps): Promise<BusyWallRange[]> {
  const state = busyCacheState();
  if (state.inflight) return state.inflight;
  const { timeMin, timeMax } = busyWindow(settings, now);
  const p = getBusyIntervals(timeMin, timeMax, resolveFreeBusyDeps(deps))
    .then((intervals) => {
      const ranges = toWallRanges(settings, intervals);
      busyCacheState().cache = { fetchedAt: now.getTime(), ranges };
      return ranges;
    })
    .finally(() => {
      busyCacheState().inflight = null;
    });
  state.inflight = p;
  return p;
}

/**
 * RENDER/GET path (AV8-1 fail-soft, AV8-6 serve-stale, AV9-2 max-staleness). NEVER throws.
 *  - Fresh cache within TTL -> serve it (stale:false).
 *  - Else refresh (single-flight). Success -> serve fresh (stale:false).
 *  - Refresh error + last-good within the max-staleness cap -> serve stale ranges
 *    (still filtering; no banner; stale:false).
 *  - Refresh error + no last-good (or past the cap) -> `{ ranges: [], stale: true }`
 *    (unfiltered slots + a soft "availability may be approximate" note).
 */
export async function getBusyWallRangesForRender(
  settings: BookingSettings,
  now: Date,
  deps?: FreeBusyDeps
): Promise<{ ranges: BusyWallRange[]; stale: boolean }> {
  const state = busyCacheState();
  const nowMs = now.getTime();
  if (state.cache && nowMs - state.cache.fetchedAt < BUSY_TTL_MS) {
    return { ranges: state.cache.ranges, stale: false };
  }
  try {
    const ranges = await refreshBusy(settings, now, deps);
    return { ranges, stale: false };
  } catch {
    const cache = busyCacheState().cache;
    if (cache && nowMs - cache.fetchedAt <= BUSY_MAX_STALE_MS) {
      return { ranges: cache.ranges, stale: false }; // serve-stale within cap
    }
    return { ranges: [], stale: true }; // cold / past-cap -> unfiltered + banner
  }
}

/**
 * POST hot path (AV9-1). Bounded latency, authoritative gate:
 *  - Warm+fresh cache (within TTL) -> use it, `{ ok:true, ranges }`.
 *  - Else ONE FreeBusy attempt with a HARD ~3s deadline (no multi-retry, does NOT join
 *    the render single-flight so it can't inherit a longer deadline). Success warms the
 *    cache and returns `{ ok:true, ranges }`; failure/timeout -> `{ ok:false }` (the
 *    caller fail-opens + flags the booking for reconciliation).
 */
export async function getBusyWallRangesForBooking(
  settings: BookingSettings,
  now: Date,
  deps?: FreeBusyDeps
): Promise<{ ok: true; ranges: BusyWallRange[] } | { ok: false }> {
  const state = busyCacheState();
  const nowMs = now.getTime();
  if (state.cache && nowMs - state.cache.fetchedAt < BUSY_TTL_MS) {
    return { ok: true, ranges: state.cache.ranges };
  }
  try {
    const base = resolveFreeBusyDeps(deps);
    const bounded: FreeBusyDeps = { ...base, timeoutMs: base.timeoutMs ?? FREEBUSY_POST_TIMEOUT_MS };
    const { timeMin, timeMax } = busyWindow(settings, now);
    const intervals = await getBusyIntervals(timeMin, timeMax, bounded);
    const ranges = toWallRanges(settings, intervals);
    busyCacheState().cache = { fetchedAt: now.getTime(), ranges }; // warm for later renders
    return { ok: true, ranges };
  } catch {
    return { ok: false };
  }
}
