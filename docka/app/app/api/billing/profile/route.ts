import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import {
  ensureBillingProfileForAgent,
  getBillingSettings,
  saveBillingProfileForAgent,
  usageForAgent,
  usagePreviewForAgent,
} from "@/lib/billing-store";
import { tallinnPeriodOf } from "@/lib/billing-usage";
import { stripeConfigured } from "@/lib/stripe";
import { COUNTRY_WHITELIST } from "@/lib/billing-countries";

export const dynamic = "force-dynamic";

// GET  /api/billing/profile -> the SIGNED-IN agent's own billing profile, its live
//                              current-period usage preview and its recent usage rows.
// PUT  /api/billing/profile -> save business info and/or record ToS acceptance.
//
// Everything is keyed by session.agentId (never a body-supplied id), which is what the
// isolation static guard checks via the billing-store GUARD_SYMBOLS. RATES AND
// EXEMPTION ARE NOT WRITABLE HERE — they are admin-only (see /api/admin/billing).
//
// billing-guard: exempt — the billing surface itself is reachable at every tier, so a
// past-due or blocked agency can always read its own status and fix its details.

/** R2-10c — house-style manual bounds. No zod (not a dependency, deliberately). */
const MAX_LEN = 200;
const MAX_EMAIL_LEN = 254;

// ISO-3166-1 alpha-2 whitelist (EEA + UK + CH + a few) now lives in @/lib/billing-countries
// so the client country PICKER and this validator share ONE source of truth — a user can
// never pick a country this route would reject. Validation behaviour is unchanged.

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function tooLong(v: string, max = MAX_LEN): boolean {
  return v.length > max;
}

/** Deliberately permissive shape check — Stripe/VIES do the real validation. */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export async function GET() {
  const session = await agentSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }
  // C5 — `ensureBillingProfileForAgent` RETURNS the profile (create-if-absent), so the
  // separate re-read and its unreachable null branch were pure copy-paste.
  const profile = await ensureBillingProfileForAgent(session.agentId);
  const settings = getBillingSettings();
  const period = tallinnPeriodOf(Date.now());
  const preview = usagePreviewForAgent(session.agentId, period);

  return NextResponse.json({
    ok: true,
    profile,
    settings: {
      tosVersion: settings.tosVersion,
      goLiveAt: settings.goLiveAt,
      defaults: settings.defaults,
    },
    stripeConfigured: stripeConfigured(),
    currentPeriod: {
      period,
      quantity: preview.quantity,
      billableSeafarerIds: preview.billableSeafarerIds,
    },
    usage: usageForAgent(session.agentId, 6),
  });
}

export async function PUT(req: NextRequest) {
  const session = await agentSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Sign in as an agent." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    legalName?: unknown;
    regCode?: unknown;
    vatNumber?: unknown;
    billingEmail?: unknown;
    address?: { line1?: unknown; line2?: unknown; city?: unknown; postal?: unknown; country?: unknown };
    acceptTos?: unknown;
  };

  const current = await ensureBillingProfileForAgent(session.agentId);

  // FINDING 13 — this PUT was a silent FULL REPLACE: `clean(undefined)` returns "", so a
  // partial body (the ToS checkbox posts `{"acceptTos": true}` on its own) blanked the
  // agency's legal name, reg code, VAT number, billing e-mail and whole address, with a
  // 200 and no warning. Every field is now MERGED: it is written only when the body
  // actually carries it, and validation runs on the MERGED result so a stored value can
  // never become unvalidatable either.
  const has = (v: unknown): boolean => v !== undefined;
  const merge = (incoming: unknown, stored: string): string =>
    has(incoming) ? clean(incoming) : stored;

  const legalName = merge(body.legalName, current.legalName);
  const regCode = merge(body.regCode, current.regCode);
  const vatNumber = merge(body.vatNumber, current.vatNumber ?? "");
  const billingEmail = merge(body.billingEmail, current.billingEmail);
  const addr = body.address ?? {};
  const storedAddr = current.address ?? { line1: "", city: "", postal: "", country: "" };
  // The address MERGES PER SUBFIELD: sending only `{ address: { city } }` must not blank
  // the street and the country.
  const line1 = merge(addr.line1, storedAddr.line1 ?? "");
  const line2 = merge(addr.line2, storedAddr.line2 ?? "");
  const city = merge(addr.city, storedAddr.city ?? "");
  const postal = merge(addr.postal, storedAddr.postal ?? "");
  const country = merge(addr.country, storedAddr.country ?? "").toUpperCase();

  const errors: string[] = [];
  for (const [field, value] of [
    ["legalName", legalName],
    ["regCode", regCode],
    ["vatNumber", vatNumber],
    ["address.line1", line1],
    ["address.line2", line2],
    ["address.city", city],
    ["address.postal", postal],
  ] as const) {
    if (tooLong(value)) errors.push(`${field} must be ${MAX_LEN} characters or fewer.`);
  }
  if (tooLong(billingEmail, MAX_EMAIL_LEN)) {
    errors.push(`billingEmail must be ${MAX_EMAIL_LEN} characters or fewer.`);
  }
  if (billingEmail && !looksLikeEmail(billingEmail)) {
    errors.push("billingEmail does not look like an e-mail address.");
  }
  if (country && !COUNTRY_WHITELIST.has(country)) {
    errors.push("country must be a supported ISO-3166 alpha-2 code.");
  }
  if (errors.length > 0) {
    return NextResponse.json({ ok: false, error: errors[0], errors }, { status: 400 });
  }

  const settings = getBillingSettings();
  const acceptTos = body.acceptTos === true;
  const nowIso = new Date().toISOString();

  const saved = await saveBillingProfileForAgent(
    session.agentId,
    {
      legalName,
      regCode,
      vatNumber: vatNumber || null,
      billingEmail,
      address: { line1, line2: line2 || undefined, city, postal, country },
      // Acceptance is APPEND-ONLY from the agent's side: ticking the box records the
      // instant + the version; the API never un-accepts on a later save.
      ...(acceptTos
        ? { tosAcceptedAt: current.tosAcceptedAt ?? nowIso, tosVersion: settings.tosVersion }
        : {}),
    },
    nowIso
  );

  return NextResponse.json({ ok: true, profile: saved });
}
