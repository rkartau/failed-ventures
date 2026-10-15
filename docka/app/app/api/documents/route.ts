import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  readDB,
  updateDB,
  id,
  requestManualVerification,
  confirmManualVerification,
  closeManualVerification,
  type Doc,
} from "@/lib/db";
import {
  newVerifiedDoc,
  applyVerifiedIdentity,
  applyVerifiedHolderToDoc,
} from "@/lib/verify";
import { bindHolder, clientIpFromHeaders, resolveInput } from "@/lib/registry";
import { stripSensitiveInputs } from "@/lib/registry/countries";
import type { ResolveOutcome } from "@/lib/registry/types";
import type { VerifiedCert } from "@/lib/cert";
import { recognizeImage } from "@/lib/recognize";
import { classifyRequiredType } from "@/lib/doctypes";
import { autoClearForDoc, clearRequestById } from "@/lib/doc-requests";
import type { DocRequest } from "@/lib/db";
import { isSameSeafarerDuplicate } from "@/lib/duplicates";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import { checkAccess } from "@/lib/access";
import {
  resolveTokenSubject,
  SAMPLE_WRITE_DENIED,
  sampleReadOnlyResponse,
  pruneSampleReferences,
} from "@/lib/sample-guard";

export const dynamic = "force-dynamic";

// billing-guard: session-branch — R2-9. This route serves TWO trust models. The
// billing tier binds ONLY to the resolved agent-session path; the possession-token
// path is deliberately untouched, so a blocked agency never costs its seafarers
// access to their own data via /share, /portal or a share link (decision 6).
// (requireBillingReadable / requireBillingWritable both fail open on a session-less
// caller, which is what makes the token branch structurally exempt.)
// OCR on a large photo can take a few seconds — give the route room.
export const maxDuration = 60;

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

// SAME-SEAFARER upload dedupe lives in lib/duplicates.ts (isSameSeafarerDuplicate,
// moved there in the registry increment so it is unit-testable + country-scoped
// per plan §4.9 — same number under two DIFFERENT non-null registryCountry
// values is NOT a duplicate; null is a wildcard).

// GET /api/documents?seafarerId=...
export async function GET(req: NextRequest) {
  const sid = (req.nextUrl.searchParams.get("seafarerId") ?? "").trim();
  if (!sid) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }
  // Documents (including medical-certificate metadata) are AGENT-facing here and
  // must be grant-scoped. FAIL-CLOSED: signed-in agent + LIVE grant, else 404 — a
  // raw seafarerId can no longer be replayed to enumerate another tenant's dossier.
  // The seaman reads their OWN documents via /api/seafarers?token=, which embeds
  // them (an unguessable possession secret), so no seaman consumer is affected.
  // CANONICAL ACTOR ORDER (F3): resolve the target, then `checkAccess` FIRST, then the
  // billing gate. The old order fired the 402 before the grant check, so a blocked agent
  // could tell "this id exists in SOME tenant" (402) from "no such id" (404) — a
  // cross-tenant existence oracle (finding 19). This GET has no token trust model.
  const session = await agentSession();
  if (!session?.user || !checkAccess(session.agentId, sid).allowed) {
    return NextResponse.json({ ok: false, error: "Seafarer not found." }, { status: 404 });
  }
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  const db = readDB();
  const documents = db.documents
    .filter((d) => d.seafarerId === sid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return NextResponse.json({ ok: true, documents });
}

// POST /api/documents  (multipart/form-data)
// fields: seafarerId, code? (verification code or URL), title? (fallback), file?
//
// Paths, in order of confidence:
//  1. A pasted code/URL      -> live government verification (VERIFIED, green).
//  2. An uploaded image      -> two-tier recognition (recognizeImage):
//       (a) QR / embedded code -> live verification (VERIFIED, green)
//       (b) OCR best-effort     -> title/name/expiry read from the photo (amber)
//  3. Anything else          -> stored as a plain file (never a silent failure).
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: "Invalid form data." }, { status: 400 });
  }

  const seafarerId = String(form.get("seafarerId") ?? "").trim();
  const codeRaw = String(form.get("code") ?? form.get("estonianCode") ?? "").trim();
  const titleRaw = String(form.get("title") ?? "").trim();
  // Feature 1+2 — OPTIONAL targeted upload: the id of the specific pending
  // DocRequest this upload is meant to fill. When present it clears THAT request
  // even if it is ad-hoc (requiredType null), which auto-clear never matches.
  const docRequestId = String(form.get("docRequestId") ?? "").trim();

  if (!seafarerId) {
    return NextResponse.json({ ok: false, error: "seafarerId is required." }, { status: 400 });
  }

  const db = readDB();
  if (!db.seafarers.some((s) => s.id === seafarerId)) {
    return NextResponse.json({ ok: false, error: "Unknown seafarer." }, { status: 404 });
  }

  // FAIL-CLOSED authorisation before ANY file write or DB mutation, mirroring the
  // PATCH/DELETE gate. Uploading a document was previously UNAUTHENTICATED — any
  // caller who knew (or guessed) a seafarerId could push a doc into that tenant's
  // dossier. Two trust models resolve the owner (the form's seafarerId here):
  //   - agent context  : a signed-in agent needs a LIVE grant to the seafarer
  //     (checkAccess, agentId FIRST). A foreign / un-granted seafarer 404s.
  //   - seaman context : a "token" multipart field must match the OWNER's share
  //     token (their own possession secret) — a token for another seafarer 404s.
  // Anything else => the SAME "Unknown seafarer." 404 the existence check returns,
  // so an unauthorised caller cannot distinguish "doesn't exist" from "not yours".
  const session = await agentSession();
  const token = String(form.get("token") ?? "").trim();
  // Owner-token authorisation via the sample chokepoint (open token only, PHASE0-CENSUS
  // row 2; a sample subject's token write-DENYs). Replaces the deprecated shareToken
  // equality so the D6 v4 zero-inline-compare rule holds.
  const tokenSubject = token ? resolveTokenSubject(db, token, "write", ["open"]) : null;
  const tokenAuthorises =
    !!tokenSubject && tokenSubject !== SAMPLE_WRITE_DENIED && tokenSubject.seafarer.id === seafarerId;
  // CANONICAL ACTOR ORDER (F3, findings 8 + 19). `checkAccess` runs BEFORE the billing
  // gate so a blocked agent cannot use the 402/404 split as an existence oracle, and a
  // denied gate FALLS THROUGH to the owner-token branch instead of 402-ing: the seafarer
  // at a shared browser must never lose access to their own dossier because the agency
  // that also has a session there stopped paying (decision 6 / R2-9).
  let isAgent = !!session?.user;
  if (isAgent) {
    if (!checkAccess(session!.agentId, seafarerId).allowed) {
      return NextResponse.json({ ok: false, error: "Unknown seafarer." }, { status: 404 });
    }
    const billingGate = requireBillingWritable(session);
    if (!billingGate.ok) {
      if (!tokenAuthorises) return billingGate.response;
      // FR1-7 — the request proceeds AS THE OWNER, never with agent powers.
      isAgent = false;
    }
  } else if (tokenSubject === SAMPLE_WRITE_DENIED) {
    // Owner (token) context: a sample subject's token is write-DENIED (403).
    return sampleReadOnlyResponse();
  }
  if (!isAgent && !tokenAuthorises) {
    return NextResponse.json({ ok: false, error: "Unknown seafarer." }, { status: 404 });
  }

  // Store an optional file first (works with or without a code).
  let fileName: string | null = null;
  let originalName: string | undefined;
  let fileBuf: Buffer | null = null;
  let storedPath: string | null = null;
  const file = form.get("file");
  if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
    const f = file as File;
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stored = `${id()}${safeExt(f.name)}`;
    fileBuf = Buffer.from(await f.arrayBuffer());
    storedPath = path.join(UPLOAD_DIR, stored);
    fs.writeFileSync(storedPath, fileBuf);
    fileName = stored;
    originalName = f.name;
  }

  // SHA-256 of the uploaded bytes — the last-resort dedupe signature.
  const fileHash = fileBuf ? crypto.createHash("sha256").update(fileBuf).digest("hex") : null;

  const codePasted = codeRaw.length > 0;

  // Base record — used as-is for a plain file with no resolvable code.
  let doc: Doc = {
    id: id(),
    seafarerId,
    title: titleRaw || "Document",
    docType: "Document",
    docCategory: null,
    estonianCode: null,
    isValid: null,
    validUntil: null,
    fileName,
    createdAt: new Date().toISOString(),
    source: "manual",
    requiredType: null,
    reviewStatus: "pending",
    expiryConfirmed: true, // a manual/plain doc has no auto-guessed date to distrust
  };
  if (originalName) doc.originalName = originalName;

  let autoVerified = false;
  let readFromPhoto = false;
  // The successful registry verification (if any) — carried into the write critical
  // section so the seaman's OWN profile can adopt the registry-returned identity.
  let verifiedCert: VerifiedCert | null = null;
  // When a photo carries no readable/meaningful title, we number it per seafarer
  // so the seaman can tell his uploads apart at a glance.
  let needsPhotoNumber = false;
  // Registry multi-outcome extras (plan §5.2): the resolve outcome echoed to the
  // UI, the honest holder-mismatch message, and the Wave-4 manual-request stamp.
  let pasteOutcome: ResolveOutcome | null = null;
  let holderMismatchMsg: string | null = null;
  let stampManualRequest = false;

  // Remove an already-stored upload file when the request ends WITHOUT storing a
  // doc (rate limit / picker round-trip / confirmation step) — no orphans, and
  // §2.4's "429 → no partial doc" holds for the file too.
  const discardStoredFile = () => {
    if (storedPath) {
      try {
        fs.unlinkSync(storedPath);
      } catch {
        /* ignore */
      }
    }
  };

  if (codePasted) {
    // --- Path 1: explicit pasted code → full registry resolve (§2.3/§5.2) --
    const overrideRaw = String(form.get("countryOverride") ?? "").trim().toUpperCase();
    const holderConfirmed = /^(1|true|yes)$/i.test(String(form.get("holderConfirmed") ?? "").trim());
    // Optional multi-key lookup inputs (§5.2). Sensitive values are used for
    // the fetch then STRIPPED before any store — never persisted, never logged.
    let extraInputs: Record<string, string> | undefined;
    const riRaw = String(form.get("registryInputs") ?? "").trim();
    if (riRaw) {
      try {
        const parsed = JSON.parse(riRaw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          extraInputs = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string" && v.trim()) extraInputs[k] = v.trim();
          }
          if (Object.keys(extraInputs).length === 0) extraInputs = undefined;
        }
      } catch {
        /* malformed registryInputs — ignored, the paste continues without them */
      }
    }

    const outcome = await resolveInput(codeRaw, {
      countryOverride: overrideRaw || undefined,
      clientIp: clientIpFromHeaders(req.headers),
      extraInputs,
    });

    if (outcome.kind === "error" && outcome.rateLimited) {
      // §2.4: friendly retry, NO partial verification, NO doc stored.
      discardStoredFile();
      return NextResponse.json({ ok: false, error: outcome.error, outcome }, { status: 429 });
    }

    if (outcome.kind === "verified") {
      doc = newVerifiedDoc(seafarerId, outcome.cert, { title: titleRaw, fileName, originalName });
      verifiedCert = outcome.cert;
      if (extraInputs) {
        const kept = stripSensitiveInputs(outcome.cert.registryCountry, extraInputs);
        if (Object.keys(kept).length > 0) doc.registryInputs = kept;
      }
    } else if (outcome.kind === "pending-binding") {
      // §2.5 choke point: ONLY bindHolder may turn a public-identifier match
      // into a storable verification.
      const sf = db.seafarers.find((s) => s.id === seafarerId)!;
      const bind = bindHolder(outcome, sf, { confirmedByHolder: holderConfirmed });
      if (bind.ok) {
        doc = newVerifiedDoc(seafarerId, bind.cert, { title: titleRaw, fileName, originalName });
        verifiedCert = bind.cert; // identity self-heal stays gated inside applyVerifiedIdentity
        if (extraInputs) {
          const kept = stripSensitiveInputs(bind.cert.registryCountry, extraInputs);
          if (Object.keys(kept).length > 0) doc.registryInputs = kept;
        }
      } else if (bind.needsConfirmation) {
        // First-set (§2.5 rule 3): nothing stored until the holder confirms.
        discardStoredFile();
        return NextResponse.json(
          { ok: false, needsHolderConfirmation: true, holderName: bind.holderName, outcome },
          { status: 409 }
        );
      } else {
        // Rule 2 mismatch: stored UNVERIFIED + flagged, never green.
        doc.title = titleRaw || outcome.cert.title || "Unverified document";
        doc.certNumber = outcome.cert.code;
        doc.registryCountry = outcome.country.country;
        doc.holderMismatch = true;
        doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
        // Snapshot WHO the registry says holds it — surfaced to reviewers.
        applyVerifiedHolderToDoc(doc, outcome.cert);
        holderMismatchMsg = bind.error;
        pasteOutcome = outcome;
      }
    } else if (outcome.kind === "assist" || outcome.kind === "manual") {
      // §5.2: store the doc as today (unverified), code into certNumber,
      // registryCountry set; manual additionally opens the request workflow.
      // vr2 item 5: the fallback title names the country ("Latvia certificate")
      // instead of a bare "Unverified document", so rescued docs stay legible
      // on the seafarer row and agent list.
      doc.title = titleRaw || `${outcome.country.countryName} certificate`;
      doc.certNumber = codeRaw;
      doc.registryCountry = outcome.country.country;
      doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
      if (extraInputs) {
        const kept = stripSensitiveInputs(outcome.country.country, extraInputs);
        if (Object.keys(kept).length > 0) doc.registryInputs = kept;
      }
      stampManualRequest = outcome.kind === "manual";
      pasteOutcome = outcome;
    } else if (outcome.kind === "ambiguous") {
      // Country picker round-trip (§2.3): nothing stored; the UI re-POSTs the
      // same input with countryOverride.
      discardStoredFile();
      return NextResponse.json(
        { ok: false, error: "Select the issuing country to continue.", outcome },
        { status: 422 }
      );
    } else if (outcome.kind === "needs-inputs") {
      // §5.2 multi-key prompt round-trip (UK/NO date of birth, …): nothing is
      // fetched or stored yet — the UI prompts for outcome.missing (auto-filled
      // from the profile where the field's source allows) and re-POSTs the same
      // code with a registryInputs JSON field.
      discardStoredFile();
      return NextResponse.json(
        { ok: false, error: "A few more details are needed to verify this certificate.", outcome },
        { status: 422 }
      );
    } else if (fileName) {
      // Legacy behavior: keep the attached file; store the raw code without
      // verification (incl. the unpinned-domain warning surfaced via outcome).
      doc.estonianCode = codeRaw.toUpperCase();
      doc.title = titleRaw || "Unverified document";
      doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
      pasteOutcome = outcome;
    } else {
      return NextResponse.json({ ok: false, error: outcome.error, outcome }, { status: 422 });
    }
  } else if (fileBuf && originalName && storedPath) {
    // --- Path 2: recognise the uploaded file ----------------------------
    const rec = await recognizeImage(fileBuf, originalName, storedPath);
    if (rec.source === "government") {
      doc = newVerifiedDoc(seafarerId, rec.cert, { title: titleRaw, fileName, originalName });
      verifiedCert = rec.cert;
      autoVerified = true;
    } else if (rec.source === "pending-binding") {
      // §2.5: the photo path goes through the SAME bindHolder choke point — a
      // photo of someone ELSE's cert QR is flagged holder-mismatch, never green.
      const sf = db.seafarers.find((s) => s.id === seafarerId)!;
      const bind = bindHolder(
        { kind: "pending-binding", cert: rec.cert, country: rec.country },
        sf
      );
      if (bind.ok) {
        doc = newVerifiedDoc(seafarerId, bind.cert, { title: titleRaw, fileName, originalName });
        verifiedCert = bind.cert;
        autoVerified = true;
      } else {
        // Mismatch OR unconfirmed first-set: stored as an UNVERIFIED photo doc;
        // flagged only on a positive mismatch.
        doc.title = titleRaw || rec.cert.title || "Certificate photo";
        doc.docType = "Photo — not verified";
        doc.source = "photo";
        doc.certNumber = rec.cert.code;
        doc.registryCountry = rec.country.country;
        doc.validUntil = rec.cert.validUntil || null;
        doc.expiryConfirmed = false;
        doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
        applyVerifiedHolderToDoc(doc, rec.cert);
        if (!bind.needsConfirmation) {
          doc.holderMismatch = true;
          holderMismatchMsg =
            "The registry lists a different holder for this certificate — it was saved unverified and flagged for review.";
        }
        readFromPhoto = true;
      }
    } else if (rec.source === "photo") {
      // Prefer a read title; fall back to a meaningful filename. A purely numeric
      // camera name ("1000029460") is no clearer than a clean generic, so it does
      // NOT become the title — instead we number the photo per seafarer below so
      // the rows are never identical ("Certificate photo 1", "…2", …).
      const base = originalName.replace(/\.[a-z0-9]+$/i, "").trim();
      const filenameTitle = /[A-Za-z]{3,}/.test(base) ? base : "";
      const readTitle = titleRaw || rec.fields.title || filenameTitle;
      // Honest subtext — a saved photo is NOT registry-verified; never a green
      // "verified" signal. The seaman can rename it and add an expiry if they want.
      doc.title = readTitle || "Certificate photo";
      doc.docType = rec.fields.title ? doc.title : "Photo — not verified";
      doc.source = "photo";
      doc.holderName = rec.fields.name;
      doc.validUntil = rec.fields.expiry;
      // Best-effort printed certificate number — the value the fleet-wide
      // duplicate check compares to catch the same number on two crew.
      doc.certNumber = rec.fields.certNumber;
      // The expiry (if any) came out of OCR — a guess, NOT registry-verified and
      // NOT confirmed by the seaman. Flag it so the badge reads "unread" rather
      // than a confident green "Valid" (round-8 items 1/3/8/10).
      doc.expiryConfirmed = false;
      doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
      needsPhotoNumber = !readTitle;
      readFromPhoto = true;
    }
    // rec.source === "none": leave the plain-file base record.
  } else {
    return NextResponse.json(
      { ok: false, error: "Paste a verification code or attach a file." },
      { status: 400 }
    );
  }

  // Carry the file signature so a later identical re-upload can be recognised.
  doc.fileHash = fileHash;

  // Atomically: re-check for a same-seafarer duplicate against the fresh db and,
  // only if none, assign a photo number + persist. The check runs INSIDE the write
  // critical section so two near-simultaneous identical uploads can't both land.
  const outcome = await updateDB((d) => {
    // Adopt the registry-returned identity onto the seaman's OWN profile whenever a
    // government verification succeeded — even if the document itself is a duplicate,
    // because the identity is authoritative and the write is idempotent. Scoped to
    // THIS document's seafarerId (validated to exist above), never another seafarer.
    if (verifiedCert) {
      const sf = d.seafarers.find((s) => s.id === seafarerId);
      if (sf) applyVerifiedIdentity(sf, verifiedCert);
    }
    const dup = d.documents.find(
      (x) => x.seafarerId === seafarerId && isSameSeafarerDuplicate(x, doc, fileHash)
    );
    if (dup) {
      // Re-verify path: even though the document already exists, capture the fresh
      // registry holder snapshot onto the stored doc so the identity is durable.
      if (verifiedCert) applyVerifiedHolderToDoc(dup, verifiedCert);
      return { duplicate: true as const, existing: dup };
    }
    if (needsPhotoNumber) {
      const n = d.documents.filter((x) => x.seafarerId === seafarerId && x.source === "photo").length + 1;
      doc.title = `Certificate photo ${n}`;
      doc.requiredType = classifyRequiredType({ title: doc.title, docType: doc.docType });
    }
    // Wave-4 manual-request countries (§5.2): open the manual-verification
    // workflow in the SAME critical section as the insert (idempotent helper —
    // a re-POST can never overwrite the original request).
    if (stampManualRequest) {
      const sf = d.seafarers.find((s) => s.id === seafarerId);
      requestManualVerification(doc, sf?.name || "seafarer");
    }
    // Fix 6 — a targeted upload (docRequestId) should appear in the doc list under
    // the REQUEST's name, not the raw filename / generic "Certificate photo N".
    // Reuse the SAME fresh lookup the clear logic uses (still pending at this point,
    // before clearRequestById below marks it received). requiredType values are
    // already human-readable, so they double as the label fallback. When the request
    // carries a slot and the doc hasn't classified into one, adopt the slot too so
    // the doc both NAMES and SLOTS correctly (classification-derived views agree).
    if (docRequestId) {
      const targetReq = d.docRequests.find(
        (r) => r.id === docRequestId && r.seafarerId === seafarerId && r.status === "pending"
      );
      if (targetReq) {
        const label = (targetReq.label ?? "").trim();
        doc.title = label || targetReq.requiredType || doc.title;
        if (targetReq.requiredType && !doc.requiredType) {
          doc.requiredType = targetReq.requiredType;
        }
      }
    }
    // §D9 — bound real-agent interactions with a sample subject (no-op otherwise).
    pruneSampleReferences(d, seafarerId);
    d.documents.push(doc);
    // Auto-clear the collection loop: a matching pending document-request (same
    // required slot) is marked received the instant the seaman uploads what was
    // asked for — no agent action needed. Runs in the same critical section as the
    // insert so the checklist and the document set never disagree.
    const clearedAuto = autoClearForDoc(d.docRequests, seafarerId, doc);
    // Feature 1+2 — a targeted upload additionally clears the EXACT request it was
    // pointed at (even ad-hoc / requiredType null), in the same critical section.
    const clearedExplicit = docRequestId
      ? clearRequestById(d.docRequests, seafarerId, docRequestId, doc)
      : [];
    const clearedRequestIds = Array.from(new Set([...clearedAuto, ...clearedExplicit]));
    // Fresh checklist for this seafarer so the client can replace state in one shot.
    const freshRequests = d.docRequests.filter((r) => r.seafarerId === seafarerId);
    return { duplicate: false as const, clearedRequestIds, docRequests: freshRequests };
  });

  if (outcome.duplicate) {
    // Disregard the re-upload. Remove the just-written file so a skipped duplicate
    // never leaves an orphan on disk (storage is tight on this box).
    if (storedPath) {
      try {
        fs.unlinkSync(storedPath);
      } catch {
        /* ignore */
      }
    }
    return NextResponse.json({
      ok: true,
      duplicate: true,
      skipped: true,
      message: "Already uploaded — skipped",
      document: outcome.existing,
    });
  }

  // fileOnly keeps its legacy meaning ("we couldn't read a code from that
  // file") — the NEW registry outcomes (assist/manual stores, holder-mismatch
  // flags) are not that, so they suppress it; the legacy error-with-file path
  // (pasteOutcome.kind === "error") keeps it.
  const suppressFileOnly =
    !!holderMismatchMsg ||
    (pasteOutcome !== null && (pasteOutcome.kind === "assist" || pasteOutcome.kind === "manual"));
  const fileOnly =
    doc.source === "manual" && doc.docCategory === null && !doc.validUntil && !suppressFileOnly;
  return NextResponse.json({
    ok: true,
    document: doc,
    autoVerified,
    readFromPhoto,
    source: doc.source,
    fileOnly,
    // Feature 1+2 — which document-requests this upload cleared, plus the seafarer's
    // fresh checklist, so the client can update the panel without a full reload.
    clearedRequestIds: outcome.clearedRequestIds,
    docRequests: outcome.docRequests,
    // Registry multi-outcome extras (§5.2) — absent for legacy flows.
    ...(pasteOutcome ? { outcome: pasteOutcome } : {}),
    ...(holderMismatchMsg ? { holderMismatch: true, message: holderMismatchMsg } : {}),
  });
}

// PATCH /api/documents  { documentId, validUntil?, title? }
//
// Lets the seafarer fill in the details OCR could not read off a paper photo —
// above all the EXPIRY DATE, so the app can actually remind them before it
// lapses (its headline job). Only editable for non-government documents: a
// registry-verified record's title/expiry come from the authority and must not
// be hand-overwritten.
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    validUntil?: string | null;
    /**
     * Feature 3 — mark this document as having NO expiry date (perpetual). true
     * forces validUntil=null, marks the expiry confirmed, and treats the doc as
     * valid; false clears the flag. Government docs stay edit-locked (see below).
     */
    noExpiry?: boolean;
    title?: string;
    /** Set true when a reviewer opened the file and confirmed name + expiry. */
    reviewerChecked?: boolean;
    /** Reviewer name for the audit trail (reviewerChecked / manualAction). */
    checkedBy?: string;
    /**
     * §4.3 — HOW the reviewer sign-off was performed: "document" (eyeballed the
     * file) or "registry-portal" (confirmed on the official registry via the
     * assisted flow). AGENT-ONLY, server-enforced: a seaman token caller
     * attempting to set it gets 403 — a seafarer must never stamp their own doc
     * as registry-checked. Only applies together with reviewerChecked:true.
     */
    checkedVia?: string;
    /**
     * §4.4 manual-verification workflow (Wave-4 email/process countries).
     * AGENT-ONLY (403 for seamen): "request" opens the request via the
     * idempotent helper (a re-POST never overwrites requestedAt), "confirm"
     * records the authority's reply, "close" marks it unavailable.
     */
    manualAction?: string;
    /**
     * F8 — REQUIRED with manualAction:"confirm": short evidence of the
     * authority's reply (email date / reference), stored in
     * manualVerification.evidenceNote. A confirm without it is a 400.
     */
    evidenceNote?: string;
    /** Seaman self-service authorisation: the OWNER share token (possession secret). */
    token?: string;
    /**
     * Archive (true) / unarchive (false) this document. Archiving moves a past doc
     * OUT of the active list without deleting it; it stays viewable and can be
     * unarchived. Allowed on ANY document (incl. government) — it changes only
     * whether the doc counts as active, never the issuer's content.
     */
    archived?: boolean;
    /**
     * Owner-set display rotation in degrees (0 | 90 | 180 | 270). A non-destructive
     * display transform — like `archived`, it is allowed on ANY document (incl.
     * government) because it never rewrites issuer content, only how the image is
     * shown. The stored file bytes are untouched.
     */
    rotation?: number;
  };
  const documentId = (body.documentId ?? "").trim();
  if (!documentId) {
    return NextResponse.json({ ok: false, error: "documentId is required." }, { status: 400 });
  }

  // FAIL-CLOSED authorisation before ANY mutation. Editing a document by its opaque
  // id was previously UNAUTHENTICATED — any caller could rewrite any tenant's doc
  // title/expiry/reviewer-sign-off. Two trust models resolve the owner, mirroring
  // /api/files and /api/seafarers:
  //   - agent context  : a signed-in agent needs a LIVE grant to the doc's owner
  //     (checkAccess, TOCTOU-safe). A foreign / un-granted doc 404s with no write.
  //   - seaman context : a ?token in the body must match the OWNER's share token
  //     (the seaman's own possession secret) — a token for another seafarer 404s.
  // Anything else => 404. reviewerChecked is an AGENT-only sign-off (see below).
  const targetDoc = readDB().documents.find((d) => d.id === documentId) ?? null;
  const owner = targetDoc?.seafarerId ?? null;
  const session = await agentSession();
  const token = (body.token ?? "").trim();
  const tokenSubject = token ? resolveTokenSubject(readDB(), token, "write", ["open"]) : null;
  const tokenAuthorises =
    !!owner &&
    !!tokenSubject &&
    tokenSubject !== SAMPLE_WRITE_DENIED &&
    tokenSubject.seafarer.id === owner;
  // CANONICAL ACTOR ORDER (F3, findings 8 + 19) — see the POST handler above. The
  // owner-token fall-through demotes to OWNER context (FR1-7), so the agent-only
  // sign-off fields below still 403 for it. Token resolution goes through the sample
  // chokepoint (open token only; a sample subject's token write-DENYs -> 403).
  let isAgent = !!session?.user;
  if (isAgent) {
    if (!owner || !checkAccess(session!.agentId, owner).allowed) {
      return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
    }
    const billingGate = requireBillingWritable(session);
    if (!billingGate.ok) {
      if (!tokenAuthorises) return billingGate.response;
      isAgent = false;
    }
  } else if (tokenSubject === SAMPLE_WRITE_DENIED) {
    return sampleReadOnlyResponse();
  }
  if (!isAgent && !tokenAuthorises) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }
  // SAMPLE GUARD (census row 2): a CURATED sample document is immutable for
  // everyone — agents included. (An agent's OWN non-curated upload to a sample
  // subject stays editable/deletable as usual.)
  if (targetDoc?.sample === true) {
    return sampleReadOnlyResponse();
  }

  // ---- Registry-era agent-only fields (plan §4.3/§4.4) — SERVER-SIDE role
  // gate. Both are audit facts only an agent/reviewer may write; an authorised
  // seaman (owner token) attempting them gets an explicit 403, never a silent
  // ignore — forging "checked against registry" or the manual-verification
  // trail from the seaman side must fail loudly.
  if (body.checkedVia !== undefined) {
    if (body.checkedVia !== "document" && body.checkedVia !== "registry-portal") {
      return NextResponse.json({ ok: false, error: "Invalid checkedVia value." }, { status: 400 });
    }
    if (!isAgent) {
      return NextResponse.json(
        { ok: false, error: "Only a signed-in agent can record a registry check." },
        { status: 403 }
      );
    }
    if (body.reviewerChecked !== true) {
      return NextResponse.json(
        { ok: false, error: "checkedVia requires reviewerChecked." },
        { status: 400 }
      );
    }
  }
  if (body.manualAction !== undefined) {
    if (!["request", "confirm", "close"].includes(body.manualAction)) {
      return NextResponse.json({ ok: false, error: "Invalid manualAction." }, { status: 400 });
    }
    if (!isAgent) {
      return NextResponse.json(
        { ok: false, error: "Only a signed-in agent can manage manual verification." },
        { status: 403 }
      );
    }
    // F8 — a confirmation must carry evidence of the authority's reply.
    if (body.manualAction === "confirm" && !(body.evidenceNote ?? "").trim()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Add a short evidence note (what the authority replied — email date / reference) to mark this confirmed.",
        },
        { status: 400 }
      );
    }
  }
  // Actor for the manual-verification audit trail: explicit checkedBy, else the
  // agent session identity (never client-forgeable for the fallback).
  const actorName =
    (body.checkedBy ?? "").trim() ||
    // FR1-7 — `isAgent` (not `session`): a request that fell through to the owner token
    // because the agency is blocked is attributed to the OWNER, never to the agency.
    (isAgent ? session?.user?.name || session?.user?.email : null) ||
    "Agent";

  // Normalise an optional expiry date to an ISO instant (accepts yyyy-mm-dd from
  // a date input). An empty string clears it.
  let validUntil: string | null | undefined;
  if (body.validUntil !== undefined) {
    const raw = (body.validUntil ?? "").trim();
    if (raw === "") {
      validUntil = null;
    } else {
      const d = new Date(raw);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ ok: false, error: "Enter a valid expiry date." }, { status: 400 });
      }
      validUntil = d.toISOString();
    }
  }

  const title = body.title !== undefined ? String(body.title).trim() : undefined;

  const result = await updateDB((db) => {
    const d = db.documents.find((x) => x.id === documentId);
    if (!d) return { notFound: true as const };

    // Archive / unarchive is a standalone op allowed on ANY document (including a
    // government-verified one): it only moves a past doc out of / back into the
    // active set, it does not rewrite issuer content — so it is NOT gated by the
    // government edit-lock below.
    if (body.archived !== undefined) {
      d.archived = body.archived === true;
      d.archivedAt = d.archived ? new Date().toISOString() : null;
      return { doc: d };
    }

    // Display rotation is a standalone, non-destructive op allowed on ANY document
    // (incl. government), same rationale as archive: it changes only how the image is
    // presented, never the issuer's content — so it is NOT gated by the government
    // edit-lock below. Any value other than a valid quarter-turn normalises to 0.
    if (body.rotation !== undefined) {
      d.rotation = (
        body.rotation === 90 || body.rotation === 180 || body.rotation === 270
          ? body.rotation
          : 0
      ) as 0 | 90 | 180 | 270;
      return { doc: d };
    }

    // §4.4 manual-verification workflow — a standalone agent-only op (role gate
    // above). Runs through the pure idempotent helpers: "request" never
    // overwrites an existing requestedAt (double-click / re-POST safe),
    // "confirm" never re-stamps an existing confirmation, "close" only closes
    // an OPEN request. Written inside this critical section only (plan §4.4).
    if (body.manualAction !== undefined) {
      if (d.source === "government") return { locked: true as const };
      if (body.manualAction === "request") requestManualVerification(d, actorName);
      else if (body.manualAction === "confirm")
        confirmManualVerification(d, actorName, (body.evidenceNote ?? "").trim());
      else closeManualVerification(d);
      return { doc: d };
    }

    if (d.source === "government") return { locked: true as const };

    if (validUntil !== undefined) {
      d.validUntil = validUntil;
      d.isValid = validUntil ? new Date(validUntil).getTime() > Date.now() : null;
      // The seaman just typed/confirmed this date by hand — it is no longer an
      // untrusted OCR guess, so the badge may leave the "expiry unread" state.
      d.expiryConfirmed = true;
    }
    // Feature 3 — "No end date" flag. Applied AFTER the validUntil edit so it wins:
    // a perpetual doc has no expiry, is confirmed (not an OCR guess) and is valid.
    if (body.noExpiry === true) {
      d.noExpiry = true;
      d.validUntil = null;
      d.expiryConfirmed = true;
      d.isValid = true; // perpetual = valid
    } else if (body.noExpiry === false) {
      d.noExpiry = false;
    }
    if (title !== undefined && title) {
      d.title = title;
      d.docType = "Certificate photo";
    }
    // Reviewer sign-off: a human opened the actual document and confirmed the
    // name + expiry. Records who/when for the audit trail. This is a reviewer
    // check on a non-government doc — it does NOT make the doc registry-verified.
    // AGENT-ONLY: a seaman self-service (token) caller must not be able to stamp
    // their own document as "checked by reviewer" — that would forge an audit fact.
    if (body.reviewerChecked === true && isAgent) {
      d.reviewerChecked = true;
      d.checkedBy = (body.checkedBy ?? "").trim() || null;
      d.checkedAt = new Date().toISOString();
      // §4.3 — record HOW the check was performed (validated + role-gated
      // above): "registry-portal" flips the badge label to "Checked against
      // registry" (still blue, never emerald). Absent = legacy eyeball check.
      if (body.checkedVia !== undefined) {
        d.checkedVia = body.checkedVia as "document" | "registry-portal";
      }
    }
    d.requiredType = classifyRequiredType({ title: d.title, docType: d.docType });
    // A seaman who names/dates a previously-unclassified photo can now fill a
    // required slot — clear any matching pending document-request in the same pass.
    const clearedRequestIds = autoClearForDoc(db.docRequests, d.seafarerId, d);
    // Feature 1+2 — return the fresh checklist so the naming/dating flow can update
    // the panel without a reload, mirroring the POST path.
    const docRequests = db.docRequests.filter((r) => r.seafarerId === d.seafarerId);
    return { doc: d, clearedRequestIds, docRequests };
  });

  if ("notFound" in result) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }
  if ("locked" in result) {
    return NextResponse.json(
      { ok: false, error: "Registry-verified documents can't be edited." },
      { status: 403 }
    );
  }
  // Feature 1+2 — surface any checklist clears from the naming/dating pass. Absent
  // on the standalone archive / rotation / manual-verification branches.
  const clearedRequestIds = "clearedRequestIds" in result ? result.clearedRequestIds ?? [] : [];
  const docRequests: DocRequest[] = "docRequests" in result ? result.docRequests ?? [] : [];
  return NextResponse.json({ ok: true, document: result.doc, clearedRequestIds, docRequests });
}

// DELETE /api/documents  { documentId, token? }
//
// Permanently remove a document the seaman uploaded by mistake — the record, its
// uploaded file on disk (if any) and its comment thread. Authorised EXACTLY like the
// PATCH edit above (fail-closed): a signed-in agent with a LIVE grant to the doc's
// owner, OR a ?token in the body matching the OWNER's share token. Anything else =>
// 404 with no delete. A seaman can only ever delete THEIR OWN document.
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    documentId?: string;
    token?: string;
  };
  const documentId = (body.documentId ?? "").trim();
  if (!documentId) {
    return NextResponse.json({ ok: false, error: "documentId is required." }, { status: 400 });
  }

  // Same two-trust-model authorisation as PATCH, before any mutation.
  const targetDoc = readDB().documents.find((d) => d.id === documentId) ?? null;
  const owner = targetDoc?.seafarerId ?? null;
  const session = await agentSession();
  const token = (body.token ?? "").trim();
  const tokenSubject = token ? resolveTokenSubject(readDB(), token, "write", ["open"]) : null;
  const tokenAuthorises =
    !!owner &&
    !!tokenSubject &&
    tokenSubject !== SAMPLE_WRITE_DENIED &&
    tokenSubject.seafarer.id === owner;
  // CANONICAL ACTOR ORDER (F3, findings 8 + 19) — see the POST handler above. Token
  // resolution goes through the sample chokepoint (open token only; a sample subject's
  // token write-DENYs -> 403).
  let isAgent = !!session?.user;
  if (isAgent) {
    if (!owner || !checkAccess(session!.agentId, owner).allowed) {
      return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
    }
    const billingGate = requireBillingWritable(session);
    if (!billingGate.ok) {
      if (!tokenAuthorises) return billingGate.response;
      isAgent = false;
    }
  } else if (tokenSubject === SAMPLE_WRITE_DENIED) {
    return sampleReadOnlyResponse();
  }
  if (!isAgent && !tokenAuthorises) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }
  // SAMPLE GUARD (census row 2): a CURATED sample document is immutable for
  // everyone — agents included. (An agent's OWN non-curated upload to a sample
  // subject stays editable/deletable as usual.)
  if (targetDoc?.sample === true) {
    return sampleReadOnlyResponse();
  }

  // Remove the record + its comment thread atomically; capture the file to unlink.
  const outcome = await updateDB((db) => {
    const doc = db.documents.find((d) => d.id === documentId);
    if (!doc) return { notFound: true as const };
    const fileName = doc.fileName;
    db.documents = db.documents.filter((d) => d.id !== documentId);
    db.comments = db.comments.filter((c) => c.documentId !== documentId);
    return { fileName };
  });

  if ("notFound" in outcome) {
    return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
  }

  // Remove the uploaded file from disk (belt-and-braces basename guard). Best-effort:
  // a missing/locked file must not fail the delete — the record is already gone.
  if (outcome.fileName) {
    try {
      const p = path.join(UPLOAD_DIR, path.basename(outcome.fileName));
      if (p.startsWith(UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore — record + thread already removed */
    }
  }

  return NextResponse.json({ ok: true, deleted: documentId });
}
