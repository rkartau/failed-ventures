// Cross-crew duplicate-certificate detection — client-safe (no Node built-ins).
//
// PSC fraud reality: the SAME certificate number turning up on two different
// crew members is a classic forged-STCW signal. A photo that "looks fine" is not
// proof; a duplicate number across the fleet is a concrete, checkable red flag we
// CAN compute even without an issuer API. This works for BOTH registry-verified
// docs (whose number is the registry access code) and photo/OCR docs (whose
// number is read best-effort off the certificate, stored as `certNumber`).
//
// COUNTRY SCOPING (plan §4.9): certificate-number formats collide across
// countries — the same number string issued by two DIFFERENT registries is NOT
// a duplicate. The comparison therefore carries `registryCountry`, with a
// NULL-WILDCARD anti-fraud rule: a doc with no known country (photo/OCR)
// matches ANY country, so the forgery banner still fires against it. Only two
// DIFFERENT non-null countries are non-duplicates. The index KEY stays the
// normalized number ALONE (never country-suffixed — that would break the
// wildcard); the country lives in the VALUE entries and is applied per-doc.

import type { Doc, Seafarer } from "@/lib/db";
import { nameNearExact, nameFuzzy, foldDiacritics } from "@/lib/fuzzy-name";

// Normalise a certificate/registration number for comparison: upper-case, strip
// everything but letters+digits, so "ABC-1234 / 2021" and "abc1234 2021" collide.
export function normNumber(v?: string | null): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The comparable number for a document: its OCR-read cert number, else its
// registry code. Empty when we have neither.
export function docNumber(d: Doc): string {
  return normNumber(d.certNumber ?? d.estonianCode ?? null);
}

// §4.9 null-wildcard rule, the single comparison every dedupe surface uses:
// null (unknown country — photo/OCR docs) matches ANY country; only two
// DIFFERENT non-null countries make the same number NOT a duplicate.
export function registryCountriesCompatible(
  a?: string | null,
  b?: string | null
): boolean {
  return a == null || b == null || a === b;
}

/** One fleet-index entry: who carries the number, under which registry. */
export type DuplicateEntry = { seafarerId: string; registryCountry: string | null };

/** One name-index entry a client card can render + country-filter on. */
export type DuplicateNameEntry = { name: string; registryCountry: string | null };

/** number -> entries; the serialisable index handed to client components. */
export type DuplicateNameIndex = Record<string, DuplicateNameEntry[]>;

// number -> the (seafarer, registryCountry) pairs carrying a document with that
// number. One entry per DISTINCT (seafarerId, registryCountry) combination —
// the key stays the normalized number alone (§4.9).
export function buildDuplicateIndex(docs: Doc[]): Map<string, DuplicateEntry[]> {
  const acc = new Map<string, Map<string, DuplicateEntry>>();
  for (const d of docs) {
    const n = docNumber(d);
    if (n.length < 5) continue; // too short to be a meaningful cert number
    const country = d.registryCountry ?? null;
    // Country codes are ISO-2 upper (never contain "|"), so this key is unambiguous.
    const pairKey = `${d.seafarerId}|${country ?? ""}`;
    if (!acc.has(n)) acc.set(n, new Map());
    const perNumber = acc.get(n)!;
    if (!perNumber.has(pairKey)) {
      perNumber.set(pairKey, { seafarerId: d.seafarerId, registryCountry: country });
    }
  }
  const out = new Map<string, DuplicateEntry[]>();
  for (const [n, pairs] of acc) out.set(n, [...pairs.values()]);
  return out;
}

// Build a plain map (number -> {name, registryCountry} entries) that a server
// component can serialise and hand to a client card, so the client can flag a
// duplicate without re-scanning the whole fleet. Only numbers shared by ≥2
// DISTINCT seafarers land in the map; the per-doc country filtering (null
// wildcard) happens downstream in duplicateOthers().
export function duplicateNameIndex(
  docs: Doc[],
  seafarerName: (id: string) => string
): DuplicateNameIndex {
  const idx = buildDuplicateIndex(docs);
  const out: DuplicateNameIndex = {};
  for (const [n, entries] of idx) {
    const distinctSeafarers = new Set(entries.map((e) => e.seafarerId));
    if (distinctSeafarers.size < 2) continue;
    out[n] = entries.map((e) => ({
      name: seafarerName(e.seafarerId),
      registryCountry: e.registryCountry,
    }));
  }
  return out;
}

// For one document + a duplicate name-index, the OTHER crew names sharing its
// number (excluding the doc's own seafarer). Empty when it is not a duplicate.
//
// COUNTRY SCOPING (§4.9): entries whose registryCountry is a DIFFERENT non-null
// country than this doc's are skipped (not duplicates); a null on either side
// is a wildcard match, so photo/OCR docs still flag against verified ones.
//
// GOVERNMENT-VERIFIED SUPPRESSION: a document whose source is "government" was
// confirmed genuine + its true holder established by the issuing registry (the
// emerald "Verified" state, `d.source === "government"` — the SAME check the
// verified pill uses in DocViewer / AgentDocList / ReviewPanel). Once the registry
// has verified ownership, a shared certificate number is NOT a forgery signal on
// THIS document, so it must never carry the "Possible forgery" banner or the
// "Possible duplicate" attention row. We still leave government docs IN the
// fleet-wide index (buildDuplicateIndex), so a NON-verified doc that shares the
// number with a verified one still flags — the duplicate/forgery signal remains a
// legitimate fraud check for photo/unverified documents. This single guard
// suppresses everywhere, because both the per-doc banner and the
// assignmentBlockers() forgery path funnel through duplicateOthers().
// NOTE: `source:"registry"` (holder NOT verified) deliberately does NOT get
// this suppression — a registry-confirmed document proves existence, not
// ownership, so the forgery signal must keep firing on it.
export function duplicateOthers(
  d: Doc,
  index: DuplicateNameIndex,
  ownName: string
): string[] {
  if (d.source === "government") return [];
  const n = docNumber(d);
  const entries = index[n];
  if (!entries) return [];
  const myCountry = d.registryCountry ?? null;
  // Remove one instance of the owner's own name; anything left is a real clash.
  const others: string[] = [];
  let skippedOwn = false;
  for (const e of entries) {
    if (!registryCountriesCompatible(myCountry, e.registryCountry)) continue;
    if (!skippedOwn && e.name === ownName) {
      skippedOwn = true;
      continue;
    }
    others.push(e.name);
  }
  return others;
}

// ---- Same-seafarer upload dedupe (moved from api/documents/route.ts) -----
//
// A seaman re-uploading the same certificate must not create a second row.
// Signature priority (highest-confidence first):
//   1. government registry code (estonianCode) — an authority-issued identity.
//   2. printed certificate number, OR a (title + expiry) pair — a strong content
//      match for a manual/photo doc that carries no code.
//   3. SHA-256 of the file bytes — the same file re-sent.
// This is deliberately SCOPED to one seafarer: the fleet-wide, CROSS-seafarer
// forgery detection (a shared cert number on two DIFFERENT crew) is the separate
// signal above and must keep flagging.
//
// COUNTRY SCOPING (§4.9): the number-based signatures (1, 2a) apply the same
// null-wildcard rule — the same number string under two DIFFERENT non-null
// registryCountry values is NOT a duplicate (both docs are kept). The
// content-based signatures (2b title+expiry, 3 file hash) are country-agnostic.
function normText(v?: string | null): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
export function isSameSeafarerDuplicate(
  existing: Doc,
  incoming: Doc,
  incomingHash: string | null
): boolean {
  const countriesOk = registryCountriesCompatible(
    existing.registryCountry ?? null,
    incoming.registryCountry ?? null
  );
  if (countriesOk) {
    // 1. government code
    const eCode = normNumber(incoming.estonianCode);
    if (eCode.length >= 5 && normNumber(existing.estonianCode) === eCode) return true;
    // 2a. printed certificate number (falls back to the registry code as its number)
    const cNum = normNumber(incoming.certNumber ?? incoming.estonianCode);
    if (cNum.length >= 5 && normNumber(existing.certNumber ?? existing.estonianCode) === cNum) {
      return true;
    }
  }
  // 2b. title + expiry — both must be present and match
  const title = normText(incoming.title);
  if (
    title &&
    incoming.validUntil &&
    normText(existing.title) === title &&
    existing.validUntil === incoming.validUntil
  ) {
    return true;
  }
  // 3. identical file bytes
  if (incomingHash && existing.fileHash && existing.fileHash === incomingHash) return true;
  return false;
}

// ---- Person-level duplicate detection (#37) ----------------------------
//
// PER-TENANT (never network-wide): the caller only ever passes its own grant-scoped
// roster. This adds transliteration-robust PERSON matching on top of the cert-number
// dedupe above. Corroboration is DELIBERATELY strict (#37.1): a merge is one-click
// mergeable ONLY when a unique identifier agrees, or DOB + a near-EXACT full name —
// twins / father-son Jr. (shared surname + DOB, different given name) are flag-only.

/** Cap a match field so a crafted long value can't blow up levenshtein (#3 critic). */
export const PERSON_FIELD_CAP = 128;
function cap(v: string | null | undefined): string {
  return (v ?? "").slice(0, PERSON_FIELD_CAP);
}

/** yyyy-mm-dd slice of a stored DOB, or null. */
function normDob(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export type PersonIdentity = {
  seafarerId: string;
  name: string;
  dob: string | null;
  personalCode: string | null;
  passportNo: string | null;
  seamanBookNo: string | null;
};

export type PersonMatch = {
  seafarerId: string;
  confidence: number;
  reasons: string[];
  /** #37.6 — a UNIQUE identifier agreed, OR DOB + near-EXACT full name (mergeable). */
  corroborated: boolean;
};

/**
 * Build a person identity for matching. Prefers the government-verified* holder snapshot
 * (on the seafarer / on a doc) over the typed/import profile. Tolerant of legacy rows with
 * NO birthDate/passportNo/mergedFrom (§#8 pre-migration fixture): every field defaults to
 * null with no throw. Fields are capped for the downstream string math.
 */
export function personIdentityOf(s: Seafarer, docs: Doc[]): PersonIdentity {
  const verifiedDobDoc = docs.find((d) => d.verifiedBirthDate);
  const verifiedCodeDoc = docs.find((d) => d.verifiedPersonalCode);
  return {
    seafarerId: s.id,
    name: cap(s.verifiedName || s.name || ""),
    dob: normDob(s.birthDate ?? verifiedDobDoc?.verifiedBirthDate ?? null),
    personalCode: normNumber(s.personalCode ?? verifiedCodeDoc?.verifiedPersonalCode ?? null) || null,
    passportNo: normNumber(s.passportNo ?? null) || null,
    seamanBookNo: normNumber(s.seamanBookNo ?? null) || null,
  };
}

function idAgrees(a: string | null, b: string | null): boolean {
  return !!a && !!b && a === b;
}

/** Folded, lower-cased tokens of a name; [] when empty. */
function nameTokens(s: string): string[] {
  return foldDiacritics(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Do two names share a SURNAME (last token)? Flags twins / father-son Jr. for REVIEW. */
function sharesSurname(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta[ta.length - 1] === tb[tb.length - 1];
}

/**
 * Score one target identity against a roster (deterministic 0–1), returning matches at or
 * above `min` (default 0.4), self-excluded, sorted desc. Scoring:
 *   personalCode exact          = 0.95  (corroborated)
 *   passport / seaman-book exact = 0.90  (corroborated)
 *   DOB exact + near-EXACT name  = 0.85  (corroborated — the narrow extra tier)
 *   DOB exact + fuzzy name only  = 0.60  (FLAG-ONLY — twins/Jr. safety)
 *   fuzzy name only              = 0.40  (FLAG-ONLY)
 */
export function personMatchCandidates(
  target: PersonIdentity,
  roster: PersonIdentity[],
  opts?: { min?: number }
): PersonMatch[] {
  const min = opts?.min ?? 0.4;
  const out: PersonMatch[] = [];
  for (const cand of roster) {
    if (cand.seafarerId === target.seafarerId) continue;
    const reasons: string[] = [];
    let confidence = 0;
    let corroborated = false;

    if (idAgrees(target.personalCode, cand.personalCode)) {
      confidence = Math.max(confidence, 0.95);
      corroborated = true;
      reasons.push("personal code matches");
    }
    if (
      idAgrees(target.passportNo, cand.passportNo) ||
      idAgrees(target.seamanBookNo, cand.seamanBookNo)
    ) {
      confidence = Math.max(confidence, 0.9);
      corroborated = true;
      reasons.push("passport / seaman's-book number matches");
    }

    const dobEqual = idAgrees(target.dob, cand.dob);
    if (dobEqual && nameNearExact(target.name, cand.name)) {
      confidence = Math.max(confidence, 0.85);
      corroborated = true;
      reasons.push("same date of birth and near-exact name");
    } else if (dobEqual && (nameFuzzy(target.name, cand.name) || sharesSurname(target.name, cand.name))) {
      // Flag-only tier (#37.1): same DOB + a similar-or-shared-surname name (twins /
      // father-son Jr.) surfaces for REVIEW but is never one-click mergeable.
      confidence = Math.max(confidence, 0.6);
      reasons.push("same date of birth and similar name — review before merge");
    } else if (nameFuzzy(target.name, cand.name)) {
      confidence = Math.max(confidence, 0.4);
      // #S14 — a low % on a same/similar name is not a bug; the reason explains WHY
      // it is weak (no shared identifier or documents), so the agent reviews first.
      reasons.push("similar name — no shared ID or documents yet (review before merge)");
    }

    if (confidence >= min) {
      out.push({ seafarerId: cand.seafarerId, confidence, reasons, corroborated });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Server-side re-derivation of the corroboration HARD-GATE (#37.6) from the two STORED
 * records — never trust a client-sent flag. Returns true ONLY when a unique identifier
 * agrees, or DOB + a near-EXACT full name. DOB-alone / name-only = false.
 */
export function corroboratedByStored(a: PersonIdentity, b: PersonIdentity): boolean {
  if (idAgrees(a.personalCode, b.personalCode)) return true;
  if (idAgrees(a.passportNo, b.passportNo)) return true;
  if (idAgrees(a.seamanBookNo, b.seamanBookNo)) return true;
  if (idAgrees(a.dob, b.dob) && nameNearExact(a.name, b.name)) return true;
  return false;
}
