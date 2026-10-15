// Outward, public single-cert RE-VERIFICATION (roadmap T1.4; increment 8 of the
// EU VerifierRegistry plan generalizes it beyond Estonia).
//
// docka verifies a certificate INWARD against the issuing country's registry
// (pluggable VerifierRegistry, lib/registry/). This module mints the OUTWARD
// proof: a tamper-evident, unguessable public token for a government-verified
// document that opens a minimal, privacy-safe confirmation page
// (/verify/<token>) any third party — a PSC officer, a shipowner, a non-tenant agent
// — can open with NO login to re-confirm the credential is registry-valid.
//
// TAMPER-EVIDENCE. The token is `<documentId>~<sig>` where `sig` is an HMAC-SHA256
// of the document id under the app's AUTH_SECRET. Nobody can forge a token for a
// document without the secret, and the id cannot be swapped without breaking the
// signature — so the page can only be reached via a link docka itself minted. The
// id is a random UUID (never PII), and the page/API deliberately expose LESS than the
// public government registry page already does (no personal code, no date of birth,
// no photo, no document file).
//
// LIVE RE-CHECK (§5.4). On every open the proof is re-confirmed LIVE against the
// issuing country's registry — keyed by the doc (`registryCountry` + the stored
// non-sensitive `registryInputs`), routed through the registry dispatcher's guarded
// fetch layer (rate limit + result cache, §2.4). Countries whose lookup needs
// UNSTORED sensitive inputs (`recheckable:false` — BG EGN, HR name split, a UK doc
// without its stored DOB) render an honest SNAPSHOT by design: the stored verified
// record + when it was verified + reVerified:false wording — no fetch attempted.
// If a recheckable registry is momentarily unreachable the page falls back to the
// stored government-verified snapshot and says so honestly, rather than failing shut.

import crypto from "crypto";
import { readDB, type DB, type Doc, type Seafarer } from "@/lib/db";
import {
  verificationLevelForDoc,
  docLevelTooltip,
  type VerificationLevel,
} from "@/lib/verification-level";
import { recheckStoredLookup } from "@/lib/registry";
import { countryEntry } from "@/lib/registry/countries";
import type { CountryEntry } from "@/lib/registry/types";
import {
  CATEGORY_LABELS,
  publicUrl,
  type DocCategory,
  type VerifiedCert,
} from "@/lib/cert";
import {
  classifyCertRule,
  computeLegalExpiry,
  effectiveValidUntil,
} from "@/lib/cert-rules";

const SIGNING_SECRET = process.env.AUTH_SECRET ?? "docka-dev-verify-secret";

/** HMAC-SHA256(documentId) truncated to 24 hex chars — the tamper-evidence tag. */
function sign(documentId: string): string {
  return crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(`verify:${documentId}`)
    .digest("hex")
    .slice(0, 24);
}

/** Mint the public verification token for a document id: `<id>~<sig>`. */
export function mintVerifyToken(documentId: string): string {
  return `${documentId}~${sign(documentId)}`;
}

/** The site-relative path of a document's public re-verification page. */
export function publicVerifyPath(documentId: string): string {
  return `/verify/${mintVerifyToken(documentId)}`;
}

/**
 * Resolve a public token back to its document id, or null when the token is
 * malformed or its signature does not match (forged / tampered). Constant-time
 * signature compare.
 */
export function resolveVerifyToken(token: string): string | null {
  if (!token) return null;
  const sep = token.lastIndexOf("~");
  if (sep <= 0) return null;
  const documentId = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  const expected = sign(documentId);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return documentId;
}

// ---- Public, privacy-safe proof shape ---------------------------------

export type PublicProof = {
  /** Effective LEGAL validity (age-shortened where the rule applies), live when reachable. */
  valid: boolean;
  /** Registry holder name — already public on the government registry page; no other PII. */
  holderName: string | null;
  /** Human title of the certificate (e.g. its legal name). */
  certificateTitle: string;
  /** Certificate category label (Certificate of competency / Medical / …). */
  category: string;
  /** Rank / position the credential holder serves in, when known. */
  rank: string | null;
  /** Issuing authority, e.g. "Republic of Estonia — Transpordiamet (issued in Eesti)". */
  issuedBy: string;
  /** What it was verified against (the registry), in words. */
  verifiedAgainst: string;
  /** The public government registry page for this certificate (external, authoritative). */
  registryUrl: string;
  /** Effective LEGAL expiry (ISO yyyy-mm-dd), when the certificate carries one. */
  expiry: string | null;
  /** Printed/registry expiry when it differs from the legal one (age-shortened medicals). */
  printedExpiry: string | null;
  /** Short human note when the legal expiry is earlier than the printed one. */
  legalNote: string | null;
  /** Instant this re-verification was produced. */
  verifiedAt: string;
  /** True when the LIVE registry re-check succeeded on THIS request. */
  reVerified: boolean;
  /** ISO-2 issuing registry country (drives the per-country proof naming). */
  registryCountry: string;
  /**
   * How the live re-check went (§5.4):
   *   "live"         — re-confirmed against the registry on THIS request;
   *   "snapshot"     — live re-check not available for this registry BY DESIGN
   *                    (`recheckable:false` / required lookup inputs unstored);
   *   "rate-limited" — §2.4 over-limit; stored record shown, NO fetch;
   *   "unreachable"  — the registry gave no usable answer just now.
   */
  recheckState: "live" | "snapshot" | "rate-limited" | "unreachable";
  /**
   * F10e — the "live" answer came from the short-TTL result cache (fresh to
   * within minutes, NOT this instant). The page words it "confirmed in the
   * last few minutes", never "just now".
   */
  liveCached: boolean;
  /** Instant this credential was last verified against the registry (for the snapshot wording). */
  verifiedOn: string | null;
  /** #30 verification level of the proven document (always 3 — a proof is L3-only). */
  level: VerificationLevel;
  /** #30 identity-bound vs holder-bound tooltip for the level badge. */
  levelTooltip: string;
};

// Per-country issuer line (§5.4): the issuing authority from the registry table,
// plus the credential's institution when it adds information.
function fullIssuer(entry: CountryEntry | undefined, institution: string | null | undefined): string {
  const auth = entry?.authority ?? "Issuing maritime authority";
  const inst = (institution ?? "").trim();
  const parts = [auth];
  if (inst && !auth.toLowerCase().includes(inst.toLowerCase()) && !/transpordiamet/i.test(inst)) {
    parts.push(inst);
  }
  return parts.join(" · ");
}

// Per-country "verified against" line — names the ACTUAL registry (authority +
// its pinned public portal host from countries.ts).
function registryNameFor(entry: CountryEntry | undefined): string {
  if (!entry) return "the issuing authority's official registry";
  let host = "";
  try {
    host = new URL(entry.portalUrl).hostname;
  } catch {
    host = "";
  }
  return host ? `${entry.authority} (${host})` : entry.authority;
}

// §5.4 widened proof guard: a proof exists ONLY for a government-verified doc
// (source:"registry" — BG presence / training-center — never mints one) that
// carries a registry country AND a stored lookup key (access code or inputs).
function proofEligible(doc: Doc): boolean {
  if (doc.source !== "government" || !doc.registryCountry) return false;
  return !!doc.estonianCode || Object.keys(doc.registryInputs ?? {}).length > 0;
}

/**
 * Build the minimal public proof for a government-verified document, RE-CHECKING it
 * live against the registry. Returns null when the token is invalid, the document is
 * missing, or the document is not a government-verified credential (nothing to prove).
 */
export async function buildPublicProof(
  token: string,
  opts?: { clientIp?: string }
): Promise<PublicProof | null> {
  const documentId = resolveVerifyToken(token);
  if (!documentId) return null;

  const db = readDB();
  const doc: Doc | undefined = db.documents.find((d) => d.id === documentId);
  if (!doc) return null;
  // Only government-verified credentials carry an outward proof (§5.4 widened
  // guard — source:"registry" docs and docs without a stored lookup key never do).
  if (!proofEligible(doc)) return null;

  const entry = countryEntry(doc.registryCountry as string);
  const seafarer: Seafarer | undefined = db.seafarers.find((s) => s.id === doc.seafarerId);
  const category = (doc.docCategory ?? "competency") as DocCategory;

  // Holder DOB (for the age-based legal-expiry rule) — prefer the doc snapshot, then
  // the profile. Never surfaced to the viewer; used only to compute legal validity.
  const holderDOB = doc.verifiedBirthDate ?? seafarer?.birthDate ?? null;

  // LIVE re-check (§5.4): keyed by the doc — registryCountry + stored non-sensitive
  // registryInputs — through the registry dispatcher's guarded fetch layer (rate
  // limit + result cache, §2.4). recheckable:false / missing stored inputs →
  // honest snapshot by design; over-limit → friendly snapshot, NO fetch. On a live
  // answer we overlay the fresh registry fields; otherwise the stored snapshot stands.
  let live: VerifiedCert | null = null;
  let recheckState: PublicProof["recheckState"] = "snapshot";
  let liveCached = false;
  if (doc.estonianCode) {
    const re = await recheckStoredLookup({
      country: doc.registryCountry as string,
      code: doc.estonianCode,
      inputs: doc.registryInputs ?? undefined,
      clientIp: opts?.clientIp,
    });
    recheckState = re.state;
    if (re.state === "live") {
      live = re.cert;
      liveCached = re.cached;
    }
  }

  const verifiedAt = new Date().toISOString();
  const registryUrl =
    live?.sourceUrl ||
    (doc.registryCountry === "EE" && doc.estonianCode
      ? publicUrl(category, doc.estonianCode)
      : entry?.portalUrl ?? "");
  const categoryLabel = live ? CATEGORY_LABELS[live.docCategory] : CATEGORY_LABELS[category];
  const certificateTitle = (live?.title || doc.title || categoryLabel).trim();
  const holderName = (live?.hasName ? live.fullName : null) || doc.verifiedFullName || null;

  // Effective LEGAL expiry. When live data is present, compute the legal window from
  // the live printed expiry + the classified rule; otherwise use the stored doc.
  let expiry: string | null;
  let printedExpiry: string | null;
  let legalNote: string | null = null;
  if (live) {
    const ruleType = classifyCertRule({
      title: live.title,
      certificateType: live.certificateType,
      docCategory: live.docCategory,
    });
    const info = computeLegalExpiry({
      ruleType,
      printedValidUntil: live.validUntil || null,
      issuedOn: live.issuedOn || null,
      holderDOB,
    });
    printedExpiry = info.printedValidUntil;
    expiry = info.legalValidUntil ?? printedExpiry;
    legalNote = info.differs ? info.reason : null;
  } else {
    printedExpiry = doc.validUntil ? doc.validUntil.slice(0, 10) : null;
    expiry = effectiveValidUntil(doc, holderDOB);
    if (expiry) expiry = expiry.slice(0, 10);
    legalNote = expiry && printedExpiry && expiry < printedExpiry
      ? "Legal expiry is earlier than the printed date (age-based validity rule)."
      : null;
  }

  // Validity: the registry's own isValid AND (when an expiry is known) that the
  // effective legal expiry is not in the past — so an age-shortened-but-registry-
  // "valid" medical still reads as expired here.
  const registryValid = live ? live.isValid : doc.isValid === true;
  const notLegallyExpired = expiry ? expiry >= verifiedAt.slice(0, 10) : true;
  const valid = registryValid && notLegallyExpired;

  return {
    valid,
    holderName,
    certificateTitle,
    category: categoryLabel,
    rank: seafarer?.rank?.trim() || null,
    issuedBy: fullIssuer(entry, live?.institution),
    verifiedAgainst: registryNameFor(entry),
    registryUrl,
    expiry,
    printedExpiry: printedExpiry && expiry && printedExpiry !== expiry ? printedExpiry : null,
    legalNote,
    verifiedAt,
    reVerified: recheckState === "live",
    registryCountry: doc.registryCountry as string,
    recheckState,
    liveCached,
    verifiedOn: doc.verifiedResolvedAt ?? doc.createdAt ?? null,
    level: verificationLevelForDoc(doc),
    levelTooltip: docLevelTooltip(doc),
  };
}

/**
 * Authorise minting a verify link for a document from a SHARE TOKEN the caller holds.
 * Returns the document id when `token` is any share token that already grants access
 * to the document's owning seafarer (the owner's own open/private/alias token, or an
 * agent access-grant token), the document belongs to that seafarer, AND it is a
 * government-verified credential. Null otherwise. This never resolves an agent SESSION
 * (so it stays outside the tenant-isolation gate) — it authorises purely by possession
 * of a token that already opens the seafarer's documents, and the verify link it
 * returns is public by design (strictly less sensitive than the documents themselves).
 */
/**
 * Shared eligibility core (D6 v4): is `documentId` a proof-mintable document
 * OWNED by `owner`? Single source for BOTH the route's chokepoint-resolved
 * seaman-token path and the grant-token path below — the proofEligible +
 * ownership + sample-curated rules can never drift between them.
 *
 * Public Sample Profiles (census row 8 FILTER): for a sample subject, proofs are
 * minted ONLY for curated (sample:true) documents — an agent's real upload onto
 * the flagship never gets a public verify link through the published token.
 */
export function proofDocIdForOwner(
  db: DB,
  owner: { id: string; isSample?: boolean } | null,
  documentId: string
): string | null {
  if (!owner || !documentId) return null;
  const doc = db.documents.find((d) => d.id === documentId);
  if (!doc || !proofEligible(doc)) return null;
  if (owner.id !== doc.seafarerId) return null;
  if (owner.isSample === true && doc.sample !== true) return null;
  return doc.id;
}

export function documentIdForShareToken(shareToken: string, documentId: string): string | null {
  if (!shareToken || !documentId) return null;
  const db = readDB();
  const ownerBySeamanToken = db.seafarers.find(
    (s) =>
      s.openShareToken === shareToken ||
      s.emailShareToken === shareToken ||
      s.shareToken === shareToken
  );
  const ownerByGrant = ownerBySeamanToken
    ? null
    : db.accessGrants.find((g) => g.shareToken === shareToken);

  const ownerSeafarerId = ownerBySeamanToken?.id ?? ownerByGrant?.seafarerId ?? null;
  if (!ownerSeafarerId) return null;
  const owner = db.seafarers.find((s) => s.id === ownerSeafarerId) ?? { id: ownerSeafarerId };
  return proofDocIdForOwner(db, owner, documentId);
}
