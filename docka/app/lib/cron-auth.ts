// lib/cron-auth.ts — the ONE shared-secret gate for every cron endpoint.
//
// Extracted (fix-plan F1/C1) because the identical check was written twice: once in
// lib/billing-cron.ts and once, hand-copied, in app/api/cron/reminders/route.ts. Two
// copies of an auth predicate is one copy too many — a hardening applied to one would
// silently miss the other.
//
// FAIL-CLOSED IN PRODUCTION: with no CRON_SECRET configured this returns false in
// production, so a real deployment is never left with an open, unauthenticated cron
// endpoint. Outside production it runs freely for local convenience.
//
// The `?secret=` variant is MANUAL-TESTING ONLY (R1-10d) — the crontab always uses the
// Bearer header so the secret never lands in a URL, a log line or a referer.

export function cronAuthorized(input: {
  authorization: string | null;
  secretParam: string | null;
  env?: { CRON_SECRET?: string; NODE_ENV?: string };
}): boolean {
  const env = input.env ?? process.env;
  const secret = env.CRON_SECRET;
  const header = input.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || (input.secretParam ?? "");
  if (secret) return provided === secret;
  return env.NODE_ENV !== "production";
}
