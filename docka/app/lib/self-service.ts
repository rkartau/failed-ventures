// Client-safe rule library for the seafarer SELF-SERVICE profile-update loop —
// the same shared-semantics module the doc-requests / roster-search features use.
// It owns the DERIVED logic (which fields a seaman may self-edit, how a value is
// normalised, how an approved change is applied, how the queue is summarised /
// sorted) so the seaman page, the agent approval panel AND the server route share
// ONE set of rules. The records live in lib/db.ts; persistence + notify live in the
// route. NO Node built-ins here — importable from both server and client.
//
// A seaman never writes to their live profile directly: every change is PROPOSED as
// a pending record and only takes effect once a granted agent APPROVES it (the
// shore-approval gate from roadmap T1.7). The set of editable fields is fixed +
// typed here, so a crafted payload can only ever touch a known personal field —
// never rank, state, tokens, or any government-verified identity field.

import type { Seafarer, ProfileChangeRequest } from "@/lib/db";

// ---- Editable field registry ------------------------------------------
//
// The FIXED, typed set of personal fields a seaman may propose to change. Anything
// not in this list is rejected server-side, so self-service can never reach the
// pipeline state, share tokens, or the registry-verified identity block.

/** Input hint for the on-screen editor. */
export type SelfServiceFieldKind = "text" | "tel";

export type SelfServiceFieldDef = {
  key: string;
  /** Human label shown to seaman + agent. */
  label: string;
  /** Grouping header for the editor / approval panel. */
  group: string;
  kind: SelfServiceFieldKind;
  /** Optional short helper shown under the input. */
  hint?: string;
};

export const SELF_SERVICE_FIELDS = [
  { key: "phone", label: "Mobile / contact number", group: "Personal contact", kind: "tel" },
  { key: "email", label: "Personal e-mail", group: "Personal contact", kind: "text" },
  { key: "address", label: "Home address", group: "Personal contact", kind: "text" },
  { key: "nextOfKinName", label: "Next of kin — name", group: "Next of kin", kind: "text" },
  {
    key: "nextOfKinRelation",
    label: "Next of kin — relationship",
    group: "Next of kin",
    kind: "text",
  },
  { key: "nextOfKinPhone", label: "Next of kin — phone", group: "Next of kin", kind: "tel" },
  { key: "bankName", label: "Bank name", group: "Bank / payroll", kind: "text" },
  {
    key: "bankAccount",
    label: "Account number / IBAN",
    group: "Bank / payroll",
    kind: "text",
    hint: "Your wage account. Only your granted agents ever see this.",
  },
  { key: "bankSwift", label: "SWIFT / BIC", group: "Bank / payroll", kind: "text" },
] as const satisfies readonly SelfServiceFieldDef[];

/** The union of self-editable field keys. */
export type SelfServiceFieldKey = (typeof SELF_SERVICE_FIELDS)[number]["key"];

/** The seaman-maintained personal profile — one optional string per editable key. */
export type SeafarerProfile = Partial<Record<SelfServiceFieldKey, string | null>>;

const FIELD_BY_KEY: Record<string, SelfServiceFieldDef> = Object.fromEntries(
  SELF_SERVICE_FIELDS.map((f) => [f.key, f])
);

/** Type-guard: is `raw` one of the known editable field keys? */
export function isSelfServiceField(raw: unknown): raw is SelfServiceFieldKey {
  return typeof raw === "string" && raw in FIELD_BY_KEY;
}

/** The definition for a field key, or null for an unknown key. */
export function fieldDef(key: string): SelfServiceFieldDef | null {
  return FIELD_BY_KEY[key] ?? null;
}

/** Human label for a field key (falls back to the raw key). */
export function fieldLabel(key: string): string {
  return FIELD_BY_KEY[key]?.label ?? key;
}

/** The fields grouped for display, preserving registry order. */
export function fieldGroups(): { group: string; fields: SelfServiceFieldDef[] }[] {
  const out: { group: string; fields: SelfServiceFieldDef[] }[] = [];
  for (const f of SELF_SERVICE_FIELDS) {
    let g = out.find((x) => x.group === f.group);
    if (!g) {
      g = { group: f.group, fields: [] };
      out.push(g);
    }
    g.fields.push(f);
  }
  return out;
}

// ---- Value handling ----------------------------------------------------

/** Max length of a proposed value; longer input is rejected server-side. */
export const MAX_VALUE = 200;
/** Max length of the seaman's optional note. */
export const MAX_NOTE = 500;

/**
 * Normalise a proposed value: trim, collapse to a single string, cap length. An
 * empty string means "clear this field" and normalises to null. Returns the sentinel
 * "bad" when the raw input is the wrong type or overlong so the route can 400.
 */
export function normalizeValue(raw: unknown): string | null | "bad" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "bad";
  const v = raw.trim();
  if (v === "") return null;
  if (v.length > MAX_VALUE) return "bad";
  return v;
}

/** The value currently ON FILE for a field (the seaman's approved profile). */
export function currentValueOf(seafarer: Seafarer, key: SelfServiceFieldKey): string | null {
  return seafarer.selfProfile?.[key] ?? null;
}

/**
 * Apply an APPROVED change to a seafarer IN PLACE: writes the proposed value into
 * the seaman's self-profile under the request's field. Only ever called by the
 * server after a granted agent approved the request — never from client input.
 */
export function applyApprovedChange(seafarer: Seafarer, req: ProfileChangeRequest): void {
  seafarer.selfProfile = {
    ...(seafarer.selfProfile ?? {}),
    [req.field]: req.proposedValue,
  };
}

// ---- Queue derivation --------------------------------------------------

/** Still awaiting a shore decision. */
export function isPending(req: ProfileChangeRequest): boolean {
  return req.status === "pending";
}

export type ProfileChangeSummary = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  /** Cancelled by the seaman or superseded by a newer proposal for the same field. */
  cancelled: number;
};

/** Summarise a seafarer's change requests for the board badge + panel header. */
export function summarizeChanges(reqs: ProfileChangeRequest[]): ProfileChangeSummary {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let cancelled = 0;
  for (const r of reqs) {
    if (r.status === "pending") pending++;
    else if (r.status === "approved") approved++;
    else if (r.status === "rejected") rejected++;
    else cancelled++;
  }
  return { total: reqs.length, pending, approved, rejected, cancelled };
}

/** Sort for display: pending first (oldest first — first-in the queue), then newest activity. */
export function sortChangesForDisplay(
  reqs: ProfileChangeRequest[]
): ProfileChangeRequest[] {
  const rank = (r: ProfileChangeRequest): number => (r.status === "pending" ? 0 : 1);
  return reqs.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return a.createdAt.localeCompare(b.createdAt); // oldest pending first
    return (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt);
  });
}
