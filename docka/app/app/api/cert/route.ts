import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { redactCertForPublic } from "@/lib/cert";
import { DEV_COOKIE, isDevLoginEnabled } from "@/lib/agent-session";
import { DEV_SEAMAN_COOKIE, isDevSeamanLoginEnabled } from "@/lib/seaman-session";
import {
  clientIpFromHeaders,
  legacyResultForOutcome,
  resolveInput,
  type ResolveOpts,
} from "@/lib/registry";
import type { ResolveOutcome } from "@/lib/registry/types";

export const dynamic = "force-dynamic";

// isolation-guard: exempt — PUBLIC verification endpoint: it resolves registry
// lookups only and reads no tenant data. It never calls the agent identity gate
// (the static scan trips on the word in the "Deliberately NOT" note below, which
// documents exactly why the gate is avoided here).
//
// billing-guard: exempt — same reason, for the same static-scan trip: there is no
// agent session here to hold a billing tier, and this is a PUBLIC endpoint that must
// keep answering regardless of any agency's subscription state.

// Public verification endpoint (plan §5.2): resolves ANY supported registry
// input through the VerifierRegistry and returns the full multi-outcome
// `{outcome}` payload ALONGSIDE the legacy body (ok/error/cert fields), so old
// clients keep working byte-for-byte while VerifyBox renders per outcome.
//
//   GET  /api/cert?code=<code or full URL>       — single-string code ONLY.
//        Sensitive fields are NEVER accepted in a query string (§2.4 —
//        POST-body only, keeps them out of proxy/access logs).
//   POST /api/cert  { input, countryOverride?, inputs? }
//        — multi-key / sensitive lookups + the ambiguous country-picker
//        round-trip (§2.3: re-POSTs the same raw input with countryOverride).
//
// Both are rate-limited per §2.4 (per-IP + global token buckets, applied
// before any outbound fetch): over-limit → friendly 429, never a partial
// verification.

// ---- Public redaction gate (owner 2026-07-28) -------------------------
//
// This endpoint feeds BOTH the anonymous public verification surfaces (the
// homepage demo block and /verify, via VerifyBox) and signed-in surfaces (the
// agent dashboard's per-document "verify" button). The demo runs a real lookup
// against a real person's certificate, so for an UNAUTHENTICATED caller the
// holder's personal code and the certificate's verification code are redacted
// server-side — they never reach the browser at all (see lib/cert.ts
// `redactCertForPublic`). A signed-in viewer keeps the full values.
//
// Deliberately NOT `agentSession()`: that helper find-or-CREATES an Agent row
// (a db.json write) and must never be triggered from a public endpoint. The
// checks below are read-only and mirror the same signals.
async function isSignedInViewer(): Promise<boolean> {
  try {
    const s = await auth();
    if (s?.user) return true; // any Google session — agent or seaman
    if (isDevLoginEnabled && cookies().get(DEV_COOKIE)?.value) return true;
    if (isDevSeamanLoginEnabled && cookies().get(DEV_SEAMAN_COOKIE)?.value) return true;
    return false;
  } catch {
    // Fail CLOSED (treat as anonymous → redact): auth()/cookies() throw outside
    // a live Next request scope (e.g. the route-level §5b lane tests).
    return false;
  }
}

// Redact the two identifying codes on every outcome that carries a certificate.
// `opts.sample` additionally neuters sourceUrl + birthDate (see redactCertForPublic).
function redactOutcome(outcome: ResolveOutcome, opts?: { sample?: boolean }): ResolveOutcome {
  if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
    return { ...outcome, cert: redactCertForPublic(outcome.cert, opts) };
  }
  return outcome;
}

// The public sample button posts this sentinel INSTEAD of the demo
// certificate's real access token, so that token is never present in the page
// HTML or the client bundle. It is resolved to the real code here, server-side
// only. A user-typed code is passed through untouched, in full.
const SAMPLE_SENTINEL = "__docka-sample__";
// Public archive: the original value was a real certificate's access token and
// has been replaced with an obviously fake placeholder. Set SAMPLE_CERT_CODE to
// a certificate code you are allowed to show publicly to make the demo button
// return a real result; with the placeholder the lookup simply finds nothing.
const SAMPLE_CODE = process.env.SAMPLE_CERT_CODE || "SAMPLE0SAFETY001";

// `isSample` is captured on the EXACT string resolveSample matches (the literal
// sentinel, nothing else), BEFORE the rewrite to the real code — it routes the
// demo lookup to the dedicated §5b "sample" budget lane so a homepage demo wave
// can never 429 real verifications. A user pasting the real Estonian code is a
// real lookup: normal lane, full caps (no cap-free verification hole).
function resolveSample(raw: string): { code: string; isSample: boolean } {
  const isSample = raw === SAMPLE_SENTINEL;
  return { code: isSample ? SAMPLE_CODE : raw, isSample };
}

// `isSample` = the hardcoded homepage DEMO prop (the __docka-sample__ sentinel).
// It shows a REAL person's data on a public page, so it is FULLY redacted for
// EVERY viewer — signed-in admins/agents INCLUDED. isSignedInViewer() is
// deliberately NOT consulted for the sample (its bypass must not apply here).
// Real (non-sample) lookups are unchanged: full values for a signed-in viewer,
// code+personalCode masked for an anonymous one.
async function respond(outcome: ResolveOutcome, isSample = false) {
  const shown = isSample
    ? redactOutcome(outcome, { sample: true })
    : (await isSignedInViewer())
      ? outcome
      : redactOutcome(outcome);
  const legacy = legacyResultForOutcome(shown);

  if (shown.kind === "error" && shown.rateLimited) {
    return NextResponse.json({ ok: false, error: shown.error, outcome: shown }, { status: 429 });
  }
  if (legacy.ok) {
    return NextResponse.json({ ...legacy, outcome: shown });
  }
  // 400 for empty/malformed input, 404 for everything that found nothing —
  // exact legacy status semantics.
  const status = /valid verification code/.test(legacy.error) ? 400 : 404;
  return NextResponse.json({ ok: false, error: legacy.error, outcome: shown }, { status });
}

export async function GET(req: NextRequest) {
  const { code: raw, isSample } = resolveSample(req.nextUrl.searchParams.get("code") ?? "");
  // Interactive lane: opt into EE resilience (retry a fast network throw once +
  // fan out remaining categories after a throw) so a transient blip on the
  // sample-cert demo self-heals instead of surfacing ERR_EE_NETWORK. Anon
  // upload / internal callers never set this.
  const opts: ResolveOpts = {
    clientIp: clientIpFromHeaders(req.headers),
    allowRegistryResilience: true,
  };
  if (isSample) opts.budgetLane = "sample";
  const outcome = await resolveInput(raw, opts);
  return respond(outcome, isSample);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    input?: string;
    code?: string;
    countryOverride?: string;
    /** Extra lookup inputs for multi-key countries; sensitive values are pass-through only. */
    inputs?: Record<string, unknown>;
  };
  const { code: raw, isSample } = resolveSample(String(body.input ?? body.code ?? "").trim());

  // Sanitize extra inputs to a flat string map — never logged, never persisted here.
  let extraInputs: Record<string, string> | undefined;
  if (body.inputs && typeof body.inputs === "object") {
    extraInputs = {};
    for (const [k, v] of Object.entries(body.inputs)) {
      if (typeof v === "string" && v.trim()) extraInputs[k] = v.trim();
    }
    if (Object.keys(extraInputs).length === 0) extraInputs = undefined;
  }

  const opts: ResolveOpts = {
    clientIp: clientIpFromHeaders(req.headers),
    extraInputs,
    // Interactive paste/sample lane — opt into EE resilience (see GET above).
    allowRegistryResilience: true,
  };
  if (isSample) opts.budgetLane = "sample";
  const override = String(body.countryOverride ?? "").trim().toUpperCase();
  if (override) opts.countryOverride = override;

  const outcome = await resolveInput(raw, opts);
  return respond(outcome, isSample);
}
