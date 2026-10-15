import { NextRequest, NextResponse } from "next/server";
import { readDB, type Doc, type Seafarer } from "@/lib/db";
import { auth } from "@/auth";
import { evaluateShareAccess } from "@/lib/share-access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleTokenRateLimited,
  SAMPLE_CACHE_CONTROL,
} from "@/lib/sample-guard";
import {
  computeReminderDates,
  docHasReminderExpiry,
  icsDate,
  settingsFromSeafarer,
} from "@/lib/reminders-calendar";

export const dynamic = "force-dynamic";

// GET /api/calendar?token=<owner share token>
//
// Owner-scoped calendar export of document-expiry reminders as a downloadable
// iCalendar (.ics) file. Authorisation is by POSSESSION of the seaman's OWN share
// token — the SAME trust model as /api/files:
//   - matched Seafarer.openShareToken  -> serve (the token alone authorises).
//   - matched Seafarer.emailShareToken -> RESTRICTED: only a signed-in Google viewer
//     on the allow-list, OR the owner's own seaman session, gets the calendar.
//   - no / wrong / foreign token -> 404, revealing nothing (no titles, no dates).
//
// The route resolves NEITHER the agent-session role gate NOR the seaman-session role
// gate — it is a possession-token export exactly like the /api/files token branch —
// so it is outside the agent/seaman isolation guards by construction.

// iCalendar text escaping: backslash, semicolon, comma, and newline per RFC 5545.
function escICS(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold a content line to <=75 octets with CRLF + single-space continuation (RFC 5545).
// Folds on character boundaries; ASCII output here keeps octets == chars.
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

function humanDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// A single deterministic DTSTAMP for the whole file. Using a fixed, content-derived
// stamp (rather than "now") keeps re-exports byte-stable so a re-import updates the
// same events instead of churning them.
const DTSTAMP = "20200101T000000Z";

function buildCalendar(seafarer: Seafarer, docs: Doc[]): { text: string; events: number; documents: number } {
  const settings = settingsFromSeafarer(seafarer);
  const now = new Date();

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Docka//Expiry Reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${escICS(`Document expiry reminders — ${seafarer.name}`)}`),
  ];

  let events = 0;
  let documentsWithReminders = 0;

  // PER DOCUMENT: each document's OWN expiry drives its OWN schedule + its OWN events,
  // each event clearly naming that document.
  for (const doc of docs) {
    if (!docHasReminderExpiry(doc)) continue;
    const dates = computeReminderDates(doc.validUntil, settings, now);
    if (dates.length === 0) continue;
    documentsWithReminders += 1;

    const expiryHuman = humanDate(doc.validUntil);
    const summary = `Renew: ${doc.title} — expires ${expiryHuman}`;
    const description =
      `Your document "${doc.title}" expires ${expiryHuman}. ` +
      `Renew it before then and upload the new one to Docka. ` +
      `This reminder is one of ${dates.length} for this document.`;

    for (const date of dates) {
      const day = icsDate(date); // reminder day (YYYYMMDD)
      const endDay = icsDate(new Date(date.getTime() + 86_400_000)); // all-day DTEND is exclusive
      // Deterministic, stable UID per (document, reminder day) so a re-import UPDATES
      // the same event rather than creating a duplicate.
      const uid = `docka-${doc.id}-${day}@docka.me`;
      lines.push(
        "BEGIN:VEVENT",
        foldLine(`UID:${uid}`),
        `DTSTAMP:${DTSTAMP}`,
        `DTSTART;VALUE=DATE:${day}`,
        `DTEND;VALUE=DATE:${endDay}`,
        foldLine(`SUMMARY:${escICS(summary)}`),
        foldLine(`DESCRIPTION:${escICS(description)}`),
        "TRANSP:TRANSPARENT",
        "END:VEVENT"
      );
      events += 1;
    }
  }

  lines.push("END:VCALENDAR");
  return { text: lines.join("\r\n") + "\r\n", events, documents: documentsWithReminders };
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get("token") ?? "").trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const db = readDB();
  // CHOKEPOINT: open + gated email (PHASE0-CENSUS row 5). Sample subjects export a
  // CURATED (sample:true) calendar only, rate-limited + publicly cacheable.
  const subject = resolveTokenSubject(db, token, "read", ["open", "email"]);
  if (subject === null || subject === SAMPLE_WRITE_DENIED) {
    // No / wrong / foreign token — reveal nothing.
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const owner = subject.seafarer;
  if (subject.isSample && sampleTokenRateLimited(token)) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  // PRIVATE (email) token: the token alone is NOT sufficient — same rule as the share
  // page and /api/files. Serve only to a signed-in allow-listed viewer, or the owner's
  // own seaman session. Anything else 404s.
  if (subject.mode === "email") {
    const gate = await evaluateShareAccess(owner, "email");
    let ok = gate.allowed;
    if (!ok) {
      const session = await auth();
      if (session?.role === "seaman" && session.seafarerId === owner.id) ok = true;
    }
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
  }

  const docs = subject.filterRows(db.documents.filter((d) => d.seafarerId === owner.id));
  const { text } = buildCalendar(owner, docs);

  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="docka-reminders.ics"',
      "Cache-Control": subject.isSample ? SAMPLE_CACHE_CONTROL : "no-store",
    },
  });
}
