import { redactCertForPublic } from "@/lib/cert";
import {
  clientIpFromHeaders,
  consumeBudget,
  legacyResultForOutcome,
} from "@/lib/registry";
import { azWireCode } from "@/lib/registry/adapters/az";
import { uaMaradDocParam } from "@/lib/registry/adapters/ua-marad";
import type { CountryCode, ResolveOutcome } from "@/lib/registry/types";
import {
  auditDiskFloorRefusal,
  checkStorageGates,
  ensureOrphanSweep,
  exceedsPixelLimit,
  ipHashFor,
  MAX_CONTENT_LENGTH,
  MAX_DERIVED_BYTES,
  MAX_ORIGINAL_BYTES,
  persistUpload,
  runAnonymousRecognition,
  sniffMagic,
  VERIFY_UPLOAD_BUDGET,
  verifyIpSalt,
} from "@/lib/verify-upload";

export const dynamic = "force-dynamic";

// PUBLIC anonymous certificate-upload verification endpoint (verify-upload
// plan §1). No session of any kind is resolved here — like /api/cert it reads
// no tenant data; unlike the paste path, an ACCEPTED document is persisted
// (the corpus is the point — operator-locked decision). Anonymous flows can
// never mint a holder-bound green: certs are redacted server-side and
// pending-binding stays pending-binding.
//
//   POST /api/verify-upload   multipart/form-data
//     file:    REQUIRED — the original document. Accepted by MAGIC BYTES only:
//              JPEG / PNG / WEBP / GIF / BMP / PDF / HEIC. ≤ 10 MB.
//     derived: OPTIONAL — the client-side JPEG re-encode (compress.ts
//              forceJpeg). Untrusted: must sniff JPEG, ≤ 5 MB, ≤ 40 MP —
//              anything else is discarded NON-fatally (original still saved).
//
//   Strict §1 processing order: IP → upload rate budget → Content-Length gate
//   (before any body read) → formData → per-part caps → magic sniff → storage
//   gates → persist (received) → recognition (45 s enqueue-to-settle) →
//   respond. Refusal statuses (411/413/415/429/503) persist NOTHING.
//
//   Response (200 = accepted + persisted; the recognition result rides in the
//   body): reuses the /api/cert outcome contract — `{...legacy, outcome}` with
//   the cert redacted for the public — plus `{itemId, phase, countryDetected}`.
//   phase "deferred" carries NO outcome: the document is saved and queued for
//   an admin re-run; the UI renders the deferred card.

const ERR_LENGTH_REQUIRED = "Upload needs a Content-Length header.";
const ERR_TOO_LARGE = "This file is too large — the limit is 10 MB.";
const ERR_UNSUPPORTED =
  "Unsupported file type — upload a JPEG, PNG, WebP, GIF, BMP, HEIC photo or a PDF.";
const ERR_UPLOAD_RATE =
  "Too many uploads right now — please wait a moment and try again.";
const ERR_STORAGE =
  "Document uploads are temporarily unavailable — please try again later.";
const ERR_NOT_CONFIGURED =
  "Document uploads are not available right now — please try again later.";
const MSG_DEFERRED =
  "We saved your document — verification is queued and will run shortly.";
const MSG_NO_MATCH =
  "We could not read a verifiable code from this document. It was saved — try a sharper photo, or enter the code manually.";

// Display (printed) form of a pipeline-extracted code for the needs-inputs
// prefill — candidates travel NORMALIZED ("00073024"), the certificate prints
// "000730/24". Reuses the adapters' own wire-form reconstruction (server-side
// only — az.ts/ua-marad.ts import fetch guards and must never reach the client
// bundle); countries without a divergent printed form pass through unchanged.
function displayCodeFor(country: CountryCode, code: string): string {
  if (country === "AZ") return azWireCode(code) ?? code;
  if (country === "UA-MARAD") return uaMaradDocParam(code, code.slice(-4));
  return code;
}

// Same 5-line public redaction gate as /api/cert (this surface is ALWAYS
// anonymous — there is no signed-in variant): the holder's personal code and
// the certificate's verification code never reach the browser.
function redactOutcome(outcome: ResolveOutcome): ResolveOutcome {
  if (outcome.kind === "verified" || outcome.kind === "pending-binding") {
    return { ...outcome, cert: redactCertForPublic(outcome.cert) };
  }
  return outcome;
}

function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
  return Response.json(body, { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  // §2 startup orphan sweep — once per process, first request.
  ensureOrphanSweep();

  // Without the salt no PII-free chain line can be written — fail closed
  // BEFORE anything else (nothing persists).
  if (!verifyIpSalt()) return json({ ok: false, error: ERR_NOT_CONFIGURED }, 503);

  const clientIp = clientIpFromHeaders(req.headers);

  // §1 upload rate budget: per-IP + the NAMED per-surface global counter —
  // never the registry-outbound globalBucket.
  if (!consumeBudget("verify-upload", clientIp, VERIFY_UPLOAD_BUDGET)) {
    return json({ ok: false, error: ERR_UPLOAD_RATE }, 429, { "Retry-After": "20" });
  }

  // §1 Content-Length gate — BEFORE any body read.
  const declared = req.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared.trim())) {
    return json({ ok: false, error: ERR_LENGTH_REQUIRED }, 411);
  }
  if (Number(declared) > MAX_CONTENT_LENGTH) {
    return json({ ok: false, error: ERR_TOO_LARGE }, 413);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ ok: false, error: ERR_UNSUPPORTED }, 415);
  }
  const filePart = form.get("file");
  if (!(filePart instanceof File)) {
    return json({ ok: false, error: ERR_UNSUPPORTED }, 415);
  }

  // §1 per-part re-check (a lying Content-Length died above; parts re-checked).
  if (filePart.size > MAX_ORIGINAL_BYTES) {
    return json({ ok: false, error: ERR_TOO_LARGE }, 413);
  }
  const originalBuf = Buffer.from(await filePart.arrayBuffer());

  // §1 magic sniff — the ONLY type authority; origName/Content-Type are never
  // trusted. safeExt derives from this inside persistUpload.
  const sniffed = sniffMagic(originalBuf);
  if (!sniffed) return json({ ok: false, error: ERR_UNSUPPORTED }, 415);

  // Derived part (§3): untrusted client optimization — sniffed JPEG, ≤5 MB,
  // pixel-gated; any failure discards it NON-fatally (the original is the doc).
  let derivedBuf: Buffer | null = null;
  const derivedPart = form.get("derived");
  if (derivedPart instanceof File && derivedPart.size > 0 && derivedPart.size <= MAX_DERIVED_BYTES) {
    const buf = Buffer.from(await derivedPart.arrayBuffer());
    if (sniffMagic(buf) === "jpeg" && !exceedsPixelLimit(buf, "jpeg")) derivedBuf = buf;
  }

  // §1 storage gates — disk floor (audited refusal, no file) + daily quota.
  const gate = checkStorageGates(originalBuf.length + (derivedBuf?.length ?? 0));
  if (!gate.ok) {
    if (gate.reason === "disk-floor") {
      await auditDiskFloorRefusal(ipHashFor(clientIp), gate.bytesFree);
    }
    return json({ ok: false, error: ERR_STORAGE }, 503);
  }

  // §2 persist (phase "received") — from here on, EVERY path keeps the bytes.
  const item = await persistUpload({
    originalBuf,
    sniffedType: sniffed,
    origName: filePart.name || "",
    derivedBuf,
    clientIp,
  });

  // §4/§5 recognition — 45 s enqueue-to-settle; every failure converges to
  // "deferred" (bytes + sidecar persisted, admin re-run).
  const settle = await runAnonymousRecognition(item);

  if (settle.phase === "deferred") {
    return json(
      {
        ok: false,
        error: MSG_DEFERRED,
        itemId: item.itemId,
        phase: "deferred",
        countryDetected: settle.countryDetected,
      },
      200
    );
  }
  if (!settle.outcome) {
    // Completed with nothing verifiable — guided fallback (retry tips +
    // manual entry prefilled with countryDetected when the keyword map fired).
    // A needs-inputs settle does NOT land here (it rides the outcome path
    // below with codeDisplay): this branch is the truly-no-code case only.
    return json(
      {
        ok: false,
        error: MSG_NO_MATCH,
        itemId: item.itemId,
        phase: "completed",
        countryDetected: settle.countryDetected,
      },
      200
    );
  }

  // /api/cert contract: legacy fields spread + the redacted multi-outcome
  // payload, plus the upload additions. Always redacted — anonymous surface.
  // A needs-inputs settle (registry wants more keys for a code the pipeline
  // DID read) additionally carries `codeDisplay`, the printed form of the
  // extracted code, so the UI can prefill it instead of making the user
  // retype it (2026-08-24 live AZ defect). Same-session echo of the
  // uploader's own document — nothing new is logged or persisted.
  const shown = redactOutcome(settle.outcome);
  const legacy = legacyResultForOutcome(shown);
  return json(
    {
      ...legacy,
      outcome: shown,
      ...(shown.kind === "needs-inputs"
        ? { codeDisplay: displayCodeFor(shown.country.country, shown.code) }
        : {}),
      itemId: item.itemId,
      phase: "completed",
      countryDetected: settle.countryDetected,
    },
    200
  );
}
