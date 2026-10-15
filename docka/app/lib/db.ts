import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { DocCategory } from "@/lib/cert";
import type { CountryCode } from "@/lib/registry/types";
import { isSeafarerState, type SeafarerState } from "@/lib/pipeline";
import { isAvailability, type Availability } from "@/lib/availability";
import { classifyRequiredType, type RequiredDocType } from "@/lib/doctypes";
import type { RequiredDocsConfig, RequiredDocsSnapshot } from "@/lib/required-docs";
import type { SeafarerProfile, SelfServiceFieldKey } from "@/lib/self-service";
import { migrateOverrides, type OutreachOverrides } from "@/lib/outreach-overrides";

// Re-export the client-safe pipeline helpers so existing `@/lib/db` imports keep
// working (the constants live in lib/pipeline.ts to stay Node-free).
export {
  SEAFARER_STATES,
  STATE_LABELS,
  isSeafarerState,
  nextState,
  type SeafarerState,
} from "@/lib/pipeline";

// ---- Types -------------------------------------------------------------

export type Seafarer = {
  id: string;
  name: string;
  /** Rank / position, e.g. "Chief Officer". */
  rank: string;
  /** Agent pipeline state. */
  state: SeafarerState;
  /**
   * SEAMAN-DECLARED availability — the seaman's own "am I free for a berth" signal,
   * kept STRICTLY SEPARATE from the agent pipeline `state`. undefined = never
   * declared ("Not set"). Owner-set on /seafarer with NO shore-approval gate
   * (marking yourself occupied must be instant); a granted agent may override it.
   */
  availability?: Availability;
  /**
   * yyyy-mm-dd the seaman becomes free. Meaningful ONLY when availability ===
   * "open_from"; null otherwise (the only availability state that carries a date).
   */
  availableFrom?: string | null;
  /**
   * @deprecated Kept as an ALIAS of `openShareToken` so any code that still reads
   * `shareToken` (reminders, the seaman's own self-access key) keeps working. It is
   * always kept equal to `openShareToken`.
   */
  shareToken: string;
  /**
   * OPEN share link token. Anyone holding /share/<openShareToken> opens ALL of this
   * seafarer's documents with NO login. Unguessable + independently rotatable.
   */
  openShareToken: string;
  /**
   * PRIVATE (email) share link token. /share/<emailShareToken> resolves this
   * seafarer, but the token ALONE reveals nothing: access still requires a signed-in
   * Google session whose e-mail is in `allowedEmails`. Unguessable + independently
   * rotatable. Works at the SAME time as the open link.
   */
  emailShareToken: string;
  /**
   * Epoch ms of the last time the seaman SELF-ACCESS token (shareToken) resolved the OWN dashboard
   * via GET /api/seafarers?token= (or was refreshed on the signed-in /me path). Drives the 24h
   * sliding idle TTL on that path only (NOT the agent /share/<token> view, which resolves
   * openShareToken separately and is untouched). ABSENT on legacy records -> treated as "fresh" and
   * stamped on first resolve after deploy. Additive/optional; no migration of db.json needed.
   */
  shareTokenLastUsedAt?: number;
  createdAt: string;
  /** True when the agent created this as an invite placeholder (no uploads yet). */
  invited?: boolean;
  /**
   * Provenance — the agent whose invite/import created this placeholder. Absent on
   * legacy rows and on seaman-self-created profiles. Additive/optional, no migration;
   * gates the hidden-crew HARD delete (only the creating agency may erase its own
   * unclaimed placeholder).
   */
  createdByAgentId?: string | null;
  /** Vessel this crew member is assigned to — groups the PSC/MLC dossier. */
  vessel?: string | null;
  /**
   * Vessel TYPE of the berth (e.g. "chemical_tanker") — drives the vessel-type
   * add-on layer of the required-docs matrix (lib/required-docs.ts). Free text or a
   * canonical VesselTypeKey; normalised by the engine. Null / unset = rank floor only.
   */
  vesselType?: string | null;
  /**
   * Flag state / registry the vessel flies (e.g. "panama") — drives the per-flag
   * add-on layer of the required-docs matrix. Free text or a canonical FlagKey;
   * normalised by the engine. Null / unset = no flag-specific add-on.
   */
  flagState?: string | null;
  /**
   * Planned end-of-rotation date (ISO). When set, sea-readiness also fails any
   * document that lapses BEFORE this date, not just one expired today — a cert
   * that expires mid-voyage must block the assignment.
   */
  rotationEnd?: string | null;
  /**
   * Google identity (Auth.js `sub`) of the SEAMAN who owns this profile, set when
   * a seaman signs in with Google. Null for an anonymous local profile or an
   * agent-created invite. Primary match key for a returning signed-in seaman.
   */
  googleSub?: string | null;
  /**
   * Owning seaman's Google e-mail (lower-cased) — the SECONDARY match key, used
   * when the same person signs in before their `sub` is on file. Null when unowned.
   */
  ownerEmail?: string | null;
  /**
   * Owning CredentialUser.id when this profile belongs to a PASSWORD account
   * (feat/password-signup). Non-secret back-pointer — safe to return from /me.
   * Null/absent for anonymous, Google-owned, or agent-created rows. "Unowned"
   * checks are `!googleSub && !ownerEmail && !credentialUserId`.
   */
  credentialUserId?: string | null;
  /**
   * Public Sample Profiles: true ONLY on the seeded fictional demo seafarers
   * (flagship + sample-agency board crew). A sample row is publicly rendered,
   * read-only via any token path, unclaimable/unadoptable through every auth
   * seam, never merged, and excluded from notification sends. Written only by
   * scripts/seed-samples.mjs. Additive/optional — absent on every real row.
   */
  isSample?: boolean;
  /**
   * Agent-TYPED contact e-mail captured from an imported crew roster (lower-cased).
   * SECURITY: this is a CONTACT field only — it gates NOTHING in auth. Unlike
   * `ownerEmail` (a seaman-login secondary match key, lib/seaman-account.ts) an
   * unverified imported address here can never take over a profile. Used solely as
   * the recipient of the PROFILE INVITE (`/api/reminders` kind `claim`) while the
   * profile is still an unclaimed placeholder. Null when the roster row had no
   * valid email. Never copied into `ownerEmail`.
   */
  importedEmail?: string | null;
  /**
   * Seaman opt-in (default OFF): when true, any document past its expiry date is
   * automatically archived on load of the seaman view (and after upload/edit).
   * Documents with no expiry are never auto-archived.
   */
  autoArchiveExpired?: boolean;
  /**
   * Lower-cased agent e-mails permitted to open the PRIVATE (email) share link.
   * Never an auth secret on its own — opening the private link ALSO requires a
   * signed-in Google session whose e-mail is on this list (see lib/share-access.ts).
   * Unused by the OPEN link.
   */
  allowedEmails?: string[];

  // ---- Government-verified identity -------------------------------------
  // When a document of this seaman is verified against the Estonian maritime
  // registry, the holder identity the registry returned (name, personal code,
  // date of birth, photo, issuing country) is written here as the AUTHORITATIVE
  // maritime identity. The government data wins over the typed/Google name. Set
  // server-side only, as part of the verify/save flow — never from client input.
  // If multiple verified docs exist the MOST RECENT verification wins (they agree).
  /** True once at least one government verification set this identity. */
  identityVerified?: boolean;
  /** ISO instant of the verification that set the identity. */
  identityVerifiedAt?: string | null;
  /** Registry holder full name (firstName + lastName). */
  verifiedName?: string | null;
  /** Registry personal (national ID) code. */
  personalCode?: string | null;
  /** Registry date of birth (ISO instant). */
  birthDate?: string | null;
  /** Registry holder photo URL (time-limited signed URL from the registry). */
  photoUrl?: string | null;
  /** Registry issuing country, e.g. "Eesti". */
  issuerCountry?: string | null;

  // ---- Persistent profile photo (local, durable) ------------------------
  // The registry `photoUrl` is a TIME-LIMITED signed URL that expires, so it can't
  // be shown long-term. When a government verification yields a photo we DOWNLOAD it
  // server-side once and store it under uploads/, keeping only the LOCAL filename
  // here. Both are served via /api/profile-photo/<id> (never the raw expiring URL).
  /** Local uploads/ filename of the downloaded government-verified profile photo. */
  verifiedPhotoFile?: string | null;
  /**
   * Local uploads/ filename of an owner-uploaded CUSTOM profile photo. When set it
   * OVERRIDES the verified photo as the displayed avatar; resetting it (owner action)
   * reverts to the verified photo. Owner-set only.
   */
  customPhotoFile?: string | null;

  // ---- Expiry-reminder calendar settings (owner-editable) ---------------
  // Drive the "Expiry reminders" module + the owner-scoped .ics calendar export.
  // All four have read-migration defaults so legacy rows behave as "1 month before,
  // 3 reminders, every 14 days" without a data migration. Owner-set only.
  /** First reminder lead VALUE (paired with the unit), e.g. 3 in "3 months before". Default 1. */
  reminderLeadValue?: number;
  /** First reminder lead UNIT. Default "months". */
  reminderLeadUnit?: "months" | "weeks" | "days";
  /** How many reminders to emit per document. Default 3. */
  reminderCount?: number;
  /** Repeat interval between reminders, in days. Default 14. */
  reminderIntervalDays?: number;

  /**
   * Agent-facing free-text labels for cohort organisation (e.g. "priority",
   * "tanker-ready", "awaiting-visa"). Set by the agent via the bulk-actions bar,
   * de-duplicated case-insensitively. Purely organisational — never gates
   * compliance, access, or the pipeline. Optional; absent = no tags.
   */
  tags?: string[];

  // ---- Seaman self-service personal profile (shore-approved) ------------
  // Personal / next-of-kin / bank details the SEAMAN maintains themselves. A seaman
  // never writes these directly: each change is PROPOSED as a ProfileChangeRequest
  // and only lands here once a granted agent APPROVES it (roadmap T1.7). The fixed,
  // typed field set lives in lib/self-service.ts, so self-service can only ever touch
  // a known personal field — never rank, state, tokens, or the verified identity.
  selfProfile?: SeafarerProfile;

  // ---- Person-matching identity fields (#37) ----------------------------
  /**
   * Import-supplied passport number (#37.2). Optional; a first-class person-match
   * field (a unique identifier that corroborates a merge). Default null.
   */
  passportNo?: string | null;
  /**
   * Import-supplied seaman's book / discharge-book number (#37.2). Optional; a
   * first-class person-match field. Default null.
   */
  seamanBookNo?: string | null;
  /**
   * Absorbed seafarer IDs after a merge (#37.7). The survivor UNIONs its own id +
   * these when reading append-only audit sinks, without ever rewriting the chains.
   * Default [].
   */
  mergedFrom?: string[];
  /**
   * Absorbed records' share tokens carried onto the survivor after a merge (#6), WITH
   * their original mode, so old share links redirect (not 404) without downgrading a
   * private link to open. Resolved as VIEW-ONLY aliases; pruned on token rotation.
   * Default [].
   */
  priorShareTokens?: { token: string; mode: "open" | "email" }[];
  /**
   * Seaman's default cross-agency propagation choice for the CONTACT/CV bucket (#38.1).
   * A NEW grant inherits this. Default false (opt-in / GDPR).
   */
  propagateContactByDefault?: boolean;
  /**
   * Seaman's default cross-agency propagation choice for the FINANCIAL/NOK bucket.
   * Default false.
   */
  propagateFinancialByDefault?: boolean;

  // ---- Employment / CBA (#41) -------------------------------------------
  /**
   * #41 item 15 — the seaman/agency SELF-DECLARES this berth is covered by a
   * Collective Bargaining Agreement. Self-asserted only (never "verified"); default
   * false. Surfaced as a "CBA claimed (self-declared)" chip, never a badge.
   */
  cbaCovered?: boolean;
  /** #41 — free-text CBA reference (union / agreement name). Unvalidated; default null. */
  cbaRef?: string | null;

  /**
   * Single per-seaman highwater for the in-app messages inbox: the newest circular
   * `createdAt` this seaman has acknowledged as seen. Unread = my circulars with
   * `createdAt > inboxLastSeenAt`. Advanced monotonically (max of old + the newest
   * rendered row) from `POST /api/inbox/seen`, NEVER to server `now()`. Undefined on
   * legacy rows / a seaman who never opened the inbox → everything reads as unread.
   */
  inboxLastSeenAt?: string;

  // ---- #49 docka-verified directory opt-in ------------------------------
  /**
   * Seaman opt-in (default OFF) to appear in the docka-verified network directory
   * that signed-in shipowner clients can browse (#49). This is the SEAMAN half of the
   * DUAL consent: a seaman is listable ONLY when this is true AND a granting agency
   * separately set `AccessGrant.directoryConsent` AND the seaman is identity-verified.
   * Going-forward only — turning it off stops NEW views, never un-sees a past one.
   */
  directoryOptIn?: boolean;
};

// ---- Seaman self-service change queue (lib/self-service.ts) ------------
//
// A seaman PROPOSES a change to one of their own personal fields; the change sits
// PENDING until a granted agent approves or rejects it (the shore-approval gate).
// Approval applies the value to `Seafarer.selfProfile[field]`; rejection/cancel
// leaves the live profile untouched. Seaman-owned (NOT agent-scoped) — visible to
// whichever granted agent reviews it, mirroring how a DocRequest is seaman-visible
// across granting agents. Every decision is recorded (actor + when) for the audit
// trail.

export type ProfileChangeStatus =
  /** Awaiting a shore decision. */
  | "pending"
  /** A granted agent approved it — the value was written to the live profile. */
  | "approved"
  /** A granted agent rejected it — the live profile was left unchanged. */
  | "rejected"
  /** The seaman withdrew it, or a newer proposal for the same field superseded it. */
  | "cancelled";

export type ProfileChangeRequest = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  /** Which editable personal field this proposes to change (self-service registry key). */
  field: SelfServiceFieldKey;
  /** Field label captured at request time — display + audit. */
  fieldLabel: string;
  /** Value on file when the seaman proposed (the "from" side of the diff). */
  previousValue: string | null;
  /** Value the seaman proposes (the "to" side; null = clear the field). */
  proposedValue: string | null;
  /** Optional free-text note from the seaman (why / context). */
  note?: string | null;
  status: ProfileChangeStatus;
  createdAt: string;
  /** Agent name/email who approved/rejected — audit. Null while pending. */
  decidedBy?: string | null;
  /** Tenant that made the decision. Null while pending / on seaman cancel. */
  decidedByAgentId?: string | null;
  /** ISO instant the decision (or cancel) landed. Null while pending. */
  decidedAt?: string | null;
  /** Optional agent note shown to the seaman (esp. on rejection). */
  decisionNote?: string | null;
};

/**
 * One calendar day's total rest hours for a seafarer — the raw material of the
 * STCW/MLC rest-hours report an inspector asks for. Keyed by seafarer + date;
 * the latest write for a date wins.
 */
export type RestHourEntry = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Total hours of rest in that 24-hour period. */
  hoursRest: number;
  createdAt: string;
};

/**
 * How a document's metadata was obtained.
 *  - "government" — flag-state registry verification that passed holder binding
 *    (plan §2.5 rules 1–3); the ONLY source that earns the emerald badge.
 *  - "registry"   — registry-confirmed DOCUMENT, holder NOT verified (BG
 *    presence-only results, UA-TCCS training-center confirmations). Fail-closed
 *    by construction: every `source === "government"` check excludes it.
 *  - "photo"      — OCR best-effort read.
 *  - "manual"     — typed/plain upload.
 */
export type DocSource = "government" | "registry" | "photo" | "manual";

/** Agent decision on a single document during review. */
export type ReviewStatus = "pending" | "approved" | "rejected" | "reupload";

export type Doc = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  title: string;
  docType: string;
  /** Which government endpoint verified this, if any. */
  docCategory: DocCategory | null;
  /**
   * Registry access code / lookup key (HISTORICALLY named for Estonia;
   * interpreted per `registryCountry` — plan §4.2). Kept under this name
   * because it is throughout db.json, seed.mjs, dedupe logic and the self-heal
   * filters; renaming would force a data migration for zero user value.
   */
  estonianCode: string | null;
  /**
   * Certificate / registration number used for fleet-wide DUPLICATE detection.
   * For a registry-verified doc this is the Estonian access code; for a photo it
   * is a best-effort OCR read of the printed number. Two crew carrying the same
   * number is a forged-STCW red flag surfaced to the agent.
   */
  certNumber?: string | null;
  /** Auto-filled from the registry at upload time. */
  isValid: boolean | null;
  validUntil: string | null;
  /**
   * Feature 3 — the document INTENTIONALLY has no expiry date (perpetual). `true`
   * means the owner marked it as having no end date, so every status/display/
   * analytics reader treats it as VALID/compliant and labels it "No expiry".
   * This is DISTINCT from a null `validUntil`, which means "unknown / not yet
   * read". Additive + optional (absent on legacy rows = not perpetual). Does NOT
   * apply to the separate SEA employment path (`seaEndDate`), where null keeps its
   * "reconfirm" meaning.
   */
  noExpiry?: boolean;
  /**
   * True when the expiry was set by an authority (government registry) or
   * confirmed by a human (the seaman typed/checked it). False when it is only a
   * best-effort OCR guess off a photo. Drives the honest badge: an unconfirmed
   * expiry is shown "unread — please confirm", never as a confident fact.
   */
  expiryConfirmed?: boolean;
  /**
   * A reviewer opened the ACTUAL document in the viewer and confirmed its name +
   * expiry match. This is a human reviewer check on a non-government document —
   * NOT registry verification, so it is shown as a distinct "Checked by reviewer"
   * label, never the emerald government-verified badge.
   */
  reviewerChecked?: boolean;
  /** Reviewer who signed off the check — audit trail. */
  checkedBy?: string | null;
  /** ISO instant the reviewer check was recorded — audit trail. */
  checkedAt?: string | null;
  /**
   * #41 item 13 — end date of a SEA / employment-agreement document (ISO YYYY-MM-DD),
   * driving employment-currency. null = present but expiry unknown (an `unknownExpiry`
   * reconfirm state for an assigned seaman, NEVER a silent forever-current SEA).
   */
  seaEndDate?: string | null;
  fileName: string | null;
  originalName?: string;
  /**
   * SHA-256 of the uploaded file bytes (hex). Used as the last-resort duplicate
   * signature when a re-upload of the SAME seafarer carries no government code and
   * no cert number — the identical file is disregarded ("Already uploaded"). Null
   * for code-only documents with no attached file.
   */
  fileHash?: string | null;
  createdAt: string;
  /** government = QR/registry verified; photo = OCR read; manual = typed/plain. */
  source: DocSource;
  /** Name read off the photo by OCR (best-effort, not government-verified). */
  holderName?: string | null;
  /** Which required slot this document fills (best-effort classification). */
  requiredType: RequiredDocType | null;
  /** Agent review decision. */
  reviewStatus: ReviewStatus;
  reviewReason?: string | null;
  /** Who signed off the decision (agent name/email) — audit trail. Null while pending. */
  reviewedBy?: string | null;
  /** ISO instant the decision was recorded — audit trail. Null while pending. */
  reviewedAt?: string | null;
  /**
   * The SEAMAN archived this as a past/retired document. It stays visible to the
   * seaman (in a collapsible "Archived" section) but is NOT counted as an active
   * on-file document: excluded from the seaman's active list and from the
   * agent-side active set / completeness / validity / sea-readiness hard-block.
   */
  archived?: boolean;
  /** ISO instant the document was archived. Null when not archived. */
  archivedAt?: string | null;
  // ---- Registry (plan §4) -------------------------------------------------
  /**
   * ISO-2 country of the registry this document belongs to / was verified
   * against (plan §4.1). Read-migration labels legacy `source:"government"`
   * rows "EE" (all legacy government docs are Estonian). A row with
   * `estonianCode` set but `source:"manual"` (the unverified-code-kept path)
   * is NOT labeled — its code was never verified against any registry.
   * Null = no registry association (plain photo/manual docs).
   */
  registryCountry?: CountryCode | null;
  /**
   * §4.3 — HOW the reviewer sign-off (`reviewerChecked`) was performed:
   * "document" = the reviewer eyeballed the actual document; "registry-portal"
   * = the reviewer confirmed it on the official registry portal via the
   * assisted flow. Reuses `reviewerChecked`/`checkedBy`/`checkedAt` untouched;
   * only changes the badge label ("Checked against registry"), never the tone.
   */
  checkedVia?: "document" | "registry-portal" | null;
  /**
   * §4.4 — first-class manual-verification workflow state (Wave-4 countries:
   * email/process-only registries). Written ONLY server-side via updateDB.
   * IDEMPOTENCY: the request action never overwrites an existing
   * `requestedAt` — a double-click / re-POST of "Request manual verification"
   * is a no-op (use `requestManualVerification()` below).
   */
  manualVerification?: {
    status: "requested" | "confirmed" | "closed_unavailable";
    requestedAt: string;
    requestedBy: string;
    confirmedAt?: string | null;
    confirmedBy?: string | null;
    /**
     * F8 — REQUIRED evidence for a "confirmed" state: what the authority
     * actually replied (email date, reference). A bare click can never mint
     * "confirmed"; the API rejects a confirm without a note.
     */
    evidenceNote?: string | null;
  } | null;
  /**
   * §4.10 — the §2.5 trust class of the lookup MODE that produced this doc's
   * verified holder snapshot: "capability-token" (unguessable secret — may
   * drive identity self-heal) vs "public-identifier" (printed/knowable key —
   * never self-heals identity). Read-migration defaults legacy
   * `source:"government"` rows to "capability-token" (all legacy government
   * docs are EE access-token verifications), so the strict gate in
   * `applyVerifiedIdentity` cannot regress the pre-migration EE backfill.
   */
  verifiedKeyTrust?: "capability-token" | "public-identifier";
  /**
   * §4.6 — the NON-sensitive lookup inputs used at verification time (e.g. UK
   * documentId). `sensitive:true` fields (BG EGN, ES NIF) are STRIPPED before
   * store — never persisted, never logged. This is the re-verification key
   * (§5.4): re-checks are keyed by `registryCountry` + `registryInputs`,
   * never by re-parsing a bare stored string.
   */
  registryInputs?: Record<string, string> | null;
  /**
   * §4.7 — a public-identifier registry verification returned a holder that
   * FAILED the §2.5 identity match (bindHolder rule 2). The doc is stored
   * unverified (never `source:"government"`) and this flag surfaces it to
   * reviewers. Set only server-side, together with the verified* holder
   * snapshot showing WHO the registry says holds the certificate.
   */
  holderMismatch?: boolean;

  /**
   * Owner-set display rotation in degrees (0 | 90 | 180 | 270). Applied as a
   * NON-DESTRUCTIVE CSS transform wherever the document image is shown — the
   * seaman viewer, the shared view-only viewer, the agent review viewer, and the
   * thumbnails — so a sideways photo the owner straightens shows upright to
   * everyone. The stored file bytes are never re-encoded. Only the owner changes it.
   */
  rotation?: 0 | 90 | 180 | 270;

  // ---- Government-verified holder snapshot (per document) ----------------
  // When THIS document is verified against the Estonian registry, the holder
  // identity the registry returned is snapshotted here ON the document. This is
  // the durable source the owner-profile self-heal reads from, so the identity
  // never has to be re-fetched once captured. Set server-side only, on every
  // government verification (fresh add, QR photo, bootstrap, AND re-verify of an
  // already-stored doc). Absent (undefined) on legacy rows and non-government docs.
  /** Registry holder given name. */
  verifiedFirstName?: string | null;
  /** Registry holder surname. */
  verifiedLastName?: string | null;
  /** Registry holder full name (firstName + lastName). Presence = "holder captured". */
  verifiedFullName?: string | null;
  /** Registry personal (national ID) code. */
  verifiedPersonalCode?: string | null;
  /** Registry date of birth (ISO instant). */
  verifiedBirthDate?: string | null;
  /** Registry holder photo URL (time-limited signed URL from the registry). */
  verifiedPhotoUrl?: string | null;
  /** Registry issuing country, e.g. "Eesti". */
  verifiedIssuerCountry?: string | null;
  /**
   * ISO instant the holder identity was last resolved from the registry for this
   * doc. Set even for a name-less (medical) result — it caches the fact that we
   * already asked, so the owner self-heal does not re-fetch a name-less cert on
   * every profile load. Absent = never resolved (self-heal may fetch once).
   */
  verifiedResolvedAt?: string | null;
};

/**
 * Open a manual-verification request on a document (plan §4.4). IDEMPOTENT by
 * construction: if ANY manualVerification state already exists the call is a
 * no-op returning false — a double-click / re-POST can never overwrite the
 * original `requestedAt` (or clobber a later "confirmed" state). Pure mutation
 * helper — call it INSIDE an updateDB critical section only.
 */
export function requestManualVerification(doc: Doc, requestedBy: string): boolean {
  if (doc.manualVerification) return false;
  doc.manualVerification = {
    status: "requested",
    requestedAt: new Date().toISOString(),
    requestedBy,
    confirmedAt: null,
    confirmedBy: null,
  };
  return true;
}

/**
 * Record the authority's positive reply on an open manual-verification request
 * (plan §4.4 "confirmed"). Allowed from "requested" AND from
 * "closed_unavailable" (a late authority reply after the agent closed the
 * request is good news, not an error). IDEMPOTENT: an already-confirmed state
 * is never re-stamped — the original confirmedAt/confirmedBy stand. Pure
 * mutation helper — call it INSIDE an updateDB critical section only.
 */
export function confirmManualVerification(
  doc: Doc,
  confirmedBy: string,
  evidenceNote?: string
): boolean {
  const mv = doc.manualVerification;
  if (!mv || mv.status === "confirmed") return false;
  mv.status = "confirmed";
  mv.confirmedAt = new Date().toISOString();
  mv.confirmedBy = confirmedBy;
  // F8 — evidence travels with the confirmation. Idempotency unchanged: an
  // already-confirmed state (and its original note) is never re-stamped.
  if (evidenceNote !== undefined) mv.evidenceNote = evidenceNote.trim() || null;
  return true;
}

/**
 * Close an OPEN manual-verification request as unavailable (plan §4.4
 * "closed_unavailable") — the authority did not / cannot answer. Allowed ONLY
 * from "requested": a confirmed state is never demoted, and a re-close is a
 * no-op. The original requestedAt/requestedBy audit trail is untouched. Pure
 * mutation helper — call it INSIDE an updateDB critical section only.
 */
export function closeManualVerification(doc: Doc): boolean {
  const mv = doc.manualVerification;
  if (!mv || mv.status !== "requested") return false;
  mv.status = "closed_unavailable";
  return true;
}

export type Comment = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  /** Set for a per-document note; null for a seafarer-level agent note. */
  documentId: string | null;
  /** Set for a seafarer-level agent note. */
  seafarerId?: string | null;
  authorName: string;
  text: string;
  createdAt: string;
};

// ---- Multi-tenant consent / access model ------------------------------
//
// A tenant is an `Agent` (a crewing org). A seafarer only becomes visible to an
// agent through an `AccessGrant` the seafarer created. An `Assignment` (the man
// sent to sea under that agent) is what LOCKS the grant. See lib/access.ts for
// the lifecycle rules — this file only defines the shapes + storage.

export type Agent = {
  id: string;
  orgName: string;
  /** Contact e-mail / phone for the org — display only, never an auth secret. */
  contact: string;
  createdAt: string;
  /**
   * Live-login link fields (optional / backward-compatible). When a real agent
   * signs in with Google, `lib/agent-account.ts` resolves them to THIS row and
   * records the verified Google identity here so their grants/assignments/
   * access-log (all keyed by Agent.id) join their Agent row instead of being
   * stranded under a `google:<email>` key. Normalised e-mail (trim+lowercased).
   * Absent on seed/legacy rows — those still load unchanged.
   */
  googleEmail?: string | null;
  /** Google `sub` (provider account id) — the stable primary link when known. */
  googleSub?: string | null;
  /**
   * Public Sample Profiles: true ONLY on the seeded fictional sample agency
   * ("Sample Crewing OU"). Never sign-in-linkable; excluded from the dev
   * test-login tenant picker. Written only by scripts/seed-samples.mjs.
   */
  isSample?: boolean;
};

/**
 * A seafarer sent to sea UNDER a specific agent. `returnedAt === null` means the
 * assignment is live; a live assignment is what forces the (seafarer,agent) grant
 * into LOCKED. Lock/unlock is derived from this row — never a manual flag.
 */
export type Assignment = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  agentId: string;
  vessel: string | null;
  sentToSeaAt: string;
  returnedAt: string | null;
  /** How the assignment ended, for the audit trail. */
  closedReason?: "returned" | "force_closed_cap" | null;
  /**
   * FROZEN required-docs set captured at assignment start (lib/required-docs.ts),
   * so a mid-contract rank change cannot silently re-scope what the man was
   * required to hold when committed to this voyage. Null on legacy rows.
   */
  requiredSnapshot?: RequiredDocsSnapshot | null;
  createdAt: string;
};

/** Stored base status of a grant. LOCKED and EXPIRED are DERIVED live, never persisted here. */
export type GrantBaseStatus = "PENDING" | "ACTIVE" | "REVOKED" | "EXPIRED";

/** Effective, request-time status (adds the derived LOCKED). */
export type GrantStatus = "PENDING" | "ACTIVE" | "LOCKED" | "REVOKED" | "EXPIRED";

/**
 * CONSENT while ashore; flips to CONTRACT + legal obligation at lock, pre-disclosed
 * at grant time (avoids the invalid-consent trap for the sea-lock).
 */
export type LegalBasis = "CONSENT" | "CONTRACT_LEGAL_OBLIGATION";

export type AccessScope = "profile" | "documents" | "log";

export type AccessGrant = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  agentId: string;
  /** Persisted BASE status only — the live status (incl. LOCKED/EXPIRED) is computed. */
  status: GrantBaseStatus;
  legalBasis: LegalBasis;
  scope: AccessScope[];
  /** Per-grant, rotates on revoke so a stale link cannot silently reactivate. */
  shareToken: string;
  grantedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /**
   * Per-(seafarer, agent) pipeline stage — the source of truth for where THIS
   * agency is with this seaman. `Seafarer.state` is now a deprecated dual-written
   * global mirror ("last move by any agent"). Optional/additive: legacy rows are
   * backfilled from `Seafarer.state` once inside readDB().
   */
  stage?: SeafarerState;
  /** Epoch ms the grant's `stage` last changed. Read-time default: Date.parse(createdAt). */
  stageUpdatedAt?: number;
  /**
   * #37 (#2 critic) — set when this grant is a DROPPED duplicate absorbed by a merge:
   * it is TOMBSTONED (status:"REVOKED" + this field = the survivor grant's id) rather
   * than hard-deleted, so its append-only propagation / consent history stays resolvable
   * to the survivor grant. Default undefined (a normal / re-pointed grant has no mapping).
   */
  mergedIntoGrantId?: string;
  /**
   * #38 — cross-agency propagation consent for the CONTACT/CV bucket. Default FALSE
   * (opt-in). When true, this agency sees the seaman's personal contact overlay.
   */
  propagateContact?: boolean;
  /**
   * #38 — cross-agency propagation consent for the FINANCIAL / next-of-kin bucket.
   * Default FALSE (opt-in). Independent of the contact bucket.
   */
  propagateFinancial?: boolean;
  /**
   * #42 — this agency may expose THIS seaman on a shipowner/client read-portal it
   * builds (a crew list a client sees). Seaman-controlled, per (seaman, agency).
   * Default FALSE (opt-in); a portal re-gates on it LIVE at every view.
   */
  clientVisible?: boolean;
  /**
   * #49 — this agency consents to route the seaman as a lead in the docka-verified
   * directory (the AGENCY half of the dual consent). Default FALSE (opt-in). The
   * directory gate reads the STORED grant.status === "ACTIVE" alongside this flag —
   * never effectiveGrantStatus / effectiveLegalBasis (which alias EXPIRED/REVOKED/
   * PENDING as CONSENT and mask a revoked mid-voyage grant as LOCKED).
   */
  directoryConsent?: boolean;
  /**
   * Bug1 — per-agent BOARD hide. When set (ISO instant), THIS agent has removed the
   * seaman from essentially every one of their own surfaces: the grant stays ACTIVE and
   * documents stay accessible, but the seaman is excluded from the board, CSV/Excel
   * exports, inspection dossier, talent search, single-agent view, analytics, vacancies,
   * portals, circulars, reminders, and bulk actions — both viewing AND notification/
   * action reach. The ONLY place a hidden seaman still surfaces is the dedicated "Hidden
   * crew" panel and the invite-link re-add path used to restore them — see
   * lib/agentData.ts `includeHidden`. Optional/additive, reversible (cleared on
   * restore / re-add). Never revokes the grant. Default undefined/null = visible.
   */
  hiddenByAgentAt?: string | null;
};

/**
 * #42 — a shipowner/client READ-PORTAL an agency builds over a curated slice of its
 * crew. The token opens a display-only, allow-list-projected crew list; documents,
 * ids, personal data NEVER cross to it (see lib/client-view.ts). `seafarerIds` is a
 * curated CEILING re-gated LIVE at read against grant + `clientVisible`.
 */
export type ClientPortal = {
  id: string;
  agentId: string;
  vessel: string;
  clientLabel: string;
  /** shareToken() 72-bit. Never serialised to a client component. */
  token: string;
  /** Curated ceiling; re-gated live at read (TOCTOU-safe). */
  seafarerIds: string[];
  /** "open" = token alone opens; "email" = token + signed-in allow-listed viewer. */
  mode: "open" | "email";
  /** Lower-cased client e-mails permitted in "email" mode. */
  allowedEmails?: string[];
  /** Voyage window (#42): joinDate..rotationEnd drives per-slot expiry judging. */
  joinDate?: string | null;
  rotationEnd?: string | null;
  /**
   * Idempotency key (#C11): a create carrying a key already present for this agent
   * RETURNS the existing portal — never a 2nd row (double-submit safe).
   */
  createKey?: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/**
 * #52 — a crewing VACANCY an agency opens, matched against its grant-scoped roster
 * (agency-internal; never an external surface). `requiredCerts`/`requiredEndorsements`
 * are validated ⊆ REQUIRED_DOC_TYPES + length-capped; sea-time bounds are integer-
 * validated server-side (see lib/vacancy-store.ts).
 */
export type Vacancy = {
  id: string;
  agentId: string;
  title: string;
  rank: string;
  vesselType?: string | null;
  flagState?: string | null;
  requiredCerts: RequiredDocType[];
  requiredEndorsements?: RequiredDocType[];
  /** Minimum qualifying sea days (int 0..25000). */
  minSeaDays?: number | null;
  /** Sea-time window in months (int 1..600); default REVALIDATION_WINDOW_MONTHS. */
  seaWindowMonths?: number | null;
  /** Voyage window fed to matching (#C1). */
  rotationEnd?: string | null;
  /** Idempotency key (#C11): double-submit → one row. */
  createKey?: string | null;
  status: "open" | "filled" | "closed";
  createdAt: string;
  closedAt?: string | null;
};

/**
 * One audit row per required-docs CONFIG edit by an agent. Append-only in
 * practice (the settings route only pushes). Records the actor, a human diff, and
 * the BLAST RADIUS (how many of the agent's seafarers the change re-scoped) so the
 * effect of a config edit is never invisible. IDs/counts only — no PII.
 */
export type RequiredDocsAuditRow = {
  id: string;
  agentId: string;
  at: string;
  /** Agent name/email who saved. */
  actor: string;
  /** Short human summary of what changed (e.g. "Rating: +Endorsement"). */
  summary: string;
  /** Number of the agent's seafarers governed by this config at edit time. */
  affectedSeafarers: number;
  /** Ids of those seafarers (blast radius detail). */
  affectedSeafarerIds: string[];
  /** Impersonation attribution (F1) — set ONLY when an admin saved this via "act as". */
  impersonator?: string;
  onBehalfOf?: string;
};

// ---- Notification channel (lib/notify.ts) -----------------------------
//
// The single outbound channel every "we told someone" feature routes through
// (expiry reminders, document requests, review outcomes). One send() abstraction
// over email (SMTP) + a pluggable SMS stub; when a channel is unconfigured it logs
// + records here instead of throwing, so a demo box with no SMTP creds still leaves
// an honest, dated "would have sent" trail. This is the app DB record — NOT the
// tamper-evident audit sink (it may carry the recipient address, like ownerEmail).

/** Delivery channel a notification went out on. */
export type NotifyChannel = "email" | "sms";

/** What actually happened to one send attempt. */
export type NotifyStatus =
  /** Handed to a real provider (SMTP accepted it). */
  | "sent"
  /** No provider configured / no address — recorded only, nobody was contacted. */
  | "logged"
  /** A provider was configured but the send threw. */
  | "failed";

/** One outbound-notification attempt, recorded whether or not it actually left the box. */
export type NotificationLog = {
  id: string;
  at: string;
  channel: NotifyChannel;
  /** Resolved recipient address (email or phone). Empty when none was available. */
  to: string;
  /** Human name of the recipient, when known — display only. */
  toName?: string | null;
  subject: string;
  /** Truncated body preview (first ~200 chars) — enough to see what went out. */
  preview: string;
  status: NotifyStatus;
  /** Why it was only logged / failed, e.g. "email channel not configured". */
  reason?: string | null;
  /** Caller grouping tag, e.g. "reminder:renewal", so a feature can find its own sends. */
  kind?: string | null;
  /**
   * OPTIONAL subject-seafarer id. Absent on plain mail-log rows (recipient is the only
   * key those need). Populated for FEATURE-scoped ledger rows that must be found by
   * seafarer — e.g. the `kind:"invite:card"` dedupe rows the upload-link send writes
   * (lib/card-link.ts), which the anti-spam guard reads back per seafarer.
   */
  seafarerId?: string | null;
};

/**
 * One reminder actually emitted, used ONLY to dedupe the daily reminder cron so a
 * re-run on the same calendar day never double-sends. Keyed by (docId, recipient,
 * reminderDate); `recipient` is a bucket string ("seaman" or "agent:<agentId>").
 */
export type ReminderSentEntry = {
  id: string;
  /** Document (certificate) the reminder was about. */
  docId: string;
  seafarerId: string;
  /** Recipient bucket: "seaman" or `agent:<agentId>`. */
  recipient: string;
  /** The reminder calendar day (YYYY-MM-DD, UTC) it fired for — dedupe key. */
  reminderDate: string;
  channel: NotifyChannel;
  sentAt: string;
};

/**
 * One company circular / bulletin an agency broadcast to (all or a filtered slice
 * of) its roster. The DELIVERY is a fan-out through lib/notify.ts (email today);
 * this row is the durable record of what was sent, to whom, by whom, and with what
 * roster filter — so a broadcast is auditable and can be shown back to the agent.
 * `recipientIds` are the seafarer ids that were IN this agent's grant-scoped roster
 * at send time (already tenant-filtered — never a raw cross-tenant id).
 */
export type Circular = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  /** Sending tenant (agentSession.agentId). Own-tenant reads filter on this. */
  agentId: string;
  /** Agent name/email who sent it — display + audit. */
  authorName: string;
  subject: string;
  message: string;
  /**
   * Roster filter applied at send time (null/empty field = no constraint on that
   * axis). Kept for the history view so "who did this reach" is reconstructable.
   */
  filter: { rank: string | null; state: SeafarerState | null; vessel: string | null } | null;
  channel: NotifyChannel;
  /** Grant-scoped seafarer ids this circular was fanned out to. */
  recipientIds: string[];
  /** Number of recipients a real provider accepted the message for. */
  delivered: number;
  /**
   * Two-way toggle (default false). When true a recipient seaman may post a
   * `CircularReply` back to the sending agency from their in-app inbox. Legacy
   * rows have no field: it is read as `?? false` at every access site (NO per-read
   * write amplification — the value is never backfilled onto old circular rows).
   */
  allowReplies: boolean;
  createdAt: string;
};

/**
 * One seaman reply to a `Circular` — the return leg of in-app messaging. Written
 * ONLY from an authenticated seaman session (never a share-token path). `agentId`
 * is denormalised from the circular's sending tenant so an agent's own reads filter
 * on it exactly like every other tenant-scoped collection. `visibility` controls who
 * else may read it: "agent" = only the sending agency; "all" = the agency PLUS the
 * other live recipients of the same circular (peers see it ANONYMISED, never the
 * author's name — the agent always sees the real name).
 */
export type CircularReply = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  /** The Circular this replies to. */
  circularId: string;
  /** Sending tenant of the circular (denormalised). Own-tenant agent reads filter on this. */
  agentId: string;
  /** Seafarer who authored the reply. */
  seafarerId: string;
  /** Author's canonical seafarer name at write time — shown to the AGENT only. */
  authorName: string;
  /** Reply text (trimmed, length-capped at write time). */
  body: string;
  /** "agent" = agency only; "all" = agency + peer recipients (peers see it anonymised). */
  visibility: "agent" | "all";
  /**
   * Client-generated per-submit key (F2). PRIMARY idempotency token: a retried POST
   * carrying the same key returns the existing row instead of inserting a duplicate.
   * Optional so legacy/empty rows stay valid; new writes always set it.
   */
  idempotencyKey?: string;
  createdAt: string;
};

/**
 * A single item on an agent's "please supply this document" checklist for a
 * seafarer. The missing set already comes from lib/compliance.ts; a DocRequest is
 * the tracked, deadlined COLLECTION step that turns "you're missing a Medical"
 * into "supply your Medical by 12 Aug" — the loop where crewing agents actually
 * spend the day. One record per requested item, so per-item status + deadline are
 * first-class. `requiredType` (when set) is what lets an incoming upload auto-clear
 * the request (see lib/doc-requests.ts `matchesDoc`). Tenant-scoped: `agentId` is
 * the raising agent, and every read/write goes through the grant guard.
 */
export type DocRequestStatus =
  /** Awaiting the seaman's upload. */
  | "pending"
  /** A matching document arrived (auto on upload) or the agent marked it in. */
  | "received"
  /** The agent decided this item is not needed after all. */
  | "waived"
  /** The agent withdrew the request. */
  | "cancelled";

export type DocRequest = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  /** Tenant that raised the request (agentSession.agentId). Own-tenant reads filter on this. */
  agentId: string;
  /** Agent name/email who raised it — display + audit. */
  requestedBy: string;
  /**
   * The required slot this asks for, when it maps to one (Medical, Passport, …).
   * Drives auto-clear: an uploaded document classified into the same slot marks a
   * pending request received. Null for a free-text ad-hoc item (e.g. "Yellow-fever
   * certificate") that fills no required slot — that one is cleared by the agent.
   */
  requiredType: RequiredDocType | null;
  /** Human label of what is being requested (shown to the seaman). */
  label: string;
  /** Optional free-text note from the agent (why / which exact document). */
  note?: string | null;
  /** ISO date (YYYY-MM-DD) the document is due; null = no deadline. */
  dueDate: string | null;
  status: DocRequestStatus;
  createdAt: string;
  /** ISO instant it left "pending"; null while still pending. */
  resolvedAt?: string | null;
  /** How it left pending: an upload auto-cleared it, or the agent acted. Null while pending. */
  resolvedVia?: "upload" | "agent" | null;
};

// A single sea-service engagement — one sign-on/sign-off row of the digital
// discharge book (T2.2). Accumulated qualifying sea time is DERIVED from these rows
// by lib/sea-service.ts (never stored), so a correction to a date immediately
// re-flows the totals. This is the data spine the CV (item 4), the revalidation-path
// gate (item 13) and endorsement-prerequisite checks read from. Tenant model mirrors
// the discharge book itself: the record belongs to the SEAMAN; a granted agent may
// maintain it (like rest-hours), and every read/write is grant- or owner-token-scoped.
export type SeaServiceEntry = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  /** Vessel / ship name served on. */
  vessel: string;
  /** IMO number of the ship (optional — not every entry has one to hand). */
  imo?: string | null;
  /** Rank / capacity served in this engagement (free text, e.g. "Third Officer"). */
  rank: string;
  /**
   * Vessel TYPE key or free text (optional). Kept so an endorsement prerequisite
   * ("X days on a tanker") can be evaluated from the ledger later (item 13/T2.9).
   */
  vesselType?: string | null;
  /** Flag state / registry (optional). */
  flagState?: string | null;
  /** Sign-on date (YYYY-MM-DD) — the day the engagement began. */
  signOn: string;
  /** Sign-off date (YYYY-MM-DD); null = STILL ONBOARD, so it counts up to today. */
  signOff: string | null;
  /** Optional free-text remark (trade, area, agency reference). */
  note?: string | null;
  /**
   * Who recorded the row — "seaman" (own discharge book) or "agent:<agentId>".
   * Audit/provenance only; it never widens access. Not shown to other tenants.
   */
  recordedBy: string;
  createdAt: string;
};

// ---- Appraisal scorecards (#43, lib/appraisals.ts) --------------------
//
// A typed interview / post-voyage appraisal, agency-authored + tenant-scoped +
// hash-chain audited. The pure validation + versioned competency-set logic lives in
// lib/appraisals.ts; this file owns only the stored shapes (like SeaServiceEntry).
export type AppraisalKind = "interview" | "post_voyage";
export type AppraisalRating = 1 | 2 | 3 | 4 | 5;
export type AppraisalScore = { competency: string; rating: AppraisalRating };
export type RehireRecommendation = "yes" | "no" | "conditional";

export type Appraisal = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  seafarerId: string;
  agentId: string;
  kind: AppraisalKind;
  /** Pinned competency-set version — resolvable in lib/appraisals COMPETENCY_SETS. */
  competencySetVersion: string;
  /** Individual author name — INTERNAL; the seaman projection maps it to authorOrg. */
  authorName: string;
  /** Authoring org (db.agents[agentId].orgName) — what the seaman is allowed to see. */
  authorOrg: string;
  vessel?: string | null;
  voyageFrom?: string | null;
  voyageTo?: string | null;
  assignmentId?: string | null;
  scores: AppraisalScore[];
  overall: AppraisalRating;
  recommend: RehireRecommendation;
  /** REQUIRED (non-empty) when recommend === "no". INTERNAL. */
  rehireReason?: string | null;
  /** Agency-private free-text. INTERNAL — never in the seaman projection. */
  comments: string | null;
  /**
   * #11 — the comment the agent chose to SHARE with the seaman. Seaman-VISIBLE (added
   * to projectAppraisalForSeaman's allow-list). Distinct from `comments` (agency-private).
   */
  sharedComment: string | null;
  /**
   * #11 — STICKY point-in-time flag: set ONCE the first time a non-empty sharedComment is
   * persisted (POST or PATCH); NEVER auto-cleared on blanking. The "was ever shared" fact
   * that #12's delete-consent branch keys on (ever-shared => seaman consent required).
   */
  sharedWithSeamanAt: string | null;
  /**
   * #12 — set when the agent deletes an EVER-SHARED appraisal. A non-null value hides the
   * row from ALL agent reads (GET / dedupe / PATCH / DELETE) while it stays seaman-visible
   * pending the seaman's keep/delete decision. Never surfaced to the agent again.
   */
  hiddenFromAgentAt: string | null;
  fastPath: boolean;
  /** NON-optional client idempotency token (v3 item 2). */
  idempotencyKey: string;
  createdAt: string;
  updatedAt?: string | null;
};

/**
 * #12 — a seaman keep/delete CONSENT request raised when an agent deletes an appraisal
 * that was ever shared with the seaman (sticky sharedWithSeamanAt set). Mirrors the
 * ProfileShareRequest async-decision shape. At most ONE `pending` per appraisalId.
 *   - status "pending" : awaiting the seaman's decision (appraisal is agent-hidden).
 *   - status "kept"    : seaman kept it — permanently agent-hidden, still seaman-visible (terminal).
 *   - status "deleted" : seaman deleted it — the appraisal row was hard-deleted (terminal).
 */
export type AppraisalDeleteRequest = {
  id: string;
  appraisalId: string;
  seafarerId: string;
  agentId: string;
  status: "pending" | "kept" | "deleted";
  createdAt: string;
  decidedAt: string | null;
};

// ---- Contract / SEA terms + issued-SEA store (#45, lib/contract.ts) ---
//
// The employment TERMS an agency fills for a generated SEA. Home is db.ts (it is the
// persisted shape on IssuedSeaRecord); lib/contract.ts imports it. Every field may be
// null — an unknown value renders as an explicit BLANK line, never a fabricated figure.
export type ContractTerms = {
  position: string | null;
  wageAmount: string | null;
  wageCurrency: string | null;
  wagePeriod: "month" | "day" | null;
  leaveDaysPerMonth: string | null;
  contractStart: string | null;
  durationMonths: string | null;
  noticeDays: string | null;
  allotment: string | null;
  repatriationBy: string | null;
};

/**
 * MINIMAL persisted issued-SEA record keyed to `assignmentId` (v3 item 1) — stores
 * only the LATEST terms per assignment so the seaman GET rehydrates real terms rather
 * than a blank SEA. NOT the full versioned register (see §Deferred): no history.
 */
export type IssuedSeaRecord = {
  id: string;
  /**
   * Public Sample Profiles: true ONLY on a seeded curated demo row — the only rows
   * the public sample projections may render. Written exclusively by the seed
   * script (scripts/seed-samples.mjs); never set by any route. Additive/optional.
   */
  sample?: true;
  assignmentId: string;
  seafarerId: string;
  agentId: string;
  terms: ContractTerms;
  /** Identity-verified state of the seaman AT the moment of issue. */
  identityVerifiedAtIssue: boolean;
  /** Agency org name that issued it. */
  issuedBy: string;
  /** ISO instant of the (latest) generation — provenance. */
  generatedAt: string;
};

// ---- Stripe billing (STRIPE-BILLING-PLAN.md §1, R1/R2/R3 schema deltas folded) ----
//
// All billing state is ADDITIVE and lives in its own collections keyed by agentId —
// Agent rows are never touched. Card data NEVER lands here: we store Stripe object
// ids and a status mirror only (plan §4 "Card data").

/** Postal address captured for Stripe Tax / invoicing. */
export type BillingAddress = {
  line1: string;
  line2?: string;
  city: string;
  postal: string;
  /** ISO-3166 alpha-2, upper-case. */
  country: string;
};

/**
 * The MAPPED subscription status (R2-7). Stripe's own union is wider; the mapping
 * table lives in lib/stripe.ts (`mapStripeStatus`) and is shared by the webhook and
 * the daily reconciler so both can never diverge.
 */
export type BillingSubscriptionStatus =
  | "none"
  | "incomplete"
  | "active"
  | "past_due"
  | "canceled";

export type BillingProfile = {
  /** Partition key — exactly one row per agent. */
  agentId: string;
  legalName: string;
  regCode: string;
  vatNumber: string | null;
  billingEmail: string;
  address: BillingAddress;
  tosAcceptedAt: string | null;
  tosVersion: string | null;
  /** Licensed monthly base in EUR (default 300; admin guidance 200–500). */
  baseEurMonthly: number;
  /** Metered rate per billable seafarer in EUR (default 2; admin guidance 1–5). */
  perSeafarerEur: number;
  /** Decision 7 — admin comp / kill-switch. An exempt agent never accrues or blocks. */
  exemptFromBilling: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeBasePriceId: string | null;
  stripeUsagePriceId: string | null;
  subscriptionStatus: BillingSubscriptionStatus;
  paymentMethodAttached: boolean;
  /** Set by invoice.payment_failed, cleared by invoice.paid / the reconciler. */
  pastDueSince: string | null;
  /** R2-5 — set by customer.subscription.deleted; drives canceled-status escalation. */
  canceledAt: string | null;
  /** R1-9 — profile.createdAt for a post-go-live, non-exempt, non-sample agent. */
  billingRequiredSince: string | null;
  /** R1-6 — usage before this instant is never billed (subscription start / un-exempt). */
  billingActiveFrom: string | null;
  /** R2-4 — per-family ordering guards (`event.created`, seconds). */
  lastInvoiceEventCreated: number | null;
  lastSubscriptionEventCreated: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * One computed month of metered usage for one agent. Doubles as the push-dedupe
 * ledger: a row already carrying `pushedToStripeAt` is NEVER re-pushed (the shared
 * Billing Meter aggregates by SUM, so a double push would double-bill).
 */
export type BillingUsageRow = {
  id: string;
  agentId: string;
  /** "YYYY-MM" — the TALLINN calendar month (plan §0.5). */
  period: string;
  billableSeafarerIds: string[];
  quantity: number;
  computedAt: string;
  /** R1-1 — stamped BEFORE the Stripe call; an attempted-but-unconfirmed row is manual-only. */
  pushAttemptedAt: string | null;
  /** ONLY ever means "Stripe received a meter event for this row" (fix-plan D-G). */
  pushedToStripeAt: string | null;
  stripeMeterEventId: string | null;
  /**
   * D-G — a month CLOSED without anything being sent to Stripe. `no-usage` = the
   * computed quantity was zero; `never-billed` = the agency could not be billed for
   * this period at all (exempt, no subscription, pre-subscription month — R1-6b).
   * A closed row is NOT frozen: a later recompute that finds usage REOPENS it
   * (closedAs back to null), which is exactly what the zero-freeze bug prevented.
   */
  closedAs?: "no-usage" | "never-billed" | null;
  closedReason?: string | null;
  /** Per-seafarer accrual ms + warnings, for admin explainability. */
  detail?: unknown;
};

/** Webhook idempotency ledger — Stripe redelivers, so every event is claimed once. */
export type StripeEventRow = {
  id: string;
  stripeEventId: string;
  type: string;
  receivedAt: string;
  /** null = a CRASHED claim (phase 1 ran, phase 3 did not) → reprocessed on redelivery. */
  processedAt: string | null;
};

/** T0 go-live snapshot row: a pair that was already readable when billing launched. */
export type BillingBaselineRow = {
  agentId: string;
  seafarerId: string;
  grantId: string;
  /** The go-live instant — intervals open here, never earlier (decision 3: no retro-billing). */
  openAt: string;
};

/** Singleton billing configuration + the lazily-created shared Stripe object ids. */
export type BillingSettings = {
  /** T0. null = billing is NOT launched — every agent's tier is `exempt` (global off-switch). */
  goLiveAt: string | null;
  stripeBaseProductId: string | null;
  stripeUsageProductId: string | null;
  stripeMeterId: string | null;
  /** R3-3 — the explicit Billing Portal Configuration (cancellation OFF). */
  stripePortalConfigId: string | null;
  defaults: { baseEurMonthly: number; perSeafarerEur: number };
  tosVersion: string;
};

/** The all-null / default BillingSettings a db.json without billing keys reads as. */
export const EMPTY_BILLING_SETTINGS: BillingSettings = {
  goLiveAt: null,
  stripeBaseProductId: null,
  stripeUsageProductId: null,
  stripeMeterId: null,
  stripePortalConfigId: null,
  defaults: { baseEurMonthly: 300, perSeafarerEur: 2 },
  tosVersion: "2026-08-1",
};

// ---- Password (credential) accounts — feat/password-signup -------------
//
// Username+password self-signup for BOTH roles (D1/D2). Hashes live ONLY in
// this collection — never on Seafarer/Agent (whole-object API returns) and
// never in an audit sink. A credential session NEVER carries an e-mail (D3).

export type ScryptHash = {
  /** scrypt cost params stored per record so params can be raised later without migration. */
  N: number;
  r: number;
  p: number;
  keylen: number;
  saltB64: string; // 16 random bytes, base64
  hashB64: string; // scrypt output, base64
};

export type RecoveryCode = {
  hash: ScryptHash;
  /** ISO instant when consumed; null = still valid. */
  usedAt: string | null;
};

export type CredentialUser = {
  id: string; // "cred:" + crypto.randomUUID()
  /** Display form as typed (NFC-normalized). */
  username: string;
  /** UNIQUE key (NFC + toLowerCase). */
  usernameLower: string;
  password: ScryptHash;
  /**
   * OPTIONAL, lower-cased, UNVERIFIED. Login-convenience identifier + future
   * verification target ONLY. NEVER written to Seafarer.ownerEmail /
   * Agent.googleEmail; NEVER matched against them. Not unique (D6).
   */
  emailUnverified?: string | null;
  /**
   * Role anchors (D2, v5): bound at signup / adoption / explicit confirmed
   * side-bind / 2f-b self-heal / admin rescue — NEVER minted by a plain
   * sign-in. Either/both may be set.
   */
  seafarerId?: string | null; // owned Seafarer.id (seaman side)
  agentId?: string | null; // "agent:p-<16hex>" (agent side, D4)
  /** 8 at signup (D7). */
  recoveryCodes: RecoveryCode[];
  createdAt: string;
  /**
   * Stamped by recovery-reset AND signed-in change-password (Step 13, D11);
   * feeds the `pwdAt` session-invalidation claim (Step 4/5, invariant 11).
   */
  passwordChangedAt?: string | null;
  /**
   * Outreach attribution (Increment 5, ADDITIVE — flagged db.json schema
   * change awaiting deploy sign-off). Present ONLY when the signup arrived
   * through a VERIFIED outreach CTA token whose send_key matched
   * ^LD\d{1,15}$; both fields are stamped together at create. Display-only
   * telemetry — never read by auth logic.
   */
  leadKey?: string;
  source?: "outreach";
};

// ---- "Book a call" bookings (lib/booking.ts) --------------------------
//
// Self-service booking rows + the singleton weekly-hours settings, stored in
// db.json so they reuse the existing mutex + atomic write + double-booking
// guard for free (booking-plan §Architecture). A booking's source of truth is
// its WALL-CLOCK in the business timezone: `date` + `time` + `tz`; slot
// generation / availability / double-booking all compare on `(date,time)`
// strings, so there is no wall-clock->instant math and no DST landmine (the
// only clock primitive is businessNowParts() in lib/booking.ts).
//
// RETENTION (R10): to keep the hot per-request read bounded, the Wave-2
// booking API drops stale rows on write via `compactBookings()` (lib/booking.ts)
// — cancelled rows + past `booked` rows older than 90 days. It is deliberately
// NOT wired into updateDB globally (that would surprise other callers).
export type Booking = {
  id: string;
  /** YYYY-MM-DD (business-tz wall-clock date). */
  date: string;
  /** HH:MM (business-tz wall-clock time). */
  time: string;
  /** IANA business timezone the wall-clock is interpreted in. */
  tz: string;
  name: string;
  email: string;
  company?: string;
  phone?: string;
  note?: string;
  /** Where the booking came from — public /book page vs an outreach link. */
  source: "public" | "outreach";
  /** Opaque outreach send_key ("LD"+digits) captured from /book?lead=. Present only
   * for source:"outreach"; sanitized (^LD\d{1,15}$) on both the client page and the
   * server route before persistence. Additive/optional — no migration. */
  leadKey?: string;
  /** Soft-delete: "cancelled" frees the slot for rebooking but keeps history. */
  status: "booked" | "cancelled";
  /** ISO instant the booking was created. */
  createdAt: string;
  /** ISO instant an admin marked it seen (R7 unseen-badge). Absent = unseen. */
  seenAt?: string;
  /** Google Calendar event id once this booking is synced to the shared calendar.
   * Set by the calendar-sync layer (Wave 3) — pure telemetry; create/delete always
   * recompute the id from `id` via eventIdFor(). */
  googleEventId?: string;
  /** Calendar-sync state; undefined / "pending" at creation, advanced by the
   * calendar-sync wave + the cron reconciler. Additive/optional — no migration.
   * Terminal states: "cancelled" (an admin cancelled the booking) and "abandoned"
   * (sync retries exhausted — CV6-2). */
  calendarSync?: "pending" | "synced" | "failed" | "cancelled" | "abandoned";
  /** How many calendar-sync push attempts the reconciler has made (CV6-2). Absent =
   * never attempted; drives the attempt cap that moves a stuck row to "abandoned". */
  syncAttempts?: number;
  /** Two-way availability (AV9-3): the FreeBusy busy-check outcome at booking time.
   * "ok" = a fresh Google busy-check passed; "skipped-outage" = the check could not run
   * (Google unreachable), so the booking was fail-OPEN and is flagged for the admin to
   * verify + the cron reconciler to re-check. Absent = calendar disabled / not checked.
   * Additive/optional — no migration. */
  busyCheck?: "ok" | "skipped-outage";
};

/**
 * Singleton booking configuration: the business timezone, slot length, how far
 * ahead bookings are offered, and the fixed weekly hours. `weekly` is keyed by
 * day-of-week 0..6 (0 = Sunday); a null value disables that weekday. Defaults
 * live in DEFAULT_BOOKING_SETTINGS (lib/booking.ts); validated via
 * validateSettings() before persistence.
 */
export type BookingSettings = {
  timezone: string;
  slotMinutes: number;
  horizonDays: number;
  weekly: Record<number, { start: string; end: string } | null>;
};

export type DB = {
  seafarers: Seafarer[];
  documents: Doc[];
  comments: Comment[];
  restHours: RestHourEntry[];
  agents: Agent[];
  assignments: Assignment[];
  accessGrants: AccessGrant[];
  /** Per-agent required-docs configuration (defaults to the researched baseline). */
  requiredDocsConfigs: RequiredDocsConfig[];
  /** Append-only audit of required-docs config edits. */
  requiredDocsAudit: RequiredDocsAuditRow[];
  /** Every outbound-notification attempt (sent, logged-only, or failed). */
  notifications: NotificationLog[];
  /** Dedupe ledger for the daily reminder cron (idempotent per doc+recipient+day). */
  remindersSent: ReminderSentEntry[];
  /** Company circulars/bulletins an agency broadcast to its roster. */
  circulars: Circular[];
  /** Seaman replies to circulars (the return leg of in-app messaging). */
  circularReplies: CircularReply[];
  /** Agent-raised document-request checklist items (collect-from-seaman loop). */
  docRequests: DocRequest[];
  /** Seaman-proposed personal-profile changes awaiting shore approval (T1.7). */
  profileChanges: ProfileChangeRequest[];
  /** Structured sea-service ledger — the digital discharge book (T2.2). */
  seaService: SeaServiceEntry[];
  /** Active admin "act as" records, keyed by admin e-mail (lib/impersonation.ts). */
  impersonations: Impersonation[];
  /** #38.5 — agent-side async requests for cross-agency profile propagation. */
  profileShareRequests: ProfileShareRequest[];
  /** #43 — typed interview / post-voyage appraisal scorecards. */
  appraisals: Appraisal[];
  /** #12 — seaman keep/delete consent requests for agent-deleted, ever-shared appraisals. */
  appraisalDeleteRequests: AppraisalDeleteRequest[];
  /** #45 — minimal issued-SEA terms, keyed to assignmentId (latest per assignment). */
  issuedSeaTerms: IssuedSeaRecord[];
  /** #42 — shipowner/client read-portals an agency built over a curated crew slice. */
  clientPortals: ClientPortal[];
  /** #52 — crewing vacancies an agency opened, matched against its granted roster. */
  vacancies: Vacancy[];
  /** Stripe billing — per-agent business info + subscription mirror (one row per agent). */
  billingProfiles: BillingProfile[];
  /** Stripe billing — computed monthly usage ledger + push-dedupe. */
  billingUsage: BillingUsageRow[];
  /** Stripe billing — webhook idempotency ledger. */
  stripeEvents: StripeEventRow[];
  /** Stripe billing — T0 go-live snapshot of already-readable pairs. */
  billingBaseline: BillingBaselineRow[];
  /** Stripe billing — singleton settings (go-live instant + shared Stripe object ids). */
  billingSettings: BillingSettings;
  /** feat/password-signup — username+password accounts (hashes live ONLY here). */
  credentialUsers: CredentialUser[];
  /** "Book a call" — self-service booking rows (see Booking + lib/booking.ts). */
  bookings: Booking[];
  /** "Book a call" — singleton weekly-hours settings; null = use DEFAULT_BOOKING_SETTINGS. */
  bookingSettings: BookingSettings | null;
  /** feat/manual-hold — operator hold/move override set; SOURCE OF TRUTH the
   *  outreach pipeline pulls each cycle (lib/outreach-overrides.ts). */
  outreachOverrides: OutreachOverrides;
};

// ---- Append-only, hash-chained audit sinks ----------------------------
//
// accessLog + consentEvents live OUTSIDE db.json in line-delimited (ndjson) sinks
// that are only ever appended to, never rewritten. Each entry stores IDs + hashes
// ONLY (never PII payloads — no passport numbers, no cert contents) and carries a
// `prevHash` linking it to the previous entry, so any tamper/reorder/delete breaks
// the chain. Appends run under the same in-process mutex as db.json writes (see
// `serialize`), so concurrent appends can't fork the chain.

export type AccessAction = "VIEWED" | "REVIEWED" | "DOWNLOADED" | "EXPORTED";

/** One agent access event. Subject/actor are IDs; documentRef is a document ID, never its contents. */
export type AccessLogEntry = {
  id: string;
  prevHash: string;
  hash: string;
  at: string;
  seafarerId: string;
  agentId: string;
  grantId: string | null;
  action: AccessAction;
  documentRef: string | null;
};

export type ConsentEventType =
  | "REQUESTED"
  | "GRANTED"
  | "BASIS_CHANGED"
  | "LOCKED"
  | "UNLOCKED"
  | "WITHDRAWN"
  // Hidden-crew delete — an AGENT removed a claimed/multi-agent profile from their own
  // view (revokes THEIR grant only; the seaman may re-grant from the portal).
  | "REVOKED_BY_AGENT"
  | "EXPIRED"
  | "REOPEN_DENIED"
  // #38 — cross-agency propagation consent toggled on / off (per bucket).
  | "PROPAGATION_GRANTED"
  | "PROPAGATION_WITHDRAWN"
  // #42 — a seaman toggled an agency's client-portal visibility on / off.
  | "CLIENT_VISIBLE_GRANTED"
  | "CLIENT_VISIBLE_WITHDRAWN"
  // #49 — an agency toggled its docka-verified directory consent on / off.
  | "DIRECTORY_CONSENT_GRANTED"
  | "DIRECTORY_CONSENT_WITHDRAWN";

export type ConsentEvent = {
  id: string;
  prevHash: string;
  hash: string;
  at: string;
  grantId: string;
  type: ConsentEventType;
  legalBasisAfter: LegalBasis | null;
  /** Actor as an ID reference, e.g. "seafarer:<id>", "agent:<id>", "system" — never a name. */
  actor: string;
  /** #38 — which propagation bucket a PROPAGATION_* event concerns (non-PII). */
  bucket?: "contact" | "financial";
};

/**
 * #38.5 — an agent-side ASYNC request for cross-agency propagation of a seaman's
 * personal overlay. This is a REQUEST, never a grant: it writes NO flag until the
 * seaman approves. Fail-closed — an unapproved request grants zero visibility.
 */
export type ProfileShareRequest = {
  id: string;
  seafarerId: string;
  agentId: string;
  bucket: "contact" | "financial";
  /** Agent name/email who raised it — display + audit. */
  requestedBy: string;
  status: "pending" | "approved" | "declined";
  createdAt: string;
  decidedAt?: string | null;
};

export type AuditSink =
  | "access-log"
  | "consent-events"
  | "admin-audit"
  | "portal-log"
  // Bug1 — dedicated OPERATIONAL sink for per-agent board hide/restore. Deliberately
  // SEPARATE from access-log (whose UNFILTERED last entry `reviewsForSeafarer` shows the
  // seaman as their most-recent agent action — a hide must never surface there) and from
  // consent-events (the GDPR legal ledger). Never read by any seaman-facing surface.
  | "board-events"
  // Verify-upload plan §2 — anonymous certificate-upload corpus events. PII-FREE
  // core by construction: date-rotated ipHash + itemId + content hashes only —
  // NEVER the original filename or a raw IP (those live in the DELETABLE
  // per-item sidecar, data/verify-uploads/<uuid>.json). Tail-hash-cached (see
  // TAIL_CACHED_SINKS below): this sink grows with every anonymous upload and
  // must not pay appendAuditRaw's whole-file re-read per append.
  | "verify-uploads"
  // feat/password-signup — credential-auth security events (SIGNUP, LOGIN_OK/
  // FAIL, RECOVERY_RESET_*, RATE_LIMITED aggregates, PROFILE_BIND, ADOPT_SKIPPED,
  // PASSWORD_CHANGE, CODES_REGENERATED). Entries carry { type, credId?, idHash?,
  // ipHash? } — idHash = first 16 hex of sha256(identifierLower), ipHash follows
  // the date-rotated verify-uploads pattern; NEVER a raw username, e-mail, IP,
  // token, or any secret. Every per-request type is bounded by a Step 3 rate
  // bucket; RATE_LIMITED is only ever a per-bucket 10-minute AGGREGATE line
  // (lib/auth-rate-limit.ts) — never per-request. NOT tail-cached (the single-
  // slot tailCache belongs to verify-uploads; sharing it would thrash).
  // Retention: this sink holds hash-only pseudonymized security data (ids,
  // sha256 prefixes, date-rotated ipHash — never raw identifiers), retained for
  // abuse forensics under security legitimate interest — GDPR-defensible as
  // stated; there is no raw identifier to erase.
  | "auth-events";

/** Bug1 — one board hide/restore/delete event. IDs only; no PII. Hash-chained like every sink. */
export type BoardEventAction = "BOARD_HIDDEN" | "BOARD_RESTORED" | "BOARD_DELETED";
export type BoardEvent = {
  id: string;
  prevHash: string;
  hash: string;
  at: string;
  grantId: string;
  seafarerId: string;
  agentId: string;
  action: BoardEventAction;
  /** BOARD_DELETED only: "view" = caller's grant revoked; "hard" = row + cascade erased. */
  mode?: "view" | "hard";
};

// ---- Impersonation (admin "act as") -----------------------------------
//
// A server-side record — NOT a token/cookie — keyed by the admin's verified
// e-mail (<=1 active per admin). The admin keeps their own Google JWT; this row
// says who they are currently acting as. See lib/impersonation.ts.
export type ImpersonationTargetKind = "seaman" | "agent";
export type Impersonation = {
  /** Verified, lower-cased admin e-mail (the KEY; at most one row per admin). */
  adminEmail: string;
  targetKind: ImpersonationTargetKind;
  /** Seafarer uuid OR agent id ("agent:*"). */
  targetId: string;
  startedAt: number;
  /** startedAt + TTL — a tombstone past this instant (suspended, never own-identity). */
  expiresAt: number;
};

// ---- Impersonation audit stamp (F1: explicit, REQUIRED threading) ------
//
// Every audit-funnel call (appendAuditRaw / appendAudit / transact) MUST declare
// whether it is an impersonated write. A real impersonated write passes an
// AuditStamp; every other caller passes the AUDIT_NO_IMPERSONATION sentinel.
// The arg is REQUIRED (no default) at the funnel, so a NEW writer added later
// cannot silently ship unattributed — it will not compile without the arg. This
// makes audit under-attribution impossible-by-construction.
export type AuditStamp = { impersonator: string; onBehalfOf: string };
export const AUDIT_NO_IMPERSONATION: unique symbol = Symbol("no-impersonation");
export type AuditOnBehalf = AuditStamp | typeof AUDIT_NO_IMPERSONATION;

// ---- Storage -----------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const SINK_PATH: Record<AuditSink, string> = {
  "access-log": path.join(DATA_DIR, "access-log.ndjson"),
  "consent-events": path.join(DATA_DIR, "consent-events.ndjson"),
  "admin-audit": path.join(DATA_DIR, "admin-audit.ndjson"),
  // #42/#49 — portal + directory view/search audit (id + at + type + coarse count
  // ONLY; never names / query text / DOB). Hash-chained like the other sinks.
  "portal-log": path.join(DATA_DIR, "portal-log.ndjson"),
  // Bug1 — per-agent board hide/restore operational trail (ids only, hash-chained).
  "board-events": path.join(DATA_DIR, "board-events.ndjson"),
  // Verify-upload plan §2 — anonymous upload corpus trail (PII-free, hash-chained).
  "verify-uploads": path.join(DATA_DIR, "verify-upload-events.ndjson"),
  // feat/password-signup — credential-auth security trail (hash-only, see union).
  "auth-events": path.join(DATA_DIR, "auth-events.ndjson"),
};

const EMPTY: DB = {
  seafarers: [],
  documents: [],
  comments: [],
  restHours: [],
  agents: [],
  assignments: [],
  accessGrants: [],
  requiredDocsConfigs: [],
  requiredDocsAudit: [],
  notifications: [],
  remindersSent: [],
  circulars: [],
  circularReplies: [],
  docRequests: [],
  profileChanges: [],
  seaService: [],
  impersonations: [],
  profileShareRequests: [],
  appraisals: [],
  appraisalDeleteRequests: [],
  issuedSeaTerms: [],
  clientPortals: [],
  vacancies: [],
  billingProfiles: [],
  billingUsage: [],
  stripeEvents: [],
  billingBaseline: [],
  billingSettings: { ...EMPTY_BILLING_SETTINGS },
  credentialUsers: [],
  bookings: [],
  bookingSettings: null,
  outreachOverrides: {
    version: 0,
    holds: { leads: [], companies: [] },
    moves: [],
    moveSeq: 0,
    // reply desk wave 3 M2 — operator draft decisions (Approve / Reject).
    draftActions: [],
    draftActionSeq: 0,
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
};

// ---- #12(critic) single-instance boot guard ---------------------------
//
// The mutex + hash-chain correctness assumes ONE Node process (owner decision D1). A
// pm2 CLUSTER (`pm2 scale docka 2`) would fork the chain silently. PRIMARY guard: a
// non-zero pm2 instance id hard-fails at module load (fail loud, never fork). The
// `.docka.lock` is best-effort belt-and-braces: it records this pid and warns (never
// throws — throwing would break Next's multi-worker BUILD, which forks child procs
// that import this module). Stale-lock tolerant: a lock whose pid is dead is ignored.
(function assertSingleInstance(): void {
  const inst = Number(process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? 0);
  if (Number.isFinite(inst) && inst > 0) {
    throw new Error(
      `docka refuses to start as pm2 instance ${inst}: the JSON store's mutex + audit ` +
        `hash chains require a SINGLE process. Run docka with exactly one instance ` +
        `(pm2 'exec_mode: fork', instances: 1) — never a cluster.`
    );
  }
  // Only take the advisory lock at RUNTIME, never during a build (NEXT_PHASE is set by
  // next build). Best-effort; failures are logged, never fatal.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const lockPath = path.join(DATA_DIR, ".docka.lock");
    if (fs.existsSync(lockPath)) {
      const holder = Number(fs.readFileSync(lockPath, "utf-8").trim());
      let alive = false;
      if (Number.isFinite(holder) && holder > 0 && holder !== process.pid) {
        try {
          process.kill(holder, 0); // signal 0 — existence check only
          alive = true;
        } catch {
          alive = false; // ESRCH -> dead -> stale lock, ignore
        }
      }
      if (alive) {
        console.warn(
          `[docka] WARNING: data/.docka.lock is held by a live pid ${holder}. A second ` +
            `process on the same JSON store can corrupt the audit chains. Ensure only one runs.`
        );
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");
  } catch {
    /* best-effort — a locked/read-only data dir must not prevent boot */
  }
})();

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2), "utf-8");
  }
}

export function readDB(): DB {
  ensureFile();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DB>;
    let migratedTokens = false;
    const built: DB = {
      // Backfill new fields on legacy rows so older db.json files keep working.
      seafarers: (parsed.seafarers ?? []).map((s) => {
        const r = s as Partial<Seafarer>;
        // --- Two-token share migration (open link + private/email link) ----------
        // openShareToken inherits the legacy single `shareToken` so existing OPEN
        // links keep working; emailShareToken is minted ONCE if absent. `shareToken`
        // is kept as an ALIAS of openShareToken. readDB() runs FULLY synchronously
        // (no await), so on the single-threaded event loop the first read mints AND
        // persists these before any other request's readDB can observe the row — a
        // minted private-link token is therefore stable across requests.
        const openShareToken = r.openShareToken ?? r.shareToken ?? shareToken();
        let emailShareToken = r.emailShareToken ?? "";
        if (!emailShareToken || emailShareToken === openShareToken) {
          emailShareToken = shareToken();
          while (emailShareToken === openShareToken) emailShareToken = shareToken();
        }
        if (
          r.openShareToken !== openShareToken ||
          r.emailShareToken !== emailShareToken ||
          r.shareToken !== openShareToken
        ) {
          migratedTokens = true;
        }
        return {
          ...r,
          rank: r.rank ?? "",
          state: isSeafarerState(r.state) ? r.state : "review",
          // Seaman-declared availability — legacy rows keep "Not set" (undefined);
          // availableFrom is normalised to a yyyy-mm-dd and only kept meaningful for
          // the open_from state (cleared to null otherwise on write).
          availability: isAvailability(r.availability) ? r.availability : undefined,
          availableFrom:
            typeof r.availableFrom === "string" && r.availableFrom
              ? r.availableFrom.slice(0, 10)
              : null,
          vessel: r.vessel ?? null,
          rotationEnd: r.rotationEnd ?? null,
          googleSub: r.googleSub ?? null,
          ownerEmail: r.ownerEmail ?? null,
          // feat/password-signup — credential owner back-pointer, null on legacy rows.
          credentialUserId: r.credentialUserId ?? null,
          // Additive/optional import contact field — defaults to null on legacy rows.
          importedEmail: r.importedEmail ?? null,
          autoArchiveExpired: r.autoArchiveExpired ?? false,
          openShareToken,
          emailShareToken,
          // Alias — always equals openShareToken so legacy `shareToken` readers work.
          shareToken: openShareToken,
          allowedEmails: Array.isArray(r.allowedEmails) ? r.allowedEmails : [],
          // Verified-identity fields default to "not verified" on legacy rows; they
          // are only ever populated by a live registry verification.
          identityVerified: r.identityVerified ?? false,
          identityVerifiedAt: r.identityVerifiedAt ?? null,
          verifiedName: r.verifiedName ?? null,
          personalCode: r.personalCode ?? null,
          birthDate: r.birthDate ?? null,
          photoUrl: r.photoUrl ?? null,
          issuerCountry: r.issuerCountry ?? null,
          // Local, durable profile-photo references default to "none" on legacy rows;
          // the verified one is filled by the server-side download on owner load.
          verifiedPhotoFile: r.verifiedPhotoFile ?? null,
          customPhotoFile: r.customPhotoFile ?? null,
          // Expiry-reminder calendar settings — read-migration defaults so legacy
          // rows behave as "1 month before, 3 reminders, every 14 days".
          reminderLeadValue:
            typeof r.reminderLeadValue === "number" && r.reminderLeadValue > 0
              ? r.reminderLeadValue
              : 1,
          reminderLeadUnit:
            r.reminderLeadUnit === "weeks" || r.reminderLeadUnit === "days"
              ? r.reminderLeadUnit
              : "months",
          reminderCount:
            typeof r.reminderCount === "number" && r.reminderCount > 0 ? r.reminderCount : 3,
          reminderIntervalDays:
            typeof r.reminderIntervalDays === "number" && r.reminderIntervalDays > 0
              ? r.reminderIntervalDays
              : 14,
          // Seaman self-service personal profile — defaults to empty on legacy rows;
          // only ever populated by an APPROVED ProfileChangeRequest.
          selfProfile:
            r.selfProfile && typeof r.selfProfile === "object" ? r.selfProfile : {},
          // In-app inbox highwater — undefined on legacy rows (everything unread
          // until the seaman first opens the inbox). Additive, no data migration.
          inboxLastSeenAt:
            typeof r.inboxLastSeenAt === "string" ? r.inboxLastSeenAt : undefined,
          // Person-match identity fields (#37) — additive/optional, default null/[].
          passportNo: r.passportNo ?? null,
          seamanBookNo: r.seamanBookNo ?? null,
          mergedFrom: Array.isArray(r.mergedFrom) ? r.mergedFrom : [],
          priorShareTokens: Array.isArray(r.priorShareTokens) ? r.priorShareTokens : [],
          // Propagation defaults (#38.1) — OPT-IN: legacy seamen default FALSE.
          propagateContactByDefault: r.propagateContactByDefault ?? false,
          propagateFinancialByDefault: r.propagateFinancialByDefault ?? false,
          // #41 employment / CBA — tolerant reads; legacy rows default off/null.
          cbaCovered: r.cbaCovered ?? false,
          cbaRef: r.cbaRef ?? null,
          // #49 directory opt-in — OPT-IN: legacy seamen default FALSE (fail-closed).
          directoryOptIn: r.directoryOptIn ?? false,
        } as Seafarer;
      }),
      documents: (parsed.documents ?? []).map((d) => {
        const r = d as Partial<Doc>;
        // Legacy rows: a government code implies government source; anything else
        // with a validity implies it was verified; otherwise manual/plain.
        const source: DocSource =
          r.source ?? (r.docCategory ? "government" : "manual");
        // Best-effort classify any document that reaches us without a required-type
        // tag (all legacy/seeded rows, and any real upload we couldn't tag at write
        // time). Without this, completeness collapses to 0/N for the whole fleet and
        // the "Problems"/"Missing documents" filters match everyone.
        const requiredType =
          r.requiredType ??
          classifyRequiredType({
            title: r.title,
            docType: r.docType,
            docCategory: r.docCategory,
          });
        // Expiry trust: a photo's date is an OCR guess (unconfirmed) unless the
        // seaman later confirmed it; government + manual/typed dates are trusted.
        const expiryConfirmed =
          r.expiryConfirmed ?? (source === "photo" ? false : true);
        // Duplicate-detection number: explicit cert number, else the registry
        // code (a verified doc's code IS its comparable number). Legacy rows get
        // this for free so cross-crew duplicates are caught without a migration.
        const certNumber = r.certNumber ?? r.estonianCode ?? null;
        // Registry country (plan §4.1): keyed on `source === "government"`
        // ONLY — every legacy government doc is Estonian. A `source:"manual"`
        // row with an (unverified) estonianCode is NOT labeled EE: its code
        // was never verified against any registry.
        const registryCountry =
          r.registryCountry ?? (source === "government" ? "EE" : null);
        // Key-trust (plan §4.10): legacy government rows are EE access-token
        // verifications — default "capability-token" so the strict §2.5 gate
        // in applyVerifiedIdentity keeps healing pre-migration EE snapshots.
        const verifiedKeyTrust =
          r.verifiedKeyTrust ?? (source === "government" ? "capability-token" : undefined);
        return {
          docCategory: null,
          isValid: null,
          validUntil: null,
          reviewStatus: "pending",
          reviewedBy: null,
          reviewedAt: null,
          ...r,
          source,
          requiredType,
          expiryConfirmed,
          certNumber,
          registryCountry,
          verifiedKeyTrust,
          archived: r.archived ?? false,
          archivedAt: r.archivedAt ?? null,
          // #41 — SEA/employment-agreement end date; tolerant read, default null.
          seaEndDate: r.seaEndDate ?? null,
          // Non-destructive display rotation; anything but a valid quarter-turn
          // (incl. missing on legacy rows) backfills to 0 (upright).
          rotation:
            r.rotation === 90 || r.rotation === 180 || r.rotation === 270 ? r.rotation : 0,
        } as Doc;
      }),
      comments: (parsed.comments ?? []).map((c) => {
        const r = c as Partial<Comment>;
        return { documentId: r.documentId ?? null, ...r } as Comment;
      }),
      restHours: (parsed.restHours ?? []).map((e) => {
        const r = e as Partial<RestHourEntry>;
        return {
          id: r.id ?? "",
          seafarerId: r.seafarerId ?? "",
          date: r.date ?? "",
          hoursRest: typeof r.hoursRest === "number" ? r.hoursRest : Number(r.hoursRest) || 0,
          createdAt: r.createdAt ?? new Date().toISOString(),
          // Public Sample Profiles: curated-row marker passthrough.
          ...(r.sample === true ? { sample: true as const } : null),
        } as RestHourEntry;
      }),
      // New multi-tenant collections default to empty on legacy db.json files.
      agents: (parsed.agents ?? []) as Agent[],
      assignments: (parsed.assignments ?? []).map((a) => {
        const r = a as Partial<Assignment>;
        return {
          id: r.id ?? "",
          seafarerId: r.seafarerId ?? "",
          agentId: r.agentId ?? "",
          vessel: r.vessel ?? null,
          sentToSeaAt: r.sentToSeaAt ?? new Date().toISOString(),
          returnedAt: r.returnedAt ?? null,
          closedReason: r.closedReason ?? null,
          requiredSnapshot: r.requiredSnapshot ?? null,
          createdAt: r.createdAt ?? new Date().toISOString(),
          // Public Sample Profiles: the curated-row marker must survive the read
          // rebuild (only ever `true`, and only ever seed-written).
          ...(r.sample === true ? { sample: true as const } : null),
        } as Assignment;
      }),
      accessGrants: (parsed.accessGrants ?? []).map((g) => {
        const r = g as Partial<AccessGrant>;
        return {
          id: r.id ?? "",
          seafarerId: r.seafarerId ?? "",
          agentId: r.agentId ?? "",
          status: r.status ?? "PENDING",
          legalBasis: r.legalBasis ?? "CONSENT",
          scope: r.scope ?? ["profile", "documents", "log"],
          shareToken: r.shareToken ?? "",
          grantedAt: r.grantedAt ?? null,
          revokedAt: r.revokedAt ?? null,
          expiresAt: r.expiresAt ?? null,
          createdAt: r.createdAt ?? new Date().toISOString(),
          // Defensive: leave `stage` ABSENT when not a valid state so the one-time
          // backfill below can detect "never set". stageUpdatedAt only kept if finite.
          stage: isSeafarerState(r.stage) ? r.stage : undefined,
          stageUpdatedAt:
            typeof r.stageUpdatedAt === "number" && Number.isFinite(r.stageUpdatedAt)
              ? r.stageUpdatedAt
              : undefined,
          // #37 merge tombstone pointer — undefined unless this grant was absorbed.
          mergedIntoGrantId:
            typeof r.mergedIntoGrantId === "string" ? r.mergedIntoGrantId : undefined,
          // Bug1 per-agent BOARD hide — carry the ISO instant through the read
          // rebuild; anything non-string (incl. legacy/missing rows) => null (visible).
          hiddenByAgentAt: typeof r.hiddenByAgentAt === "string" ? r.hiddenByAgentAt : null,
          // #38 propagation flags — OPT-IN: legacy/back-catalog grants default FALSE
          // (the personal overlay is hidden from agencies that never got explicit
          // consent; doc visibility is unchanged — tolerant read, no throw).
          propagateContact: r.propagateContact ?? false,
          propagateFinancial: r.propagateFinancial ?? false,
          // #42/#49 client-portal + directory consent — OPT-IN: default FALSE
          // (fail-closed; a legacy grant exposes nobody until explicitly toggled).
          clientVisible: r.clientVisible ?? false,
          directoryConsent: r.directoryConsent ?? false,
          // Public Sample Profiles: the curated-row marker must survive the read
          // rebuild (only ever `true`, and only ever seed-written).
          ...(r.sample === true ? { sample: true as const } : null),
        } as AccessGrant;
      }),
      // New required-docs collections default to empty on legacy db.json files.
      requiredDocsConfigs: (parsed.requiredDocsConfigs ?? []) as RequiredDocsConfig[],
      requiredDocsAudit: (parsed.requiredDocsAudit ?? []) as RequiredDocsAuditRow[],
      // Notification channel collections default to empty on legacy db.json files.
      notifications: (parsed.notifications ?? []) as NotificationLog[],
      remindersSent: (parsed.remindersSent ?? []) as ReminderSentEntry[],
      // Company-circulars collection defaults to empty on legacy db.json files.
      circulars: (parsed.circulars ?? []) as Circular[],
      // Seaman replies to circulars default to empty on legacy db.json files.
      circularReplies: (parsed.circularReplies ?? []) as CircularReply[],
      // Document-request checklist items default to empty on legacy db.json files.
      docRequests: (parsed.docRequests ?? []) as DocRequest[],
      // Seaman self-service change queue defaults to empty on legacy db.json files.
      profileChanges: (parsed.profileChanges ?? []) as ProfileChangeRequest[],
      // Sea-service ledger defaults to empty on legacy db.json files.
      seaService: (parsed.seaService ?? []) as SeaServiceEntry[],
      // Admin impersonation records default to empty on legacy db.json files.
      impersonations: (parsed.impersonations ?? []) as Impersonation[],
      // #38.5 async propagation requests default to empty on legacy db.json files.
      profileShareRequests: (parsed.profileShareRequests ?? []) as ProfileShareRequest[],
      // #43 appraisals + #45 issued-SEA terms default to empty on legacy db.json files.
      appraisals: (parsed.appraisals ?? []) as Appraisal[],
      // #12 seaman keep/delete consent requests default to empty on legacy db.json files.
      appraisalDeleteRequests: (parsed.appraisalDeleteRequests ?? []) as AppraisalDeleteRequest[],
      issuedSeaTerms: (parsed.issuedSeaTerms ?? []) as IssuedSeaRecord[],
      // #42 client-portals + #52 vacancies default to empty on legacy db.json files
      // (tolerant read — no migration file, no destructive rewrite).
      clientPortals: (parsed.clientPortals ?? []) as ClientPortal[],
      vacancies: (parsed.vacancies ?? []) as Vacancy[],
      // Stripe billing collections default to empty on every pre-billing db.json —
      // tolerant read, no migration file, no destructive rewrite. A db.json with no
      // billing keys at all loads and behaves exactly as before (goLiveAt null =
      // billing dormant, plan §4 "Enforcement fail-open by design pre-launch").
      billingProfiles: (parsed.billingProfiles ?? []).map((p) => {
        const r = p as Partial<BillingProfile>;
        return {
          ...r,
          // R1/R2/R3 field deltas default on rows written by an earlier build.
          canceledAt: r.canceledAt ?? null,
          billingActiveFrom: r.billingActiveFrom ?? null,
          billingRequiredSince: r.billingRequiredSince ?? null,
          lastInvoiceEventCreated:
            typeof r.lastInvoiceEventCreated === "number" ? r.lastInvoiceEventCreated : null,
          lastSubscriptionEventCreated:
            typeof r.lastSubscriptionEventCreated === "number"
              ? r.lastSubscriptionEventCreated
              : null,
        } as BillingProfile;
      }),
      billingUsage: (parsed.billingUsage ?? []).map((u) => {
        const r = u as Partial<BillingUsageRow>;
        // R1-1 pushAttemptedAt defaults to the confirmed push instant on legacy rows
        // (a row that is already pushed was, by construction, also attempted).
        //
        // D-G read-migration: BEFORE the closedAs model, a zero month was closed by
        // stamping `pushedToStripeAt` + `stripeMeterEventId: "no-usage"`. Such a row is
        // recognised as the closedAs equivalent so the done-check keeps working on a
        // db.json written by the older build.
        const legacyNoUsage = r.stripeMeterEventId === "no-usage";
        if (legacyNoUsage && !r.closedAs) {
          // N3 — "no-usage" was a SENTINEL, never a meter-event id: Stripe was never
          // called for these rows. Carrying the stamps over would leave the row frozen
          // by `recordUsageForPeriod` (which freezes on pushAttemptedAt/pushedToStripeAt)
          // so the D-G reopen path could never fire — a legacy zero month stuck at 0
          // forever, which is the very fossilisation finding 1 exists to undo. The
          // stamps are cleared as part of translating the row into the closedAs model.
          return {
            ...r,
            pushAttemptedAt: null,
            pushedToStripeAt: null,
            stripeMeterEventId: null,
            closedAs: "no-usage",
            closedReason: r.closedReason ?? "migrated from the legacy no-usage close",
          } as BillingUsageRow;
        }
        return {
          ...r,
          pushAttemptedAt: r.pushAttemptedAt ?? r.pushedToStripeAt ?? null,
          closedAs: r.closedAs ?? null,
          closedReason: r.closedReason ?? null,
        } as BillingUsageRow;
      }),
      stripeEvents: (parsed.stripeEvents ?? []) as StripeEventRow[],
      billingBaseline: (parsed.billingBaseline ?? []) as BillingBaselineRow[],
      billingSettings: {
        ...EMPTY_BILLING_SETTINGS,
        ...((parsed.billingSettings ?? {}) as Partial<BillingSettings>),
        defaults: {
          ...EMPTY_BILLING_SETTINGS.defaults,
          ...(((parsed.billingSettings ?? {}) as Partial<BillingSettings>).defaults ?? {}),
        },
      },
      // feat/password-signup — credential accounts default to empty on legacy
      // db.json files (tolerant read, no migration).
      credentialUsers: (parsed.credentialUsers ?? []) as CredentialUser[],
      // "Book a call" — bookings + singleton settings default to empty/null on
      // legacy db.json files (additive optional read, no migration).
      bookings: (parsed.bookings ?? []) as Booking[],
      bookingSettings: (parsed.bookingSettings ?? null) as BookingSettings | null,
      // feat/manual-hold — legacy db.json loads with an empty override set
      // (tolerant read-migration, no data migration).
      outreachOverrides: migrateOverrides(parsed.outreachOverrides),
    };
    // --- One-time per-agent stage backfill (F2) -----------------------------------
    // Every grant that has no stage yet inherits the seaman's current global
    // `Seafarer.state`, so day-1 every agency's board is IDENTICAL to before the
    // migration (F6). stageUpdatedAt seeds from createdAt (NOT Date.now(), which would
    // make every legacy grant look freshly touched); guarded with Number.isFinite so a
    // malformed createdAt leaves stageUpdatedAt absent (read-time default then applies).
    // Idempotent by DATA PRESENCE: after the first persist every grant has a concrete
    // stage, so isSeafarerState(r.stage) is true on later reads and nothing re-runs.
    // Race-safe by the same argument as the token migration (synchronous in-read write).
    let migratedGrantStage = false;
    const seamanById = new Map<string, Seafarer>();
    for (const s of built.seafarers) seamanById.set(s.id, s);
    for (const grant of built.accessGrants) {
      if (grant.stage === undefined) {
        grant.stage = seamanById.get(grant.seafarerId)?.state ?? "review";
        const parsed = Date.parse(grant.createdAt);
        if (Number.isFinite(parsed)) grant.stageUpdatedAt = parsed;
        migratedGrantStage = true;
      }
    }
    // Persist the one-time two-token migration so freshly-minted private-link tokens
    // are durable, AND the one-time stage backfill above. Runs at most once per legacy
    // row (subsequent reads find both tokens / a concrete stage and rewrite nothing).
    // writeAtomic is synchronous, so this completes before readDB returns and cannot
    // race a concurrent reader on the single-threaded loop.
    if (migratedTokens || migratedGrantStage) {
      try {
        writeAtomic(built);
      } catch {
        /* best-effort — retried on the next read if it failed */
      }
    }
    return built;
  } catch {
    // Corrupt/empty file — reset to a safe empty state rather than crash.
    return { ...EMPTY };
  }
}

// Windows-safe atomic replace. On Windows `rename` over an EXISTING file is NOT
// guaranteed atomic and can throw EEXIST/EPERM, so: write a unique temp file,
// fsync it to durable storage, then rename it into place — retrying the rename a
// few times to ride out a transient AV/indexer lock on the target. Correctness of
// "no concurrent writer" comes from the mutex below; this only guarantees a reader
// never sees a half-written file and that the bytes are flushed to disk.
function writeFileSyncDurable(file: string, data: string): void {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicReplace(target: string, data: string): void {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  writeFileSyncDurable(tmp, data);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      // EEXIST/EPERM/EACCES on Windows: the target is momentarily locked. Remove
      // it and retry the rename (still single-writer, so this is race-free).
      if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
        try {
          fs.unlinkSync(target);
        } catch {
          /* ignore — retry the rename anyway */
        }
        continue;
      }
      break;
    }
  }
  // Give up on rename: fall back to a durable in-place write so we never lose the
  // update, then clean the temp file.
  try {
    writeFileSyncDurable(target, data);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  if (!fs.existsSync(target)) throw lastErr ?? new Error("atomicReplace failed");
}

function writeAtomic(db: DB): void {
  ensureFile();
  atomicReplace(DB_PATH, JSON.stringify(db, null, 2));
}

export function writeDB(db: DB): void {
  writeAtomic(db);
}

// ---- Single in-process mutex ------------------------------------------
//
// Next dev/prod runs a SINGLE Node process (the proto is pinned to one instance —
// documented owner decision D1), so one in-process promise chain serialises EVERY
// db.json mutation AND every audit-sink append. Each critical section runs to
// completion before the next begins — no lost updates, no forked hash chains.
// (When the DB+RLS migration lands, this is replaced by DB transactions.)
let writeLock: Promise<unknown> = Promise.resolve();

// Test-only observability: how many critical sections have been ENTERED through the
// shared mutex. Lets a concurrency test assert the write-lock was actually taken the
// expected number of times, so a future refactor that turns `serialize` into a no-op
// (last-writer-wins) can't leave the lock-proof test vacuous-but-green. Never used by
// product code — purely a falsifiability pin.
let serializeEntries = 0;
/** Test hook: total number of critical sections entered via `serialize`. */
export function _serializeEntryCount(): number {
  return serializeEntries;
}

/** Run `fn` in the shared critical section. All writers (db.json + audit) use this. */
export function serialize<T>(fn: () => T | Promise<T>): Promise<T> {
  serializeEntries++;
  const run = writeLock.then(() => fn());
  // Keep the chain alive even if this operation throws.
  writeLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function updateDB<T>(mutator: (db: DB) => T): Promise<T> {
  return serialize(() => {
    const db = readDB();
    const result = mutator(db);
    writeAtomic(db);
    return result;
  });
}

// ---- Audit sink: append-only, hash-chained ----------------------------

// Deterministic stringify for hashing: flat entry, keys sorted, so db.ts and the
// seed script (scripts/seed-curated.mjs) compute byte-identical hashes.
function stableStringify(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/** hash = sha256(prevHash + "|" + stable(core)); core = the entry MINUS prevHash & hash. */
function chainHash(prevHash: string, core: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(`${prevHash}|${stableStringify(core)}`).digest("hex");
}

const GENESIS = "GENESIS";

function readSinkLines(sink: AuditSink): string[] {
  const p = SINK_PATH[sink];
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function lastHash(sink: AuditSink): string {
  const lines = readSinkLines(sink);
  if (lines.length === 0) return GENESIS;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]) as { hash?: string };
    return parsed.hash ?? GENESIS;
  } catch {
    return GENESIS;
  }
}

// ---- Verify-upload tail-hash cache (plan §2, architect r2 #1) ----------
//
// appendAuditRaw re-reads the WHOLE sink per append; fine for the low-volume
// sinks, O(n²) for the corpus trail that grows with every anonymous upload.
// SCOPED to the verify-uploads sink ONLY (single writer by construction — every
// append runs through appendAudit under the shared mutex): remember the last
// appended {hash, file size}; a subsequent append whose fs.stat size matches
// reuses the hash without any read. Size mismatch (external append, truncation,
// manual edit) → drop the cache and seek-read only the file's TAIL for the last
// line. Other sinks keep the current whole-file behavior byte-for-byte.
const TAIL_CACHED_SINKS: ReadonlySet<AuditSink> = new Set(["verify-uploads"]);
const TAIL_READ_BYTES = 64 * 1024; // far above any single PII-free event line
let tailCache: { sink: AuditSink; hash: string; size: number } | null = null;

function hashFromLastLine(chunk: string): string | null {
  const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]) as { hash?: string };
    return parsed.hash ?? GENESIS;
  } catch {
    return null;
  }
}

function lastHashTailCached(sink: AuditSink): string {
  const p = SINK_PATH[sink];
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    tailCache = null;
    return GENESIS; // sink file does not exist yet
  }
  if (tailCache && tailCache.sink === sink && tailCache.size === size) return tailCache.hash;
  tailCache = null;

  // Seek-read the tail only. If the tail window holds no complete line (a
  // pathological over-long line), fall back to the whole-file read.
  let hash: string | null = null;
  const start = Math.max(0, size - TAIL_READ_BYTES);
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      hash = hashFromLastLine(buf.toString("utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    hash = null;
  }
  if (hash === null) hash = lastHash(sink); // fallback: whole-file read
  tailCache = { sink, hash, size };
  return hash;
}

// Low-level append. ASSUMES it is already inside the shared critical section
// (called by `appendAudit` and `transact`). Reads the tail hash + appends in one
// go — safe only because a single writer holds the mutex.
function appendAuditRaw<T extends Record<string, unknown>>(
  sink: AuditSink,
  core: T,
  onBehalf: AuditOnBehalf
): T & { prevHash: string; hash: string } {
  // F1 — the ONE merge site for the impersonation stamp. A non-impersonated write
  // (sentinel) is byte-identical to before; an impersonated write merges the stamp
  // into the hashed core so attribution is part of the tamper-evident chain.
  const stamped: Record<string, unknown> =
    onBehalf === AUDIT_NO_IMPERSONATION ? core : { ...core, ...onBehalf };
  const cached = TAIL_CACHED_SINKS.has(sink);
  const prevHash = cached ? lastHashTailCached(sink) : lastHash(sink);
  const hash = chainHash(prevHash, stamped);
  const entry = { ...stamped, prevHash, hash };
  fs.appendFileSync(SINK_PATH[sink], JSON.stringify(entry) + "\n", "utf-8");
  if (cached) {
    // Record the post-append size so the next append can skip the read; a
    // stat failure just drops the cache (correctness never depends on it).
    try {
      tailCache = { sink, hash, size: fs.statSync(SINK_PATH[sink]).size };
    } catch {
      tailCache = null;
    }
  }
  return entry as T & { prevHash: string; hash: string };
}

/**
 * Append one entry to an audit sink under the shared mutex. `core` MUST contain
 * id + at + the ID/hash-only payload (NEVER PII). Returns the stored entry with
 * its prevHash/hash filled in. Because the read-of-prevHash and the append happen
 * inside the same critical section, concurrent appends cannot fork the chain.
 * Use this ONLY for a standalone log with no db.json change; if you also mutate
 * db.json, use `transact` so the write + append share one critical section.
 */
export function appendAudit<T extends Record<string, unknown>>(
  sink: AuditSink,
  core: T,
  onBehalf: AuditOnBehalf
): Promise<T & { prevHash: string; hash: string }> {
  return serialize(() => {
    ensureFile();
    return appendAuditRaw(sink, core, onBehalf);
  });
}

/**
 * Idempotent audit append (the mutex-guarded
 * scan-before-append that REPLACES an impossible unique DB index, since this store
 * is a hash-chained JSONL FILE, not a relational table).
 *
 * Runs the DUPLICATE SCAN and the APPEND inside the SAME `serialize()` critical
 * section (the one lock that already serialises every chain append), so two
 * concurrent callers race safely: the loser sees the winner's line and appends
 * NOTHING. `isDuplicate` is evaluated against each already-parsed sink entry; the
 * FIRST match short-circuits with `{ appended: false }`. On no match, one line is
 * appended via the same hash-chained `appendAuditRaw` and `{ appended: true }` is
 * returned. Malformed lines are skipped by the scan (never a false "duplicate").
 *
 * Use for at-most-once audit facts keyed on a business tuple (e.g. a job
 * runId + completion phase). For a plain always-append line use `appendAudit`.
 */
export function appendAuditOnce<T extends Record<string, unknown>>(
  sink: AuditSink,
  isDuplicate: (existing: Record<string, unknown>) => boolean,
  core: T,
  onBehalf: AuditOnBehalf
): Promise<{ appended: boolean; entry: (T & { prevHash: string; hash: string }) | null }> {
  return serialize(() => {
    ensureFile();
    for (const line of readSinkLines(sink)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a malformed line is never a match — fail toward appending
      }
      if (isDuplicate(parsed)) return { appended: false, entry: null };
    }
    return { appended: true, entry: appendAuditRaw(sink, core, onBehalf) };
  });
}

/**
 * Atomic db.json mutation + audit append(s) in ONE critical section. The mutator
 * receives the db and an `audit(sink, core)` collector; db.json is written first,
 * then the buffered audit entries are hash-chained and appended — all before the
 * mutex is released, so nothing interleaves and no chain forks. Never call
 * `updateDB`/`appendAudit`/`serialize` from inside `fn` (that would deadlock).
 */
export function transact<T>(
  fn: (db: DB, audit: (sink: AuditSink, core: Record<string, unknown>) => void) => T,
  onBehalf: AuditOnBehalf
): Promise<T> {
  return serialize(() => {
    ensureFile();
    const db = readDB();
    const drafts: { sink: AuditSink; core: Record<string, unknown> }[] = [];
    const result = fn(db, (sink, core) => drafts.push({ sink, core }));
    writeAtomic(db);
    // Every audit line drafted inside this transaction inherits the SAME stamp:
    // an impersonated request stamps all its consent sub-events (incl. actor:"system").
    for (const d of drafts) appendAuditRaw(d.sink, d.core, onBehalf);
    return result;
  });
}

export function readAccessLog(): AccessLogEntry[] {
  return readSinkLines("access-log").map((l) => JSON.parse(l) as AccessLogEntry);
}

export function readConsentEvents(): ConsentEvent[] {
  return readSinkLines("consent-events").map((l) => JSON.parse(l) as ConsentEvent);
}

/** Bug1 — the per-agent board hide/restore trail (agent-operational; never seaman-facing). */
export function readBoardEvents(): BoardEvent[] {
  return readSinkLines("board-events").map((l) => JSON.parse(l) as BoardEvent);
}

/** Verify a sink's hash chain is unbroken (for tests / the transparency proof). */
export function verifyAuditChain(sink: AuditSink): { ok: boolean; brokenAt: number | null } {
  const lines = readSinkLines(sink);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e: Record<string, unknown> & { prevHash?: string; hash?: string };
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return { ok: false, brokenAt: i };
    }
    const { prevHash, hash, ...core } = e;
    if (prevHash !== prev) return { ok: false, brokenAt: i };
    if (chainHash(prev, core) !== hash) return { ok: false, brokenAt: i };
    prev = hash ?? GENESIS;
  }
  return { ok: true, brokenAt: null };
}

// ---- Helpers -----------------------------------------------------------

export function id(): string {
  return crypto.randomUUID();
}

export function shareToken(): string {
  // URL-friendly, short-ish, unguessable enough for a demo.
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * Mint a fresh, independent pair of share tokens for a NEW seafarer: an OPEN-link
 * token and a PRIVATE (email)-link token, guaranteed distinct. `shareToken` is the
 * alias of the open token, so spreading this into a Seafarer literal fills all three.
 */
export function newShareTokens(): {
  openShareToken: string;
  emailShareToken: string;
  shareToken: string;
} {
  const openShareToken = shareToken();
  let emailShareToken = shareToken();
  while (emailShareToken === openShareToken) emailShareToken = shareToken();
  return { openShareToken, emailShareToken, shareToken: openShareToken };
}
