import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { clientIpFromHeaders, consumeBudget } from "@/lib/registry";
import { searchDirectory, type DirectorySearchInput } from "@/lib/directory";
import { REQUIRED_DOC_TYPES, type RequiredDocType } from "@/lib/doctypes";
import { SurfaceRefSaltMissing } from "@/lib/surface-ref";

export const dynamic = "force-dynamic";

// #49 — docka-verified directory search. AUTHENTICATED clients only (any signed-in
// Google identity) [R49.9], rate-limited via the REUSED registry limiter in a SEPARATE
// named bucket [C2/V2], noindex, returns ONLY projected rows (never a raw RosterSearchRow).
//
// This route resolves NO agent/seaman tenant identity (auth() only) — the directory is
// a narrow cross-tenant reader gated by dual+live consent inside lib/directory, not by
// a tenant scope.

// Directory per-IP bucket: generous for an authed human using a debounced search box,
// still far below a scraper — and NAMESPACED so it can never burn the registry budget.
const DIR_CAPACITY = 30;
const DIR_REFILL_PER_MS = 30 / 60_000; // 30 / minute

const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" } as const;
const VALID_CERTS = new Set<RequiredDocType>(REQUIRED_DOC_TYPES);

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NOINDEX });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return json({ ok: false, error: "Sign in to browse the docka-verified directory." }, 401);
  }

  // REUSED spoof-hardened limiter: IP via clientIpFromHeaders + the extracted
  // consumeBudget in the "directory" namespace (no global bucket — no outbound fetch).
  const ip = clientIpFromHeaders(req.headers);
  if (!consumeBudget("directory", ip, { capacity: DIR_CAPACITY, refillPerMs: DIR_REFILL_PER_MS })) {
    return json({ ok: false, error: "Too many searches right now — wait a minute." }, 429);
  }

  const sp = req.nextUrl.searchParams;
  const certTypeRaw = (sp.get("certType") ?? "").trim();
  // Verification-level facet: accept 0..3 only; anything else -> no floor filter [E2].
  const minLevelRaw = Number(sp.get("minLevel"));
  const minVerificationLevel =
    Number.isInteger(minLevelRaw) && minLevelRaw >= 1 && minLevelRaw <= 3
      ? (minLevelRaw as 1 | 2 | 3)
      : undefined;
  const input: DirectorySearchInput = {
    text: sp.get("text") ?? undefined,
    rank: sp.get("rank") ?? undefined,
    nationality: sp.get("nationality") ?? undefined,
    vesselType: sp.get("vesselType") ?? undefined,
    flagState: sp.get("flagState") ?? undefined,
    certType: VALID_CERTS.has(certTypeRaw as RequiredDocType) ? (certTypeRaw as RequiredDocType) : "",
    minVerificationLevel,
    inDateOnly: sp.get("inDate") === "1",
  };

  try {
    const res = searchDirectory(input);
    if (!res.ok) {
      const msg =
        res.error === "text-too-short"
          ? "Type at least 2 characters, or pick a filter."
          : "Search text is too long.";
      return json({ ok: false, error: msg }, 400);
    }
    return json({ ok: true, rows: res.rows }, 200);
  } catch (e) {
    if (e instanceof SurfaceRefSaltMissing) {
      return json({ ok: false, error: "Directory temporarily unavailable." }, 503);
    }
    throw e;
  }
}
