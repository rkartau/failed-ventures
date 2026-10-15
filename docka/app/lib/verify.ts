// Server-side verification + persistence/identity layer. The actual registry
// lookup lives in the pluggable VerifierRegistry (lib/registry/ — Estonia is
// adapter #1); this module keeps the legacy `verifyCode` entry point plus the
// country-agnostic persistence helpers (newVerifiedDoc, holder snapshots,
// identity self-heal, photo caching). Shared by the public /api/cert route and
// the seafarer document-upload route (auto-verify).

import {
  CATEGORY_LABELS,
  type CertResult,
  type VerifiedCert,
} from "@/lib/cert";
import { verifyCapabilityToken } from "@/lib/registry";
import { id, readDB, updateDB, type Doc, type Seafarer } from "@/lib/db";
import { classifyRequiredType } from "@/lib/doctypes";
import fs from "fs";
import path from "path";
import {
  UPLOAD_DIR,
  MAX_PHOTO_BYTES,
  extForImageType,
  extFromMagic,
} from "@/lib/profile-photo";

// EXACT legacy signature — now a thin wrapper over the registry dispatcher
// (plan §2.1). Dispatches ONLY capability-token lookup modes (the EE access
// token today), so this context-less entry point — used by recognize.ts,
// verify-record.ts, the backfill loops and the routes — can never mint an
// unbound public-identifier verification. EE inputs return byte-identical
// results to the pre-refactor loop (same endpoint order, same error strings).
export async function verifyCode(rawInput: string): Promise<CertResult> {
  return verifyCapabilityToken(rawInput);
}

// Build a stored Doc from a successful verification. Shared by the document
// upload route and the profile-bootstrap route so both fill the exact same
// auto-detected title / category / validity / expiry — the seafarer never types
// a title, type or date.
export function newVerifiedDoc(
  seafarerId: string,
  result: VerifiedCert,
  opts?: { title?: string; fileName?: string | null; originalName?: string }
): Doc {
  const title =
    (opts?.title ?? "").trim() || result.title || CATEGORY_LABELS[result.docCategory];
  const docType = CATEGORY_LABELS[result.docCategory];
  const doc: Doc = {
    id: id(),
    seafarerId,
    title,
    docType,
    docCategory: result.docCategory,
    estonianCode: result.code,
    certNumber: result.code, // the registry access code is this doc's comparable number
    isValid: result.isValid,
    validUntil: result.validUntil || null,
    expiryConfirmed: true, // the registry is the authority on this date
    fileName: opts?.fileName ?? null,
    createdAt: new Date().toISOString(),
    // §2.5 source semantics: "government" for flag-state verifications that
    // passed holder binding; "registry" for presence-only / training-center
    // confirmations (holder not verified — teal badge, never emerald).
    source: result.verifiedSource,
    registryCountry: result.registryCountry,
    requiredType: classifyRequiredType({ title, docType, docCategory: result.docCategory }),
    reviewStatus: "pending",
  };
  if (opts?.originalName) doc.originalName = opts.originalName;
  // Snapshot the registry holder identity onto the document itself, so the
  // owner-profile self-heal can adopt it later without re-fetching the registry.
  applyVerifiedHolderToDoc(doc, result);
  return doc;
}

// The subset of a verified result needed to name a profile / stamp a holder. Both a
// live VerifiedCert and a holder snapshot rehydrated from a Doc satisfy this shape.
export type VerifiedHolder = {
  hasName: boolean;
  fullName: string;
  personalCode?: string | null;
  birthDate?: string | null;
  photoUrl?: string | null;
  issuerCountry?: string | null;
  /**
   * §2.5 trust class of the lookup mode that produced this holder. The
   * applyVerifiedIdentity gate is STRICT: only "capability-token" may self-heal
   * a profile — undefined does NOT pass (safe: §4.10 persistence + the readDB
   * migration guarantee the field exists on every rehydrated snapshot).
   */
  keyTrust?: "capability-token" | "public-identifier";
};

// Snapshot the registry-returned holder identity ONTO a document. Called on EVERY
// government verification of that document (fresh add, QR photo, bootstrap, and the
// re-verify/duplicate path). Always stamps `verifiedResolvedAt` so the owner
// self-heal never re-fetches this doc again. A name-less (medical MinimalDocument)
// result carries no name, so it captures only whatever identity data it has and
// NEVER overwrites a previously-captured good name with a blank.
export function applyVerifiedHolderToDoc(doc: Doc, cert: VerifiedCert): void {
  doc.verifiedResolvedAt = new Date().toISOString();
  // §4.10 — persist the trust class of the lookup mode ON the snapshot (also
  // for name-less results), so a holder rehydrated later still carries it and
  // the strict applyVerifiedIdentity gate can never be bypassed by rehydration.
  doc.verifiedKeyTrust = cert.keyTrust;
  if (!cert.hasName || !cert.fullName) {
    if (cert.personalCode) doc.verifiedPersonalCode = cert.personalCode;
    if (cert.birthDate) doc.verifiedBirthDate = cert.birthDate;
    if (cert.issuerCountry) doc.verifiedIssuerCountry = cert.issuerCountry;
    return;
  }
  doc.verifiedFirstName = cert.firstName || null;
  doc.verifiedLastName = cert.lastName || null;
  doc.verifiedFullName = cert.fullName;
  doc.verifiedPersonalCode = cert.personalCode || null;
  doc.verifiedBirthDate = cert.birthDate || null;
  doc.verifiedPhotoUrl = cert.photoUrl || null;
  doc.verifiedIssuerCountry = cert.issuerCountry || null;
}

// Rehydrate a holder snapshot from a document's stored verified* fields.
// Exported for the §6.1 unit tests (keyTrust persistence round-trip).
export function holderFromDoc(doc: Doc): VerifiedHolder {
  return {
    hasName: !!doc.verifiedFullName,
    fullName: doc.verifiedFullName ?? "",
    personalCode: doc.verifiedPersonalCode ?? null,
    birthDate: doc.verifiedBirthDate ?? null,
    photoUrl: doc.verifiedPhotoUrl ?? null,
    issuerCountry: doc.verifiedIssuerCountry ?? null,
    // §4.10 — the readDB migration guarantees this exists on every government
    // row (legacy rows default "capability-token"), so the strict identity
    // gate keeps healing pre-migration EE snapshots.
    keyTrust: doc.verifiedKeyTrust,
  };
}

// Write the registry-returned holder identity onto the seaman's OWN profile as the
// AUTHORITATIVE maritime identity. Called server-side inside the write critical
// section whenever a government verification succeeds for one of the seaman's docs.
//
// A name-less model (a medical MinimalDocumentModel) cannot name the profile, so it
// leaves the identity untouched — we never blank a good verified name with a later
// name-less verification. A named verification (competency / endorsement /
// qualification) sets/refreshes every field; the MOST RECENT named verification wins
// (they agree in practice). Returns true when it applied an identity.
export function applyVerifiedIdentity(seafarer: Seafarer, cert: VerifiedHolder): boolean {
  // §2.5 rule 1 — THE keyTrust gate, enforced INSIDE the single choke point
  // every consumer imports (never by caller discipline): only a
  // capability-token verification (an unguessable secret only the holder/paper
  // has) may write profile identity. A public-identifier lookup (a key printed
  // on the cert, knowable by a third party) is a strict no-op here — and so is
  // an absent keyTrust (fail closed; §4.10 guarantees the field on every
  // legitimate snapshot).
  if (cert.keyTrust !== "capability-token") return false;
  if (!cert.hasName || !cert.fullName) return false;
  seafarer.identityVerified = true;
  seafarer.identityVerifiedAt = new Date().toISOString();
  seafarer.verifiedName = cert.fullName;
  seafarer.personalCode = cert.personalCode || null;
  seafarer.birthDate = cert.birthDate || null;
  seafarer.photoUrl = cert.photoUrl || null;
  seafarer.issuerCountry = cert.issuerCountry || null;
  return true;
}

// Self-healing back-fill of the OWNER's verified identity.
//
// Called server-side ONLY when the owner loads their OWN profile (the ?token= GET
// and /api/seafarers/me). If the profile is already identity-verified, or the owner
// has no government-verified document, it does nothing. Otherwise it populates the
// profile from a government-verified document — preferring a holder snapshot already
// stored on a doc, and ONLY if none exists re-resolving the doc's registry code once
// (caching the result on the doc via `verifiedResolvedAt` so it is never re-fetched
// on later loads). Strictly scoped to `seafarerId` — it never touches another
// seafarer and grants no agent scope. Best-effort: any registry/network failure
// leaves the profile untouched and is retried on the next load.
export async function backfillOwnerIdentity(seafarerId: string): Promise<void> {
  await backfillIdentityOnly(seafarerId);
  // Persist the verified photo LOCALLY (idempotent, cached once stored). Runs on
  // EVERY owner load — even for an already-identity-verified profile — so a profile
  // verified before this feature existed still gets its durable local photo. The raw
  // registry URL is never displayed; only the local file is served.
  await ensureVerifiedPhotoStored(seafarerId);
}

async function backfillIdentityOnly(seafarerId: string): Promise<void> {
  const db = readDB();
  const sf = db.seafarers.find((s) => s.id === seafarerId);
  if (!sf || sf.identityVerified) return;

  // §5.4 EE-ONLY GATE: registry re-fetch + identity backfill run ONLY for
  // Estonian docs (capability token, recheckable, and the only registry class
  // that may heal identity — §2.5 rule 1). A profile holding only non-EE
  // (public-identifier) verified docs performs ZERO registry fetches and ZERO
  // db writes on an owner load — it never fans out to foreign registries.
  // The readDB migration guarantees registryCountry on every government row.
  const govDocs = db.documents.filter(
    (d) =>
      d.seafarerId === seafarerId &&
      d.source === "government" &&
      !!d.estonianCode &&
      d.registryCountry === "EE"
  );
  if (govDocs.length === 0) return;

  // Fast path: a document already carries a captured holder name — adopt it with no
  // network call. Most-recent capture wins (they agree in practice). keyTrust-aware
  // skip (§5.4): only a capability-token snapshot can pass the applyVerifiedIdentity
  // gate, so a public-identifier snapshot must not trigger a pointless write.
  const stored = govDocs
    .filter((d) => d.verifiedFullName && d.verifiedKeyTrust === "capability-token")
    .sort((a, b) => (b.verifiedResolvedAt ?? "").localeCompare(a.verifiedResolvedAt ?? ""))[0];
  if (stored) {
    await updateDB((d) => {
      const s = d.seafarers.find((x) => x.id === seafarerId);
      const doc = d.documents.find((x) => x.id === stored.id);
      if (s && !s.identityVerified && doc) applyVerifiedIdentity(s, holderFromDoc(doc));
    });
    return;
  }

  // Slow path: no snapshot yet (e.g. a doc verified before this field existed).
  // Re-resolve each un-resolved government code against the registry ONCE; the first
  // that yields a name sets the identity. Every resolved doc is stamped so it is not
  // re-fetched on the next load, even when the model is name-less (medical).
  const toResolve = govDocs.filter((d) => !d.verifiedResolvedAt);
  for (const target of toResolve) {
    const res = await verifyCode(target.estonianCode as string);
    if (!res.ok) continue; // registry unreachable — leave un-stamped, retry next load
    const done = await updateDB((d) => {
      const s = d.seafarers.find((x) => x.id === seafarerId);
      const doc = d.documents.find((x) => x.id === target.id);
      if (!s || !doc) return false;
      applyVerifiedHolderToDoc(doc, res); // caches holder + verifiedResolvedAt
      if (s.identityVerified) return true; // already set by a concurrent path
      return applyVerifiedIdentity(s, res); // true only when the cert carried a name
    });
    if (done) return; // identity populated — stop resolving further docs
  }
}

// Download an image URL to a Buffer with a short timeout and a hard size cap. Returns
// null (never throws) on any failure — a non-image content-type, a non-200, an over-cap
// body, an expired signed URL, or a network error — so a failed fetch is a graceful
// no-op the caller retries on the next load.
async function downloadImage(url: string): Promise<{ buf: Buffer; ext: string } | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_PHOTO_BYTES) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > MAX_PHOTO_BYTES) return null;
    const buf = Buffer.from(ab);
    // Decide the type from the declared content-type OR the magic bytes. The registry
    // serves its photo as application/octet-stream, so we must sniff the bytes; either
    // way a non-image body is refused.
    const ext = extForImageType(res.headers.get("content-type")) ?? extFromMagic(buf);
    if (!ext) return null;
    return { buf, ext };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// Ensure the seaman's government-verified photo is stored LOCALLY under uploads/, so
// it can be shown durably (the registry URL is a time-limited signed URL that expires).
//
// Idempotent + cached: if a local verified photo file already exists on disk it does
// nothing. Otherwise it tries the registry URL already captured on the profile
// (`photoUrl`); if that fails/expired it re-resolves ONE government document's code
// against the registry to obtain a FRESH signed URL, then downloads that. On success
// it stores the bytes and records the local filename; on any failure it leaves the
// profile untouched (retried on the next owner load). Owner-scoped to `seafarerId`.
export async function ensureVerifiedPhotoStored(seafarerId: string): Promise<void> {
  const db = readDB();
  const sf = db.seafarers.find((s) => s.id === seafarerId);
  if (!sf) return;

  // Already cached and the file is present on disk — nothing to do.
  if (sf.verifiedPhotoFile) {
    const existing = path.join(UPLOAD_DIR, path.basename(sf.verifiedPhotoFile));
    if (existing.startsWith(UPLOAD_DIR) && fs.existsSync(existing)) return;
  }

  // 1) Try the registry URL already captured on the profile.
  let dl = sf.photoUrl ? await downloadImage(sf.photoUrl) : null;
  let refreshedUrl: string | null = null;

  // 2) Expired/missing/none → re-resolve the government code(s) to get a FRESH signed
  //    URL, then download from it. Try each government document (a name-less medical
  //    carries no photo, so we must not stop at the first code) — preferring a doc that
  //    previously carried a photo, then by recency — until one yields a downloadable
  //    image.
  if (!dl) {
    // §5.4 EE-ONLY GATE (same as backfillIdentityOnly): only the Estonian
    // registry serves holder photos, and only its capability-token codes are
    // recheckable — a non-EE-only profile triggers no registry fetch here.
    const govDocs = db.documents
      .filter(
        (d) =>
          d.seafarerId === seafarerId &&
          d.source === "government" &&
          !!d.estonianCode &&
          d.registryCountry === "EE"
      )
      .sort(
        (a, b) =>
          Number(!!b.verifiedPhotoUrl) - Number(!!a.verifiedPhotoUrl) ||
          (b.verifiedResolvedAt ?? "").localeCompare(a.verifiedResolvedAt ?? "")
      );
    for (const gd of govDocs) {
      const res = await verifyCode(gd.estonianCode as string);
      if (res.ok && res.photoUrl) {
        const got = await downloadImage(res.photoUrl);
        if (got) {
          dl = got;
          refreshedUrl = res.photoUrl;
          break;
        }
      }
    }
  }

  if (!dl) return; // best-effort — nothing to store this load

  const fileName = `profile-${seafarerId}-verified${dl.ext}`;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), dl.buf);
  } catch {
    return; // disk failure — leave untouched, retry next load
  }

  await updateDB((d) => {
    const s = d.seafarers.find((x) => x.id === seafarerId);
    if (!s) return;
    s.verifiedPhotoFile = fileName;
    // Keep the freshest signed URL on the profile too (used only as a re-download
    // source; it is never displayed to a viewer).
    if (refreshedUrl) s.photoUrl = refreshedUrl;
  });
}
