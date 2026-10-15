// The single outbound-notification channel for docka.
//
// One `send()` abstraction over multiple transports (email via SMTP today; SMS +
// WhatsApp stubbed behind the same interface). Every attempt is RECORDED to the
// `notifications` log in db.json — whether it actually left the box or not — so a
// demo/staging deployment with no SMTP creds still produces an honest, dated
// "would have sent" trail instead of throwing. Features that need to tell a seaman
// or an agent something (expiry reminders, document requests, review outcomes) all
// route through here so there is ONE place that knows how to reach a person.
//
// Config is entirely env-driven (see the ENV block below). Nothing here ever
// throws to the caller: a missing transport, a missing address, or a provider
// error all resolve to a recorded result the caller can inspect.

import { updateDB, id, type NotifyChannel, type NotifyStatus, type NotificationLog } from "@/lib/db";

// ---- Public shapes -----------------------------------------------------

/** Who a notification is going to. Only the field matching the channel is used. */
export type NotifyRecipient = {
  /** Display name, when known. */
  name?: string | null;
  /** Destination for the "email" channel. */
  email?: string | null;
  /** Destination for the "sms" channel. */
  phone?: string | null;
};

export type NotifyInput = {
  channel: NotifyChannel;
  to: NotifyRecipient;
  subject: string;
  /** Plain-text body. Email sends it as text; SMS would send it as the message. */
  message: string;
  /** Optional HTML body for email; falls back to `message` when absent. */
  html?: string;
  /** Caller grouping tag recorded on the log row, e.g. "reminder:renewal". */
  kind?: string;
  /**
   * Optional extra email headers (e.g. List-Unsubscribe). Applied to the SMTP send only;
   * ignored by non-email transports. Callers pass what they need — nothing is added
   * implicitly except the card-link List-Unsubscribe default (see sendEmail).
   */
  headers?: Record<string, string>;
};

export type NotifyResult = {
  ok: boolean;
  channel: NotifyChannel;
  /** True ONLY when a real provider accepted the message. */
  delivered: boolean;
  status: NotifyStatus;
  /** Populated when the message was only logged / failed. */
  reason?: string;
  /** Id of the NotificationLog row written for this attempt. */
  logId: string;
};

// ---- Env config --------------------------------------------------------
//
// Email (SMTP):
//   SMTP_HOST      required to enable email (e.g. "smtp.mailgun.org")
//   SMTP_PORT      default 587
//   SMTP_SECURE    "1"/"true" to use TLS-on-connect (port 465); default false (STARTTLS)
//   SMTP_USER      optional SMTP auth user
//   SMTP_PASS      optional SMTP auth password
//   SMTP_FROM      OPTIONAL From address (e.g. "docka <no-reply@docka.me>"). When unset
//                  the platform sends from DEFAULT_FROM ("hello@trydocka.me"), so email
//                  goes live the moment SMTP_HOST (+ any auth) is set on the box — no
//                  SMTP_FROM needed. The env value, when present, still wins.
//
// SMS (stub — pluggable):
//   SMS_PROVIDER   provider key; only "twilio" is recognised as a stub today
//   (No live SMS transport ships yet — the adapter records + reports "not configured".)

function envFlag(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

// Non-secret DEFAULT sender used when SMTP_FROM is unset. The owner's platform address;
// the env var still overrides it. NEVER a secret — only a From address lives here.
const DEFAULT_FROM = "hello@trydocka.me";

/** The effective From — env override, else the platform default. Always truthy. */
function effectiveFrom(): string {
  const raw = (process.env.SMTP_FROM ?? "").trim();
  return raw.length > 0 ? raw : DEFAULT_FROM;
}

// ---- Transport result (internal) --------------------------------------

type TransportOutcome = {
  delivered: boolean;
  status: NotifyStatus;
  reason?: string;
};

// ---- Email transport (SMTP via nodemailer) ----------------------------

// Cache the transporter across calls within the single Node process. `null` = not
// yet built; `false` = tried and unavailable/unconfigured (don't retry building).
let cachedTransport: unknown | null | false = null;

function emailConfigured(): boolean {
  // Only SMTP_HOST is required now — the From always resolves (env override or the
  // DEFAULT_FROM platform address), so no SMTP_FROM is needed to go live.
  return Boolean(process.env.SMTP_HOST);
}

async function getTransport(): Promise<unknown | null> {
  if (cachedTransport !== null) return cachedTransport === false ? null : cachedTransport;
  if (!emailConfigured()) {
    cachedTransport = false;
    return null;
  }
  try {
    // Lazy import so the build / non-email code paths never load nodemailer, and a
    // box without the package degrades to "logged" instead of crashing on import.
    const mod = (await import("nodemailer")) as unknown as {
      default?: { createTransport: (opts: unknown) => unknown };
      createTransport?: (opts: unknown) => unknown;
    };
    const nodemailer = mod.default ?? mod;
    const createTransport = nodemailer.createTransport?.bind(nodemailer);
    if (!createTransport) {
      cachedTransport = false;
      return null;
    }
    const port = Number(process.env.SMTP_PORT ?? 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const transport = createTransport({
      host: process.env.SMTP_HOST,
      port: Number.isFinite(port) ? port : 587,
      secure: envFlag(process.env.SMTP_SECURE),
      auth: user && pass ? { user, pass } : undefined,
    });
    cachedTransport = transport;
    return transport;
  } catch {
    // Package missing or transport construction failed — treat email as unavailable.
    cachedTransport = false;
    return null;
  }
}

/** Bare address out of an RFC5322 From ("docka <no-reply@docka.me>" -> "no-reply@docka.me"). */
function fromAddress(): string {
  const raw = effectiveFrom();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim();
}

/**
 * Extra SMTP headers for one send. Starts from any caller-supplied `headers`, then adds a
 * List-Unsubscribe DEFAULT for the card-link mail (a `mailto:` to the From/agency contact —
 * there is no one-click endpoint, so NO List-Unsubscribe-Post is emitted). Returns undefined
 * when there is nothing to add, so non-card sends are byte-for-byte unchanged.
 */
function emailHeaders(input: NotifyInput): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.kind === "card-link" && !headers["List-Unsubscribe"]) {
    const addr = fromAddress();
    if (addr) headers["List-Unsubscribe"] = `<mailto:${addr}?subject=unsubscribe>`;
  }
  return Object.keys(headers).length ? headers : undefined;
}

async function sendEmail(input: NotifyInput): Promise<TransportOutcome> {
  const to = input.to.email?.trim();
  if (!to) {
    return { delivered: false, status: "logged", reason: "no email address for recipient" };
  }
  if (!emailConfigured()) {
    return { delivered: false, status: "logged", reason: "email channel not configured (SMTP_HOST unset)" };
  }
  const transport = (await getTransport()) as {
    sendMail: (opts: unknown) => Promise<unknown>;
  } | null;
  if (!transport) {
    return { delivered: false, status: "logged", reason: "email transport unavailable" };
  }
  try {
    await transport.sendMail({
      from: effectiveFrom(),
      to: input.to.name ? `${input.to.name} <${to}>` : to,
      subject: input.subject,
      text: input.message,
      html: input.html ?? undefined,
      headers: emailHeaders(input),
    });
    return { delivered: true, status: "sent" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : "SMTP send failed";
    return { delivered: false, status: "failed", reason };
  }
}

// ---- SMS transport (pluggable stub) -----------------------------------
//
// The SMS/WhatsApp transports are stubbed behind the same interface so items that
// depend on this channel can already target `channel: "sms"`. Wiring a real
// provider (Twilio / MessageBird) means implementing one function here; the rest of
// the app never changes. Until then every SMS attempt is recorded + reported as
// "not configured".

async function sendSms(input: NotifyInput): Promise<TransportOutcome> {
  const to = input.to.phone?.trim();
  if (!to) {
    return { delivered: false, status: "logged", reason: "no phone number for recipient" };
  }
  const provider = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    return { delivered: false, status: "logged", reason: "SMS channel not configured (SMS_PROVIDER unset)" };
  }
  // No live SMS transport ships yet — recognised provider, but stubbed.
  return {
    delivered: false,
    status: "logged",
    reason: `SMS provider "${provider}" not yet implemented (stub)`,
  };
}

// ---- Public API --------------------------------------------------------

function preview(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? oneLine.slice(0, 197) + "..." : oneLine;
}

function addressFor(input: NotifyInput): string {
  return (input.channel === "sms" ? input.to.phone : input.to.email)?.trim() ?? "";
}

/**
 * Send one notification over the given channel and RECORD the attempt.
 *
 * Never throws: an unconfigured channel, a missing address, or a provider error
 * all resolve to a recorded {@link NotifyResult} (status "logged" / "failed").
 * The `notifications` log row is written for every call, so "we tried to tell
 * them" is always durable even on a box with no SMTP creds.
 */
export async function send(input: NotifyInput): Promise<NotifyResult> {
  let outcome: TransportOutcome;
  try {
    outcome = input.channel === "email" ? await sendEmail(input) : await sendSms(input);
  } catch (e) {
    // Defensive: an adapter should already be total, but never let it escape.
    outcome = {
      delivered: false,
      status: "failed",
      reason: e instanceof Error ? e.message : "unexpected notify error",
    };
  }

  const row: NotificationLog = {
    id: id(),
    at: new Date().toISOString(),
    channel: input.channel,
    to: addressFor(input),
    toName: input.to.name ?? null,
    subject: input.subject,
    preview: preview(input.message),
    status: outcome.status,
    reason: outcome.reason ?? null,
    kind: input.kind ?? null,
  };
  await updateDB((db) => {
    db.notifications.push(row);
  });

  return {
    ok: outcome.status !== "failed",
    channel: input.channel,
    delivered: outcome.delivered,
    status: outcome.status,
    reason: outcome.reason,
    logId: row.id,
  };
}

/** True when at least one live outbound transport is configured (email today). */
export function channelConfigured(channel: NotifyChannel): boolean {
  if (channel === "email") return emailConfigured();
  return Boolean(process.env.SMS_PROVIDER?.trim());
}
