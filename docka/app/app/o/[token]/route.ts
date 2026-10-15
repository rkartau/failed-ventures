import { NextRequest, NextResponse } from "next/server";
import { trackingSecretConfigured, verifyTrackingToken } from "@/lib/tracking-token";
import { appendEvent, OutreachEventsError } from "@/lib/outreach-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // needs node:crypto + fs (appendEvent); never the edge bundle

// SYSTEM route — the open-tracking pixel (plan §2 B2). NOT agent- or seaman-scoped.
//
// GET /o/<token>.gif  → a 1×1 transparent GIF, Cache-Control: no-store.
//
// FAIL-CLOSED (mirrors the Stripe webhook route): with TRACKING_HMAC_SECRET unset
// this endpoint answers 503 — an unconfigured deployment can never record a
// forged open. This 503 gate precedes the pixel-enabled flag below.
//
// OFF BY DEFAULT: the open pixel forces HTML-multipart mail (hurts deliverability)
// and Apple MPP makes opens near-meaningless, so recording is DORMANT until
// OUTREACH_OPEN_PIXEL_ENABLED=1 (Tier B). When dormant the endpoint still serves
// the transparent GIF (so any embedded pixel never shows a broken image) but
// records NOTHING. A pixel is embedded in mail only when enabled, so this route
// is normally simply unused.
//
// The GIF is ALWAYS returned (even for a forged/invalid token) — a tracking pixel
// must never leak token validity through its response, and never 4xx into a mail
// client's image loader.

// 1×1 transparent GIF (43 bytes).
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixelResponse(): NextResponse {
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}

function openPixelEnabled(): boolean {
  return process.env.OUTREACH_OPEN_PIXEL_ENABLED === "1";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
): Promise<NextResponse> {
  // FAIL-CLOSED: no HMAC secret → 503 (do not even serve the pixel).
  if (!trackingSecretConfigured()) {
    return NextResponse.json({ ok: false, error: "tracking not configured" }, { status: 503 });
  }

  // The route is /o/<token>.gif — strip the .gif the mail client requested.
  const raw = params.token ?? "";
  const token = raw.endsWith(".gif") ? raw.slice(0, -4) : raw;

  const verified = verifyTrackingToken(token, "open");
  if (!verified.ok) {
    // Invalid/forged/tampered/wrong-event token → serve the pixel, record nothing.
    return pixelResponse();
  }

  if (openPixelEnabled()) {
    try {
      await appendEvent({
        event: "open",
        send_key: verified.payload.send_key,
        message_id: verified.payload.message_id,
        touch: verified.payload.touch,
      });
    } catch (err) {
      // Disk ceiling or transient fs error → still return the pixel; recording is
      // best-effort and must never fail a mail render.
      if (!(err instanceof OutreachEventsError)) {
        console.error("O-PIXEL-APPEND-FAILURE", err);
      }
    }
  }

  return pixelResponse();
}
