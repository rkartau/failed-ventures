// Client-safe prefill helpers for the agent-side registry check (plan §5.3),
// extracted from components/RegistryInfo.tsx so the persona-B4 guard is
// unit-testable (pure TS — no JSX).

import type { Doc, Seafarer } from "@/lib/db";
import { countryEntry } from "./countries";
import { genericNormalize } from "./detect";
import type { CountryEntry } from "./types";

// A stored pasted value may be the raw pasted URL — reduce it to a code ONLY
// when the URL actually carries one. Persona B4 guard: a portal URL whose path
// is route words ("…/verification-of-certificates/") must NEVER be turned into
// a fake certificate number ("VERIFICATIONOFCERTIFICATES") — a URL that
// matched only by hostname yields an EMPTY prefill; empty beats wrong data.
export function codeish(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  // URL-shaped? (explicit scheme, or a hostname-shaped first segment — the
  // same rule registry detection applies.)
  const head = t.split("/")[0] ?? "";
  const urlish =
    /^https?:\/\//i.test(t) ||
    (t.includes("/") && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(head));
  if (!urlish) {
    // Plain code (separators like FR's "12345/67" are normalized away).
    return genericNormalize(t);
  }
  const path = t.split(/[?#]/)[0];
  const parts = path.split("/").filter(Boolean);
  const seg = parts[parts.length - 1] ?? "";
  // Hostname-only URL (nothing after the domain) → no code to derive. A
  // slug-like route word (all lowercase letters, optionally hyphen/underscore
  // separated — "verification-of-certificates", "certificates") is a PATH, not
  // a code: real codes carry digits and/or uppercase.
  if (!seg || seg.includes(".") || /^https?:$/i.test(seg)) return "";
  if (/^[a-z]+([-_][a-z]+)*$/.test(seg)) return "";
  return genericNormalize(seg);
}

// ---- Rescued-doc labeling (vr2 item 5) -----------------------------------
//
// Documents stored through the unmatched-code rescue picker (assist/manual
// outcomes: LV, RO, …) used to render as a bare "Unverified document". This
// display helper names the country and the doc's capability state so the
// seafarer row and the agent list read e.g.
//   "Latvia certificate · LV102452023 · Check on registry pending"
//   "Romania certificate · RO771230 · Verification requested"
// Reuses countries.ts naming + the existing badge-state vocabulary; NEVER
// applies to government/registry(-confirmed)/photo docs, whose surfaces
// already say what they are.

export type RescuedDocDisplay = {
  /** Replacement title when the stored one is generic — else null (keep it). */
  title: string | null;
  countryName: string;
  /** Normalized stored lookup code, when one exists. */
  code: string | null;
  /** Human capability-state line, mirroring the badge vocabulary. */
  state: string;
};

export function rescuedDocDisplay(doc: Doc): RescuedDocDisplay | null {
  if (!doc.registryCountry) return null;
  if (doc.source === "government" || doc.source === "registry" || doc.source === "photo") {
    return null;
  }
  const entry = countryEntry(doc.registryCountry);
  if (!entry) return null;
  const assisted =
    entry.capability === "assisted" || entry.capability === "unverified-endpoint";
  const manual = entry.capability === "manual";
  if (!assisted && !manual) return null;

  const generic = /^(unverified document|document)$/i.test((doc.title ?? "").trim());
  // Title falls back to "<CountryName> certificate" only for the generic
  // rescue-stored titles (docType carries no signal for these rows either).
  const title = generic ? `${entry.countryName} certificate` : null;

  const mv = doc.manualVerification;
  const state =
    mv?.status === "requested"
      ? "Verification requested"
      : mv?.status === "confirmed"
        ? "Confirmed by the authority"
        : mv?.status === "closed_unavailable"
          ? "Verification unavailable from the authority"
          : doc.reviewerChecked && doc.checkedVia === "registry-portal"
            ? "Checked against registry"
            : manual
              ? "Manual verification available"
              : "Check on registry pending";

  const code = codeish(doc.certNumber ?? doc.estonianCode);
  return { title, countryName: entry.countryName, code: code || null, state };
}

// ---- "Use profile name" per-field semantics (vr2 item 2) -----------------
//
// The per-field profile-copy helper must respect what the field MEANS: a
// surname field receives the profile's LAST name, a first-name field the FIRST
// name, and a whole-name field (LV "Holder name and surname") the full name.
// The invariant "never auto-split a single fullName string" (plan §3) stands:
// when only an unstructured full name exists, first/last-specific fields get
// NO fill value (empty + typed by the user) — full-name fields still do.

export type NameFieldSemantics = "first" | "last" | "full" | "other";

/**
 * Classify a country input field's name semantics from its key, using the
 * sibling fields of the same entry to disambiguate a bare "name" key:
 * LT/ES pair `name` with a surname field (so it means FIRST name), while LV's
 * lone `name` means the whole name. Father's-name fields are a DIFFERENT
 * person's name — never profile-fillable ("other").
 */
export function nameFieldSemantics(country: CountryEntry, key: string): NameFieldSemantics {
  if (!/name/i.test(key) || /father/i.test(key)) return "other";
  if (/surname|last_?name/i.test(key)) return "last";
  if (/first_?name/i.test(key)) return "first";
  const hasSurnameSibling = country.inputs.some(
    (f) => f.key !== key && /surname|last_?name/i.test(f.key)
  );
  return hasSurnameSibling ? "first" : "full";
}

export type ProfileNameParts = {
  /** verifiedName → declared name (the legacy full-name fallback chain). */
  fullName: string;
  /** Structured given name — ONLY from a registry holder snapshot. */
  firstName: string;
  /** Structured surname — ONLY from a registry holder snapshot. */
  lastName: string;
};

/**
 * The profile's name, with a structured first/last split ONLY where the
 * registry itself provided one: a government-verified doc snapshot
 * (`verifiedFirstName`/`verifiedLastName`) whose `verifiedFullName` matches
 * the profile name. A stored fullName string is NEVER auto-split.
 */
export function structuredProfileName(
  seafarer?: Seafarer | null,
  docs?: readonly Doc[] | null
): ProfileNameParts {
  const fullName = (seafarer?.verifiedName ?? "").trim() || (seafarer?.name ?? "").trim();
  let firstName = "";
  let lastName = "";
  if (fullName && docs) {
    for (const d of docs) {
      if (d.source !== "government") continue;
      const f = (d.verifiedFirstName ?? "").trim();
      const l = (d.verifiedLastName ?? "").trim();
      const fl = (d.verifiedFullName ?? "").trim();
      if (f && l && fl && fl.toLowerCase() === fullName.toLowerCase()) {
        firstName = f;
        lastName = l;
        break;
      }
    }
  }
  return { fullName, firstName, lastName };
}

/**
 * The value the per-field "Use profile name" helper may offer for a field of
 * the given semantics — or null when nothing safe exists (never a wrong split,
 * never a full name into a first/last-specific field).
 */
export function profileNameFill(
  sem: NameFieldSemantics,
  parts: ProfileNameParts
): string | null {
  if (sem === "full") return parts.fullName || null;
  if (sem === "first") return parts.firstName || null;
  if (sem === "last") return parts.lastName || null;
  return null;
}

/**
 * Prefill values for an agent-side portal check on a STORED document.
 * Fallback chain per field: stored non-sensitive registryInputs → the doc's
 * stored code (certNumber/estonianCode, URL-reduced with the B4 guard) →
 * profile (birthDate / verifiedName → declared name) → empty prompt.
 * Sensitive fields (BG EGN, ES NIF) are NEVER prefilled — pass-through only,
 * never stored anywhere to prefill from.
 */
export function prefillFromDoc(
  country: CountryEntry,
  doc: Doc,
  seafarer?: Seafarer | null,
  /** All of the seafarer's docs — source of a structured first/last name split. */
  allDocs?: readonly Doc[] | null
): Record<string, string> {
  const out: Record<string, string> = {};
  // Field-semantics-aware name parts (vr2 item 2): structured split comes only
  // from a registry holder snapshot; a bare fullName is never auto-split.
  const parts = structuredProfileName(seafarer, allDocs ?? [doc]);
  for (const f of country.inputs) {
    if (f.sensitive) continue;
    const stored = doc.registryInputs?.[f.key];
    if (stored) {
      out[f.key] = stored;
      continue;
    }
    if (f.source === "paste") {
      const v = codeish(doc.certNumber ?? doc.estonianCode);
      if (v) out[f.key] = v;
    } else if (f.source === "profile.birthDate") {
      const v = (seafarer?.birthDate ?? "").slice(0, 10); // UTC slice — no tz math
      if (v) out[f.key] = v;
    } else if (f.source === "profile.verifiedName") {
      // Respect the field's semantics: LV's lone "name" field takes the whole
      // name; LT's first/surname pair only fills from a STRUCTURED split
      // (empty + typed otherwise — never a full name in a surname field).
      const v = profileNameFill(nameFieldSemantics(country, f.key), parts);
      if (v) out[f.key] = v;
    }
    // source "prompt" → left empty ("Type to copy across").
  }
  return out;
}
