import { NextRequest, NextResponse } from "next/server";
import { trackingSecretConfigured, verifyTrackingToken } from "@/lib/tracking-token";
import { appendEvent, OutreachEventsError } from "@/lib/outreach-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // needs node:crypto + fs (appendEvent)

// SYSTEM route — one-click unsubscribe (plan §2 B4, §4). The compliance-critical
// path. NOT agent- or seaman-scoped.
//
//   POST /u/<token>  — RFC 8058 one-click (List-Unsubscribe-Post). Records the
//                      unsub and returns 200. Idempotent: a repeat POST writes a
//                      second row with the SAME event_key, folded to ONE
//                      suppression downstream — no error, no double effect.
//   GET  /u/<token>  — a human CONFIRM page. It does NOT record on GET (mail
//                      security scanners and link prefetchers issue GETs; a GET
//                      that unsubscribed would fire false unsubs). It shows a
//                      one-button form that POSTs back to the same URL.
//
// FAIL-CLOSED: with TRACKING_HMAC_SECRET unset → 503 on both verbs (mirrors the
// Stripe webhook route). A forged/tampered token → 400 (POST) / error page (GET).

function notConfigured(): NextResponse {
  return NextResponse.json({ ok: false, error: "tracking not configured" }, { status: 503 });
}

function htmlPage(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a;line-height:1.5}
  h1{font-size:1.4rem;margin:0 0 .75rem}
  p{margin:0 0 1rem;color:#444}
  button{font:inherit;padding:.65rem 1.2rem;border:0;border-radius:.5rem;background:#0b5;color:#fff;cursor:pointer}
  button:hover{background:#0a4}
</style></head><body>${body}</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function recordUnsub(token: string): Promise<{ ok: true } | { ok: false; status: number }> {
  const verified = verifyTrackingToken(token, "unsub");
  if (!verified.ok) {
    // unconfigured is handled by the caller before this point.
    return { ok: false, status: 400 };
  }
  try {
    await appendEvent({
      event: "unsub",
      send_key: verified.payload.send_key,
      message_id: verified.payload.message_id,
      touch: verified.payload.touch,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof OutreachEventsError) return { ok: false, status: 503 };
    console.error("U-UNSUB-APPEND-FAILURE", err);
    return { ok: false, status: 500 };
  }
}

// POST — RFC 8058 one-click. Records the unsub, returns 200 (idempotent).
export async function POST(
  _req: NextRequest,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  if (!trackingSecretConfigured()) return notConfigured();
  const r = await recordUnsub(params.token ?? "");
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: "unsubscribe failed" }, { status: r.status });
  }
  return NextResponse.json({ ok: true, unsubscribed: true }, { status: 200 });
}

// GET — human confirm page. Verifies the token (so a bad link shows an error) but
// does NOT record; the visible button POSTs to record.
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  if (!trackingSecretConfigured()) return notConfigured();

  const token = params.token ?? "";
  const verified = verifyTrackingToken(token, "unsub");
  if (!verified.ok) {
    return htmlPage(
      400,
      "Invalid unsubscribe link",
      `<h1>This unsubscribe link is not valid</h1>
       <p>The link may be incomplete or expired. If you keep receiving mail you did
       not ask for, reply to any message and we will remove you.</p>`
    );
  }

  // Post back to this same URL. The token is already in the path.
  return htmlPage(
    200,
    "Unsubscribe",
    `<h1>Unsubscribe from these emails</h1>
     <p>Click the button below and we will stop emailing you. This takes effect
     immediately and cannot be undone by us re-adding you.</p>
     <form method="POST" action="">
       <button type="submit">Unsubscribe me</button>
     </form>`
  );
}
